// database.js — load dnd35.db (SQLite) and expose query helpers.
//
// This module is purely additive: existing manual-entry fields keep
// working. When the database loads, we populate dropdown options and
// wire selection handlers; if the DB fails to load we log a warning and
// leave the sheet operating as before.
//
// Public API:
//   DB.ready             — Promise that resolves when DB is loaded
//   DB.query(sql, params) — returns array of row objects
//   DB.queryOne(sql, params) — returns first row or null
//
// SQL.js docs: https://sql.js.org/

(function () {
  // Resolve paths against the document's baseURI so they work whether
  // index.html is served at "/" or behind a sub-path (and regardless of
  // a `?bust=...` cache-buster on the URL).
  const BASE = new URL('.', document.baseURI).href;
  // Cache-bust the DB blob — Chrome/Firefox aggressively cache the
  // 14 MB file otherwise, so a rebuilt DB on disk doesn't reach the
  // page until a hard refresh. CONTENT-DERIVED: stamped automatically by the
  // DB project's deploy_to_charsheet.py (= <build-date>-<sha256[:8]> of the
  // blob). Do NOT hand-edit — re-run that script to deploy a new DB. (This
  // removes the multi-instance "whose turn to increment" race.)
  const DB_VERSION = '20260701-9007967e';
  const DB_PATH = BASE + 'data/dnd35.db?v=' + DB_VERSION;
  const SQLJS_WASM_PATH = BASE + 'vendor/sql-wasm.wasm';

  let db = null;

  // Convert a sql.js exec() result to an array of row objects.
  function execToRows(stmt) {
    const cols = stmt.getColumnNames();
    const rows = [];
    while (stmt.step()) {
      const values = stmt.get();
      const row = {};
      for (let i = 0; i < cols.length; i++) {
        row[cols[i]] = values[i];
      }
      rows.push(row);
    }
    return rows;
  }

  function query(sql, params) {
    if (!db) {
      console.warn('DB not ready; query ignored:', sql);
      return [];
    }
    const stmt = db.prepare(sql);
    try {
      if (params) stmt.bind(params);
      return execToRows(stmt);
    } finally {
      stmt.free();
    }
  }

  function queryOne(sql, params) {
    const rows = query(sql, params);
    return rows.length ? rows[0] : null;
  }

  // Load the DB blob with STREAMING + RETRY.
  //
  // A single ~52 MB body read — whether fetch().arrayBuffer() or XHR
  // responseType='arraybuffer' — intermittently ABORTS in sandboxed /
  // proxied environments (the preview harness, some corporate proxies),
  // even though the server served every byte fine. We verified this: the
  // exact blob downloads via curl in ~0.5 s and loads on most page loads,
  // but the single-read XHR network-errors ~1 in 3 in the preview. With no
  // retry, one transient abort left a permanent "Pickers disabled" banner
  // until a manual reload — the long-standing preview pain.
  //
  // Two changes fix it durably: (1) read the body as a STREAM (getReader)
  // in small network-sized pieces instead of one giant buffer read — the
  // single big read is the part that aborts; and (2) RETRY the whole read
  // a few times with backoff so an intermittent abort recovers instead of
  // killing the page. The reads are independent, so a handful of attempts
  // drives the residual failure rate to negligible. Client-only — the
  // server serves the file correctly; nothing there needed changing.
  async function fetchDbBytes(url, attempts = 5) {
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        if (!resp.body || !resp.body.getReader) {
          // No streaming support (ancient browser) — single buffered read.
          return new Uint8Array(await resp.arrayBuffer());
        }
        const reader = resp.body.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.length;
        }
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          out.set(chunk, offset);
          offset += chunk.length;
        }
        if (attempt > 1) {
          console.log(`[DB] loaded on attempt ${attempt}/${attempts}`);
        }
        return out;
      } catch (err) {
        lastErr = err;
        console.warn(
          `[DB] load attempt ${attempt}/${attempts} failed: ${err.message}`);
        if (attempt < attempts) {
          // Linear backoff — give the proxy/sandbox a moment to recover.
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
    }
    throw lastErr || new Error(`failed to load ${url} after ${attempts} attempts`);
  }

  // Load: fetch sql.js, then fetch the DB blob, then open it.
  const ready = (async function load() {
    try {
      // initSqlJs is exposed globally by sql-wasm.js.
      const SQL = await window.initSqlJs({
        locateFile: file => SQLJS_WASM_PATH,
      });
      const bytes = await fetchDbBytes(DB_PATH);
      db = new SQL.Database(bytes);
      // Per-type counts via the unified `entry` table (the legacy
      // `race` / `spell` / `feat` / `item` views were removed in the
      // 2026-05-14 cleanup; querying them throws "no such table").
      const races = queryOne(
        "SELECT COUNT(*) AS n FROM entry WHERE type = 'race'");
      const spells = queryOne(
        "SELECT COUNT(*) AS n FROM entry WHERE type = 'spell'");
      const feats = queryOne(
        "SELECT COUNT(*) AS n FROM entry "
        + "WHERE type IN ('feat','acf','skill_trick')");
      const items = queryOne(
        "SELECT COUNT(*) AS n FROM entry "
        + "WHERE type IN ('item','weapon','armor','gear')");
      console.log(`[DB] Loaded ${DB_PATH} — ${races.n} races, ` +
        `${spells.n} spells, ${feats.n} feats, ${items.n} items`);
      return db;
    } catch (err) {
      console.warn('[DB] Failed to load — sheet will operate without ' +
        'database-driven features:', err);
      showLoadFailureBanner(err);
      return null;
    }
  })();

  // When DB load fails, show a visible banner at the top of the page so
  // the user actually realizes the pickers aren't going to work. The
  // most common cause by far is opening index.html via `file://` —
  // Firefox/Chrome both refuse to fetch the 14 MB SQLite blob from a
  // file:// origin. Detect that case and give a specific tip.
  function showLoadFailureBanner(err) {
    const tryRender = () => {
      if (!document.body) {
        document.addEventListener('DOMContentLoaded', tryRender, { once: true });
        return;
      }
      if (document.getElementById('db-load-banner')) return;
      const isFileScheme = location.protocol === 'file:';
      const banner = document.createElement('div');
      banner.id = 'db-load-banner';
      banner.style.cssText =
        'background:#5a1a1a; color:#fff; padding:0.6rem 1rem; ' +
        'font:0.9em system-ui, sans-serif; ' +
        'border-bottom:2px solid #a44; position:sticky; top:0; z-index:9999;';
      if (isFileScheme) {
        banner.innerHTML =
          '<b>Pickers disabled:</b> the character sheet was opened via ' +
          '<code>file://</code>, so the browser refused to load ' +
          '<code>data/dnd35.db</code>. ' +
          'Close this tab and double-click <b>serve.bat</b> instead ' +
          '(or run <code>python -m http.server</code> from this folder ' +
          'and open <code>http://localhost:8000/</code>). ' +
          'Manual-entry fields still work without the DB.';
      } else {
        banner.innerHTML =
          '<b>Pickers disabled:</b> failed to load <code>data/dnd35.db</code>. ' +
          'Open DevTools → Console for details. Manual-entry fields ' +
          'still work.';
      }
      document.body.prepend(banner);
    };
    tryRender();
  }

  window.DB = { ready, query, queryOne, isLoaded: () => db !== null };
})();
