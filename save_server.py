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
import http.server
import json
import os
import re
import sys
import threading
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


class CharacterSheetHandler(http.server.SimpleHTTPRequestHandler):
    """Static-file handler with /api/saves overlay."""

    # Disable the default request logging — too noisy with the
    # picker queries hammering the DB blob on every modal open.
    # Keep API requests + errors though so the user can see saves
    # working in the terminal.
    def log_message(self, fmt, *args):
        if self.path.startswith("/api/") or "code" in fmt:
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
        # Everything else is a static file.
        return super().do_GET()

    def do_PUT(self):
        if self.path.startswith("/api/saves/"):
            return self._api_put_save()
        if self.path.startswith("/api/flags/"):
            return self._api_put_flags()
        self.send_error(405, "method not allowed")

    def do_POST(self):
        # /api/move is the atomic rename / folder-move endpoint —
        # used by the library modal's "→ active" / "→ library"
        # buttons. Lives at a separate URL (not under /api/saves/)
        # so the path matching for save load/PUT/DELETE stays
        # unambiguous. Body: {"from": "<qualified>", "to": "<qualified>"}.
        if self.path == "/api/move":
            return self._api_move_save()
        if self.path.startswith("/api/flags/"):
            return self._api_post_flags()
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

    server = http.server.ThreadingHTTPServer(
        (bind, port), CharacterSheetHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
