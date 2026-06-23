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
  const DB_VERSION = '20260623-d747f840';
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

  // XHR-based binary fetch. We use XHR instead of fetch().arrayBuffer()
  // because some sandboxed preview environments abort large response
  // body reads even when the HTTP fetch headers succeed. Plain XHR
  // streams the body into one buffer and Just Works everywhere.
  function fetchArrayBuffer(url) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.responseType = 'arraybuffer';
      xhr.open('GET', url, true);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
          resolve(xhr.response);
        } else {
          reject(new Error(`HTTP ${xhr.status} for ${url}`));
        }
      };
      xhr.onerror = () => reject(new Error(`Network error for ${url}`));
      xhr.send();
    });
  }

  // Load: fetch sql.js, then fetch the DB blob, then open it.
  const ready = (async function load() {
    try {
      // initSqlJs is exposed globally by sql-wasm.js.
      const SQL = await window.initSqlJs({
        locateFile: file => SQLJS_WASM_PATH,
      });
      const buf = await fetchArrayBuffer(DB_PATH);
      db = new SQL.Database(new Uint8Array(buf));
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
