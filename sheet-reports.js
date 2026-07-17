// sheet-reports.js — char-sheet-facing bug / feature reports (2026-07-09).
//
// A lightweight in-sheet capture for "this is broken" / "it'd be nice if…"
// notes about the CHARACTER SHEET itself (distinct consumer from the DB-facing
// entry-review flags in review-flags.js). Persists via SaveBackend to the
// `sheet-reports` surface (a file outside saves/). Kept deliberately minimal —
// not an issue tracker.
//
// Exposed as global `SheetReports`. Report shape:
//   { id, kind: 'bug'|'feature', note, created, status: 'open'|'resolved',
//     resolved? }
(function () {
  'use strict';
  const SURFACE = 'sheet-reports';
  let state = { flags: [] };
  let loaded = false;

  function emit() {
    document.dispatchEvent(new CustomEvent('sheet-reports-changed'));
  }

  function adopt(data) {
    state = (data && Array.isArray(data.flags)) ? data : { flags: [] };
  }

  async function init() {
    try {
      adopt(await SaveBackend.loadFlags(SURFACE));
    } catch (e) {
      console.warn('[sheet-reports] load failed', e);
      state = { flags: [] };
    }
    loaded = true;
    emit();
  }

  // Re-pull authoritative state so an open tab reflects reports filed in other
  // tabs (wired to focus / dashboard-open in review-flags-ui.js).
  async function refresh() {
    try {
      adopt(await SaveBackend.loadFlags(SURFACE));
      emit();
    } catch (e) {
      console.warn('[sheet-reports] refresh failed', e);
    }
  }

  // Atomic op through the backend; adopt the returned authoritative state so
  // concurrent tabs can't clobber each other's reports.
  async function op(o) {
    try {
      adopt(await SaveBackend.flagOp(SURFACE, o));
    } catch (e) {
      console.warn('[sheet-reports] op failed', e);
    }
    emit();
  }

  function newId() {
    return 'r' + Date.now().toString(36) + '-' +
           Math.floor(Math.random() * 1e6).toString(36);
  }

  async function add(kind, note) {
    const rep = {
      id: newId(),
      kind: kind === 'feature' ? 'feature' : 'bug',
      note: (note || '').trim(),
      created: new Date().toISOString(),
      status: 'open',
    };
    await op({ op: 'add', flag: rep });
    return rep;
  }

  async function resolve(id) {
    await op({ op: 'resolve', id, resolved: new Date().toISOString() });
  }

  async function remove(id) {
    await op({ op: 'remove', id });
  }

  // Amend an existing report in place (re-phrase the note / switch bug↔feature)
  // so refining a report doesn't mean filing a duplicate.
  async function edit(id, changes) {
    changes = changes || {};
    const o = { op: 'edit', id, edited: new Date().toISOString() };
    if (typeof changes.note === 'string') o.note = changes.note.trim();
    if (changes.kind === 'bug' || changes.kind === 'feature') o.kind = changes.kind;
    await op(o);
  }

  const getAll = () => state.flags.slice();
  const getOpen = () => state.flags.filter(r => r.status !== 'resolved');
  const isLoaded = () => loaded;

  window.SheetReports = { init, refresh, add, resolve, remove, edit, getAll, getOpen, isLoaded };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
