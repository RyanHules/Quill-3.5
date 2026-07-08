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

  async function init() {
    try {
      const data = await SaveBackend.loadFlags(SURFACE);
      state = (data && Array.isArray(data.flags)) ? data : { flags: [] };
    } catch (e) {
      console.warn('[sheet-reports] load failed', e);
      state = { flags: [] };
    }
    loaded = true;
    emit();
  }

  async function persist() {
    try {
      await SaveBackend.saveFlags(SURFACE, state);
    } catch (e) {
      console.warn('[sheet-reports] save failed', e);
    }
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
    state.flags.push(rep);
    emit();
    await persist();
    return rep;
  }

  async function resolve(id) {
    const r = state.flags.find(x => x.id === id);
    if (!r) return;
    r.status = 'resolved';
    r.resolved = new Date().toISOString();
    emit();
    await persist();
  }

  async function remove(id) {
    const before = state.flags.length;
    state.flags = state.flags.filter(x => x.id !== id);
    if (state.flags.length !== before) { emit(); await persist(); }
  }

  const getAll = () => state.flags.slice();
  const getOpen = () => state.flags.filter(r => r.status !== 'resolved');
  const isLoaded = () => loaded;

  window.SheetReports = { init, add, resolve, remove, getAll, getOpen, isLoaded };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
