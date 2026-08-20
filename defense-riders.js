// defense-riders.js — structured energy resistances, immunities,
// vulnerabilities, fast healing and regeneration (2026-08-20).
//
// WHY. The sheet had dedicated fields for SR and DR and nothing for the rest,
// so everything else landed in the free-text Defense Notes box. That was a
// documented gap — race-picker's own comment read "folded into the free-form
// #defense-notes (no dedicated sheet field yet)" — and it had a sharper edge
// than a missing field usually does: the DATA ARRIVED STRUCTURED AND WE THREW
// THE STRUCTURE AWAY. The DB carries `resistances: [{amount, damage_type}]`,
// `immunities: [...]`, `vulnerabilities: [...]`, `fast_healing: n` and
// `regeneration: {amount, bypass}` on 149 / 128 / 1 / 36 / 10 entries, and
// race-picker read those fields and flattened them into a prose line. So the
// consuming rig, asked whether a fireball hurts Kell, got a sentence.
//
// This module is the missing field. It does NOT invent a shape: it adopts the
// DB's field names and value shapes verbatim, so there is one vocabulary from
// the book to the sheet to the bus. (Coerce to the canonical shape, never alias
// it — the same rule the DB project runs on.)
//
// WHAT IS DELIBERATELY NOT HERE
//
//   * DR and SR keep their existing fields and their existing free-text /
//     numeric storage. 158 saved characters have hand-typed DR strings, and
//     re-parsing those into a new store is exactly the risky migration this
//     module is built to avoid needing. live-publish.js publishes a PARSED
//     view of DR alongside the verbatim string; storage is untouched.
//   * The Defense Notes box stays, and stays authoritative for everything not
//     modelled here — layered situational DR, fortification %, and the long
//     tail nobody has thought of. A structured field that swallowed the notes
//     box would trade a known gap for an unknown one.
//
// THE MIGRATION WINDOW IS THE INTERESTING PART. An empty rider list means "no
// resistances entered", which for a character sheet is a claim of none. But
// every character that predates this module ALSO has an empty list while
// carrying "Resist 5: Acid, Fire, Cold" in its notes — and publishing `[]` for
// them would be worse than publishing nothing, because a consumer would read
// it as "takes full damage" and narrate it out loud. So the publisher also
// emits `notes_may_contain_riders`, set when the free-text box still looks like
// it is carrying rider content. Empty-and-flagged is not the same statement as
// empty-and-clean, and the two must not be readable as one. The flag goes false
// on its own as characters get migrated by hand.
const DefenseRiders = (function () {
  'use strict';

  const KINDS = [
    ['resistance', 'Resist'],
    ['immunity', 'Immune to'],
    ['vulnerability', 'Vulnerable to'],
  ];

  // Suggestion lists built from what the DB ACTUALLY carries (top values across
  // every entry with these fields), not from what a plausible list would be.
  // Energy types are a closed set in 3.5; immunity targets are not, so the
  // input stays free text and the datalist is only a shortcut.
  const ENERGY_TYPES = ['acid', 'cold', 'electricity', 'fire', 'sonic'];
  const IMMUNITY_SUGGESTIONS = [
    'poison', 'paralysis', 'sleep', 'stunning', 'petrification', 'disease',
    'death effects', 'mind-affecting effects', 'necromantic effects',
    'critical hits', 'energy drain', 'flanking', 'fear', 'polymorphing',
    'ability damage', 'ability drain', 'death from massive damage',
    'nonlethal damage', 'acid', 'cold', 'electricity', 'fire', 'sonic',
  ];

  // Anything in the notes box that looks like an unmigrated rider. Deliberately
  // GENEROUS: a false positive costs a consumer one cautious sentence, a false
  // negative costs it a wrong ruling at the table.
  const NOTE_RIDER_RE =
    /\b(resist(?:ance|s|ed)?|immun\w*|vulnerab\w*|regenerat\w*|fast heal\w*)\b/i;

  let seq = 0;

  function $(sel) { return document.querySelector(sel); }
  function list() { return document.getElementById('defense-riders-list'); }

  function intOrNull(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (s === '') return null;
    return /^\d+$/.test(s) ? parseInt(s, 10) : null;
  }

  // ---- rows ---------------------------------------------------------------

  function addRow(data = {}) {
    const host = list();
    if (!host) return null;
    const row = document.createElement('div');
    row.className = 'defense-rider-row';
    row.dataset.riderIndex = seq++;
    const kind = KINDS.some(k => k[0] === data.kind) ? data.kind : 'resistance';
    const opts = KINDS.map(([v, label]) =>
      `<option value="${v}"${v === kind ? ' selected' : ''}>${label}</option>`).join('');
    row.innerHTML =
      `<select class="dr-kind">${opts}</select>` +
      `<input type="number" class="dr-amount" min="0" placeholder="5" ` +
        `value="${data.amount != null ? data.amount : ''}">` +
      `<input type="text" class="dr-type" placeholder="fire" ` +
        `list="defense-rider-types" value="${escapeAttr(data.type || '')}">` +
      `<button type="button" class="dr-remove" title="Remove">&times;</button>`;
    host.appendChild(row);
    // The marker says which source auto-filled this row, so removing that
    // source removes exactly its rows and leaves hand-entered ones alone —
    // the same ownership contract race-picker already uses for SR and DR.
    if (data.from) row.dataset.from = data.from;
    syncRow(row);
    return row;
  }

  // An immunity has no magnitude; showing a stray amount box invites someone to
  // type 5 into it and believe it meant something.
  function syncRow(row) {
    const kind = row.querySelector('.dr-kind').value;
    const amount = row.querySelector('.dr-amount');
    const needsAmount = (kind === 'resistance');
    amount.style.display = needsAmount ? '' : 'none';
    if (!needsAmount) amount.value = '';
    row.querySelector('.dr-type').placeholder =
      kind === 'resistance' ? 'fire' : (kind === 'immunity' ? 'poison' : 'fire');
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function rows() {
    const host = list();
    return host ? Array.from(host.querySelectorAll('.defense-rider-row')) : [];
  }

  function readRow(row) {
    const kind = row.querySelector('.dr-kind').value;
    const type = (row.querySelector('.dr-type').value || '').trim();
    const amount = intOrNull(row.querySelector('.dr-amount').value);
    return { kind, type, amount, from: row.dataset.from || null };
  }

  // ---- structured read (what the bus publishes) ---------------------------

  // Returns the DB's own field names and shapes. A rider with no type is
  // skipped: a resistance to nothing is not a fact, it is a half-typed row.
  function getStructured() {
    const out = {
      resistances: [], immunities: [], vulnerabilities: [],
      fast_healing: null, regeneration: null,
    };
    for (const row of rows()) {
      const r = readRow(row);
      if (!r.type) continue;
      if (r.kind === 'resistance') {
        out.resistances.push({ damage_type: r.type, amount: r.amount });
      } else if (r.kind === 'immunity') {
        out.immunities.push(r.type);
      } else if (r.kind === 'vulnerability') {
        out.vulnerabilities.push(r.type);
      }
    }
    const fh = intOrNull(($('#fast-healing') || {}).value);
    if (fh != null) out.fast_healing = fh;
    const rg = intOrNull(($('#regeneration-amount') || {}).value);
    if (rg != null) {
      const bypass = (($('#regeneration-bypass') || {}).value || '').trim();
      out.regeneration = bypass ? { amount: rg, bypass } : { amount: rg };
    }
    return out;
  }

  // True when the free-text notes still look like they carry rider content the
  // structured fields don't have. See the migration-window note at the top:
  // this is what stops an empty list being read as a clean "none".
  function notesMayContainRiders() {
    const el = document.getElementById('ac-defense-notes');
    const text = el ? String(el.value || '') : '';
    if (!text.trim()) return false;
    return NOTE_RIDER_RE.test(text);
  }

  // ---- auto-fill from a source (race, template, …) ------------------------

  // `spec` takes the DB's shapes as-is: {resistances:[{amount,damage_type}],
  // immunities:[...], vulnerabilities:[...], fast_healing:n,
  // regeneration:{amount,bypass}}. Passing null removes that source's rows.
  //
  // Re-applying the SAME source clears its rows first, so a level-up or a
  // re-pick refreshes rather than stacking duplicates.
  function applyFromSource(sourceKey, spec) {
    if (!sourceKey) return;
    clearSource(sourceKey);
    if (!spec) { notifyChanged(); return; }
    for (const r of (spec.resistances || [])) {
      if (!r) continue;
      const type = r.damage_type || r.type;
      if (!type) continue;
      addRow({ kind: 'resistance', type, amount: r.amount, from: sourceKey });
    }
    for (const t of (spec.immunities || [])) {
      if (t) addRow({ kind: 'immunity', type: String(t), from: sourceKey });
    }
    for (const t of (spec.vulnerabilities || [])) {
      if (t) addRow({ kind: 'vulnerability', type: String(t), from: sourceKey });
    }
    notifyChanged();
  }

  function clearSource(sourceKey) {
    for (const row of rows()) {
      if (row.dataset.from === sourceKey) row.remove();
    }
  }

  // Every source key currently owning at least one row. Lets a caller sweep by
  // prefix ("race:*") rather than having to remember which race it applied —
  // a rename or a reload between apply and remove otherwise strands rows that
  // nothing will ever clean up.
  function sourceKeys() {
    const out = new Set();
    for (const row of rows()) {
      if (row.dataset.from) out.add(row.dataset.from);
    }
    return Array.from(out);
  }

  function notifyChanged() {
    document.dispatchEvent(new Event('defense-riders-changed'));
    // Riders are display-and-publish only today (no bonus-layer effects), but
    // the recalc keeps any future consumer honest and costs nothing here.
    try { if (typeof window.recalcAll === 'function') window.recalcAll(); }
    catch (e) { /* never break an apply */ }
  }

  // ---- build --------------------------------------------------------------

  function build() {
    const host = list();
    if (!host) return;
    host.innerHTML = '';
    seq = 0;

    let dl = document.getElementById('defense-rider-types');
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = 'defense-rider-types';
      // No `label` attributes — Firefox renders them as visible suggestion
      // text, which makes a picker look broken (the soulmeld lesson).
      const seen = new Set();
      for (const v of ENERGY_TYPES.concat(IMMUNITY_SUGGESTIONS)) {
        if (seen.has(v)) continue;
        seen.add(v);
        const opt = document.createElement('option');
        opt.value = v;
        dl.appendChild(opt);
      }
      document.body.appendChild(dl);
    }

    host.addEventListener('change', (e) => {
      const row = e.target.closest('.defense-rider-row');
      if (!row) return;
      if (e.target.classList.contains('dr-kind')) syncRow(row);
      // A hand-edit hands the row over to the player: the source marker goes,
      // so a later race change stops managing it. Same contract as every other
      // auto-filled field on the sheet.
      if (e.isTrusted) delete row.dataset.from;
      notifyChanged();
    });
    host.addEventListener('input', (e) => {
      const row = e.target.closest('.defense-rider-row');
      if (row && e.isTrusted) delete row.dataset.from;
    });
    host.addEventListener('click', (e) => {
      if (!e.target.classList.contains('dr-remove')) return;
      e.target.closest('.defense-rider-row').remove();
      notifyChanged();
    });

    const addBtn = document.getElementById('defense-riders-add');
    if (addBtn && !addBtn.dataset.wired) {
      addBtn.dataset.wired = '1';
      addBtn.addEventListener('click', () => { addRow(); notifyChanged(); });
    }
  }

  // ---- save / load --------------------------------------------------------

  function collectData() {
    return {
      _defense_riders: rows().map(readRow).filter(r => r.type),
      'fast-healing': ($('#fast-healing') || {}).value || '',
      'regeneration-amount': ($('#regeneration-amount') || {}).value || '',
      'regeneration-bypass': ($('#regeneration-bypass') || {}).value || '',
    };
  }

  function loadData(data) {
    build();
    // Defensive default: a save written before this module existed has no
    // `_defense_riders`, and must load as an empty list rather than as an
    // error. Its rider prose stays in the notes box, and the publisher's
    // `notes_may_contain_riders` flag is what keeps that visible.
    const saved = Array.isArray(data && data._defense_riders) ? data._defense_riders : [];
    for (const r of saved) {
      if (!r || !r.type) continue;
      addRow({ kind: r.kind, type: r.type, amount: r.amount, from: r.from || null });
    }
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
    set('fast-healing', data && data['fast-healing']);
    set('regeneration-amount', data && data['regeneration-amount']);
    set('regeneration-bypass', data && data['regeneration-bypass']);
  }

  return {
    build, addRow, collectData, loadData,
    getStructured, notesMayContainRiders,
    applyFromSource, clearSource, sourceKeys,
    // Exposed for tests and for the publisher's DR parse.
    NOTE_RIDER_RE,
  };
})();
