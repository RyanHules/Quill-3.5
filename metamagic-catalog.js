// metamagic-catalog.js — Hand-curated lookup table of common D&D 3.5
// metamagic feats, keyed by feat name. Used by spell-picker.js's
// metamagic UI and the spells-tab Metamagic Reference panel.
//
// **Fallback only.** The Database project's _metamagic_metadata.py
// populates entry.data.metamagic.level_adjustment / .action_type_mod /
// .effect_summary on every feat tagged Metamagic in the DB (79/79
// covered as of 2026-05-17). The pickers call `lookupMetamagic()` /
// `lookupMetamagicFromDB()` which prefer the DB and fall back to this
// catalog for homebrew feats the user adds that aren't in the DB.
//
// Shape per entry:
//   levelAdjustment : integer N        (the +N levels) — required
//                     OR 'variable'    (Heighten / Sanctum)
//   effect          : short description, one or two sentences
//   actionTypeMod   : optional. 'swift action', 'one step longer', etc.
//   variableTarget  : optional. true → UI offers a target-level input
//                     instead of a checkbox.
//
// Sources: PHB chapter 5 (the eight base feats + Heighten), Complete
// Arcane chapter 3, Complete Divine, Book of Exalted Deeds.

(function () {
  const CATALOG = {
    // ---------- PHB ----------
    'Empower Spell': {
      levelAdjustment: 2,
      effect: 'All variable, numeric effects of the spell are increased by one-half (×1.5). Saving throws and opposed rolls are not affected.',
    },
    'Maximize Spell': {
      levelAdjustment: 3,
      effect: 'All variable, numeric effects of the spell use the maximum result. Saving throws and opposed rolls are not affected.',
    },
    'Quicken Spell': {
      levelAdjustment: 4,
      effect: 'Cast as a swift action. Only one quickened spell per round. A spell with a casting time longer than 1 full round cannot be quickened.',
      actionTypeMod: 'swift action',
    },
    'Extend Spell': {
      levelAdjustment: 1,
      effect: 'Spell duration is doubled. Instantaneous- and permanent-duration spells are not affected.',
    },
    'Silent Spell': {
      levelAdjustment: 1,
      effect: 'No verbal component required. Bard spells cannot be made silent.',
    },
    'Still Spell': {
      levelAdjustment: 1,
      effect: 'No somatic component required. No arcane spell failure from armor for this casting.',
    },
    'Enlarge Spell': {
      levelAdjustment: 1,
      effect: 'Range is doubled. Close → 50 ft + 5 ft / 2 levels; medium → 200 ft + 20 ft/level; long → 800 ft + 80 ft/level. Personal, touch, and unlimited ranges unaffected.',
    },
    'Widen Spell': {
      levelAdjustment: 3,
      effect: 'Burst, emanation, line, or spread area is doubled in radius/length. Spells without these area types are unaffected.',
    },
    'Heighten Spell': {
      levelAdjustment: 'variable',
      variableTarget: true,
      effect: 'Spell occupies a higher-level slot, but in every other way it is treated as that higher level (save DC, SR, dispel checks, level-dependent damage caps, etc.).',
    },

    // ---------- Complete Arcane ----------
    'Persistent Spell': {
      levelAdjustment: 6,
      effect: 'Personal- or fixed-range spell lasts 24 hours. Only affects spells with a duration of one or more hours, with a target/area of personal, touch, or short fixed range.',
    },
    'Repeat Spell': {
      levelAdjustment: 3,
      effect: 'Spell automatically repeats on the caster\'s next turn against the same target or in the same area. Repeated casting uses no action.',
    },
    'Twin Spell': {
      levelAdjustment: 4,
      effect: 'Spell takes effect twice on the same target or area as if simultaneously cast by two separate casters. Variables, durations, and other parameters are determined separately for each instance.',
    },
    'Sculpt Spell': {
      levelAdjustment: 1,
      effect: 'Change the area to one of: cylinder (10 ft radius, 30 ft high), 40 ft cone, four 10 ft cubes, ball (20 ft radius), or 120 ft line. Original area must be a burst, emanation, line, or spread.',
    },
    'Energy Substitution': {
      levelAdjustment: 0,
      effect: 'Replace the spell\'s acid/cold/electricity/fire/sonic damage type and descriptor with one chosen energy type. Does not change the spell\'s level.',
    },
    'Energy Admixture': {
      levelAdjustment: 4,
      effect: 'Add equal damage of a chosen energy type alongside the spell\'s native type. Each type can be reduced independently by resistance/immunity.',
    },
    'Sanctum Spell': {
      levelAdjustment: 'variable',
      effect: 'Cast within your sanctum: +1 caster level, but level is unchanged. Cast outside: spell occupies one slot higher than normal. Choose a sanctum (5,000 cubic ft) when you take the feat.',
    },
    'Delay Spell': {
      levelAdjustment: 3,
      effect: 'Spell takes effect 1-5 full rounds after casting. Choose the delay at the time of casting.',
    },

    // NOTE: Empower Turning is deliberately NOT here. It's a [General]
    // feat (Complete Divine / Libris Mortis) that boosts your TURNING
    // damage — not a metamagic feat, and it never applies to spells. It
    // was previously mis-listed here, so the spells-tab metamagic UI
    // (which falls back to this catalog when the DB has no metamagic
    // block) wrongly offered it as a spell metamagic option (P2, fixed
    // 2026-07-13). The DB correctly tags it General, so removing it here
    // is the whole fix.

    // ---------- Book of Exalted Deeds ----------
    'Consecrate Spell': {
      levelAdjustment: 1,
      effect: 'Spell gains the [good] descriptor. If it deals damage, the spell deals +1 damage per die against undead and evil outsiders.',
    },
    'Purify Spell': {
      levelAdjustment: 1,
      effect: 'Spell gains the [good] descriptor. Neutral creatures take half damage; good creatures take no damage. Evil creatures take normal damage.',
    },
    'Nonlethal Substitution': {
      levelAdjustment: 0,
      effect: 'Spell\'s damage becomes nonlethal damage of the chosen type.',
    },
  };

  // Public API: lookup-by-name, list-all, has().
  window.MetamagicCatalog = {
    get: (name) => CATALOG[String(name || '').trim()] || null,
    has: (name) => Object.prototype.hasOwnProperty.call(
      CATALOG, String(name || '').trim()),
    names: () => Object.keys(CATALOG),
    // Filter a list of feat names to only those in the catalog.
    // Used by spell-picker UI to decide which metamagic checkboxes
    // to render based on what the character actually has.
    filter: (featNames) => {
      const out = [];
      for (const n of featNames || []) {
        const trimmed = String(n || '').trim();
        if (CATALOG[trimmed]) out.push(trimmed);
      }
      return out;
    },
  };
})();
