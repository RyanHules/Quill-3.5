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
  var SCHEMA = 6;
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

  function abilities() {
    var out = {};
    ['str', 'dex', 'con', 'int', 'wis', 'cha'].forEach(function (a) {
      out[a] = { score: num(a + '-total'), mod: num(a + '-mod') };
    });
    return out;
  }

  function attacks() {
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

  // Daily pools: CAPACITY ONLY, deliberately.
  //
  // The ownership split says current/spent values belong to the consumer that
  // narrates the change — it tracks depletion, the sheet hands it the ceiling.
  // So `.sc-used`, `.sc-remain` and `.psi-pp-spent` are NOT published even
  // though they sit in the same rows. One owner per number; publishing them
  // would invite two writers for the same quantity, which is the collision the
  // split exists to prevent.
  function pools() {
    var out = { power_points: [], spell_slots: [], uses_per_day: {} };

    document.querySelectorAll('[data-caster-type="psionics"]').forEach(function (p, i) {
      var maxPP = intOf(cell(p, '.psi-pp-day'));
      if (maxPP == null) return;
      var pid = casterIdentity(p, i);
      out.power_points.push({ id: pid.id, label: pid.label, max: maxPP });
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
        if (!total && known == null && dc == null) return;   // unused level
        var lvlEl = row.querySelector('[data-lvl]');
        levels.push({
          level: lvlEl ? intOf(lvlEl.getAttribute('data-lvl')) : null,
          known: known, dc: dc,
          per_day: perDay, bonus: bonus, domain: domain,
          specialist: spec, extra: extra,
          capacity: total
        });
      });
      if (levels.length) {
        var cid = casterIdentity(p, i);
        out.spell_slots.push({ id: cid.id, label: cid.label, levels: levels });
      }
    });

    // Class daily uses that live as plain top-level fields.
    var rage = num('rage-per-day'), turn = num('turn-per-day');
    if (rage != null) out.uses_per_day.rage = rage;
    if (turn != null) out.uses_per_day.turn_undead = turn;

    return out;
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
      hp: {
        total: num('hp-total'),
        current: num('hp-current'),
        temp: num('hp-temp'),
        nonlethal: num('hp-nonlethal')
      },
      speed: { land: txt('speed-land'), fly: txt('speed-fly') },
      attacks: attacks(),
      skills: skills(),
      pools: pools(),
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
