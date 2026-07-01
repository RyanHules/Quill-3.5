// class-picker.js — Class + level lookup that auto-fills BAB and saves
// from the SQLite database. Designed to coexist with the existing
// free-form `#char-class` textarea so manual multi-class entries keep
// working.
//
// UI added to the page (next to the Class & Level textarea):
//   #class-lookup           (input)    — class autocomplete
//   #class-lookup-level     (input)    — level number 1-20+
//   #class-lookup-apply     (button)   — explicit apply
//   #class-info             (div)      — preview panel
//   <datalist id="class-options">      — autocomplete options
//
// Existing fields written:
//   #bab-1            — Base Attack Bonus (highest), from progression
//   #fort-base        — Fortitude base save
//   #ref-base         — Reflex base save
//   #will-base        — Will base save
//   #char-class       — appended (or set, if empty) with "ClassName Level"
//   #char-level       — set if currently empty
//
// BAB/save progression formulas (PHB):
//   BAB good   = level
//   BAB avg    = floor(level * 3/4)
//   BAB poor   = floor(level / 2)
//   Save good  = 2 + floor(level / 2)
//   Save poor  = floor(level / 3)

(function () {
  if (!window.DB) {
    console.warn('[class-picker] DB module not loaded');
    return;
  }

  // Map from lowercase class name → array of class_table rows.
  let classIndex = new Map();

  // Default spellcasting/manifesting ability for known classes. Used to
  // pre-select the .sc-ability dropdown when auto-creating a Spells tab.
  // Classes not in this map get an empty ability (user fills in).
  const SPELLCASTING_ABILITY = {
    'Wizard': 'INT', 'Sorcerer': 'CHA', 'Bard': 'CHA',
    'Cleric': 'WIS', 'Druid': 'WIS',
    'Paladin': 'WIS', 'Ranger': 'WIS',
    'Hexblade': 'CHA', 'Warmage': 'CHA',
    'Beguiler': 'INT', 'Dread Necromancer': 'CHA',
    'Healer': 'WIS', 'Spirit Shaman': 'WIS',
    'Wu Jen': 'INT', 'Shugenja': 'CHA',
    'Duskblade': 'INT', 'Sohei': 'WIS',
    'Apostle of Peace': 'WIS', 'Assassin': 'INT',
    'Blackguard': 'WIS',
  };

  // Variants of class names appearing in spell_class_level.class_name
  // (which mixes abbreviations, full names, case variants, and parser-
  // fragmented forms). Used to look up the offset between the
  // spells_per_day_json array index and actual spell level.
  const SPELL_CLASS_VARIANTS = {
    'Wizard':   ['Wiz', 'Wizard', 'wizard'],
    'Sorcerer': ['Sor', 'Sorcerer', 'sorcerer'],
    'Cleric':   ['Clr', 'Cleric', 'cleric', 'C l e r i c'],
    'Druid':    ['Drd', 'Druid', 'druid', 'd r u i d'],
    'Paladin':  ['Pal', 'Paladin', 'paladin'],
    'Ranger':   ['Rgr', 'Ranger', 'ranger', 'r a n g e r'],
    // Mystic Ranger (Dragon #336) casts 0th-5th level spells — its
    // spells_per_day list starts at level 0 (orisons). Routing it through
    // the data-driven offset (MIN(level)=0 from spell_class_level) is
    // required: the length heuristic would mis-read its 6-slot list (<7)
    // as a no-cantrip caster and shift every column up by one.
    'Mystic Ranger': ['Mystic Ranger'],
    'Bard':     ['Brd', 'Bard', 'bard'],
    'Hexblade': ['Hexblade', 'hexblade'],
    'Warmage':  ['Wmg', 'Warmage', 'warmage'],
    'Beguiler': ['Beguiler', 'beguiler'],
    'Healer':   ['Healer', 'healer'],
    'Wu Jen':   ['Wuj', 'Wij', 'Wu Jen', 'wu jen'],
    'Shugenja': ['Shu', 'Sha', 'Shugenja', 'shugenja'],
    'Duskblade':['Duskblade', 'duskblade'],
    'Assassin': ['Asn', 'Assassin', 'assassin'],
    'Blackguard':['Blk', 'Blackguard', 'blackguard'],
    'Dread Necromancer': ['Dread Necromancer', 'Dread necromancer', 'dread necromancer'],
    'Spirit Shaman': ['Spirit Shaman'],
    'Apostle of Peace': ['Apostle of peace', 'apostle of peace', 'Apostle of Peace'],
  };

  // Classes that grant power points / power-known progressions. Used to
  // auto-create a Psionics tab even when the parsed `class_level` rows
  // are sparse (the parser missed PP/known columns for most psionic
  // classes — flagged in TODO.md under "DB / Parser Data Quality").
  const PSIONIC_CLASSES = new Set([
    'Psion', 'Wilder', 'Psychic Warrior', 'Ardent', 'Erudite',
    'Lurk', 'Divine Mind', 'Soulknife',
  ]);

  // Tome of Battle martial adept classes — get a Maneuvers tab.
  const MARTIAL_ADEPT_CLASSES = new Set([
    'Crusader', 'Warblade', 'Swordsage',
  ]);

  // Class-skill lists per PHB. Special tokens:
  //   "Knowledge (all)"  → expand to every Knowledge subtype
  //   "Craft" / "Perform" / "Profession" (alone) → tick all currently-
  //   added subtype entries for that base skill (auto-ticking new
  //   entries the user adds later isn't supported in MVP).
  // Skill names match `.skill-name` text content from skills.js (which
  // matches data.js entries — Knowledge subtypeLabels: Arcana,
  // Arch. & Eng., Dungeoneering, Geography, History, Local, Nature,
  // Nobility, The Planes, Religion).
  const CLASS_SKILLS = {
    'Barbarian': [
      'Climb','Craft','Handle Animal','Intimidate','Jump','Listen','Ride',
      'Survival','Swim',
    ],
    'Bard': [
      'Appraise','Balance','Bluff','Climb','Concentration','Craft',
      'Decipher Script','Diplomacy','Disguise','Escape Artist',
      'Gather Information','Hide','Jump','Knowledge (all)','Listen',
      'Move Silently','Perform','Profession','Sense Motive',
      'Sleight of Hand','Speak Language','Spellcraft','Swim','Tumble',
      'Use Magic Device',
    ],
    'Cleric': [
      'Concentration','Craft','Diplomacy','Heal','Knowledge (Arcana)',
      'Knowledge (History)','Knowledge (Religion)','Knowledge (The Planes)',
      'Profession','Spellcraft',
    ],
    'Druid': [
      'Concentration','Craft','Diplomacy','Handle Animal','Heal',
      'Knowledge (Nature)','Listen','Profession','Ride','Spellcraft',
      'Spot','Survival','Swim',
    ],
    'Fighter': [
      'Climb','Craft','Handle Animal','Intimidate','Jump','Ride','Swim',
    ],
    'Monk': [
      'Balance','Climb','Concentration','Craft','Diplomacy','Escape Artist',
      'Hide','Jump','Knowledge (Arcana)','Knowledge (Religion)','Listen',
      'Move Silently','Perform','Profession','Sense Motive','Spot','Swim',
      'Tumble',
    ],
    'Paladin': [
      'Concentration','Craft','Diplomacy','Handle Animal','Heal',
      'Knowledge (Nobility)','Knowledge (Religion)','Profession','Ride',
      'Sense Motive',
    ],
    'Ranger': [
      'Climb','Concentration','Craft','Handle Animal','Heal','Hide','Jump',
      'Knowledge (Dungeoneering)','Knowledge (Geography)',
      'Knowledge (Nature)','Listen','Move Silently','Profession','Ride',
      'Search','Spot','Survival','Swim','Use Rope',
    ],
    'Rogue': [
      'Appraise','Balance','Bluff','Climb','Craft','Decipher Script',
      'Diplomacy','Disable Device','Disguise','Escape Artist','Forgery',
      'Gather Information','Hide','Intimidate','Jump','Knowledge (Local)',
      'Listen','Move Silently','Open Lock','Perform','Profession','Search',
      'Sense Motive','Sleight of Hand','Spot','Swim','Tumble',
      'Use Magic Device','Use Rope',
    ],
    'Sorcerer': [
      'Bluff','Concentration','Craft','Knowledge (Arcana)','Profession',
      'Spellcraft',
    ],
    'Wizard': [
      'Concentration','Craft','Decipher Script','Knowledge (all)',
      'Profession','Spellcraft',
    ],
    // Common alt/PrC casters and martials that show up in CLASS_ABILITY:
    'Hexblade': [
      'Bluff','Concentration','Craft','Diplomacy','Intimidate','Knowledge (Arcana)',
      'Profession','Ride','Sense Motive','Spellcraft',
    ],
    'Warmage': [
      'Concentration','Craft','Intimidate','Knowledge (Arcana)','Knowledge (History)',
      'Profession','Spellcraft',
    ],
    'Beguiler': [
      'Bluff','Concentration','Craft','Decipher Script','Diplomacy','Disguise',
      'Escape Artist','Forgery','Gather Information','Hide','Intimidate',
      'Knowledge (Arcana)','Knowledge (Local)','Listen','Move Silently',
      'Profession','Search','Sense Motive','Sleight of Hand','Speak Language',
      'Spellcraft','Spot','Use Magic Device',
    ],
    'Dread Necromancer': [
      'Bluff','Concentration','Craft','Decipher Script','Disguise','Hide',
      'Intimidate','Knowledge (Arcana)','Knowledge (Religion)','Profession',
      'Spellcraft',
    ],
    'Healer': [
      'Concentration','Craft','Diplomacy','Handle Animal','Heal',
      'Knowledge (Nature)','Knowledge (Religion)','Profession','Spellcraft',
    ],
    'Spirit Shaman': [
      'Concentration','Craft','Diplomacy','Heal','Knowledge (Nature)',
      'Knowledge (Religion)','Listen','Profession','Spellcraft','Spot','Survival',
      'Swim',
    ],
    'Duskblade': [
      'Climb','Concentration','Craft','Intimidate','Jump','Knowledge (Arcana)',
      'Ride','Sense Motive','Spellcraft','Swim',
    ],
    'Crusader': [
      'Climb','Concentration','Craft','Diplomacy','Intimidate','Jump',
      'Knowledge (Religion)','Profession','Sense Motive','Swim',
    ],
    'Warblade': [
      'Balance','Climb','Craft','Hide','Intimidate','Jump','Knowledge (History)',
      'Martial Lore','Move Silently','Search','Swim','Tumble',
    ],
    'Swordsage': [
      'Balance','Concentration','Craft','Diplomacy','Hide','Intimidate','Jump',
      'Knowledge (History)','Knowledge (Local)','Knowledge (Nature)',
      'Knowledge (Religion)','Listen','Martial Lore','Move Silently','Profession',
      'Sense Motive','Swim','Tumble',
    ],
    'Psion': [
      'Concentration','Craft','Knowledge (Psionics)','Profession','Psicraft',
    ],
    'Wilder': [
      'Autohypnosis','Bluff','Concentration','Craft','Intimidate','Jump',
      'Knowledge (Psionics)','Listen','Profession','Psicraft','Spot','Swim',
    ],
    'Psychic Warrior': [
      'Autohypnosis','Climb','Concentration','Craft','Handle Animal','Jump',
      'Knowledge (Psionics)','Profession','Ride','Search','Swim',
    ],
  };

  // Spellcasting type per class. Primary source is the DB
  // (`entry.data.spellcasting.class_type`, populated by
  // `_class_metadata.py` at build time). The `_FALLBACK_*` map below
  // is a defensive backstop for legacy data — if a class entry was
  // built before the metadata merge landed, we still want the picker
  // to work. Access via `getClassType(name)` (defined below).
  //
  // Value shape: string `'arcane'` / `'divine'` / `'psionic'` OR an
  // array `['arcane', 'divine']` for dual-list casters (Sha'ir's gen
  // fetches from both arcane and divine lists).
  const _FALLBACK_SPELLCASTING_TYPE = {
    'Wizard': 'arcane',  'Sorcerer': 'arcane',  'Bard': 'arcane',
    'Hexblade': 'arcane','Warmage': 'arcane',   'Beguiler': 'arcane',
    'Dread Necromancer': 'arcane', 'Wu Jen': 'arcane',
    'Duskblade': 'arcane', 'Assassin': 'arcane',
    "Sha'ir": ['arcane', 'divine'],  // Dragon Compendium gen-fetched casting from both lists
    'Spellthief': 'arcane',     // Complete Adventurer
    'Jester': 'arcane',         // Dragon Compendium
    'Death Master': 'arcane',   // Dragon Compendium
    'Magewright': 'arcane',     // Eberron Campaign Setting (NPC class — wizard-style prep)
    'Cleric': 'divine',  'Druid': 'divine',
    'Paladin': 'divine', 'Ranger': 'divine',
    'Mystic Ranger': 'divine',  // Dragon Magazine #336 variant ranger (earlier, deeper divine casting)
    'Healer': 'divine',  'Shugenja': 'divine',
    'Spirit Shaman': 'divine', 'Sohei': 'divine',
    'Apostle of Peace': 'divine', 'Blackguard': 'divine',
    'Archivist': 'divine',      // Heroes of Horror
    'Favored Soul': 'divine',   // Complete Divine
    'Urban Druid': 'divine',    // Dragon Compendium
    'Psion': 'psionic', 'Wilder': 'psionic',
    'Psychic Warrior': 'psionic', 'Ardent': 'psionic',
    'Erudite': 'psionic',
    // CPsi classes — added 2026-05-16 after normalize_cpsi_classes.py
    // converted their data to canonical shape; the audit test then
    // surfaced them as "looks like spellcaster but not in fallback".
    'Divine Mind': 'psionic', 'Lurk': 'psionic',
    // UA generic Spellcaster (v3 walk 2026-06-27): picks its spell list at
    // creation (cleric/druid/sorcerer-wizard), so it can be arcane or divine.
    'Spellcaster (Generic Class)': ['arcane', 'divine'],
  };

  // Casting style per class. Primary source is the DB
  // (`entry.data.spellcasting.style`, populated by `_class_metadata.py`
  // at build time). Fallback map below for legacy data. Access via
  // `getCasterStyle(name)`.
  //
  // Used by PrCs that require specific styles (e.g. Ultimate Magus
  // requires one prepared + one spontaneous arcane caster). Values:
  // 'prepared' (spellbook/list, daily preparation), 'spontaneous'
  // (fixed known list, cast freely), 'manifesting' (psionic).
  //
  // Sha'ir is classified 'prepared' because its gens fetch specific
  // spells per day and "remain memorized until cast" — mechanically the
  // closest analogue to preparation, even though the source list is
  // open. (If the player wants to treat Sha'ir as the spontaneous
  // partner in an Ultimate Magus build, the per-level UI still lets
  // them advance Sha'ir; this flag only gates which eligible classes
  // are shown in each "prepared" / "spontaneous" slot.)
  const _FALLBACK_CASTER_STYLE = {
    // Arcane prepared
    'Wizard': 'prepared',
    'Wu Jen': 'prepared',
    'Death Master': 'prepared',
    'Assassin': 'prepared',
    'Magewright': 'prepared',   // Eberron CS NPC class — prepares spells as a wizard (no spellbook)
    // Arcane spontaneous (incl. "fixed list" spontaneous casters)
    'Sorcerer': 'spontaneous',
    'Bard': 'spontaneous',
    'Hexblade': 'spontaneous',
    'Warmage': 'spontaneous',
    'Beguiler': 'spontaneous',
    'Dread Necromancer': 'spontaneous',
    'Duskblade': 'spontaneous',
    'Spellthief': 'spontaneous',
    'Jester': 'spontaneous',
    // Divine prepared
    'Cleric': 'prepared',
    'Druid': 'prepared',
    'Paladin': 'prepared',
    'Ranger': 'prepared',
    'Mystic Ranger': 'prepared',  // Dragon Magazine #336 variant ranger (divine, prepared)
    'Archivist': 'prepared',
    // (Shugenja moved to spontaneous below — DB description confirms
    // "spontaneously without preparation".)
    'Sohei': 'prepared',
    'Urban Druid': 'prepared',
    'Apostle of Peace': 'prepared',
    'Blackguard': 'prepared',
    // Divine spontaneous
    'Favored Soul': 'spontaneous',
    'Spirit Shaman': 'spontaneous',
    'Healer': 'spontaneous',
    'Shugenja': 'spontaneous',
    // Dual arcane/divine
    "Sha'ir": 'prepared',
    'Spellcaster (Generic Class)': 'spontaneous',  // UA — casts as a sorcerer (Table 2-9 spells known)
  };

  // Primary source is the DB (`entry.data.advancement`, populated by
  // `_class_metadata.py` at build time). The `_FALLBACK_*` map is a
  // defensive backstop for legacy data; access via
  // `getAdvancementSpec(name)`.
  //
  // PrCs whose `class_level.special` text doesn't include the
  // "+1 level of existing X spellcasting class" marker (parser missed
  // it, or the rules text only appears in the class description).
  // Each entry:
  //   { types: ['arcane'|'divine'|'psionic'|'any', …],
  //     advancesAllLevels: bool,
  //     nonAdvancingLevels: [int, …]    // optional
  //     perLevelChoice: bool,            // optional — Ultimate Magus
  //     requiresStyles: ['prepared'|'spontaneous', …]  // optional
  //     allowsMultiAdvance: bool         // optional — multi-target/level
  //   }
  // - advancesAllLevels=true means the PrC's full level count is the
  //   advancement count (Mystic Theurge, Archmage, Loremaster, …).
  // - nonAdvancingLevels lists PrC levels that DON'T grant caster
  //   advancement (e.g. Sand Shaper: levels 1 and 9). Effective
  //   advancement = picked_level - count(nonAdvancingLevels ≤ picked_level).
  // - perLevelChoice=true means each non-skip PrC level is allocated
  //   independently by the player. UI builds one row of target pickers
  //   per non-skip level; advancement is stored on the entry as
  //   `advancementSlots: [{prcLevel, targets:[…]}, …]`.
  // - requiresStyles names the CASTER_STYLE values that must each have
  //   at least one matching class in pickedClasses (Ultimate Magus
  //   needs one 'prepared' and one 'spontaneous' arcane caster).
  // - allowsMultiAdvance=true means the player can pick MORE THAN ONE
  //   target per slot (UM: both prepared + spontaneous at the same
  //   level). Without this flag, each slot accepts exactly one target.
  const _FALLBACK_HARDCODED_ADVANCERS = {
    'Mystic Theurge':   { types: ['arcane', 'divine'], advancesAllLevels: true },
    'Archmage':         { types: ['arcane'],           advancesAllLevels: true },
    'Loremaster':       { types: ['any'],              advancesAllLevels: true },
    'Arcane Trickster': { types: ['any'],              advancesAllLevels: true },
    'Acolyte of the Skin': { types: ['arcane'],        advancesAllLevels: true },
    'Alienist':         { types: ['arcane'],           advancesAllLevels: true },
    'Anima Mage':       { types: ['arcane'],           advancesAllLevels: true },
    'Argent Savant':    { types: ['arcane'],           advancesAllLevels: true },
    'Blighter':         { types: ['divine'],           advancesAllLevels: true },
    'Contemplative':    { types: ['divine'],           advancesAllLevels: true },
    'Dragon Disciple':  { types: ['arcane'],           advancesAllLevels: true },
    'Dweomerkeeper':    { types: ['divine'],           advancesAllLevels: true },
    'Hierophant':       { types: ['divine'],           advancesAllLevels: true },
    'Hospitaler':       { types: ['divine'],           advancesAllLevels: true },
    'Mage of the Arcane Order': { types: ['arcane'],   advancesAllLevels: true },
    'Master Specialist': { types: ['arcane'],          advancesAllLevels: true },
    'Sacred Exorcist':  { types: ['divine'],           advancesAllLevels: true },
    'Shadowcraft Mage': { types: ['arcane'],           advancesAllLevels: true },
    'Thaumaturgist':    { types: ['divine'],           advancesAllLevels: true },
    'True Necromancer': { types: ['arcane', 'divine'], advancesAllLevels: true },
    'Ur-Priest':        { types: ['divine'],           advancesAllLevels: true },
    // Unapproachable East: durthan advances arcane casting at every
    // level via "Spells per Day/Spells Known" feature (no canonical
    // marker in the parsed class_table).
    'Durthan':          { types: ['arcane'],           advancesAllLevels: true },
    // Sandstorm: sand shaper advances arcane casting at every level
    // EXCEPT 1st and 9th — those are the "PrC entry" and "capstone"
    // levels respectively.
    'Sand Shaper':      { types: ['arcane'],           advancesAllLevels: true,
                          nonAdvancingLevels: [1, 9] },
    // Additional PrCs whose class_table.special doesn't carry the
    // canonical "+1 level of existing X spellcasting class" marker
    // (the parser missed it; the advancement language only appears in
    // the class_features prose). Audited 2026-05-15 via
    // `tests/test_pickers.js` and added below to keep that audit
    // green going forward.
    'Arachnomancer':         { types: ['any'],     advancesAllLevels: true,
                               nonAdvancingLevels: [2, 5, 8, 9, 10] },
    'Black Flame Zealot':    { types: ['divine'],  advancesAllLevels: true },
    'Church Inquisitor':     { types: ['divine'],  advancesAllLevels: true },
    'Daggerspell Mage':      { types: ['arcane'],  advancesAllLevels: true },
    'Daggerspell Shaper':    { types: ['divine'],  advancesAllLevels: true },
    'Entropomancer':         { types: ['divine'],  advancesAllLevels: true },
    'Exalted Arcanist':      { types: ['arcane'],  advancesAllLevels: true },
    'Eye of Lolth':          { types: ['divine'],  advancesAllLevels: true },
    'Fist of Raziel':        { types: ['divine'],  advancesAllLevels: true },
    'Fochlucan Lyrist':      { types: ['arcane', 'divine'], advancesAllLevels: true },
    'Insidious Corruptor':   { types: ['any'],     advancesAllLevels: true },
    'Lion of Talisid':       { types: ['divine'],  advancesAllLevels: true },
    'Lord of Tides':         { types: ['divine'],  advancesAllLevels: true },
    'Maester':               { types: ['any'],     advancesAllLevels: true },
    'Master of the Yuirwood': { types: ['arcane'], advancesAllLevels: true },
    'Mythic Exemplar':       { types: ['any'],     advancesAllLevels: true },
    'Ollam':                 { types: ['arcane'],  advancesAllLevels: true },
    'Prophet of Erathaol':   { types: ['divine'],  advancesAllLevels: true },
    'Raumathari Battlemage': { types: ['arcane'],  advancesAllLevels: true,
                               nonAdvancingLevels: [5] },
    'Scion of Tem-Et-Nu':    { types: ['divine'],  advancesAllLevels: true },
    'Sentinel of Bharrai':   { types: ['divine'],  advancesAllLevels: true },
    'Shadowbane Stalker':    { types: ['divine'],  advancesAllLevels: true,
                               nonAdvancingLevels: [4, 9] },
    'Shadowmind':            { types: ['psionic'], advancesAllLevels: true },
    'Skylord':               { types: ['divine'],  advancesAllLevels: true },
    'Swanmay':               { types: ['divine'],  advancesAllLevels: true },
    'Talontar Blightlord':   { types: ['divine'],  advancesAllLevels: true,
                               nonAdvancingLevels: [6, 10] },
    'Troubadour of Stars':   { types: ['arcane'],  advancesAllLevels: true },
    'Ultimate Magus':        { types: ['arcane'],  advancesAllLevels: true,
                               // UM advances at EVERY level, but:
                               //   - L1, 4, 7: auto-advance the LOWER
                               //     of the two arcane classes
                               //     (tie-break = player choice).
                               //   - All other levels: player picks
                               //     +1 prepared, +1 spontaneous, or
                               //     both.
                               // Requires one prepared and one
                               // spontaneous arcane caster.
                               perLevelChoice: true,
                               requiresStyles: ['prepared', 'spontaneous'],
                               allowsMultiAdvance: true,
                               autoAdvanceLowerLevels: [1, 4, 7] },
    'Virtuoso':              { types: ['arcane'],  advancesAllLevels: true },
    'Walker in the Waste':   { types: ['divine'],  advancesAllLevels: true,
                               nonAdvancingLevels: [1, 10] },
    // Epic Level Handbook epic PrCs that advance spellcasting via the
    // standard Spells per Day class feature (their class_table.special
    // entries don't carry the canonical "+1 level of existing X
    // spellcasting class" marker because each level's special column is
    // dedicated to class-feature names like "Uncanny location" or
    // "Granted domain"). The advancement is described only in prose.
    'Agent Retriever':       { types: ['any'],     advancesAllLevels: true },
    'Cosmic Descryer':       { types: ['any'],     advancesAllLevels: true,
                               nonAdvancingLevels: [1, 3, 5, 7, 9] },
    'Divine Emissary':       { types: ['divine'],  advancesAllLevels: true },
    'High Proselytizer':     { types: ['divine'],  advancesAllLevels: true,
                               nonAdvancingLevels: [1, 3, 5, 7, 9] },
    // Races of the Wild: advancement lives only in the class_features
    // "Spellcasting" prose (no class_table marker). Mirror of
    // _class_metadata.ADVANCEMENT_METADATA; added 2026-05-28.
    'Arcane Hierophant':     { types: ['arcane', 'divine'], advancesAllLevels: true },
    'Luckstealer':           { types: ['any'],     advancesAllLevels: true,
                               nonAdvancingLevels: [1, 7, 10] },
    'Ruathar':               { types: ['any'],     advancesAllLevels: true },
  };

  // Tome of Battle maneuver-advancement metadata. Parallel to
  // _FALLBACK_HARDCODED_ADVANCERS but for ToB initiator-level /
  // maneuvers-known advancement. Lives in its own map because ToB PrCs
  // typically advance maneuvers on a DIFFERENT schedule than spells —
  // e.g. Ruby Knight Vindicator advances divine casting at every level
  // except 1 and 6, but only advances maneuvers at EVEN levels.
  //
  // Primary source is the DB (`entry.data.maneuver_advancement`,
  // populated by `_class_metadata.py::MANEUVER_ADVANCEMENT_METADATA` at
  // build time). This fallback covers older DBs / missing-build cases.
  //
  // Schema:
  //   advancingLevels: [int, …]  — PrC levels that grant +1 IL to the
  //       picked base ToB class.
  //   disciplines: [str, …]      — optional discipline whitelist.
  //       Recorded for future maneuver-picker integration, not consumed
  //       by the IL advancement walk.
  // Invocation-advancement metadata (Warlock-style pillar). Parallels
  // `_FALLBACK_HARDCODED_ADVANCERS` / `_FALLBACK_MANEUVER_ADVANCERS`
  // but tracks invocations-known / grade-access advancement of a
  // base invocation-using class (Warlock today; Dragonfire Adept once
  // extracted). Three PrCs use this pillar:
  //
  //   * Eldritch Disciple  (CMage) — advances invocations at every PrC level
  //   * Eldritch Theurge   (CMage) — advances invocations AT every PrC level
  //                                  (also advances arcane casting via the
  //                                  separate spell pillar — dual-pillar PrC)
  //   * Demonbinder        (DotU)  — advances invocations at L2-L10 (skips L1)
  //
  // No "advancing-types" axis because there's only one invocation-track
  // base class in the current DB (Warlock). When DFA gets extracted,
  // advancement still resolves to "the picked base invocation-user".
  const _FALLBACK_INVOCATION_ADVANCERS = {
    'Eldritch Disciple': {
      advancingLevels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    },
    'Eldritch Theurge': {
      advancingLevels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    },
    'Demonbinder': {
      advancingLevels: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    },
  };

  // Base invocation-using classes. Two axes use this set: (1) auto-create
  // an Invocations sub-tab in ensureCasterTab when one is applied, and
  // (2) resolve the target of invocation-advancement PrCs (Eldritch
  // Theurge / Eldritch Disciple / Demonbinder). Both Warlock and
  // Dragonfire Adept (Dragon Magic) are base invocation users; Hellfire
  // Warlock and the rest are PrCs that require one of these as a base.
  const INVOCATION_USING_CLASSES = new Set([
    'Warlock', 'Dragonfire Adept',
  ]);

  // Mystery-advancement metadata (ToM shadowcaster pillar). Parallels
  // the spell / maneuver / invocation pillars. Two PrCs use it today:
  //
  //   * Master of Shadow (ToM) — advances mysteries L2-L10 (skips L1).
  //     Source phrasing is "casting class to which you belonged"
  //     (generic — could also mean an arcane caster); we route to
  //     the mystery pillar because Shadowcaster is the canonical
  //     build per source material.
  //   * Noctumancer (ToM) — DUAL-pillar PrC. Advances both mystery
  //     AND arcane casting at every level. Has BOTH `mystery_-
  //     advancement` and the spell-pillar `advancement` set.
  const _FALLBACK_MYSTERY_ADVANCERS = {
    'Master of Shadow': { advancingLevels: [2, 3, 4, 5, 6, 7, 8, 9, 10] },
    'Noctumancer':      { advancingLevels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
  };

  // Base mystery-using classes — the targets of mystery-advancement
  // PrCs. Today just Shadowcaster; expand if future books add more.
  const MYSTERY_USING_CLASSES = new Set([
    'Shadowcaster',
  ]);

  // Base vestige-binding classes — get a Vestige Binding ("binding")
  // sub-tab. Today just Binder; the binder PrCs (Anima Mage, Fiendbinder,
  // Knight of the Sacred Seal, Scion of Dantalion, Tenebrous Apostate,
  // Witchborn Binder, Nar Demonbinder) all require Binder as their base,
  // so the base-class wiring covers every vestige character. Parallel to
  // INVOCATION_USING_CLASSES / MYSTERY_USING_CLASSES / PSIONIC_CLASSES /
  // MARTIAL_ADEPT_CLASSES; consumed by ensureCasterTab.
  const VESTIGE_USING_CLASSES = new Set([
    'Binder',
  ]);

  // Incarnum meldshaper classes (Magic of Incarnum). These don't get a
  // Spells sub-tab — soulmelds live on the Equipment tab's magic-item
  // slots — but their class_table carries {soulmelds, essentia,
  // chakra_binds} per level, which we copy into the Equipment tab's
  // soulmeld counter fields on apply (populateIncarnumCounts).
  const INCARNUM_CLASSES = new Set([
    'Totemist', 'Incarnate', 'Soulborn',
  ]);

  const _FALLBACK_MANEUVER_ADVANCERS = {
    'Ruby Knight Vindicator': {
      advancingLevels: [2, 4, 6, 8, 10],
      disciplines: ['Devoted Spirit', 'Shadow Hand',
                    'Stone Dragon', 'White Raven'],
    },
    'Jade Phoenix Mage': {
      advancingLevels: [1, 3, 5, 7, 9],
      disciplines: ['Desert Wind', 'Devoted Spirit'],
    },
    'Master of Nine': {
      advancingLevels: [1, 2, 3, 4, 5],
      disciplines: [],  // all 9 disciplines
    },
  };

  // ----------------------------------------------------------------------
  // DB-backed metadata accessors
  //
  // Spellcasting type, caster style, and advancement spec all live on
  // the class/prc entry's `data` blob in the DB (merged at build time
  // by `_class_metadata.py`). These accessors prefer DB data and fall
  // back to the hand-coded maps above for classes that don't have the
  // merged fields yet (defensive — supports loading older DB blobs).
  // ----------------------------------------------------------------------
  const _dbMetaCache = new Map();  // className → { classType, style, advancement }
  let _dbMetaLoaded = false;

  // Normalize a free-form ability name from the DB ("Charisma", "Cha",
  // "CHA") into the 3-letter code consumed by SPELLCASTING_ABILITY users.
  const _ABILITY_TO_CODE = {
    'strength': 'STR', 'str': 'STR',
    'dexterity': 'DEX', 'dex': 'DEX',
    'constitution': 'CON', 'con': 'CON',
    'intelligence': 'INT', 'int': 'INT',
    'wisdom': 'WIS', 'wis': 'WIS',
    'charisma': 'CHA', 'cha': 'CHA',
  };
  function _normalizeAbility(v) {
    if (!v) return '';
    // Array-form (Savant: ["Intelligence", "Wisdom"] — dual-list
    // caster). Return the first normalized code so the existing
    // single-ability consumers (caster panel ability dropdown) get a
    // sensible default. Dual-list-aware consumers can read
    // spellcasting.key_ability_per_list off the DB row directly.
    if (Array.isArray(v)) {
      for (const x of v) {
        const k = String(x).trim().toLowerCase();
        if (_ABILITY_TO_CODE[k]) return _ABILITY_TO_CODE[k];
      }
      return '';
    }
    const k = String(v).trim().toLowerCase();
    return _ABILITY_TO_CODE[k] || '';
  }

  function loadDbMetadata() {
    if (_dbMetaLoaded) return;
    if (!window.DB || !DB.isLoaded()) return; // try again later
    _dbMetaLoaded = true;
    // Pull EVERY class/prc row so we get key_ability / class_skills
    // even for non-casters (Fighter has class_skills too). Filtering
    // is per-field below.
    const rows = DB.query(
      "SELECT name, type AS entry_type, " +
      "json_extract(data, '$.spellcasting.class_type')           AS class_type, " +
      "json_extract(data, '$.spellcasting.style')                 AS style, " +
      "json_extract(data, '$.spellcasting.key_ability')           AS key_ability, " +
      "json_extract(data, '$.spellcasting.bonus_spell_ability')   AS bonus_spell_ability, " +
      "json_extract(data, '$.spellcasting.no_save_dc')            AS no_save_dc, " +
      "json_extract(data, '$.class_skills')                       AS class_skills, " +
      "json_extract(data, '$.advancement')                        AS advancement, " +
      "json_extract(data, '$.maneuver_advancement')               AS maneuver_advancement, " +
      "json_extract(data, '$.invocation_advancement')             AS invocation_advancement, " +
      "json_extract(data, '$.mystery_advancement')                AS mystery_advancement " +
      "FROM entry WHERE type IN ('class','prc')"
    );
    // Base classes advance no one BY DEFAULT (the advancement pillars are a
    // PrC concept). EXCEPTION: the UA caster-race racial paragons genuinely
    // advance the character's existing spellcasting at their 2nd/3rd levels
    // ("gains new spells per day as if she had also gained a level in [her
    // spellcasting class]", UA — book-verified 2026-06-27). Honor THEIR spell
    // pillar; everything else mis-tagged onto a base class still gets dropped.
    const BASE_CLASS_SPELL_ADVANCERS = new Set([
      'Drow Paragon', 'Elf Paragon', 'Gnome Paragon',
      'Half-Elf Paragon', 'Human Paragon',
    ]);
    for (const r of rows) {
      let ct = r.class_type;
      // class_type may be JSON-encoded (array shape: '["arcane","divine"]')
      if (typeof ct === 'string' && ct[0] === '[') {
        try { ct = JSON.parse(ct); } catch (e) { /* keep string */ }
      }
      let adv = null;
      if (r.advancement) {
        try { adv = JSON.parse(r.advancement); } catch (e) { adv = null; }
        if (adv) {
          // Normalize Python snake_case → JS camelCase for picker
          // consumers that already use camelCase.
          adv = {
            types: adv.types,
            advancesAllLevels: !!adv.advances_all_levels,
            nonAdvancingLevels: adv.non_advancing_levels,
            autoAdvanceLowerLevels: adv.auto_advance_lower_levels,
            perLevelChoice: !!adv.per_level_choice,
            requiresStyles: adv.requires_styles,
            allowsMultiAdvance: !!adv.allows_multi_advance,
          };
        }
      }
      let skills = null;
      if (r.class_skills) {
        try { skills = JSON.parse(r.class_skills); } catch (e) { skills = null; }
      }
      let madv = null;
      if (r.maneuver_advancement) {
        try { madv = JSON.parse(r.maneuver_advancement); } catch (e) { madv = null; }
        if (madv) {
          // Normalize Python snake_case → JS camelCase to match the
          // hand-coded fallback shape.
          madv = {
            advancingLevels: madv.advancing_levels || [],
            disciplines: madv.disciplines || [],
          };
        }
      }
      let iadv = null;
      if (r.invocation_advancement) {
        try { iadv = JSON.parse(r.invocation_advancement); } catch (e) { iadv = null; }
        if (iadv) {
          iadv = { advancingLevels: iadv.advancing_levels || [] };
        }
      }
      let mystadv = null;
      if (r.mystery_advancement) {
        try { mystadv = JSON.parse(r.mystery_advancement); } catch (e) { mystadv = null; }
        if (mystadv) {
          mystadv = { advancingLevels: mystadv.advancing_levels || [] };
        }
      }
      // Base-class guard. The four advancement pillars (spell / maneuver /
      // invocation / mystery) each describe a PRESTIGE class advancing some
      // base class's progression — they are PrC-only by definition; a base
      // class advances no one. Drop any pillar that got mis-tagged onto a
      // base class so the "advancer" invariant holds regardless of DB data
      // quality. (The DB metadata generator stapled an arcane `advancement`
      // block onto the Dragonfire Adept / Prestige Bard / Prestige Paladin
      // BASE classes, which made the picker warn "no arcane class to
      // advance" the moment one was selected.)
      if (r.entry_type === 'class') {
        madv = iadv = mystadv = null;   // base classes never advance these
        if (!BASE_CLASS_SPELL_ADVANCERS.has(r.name)) adv = null;  // ...nor spells, except the allowlist
      }
      _dbMetaCache.set(r.name, {
        classType: ct,
        style: r.style,
        advancement: adv,
        maneuverAdvancement: madv,
        invocationAdvancement: iadv,
        mysteryAdvancement: mystadv,
        keyAbility: _normalizeAbility(r.key_ability),
        // Optional override — only set for Favored Soul / Spirit
        // Shaman style classes. Null when bonus spells use the same
        // ability as DCs (the common case).
        bonusSpellAbility: _normalizeAbility(r.bonus_spell_ability),
        // True for classes whose "spells" never allow saves (Artificer
        // infusions). sql.js returns 1/0 for booleans, normalize.
        noSaveDc: !!r.no_save_dc,
        classSkills: Array.isArray(skills) ? skills : null,
      });
    }
  }

  // Public accessors: prefer DB metadata, fall back to hand-coded maps.
  function getClassType(className) {
    loadDbMetadata();
    const m = _dbMetaCache.get(className);
    if (m && m.classType != null) return m.classType;
    return _FALLBACK_SPELLCASTING_TYPE[className] ?? null;
  }
  function getCasterStyle(className) {
    loadDbMetadata();
    const m = _dbMetaCache.get(className);
    if (m && m.style != null) return m.style;
    return _FALLBACK_CASTER_STYLE[className] ?? null;
  }
  function getAdvancementSpec(className) {
    loadDbMetadata();
    const m = _dbMetaCache.get(className);
    if (m && m.advancement) return m.advancement;
    return _FALLBACK_HARDCODED_ADVANCERS[className] ?? null;
  }
  function getManeuverAdvancementSpec(className) {
    loadDbMetadata();
    const m = _dbMetaCache.get(className);
    if (m && m.maneuverAdvancement) return m.maneuverAdvancement;
    return _FALLBACK_MANEUVER_ADVANCERS[className] ?? null;
  }
  function getInvocationAdvancementSpec(className) {
    loadDbMetadata();
    const m = _dbMetaCache.get(className);
    if (m && m.invocationAdvancement) return m.invocationAdvancement;
    return _FALLBACK_INVOCATION_ADVANCERS[className] ?? null;
  }
  function getMysteryAdvancementSpec(className) {
    loadDbMetadata();
    const m = _dbMetaCache.get(className);
    if (m && m.mysteryAdvancement) return m.mysteryAdvancement;
    return _FALLBACK_MYSTERY_ADVANCERS[className] ?? null;
  }
  // True for classes whose "spells" never allow saving throws
  // (Artificer infusions are the canonical case). Consumers should
  // hide / mute the DC column on the spell-tab panel.
  function getNoSaveDc(className) {
    loadDbMetadata();
    const m = _dbMetaCache.get(className);
    if (m && m.noSaveDc) return true;
    return false;
  }
  function getKeyAbility(className) {
    loadDbMetadata();
    const m = _dbMetaCache.get(className);
    if (m && m.keyAbility) return m.keyAbility;
    return SPELLCASTING_ABILITY[className] ?? '';
  }
  // Optional override for classes that use a different ability for
  // bonus spells per day than for save DCs. Returns null for the
  // common case where bonus spells use the same ability as DCs.
  function getBonusSpellAbility(className) {
    loadDbMetadata();
    const m = _dbMetaCache.get(className);
    if (m && m.bonusSpellAbility) return m.bonusSpellAbility;
    return null;
  }
  function getClassSkills(className) {
    loadDbMetadata();
    const m = _dbMetaCache.get(className);
    if (m && m.classSkills) return m.classSkills;
    return CLASS_SKILLS[className] ?? null;
  }

  function babAt(prog, lvl) {
    if (lvl <= 0) return 0;
    const p = (prog || '').toLowerCase();
    if (p.startsWith('good') || p === 'full' || p === 'high') return lvl;
    if (p.startsWith('ave') || p.startsWith('avg') || p.startsWith('mid') ||
        p === 'three-quarters' || p === '3/4') {
      return Math.floor(lvl * 3 / 4);
    }
    if (p.startsWith('poor') || p === 'half' || p === '1/2') return Math.floor(lvl / 2);
    return 0;
  }

  function saveAt(prog, lvl) {
    if (lvl <= 0) return 0;
    const p = (prog || '').toLowerCase();
    if (p.startsWith('good') || p === 'high') return 2 + Math.floor(lvl / 2);
    if (p.startsWith('poor') || p === 'low') return Math.floor(lvl / 3);
    return 0;
  }

  function init() {
    const classInput = document.getElementById('class-lookup');
    const levelInput = document.getElementById('class-lookup-level');
    const applyBtn   = document.getElementById('class-lookup-apply');
    const infoPanel  = document.getElementById('class-info');
    if (!classInput || !levelInput || !applyBtn || !infoPanel) {
      console.warn('[class-picker] picker UI elements not found');
      return;
    }

    // 1. datalist for autocomplete
    let datalist = document.getElementById('class-options');
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = 'class-options';
      classInput.setAttribute('list', 'class-options');
      classInput.setAttribute('autocomplete', 'off');
      classInput.parentElement.appendChild(datalist);
    }

    // 2. Populate options. Prefer 3.5 versions; ties broken by newest
    // publication date so e.g. Player's Handbook II Bard wins over
    // 3.0 reprints when both exist under the same display name.
    function rebuildClassIndex() {
      const rows = DB.query(
        "SELECT e.id AS class_id, e.name AS class, e.type AS entry_type, "
        + "e.version, e.source, "
        + "json_extract(e.data, '$.bab_progression')  AS bab_progression, "
        + "json_extract(e.data, '$.fort_progression') AS fort_progression, "
        + "json_extract(e.data, '$.ref_progression')  AS ref_progression, "
        + "json_extract(e.data, '$.will_progression') AS will_progression, "
        + "json_extract(e.data, '$.table_caption')    AS table_caption, "
        + "json_extract(e.data, '$.variant_of')       AS variant_of "
        + "FROM entry e "
        + "LEFT JOIN book b ON b.name = e.source "
        + "WHERE e.type IN ('class', 'prc') "
        + "ORDER BY e.name, "
        + "         CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, "
        + "         b.publication_date DESC"
      );
      classIndex = new Map();
      for (const r of rows) {
        // r.class is the entry name (aliased above) and r.entry_type is
        // either 'class' or 'prc'. Pass both so allowsEntry's
        // counterpart match keys correctly per entry type.
        if (window.BookFilter && !window.BookFilter.allowsEntry(
          { source: r.source, version: r.version, name: r.class,
            type: r.entry_type })) continue;
        const key = (r.class || '').toLowerCase();
        if (!classIndex.has(key)) classIndex.set(key, []);
        classIndex.get(key).push(r);
      }
      datalist.innerHTML = '';
      // Build datalist (deduped by class name; only show 3.5 entry if present).
      for (const [key, list] of classIndex) {
        const r = list[0];
        const opt = document.createElement('option');
        opt.value = r.class;
        datalist.appendChild(opt);
      }
      console.log(`[class-picker] ${classIndex.size} classes available`);
    }
    rebuildClassIndex();
    document.addEventListener('book-filter-changed', rebuildClassIndex);

    // 3. Live preview as user types/changes inputs.
    const refresh = () => updatePreview(infoPanel, classInput.value, levelInput.value);
    classInput.addEventListener('input', refresh);
    levelInput.addEventListener('input', refresh);
    // Re-render when class customizations change so the strike-through
    // preview reflects added/removed ACFs without a page reload, and
    // re-render the chip list so the per-chip tag badges refresh too.
    document.addEventListener('class-customizations-changed', () => {
      refresh();
      renderClassList();
    });

    // Bloodline-changed: the bloodline contributes a level segment to the
    // Class & Level box (e.g. "… / Fireclaw Bloodline 1"). Rebuild the
    // aggregate so that segment refreshes when the bloodline selection or
    // its slot count changes. Only when classes are picked (the box is
    // ours to rebuild — a manual-entry char-class is left to the user).
    document.addEventListener('bloodline-changed', () => {
      if (pickedClasses.length) applyAggregatesToSheet();
    });

    // Build-timeline-changed: the "current class" is the last class in the
    // timeline, so re-point the class-skill checkboxes + prior markers when
    // the timeline's class order changes (add/remove level, change a level's
    // class). See reconcileCurrentClassSkills.
    document.addEventListener('build-timeline-changed',
      reconcileCurrentClassSkills);

    // 4. Apply button writes calculated values into the sheet.
    applyBtn.addEventListener('click', () => {
      applyToSheet(classInput.value, levelInput.value, infoPanel);
    });

    // 5. Hook into Character save/load for multiclass state persistence.
    // (Already installed at module load — see bottom of file. Calling
    // again is safe — installPersistenceHooks early-returns when the
    // hook is already in place.)
    installPersistenceHooks();

    // 6. Render the chip-list area now so the UA-fractional toggle is
    // visible even before any class is applied.
    renderClassList();
  }

  // ============================================================
  // Multiclass state
  //
  // pickedClasses is the source of truth for the aggregated BAB/saves
  // computation. Each entry carries everything needed to recompute
  // without re-querying the DB. The classInfo (chip list) UI is rendered
  // from this array; char-class textarea is rebuilt from it on every
  // change. Manual edits to BAB / saves / char-class survive (they're
  // not pushed back into pickedClasses), but get overwritten on the
  // next Apply or Remove.
  // ============================================================

  let pickedClasses = [];
  // false = "consolidated" model (PHB RAW summation but applied to grouped
  // progressions, so the +2 good-save base only counts once per save type
  // — no multiclass exploit). true = UA p.73 fractional bonuses.
  let useFractional = false;
  // Gestalt (UA p.72-73): a character carries TWO parallel class tracks
  // ("sides"). pickedClasses is Side A — every existing single-stack code
  // path is unchanged. pickedClassesB is Side B, empty (and inert) unless
  // gestalt mode is on. When `gestalt` is false the sheet behaves
  // byte-identically to the single-stack model.
  let pickedClassesB = [];
  let gestalt = false;
  // Which side the picker's Apply targets while gestalt is on ('A' | 'B').
  // Ignored when gestalt is off (everything is Side A).
  let activeSide = 'A';
  function sideArray(side) {
    return side === 'B' ? pickedClassesB : pickedClasses;
  }
  // Advancement is TRACK-AGNOSTIC in gestalt (UA): an advancer on either side
  // can advance a caster on either side, and class progression sums across
  // both tracks for these purposes. So the entire advancement / spell-refresh
  // subsystem reads classPool() — the UNION of both sides — instead of
  // pickedClasses directly. When gestalt is OFF this returns exactly
  // pickedClasses, so the single-stack path is provably unchanged (every
  // existing advancement test must still pass).
  function classPool() {
    return gestalt ? pickedClasses.concat(pickedClassesB) : pickedClasses;
  }
  // Total CHARACTER level. Gestalt sides are PARALLEL, not additive, so the
  // character level is max(ΣA, ΣB), NOT their sum. Used by the initiator-level
  // "+1/2 of your other levels" math, which would over-count if it summed both
  // tracks. Non-gestalt is the simple sum (unchanged).
  function totalCharacterLevel() {
    const sum = (arr) => arr.reduce((s, e) => s + (e.level || 0), 0);
    return gestalt
      ? Math.max(sum(pickedClasses), sum(pickedClassesB))
      : sum(pickedClasses);
  }
  // Public-API setters (referenced by name from window.ClassPicker so the
  // export object stays a flat brace-free literal).
  function apiSetGestalt(on) {
    gestalt = !!on;
    // Always start on Side A when the gestalt state changes — activeSide is
    // transient UI state and must not leak across characters or toggles
    // (a stale 'B' would silently route the next character's first class to
    // Side B).
    activeSide = 'A';
    applyAggregatesToSheet();
    renderClassList();
  }
  function apiSetActiveSide(s) {
    activeSide = (s === 'B' ? 'B' : 'A');
    renderClassList();
  }

  function findClassEntry(className, arr) {
    const k = String(className).toLowerCase();
    return (arr || pickedClasses).findIndex(e => e.className.toLowerCase() === k);
  }

  // Classify a progression label into "good" | "avg" | "poor" | null.
  function babCategory(prog) {
    const p = (prog || '').toLowerCase();
    if (p.startsWith('good') || p === 'full' || p === 'high') return 'good';
    if (p.startsWith('ave') || p.startsWith('avg') || p.startsWith('mid') ||
        p === 'three-quarters' || p === '3/4') return 'avg';
    if (p.startsWith('poor') || p === 'half' || p === '1/2') return 'poor';
    return null;
  }
  function saveCategory(prog) {
    const p = (prog || '').toLowerCase();
    if (p.startsWith('good') || p === 'high') return 'good';
    if (p.startsWith('poor') || p === 'low')  return 'poor';
    return null;
  }

  // Sum levels by progression category per attribute.
  function levelGroups(entries) {
    const g = {
      bab:  { good: 0, avg: 0, poor: 0 },
      fort: { good: 0, poor: 0 },
      ref:  { good: 0, poor: 0 },
      will: { good: 0, poor: 0 },
    };
    for (const e of entries) {
      const lvl = e.level;
      const bc = babCategory(e.prog.bab);   if (bc) g.bab[bc] += lvl;
      const fc = saveCategory(e.prog.fort); if (fc) g.fort[fc] += lvl;
      const rc = saveCategory(e.prog.ref);  if (rc) g.ref[rc]  += lvl;
      const wc = saveCategory(e.prog.will); if (wc) g.will[wc] += lvl;
    }
    return g;
  }

  // Apply the BAB/save formulas to a level-group structure
  // (`{bab:{good,avg,poor}, fort:{good,poor}, ref, will}`). Shared by the
  // single-stack aggregator AND the gestalt synthesizer so both honor the
  // pooled/fractional toggle identically.
  function totalsFromGroups(g, fractional) {
    let bab = 0, fort = 0, ref = 0, will = 0;
    if (fractional) {
      // UA p.73 fractional: sum fractions per type, then floor once. The
      // "smooth" model.
      bab = Math.floor(g.bab.good + g.bab.avg * 0.75 + g.bab.poor * 0.5);
      const frac = (gg, pp) =>
        Math.floor((gg > 0 ? 2 : 0) + gg * 0.5 + pp / 3);
      fort = frac(g.fort.good, g.fort.poor);
      ref  = frac(g.ref.good,  g.ref.poor);
      will = frac(g.will.good, g.will.poor);
    } else {
      // Pooled-levels model (the common house rule for multiclass
      // saves): sum total levels by progression type, then apply each
      // formula ONCE. Critically, the "+2" flat base bonus on a good
      // save is granted ONCE per save type, not once per class —
      // 7 levels across multiple good-save classes still yields
      // 2 + floor(7/2) = 5, not 14.
      //
      // Strict RAW per-class summation (DMG p.30) would give the +2
      // flat bonus per class with a good save in that type, but in
      // practice that produces save totals that climb unreasonably
      // fast for builds with many same-save classes — so the pooled
      // model is what most tables actually use, and what we render
      // by default. (Use the UA fractional toggle for the
      // smoother-but-strictly-RAW alternative.)
      const babSeg = (n, t) =>
        n <= 0 ? 0 :
        t === 'good' ? n :
        t === 'avg'  ? Math.floor(n * 3 / 4) :
                       Math.floor(n / 2);
      const saveSeg = (n, t) =>
        n <= 0 ? 0 :
        t === 'good' ? 2 + Math.floor(n / 2) : Math.floor(n / 3);
      bab  = babSeg(g.bab.good,  'good') +
             babSeg(g.bab.avg,   'avg')  +
             babSeg(g.bab.poor,  'poor');
      fort = saveSeg(g.fort.good, 'good') + saveSeg(g.fort.poor, 'poor');
      ref  = saveSeg(g.ref.good,  'good') + saveSeg(g.ref.poor,  'poor');
      will = saveSeg(g.will.good, 'good') + saveSeg(g.will.poor, 'poor');
    }
    return { bab, fort, ref, will };
  }

  function aggregateTotals(entries) {
    let lvl = 0;
    for (const e of entries) lvl += e.level;
    const g = levelGroups(entries);
    const t = totalsFromGroups(g, useFractional);
    return { bab: t.bab, fort: t.fort, ref: t.ref, will: t.will, lvl };
  }

  // ── Gestalt synthesis (UA p.72-73) ───────────────────────────────────
  // Expand one side's class stack into a per-character-level array of
  // progression CATEGORIES, walking classes as contiguous blocks in array
  // order (the same level distribution build-timeline's reconstructFromTotals
  // uses). A class with no progression in a category yields null for that
  // level — Savage-Species monster classes have "dead" levels (no Hit Die /
  // no save bump), and null contributes 0 by construction. `betterCat` ranks
  // none BELOW poor so the per-level max falls through to the live side
  // (max(present, null) = present), which is what lets a no-progression-
  // every-level monster class slot in later without an engine change.
  function expandTrack(entries) {
    const out = [];
    for (const e of (entries || [])) {
      const p = e.prog || {};
      const cat = {
        bab:  babCategory(p.bab),
        fort: saveCategory(p.fort),
        ref:  saveCategory(p.ref),
        will: saveCategory(p.will),
      };
      const n = e.level || 0;
      for (let i = 0; i < n; i++) out.push(cat);
    }
    return out;
  }

  const BAB_RANK  = { good: 3, avg: 2, poor: 1 };
  const SAVE_RANK = { good: 2, poor: 1 };
  function betterCat(a, b, rank) {
    const ra = rank[a] || 0, rb = rank[b] || 0;
    if (ra === 0 && rb === 0) return null;
    return ra >= rb ? a : b;
  }

  // Combine two sides per character level — the better category each level —
  // tally into a level-group structure, then apply the SAME pooled/fractional
  // formula as the single-stack path. Because we tally the synthesized
  // per-level categories and run the pooled formula once, a continuous good
  // save yields a SINGLE +2 base (no GitP "+2 per class" double-dip).
  // lvl = max(ΣA, ΣB) — legal gestalt keeps the sides equal; we don't sum.
  function gestaltTotals(sideA, sideB) {
    const ea = expandTrack(sideA), eb = expandTrack(sideB);
    const n = Math.max(ea.length, eb.length);
    const g = {
      bab:  { good: 0, avg: 0, poor: 0 },
      fort: { good: 0, poor: 0 },
      ref:  { good: 0, poor: 0 },
      will: { good: 0, poor: 0 },
    };
    for (let i = 0; i < n; i++) {
      const a = ea[i] || {}, b = eb[i] || {};
      const bab  = betterCat(a.bab,  b.bab,  BAB_RANK);  if (bab)  g.bab[bab]++;
      const fort = betterCat(a.fort, b.fort, SAVE_RANK); if (fort) g.fort[fort]++;
      const ref  = betterCat(a.ref,  b.ref,  SAVE_RANK); if (ref)  g.ref[ref]++;
      const will = betterCat(a.will, b.will, SAVE_RANK); if (will) g.will[will]++;
    }
    const t = totalsFromGroups(g, useFractional);
    return { bab: t.bab, fort: t.fort, ref: t.ref, will: t.will,
             lvl: Math.max(ea.length, eb.length),
             lenA: ea.length, lenB: eb.length };
  }

  function applyAggregatesToSheet() {
    const totals = gestalt
      ? gestaltTotals(pickedClasses, pickedClassesB)
      : aggregateTotals(pickedClasses);
    setNumeric('bab-1',     totals.bab);
    setNumeric('fort-base', totals.fort);
    setNumeric('ref-base',  totals.ref);
    setNumeric('will-base', totals.will);
    // Rebuild #char-class textarea verbatim from entries, then append
    // the bloodline as another level segment, e.g.
    // "Scout 3 / Rogue 2 / Fireclaw Bloodline 1" — UA bloodline levels
    // are real class levels. bloodline.js owns the label + the count
    // (= slots taken in its tracker); empty until ≥1 slot is taken.
    const ta = document.getElementById('char-class');
    if (ta) {
      const fmt = (arr) => arr.map(e => `${e.className} ${e.level}`).join(' / ');
      // Gestalt notation: the two sides joined by " // " (e.g.
      // "Fighter 5 / Rogue 5 // Wizard 10"). Non-gestalt is just Side A.
      let classStr = fmt(pickedClasses);
      if (gestalt) {
        classStr = [classStr, fmt(pickedClassesB)].filter(Boolean).join(' // ');
      }
      const blLabel = (window.Bloodline
        && typeof Bloodline.getClassLevelLabel === 'function')
        ? Bloodline.getClassLevelLabel() : '';
      if (blLabel) classStr = classStr ? `${classStr} / ${blLabel}` : blLabel;
      ta.value = classStr;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // Total Level: only set if user hasn't manually deviated. We track
    // our last-pushed value in a data attribute; if the current value
    // matches it (or is empty), update; otherwise the user has tweaked
    // it (likely to add LA from race) and we leave it alone.
    const tl = document.getElementById('char-level');
    if (tl) {
      const prev = parseInt(tl.dataset.mcComputed || '', 10);
      const cur  = parseInt(tl.value, 10);
      const userTouched = !isNaN(cur) && !isNaN(prev) && cur !== prev;
      if (!tl.value.trim() || !userTouched) {
        tl.value = totals.lvl || '';
        tl.dispatchEvent(new Event('input', { bubbles: true }));
      }
      tl.dataset.mcComputed = String(totals.lvl);
    }
    // XP auto-fill: when the XP field is blank, populate with the
    // minimum XP required for the current total level (PHB Table 3-2:
    // L(L-1)/2 × 1000). Avoids the rebuild-killer where the user
    // forgets to backfill XP after every class apply and the "to next
    // level" display shows nonsense. Respects any explicit user value
    // (even 0) — we only fill the empty case.
    const xp = document.getElementById('char-xp');
    if (xp && !xp.value.trim() && totals.lvl >= 1) {
      const minXp = totals.lvl * (totals.lvl - 1) / 2 * 1000;
      xp.value = String(minXp);
      xp.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return totals;
  }

  // Build the controls cluster shown at the end of the Side A row: the UA
  // fractional toggle, the Gestalt toggle, and (when gestalt) the Side A/B
  // "Apply to" selector. Always rendered, even with no classes applied, so
  // the toggles are reachable before the first Apply.
  function buildClassControls() {
    const wrap = document.createElement('span');
    wrap.style.cssText =
      'margin-left:auto; display:inline-flex; gap:0.9rem; align-items:center; ' +
      'flex-wrap:wrap; font-size:0.8em; opacity:0.9;';

    // Gestalt toggle.
    const gWrap = document.createElement('label');
    gWrap.style.cssText =
      'cursor:pointer; display:inline-flex; gap:0.25rem; align-items:center;';
    gWrap.title =
      'Gestalt (UA p.72-73): the character has two parallel class tracks ' +
      '(Side A / Side B). Each level takes the better of the two for BAB, ' +
      'saves, HD and skills, and gains every class feature of both. Turning ' +
      'this on reveals a Side B row and an "Apply to" selector.';
    const gInput = document.createElement('input');
    gInput.type = 'checkbox';
    gInput.id = 'mc-gestalt';
    gInput.checked = gestalt;
    gInput.addEventListener('change', () => {
      gestalt = gInput.checked;
      activeSide = 'A';   // reset on any toggle (see apiSetGestalt)
      applyAggregatesToSheet();
      renderClassList();
      if (typeof window.recalcAll === 'function') {
        try { window.recalcAll(); } catch (e) { /* non-fatal */ }
      }
    });
    gWrap.appendChild(gInput);
    gWrap.appendChild(document.createTextNode(' Gestalt'));
    wrap.appendChild(gWrap);

    // UA fractional toggle.
    const fracWrap = document.createElement('label');
    fracWrap.style.cssText =
      'cursor:pointer; display:inline-flex; gap:0.25rem; align-items:center;';
    fracWrap.title =
      'When checked, BAB and saves use the Unearthed Arcana p.73 ' +
      'fractional base bonus rules (fractions per level summed across ' +
      'all classes, then floored). When unchecked, the consolidated PHB ' +
      'model is used: levels are grouped by progression type per save / ' +
      'per BAB tier, then the formula is applied once per group (so the ' +
      '+2 good-save base only counts once per save). Applies to the ' +
      'gestalt synthesis too.';
    const fracInput = document.createElement('input');
    fracInput.type = 'checkbox';
    fracInput.id = 'mc-use-fractional';
    fracInput.checked = useFractional;
    fracInput.addEventListener('change', () => {
      useFractional = fracInput.checked;
      if (pickedClasses.length || pickedClassesB.length) {
        applyAggregatesToSheet();
        if (typeof window.recalcAll === 'function') {
          try { window.recalcAll(); } catch (e) { /* non-fatal */ }
        }
      }
    });
    fracWrap.appendChild(fracInput);
    fracWrap.appendChild(document.createTextNode(' UA fractional (p.73)'));
    wrap.appendChild(fracWrap);

    // Side selector (gestalt only): which side the Apply button targets.
    if (gestalt) {
      const selWrap = document.createElement('span');
      selWrap.style.cssText =
        'display:inline-flex; gap:0.3rem; align-items:center;';
      selWrap.appendChild(document.createTextNode('Apply to:'));
      for (const s of ['A', 'B']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mc-side-btn';
        b.dataset.side = s;
        b.textContent = `Side ${s}`;
        const on = activeSide === s;
        b.style.cssText =
          'cursor:pointer; font-size:0.95em; padding:0.1rem 0.5rem; ' +
          'border-radius:3px; color:inherit; ' +
          'border:1px solid ' + (on ? '#6a8aaa' : '#555') + '; ' +
          'background:' + (on ? 'rgba(106,138,170,0.35)' : 'transparent') + ';';
        b.addEventListener('click', () => { activeSide = s; renderClassList(); });
        selWrap.appendChild(b);
      }
      wrap.appendChild(selWrap);
    }
    return wrap;
  }

  // Render one side's chip row into listEl. `side` is 'A' | 'B' in gestalt
  // mode (drives the row label + which array a chip's × removes from) or
  // null for the single-stack "Applied:" row. `withAdvancers` gates the
  // advance-target choosers — Side A only in Phase 1 (the spell-advancement
  // subsystem is Side-A-scoped; see notes).
  function renderChipRow(listEl, entries, side, withAdvancers) {
    const label = document.createElement('span');
    label.textContent = side ? `Side ${side}:` : 'Applied:';
    label.style.cssText = 'font-size:0.85em; opacity:0.7';
    listEl.appendChild(label);

    const custByClass = collectCustomizationsByClass();
    for (const e of entries) {
      const chip = document.createElement('span');
      chip.className = 'mc-class-chip';
      chip.dataset.class = e.className;
      chip.style.cssText =
        'background:rgba(106,138,170,0.2); padding:0.15rem 0.5rem; ' +
        'border-radius:3px; font-size:0.85em; ' +
        'display:inline-flex; gap:0.35rem; align-items:center;';
      const txt = document.createElement('span');
      txt.textContent = `${e.className} ${e.level}`;
      chip.appendChild(txt);
      const custs = custByClass.get(e.className.toLowerCase()) || [];
      for (const c of custs) {
        const tag = document.createElement('span');
        tag.className = 'mc-chip-tag';
        tag.textContent = shortenVariantName(c);
        tag.title = `${c.kind}: ${c.name}${c.race ? ' — ' + c.race : ''}` +
          (c.replaces ? `\nReplaces: ${c.replaces}` : '');
        chip.appendChild(tag);
      }
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.title = `Remove ${e.className}`;
      x.style.cssText =
        'background:transparent; border:0; color:#c88; cursor:pointer; ' +
        'font-size:1.1em; padding:0; line-height:1;';
      x.addEventListener('click', () => removeClass(e.className, side));
      chip.appendChild(x);
      listEl.appendChild(chip);
    }

    if (withAdvancers) renderAdvancerChoosers(listEl);
  }

  function renderClassList() {
    const infoPanel = document.getElementById('class-info');
    if (!infoPanel) return;
    let list = document.getElementById('mc-classes-list');
    if (!list) {
      list = document.createElement('div');
      list.id = 'mc-classes-list';
      list.style.cssText =
        'display:flex; gap:0.4rem; flex-wrap:wrap; align-items:center; ' +
        'margin-top:0.25rem; min-height:1.6rem;';
      infoPanel.parentElement.insertBefore(list, infoPanel);
    }
    // Side B row lives directly beneath Side A; created lazily, hidden when
    // gestalt is off so the non-gestalt layout is unchanged.
    let listB = document.getElementById('mc-classes-list-b');
    if (!listB) {
      listB = document.createElement('div');
      listB.id = 'mc-classes-list-b';
      listB.style.cssText =
        'display:flex; gap:0.4rem; flex-wrap:wrap; align-items:center; ' +
        'margin-top:0.25rem; min-height:1.6rem;';
      list.parentElement.insertBefore(listB, list.nextSibling);
    }
    list.innerHTML = '';
    listB.innerHTML = '';
    listB.style.display = gestalt ? 'flex' : 'none';

    const controls = buildClassControls();

    // Nothing applied on either side → just the controls (so Gestalt /
    // fractional toggles are reachable from a fresh sheet).
    if (!pickedClasses.length && !pickedClassesB.length) {
      list.appendChild(controls);
      return;
    }

    // Side A — labeled "Side A:" in gestalt, "Applied:" otherwise. Advancer
    // choosers render here, but are sourced from the UNION of both sides
    // (track-agnostic), so a Side-B advancer's chooser appears here too.
    renderChipRow(list, pickedClasses, gestalt ? 'A' : null, true);

    // Side B — gestalt only, no advancer choosers (see renderChipRow note).
    if (gestalt) {
      renderChipRow(listB, pickedClassesB, 'B', false);
      const t = gestaltTotals(pickedClasses, pickedClassesB);
      if (t.lenA !== t.lenB) {
        const note = document.createElement('span');
        note.style.cssText =
          'flex:1 1 100%; font-size:0.8em; color:#c9a85a; ' +
          'padding:0.15rem 0.3rem;';
        note.textContent =
          `⚠ Sides uneven (A=${t.lenA}, B=${t.lenB}). Legal gestalt keeps ` +
          `both sides at the same level; stats use the higher (${t.lvl}).`;
        listB.appendChild(note);
      }
    }

    // Clear All clears BOTH sides; shown once total ≥ 2.
    if (pickedClasses.length + pickedClassesB.length >= 2) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.textContent = 'Clear All';
      clear.title = 'Remove all applied classes (both sides)';
      clear.style.cssText =
        'background:transparent; border:1px solid #844; color:#c88; ' +
        'cursor:pointer; font-size:0.8em; padding:0.1rem 0.4rem; ' +
        'border-radius:3px; margin-left:0.3rem;';
      clear.addEventListener('click', clearAllClasses);
      list.appendChild(clear);
    }
    list.appendChild(controls);

    // Auto-apply class-granted FIXED bonus feats (Track / Endurance /
    // Scribe Scroll / …) into the Feats tab. Reconcile-idempotent +
    // derived (not persisted), so running it on every class-list render
    // covers apply, remove, load, and the DB-ready re-resolution
    // uniformly — same model as bloodline.syncBonusFeats.
    syncClassBonusFeats();
  }

  // Render per-advancer target choosers. Inserts a row below the chip
  // list for each advancer that needs UI:
  //   - Simple advancer with ≥2 eligible targets: a <select> per type.
  //   - perLevelChoice advancer (Ultimate Magus): one row per advancing
  //     PrC level, with checkboxes for prepared and spontaneous slots.
  function renderAdvancerChoosers(listEl) {
    // Union: advancers on EITHER gestalt side get a chooser (track-agnostic).
    const advancers = classPool().filter(e =>
      e.advancesTypes && e.advancesTypes.length);
    if (!advancers.length) return;

    for (const adv of advancers) {
      if (adv.perLevelChoice) {
        renderPerLevelChooser(listEl, adv);
      } else {
        renderSimpleChooser(listEl, adv);
        renderSimpleWarnings(listEl, adv);
      }
    }
  }

  // For classic (non-perLevel) advancers, render a ⚠ warning row whenever
  // ANY of the entry's advancesTypes has no eligible target in
  // pickedClasses. Catches the case of e.g. Mystic Theurge applied
  // without a divine caster — the picker silently dropped that
  // advancement before, with no UI feedback.
  function renderSimpleWarnings(listEl, adv) {
    const issues = [];
    for (let i = 0; i < (adv.advancesTypes || []).length; i++) {
      const t = adv.advancesTypes[i];
      const tgt = (adv.advancesTargets || [])[i];
      const eligible = eligibleTargetsForType(adv, t);
      if (!tgt && !eligible.length) {
        const typeLabel = t === 'any' ? 'spellcasting' : t;
        issues.push(
          `no ${typeLabel} class to advance — add one to enable this`
        );
      }
    }
    if (!issues.length) return;
    const row = document.createElement('div');
    row.className = 'mc-advance-warning';
    row.style.cssText =
      'flex:1 1 100%; font-size:0.82em; color:#c88; ' +
      'padding:0.2rem 0.4rem; background:rgba(170, 80, 80, 0.08); ' +
      'border-left:2px solid #844; border-radius:0 3px 3px 0;';
    row.textContent =
      `⚠ ${adv.className} ${adv.level}: ${issues.join('; ')}.`;
    listEl.appendChild(row);
  }

  function eligibleTargetsForType(advancerEntry, typeStr) {
    // Union: a Side-A advancer can target a Side-B caster and vice versa.
    return classPool().filter(e => {
      if (e === advancerEntry) return false;
      if (!e.classId) return false;
      const t = getClassType(e.className);
      if (t == null) return false;
      const ts = Array.isArray(t) ? t : [t];
      return typeStr === 'any' || ts.includes(typeStr);
    });
  }

  function renderSimpleChooser(listEl, adv) {
    // Only render if at least one type has ≥2 eligible targets.
    const ambiguous = adv.advancesTypes.some(t =>
      eligibleTargetsForType(adv, t).length >= 2);
    if (!ambiguous) return;
    const row = document.createElement('div');
    row.className = 'mc-advance-row';
    row.style.cssText =
      'flex:1 1 100%; font-size:0.82em; opacity:0.9; ' +
      'display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center; ' +
      'padding:0.15rem 0.4rem; background:rgba(255,255,255,0.03); ' +
      'border-left:2px solid #6a8aaa; border-radius:0 3px 3px 0;';
    const label = document.createElement('span');
    label.textContent = `${adv.className} ${adv.level} advances:`;
    label.style.cssText = 'opacity:0.7;';
    row.appendChild(label);
    for (let i = 0; i < adv.advancesTypes.length; i++) {
      const t = adv.advancesTypes[i];
      const opts = eligibleTargetsForType(adv, t);
      if (opts.length < 2) continue;
      const sel = document.createElement('select');
      sel.style.cssText =
        'background:#1a1f29; color:#eef; border:1px solid #44516a; ' +
        'border-radius:3px; padding:0.05rem 0.3rem; font:inherit; font-size:1em;';
      sel.title = `Which ${t} class should ${adv.className} advance?`;
      for (const o of opts) {
        const opt = document.createElement('option');
        opt.value = o.className;
        opt.textContent = `${o.className} (${t})`;
        if (adv.advancesTargets && adv.advancesTargets[i] === o.className) {
          opt.selected = true;
        }
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => {
        const next = (adv.advancesTargets || []).slice();
        while (next.length <= i) next.push(null);
        next[i] = sel.value;
        adv.advancesTargets = next;
        refreshAllSpellTabs();
        renderClassList();
      });
      row.appendChild(sel);
    }
    listEl.appendChild(row);
  }

  function renderPerLevelChooser(listEl, adv) {
    const wrap = document.createElement('div');
    wrap.className = 'mc-advance-perlevel';
    wrap.style.cssText =
      'flex:1 1 100%; font-size:0.82em; ' +
      'padding:0.4rem 0.6rem; background:rgba(255,255,255,0.03); ' +
      'border-left:2px solid #6a8aaa; border-radius:0 3px 3px 0; ' +
      'display:grid; grid-template-columns:auto 1fr; gap:0.2rem 0.6rem; ' +
      'align-items:center;';
    const header = document.createElement('div');
    header.style.cssText = 'grid-column:1 / -1; opacity:0.7;';
    header.textContent =
      `${adv.className} ${adv.level} — per-level advancement` +
      (adv.requiresStyles
        ? ` (requires ${adv.requiresStyles.join(' + ')} arcane casters)`
        : '');
    wrap.appendChild(header);

    // Gather candidate targets per slot. UM: prepared and spontaneous
    // arcane casters. Generic: any class matching adv.advancesTypes.
    const primaryType = adv.advancesTypes[0];
    const candidates = eligibleTargetsForType(adv, primaryType);
    // Warn if requiresStyles isn't met.
    if (adv.requiresStyles) {
      const have = new Set(candidates
        .map(c => getCasterStyle(c.className))
        .filter(Boolean));
      const missing = adv.requiresStyles.filter(s => !have.has(s));
      if (missing.length) {
        const warn = document.createElement('div');
        warn.style.cssText =
          'grid-column:1 / -1; color:#c88; font-size:0.92em; ' +
          'padding:0.2rem 0; border-bottom:1px dashed #844;';
        warn.textContent =
          `⚠ Missing ${missing.join(' + ')} arcane class — ` +
          `${adv.className}'s advancement is incomplete until you add one.`;
        wrap.appendChild(warn);
      }
    }

    for (const slot of (adv.advancementSlots || [])) {
      const lvLbl = document.createElement('span');
      lvLbl.textContent = `L${slot.prcLevel}:`;
      lvLbl.style.cssText = 'text-align:right; opacity:0.7;';
      wrap.appendChild(lvLbl);
      const slotRow = document.createElement('span');
      slotRow.style.cssText = 'display:inline-flex; flex-wrap:wrap; gap:0.5rem; align-items:center;';
      if (slot.kind === 'auto-lower') {
        renderAutoLowerSlot(slotRow, adv, slot, candidates);
      } else {
        renderChoiceSlot(slotRow, adv, slot, candidates);
      }
      wrap.appendChild(slotRow);
    }
    listEl.appendChild(wrap);
  }

  // Render a choice slot: checkboxes (or radios) for each eligible
  // target, filtered by requiresStyles.
  function renderChoiceSlot(rowEl, adv, slot, candidates) {
    for (const cand of candidates) {
      const style = getCasterStyle(cand.className);
      // Skip candidates that don't satisfy requiresStyles, IF set.
      if (adv.requiresStyles && style &&
          !adv.requiresStyles.includes(style)) continue;
      const label = document.createElement('label');
      label.style.cssText =
        'display:inline-flex; align-items:center; gap:0.2rem; cursor:pointer;';
      const cb = document.createElement('input');
      cb.type = adv.allowsMultiAdvance ? 'checkbox' : 'radio';
      cb.name = `mc-slot-${adv.className}-${slot.prcLevel}`;
      cb.value = cand.className;
      cb.checked = (slot.targets || []).includes(cand.className);
      cb.addEventListener('change', () => {
        let next = (slot.targets || []).slice();
        if (adv.allowsMultiAdvance) {
          if (cb.checked) {
            if (!next.includes(cand.className)) next.push(cand.className);
          } else {
            next = next.filter(t => t !== cand.className);
          }
        } else {
          next = cb.checked ? [cand.className] : [];
        }
        slot.targets = next;
        refreshAllSpellTabs();
        renderClassList();  // re-render to refresh auto-lower resolution
      });
      label.appendChild(cb);
      const txt = document.createTextNode(
        ` ${cand.className}${style ? ` (${style[0]})` : ''}`
      );
      label.appendChild(txt);
      rowEl.appendChild(label);
    }
  }

  // Render an auto-lower slot: shows the auto-picked target (read-only),
  // plus a tiebreaker dropdown if there's a tie.
  function renderAutoLowerSlot(rowEl, adv, slot, candidates) {
    const auto = (slot.targets || [])[0];
    const tag = document.createElement('span');
    tag.style.cssText =
      'display:inline-flex; align-items:center; gap:0.3rem; ' +
      'padding:0.05rem 0.4rem; background:rgba(106,138,170,0.15); ' +
      'border:1px dashed #44516a; border-radius:3px;';
    const autoLabel = document.createElement('span');
    autoLabel.style.cssText = 'opacity:0.7; font-size:0.92em;';
    autoLabel.textContent = 'auto (lower):';
    tag.appendChild(autoLabel);
    if (slot.tiedOptions && slot.tiedOptions.length > 1) {
      // Tie — render a small selector for the user's preference.
      const sel = document.createElement('select');
      sel.style.cssText =
        'background:#1a1f29; color:#eef; border:1px solid #44516a; ' +
        'border-radius:3px; padding:0 0.3rem; font:inherit; font-size:1em;';
      sel.title = 'Tiebreak: which class to advance when both are equal';
      for (const opt of slot.tiedOptions) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        if (opt === auto) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => {
        slot.tieBreaker = sel.value;
        refreshAllSpellTabs();
        renderClassList();
      });
      tag.appendChild(sel);
      const note = document.createElement('span');
      note.style.cssText = 'opacity:0.6; font-size:0.85em;';
      note.textContent = '(tied)';
      tag.appendChild(note);
    } else {
      const tgt = document.createElement('b');
      tgt.textContent = auto || '—';
      tag.appendChild(tgt);
    }
    rowEl.appendChild(tag);
  }

  function removeClass(className, side) {
    // Locate the entry in the requested side, or search A then B when the
    // caller doesn't specify (e.g. external callers / non-gestalt chips).
    let arr, idx;
    if (side === 'B') { arr = pickedClassesB; idx = findClassEntry(className, arr); }
    else if (side === 'A') { arr = pickedClasses; idx = findClassEntry(className, arr); }
    else {
      idx = findClassEntry(className, pickedClasses);
      if (idx >= 0) { arr = pickedClasses; }
      else { arr = pickedClassesB; idx = findClassEntry(className, arr); }
    }
    if (idx < 0) return;
    const removed = arr.splice(idx, 1)[0];

    // Gestalt: a class can sit on BOTH sides. Its features / skills / spell
    // panels are the union, so only tear them down when NO remaining side
    // still grants this class. The monster-ext subtraction below is keyed
    // to the removed ENTRY (not the name), so it always runs.
    const otherArr = arr === pickedClasses ? pickedClassesB : pickedClasses;
    const stillGranted = findClassEntry(className, otherArr) >= 0;

    if (!stillGranted) {
    // Strip this class's Special Abilities entries.
    document
      .querySelectorAll(`[data-from-class="${cssEscape(className)}"]`)
      .forEach(node => {
        const row = node.closest('.feat-row');
        if (row) row.remove();
      });

    // Remove this class's spells tab(s) if any. Must mirror the set of
    // sub-tab types ensureCasterTab can auto-create, or removing the
    // class orphans its tab (e.g. a removed Warlock leaving a stray
    // Invocations tab).
    for (const type of ['spellcasting', 'psionics', 'maneuvers',
                        'invocations', 'binding', 'shadowcaster']) {
      const panel = findExistingCasterPanel(type, className);
      if (!panel) continue;
      // A race-owned racial-initiation panel that this class merged into
      // stays put when the class is removed — the racial pass (in
      // refreshAllManeuverTabs, fired below) reverts its IL to the racial base.
      if (panel.dataset.fromRace) continue;
      const casterIdx = panel.id.replace(/^caster-/, '');
      const tabBtn = document.querySelector(
        `#spells-tab-bar .inner-tab[data-caster-idx="${casterIdx}"]`
      );
      if (tabBtn) tabBtn.remove();
      panel.remove();
    }
    } // end !stillGranted teardown

    // Drop advances pointing at the removed class so the chip-list and
    // refreshAllSpellTabs no longer try to advance a class that's gone.
    // Both sides' entries are scanned (advances live on whichever side
    // carries the advancing PrC).
    const removedKey = className.toLowerCase();
    for (const e of pickedClasses.concat(pickedClassesB)) {
      if (e.advancesTargets) {
        e.advancesTargets = e.advancesTargets.map(t =>
          t && t.toLowerCase() === removedKey ? null : t);
      }
      // (ToB maneuver pillar needs no per-target cleanup — IL is computed
      // live from the registry + the current pickedClasses, all-target.)
      // Invocation pillar — same pattern.
      if (e.invocationAdvancesTarget &&
          e.invocationAdvancesTarget.toLowerCase() === removedKey) {
        e.invocationAdvancesTarget = null;
      }
      // Mystery pillar — same pattern.
      if (e.mysteryAdvancesTarget &&
          e.mysteryAdvancesTarget.toLowerCase() === removedKey) {
        e.mysteryAdvancesTarget = null;
      }
    }

    // Name-keyed teardown — skipped when the other side still grants this
    // class (union semantics), so removing Side-A Fighter doesn't strip the
    // Fighter features Side B still provides.
    if (!stillGranted) {
      // Strip class-granted freebie spells (Sand Shaper's Desert
      // Insight, etc.) added to any spellcasting panel's Known list.
      // We identify them by their `data-source` attribute, which
      // class-spell-additions.js prefixes with "<className> — ".
      removeClassGrantedSpells(className);

      // Clear Class Features tab fields that were auto-filled by
      // populateClassFeaturesTab for this class. `data-from-class`
      // is set when the field was empty at apply time; the user-edit
      // listener clears the marker if the user types in the field,
      // so we won't blow away any manual customizations.
      removeAutoFilledClassFeatureFields(className);
      // Strip ACFs / sub levels that targeted this class — they're
      // tied to the class and have no meaning once it's removed. Per-
      // customization notes the user wrote go with them; if you want
      // to preserve those, re-apply the class first then remove
      // individual customizations from the list.
      if (typeof ClassFeatures !== 'undefined' &&
          typeof ClassFeatures.removeCustomizationsForClass === 'function') {
        ClassFeatures.removeCustomizationsForClass(className);
      }
      // Untick class-skill checkboxes whose ONLY remaining source was
      // this class. Boxes claimed by other applied classes stay ticked.
      removeClassSkills(className);
    }
    // Subtract monster-class extensions (ability bumps + NA + size)
    // that this class applied. Stored on the removed entry by
    // applyMonsterClassExtensions on the original apply; no-op for
    // non-monster classes. Keyed to the removed ENTRY, so always runs.
    removeMonsterClassExtensions(removed);
    reconcileCurrentClassSkills();
    applyAggregatesToSheet();
    refreshAllSpellTabs();
    renderClassList();
    if (typeof window.recalcAll === 'function') {
      try { window.recalcAll(); } catch (e) { /* non-fatal */ }
    }
    // Same cross-module event as applyClass — see comment there.
    try {
      document.dispatchEvent(new CustomEvent('classes-changed', {
        detail: { state: pickedClasses.slice() },
      }));
    } catch (e) { /* non-fatal */ }
  }

  function clearAllClasses() {
    const total = pickedClasses.length + pickedClassesB.length;
    if (!total) return;
    if (!confirm(`Remove all ${total} applied classes?`)) return;
    // Remove each class via the normal path so spells tabs + special
    // abilities get cleaned up consistently. We snapshot the name list
    // BEFORE the loop because each removeClass() mutates pickedClasses
    // (and re-renders the chip list, which would otherwise re-bind the
    // Clear All button to fresh state mid-iteration). The defensive
    // try/catch ensures a single failed removal doesn't strand the
    // remaining classes — previously, an exception in any class's
    // removal path would short-circuit the loop, leaving the rest
    // applied (reported 2026-05-16 as "Clear All removes one at a
    // time").
    // Snapshot per side (removeClass mutates the arrays) and remove from the
    // explicit side so a class shared across both sides clears from each.
    const aNames = pickedClasses.map(e => e.className);
    const bNames = pickedClassesB.map(e => e.className);
    for (const n of aNames) {
      try { removeClass(n, 'A'); }
      catch (err) { console.warn('[class-picker] removeClass failed for', n, err); }
    }
    for (const n of bNames) {
      try { removeClass(n, 'B'); }
      catch (err) { console.warn('[class-picker] removeClass failed for', n, err); }
    }
  }

  // ============================================================
  // Creature-as-race racial Hit Dice (synthetic class rows)
  //
  // A creature picked as a playable race (via creature-race-picker.js)
  // can carry racial Hit Dice — real HD that sit BEFORE class levels and
  // contribute their own BAB / saves / total level. We model them as a
  // synthetic pickedClasses entry (`racialHD: true`) carrying the BAB/save
  // PROGRESSION LABELS for the creature type (from data.js
  // `creatureTypeToProg`), so they pool through the exact same aggregate
  // math as any class. The entry has NO DB classId/source/monsterExt:
  //  - ability mods / natural armor / size are applied by the
  //    creature-race-picker's adjustment layer (the race-column writes),
  //    NOT via monsterExt — so they're never double-counted here.
  //  - prog is persisted DIRECTLY in the save (synthetic rows can't be
  //    rehydrated from the DB class table — see the load branch below).
  // At most one racial-HD row exists at a time (one creature-race).
  // ============================================================

  function addRacialHD(meta) {
    if (!meta || !meta.creatureRace || !meta.count || !meta.prog) return null;
    const className = `${meta.creatureRace} (racial HD)`;
    // Drop any prior racial-HD row first (only one creature-race active) —
    // from BOTH sides, since the previous one may have landed on either.
    for (const arr of [pickedClasses, pickedClassesB]) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].racialHD) arr.splice(i, 1);
      }
    }
    // Gestalt: racial HD lands on the active side (you gestalt a creature's
    // racial HD against a class on the other track). Its prog feeds the
    // synthesis like any class; its ability/NA/size adjustments are applied
    // character-global by the creature-race-picker, not per side.
    const target = gestalt ? sideArray(activeSide) : pickedClasses;
    target.push({
      className,
      level: meta.count,
      racialHD: true,
      creatureRace: meta.creatureRace,
      creatureType: meta.creatureType || null,
      prog: {
        bab:  meta.prog.bab,
        fort: meta.prog.fort,
        ref:  meta.prog.ref,
        will: meta.prog.will,
      },
    });
    applyAggregatesToSheet();
    renderClassList();
    if (typeof window.recalcAll === 'function') {
      try { window.recalcAll(); } catch (e) { /* non-fatal */ }
    }
    try {
      document.dispatchEvent(new CustomEvent('classes-changed', {
        detail: { state: pickedClasses.slice() },
      }));
    } catch (e) { /* non-fatal */ }
    return className;
  }

  // Remove the synthetic racial-HD row. With no argument, removes
  // whichever racial-HD row is present (there's only ever one). Routes
  // through removeClass so aggregates + chip list + recalc all refresh;
  // the class-specific cleanup in removeClass no-ops for a synthetic row
  // (no DB class to match for skills / granted spells / monsterExt).
  function removeRacialHD(creatureRace) {
    if (!creatureRace) {
      // Union — the racial-HD row may sit on either gestalt side.
      const found = classPool().find(e => e.racialHD);
      if (found) removeClass(found.className);  // removeClass searches both sides
      return;
    }
    removeClass(`${creatureRace} (racial HD)`);
  }

  // Double-count guard for creature-race-picker: true when a Savage
  // Species monster CLASS for the same creature is already applied
  // (those carry monsterExt + their own class_table HD, so layering the
  // creature-as-race racial HD on top would count the HD/abilities
  // twice). Matched by class name == creature name (case-insensitive).
  function hasMonsterClassFor(creatureName) {
    if (!creatureName) return false;
    const k = String(creatureName).toLowerCase();
    // Union — a monster class for this creature on EITHER side should
    // suppress layering creature-as-race racial HD on top of it.
    return classPool().some(e =>
      !e.racialHD && e.monsterExt &&
      e.className.toLowerCase() === k);
  }

  // ============================================================
  // Save / Load persistence
  //
  // Monkey-patch Character.collectData / loadData. On save, append
  // `_multiclass` with the current state. On load, restore the array
  // and re-render the chip list, but DO NOT recompute aggregates — the
  // saved BAB/saves are authoritative (so manual edits survive).
  //
  // Gestalt: Side A persists as `_multiclass` exactly as before; Side B
  // (when gestalt is on) persists as the parallel `_multiclassB`, plus a
  // `_gestalt: true` flag. Both arrays use the SAME stub-mapping and
  // hydration helpers below, so Side B inherits every save-stability
  // property (name+source resolution, racial-HD reconstruction, the
  // advancement pillars). Old saves carry neither key → gestalt off,
  // Side B empty, behavior byte-identical.
  // ============================================================

  // Serialize one picked-class entry to its compact save stub. Strips the
  // prog object (rehydrated from the DB on load) except for synthetic
  // racial-HD rows, which have no DB class and carry prog directly.
  function mapEntryToStub(e) {
    return {
      className: e.className, level: e.level,
      classId:   e.classId,   version: e.version,
      source:    e.source,
      advancesTypes:   e.advancesTypes,
      advancesLevels:  e.advancesLevels,
      advancesTargets: e.advancesTargets,
      perLevelChoice:         e.perLevelChoice,
      advancingLevels:        e.advancingLevels,
      autoAdvanceLowerLevels: e.autoAdvanceLowerLevels,
      requiresStyles:         e.requiresStyles,
      allowsMultiAdvance:     e.allowsMultiAdvance,
      advancementSlots:       e.advancementSlots,
      invocationAdvancesLevels:  e.invocationAdvancesLevels,
      invocationAdvancesTarget:  e.invocationAdvancesTarget,
      invocationAdvancingLevels: e.invocationAdvancingLevels,
      mysteryAdvancesLevels:  e.mysteryAdvancesLevels,
      mysteryAdvancesTarget:  e.mysteryAdvancesTarget,
      mysteryAdvancingLevels: e.mysteryAdvancingLevels,
      monsterExt: e.monsterExt,
      racialHD:     e.racialHD || undefined,
      creatureRace: e.creatureRace || undefined,
      creatureType: e.creatureType || undefined,
      prog:         e.racialHD ? e.prog : undefined,
    };
  }

  // Reconstruct one picked-class entry from its save stub. Three branches:
  // synthetic racial-HD (no DB lookup), DB-resolution failure (preserved
  // as `_unhydrated` so save round-trips it forward), and the normal
  // name+source-resolved class. Used for BOTH sides.
  function hydrateStub(stub) {
    // Synthetic racial-HD rows (creature-as-race) carry their own prog and
    // have no DB class — reconstruct directly, before any DB lookup.
    if (stub.racialHD) {
      return {
        className: stub.className,
        level: stub.level,
        racialHD: true,
        creatureRace: stub.creatureRace,
        creatureType: stub.creatureType || null,
        prog: stub.prog ||
          { bab: null, fort: null, ref: null, will: null },
      };
    }
    // Resolve by name+source FIRST (entry.id renumbers on DB rebuild).
    const cls = resolveMulticlassStub(stub);
    if (!cls) {
      // Preserve the stub so save doesn't drop it. prog missing → recalc
      // skipped per the "saved BAB/saves are authoritative" rule.
      return {
        className: stub.className,
        level: stub.level,
        classId: stub.classId,
        source: stub.source,
        version: stub.version,
        prog: { bab: null, fort: null, ref: null, will: null },
        _unhydrated: true,
        advancesTypes:   stub.advancesTypes   || undefined,
        advancesLevels:  stub.advancesLevels  || undefined,
        advancesTargets: stub.advancesTargets || undefined,
        perLevelChoice:         stub.perLevelChoice         || undefined,
        advancingLevels:        stub.advancingLevels        || undefined,
        autoAdvanceLowerLevels: stub.autoAdvanceLowerLevels || undefined,
        requiresStyles:         stub.requiresStyles         || undefined,
        allowsMultiAdvance:     stub.allowsMultiAdvance     || undefined,
        advancementSlots:       stub.advancementSlots       || undefined,
        invocationAdvancesLevels:  stub.invocationAdvancesLevels  || undefined,
        invocationAdvancesTarget:  stub.invocationAdvancesTarget  || undefined,
        invocationAdvancingLevels: stub.invocationAdvancingLevels || undefined,
        mysteryAdvancesLevels:  stub.mysteryAdvancesLevels  || undefined,
        mysteryAdvancesTarget:  stub.mysteryAdvancesTarget  || undefined,
        mysteryAdvancingLevels: stub.mysteryAdvancingLevels || undefined,
        monsterExt: stub.monsterExt || undefined,
      };
    }
    return {
      className: cls.class || stub.className,
      level: stub.level,
      classId: cls.class_id,
      source: cls.source || stub.source,
      version: cls.version || stub.version,
      prog: {
        bab:  cls.bab_progression,
        fort: cls.fort_progression,
        ref:  cls.ref_progression,
        will: cls.will_progression,
      },
      advancesTypes:   stub.advancesTypes   || undefined,
      advancesLevels:  stub.advancesLevels  || undefined,
      advancesTargets: stub.advancesTargets || undefined,
      perLevelChoice:         stub.perLevelChoice         || undefined,
      advancingLevels:        stub.advancingLevels        || undefined,
      autoAdvanceLowerLevels: stub.autoAdvanceLowerLevels || undefined,
      requiresStyles:         stub.requiresStyles         || undefined,
      allowsMultiAdvance:     stub.allowsMultiAdvance     || undefined,
      advancementSlots:       stub.advancementSlots       || undefined,
      invocationAdvancesLevels:  stub.invocationAdvancesLevels  || undefined,
      invocationAdvancesTarget:  stub.invocationAdvancesTarget  || undefined,
      invocationAdvancingLevels: stub.invocationAdvancingLevels || undefined,
      mysteryAdvancesLevels:  stub.mysteryAdvancesLevels  || undefined,
      mysteryAdvancesTarget:  stub.mysteryAdvancesTarget  || undefined,
      mysteryAdvancingLevels: stub.mysteryAdvancingLevels || undefined,
      monsterExt: stub.monsterExt || undefined,
    };
  }

  function installPersistenceHooks() {
    // Character is declared `const` at the top of character.js so it's
    // in the global lexical scope but NOT a property of `window` —
    // reference it bare. typeof guards against it being absent (e.g.
    // if someone loads the modules in a different order).
    if (typeof Character === 'undefined' || Character._mcHooked) return;
    Character._mcHooked = true;
    const origCollect = Character.collectData;
    const origLoad    = Character.loadData;
    Character.collectData = function () {
      const out = origCollect.apply(this, arguments) || {};
      // Save-stability: persist the `data-from-class` markers that
      // setIfEmpty stamped on auto-filled fields (Turn Undead per-day,
      // Rage rounds, etc.). Without this, the field VALUES survive
      // save/load via the normal collect path, but the MARKERS are
      // lost — so a subsequent class-remove can't clean those fields.
      // Stored as a flat {fieldId: className} map; tiny payload.
      const markers = {};
      document.querySelectorAll('[data-from-class]').forEach(el => {
        if (el.id) markers[el.id] = el.dataset.fromClass;
      });
      if (Object.keys(markers).length) out._fromClassMarkers = markers;
      // Side A — unchanged shape (`_multiclass`). prog is stripped and
      // rehydrated from the DB on load; see mapEntryToStub.
      if (pickedClasses.length) {
        out._multiclass = pickedClasses.map(mapEntryToStub);
      }
      // Gestalt: persist the flag + Side B. Both keys are omitted when
      // they'd be empty/false, so a non-gestalt save is byte-identical to
      // the pre-gestalt format.
      if (gestalt) out._gestalt = true;
      if (pickedClassesB.length) {
        out._multiclassB = pickedClassesB.map(mapEntryToStub);
      }
      if (useFractional) out._fractionalBaseBonus = true;
      return out;
    };
    Character.loadData = function (data) {
      const ret = origLoad.apply(this, arguments);
      pickedClasses = [];
      useFractional = !!(data && data._fractionalBaseBonus);
      // Side A (`_multiclass`) and Side B (`_multiclassB`) hydrate through
      // the same hydrateStub helper — see its comment for the three
      // resolution branches (racial-HD / unhydrated / name+source).
      if (data && Array.isArray(data._multiclass)) {
        for (const stub of data._multiclass) pickedClasses.push(hydrateStub(stub));
      }
      // Gestalt mode + Side B. Absent keys → off / empty, so old saves load
      // exactly as before. activeSide is transient UI state — reset to A on
      // every load so a prior character's Side-B selection can't leak.
      gestalt = !!(data && data._gestalt);
      activeSide = 'A';
      pickedClassesB = [];
      if (data && Array.isArray(data._multiclassB)) {
        for (const stub of data._multiclassB) pickedClassesB.push(hydrateStub(stub));
      }
      renderClassList();
      // Save-stability: restore `data-from-class` markers stamped by
      // setIfEmpty during the original session. The field values are
      // already restored via origLoad; we just re-apply the dataset
      // attribute + the clear-on-edit listener so a subsequent class
      // removal can still clean these fields. See collectData above
      // for the matching emit logic.
      if (data && data._fromClassMarkers && typeof data._fromClassMarkers === 'object') {
        for (const [id, className] of Object.entries(data._fromClassMarkers)) {
          const el = document.getElementById(id);
          if (!el) continue;
          el.dataset.fromClass = className;
          if (!el.dataset.fromClassWired) {
            el.dataset.fromClassWired = '1';
            el.addEventListener('input', (ev) => {
              if (ev.isTrusted) delete el.dataset.fromClass;
            });
          }
        }
      }
      // Stamp dataset.mcComputed so the loaded total-level value is
      // recognized as "computed by us" (not a manual deviation) on the
      // next Apply.
      const tl = document.getElementById('char-level');
      if (tl && (pickedClasses.length || pickedClassesB.length)) {
        const totals = gestalt
          ? gestaltTotals(pickedClasses, pickedClassesB)
          : aggregateTotals(pickedClasses);
        tl.dataset.mcComputed = String(totals.lvl);
      }
      // Class skills run AFTER all other modules' loadData (Skills.loadData
      // would otherwise reset the checkboxes from saved state). Deferred
      // to the next tick so this re-tags loaded skill rows with their
      // class-skill sources for proper untick-on-remove tracking. Gestalt:
      // both sides contribute class skills (the union), so re-tag from A∪B.
      if (pickedClasses.length || pickedClassesB.length) {
        setTimeout(() => {
          for (const e of pickedClasses) applyClassSkills(e.className);
          if (gestalt) for (const e of pickedClassesB) applyClassSkills(e.className);
          reconcileCurrentClassSkills();
        }, 0);
      }
      return ret;
    };
  }

  // Resolve a saved `_multiclass` stub against the current DB. Tries
  // (name + source + version) first, then (name + version), then
  // (name + any), then the saved classId as a last resort. Returns
  // null when no candidate is found OR the DB isn't loaded yet — the
  // caller preserves the stub as an `_unhydrated` entry in either
  // case so the chip still renders and a later save round-trips the
  // data forward.
  function resolveMulticlassStub(stub) {
    if (typeof DB === 'undefined' || !DB.isLoaded()) return null;
    if (!stub) return null;
    const name = stub.className;
    // Name + source + version (most specific — picks the exact entry
    // even when the same class name appears in multiple books).
    if (name && stub.source && stub.version) {
      const r = DB.queryOne(
        "SELECT id AS class_id, name AS class, version, source, "
        + "json_extract(data, '$.bab_progression')  AS bab_progression, "
        + "json_extract(data, '$.fort_progression') AS fort_progression, "
        + "json_extract(data, '$.ref_progression')  AS ref_progression, "
        + "json_extract(data, '$.will_progression') AS will_progression "
        + "FROM entry WHERE name = ? COLLATE NOCASE AND source = ? "
        + "AND version = ? AND type IN ('class','prc') LIMIT 1",
        [name, stub.source, stub.version]);
      if (r) return r;
    }
    // Name + version (handles source rename without changing version).
    // NOTE: must qualify `name` and `version` with `e.` here — the
    // LEFT JOIN on `book b ON b.name = e.source` makes bare `name`
    // ambiguous (book table has its own `name` column). This bug was
    // introduced in the 2026-05-18 brittle-id fix and surfaced when
    // a saved character with `_multiclass` was loaded, throwing a
    // "ambiguous column name: name" exception that aborted the rest
    // of Character.loadData mid-load (so the rest of the sheet
    // appeared blank).
    if (name && stub.version) {
      const r = DB.queryOne(
        "SELECT e.id AS class_id, e.name AS class, e.version, e.source, "
        + "json_extract(e.data, '$.bab_progression')  AS bab_progression, "
        + "json_extract(e.data, '$.fort_progression') AS fort_progression, "
        + "json_extract(e.data, '$.ref_progression')  AS ref_progression, "
        + "json_extract(e.data, '$.will_progression') AS will_progression "
        + "FROM entry e LEFT JOIN book b ON b.name = e.source "
        + "WHERE e.name = ? COLLATE NOCASE AND e.version = ? "
        + "AND e.type IN ('class','prc') "
        + "ORDER BY b.publication_date DESC LIMIT 1",
        [name, stub.version]);
      if (r) return r;
    }
    // Name only (any version, prefer 3.5 + newest source).
    if (name) {
      const r = DB.queryOne(
        "SELECT e.id AS class_id, e.name AS class, e.version, e.source, "
        + "json_extract(e.data, '$.bab_progression')  AS bab_progression, "
        + "json_extract(e.data, '$.fort_progression') AS fort_progression, "
        + "json_extract(e.data, '$.ref_progression')  AS ref_progression, "
        + "json_extract(e.data, '$.will_progression') AS will_progression "
        + "FROM entry e LEFT JOIN book b ON b.name = e.source "
        + "WHERE e.name = ? COLLATE NOCASE AND e.type IN ('class','prc') "
        + "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, "
        + "         b.publication_date DESC LIMIT 1",
        [name]);
      if (r) return r;
    }
    // Last resort: the saved id (brittle — entry.id renumbers on
    // every DB rebuild, so this can resolve to the WRONG class).
    // Guarded by a type+name check so an id that now points to a
    // completely different class drops through to the unhydrated
    // fallback rather than silently swapping.
    if (stub.classId) {
      const r = DB.queryOne(
        "SELECT id AS class_id, name AS class, version, source, "
        + "json_extract(data, '$.bab_progression')  AS bab_progression, "
        + "json_extract(data, '$.fort_progression') AS fort_progression, "
        + "json_extract(data, '$.ref_progression')  AS ref_progression, "
        + "json_extract(data, '$.will_progression') AS will_progression "
        + "FROM entry WHERE id = ? AND type IN ('class','prc')",
        [stub.classId]);
      // Only honor the id-based hit if its name matches the stub's
      // (case-insensitive) — protects against id reassignment.
      if (r && (!name || r.class.toLowerCase() === name.toLowerCase())) {
        return r;
      }
    }
    return null;
  }

  // Re-hydrate any `_unhydrated` entries once the DB becomes ready.
  // Covers the race where the user loads a character (via the saved-
  // characters dropdown or a JSON import) before DB.ready resolves —
  // the load preserved the stub data; this fills in prog so a
  // subsequent recalc has the right BAB / save progressions.
  function rehydrateUnhydratedClasses() {
    if (typeof DB === 'undefined' || !DB.isLoaded()) return;
    // Re-resolve any `_unhydrated` stubs in one side's array, in place.
    const rehydrateArray = (arr) => {
      let n = 0;
      for (let i = 0; i < arr.length; i++) {
        const e = arr[i];
        if (!e._unhydrated) continue;
        const cls = resolveMulticlassStub({
          className: e.className, level: e.level,
          classId: e.classId, source: e.source, version: e.version,
        });
        if (!cls) continue;
        arr[i] = Object.assign({}, e, {
          className: cls.class || e.className,
          classId:   cls.class_id,
          source:    cls.source || e.source,
          version:   cls.version || e.version,
          prog: {
            bab:  cls.bab_progression,
            fort: cls.fort_progression,
            ref:  cls.ref_progression,
            will: cls.will_progression,
          },
          _unhydrated: false,
        });
        delete arr[i]._unhydrated;
        n++;
      }
      return n;
    };
    // Both sides — a gestalt Side B stub can be unhydrated on a load-before-
    // DB-ready race just like Side A.
    const changed = rehydrateArray(pickedClasses) + rehydrateArray(pickedClassesB);
    if (changed) {
      console.log(`[class-picker] re-hydrated ${changed} class entr` +
                  `${changed === 1 ? 'y' : 'ies'} after DB ready`);
      renderClassList();
    }
  }

  function lookupClass(typedName) {
    const key = (typedName || '').trim().toLowerCase();
    if (!key) return null;
    const list = classIndex.get(key);
    if (!list || !list.length) return null;
    return list[0]; // 3.5 preferred (sorted that way)
  }

  // The base class a variant replaces (Chaos Monk → "Monk"), or null for a
  // non-variant. Resolves through the class index, which now carries
  // `variant_of`. Degrades to null when the class isn't in scope (e.g. a
  // book-filtered-out variant on a loaded save) — no conflict is reported.
  function variantBaseOf(className) {
    const c = lookupClass(className);
    return c && c.variant_of ? c.variant_of : null;
  }

  // Variant ⇄ base mutual exclusion. A variant class is a FULL replacement
  // for its base, so a character can't hold both — nor two different
  // variants of the same base (each replaces the same class). Returns the
  // first conflicting picked class (across BOTH gestalt sides — base/variant
  // is a class-identity clash regardless of track) or null. `applyingName`
  // re-applied at a new level is fine: self is skipped by name.
  function findVariantConflict(applyingName) {
    const eq = (a, b) =>
      String(a || '').toLowerCase() === String(b || '').toLowerCase();
    const base = variantBaseOf(applyingName);   // base if applying a variant
    for (const e of pickedClasses.concat(pickedClassesB)) {
      if (eq(e.className, applyingName)) continue;            // self (level bump)
      if (base && eq(e.className, base))                      // variant over its base
        return { other: e.className, kind: 'base' };
      if (eq(variantBaseOf(e.className), applyingName))       // base under a picked variant
        return { other: e.className, kind: 'variant' };
      if (base && eq(variantBaseOf(e.className), base))       // sibling variant of same base
        return { other: e.className, kind: 'sibling' };
    }
    return null;
  }

  // Cache parsed class_table per class entry id.  Hit rate is high because
  // we hit the same class multiple times during a recompute cycle (every
  // applied class queries levelData + levelsUpTo + getSpellcastingDataAtLevel).
  const classTableCache = new Map();

  function fetchClassTable(classId) {
    if (classTableCache.has(classId)) return classTableCache.get(classId);
    const row = DB.queryOne(
      "SELECT json_extract(data, '$.class_table') AS class_table "
      + "FROM entry WHERE id = ?", [classId]);
    let arr = [];
    if (row && row.class_table) {
      try { arr = JSON.parse(row.class_table) || []; }
      catch (e) { console.warn('[class-picker] bad class_table JSON', e); }
    }
    if (!Array.isArray(arr)) arr = [];
    classTableCache.set(classId, arr);
    return arr;
  }

  // `natural_armor_stacking` ("overlap" = use-higher, vs the default additive)
  // for a class, cached. Drives the overlap-vs-add decision in
  // applyMonsterClassExtensions (DFA "Scales" overlaps the racial NA; Dragon
  // Shaman / Ogre add).
  const naStackingCache = new Map();
  function fetchNaStacking(classId) {
    if (naStackingCache.has(classId)) return naStackingCache.get(classId);
    const row = DB.queryOne(
      "SELECT json_extract(data, '$.natural_armor_stacking') AS s "
      + "FROM entry WHERE id = ?", [classId]);
    const v = (row && row.s) ? String(row.s) : null;
    naStackingCache.set(classId, v);
    return v;
  }

  // Stringify a per-row spells_per_day value into the JSON the rest of
  // class-picker.js expects ("spells_per_day_json" used to be a TEXT
  // column with a JSON array). Same for spells_known.
  function rowToLevelDetail(row) {
    if (!row) return null;
    const spd = row.spells_per_day;
    const sk  = row.spells_known;
    return {
      level: row.level,
      special: row.special || '',
      spells_per_day_json:
        spd === undefined || spd === null ? null : JSON.stringify(spd),
      spells_known_json:
        sk === undefined || sk === null ? null : JSON.stringify(sk),
      power_points_per_day: row.power_points_per_day ?? null,
      powers_known: row.powers_known ?? null,
      max_power_level: row.max_power_level ?? null,
    };
  }

  function levelData(classId, level) {
    const table = fetchClassTable(classId);
    const row = table.find(r => Number(r.level) === Number(level));
    return rowToLevelDetail(row);
  }

  function levelsUpTo(classId, level) {
    const table = fetchClassTable(classId);
    return table
      .filter(r => Number(r.level) <= Number(level))
      .map(r => ({ level: r.level, special: r.special || '' }))
      .sort((a, b) => a.level - b.level);
  }

  // ============================================================
  // Monster-class extensions (Savage Species)
  // ============================================================
  //
  // Savage Species monster classes (Ogre, Drider, Centaur, Half-Ogre,
  // etc.) extend their class_table rows with per-level `size`,
  // `natural_armor`, `racial_hd`, and `ability_changes` fields. These
  // are racial-template-style adjustments that need to actually
  // affect the character sheet's Template ability column, Natural
  // Armor field, and Size select when the class is applied.
  //
  // `ability_changes` is the DELTA at each level (e.g. L2 ogre adds
  // +2 Str / +2 Con). `natural_armor`, `size`, `racial_hd` are
  // cumulative — they're the TOTAL value at that level. Aggregation
  // sums ability_changes across L1..applied-level, and takes the
  // most-recent non-null value of the cumulative fields.

  function getMonsterClassExtensions(classId, atLevel) {
    const table = fetchClassTable(classId);
    if (!table.length) return null;
    // A class is "monster-flavored" if any row carries the SS-style
    // extension fields. Non-monster classes never enter this code path.
    const isMonsterClass = table.some(r =>
      r.natural_armor != null || r.size != null ||
      r.racial_hd != null ||
      (Array.isArray(r.ability_changes) && r.ability_changes.length));
    if (!isMonsterClass) return null;
    const abilityMods = {};
    let naturalArmor = 0;
    let size = null;
    let racialHD = 0;
    for (const r of table) {
      if (Number(r.level) > Number(atLevel)) continue;
      for (const ch of (r.ability_changes || [])) {
        // DB schema uses "Str" / "Con" — uppercase 3-letter for the
        // sheet's `${ab}-template` IDs.
        const ab = String(ch.ability || '').toUpperCase().slice(0, 3);
        if (!ab) continue;
        abilityMods[ab] = (abilityMods[ab] || 0) + (Number(ch.modifier) || 0);
      }
      if (r.natural_armor != null) naturalArmor = Number(r.natural_armor) || 0;
      if (r.size) size = r.size;
      if (r.racial_hd != null) racialHD = Number(r.racial_hd) || 0;
    }
    return { abilityMods, naturalArmor, size, racialHD,
             naStacking: fetchNaStacking(classId) };
  }

  // Apply (or re-apply) monster-class extensions to the sheet. Diffs
  // against `prevExt` (the previously-applied extensions for this
  // SAME class, captured BEFORE the entry was replaced) and applies
  // only the delta — so re-applying Ogre 2 → Ogre 3 only adds the
  // L3 changes, not the full L1..L3 stack again. Stores the new
  // extensions on entry.monsterExt for removeClass to subtract.
  function applyMonsterClassExtensions(entry, prevExt) {
    const ext = getMonsterClassExtensions(entry.classId, entry.level);
    if (!ext) return;
    entry.monsterExt = ext;
    // Ability mods → Template column (matches template-picker's
    // pattern; multiple monster-classy things stack additively).
    for (const ab of ['STR','DEX','CON','INT','WIS','CHA']) {
      const prev = (prevExt && prevExt.abilityMods && prevExt.abilityMods[ab]) || 0;
      const next = ext.abilityMods[ab] || 0;
      const delta = next - prev;
      if (delta === 0) continue;
      const el = document.getElementById(`${ab.toLowerCase()}-template`);
      if (!el) continue;
      const cur = parseInt(el.value, 10) || 0;
      el.value = String(cur + delta);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // Natural armor → #ac-natural.
    //   * Default (additive): the class IMPROVES natural armor — Ogre, Dragon
    //     Shaman ("Natural Armor (Ex)"). Contribution = the raw cumulative value.
    //   * "overlap" stacking: the class's NA does NOT stack with the creature's
    //     existing NA — you use the higher (DFA "Scales"). Per Ryan's rule
    //     (2026-06-12): effective NA = max(base NA, overlap value) + enhancements.
    //     So this class's NET contribution = max(0, value − preClassNA), where
    //     preClassNA is the NA already present from everything else (race /
    //     template / other classes) = current field minus what THIS class
    //     previously contributed. Without this, a kobold (NA 1) taking DFA got
    //     1 + 2 = 3 instead of max(1, 2) = 2.
    // `ext.appliedNA` records the net amount actually written so re-level and
    // removal subtract exactly that (and old saves without it fall back to the
    // raw value they applied additively — migration-safe).
    const na = document.getElementById('ac-natural');
    const prevApplied = (prevExt && prevExt.appliedNA != null)
      ? prevExt.appliedNA
      : ((prevExt && prevExt.naturalArmor) || 0);
    let appliedNA = ext.naturalArmor;
    if (ext.naStacking === 'overlap' && na) {
      const curVal = parseInt(na.value, 10) || 0;
      const preClassNA = curVal - prevApplied;        // NA from all other sources
      appliedNA = Math.max(0, ext.naturalArmor - preClassNA);
    }
    ext.appliedNA = appliedNA;
    const deltaNA = appliedNA - prevApplied;
    if (deltaNA !== 0 && na) {
      const cur = parseInt(na.value, 10) || 0;
      na.value = String(cur + deltaNA);
      na.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // Size → #char-size, but only if either (a) this class owns the
    // current value (data-from-class === className) so we can refresh
    // it on re-apply, or (b) the user hasn't deviated from Medium
    // default. The data-from-class marker rides on top of the existing
    // _fromClassMarkers persistence so it survives save/load.
    if (ext.size) {
      const sizeSel = document.getElementById('char-size');
      if (sizeSel) {
        const ownedByThis = sizeSel.dataset.fromClass === entry.className;
        const looksDefault = sizeSel.value === '' || sizeSel.value === 'Medium';
        if (ownedByThis || looksDefault) {
          if (sizeSel.value !== ext.size) {
            sizeSel.value = ext.size;
            sizeSel.dispatchEvent(new Event('change', { bubbles: true }));
          }
          sizeSel.dataset.fromClass = entry.className;
        }
      }
    }
  }

  // Inverse of applyMonsterClassExtensions — runs from removeClass.
  // Subtracts the stored ability mods + natural armor, clears the
  // size if we were the ones who set it.
  function removeMonsterClassExtensions(removedEntry) {
    const ext = removedEntry && removedEntry.monsterExt;
    if (!ext) return;
    for (const ab of ['STR','DEX','CON','INT','WIS','CHA']) {
      const mod = ext.abilityMods[ab] || 0;
      if (mod === 0) continue;
      const el = document.getElementById(`${ab.toLowerCase()}-template`);
      if (!el) continue;
      const cur = parseInt(el.value, 10) || 0;
      el.value = String(cur - mod);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // Subtract the NET amount this class actually contributed (appliedNA).
    // Old saves predating the overlap fix have no appliedNA → fall back to the
    // raw cumulative value, which is what they added additively.
    const naApplied = (ext.appliedNA != null) ? ext.appliedNA : (ext.naturalArmor || 0);
    if (naApplied) {
      const na = document.getElementById('ac-natural');
      if (na) {
        const cur = parseInt(na.value, 10) || 0;
        na.value = String(cur - naApplied);
        na.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    if (ext.size) {
      const sizeSel = document.getElementById('char-size');
      if (sizeSel && sizeSel.dataset.fromClass === removedEntry.className) {
        // Reset to Medium and drop our ownership marker.
        sizeSel.value = 'Medium';
        delete sizeSel.dataset.fromClass;
        sizeSel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  // Detect spell-advancing PrC. Returns { types: [...], levels: N } or null.
  // Source A: count class_level rows up to `level` whose `special` text
  //   contains the "+1 level of existing (arcane|divine|manifesting)
  //   spellcasting class" marker. Each match contributes +1 advancement.
  // Source B: hardcoded HARDCODED_ADVANCERS for parser-missed PrCs;
  //   advancesLevels == picked level when advancesAllLevels is true.
  function detectSpellAdvancement(className, classId, level) {
    const rows = levelsUpTo(classId, level);
    const types = new Set();
    let hits = 0;
    for (const r of rows) {
      const text = String(r.special || '');
      // Scan for ALL occurrences (Cerebremancer puts both arcane and
      // manifesting markers on the same level — count each as one).
      const re = /\+\s*1\s*level\s+of\s+existing\s+(arcane|divine|manifesting|psionic)\s+(?:spellcasting|manifesting)?\s*class/gi;
      let m, perRow = 0;
      while ((m = re.exec(text)) !== null) {
        let t = m[1].toLowerCase();
        if (t === 'manifesting') t = 'psionic';
        types.add(t);
        perRow++;
      }
      // Increment hits once per row that had at least one match
      // (Cerebremancer L1 has TWO markers but advances each tracked
      // class by 1, not 2).
      if (perRow > 0) hits++;
    }
    if (hits > 0) {
      return { types: [...types], levels: hits };
    }
    const hard = getAdvancementSpec(className);
    if (hard && hard.advancesAllLevels) {
      // Subtract any "non-advancing levels" that fall at or below the
      // picked level. For Sand Shaper (nonAdvancingLevels: [1, 9]) at
      // level 5, effective advancement is 5 - 1 = 4 (only L1 has been
      // passed). At level 9, it's 9 - 2 = 7 (both L1 and L9 are
      // non-advancing).
      //
      // autoAdvanceLowerLevels DOES count toward effective — those
      // levels DO advance (just automatically to the lower of the
      // requiresStyles pair). For Ultimate Magus, every PrC level
      // contributes +1 caster level somewhere.
      let effective = level;
      const nonAdvancing = hard.nonAdvancingLevels || [];
      const autoLower = hard.autoAdvanceLowerLevels || [];
      for (const n of nonAdvancing) {
        if (n <= level) effective--;
      }
      if (effective <= 0) return null;
      const out = { types: hard.types.slice(), levels: effective };
      if (hard.perLevelChoice) {
        const advancingLevels = [];
        for (let lv = 1; lv <= level; lv++) {
          if (nonAdvancing.includes(lv)) continue;
          advancingLevels.push(lv);
        }
        out.perLevelChoice = true;
        out.advancingLevels = advancingLevels;
        out.autoAdvanceLowerLevels = autoLower.filter(lv => lv <= level);
        out.requiresStyles = hard.requiresStyles || null;
        out.allowsMultiAdvance = !!hard.allowsMultiAdvance;
      }
      return out;
    }
    return null;
  }

  // Pick the first matching class in pickedClasses for an advancer's
  // target type. 'any' matches the first class with spellcasting at
  // its native level (regardless of type).
  function pickAdvanceTarget(typeStr, advancerEntry) {
    for (const e of classPool()) {   // union — target either side
      if (e === advancerEntry) continue;
      if (!e.classId) continue;
      if (typeStr === 'any') {
        if (getSpellcastingDataAtLevel(e.classId, e.level)) return e.className;
        continue;
      }
      // SPELLCASTING_TYPE may be a single string or an array (e.g.
      // Sha'ir = ['arcane', 'divine']). Normalize before comparison.
      const t = getClassType(e.className);
      if (t == null) continue;
      const types = Array.isArray(t) ? t : [t];
      if (types.includes(typeStr)) return e.className;
    }
    return null;
  }

  // For a per-level-choice advancer entry (Ultimate Magus, …), build
  // `entry.advancementSlots` — one slot per advancingLevels entry. Each
  // slot's `targets` lists which base classes received +1 at that PrC
  // level. Defaults: when `requiresStyles` is set (UM: prepared +
  // spontaneous), seed targets with one of each style. Otherwise seed
  // with the first eligible target. Preserves any prior user picks for
  // slots whose prcLevel survives.
  function seedAdvancementSlots(entry) {
    if (!entry.perLevelChoice) return;
    const wantStyles = entry.requiresStyles || [];
    const types = entry.advancesTypes || ['any'];
    const autoLower = new Set(entry.autoAdvanceLowerLevels || []);
    const eligible = classPool().filter(e => {   // union — both sides
      if (e === entry) return false;
      if (!e.classId) return false;
      const t = getClassType(e.className);
      if (t == null) return false;
      const ts = Array.isArray(t) ? t : [t];
      // 'any' matches anything; specific type must be in the class's type list.
      return types.some(want => want === 'any' || ts.includes(want));
    });
    // Pick a default target per CHOICE slot. For UM-style PrCs with
    // requiresStyles=['prepared','spontaneous'] and allowsMultiAdvance,
    // we default to advancing BOTH at each level (i.e. one prepared +
    // one spontaneous together). That's the standard build pattern;
    // the user can de-select to allocate manually.
    const defaultChoiceTargets = [];
    for (const wantStyle of wantStyles) {
      const match = eligible.find(e => getCasterStyle(e.className) === wantStyle);
      if (match) defaultChoiceTargets.push(match.className);
    }
    if (!defaultChoiceTargets.length && eligible.length) {
      defaultChoiceTargets.push(eligible[0].className);
    }
    // Build/refresh slots. Preserve existing user picks for slot levels
    // that survive; seed defaults for newly-added ones. Slot `kind`
    // is 'auto-lower' for levels in autoAdvanceLowerLevels, else
    // 'choice'. Auto-lower slot targets are recomputed later by
    // resolveAutoLowerSlots(); seed them as empty.
    const prev = new Map();
    for (const s of (entry.advancementSlots || [])) prev.set(s.prcLevel, s);
    entry.advancementSlots = entry.advancingLevels.map(lvl => {
      const isAuto = autoLower.has(lvl);
      const existing = prev.get(lvl);
      if (existing) {
        // Update kind on schema drift (e.g. autoAdvanceLowerLevels added).
        existing.kind = isAuto ? 'auto-lower' : 'choice';
        if (isAuto) {
          // Auto-lower slots get their targets recomputed. Preserve
          // the user's tiebreaker preference, if any.
          existing.targets = existing.targets || [];
        } else if (!existing.targets) {
          existing.targets = defaultChoiceTargets.slice();
        }
        return existing;
      }
      return isAuto
        ? { prcLevel: lvl, kind: 'auto-lower', targets: [], tieBreaker: null }
        : { prcLevel: lvl, kind: 'choice',     targets: defaultChoiceTargets.slice() };
    });
  }

  // For each auto-lower slot in an advancer entry, compute which class
  // (of the requiresStyles candidates) currently has the LOWER effective
  // spell level — that's the target for that slot. Walks slots in level
  // order because each auto-advance affects the running tally that
  // later slots see. Tie-break uses the slot's `tieBreaker` (user
  // preference) when set, otherwise falls back to the first eligible
  // class in pickedClasses order.
  function resolveAutoLowerSlots(entry) {
    if (!entry.perLevelChoice) return;
    if (!entry.advancementSlots) return;
    const wantStyles = entry.requiresStyles || [];
    if (!wantStyles.length) return;
    const styleClasses = wantStyles.map(s => {
      const match = classPool().find(e =>   // union — both sides
        e !== entry && getCasterStyle(e.className) === s);
      return match ? match.className : null;
    });
    if (styleClasses.some(c => !c)) return; // missing one — skip; warning surfaces in UI
    // Tally running advancement count per style-class, walking slots
    // in PrC level order.
    const running = Object.create(null);
    for (const cls of styleClasses) running[cls] = 0;
    // Tally NON-UM advancement contributions from other entries
    // (Mystic Theurge etc.) baseline. Union — advancers on both sides.
    for (const e of classPool()) {
      if (e === entry) continue;
      if (e.advancementSlots) {
        for (const s of e.advancementSlots) {
          for (const t of s.targets || []) {
            if (t in running) running[t]++;
          }
        }
      } else if (e.advancesTargets) {
        for (const t of e.advancesTargets) {
          if (t in running) running[t] += (e.advancesLevels || 0);
        }
      }
    }
    // Add base class level so "effective spell level" comparison uses
    // the full sum (not just advancement contributions). Without this,
    // a Wizard 5 + Sorcerer 3 + UM build would treat both as "0
    // advancement" and auto-pick alphabetically rather than picking
    // the lower-base Sorcerer.
    for (const cls of styleClasses) {
      const base = classPool().find(e => e.className === cls);
      if (base) running[cls] += base.level;
    }
    // Walk slots; assign auto-lower targets.
    const sortedSlots = entry.advancementSlots
      .slice()
      .sort((a, b) => a.prcLevel - b.prcLevel);
    for (const slot of sortedSlots) {
      if (slot.kind === 'auto-lower') {
        // Find the minimum running value; collect ties.
        const min = Math.min(...styleClasses.map(c => running[c]));
        const tied = styleClasses.filter(c => running[c] === min);
        let target;
        if (tied.length === 1) {
          target = tied[0];
        } else if (slot.tieBreaker && tied.includes(slot.tieBreaker)) {
          target = slot.tieBreaker;
        } else {
          target = tied[0]; // deterministic fallback
        }
        slot.targets = [target];
        slot.tiedOptions = tied.length > 1 ? tied.slice() : null;
        running[target]++;
      } else if (slot.kind === 'choice') {
        for (const t of slot.targets || []) {
          if (t in running) running[t]++;
        }
      }
    }
  }

  // Resolve advancesTargets for an entry by re-running pickAdvanceTarget
  // for each type. Updates entry.advancesTargets in place. Skips types
  // already targeting an entry that still exists.
  function refreshAdvanceTargets(entry) {
    if (!entry.advancesTypes || !entry.advancesTypes.length) return;
    // Per-level entries manage their own slots via seedAdvancementSlots
    // and the UI. Refresh slot targets here too so removed classes drop
    // out and new candidates can be auto-picked.
    if (entry.perLevelChoice) {
      const stillExists = (name) =>
        classPool().some(e => e.className.toLowerCase() === name.toLowerCase());
      for (const slot of (entry.advancementSlots || [])) {
        slot.targets = (slot.targets || []).filter(t => t && stillExists(t));
      }
      // Re-seed any slots emptied by class removal.
      seedAdvancementSlots(entry);
      return;
    }
    const stillExists = (name) =>
      classPool().some(e => e.className.toLowerCase() === name.toLowerCase());
    const oldTargets = entry.advancesTargets || [];
    const next = [];
    for (let i = 0; i < entry.advancesTypes.length; i++) {
      const t = entry.advancesTypes[i];
      const old = oldTargets[i];
      if (old && stillExists(old)) {
        next.push(old);
        continue;
      }
      const fresh = pickAdvanceTarget(t, entry);
      if (fresh) next.push(fresh);
      else next.push(null); // no match available; leave slot empty
    }
    entry.advancesTargets = next;
  }

  // Compute the effective spell-class level for a given base entry
  // (its native level + sum of advancers pointing at it). Capped at 20
  // to avoid querying epic-level rows that aren't in the DB.
  //
  // Two advancement shapes are honored:
  //
  //   1. `e.advancesTargets` (list of N target class names) +
  //      `e.advancesLevels` (int). The advancer's full advancesLevels
  //      bonus is added to each target in the list. Used for the
  //      classic "advances +1 of existing X class at every PrC level"
  //      shape (Mystic Theurge, Archmage, Loremaster, Eldritch Knight,
  //      Durthan, Sand Shaper, etc.).
  //
  //   2. `e.advancementSlots` (array of { prcLevel: int, targets: [..] }).
  //      Each slot represents one non-skip PrC level and lists which
  //      base classes received +1 at that level. Used for per-level
  //      allocation PrCs (Ultimate Magus: at each non-skip level,
  //      the player picks prepared, spontaneous, or both).
  //
  // A given advancer entry uses ONE shape, not both. perLevelChoice PrCs
  // populate advancementSlots; everything else populates advancesTargets.
  function effectiveSpellLevel(target) {
    let bonus = 0;
    for (const e of classPool()) {   // union — advancers on both sides
      if (e === target) continue;
      // Shape 2: per-level slots.
      if (e.advancementSlots && e.advancementSlots.length) {
        for (const slot of e.advancementSlots) {
          if (!slot || !slot.targets) continue;
          for (const tgt of slot.targets) {
            if (tgt && tgt.toLowerCase() === target.className.toLowerCase()) {
              bonus++;
            }
          }
        }
        continue;  // Don't also count advancesTargets for this entry.
      }
      // Shape 1: classic all-at-once.
      if (!e.advancesTargets || !e.advancesTargets.length) continue;
      for (const tgt of e.advancesTargets) {
        if (tgt && tgt.toLowerCase() === target.className.toLowerCase()) {
          bonus += e.advancesLevels || 0;
        }
      }
    }
    return Math.min(20, target.level + bonus);
  }

  // ============================================================
  // Maneuver-advancement pillar (Tome of Battle)
  //
  // ToB PrCs (Ruby Knight Vindicator, Jade Phoenix Mage, Master of Nine)
  // advance initiator level. Their metadata lives entirely in the
  // registry (`getManeuverAdvancementSpec` → DB `maneuver_advancement`
  // or `_FALLBACK_MANEUVER_ADVANCERS`); effectiveInitiatorLevel reads it
  // directly, so — unlike the spell pillar — there is NO per-entry
  // target/level stamping to keep in sync or round-trip. Each advancer
  // adds its FULL level to EVERY martial-adept class's IL (all-target;
  // see effectiveInitiatorLevel for the rule), and refreshAllManeuverTabs
  // writes each panel's computed IL into its `.tom-init-level` field.
  //
  // A homebrew ToB PrC just needs a `maneuver_advancement` registry entry
  // to participate — no other wiring. (The spec's `advancing_levels` is
  // the maneuvers-KNOWN gain schedule, available to a future maneuver-
  // picker via the same accessor; it is NOT an IL schedule.)
  // ============================================================

  // Initiator level for an applied martial-adept class, per Tome of
  // Battle p.39. IL is computed PER martial-adept class (this is called
  // once per target, and refreshAllManeuverTabs writes each result into
  // its own panel), so a Crusader 7 / Swordsage 5 shows IL 9 on the
  // crusader panel and IL 8 on the swordsage panel.
  //
  //   IL = levels in THIS class
  //      + FULL levels of EVERY ToB maneuver-advancer PrC (RKV / JPM /
  //        MoN). Each one's Chapter 5 text reads "add your full <PrC>
  //        levels to your initiator level" — unqualified, so the boost
  //        applies to EVERY martial-adept class's IL, not just the one
  //        entered with (confirmed all-target with Ryan, 2026-06-07).
  //        The PrC's even/odd `advancing_levels` is the maneuvers-KNOWN
  //        schedule, NOT an IL schedule — so IL takes the whole class
  //        level and isn't gated by it (a lone RKV 1, whose first
  //        maneuver isn't until level 2, still adds its full +1).
  //      + 1/2 of ALL other character levels (other base classes, other
  //        martial-adept classes, non-advancing PrC levels, racial HD),
  //        rounded down.
  //
  // Worked examples (ToB p.39): Crusader 7 / Swordsage 5 → crusader IL
  //   7 + floor(5/2) = 9, swordsage 5 + floor(7/2) = 8. Crusader 5 /
  //   Swordsage 5 / MoN 2 → both 5 + MoN 2 (full) + floor(5/2) = 9.
  //
  // (The "no martial-adept levels → IL = 1/2 character level" clause is
  // for feat-granted maneuvers with no class panel, so it has no UI
  // surface here.) Capped at 20 to match the IL table ceiling.
  function effectiveInitiatorLevel(target) {
    // Every recognized ToB maneuver-advancer adds its FULL level to this
    // (and every) martial-adept IL. Detect by registry membership, not
    // by the per-level advancing schedule, so the schedule never gates
    // the IL contribution.
    let advBonus = 0;
    for (const e of classPool()) {   // union — ToB advancers on both sides
      if (e === target) continue;
      if (getManeuverAdvancementSpec(e.className)) {
        advBonus += (e.level || 0);
      }
    }
    // Half-value contribution from every other character level — i.e. all
    // picked levels except this class's own and the full-counted advancer
    // PrC levels above. Gestalt character level is max(ΣA, ΣB), NOT the sum
    // of both tracks (the sides are parallel), so use totalCharacterLevel().
    const totalLevel = totalCharacterLevel();
    const otherLevels = Math.max(0, totalLevel - target.level - advBonus);
    const il = target.level + advBonus + Math.floor(otherLevels / 2);
    return Math.min(20, il);
  }

  // After every apply/remove: refresh each non-advancer's spells tab to
  // reflect the current effective level. Advancer entries with no
  // spellcasting data of their own (Eldritch Knight, Mystic Theurge,
  // …) don't get tabs themselves.
  function refreshAllSpellTabs() {
    // Union throughout — advancers and casters on BOTH gestalt sides
    // participate (track-agnostic advancement).
    for (const e of classPool()) refreshAdvanceTargets(e);
    for (const e of classPool()) refreshInvocationAdvanceTarget(e);
    for (const e of classPool()) refreshMysteryAdvanceTarget(e);
    // After targets settle, resolve auto-lower slots (UM L1/4/7) using
    // the current state. This must come AFTER refreshAdvanceTargets
    // because slot targets are recomputed there for per-level entries.
    for (const e of classPool()) {
      if (e.perLevelChoice) resolveAutoLowerSlots(e);
    }
    for (const target of classPool()) {
      if (!target.classId) continue;
      const effLvl = effectiveSpellLevel(target);
      const sc = getSpellcastingDataAtLevel(target.classId, effLvl);
      if (!sc) continue;
      const offset = getSpellLevelOffset(target.className, sc.spd.length);
      upsertSpellcastingPanel(target.className, effLvl, sc, offset);
    }
    // Refresh each applied ToB base class's maneuver panel IL.
    refreshAllManeuverTabs();

    // Re-fire class-spell-additions (Sand Shaper's Desert Insight, etc.)
    // for every applied class that has a CATALOG entry. Needed for the
    // case where the freebies' target panel's max-castable level moves
    // UP after the granting class was first applied — e.g. a Sand
    // Shaper 1 / Wizard 4 player levels the wizard to 5, unlocking L3
    // spells on the wizard panel. Without this pass the L3 Desert
    // Insight spells (control sand, haboob, etc.) never get added
    // because applyClassSpellAdditions only fires on apply / re-apply
    // of the granting class itself.
    //
    // The function is idempotent — applyFeaturesToPanel dedupes by
    // spell name within each level — so this is safe to call on every
    // spell-tab refresh. Filtered to CATALOG-listed classes so the
    // overhead is zero for characters without one of these classes.
    if (typeof ClassSpellAdditions !== 'undefined') {
      for (const e of classPool()) {
        if (!e.className) continue;
        if (!ClassSpellAdditions.getFeatures(e.className).length) continue;
        applyClassSpellAdditions(e);
      }
    }
  }

  // ============================================================
  // Invocation-advancement pillar (Warlock-style)
  //
  // Parallel to the spell + maneuver pillars but tracks the
  // invocation-pillar progression of a base invocation-using class
  // (Warlock today; Dragonfire Adept once extracted). Eldritch
  // Disciple / Eldritch Theurge / Demonbinder all advance this pillar.
  //
  // Eldritch Theurge is a DUAL-pillar PrC — it advances both arcane
  // spellcasting AND invocations at every PrC level. The two pillars
  // are tracked on the entry independently (entry.advancesLevels for
  // the spell side, entry.invocationAdvancesLevels for the invocation
  // side) so that future UI / lookup-modal / chip-display consumers
  // can surface both.
  //
  // No effective-level panel-update is wired today — the sheet
  // doesn't yet have a per-Warlock invocations panel showing caster
  // level / invocations-known counts. The chip-list display surfaces
  // "(advances invocations)" via the same advNote builder that
  // handles the spell pillar.
  // ============================================================

  function detectInvocationAdvancement(className, classId, level) {
    const spec = getInvocationAdvancementSpec(className);
    if (!spec || !Array.isArray(spec.advancingLevels)) return null;
    const passed = spec.advancingLevels.filter(lv => lv <= level);
    if (!passed.length) return null;
    return {
      levels: passed.length,
      advancingLevels: passed.slice(),
    };
  }

  function pickInvocationAdvanceTarget(advancerEntry) {
    for (const e of classPool()) {   // union — both sides
      if (e === advancerEntry) continue;
      if (INVOCATION_USING_CLASSES.has(e.className)) return e.className;
    }
    return null;
  }

  function effectiveInvocationLevel(target) {
    let bonus = 0;
    for (const e of classPool()) {   // union — both sides
      if (e === target) continue;
      if (!e.invocationAdvancesLevels) continue;
      const tgt = e.invocationAdvancesTarget;
      if (!tgt) continue;
      if (tgt.toLowerCase() === target.className.toLowerCase()) {
        bonus += e.invocationAdvancesLevels;
      }
    }
    return Math.min(20, target.level + bonus);
  }

  function refreshInvocationAdvanceTarget(entry) {
    if (!entry.invocationAdvancesLevels) return;
    const stillExists = (name) =>
      classPool().some(e => e.className.toLowerCase() === name.toLowerCase());
    if (entry.invocationAdvancesTarget &&
        stillExists(entry.invocationAdvancesTarget)) return;
    const tgt = pickInvocationAdvanceTarget(entry);
    entry.invocationAdvancesTarget = tgt || null;
  }

  // ============================================================
  // Mystery-advancement pillar (Tome of Magic shadowcaster pillar)
  //
  // Parallel to the spell + maneuver + invocation pillars. Tracks
  // the mystery-pillar progression of a base mystery-using class
  // (Shadowcaster today). Two PrCs use this pillar:
  //
  //   * Master of Shadow (ToM) — advances mysteries L2-L10
  //   * Noctumancer      (ToM) — DUAL-pillar PrC. Advances mystery
  //                              AND arcane casting every level. Has
  //                              BOTH `entry.advancesLevels` (arcane
  //                              spell side) AND `entry.mystery-
  //                              AdvancesLevels` populated.
  // ============================================================

  function detectMysteryAdvancement(className, classId, level) {
    const spec = getMysteryAdvancementSpec(className);
    if (!spec || !Array.isArray(spec.advancingLevels)) return null;
    const passed = spec.advancingLevels.filter(lv => lv <= level);
    if (!passed.length) return null;
    return {
      levels: passed.length,
      advancingLevels: passed.slice(),
    };
  }

  function pickMysteryAdvanceTarget(advancerEntry) {
    for (const e of classPool()) {   // union — both sides
      if (e === advancerEntry) continue;
      if (MYSTERY_USING_CLASSES.has(e.className)) return e.className;
    }
    return null;
  }

  function effectiveMysteryLevel(target) {
    let bonus = 0;
    for (const e of classPool()) {   // union — both sides
      if (e === target) continue;
      if (!e.mysteryAdvancesLevels) continue;
      const tgt = e.mysteryAdvancesTarget;
      if (!tgt) continue;
      if (tgt.toLowerCase() === target.className.toLowerCase()) {
        bonus += e.mysteryAdvancesLevels;
      }
    }
    return Math.min(20, target.level + bonus);
  }

  function refreshMysteryAdvanceTarget(entry) {
    if (!entry.mysteryAdvancesLevels) return;
    const stillExists = (name) =>
      classPool().some(e => e.className.toLowerCase() === name.toLowerCase());
    if (entry.mysteryAdvancesTarget &&
        stillExists(entry.mysteryAdvancesTarget)) return;
    const tgt = pickMysteryAdvanceTarget(entry);
    entry.mysteryAdvancesTarget = tgt || null;
  }

  function refreshAllManeuverTabs() {
    for (const target of classPool()) {   // union — martial adepts on both sides
      if (!MARTIAL_ADEPT_CLASSES.has(target.className)) continue;
      const panel = findExistingCasterPanel('maneuvers', target.className);
      if (!panel) continue;
      // A race-owned racial-initiation panel (Valkyrie's swordsage track) is
      // IL-managed by the racial pass below — skip it in the per-class loop so
      // the two don't fight over the same .tom-init-level.
      if (panel.dataset.fromRace) continue;
      const il = effectiveInitiatorLevel(target);
      const ilField = panel.querySelector('.tom-init-level');
      if (!ilField) continue;
      // Only push the picker's computed IL when the field was
      // auto-filled (data-from-class === target.className). User-typed
      // values clear the marker, so we leave them alone.
      const fromCls = ilField.dataset.fromClass;
      if (fromCls && fromCls === target.className) {
        ilField.value = String(il);
        ilField.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (!ilField.value.trim()) {
        // Field is blank — fill and tag so subsequent refreshes can
        // update it (and so removeClass strips it via the standard
        // data-from-class sweep).
        ilField.value = String(il);
        ilField.dataset.fromClass = target.className;
        if (!ilField.dataset.fromClassWired) {
          ilField.dataset.fromClassWired = '1';
          ilField.addEventListener('input', (ev) => {
            if (ev.isTrusted) delete ilField.dataset.fromClass;
          });
        }
        ilField.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    // Racial initiation pass — a race's racial_casting maneuvers track
    // (Valkyrie's swordsage initiation, base IL 10) STACKS with class levels:
    // IL = racial base + levels in the stacks_with class, or + all martial-
    // adept levels for a category ("martial adept"). Runs regardless of applied
    // classes, so removing the class reverts the panel to the racial base.
    document.querySelectorAll(
      '#spells-content [data-caster-type="maneuvers"][data-from-race]'
    ).forEach((panel) => {
      const base = parseInt(panel.dataset.racialBase || '0', 10);
      if (!base) return;
      const asClass = (panel.dataset.racialAsClass || '').toLowerCase();
      const stacksWith = (panel.dataset.racialStacksWith || '').toLowerCase();
      let add = 0;
      if (asClass) {
        const e = classPool().find(c => c.className.toLowerCase() === asClass);
        if (e) add = e.level || 0;
      } else if (stacksWith.includes('martial adept')) {
        add = classPool()
          .filter(c => MARTIAL_ADEPT_CLASSES.has(c.className)
            || getManeuverAdvancementSpec(c.className))
          .reduce((s, c) => s + (c.level || 0), 0);
      }
      const ilField = panel.querySelector('.tom-init-level');
      if (ilField) {
        ilField.value = String(Math.min(20, base + add));
        ilField.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }

  // Strip parser-leaked sample character names (e.g. "Krusk", "Alhandra")
  // that bleed in at the end of the L20 row. Heuristic: a single trailing
  // Capitalized-Word that follows a complete scaling notation.
  function cleanDisplay(text) {
    let s = String(text || '').trim();
    s = s.replace(/(\d+\s*\/\s*(?:day|week|round|encounter|hour|hr|minute|min))\s+[A-Z][a-z]+\s*$/i, '$1');
    s = s.replace(/([+\-]?\s*\d+d\d+)\s+[A-Z][a-z]+\s*$/i, '$1');
    return s.trim();
  }

  // Strip scaling tails (counts, dice, distances, ranks) so two entries
  // for the same feature at different levels collapse onto the same key.
  function stemOf(text) {
    let s = cleanDisplay(text).toLowerCase();
    if (!s) return '';
    // Remove "+Nd6" / "Nd6"
    s = s.replace(/[+\-]?\s*\d+\s*d\s*\d+/g, '');
    // Remove "N/day", "N/week", "N/round", "N/encounter", "N/hour", "N/minute"
    s = s.replace(/\d+\s*\/\s*(?:day|week|round|encounter|hour|hr|minute|min)/gi, '');
    // Remove "N/—" or "N/-" (DR-style)
    s = s.replace(/\d+\s*\/\s*[—\-–]/g, '');
    // Remove trailing "(N)"
    s = s.replace(/\s*\(\s*\d+\s*\)\s*$/, '');
    // Remove trailing "+N ft." / "N ft."
    s = s.replace(/\s*[+\-]?\s*\d+\s*(?:ft\.?|feet)\s*$/i, '');
    // Remove trailing "+N" or "-N" or standalone "N"
    s = s.replace(/\s*[+\-]?\s*\d+\s*$/, '');
    // Collapse whitespace
    return s.replace(/\s+/g, ' ').trim();
  }

  // Skip junk entries: empty strings, em-dashes, single chars, etc.
  function isJunkEntry(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    if (/^[—–\-]+$/.test(t)) return true; // pure em/en/hyphen dashes
    if (t.length < 2) return true;
    return false;
  }

  // Collapse all `special` rows from levels 1..N into a deduplicated list.
  // For each "stem group":
  //   - If all originals match (case-insensitive), it's a stacking feature
  //     (e.g. Fighter "Bonus feat" ×11). Emit once with × count.
  //   - Otherwise it's a scaling feature (e.g. "Smite evil 1/day" → "5/day").
  //     Emit only the highest-level original.
  function dedupSpecials(levelRows) {
    const groups = new Map(); // stem → [{level, original}, ...]
    for (const row of levelRows) {
      if (!row.special) continue;
      const entries = String(row.special).split(/\s*,\s*/);
      for (const raw of entries) {
        const entry = cleanDisplay(raw);
        if (isJunkEntry(entry)) continue;
        const stem = stemOf(entry);
        if (!stem) continue;
        if (!groups.has(stem)) groups.set(stem, []);
        groups.get(stem).push({ level: row.level, original: entry });
      }
    }
    const out = [];
    for (const entries of groups.values()) {
      const originals = new Set(entries.map(e => e.original.toLowerCase()));
      if (originals.size === 1) {
        // Stacking — same text repeated. Use canonical-cased original.
        const e = entries[0];
        out.push({
          label: entries.length > 1
            ? `${e.original} ×${entries.length}`
            : e.original,
          firstLevel: e.level,
        });
      } else {
        // Scaling — keep latest.
        const latest = entries.reduce((a, b) => a.level >= b.level ? a : b);
        out.push({ label: latest.original, firstLevel: latest.level });
      }
    }
    out.sort((a, b) =>
      a.firstLevel - b.firstLevel || a.label.localeCompare(b.label));
    return out;
  }

  // ---- Chip tagging helpers ------------------------------------------
  //
  // The chip list re-renders on every classes-changed event and we
  // also subscribe to class-customizations-changed (wired in init)
  // so tag badges refresh live without a page reload.

  function collectCustomizationsByClass() {
    const map = new Map();
    if (typeof ClassFeatures === 'undefined' ||
        typeof ClassFeatures.getCustomizations !== 'function') {
      return map;
    }
    const matchesCls = (typeof ClassVariants !== 'undefined' &&
                        typeof ClassVariants.matchesClass === 'function')
      ? ClassVariants.matchesClass
      : (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
    const customs = ClassFeatures.getCustomizations();
    if (!customs.length) return map;
    // Bucket each customization under every picked class it matches
    // (matchesClass handles "Sorcerer / Wizard" → both Sorcerer and
    // Wizard picked classes get the tag).
    for (const e of pickedClasses) {
      const key = e.className.toLowerCase();
      const bucket = [];
      for (const c of customs) {
        if (matchesCls(e.className, c.class)) bucket.push(c);
      }
      if (bucket.length) map.set(key, bucket);
    }
    return map;
  }

  // Compact a long sub-level name down to "<Race> Sub L<N>" — keeps
  // the chip from blowing the row width. ACF names stay verbatim
  // since they're typically short already ("Spelltouched",
  // "Ape Totem", etc.). Falls back to truncation for unusually long
  // ACF names.
  function shortenVariantName(c) {
    if (c.kind === 'Sub Level' && c.race && c.level != null) {
      return `${c.race.split(' ')[0]} Sub L${c.level}`;
    }
    if (c.name.length > 22) {
      return c.name.slice(0, 20) + '…';
    }
    return c.name;
  }

  // ---- Class customizations integration -----------------------------
  //
  // The Class Features tab hosts a structured list of selected ACFs /
  // sub levels (see class-features.js#getCustomizations). For each
  // customization whose `class` matches the typed class, we tokenize
  // its free-text `replaces` field and stick the resulting feature
  // names into a Map<feature-token-lower, {kind, name}> keyed by the
  // class-feature label we'd strike through. The info panel's
  // cumulative-features rendering then checks each feature label
  // against this map and applies the strikethrough.

  function buildReplacedMap(className) {
    if (typeof ClassFeatures === 'undefined' ||
        typeof ClassFeatures.getCustomizations !== 'function') {
      return new Map();
    }
    const customs = ClassFeatures.getCustomizations();
    if (!customs.length) return new Map();
    const matchesCls = (typeof ClassVariants !== 'undefined' &&
                        typeof ClassVariants.matchesClass === 'function')
      ? ClassVariants.matchesClass
      : (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    const map = new Map();
    for (const c of customs) {
      if (!c.replaces || !matchesCls(className, c.class)) continue;
      // Split on commas, semicolons, "and". Strip any parenthesized
      // clarifications ("(8th level)") and trim.
      const tokens = c.replaces
        .split(/\s*(?:,|;|\band\b)\s*/i)
        .map(t => t.replace(/\([^)]*\)/g, '').trim())
        .filter(Boolean);
      for (const t of tokens) {
        const key = t.toLowerCase();
        if (!map.has(key)) map.set(key, { kind: c.kind, name: c.name });
      }
    }
    return map;
  }

  // Match a class-feature label against the replaced-map's tokens. We
  // use substring matching in BOTH directions because the strings
  // diverge in irritating ways: the cumulative-feature label might be
  // "Scribe Scroll" while the ACF `replaces` says "Scribe Scroll" —
  // exact match. But also "Bonus Feat (8th level)" in the cumulative
  // list versus "Bonus feat (8th level)" — case-insensitive substring
  // catches that. Returns the matching customization meta or null.
  function findReplacement(featureLabel, replacedMap) {
    if (!replacedMap || replacedMap.size === 0) return null;
    const label = String(featureLabel || '').toLowerCase().trim();
    if (!label) return null;
    // Exact match first (fastest, most accurate).
    if (replacedMap.has(label)) return replacedMap.get(label);
    // Substring match either way — handle slightly-different phrasing
    // between the cumulative-features list and the ACF `replaces`
    // free text.
    for (const [token, meta] of replacedMap) {
      if (label === token) return meta;
      if (label.includes(token) && token.length >= 4) return meta;
      if (token.includes(label) && label.length >= 4) return meta;
    }
    return null;
  }

  function updatePreview(panel, typedName, levelStr) {
    const cls = lookupClass(typedName);
    const level = parseInt(levelStr, 10);
    if (!cls || !level || level < 1) {
      panel.style.display = 'none';
      panel.innerHTML = '';
      return;
    }
    const lvlRow = levelData(cls.class_id, level);

    const bab = babAt(cls.bab_progression, level);
    const fort = saveAt(cls.fort_progression, level);
    const ref  = saveAt(cls.ref_progression, level);
    const will = saveAt(cls.will_progression, level);

    const bits = [];
    bits.push(`<b>${escapeHtml(cls.class)} ${level}</b>` +
      ` <span style="opacity:.7">(${escapeHtml(cls.version || '?')})</span>`);
    // PrC requirements — pull from the entry data and render via
    // Lookup with the Feats sub-field as clickable pills. Goes first
    // because it gates entry to the class. Parse the whole `data` blob
    // and hand it to renderEntryRequirements so every shape resolves:
    // Capitalized dict, lowercase/snake walked dict, labeled string,
    // and the `prerequisites` string fallback. (The old code
    // json_extract'd just `$.requirements` and JSON.parse'd it, which
    // THREW on string-shaped requirements — the walked-book PrCs —
    // and silently dropped them.)
    if (window.Lookup && Lookup.renderEntryRequirements) {
      const reqRow = DB.queryOne(
        "SELECT data FROM entry WHERE id = ?", [cls.class_id]
      );
      if (reqRow && reqRow.data) {
        try {
          const reqHtml = Lookup.renderEntryRequirements(
            JSON.parse(reqRow.data)
          );
          if (reqHtml) bits.push(reqHtml);
        } catch (e) { /* malformed JSON — skip */ }
      }
    }
    bits.push(`<b>BAB:</b> +${bab}`);
    bits.push(`<b>Saves:</b> Fort +${fort}, Ref +${ref}, Will +${will}`);

    // Weapon/armor proficiencies. Fetched per-render (not in the
    // class index) to keep the index lean — same pattern as the
    // requirements pull above. Canonical DB field is the plural
    // `weapon_armor_proficiencies` (enforced by the 2026-05-26
    // field-canon sweep); fall back to legacy singular for safety.
    const profRow = DB.queryOne(
      "SELECT json_extract(data, '$.weapon_armor_proficiencies') AS plural, " +
      "       json_extract(data, '$.weapon_armor_proficiency')   AS singular " +
      "FROM entry WHERE id = ?", [cls.class_id]
    );
    const prof = profRow && (profRow.plural || profRow.singular);
    if (prof) bits.push(`<b>Proficiencies:</b> ${escapeHtml(prof)}`);

    // Cumulative class features (1..level), with stack-vs-scale dedup.
    // If the player has any ACFs / Sub Levels for this class in their
    // Class Customizations list, strike through the features each one
    // replaces (with a tooltip naming the customization). Makes the
    // mechanical effect of the customization visible at a glance.
    const cumulative = dedupSpecials(levelsUpTo(cls.class_id, level));
    const replacedMap = buildReplacedMap(cls.class);
    if (cumulative.length) {
      const head = cumulative.slice(0, 8).map(c => {
        const replacedBy = findReplacement(c.label, replacedMap);
        if (replacedBy) {
          return `<span class="cf-replaced" title="Replaced by ` +
            `${escapeHtml(replacedBy.kind)}: ${escapeHtml(replacedBy.name)} ` +
            `(gained at level ${c.firstLevel})">` +
            `<s>${escapeHtml(c.label)}</s></span>`;
        }
        return `<span title="Gained at level ${c.firstLevel}">` +
               escapeHtml(c.label) + '</span>';
      }).join(', ');
      const tail = cumulative.length > 8
        ? ` <span style="opacity:.7">+${cumulative.length - 8} more</span>`
        : '';
      bits.push(`<b>Class Features (cumulative):</b> ${head}${tail}`);
    }

    if (lvlRow) {
      // `spells_per_day_json` is an array for native casters but can
      // be a STRING for advancer PrCs (e.g. Durthan stores
      // "+1 level of existing spellcasting class" verbatim in the
      // spells_per_day column). Calling `.some()` on a string throws
      // and the rest of updatePreview never runs, leaving the panel
      // empty. Guard with Array.isArray before treating as a slot
      // array — and surface the advance marker as a separate bit.
      const spd = parseJsonArray(lvlRow.spells_per_day_json);
      if (Array.isArray(spd) && spd.some(x => x !== null && x !== undefined)) {
        bits.push(`<b>Spells/Day:</b> ${formatSpellArray(spd)}`);
      } else if (typeof spd === 'string' && /level of existing/i.test(spd)) {
        bits.push(`<b>Advances:</b> ${escapeHtml(spd)}`);
      }
      const sk = parseJsonArray(lvlRow.spells_known_json);
      if (Array.isArray(sk) && sk.some(x => x !== null && x !== undefined)) {
        bits.push(`<b>Spells Known:</b> ${formatSpellArray(sk)}`);
      }
      if (lvlRow.power_points_per_day) {
        bits.push(`<b>PP/Day:</b> ${lvlRow.power_points_per_day}`);
      }
      if (lvlRow.powers_known) {
        bits.push(`<b>Powers Known:</b> ${lvlRow.powers_known}`);
      }
      if (lvlRow.max_power_level) {
        bits.push(`<b>Max Power Lvl:</b> ${escapeHtml(lvlRow.max_power_level)}`);
      }
    } else {
      bits.push(`<i style="opacity:.7">No data for level ${level} in this table</i>`);
    }

    let html = bits.join(' &nbsp;·&nbsp; ');

    // Structured data tables (Druid's animal companions, Ranger's
    // favored enemies, Monk unarmed damage by size, DFA breath
    // effects, …). Collapsed behind a <details> line — these run to
    // 20+ rows and the preview strip is deliberately compact (the
    // 2026-06-03 "lookups eat too much real estate" pass). Fetched
    // per-render like the requirements / proficiencies pulls above.
    if (window.RichText) {
      const tRow = DB.queryOne(
        "SELECT json_extract(data, '$.tables') AS t " +
        "FROM entry WHERE id = ?", [cls.class_id]
      );
      if (tRow && tRow.t) {
        try {
          const tables = JSON.parse(tRow.t);
          const tablesHtml = RichText.renderTables(tables);
          if (tablesHtml) {
            html += `<details class="rt-tables-details">` +
              `<summary>Data tables (${tables.length})</summary>` +
              `${tablesHtml}</details>`;
          }
        } catch (e) { /* malformed tables JSON — skip */ }
      }
    }

    panel.innerHTML = html;
    // Activate see-also pill clicks (feat names inside Requirements).
    if (window.Lookup && Lookup.wireSeeAlsoPills) {
      Lookup.wireSeeAlsoPills(panel);
    }
    if (window.ErrataBadge) ErrataBadge.attach(panel, cls.class_id);
    if (window.VersionBadge) VersionBadge.attach(panel, cls.version);
    // Append the collapsible Variants section (ACFs + Sub Levels)
    // below the main summary. Skipped silently if ClassVariants
    // didn't load (e.g. script order issue) or the class has no
    // matching variants.
    if (typeof ClassVariants !== 'undefined' &&
        typeof ClassVariants.renderInto === 'function') {
      ClassVariants.renderInto(panel, cls.class);
    }
    panel.style.display = 'block';
  }

  function applyToSheet(typedName, levelStr, panel) {
    const cls = lookupClass(typedName);
    const level = parseInt(levelStr, 10);
    if (!cls || !level || level < 1) {
      flashPanel(panel, 'Pick a class and a valid level first.', '#a66');
      return;
    }

    // Variant ⇄ base mutual exclusion — a variant class replaces its base,
    // so block holding both (or two variants of the same base) and tell the
    // user which class to remove first.
    const conflict = findVariantConflict(cls.class);
    if (conflict) {
      const msg = conflict.kind === 'base'
        ? `${cls.class} is a variant of ${conflict.other} — remove ${conflict.other} first (a variant replaces its base class).`
        : conflict.kind === 'variant'
          ? `${conflict.other} is a variant of ${cls.class} — remove ${conflict.other} first (you already have its variant).`
          : `${cls.class} and ${conflict.other} are both variants of the same class — remove ${conflict.other} first (one variant at a time).`;
      flashPanel(panel, msg, '#a66');
      return;
    }

    // Update the multiclass state: replace existing entry for this class,
    // or push a new one. Aggregates (BAB, saves, char-class, total level)
    // are then recomputed across the full pickedClasses list. Gestalt routes
    // the entry to the active side (`arr`); non-gestalt is always Side A.
    const arr = gestalt ? sideArray(activeSide) : pickedClasses;
    const existingIdx = findClassEntry(cls.class, arr);
    const entry = {
      className: cls.class,
      level: level,
      classId: cls.class_id,
      // `source` is the brittle-id escape hatch on save/load round-trip.
      // entry.id renumbers on every DB rebuild (rebuilds insert/move
      // entries → auto-increment shifts), so an old save's classId can
      // resolve to the WRONG class (e.g. id 2404 was Sha'ir before
      // the 2026-05-18 Gen+template rebuild, is Mountebank after).
      // loadData looks up by name+source first, then version, then id.
      source: cls.source,
      version: cls.version,
      prog: {
        bab:  cls.bab_progression,
        fort: cls.fort_progression,
        ref:  cls.ref_progression,
        will: cls.will_progression,
      },
    };
    // Detect "+1 caster level of existing X spellcasting class" PrCs.
    const adv = detectSpellAdvancement(cls.class, cls.class_id, level);
    if (adv) {
      entry.advancesTypes = adv.types;
      entry.advancesLevels = adv.levels;
      if (adv.perLevelChoice) {
        // Mark the entry so the UI renders per-level pickers and
        // effectiveSpellLevel routes to advancementSlots.
        entry.perLevelChoice = true;
        entry.advancingLevels = adv.advancingLevels;
        entry.autoAdvanceLowerLevels = adv.autoAdvanceLowerLevels || [];
        entry.requiresStyles = adv.requiresStyles;
        entry.allowsMultiAdvance = adv.allowsMultiAdvance;
      }
    }
    // ToB maneuver-advancement (RKV / JPM / MoN) needs no per-entry
    // stamping — effectiveInitiatorLevel reads the registry
    // (getManeuverAdvancementSpec) directly when computing each panel's IL.
    // Detect invocation-advancement (parallel pillar — Eldritch
    // Disciple, Eldritch Theurge, Demonbinder). Independent of the
    // other pillars; ET populates BOTH spell and invocation.
    const iadv = detectInvocationAdvancement(cls.class, cls.class_id, level);
    if (iadv) {
      entry.invocationAdvancesLevels = iadv.levels;
      entry.invocationAdvancingLevels = iadv.advancingLevels;
    }
    // Detect mystery-advancement (parallel pillar — Master of Shadow,
    // Noctumancer). Independent of the other pillars; Noctumancer
    // populates BOTH spell (arcane) and mystery pillars on the same
    // schedule.
    const mystadv = detectMysteryAdvancement(cls.class, cls.class_id, level);
    if (mystadv) {
      entry.mysteryAdvancesLevels = mystadv.levels;
      entry.mysteryAdvancingLevels = mystadv.advancingLevels;
    }
    // Capture the previous entry's monster-class extensions BEFORE
    // the replace below so applyMonsterClassExtensions can diff
    // against them (re-applying Ogre 2 → Ogre 3 only adds the new
    // L3 changes, not the full L1..L3 stack again).
    const prevMonsterExt = (existingIdx >= 0)
      ? arr[existingIdx].monsterExt : null;
    if (existingIdx >= 0) {
      // Preserve user-pinned target overrides on re-apply (advancesTargets
      // / advancementSlots may have been manually selected by the user
      // later via UI). For perLevelChoice PrCs we preserve slots whose
      // prcLevel is still within the new advancingLevels list and
      // discard the rest (e.g. user dropped UM from L5 → L3, slots at
      // L4+ disappear).
      const prev = arr[existingIdx];
      if (prev.advancesTargets) entry.advancesTargets = prev.advancesTargets;
      if (prev.advancementSlots && entry.perLevelChoice) {
        const keep = new Set(entry.advancingLevels);
        entry.advancementSlots = prev.advancementSlots
          .filter(s => keep.has(s.prcLevel));
      }
      // Same for the invocation pillar (matters once we extract more
      // than one invocation-using base class).
      if (prev.invocationAdvancesTarget) {
        entry.invocationAdvancesTarget = prev.invocationAdvancesTarget;
      }
      if (prev.mysteryAdvancesTarget) {
        entry.mysteryAdvancesTarget = prev.mysteryAdvancesTarget;
      }
      arr[existingIdx] = entry;
    } else {
      arr.push(entry);
    }
    // Seed advancementSlots for new perLevelChoice entries (or freshly
    // re-added slots after a level bump). Defaults each slot to the
    // first eligible target of the appropriate style; the user can
    // change via the chip-list UI.
    if (entry.perLevelChoice) {
      seedAdvancementSlots(entry);
    }

    // Apply Savage-Species-style monster-class extensions: per-level
    // ability score bumps land in the Template column, natural armor
    // in #ac-natural, size in #char-size. Diffed against the entry's
    // previous extensions so re-apply at a higher level only adds
    // the new levels. No-op for non-monster classes.
    applyMonsterClassExtensions(entry, prevMonsterExt);
    const totals = applyAggregatesToSheet();
    renderClassList();

    // Cumulative class features into Special Abilities, tagged per-class
    // so re-applying the same class (different level) refreshes only its
    // own entries, leaving other classes' (and the race's) entries alone.
    const cumulative = dedupSpecials(levelsUpTo(cls.class_id, level));
    populateSpecialAbilities(cls.class, cumulative);

    // Tick class-skill checkboxes (idempotent on re-apply), then point the
    // checkbox at the current class + stamp prior-class markers.
    applyClassSkills(cls.class);
    reconcileCurrentClassSkills();

    // Auto-populate the Class Features tab (turn-undead, rage, etc.) for
    // classes whose features map onto existing UI fields. Only fills
    // empty fields, so user customizations on re-apply survive.
    populateClassFeaturesTab(cls.class, level, cls.class_id);

    // If the class has spellcasting at this level (paladin L4+, wizard L1+,
    // etc.), or uses a spell-adjacent subsystem with its own Spells sub-tab
    // — psionics (Psion/Wilder/…), maneuvers (Crusader/Warblade/Swordsage),
    // invocations (Warlock), vestige binding (Binder), or shadowcasting
    // (Shadowcaster) — ensure the appropriate Spells sub-tab exists and is
    // populated. No tab is created when the class doesn't grant spell access
    // at this level (e.g. paladin L1-3) — per the user's "0 or more, not
    // none" rule.
    const casterPanel = ensureCasterTab(cls.class, level, cls.class_id);

    // Incarnum meldshapers (Totemist/Incarnate/Soulborn) have no Spells
    // sub-tab — their soulmelds live on the Equipment tab — so copy the
    // class_table's per-level soulmeld / essentia / chakra-bind counts
    // into the Equipment tab's soulmeld counter fields.
    if (INCARNUM_CLASSES.has(cls.class)) {
      populateIncarnumCounts(cls.class, level, cls.class_id);
    }

    // Refresh effective spell levels in case this class is an advancer
    // (Eldritch Knight, Mystic Theurge, …) or in case the just-applied
    // class is the new target of a previously-applied advancer.
    refreshAllSpellTabs();

    // Push class-granted spells (Sand Shaper's Desert Insight, etc.)
    // into the target panel's Known list as freebies. See
    // class-spell-additions.js for the catalog. Routes to the first
    // advancement target when the class is an advancer, or to the
    // class's own panel when it's a native caster.
    applyClassSpellAdditions(entry);

    // Trigger the orchestrator's recalc if available.
    if (typeof window.recalcAll === 'function') {
      try { window.recalcAll(); } catch (e) { /* non-fatal */ }
    }

    // Notify cross-module listeners that the applied-class set changed.
    // Used by: app.js (CharacterHistory reconstruction), companion.js
    // (progression-panel refresh + comp-type auto-default). Single
    // dispatch point fired from BOTH applyClass and removeClass.
    try {
      document.dispatchEvent(new CustomEvent('classes-changed', {
        detail: { state: pickedClasses.slice() },
      }));
    } catch (e) { /* non-fatal */ }

    const tabNote = casterPanel ? ' + Spells tab' : '';
    const advParts = [];
    if (entry.advancesTargets && entry.advancesTargets.some(t => t)) {
      advParts.push(entry.advancesTargets.filter(Boolean).join(' + '));
    } else if (entry.advancesTypes && entry.advancesTypes.length) {
      advParts.push(`${entry.advancesTypes.join('+')} caster — no target found`);
    }
    // ToB IL-advancers (RKV / JPM / MoN) are all-target — they add their
    // full level to EVERY martial adept's IL — so the note names no
    // single class.
    if (getManeuverAdvancementSpec(cls.class)) {
      const hasBase = classPool().some(e => MARTIAL_ADEPT_CLASSES.has(e.className));
      advParts.push(hasBase
        ? 'initiator level'
        : 'initiator level — no martial adept class');
    }
    if (entry.invocationAdvancesTarget) {
      advParts.push(`${entry.invocationAdvancesTarget} invocations`);
    } else if (entry.invocationAdvancesLevels) {
      advParts.push(`invocations — no invoker base found`);
    }
    if (entry.mysteryAdvancesTarget) {
      advParts.push(`${entry.mysteryAdvancesTarget} mysteries`);
    } else if (entry.mysteryAdvancesLevels) {
      advParts.push(`mysteries — no mystery base found`);
    }
    const advNote = advParts.length ? ` (advances ${advParts.join(', ')})` : '';
    const summary = pickedClasses
      .map(e => `${e.className} ${e.level}`).join(' / ');
    flashPanel(panel,
      `Classes: ${summary} → BAB +${totals.bab}, ` +
      `Fort +${totals.fort}, Ref +${totals.ref}, Will +${totals.will}` +
      (cumulative.length ? ` (+${cumulative.length} ${cls.class} features)` : '') +
      tabNote + advNote,
      '#7a9');
  }

  // ============================================================
  // Class → Spells-tab integration
  // ============================================================

  // Look up the offset between spells_per_day_json[i] and actual spell
  // level. Wizards/Sorcerers/Bards/Clerics/Druids/Shugenja: 0 (have
  // cantrips). Paladins/Rangers/Hexblades/Assassins/Blackguards: 1 (no
  // cantrips). Drives the data-driven query against spell_class_level
  // first, falls back to a length-based heuristic when no spell_class_level
  // entries exist for the class.
  function getSpellLevelOffset(className, spdLength) {
    const variants = SPELL_CLASS_VARIANTS[className];
    if (variants && variants.length) {
      const placeholders = variants.map(() => '?').join(',');
      const r = DB.queryOne(
        `SELECT MIN(level) AS mn FROM spell_class_level ` +
        `WHERE class_name IN (${placeholders})`,
        variants
      );
      if (r && r.mn !== null && r.mn !== undefined) return r.mn;
    }
    // Heuristic fallback by progression length:
    //   ≥7 (full caster, bard) → starts at 0-level
    //   <7 (paladin/ranger/etc.) → starts at 1st-level
    return spdLength >= 7 ? 0 : 1;
  }

  // Returns { spd, sk } at the given level if the class grants any spell
  // slots (including 0-base slots — paladin L4 has [0, null,...] which
  // counts), else null. Per the user's spec: "0 or more spell slots,
  // not none" — `none` meaning the array entry is null/undefined.
  function getSpellcastingDataAtLevel(classId, classLevel) {
    const row = levelData(classId, classLevel);
    if (!row) return null;
    const spd = parseJsonArray(row.spells_per_day_json);
    // spells_per_day can be a STRING for advancer PrCs (Durthan
    // stores "+1 level of existing spellcasting class" verbatim).
    // Calling `.some()` on a string throws — the same gotcha that
    // bit updatePreview earlier (see comment at the preview-panel
    // code site). For advancer rows, the class has no native
    // spellcasting data of its own; return null so the picker
    // doesn't try to create a panel for it.
    if (!spd || !Array.isArray(spd) || !spd.length) return null;
    // A "real" slot is a NUMBER (including 0 — Paladin L4 is [0,…] and can
    // cast with a high casting stat). Empty entries are dashes ("-"/"—")
    // or null. So a class that only gains spells LATER (Paladin 1-3, all
    // dashes) opens no casting tab until it actually has slots.
    const hasAny = spd.some(n => typeof n === 'number');
    if (!hasAny) return null;
    const sk = parseJsonArray(row.spells_known_json);
    return { spd, sk: Array.isArray(sk) ? sk : null };
  }

  // Find an existing caster panel whose notes start with the class name
  // (case-insensitive). Used for tab dedup so re-applying the same
  // class at a different level updates rather than duplicates.
  function findExistingCasterPanel(type, className) {
    const panels = document.querySelectorAll(
      `#spells-content [data-caster-type="${type}"]`
    );
    const needle = className.toLowerCase();
    for (const p of panels) {
      const notes = p.querySelector('.caster-notes')?.value?.trim().toLowerCase() || '';
      if (notes === needle || notes.startsWith(needle + ' ') ||
          notes.startsWith(needle + ':')) {
        return p;
      }
    }
    return null;
  }

  // Push class-granted spells (Sand Shaper's Desert Insight, etc.)
  // into the target panel's Known list as freebies. Looks up the
  // class in ClassSpellAdditions; for each applicable feature,
  // appends each spell to its level's Known list with a
  // `{ freebie: true, source }` flag. Idempotent — skips spells
  // already present at that level in the target panel.
  function applyClassSpellAdditions(entry) {
    if (typeof ClassSpellAdditions === 'undefined') return;
    if (typeof Spells === 'undefined' ||
        typeof Spells.addKnownSpell !== 'function') return;
    const features = ClassSpellAdditions.applicableFeatures(
      entry.className, entry.level);
    if (!features.length) return;
    // Per Sandstorm (Desert Insight) and the RAW pattern for "adds X
    // spells to your spell list" features: the spells expand EVERY
    // spellcasting class the character has, not just the one the
    // granting class advances. For a Wizard 5 / Cleric 3 / Sand
    // Shaper 1, Desert Insight adds L1 desert spells to both the
    // Wizard's Spellbook AND the Cleric's Known list, each capped
    // at that panel's own max castable level.
    //
    // Future-proofing: if a future class-feature has narrower scope
    // (e.g. "adds spells to your Wizard list only"), grow the
    // catalog entry to carry a `scope: "all-casters" | "own" |
    // "advancement-target"` field and switch behavior here. For now
    // every catalog entry is implicitly all-casters, matching RAW.
    const targetPanels = document.querySelectorAll(
      '#spells-content [data-caster-type="spellcasting"]');
    if (!targetPanels.length) return;  // no panel to push into yet
    for (const panel of targetPanels) {
      applyFeaturesToPanel(panel, features, entry.className);
    }
  }

  // Compute the panel's max castable level (highest level with at
  // least one of base/domain/specialist slots > 0), then push every
  // applicable feature's spells into the panel's Known list, capped
  // at that level. Per PHB & Sandstorm: class features that "add
  // spells to your spell list" only confer access to spell levels
  // the caster can already cast. Without this cap, Sand Shaper L1
  // (entering at Sha'ir CL 3 → max castable L2) would inject L3-L9
  // Desert Insight spells the character can never cast.
  function applyFeaturesToPanel(panel, features, className) {
    let maxCastable = 0;
    for (let i = 9; i >= 0; i--) {
      const perDay = parseInt(
        panel.querySelector(`.sc-per-day[data-lvl="${i}"]`)?.value || '0',
        10);
      const domain = parseInt(
        panel.querySelector(`.sc-domain-slots[data-lvl="${i}"]`)?.value || '0',
        10);
      const specialist = parseInt(
        panel.querySelector(`.sc-specialist-slots[data-lvl="${i}"]`)?.value || '0',
        10);
      if ((perDay + domain + specialist) > 0) { maxCastable = i; break; }
    }
    for (const feature of features) {
      const source = `${className} — ${feature.featureName}`;
      for (const [lvlStr, spells] of Object.entries(feature.spellsByLevel || {})) {
        const lvl = parseInt(lvlStr, 10);
        if (isNaN(lvl) || lvl < 0 || lvl > 9) continue;
        // Skip freebie levels above this panel's current max access.
        if (lvl > maxCastable) continue;
        const listEl = panel.querySelector(
          `.sc-known-list[data-lvl="${lvl}"]`);
        if (!listEl) continue;
        // Dedup: skip if a row with the same name already exists at
        // this level (regardless of freebie flag — don't double-add).
        const existing = new Set(
          [...listEl.querySelectorAll('.sc-known-name')]
            .map(el => (el.value || '').trim().toLowerCase())
        );
        for (const name of spells) {
          if (existing.has(name.toLowerCase())) continue;
          Spells.addKnownSpell(listEl, lvl, name,
            { freebie: true, source });
          existing.add(name.toLowerCase());
        }
      }
    }
  }

  // Inverse of applyClassSpellAdditions — strips any freebie rows
  // sourced from this class out of every spellcasting panel's Known
  // list. Called from removeClass to keep the panels in sync when a
  // class is removed. The Known counter refreshes via the
  // sc-known-remove handler each row already carries… but those
  // handlers fire on user-initiated clicks; here we're removing
  // nodes directly, so we explicitly trigger Spells.recalc() at
  // the end to refresh per-level counters.
  function removeClassGrantedSpells(className) {
    const prefix = (className + ' — ').toLowerCase();
    const rows = document.querySelectorAll(
      '#spells-content .sc-known-row[data-freebie="1"]');
    let removed = 0;
    for (const row of rows) {
      const src = (row.dataset.source || '').toLowerCase();
      if (src.startsWith(prefix)) { row.remove(); removed++; }
    }
    if (removed > 0 && typeof Spells !== 'undefined' &&
        typeof Spells.recalc === 'function') {
      // Re-run the spellcasting recalc to refresh counters / DCs /
      // slot tracking after the rows disappeared.
      try { Spells.recalc(); } catch (e) { /* non-fatal */ }
    }
  }

  // Clear Class Features tab fields (Turn/Rebuke per-day, Rage
  // counts, etc.) that were auto-filled by populateClassFeaturesTab
  // for this class. Identifies via the `data-from-class` marker
  // setIfEmpty stamps on each filled field. User edits clear the
  // marker via the input listener wired in setIfEmpty, so manually-
  // customized values are preserved across class removal.
  function removeAutoFilledClassFeatureFields(className) {
    const escaped = String(className).replace(/"/g, '\\"');
    const fields = document.querySelectorAll(
      `[data-from-class="${escaped}"]`);
    for (const el of fields) {
      el.value = '';
      delete el.dataset.fromClass;
      // Notify any downstream listeners (recalcAll, etc.) that the
      // value changed. Dispatch via the document path so the
      // existing input delegation picks it up.
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function ensureCasterTab(className, classLevel, classId) {
    if (typeof Spells?.addCaster !== 'function') return null;
    const sc = getSpellcastingDataAtLevel(classId, classLevel);
    if (sc) {
      const offset = getSpellLevelOffset(className, sc.spd.length);
      return upsertSpellcastingPanel(className, classLevel, sc, offset);
    }
    if (PSIONIC_CLASSES.has(className)) {
      return ensureSimpleCasterTab('psionics', className, classLevel, {
        createData: { manifesterLevel: classLevel },
        levelSelectors: ['.psi-manifester-level'],
      });
    }
    if (MARTIAL_ADEPT_CLASSES.has(className)) {
      const panel = ensureSimpleCasterTab('maneuvers', className, classLevel, {
        levelSelectors: ['.tom-init-level'],
      });
      // M2 (2026-05-16 play-feel pass): auto-populate the ToB count
      // fields (Initiator Level / Maneuvers Known / Maneuvers Readied
      // / Stances Known) from the class_table's `columns` block. Same
      // setIfEmpty pattern as populateClassFeaturesTab — only fills
      // blank fields, tags with data-from-class so removeClass strips,
      // user edits clear the marker via event.isTrusted listener.
      if (panel) populateManeuverPanelCounts(panel, className, classLevel);
      return panel;
    }
    // Spell-adjacent subsystems with their own Spells sub-tab type but
    // no spells_per_day progression: Warlock → invocations, Binder →
    // vestige binding, Shadowcaster → shadowcasting. Same auto-create-
    // and-level-sync contract as psionics/maneuvers above. The level
    // seeds the relevant "caster/binder/invoker level" field; available
    // class_table count columns are prefilled (M2-style) where present.
    if (INVOCATION_USING_CLASSES.has(className)) {
      const panel = ensureSimpleCasterTab('invocations', className, classLevel, {
        createData: { invokerLevel: classLevel, casterLevel: classLevel,
                      invoClass: className },
        levelSelectors: ['.invo-level', '.invo-caster-level'],
      });
      if (panel) populateInvocationPanelCounts(panel, className, classLevel, classId);
      return panel;
    }
    if (VESTIGE_USING_CLASSES.has(className)) {
      const panel = ensureSimpleCasterTab('binding', className, classLevel, {
        createData: { binderLevel: classLevel },
        levelSelectors: ['.bind-level'],
      });
      if (panel) populateBinderPanelCounts(panel, className, classLevel, classId);
      return panel;
    }
    if (MYSTERY_USING_CLASSES.has(className)) {
      // Shadowcaster's mystery counts aren't in the class_table columns
      // (mysteries-known derives from a per-level formula in the class
      // text), so we seed the caster level only.
      return ensureSimpleCasterTab('shadowcaster', className, classLevel, {
        createData: { casterLevel: classLevel },
        levelSelectors: ['.sh-caster-level'],
      });
    }
    return null;
  }

  // Parse a single entry from spells_per_day_json. Cleric (and other
  // domain casters) store entries as the string "N+M" — N base slots
  // plus M domain/specialist slot. Returns { base, bonus } where bonus
  // covers domain (Cleric) or specialist (Wizard) extras.
  function parseSlotEntry(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number') return { base: raw, bonus: 0 };
    const s = String(raw).trim();
    const m = s.match(/^(\d+)\s*\+\s*(\d+)$/);
    if (m) return { base: parseInt(m[1], 10), bonus: parseInt(m[2], 10) };
    const n = parseInt(s, 10);
    if (!isNaN(n)) return { base: n, bonus: 0 };
    return null;
  }

  // "Knows-whole-list" casters have no per-level Spells Known table in
  // their source (they know every spell on their list of any castable
  // level, with whatever advanced-learning rules apply). For these we
  // skip the spells-known auto-fill and prefill the notes with the
  // canonical "knows everything" reminder so the user understands why
  // the Known column stays blank.
  // Sha'ir DOES have a per-level Spells Known table (Dragon Compendium
  // Table 2-12) — the gen-retrieval mechanic interacts with it but
  // doesn't replace it, so Sha'ir is handled as a normal spontaneous
  // caster. The classes below have no per-level Spells Known table in
  // their source (they know every spell on their list of any castable
  // level); for them we prefill the panel notes so the user understands
  // why the Known column stays blank.
  const KNOWS_WHOLE_LIST_NOTES = {
    'Beguiler': "Beguiler — knows every spell on the beguiler spell list of any level she can cast (plus advanced learning).",
    'Warmage': 'Warmage — knows every spell on the warmage spell list of any level he can cast (plus advanced learning).',
    'Dread Necromancer': 'Dread Necromancer — knows every spell on the dread necromancer spell list of any level he can cast (plus advanced learning).',
    'Healer': 'Healer — knows every spell on the healer spell list of any level she can cast.',
    'Artificer': "Artificer — knows every infusion on the artificer infusion list of any level he can cast. Infusions imbue items/constructs only (not creatures) and NEVER ALLOW SAVING THROWS (DC column n/a).",
  };

  // M1 (2026-05-16 play-feel pass): classes that prepare spells from
  // their entire class list (no personal Known/spellbook). Toggling
  // off `showKnown` for these classes hides a column that's dead UI
  // for them. Wizard / Wu Jen / Assassin / Death Master / Archivist
  // keep both columns visible (spellbook IS their Known list).
  const PREPARES_FROM_WHOLE_LIST = new Set([
    'Cleric', 'Druid', 'Paladin', 'Ranger', 'Sohei', 'Urban Druid',
    'Apostle of Peace', 'Blackguard',
  ]);

  function upsertSpellcastingPanel(className, classLevel, sc, offset) {
    const notesText = KNOWS_WHOLE_LIST_NOTES[className] || className;
    const style = getCasterStyle(className);
    // Spontaneous casters don't prepare — hide Prepared column by default.
    // Prepared-from-whole-list casters don't track a personal Known list —
    // hide Known column by default. Other prepared casters (Wizard /
    // Archivist / Beguiler-via-spellbook / etc.) show both.
    // Beguiler/Warmage/Dread Necromancer/Healer are 'spontaneous' style
    // AND knows-whole-list — both columns hidden makes the panel useless,
    // so we keep Known visible (so the user can override and add
    // advanced-learning picks) but hide Prepared.
    const showKnownDefault = !PREPARES_FROM_WHOLE_LIST.has(className);
    const showPreparedDefault = style !== 'spontaneous';
    const data = {
      name: className,
      notes: notesText,
      casterLevel: classLevel,
      ability: getKeyAbility(className) || '',
      // Set only when the class uses a different ability for bonus
      // spells than for DCs (Favored Soul / Spirit Shaman). Blank
      // for everyone else; recalc falls back to `ability` then.
      bonusAbility: getBonusSpellAbility(className) || '',
      maxLevel: 9,
      showKnown: showKnownDefault,
      showPrepared: showPreparedDefault,
    };
    let anyBonus = false;
    for (let i = 0; i < sc.spd.length; i++) {
      const lvl = offset + i;
      if (lvl < 0 || lvl > 9) continue;
      const v = parseSlotEntry(sc.spd[i]);
      if (v) {
        data[`perDay-${lvl}`] = v.base;
        if (v.bonus > 0 && lvl >= 1) {
          data[`domain-${lvl}`] = v.bonus;
          anyBonus = true;
        }
      }
      if (sc.sk) {
        const k = parseSlotEntry(sc.sk[i]);
        if (k) data[`known-${lvl}`] = k.base;
      }
    }
    // Enable domain access for clerics (and any class whose progression
    // has "N+M" entries — that "+M" is the domain/specialist slot).
    // Cleric is the canonical case; specialist wizards get +1 too but
    // the stored generic-wizard progression doesn't include it.
    if (anyBonus && className === 'Cleric') data.domainAccess = true;
    // Sha'ir: gen-retrieval gives access to spells from nine fixed
    // elemental and conceptual domains (Air, Chaos, Earth, Fire,
    // Knowledge, Law, Luck, Sun, Water) per Dragon Compendium. Domain
    // *spells* are retrievable; no granted power. Prefill the nine
    // entries so the domain-picker's spell-list info panels render
    // for the player without manual typing.
    if (className === "Sha'ir") {
      data.domainAccess = true;
      data.domains = [
        'Air', 'Chaos', 'Earth', 'Fire',
        'Knowledge', 'Law', 'Luck', 'Sun', 'Water',
      ].map(n => ({
        name: n,
        power: "Sha'ir — spells only, no granted power.",
      }));
    }

    const existing = findExistingCasterPanel('spellcasting', className);
    if (existing) {
      updateSpellcastingPanel(existing, data, classLevel, sc.spd.length, offset);
      _stampNoSaveDc(existing, className);
      return existing;
    }
    Spells.addCaster('spellcasting', data);
    const fresh = findExistingCasterPanel('spellcasting', className);
    _stampNoSaveDc(fresh, className);
    return fresh;
  }

  // Set a panel-level data attribute when the applied class never
  // allows save DCs (Artificer). Spells.js reads this and displays
  // "—" instead of computing 10 + spell level + key-ability mod.
  function _stampNoSaveDc(panel, className) {
    if (!panel) return;
    if (getNoSaveDc(className)) {
      panel.dataset.noSaveDc = '1';
    } else {
      delete panel.dataset.noSaveDc;
    }
  }

  function updateSpellcastingPanel(panel, data, classLevel, spdLength, offset) {
    // Notes: only set if currently empty or matches a leading class name
    // (don't clobber user-added text like "Wizard — focused conjurer").
    const notes = panel.querySelector('.caster-notes');
    if (notes && !notes.value.trim()) {
      notes.value = data.notes;
      notes.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const cl = panel.querySelector('.sc-caster-level');
    if (cl) {
      cl.value = classLevel;
      cl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const ab = panel.querySelector('.sc-ability');
    if (ab && data.ability && !ab.value) {
      ab.value = data.ability;
      ab.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const bab = panel.querySelector('.sc-bonus-ability');
    if (bab && data.bonusAbility && !bab.value) {
      bab.value = data.bonusAbility;
      bab.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // Clear the per-day/known fields IN THE CLASS'S RANGE first so that
    // re-applying at a lower level (e.g. Wizard 7 → Wizard 3) drops the
    // higher-level slots back to empty. Levels outside the class's range
    // (e.g. Bonus Spells from a multiclass other-source) are left alone.
    const lo = offset, hi = offset + spdLength - 1;
    for (let lvl = lo; lvl <= Math.min(9, hi); lvl++) {
      const pd  = panel.querySelector(`.sc-per-day[data-lvl="${lvl}"]`);
      const kn  = panel.querySelector(`.sc-known[data-lvl="${lvl}"]`);
      const dom = panel.querySelector(`.sc-domain-slots[data-lvl="${lvl}"]`);
      if (pd)  pd.value  = '';
      if (kn)  kn.value  = '';
      if (dom) dom.value = '';
    }
    // If the new data activates domain access on a tab that previously
    // didn't have it, flip the toggle so the column becomes visible.
    if (data.domainAccess) {
      const dt = panel.querySelector('.sc-domain-toggle');
      if (dt && !dt.checked) {
        dt.checked = true;
        dt.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    for (const key of Object.keys(data)) {
      const m = key.match(/^(perDay|known|domain)-(\d+)$/);
      if (!m) continue;
      const klass = m[1] === 'perDay' ? 'sc-per-day'
                  : m[1] === 'known'  ? 'sc-known'
                  : 'sc-domain-slots';
      const inp = panel.querySelector(`.${klass}[data-lvl="${m[2]}"]`);
      if (inp) {
        inp.value = data[key];
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    if (typeof Spells?.recalc === 'function') {
      try { Spells.recalc(); } catch (e) { /* non-fatal */ }
    }
  }

  // Create (or re-sync) a non-spellcasting caster sub-tab — psionics,
  // maneuvers, invocations, vestige binding, shadowcasting. These have
  // no spells_per_day slot table, so the sub-tab is keyed by class name
  // and the class level seeds a single "level" field per subsystem.
  //
  // opts:
  //   createData     — extra data keys merged into the addCaster() blob
  //                    on CREATE, so the panel opens with its level
  //                    field(s) pre-filled (e.g. { invokerLevel,
  //                    casterLevel } for Warlock → buildInvocationsHTML).
  //   levelSelectors — panel input selectors re-synced to classLevel on
  //                    RE-APPLY (level-up). Must name the SUBSYSTEM's
  //                    real level inputs — psionics is .psi-manifester-
  //                    level, maneuvers .tom-init-level, etc. (The old
  //                    hard-coded '.sc-caster-level, .pp-manifester-level'
  //                    matched NONE of these, so a re-applied psionic
  //                    class never bumped its manifester level — fixed by
  //                    passing the correct selectors from ensureCasterTab.)
  function ensureSimpleCasterTab(type, className, classLevel, opts) {
    opts = opts || {};
    const levelSelectors = opts.levelSelectors
      || ['.sc-caster-level', '.psi-manifester-level'];
    const existing = findExistingCasterPanel(type, className);
    if (existing) {
      for (const sel of levelSelectors) {
        const cl = existing.querySelector(sel);
        if (cl) {
          cl.value = classLevel;
          cl.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      return existing;
    }
    const data = Object.assign(
      { name: className, notes: className }, opts.createData || {});
    Spells.addCaster(type, data);
    return findExistingCasterPanel(type, className);
  }

  // ============================================================
  // Class skills integration
  // ============================================================

  // Knowledge subtype spellings differ between the sheet's fixed list
  // (data.js uses abbreviated labels) and the DB's free-text
  // `class_skills` strings (lowercased, and sometimes spelled out).
  // Map normalized DB subtype → the sheet's subtypeLabel, both compared
  // lowercased. Anything not listed falls through to a direct
  // case-insensitive subtype match (which already covers arcana,
  // religion, the planes, nature, dungeoneering, geography, history,
  // local, nobility, …).
  const KNOWLEDGE_SUBTYPE_ALIASES = {
    'architecture and engineering': 'arch. & eng.',
    'architecture': 'arch. & eng.',
    'arch. and eng.': 'arch. & eng.',
    'nobility and royalty': 'nobility',
    'royalty and nobility': 'nobility',
  };

  // A Knowledge spec that names no single concrete subtype — "all",
  // "all skills, taken individually", "any", "any one/two/three", or a
  // bare "Knowledge" — expands to EVERY Knowledge row. The "any N"
  // choose-some forms are intentionally expanded to all (the user can
  // untick the ones they didn't pick); marking nothing was the bug.
  function isKnowledgeAllSpec(inner) {
    const s = inner.trim().toLowerCase();
    return s === '' || /^all\b/.test(s) || /^any\b/.test(s)
      || /individually/.test(s);
  }

  // Resolve a class-skill spec to the matching `.skill-class-check`
  // checkboxes in the Skills tab. Specs:
  //   "Climb"                → exact-match by .skill-name
  //   "Knowledge (religion)" → case-insensitive match against a Knowledge
  //                            subtype row (DB strings are lowercased)
  //   "Knowledge (all skills, taken individually)" / "(any)" / bare
  //                          → all Knowledge subtype rows
  //   "Craft" / "Perform" / "Profession" → all currently-added subtype
  //                            entries for that base skill
  function findSkillCheckboxesForSpec(spec) {
    const out = [];
    const tab = document.getElementById('tab-skills');
    if (!tab) return out;

    const specTrim = String(spec || '').trim();

    // Knowledge — heterogeneous, lowercased DB strings need tolerant
    // matching. Catches "Knowledge", "Knowledge (arcana)", and the whole
    // all/any/individually family.
    const km = specTrim.match(/^knowledge\s*(?:\((.*)\))?\s*$/i);
    if (km) {
      const inner = km[1] || '';
      const all = isKnowledgeAllSpec(inner);
      let want = inner.trim().toLowerCase();
      if (KNOWLEDGE_SUBTYPE_ALIASES[want]) want = KNOWLEDGE_SUBTYPE_ALIASES[want];
      // FR campaign "Knowledge (<region> local)" → the generic Local row.
      if (/\blocal$/.test(want)) want = 'local';
      tab.querySelectorAll('tr[data-skill-index]').forEach(tr => {
        const name = tr.querySelector('.skill-name')?.textContent?.trim() || '';
        const m = name.match(/^Knowledge\s*\((.*)\)\s*$/i);
        if (!m) return;
        if (all || m[1].trim().toLowerCase() === want) {
          const cb = tr.querySelector('.skill-class-check');
          if (cb) out.push(cb);
        }
      });
      return out;
    }
    if (spec === 'Craft' || spec === 'Perform' || spec === 'Profession') {
      tab.querySelectorAll(`tr[data-subtype-of="${spec}"]`).forEach(tr => {
        const cb = tr.querySelector('.skill-class-check');
        if (cb) out.push(cb);
      });
      return out;
    }
    // Specific Craft/Perform/Profession subtype, e.g. "Craft (alchemy)".
    // Match an existing subtype row case-insensitively (rows may be
    // user-made or auto-created by a structured bonus, e.g. Gnome alchemy).
    const subM = specTrim.match(/^(Craft|Perform|Profession)\s*\((.+)\)\s*$/i);
    if (subM) {
      const base = subM[1].toLowerCase(), sub = subM[2].trim().toLowerCase();
      tab.querySelectorAll('tr[data-subtype-of]').forEach(tr => {
        if ((tr.dataset.subtypeOf || '').toLowerCase() !== base) return;
        const s = (tr.querySelector('.skill-subtype-input')?.value || '').trim().toLowerCase();
        if (s === sub) { const cb = tr.querySelector('.skill-class-check'); if (cb) out.push(cb); }
      });
      return out;
    }
    // Plain skill — exact match by display name.
    tab.querySelectorAll('tr[data-skill-index]').forEach(tr => {
      const name = tr.querySelector('.skill-name')?.textContent?.trim() || '';
      if (name === spec) {
        const cb = tr.querySelector('.skill-class-check');
        if (cb) out.push(cb);
      }
    });
    return out;
  }

  // Tick class-skill checkboxes for `className`. Tracks the originating
  // class on the checkbox via dataset.classSkillSources (comma-separated)
  // so removeClass can untick only when no other applied class still
  // claims it. Manually-ticked boxes (no dataset.classSkillSources) are
  // never modified by remove.
  // Set of every feat name (lowercased) in the DB. Used to recognize when
  // a class feature IS a granted feat (Track, Endurance, Scribe Scroll).
  // Cached after the first DB-ready build.
  let _featNameSet = null;
  function featNameSet() {
    if (_featNameSet) return _featNameSet;
    const s = new Set();
    if (window.DB && DB.isLoaded()) {
      for (const r of DB.query(
        "SELECT DISTINCT LOWER(name) AS n FROM entry WHERE type='feat'")) {
        if (r.n) s.add(r.n);
      }
      _featNameSet = s;   // only cache once the DB is actually loaded
    }
    return s;
  }

  // Inject the FIXED bonus feats a class grants into the Feats tab as
  // derived rows. The reliable signal (audited DB-wide 2026-06-29): a
  // class_features entry whose NAME matches a feat AND whose DESCRIPTION
  // says "bonus feat". This catches genuine grants (Track/Endurance/
  // Scribe Scroll/Weapon Finesse/…) while excluding same-named class
  // features that aren't feat grants (Damage Reduction, Trap Sense,
  // Scent) and choice-based "Bonus Feats" (which name no specific feat).
  // Rows are DERIVED (Feats.collectData skips data-from-class-feat), so
  // they re-derive on load rather than persisting + duplicating — same
  // model as bloodline.syncBonusFeats. Reconcile-idempotent.
  function syncClassBonusFeats() {
    const container = document.getElementById('feats-container');
    if (!container || typeof Feats === 'undefined'
        || typeof Feats.addFeat !== 'function') return;
    const feats = featNameSet();
    if (!feats.size) return;
    const strip = s => String(s || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    const wanted = [];
    const seen = new Set();
    for (const pc of [...pickedClasses, ...pickedClassesB]) {
      if (!pc || !pc.classId) continue;
      const cf = fetchClassFeatures(pc.classId);
      if (!cf) continue;
      for (const f of cf) {
        if (Number(f.level_acquired || 0) > Number(pc.level || 0)) continue;
        const nm = strip(f.name).toLowerCase();
        if (!nm || !feats.has(nm)) continue;
        if (!/bonus feat/i.test(f.description || '')) continue;
        const key = `${pc.className}|${nm}|${f.level_acquired}`;
        if (seen.has(key)) continue;
        seen.add(key);
        wanted.push({ feat: strip(f.name), level: f.level_acquired,
                      cls: pc.className, key });
      }
    }
    const existing = [...container.querySelectorAll(
      '.feat-row[data-from-class-feat="1"]')];
    const existingKeys = existing.map(r => r.dataset.classFeatKey || '');
    const wantedKeys = wanted.map(w => w.key);
    const inSync = existingKeys.length === wantedKeys.length
      && existingKeys.every((k, i) => k === wantedKeys[i]);
    if (inSync) return;
    existing.forEach(r => r.remove());
    for (const w of wanted) {
      // sourceLabel: renders a read-only info box (like picker-added feats)
      // with the granting class shown as a tag, not an editable spec.
      Feats.addFeat(w.feat, { sourceLabel: `${w.cls} bonus feat — L${w.level}` });
      const rows = container.querySelectorAll('.feat-row');
      const row = rows[rows.length - 1];
      if (!row) continue;
      row.dataset.fromClassFeat = '1';
      row.dataset.classFeatKey = w.key;
      row.classList.add('feat-from-class');
      const ta = row.querySelector('.feat-entry');
      if (ta) ta.dataset.fromClassFeat = '1';
    }
  }

  // Auto-fill the Class Features tab from a class's class_features data.
  // For classes that have UI fields (turn-undead, rage), we map the
  // relevant features. Existing non-empty fields are left alone so user
  // overrides survive re-apply. Idempotent.
  function populateClassFeaturesTab(className, level, classId) {
    if (!classId) return;
    const features = fetchClassFeatures(classId);
    if (!features) return;
    const acquired = features.filter(f =>
      Number(f.level_acquired || 0) <= Number(level));
    if (!acquired.length) return;

    // Set the field if it's currently empty AND tag it with
    // `data-from-class=<className>` so removeClass can later strip
    // values it auto-filled. Manual user edits (input events) clear
    // the marker so the user's override survives a class removal.
    // The clear-on-edit listener is attached only once per element
    // (guarded by `data-from-class-wired`).
    const setIfEmpty = (id, val) => {
      const el = document.getElementById(id);
      if (!el || el.value.trim()) return;
      el.value = val;
      el.dataset.fromClass = className;
      if (!el.dataset.fromClassWired) {
        el.dataset.fromClassWired = '1';
        el.addEventListener('input', (ev) => {
          // Only clear the marker if THIS event isn't the synthetic
          // one we dispatched right after setting the value. The
          // distinguisher: when we set, isTrusted is false and we
          // dispatch immediately. User keystrokes are trusted.
          if (ev.isTrusted) delete el.dataset.fromClass;
        });
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };

    // M3 (2026-05-16 play-feel pass): when the player has a non-zero
    // ability score set, substitute the actual mod into the template
    // so the displayed value is computed (e.g. "3 + CHA mod" → "5"
    // for CHA 16, "1d20 + CHA mod" → "1d20 + 3"). Falls back to the
    // raw template string when the ability isn't set yet — re-applying
    // the class after setting abilities picks up the new value.
    // Future enhancement: store the template in a data-attribute and
    // re-substitute on every recalcAll so changing an ability mid-
    // game updates the displayed value automatically.
    function getMod(ab) {
      // getAbilityMod isn't on window — read the pre-computed mod from
      // the corresponding `<span id="{ab}-mod">` ("+1", "-2", "+0").
      // Returns null if no score is set (span empty / unparseable).
      const span = document.getElementById(`${ab.toLowerCase()}-mod`);
      if (!span) return null;
      const txt = (span.textContent || '').trim();
      if (!txt) return null;
      const m = parseInt(txt, 10);
      return Number.isFinite(m) ? m : null;
    }
    function fmtDieModifier(n) {
      if (!Number.isFinite(n) || n === 0) return '';
      return ` ${n >= 0 ? '+' : '-'} ${Math.abs(n)}`;
    }

    // ---- Turn / Rebuke Undead --------------------------------------------
    const hasTurn = acquired.some(f =>
      /\bturn\b|\brebuke\b/i.test(f.name || ''));
    if (hasTurn) {
      const chaMod = getMod('CHA');
      setIfEmpty(
        'turn-per-day',
        chaMod !== null ? String(3 + chaMod) : '3 + CHA mod'
      );
      setIfEmpty(
        'turn-check',
        chaMod !== null ? `1d20${fmtDieModifier(chaMod)}` : '1d20 + CHA mod'
      );
      setIfEmpty(
        'turn-damage',
        chaMod !== null
          ? `2d6${fmtDieModifier(level + chaMod)}`
          : `2d6 + ${level} + CHA mod`
      );
    }

    // ---- Rage / Greater Rage / Mighty Rage --------------------------------
    const rageFeat = acquired.find(f => /^rage$/i.test(f.name || ''));
    if (rageFeat) {
      // Rages/day progression for Barbarian (PHB p.25):
      //   L1=1, L4=2, L8=3, L12=4, L16=5, L20=6.
      // Use a closed-form: 1 + floor((L-1)/4), capped at level/4 milestones.
      const perDay = 1 +
        (level >= 4 ? 1 : 0) +
        (level >= 8 ? 1 : 0) +
        (level >= 12 ? 1 : 0) +
        (level >= 16 ? 1 : 0) +
        (level >= 20 ? 1 : 0);
      setIfEmpty('rage-per-day', String(perDay));
      const conMod = getMod('CON');
      setIfEmpty(
        'rage-duration',
        conMod !== null ? String(3 + conMod) : '3 + CON mod'
      );
      // Greater (L11), Mighty (L20) bumps.
      const hasMighty = acquired.some(f => /mighty rage/i.test(f.name || ''));
      const hasGreater = acquired.some(f => /greater rage/i.test(f.name || ''));
      const ab = hasMighty ? '+8' : hasGreater ? '+6' : '+4';
      const will = hasMighty ? '+4' : hasGreater ? '+3' : '+2';
      setIfEmpty('rage-str-con', ab);
      setIfEmpty('rage-will', will);
      setIfEmpty('rage-ac', '-2');
    }
  }

  // Shared "fill only if blank, tag with data-from-class, clear the
  // marker on user edit" setter for class-driven panel auto-fill.
  // Returns a setIfEmpty(selector, value) closure scoped to `panel` /
  // `className`. Centralizes the M2 contract — user edits survive
  // re-apply; removeClass strips untouched auto-fills via the
  // data-from-class marker — so the maneuver / invocation / binder
  // count populators below all behave identically.
  function makeClassFieldSetter(panel, className) {
    return (sel, val) => {
      const el = panel.querySelector(sel);
      if (!el) return;
      // Fill when blank, OR re-sync when the field still carries OUR
      // auto-fill marker (the player hasn't hand-edited it — a manual
      // edit clears data-fromClass via the isTrusted listener below).
      // This lets per-level counts (maneuvers/invocations known, max
      // vestige level) advance on level-up — e.g. Binder 5→9 bumps Max
      // Vestige Level 3→5 — while a value the player typed is preserved.
      // (Programmatic re-fills dispatch a non-trusted input event, so
      // they never trip the marker-clearing listener.)
      const stillAuto = el.dataset.fromClass === className;
      if (el.value.trim() && !stillAuto) return;
      el.value = val;
      el.dataset.fromClass = className;
      if (!el.dataset.fromClassWired) {
        el.dataset.fromClassWired = '1';
        el.addEventListener('input', (ev) => {
          if (ev.isTrusted) delete el.dataset.fromClass;
        });
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
  }

  // Resolve the class_table row for `classId` at `level` (or null).
  // Shared by the count populators below. Different subsystems store
  // their per-level counts differently — ToB / Warlock under a nested
  // `columns` block, Binder as a top-level `max_vestige_level` field —
  // so callers read the row directly rather than assuming a shape.
  function classTableRowAt(classId, level) {
    if (!classId) return null;
    const table = fetchClassTable(classId);
    if (!table || !table.length) return null;
    return table.find(r => Number(r.level) === Number(level)) || null;
  }

  // "3rd" / "1st" / "10th" / 3 → leading integer; null if unparseable.
  function parseOrdinalInt(v) {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const m = String(v).match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  }

  // M2: Populate Tome of Battle maneuver/stance counts on the panel
  // from the class_table row's `columns` block. setIfEmpty pattern:
  // only fills empty fields, tags with data-from-class, clears the
  // marker on user edit.
  function populateManeuverPanelCounts(panel, className, level) {
    if (!panel) return;
    // Find the class's classId via the picked-classes list (we know it
    // was just applied, so it's there). Union so a Side-B martial adept
    // resolves too.
    const entry = classPool().find(p => p.className === className);
    const row = classTableRowAt(entry?.classId, level);
    if (!row || !row.columns) return;
    const cols = row.columns;
    const setPanelIfEmpty = makeClassFieldSetter(panel, className);
    setPanelIfEmpty('.tom-init-level',     String(level));
    if (cols.maneuvers_known   != null) setPanelIfEmpty('.tom-known-count',   String(cols.maneuvers_known));
    if (cols.maneuvers_readied != null) setPanelIfEmpty('.tom-readied-count', String(cols.maneuvers_readied));
    if (cols.stances_known     != null) setPanelIfEmpty('.tom-stances-count', String(cols.stances_known));
  }

  // Warlock-style invocation counts. The class_table row's `columns`
  // block carries invocations_known per level (Warlock L5 → 3). Highest
  // Grade and the per-grade breakdown aren't in the table (grade access
  // is a level formula in the class text), so we prefill the known count
  // only; the player sets Highest Grade. Same setIfEmpty contract.
  function populateInvocationPanelCounts(panel, className, level, classId) {
    if (!panel) return;
    const row = classTableRowAt(classId, level);
    const known = row?.columns?.invocations_known;
    if (known == null) return;
    makeClassFieldSetter(panel, className)('.invo-known-count', String(known));
  }

  // Binder vestige counts. max_vestige_level is a top-level ordinal
  // string on the row ("3rd") — parse the leading integer into the
  // panel's Max Vestige Level field. Max Vestiges Bound isn't a table
  // column (it's a level rule in the class text), so it's left for the
  // player. Same setIfEmpty contract.
  function populateBinderPanelCounts(panel, className, level, classId) {
    if (!panel) return;
    const row = classTableRowAt(classId, level);
    const mv = parseOrdinalInt(row?.max_vestige_level);
    if (mv == null) return;
    makeClassFieldSetter(panel, className)('.bind-max-vestige', String(mv));
  }

  // Copy an incarnum meldshaper's per-level counts (soulmelds shaped /
  // essentia pool / chakra binds, all in the class_table row's `columns`
  // block) into the Equipment tab's soulmeld counter inputs. These
  // counters live on a different tab (no panel), so we target them by id
  // off `document`. The Equipment fields default to "0", so unlike the
  // spell-panel setter we treat "0" as unset too — the first apply fills
  // them, level-up re-syncs while still auto-marked, and removeClass
  // strips them via the global data-from-class sweep
  // (removeAutoFilledClassFeatureFields). A user-typed non-zero value
  // clears the marker (isTrusted listener) and is preserved.
  function populateIncarnumCounts(className, level, classId) {
    const row = classTableRowAt(classId, level);
    const cols = row && row.columns;
    if (!cols) return;
    const set = (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const cur = (el.value || '').trim();
      const stillAuto = el.dataset.fromClass === className;
      if (cur !== '' && cur !== '0' && !stillAuto) return;
      el.value = String(val);
      el.dataset.fromClass = className;
      if (!el.dataset.fromClassWired) {
        el.dataset.fromClassWired = '1';
        el.addEventListener('input', (ev) => {
          if (ev.isTrusted) delete el.dataset.fromClass;
        });
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    if (cols.soulmelds    != null) set('#sm-max-soulmelds', cols.soulmelds);
    if (cols.essentia     != null) set('#sm-max-essentia',  cols.essentia);
    if (cols.chakra_binds != null) set('#sm-max-binds',     cols.chakra_binds);
  }

  // Variant classes (variant_of) inherit their PARENT's class features —
  // but only the ones the variant actually GETS (its class_table special
  // column enumerates them), each surfaced at the VARIANT's own level. The
  // variant's own features win on a name conflict (e.g. Mystic Ranger's
  // weaker Spells, its "no animal companion" note). Reuses the ACF
  // inheritance matcher exposed on ClassVariants. Non-variant classes get
  // their own features back unchanged.
  function getEffectiveClassFeatures(classData) {
    const own = Array.isArray(classData && classData.class_features)
      ? classData.class_features : [];
    if (!classData || !classData.variant_of
        || typeof ClassVariants === 'undefined'
        || typeof ClassVariants.buildFeatureLevelMap !== 'function'
        || typeof ClassVariants.matchFeatureLevel !== 'function') {
      return own;
    }
    const parent = ClassVariants.getClassData(classData.variant_of);
    if (!parent || !Array.isArray(parent.class_features)) return own;
    const fmap = ClassVariants.buildFeatureLevelMap(classData);
    const ownNames = new Set(
      own.map(f => String(f.name || '').toLowerCase().trim()));
    const merged = [...own];
    for (const pf of parent.class_features) {
      const nm = String(pf.name || '').toLowerCase().trim();
      if (!nm || ownNames.has(nm)) continue;   // variant's own wins
      // Inherit only if the variant actually gets this feature (its
      // class_table enumerates it); surface it at the variant's own level.
      const lvl = ClassVariants.matchFeatureLevel(pf.name, fmap);
      if (lvl == null) continue;               // variant doesn't get it
      merged.push({ ...pf, level_acquired: lvl,
        _inheritedFrom: classData.variant_of });
    }
    merged.sort((a, b) =>
      Number(a.level_acquired || 0) - Number(b.level_acquired || 0));
    return merged;
  }

  // Cache parsed (+ inheritance-merged) class_features per class entry id,
  // same pattern as fetchClassTable.
  const classFeaturesCache = new Map();
  function fetchClassFeatures(classId) {
    if (classFeaturesCache.has(classId)) {
      return classFeaturesCache.get(classId);
    }
    const row = DB.queryOne(
      "SELECT data AS data_json FROM entry WHERE id = ?", [classId]);
    let classData = {};
    if (row && row.data_json) {
      try { classData = JSON.parse(row.data_json) || {}; }
      catch (e) { console.warn('[class-picker] bad class data JSON', e); }
    }
    const arr = getEffectiveClassFeatures(classData);
    // Don't cache a variant's features computed before ClassVariants is
    // available (it would lock in the un-inherited fallback). In practice
    // fetchClassFeatures only runs on user interaction / DB.ready, well
    // after all modules load — this guard is belt-and-suspenders.
    const incompleteVariant = classData.variant_of &&
      (typeof ClassVariants === 'undefined'
       || typeof ClassVariants.buildFeatureLevelMap !== 'function');
    if (!incompleteVariant) classFeaturesCache.set(classId, arr);
    return arr;
  }

  function applyClassSkills(className) {
    const skills = getClassSkills(className);
    if (!skills) return;
    for (const spec of skills) {
      for (const cb of findSkillCheckboxesForSpec(spec)) {
        const sources = (cb.dataset.classSkillSources || '')
          .split(',').filter(Boolean);
        if (!sources.includes(className)) sources.push(className);
        cb.dataset.classSkillSources = sources.join(',');
        if (!cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }
  }

  function removeClassSkills(className) {
    const tab = document.getElementById('tab-skills');
    if (!tab) return;
    tab.querySelectorAll('.skill-class-check[data-class-skill-sources]')
      .forEach(cb => {
        const sources = (cb.dataset.classSkillSources || '')
          .split(',').filter(Boolean);
        const idx = sources.indexOf(className);
        if (idx < 0) return;
        sources.splice(idx, 1);
        if (sources.length === 0) {
          delete cb.dataset.classSkillSources;
          if (cb.checked) {
            cb.checked = false;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } else {
          cb.dataset.classSkillSources = sources.join(',');
        }
      });
  }

  // ============================================================
  // Current-class-skill reconciliation (2026-06-16, Ryan's call)
  // ============================================================
  //
  // applyClassSkills/removeClassSkills (above) maintain
  // dataset.classSkillSources = the UNION of every applied class that claims
  // each skill. That's the right input for "is this a class skill for ANY
  // class" (= max-rank eligibility), but it doesn't distinguish the CURRENT
  // class (skills you can buy at 1 pt/rank now) from a PRIOR class (skills
  // that still count toward your max ranks but cost 2 pt/rank now).
  //
  // Ryan's model: the checkbox reflects the CURRENT (last-in-timeline) class
  // only; skills that are class skills SOLELY via an earlier class get a
  // separate "prior" marker. Everything here is DERIVED from classSkillSources
  // (rebuilt on load) + the build timeline's last class — no new persisted
  // field. Legacy saves whose `classSkill` booleans hold the old union migrate
  // forward automatically: on load applyClassSkills re-sources the rows, then
  // reconcile re-points the checkbox to the current class and stamps the marks.

  // The "current" class = the last class in the build timeline (Ryan: "use the
  // class skills for the last class in the timeline").
  //
  // Subtlety: the timeline is AUTO-RECONSTRUCTED from the picker (in picker
  // order) on every `classes-changed`, so an auto timeline ALWAYS ends in the
  // last PICKED class. But that reconstruction fires AFTER a fresh apply's
  // reconcile, so reading the auto timeline mid-apply yields the PREVIOUS
  // class (a one-cycle lag). Therefore: trust the timeline only when the user
  // has actually CURATED it (a row without `_reconstructed`) — that's the case
  // where it can legitimately diverge from picker order; otherwise use the
  // always-fresh last picked class (identical to a fresh auto timeline, no lag).
  //
  // CharacterHistory is a top-level `const` global (accessible by name, NOT as
  // window.CharacterHistory). Mirror how build-timeline.js references it.
  function getCurrentClassName() {
    let timelineLast = null, userCurated = false;
    try {
      const hist = (typeof CharacterHistory !== 'undefined' && CharacterHistory.get)
        ? CharacterHistory.get() : [];
      if (Array.isArray(hist) && hist.length) {
        let last = hist[0];
        for (const e of hist) if ((e.level || 0) >= (last.level || 0)) last = e;
        timelineLast = (last && last.class_taken) ? last.class_taken : null;
        // BuildTimeline edits DELETE `_reconstructed` (rather than set false),
        // so any row missing it means the user touched the timeline.
        userCurated = hist.some(e => e && !e._reconstructed);
      }
    } catch (e) { /* fall through to picker order */ }
    if (userCurated && timelineLast) return timelineLast;
    if (pickedClasses.length) return pickedClasses[pickedClasses.length - 1].className;
    return timelineLast;
  }

  // Render (or clear) the small "prior class skill" marker beside a
  // class-skill checkbox. `priorSources` = the earlier classes that make this
  // a class skill, or null/[] to remove the marker.
  function setPriorClassSkillMark(cb, priorSources) {
    const cell = cb.closest('td') || cb.parentElement;
    if (!cell) return;
    let mark = cell.querySelector('.prior-class-skill-mark');
    if (priorSources && priorSources.length) {
      if (!mark) {
        mark = document.createElement('span');
        mark.className = 'prior-class-skill-mark';
        mark.textContent = '◆'; // ◆
        cb.insertAdjacentElement('afterend', mark);
      }
      mark.title = 'Class skill via a previous class (' + priorSources.join(', ')
        + ') — counts toward your maximum skill ranks, but costs 2 points per '
        + 'rank to buy at your current class.';
    } else if (mark) {
      mark.remove();
    }
  }

  // Reconcile every auto-managed class-skill checkbox against the CURRENT
  // class: tick it only when the current class claims the skill, and stamp a
  // prior-class marker when an EARLIER class (but not the current one) does.
  // Manual ticks (checkboxes with no classSkillSources) are left untouched.
  function reconcileCurrentClassSkills() {
    const tab = document.getElementById('tab-skills');
    if (!tab) return;
    const current = getCurrentClassName();
    tab.querySelectorAll('.skill-class-check[data-class-skill-sources]')
      .forEach(cb => {
        const sources = (cb.dataset.classSkillSources || '')
          .split(',').filter(Boolean);
        if (!sources.length) return;
        // No resolvable current class → degrade to union (any source ticks).
        const isCurrent = current ? sources.includes(current) : true;
        const priorOnly = current ? sources.filter(s => s !== current) : [];
        if (cb.checked !== isCurrent) cb.checked = isCurrent;
        const showPrior = !isCurrent && priorOnly.length > 0;
        if (showPrior) cb.dataset.priorClassSkill = priorOnly.join(',');
        else delete cb.dataset.priorClassSkill;
        setPriorClassSkillMark(cb, showPrior ? priorOnly : null);
      });
  }

  // Auto-populate Special Abilities from cumulative class features.
  // Tags entries with data-from-class="<className>" so subsequent applies
  // of the same class clean up only that class's entries (preserving
  // race traits and other classes' features).
  function populateSpecialAbilities(className, cumulative) {
    const container = document.getElementById('special-abilities-container');
    if (!container || typeof Feats?.addSpecialAbility !== 'function') return;

    // 1. Remove previously class-added entries for this specific class.
    //    Match on the data-from-class marker AND — as a backstop for
    //    characters saved before that marker round-tripped (feats.js
    //    persistence fix) — on the "[<ClassName> <lvl>] " text prefix this
    //    function stamps. Without the backstop, a legacy save's untagged
    //    class features wouldn't be found, so re-apply/level-up would re-add
    //    the cumulative set on top of them (the duplication bug).
    const tag = String(className);
    const prefix = `[${className} `;
    container.querySelectorAll('.special-ability-entry').forEach(ta => {
      const tagged = ta.dataset.fromClass === tag;
      const prefixed = (ta.value || '').startsWith(prefix);
      if (tagged || prefixed) {
        const row = ta.closest('.feat-row');
        if (row) row.remove();
      }
    });

    // 2. Add new cumulative entries.
    for (const c of cumulative) {
      const text = `[${className} ${c.firstLevel}] ${c.label}`;
      Feats.addSpecialAbility(text);
      const rows = container.querySelectorAll('.feat-row');
      const lastTa = rows[rows.length - 1]?.querySelector(
        '.special-ability-entry'
      );
      if (lastTa) lastTa.setAttribute('data-from-class', tag);
    }
  }

  // Minimal CSS.escape polyfill — quotes selector parts that contain
  // characters with special meaning (e.g. spaces in "Black Flame Zealot").
  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(s);
    }
    return String(s).replace(/[^a-zA-Z0-9_-]/g, ch =>
      '\\' + ch.charCodeAt(0).toString(16) + ' ');
  }

  function setNumeric(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function flashPanel(panel, msg, color) {
    if (!panel) return;
    const note = document.createElement('div');
    note.style.cssText = `margin-top:0.3rem;color:${color};font-style:italic`;
    note.textContent = msg;
    panel.appendChild(note);
    panel.style.display = 'block';
    setTimeout(() => note.remove(), 4000);
  }

  function parseJsonArray(s) {
    if (!s) return null;
    try { return JSON.parse(s); } catch { return null; }
  }

  // Render an array like [4,3,2,1,null,...] as "0:4 / 1:3 / 2:2 / 3:1"
  function formatSpellArray(arr) {
    return arr
      .map((n, i) => (n === null || n === undefined) ? null : `${i}:${n}`)
      .filter(Boolean)
      .join(' / ');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Install persistence hooks IMMEDIATELY at module load (not after
  // DB.ready). character.js loads before class-picker.js per the
  // index.html script order, so `Character` is defined here. Without
  // this early install, a user loading a saved character before
  // DB.ready resolves would hit the ORIGINAL Character.loadData
  // (which ignores `_multiclass` entirely) — pickedClasses stays
  // empty, the chip list never renders, and a subsequent save
  // permanently wipes the saved multiclass array.
  installPersistenceHooks();

  DB.ready.then((db) => {
    if (db) {
      init();
      // If a character was loaded BEFORE DB.ready resolved (race on
      // page open + immediate dropdown click), any classes in the
      // save's `_multiclass` array are currently sitting in
      // pickedClasses as _unhydrated stubs. Fill in prog now that
      // the DB is available so the chip list still works and a
      // subsequent recalc has correct progressions.
      rehydrateUnhydratedClasses();
    }
  });

  // Expose for testing + integration with future Character module wrappers.
  window.ClassPicker = {
    getState: () => pickedClasses.slice(),
    getStateB: () => pickedClassesB.slice(),
    isGestalt: () => gestalt,
    setGestalt: apiSetGestalt,
    setActiveSide: apiSetActiveSide,
    getActiveSide: () => activeSide,
    findEntry: findClassEntry,
    removeClass,
    clearAll: clearAllClasses,
    // Math, exposed for the play-feel suite's synthesis invariants (the
    // double-dip canary). Pure functions over level/prog entry arrays.
    aggregateTotals,
    gestaltTotals,
    // Creature-as-race racial Hit Dice (see creature-race-picker.js).
    addRacialHD,
    removeRacialHD,
    hasMonsterClassFor,
    // Re-point class-skill checkboxes at the current (last-in-timeline) class
    // and stamp prior-class markers. Exposed for the timeline + tests.
    reconcileCurrentClassSkills,
    getCurrentClassName,
    // Recompute every maneuver panel's IL (incl. the racial-initiation pass).
    // Called by race-picker after spawning a racial maneuvers panel so a
    // Valkyrie applied on top of existing swordsage levels stacks immediately.
    refreshManeuverTabs: refreshAllManeuverTabs,
  };
})();
