"""import_characters.py — bulk-import the imported_characters/ folder.

Reads every *.json from `imported_characters/`, validates that it
parses cleanly + looks like a character save, ensures `char-name`
is populated (falls back to filename when empty — many imported
files have empty char-name and rely on filename to identify the
character), tags each with `library` so the new list-view UI can
filter the imported set as a group, and writes the result into
`saves/library/<name>.json`.

The script writes directly to the filesystem rather than going
through the save server's HTTP API. Reasons: (a) no server has to
be running, (b) atomic local-fs writes are simpler than HTTP error
handling for 371 files, (c) the import is a one-shot bootstrap, not
an interactive flow.

Usage:
    python import_characters.py [options]

Options:
    --src DIR        Source folder (default: imported_characters/)
    --dest DIR       Destination folder (default: saves/library/)
    --force          Overwrite existing files in destination
    --tag TAG        Additional tag to apply to every imported save
                     (can be repeated; "library" is always added)
    --dry-run        Show what would be done without writing
    --verbose        Print every file processed (default: only summary
                     + errors)

Examples:
    python import_characters.py
    python import_characters.py --tag campaign:diamondsoul --tag npc
    python import_characters.py --src ~/old_chars/ --dest saves/old/
    python import_characters.py --dry-run --verbose
"""
import argparse
import json
import os
import re
import sys

from pathlib import Path


_PROJECT_ROOT = Path(__file__).parent.resolve()
DEFAULT_SRC = _PROJECT_ROOT / "imported_characters"
DEFAULT_DEST = _PROJECT_ROOT / "saves" / "library"

# Mirror the server's slugify so filenames match what save_server.py
# would produce for the same canonical name.
_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(name: str) -> str:
    s = _SLUG_RE.sub("_", (name or "").strip().lower()).strip("_")
    return s or "unnamed"


def filename_to_name(filename: str) -> str:
    """Convert "Air_Mephit.json" -> "Air Mephit". Underscores → spaces,
    drops .json extension. Used as a fallback char-name when the
    file's own char-name field is empty."""
    base = Path(filename).stem
    # Replace underscores with spaces, collapse multiple spaces. Keep
    # original capitalization — many filenames already use the right
    # form ("Air_Mephit" → "Air Mephit", not "air mephit").
    return re.sub(r"\s+", " ", base.replace("_", " ")).strip() or "Unnamed"


def is_character_save(data) -> bool:
    """Quick sanity-check that this JSON looks like a character save.
    Doesn't have to be exhaustive — bad input gets caught at load
    time inside the sheet anyway. We just want to skip obvious
    non-character JSONs (config files, etc.) that might be in the
    folder by mistake."""
    if not isinstance(data, dict):
        return False
    # Every real character save has these keys (verified across the
    # 371-file imported_characters audit).
    required = {"char-name", "char-class", "char-race", "str-score"}
    return required.issubset(data.keys())


def merge_tags(existing, additions) -> list:
    """Combine existing `_tags` with the new tags. Case-insensitive
    dedupe, sorted, lowercased. Preserves the server's normalization
    convention so what's written matches what the API would store."""
    out = set()
    for src in (existing or []), additions:
        for t in src:
            if isinstance(t, str) and t.strip():
                out.add(t.strip().lower())
    return sorted(out)


def main():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--src", type=Path, default=DEFAULT_SRC,
                   help="source folder (default: imported_characters/)")
    p.add_argument("--dest", type=Path, default=DEFAULT_DEST,
                   help="destination folder (default: saves/library/)")
    p.add_argument("--force", action="store_true",
                   help="overwrite existing files in destination")
    p.add_argument("--tag", action="append", default=[],
                   help="extra tag(s) to apply (repeatable)")
    p.add_argument("--dry-run", action="store_true",
                   help="show what would be done without writing")
    p.add_argument("--verbose", action="store_true",
                   help="print every file processed")
    args = p.parse_args()

    src: Path = args.src.resolve()
    dest: Path = args.dest.resolve()

    if not src.exists():
        print(f"error: source folder does not exist: {src}",
              file=sys.stderr)
        return 2
    if not src.is_dir():
        print(f"error: source is not a directory: {src}",
              file=sys.stderr)
        return 2

    extra_tags = ["library"] + list(args.tag)

    files = sorted(src.glob("*.json"))
    if not files:
        print(f"no *.json files in {src} — nothing to import")
        return 0

    if not args.dry_run:
        dest.mkdir(parents=True, exist_ok=True)

    stats = {"imported": 0, "skipped_exists": 0, "skipped_invalid": 0,
             "parse_errors": 0}

    for fp in files:
        try:
            with fp.open(encoding="utf-8") as f:
                data = json.load(f)
        except json.JSONDecodeError as e:
            print(f"  PARSE ERROR  {fp.name}: {e}", file=sys.stderr)
            stats["parse_errors"] += 1
            continue

        if not is_character_save(data):
            print(f"  not a character save (missing required keys): "
                  f"{fp.name}", file=sys.stderr)
            stats["skipped_invalid"] += 1
            continue

        # Slug always comes from the FILENAME, not char-name. The
        # user's filename is their organizational choice — many
        # versioned files share an internal char-name (Anapa /
        # Anapa_2 / Anapa_3 all have char-name="Anapa" but represent
        # the character at different points in time). Slugging by
        # char-name would silently dedupe them. char-name stays as
        # the display label; filename stays as the storage key.
        existing_name = (data.get("char-name") or "").strip()
        name = existing_name or filename_to_name(fp.name)
        slug = slugify(Path(fp.name).stem)
        dest_path = dest / f"{slug}.json"

        if dest_path.exists() and not args.force:
            if args.verbose:
                print(f"  exists, skipping (use --force): {dest_path.name}")
            stats["skipped_exists"] += 1
            continue

        # Inject derived char-name when missing, so the new sheet has
        # a value to display. Also stamp tags.
        out = dict(data)
        if not existing_name:
            out["char-name"] = name
        out["_tags"] = merge_tags(data.get("_tags"), extra_tags)

        if args.dry_run:
            print(f"  WOULD WRITE  {dest_path.name}  (name={name!r})")
        else:
            tmp = dest_path.with_suffix(dest_path.suffix + ".tmp")
            with tmp.open("w", encoding="utf-8") as f:
                json.dump(out, f, indent=2, ensure_ascii=False)
            os.replace(tmp, dest_path)
            if args.verbose:
                print(f"  imported  {dest_path.name}  (name={name!r})")
        stats["imported"] += 1

    # Summary
    print()
    print(f"Source:      {src}")
    print(f"Destination: {dest}")
    print(f"Tags applied: {extra_tags}")
    if args.dry_run:
        print("(DRY RUN — nothing was written)")
    print(f"Imported:        {stats['imported']}")
    print(f"Skipped (exists):{stats['skipped_exists']}")
    print(f"Skipped (invalid):{stats['skipped_invalid']}")
    print(f"Parse errors:    {stats['parse_errors']}")
    return 0 if stats["parse_errors"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
