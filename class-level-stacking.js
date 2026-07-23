// class-level-stacking.js — Feats that make levels in one class count as
// levels in another FOR ONE SPECIFIC PROGRESSION (Swift Ambusher: "your
// rogue and scout levels stack for the purpose of determining the extra
// damage and bonus to Armor Class granted when skirmishing").
//
// Exposed as the global `ClassLevelStacking`. Pure — no DOM, no DB — so the
// resolver is testable in Node; class-picker.js consumes it when it builds
// the cumulative class-features list.
//
// SCOPE, and why it's narrower than the feat list.
// The mechanism works by re-reading the target class's `class_table` at a
// higher effective level and substituting that row's `special` text. That
// only works for progressions that actually live in `special` AND scale
// across several rows. A DB check of every candidate pair found three
// reasons a feat can't be modelled this way:
//
//   1. The progression is a table COLUMN, not `special` — the monk's
//      unarmed_damage is its own column, so the four Ascetic feats that
//      stack levels for unarmed strike damage can't be shifted here.
//   2. The progression isn't in the table at all — ki pool (monk, ninja)
//      appears in neither class_table.
//   3. THE COLUMN TRACKS A DIFFERENT QUANTITY. This is the dangerous one:
//      the paladin's `special` carries "smite evil N/day", but every feat
//      that stacks levels for smite does so for the DAMAGE and says in so
//      many words that it grants no extra daily uses. Substituting a
//      higher paladin row would silently hand out free smites. So Ascetic
//      Knight, Devoted Performer, Devoted Tracker and Initiate of Bahamut
//      are deliberately NOT modelled rather than modelled wrongly.
//
// UNMODELLED lists those feats explicitly, so the sheet can say "this feat
// does something we don't compute" instead of pretending it does nothing.

const ClassLevelStacking = (function () {
  'use strict';

  // Each entry: the two classes whose levels combine, and what that sum
  // applies to. `features` are lowercase stems matched against the
  // cumulative-feature label. A feat can grant several, targeting
  // DIFFERENT classes (Swift Hunter boosts skirmish as a scout AND
  // favored enemy as a ranger).
  const CATALOG = [
    {
      name: 'Swift Ambusher', source: 'Complete Scoundrel',
      classes: ['Rogue', 'Scout'],
      grants: [{ target: 'Scout', features: ['skirmish'] }],
      // Book example: scout 4 / rogue 7 -> skirmish as an 11th-level scout.
    },
    {
      name: 'Swift Hunter', source: 'Complete Scoundrel',
      classes: ['Ranger', 'Scout'],
      grants: [
        { target: 'Scout',  features: ['skirmish'] },
        { target: 'Ranger', features: ['favored enemy'] },
      ],
      // Book example: scout 4 / ranger 1 -> skirmish as a 5th-level scout,
      // and two favored enemies as a 5th-level ranger.
    },
    {
      name: 'Daring Outlaw', source: 'Complete Scoundrel',
      classes: ['Rogue', 'Swashbuckler'],
      grants: [
        { target: 'Swashbuckler', features: ['grace', 'dodge bonus'] },
        { target: 'Rogue',        features: ['sneak attack'] },
      ],
      // Book example: rogue 7 / swashbuckler 4 -> grace +2 and +2 dodge as
      // an 11th-level swashbuckler; sneak attack 6d6 as an 11th-level rogue.
    },
    {
      name: 'Daring Warrior', source: 'Complete Scoundrel',
      classes: ['Fighter', 'Swashbuckler'],
      grants: [{ target: 'Swashbuckler', features: ['grace', 'dodge bonus'] }],
      // Book example: fighter 6 / swashbuckler 5 -> as an 11th-level
      // swashbuckler. (It also stacks for fighter-level feat prereqs, which
      // is a prerequisite question, not a class-feature tier.)
    },
    {
      name: 'Martial Stalker', source: 'Complete Scoundrel',
      classes: ['Fighter', 'Ninja'],
      grants: [{ target: 'Ninja', features: ['ac bonus'] }],
      // Also stacks for the ki pool, which no class_table models.
    },
    {
      name: 'Master Spellthief', source: 'Complete Scoundrel',
      classes: null,   // spellthief + ANY arcane class — resolved specially
      spellthiefArcane: true,
      grants: [{ target: 'Spellthief', features: ['steal spell'] }],
    },
    {
      name: 'Song of the White Raven', source: 'Tome of Battle',
      classes: ['Crusader', 'Bard'],
      altClasses: ['Warblade', 'Bard'],
      grants: [{ target: 'Bard', features: ['inspire courage'] }],
    },
  ];

  // Feats that stack class levels but whose effect this mechanism can't
  // express. Surfaced to the player rather than silently ignored.
  const UNMODELLED = [
    { name: 'Ascetic Hunter',     why: 'stacks ranger + monk for unarmed strike damage (a table column, not a class-feature tier)' },
    { name: 'Ascetic Knight',     why: 'stacks paladin + monk for unarmed damage and smite DAMAGE — the paladin table tracks smite uses/day, and the feat grants no extra uses' },
    { name: 'Ascetic Rogue',      why: 'stacks rogue + monk for unarmed strike damage (a table column)' },
    { name: 'Ascetic Mage',       why: 'stacks sorcerer + monk for unarmed strike damage (a table column)' },
    { name: 'Ascetic Stalker',    why: 'stacks monk + ninja for the ki pool, which no class table models' },
    { name: 'Devoted Performer',  why: 'stacks paladin + bard for smite DAMAGE and bardic music uses; the tables track uses/day and the feat grants no extra uses' },
    { name: 'Devoted Tracker',    why: 'stacks paladin + ranger for smite DAMAGE and wild empathy; the paladin table tracks uses/day and the feat grants no extra uses' },
    { name: 'Initiate of Bahamut', why: 'stacks cleric levels for smite DAMAGE; the paladin table tracks uses/day' },
  ];

  const lower = (s) => String(s || '').toLowerCase();

  // `classLevels`: [{ className, level }] (or an object map).
  // `hasFeat(name)`: predicate.
  // Returns [{ feat, target, features[], baseLevel, effectiveLevel, from }],
  // one per grant that actually applies, skipping any where stacking adds
  // nothing (the character lacks the other class, or the sum equals base).
  function resolve(classLevels, hasFeat) {
    const levels = new Map();
    const list = Array.isArray(classLevels)
      ? classLevels
      : Object.entries(classLevels || {}).map(([className, level]) => ({ className, level }));
    for (const c of list) {
      const k = lower(c.className);
      // Same class on both gestalt sides doesn't double — take the higher.
      levels.set(k, Math.max(levels.get(k) || 0, Number(c.level) || 0));
    }
    const out = [];
    if (typeof hasFeat !== 'function') return out;

    for (const entry of CATALOG) {
      if (!hasFeat(entry.name)) continue;
      // Which pair of classes applies? Some feats accept either of two.
      let pair = null;
      if (entry.spellthiefArcane) {
        // Spellthief levels stack with levels of ANY other arcane class.
        const st = levels.get('spellthief') || 0;
        if (!st) continue;
        let best = 0, bestName = '';
        for (const [name, lvl] of levels) {
          if (name === 'spellthief') continue;
          if (ARCANE_CLASSES.has(name) && lvl > best) { best = lvl; bestName = name; }
        }
        if (!best) continue;
        pair = { a: 'Spellthief', b: bestName, sum: st + best };
      } else {
        for (const cand of [entry.classes, entry.altClasses].filter(Boolean)) {
          const la = levels.get(lower(cand[0])) || 0;
          const lb = levels.get(lower(cand[1])) || 0;
          if (la && lb) { pair = { a: cand[0], b: cand[1], sum: la + lb }; break; }
        }
      }
      if (!pair) continue;                    // needs BOTH classes to do anything

      for (const grant of entry.grants) {
        const base = levels.get(lower(grant.target)) || 0;
        if (!base) continue;                  // no levels in the target class
        const eff = Math.min(pair.sum, 20);   // class tables stop at 20
        if (eff <= base) continue;            // stacking gained nothing
        out.push({
          feat: entry.name,
          target: grant.target,
          features: grant.features.slice(),
          baseLevel: base,
          effectiveLevel: eff,
          from: [pair.a, pair.b],
        });
      }
    }
    return out;
  }

  // Arcane classes for Master Spellthief. Deliberately a plain list: the
  // feat says "any class that grants arcane spellcasting other than the
  // spellthief", and the DB's class_type metadata is incomplete on several
  // core classes.
  const ARCANE_CLASSES = new Set([
    'wizard', 'sorcerer', 'bard', 'warmage', 'beguiler', 'dread necromancer',
    'hexblade', 'duskblade', 'wu jen', 'shugenja', 'warlock', 'sha\'ir',
    'jester', 'suel arcanamach', 'sublime chord',
  ]);

  // Does a cumulative-feature label belong to one of a grant's features?
  // Prefix-aligned on a word boundary, the same rule the ACF replacement
  // matcher uses, so "sneak attack +6d6" matches the stem "sneak attack"
  // while "psionic sneak attack" does not.
  function labelMatches(label, features) {
    const l = lower(label).trim();
    return features.some((f) => {
      const s = lower(f);
      if (l === s) return true;
      if (!l.startsWith(s)) return false;
      return /[^a-z0-9]/.test(l.charAt(s.length));
    });
  }

  // Feats the player has that stack levels but that we don't compute.
  function unmodelledFor(hasFeat) {
    if (typeof hasFeat !== 'function') return [];
    return UNMODELLED.filter(u => hasFeat(u.name));
  }

  return {
    resolve, labelMatches, unmodelledFor,
    // Exposed for the test suite / introspection.
    CATALOG, UNMODELLED,
  };
})();

if (typeof window !== 'undefined') window.ClassLevelStacking = ClassLevelStacking;
