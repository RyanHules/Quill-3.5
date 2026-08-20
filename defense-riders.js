// defense-riders.js — structured defensive riders (2026-08-20).
//
// Energy resistances / immunities / vulnerabilities, damage reduction, fast
// healing and regeneration, as data instead of prose.
//
// WHY. The sheet had fields for DR (free text) and SR (a number) and nothing
// for the rest, so everything else landed in the free-text Defense Notes box.
// The sharp version of the problem was not the missing field — it was that THE
// DATA ARRIVED STRUCTURED AND WE THREW THE STRUCTURE AWAY: the DB carries
// `resistances: [{amount, damage_type}]`, `immunities`, `vulnerabilities`,
// `damage_reduction: [{amount, bypass}]`, `fast_healing` and `regeneration:
// {amount, bypass}`, and race-picker read those fields and flattened them into
// a sentence. Anything reading the sheet downstream then had to parse English
// to answer "does fire hurt this character".
//
// This module does not invent a shape. It adopts the DB's field names and
// value shapes verbatim, so one vocabulary runs from the book to the sheet to
// the live bus.
//
// ---------------------------------------------------------------------------
// DAMAGE REDUCTION AND THE STACKING QUESTION
//
// DR gets a `stacks` flag per entry, and that flag exists because the corpus
// says it has to — but the DEFAULT is not stacking, and the resolution is not
// addition. DMG p.292:
//
//   "If a creature has damage reduction from more than one source, the two
//    forms of damage reduction do not stack. Instead, the creature gets the
//    benefit of the best damage reduction in a given situation."
//
// The werebear example in that entry is the one to hold on to: DR 10/silver
// plus DR 5/evil means a plain weapon is reduced by 10, a silver weapon by 5
// (it bypassed the 10 but not the 5), an evil weapon by 10, and a silvered
// unholy weapon by nothing. So "best applicable to THIS attack", never a sum.
//
// The flag is still needed, because explicit per-source exceptions are real
// and not rare — a DB-wide sweep found eight: Iron Ward Diamond ("stacks with
// similar damage reduction granted by any other source"), Berserker Strength
// (PHB2 ACF), Dragonward (invocation, "stacks with ... such as from barbarian
// levels"), Skin of the Moon (stacks with other DR/—), Breastplate of Terror
// (stacks with CLASS-FEATURE DR only), and the Armor-as-DR variant rule.
//
// So: `stacks: false` entries compete — a consumer takes the best of those the
// attack does not bypass. `stacks: true` entries add on top of that winner.
// The sheet does NOT resolve this, deliberately: resolution depends on what the
// incoming attack is made of, and the sheet does not know that. It publishes
// the entries and the flags; whoever knows the attack does the arithmetic.
//
// Breastplate of Terror's "stacks with class-feature DR but nothing else" is
// beyond a boolean and is not modelled. That is a note-box case.
//
// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT HERE
//
//   * SR stays a plain number field. It already is one, and it works.
//   * The Defense Notes box stays, and stays authoritative for everything not
//     modelled here — conditional DR ("2/- vs Air subtype"), fortification %,
//     and the long tail. A structured field that swallowed the notes box would
//     trade a known gap for an unknown one.
//
// THE MIGRATION WINDOW. An empty rider list means "no resistances entered",
// which for a character sheet is a claim of none. But every character built
// before this module ALSO has an empty list while carrying "Resist 5: Acid,
// Fire, Cold" in its notes, and publishing `[]` for them would be worse than
// publishing nothing — a consumer would read it as "takes full damage" and
// narrate it out loud. So the publisher also emits `notes_may_contain_riders`.
// Empty-and-flagged is not the same statement as empty-and-clean. The flag
// goes false on its own as characters get migrated.
//
// DR migrates automatically instead, because it CAN: 157 of the 158 saved DR
// strings parse cleanly into {amount, bypass} (the one holdout is "see SA", a
// pointer rather than a value). `migrateLegacyDR` runs on load, and anything
// that does not parse stays visible in the legacy text box rather than being
// dropped on the floor.
const DefenseRiders = (function () {
  'use strict';

  const KINDS = [
    ['resistance', 'Resist'],
    ['immunity', 'Immune to'],
    ['vulnerability', 'Vulnerable to'],
  ];

  // Suggestion lists built from what the DB ACTUALLY carries (top values across
  // every entry with these fields), not from a plausible-looking list. Energy
  // types are a closed set in 3.5; immunity targets are not, so the input stays
  // free text and the datalist is only a shortcut.
  const ENERGY_TYPES = ['acid', 'cold', 'electricity', 'fire', 'sonic'];
  const IMMUNITY_SUGGESTIONS = [
    'poison', 'paralysis', 'sleep', 'stunning', 'petrification', 'disease',
    'death effects', 'mind-affecting effects', 'necromantic effects',
    'critical hits', 'energy drain', 'flanking', 'fear', 'polymorphing',
    'ability damage', 'ability drain', 'death from massive damage',
    'nonlethal damage', 'acid', 'cold', 'electricity', 'fire', 'sonic',
  ];
  const BYPASS_SUGGESTIONS = [
    'adamantine', 'bludgeoning', 'chaotic', 'cold iron', 'epic', 'evil',
    'good', 'lawful', 'magic', 'piercing', 'silver', 'slashing',
    'bludgeoning and magic', 'evil and silver', 'cold iron or evil',
  ];

  // Anything in the notes box that looks like an unmigrated rider. Deliberately
  // GENEROUS: a false positive costs a consumer one cautious sentence, a false
  // negative costs it a wrong ruling at the table.
  const NOTE_RIDER_RE =
    /\b(resist(?:ance|s|ed)?|immun\w*|vulnerab\w*|regenerat\w*|fast heal\w*)\b/i;

  let seq = 0;

  function $(sel) { return document.querySelector(sel); }
  function byId(id) { return document.getElementById(id); }
  function riderList() { return byId('defense-riders-list'); }
  function drList() { return byId('dr-entries-list'); }
  function regenList() { return byId('regen-entries-list'); }

  function intOrNull(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (s === '') return null;
    return /^\d+$/.test(s) ? parseInt(s, 10) : null;
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function rowsIn(host, sel) {
    return host ? Array.from(host.querySelectorAll(sel)) : [];
  }

  // ---- resistance / immunity / vulnerability rows -------------------------
  //
  // NB the class prefix is `rider-`, not `dr-`. `dr-` belongs to damage
  // reduction below, and having "dr" mean "defense rider" three inches from
  // real DR is exactly the kind of collision that reads fine to whoever wrote
  // it and as a bug to whoever reads it next.

  function addRow(data = {}) {
    const host = riderList();
    if (!host) return null;
    const row = document.createElement('div');
    row.className = 'defense-rider-row';
    row.dataset.riderIndex = seq++;
    const kind = KINDS.some(k => k[0] === data.kind) ? data.kind : 'resistance';
    const opts = KINDS.map(([v, label]) =>
      `<option value="${v}"${v === kind ? ' selected' : ''}>${label}</option>`).join('');
    row.innerHTML =
      `<select class="rider-kind">${opts}</select>` +
      `<input type="number" class="rider-amount" min="0" placeholder="5" ` +
        `value="${data.amount != null ? data.amount : ''}">` +
      `<input type="text" class="rider-type" placeholder="fire" ` +
        `list="defense-rider-types" value="${escapeAttr(data.type || '')}">` +
      `<button type="button" class="rider-remove" title="Remove">&times;</button>`;
    host.appendChild(row);
    if (data.from) row.dataset.from = data.from;
    syncRow(row);
    return row;
  }

  // An immunity has no magnitude; showing a stray amount box invites someone to
  // type 5 into it and believe it meant something.
  function syncRow(row) {
    const kind = row.querySelector('.rider-kind').value;
    const amount = row.querySelector('.rider-amount');
    const needsAmount = (kind === 'resistance');
    amount.style.display = needsAmount ? '' : 'none';
    if (!needsAmount) amount.value = '';
    row.querySelector('.rider-type').placeholder =
      kind === 'immunity' ? 'poison' : 'fire';
  }

  function riderRows() { return rowsIn(riderList(), '.defense-rider-row'); }

  function readRider(row) {
    return {
      kind: row.querySelector('.rider-kind').value,
      type: (row.querySelector('.rider-type').value || '').trim(),
      amount: intOrNull(row.querySelector('.rider-amount').value),
      from: row.dataset.from || null,
    };
  }

  // ---- damage reduction rows ----------------------------------------------

  function addDR(data = {}) {
    const host = drList();
    if (!host) return null;
    const row = document.createElement('div');
    row.className = 'dr-entry-row';
    row.innerHTML =
      `<input type="number" class="dr-amount" min="0" placeholder="5" ` +
        `value="${data.amount != null ? data.amount : ''}">` +
      `<span class="dr-slash">/</span>` +
      `<input type="text" class="dr-bypass" list="dr-bypass-types" ` +
        `placeholder="magic (blank = nothing bypasses)" ` +
        `value="${escapeAttr(data.bypass || '')}">` +
      `<label class="dr-stacks-label" title="RAW (DMG p.292): DR from several sources does NOT stack — the best one that the incoming attack fails to bypass applies. Tick this only for a source that says otherwise (Iron Ward Diamond, Berserker Strength, Dragonward, the Armor-as-DR variant): it then ADDS on top of that winner.">` +
        `<input type="checkbox" class="dr-stacks"${data.stacks ? ' checked' : ''}> stacks</label>` +
      `<button type="button" class="dr-remove" title="Remove">&times;</button>`;
    host.appendChild(row);
    if (data.from) row.dataset.from = data.from;
    return row;
  }

  function drRows() { return rowsIn(drList(), '.dr-entry-row'); }

  function readDR(row) {
    const bypass = (row.querySelector('.dr-bypass').value || '').trim();
    return {
      amount: intOrNull(row.querySelector('.dr-amount').value),
      // Blank / dash means nothing bypasses it — the books write that as
      // "DR 5/—", and null is the honest representation of "no bypass exists"
      // as against the empty string, which reads like a missing value.
      bypass: (bypass === '' || bypass === '-' || bypass === '—') ? null : bypass,
      stacks: !!row.querySelector('.dr-stacks').checked,
      from: row.dataset.from || null,
    };
  }

  // ---- regeneration rows --------------------------------------------------
  //
  // A list rather than one pair of fields, because a creature can carry several
  // regenerations bypassed by different things (a troll's acid-and-fire plus a
  // template's), and collapsing them to one loses the bypass that matters.

  function addRegen(data = {}) {
    const host = regenList();
    if (!host) return null;
    const row = document.createElement('div');
    row.className = 'regen-entry-row';
    row.innerHTML =
      `<input type="number" class="regen-amount" min="0" placeholder="5" ` +
        `value="${data.amount != null ? data.amount : ''}">` +
      `<span class="regen-sep">bypassed by</span>` +
      `<input type="text" class="regen-bypass" placeholder="acid, fire" ` +
        `value="${escapeAttr(data.bypass || '')}">` +
      `<button type="button" class="regen-remove" title="Remove">&times;</button>`;
    host.appendChild(row);
    if (data.from) row.dataset.from = data.from;
    return row;
  }

  function regenRows() { return rowsIn(regenList(), '.regen-entry-row'); }

  function readRegen(row) {
    const bypass = (row.querySelector('.regen-bypass').value || '').trim();
    return {
      amount: intOrNull(row.querySelector('.regen-amount').value),
      bypass: bypass || null,
      from: row.dataset.from || null,
    };
  }

  // ---- structured read (what the bus publishes) ---------------------------

  // Returns the DB's own field names and shapes. A rider with no type, or a DR
  // with no amount, is skipped: those are half-typed rows, not facts.
  function getStructured() {
    const out = {
      resistances: [], immunities: [], vulnerabilities: [],
      damage_reduction: [], fast_healing: null, regeneration: [],
    };
    for (const row of riderRows()) {
      const r = readRider(row);
      if (!r.type) continue;
      if (r.kind === 'resistance') {
        out.resistances.push({ damage_type: r.type, amount: r.amount });
      } else if (r.kind === 'immunity') {
        out.immunities.push(r.type);
      } else if (r.kind === 'vulnerability') {
        out.vulnerabilities.push(r.type);
      }
    }
    for (const row of drRows()) {
      const d = readDR(row);
      if (d.amount == null) continue;
      out.damage_reduction.push({ amount: d.amount, bypass: d.bypass, stacks: d.stacks });
    }
    for (const row of regenRows()) {
      const g = readRegen(row);
      if (g.amount == null) continue;
      out.regeneration.push(g.bypass ? { amount: g.amount, bypass: g.bypass }
                                     : { amount: g.amount });
    }
    const fh = intOrNull((byId('fast-healing') || {}).value);
    if (fh != null) out.fast_healing = fh;
    return out;
  }

  // The books' own notation, rendered from the structure — "10/cold iron, 5/—".
  // Published beside the entries so a consumer that just wants to print
  // something has it, and so the value stays legible in a save file.
  function drText() {
    const parts = drRows().map(readDR).filter(d => d.amount != null)
      .map(d => `${d.amount}/${d.bypass || '—'}`);
    return parts.length ? parts.join(', ') : null;
  }

  // True when the free-text notes still look like they carry rider content the
  // structured fields don't have. See the migration-window note at the top:
  // this is what stops an empty list being read as a clean "none".
  function notesMayContainRiders() {
    const el = byId('ac-defense-notes');
    const text = el ? String(el.value || '') : '';
    if (!text.trim()) return false;
    return NOTE_RIDER_RE.test(text);
  }

  // ---- legacy DR migration ------------------------------------------------

  // "10/cold iron, 5/-" -> [{amount, bypass}]. Returns null on anything it
  // cannot fully account for, so a half-understood string is never turned into
  // confident-looking rows. 157 of 158 saved strings parse; the holdout is
  // "see SA", which is a pointer rather than a value and correctly refuses.
  function parseDRText(raw) {
    if (!raw) return null;
    const body = String(raw).replace(/^\s*DR\s+/i, '');
    const parts = body.split(/[;,]/).map(s => s.trim()).filter(s => s !== '');
    if (!parts.length) return null;
    const out = [];
    for (const part of parts) {
      const m = /^(\d+)\s*\/\s*(.*)$/.exec(part);
      if (!m) return null;                       // one unparsed part, no result
      const bypass = m[2].trim();
      out.push({
        amount: parseInt(m[1], 10),
        bypass: (bypass === '' || bypass === '-' || bypass === '—') ? null : bypass,
      });
    }
    return out.length ? out : null;
  }

  // Pull an old save's free-text DR into rows. Non-destructive on failure: the
  // string stays in the legacy box, which stays visible precisely so nothing
  // silently disappears. Only runs when there are no structured rows yet, so it
  // can never overwrite something the player has already entered.
  function migrateLegacyDR() {
    const el = byId('damage-reduction');
    if (!el) return;
    const raw = String(el.value || '').trim();
    if (!raw || drRows().length) { syncLegacyDR(); return; }
    const parsed = parseDRText(raw);
    if (!parsed) { syncLegacyDR(); return; }     // leave it visible, untouched
    for (const d of parsed) addDR(d);
    el.value = '';
    syncLegacyDR();
  }

  // The legacy box earns its place on screen only while it still holds
  // something. Empty and hidden is the end state for every character.
  function syncLegacyDR() {
    const el = byId('damage-reduction');
    const wrap = el && el.closest('.legacy-dr-field');
    if (!wrap) return;
    wrap.style.display = String(el.value || '').trim() ? '' : 'none';
  }

  // ---- auto-fill from a source (race, template, …) ------------------------

  // `spec` takes the DB's shapes as-is. Passing null removes that source's rows.
  // Re-applying the SAME source clears its rows first, so a level-up or re-pick
  // refreshes rather than stacking duplicates.
  function applyFromSource(sourceKey, spec) {
    if (!sourceKey) return;
    clearSource(sourceKey);
    if (!spec) { notifyChanged(); return; }
    for (const r of (spec.resistances || [])) {
      const type = r && (r.damage_type || r.type);
      if (type) addRow({ kind: 'resistance', type, amount: r.amount, from: sourceKey });
    }
    for (const t of (spec.immunities || [])) {
      if (t) addRow({ kind: 'immunity', type: String(t), from: sourceKey });
    }
    for (const t of (spec.vulnerabilities || [])) {
      if (t) addRow({ kind: 'vulnerability', type: String(t), from: sourceKey });
    }
    for (const d of (spec.damage_reduction || [])) {
      if (d && d.amount != null) {
        addDR({ amount: d.amount, bypass: d.bypass, stacks: !!d.stacks, from: sourceKey });
      }
    }
    // `regeneration` arrives from the DB as a single {amount, bypass} object,
    // not a list — accept both so the caller never has to normalise.
    const regen = spec.regeneration;
    for (const g of (Array.isArray(regen) ? regen : (regen ? [regen] : []))) {
      if (g && g.amount != null) addRegen({ amount: g.amount, bypass: g.bypass, from: sourceKey });
    }
    notifyChanged();
  }

  function clearSource(sourceKey) {
    for (const row of riderRows().concat(drRows(), regenRows())) {
      if (row.dataset.from === sourceKey) row.remove();
    }
  }

  // Every source key currently owning at least one row. Lets a caller sweep by
  // prefix ("race:*") rather than having to remember which race it applied — a
  // rename or a reload between apply and remove otherwise strands rows that
  // nothing will ever clean up.
  function sourceKeys() {
    const out = new Set();
    for (const row of riderRows().concat(drRows(), regenRows())) {
      if (row.dataset.from) out.add(row.dataset.from);
    }
    return Array.from(out);
  }

  function notifyChanged() {
    syncLegacyDR();
    document.dispatchEvent(new Event('defense-riders-changed'));
    // Riders are display-and-publish only today (no bonus-layer effects), but
    // the recalc keeps any future consumer honest and costs nothing here.
    try { if (typeof window.recalcAll === 'function') window.recalcAll(); }
    catch (e) { /* never break an apply */ }
  }

  // ---- build --------------------------------------------------------------

  function datalist(id, values) {
    let dl = byId(id);
    if (dl) return;
    dl = document.createElement('datalist');
    dl.id = id;
    // No `label` attributes — Firefox renders them as visible suggestion text,
    // which makes a picker look broken (the soulmeld lesson).
    const seen = new Set();
    for (const v of values) {
      if (seen.has(v)) continue;
      seen.add(v);
      const opt = document.createElement('option');
      opt.value = v;
      dl.appendChild(opt);
    }
    document.body.appendChild(dl);
  }

  // A hand-edit hands the row over to the player: the source marker goes, so a
  // later race change stops managing it. Same contract as every other
  // auto-filled field on the sheet.
  function wireList(host, rowSel, removeCls) {
    if (!host || host.dataset.wired) return;
    host.dataset.wired = '1';
    host.addEventListener('change', (e) => {
      const row = e.target.closest(rowSel);
      if (!row) return;
      if (e.target.classList.contains('rider-kind')) syncRow(row);
      if (e.isTrusted) delete row.dataset.from;
      notifyChanged();
    });
    host.addEventListener('input', (e) => {
      const row = e.target.closest(rowSel);
      if (row && e.isTrusted) delete row.dataset.from;
    });
    host.addEventListener('click', (e) => {
      if (!e.target.classList.contains(removeCls)) return;
      e.target.closest(rowSel).remove();
      notifyChanged();
    });
  }

  function wireAdd(id, fn) {
    const btn = byId(id);
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => { fn(); notifyChanged(); });
  }

  function build() {
    const host = riderList();
    if (!host) return;
    host.innerHTML = '';
    if (drList()) drList().innerHTML = '';
    if (regenList()) regenList().innerHTML = '';
    seq = 0;

    datalist('defense-rider-types', ENERGY_TYPES.concat(IMMUNITY_SUGGESTIONS));
    datalist('dr-bypass-types', BYPASS_SUGGESTIONS);

    wireList(host, '.defense-rider-row', 'rider-remove');
    wireList(drList(), '.dr-entry-row', 'dr-remove');
    wireList(regenList(), '.regen-entry-row', 'regen-remove');
    wireAdd('defense-riders-add', () => addRow());
    wireAdd('dr-entries-add', () => addDR());
    wireAdd('regen-entries-add', () => addRegen());

    const legacy = byId('damage-reduction');
    if (legacy && !legacy.dataset.wired) {
      legacy.dataset.wired = '1';
      legacy.addEventListener('input', syncLegacyDR);
    }
    syncLegacyDR();
  }

  // ---- save / load --------------------------------------------------------

  function collectData() {
    return {
      _defense_riders: riderRows().map(readRider).filter(r => r.type),
      _dr_entries: drRows().map(readDR).filter(d => d.amount != null),
      _regeneration: regenRows().map(readRegen).filter(g => g.amount != null),
      'fast-healing': (byId('fast-healing') || {}).value || '',
    };
  }

  function loadData(data) {
    build();
    // Defensive defaults: a save written before this module existed has none of
    // these keys and must load as empty rather than as an error. Its rider
    // prose stays in the notes box, and `notes_may_contain_riders` keeps that
    // visible to anything reading the sheet.
    const d = data || {};
    for (const r of (Array.isArray(d._defense_riders) ? d._defense_riders : [])) {
      if (r && r.type) addRow({ kind: r.kind, type: r.type, amount: r.amount, from: r.from || null });
    }
    for (const e of (Array.isArray(d._dr_entries) ? d._dr_entries : [])) {
      if (e && e.amount != null) addDR(e);
    }
    for (const g of (Array.isArray(d._regeneration) ? d._regeneration : [])) {
      if (g && g.amount != null) addRegen(g);
    }
    const fh = byId('fast-healing');
    if (fh) fh.value = d['fast-healing'] ?? '';
    // Legacy single-regeneration keys (this module's own first shape, one day
    // old). Migrated forward rather than dropped — old saves outlast every
    // refactor, including a same-week one.
    if (!(Array.isArray(d._regeneration) && d._regeneration.length)) {
      const amt = intOrNull(d['regeneration-amount']);
      if (amt != null) addRegen({ amount: amt, bypass: d['regeneration-bypass'] || '' });
    }
    // Runs LAST so it can see whether structured rows already arrived.
    migrateLegacyDR();
  }

  return {
    build, addRow, addDR, addRegen, collectData, loadData,
    getStructured, notesMayContainRiders, drText,
    applyFromSource, clearSource, sourceKeys,
    parseDRText, migrateLegacyDR,
    NOTE_RIDER_RE,
  };
})();
