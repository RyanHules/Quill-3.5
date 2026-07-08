// review-flags.js — DB-facing entry-review flags (2026-07-09).
//
// While browsing the universal-search (lookup) modal, the user can flag a
// specific DB entry for review + attach a note about the issue (thin data,
// unstructured table, wrong value, …). Flags persist via SaveBackend to the
// dedicated `entry-flags` surface (a file OUTSIDE saves/, so they never appear
// in the character list). The loop is closed on the DB side by a small reader
// in the DB project that turns open flags into a worklist; resolving a flag
// here clears it there.
//
// Exposed as global `ReviewFlags`. Flag shape:
//   { id, ref: {name, source, type}, note, created, status: 'open'|'resolved',
//     resolved? }
// This is the CONSUMER-DB surface only; char-sheet bug/feature reports are a
// SEPARATE surface (sheet-reports.js), per the two-consumer split.
(function () {
  'use strict';
  const SURFACE = 'entry-flags';
  let state = { flags: [] };
  let loaded = false;

  function refKey(ref) {
    if (!ref) return '';
    return `${ref.type || ''}|${(ref.source || '').toLowerCase()}|` +
           `${(ref.name || '').toLowerCase()}`;
  }

  function emit() {
    document.dispatchEvent(new CustomEvent('review-flags-changed'));
  }

  async function init() {
    try {
      const data = await SaveBackend.loadFlags(SURFACE);
      state = (data && Array.isArray(data.flags)) ? data : { flags: [] };
    } catch (e) {
      console.warn('[review-flags] load failed', e);
      state = { flags: [] };
    }
    loaded = true;
    emit();
  }

  async function persist() {
    try {
      await SaveBackend.saveFlags(SURFACE, state);
    } catch (e) {
      console.warn('[review-flags] save failed', e);
    }
  }

  // A small non-time-critical unique id. Date.now()+random is fine in the
  // browser (unlike the workflow sandbox) and collisions are irrelevant here.
  function newId() {
    return 'f' + Date.now().toString(36) + '-' +
           Math.floor(Math.random() * 1e6).toString(36);
  }

  async function add(ref, note) {
    const flag = {
      id: newId(),
      ref: { name: ref.name || '', source: ref.source || '', type: ref.type || '' },
      note: (note || '').trim(),
      created: new Date().toISOString(),
      status: 'open',
    };
    state.flags.push(flag);
    emit();
    await persist();
    return flag;
  }

  async function resolve(id) {
    const f = state.flags.find(x => x.id === id);
    if (!f) return;
    f.status = 'resolved';
    f.resolved = new Date().toISOString();
    emit();
    await persist();
  }

  async function remove(id) {
    const before = state.flags.length;
    state.flags = state.flags.filter(x => x.id !== id);
    if (state.flags.length !== before) { emit(); await persist(); }
  }

  const getAll = () => state.flags.slice();
  const getOpen = () => state.flags.filter(f => f.status !== 'resolved');
  const flagsFor = (ref) => {
    const k = refKey(ref);
    return k ? state.flags.filter(f => refKey(f.ref) === k) : [];
  };
  const openFor = (ref) => flagsFor(ref).filter(f => f.status !== 'resolved');
  const isFlagged = (ref) => openFor(ref).length > 0;
  const isLoaded = () => loaded;

  window.ReviewFlags = {
    init, add, resolve, remove,
    getAll, getOpen, flagsFor, openFor, isFlagged, isLoaded, refKey,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
