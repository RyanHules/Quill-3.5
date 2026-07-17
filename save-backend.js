// save-backend.js — character storage abstraction.
//
// Two backends, identical async API:
//
//   1. `server`        — Python save_server.py over /api/saves/*.
//                        Saves live as JSON files in <project>/saves/,
//                        organized into subfolders (saves/active/,
//                        saves/library/, etc.). Folder-aware list +
//                        load + save + delete. Origin-agnostic, git-
//                        trackable.
//   2. `localStorage`  — legacy fallback. Saves live in the browser
//                        under STORAGE_KEY as a single flat dict
//                        {qualifiedName: data}. The qualified name
//                        ("library/Anapa") gets stored as a literal
//                        string key, so folder semantics are
//                        preserved enough for the list view to group
//                        by it, but there's no real filesystem
//                        underneath. Used when the page is served by
//                        plain `python -m http.server`.
//
// At module load we probe `/api/health`. If it responds with
// `{ok: true}`, mode = 'server'; otherwise mode = 'localStorage'.
// The page still works when served by plain `python -m http.server`
// — server mode is an enhancement, not a requirement.
//
// Identifier convention: every save has a "qualified name" — a
// string of the form "folder/name" (e.g. "library/Anapa",
// "active/Dust") or just "name" for root. All API calls take the
// qualified name; the server slugifies each segment for the
// on-disk filename. Display names live inside the JSON's
// `char-name` field.
//
// Public API (all async; await before using):
//
//   SaveBackend.ready                 - Promise<void>; resolves
//                                       after server probe completes.
//   SaveBackend.mode                  - 'server' | 'localStorage'.
//   SaveBackend.list()                - Promise<Array<{name, slug,
//                                       folder, qualified, modified,
//                                       size, tags}>>
//   SaveBackend.load(qualified)       - Promise<obj|null>
//   SaveBackend.save(qualified, data) - Promise<void>
//   SaveBackend.delete(qualified)     - Promise<void>
//   SaveBackend.move(fromQ, toQ)      - Promise<void>; atomic on
//                                       server (os.rename), throws
//                                       on dest-exists collision.
//   SaveBackend.serverInfo()          - Promise<{save_dir,
//                                                save_count}|null>
//   SaveBackend.migrateFromLocalStorage()
//                                     - Promise<{copied, skipped,
//                                                errors, total}>
//   SaveBackend.hasLocalStorageSaves()
//                                     - bool; true when the legacy
//                                       localStorage dict has
//                                       characters in it.
//   SaveBackend.parseQualified(qual)  - { folder, name } helper
//   SaveBackend.MIGRATION_DONE_KEY    - localStorage flag.
//   SaveBackend.CHARACTERS_KEY        - the localStorage dict key.
//
// Resilience: if the server dies mid-session, save() will fail
// loudly (rejected promise) — caller (app.js) catches and shows a
// notification. It does NOT silently fall back to localStorage,
// because that would split the user's saves across two stores
// without them realizing.

(function () {
  const CHARACTERS_KEY = 'dnd35_characters';
  const MIGRATION_DONE_KEY = 'dnd35_migration_done';
  const HEALTH_URL = '/api/health';
  const SAVES_URL = '/api/saves';

  let mode = 'unknown';
  let serverInfo = null;

  // ---- Probe at module load -----------------------------------------------

  const ready = (async function probe() {
    try {
      const r = await fetch(HEALTH_URL, { cache: 'no-store' });
      if (r.ok) {
        const data = await r.json();
        if (data && data.ok) {
          mode = 'server';
          serverInfo = data;
          console.log(
            `[save-backend] server mode — saves at ${data.save_dir} ` +
            `(${data.save_count} on disk)`);
          return;
        }
      }
    } catch (e) {
      // Plain http.server returns 404 on /api/health (which is fine
      // — that's the fallback path). Network errors fall through too.
    }
    mode = 'localStorage';
    console.log(
      '[save-backend] localStorage mode — run save_server.py for ' +
      'port-independent, folder-organized saves');
  })();

  // ---- Qualified-name helpers --------------------------------------------

  // "library/Anapa" -> { folder: 'library', name: 'Anapa' }
  // "Dust"          -> { folder: '',        name: 'Dust' }
  function parseQualified(qualified) {
    const idx = String(qualified || '').indexOf('/');
    if (idx < 0) return { folder: '', name: String(qualified || '') };
    return {
      folder: String(qualified).slice(0, idx),
      name: String(qualified).slice(idx + 1),
    };
  }

  // ---- localStorage helpers (legacy backend) ------------------------------
  //
  // The localStorage dict's keys are now qualified names — "Dust",
  // "library/Anapa", etc. — so users in fallback mode can still see
  // the folder structure in the list view (even though there's no
  // real filesystem). Backward-compat: existing localStorage saves
  // (no folder prefix) just appear at root, which is correct.

  function readLocalStorageDict() {
    try {
      return JSON.parse(localStorage.getItem(CHARACTERS_KEY)) || {};
    } catch {
      return {};
    }
  }

  function writeLocalStorageDict(dict) {
    localStorage.setItem(CHARACTERS_KEY, JSON.stringify(dict));
  }

  function hasLocalStorageSaves() {
    const dict = readLocalStorageDict();
    return Object.keys(dict).length > 0;
  }

  // Synthesize the rich list-entry shape from a localStorage dict
  // entry. modified/size are stubbed since we don't track them in
  // localStorage; UI should tolerate them being absent.
  function localStorageListEntry(qualified, data) {
    const { folder, name: bareName } = parseQualified(qualified);
    const displayName = (data && data['char-name']) || bareName || qualified;
    const tags = Array.isArray(data && data._tags)
      ? data._tags
          .filter(t => typeof t === 'string' && t.trim())
          .map(t => t.trim().toLowerCase())
      : [];
    return {
      name: displayName,
      slug: bareName,
      folder,
      qualified,
      modified: null,
      size: JSON.stringify(data || {}).length,
      tags: [...new Set(tags)].sort(),
    };
  }

  // ---- Server helpers -----------------------------------------------------

  // Build /api/saves/<folder>/<name> with each segment encoded
  // independently. Empty folder → /api/saves/<name>. This matches
  // the server's _extract_name which decodes per-segment.
  function serverUrl(qualified) {
    const { folder, name } = parseQualified(qualified);
    const parts = [];
    if (folder) {
      for (const seg of folder.split('/')) {
        if (seg) parts.push(encodeURIComponent(seg));
      }
    }
    parts.push(encodeURIComponent(name));
    return SAVES_URL + '/' + parts.join('/');
  }

  async function serverList() {
    const r = await fetch(SAVES_URL, { cache: 'no-store' });
    if (!r.ok) throw new Error(`list failed: HTTP ${r.status}`);
    const data = await r.json();
    return (data.saves || []).slice();
  }

  async function serverLoad(qualified) {
    const r = await fetch(serverUrl(qualified), { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`load failed: HTTP ${r.status}`);
    return await r.json();
  }

  async function serverSave(qualified, data) {
    const r = await fetch(serverUrl(qualified), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!r.ok) {
      let detail = '';
      try {
        const j = await r.json();
        detail = j.error ? `: ${j.error}` : '';
      } catch {}
      throw new Error(`save failed: HTTP ${r.status}${detail}`);
    }
  }

  async function serverDelete(qualified) {
    const r = await fetch(serverUrl(qualified), { method: 'DELETE' });
    if (r.status === 404) return;   // already gone — treat as success
    if (!r.ok) throw new Error(`delete failed: HTTP ${r.status}`);
  }

  async function serverMove(fromQ, toQ) {
    const r = await fetch('/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromQ, to: toQ }),
    });
    if (!r.ok) {
      let detail = '';
      try {
        const j = await r.json();
        detail = j.error ? `: ${j.error}` : '';
      } catch {}
      throw new Error(`move failed: HTTP ${r.status}${detail}`);
    }
  }

  // ---- Public API ---------------------------------------------------------

  async function list() {
    await ready;
    if (mode === 'server') return await serverList();
    const dict = readLocalStorageDict();
    return Object.keys(dict).sort()
      .map(q => localStorageListEntry(q, dict[q]));
  }

  async function load(qualified) {
    await ready;
    if (mode === 'server') return await serverLoad(qualified);
    const dict = readLocalStorageDict();
    return dict[qualified] || null;
  }

  async function save(qualified, data) {
    await ready;
    if (mode === 'server') {
      await serverSave(qualified, data);
    } else {
      const dict = readLocalStorageDict();
      dict[qualified] = data;
      writeLocalStorageDict(dict);
    }
  }

  async function del(qualified) {
    await ready;
    if (mode === 'server') {
      await serverDelete(qualified);
    } else {
      const dict = readLocalStorageDict();
      delete dict[qualified];
      writeLocalStorageDict(dict);
    }
  }

  // Move a save from one qualified path to another. Atomic on the
  // server (os.rename inside a single filesystem); in localStorage
  // mode it's a copy-then-delete which IS racy, but localStorage
  // is single-threaded per origin so a race window of one statement
  // is fine.
  //
  // Throws on destination-exists (409 from server) — caller should
  // handle. No-op when from === to.
  async function move(fromQ, toQ) {
    await ready;
    if (fromQ === toQ) return;
    if (mode === 'server') {
      await serverMove(fromQ, toQ);
    } else {
      const dict = readLocalStorageDict();
      if (!(fromQ in dict)) throw new Error('move failed: source not found');
      if (toQ in dict) throw new Error(
        'move failed: destination already exists');
      dict[toQ] = dict[fromQ];
      delete dict[fromQ];
      writeLocalStorageDict(dict);
    }
  }

  // Migration: copy every localStorage save up to the server. Idempotent
  // — re-running just overwrites server-side with the localStorage
  // version, which is safe but only useful if the user knows it's
  // available. The UI calls this once on first server-mode page load
  // (when there are localStorage saves AND no migration-done flag).
  //
  // Returns {copied, skipped, errors}. We don't delete the localStorage
  // saves after migration — they stay as a backup until the user
  // explicitly clears them via the export/import UI or browser tools.
  async function migrateFromLocalStorage() {
    await ready;
    if (mode !== 'server') {
      return { copied: 0, skipped: 0, errors: [], total: 0,
        note: 'not in server mode — no-op' };
    }
    const dict = readLocalStorageDict();
    const qualifieds = Object.keys(dict);
    let copied = 0, skipped = 0;
    const errors = [];
    for (const qualified of qualifieds) {
      try {
        await serverSave(qualified, dict[qualified]);
        copied++;
      } catch (e) {
        errors.push({ qualified, error: String(e) });
        skipped++;
      }
    }
    return { copied, skipped, errors, total: qualifieds.length };
  }

  function getServerInfo() { return serverInfo; }

  // ---- Review flags (2026-07-09) -------------------------------------
  // Separate store from character saves — server mode uses the dedicated
  // /api/flags/<surface> endpoints (a file outside saves/, so flags never
  // pollute the character list); localStorage mode falls back to a keyed dict.
  // Surfaces: 'entry-flags' (DB-facing) | 'sheet-reports' (char-sheet-facing).
  const FLAGS_LS_PREFIX = 'dnd35-flags-';

  async function loadFlags(surface) {
    await ready;
    if (mode === 'server') {
      try {
        const r = await fetch('/api/flags/' + encodeURIComponent(surface),
                              { cache: 'no-store' });
        if (!r.ok) return { flags: [] };
        return await r.json();
      } catch (e) {
        return { flags: [] };
      }
    }
    try {
      return JSON.parse(localStorage.getItem(FLAGS_LS_PREFIX + surface))
             || { flags: [] };
    } catch (e) {
      return { flags: [] };
    }
  }

  async function saveFlags(surface, data) {
    await ready;
    if (mode === 'server') {
      const r = await fetch('/api/flags/' + encodeURIComponent(surface), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error('saveFlags failed: ' + r.status);
      return;
    }
    localStorage.setItem(FLAGS_LS_PREFIX + surface, JSON.stringify(data));
  }

  // Apply a single atomic op (add / resolve / remove) to a flag surface and
  // return the full new state. The whole-array PUT above let concurrent tabs
  // clobber each other (each sent its own stale array; the server replaced
  // wholesale). Op-based writes never transmit the array, so there's nothing to
  // clobber — and the returned authoritative state lets a tab pick up flags
  // other tabs added. In server mode the merge happens server-side under a lock;
  // in localStorage mode we read-modify-write the shared (cross-tab) store here.
  function applyFlagOpLocal(data, op) {
    if (!Array.isArray(data.flags)) data.flags = [];
    if (op.op === 'add') {
      if (op.flag && op.flag.id &&
          !data.flags.some(f => f.id === op.flag.id)) {
        data.flags.push(op.flag);
      }
    } else if (op.op === 'resolve') {
      const f = data.flags.find(x => x.id === op.id);
      if (f) { f.status = 'resolved'; f.resolved = op.resolved || new Date().toISOString(); }
    } else if (op.op === 'remove') {
      data.flags = data.flags.filter(x => x.id !== op.id);
    } else if (op.op === 'edit') {
      const f = data.flags.find(x => x.id === op.id);
      if (f) {
        if (typeof op.note === 'string') f.note = op.note.trim();
        if (op.kind === 'bug' || op.kind === 'feature') f.kind = op.kind;
        f.edited = op.edited || new Date().toISOString();
      }
    }
    return data;
  }

  async function flagOp(surface, op) {
    await ready;
    if (mode === 'server') {
      const r = await fetch('/api/flags/' + encodeURIComponent(surface), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(op),
      });
      if (!r.ok) throw new Error('flagOp failed: ' + r.status);
      return await r.json();
    }
    let data;
    try {
      data = JSON.parse(localStorage.getItem(FLAGS_LS_PREFIX + surface)) || { flags: [] };
    } catch (e) {
      data = { flags: [] };
    }
    applyFlagOpLocal(data, op);
    localStorage.setItem(FLAGS_LS_PREFIX + surface, JSON.stringify(data));
    return data;
  }

  window.SaveBackend = {
    ready,
    get mode() { return mode; },
    list,
    load,
    save,
    loadFlags,
    saveFlags,
    flagOp,
    delete: del,
    move,
    serverInfo: getServerInfo,
    migrateFromLocalStorage,
    hasLocalStorageSaves,
    parseQualified,
    MIGRATION_DONE_KEY,
    CHARACTERS_KEY,
  };
})();
