// race-unify.js — coordinator for the single, unified "Race" field.
//
// The sheet used to have two inputs: "Race" (#char-race, PHB races via
// race-picker) and "Creature as Race" (#char-creature-race, monster PCs
// via creature-race-picker, which adds racial Hit Dice + a level
// adjustment). Only one is ever in use at a time, so they were merged
// into the single #char-race field. Both pickers now bind to it; this
// module coordinates them:
//
//   * Routing. A typed name is a race, a creature, or — for a couple of
//     names — both. race-picker applies only names in its index;
//     creature-picker only names in its. For the genuine overlaps
//     (Centaur, Gnoll today) we ask which the player means, because the
//     two apply different mechanics (the monster adds racial HD + LA).
//
//   * Shared teardown. The two pickers manage the Race ability columns
//     differently (race-picker clears + overwrites all six; the creature
//     picker writes deltas for the abilities it names). On a unified
//     field, switching race<->monster would otherwise leave stale mods
//     on the abilities the new pick doesn't touch. `teardownAll()` runs
//     BOTH pickers' resets before any apply, so every switch starts from
//     a clean slate.
//
// Public API (window.RaceUnify):
//   claim(type, name)  -> bool   — may `type` ('race'|'creature') apply
//                                   `name` now? false on an unresolved
//                                   collision (and pops the chooser).
//   resolve(name, type)          — record the choice + apply it.
//   teardownAll()                — reset both pickers' auto-writes.
//   isCollision(name)  -> bool
//   reset()                      — clear resolutions + hide chooser
//                                   (called from New Character).
//
// The pickers expose `window.RacePicker` / `window.CreatureRacePicker`
// with `{ resetWrites, applyByName }`; this module calls into them.

(function () {
  'use strict';

  // Lowercased names that exist as BOTH a race AND a creature-with-
  // as_character (the only ones that need disambiguation).
  const collisions = new Set();
  // Lowercased name -> 'race' | 'creature' (the player's resolution for
  // this session). Cleared on New Character.
  const resolved = new Map();

  let chooserEl = null;

  function key(name) { return String(name || '').trim().toLowerCase(); }
  function isCollision(name) { return collisions.has(key(name)); }

  function buildCollisions() {
    if (!window.DB || !DB.isLoaded || !DB.isLoaded()) return;
    try {
      const rows = DB.query(
        "SELECT LOWER(name) AS n FROM entry WHERE type = 'race' "
        + "INTERSECT "
        + "SELECT LOWER(name) AS n FROM entry WHERE type = 'creature' "
        + "AND json_extract(data, '$.as_character') IS NOT NULL");
      collisions.clear();
      for (const r of rows) collisions.add(r.n);
      console.log(`[race-unify] ${collisions.size} race/creature collision name(s):`,
        [...collisions].join(', ') || '(none)');
    } catch (e) {
      console.warn('[race-unify] collision query failed:', e);
    }
  }

  // Called by each picker before it auto-applies a typed name. Returns
  // true if it may proceed. For a collision name we hold both pickers off
  // and show a chooser until the player resolves it.
  function claim(type, name) {
    const k = key(name);
    if (!collisions.has(k)) return true;        // unambiguous → go
    if (resolved.get(k) === type) return true;  // player chose this kind
    if (!resolved.has(k)) showChooser(name);    // first sight → ask
    return false;
  }

  function resolve(name, type) {
    resolved.set(key(name), type);
    hideChooser();
    if (type === 'race' && window.RacePicker
        && typeof RacePicker.applyByName === 'function') {
      RacePicker.applyByName(name);
    } else if (type === 'creature' && window.CreatureRacePicker
        && typeof CreatureRacePicker.applyByName === 'function') {
      CreatureRacePicker.applyByName(name);
    }
  }

  // Reset every auto-write both pickers own, so a fresh apply (or a
  // switch between race and monster) starts from a clean slate.
  function teardownAll() {
    if (window.RacePicker && typeof RacePicker.resetWrites === 'function') {
      RacePicker.resetWrites();
    }
    if (window.CreatureRacePicker
        && typeof CreatureRacePicker.resetWrites === 'function') {
      CreatureRacePicker.resetWrites();
    }
  }

  function reset() {
    resolved.clear();
    hideChooser();
  }

  // ---- Disambiguation chooser -------------------------------------------

  function ensureChooser() {
    if (chooserEl) return chooserEl;
    const input = document.getElementById('char-race');
    if (!input) return null;
    chooserEl = document.createElement('div');
    chooserEl.id = 'race-unify-chooser';
    chooserEl.style.cssText =
      'grid-column: 1 / -1; margin-top: 0.25rem; padding: 0.4rem 0.55rem; '
      + 'font-size: 0.85em; background: rgba(217,134,58,0.10); '
      + 'border-left: 3px solid #d9863a; border-radius: 3px; display: none;';
    // Append after the race input's field cell so it spans the grid row.
    (input.parentElement.parentElement || input.parentElement)
      .appendChild(chooserEl);
    chooserEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-kind]');
      if (!btn) return;
      ev.preventDefault();
      resolve(chooserEl.dataset.name || '', btn.dataset.kind);
    });
    return chooserEl;
  }

  function showChooser(name) {
    const el = ensureChooser();
    if (!el) return;
    // Idempotent — both pickers call claim() on the same keystroke.
    if (el.style.display !== 'none' && el.dataset.name === key(name)) return;
    el.dataset.name = key(name);
    const safe = String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    el.innerHTML =
      `<b>${safe}</b> is both a standard race and a monster (which add `
      + `racial Hit Dice + a level adjustment). Which do you mean? `
      + `<button type="button" class="btn-add btn-add-inline" `
      + `data-kind="race" style="margin-left:0.3rem">Standard race</button> `
      + `<button type="button" class="btn-add btn-add-inline" `
      + `data-kind="creature">Monster race</button>`;
    el.style.display = 'block';
  }

  function hideChooser() {
    if (chooserEl) { chooserEl.style.display = 'none'; chooserEl.dataset.name = ''; }
  }

  window.RaceUnify = {
    claim, resolve, teardownAll, isCollision, reset,
    _buildCollisions: buildCollisions,
  };

  if (window.DB && DB.ready) {
    DB.ready.then(() => { buildCollisions(); ensureChooser(); });
  }
  // Rebuild on book-filter changes (a filtered-out type could remove a
  // collision; unlikely but cheap to keep correct).
  document.addEventListener('book-filter-changed', buildCollisions);
})();
