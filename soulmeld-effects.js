// soulmeld-effects.js — make essentia mean something.
//
// WHY. The sheet already tracked incarnum well: which soulmeld is shaped in
// which slot, whether it is bound, how much essentia is invested (clickable
// pips, per slot, with the MoI capacity table driving the ceiling). What it
// did not do was let any of that reach a number. You moved a pip and nothing
// on the character changed.
//
// WHERE THE EFFECTS COME FROM (changed 2026-08-21). They used to be typed in
// by hand, per character, per soulmeld, because the DB carried every effect as
// PROSE. They are now DATA: all 94 soulmelds carry structured `bonuses` in the
// DB — 194 rows, hand-authored from each soulmeld's own text and guarded by
// mechanical invariants (see the sibling project's _soulmeld_bonuses_data.py).
// So a shaped soulmeld computes immediately, for everyone, with no typing and
// without even opening its ⓘ panel.
//
// A prose parser was tried first and is deliberately NOT here. Measured over
// all 94: it recovers the per-point SCALE for 94% but the TARGET for only 57%,
// because a third of the entries name their target with a pronoun that lives
// in a different field ("Every point ... increases the bonus by 2" — which
// bonus? four skills back, in the description). Guessing would be right two
// times in three, which is the worst possible accuracy for something that
// looks authoritative.
//
// THE ROW SHAPE IS THE DB'S CANONICAL `bonuses`, end to end — no second
// vocabulary anywhere in this file:
//
//     { bonus_type, target, amount, bonus_category, condition,
//       scaling: {kind:'per_essentia', step|dice, max?},
//       when: 'shaped'|'bound', chakra, applies_to, target_scope }
//
// An earlier draft of this module invented {base, perEssentia, target,
// appliesTo, when} sheet-side. That was a second shape for a concept the DB
// already had ~700 rows of, and two of its names collided in MEANING with the
// canon — its `target` ('damage'/'attack') is the canon's `bonus_type`, while
// the canon's `target` is the specific instance ('Balance', 'Will', 'fire').
// Keeping one shape is what lets the resolved rows feed the sheet's EXISTING
// aggregators (DND35.categorizeSaveBonuses and friends) instead of needing
// their own parallel plumbing.
//
// HOW ESSENTIA IS FOLDED IN. `amount + step × invested`, capped by
// `scaling.max` where the book prints a ceiling. The resolved row then drops
// its `scaling` and becomes an ordinary flat row — the same move
// DND35.resolveAbilityLinkedBonus makes for ability-linked rows, and the
// reason it matters is DND35.flatBonusRowOk: it REJECTS any row that still
// carries `scaling`, so an unresolved soulmeld row can never leak into a total.
//
// WHY `when` SOLVES THE CHAKRA-BIND PROBLEM — and why `chakra` is needed too.
// A soulmeld can bind to several chakras and do something different in each.
// A shaped soulmeld occupies exactly one slot, and the slot IS the chakra, so
// a `when:'bound'` row simply applies while that slot's bind box is ticked.
// But 55 of the 94 bind to MORE than one chakra with a different effect in
// each, so the row also names which bind it came from, and a bound row only
// counts when the slot's chakra matches it.
//
// WORKED EXAMPLE — Dread Carapace, which is what prompted all of this. Its
// own text gives +2 damage with a bite or +1 with another natural attack, a -1
// attack penalty with natural weapons, and each point of essentia adds another
// of each. That is three rows, and at 5 essentia the sheet computes -6 attack
// and +12 bite / +6 other natural damage — exactly the worked example the book
// itself prints.
//
// WHAT REACHES A TOTAL AND WHAT ONLY DISPLAYS. Each of these goes to the
// sheet's OWN aggregator for that thing rather than to a private one here —
// which is the dividend of using the canonical row shape:
//
//   attack / damage            per-weapon, via getWeaponMods
//   ac / natural_armor         typed protItem rows into the AC onion, so 3.5
//                              stacking and the touch / flat-footed flags
//                              apply per bonus type
//   skill / save / initiative  DND35.categorize*Bonuses, the same helpers that
//                              fold in race, template, feat and trait bonuses
//   energy_resistance / DR     DefenseRiders.applyFromSource, so they sit in
//                              the structured rider list beside a race's
//   spell_resistance           shown beside #spell-resistance (does not stack)
//   miss_chance                shown beside #ac-miss-chance (highest wins)
//
// Still display-only, computed and SHOWN with no aggregator to land in: turn
// resistance, darkvision, illumination, spell DC, spell damage, caster level,
// confirm-critical, hit points, speed, grapple, ability checks. `unrouted()`
// lists them so nothing pretends to have applied.
const SoulmeldEffects = (function () {
  'use strict';

  // bonus_type → label. Ordered routed-first. Kept in one list so the UI and
  // the router cannot drift apart about what exists. `routed` means "reaches a
  // total somewhere", whether here or through a sheet aggregator.
  const TYPES = [
    ['damage', 'damage', true],
    ['attack', 'attack', true],
    ['ac', 'AC', true],
    ['natural_armor', 'natural armor', true],
    ['skill', 'skill', true],
    ['save', 'save', true],
    ['initiative', 'initiative', true],
    ['ability_check', 'ability check', false],
    ['grapple', 'grapple', false],
    ['energy_resistance', 'energy resistance', true],
    ['damage_reduction', 'damage reduction', true],
    ['spell_resistance', 'spell resistance', true],
    ['turn_resistance', 'turn resistance', false],
    ['hp', 'hit points', false],
    ['speed', 'speed', false],
    ['darkvision', 'darkvision (ft)', false],
    ['miss_chance', 'miss chance (%)', true],
    ['illumination', 'illumination (ft)', false],
    ['spell_dc', 'spell save DC', false],
    ['spell_damage', 'spell damage', false],
    ['caster_level', 'caster level', false],
    ['confirm_critical', 'confirm critical', false],
    ['other', 'other', false],
  ];

  // Which attacks an attack/damage row touches. Dread Carapace is
  // natural-only and gives a bite twice what it gives a claw, which is why
  // "bite" is separate rather than a note.
  const APPLIES = [
    ['all', 'all attacks'],
    ['natural', 'natural weapons'],
    ['bite', 'bite only'],
    ['manufactured', 'manufactured weapons'],
  ];

  const ROUTED = TYPES.filter(t => t[2]).map(t => t[0]);
  const LABEL = {};
  TYPES.forEach(t => { LABEL[t[0]] = t[1]; });

  // Source-key prefix for the rows this module owns in DefenseRiders.
  const RIDER_PREFIX = 'soulmeld:';

  function byId(id) { return document.getElementById(id); }

  function numOf(v) {
    const n = parseInt(String(v == null ? '' : v).trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }

  // ---- the book's own rows, from the DB -----------------------------------

  // Queried once and cached by lower-cased name. Read straight from the DB
  // rather than through soulmeld-picker's index on purpose: that index is
  // BOOK-FILTERED, and a character who already has a soulmeld shaped should
  // not silently lose its effects because the book got unticked afterwards.
  let dbIndex = null;

  function loadDbRows() {
    if (dbIndex) return dbIndex;
    dbIndex = new Map();
    try {
      if (typeof DB === 'undefined' || !DB.isLoaded || !DB.isLoaded()) {
        dbIndex = null;              // not ready yet — retry on the next call
        return new Map();
      }
      const rows = DB.query(
        "SELECT name, json_extract(data, '$.bonuses') AS bonuses "
        + "FROM entry WHERE type = 'soulmeld' "
        + "AND json_extract(data, '$.bonuses') IS NOT NULL");
      for (const r of rows) {
        let parsed = [];
        try { parsed = JSON.parse(r.bonuses) || []; }
        catch (e) { parsed = []; }   // malformed row — treat as no effects
        if (!Array.isArray(parsed) || !parsed.length) continue;
        const key = String(r.name || '').toLowerCase();
        if (!dbIndex.has(key)) dbIndex.set(key, parsed);
      }
    } catch (e) {
      dbIndex = null;
      return new Map();
    }
    return dbIndex;
  }

  function dbRowsFor(name) {
    const idx = loadDbRows();
    return idx.get(String(name || '').toLowerCase()) || [];
  }

  // ---- reading the shaped soulmelds ---------------------------------------

  // One entry per shaped soulmeld, with the live essentia count off its own
  // pips. `key` is stable across reloads (slot + index), which is what any
  // player-edited rows are stored against.
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

  // Which chakras a body slot corresponds to. Borrowed from soulmeld-picker
  // rather than copied, because a second copy of this map is a second thing to
  // keep true — the project has been bitten by hand-maintained duplicates
  // often enough. The fallback only matters if the picker failed to load, in
  // which case an unmatched bound row is skipped rather than misapplied.
  function chakrasForSlot(slotId) {
    const map = (typeof window !== 'undefined' && window.SoulmeldPicker
                 && window.SoulmeldPicker.SLOT_TO_CHAKRAS) || null;
    if (map && map[slotId]) return map[slotId];
    return slotId === 'totem' ? ['Totem'] : [];
  }

  // ---- the effect store (player edits only) -------------------------------
  //
  // The DB is the default source, so nothing is stored unless the player has
  // actually changed something. Keyed by slot-index rather than by soulmeld
  // NAME on purpose: the same soulmeld can be shaped in two chakras with
  // different bind effects, and the slot is what distinguishes them. The store
  // also records the name it was written for, so re-shaping a different
  // soulmeld into a slot falls back to the NEW soulmeld's book rows instead of
  // applying the old one's numbers.
  let store = {};

  function nameFor(key) { return (store[key] && store[key].name) || null; }
  function isEdited(key, sm) {
    const s = store[key];
    return !!(s && s.rows && s.name === (sm && sm.name));
  }

  // The rows in force for a slot: the player's if they edited this soulmeld,
  // otherwise the book's own.
  function rowsFor(key, smIn) {
    const sm = smIn || find(key);
    if (isEdited(key, sm)) return store[key].rows;
    return sm ? dbRowsFor(sm.name) : [];
  }

  function setRows(key, name, rows) {
    if (!rows || !rows.length) { store[key] = { name, rows: [] }; return; }
    store[key] = { name, rows };
  }

  // ---- computation --------------------------------------------------------

  // Fold this soulmeld's invested essentia into a row, returning an ordinary
  // FLAT canonical row (no `scaling`) plus a little display metadata. Mirrors
  // DND35.resolveAbilityLinkedBonus, and the dropped `scaling` is what lets
  // DND35.flatBonusRowOk accept the result.
  function resolve(row, sm) {
    const sc = row.scaling || null;
    const step = sc && typeof sc.step === 'number' ? sc.step : 0;
    let amount = numOf(row.amount) + step * sm.essentia;
    if (sc && typeof sc.max === 'number') {
      amount = amount < 0 ? Math.max(amount, -sc.max) : Math.min(amount, sc.max);
    }
    const out = Object.assign({}, row, {
      amount,
      source: `${sm.name} (soulmeld)`,
      soulmeld: sm.name,
      slot: sm.slot,
      essentia: sm.essentia,
      // Per ROW, not per type: a conditional row reaches no total no matter
      // how routable its type is, and the readout's "[display only]" tag
      // should mean exactly "this number is not in any total".
      routed: ROUTED.indexOf(row.bonus_type) !== -1 && !row.condition,
    });
    delete out.scaling;
    // Dice-valued scales have no integer amount at all; carry the rolled
    // expression for display and leave `amount` at 0 so no total is corrupted.
    // "1d4" means 1d4 PER POINT, so N essentia is (N × count)d(faces).
    if (sc && sc.dice) {
      const m = /^(\d+)d(\d+)$/.exec(String(sc.dice));
      out.dice = (m && sm.essentia)
        ? `${parseInt(m[1], 10) * sm.essentia}d${m[2]}` : null;
      out.dicePerPoint = sc.dice;
      out.amount = 0;
    }
    return out;
  }

  // Every row currently in force, resolved. A `bound` row contributes nothing
  // while the slot's bind box is unticked — that is the whole point of the
  // flag — and nothing when the slot's chakra isn't the one the row belongs to.
  function computeAll() {
    const out = [];
    for (const sm of shaped()) {
      const valid = chakrasForSlot(sm.slot).map(c => String(c).toLowerCase());
      for (const row of rowsFor(sm.key, sm)) {
        if (!row || !row.bonus_type) continue;
        if (row.when === 'bound') {
          if (!sm.bound) continue;
          const want = String(row.chakra || '').toLowerCase();
          if (want && valid.length && valid.indexOf(want) === -1) continue;
        }
        const r = resolve(row, sm);
        if (!r.amount && !r.dice) continue;
        out.push(r);
      }
    }
    return out;
  }

  // Rows the sheet computes but has nowhere to put. Surfaced deliberately: a
  // row that silently does nothing is worse than no row at all, because it
  // looks like it worked.
  function unrouted() { return computeAll().filter(e => !e.routed); }

  // Rows fit to hand to the sheet's flat aggregators — ally-scoped and
  // dice-valued ones are not the character's own flat numbers.
  function flatRows() {
    const ok = (typeof DND35 !== 'undefined' && DND35.flatBonusRowOk)
      ? (r) => DND35.flatBonusRowOk(r) : () => true;
    return computeAll().filter(r => !r.dice && ok(r));
  }

  // AC as TYPED protItem rows, not one untyped number.
  //
  // This is the fix for touch AC. The first cut summed every soulmeld AC point
  // into `bonuses.ac`, which character.js adds to acTotal, touchAC AND
  // flatFootedAC alike — so Totem Avatar's natural armor inflated touch AC
  // (natural armor never applies against touch), Ankheg Breastplate's armor
  // bonus did the same, and Riding Bracers' DODGE bonus survived being
  // flat-footed, which is precisely the bonus you lose. Going through the
  // protItem list instead means the AC onion applies 3.5 stacking and the
  // touch/flat-footed flags per bonus type, exactly as it does for a worn item.
  function getActiveACBonuses() {
    const items = [];
    const situational = [];
    // Non-natural AC rows: the sheet's own categorizer already resolves type,
    // touch and flat-footed, and routes condition-bearing rows to notes.
    if (typeof DND35 !== 'undefined' && DND35.categorizeACBonuses) {
      const c = DND35.categorizeACBonuses(flatRows());
      items.push(...(c.items || []));
      situational.push(...(c.situational || []));
    }
    // Natural armor is skipped by that categorizer BY DESIGN — the sheet routes
    // natural armor through its own #ac-natural field, so re-feeding a race's
    // rows there would double-count. A soulmeld is not in that field, so its
    // rows have to be added here or Totem Avatar and Wormtail Belt lose their
    // entire effect.
    for (const e of flatRows()) {
      if (e.bonus_type !== 'natural_armor' || !e.amount) continue;
      if (e.condition) {
        situational.push({ type: 'Natural Armor', ac: e.amount,
                           condition: e.condition, category: e.bonus_category,
                           source: e.source });
        continue;
      }
      items.push({
        type: 'Natural Armor', ac: e.amount, touch: false, flatfooted: true,
        // Both soulmeld sources are ENHANCEMENT bonuses to natural armor,
        // which in 3.5 add to the creature's own natural armor rather than
        // overlapping it — the same "increase to natural armor" the ability-AC
        // rows model with their stack toggle. A plain (untyped) natural armor
        // bonus would overlap, so the flag follows the category rather than
        // being hardcoded.
        stacks: String(e.bonus_category || '').toLowerCase() === 'enhancement',
        source: e.source,
      });
    }
    return { items, situational };
  }

  // Energy resistance and damage reduction, in the shape
  // DefenseRiders.applyFromSource consumes — so a soulmeld's fire resistance
  // appears in the same structured rider list as a race's, tagged with where
  // it came from, instead of being a number this module knows and nothing else
  // does.
  //
  // UNCONDITIONAL rows only. A structured rider row has nowhere to put a
  // condition (the module's own doc sends conditional riders to Defense Notes),
  // and Wind Cloak's "DR 2/magic against RANGED weapons" entered as a flat row
  // would claim a defence the character does not have. The skipped ones are
  // returned so a caller can surface them rather than lose them.
  // Grouped PER SOULMELD, keyed `soulmeld:<name>` to match race-picker's
  // `race:<name>` convention — the marker ends up in the save file, where a
  // name stays readable and a DB id would not.
  function getDefenseRiderSpec() {
    const bySource = new Map();
    const conditional = [];
    for (const e of flatRows()) {
      if (!e.amount) continue;
      const isER = e.bonus_type === 'energy_resistance';
      const isDR = e.bonus_type === 'damage_reduction';
      if (!isER && !isDR) continue;
      if (e.condition) { conditional.push(e); continue; }
      const key = `${RIDER_PREFIX}${e.soulmeld}`;
      if (!bySource.has(key)) {
        bySource.set(key, { resistances: [], damage_reduction: [] });
      }
      const spec = bySource.get(key);
      if (isER) {
        if (e.target) spec.resistances.push({ damage_type: e.target, amount: e.amount });
      } else {
        // A blank bypass means "nothing bypasses this" (DR X/—), which is the
        // BEST kind of DR — so an unknown bypass must never arrive blank.
        // Adamant Pauldrons, whose bypass depends on the wearer's alignment,
        // carries that in its condition and is therefore skipped above.
        spec.damage_reduction.push({ amount: e.amount, bypass: e.target || '',
                                     stacks: false });
      }
    }
    return { sources: Array.from(bySource, ([key, spec]) => ({ key, spec })),
             conditional };
  }

  // Push the current riders into DefenseRiders, and retire any this character
  // no longer has.
  //
  // NOT called from recalc, deliberately: applyFromSource ends in its own
  // recalcAll, so driving it from inside a recalc would recurse. It runs from
  // the same grid interactions that change essentia — which is where the
  // change actually originates — and a signature guard makes a no-change pass
  // free, so a pip click that alters nothing here costs nothing.
  let lastRiderSig = null;

  function syncDefenseRiders() {
    if (typeof DefenseRiders === 'undefined' || !DefenseRiders.applyFromSource) return;
    const { sources } = getDefenseRiderSpec();
    const sig = JSON.stringify(sources);
    if (sig === lastRiderSig) return;
    lastRiderSig = sig;
    const live = new Set(sources.map(s => s.key));
    // Passing a null spec clears the key AND notifies; a bare clearSource
    // would leave the sheet showing a rider the character just lost.
    if (DefenseRiders.sourceKeys) {
      for (const k of DefenseRiders.sourceKeys()) {
        if (String(k).indexOf(RIDER_PREFIX) === 0 && !live.has(k)) {
          DefenseRiders.applyFromSource(k, null);
        }
      }
    }
    for (const { key, spec } of sources) DefenseRiders.applyFromSource(key, spec);
  }

  // Spell resistance does NOT stack — the highest applies. Nor does a miss
  // chance: the sheet's own field says so ("50/20 → highest wins at 50"). So
  // these report the BEST single source rather than a sum, and the sheet shows
  // the effective value BESIDE the manual field instead of writing into it — a
  // box the player types in is the wrong home for a number that changes every
  // time an essentia pip moves.
  //
  // A conditional winner is reported, not hidden, but flagged: Fellmist Robe's
  // concealment genuinely does not apply to an adjacent attacker, and silently
  // dropping it and silently counting it are both wrong.
  function bestOf(type) {
    let best = null;
    for (const e of computeAll()) {
      if (e.bonus_type !== type || e.dice) continue;
      if (!e.amount) continue;
      if (!best || e.amount > best.amount) {
        best = { amount: e.amount, from: e.soulmeld,
                 conditional: !!e.condition, condition: e.condition || null };
      }
    }
    return best;
  }

  function getBestSpellResistance() { return bestOf('spell_resistance'); }
  function getBestMissChance() { return bestOf('miss_chance'); }

  // ---- the sheet's own typed aggregators ----------------------------------
  //
  // These exist because the rows are canonical: the same helpers that fold in
  // race, template, feat and trait bonuses take these unchanged. Each returns
  // the exact shape its caller already consumes from every other source.

  function getActiveSaveBonuses() {
    return (typeof DND35 !== 'undefined' && DND35.categorizeSaveBonuses)
      ? DND35.categorizeSaveBonuses(flatRows())
      : { direct: { fort: [], ref: [], will: [] }, situational: [] };
  }

  function getActiveInitiativeBonuses() {
    return (typeof DND35 !== 'undefined' && DND35.categorizeInitiativeBonuses)
      ? DND35.categorizeInitiativeBonuses(flatRows())
      : { direct: [], situational: [] };
  }

  function getActiveSkillBonuses() {
    return (typeof DND35 !== 'undefined' && DND35.categorizeSkillBonuses)
      ? DND35.categorizeSkillBonuses(flatRows())
      : { direct: {}, global: 0, situational: [] };
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
      if (e.bonus_type !== 'attack' && e.bonus_type !== 'damage') continue;
      if (e.dice) continue;                 // dice riders are not a flat mod
      const scope = e.applies_to || 'all';
      let applies;
      if (scope === 'all') applies = true;
      else if (scope === 'natural') applies = isNatural;
      else if (scope === 'manufactured') applies = isManufactured;
      // "bite" is a specific natural attack the sheet cannot identify from the
      // style alone, so it is NOT applied automatically — it would be wrong on
      // every claw. It shows in the readout and the player adds it by hand.
      else if (scope === 'bite') applies = false;
      if (!applies) continue;
      if (e.bonus_type === 'attack') attack += e.amount; else damage += e.amount;
      sources.push(e);
    }
    return { attack, damage, sources };
  }

  // ---- UI -----------------------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function rowHtml(r) {
    r = r || {};
    const sc = r.scaling || {};
    const per = typeof sc.step === 'number' ? sc.step : '';
    const opt = (list, sel) => list.map(([v, label]) =>
      `<option value="${v}"${v === sel ? ' selected' : ''}>${esc(label)}</option>`).join('');
    return `<div class="sme-row">` +
      `<select class="sme-when" title="A bound effect only applies while this slot's chakra bind is ticked, and only in the chakra it belongs to — a soulmeld can bind to several with a different effect in each.">` +
        `<option value="shaped"${r.when !== 'bound' ? ' selected' : ''}>shaped</option>` +
        `<option value="bound"${r.when === 'bound' ? ' selected' : ''}>bound</option></select>` +
      `<input type="text" class="sme-chakra" placeholder="chakra" title="Which chakra bind this row comes from. Only meaningful on a bound row." value="${esc(r.chakra)}">` +
      `<input type="number" class="sme-amount" placeholder="0" title="Flat amount that applies regardless of essentia." value="${r.amount != null ? r.amount : ''}">` +
      `<span class="sme-plus">+</span>` +
      `<input type="number" class="sme-per" placeholder="0" title="Amount added per point of essentia invested in this soulmeld." value="${per}">` +
      `<span class="sme-per-label">/ess</span>` +
      `<select class="sme-type">${opt(TYPES.map(t => [t[0], t[1]]), r.bonus_type || 'damage')}</select>` +
      `<input type="text" class="sme-spec" placeholder="which" title="The specific one, where it matters: a skill name, Fortitude/Reflex/Will, or an energy type." value="${esc(r.target)}">` +
      `<select class="sme-applies" title="Which attacks this touches. Bite is never applied automatically — the sheet cannot tell a bite from a claw, and guessing would be wrong on every claw.">${opt(APPLIES, r.applies_to || 'all')}</select>` +
      `<input type="text" class="sme-cond" placeholder="condition" title="A condition makes this situational: it is shown as a note rather than added to a total." value="${esc(r.condition)}">` +
      `<button type="button" class="sme-remove" title="Remove">&times;</button>` +
      `</div>`;
  }

  // The effects live inside the soulmeld's existing ⓘ panel, under the prose
  // they are a structured restatement of — so the book text and the numbers
  // derived from it sit together.
  function ensureBlock(panel, key) {
    let block = panel.querySelector('.sme-block');
    if (block) return block;
    block = document.createElement('div');
    block.className = 'sme-block';
    block.dataset.key = key;
    block.innerHTML =
      `<div class="sme-head">Effects <span class="sme-sub">— from the book, scaled by the essentia invested here</span></div>` +
      `<div class="sme-rows"></div>` +
      `<button type="button" class="sme-add">+ effect</button>` +
      `<button type="button" class="sme-reset" title="Discard your edits for this slot and go back to the effects as the book states them.">reset to book</button>` +
      `<div class="sme-suggest-note"></div>` +
      `<div class="sme-readout"></div>`;
    panel.appendChild(block);
    syncRendered(block, key);
    return block;
  }

  function renderRows(block, key) {
    const holder = block.querySelector('.sme-rows');
    holder.innerHTML = '';
    for (const r of rowsFor(key)) {
      holder.insertAdjacentHTML('beforeend', rowHtml(r));
    }
  }

  // Keep an unedited block showing the CURRENT soulmeld's book rows. Blocks are
  // built once, when the ⓘ panel is first laid out — which for most slots is at
  // load, while they are still empty. Without this the rows a slot gained by
  // being filled afterwards would never appear, and the panel would show
  // nothing while the numbers quietly worked (which is exactly what it did).
  //
  // An EDITED block is left alone: its DOM is the source of the player's rows,
  // and re-rendering under them would eat a keystroke or a half-open select.
  function syncRendered(block, key) {
    const sm = find(key);
    if (isEdited(key, sm)) { block.dataset.renderedFor = '(edited)'; return; }
    const want = sm ? sm.name : '';
    if (block.dataset.renderedFor === want) return;
    block.dataset.renderedFor = want;
    renderRows(block, key);
  }

  function readBlock(block) {
    return Array.from(block.querySelectorAll('.sme-row')).map((r) => {
      const per = r.querySelector('.sme-per').value;
      const amt = r.querySelector('.sme-amount').value;
      const row = {
        bonus_type: r.querySelector('.sme-type').value,
        target: r.querySelector('.sme-spec').value.trim() || null,
        amount: String(amt).trim() === '' ? null : numOf(amt),
        bonus_category: 'untyped',
        condition: r.querySelector('.sme-cond').value.trim() || null,
        when: r.querySelector('.sme-when').value,
        applies_to: r.querySelector('.sme-applies').value,
      };
      const chakra = r.querySelector('.sme-chakra').value.trim();
      if (chakra) row.chakra = chakra;
      if (String(per).trim() !== '') {
        row.scaling = { kind: 'per_essentia', step: numOf(per) };
      }
      return row;
    }).filter(r => r.amount || (r.scaling && r.scaling.step));
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
    const parts = mine.map((e) => {
      const t = LABEL[e.bonus_type] || e.bonus_type;
      const which = e.target ? ` ${e.target}` : '';
      const scope = (!e.applies_to || e.applies_to === 'all') ? ''
        : ` (${(APPLIES.find(a => a[0] === e.applies_to) || [, ''])[1]})`;
      const tag = e.routed ? '' : ' [display only]';
      const val = e.dice ? e.dice
        : `${e.amount >= 0 ? '+' : ''}${e.amount}`;
      const cond = e.condition ? ' *' : '';
      return `${val} ${t}${which}${scope}${cond}${tag}`;
    });
    let text = parts.length
      ? `${sm.essentia} essentia → ${parts.join(', ')}`
      : `${sm.essentia} essentia → no effect rows`;
    if (mine.some(e => e.condition)) text += '   (* conditional — shown as a note, not added)';
    const storedName = nameFor(key);
    if (storedName && storedName !== sm.name) {
      text += ` ⚠ your edits here were written for ${storedName}; showing ${sm.name}'s book effects instead`;
    } else if (isEdited(key, sm)) {
      text += '   (edited — "reset to book" restores the printed effects)';
    }
    out.textContent = text;
  }

  function refreshAll() {
    document.querySelectorAll('.sme-block').forEach((block) => {
      syncRendered(block, block.dataset.key);
      refreshReadout(block, block.dataset.key, find(block.dataset.key));
    });
    // Energy resistance and DR live in DefenseRiders rather than in a total
    // here, so they are pushed rather than pulled. Guarded against no-change
    // passes inside syncDefenseRiders.
    syncDefenseRiders();
  }

  // One delegated handler on the grid, matching how the ⓘ panels themselves
  // are wired. Rooted at the GRID because the blocks are created lazily when a
  // panel is first opened — binding per block would miss every one made later.
  function build() {
    const grid = byId('magic-items-grid');
    if (!grid || grid.dataset.smeWired) return;
    grid.dataset.smeWired = '1';
    grid.addEventListener('click', (ev) => {
      const add = ev.target.closest('.sme-add');
      if (add) {
        const block = add.closest('.sme-block');
        // Adding to an unedited slot must start from the book's rows, not from
        // nothing — otherwise the first hand-added row silently discards them.
        if (!isEdited(block.dataset.key, find(block.dataset.key))) {
          renderRows(block, block.dataset.key);
        }
        block.querySelector('.sme-rows').insertAdjacentHTML('beforeend', rowHtml({}));
        syncBlock(block); recalc(); return;
      }
      const reset = ev.target.closest('.sme-reset');
      if (reset) {
        const block = reset.closest('.sme-block');
        delete store[block.dataset.key];
        delete block.dataset.renderedFor;
        syncRendered(block, block.dataset.key);
        refreshReadout(block, block.dataset.key, find(block.dataset.key));
        recalc(); return;
      }
      const rm = ev.target.closest('.sme-remove');
      if (rm) {
        const block = rm.closest('.sme-block');
        rm.closest('.sme-row').remove();
        syncBlock(block); recalc(); return;
      }
      // A ⓘ toggle may have just revealed a panel that has no block yet.
      if (ev.target.closest('.btn-sm-info')) { setTimeout(attachBlocks, 0); return; }
      // Anything else in the grid — an essentia pip, a bind box, a slot's
      // soulmeld name — can change what these blocks should say. The readouts
      // used to refresh only when a panel was toggled, so an OPEN panel sat
      // showing the essentia count it had when you opened it.
      setTimeout(refreshAll, 0);
    });
    const onEdit = (ev) => {
      const block = ev.target.closest('.sme-block');
      if (block) { syncBlock(block); recalc(); return; }
      setTimeout(refreshAll, 0);   // a name/capacity field outside the block
    };
    grid.addEventListener('input', onEdit);
    grid.addEventListener('change', onEdit);
    attachBlocks();
  }

  // Give every open ⓘ panel its effects block. Panels are built by
  // equipment.js and revealed on demand, so this is called after a toggle and
  // after a load.
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

  // Only PLAYER EDITS are saved. The book's own rows are re-read from the DB
  // every load, so a correction to the data reaches every character instead of
  // being frozen into each saved blob at the moment it was first shaped.
  function collectData() {
    const out = {};
    for (const [k, v] of Object.entries(store)) {
      if (v && Array.isArray(v.rows)) out[k] = v;
    }
    return { _soulmeld_effects: out };
  }

  function loadData(data) {
    const saved = (data && data._soulmeld_effects);
    store = (saved && typeof saved === 'object') ? JSON.parse(JSON.stringify(saved)) : {};
    lastRiderSig = null;      // a different character: re-push, do not trust the cache
    // Blocks are rebuilt from the store, so drop any that equipment.js has
    // already re-rendered with stale contents.
    document.querySelectorAll('.sme-block').forEach(b => b.remove());
    build();
    attachBlocks();
  }

  return {
    build, attachBlocks, refreshAll,
    shaped, computeAll, unrouted, flatRows,
    getWeaponMods,
    getActiveACBonuses, getActiveSaveBonuses, getActiveInitiativeBonuses,
    getActiveSkillBonuses,
    getDefenseRiderSpec, syncDefenseRiders,
    getBestSpellResistance, getBestMissChance,
    dbRowsFor,
    collectData, loadData,
    TYPES, APPLIES,
  };
})();
