"""save_server.py — D&D 3.5 Character Sheet local server.

A thin extension of Python's `http.server` that:

  1. Serves the static character-sheet files exactly like
     `python -m http.server` does.
  2. Adds a `/api/saves` namespace for persistent character storage,
     backed by JSON files in `<project>/saves/`.

The point of #2: browser `localStorage` is keyed on origin
(scheme + host + port), so character saves silently disappear when
the user serves the sheet on a different port. With this server,
saves live on disk in a known location — origin-agnostic, browser-
agnostic, and (since the save dir is inside the project root) git-
trackable along with the rest of the sheet.

Side note: because the save dir lives under the project root, every
save file is ALSO statically served at /saves/<slug>.json. The
server only binds to 127.0.0.1 so this is a no-op for security,
but it's a useful side effect — you can hand someone a direct URL
during a local session, or just grab the .json file out of the dir
to attach to a Discord message.

The client-side `save-backend.js` module probes `/api/health` at
load and uses this API when available; otherwise it falls back to
localStorage. So this server is an enhancement, not a requirement —
the sheet still works when served by plain `python -m http.server`.

Endpoints
---------

GET    /api/health              -> {"ok": true, "save_dir": "..."}
GET    /api/saves               -> {"saves": [{"name", "modified",
                                              "size"}, ...]}
GET    /api/saves/<name>        -> the save's JSON body
PUT    /api/saves/<name>        -> write JSON body (creates or
                                   overwrites; returns 204)
DELETE /api/saves/<name>        -> remove save (returns 204)

Live resolved-state bus (2026-08-20). Phase 1 — publish / read:

PUT    /api/live/<qualified>    -> an open tab publishes its RESOLVED
                                   snapshot (204). In memory only.
GET    /api/live/<qualified>    -> {"qualified", "age_seconds", "stale",
                                    "stale_after_seconds", "snapshot"}
                                   or 404 when no tab is publishing it
DELETE /api/live/<qualified>    -> a tab RELEASES its claim (it closed,
                                   reloaded, or swapped characters).
                                   Ownership-checked: a release naming a
                                   different publisher is refused 409.
GET    /api/live                -> summary of every live character
                                   (no snapshots; cheap to poll)

Phase 2 — inbound writes (a consumer changes volatile session state):

POST   /api/live-write/<qual>   -> {"fields": {"hp.current": 23, ...}} ->
                                   {"status", "applied", "rejected",
                                    "echo", "snapshot"}. Blocks until the
                                   tab applies + recalculates, so the
                                   snapshot returned is post-write.
GET    /api/live-writable       -> the field-ownership split, machine-
                                   readable: what a consumer may write and
                                   why everything else is refused.
GET    /api/live-commands/<qual> -> the TAB's long-poll for queued writes
POST   /api/live-ack/<qual>     -> the TAB reports what it applied and
                                   publishes the post-recalc snapshot

The point: `saves/` holds RAW form fields, so anything reading them for a
character's real numbers gets them wrong. The sheet is the only thing that
knows the derived values, so the sheet publishes them. Consumers MUST honour
`stale` — a closed tab leaves a snapshot that still reads perfectly. See the
block comment above `_LIVE` for the full rationale, and the one above
`_LIVE_CMDS` for why phase 2's allowlist is the same kind of safety property.

`<name>` in URLs is URL-encoded canonical name (e.g. "Dust",
"Old Char Sheet 1"). The server slugifies internally for filenames
(lower-case, non-alphanumeric → underscore). The canonical name is
preserved inside the JSON body under `char-name`, so display
listings come from the file contents, not from the filename.

File writes are atomic (write-to-tmp, rename) so a Ctrl+C mid-write
can't leave a half-written file.

Run with:
    python save_server.py [PORT]

Default port: 3000.
"""
import hashlib
import http.server
import json
import os
import re
import sys
import threading
import time
import urllib.parse

from datetime import datetime, timezone
from pathlib import Path


_PROJECT_ROOT = Path(__file__).parent.resolve()
SAVE_DIR = _PROJECT_ROOT / "saves"
SAVE_DIR.mkdir(parents=True, exist_ok=True)

# Review-flagging store (2026-07-09). Kept OUTSIDE saves/ so flags never appear
# in the character list (list_saves rglob's the whole saves/ tree). Two fixed
# surfaces with distinct consumers: entry-flags feed the DB project's worklist;
# sheet-reports are char-sheet bug/feature notes. Fixed allowlist — no
# user-supplied filenames, so no slugify / traversal surface here.
REVIEWS_DIR = _PROJECT_ROOT / "reviews"
_FLAG_SURFACES = {"entry-flags", "sheet-reports"}

# Serializes the read-modify-write in the op-based flag endpoint. The server is
# a ThreadingHTTPServer, so two concurrent tabs POSTing ops to the same surface
# would otherwise race on the file. The lock is process-wide (all surfaces share
# it) — flag ops are rare + tiny, so there's no contention worth sharding for.
_FLAGS_LOCK = threading.Lock()

# ---- Live resolved-state bus (phase 1: publish/read only) ---------------
#
# WHY THIS EXISTS. `saves/` holds RAW FORM FIELDS — `cha-score`,
# `armor-ac-bonus`, `bab-1`. Everything the sheet actually computes
# (final initiative, AC/touch/flat-footed, saves with all bonuses folded
# in, attack routines) is derived in browser JS at display time and has
# never existed on disk. So anything reading `saves/*.json` to learn a
# character's real numbers gets them WRONG — which is exactly the bug the
# megadungeon rig hit, narrating stale initiative and missing Strength
# mid-combat.
#
# Rather than re-implement the derivation (two implementations of D&D
# math = guaranteed drift), each open sheet tab PUBLISHES its own resolved
# snapshot here after every recalc. Consumers read it. One implementation
# of the math, and it is the one the player is looking at.
#
# DELIBERATELY IN MEMORY, NOT ON DISK. This is live session state whose
# only meaning is "a tab currently has this character open and computed
# these numbers." A server restart genuinely INVALIDATES that — the
# restarted process has no idea whether those tabs are still open — so
# losing it on restart is correct behaviour, not a limitation. Persisting
# it would manufacture exactly the failure this design is built to avoid:
# a stale snapshot that still looks authoritative.
#
# CLAIM / RELEASE closes the hole staleness cannot (2026-08-21). Staleness
# catches a tab that DIED. It cannot catch a tab that deliberately moved on:
# swap a tab from Kell to Gorrash and Kell's snapshot sits here looking
# perfectly fresh for another 90 seconds, and a consumer reading it narrates
# numbers for a character nobody has open. Only the tab knows it swapped, so
# the tab says so — every publish carries a per-tab `publisher` id, and a tab
# DELETEs its claim on swap, reload and close. Releases are ownership-checked
# so a second tab cannot evict the first.
#
# TWO TABS ON ONE CHARACTER IS REPORTED, NOT RESOLVED. `contested` names every
# publisher currently live on a key. They normally compute identical numbers —
# same save, same math — but not if one has unsaved edits, and this process
# cannot tell which is right. A consumer that knows it is reading a contested
# character can say so; one silently handed the last writer's view cannot.
#
# STALENESS IS THE SAFETY PROPERTY. A closed tab leaves a snapshot sitting
# here looking perfectly fine. Every read therefore reports `age_seconds`
# and a `stale` flag; consumers MUST treat stale as ABSENT and say so
# rather than narrate from it. Reading a number is easy; knowing whether
# it is still true is the whole job.
_LIVE = {}
_LIVE_LOCK = threading.Lock()
# Tabs heartbeat well inside this even when nothing changes, so exceeding
# it means the tab is gone, reloading, or wedged — not merely idle.
LIVE_STALE_AFTER_SEC = 90.0


# ---------------------------------------------------------------------------
# PHASE 2 — INBOUND WRITES (2026-08-20)
#
# Phase 1 is one-way: tabs publish, consumers read. Phase 2 lets a consumer
# write BACK — the megadungeon rig applies combat damage, spends a slot, sets
# a condition — and receive the post-recalc snapshot in the same response, so
# it never has to guess what the write did to the derived numbers.
#
# THE ALLOWLIST IS THE SAFETY PROPERTY, exactly as `stale` is phase 1's. The
# field-ownership split agreed with the rig: the CONSUMER owns volatile session
# state (current HP, conditions, spent slots / power points, rages used, XP,
# coin) and the SHEET owns structural state (classes, feats, ability scores,
# equipment) plus every number derived from it. One owner per quantity. So a
# write to a structural field is REFUSED WITH ITS REASON rather than quietly
# applied — two writers for one number is the exact collision the split exists
# to prevent, and a refusal that explains itself is what keeps the split alive
# in two codebases that cannot see each other.
#
# ABSOLUTE VALUES ONLY, NEVER DELTAS. `hp.current = 23`, not `hp.current -= 7`.
# The writer owns the number, so it sends the number it owns. A delta that gets
# lost, retried or duplicated silently corrupts the value and nothing can tell
# afterwards; an absolute value is idempotent under all three. That also makes
# the two-tabs-same-character case harmless — both tabs apply the same value.
#
# A WRITE WITH NO FRESH TAB FAILS, IT DOES NOT QUEUE. This is the mirror of the
# read side's staleness contract. A queued command that applies ten minutes
# later, when the player has moved on, is worse than a refusal: the writer was
# told nothing happened, so it will say so out loud and move on. Commands
# therefore carry a deadline and are dropped at dispatch time, not applied late.
#
# THE OUTCOME IS THREE-STATE, NOT TWO. applied / not-applied / unknown. If no
# tab ever claimed the command we can say "not applied" with certainty. If a
# tab claimed it and then went quiet, the honest answer is that we do not know
# — reporting either success or failure there would be inventing a fact. That
# third bucket should be empty in practice; it exists so it is never silently
# folded into one of the other two.
#
# WHY A QUEUE AT ALL. The server cannot touch the sheet — the resolved numbers
# live in a browser DOM. So the tab long-polls for commands, applies them,
# recalculates, and ACKs with a fresh snapshot; the ack IS a publish (it
# updates _LIVE), which guarantees the snapshot handed back to the writer is
# byte-for-byte what a reader would have got. Delivery rides the network, not
# a timer, so it is immune to the background-tab timer throttling that slows
# phase 1's change-watcher in the three tabs that are not on screen.
_LIVE_CMDS = {}
# One condition variable guards the command registry AND wakes long-pollers.
# Deliberately not _LIVE_LOCK: a long-poll parks for up to 25 seconds, and
# holding the snapshot lock that long would stall every publish and read.
_LIVE_CMD_COND = threading.Condition()
_LIVE_CMD_SEQ = [0]
# How long a writer waits for a tab to apply and ack. The tab's poll returns
# instantly when a command is waiting and applying is synchronous, so this is
# generous by an order of magnitude — it is a ceiling, not a budget.
LIVE_WRITE_TIMEOUT_SEC = 5.0
LIVE_WRITE_TIMEOUT_MAX = 30.0
# Ceiling on a tab's long-poll park. Must stay under the handler's 60s socket
# timeout or the connection dies under the poll rather than returning empty.
LIVE_POLL_MAX_SEC = 25.0

# Fields a consumer may write, as (pattern, kind, description). The pattern is
# matched against the DOTTED PATH OF THE PUBLISHED SNAPSHOT — a consumer reads
# `snapshot["hp"]["current"]` and writes `"hp.current"`, so the read and write
# vocabularies are the same one. Parameterised paths carry the same addresses
# phase 1 publishes: caster `id` (stable; the label is not), then spell level.
LIVE_WRITABLE = [
    (r"^hp\.current$", "int", "current hit points"),
    (r"^hp\.temp$", "int", "temporary hit points"),
    (r"^hp\.nonlethal$", "int", "nonlethal damage taken"),
    (r"^conditions$", "list[str]",
     "the COMPLETE set of active conditions, not a delta; [] clears them"),
    (r"^rage_active$", "bool",
     "currently raging — folds +4 Str/+4 Con/-2 AC into the returned snapshot"),
    (r"^uses_per_day\.rage\.used$", "int", "rages used today"),
    (r"^xp$", "int", "experience points"),
    (r"^money\.(cp|sp|gp|pp)$", "num", "coin on hand"),
    # The groups are not used on this side — they are here so the pattern
    # SOURCE is character-identical to live-commands.js's, which extracts the
    # caster id and level from them. tests/test_pickers.js compares the two
    # lists as text, and a comparison that has to normalise first is a
    # comparison that can be talked into passing.
    (r"^pools\.power_points\.([^.]+)\.spent$", "int",
     "power points spent, addressed by caster id (pools.power_points.caster-1.spent)"),
    (r"^pools\.spell_slots\.([^.]+)\.(\d+)\.used$", "int",
     "slots used, addressed by caster id then spell level "
     "(pools.spell_slots.caster-0.3.used)"),
]

# Refusals that TEACH. Every one of these is a field a consumer can plausibly
# reach for and must not own; answering "unknown field" would read as a typo
# and invite a retry. Ordered — first match wins — and consulted only after
# LIVE_WRITABLE misses, so a writable path can never be shadowed by a hint.
LIVE_NOT_WRITABLE = [
    (r"^hp\.total$",
     "hp.total is structural — the sheet derives it from class HD and Con"),
    (r"^abilities\.",
     "ability scores are structural — the sheet owns them, and every derived "
     "number depends on them"),
    (r"^(defense|saves|initiative|grapple|bab|attacks|skills)\b",
     "derived — this is computed from structural state; write the cause, not "
     "the effect (e.g. a condition), and read the recomputed value back"),
    (r"^identity\.",
     "identity is structural — name, race, classes and level belong to the sheet"),
    (r"^speed\.",
     "speed is structural — the sheet derives it from race, load and armour"),
    (r"\.(max|capacity|per_day|known|dc)$",
     "pool CAPACITIES are the sheet's half of the split — it hands you the "
     "ceiling and you own the depletion"),
    (r"^pools\.",
     "the only writable pool fields are `.spent` on a power-point block and "
     "`.used` on a spell-slot level"),
]


def live_field_check(field, value):
    """Return (ok, reason) for one requested write.

    Reason is None when ok. The value's type is checked here rather than in the
    tab because a type error is a WRITER bug: it should come back on the write
    call, not arrive at a browser that has to decide what `"twelve"` means.
    """
    if not isinstance(field, str) or not field:
        return False, "field must be a non-empty string"
    for pattern, kind, _desc in LIVE_WRITABLE:
        if re.match(pattern, field):
            return live_value_check(kind, value)
    for pattern, reason in LIVE_NOT_WRITABLE:
        if re.match(pattern, field):
            return False, reason
    return False, "not a writable field (GET /api/live-writable lists them)"


def live_value_check(kind, value):
    # bool is a subclass of int in Python and JSON `true` would sail straight
    # into an integer field, so it is excluded explicitly rather than by luck.
    if kind == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            return False, "expected an integer"
        return True, None
    if kind == "num":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return False, "expected a number"
        return True, None
    if kind == "bool":
        if not isinstance(value, bool):
            return False, "expected true or false"
        return True, None
    if kind == "list[str]":
        if not isinstance(value, list) or any(not isinstance(v, str) for v in value):
            return False, "expected a list of strings"
        return True, None
    return False, "unknown field kind %r" % (kind,)  # unreachable; keeps it loud


def flags_path(surface: str) -> Path:
    """Path for a review-flag surface, or None if `surface` isn't allowlisted."""
    if surface not in _FLAG_SURFACES:
        return None
    return REVIEWS_DIR / f"{surface}.json"


def _read_flags(path: Path) -> dict:
    """Load a flag surface's state, tolerating a missing / malformed file."""
    if not path.exists():
        return {"flags": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"flags": []}
    if not isinstance(data, dict) or not isinstance(data.get("flags"), list):
        return {"flags": []}
    return data


def _write_flags(path: Path, data: dict) -> None:
    """Atomically persist a flag surface (write-tmp, rename)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fp:
        json.dump(data, fp, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def apply_flag_op(path: Path, op: dict) -> dict:
    """Apply a single atomic op to a flag surface and return the new state.

    Ops (each mutates by id, never by transmitting the whole array — so
    concurrent tabs can't clobber each other the way the old whole-array PUT
    let them):
      {"op": "add", "flag": {...}}          append (idempotent on id)
      {"op": "resolve", "id", "resolved"?}  mark one flag resolved
      {"op": "remove", "id"}                drop one flag
      {"op": "edit", "id", "note"?, "kind"?} amend a flag's note / kind in place

    Runs under _FLAGS_LOCK so the read-modify-write is atomic across threads.
    Raises ValueError on a malformed op.
    """
    kind = op.get("op")
    with _FLAGS_LOCK:
        data = _read_flags(path)
        flags = data["flags"]
        if kind == "add":
            flag = op.get("flag")
            if not isinstance(flag, dict) or not flag.get("id"):
                raise ValueError("add op requires a flag object with an id")
            if not any(f.get("id") == flag["id"] for f in flags):
                flags.append(flag)
        elif kind == "resolve":
            fid = op.get("id")
            if not fid:
                raise ValueError("resolve op requires an id")
            for f in flags:
                if f.get("id") == fid:
                    f["status"] = "resolved"
                    f["resolved"] = op.get("resolved") or \
                        datetime.now(timezone.utc).isoformat()
                    break
        elif kind == "remove":
            fid = op.get("id")
            if not fid:
                raise ValueError("remove op requires an id")
            data["flags"] = [f for f in flags if f.get("id") != fid]
        elif kind == "edit":
            fid = op.get("id")
            if not fid:
                raise ValueError("edit op requires an id")
            for f in flags:
                if f.get("id") == fid:
                    if isinstance(op.get("note"), str):
                        f["note"] = op["note"].strip()
                    if op.get("kind") in ("bug", "feature"):
                        f["kind"] = op["kind"]
                    f["edited"] = op.get("edited") or \
                        datetime.now(timezone.utc).isoformat()
                    break
        else:
            raise ValueError(f"unknown op: {kind!r}")
        _write_flags(path, data)
        return data

# One-time migration from the previous home-dir location. The first
# version of this server stored saves under ~/.dnd-sheet/saves/. If
# any files exist there AND the in-project saves/ dir is empty (i.e.
# the user hasn't created any saves under the new layout yet), copy
# them over. Source files are NOT deleted — they stay as a backup
# until the user clears them by hand. Idempotent: once the new dir
# has any *.json, we skip.
_LEGACY_SAVE_DIR = Path.home() / ".dnd-sheet" / "saves"


def _maybe_migrate_legacy():
    if not _LEGACY_SAVE_DIR.exists():
        return
    legacy_files = list(_LEGACY_SAVE_DIR.glob("*.json"))
    if not legacy_files:
        return
    # Recursive walk — if ANY save exists anywhere in the project's
    # save tree (root, subfolders like saves/active/, etc.), skip the
    # legacy migration. Earlier this used a flat glob and re-ran the
    # migration after the user deleted saves/dust.json (despite
    # saves/active/Dust.json existing). The recursive check fixes
    # that.
    new_files = list(SAVE_DIR.rglob("*.json"))
    if new_files:
        return  # already migrated or user started fresh — don't overwrite
    moved = 0
    for src in legacy_files:
        dst = SAVE_DIR / src.name
        try:
            dst.write_bytes(src.read_bytes())
            moved += 1
        except OSError as e:
            print(f"[save_server] skip legacy {src.name}: {e}",
                  file=sys.stderr)
    if moved:
        print(
            f"[save_server] migrated {moved} save{'s' if moved != 1 else ''} "
            f"from {_LEGACY_SAVE_DIR} -> {SAVE_DIR}\n"
            f"  (originals preserved at the legacy location as backup)",
            file=sys.stderr,
        )


_maybe_migrate_legacy()

# Filename slug rules — defined here because _normalize_filenames
# uses slugify(). Same regex + helper that gets re-used by the
# request-handling path below.
#
# Lowercase, non-alphanumeric → underscore, collapse repeats, strip
# leading/trailing underscores. "Dust" → "dust", "My Wizard" →
# "my_wizard", "Old Char Sheet 1" → "old_char_sheet_1". Empty after
# stripping = "unnamed".
_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(name: str) -> str:
    s = _SLUG_RE.sub("_", (name or "").strip().lower()).strip("_")
    return s or "unnamed"


def _normalize_filenames():
    """Rename any save file whose stem isn't already its own slug.

    Why this matters: every API path component goes through
    slugify() in safe_save_path(), so the on-disk filename MUST be
    a slug form for load/save/delete/move to find the file.
    `import_characters.py` writes slugs by design, but files
    placed directly into the saves tree (e.g. drag-dropped from the
    user's old exports folder) preserve their original name —
    "Dust (old).json" stays as-is, and the slug-based lookup
    silently 404s. The move endpoint hit this 2026-05-25 on the
    three files moved verbatim from exported_characters/.

    Runs once at startup, walks the full tree, renames anything
    non-slug to its slug form. On collision (the slugged target
    already exists) we skip with a warning rather than overwrite.
    Idempotent: re-running finds nothing to do.
    """
    if not SAVE_DIR.exists():
        return
    renamed = []
    skipped = []
    for path in SAVE_DIR.rglob("*.json"):
        stem = path.stem
        target_stem = slugify(stem)
        if stem == target_stem:
            continue   # already slug form
        target = path.with_name(f"{target_stem}.json")
        # Windows-case-insensitivity catch: target.exists() returns
        # True when the slug differs only by case on a case-
        # insensitive FS, because the target IS the source file. Do a
        # two-step rename via a temp name to force the case change.
        if target.exists():
            try:
                if path.samefile(target):
                    tmp = path.with_name(f"_tmpnorm_{target_stem}.json")
                    path.rename(tmp)
                    tmp.rename(target)
                    renamed.append((path, target))
                    continue
            except OSError:
                pass
            skipped.append((path, target))
            continue
        try:
            path.rename(target)
            renamed.append((path, target))
        except OSError as e:
            print(
                f"[save_server] could not normalize {path.name}: {e}",
                file=sys.stderr,
            )
    if renamed:
        print(
            f"[save_server] normalized {len(renamed)} filename"
            f"{'s' if len(renamed) != 1 else ''} to slug form:",
            file=sys.stderr,
        )
        for src, dst in renamed:
            print(f"  {src.name} -> {dst.name}", file=sys.stderr)
    if skipped:
        print(
            f"[save_server] {len(skipped)} non-slug file(s) skipped — "
            f"slug target already exists (manual resolve needed):",
            file=sys.stderr,
        )
        for src, dst in skipped:
            print(f"  {src.name} (would clobber {dst.name})",
                  file=sys.stderr)


_normalize_filenames()


def safe_save_path(qualified: str) -> Path:
    """Resolve a qualified save name to a path inside SAVE_DIR.

    `qualified` is either a bare name ("Dust") or a folder/name path
    ("library/Anapa", "active/Dust"). Each segment is slugified
    individually. Result is verified to live under SAVE_DIR via a
    resolve-and-check, so `..` traversal attempts are blocked even
    if slugify ever changes.

    Folder depth is bounded to 4 — deeper trees risk filesystem
    surprises and are pointless for a character library. A future
    expansion (campaign / setting / source / character) would still
    fit.
    """
    parts = [p for p in qualified.split("/") if p]
    if not parts:
        raise ValueError("empty qualified name")
    if len(parts) > 4:
        raise ValueError("folder depth too deep (max 4)")
    slugs = [slugify(p) for p in parts]
    slugs[-1] = slugs[-1] + ".json"
    p = SAVE_DIR.joinpath(*slugs).resolve()
    save_dir_resolved = SAVE_DIR.resolve()
    # Resolve handles symlinks + `..`; verify the final path is
    # actually inside SAVE_DIR.
    if save_dir_resolved != p.parent and save_dir_resolved not in p.parents:
        raise ValueError("path escape attempt")
    return p


def list_saves() -> list:
    """Walk SAVE_DIR recursively, returning a flat list of
    {name, slug, folder, qualified, modified, size, tags} dicts.

    `name` comes from the JSON's `char-name` field when present
    (falls back to slug — useful for the imported_characters set
    where many saves have an empty char-name and rely on filename).

    `folder` is the relative dir path from SAVE_DIR, '' for root.
    `qualified` is the API-callable identifier: "folder/name" or
    just "name" for root.

    `tags` is the JSON's `_tags` array (lowercased + dedupe'd) so
    the list-view UI can filter by tag without a second load pass.

    Skips any file that isn't valid JSON — never raises. The
    save_server is best-effort: one corrupt save shouldn't blank
    the entire library listing.
    """
    out = []
    save_dir_resolved = SAVE_DIR.resolve()
    for entry in sorted(SAVE_DIR.rglob("*.json")):
        try:
            rel = entry.resolve().relative_to(save_dir_resolved)
            folder = "/".join(rel.parts[:-1])
            # slug always returns the slug-form of the stem. For
            # already-normalized filenames (the common case) this
            # is a no-op since slugify is idempotent. For non-slug
            # filenames that somehow slipped past _normalize_filenames
            # (raced server-restart, etc.), the qualified will still
            # be load-by-API addressable IF the file is renamed on
            # the next startup. Until then load may 404 — log so
            # the user sees the issue.
            slug = slugify(entry.stem)
            if slug != entry.stem:
                print(
                    f"[save_server] non-slug filename in tree: "
                    f"{entry} (will normalize on next restart)",
                    file=sys.stderr,
                )
            stat = entry.stat()
            with entry.open(encoding="utf-8") as fp:
                data = json.load(fp)
            name = (data.get("char-name") or "").strip() or slug
            tags_raw = data.get("_tags") or []
            tags = sorted({
                str(t).strip().lower()
                for t in tags_raw
                if isinstance(t, str) and t.strip()
            })
            # Qualified uses the SLUG (stable filesystem identity),
            # not the display name. The list-view UI shows `name`
            # for human reading but uses `qualified` as the load /
            # save / delete identifier — so a rename (which only
            # changes char-name, not the file slug) stays loadable.
            # Previously qualified used display name, which broke
            # load-by-qualified after any rename.
            qualified = f"{folder}/{slug}" if folder else slug
            out.append({
                "name": name,
                "slug": slug,
                "folder": folder,
                "qualified": qualified,
                "modified": datetime.fromtimestamp(
                    stat.st_mtime, tz=timezone.utc
                ).isoformat(),
                "size": stat.st_size,
                "tags": tags,
            })
        except (OSError, json.JSONDecodeError, ValueError) as e:
            print(
                f"[save_server] skipping {entry}: {e}",
                file=sys.stderr,
            )
    return out


# ---------------------------------------------------------------------------
# Asset version — replaces the hand-bumped CACHE_VERSION
#
# index.html pins a `?v=<version>` on every module + the stylesheet so the
# browser can cache them, and that version used to be a date string a human
# had to remember to increment. Forgetting it means you're staring at stale
# JS wondering why your fix "didn't take" — which has cost real debugging
# time more than once.
#
# So: derive it from the assets themselves. The stamp is the newest mtime
# across every .js/.css the page loads, hashed short. It changes exactly when
# a source file changes — no manual step — while still letting the browser
# cache normally between edits, which a per-load timestamp would not (2.2 MB
# across 63 files re-fetched on every reload, parse cache thrown away).
#
# The server substitutes it into index.html on the way out. Under plain
# `python -m http.server` no substitution happens and the page falls back to
# its pinned literal, so the sheet still works exactly as before.
_ASSET_GLOBS = ("*.js", "*.css", "homebrew/*.js", "tests/*.js")

# The literal index.html carries this token; the server swaps in the real
# stamp. Kept deliberately un-versionlike so the "no hand-edited ?v= literals"
# guard in tests/test_pickers.js can't mistake it for one.
_ASSET_VERSION_TOKEN = "__ASSET_VERSION__"


def asset_version(root: Path) -> str:
    """Short stamp over the newest .js/.css mtime + the file count.

    The count is in the hash so that DELETING a file also moves the stamp —
    mtime alone wouldn't notice, and a removed module that stayed cached is
    exactly the kind of ghost that wastes an afternoon.
    """
    newest = 0.0
    count = 0
    for pattern in _ASSET_GLOBS:
        for p in root.glob(pattern):
            try:
                newest = max(newest, p.stat().st_mtime)
                count += 1
            except OSError:
                continue
    if not count:
        return ""
    raw = f"{newest:.6f}:{count}".encode()
    return hashlib.sha1(raw).hexdigest()[:10]


class CharacterSheetHandler(http.server.SimpleHTTPRequestHandler):
    """Static-file handler with /api/saves overlay."""

    # HTTP/1.1 so connections are KEPT ALIVE and reused. The default
    # (HTTP/1.0) forces one TCP connection per request, and a cold page
    # load asks for ~62 module scripts plus the 30 MB DB blob all at once
    # — 64 simultaneous connections, which overflowed the accept queue and
    # got individual scripts reset (WinError 10054). That surfaced as
    # random "module FAILED: class-picker.js (load error / 404)" entries
    # and a LoadTracker auto-reload. With keep-alive the browser reuses
    # its ~6 per-origin sockets instead.
    #
    # Safe here because every response sets an accurate Content-Length:
    # _send_json does, SimpleHTTPRequestHandler.send_head does for static
    # files, send_error does, and the two 204 replies carry no body by
    # definition. Without that, HTTP/1.1 keep-alive would desync the stream.
    protocol_version = "HTTP/1.1"

    # Don't let an abandoned keep-alive socket hold its worker thread
    # forever (each connection owns one under ThreadingHTTPServer).
    timeout = 60

    # Disable the default request logging — too noisy with the
    # picker queries hammering the DB blob on every modal open.
    # Keep API requests + errors though so the user can see saves
    # working in the terminal.
    def log_message(self, fmt, *args):
        # getattr, not self.path: a keep-alive socket that times out before
        # sending a request line never sets `path`, and http.server logs THAT
        # through here — so the plain attribute raised AttributeError from
        # inside the logger and took the connection thread down with a
        # traceback. Latent since keep-alive went in; the live bus's long polls
        # made idle-then-timeout sockets routine and turned it into a steady
        # drip of tracebacks in the terminal during play.
        if getattr(self, "path", "").startswith("/api/") or "code" in fmt:
            sys.stderr.write("[%s] %s - %s\n" % (
                self.log_date_time_string(),
                self.address_string(),
                fmt % args,
            ))

    # ---- Routing --------------------------------------------------------

    def do_GET(self):
        if self.path == "/api/health":
            return self._send_json(200, {
                "ok": True,
                "save_dir": str(SAVE_DIR),
                "save_count": sum(1 for _ in SAVE_DIR.rglob("*.json")),
            })
        if self.path == "/api/saves":
            return self._send_json(200, {"saves": list_saves()})
        if self.path.startswith("/api/saves/"):
            return self._api_get_save()
        if self.path.startswith("/api/flags/"):
            return self._api_get_flags()
        if self.path == "/api/live":
            return self._api_list_live()
        if self.path == "/api/live-writable":
            return self._api_live_writable()
        if self.path.startswith("/api/live-commands/"):
            return self._api_live_commands()
        if self.path.startswith("/api/live/"):
            return self._api_get_live()
        if self._is_index_request():
            return self._serve_index()
        # Everything else is a static file.
        return super().do_GET()

    def _is_index_request(self) -> bool:
        path = urllib.parse.urlparse(self.path).path
        return path in ("/", "/index.html")

    def _serve_index(self):
        """Serve index.html with the asset-version placeholder filled in.

        Never fails the page: any problem reading or stamping falls through to
        the normal static handler, which serves the file untouched (its pinned
        fallback still works).
        """
        try:
            html = (Path.cwd() / "index.html").read_text(encoding="utf-8")
        except OSError:
            return super().do_GET()
        stamp = asset_version(Path.cwd())
        if stamp:
            html = html.replace(_ASSET_VERSION_TOKEN, stamp, 1)
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # The DOCUMENT must never be cached — it carries the stamp that
        # invalidates everything else, so a stale index.html would pin every
        # module to an old version. (Editing markup and seeing nothing change
        # because the browser cached index.html is a genuine trap; it cost a
        # false "the fix isn't working" reading on 2026-07-31.)
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_PUT(self):
        if self.path.startswith("/api/saves/"):
            return self._api_put_save()
        if self.path.startswith("/api/flags/"):
            return self._api_put_flags()
        if self.path.startswith("/api/live/"):
            return self._api_put_live()
        self.send_error(405, "method not allowed")

    # ---- API: live resolved-state bus -----------------------------------

    def _live_key(self):
        """The qualified save name from /api/live/<qualified>, or None."""
        return self._live_key_for("/api/live/")

    def _live_key_for(self, prefix):
        """The qualified save name following `prefix`, or None if unusable.

        A qualified name legitimately CONTAINS slashes ("active/Gorrash Head
        Smasher"), which is why phase 2's verbs live in sibling namespaces
        (/api/live-write/<qualified>) rather than as a trailing path segment:
        with the name last, there is no way to tell a verb from a character
        called "write" without guessing, and guessing wrong on somebody's
        character name is a bug that would surface once a year and make no
        sense when it did.
        """
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith(prefix):
            return None
        raw = urllib.parse.unquote(path[len(prefix):]).strip("/")
        # Same containment rule as the save endpoints: a key is a plain
        # qualified name, never a traversal.
        if not raw or ".." in raw or raw.startswith("/") or "\\" in raw:
            return None
        return raw

    @staticmethod
    def _live_view(key, rec, now):
        age = max(0.0, now - rec["received_at"])
        return {
            "qualified": key,
            "age_seconds": round(age, 1),
            # The consumer's contract: stale means TREAT AS ABSENT. It does
            # not mean "slightly old but probably fine" — a tab that closed
            # an hour ago still has a snapshot that reads perfectly.
            "stale": age > LIVE_STALE_AFTER_SEC,
            "stale_after_seconds": LIVE_STALE_AFTER_SEC,
            # Which tab is publishing this, and whether more than one is.
            # CONTESTED is reported rather than resolved: two tabs on one
            # character normally compute the same numbers, but not if one has
            # unsaved edits, and the server cannot tell which is right. A
            # consumer that knows it is reading a contested character can say
            # so; one that is silently handed the last writer's view cannot.
            "publisher": rec.get("publisher"),
            "publishers": sorted((rec.get("publishers") or {}).keys()),
            "contested": len(rec.get("publishers") or {}) > 1,
            "snapshot": rec["snapshot"],
        }

    def _api_put_live(self):
        key = self._live_key()
        if key is None:
            return self._send_json(400, {"error": "bad live key"})
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            payload = json.loads(raw) if raw.strip() else None
        except (ValueError, json.JSONDecodeError) as e:
            return self._send_json(400, {"error": "invalid JSON: %s" % e})
        if not isinstance(payload, dict):
            return self._send_json(400, {"error": "expected a JSON object"})
        now = time.monotonic()
        # Who published this. A stable per-TAB id, minted once per page load and
        # sent with every publish — see the CLAIM/LEASE note above _LIVE.
        publisher = payload.get("publisher") or None
        with _LIVE_LOCK:
            prev = _LIVE.get(key) or {}
            seen = dict(prev.get("publishers") or {})
            if publisher:
                seen[publisher] = now
                # Forget publishers that have gone quiet past the stale window;
                # a tab that closed an hour ago must not make this character
                # look contested forever.
                seen = {p: t for p, t in seen.items()
                        if now - t <= LIVE_STALE_AFTER_SEC}
            _LIVE[key] = {
                "snapshot": payload,
                "received_at": now,
                "publisher": publisher,
                "publishers": seen,
            }
        self.send_response(204)
        self.end_headers()

    def _api_delete_live(self, prefix="/api/live/"):
        """A tab RELEASES its claim — it closed, reloaded, or switched away.

        This is the fix for the read-side hole the staleness contract cannot
        close on its own: a tab that swaps from Kell to Gorrash leaves Kell's
        snapshot sitting in the map looking perfectly fresh for the next 90
        seconds, and a consumer reading it narrates numbers for a character
        NOBODY has open. Staleness catches a tab that died; only the tab itself
        knows it deliberately moved on.

        OWNERSHIP-CHECKED. A release naming a different publisher than the one
        currently holding the key is REFUSED, not obeyed — otherwise a second
        tab on the same character could evict the first one's live snapshot by
        navigating away from it.
        """
        key = self._live_key_for(prefix)
        if key is None:
            return self._send_json(400, {"error": "bad live key"})
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            payload = json.loads(raw) if raw.strip() else {}
        except (ValueError, json.JSONDecodeError):
            payload = {}
        publisher = (payload or {}).get("publisher") or None
        now = time.monotonic()
        with _LIVE_LOCK:
            rec = _LIVE.get(key)
            if not rec:
                return self._send_json(404, {
                    "error": "no live snapshot", "qualified": key})
            holder = rec.get("publisher")
            others = {p: t for p, t in (rec.get("publishers") or {}).items()
                      if p != publisher and now - t <= LIVE_STALE_AFTER_SEC}
            if holder and publisher and holder != publisher and others:
                return self._send_json(409, {
                    "error": "not the current publisher",
                    "qualified": key,
                    "hint": "another tab is publishing this character; a "
                            "release only drops your own claim",
                })
            if others:
                # Someone else still has it open. Drop only this publisher from
                # the roster and leave the snapshot standing.
                rec["publishers"] = others
                rec["publisher"] = sorted(others, key=lambda p: -others[p])[0]
                return self._send_json(200, {
                    "released": True, "qualified": key,
                    "still_published_by": len(others),
                })
            _LIVE.pop(key, None)
        return self._send_json(200, {"released": True, "qualified": key,
                                     "still_published_by": 0})

    def _api_get_live(self):
        key = self._live_key()
        if key is None:
            return self._send_json(400, {"error": "bad live key"})
        now = time.monotonic()
        with _LIVE_LOCK:
            rec = _LIVE.get(key)
            view = self._live_view(key, rec, now) if rec else None
        if view is None:
            # 404, not an empty snapshot. "No tab has this character open"
            # and "here are some numbers" must never look the same.
            return self._send_json(404, {
                "error": "no live snapshot",
                "qualified": key,
                "hint": "no open sheet tab is publishing this character",
            })
        return self._send_json(200, view)

    def _api_list_live(self):
        now = time.monotonic()
        with _LIVE_LOCK:
            items = [self._live_view(k, r, now) for k, r in _LIVE.items()]
        # Summary only — the caller asks for a specific PC to get its
        # snapshot. Keeps the party overview cheap to poll.
        for it in items:
            it.pop("snapshot", None)
        items.sort(key=lambda i: i["qualified"])
        return self._send_json(200, {
            "live": items,
            "fresh": sum(1 for i in items if not i["stale"]),
            "stale_after_seconds": LIVE_STALE_AFTER_SEC,
        })

    # ---- API: live bus phase 2 — inbound writes -------------------------

    def _api_live_writable(self):
        """The ownership split, machine-readable.

        It exists so the split is not prose duplicated in two repositories
        that cannot see each other: a consumer can ask what it owns, and the
        refusal list tells it WHY the rest is refused rather than leaving it
        to guess at a typo.
        """
        return self._send_json(200, {
            "writable": [{"field": p, "kind": k, "description": d}
                         for p, k, d in LIVE_WRITABLE],
            "refused": [{"field": p, "reason": r} for p, r in LIVE_NOT_WRITABLE],
            "absolute_values_only": True,
            "notes": [
                "Field paths are the dotted paths of the published snapshot: "
                "read snapshot['hp']['current'], write 'hp.current'.",
                "Values are absolute, never deltas. Send the number you own.",
                "A write with no fresh publishing tab fails; it does not queue.",
                "Outcomes are three-state: applied / partial / not-applied, "
                "plus 'unknown' when a tab claimed the write and went quiet.",
            ],
            "write_timeout_seconds": LIVE_WRITE_TIMEOUT_SEC,
            "write_timeout_max_seconds": LIVE_WRITE_TIMEOUT_MAX,
            "stale_after_seconds": LIVE_STALE_AFTER_SEC,
        })

    def _read_json_body(self, limit=1024 * 1024):
        """(payload, error_response_sent). Shared by the two phase-2 POSTs."""
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            self._send_json(413, {"error": "payload too large"})
            return None, True
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            payload = json.loads(raw) if raw.strip() else None
        except (ValueError, json.JSONDecodeError) as e:
            self._send_json(400, {"error": "invalid JSON: %s" % e})
            return None, True
        if not isinstance(payload, dict):
            self._send_json(400, {"error": "expected a JSON object"})
            return None, True
        return payload, False

    def _api_live_write(self):
        key = self._live_key_for("/api/live-write/")
        if key is None:
            return self._send_json(400, {"error": "bad live key"})
        payload, sent = self._read_json_body()
        if sent:
            return
        fields = payload.get("fields")
        if not isinstance(fields, dict) or not fields:
            return self._send_json(400, {
                "error": "expected {\"fields\": {\"<path>\": <value>, ...}}"})
        try:
            timeout = float(payload.get("timeout_seconds") or LIVE_WRITE_TIMEOUT_SEC)
        except (TypeError, ValueError):
            timeout = LIVE_WRITE_TIMEOUT_SEC
        timeout = max(0.1, min(LIVE_WRITE_TIMEOUT_MAX, timeout))

        # FAIL FAST WHEN NOBODY IS LISTENING. Mirror of the read side's
        # staleness contract: no fresh tab means the write cannot happen, and
        # saying so now is strictly better than queueing it for a tab that may
        # never come back. 409, and the two causes are distinguished — "never
        # had this character open" and "had it open and went away" are
        # different problems for whoever is reading the error.
        now = time.monotonic()
        with _LIVE_LOCK:
            rec = _LIVE.get(key)
            age = None if rec is None else max(0.0, now - rec["received_at"])
        if rec is None:
            return self._send_json(409, {
                "status": "not-applied",
                "reason": "no-live-tab",
                "qualified": key,
                "hint": "no open sheet tab is publishing this character",
            })
        if age > LIVE_STALE_AFTER_SEC:
            return self._send_json(409, {
                "status": "not-applied",
                "reason": "stale-tab",
                "qualified": key,
                "age_seconds": round(age, 1),
                "stale_after_seconds": LIVE_STALE_AFTER_SEC,
                "hint": "the last publish is older than the stale window; "
                        "treat this character as absent",
            })

        accepted, rejected = {}, []
        for field, value in fields.items():
            ok, reason = live_field_check(field, value)
            if ok:
                accepted[field] = value
            else:
                rejected.append({"field": field, "reason": reason})
        if not accepted:
            return self._send_json(400, {
                "status": "not-applied",
                "reason": "no-writable-fields",
                "qualified": key,
                "rejected": rejected,
                "hint": "GET /api/live-writable lists what a consumer owns",
            })

        with _LIVE_CMD_COND:
            _LIVE_CMD_SEQ[0] += 1
            cmd = {
                "id": "cmd-%d" % _LIVE_CMD_SEQ[0],
                "fields": accepted,
                "source": str(payload.get("source") or "")[:120],
                "reason": str(payload.get("reason") or "")[:400],
                # The deadline is the WRITER's patience, and it is enforced at
                # dispatch: a command whose writer has stopped waiting is never
                # handed to a tab. Late application is the failure mode this
                # whole design is built to avoid.
                "expires_at": now + timeout,
                "dispatched_at": None,
                "result": None,
            }
            _LIVE_CMDS.setdefault(key, []).append(cmd)
            _LIVE_CMD_COND.notify_all()

            deadline = time.monotonic() + timeout
            while cmd["result"] is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                _LIVE_CMD_COND.wait(remaining)

            result = cmd["result"]
            dispatched = cmd["dispatched_at"] is not None
            # Withdraw it either way — identity, not equality, since two
            # commands can carry identical fields.
            queue = [c for c in _LIVE_CMDS.get(key) or [] if c is not cmd]
            if queue:
                _LIVE_CMDS[key] = queue
            else:
                _LIVE_CMDS.pop(key, None)

        if result is not None:
            applied = result.get("applied") or []
            rejected = rejected + (result.get("rejected") or [])
            if len(applied) == len(fields):
                status = "applied"
            elif applied:
                status = "partial"
            else:
                status = "not-applied"
            return self._send_json(200, {
                "status": status,
                "qualified": key,
                "command_id": cmd["id"],
                "applied": applied,
                "rejected": rejected,
                # What the fields actually read back as after the sheet applied
                # and recalculated — a clamp or a coercion shows up here rather
                # than being reported as a clean success.
                "echo": result.get("echo") or {},
                "snapshot": result.get("snapshot"),
            })
        if not dispatched:
            # Certain: no tab ever took it, and it can no longer be taken.
            return self._send_json(504, {
                "status": "not-applied",
                "reason": "no-tab-claimed",
                "qualified": key,
                "command_id": cmd["id"],
                "rejected": rejected,
                "timeout_seconds": timeout,
                "hint": "a tab is publishing but did not poll for commands; "
                        "it may be an older tab without live-commands.js",
            })
        # A tab took it and went quiet. We do not know whether it applied.
        # Saying so is the only honest answer, and this bucket exists precisely
        # so it never gets folded into one of the certain two.
        return self._send_json(504, {
            "status": "unknown",
            "reason": "claimed-but-no-ack",
            "qualified": key,
            "command_id": cmd["id"],
            "rejected": rejected,
            "timeout_seconds": timeout,
            "hint": "the tab claimed this write and did not acknowledge in "
                    "time; it may or may not have applied. Re-read the "
                    "snapshot before deciding.",
        })

    def _api_live_commands(self):
        """A tab long-polls here for work. Returns instantly when work waits."""
        key = self._live_key_for("/api/live-commands/")
        if key is None:
            return self._send_json(400, {"error": "bad live key"})
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        try:
            wait = float((query.get("wait") or [LIVE_POLL_MAX_SEC])[0])
        except (TypeError, ValueError):
            wait = LIVE_POLL_MAX_SEC
        wait = max(0.0, min(LIVE_POLL_MAX_SEC, wait))

        deadline = time.monotonic() + wait
        with _LIVE_CMD_COND:
            while True:
                now = time.monotonic()
                ready = []
                for cmd in _LIVE_CMDS.get(key) or []:
                    if cmd["dispatched_at"] is not None:
                        continue          # another tab already took it
                    if cmd["expires_at"] <= now:
                        continue          # writer stopped waiting; never apply
                    cmd["dispatched_at"] = now
                    ready.append(cmd)
                if ready:
                    out = [{"id": c["id"], "fields": c["fields"],
                            "source": c["source"], "reason": c["reason"]}
                           for c in ready]
                    break
                remaining = deadline - now
                if remaining <= 0:
                    out = []
                    break
                _LIVE_CMD_COND.wait(remaining)
        return self._send_json(200, {
            "qualified": key,
            "commands": out,
            "poll_max_seconds": LIVE_POLL_MAX_SEC,
        })

    def _api_live_ack(self):
        """A tab reports what it did, and publishes in the same breath.

        The ack carries the post-recalc snapshot and it is stored exactly like
        a PUT publish would store it, which is what makes the snapshot handed
        back to the writer identical to what any reader would get. One code
        path, so the two can never drift.
        """
        key = self._live_key_for("/api/live-ack/")
        if key is None:
            return self._send_json(400, {"error": "bad live key"})
        payload, sent = self._read_json_body(limit=10 * 1024 * 1024)
        if sent:
            return
        snapshot = payload.get("snapshot")
        if isinstance(snapshot, dict):
            with _LIVE_LOCK:
                _LIVE[key] = {"snapshot": snapshot, "received_at": time.monotonic()}
        results = payload.get("results")
        if not isinstance(results, list):
            results = []
        with _LIVE_CMD_COND:
            queue = {c["id"]: c for c in _LIVE_CMDS.get(key) or []}
            for item in results:
                if not isinstance(item, dict):
                    continue
                cmd = queue.get(item.get("id"))
                if cmd is None:
                    continue      # the writer already timed out and withdrew it
                cmd["result"] = {
                    "applied": item.get("applied") or [],
                    "rejected": item.get("rejected") or [],
                    "echo": item.get("echo") or {},
                    "snapshot": snapshot,
                }
            _LIVE_CMD_COND.notify_all()
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        # `navigator.sendBeacon` can only POST, and it is the only request that
        # reliably survives a page unload — which is exactly when a tab most
        # needs to release its claim. Same handler as the DELETE.
        if self.path.startswith("/api/live-release/"):
            return self._api_delete_live(prefix="/api/live-release/")
        # /api/move is the atomic rename / folder-move endpoint —
        # used by the library modal's "→ active" / "→ library"
        # buttons. Lives at a separate URL (not under /api/saves/)
        # so the path matching for save load/PUT/DELETE stays
        # unambiguous. Body: {"from": "<qualified>", "to": "<qualified>"}.
        if self.path == "/api/move":
            return self._api_move_save()
        if self.path.startswith("/api/flags/"):
            return self._api_post_flags()
        if self.path.startswith("/api/live-write/"):
            return self._api_live_write()
        if self.path.startswith("/api/live-ack/"):
            return self._api_live_ack()
        if self.path == "/api/loadstatus":
            return self._api_loadstatus()
        self.send_error(405, "method not allowed")

    def _api_loadstatus(self):
        """Dev-only: the sheet's LoadTracker POSTs its terminal load state here
        (only when the page URL carries ?loadsignal), and we drop it in
        reviews/_loadstatus.json. A watcher (or the developer) can poll that file
        to know when the page finished loading / gave up, instead of polling the
        browser. Not used in normal operation."""
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            payload = json.loads(raw) if raw.strip() else {}
            if not isinstance(payload, dict):
                payload = {}
        except (ValueError, json.JSONDecodeError):
            payload = {}
        try:
            REVIEWS_DIR.mkdir(parents=True, exist_ok=True)
            (REVIEWS_DIR / "_loadstatus.json").write_text(
                json.dumps(payload, indent=2), encoding="utf-8")
        except OSError as e:
            return self._send_json(500, {"error": str(e)})
        return self._send_json(200, {"ok": True})

    def do_DELETE(self):
        if self.path.startswith("/api/saves/"):
            return self._api_delete_save()
        # A tab releasing its live claim (it closed, reloaded, or swapped to a
        # different character). Ordered after /api/saves/ because both are
        # DELETEs and the prefixes are distinct.
        if self.path.startswith("/api/live/"):
            return self._api_delete_live()
        self.send_error(405, "method not allowed")

    # ---- API: per-save GET/PUT/DELETE ----------------------------------

    def _api_get_save(self):
        name = self._extract_name()
        if name is None:
            return  # error already sent
        try:
            path = safe_save_path(name)
        except ValueError as e:
            return self._send_json(400, {"error": str(e)})
        if not path.exists():
            return self._send_json(404, {"error": "save not found"})
        try:
            body = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            # No-cache — the client just made an explicit request,
            # we don't want the browser handing it stale data.
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except OSError as e:
            self._send_json(500, {"error": str(e)})

    def _api_put_save(self):
        name = self._extract_name()
        if name is None:
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return self._send_json(400, {"error": "empty body"})
        if length > 10 * 1024 * 1024:
            # 10 MB is generous — a fully-tricked-out character with
            # full level-history and 100s of attacks is maybe 100 KB.
            return self._send_json(413, {"error": "payload too large"})
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("save payload must be a JSON object")
        except (ValueError, json.JSONDecodeError) as e:
            return self._send_json(400, {"error": f"invalid JSON: {e}"})

        try:
            path = safe_save_path(name)
        except ValueError as e:
            return self._send_json(400, {"error": str(e)})
        # Auto-create parent folders for hierarchical PUTs (e.g.
        # /api/saves/library/Anapa creates saves/library/ if missing).
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            # Pretty-print the JSON so the on-disk file is
            # human-readable (and diffable for git/Dropbox users).
            with tmp.open("w", encoding="utf-8") as fp:
                json.dump(payload, fp, indent=2, ensure_ascii=False)
            os.replace(tmp, path)
        except OSError as e:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            return self._send_json(500, {"error": str(e)})

        self.send_response(204)
        self.end_headers()

    def _api_delete_save(self):
        name = self._extract_name()
        if name is None:
            return
        try:
            path = safe_save_path(name)
        except ValueError as e:
            return self._send_json(400, {"error": str(e)})
        if not path.exists():
            return self._send_json(404, {"error": "save not found"})
        try:
            path.unlink()
        except OSError as e:
            return self._send_json(500, {"error": str(e)})
        # Best-effort: clean up empty parent dirs (e.g. delete
        # saves/library/Foo, library/ now empty → remove it). Stops
        # at SAVE_DIR root. rmdir fails-silent if dir isn't empty.
        try:
            parent = path.parent
            save_root = SAVE_DIR.resolve()
            while parent.resolve() != save_root and parent.resolve().is_relative_to(save_root):
                parent.rmdir()  # raises OSError if not empty — we stop
                parent = parent.parent
        except OSError:
            pass  # parent dir not empty or already gone — fine
        self.send_response(204)
        self.end_headers()

    # ---- API: review flags GET/PUT -------------------------------------

    def _flag_surface(self):
        """Extract + validate the surface from /api/flags/<surface>. Sends the
        error + returns None on a bad surface."""
        surface = urllib.parse.unquote(self.path[len("/api/flags/"):]).strip("/")
        if flags_path(surface) is None:
            self._send_json(404, {"error": "unknown flag surface"})
            return None
        return surface

    def _api_get_flags(self):
        surface = self._flag_surface()
        if surface is None:
            return
        path = flags_path(surface)
        if not path.exists():
            # Empty store — return the canonical empty shape, not a 404, so the
            # client can treat "no file yet" and "no flags yet" identically.
            return self._send_json(200, {"flags": []})
        try:
            body = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except OSError as e:
            self._send_json(500, {"error": str(e)})

    def _api_post_flags(self):
        """Atomic op-based mutation of a flag surface. Body is a single op
        (add / resolve / remove — see apply_flag_op). Returns the full new
        state so the client can adopt authoritative state (picking up any
        flags other tabs added concurrently) instead of trusting its own
        stale snapshot. This replaces the whole-array PUT for mutations."""
        surface = self._flag_surface()
        if surface is None:
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return self._send_json(400, {"error": "empty body"})
        if length > 1 * 1024 * 1024:
            return self._send_json(413, {"error": "payload too large"})
        raw = self.rfile.read(length)
        try:
            op = json.loads(raw)
            if not isinstance(op, dict):
                raise ValueError("op payload must be a JSON object")
        except (ValueError, json.JSONDecodeError) as e:
            return self._send_json(400, {"error": f"invalid JSON: {e}"})
        try:
            data = apply_flag_op(flags_path(surface), op)
        except ValueError as e:
            return self._send_json(400, {"error": str(e)})
        except OSError as e:
            return self._send_json(500, {"error": str(e)})
        return self._send_json(200, data)

    def _api_put_flags(self):
        surface = self._flag_surface()
        if surface is None:
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return self._send_json(400, {"error": "empty body"})
        if length > 5 * 1024 * 1024:
            return self._send_json(413, {"error": "payload too large"})
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("flags payload must be a JSON object")
        except (ValueError, json.JSONDecodeError) as e:
            return self._send_json(400, {"error": f"invalid JSON: {e}"})
        path = flags_path(surface)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            with tmp.open("w", encoding="utf-8") as fp:
                json.dump(payload, fp, indent=2, ensure_ascii=False)
            os.replace(tmp, path)
        except OSError as e:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            return self._send_json(500, {"error": str(e)})
        self.send_response(204)
        self.end_headers()

    def _api_move_save(self):
        """Atomic move: rename a save from one qualified path to
        another. Body: {"from": "library/anapa", "to": "active/anapa"}.

        Uses os.rename — atomic within a single filesystem, which is
        always the case here since both paths are under SAVE_DIR.

        Refuses to overwrite an existing destination (returns 409).
        The user can DELETE the destination first if they actually
        want to replace it; we don't auto-overwrite because moves are
        triggered by single-click UI and silent overwrites lose data.

        Auto-creates the destination parent dir (e.g. moving from root
        into a brand-new folder); cleans up the source's parent if
        empty after the move (mirrors DELETE's behavior).
        """
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 4096:
            return self._send_json(400, {"error": "invalid body length"})
        try:
            payload = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError) as e:
            return self._send_json(400, {"error": f"invalid JSON: {e}"})
        if not isinstance(payload, dict):
            return self._send_json(400, {"error": "body must be an object"})
        from_q = payload.get("from")
        to_q = payload.get("to")
        if not isinstance(from_q, str) or not isinstance(to_q, str):
            return self._send_json(400, {
                "error": "'from' and 'to' must be strings"})

        try:
            from_path = safe_save_path(from_q)
            to_path = safe_save_path(to_q)
        except ValueError as e:
            return self._send_json(400, {"error": str(e)})

        if not from_path.exists():
            return self._send_json(404, {"error": "source not found"})
        if from_path == to_path:
            # No-op. Return 204 so the client can treat it as success.
            self.send_response(204)
            self.end_headers()
            return
        if to_path.exists():
            return self._send_json(409, {
                "error": "destination already exists — "
                "delete it first or pick a different name"})

        to_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.rename(from_path, to_path)
        except OSError as e:
            return self._send_json(500, {"error": str(e)})

        # Clean up empty source-parent dir(s), same as DELETE does.
        try:
            parent = from_path.parent
            save_root = SAVE_DIR.resolve()
            while (parent.resolve() != save_root
                   and parent.resolve().is_relative_to(save_root)):
                parent.rmdir()
                parent = parent.parent
        except OSError:
            pass

        self.send_response(204)
        self.end_headers()

    # ---- Helpers --------------------------------------------------------

    def _extract_name(self):
        """Pull and URL-decode the qualified name from
        /api/saves/<folder>/<name> (or /api/saves/<name>). Each segment
        is decoded separately so spaces ("%20"), apostrophes, etc.
        survive. The decoded path components must NOT themselves
        contain "/" — that's reserved as the path separator. Empty or
        traversal-attempt paths get a 400.

        Returns the qualified name as "folder/name" (or just "name"),
        ready to pass to safe_save_path() which handles slugification
        + escape-check.
        """
        suffix = self.path[len("/api/saves/"):]
        if not suffix:
            self._send_json(400, {"error": "missing name"})
            return None
        parts = []
        for raw_seg in suffix.split("/"):
            seg = urllib.parse.unquote(raw_seg)
            # A decoded segment that itself contains "/" would mean
            # the caller double-encoded — reject for safety, since
            # downstream slugify would conflate it with hierarchy.
            if not seg or "/" in seg or seg in (".", ".."):
                self._send_json(400, {"error": "invalid path segment"})
                return None
            parts.append(seg)
        return "/".join(parts)

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


class CharacterSheetServer(http.server.ThreadingHTTPServer):
    """Threading server with a listen backlog sized for a cold page load.

    socketserver's default request_queue_size is 5. The sheet opens far
    more sockets than that in its first burst, and everything past the
    backlog gets refused by the OS before any worker thread can accept
    it — the other half of the dropped-script bug (see the handler's
    protocol_version note). 128 leaves plenty of headroom for several
    tabs loading at once.
    """

    request_queue_size = 128
    # Re-bind immediately after a restart instead of tripping over a
    # socket still in TIME_WAIT.
    allow_reuse_address = True

    # Client-side disconnects are NORMAL here, not errors: every character
    # swap aborts a parked long poll, every closed tab drops a keep-alive
    # socket, and a reload does both. socketserver's default prints a full
    # traceback for each, which buries the API log this server exists to make
    # readable. Stay quiet for those three — and ONLY those three; anything
    # else still gets its traceback, because a server that ate real errors
    # would be worse than a noisy one.
    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def main():
    port = 3000
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"bad port: {sys.argv[1]}", file=sys.stderr)
            sys.exit(2)

    bind = "127.0.0.1"
    print(
        f"D&D 3.5 Character Sheet server\n"
        f"  Serving:    {Path(__file__).parent}\n"
        f"  Save dir:   {SAVE_DIR}\n"
        f"  Listening:  http://{bind}:{port}/\n"
        f"\n"
        f"Open http://{bind}:{port}/ in your browser.\n"
        f"Ctrl+C to stop.\n",
        flush=True,
    )

    # SimpleHTTPRequestHandler serves files from the CWD, so cd to
    # our own directory before binding. Caller (serve.bat) does this
    # too, but belt-and-suspenders for when the user runs the script
    # directly from elsewhere.
    os.chdir(Path(__file__).parent)

    server = CharacterSheetServer((bind, port), CharacterSheetHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
