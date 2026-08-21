// soulmeld-effects.js — make essentia mean something (T2, 2026-08-21).
//
// WHY. The sheet already tracked incarnum well: which soulmeld is shaped in
// which slot, whether it is bound, how much essentia is invested (clickable
// pips, per slot, with the MoI capacity table driving the ceiling). What it
// did not do was let any of that reach a number. You moved a pip and nothing
// on the character changed.
//
// The obstacle is that the DB carries every soulmeld's effect as PROSE. All 94
// of them have `essentia`, `chakra` and `chakra_binds` fields and not one
// structured bonus — the mechanics are English. So this module is the missing
// middle: the player states a soulmeld's effect once, in a small structured
// form, and the sheet does the arithmetic from the live essentia count from
// then on.
//
// THE SHAPE COMES FROM THE CORPUS, not from guessing. Of the 94 soulmelds, 75
// (80%) express their essentia effect as a clean per-point scale, and the
// targets cluster hard: damage (28), checks/skills (21), energy resistance
// (13), attack (11), then HP, saves, AC, speed and natural armor in ones and
// twos. So an effect is:
//
//     value = base + perEssentia × (essentia invested in THIS soulmeld)
//
// with a target and an optional free-text qualifier.
//
// WHY `when` SOLVES THE CHAKRA-BIND PROBLEM. A soulmeld can be bound to several
// different chakras and does something different in each — Dread Carapace binds
// to arms, feet or heart, with three distinct effects. That looks like it needs
// a per-chakra table, and it does not: a shaped soulmeld occupies exactly ONE
// slot at a time, and the slot IS the chakra. So an effect row tagged
// `when: 'bound'` simply applies while that slot's bind box is ticked, and the
// per-chakra multiplicity collapses into "which slot is it in".
//
// WORKED EXAMPLE — Dread Carapace, which is what prompted this. Its own text:
// "+2 bonus on damage rolls when you are using a bite attack, or a +1 bonus
// when you are using a claw or other natural attack. In exchange, you take a -1
// penalty on attack rolls with natural weapons," and then "every point of
// essentia ... increases your attack penalty by 1 and your damage bonus by 2
// (for bite attacks) or 1 (for other natural weapons)." That is two rows:
//
//     damage  base +1  per-essentia +1  applies-to natural   (bite would be +2/+2)
//     attack  base -1  per-essentia -1  applies-to natural
//
// and at 5 essentia it yields -6 attack and +6 damage, which is exactly what
// the book's own worked example says.
//
// WHAT IS ROUTED AND WHAT IS NOT — read this before trusting a total. `damage`,
// `attack`, `ac` and `natural-armor` reach the sheet's numbers. Every other
// target is captured, computed and SHOWN in the readout but does not yet feed
// its aggregator; those rows are honest records that the sheet displays rather
// than silent no-ops, and `unrouted()` lists them so nothing pretends otherwise.
const SoulmeldEffects = (function () {
  'use strict';

  // Routed targets first, then the ones that only display. Kept in one list so
  // the UI and the router cannot drift apart about what exists.
  const TARGETS = [
    ['damage', 'damage', true],
    ['attack', 'attack', true],
    ['ac', 'AC', true],
    ['natural-armor', 'natural armor', true],
    ['save-fort', 'Fort save', false],
    ['save-ref', 'Ref save', false],
    ['save-will', 'Will save', false],
    ['skill', 'skill/check', false],
    ['resistance', 'energy resistance', false],
    ['hp', 'hit points', false],
    ['speed', 'speed', false],
    ['other', 'other', false],
  ];

  // Which attacks a damage/attack effect touches. Dread Carapace is natural-only
  // and gives bite twice what it gives a claw, which is why "bite" is separate
  // rather than a note.
  const APPLIES = [
    ['all', 'all attacks'],
    ['natural', 'natural weapons'],
    ['bite', 'bite only'],
    ['manufactured', 'manufactured weapons'],
  ];

  const ROUTED = TARGETS.filter(t => t[2]).map(t => t[0]);

  function $(sel) { return document.querySelector(sel); }
  function byId(id) { return document.getElementById(id); }

  function numOf(v) {
    const n = parseInt(String(v ?? '').trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }

  // ---- reading the shaped soulmelds ---------------------------------------

  // One entry per shaped soulmeld, with the live essentia count off its own
  // pips. `key` is stable across reloads (slot + index), which is what the
  // effect rows are stored against.
  function shaped() {
    const out = [];
    document.querySelectorAll('.magic-item-slot[data-slot-id]').forEach((slot) => {
      const id = slot.dataset.slotId;
      push(out, `${id}:0`, id, slot.querySelector('.slot-sm-name'),
           slot.querySelector('.slot-sm-bound'),
           slot.querySelector('.essentia-pips:not(.essentia-pips-2)'));
      push(out, `${id}:1`, id, slot.querySelector('.slot-sm2-name'),
           slot.querySelector('.slot-sm2-bound'),
           slot.querySelector('.essentia-pips-2'));
    });
    push(out, 'totem:0', 'totem', byId('totem-sm-name'), byId('totem-sm-bound'),
         byId('totem-essentia-pips'));
    push(out, 'totem:1', 'totem', byId('totem-sm2-name'), byId('totem-sm2-bound'),
         byId('totem-essentia-pips-2'));
    return out;
  }

  function push(out, key, slotId, nameEl, boundEl, pipsEl) {
    const name = (nameEl && nameEl.value || '').trim();
    if (!name) return;                       // an empty slot is not a soulmeld
    out.push({
      key, slot: slotId, name,
      bound: !!(boundEl && boundEl.checked),
      essentia: pipsEl ? pipsEl.querySelectorAll('.essentia-pip.filled').length : 0,
    });
  }

  function find(key) { return shaped().find(s => s.key === key) || null; }

  // ---- the effect store ---------------------------------------------------
  //
  // Keyed by slot-index rather than by soulmeld NAME on purpose: the same
  // soulmeld can be shaped in two chakras with different bind effects, and the
  // slot is what distinguishes them. Re-shaping a different soulmeld into a
  // slot leaves that slot's rows behind, so the store also records the name it
  // was written for and the UI warns when they diverge rather than silently
  // applying one soulmeld's numbers to another.
  let store = {};

  function rowsFor(key) { return (store[key] && store[key].rows) || []; }
  function nameFor(key) { return (store[key] && store[key].name) || null; }

  function setRows(key, name, rows) {
    if (!rows || !rows.length) { delete store[key]; return; }
    store[key] = { name, rows };
  }

  // ---- computation --------------------------------------------------------

  // value = base + perEssentia × invested, for every row whose `when` is
  // satisfied. A `bound` row contributes nothing while the slot is unbound —
  // that is the whole point of the flag.
  function computeAll() {
    const out = [];
    for (const sm of shaped()) {
      for (const row of rowsFor(sm.key)) {
        if (row.when === 'bound' && !sm.bound) continue;
        const value = numOf(row.base) + numOf(row.perEssentia) * sm.essentia;
        if (!value) continue;
        out.push({
          soulmeld: sm.name, slot: sm.slot, essentia: sm.essentia,
          when: row.when || 'shaped',
          target: row.target || 'other',
          appliesTo: row.appliesTo || 'all',
          note: row.note || '',
          value,
          routed: ROUTED.indexOf(row.target) !== -1,
        });
      }
    }
    return out;
  }

  // Effects the player has entered that the sheet computes but does not yet
  // feed anywhere. Surfaced deliberately: a row that silently does nothing is
  // worse than no row at all, because it looks like it worked.
  function unrouted() { return computeAll().filter(e => !e.routed); }

  // Fed into app.js's collectActiveBonuses.
  function getActiveBonuses() {
    let ac = 0;
    for (const e of computeAll()) {
      // Natural armor and AC both land on the AC total. They are kept as
      // separate targets because they stack differently against other sources,
      // and separating them now costs nothing and is hard to retrofit later.
      if (e.target === 'ac' || e.target === 'natural-armor') ac += e.value;
    }
    return { ac };
  }

  // Per-weapon attack/damage modifiers, filtered by what the weapon IS. The
  // caller passes the row's fighting style; `natural` covers both the primary
  // and secondary natural styles, and `bite` is narrower still.
  function getWeaponMods(style) {
    const s = String(style || '');
    const isNatural = s.indexOf('natural') === 0;
    const isManufactured = !isNatural && s !== 'unarmed';
    let attack = 0, damage = 0;
    const sources = [];
    for (const e of computeAll()) {
      if (e.target !== 'attack' && e.target !== 'damage') continue;
      let applies;
      if (e.appliesTo === 'all') applies = true;
      else if (e.appliesTo === 'natural') applies = isNatural;
      else if (e.appliesTo === 'manufactured') applies = isManufactured;
      // "bite" is a specific natural attack the sheet cannot identify from the
      // style alone, so it is NOT applied automatically — it would be wrong on
      // every claw. It shows in the readout and the player adds it by hand.
      else if (e.appliesTo === 'bite') applies = false;
      if (!applies) continue;
      if (e.target === 'attack') attack += e.value; else damage += e.value;
      sources.push(e);
    }
    return { attack, damage, sources };
  }

  // ---- suggestion from the book text (T3) ---------------------------------
  //
  // Reads the soulmeld's own essentia prose and proposes what it can. This is a
  // SUGGESTION and never an auto-apply, and the reason is measured rather than
  // cautious: run over all 94 soulmelds, the per-point SCALE parses for 88 of
  // them (94%) while the TARGET only parses for 51 (54%). The gap is not
  // sloppiness in the regexes — it is that a third of the entries name their
  // target with a pronoun that lives in the DESCRIPTION, not the essentia
  // sentence:
  //
  //     "Every point of essentia invested in the acrobat boots increases
  //      the bonus by 2."          <- which bonus? not stated here
  //     "...increases the insight bonus by 2."   <- on what? not stated here
  //
  // So the split is deliberate: the arithmetic, which is tedious and 94%
  // machine-readable, is filled in; the target, which needs judgement a third
  // of the time, is left for the player and the parse says so. Guessing it
  // would be right two times in three, which is the worst possible accuracy for
  // something that looks authoritative.
  const SCALE_PATTERNS = [
    // "5 times the number of points", "3 × the number of points"
    [/(\d+)\s*(?:times|[x×])\s*the number of points of (?:invested )?essentia/i,
     m => ({ per: parseInt(m[1], 10) })],
    // "equal to (double) the number of points of essentia"
    [/equal to (double )?the number of points of (?:invested )?essentia/i,
     m => ({ per: m[1] ? 2 : 1 })],
    // Dice-valued: "increases the damage dealt by 1d6 points" per essentia.
    [/\bby (\d+d\d+)\b[^.]{0,80}?(?:for every|per) point of (?:invested )?essentia/i,
     m => ({ dice: m[1] })],
    [/(?:every|each) point of (?:invested )?essentia[^.]{0,140}?\bby (\d+d\d+)\b/i,
     m => ({ dice: m[1] })],
    // Flat: "increases X by N per point" / "every point ... increases X by N"
    [/\bby (\d+)\b[^.]{0,80}?(?:for every|per) point of (?:invested )?essentia/i,
     m => ({ per: parseInt(m[1], 10) })],
    [/(?:every|each) point of (?:invested )?essentia[^.]{0,140}?\bby (\d+)\b/i,
     m => ({ per: parseInt(m[1], 10) })],
    // "N feet per point", "5% per point"
    [/(\d+)\s*(?:feet|ft\.?|%)\s*per point of (?:invested )?essentia/i,
     m => ({ per: parseInt(m[1], 10) })],
    // Bare mention with no number means one per point.
    [/per point of (?:invested )?essentia|for (?:each|every) point of (?:invested )?essentia/i,
     () => ({ per: 1 })],
  ];

  const TARGET_PATTERNS = [
    [/\bdamage reduction\b/i, 'other'],          // DR has its own store; see below
    [/resistance to (?:acid|cold|electricity|fire|sonic)|energy resistance/i, 'resistance'],
    [/\bnatural armor\b/i, 'natural-armor'],
    [/bonus to (?:your )?armor class|\barmor bonus\b/i, 'ac'],
    [/\bwill saves?\b/i, 'save-will'],
    [/\breflex saves?\b/i, 'save-ref'],
    [/\bfortitude saves?\b/i, 'save-fort'],
    [/\bdamage rolls?\b|\bdamage bonus\b|\bdamage dealt\b|\bextra damage\b/i, 'damage'],
    [/\battack rolls?\b|\battack penalty\b/i, 'attack'],
    [/\bhit points?\b/i, 'hp'],
    [/\bspeed\b|\bfly\b/i, 'speed'],
    [/\bchecks?\b/i, 'skill'],
  ];

  // Returns {per, dice, target, sentence, targetKnown} or null.
  function suggestFrom(text) {
    if (!text) return null;
    // The books follow the rule with a worked example ("Thus, if you invest 5
    // points...") whose numbers would parse as the scale if we let them.
    const sentences = String(text).split(/(?<=\.)\s+/)
      .filter(s => /essentia/i.test(s) && !/^\s*(thus|for example)\b/i.test(s));
    for (const sentence of sentences) {
      let scale = null;
      for (const [re, fn] of SCALE_PATTERNS) {
        const m = re.exec(sentence);
        if (m) { scale = fn(m); break; }
      }
      if (!scale) continue;
      let target = null;
      for (const [re, t] of TARGET_PATTERNS) { if (re.test(sentence)) { target = t; break; } }
      return {
        per: scale.per != null ? scale.per : null,
        dice: scale.dice || null,
        target, targetKnown: !!target,
        sentence: sentence.trim(),
      };
    }
    return null;
  }

  // The soulmeld's essentia prose as the sheet holds it. soulmeld-picker writes
  // "<base effect> (Essentia: <essentia text>)" into the base field, so the
  // text is already on the page and this needs no DB round trip.
  function essentiaTextFor(key) {
    const [slotId, idx] = String(key).split(':');
    let el;
    if (slotId === 'totem') {
      el = byId(idx === '1' ? 'totem-sm2-base' : 'totem-sm-base');
    } else {
      const slot = document.querySelector(`.magic-item-slot[data-slot-id="${slotId}"]`);
      el = slot && slot.querySelector(idx === '1' ? '.slot-sm2-base' : '.slot-sm-base');
    }
    const raw = (el && el.value) || '';
    const m = /\(Essentia:\s*([\s\S]*)\)\s*$/.exec(raw);
    return m ? m[1] : raw;
  }

  // ---- UI -----------------------------------------------------------------

  function rowHtml(r) {
    r = r || {};
    const opt = (list, sel) => list.map(([v, label]) =>
      `<option value="${v}"${v === sel ? ' selected' : ''}>${label}</option>`).join('');
    return `<div class="sme-row">` +
      `<select class="sme-when" title="A bound effect only applies while this slot's chakra bind is ticked. That is how one soulmeld carries different effects in different chakras — the slot IS the chakra.">` +
        `<option value="shaped"${r.when !== 'bound' ? ' selected' : ''}>shaped</option>` +
        `<option value="bound"${r.when === 'bound' ? ' selected' : ''}>bound</option></select>` +
      `<input type="number" class="sme-base" placeholder="0" title="Flat amount that applies regardless of essentia." value="${r.base != null ? r.base : ''}">` +
      `<span class="sme-plus">+</span>` +
      `<input type="number" class="sme-per" placeholder="0" title="Amount added per point of essentia invested in this soulmeld." value="${r.perEssentia != null ? r.perEssentia : ''}">` +
      `<span class="sme-per-label">/ess</span>` +
      `<select class="sme-target">${opt(TARGETS.map(t => [t[0], t[1]]), r.target || 'damage')}</select>` +
      `<select class="sme-applies" title="Which attacks this touches. Bite is never applied automatically — the sheet cannot tell a bite from a claw, and guessing would be wrong on every claw.">${opt(APPLIES, r.appliesTo || 'all')}</select>` +
      `<input type="text" class="sme-note" placeholder="note" value="${String(r.note || '').replace(/"/g, '&quot;')}">` +
      `<button type="button" class="sme-remove" title="Remove">&times;</button>` +
      `</div>`;
  }

  // The effects live inside the soulmeld's existing ⓘ panel, under the prose
  // they are a structured restatement of — so the book text and the numbers a
  // player derived from it sit together.
  function ensureBlock(panel, key) {
    let block = panel.querySelector('.sme-block');
    if (block) return block;
    block = document.createElement('div');
    block.className = 'sme-block';
    block.dataset.key = key;
    block.innerHTML =
      `<div class="sme-head">Effects <span class="sme-sub">— computed from the essentia invested here</span></div>` +
      `<div class="sme-rows"></div>` +
      `<button type="button" class="sme-add">+ effect</button>` +
      `<button type="button" class="sme-suggest" title="Read this soulmeld's own essentia text and fill in what it can. It fills the per-essentia NUMBER, which is machine-readable for 94% of the catalogue, and leaves the TARGET blank when the book names it with a pronoun (&quot;increases the bonus by 2&quot;) — which is a third of them. It will not guess.">suggest from book text</button>` +
      `<div class="sme-suggest-note"></div>` +
      `<div class="sme-readout"></div>`;
    panel.appendChild(block);
    for (const r of rowsFor(key)) {
      block.querySelector('.sme-rows').insertAdjacentHTML('beforeend', rowHtml(r));
    }
    return block;
  }

  // Fill a fresh row from the book text, saying plainly what it could and could
  // not work out. The note is the point: a suggestion that silently omits the
  // half it failed on is indistinguishable from one that succeeded.
  function applySuggestion(block) {
    const key = block.dataset.key;
    const note = block.querySelector('.sme-suggest-note');
    const parsed = suggestFrom(essentiaTextFor(key));
    if (!parsed) {
      if (note) note.textContent =
        'Could not find a per-essentia scale in this soulmeld text — enter it by hand.';
      return;
    }
    const row = { when: 'shaped', base: '', perEssentia: parsed.per != null ? parsed.per : '',
                  target: parsed.target || 'other', appliesTo: 'all', note: '' };
    block.querySelector('.sme-rows').insertAdjacentHTML('beforeend', rowHtml(row));
    syncBlock(block);
    if (!note) return;
    const bits = [];
    if (parsed.dice) {
      bits.push(`the book scales this by ${parsed.dice} PER POINT — dice-valued effects ` +
        `are not modelled here (5 soulmelds do this); use a damage rider instead`);
    } else if (parsed.per != null) {
      bits.push(`+${parsed.per} per point of essentia`);
    }
    bits.push(parsed.targetKnown
      ? `target read as "${parsed.target}"`
      : 'TARGET NOT SET — the book names it with a pronoun here, so pick it yourself');
    note.textContent = bits.join(' · ');
  }

  function readBlock(block) {
    return Array.from(block.querySelectorAll('.sme-row')).map(r => ({
      when: r.querySelector('.sme-when').value,
      base: r.querySelector('.sme-base').value,
      perEssentia: r.querySelector('.sme-per').value,
      target: r.querySelector('.sme-target').value,
      appliesTo: r.querySelector('.sme-applies').value,
      note: r.querySelector('.sme-note').value,
    })).filter(r => numOf(r.base) || numOf(r.perEssentia));
  }

  function syncBlock(block) {
    const key = block.dataset.key;
    const sm = find(key);
    setRows(key, sm ? sm.name : null, readBlock(block));
    refreshReadout(block, key, sm);
  }

  function refreshReadout(block, key, sm) {
    const out = block.querySelector('.sme-readout');
    if (!out) return;
    if (!sm) { out.textContent = 'No soulmeld shaped in this slot.'; return; }
    const mine = computeAll().filter(e => e.slot === sm.slot && e.soulmeld === sm.name);
    const storedName = nameFor(key);
    const parts = mine.map(e => {
      const t = (TARGETS.find(x => x[0] === e.target) || [, e.target])[1];
      const scope = e.appliesTo === 'all' ? '' : ` (${(APPLIES.find(a => a[0] === e.appliesTo) || [, ''])[1]})`;
      const tag = e.routed ? '' : ' [display only]';
      return `${e.value >= 0 ? '+' : ''}${e.value} ${t}${scope}${tag}`;
    });
    let text = parts.length
      ? `${sm.essentia} essentia → ${parts.join(', ')}`
      : `${sm.essentia} essentia → no effect rows yet`;
    // The store is keyed by SLOT, so re-shaping leaves the old rows behind.
    // Say so rather than quietly applying one soulmeld's numbers to another.
    if (storedName && storedName !== sm.name) {
      text += ` ⚠ these rows were written for ${storedName}, not ${sm.name}`;
    }
    out.textContent = text;
  }

  function refreshAll() {
    document.querySelectorAll('.sme-block').forEach((block) => {
      refreshReadout(block, block.dataset.key, find(block.dataset.key));
    });
  }

  // One delegated handler on the grid, matching how the ⓘ panels themselves are
  // wired. Rooted at the GRID because the blocks are created lazily when a panel
  // is first opened — binding per block would miss every one made later.
  function build() {
    const grid = byId('magic-items-grid');
    if (!grid || grid.dataset.smeWired) return;
    grid.dataset.smeWired = '1';
    grid.addEventListener('click', (ev) => {
      const add = ev.target.closest('.sme-add');
      if (add) {
        const block = add.closest('.sme-block');
        block.querySelector('.sme-rows').insertAdjacentHTML('beforeend', rowHtml({}));
        syncBlock(block); recalc(); return;
      }
      const sug = ev.target.closest('.sme-suggest');
      if (sug) { applySuggestion(sug.closest('.sme-block')); recalc(); return; }
      const rm = ev.target.closest('.sme-remove');
      if (rm) {
        const block = rm.closest('.sme-block');
        rm.closest('.sme-row').remove();
        syncBlock(block); recalc(); return;
      }
      // A ⓘ toggle may have just revealed a panel that has no block yet.
      if (ev.target.closest('.btn-sm-info')) setTimeout(attachBlocks, 0);
    });
    const onEdit = (ev) => {
      const block = ev.target.closest('.sme-block');
      if (block) { syncBlock(block); recalc(); }
    };
    grid.addEventListener('input', onEdit);
    grid.addEventListener('change', onEdit);
    attachBlocks();
  }

  // Give every open ⓘ panel its effects block. Panels are built by equipment.js
  // and revealed on demand, so this is called after a toggle and after a load.
  function attachBlocks() {
    document.querySelectorAll('.slot-sm-info').forEach((panel) => {
      const key = keyForPanel(panel);
      if (key) ensureBlock(panel, key);
    });
    refreshAll();
  }

  // Which shaped-soulmeld slot a panel belongs to. Mirrors equipment.js's own
  // smInfoPanelFor resolution in reverse.
  function keyForPanel(panel) {
    if (panel.closest('#totem-sm-second')) return 'totem:1';
    const totem = panel.closest('.slot-totem');
    if (totem) return 'totem:0';
    const slot = panel.closest('.magic-item-slot[data-slot-id]');
    if (!slot) return null;
    const second = panel.closest('.slot-sm-second');
    return `${slot.dataset.slotId}:${second ? 1 : 0}`;
  }

  function recalc() {
    try { if (typeof window.recalcAll === 'function') window.recalcAll(); }
    catch (e) { /* never break an edit */ }
  }

  // ---- save / load --------------------------------------------------------

  function collectData() {
    // Trim to slots that still hold rows; an emptied block should not persist
    // as a husk that reappears as an empty section on reload.
    const out = {};
    for (const [k, v] of Object.entries(store)) {
      if (v && v.rows && v.rows.length) out[k] = v;
    }
    return { _soulmeld_effects: out };
  }

  function loadData(data) {
    const saved = (data && data._soulmeld_effects);
    store = (saved && typeof saved === 'object') ? JSON.parse(JSON.stringify(saved)) : {};
    // Blocks are rebuilt from the store, so drop any that equipment.js has
    // already re-rendered with stale contents.
    document.querySelectorAll('.sme-block').forEach(b => b.remove());
    build();
    attachBlocks();
  }

  return {
    build, attachBlocks, refreshAll,
    shaped, computeAll, unrouted, getActiveBonuses, getWeaponMods,
    suggestFrom, essentiaTextFor,
    collectData, loadData,
    TARGETS, APPLIES,
  };
})();
