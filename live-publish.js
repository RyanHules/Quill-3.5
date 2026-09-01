// live-publish.js — publish this tab's RESOLVED character state (2026-08-20).
//
// WHY. `saves/*.json` holds raw form fields (`cha-score`, `armor-ac-bonus`,
// `bab-1`). Everything the sheet computes — final initiative, AC/touch/
// flat-footed, saves with every bonus folded in, attack routines — is derived
// here in JS at display time and has never existed on disk. Anything that
// reads the save files to learn a character's real numbers gets them WRONG.
// That is the bug the megadungeon rig hit: stale initiative, missing Strength
// from Gorrash's gauntlets, narrated mid-combat and corrected out loud.
//
// The fix is NOT to re-derive elsewhere. Two implementations of D&D 3.5 math
// diverge, guaranteed, and then we are debugging which one lied. Instead this
// tab publishes what it already computed, and consumers read that. One
// implementation, and it is the one the player is looking at.
//
// SCHEMA 2 (2026-08-20) added, at the consuming rig's request and in its stated
// priority order: resolved SKILLS (final integers — the place it was drifting
// worst, since it rolls PC social skills against NPCs), defensive RIDERS
// (damage_reduction / spell_resistance / free-text notes), and daily-pool
// CAPACITIES. Capacities only, never current values: per the field-ownership
// split the consumer tracks depletion and the sheet hands it the ceiling, so
// `.sc-used` / `.sc-remain` / `.psi-pp-spent` are deliberately not published.
// One owner per number.
//
// SCOPE — this file is the OUTBOUND half: publish only. The inbound half
// (a consumer writing volatile session state back into the sheet) lives in
// live-commands.js, kept separate because it answers a different question and
// carries a different risk: publishing cannot break a sheet, applying can.
// Its safety property is the server-side field-ownership allowlist, the way
// staleness is this half's.
//
// DESIGN NOTES
//
//   * Reads the DOM, not the model. The resolved numbers live in the display
//     elements (`#ac-total`.textContent and friends) — that is the only place
//     the fully-folded values exist, and reading them is what guarantees we
//     publish what the player SEES rather than a parallel recomputation.
//   * Wraps `window.recalcAll` rather than asking every caller to notify us.
//     class-picker and others already call it directly; wrapping catches all
//     of them and needs no edits anywhere else.
//   * Heartbeats even when nothing changes, so a consumer can distinguish
//     "idle" from "tab closed". Staleness is the whole safety property on the
//     read side — see save_server.py's _LIVE comment.
//   * Silent by design. A publish failure must never interrupt play, so
//     everything is wrapped and failures are counted, not thrown. `LivePublish
//     .status()` exposes the counters for when you need to know if it's alive.
(function () {
  'use strict';

  // 2: + skills, defensive riders (as free text), pool capacities (rig ask)
  // 3: defensive riders become STRUCTURED — resistances / immunities /
  //    vulnerabilities / fast_healing / regeneration in the DB's own shapes,
  //    plus `notes_may_contain_riders` and a parsed view of DR beside the
  //    verbatim string. Additive: every schema-2 field is still emitted.
  // 4: + `damage_structured` on each attack row — dice, fighting style with
  //    BOTH multipliers it implies, per-ability terms with their multiplier
  //    RESOLVED (never the UI's "auto"), and the folded flat total. This is the
  //    field Vaire asked for after removing his `S` substitution: the live
  //    party writes `3d6+.5*S` and `d4+.5*S`, and no consumer can recover a
  //    half-Strength secondary natural from that string. The verbatim string is
  //    still emitted and is still authoritative. Additive.
  // 5: + `incarnum` — shaped soulmelds, the essentia in each, and the RESOLVED
  //    effects that essentia is buying (rig ask 4). Essentia moves as a swift
  //    action and changes what every shaped meld does, so a consumer working
  //    from structural data alone narrates last round's character. Additive.
  // 6: + `granted` on each shaped soulmeld — the half of incarnum that is not
  //    a number: bite attacks, breath weapons, flight, granted feats, senses.
  //    198 of these were authored a day before schema 5 and stamped onto
  //    nothing, so they reached neither the DB nor this bus; the DB now carries
  //    them and an ATTACK arrives with its damage already resolved for this
  //    character at this essentia. Additive.
  // 7: + `invocations`, `special_abilities`, and `blast_riders` on an
  //    eldritch-blast attack row. A warlock was the one PC whose offense could
  //    not be read off this bus at all — the rig had to ask a human for +4d6
  //    mid-combat. These are the first LISTS published here; see the schema-7
  //    block below for why the "resolved numbers, not lists" rule had to
  //    bend for exactly this case. Additive.
  // 8: the CURRENT side of every daily pool, plus `feats`, `size`, structured
  //    `senses`, per-caster `caster_level`, and the spell repertoire.
  //
  //    ⚠ This REVERSES schema 2's "capacities only, never current values"
  //    rule, and the reason is not that a consumer asked. It is that the
  //    ownership split the rule protected had ALREADY moved and this half
  //    never caught up: live-commands.js's allowlist (its `pools.power_points
  //    .<id>.spent`, `pools.spell_slots.<id>.<lvl>.used` and `uses_per_day
  //    .rage.used` patterns) lets a consumer WRITE depletion into these very
  //    inputs. The sheet has been the store of record for those numbers since
  //    that landed. Publishing capacity only meant the rig could write a value
  //    and then had no way to read it back, so it kept a second copy — which
  //    is the two-writers collision the original rule existed to prevent,
  //    arrived at from the other direction. One owner per number still holds;
  //    the owner is just the sheet now, and an owner that will not answer
  //    queries forces everyone else to guess.
  //
  //    ⚠ NON-ADDITIVE, once, deliberately: `uses_per_day` entries were bare
  //    integers (the capacity) and are now objects. Every other schema bump
  //    here has been purely additive; this one cannot be, because the field's
  //    whole problem was that it had exactly one number and needed three.
  //    Called out rather than slipped in.
  var SCHEMA = 8;
  var DEBOUNCE_MS = 400;      // recalcAll can fire in bursts; publish the tail
  var WATCH_MS = 1500;        // change-detection poll (the reliable path)
  var HEARTBEAT_MS = 20000;   // well inside the server's 90s stale window

  var timer = null;
  var beat = null;
  var watch = null;
  var lastFingerprint = null;
  var installed = false;
  var stats = { published: 0, failed: 0, skipped: 0, lastAt: null, lastError: null };

  function $(sel) { return document.querySelector(sel); }

  // textContent for computed display elements, value for inputs. Returns null
  // rather than "" so a missing element is distinguishable from an empty one.
  function txt(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    var v = ('value' in el && el.tagName !== 'SPAN') ? el.value : el.textContent;
    if (v == null) return null;
    v = String(v).trim();
    return v === '' ? null : v;
  }

  // Numbers are published as numbers where they cleanly are one, so a consumer
  // never has to parse "+7" itself and never has to guess about a leading plus.
  function num(id) {
    var v = txt(id);
    if (v == null) return null;
    var m = /^[+-]?\d+$/.exec(v.replace(/\s+/g, ''));
    return m ? parseInt(m[0], 10) : v;
  }

  // `nonability: true` means the creature has NO score here — not a score of
  // 0, and not an unfilled field. `score` is null in that case and `mod` is 0.
  // Published because the distinction changes what a consumer may do with it:
  // a nonability is immune to ability damage and drain, and nothing raises it.
  function abilities() {
    var out = {};
    ['str', 'dex', 'con', 'int', 'wis', 'cha'].forEach(function (a) {
      var na = !!(document.getElementById(a + '-nonability') || {}).checked;
      out[a] = {
        score: na ? null : num(a + '-total'),
        mod: na ? 0 : num(a + '-mod'),
        nonability: na
      };
    });
    return out;
  }

  // `sa` is the specialAbilities() result, passed in so the DOM scan happens
  // once per snapshot rather than once per attack row.
  function attacks(sa) {
    var rows = document.querySelectorAll('.attack-entry');
    var out = [];
    Array.prototype.forEach.call(rows, function (row) {
      function f(sel) {
        var el = row.querySelector(sel);
        if (!el) return null;
        var v = ('value' in el ? el.value : el.textContent);
        v = (v == null ? '' : String(v)).trim();
        return v === '' ? null : v;
      }
      var name = f('.atk-name');
      var bonus = f('.atk-bonus');
      if (name == null && bonus == null) return;   // blank template row
      var bonusEl = row.querySelector('.atk-bonus');
      // Blast riders ride ONLY on an eldritch blast row. The key is absent on
      // every other attack rather than null, because null here would read as
      // "this dagger may have unmodelled blast riders", which is not a
      // statement about a dagger. Absence means "not a blast".
      var blast = isEldritchBlastRow(name) ? blastRidersFrom(sa) : null;
      out.push({
        name: name,
        bonus: bonus,
        damage: f('.atk-damage'),
        crit: f('.atk-crit'),
        range: f('.atk-range'),
        type: f('.atk-type'),
        notes: f('.atk-notes'),
        // true when the sheet filled the bonus itself; false means the player
        // typed it and it is NOT guaranteed to reflect current modifiers.
        auto: !!(bonusEl && bonusEl.classList.contains('atk-bonus-auto')),
        // Damage riders, structured. A rider with a `condition` is NOT part of
        // the `damage` string above — a holy weapon's 2d6 against evil is
        // damage this weapon deals sometimes, and folding it into the headline
        // figure would overstate every swing against everything else. Roll it
        // when the condition holds; the sheet is not in a position to know.
        damage_riders: damageRiders(row),
        // The structured form of `damage` above, so a consumer never has to
        // parse "3d6+.5*S". Published ALONGSIDE the string, never instead of
        // it — the string is what the player typed and stays authoritative.
        // Null when the module is absent, for the same reason damage_riders is:
        // "not modelled" and "none" must not share a representation.
        damage_structured: damageStructured(row)
      });
      if (blast) {
        var last = out[out.length - 1];
        last.blast_riders = blast;
        // NOT folded into `damage`, and explicitly flagged unresolved: the
        // sheet models no essence or shape, so this list is what it could
        // substantiate, never a complete accounting of the blast. A consumer
        // that wants the total resolves the `invocations` list against the DB.
        last.blast_riders_resolved = false;
      }
    });
    return out;
  }

  // Null rather than [] when the module is absent, for the same reason the
  // defensive riders omit their keys: "not modelled" and "none" are different
  // statements and must not share a representation.
  function damageStructured(row) {
    try {
      if (typeof DamageCalc === 'undefined' || !DamageCalc.publishRow) return null;
      return DamageCalc.publishRow(row);
    } catch (e) { return null; }
  }

  function damageRiders(row) {
    try {
      if (typeof DamageCalc === 'undefined' || !DamageCalc.readRiders) return null;
      return DamageCalc.readRiders(row);
    } catch (e) { return null; }
  }

  // --- schema 7: invocations, special abilities, blast riders ---------------
  //
  // WHY. A warlock was the one PC whose offense could not be read off this bus
  // at all (Vaire, 2026-08-22 — he had to ask a human for +4d6 mid-combat).
  //
  // The reported cause was that spellcasting publishes and invocations do not.
  // That is not what was happening: this bus publishes no spell NAME for
  // anyone. `pools.spell_slots` carries counts and DCs — `known: 4` is how
  // MANY 1st-level spells a bard knows, never which four. The rule is
  // "resolved numbers, not lists", uniformly.
  //
  // Warlocks are not an exception to that rule; they are where it bites. A
  // caster's offense degrades gracefully into numbers — you get DCs and slot
  // counts and can run them approximately. A warlock's offense IS a list.
  // Strip it and nothing is left but the base blast dice.
  //
  // So this is the first LIST this bus publishes, and it is deliberate.

  function textOf(v) {
    // specialAbilities rows are two shapes in live saves: a plain string, and
    // {text, fromClass} for class-granted ones. Both are current; neither is
    // legacy.
    if (v == null) return null;
    if (typeof v === 'string') return v.trim() || null;
    return (v.text == null ? null : String(v.text).trim()) || null;
  }

  function specialAbilities() {
    try {
      var root = document.getElementById('special-abilities-container');
      if (!root) return null;
      var out = [];
      root.querySelectorAll('.special-ability-entry').forEach(function (ta) {
        var t = (ta.value == null ? '' : String(ta.value)).trim();
        if (!t) return;
        // `data-from-class` is the DOM carrier for the save's `fromClass`.
        var fc = ta.getAttribute('data-from-class');
        out.push({ text: t, from_class: fc || null });
      });
      return out;
    } catch (e) { return null; }
  }

  function invocations() {
    try {
      var panels = document.querySelectorAll('[data-caster-type="invocations"]');
      if (!panels.length) return null;          // not an invoker at all
      var out = [];
      panels.forEach(function (p, i) {
        var id = casterIdentity(p, i);
        var grades = {};
        p.querySelectorAll('.invo-known-list').forEach(function (list) {
          var g = list.dataset.grade;
          if (!g) return;
          grades[g] = Array.from(
            list.querySelectorAll('.invo-known-row .invo-known-name'))
            .map(function (inp) { return (inp.value || '').trim(); })
            .filter(Boolean);
        });
        out.push({
          id: id.id,
          label: id.label,
          invoking_class: p.dataset.invoClass || null,
          // The warlock's "caster level" for its invocations. Published
          // because it drives grade access and every invocation's save DC,
          // neither of which the name list tells you.
          invoker_level: intOf(cell(p, '.invo-caster-level')),
          highest_grade: cell(p, '.invo-highest-grade'),
          known_count: intOf(cell(p, '.invo-known-count')),
          known: grades
        });
      });
      return out;
    } catch (e) { return null; }
  }

  // Blast riders the sheet can actually SUBSTANTIATE, and nothing else.
  //
  // The sheet does not model eldritch essences or blast shapes — the blast
  // attack row says so in its own notes ("Invocation essences/shapes not
  // applied."), and `damage_riders` comes back empty because the rider store
  // is genuinely empty, not because publishing skips it.
  //
  // So this deliberately does NOT try to resolve a total. Two reasons, and the
  // second is the one that matters: resolving needs rules the sheet has not
  // been taught (one essence and one shape per blast, which invocation is
  // which, how a Hellfire Warlock's dice interact, and above all WHICH essence
  // the player has up this round — which the sheet is not told). And a total
  // that is silently wrong is worse than no total, because it gets applied
  // mid-combat and the seam is never visible. Same principle as `stale`
  // meaning absent rather than empty: an unknown must never present as a
  // nothing.
  //
  // What IS substantiated: a class-granted special ability whose text carries
  // explicit blast dice ("[Hellfire Warlock 2] Hellfire blast +4d6"). Those
  // are read, not guessed. Named invocations are published in `invocations`
  // above for a consumer that can resolve them against the DB; they are NOT
  // listed here, because the sheet cannot tell "Hellrime Blast" (an essence)
  // from "Flee the Scene" (not a blast rider at all) without that DB.
  // The dice MUST carry an explicit sign. That one requirement is doing real
  // work, and it was found by running the first version of this regex over all
  // 400 saved characters instead of a fixture:
  //
  //   "[Hellfire Warlock 2] Hellfire blast +4d6"  -> rider     (signed)
  //   "[Warlock 9] Eldritch blast 5d6"            -> NOT a rider
  //   "Eldritch Blast (1d6)"                      -> NOT a rider
  //   "Ice Blast (2d6 cold, DC 17)"               -> NOT a rider
  //
  // The second line is the one that matters. The base blast appears in the
  // special-abilities list as a plain statement of its own dice, and the
  // unsigned version of this pattern published it as a RIDER — so a consumer
  // folding riders into `damage` would have computed 5d6 + 5d6 + 4d6 for a
  // character whose blast is 9d6. Silently wrong, mid-combat, in exactly the
  // way this whole block promises not to be.
  //
  // A rider ADDS, and the book writes it that way — FCII's class table says
  // "Hellfire blast +2d6 / +4d6 / +6d6". Requiring the sign is therefore not a
  // heuristic about text; it is the distinction between a total and an
  // addition, which is the thing being asked.
  var BLAST_DICE_RE = /\b([a-z]+\s+blast)\b[^0-9+\-]{0,20}([+-]\s*\d+d\d+)/i;

  // Takes the output of specialAbilities() — {text, from_class} rows.
  function blastRidersFrom(abilities) {
    var out = [];
    (abilities || []).forEach(function (a) {
      var t = textOf(a);
      if (!t) return;
      var m = BLAST_DICE_RE.exec(t);
      if (!m) return;
      // Belt and braces on the base blast: the sign requirement above already
      // excludes it, and this says so out loud so a later edit to the regex
      // cannot quietly re-admit the double-count.
      if (/^eldritch blast$/i.test(m[1].trim())) return;
      out.push({
        name: m[1].replace(/\s+/g, ' ').trim(),
        dice: m[2].replace(/\s+/g, ''),
        source: 'special_ability',
        // The row verbatim, so a consumer can see what was parsed and
        // disagree with the parse rather than trusting it blind.
        source_text: t,
        from_class: (a && a.from_class) || null
      });
    });
    return out;
  }

  function isEldritchBlastRow(name) {
    return /eldritch blast/i.test(name || '');
  }

  // --- schema 2 ------------------------------------------------------------
  // Added 2026-08-20 at the rig's request, in its stated priority order:
  // resolved skills, defensive riders, pool CAPACITIES.

  function cell(row, sel) {
    var el = row.querySelector(sel);
    if (!el) return null;
    var v = ('value' in el ? el.value : el.textContent);
    v = (v == null ? '' : String(v)).trim();
    return v === '' ? null : v;
  }

  function intOf(v) {
    if (v == null) return null;
    var m = /^[+-]?\d+$/.exec(String(v).replace(/\s+/g, ''));
    return m ? parseInt(m[0], 10) : null;
  }

  // Resolved skill modifiers. `.skill-total` is a calc-field — the sheet always
  // computes it — so unlike an attack bonus there is no hand-typed variant and
  // no `auto` flag is needed. Ranks/misc ride along because a consumer that
  // wants to explain a number ("+14 = 9 ranks +3 Cha +2 synergy") otherwise has
  // to re-derive it, which is the whole thing we are avoiding.
  function skills() {
    var rows = document.querySelectorAll('#skills-body-left tr, #skills-body-right tr');
    var out = [];
    Array.prototype.forEach.call(rows, function (row) {
      var name = cell(row, '.skill-name');
      if (!name) return;                       // subtype group header
      // The sheet renders "NR" instead of a number for a TRAINED-ONLY skill
      // with no ranks (skills.js: `trainedOnly && ranks === 0`). That is a
      // RULE — the character cannot attempt the check at all — not a missing
      // value, and publishing it as a bare null collapses it with "we failed
      // to read this". Same distinction as energy resistances: absent must not
      // be readable as none. `usable:false` says the skill is unrollable;
      // `total:null` with `usable:true` would mean we could not parse it.
      var rawTotal = cell(row, '.skill-total');
      var trainedOnlyNoRanks = (rawTotal === 'NR');
      out.push({
        name: name,
        ability: cell(row, '.skill-ability-col'),
        total: trainedOnlyNoRanks ? null : intOf(rawTotal),
        usable: !trainedOnlyNoRanks,
        unusable_reason: trainedOnlyNoRanks ? 'trained-only, no ranks' : null,
        ability_mod: intOf(cell(row, '.skill-ability-mod')),
        ranks: cell(row, '.skill-ranks'),
        misc: cell(row, '.skill-misc'),
        class_skill: !!(row.querySelector('.skill-class-check') || {}).checked
      });
    });
    return out;
  }

  // Incarnum: what is shaped, where, how much essentia is in it, and what that
  // is currently BUYING (rig ask 4).
  //
  // THE FAILURE THIS FIXES, in Vaire's own words: "there's a reason I've been
  // moving that essentia around", dropped gently by Ryan while the rig ran his
  // greaves wrong for two charges. Essentia moves as a swift action mid-combat
  // and changes what every shaped soulmeld does, so a consumer narrating from
  // structural data alone is narrating last round's character.
  //
  // OWNERSHIP NOTE, flagged rather than assumed. The pools block below is
  // capacity-only because current/spent values belong to whoever narrates the
  // change. Essentia is NOT that shape: it is not spent down by play, it is a
  // configuration the player re-chooses, it lives on the sheet as clickable
  // pips, and the sheet's own AC / skill / save math reads it. So the invested
  // amount is published as CURRENT state next to the capacity, and there is
  // still one writer. If the rig ever wants to move essentia itself, phase 2's
  // write API is the route and that is a decision for Vaire, not a default
  // taken here.
  //
  // `effects` is the payoff of the soulmeld work: every shaped soulmeld's
  // resolved bonuses, essentia already folded in, in the DB's canonical shape.
  // A consumer no longer has to know what Urskan Greaves does.
  // A shaped soulmeld's granted (non-numeric) abilities, structured where the
  // DB has structure for them. An ATTACK is emitted with its damage already
  // resolved against this character — size band picked, per-essentia dice
  // scaled, riders scaled — because that resolution is the whole premise of
  // the bus: the consumer reads what the sheet computed rather than
  // re-deriving 3.5 from the raw fields.
  // "auto" is a UI state, not a value. It means "follow the fighting style",
  // which is right in the DOM — a Strength term should track the grip rather
  // than be re-set by hand — but it is useless to a consumer, who would have
  // to re-implement the style table to know that a secondary natural attack
  // adds half Strength. Schema 4 made exactly this fix for `damage_structured`
  // after Vaire hit the half-Strength case; publishing "auto" here would have
  // reintroduced it one field over.
  function resolvedTerms(r) {
    var mult = 1;
    try {
      if (typeof DamageCalc !== 'undefined' && DamageCalc.styleFor) {
        mult = DamageCalc.styleFor(r.style)[2];
      }
    } catch (e) { /* fall back to x1 */ }
    return (r.abilityTerms || []).map(function (t) {
      var m = (t.mult == null || t.mult === 'auto') ? mult : parseFloat(t.mult);
      return { ability: t.ability, mult: isNaN(m) ? 1 : m };
    });
  }

  function grantedFor(s) {
    try {
      if (typeof SoulmeldEffects === 'undefined'
          || !SoulmeldEffects.grantedEffects) return [];
      return SoulmeldEffects.grantedEffects()
        .filter(function (g) {
          return g.soulmeld === s.name && g.slot === s.slot;
        })
        .map(function (g) {
          var out = {
            text: g.text, kind: g.kind,
            when: g.when || 'shaped', chakra: g.chakra || null,
            qualifier: g.qualifier || null
          };
          if (g.kind === 'attack' && SoulmeldEffects.grantedAttacks) {
            var a = g.attack || {};
            var r = null;
            SoulmeldEffects.grantedAttacks().forEach(function (x) {
              if (x.key === g.slotKey + '|' + a.name) r = x;
            });
            out.attack = {
              name: a.name, count: a.count || 1,
              attack_kind: a.attack_kind, role: a.role,
              damage_type: a.damage_type || null,
              // Resolved for THIS character at THIS essentia. `dice` is empty
              // when the attack scales purely per point and none is invested,
              // which is a real state and not a missing value.
              dice: r ? (r.dice || null) : null,
              ability_terms: r ? resolvedTerms(r) : [],
              riders: r ? r.riders : [],
              range: r ? (r.range || null) : null,
              notes: r ? (r.notes || null) : null
            };
          } else if (g.kind === 'feat') {
            out.feat = g.feat;
          } else if (g.kind === 'special_ability') {
            out.special_ability = g.special_ability;
          } else if (g.kind === 'sense') {
            out.sense = g.sense;
          } else if (g.kind === 'movement') {
            out.movement = g.movement;
          }
          return out;
        });
    } catch (e) { return []; }
  }

  function incarnum() {
    try {
      if (typeof SoulmeldEffects === 'undefined' || !SoulmeldEffects.shaped) return null;
      var shaped = SoulmeldEffects.shaped();
      if (!shaped.length) return null;
      var byKey = {};
      (SoulmeldEffects.computeAll ? SoulmeldEffects.computeAll() : []).forEach(function (e) {
        var k = e.soulmeld + '\u0000' + e.slot;
        (byKey[k] = byKey[k] || []).push({
          bonus_type: e.bonus_type, target: e.target || null,
          amount: e.amount, bonus_category: e.bonus_category || null,
          condition: e.condition || null,
          applies_to: e.applies_to || null,
          when: e.when || 'shaped', chakra: e.chakra || null,
          dice: e.dice || null,
          // False means the sheet computes and shows it but has nowhere to add
          // it — the consumer may still want to narrate it.
          reaches_a_total: !!e.routed
        });
      });
      return {
        capacity: {
          base: intOf(cell(document, '#sm-base-capacity')),
          max_soulmelds: intOf(cell(document, '#sm-max-soulmelds')),
          max_essentia: intOf(cell(document, '#sm-max-essentia')),
          max_binds: intOf(cell(document, '#sm-max-binds'))
        },
        in_use: {
          shaped: intOf(cell(document, '#sm-count-shaped')),
          essentia: intOf(cell(document, '#sm-count-essentia')),
          binds: intOf(cell(document, '#sm-count-binds'))
        },
        soulmelds: shaped.map(function (s) {
          return {
            name: s.name, slot: s.slot, bound: !!s.bound,
            essentia_invested: s.essentia,
            // The half that is NOT a number — a breath weapon, a bite attack,
            // flight, incorporeality. Schema 5 published only the numeric
            // effects, so a rig could see "3d4 on a charge" but not "you have
            // claws", which is exactly what a DM narrating a fight needs.
            // Gated the same way the effects are: a Throat bind's cone is
            // absent unless the meld is actually bound at the throat.
            granted: grantedFor(s),
            effects: byKey[s.name + '\u0000' + s.slot] || []
          };
        })
      };
    } catch (e) { return null; }
  }

  // Daily pools: capacity AND current, since schema 8. See the SCHEMA 8 note
  // at the top for why the capacity-only rule reversed — short version, the
  // sheet already owns these numbers because live-commands.js lets a consumer
  // write them here, and an owner that publishes only the ceiling forces every
  // reader to keep a shadow copy of the floor.
  //
  // `remaining` is read from the sheet's own computed field rather than
  // recomputed as max - spent. Those should agree, and when they do not the
  // sheet's is the number the player is looking at, which is this file's whole
  // premise. Falls back to the subtraction only when the display element is
  // missing (a panel shape that predates it).
  function pools() {
    var out = { power_points: [], spell_slots: [], uses_per_day: {} };

    document.querySelectorAll('[data-caster-type="psionics"]').forEach(function (p, i) {
      var maxPP = intOf(cell(p, '.psi-pp-day'));
      if (maxPP == null) return;
      var pid = casterIdentity(p, i);
      var spent = intOf(cell(p, '.psi-pp-spent'));
      var remain = intOf(cell(p, '.psi-pp-remaining'));
      if (remain == null && spent != null) remain = maxPP - spent;
      out.power_points.push({
        id: pid.id, label: pid.label, max: maxPP,
        spent: spent, current: remain,
        manifester_level: intOf(cell(p, '.psi-manifester-level'))
      });
    });

    document.querySelectorAll('[data-caster-type="spellcasting"]').forEach(function (p, i) {
      var levels = [];
      p.querySelectorAll('.spell-slots-table tbody tr').forEach(function (row) {
        var perDay = intOf(cell(row, '.sc-per-day')) || 0;
        var bonus = intOf(cell(row, '.sc-bonus')) || 0;
        var domain = intOf(cell(row, '.sc-domain-slots')) || 0;
        var spec = intOf(cell(row, '.sc-specialist-slots')) || 0;
        var extra = intOf(cell(row, '.sc-extra')) || 0;
        var total = perDay + bonus + domain + spec + extra;
        var known = intOf(cell(row, '.sc-known'));
        var dc = intOf(cell(row, '.sc-dc'));
        var used = intOf(cell(row, '.sc-used'));
        var remain = intOf(cell(row, '.sc-remain'));
        if (remain == null && used != null) remain = total - used;
        if (!total && known == null && dc == null) return;   // unused level
        var lvlEl = row.querySelector('[data-lvl]');
        levels.push({
          level: lvlEl ? intOf(lvlEl.getAttribute('data-lvl')) : null,
          known: known, dc: dc,
          per_day: perDay, bonus: bonus, domain: domain,
          specialist: spec, extra: extra,
          capacity: total,
          used: used, remaining: remain
        });
      });
      if (levels.length) {
        var cid = casterIdentity(p, i);
        out.spell_slots.push({
          id: cid.id, label: cid.label,
          // The panel's OWN caster level, including the cross-class overrides
          // class-picker writes into it (Sublime Chord, Ur-Priest and four
          // others whose CL is arithmetic over OTHER classes). Published as
          // the input's value rather than re-derived here, so a house rule or
          // a hand-typed correction ships too — same reason every other field
          // in this file reads the DOM.
          caster_level: intOf(cell(p, '.sc-caster-level')),
          levels: levels
        });
      }
    });

    // Class daily uses. Objects since schema 8 (they were bare capacities) —
    // `used` is published only where the sheet actually has an input for it,
    // which today is Rage and not Turning. A null there means "the sheet does
    // not track this", not "zero used"; inventing a 0 would read as authority.
    var rage = num('rage-per-day'), turn = num('turn-per-day');
    if (rage != null) {
      var rageUsed = num('rage-used');
      out.uses_per_day.rage = {
        max: rage, used: rageUsed,
        remaining: (typeof rage === 'number' && typeof rageUsed === 'number')
          ? rage - rageUsed : null
      };
    }
    // turn-per-day is a TEXT field ("3 + CHA mod"), so `max` here may be a
    // string. Published as-is rather than coerced — see num().
    if (turn != null) out.uses_per_day.turn_undead = { max: turn, used: null, remaining: null };

    return out;
  }

  // Feats, as a list (rig ask, 2026-09-01 — there was no feats field at all,
  // so a consumer checking "does he have Combat Reflexes" was reading a
  // hand-maintained party file).
  //
  // `.feat-entry` is the canonical value on EVERY row, structured or not: a
  // DB-matched row hides the textarea and renders a chip, but the textarea is
  // still the value everything else in feats.js reads (hasFeat, the bonus
  // aggregators). Reading the chip instead would silently drop the
  // specialization on "Weapon Focus (longsword)".
  function feats() {
    try {
      var root = document.getElementById('feats-container');
      if (!root) return null;
      var out = [];
      root.querySelectorAll('.feat-row').forEach(function (row) {
        var ta = row.querySelector('.feat-entry');
        var text = ta && ta.value != null ? String(ta.value).trim() : '';
        if (!text) return;
        // Split "Weapon Focus (longsword)" into name + specialization. Only a
        // TRAILING parenthetical, matching feats.js's own parseFeatText.
        var m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(text);
        var tag = row.querySelector('.feat-source-tag');
        out.push({
          name: m ? m[1].trim() : text,
          specialization: m ? m[2].trim() : null,
          text: text,
          // Non-null only on a DERIVED row — the class / bloodline / template
          // that granted it. Null means the player chose it.
          granted_by: tag && tag.textContent ? tag.textContent.trim() : null,
          granted_at_level: row.dataset && row.dataset.featLevel != null
            ? intOf(row.dataset.featLevel) : null
        });
      });
      return out;
    } catch (e) { return null; }
  }

  // Size, space and reach (rig ask — needed for grapple / bull rush / AoO and
  // absent entirely). Space and reach come from PHB Table 8-4 via DND35.sizes.
  //
  // `reach_ft` is the TALL-body value and `reach_ft_long` sits beside it
  // because the sheet has no body-shape field; for Small and Medium they are
  // equal, so this only ever matters to a Large-or-bigger character, and there
  // it is a real fork the consumer has to make rather than one to guess.
  function size() {
    try {
      var cat = txt('char-size');
      if (!cat) return null;
      var row = (typeof DND35 !== 'undefined' && DND35.sizes) ? DND35.sizes[cat] : null;
      var baseReach = row ? row.reach : null;
      // Reach MODIFIERS, kept separate from the body reach they adjust.
      //
      // `reach_ft` alone was wrong for anyone with a reach adder — Kell holds
      // Extended Reach (+5 ft) and the bus published his Medium body's 5 ft.,
      // understating his threatened area by a full square. Published as
      // base + itemised modifiers + resolved total, the same way the senses
      // block names every contributing source rather than handing over one
      // number: a consumer narrating an attack of opportunity needs to know
      // WHY the reach is 10, and a conditional one must not be silently
      // folded in.
      var mods = [];
      var situational = [];
      try {
        if (typeof Feats !== 'undefined' && Feats.getActiveReachBonuses) {
          var fb = Feats.getActiveReachBonuses();
          (fb.direct || []).forEach(function (b) {
            mods.push({ source: b.source || 'feat', amount: b.amount,
                        bonus_category: b.bonus_category || null, active: true });
          });
          (fb.situational || []).forEach(function (b) {
            situational.push({ source: b.source || 'feat', amount: b.amount,
                               condition: b.condition, active: false });
          });
        }
      } catch (e) { /* aggregator absent mid-load */ }
      var total = baseReach;
      if (typeof baseReach === 'number') {
        total = mods.reduce(function (n, m) {
          return n + (typeof m.amount === 'number' ? m.amount : 0);
        }, baseReach);
      }
      return {
        category: cat,
        space_ft: row ? row.space : null,
        // Body reach from PHB Table 8-4, BEFORE modifiers.
        reach_ft: baseReach,
        reach_ft_long: row ? row.reachLong : null,
        // Everything adding to it, itemised, and the resolved sum. Prefer
        // `reach_total_ft` at the table; `reach_ft` is the body's own.
        reach_modifiers: mods,
        // Conditional adders are listed but NOT summed — they need a ruling
        // about whether the condition is live, which is the consumer's call.
        reach_modifiers_situational: situational,
        reach_total_ft: total,
        ac_mod: row ? row.acMod : null,
        grapple_mod: row ? row.grappleMod : null
      };
    } catch (e) { return null; }
  }

  // Structured senses (rig ask — it was keyword-scraping darkvision et al. out
  // of the free-text special_abilities, which works until a sense is worded
  // differently). Senses.resolved() is the module's own settled list: one row
  // per sense with the WINNING range already picked across race, template,
  // soulmeld and manual sources, and every contributing source named.
  //
  // This is the one place here that reads a module instead of the DOM. The
  // rendered chips are lossy on purpose — they collapse range and provenance
  // into a display string — so scraping them back out would be parsing our own
  // formatting. The resolved list IS the resolved value.
  function senses() {
    try {
      if (typeof Senses === 'undefined' || !Senses.resolved) return null;
      return Senses.resolved().map(function (r) {
        return {
          sense: r.sense,
          range_ft: r.range_ft == null ? null : r.range_ft,
          multiplier: r.multiplier == null ? null : r.multiplier,
          extended_ft: r.extended || null,
          from: Array.isArray(r.froms) ? r.froms : []
        };
      });
    } catch (e) { return null; }
  }

  // The spell repertoire — known and prepared, per caster, per level (rig ask,
  // phase 2; also open sheet report rmtbvn6vt).
  //
  // This is the list schema 7's note said this bus does not publish, and the
  // reasoning there still stands for the general case — a slot COUNT degrades
  // gracefully, a name list does not, and it churns on every prep. Two things
  // make this one worth its weight anyway: a prepared row carries its own
  // `used` flag, which is depletion state the consumer needs and cannot derive
  // from the level totals; and metamagic means the prepared NAME is not the
  // known name ("Empowered Fireball" occupies a 5th-level slot), so no
  // consumer can reconstruct the prepared list from the known list plus slots.
  function repertoire() {
    try {
      var panels = document.querySelectorAll('[data-caster-type="spellcasting"]');
      if (!panels.length) return null;
      var out = [];
      panels.forEach(function (p, i) {
        var cid = casterIdentity(p, i);
        var known = [], prepared = [];
        p.querySelectorAll('.sc-known-list').forEach(function (list) {
          var lvl = intOf(list.getAttribute('data-lvl'));
          list.querySelectorAll('.sc-known-row').forEach(function (row) {
            var nameEl = row.querySelector('.sc-known-name');
            var nm = nameEl && nameEl.value != null ? String(nameEl.value).trim() : '';
            if (!nm) return;
            known.push({
              level: lvl, name: nm,
              // A granted row (class feature, feat) vs one the player picked.
              source: (row.dataset && row.dataset.source) || null
            });
          });
        });
        p.querySelectorAll('.sc-prepared-list').forEach(function (list) {
          var lvl = intOf(list.getAttribute('data-lvl'));
          list.querySelectorAll('.sc-prepared-row').forEach(function (row) {
            var base = (row.dataset && row.dataset.base) || '';
            var nameEl = row.querySelector('.sc-prep-name');
            var shown = nameEl
              ? String(nameEl.value != null ? nameEl.value : nameEl.textContent || '').trim()
              : '';
            if (!base && !shown) return;
            var mm = [];
            try { mm = JSON.parse((row.dataset && row.dataset.metamagic) || '[]'); } catch (e) { mm = []; }
            var box = row.querySelector('.sc-prep-used');
            prepared.push({
              level: lvl,
              // `base` is the spell; `name` is what the slot actually holds
              // once metamagic is folded in. Both, because a consumer asking
              // "is fireball prepared" wants the first and one narrating the
              // cast wants the second.
              base: base || shown,
              name: shown || base,
              metamagic: Array.isArray(mm) ? mm : [],
              used: box ? !!box.checked : null
            });
          });
        });
        if (known.length || prepared.length) {
          out.push({ id: cid.id, label: cid.label, known: known, prepared: prepared });
        }
      });
      return out.length ? out : null;
    } catch (e) { return null; }
  }

  // Caster blocks have NO class-name field of their own, which matters when a
  // character has several: Kell carries three spellcasting blocks whose only
  // distinguishing signal is the spell PICKER's class filter (.sp-class), and
  // that is a user-editable search box, not an identity.
  //
  // So publish both, honestly separated:
  //   id    — the panel's DOM id (caster-0, caster-1, ...). STABLE. Address by this.
  //   label — best-effort class name. May be blank or wrong if the player
  //           retyped the picker filter. Display it; do not key off it.
  //
  // Found by testing Kell rather than by reading: my first cut emitted only a
  // label and returned "Spellcasting" three times, which is useless to a
  // consumer that needs to tell a 7th-level caster from two 3rd-level ones.
  function casterIdentity(panel, i) {
    var label = null;
    var pp = panel.getAttribute('data-pp-class');           // psionics blocks carry this
    if (pp && pp.trim()) label = pp.trim();
    if (!label) {
      var follow = panel.querySelector('.caster-follow-class');
      if (follow && follow.value && follow.value.trim()) label = follow.value.trim();
    }
    if (!label) {
      var sp = panel.querySelector('.sp-class');
      if (sp && sp.value && sp.value.trim()) label = sp.value.trim();
    }
    // An invocations panel has none of the above — its class lives in
    // `data-invo-class`, which the class picker sets. Without this, every
    // warlock block published `label: null` while the sheet knew perfectly
    // well it was a Warlock. Unlike `.sp-class` this one is NOT a
    // user-editable search box, so it is the most trustworthy of the four.
    if (!label && panel.dataset && panel.dataset.invoClass) {
      label = String(panel.dataset.invoClass).trim() || null;
    }
    return { id: panel.id || ('#' + i), label: label };
  }

  // Structured defensive riders, in the DB's own field names and shapes so a
  // consumer reads the same vocabulary the books use.
  //
  // `notes_may_contain_riders` is the load-bearing field here, and it exists
  // for the migration window. An empty `resistances: []` from a character
  // built after this shipped means "no resistances" — a real claim. The same
  // empty list from a character built BEFORE it means "nobody has migrated the
  // prose in the notes box yet", and the prose might say Resist 5 to
  // everything. Those two must not be readable as one statement, so the flag
  // says which you are looking at. Same principle as `usable` on skills:
  // absent must never be readable as none.
  // DR RESOLUTION IS THE CONSUMER'S JOB, NOT THE SHEET'S, and the shape here
  // says so on purpose. DMG p.292: several DRs do NOT stack — for each attack
  // the best DR that attack fails to BYPASS applies, so DR 10/silver + DR
  // 5/evil reduces a plain weapon by 10, a silver one by 5, an evil one by 10,
  // and a silvered unholy one by nothing. Which one wins therefore depends on
  // what the incoming attack is made of, and the sheet does not know that.
  //
  // So it publishes the entries and their `stacks` flags and stops. Entries
  // with stacks:false compete for "best applicable"; entries with stacks:true
  // add on top of that winner (Iron Ward Diamond, Berserker Strength,
  // Dragonward, the Armor-as-DR variant — eight such sources in the DB).
  // A single resolved number would be a number that is wrong for most attacks.
  //
  // `damage_reduction_text` rides along in the books' own notation for anything
  // that just wants to print it.
  function riders() {
    try {
      if (typeof DefenseRiders === 'undefined') return {};
      var s = DefenseRiders.getStructured();
      return {
        resistances: s.resistances,
        immunities: s.immunities,
        vulnerabilities: s.vulnerabilities,
        damage_reduction: s.damage_reduction,
        damage_reduction_text: DefenseRiders.drText(),
        fast_healing: s.fast_healing,
        regeneration: s.regeneration,
        // Unlike DR, regeneration CAN be resolved here, because the answer does
        // not depend on the incoming attack: several sources give you the
        // HIGHEST rate bypassed by the INTERSECTION of their bypass sets (a
        // type has to get past every one of them to stay lethal). Use this
        // field, not the raw list — the list is shown for provenance.
        regeneration_resolved: DefenseRiders.resolveRegeneration(),
        notes_may_contain_riders: DefenseRiders.notesMayContainRiders()
      };
    } catch (e) {
      // Module absent or mid-load. Emit NOTHING rather than empty arrays —
      // omitting the keys says "this sheet doesn't model it", which is true,
      // where `[]` would say "none", which would not be.
      return {};
    }
  }

  function conditions() {
    try {
      if (typeof Conditions !== 'undefined' && Conditions.getActive) {
        return Conditions.getActive();
      }
    } catch (e) { /* conditions module absent or mid-load */ }
    return null;
  }

  // NOTE: deliberately carries NO timestamp. `published_at` is stamped on in
  // publish() instead, because this object doubles as the change-detection
  // fingerprint — embedding a clock here would make every comparison differ
  // and turn the watcher into an unconditional 1.5s publisher.
  function snapshot(qualified) {
    // Scanned once — both `special_abilities` and the blast riders on the
    // eldritch-blast attack row read it.
    var sa = specialAbilities();
    return {
      schema: SCHEMA,
      qualified: qualified,
      identity: {
        name: txt('char-name'),
        race: txt('char-race'),
        classes: txt('char-class'),
        level: num('char-level'),
        alignment: txt('char-alignment')
      },
      abilities: abilities(),
      defense: {
        ac: num('ac-total'),
        touch: num('ac-touch'),
        flat_footed: num('ac-flatfooted'),
        // Riders. SCHEMA 3 (2026-08-20): energy resistances, immunities and
        // vulnerabilities are structured now — defense-riders.js gives them
        // real fields carrying the DB's own shapes, so this no longer has to
        // hand over a sentence and hope.
        //
        // DR keeps its free-text field (158 saved characters have hand-typed
        // strings there and re-parsing them into a new store is a migration
        // nobody needs), so it ships BOTH: the verbatim string the player typed
        // and a best-effort parse. Verbatim first and always — the parse is a
        // convenience that may be null, never the source of truth.
        spell_resistance: txt('spell-resistance'),
        notes: txt('ac-defense-notes'),
        ...riders()
      },
      saves: { fort: num('fort-total'), ref: num('ref-total'), will: num('will-total') },
      initiative: num('init-total'),
      grapple: num('grapple-total'),
      bab: num('bab-1'),
      size: size(),
      hp: {
        total: num('hp-total'),
        current: num('hp-current'),
        temp: num('hp-temp'),
        nonlethal: num('hp-nonlethal')
      },
      speed: { land: txt('speed-land'), fly: txt('speed-fly') },
      attacks: attacks(sa),
      // The first LISTS this bus publishes. Everything else here is a resolved
      // number, and that rule is right for a caster — DCs and slot counts run
      // them approximately. It fails completely for a warlock, whose entire
      // offense is a list. Null (not []) when the character has no invocations
      // panel / no special-abilities container at all.
      invocations: invocations(),
      special_abilities: sa,
      // Structured senses beside the free text they were being scraped out of.
      senses: senses(),
      feats: feats(),
      skills: skills(),
      pools: pools(),
      spells: repertoire(),
      conditions: conditions(),
      // Null when nothing is shaped — an incarnum character with no melds up
      // and a character who has never heard of incarnum are different states,
      // but neither is one a consumer needs to distinguish, and null is the
      // module's convention for "nothing here".
      incarnum: incarnum()
    };
  }

  // THIS TAB'S IDENTITY, minted once per page load.
  //
  // Staleness tells a consumer a tab DIED. It cannot tell it a tab deliberately
  // moved on: swap this tab from Kell to Gorrash and Kell's snapshot sits on
  // the server looking perfectly fresh for another 90 seconds, and anything
  // reading it narrates numbers for a character nobody has open. Only the tab
  // knows it swapped, so the tab has to say so — which needs a stable name to
  // say it under, and one the server can ownership-check so a second tab on the
  // same character cannot evict the first.
  //
  // Per PAGE LOAD, not per character: a reload is a new tab as far as any
  // consumer is concerned, and the old id going quiet is exactly right.
  var TAB_ID = (function () {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (e) { /* fall through */ }
    return 'tab-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  })();

  // The character this tab last published under, so a swap can release it.
  var claimed = null;

  // Release a claim. Fire-and-forget by design: this runs on pagehide, where a
  // promise chain is not guaranteed to survive, and a release that fails to
  // arrive costs nothing worse than the 90-second staleness we already had.
  function release(qualified) {
    if (!qualified) return;
    var body = JSON.stringify({ publisher: TAB_ID });
    try {
      // sendBeacon survives the page going away, which a fetch may not. It can
      // only POST, so the DELETE path is used when the page is still alive and
      // the beacon is the unload fallback.
      if (document.visibilityState === 'hidden' && navigator.sendBeacon) {
        navigator.sendBeacon(
          '/api/live-release/' + encodeURIComponent(qualified), body);
        return;
      }
      fetch('/api/live/' + encodeURIComponent(qualified), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true
      }).catch(function () { /* standalone server, or already gone */ });
    } catch (e) { /* never let a release break the sheet */ }
  }

  // `isHeartbeat` republishes identical content on purpose: the server's
  // freshness clock is what tells a consumer this tab still exists, so a quiet
  // tab must keep saying so.
  function publish(isHeartbeat) {
    var qualified = null;
    try {
      qualified = window.AppState && window.AppState.currentQualifiedName;
    } catch (e) { /* AppState not ready */ }
    // An unsaved / brand-new character has no stable address, so there is
    // nothing a consumer could ask for. Skipping is correct; publishing it
    // under a guessed key would be worse than silence.
    if (!qualified) { stats.skipped++; return; }

    // Swapped character: let go of the old one BEFORE claiming the new, so a
    // consumer never sees this tab holding two at once.
    if (claimed && claimed !== qualified) {
      release(claimed);
      lastFingerprint = null;      // different character: never suppress as "no change"
    }
    claimed = qualified;

    var snap, fingerprint, body;
    try {
      snap = snapshot(qualified);
      fingerprint = JSON.stringify(snap);
      if (!isHeartbeat && fingerprint === lastFingerprint) return;  // no change
      snap.published_at = new Date().toISOString();
      snap.publisher = TAB_ID;
      body = JSON.stringify(snap);
    } catch (e) {
      stats.failed++; stats.lastError = 'serialize: ' + e; return;
    }
    lastFingerprint = fingerprint;

    fetch('/api/live/' + encodeURIComponent(qualified), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: body
    }).then(function (r) {
      if (r.ok) { stats.published++; stats.lastAt = new Date().toISOString(); }
      else { stats.failed++; stats.lastError = 'HTTP ' + r.status; }
    }).catch(function (e) {
      // Served by plain `python -m http.server` (no API), or the server went
      // away. Not an error worth surfacing — the sheet is fully usable
      // standalone and this is purely additive.
      stats.failed++; stats.lastError = String(e);
    });
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; publish(); }, DEBOUNCE_MS);
  }

  function install() {
    if (installed) return;
    var orig = window.recalcAll;
    if (typeof orig !== 'function') return;   // app.js not loaded yet
    window.recalcAll = function () {
      var r = orig.apply(this, arguments);
      try { schedule(); } catch (e) { /* never break a recalc */ }
      return r;
    };
    installed = true;

    // Let go when the page goes away. `pagehide` rather than `beforeunload`:
    // it fires for the back/forward cache too, and beforeunload does not fire
    // at all on mobile. Without this a closed tab holds its claim until the
    // 90-second staleness clock expires — which is the very window this whole
    // claim mechanism exists to shorten.
    try {
      window.addEventListener('pagehide', function () {
        try { release(claimed); } catch (e) { /* going away anyway */ }
      });
    } catch (e) { /* no window events: nothing to release from */ }

    // WATCH THE STATE, DON'T TRUST A NOTIFICATION. This is the load-bearing
    // mechanism, and it exists because the two obvious hooks both turned out
    // to be partial — found by testing, not by reading:
    //
    //   * wrapping `window.recalcAll` only catches EXTERNAL callers. app.js's
    //     own recalcs go through its module-local binding and never touch the
    //     global, so most in-sheet edits never reach the wrapper.
    //   * wrapping the AppState setter only catches external writes too:
    //     loadCharacter assigns the closure variable `currentQualifiedName`
    //     directly, so a character LOAD never fires the setter either.
    //
    // Both hooks are still installed because when they do fire they are
    // instant. But correctness rests on this poll: diff the snapshot we would
    // publish against the one we last published, and publish on any change.
    // It cannot be bypassed by a code path that forgets to notify us, which
    // is precisely the failure the two hooks above each had.
    watch = setInterval(function () {
      try {
        var q = (window.AppState && window.AppState.currentQualifiedName) || null;
        if (!q) return;
        var fp = JSON.stringify(snapshot(q));
        if (fp !== lastFingerprint) publish();
      } catch (e) { /* never break the page */ }
    }, WATCH_MS);

    // Heartbeat so a consumer can tell a quiet tab from a closed one. The
    // watcher publishes on CHANGE; this publishes on SILENCE, and the two
    // together are what let a reader distinguish "nothing happened" from
    // "this tab is gone".
    beat = setInterval(function () { try { publish(true); } catch (e) {} }, HEARTBEAT_MS);
    // Publish once on load so a consumer sees the character without waiting
    // for the player to touch something.
    setTimeout(function () { try { publish(); } catch (e) {} }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }

  window.LivePublish = {
    publish: publish,
    status: function () {
      return {
        installed: installed,
        qualified: (window.AppState && window.AppState.currentQualifiedName) || null,
        published: stats.published,
        failed: stats.failed,
        skipped: stats.skipped,
        lastAt: stats.lastAt,
        lastError: stats.lastError
      };
    },
    snapshot: function () {
      var q = (window.AppState && window.AppState.currentQualifiedName) || null;
      return snapshot(q);
    },
    // This tab's publisher id, so live-commands.js can stamp the snapshot it
    // acks with. An ack IS a publish, and one that names nobody leaves the
    // server carrying the claim forward on trust instead of refreshing it.
    tabId: function () { return TAB_ID; },
    // live-commands.js publishes THROUGH its ack (the server stores the
    // snapshot the ack carries, so a writer gets back exactly what a reader
    // would). Recording it here keeps the change-watcher from turning around
    // and re-publishing identical content 1.5 seconds later. Takes the
    // UNSTAMPED snapshot — `published_at` is added after the fingerprint, and
    // including a clock in the fingerprint would make every comparison differ.
    notePublished: function (snap) {
      try {
        lastFingerprint = JSON.stringify(snap);
        stats.published++;
        stats.lastAt = new Date().toISOString();
      } catch (e) { /* fingerprint is an optimisation, never break the page */ }
    }
  };
})();
