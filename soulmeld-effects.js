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
  let grantIndex = null;

  function loadDbRows() {
    if (dbIndex) return dbIndex;
    dbIndex = new Map();
    grantIndex = new Map();
    try {
      if (typeof DB === 'undefined' || !DB.isLoaded || !DB.isLoaded()) {
        dbIndex = null;              // not ready yet — retry on the next call
        grantIndex = null;
        return new Map();
      }
      const rows = DB.query(
        "SELECT name, json_extract(data, '$.bonuses') AS bonuses, "
        + "json_extract(data, '$.granted_effects') AS granted "
        + "FROM entry WHERE type = 'soulmeld' "
        + "AND (json_extract(data, '$.bonuses') IS NOT NULL "
        + "     OR json_extract(data, '$.granted_effects') IS NOT NULL)");
      for (const r of rows) {
        const key = String(r.name || '').toLowerCase();
        let parsed = [];
        try { parsed = JSON.parse(r.bonuses) || []; }
        catch (e) { parsed = []; }   // malformed row — treat as no effects
        if (Array.isArray(parsed) && parsed.length && !dbIndex.has(key)) {
          dbIndex.set(key, parsed);
        }
        let grants = [];
        try { grants = JSON.parse(r.granted) || []; }
        catch (e) { grants = []; }
        if (Array.isArray(grants) && grants.length && !grantIndex.has(key)) {
          grantIndex.set(key, grants);
        }
      }
    } catch (e) {
      dbIndex = null;
      grantIndex = null;
      return new Map();
    }
    return dbIndex;
  }

  function dbRowsFor(name) {
    const idx = loadDbRows();
    return idx.get(String(name || '').toLowerCase()) || [];
  }

  // The soulmeld's NON-numeric effects, straight from the DB. Unlike the bonus
  // rows these are never player-edited: they are prose plus structure, and
  // there is no small form that would let someone usefully retype a breath
  // weapon. A correction in the DB therefore always reaches every character.
  function dbGrantsFor(name) {
    loadDbRows();
    const idx = grantIndex || new Map();
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
    // A body slot's soulmeld SWITCH is what makes it shaped, not the presence
    // of a name. Switching it off hides the sub-area but deliberately does NOT
    // clear the name or the pips (so you can toggle a meld off and back on
    // without retyping it) — and gating on the name alone meant a switched-off
    // soulmeld kept applying its effects. Caught by the live bus: the sheet's
    // own counters read 0 shaped while this module still granted cold
    // resistance 10. The totem slot has no such switch, so its own name is the
    // gate there.
    const slotEl = nameEl.closest && nameEl.closest('.magic-item-slot[data-slot-id]');
    if (slotEl) {
      const sw = slotEl.querySelector('.slot-soulmeld-check');
      if (sw && !sw.checked) return;
    }
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
  // Is this row/grant in force for this shaped soulmeld right now? Shared by
  // the bonus rows and the granted abilities deliberately: they are gated on
  // exactly the same thing, and two copies of this would drift the moment one
  // of them learned something the other did not.
  function inForce(item, sm, valid) {
    if (!item) return false;
    if (item.when !== 'bound') return true;
    if (!sm.bound) return false;
    const want = String(item.chakra || '').toLowerCase();
    return !(want && valid.length && valid.indexOf(want) === -1);
  }

  function computeAll() {
    const out = [];
    for (const sm of shaped()) {
      const valid = chakrasForSlot(sm.slot).map(c => String(c).toLowerCase());
      for (const row of rowsFor(sm.key, sm)) {
        if (!row || !row.bonus_type) continue;
        if (!inForce(row, sm, valid)) continue;
        const r = resolve(row, sm);
        if (!r.amount && !r.dice) continue;
        out.push(r);
      }
    }
    return out;
  }

  // ---- granted abilities: the half of a soulmeld that is not a number ------
  //
  // Roughly half of every soulmeld's printed text grants an ABILITY rather
  // than a bonus — a bite attack, a breath weapon, flight, incorporeality.
  // The DB now carries all 202 of them as `granted_effects`, each tagged
  // with the bind it comes from and, where the sheet can do something with it,
  // a structured payload (see the sibling project's _soulmeld_granted_data.py).
  //
  // Gated identically to the bonus rows, which is the point: a Throat bind's
  // breath weapon must not appear on a character bound at the totem.

  function grantedEffects() {
    const out = [];
    for (const sm of shaped()) {
      const valid = chakrasForSlot(sm.slot).map(c => String(c).toLowerCase());
      for (const g of dbGrantsFor(sm.name)) {
        if (!inForce(g, sm, valid)) continue;
        out.push(Object.assign({}, g, {
          soulmeld: sm.name, slot: sm.slot, slotKey: sm.key,
          essentia: sm.essentia,
        }));
      }
    }
    return out;
  }

  function grantedOfKind(kind) {
    return grantedEffects().filter(g => g.kind === kind);
  }

  function charSize() {
    const el = byId('char-size');
    return (el && el.value || 'Medium').trim();
  }

  // "1d4" × N  ->  "Nd4". Used for a per-essentia damage ramp and for riders.
  function scaleDice(dice, times) {
    const m = /^(\d+)d(\d+)$/.exec(String(dice || ''));
    if (!m || !times) return null;
    return `${parseInt(m[1], 10) * times}d${m[2]}`;
  }

  // A granted attack, resolved against the live character: its size band
  // picked, its per-essentia damage scaled, and its fighting style chosen so
  // the sheet's OWN Strength and Power Attack rules apply rather than a second
  // set written here.
  //
  // Natural attacks get a natural style, so damage-calc.js supplies the
  // Strength multiplier (×1 primary, ×½ secondary) and Power Attack per RAW.
  // Everything else — touch attacks, rays, the spike volley, the trample —
  // gets style `none` plus an EXPLICIT ability term, because those do not
  // follow the natural-weapon rules and inheriting them would be wrong. A
  // trample's 1½ Strength is printed in its own text, not derived from a grip.
  // Every attack_modifier in force. Split by reach: `own` ones improve a named
  // attack of the SAME soulmeld and are matched by (slot, name); the rest are
  // scopes over the character's whole attack list, which is how the book words
  // them — Dread Carapace doubles the threat range of "all natural attacks",
  // whatever granted them.
  function activeModifiers() {
    return grantedOfKind('attack_modifier')
      .map(g => Object.assign({}, g.modifier, {
        soulmeld: g.soulmeld, slotKey: g.slotKey,
      }));
  }

  // Which modifiers apply to one granted attack.
  // Does a scope cover a weapon being wielded THIS way? One function, used for
  // both granted attacks and the player's own rows, because a modifier that
  // says "all natural attacks" means the character's whole attack list and
  // must not mean something narrower depending on which caller asked.
  // A MONK'S unarmed strike is BOTH, and the class feature says so in as many
  // words: "A monk's unarmed strike is treated both as a manufactured weapon
  // and a natural weapon." So on a monk, an unarmed row matches the
  // `manufactured` AND `natural` scopes as well as `unarmed` — Mauling
  // Gauntlets doubles its threat range, Dread Carapace doubles it too, and
  // neither is a bug. On anyone else an unarmed strike is neither.
  //
  // Checked against the character rather than assumed, so a non-monk's fists
  // do not quietly inherit weapon effects.
  function unarmedIsAlsoWeaponAndNatural() {
    try {
      return typeof ClassPicker !== 'undefined' && ClassPicker.getClassLevel
        && ClassPicker.getClassLevel('Monk') > 0;
    } catch (e) { return false; }
  }

  function scopeCoversStyle(scope, style) {
    const s = String(style || '');
    if (scope === 'all') return true;
    const monkFists = s === 'unarmed' && unarmedIsAlsoWeaponAndNatural();
    if (scope === 'natural') return s.indexOf('natural') === 0 || monkFists;
    if (scope === 'unarmed') return s === 'unarmed';
    if (scope === 'manufactured') {
      if (monkFists) return true;
      return s !== 'unarmed' && s.indexOf('natural') !== 0 && s !== 'none';
    }
    return false;                                  // 'own' is never style-based
  }

  function modifiersFor(g) {
    const a = (g && g.attack) || {};
    const style = a.attack_kind === 'natural' ? 'natural' : 'none';
    return activeModifiers().filter((m) => {
      if (m.scope === 'own') {
        return m.slotKey === g.slotKey && m.modifies_attack === a.name;
      }
      return scopeCoversStyle(m.scope, style);
    });
  }

  // The modifiers that apply to ANY attack row, chosen by how the weapon is
  // being wielded. This is what lets Mauling Gauntlets' "any melee weapon
  // wielded" and Dread Carapace's "all natural attacks" reach the player's own
  // rows rather than only the ones a soulmeld granted — those scopes existed
  // for a day and covered nothing, because the only consumer was the granted
  // attacks and none of those is manufactured.
  //
  // `own`-scope modifiers are excluded by construction: they name an attack a
  // specific soulmeld grants, and the player's rows are not that.
  function getAttackRowModifiers(style) {
    return activeModifiers().filter(
      m => m.scope !== 'own' && scopeCoversStyle(m.scope, style));
  }

  // Does an attack row's name name this attack form? Word-start matching, so
  // "Claw" finds "Claw", "Claw (racial)", "Left Claw" and "Claw (Kruthik
  // Claws)" but not "Clawfoot Lance".
  //
  // Deliberately NOT a constructed RegExp. Building one from data means
  // escaping the pattern, and writing that escape through a scripted edit is
  // how this file ended up with a broken character class a moment ago — the
  // rule in CLAUDE.md about escapes surviving three layers, arriving as a bug
  // I could see. Plain string work has no such layer.
  function attackNameMatches(rowName, formName) {
    const hay = String(rowName || '').toLowerCase();
    const need = String(formName || '').toLowerCase().trim();
    if (!hay || !need) return false;
    let from = 0;
    for (;;) {
      const at = hay.indexOf(need, from);
      if (at === -1) return false;
      const before = at === 0 ? ' ' : hay[at - 1];
      if (!/[a-z0-9]/.test(before)) return true;      // starts a word
      from = at + 1;
    }
  }

  // Riders a soulmeld puts ON an attack the character already has, resolved
  // against that attack's own dice and the character's Strength.
  //
  // Girallon's rend is the case: it takes no attack roll, it fires because two
  // claws already hit, and it has no attack line of its own — so it is a rider
  // on the claw, not an attack beside it. `separate_instance` records the one
  // thing that distinguishes it from an ordinary rider: its damage is a
  // distinct instance rather than being bundled into the claw's, which is what
  // matters when damage reduction is applied.
  //
  // Every one of these carries a CONDITION, so nothing here is ever summed
  // into a weapon's headline damage — they are listed beside it, which is
  // already how damage-calc.js treats a conditional rider.
  // `flatParts` carries the ridden row's own flat damage components, split
  // out rather than pre-summed, because they are NOT all treated alike —
  // see the "double claw damage" comment below. Optional: an older caller
  // that omits it gets the previous dice-and-Strength behaviour.
  function getAttackRowRiders(style, weaponName, dice, strMod, flatParts) {
    const name = String(weaponName || '').toLowerCase();
    const fp = flatParts || {};
    const out = [];
    for (const g of grantedOfKind('attack_rider')) {
      const r = g.attack_rider || {};
      if (!scopeCoversStyle(r.scope, style)) continue;
      // `modifies_attack` narrows it further: the rend rides CLAWS, not every
      // natural weapon the character owns.
      if (r.modifies_attack && !attackNameMatches(name, r.modifies_attack)) {
        continue;
      }
      const mult = r.multiplier || 1;
      let amount = '';
      if (r.dice_as === 'self' && dice) {
        amount = scaleDice(dice, mult) || dice;
      } else if (r.dice) {
        amount = r.dice;
      }

      // "DOUBLE CLAW DAMAGE" means the claw's damage, not just its die
      // (report rmt4iutrr-44if). A +2 claw deals 1d4+2 before Strength, so
      // the rend deals 2d4+4 — and until now it dealt 2d4, because only the
      // die was scaled and every flat component of the ridden row was
      // dropped on the floor.
      //
      // What rides, and why each:
      //   enh   enhancement bonus — part of what the claw deals, every swing
      //   spec  Weapon Specialization — likewise, a flat damage bonus
      //   meld  a soulmeld's own damage bonus to the claw
      //   misc  the player's "Other" box; they have said the claw deals it
      //
      // What does NOT ride:
      //   Strength — handled just below at the rider's OWN multiplier, on
      //     purpose. "Including double your Strength bonus" means the
      //     character's full bonus doubled, not double whatever the ridden
      //     attack applied; a secondary claw adds half Strength and the rend
      //     still doubles the full amount.
      //   Power Attack — a choice made when you swing, and the rend takes no
      //     attack roll of its own. Excluding it is a rules JUDGEMENT rather
      //     than a reading, and it is flagged as such: if the table rules the
      //     other way, add `pa` to the sum below and nothing else changes.
      const ridable = (fp.enh || 0) + (fp.spec || 0) + (fp.meld || 0)
                    + (fp.misc || 0);
      let bonus = Math.floor(ridable * mult);

      // "including double your Strength bonus" — the character's Strength, at
      // the rider's own multiplier, NOT double whatever the ridden attack
      // happened to apply (a secondary claw adds half Strength, and the rend
      // still doubles the full bonus).
      if (r.ability_multiplier && typeof strMod === 'number' && strMod) {
        bonus += Math.floor(strMod * r.ability_multiplier);
      }
      // One combined term, so the readout says "2d4+12" rather than
      // "2d4+4+8" — the player is reading this mid-combat.
      if (bonus) amount += (bonus > 0 ? '+' : '') + bonus;
      if (!amount) continue;
      out.push({
        amount,
        label: r.label || '',
        damageType: r.damage_type || '',
        condition: r.condition || '',
        separateInstance: !!r.separate_instance,
        note: r.note || '',
        from: g.soulmeld,
      });
    }
    return out;
  }

  // Rules that attach to an attack but carry no number — Worg Pelt's free trip
  // on a bite hit, Sphinx Claws' full natural attack at the end of a charge.
  // Matched exactly like riders, and shown at the row rather than left in a
  // panel the player would have to go looking for mid-combat.
  function getAttackRowNotes(style, weaponName) {
    const name = String(weaponName || '').toLowerCase();
    const out = [];
    for (const g of grantedOfKind('attack_note')) {
      const n = g.attack_note || {};
      if (!scopeCoversStyle(n.scope, style)) continue;
      if (n.modifies_attack && !attackNameMatches(name, n.modifies_attack)) {
        continue;
      }
      out.push({ text: n.text, from: g.soulmeld });
    }
    return out;
  }

  // 3.5 doubles the SIZE of the threat range, not the multiplier: 20 becomes
  // 19-20, 19-20 becomes 17-20, 18-20 becomes 15-20. Returns null when the
  // text carries no parseable range, rather than assuming 20 — a blank
  // Critical box on someone's homebrew entry is not a promise that it crits
  // only on a natural 20.
  function doubleThreatRange(critText) {
    const t = String(critText || '').trim();
    if (!t) return null;
    const m = /^(\d+)\s*[-–]\s*(\d+)/.exec(t) || /^(\d+)/.exec(t);
    if (!m) return null;
    const low = parseInt(m[1], 10);
    const high = m[2] ? parseInt(m[2], 10) : low;
    if (!(high === 20 && low >= 2 && low <= 20)) return null;
    const size = 20 - low + 1;
    const newLow = 21 - size * 2;
    if (newLow < 2) return null;                   // past a legal threat range
    return `${newLow}-20`;
  }

  // A NON-soulmeld attack row that matches a referenced attack name — a racial
  // claw, a hand-typed bite, another book's natural weapon. Word-boundary
  // matched so "Claw" finds "Claw (racial)" and "Left claw" but not "Clawfoot
  // Raptor Lance". Rows this module manages are skipped so a granted attack
  // can never resolve against itself.
  //
  // Reads the damage row's dice where there is one, and otherwise the LEADING
  // dice of the free-text damage box, because a player who never opened the
  // equation still typed "1d6+4" and that 1d6 is the number the rule wants.
  function findPlayerAttack(name) {
    const container = byId('attacks-container');
    if (!container || !name) return null;
    const want = new RegExp(`\\b${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    for (const row of container.querySelectorAll('.attack-entry')) {
      const key = row.dataset.fromClass || '';
      if (key.indexOf(ATTACK_PREFIX) === 0) continue;      // ours, not theirs
      const rowName = (row.querySelector('.atk-name') || {}).value || '';
      if (!want.test(rowName)) continue;
      const styleEl = row.querySelector('.dmg-style');
      const style = styleEl ? styleEl.value : '';
      // A claw is a natural weapon. A row named "claw" set to two-handed is
      // the player describing something else, and doubling it would be wrong.
      if (style && style.indexOf('natural') !== 0) continue;
      let dice = (row.querySelector('.dmg-dice') || {}).value || '';
      if (!dice) {
        const free = (row.querySelector('.atk-damage') || {}).value || '';
        const m = /(\d+d\d+)/.exec(free);
        dice = m ? m[1] : '';
      }
      if (dice) return { name: rowName.trim(), dice };
    }
    return null;
  }

  function resolveAttack(g, depth) {
    const a = (g && g.attack) || {};
    // `damage_as` resolves one attack from another, so a cycle in the data
    // would spin forever. Bounded rather than trusted.
    depth = depth || 0;
    let dice = a.dice || null;
    let diceNote = null;
    if (!dice && a.dice_by_size) {
      dice = a.dice_by_size[charSize()] || null;
      if (!dice) {
        // The book gives bands for some sizes only (Gorgon Mask prints Small
        // and Medium and says larger or smaller "scales accordingly"). Say so
        // rather than silently picking one.
        diceNote = `the book states damage for ${Object.keys(a.dice_by_size)
          .join(' / ')} — scale from the nearest for ${charSize()}`;
      }
    }
    if (!dice && a.dice_per_essentia) {
      dice = scaleDice(a.dice_per_essentia, g.essentia);
      if (!dice) diceNote = `${a.dice_per_essentia} per point of essentia — `
        + 'no essentia invested, so it deals nothing yet';
    }

    // ---- improvements ------------------------------------------------------
    //
    // A bind that IMPROVES an attack rather than granting one. These were
    // carried as inert tags for a day: the panel said "claw damage improves one
    // die step" and the row kept its old die, which is worse than not saying it.
    const mods = modifiersFor(g);
    const modNotes = [];
    let threatRange = null;
    for (const m of mods) {
      const steps = (m.damage_step || 0) + (m.size_step || 0);
      if (steps && dice) {
        const out = DND35.stepWeaponDamage(dice, steps);
        if (out.stepped) {
          modNotes.push(`${dice} → ${out.dice} (${m.soulmeld})`);
          dice = out.dice;
        } else {
          // The chain does not cover this die. Say so rather than leaving the
          // player to wonder whether the improvement applied.
          modNotes.push(`${m.soulmeld} improves this damage a step, but the `
            + `progression does not cover ${dice} — apply it by hand`);
        }
      }
      if (m.threat_range_double) {
        // 3.5 doubles the THREAT RANGE, not the crit multiplier: 20 → 19-20,
        // 19-20 → 17-20. Computed off the row's current crit range so a weapon
        // that already threatens on 19 is handled, and these explicitly do NOT
        // stack with each other or with keen / Improved Critical.
        threatRange = threatRange || { from: m.soulmeld,
                                       no_stack_with: m.no_stack_with || null };
      }
      if (m.note) modNotes.push(m.note);
    }

    // Damage BY REFERENCE — Girallon's rend deals "double claw damage,
    // including double your Strength bonus", and Dragon Tail's sweep deals
    // whatever the tail currently deals. Resolving it by reference rather than
    // as a literal 2d4 is what makes the rend follow the claw when the claw is
    // itself improved a die step, which is what the book's wording requires.
    if (!dice && a.damage_as) {
      // Search ACROSS slots, not just this one. Girallon Arms grants its claws
      // from the TOTEM bind and its rend from the ARMS bind, so a same-slot
      // lookup finds nothing and the rend reports itself ungranted — which is
      // exactly what it did. The book is explicit that the claws may come from
      // "your girallon arms, a different soulmeld, your own innate abilities,
      // or some other source", so the nearest match wins: same slot first,
      // then the same soulmeld in another slot, then any granted attack of
      // that name.
      const named = grantedOfKind('attack')
        .filter(o => (o.attack || {}).name === a.damage_as);
      const ref = named.find(o => o.slotKey === g.slotKey)
        || named.find(o => o.soulmeld === g.soulmeld)
        || named[0];
      // ...and if NO soulmeld grants one, look at the character's own attack
      // rows. This is the COMMON case, not the fallback: Girallon's rend comes
      // from the arms bind and its claws from the totem bind, and binding one
      // soulmeld to both chakras at once needs the Totemist's Totem Chakra
      // Bind at 11th level. Below that, the two claws the rend keys off are
      // normally a racial claw or another soulmeld's — which is exactly what
      // the book says: "whether these attacks come from your girallon arms, a
      // different soulmeld, your own innate abilities, or some other source".
      if (!ref) {
        const own = findPlayerAttack(a.damage_as);
        if (own && own.dice) {
          dice = a.damage_multiplier
            ? (scaleDice(own.dice, a.damage_multiplier) || own.dice)
            : own.dice;
          diceNote = `double the damage of your ${own.name}`;
        }
      }
      if (!dice && ref && depth < 3) {
        const base = resolveAttack(ref, depth + 1);
        if (base.dice) {
          dice = a.damage_multiplier
            ? (scaleDice(base.dice, a.damage_multiplier) || base.dice)
            : base.dice;
        }
      }
      if (!dice) {
        diceNote = `damage as your ${a.damage_as}`
          + (a.damage_multiplier ? `, ×${a.damage_multiplier}` : '')
          + ' — that attack is not currently granted, so there is no die to '
          + 'double';
      }
    }

    const isNatural = a.attack_kind === 'natural';
    const style = !isNatural ? 'none'
      : (a.role === 'secondary' ? 'natural-secondary' : 'natural');

    // `auto` lets the fighting style drive the multiplier, which is right
    // whenever the book's own multiplier IS the natural-weapon default — and
    // is the only way a `primary_or_secondary` attack can work at all, since
    // its multiplier follows whichever the player picks that round.
    const abilityTerms = [];
    if (a.ability) {
      const followsStyle = isNatural
        && (a.ability_mult == null || a.ability_mult === 1);
      abilityTerms.push({
        ability: a.ability.toUpperCase(),
        mult: followsStyle ? 'auto'
          : String(a.ability_mult == null ? 1 : a.ability_mult),
      });
    }

    // DamageCalc's own rider shape — {amount, label, condition}, where
    // `amount` holds dice OR a flat number. Emitting that rather than a
    // private shape is what lets these drop straight into the damage row.
    // A rider that scales with essentia and has none invested contributes
    // nothing and is dropped, rather than showing as "0d4".
    const riders = [];
    const notesFromRiders = [];
    for (const r of (a.riders || [])) {
      let amount = '';
      if (r.dice) {
        amount = r.per_essentia ? (scaleDice(r.dice, g.essentia) || '') : r.dice;
      } else if (r.amount != null) {
        const n = r.per_essentia ? r.amount * g.essentia : r.amount;
        amount = n ? String(n) : '';
      }
      if (!amount) {
        // No number at all: a poison or a rider that only has prose. It is
        // still real, so it rides along as a note rather than vanishing.
        if (r.condition || r.note) {
          notesFromRiders.push(r.condition || r.note);
        }
        continue;
      }
      // `condition` and `note` are NOT the same thing and must not be merged.
      // A rider WITH a condition is listed separately and never summed into
      // the headline damage — that is damage-calc.js's rule, and it is right:
      // Unicorn Horn's "+1d6 against undead" is not damage the gore deals.
      // But Kruthik Claws' acid rider is only annotated "with each claw
      // attack", which is descriptive, not conditional — it applies to every
      // swing. Passing that annotation as a condition made unconditional
      // damage display as situational and silently dropped it from the total.
      // The DB already draws the distinction; this keeps it.
      riders.push({
        amount,
        label: r.damage_type || '',
        condition: r.condition || '',
      });
      if (r.note) notesFromRiders.push(r.note);
    }

    const notes = notesFromRiders.concat(modNotes);
    if (a.count > 1) notes.push(`×${a.count}`);
    if (a.count_per_essentia) notes.push('one per point of essentia');
    if (a.role === 'primary_or_secondary') {
      notes.push('your choice each round: primary at full attack bonus and '
                 + 'full Strength, or secondary at -5 for half Strength');
    }
    if (a.role === 'mixed') notes.push(`${a.primary_count} primary, `
                                       + `${a.secondary_count} secondary`);
    if (a.role === 'only') notes.push('the only attack you may make that round');
    if (a.reach_bonus_ft) notes.push(`reach +${a.reach_bonus_ft} ft`);
    // Only when it did NOT resolve: with a resolved die the row already shows
    // the number, and printing "damage as your Claw" beside it reads as an
    // unresolved caveat rather than an explanation.
    if (a.damage_as && !dice) notes.push(`damage as your ${a.damage_as}`);
    if (a.damage_kind === 'ability_damage') notes.push('ability damage, not hit points');
    if (a.action) notes.push(`${a.action} action`);
    if (diceNote) notes.push(diceNote);
    if (a.note) notes.push(a.note);
    for (const om of (a.text_omits || [])) {
      notes.push(om === 'ability'
        ? 'the book states this damage with no Strength clause; the sheet '
          + 'applies the default for a natural attack'
        : `the book does not state the ${om}; the sheet assumes the default`);
    }

    const range = a.range_ft ? `${a.range_ft} ft`
      : (a.range_increment_ft ? `${a.range_increment_ft} ft increment` : '');

    if (threatRange) {
      notes.push('threat range doubled (' + threatRange.from + ')'
        + (threatRange.no_stack_with
           ? '; does not stack with ' + threatRange.no_stack_with : ''));
    }

    // A natural attack's default threat range is 20/x2; a doubling modifier
    // makes it 19-20. Written into the row's Critical box so the player sees
    // the improvement where they look for it.
    const crit = threatRange ? '19-20/x2' : '20/x2';

    return {
      key: `${g.slotKey}|${a.name}`,
      threatRange, crit,
      name: `${a.name} (${g.soulmeld})`,
      dice: dice || '',
      style, abilityTerms, riders,
      count: a.count || 1,
      attackKind: a.attack_kind,
      type: a.damage_type || '',
      range,
      notes: notes.join('; '),
      source: g.soulmeld,
      essentia: g.essentia,
    };
  }

  function grantedAttacks() {
    return grantedOfKind('attack').map(resolveAttack);
  }

  // ---- granted attacks -> real attack rows ---------------------------------
  //
  // A soulmeld that grants claws is the most common reason a totemist has an
  // attack line the sheet knows nothing about, so these become ROWS in the
  // Attacks table rather than a sentence in a panel: name, damage dice,
  // fighting style, ability terms and per-essentia riders, all filled.
  //
  // Managed exactly like the Warlock's eldritch blast row (character.js
  // #upsertClassAttack): keyed, rewritten in place as essentia moves, removed
  // when the soulmeld is unshaped or unbound — and the FIRST hand-edit hands
  // the row to the player permanently, after which nothing here touches it
  // again. That last property is what makes this safe against the 517 attack
  // rows already sitting in saved characters.
  //
  // The key is namespaced `soulmeld:` so it can never collide with a class's.
  const ATTACK_PREFIX = 'soulmeld:';
  let lastAttackSig = null;

  function syncGrantedAttacks() {
    if (typeof Character === 'undefined' || !Character.upsertClassAttack) return;
    const container = byId('attacks-container');
    if (!container) return;

    const want = grantedAttacks();
    // Cheap no-change guard: this runs on every recalc, and rebuilding rows
    // that have not moved would fight the player's cursor.
    const sig = JSON.stringify(want);
    const liveKeys = Array.from(
      container.querySelectorAll('.attack-entry[data-from-class]'))
      .map(el => el.dataset.fromClass)
      .filter(k => k.indexOf(ATTACK_PREFIX) === 0);
    const wantKeys = want.map(a => ATTACK_PREFIX + a.key);
    const sameSet = liveKeys.length === wantKeys.length
      && liveKeys.every(k => wantKeys.indexOf(k) !== -1);
    if (sig === lastAttackSig && sameSet) return;
    lastAttackSig = sig;

    // Drop the rows for soulmelds that are no longer granting them. Only rows
    // still carrying the marker — an edited one has become the player's and is
    // deliberately left behind rather than deleted out from under them.
    for (const key of liveKeys) {
      if (wantKeys.indexOf(key) === -1) Character.upsertClassAttack(key, null);
    }

    for (const a of want) {
      const key = ATTACK_PREFIX + a.key;
      const row = Character.upsertClassAttack(key, {
        name: a.name,
        damage: '',              // the equation fills it if the player opts in
        crit: a.crit,
        type: a.type,
        range: a.range,
        notes: a.notes,
        calcAbility: (a.abilityTerms[0] && a.abilityTerms[0].ability) || 'STR',
        damageCalc: {
          dice: a.dice, style: a.style,
          abilityTerms: a.abilityTerms, riders: a.riders,
          // `fill damage` ON by default here, unlike every other attack row.
          // The opt-in exists to protect hand-typed damage strings — 517 of
          // them across the saved characters — and a row the SHEET just
          // created has none to protect. Left off, a soulmeld's attack would
          // appear with an empty Damage column, which reads as broken rather
          // than as cautious. The player can untick it, and the first edit
          // hands them the row outright.
          auto: true,
        },
      });
      // Refresh the EQUATION too. upsertClassAttack only rewrites the text
      // fields, and a granted attack's dice and riders both move with essentia
      // — Kruthik Claws at three pips is 1d6 plus 3d4 acid, at one pip 1d4.
      if (row && row.dataset.fromClass === key
          && typeof DamageCalc !== 'undefined' && DamageCalc.updateRow) {
        DamageCalc.updateRow(row, {
          dice: a.dice, style: a.style,
          abilityTerms: a.abilityTerms, riders: a.riders,
        });
      }
    }

    // We have just rewritten dice and riders underneath a pass that already
    // computed those rows, so their totals are one pass stale: moving an
    // essentia pip visibly changed the acid rider from 3d4 to 4d4 while the
    // total still read the old figure until something else happened to
    // trigger a recalc. Ask for one.
    //
    // DamageCalc.recalcRow is deliberately NOT called directly here — it needs
    // the bonus-aware `getAbilityMod` context that character.js builds inside
    // its own loop, and inventing a second one would be a second answer to
    // "what is this character's Strength". A full pass costs little and uses
    // the real one.
    //
    // This cannot loop: recalcAll does not call refreshAll (nothing outside
    // this module does), and the signature guard above returns early on the
    // second visit even if something ever did.
    recalc();
  }

  // Granted feats and class abilities, deduplicated by name: two soulmelds
  // both granting Weapon Finesse is one Weapon Finesse.
  function grantedFeats() {
    const seen = new Map();
    for (const g of grantedOfKind('feat')) {
      if (!seen.has(g.feat)) seen.set(g.feat, { name: g.feat, froms: [] });
      seen.get(g.feat).froms.push(g.soulmeld);
    }
    return Array.from(seen.values());
  }

  function grantedSpecials() {
    const seen = new Map();
    for (const g of grantedOfKind('special_ability')) {
      const n = g.special_ability;
      if (!seen.has(n)) seen.set(n, { name: n, froms: [], text: g.text });
      seen.get(n).froms.push(g.soulmeld);
    }
    return Array.from(seen.values());
  }

  // ---- granted feats / class abilities -> the Feats tab -------------------
  //
  // Derived rows, exactly like bloodline.js's bonus feats: rebuilt from what
  // is shaped and bound right now, marked so feats.js's collector skips them,
  // and never persisted. Persisting would freeze a bind the player may since
  // have moved, and the row would outlive unshaping the soulmeld.
  let lastFeatSig = null;

  function syncGrantedFeats() {
    if (typeof Feats === 'undefined' || typeof Feats.addFeat !== 'function') {
      return;
    }
    const featRoot = byId('feats-container');
    const specRoot = byId('special-abilities-container');
    if (!featRoot || !specRoot) return;

    const feats = grantedFeats();
    const specials = grantedSpecials();
    const sig = JSON.stringify([feats, specials]);
    if (sig === lastFeatSig) return;
    lastFeatSig = sig;

    featRoot.querySelectorAll('.feat-row[data-from-soulmeld="1"]')
      .forEach(r => r.remove());
    specRoot.querySelectorAll('.feat-row[data-from-soulmeld="1"]')
      .forEach(r => r.remove());

    const stamp = (root, sel) => {
      const rows = root.querySelectorAll('.feat-row');
      const row = rows[rows.length - 1];
      if (!row) return;
      row.dataset.fromSoulmeld = '1';
      const ta = row.querySelector(sel);
      if (ta) ta.dataset.fromSoulmeld = '1';
    };

    for (const f of feats) {
      Feats.addFeat(f.name, {
        sourceLabel: `${f.froms.join(', ')} (soulmeld)`,
      });
      stamp(featRoot, '.feat-entry');
    }
    for (const s of specials) {
      Feats.addSpecialAbility(`${s.name} — ${s.froms.join(', ')} (soulmeld)`);
      stamp(specRoot, '.special-ability-entry');
    }
  }

  // Senses that cannot be a numeric range (low-light vision and its
  // multiplier, see invisibility, true seeing, scent). The ones that DO have a
  // range are `bonuses` rows and reach senses.js through computeAll already.
  function grantedSenses() {
    return grantedOfKind('sense').map((g) => {
      const s = g.sense || {};
      return {
        sense: s.sense,
        multiplier: s.multiplier || null,
        range_ft: s.range_ft || null,
        limited_to: s.limited_to || null,
        note: s.note || g.text,
        from: g.soulmeld,
      };
    });
  }

  // Movement modes a soulmeld grants outright — flight, a climb speed, a swim
  // speed. NOT the same thing as a speed BONUS, which is a `bonuses` row with
  // a mode; these create a mode the character does not otherwise have.
  function grantedMovement() {
    const out = [];
    for (const g of grantedOfKind('movement')) {
      for (const m of (g.movement || [])) {
        let speed = m.speed_ft || 0;
        if (m.per_essentia_ft) speed += m.per_essentia_ft * g.essentia;
        // A bind that IMPROVES a mode rather than granting one — Airstep
        // Sandals' feet bind makes its own flight PERFECT. Applied here so the
        // published maneuverability and the auto-selected dropdown both get
        // the improved value rather than the granted default.
        let maneuver = m.maneuverability || '';
        for (const mod of grantedOfKind('movement_modifier')) {
          const mm = mod.movement_modifier || {};
          if (mm.mode !== m.mode) continue;
          if (mm.maneuverability) maneuver = mm.maneuverability;
          if (mm.speed_ft) speed += mm.speed_ft;
        }
        out.push({
          mode: m.mode,
          speed,
          fractionOfLand: m.fraction_of_land || null,
          maneuverability: maneuver,
          activated: !!m.activated,
          qualifier: g.qualifier || null,
          note: m.note || '',
          from: g.soulmeld,
          text: g.text,
        });
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
  function getBestTurnResistance() { return bestOf('turn_resistance'); }

  // Everything below SUMS rather than takes the best, because each is a bonus
  // to a number the character already has rather than a defence that overlaps:
  // two sources of extra hit points give you both lots.
  // Conditional rows are kept OUT of the number and listed separately, the same
  // split the save and skill categorizers make: a bonus you only sometimes have
  // is a note, not a total.
  function sumOf(type, opts) {
    const scope = opts && opts.applies_to;
    let total = 0;
    let condAmount = 0;
    const froms = [];
    const conditional = [];
    for (const e of flatRows()) {
      if (e.bonus_type !== type || !e.amount) continue;
      if (scope && (e.applies_to || 'all') !== 'all' && e.applies_to !== scope) continue;
      const label = `${e.soulmeld} ${e.amount >= 0 ? '+' : ''}${e.amount}`;
      if (e.condition) {
        conditional.push(`${label} — ${e.condition}`);
        condAmount = Math.max(condAmount, e.amount);
        continue;
      }
      total += e.amount;
      froms.push(label);
    }
    // The best CONDITIONAL amount is reported separately so a chip can show a
    // number rather than just a count — "+3 conditional" tells you what you
    // might get; "(1 conditional)" makes you open the tooltip to find out.
    return { amount: total, froms, conditional, conditionalAmount: condAmount };
  }

  // Extra MAXIMUM hit points. Necrocarnum Vestments' are explicitly not
  // temporary hit points — dropping the essentia can leave you staggered,
  // unconscious or dead — so they belong on the maximum, not in the temp box.
  function getExtraHP() { return sumOf('hp'); }
  function getGrappleBonus() { return sumOf('grapple'); }
  function getCasterLevelBonus() { return sumOf('caster_level'); }
  function getSpellDCBonus() { return sumOf('spell_dc'); }
  function getSpellDamageBonus() { return sumOf('spell_damage'); }
  // `style` is the attack row's fighting style, so a manufactured-only crit
  // bonus (Necrocarnum Weapon) does not follow a claw.
  function getConfirmCritBonus(style) {
    const s = String(style || '');
    const scope = s.indexOf('natural') === 0 ? 'natural'
      : (s === 'unarmed' ? null : 'manufactured');
    return sumOf('confirm_critical', scope ? { applies_to: scope } : undefined);
  }

  // Speed, in the RAW shape app.js's speed loop collects from every source and
  // hands to DND35.categorizeSpeedBonuses once. The rows already carry `mode`,
  // so they arrive in that categorizer's own vocabulary.
  function getActiveSpeedBonuses() {
    const out = flatRows()
      .filter(e => e.bonus_type === 'speed' && e.amount)
      .map(e => ({ bonus_type: 'speed', mode: e.mode || 'land', amount: e.amount,
                   bonus_category: e.bonus_category, condition: e.condition,
                   source: e.source }));

    // Granted movement MODES — a flight speed, a climb speed, a swim speed.
    // These are not bonuses to an existing mode, they create one the character
    // does not otherwise have, which in this categorizer's vocabulary is a
    // `set` rather than an `amount`. Emitting them in the SAME shape means
    // they go through the same encumbrance and armor gates as a racial fly
    // instead of needing a private path.
    const land = parseInt((byId('speed-land') || {}).value, 10) || 0;
    for (const m of grantedMovement()) {
      let speed = m.speed;
      if (!speed && m.fractionOfLand) speed = Math.ceil(land * m.fractionOfLand / 5) * 5;
      if (!speed) continue;          // nothing invested yet, or no land speed
      const row = {
        bonus_type: 'speed', mode: m.mode, set: speed,
        maneuver: m.maneuverability || null,
        bonus_category: 'untyped',
        source: `${m.from} (soulmeld)`,
      };
      // An ACTIVATED mode is a move action that must begin and end on solid
      // ground — Pegasus Cloak's totem bind and Dragon Mantle's both say so.
      // That is not a standing speed, so it carries its condition and lands in
      // the categorizer's `situational` list rather than granting the mode
      // outright. A character who cannot actually hover should not have the
      // sheet quietly tell them they can.
      if (m.activated || m.qualifier) {
        const parts = [];
        if (m.activated) parts.push('a move action, beginning and ending on a '
                                    + 'solid surface');
        if (m.qualifier) parts.push(`${m.qualifier} only`);
        delete row.set;
        row.amount = speed;
        row.condition = parts.join('; ');
      }
      out.push(row);
    }
    return out;
  }

  // Ability-check bonuses that the book says ALSO cover that ability's skill
  // checks. The distinction is real and cannot be parsed: Sphinx Claws says
  // "Strength checks and Strength-based skill checks", while Mauling Gauntlets
  // says "but NOT Strength-based skill checks" — so the DB carries a
  // `includes_ability_skills` flag and this reads it rather than guessing.
  function getAbilitySkillBonuses() {
    return flatRows()
      .filter(e => e.bonus_type === 'ability_check' && e.amount
                   && e.includes_ability_skills && e.target)
      .map(e => ({ ability: e.target, amount: e.amount,
                   bonus_category: e.bonus_category, source: e.source,
                   condition: e.condition }));
  }

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
  function getWeaponMods(style, weaponName) {
    const s = String(style || '');
    const isNatural = s.indexOf('natural') === 0;
    const isManufactured = !isNatural && s !== 'unarmed';
    let attack = 0, damage = 0;
    // Enhancement is tracked apart and takes the HIGHEST, not the sum: several
    // enhancement bonuses on one attack do not stack.
    let enhAttack = 0, enhDamage = 0;
    const sources = [];
    const situational = [];

    // A BITE-scoped row SUPERSEDES its own soulmeld's natural-scoped row of the
    // same kind; it does not stack with it. Dread Carapace prints "+2 points of
    // damage with a bite OR +1 with another natural attack", and its natural
    // row means "another natural attack" — the book's own worked example is
    // "+12 bite / +6 other natural" at 5 essentia, which is 12, not 18.
    //
    // Specificity, scoped per soulmeld and per bonus_type, so one soulmeld's
    // bite row can never suppress a different soulmeld's natural row.
    const bitesFor = new Set();
    if (attackNameMatches(weaponName, 'bite')) {
      for (const e of computeAll()) {
        if (e.applies_to === 'bite' && !e.condition && !e.dice) {
          bitesFor.add(e.soulmeld + '::' + e.bonus_type);
        }
      }
    }

    for (const e of computeAll()) {
      if (e.bonus_type !== 'attack' && e.bonus_type !== 'damage') continue;
      if (e.dice) continue;                 // dice riders are not a flat mod
      // A CONDITIONAL row reaches no total. `resolve()` has always said so —
      // it sets routed:false on any row with a condition, and the readout tags
      // it "[display only]" — but this function never checked, so every
      // conditional attack/damage row was being added to every matching weapon
      // anyway. Two live examples of how wrong that is: Rageclaws' "+2 morale
      // while your hit point total is below 0" was in the character's ordinary
      // attack bonus at full health, and Bloodtalons' "+1 per essentia WITH
      // THE BLOODTALONS CLAW ATTACKS" was landing on every other natural
      // weapon the character had. Surfaced as a note instead.
      if (e.condition) { situational.push(e); continue; }
      // `applies_to_attack` narrows a row to ONE attack this soulmeld grants,
      // by name — "with the sphinx claws" means the claws the soulmeld gives
      // you, not every natural weapon you own.
      //
      // This scope used to be written as a CONDITION, which put it in an
      // impossible position: applied, it leaked onto every natural weapon;
      // skipped (once conditional rows were correctly kept out of totals), it
      // vanished. As a scope it lands exactly where it belongs. A row that
      // names an attack and finds no matching row applies to nothing, which is
      // right — the attack is not on the sheet.
      if (e.applies_to_attack
          && !attackNameMatches(weaponName, e.applies_to_attack)) {
        continue;
      }
      const scope = e.applies_to || 'all';
      if (scope === 'natural'
          && bitesFor.has(e.soulmeld + '::' + e.bonus_type)) {
        continue;                    // superseded by this soulmeld's bite row
      }
      let applies;
      if (scope === 'all') applies = true;
      else if (scope === 'natural') applies = isNatural;
      else if (scope === 'manufactured') applies = isManufactured;
      // "bite" is a specific natural attack, and the STYLE cannot identify one
      // — every natural weapon shares a style, so applying it there would be
      // wrong on every claw. It used to be dropped for that reason. The
      // weapon's NAME can identify one, and now reaches this function, so a
      // bite-scoped row lands on a row called "Bite" (or "Bite (racial)", or
      // "Dragon head bite") and on nothing else.
      //
      // Dread Carapace is the case: it gives +2 damage with a bite and +1 with
      // any other natural attack, and the +2 half reached nothing at all.
      else if (scope === 'bite') applies = isNatural && attackNameMatches(weaponName, 'bite');
      if (!applies) continue;
      // ENHANCEMENT is split out rather than folded into the untyped total.
      // It is a TYPED bonus and does not stack with another enhancement bonus
      // on the same attack — a +1 weapon and a soulmeld's +1 give +1, not +2 —
      // so it has to reach the row's own Enh term, where that rule already
      // lives, instead of being buried in a generic "Meld" number that adds.
      const enh = String(e.bonus_category || '').toLowerCase() === 'enhancement';
      if (e.bonus_type === 'attack') {
        if (enh) enhAttack = Math.max(enhAttack, e.amount); else attack += e.amount;
      } else if (enh) {
        enhDamage = Math.max(enhDamage, e.amount);
      } else {
        damage += e.amount;
      }
      sources.push(e);
    }
    return { attack, damage, enhAttack, enhDamage, sources, situational };
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

  // The granted abilities for THIS slot, under the numeric effects. Only the
  // ones actually in force: a Throat bind's breath weapon does not appear on a
  // soulmeld bound at the totem, which is the whole reason the DB carries the
  // bind each one came from.
  //
  // Each is tagged with what the sheet did with it, because "the sheet listed
  // your breath weapon" and "the sheet gave you an attack row" are different
  // promises and a player should not have to guess which they got.
  const GRANT_TAG = {
    attack: '→ attack row',
    attack_modifier: '→ improves an attack',
    feat: '→ Feats tab',
    special_ability: '→ Special Abilities',
    sense: '→ Senses',
    movement: '→ Speed',
    ability: '',
  };

  function renderGranted(block, sm) {
    let holder = block.querySelector('.sme-granted');
    if (!holder) {
      holder = document.createElement('div');
      holder.className = 'sme-granted';
      block.appendChild(holder);
    }
    if (!sm) { holder.innerHTML = ''; return; }
    const mine = grantedEffects()
      .filter(g => g.slot === sm.slot && g.soulmeld === sm.name);
    if (!mine.length) { holder.innerHTML = ''; return; }

    const items = mine.map((g) => {
      const tag = GRANT_TAG[g.kind] || '';
      const qual = g.qualifier ? ` <i>(${esc(g.qualifier)} only)</i>` : '';
      let detail = '';
      if (g.kind === 'attack') {
        const a = resolveAttack(g);
        detail = ` <b>${esc(a.dice || '—')}</b>`
          + (a.count > 1 ? ` ×${a.count}` : '');
      }
      return `<div class="sme-grant"><span class="sme-grant-text">`
        + `${esc(g.text)}${qual}${detail}</span>`
        + (tag ? `<span class="sme-grant-tag">${esc(tag)}</span>` : '')
        + `</div>`;
    }).join('');
    holder.innerHTML =
      `<div class="sme-granted-head">Granted — the parts that are not a number`
      + `</div>${items}`;
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
    renderGranted(block, sm);
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
    // Granted attacks are pushed the same way, into the Attacks table, and
    // granted feats / class abilities into the Feats tab. Both no-change
    // guarded, for the same reason: this runs on every recalc.
    syncGrantedAttacks();
    syncGrantedFeats();
  }

  // refreshAll PUSHES (readouts, defense riders, granted attacks); the totals
  // that soulmelds feed by being PULLED — AC, saves, initiative, grapple, which
  // app.js reads via getActiveACBonuses and friends — only move when something
  // calls recalcAll. Nothing did, so moving an essentia pip left AC sitting at
  // its previous value until the player happened to edit an unrelated field
  // (reported on Gorrash's wormtail belt, 2026-08-22).
  //
  // It LOOKED like it worked, which is why it survived: a soulmeld that grants
  // an ATTACK updates fine, because syncGrantedAttacks recalcs when the attack
  // signature changes. Only the melds whose whole contribution is pulled — a
  // pure natural-armour meld like the wormtail belt — went stale, so the bug
  // was invisible in exactly the tests that exercise granted attacks.
  //
  // Batched so this stays ONE recalc: refreshAll's own pushes can each ask for
  // one, and the suspend/resume counter added for the live bus coalesces them
  // rather than running a full pass per push.
  //
  // No loop: recalcAll pulls from this module but never calls refreshAll.
  function refreshAndRecalc() {
    if (typeof window.batchRecalc === 'function') {
      window.batchRecalc(() => { refreshAll(); recalc(); });
    } else {
      refreshAll(); recalc();
    }
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
      setTimeout(refreshAndRecalc, 0);
    });
    const onEdit = (ev) => {
      const block = ev.target.closest('.sme-block');
      if (block) { syncBlock(block); recalc(); return; }
      setTimeout(refreshAndRecalc, 0);   // a name/capacity field outside the block
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
    grantedEffects, grantedAttacks, grantedFeats, grantedSpecials,
    grantedSenses, grantedMovement, syncGrantedAttacks, syncGrantedFeats,
    getWeaponMods, getAttackRowModifiers, getAttackRowRiders,
    getAttackRowNotes,
    doubleThreatRange,
    getActiveACBonuses, getActiveSaveBonuses, getActiveInitiativeBonuses,
    getActiveSkillBonuses,
    getDefenseRiderSpec, syncDefenseRiders,
    getBestSpellResistance, getBestMissChance, getBestTurnResistance,
    getExtraHP, getGrappleBonus, getCasterLevelBonus, getSpellDCBonus,
    getSpellDamageBonus, getConfirmCritBonus,
    getActiveSpeedBonuses, getAbilitySkillBonuses,
    dbRowsFor, dbGrantsFor,
    collectData, loadData,
    TYPES, APPLIES,
  };
})();
