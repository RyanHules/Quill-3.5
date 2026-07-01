// D&D 3.5 Edition Rules Data

const DND35 = {
  // Safe math expression evaluator for misc modifier boxes
  // Supports: +, -, *, / and parentheses. Returns integer result or 0.
  evalExpr(str) {
    if (!str || typeof str !== 'string') return parseInt(str) || 0;
    const s = str.replace(/\s/g, '');
    if (/^-?\d+$/.test(s)) return parseInt(s);
    // Only allow digits, operators, parens, decimal points
    if (!/^[\d+\-*/().]+$/.test(s)) return 0;
    try {
      const result = Function('"use strict"; return (' + s + ')')();
      return isFinite(result) ? Math.floor(result) : 0;
    } catch { return 0; }
  },

  // Ability score modifier calculation
  abilityModifier(score) {
    if (score === null || score === undefined || score === '') return 0;
    return Math.floor((parseInt(score) - 10) / 2);
  },

  // Standard D&D 3.5 skills with key ability and whether they can be
  // used untrained. Kept ALPHABETICAL by display name (Knowledge
  // subtypes grouped, "The Planes" filed under P). IMPORTANT: skills.js
  // now saves/loads BY NAME (with a LEGACY_SKILL_ORDER index fallback for
  // pre-2026-07-01 saves), so this array may be reordered freely WITHOUT
  // breaking existing saves — but if you reorder, DO NOT edit
  // LEGACY_SKILL_ORDER in skills.js (it is a frozen snapshot of the old
  // index order that nameless saves depend on).
  skills: [
    { name: "Appraise", ability: "INT", untrained: true, armorPenalty: false },
    { name: "Autohypnosis", ability: "WIS", untrained: false, armorPenalty: false },
    { name: "Balance", ability: "DEX", untrained: true, armorPenalty: true },
    { name: "Bluff", ability: "CHA", untrained: true, armorPenalty: false },
    { name: "Climb", ability: "STR", untrained: true, armorPenalty: true },
    { name: "Concentration", ability: "CON", untrained: true, armorPenalty: false },
    { name: "Control Shape", ability: "WIS", untrained: false, armorPenalty: false },
    { name: "Craft", ability: "INT", untrained: true, armorPenalty: false, hasSubtype: true, editableSubtype: true },
    { name: "Decipher Script", ability: "INT", untrained: false, armorPenalty: false },
    { name: "Diplomacy", ability: "CHA", untrained: true, armorPenalty: false },
    { name: "Disable Device", ability: "INT", untrained: false, armorPenalty: false },
    { name: "Disguise", ability: "CHA", untrained: true, armorPenalty: false },
    { name: "Escape Artist", ability: "DEX", untrained: true, armorPenalty: true },
    { name: "Forgery", ability: "INT", untrained: true, armorPenalty: false },
    { name: "Gather Information", ability: "CHA", untrained: true, armorPenalty: false },
    { name: "Handle Animal", ability: "CHA", untrained: false, armorPenalty: false },
    { name: "Heal", ability: "WIS", untrained: true, armorPenalty: false },
    { name: "Hide", ability: "DEX", untrained: true, armorPenalty: true },
    { name: "Iaijutsu Focus", ability: "CHA", untrained: false, armorPenalty: false },
    { name: "Intimidate", ability: "CHA", untrained: true, armorPenalty: false },
    { name: "Jump", ability: "STR", untrained: true, armorPenalty: true },
    { name: "Knowledge", ability: "INT", untrained: false, armorPenalty: false, hasSubtype: true, subtypeLabel: "Arcana" },
    { name: "Knowledge", ability: "INT", untrained: false, armorPenalty: false, hasSubtype: true, subtypeLabel: "Arch. & Eng." },
    { name: "Knowledge", ability: "INT", untrained: false, armorPenalty: false, hasSubtype: true, subtypeLabel: "Dungeoneering" },
    { name: "Knowledge", ability: "INT", untrained: false, armorPenalty: false, hasSubtype: true, subtypeLabel: "Geography" },
    { name: "Knowledge", ability: "INT", untrained: false, armorPenalty: false, hasSubtype: true, subtypeLabel: "History" },
    { name: "Knowledge", ability: "INT", untrained: false, armorPenalty: false, hasSubtype: true, subtypeLabel: "Local" },
    { name: "Knowledge", ability: "INT", untrained: false, armorPenalty: false, hasSubtype: true, subtypeLabel: "Nature" },
    { name: "Knowledge", ability: "INT", untrained: false, armorPenalty: false, hasSubtype: true, subtypeLabel: "Nobility" },
    { name: "Knowledge", ability: "INT", untrained: false, armorPenalty: false, hasSubtype: true, subtypeLabel: "The Planes" },
    { name: "Knowledge", ability: "INT", untrained: false, armorPenalty: false, hasSubtype: true, subtypeLabel: "Psionics" },
    { name: "Knowledge", ability: "INT", untrained: false, armorPenalty: false, hasSubtype: true, subtypeLabel: "Religion" },
    { name: "Listen", ability: "WIS", untrained: true, armorPenalty: false },
    { name: "Lucid Dreaming", ability: "WIS", untrained: false, armorPenalty: false },
    { name: "Martial Lore", ability: "INT", untrained: false, armorPenalty: false },
    { name: "Move Silently", ability: "DEX", untrained: true, armorPenalty: true },
    { name: "Open Lock", ability: "DEX", untrained: false, armorPenalty: false },
    { name: "Perform", ability: "CHA", untrained: true, armorPenalty: false, hasSubtype: true, editableSubtype: true },
    { name: "Profession", ability: "WIS", untrained: false, armorPenalty: false, hasSubtype: true, editableSubtype: true },
    { name: "Psicraft", ability: "INT", untrained: false, armorPenalty: false },
    { name: "Ride", ability: "DEX", untrained: true, armorPenalty: false },
    { name: "Search", ability: "INT", untrained: true, armorPenalty: false },
    { name: "Sense Motive", ability: "WIS", untrained: true, armorPenalty: false },
    { name: "Sleight of Hand", ability: "DEX", untrained: false, armorPenalty: true },
    { name: "Speak Language", ability: "NONE", untrained: false, armorPenalty: false },
    { name: "Spellcraft", ability: "INT", untrained: false, armorPenalty: false },
    { name: "Spot", ability: "WIS", untrained: true, armorPenalty: false },
    { name: "Survival", ability: "WIS", untrained: true, armorPenalty: false },
    { name: "Swim", ability: "STR", untrained: true, armorPenalty: true, doubleArmorPenalty: true },
    { name: "Truespeak", ability: "INT", untrained: false, armorPenalty: false },
    { name: "Tumble", ability: "DEX", untrained: false, armorPenalty: true },
    { name: "Use Magic Device", ability: "CHA", untrained: false, armorPenalty: false },
    { name: "Use Psionic Device", ability: "CHA", untrained: false, armorPenalty: false },
    { name: "Use Rope", ability: "DEX", untrained: true, armorPenalty: false },
  ],

  // Table 9-2: Carrying Loads (PHB p.162)
  // Light load = no penalties; use worse of armor or load penalties (don't stack)
  carryingLoads: {
    light:  { maxDex: Infinity, checkPenalty: 0 },
    medium: { maxDex: 3, checkPenalty: -3 },
    heavy:  { maxDex: 1, checkPenalty: -6 },
  },

  // Determine load category from total weight and STR-based capacity
  getLoadCategory(totalWeight, capacity) {
    if (totalWeight <= capacity[0]) return "light";
    if (totalWeight <= capacity[1]) return "medium";
    return "heavy";
  },

  // ---- Companion progression tables --------------------------------
  //
  // Canonical level-based stat adjustments for the four companion
  // types. Indexed by effective master level (1-20). Each entry is
  // the cumulative bonus AT THAT LEVEL (so consult once with the
  // effective level — no need to sum across rows).
  //
  // Used by companion.js's auto-computed "Progression" info panel
  // and (Phase 2) by the auto-fill of stat fields.
  //
  // Sources: PHB Table 5-1 (p.36 Animal Companion), p.53 sidebar
  // (Wizard/Sorcerer Familiar), Table 3-9 (p.45 Paladin Mount).

  // Returns null when level is outside the valid range for that
  // companion type (e.g. paladin mount before level 5).
  companionProgressions: {
    animal_companion: [
      // level, bonusHD, naAdj, abilityAdj (Str AND Dex), bonusTricks, specials
      { lvlMin: 1,  lvlMax: 2,  bonusHD:  0, naAdj:  0, abilityAdj: 0, bonusTricks: 1,
        specials: ['Link', 'Share Spells'] },
      { lvlMin: 3,  lvlMax: 5,  bonusHD:  2, naAdj:  2, abilityAdj: 1, bonusTricks: 2,
        specials: ['Evasion'] },
      { lvlMin: 6,  lvlMax: 8,  bonusHD:  4, naAdj:  4, abilityAdj: 2, bonusTricks: 3,
        specials: ['Devotion'] },
      { lvlMin: 9,  lvlMax: 11, bonusHD:  6, naAdj:  6, abilityAdj: 3, bonusTricks: 4,
        specials: ['Multiattack'] },
      { lvlMin: 12, lvlMax: 14, bonusHD:  8, naAdj:  8, abilityAdj: 4, bonusTricks: 5,
        specials: [] },
      { lvlMin: 15, lvlMax: 17, bonusHD: 10, naAdj: 10, abilityAdj: 5, bonusTricks: 6,
        specials: ['Improved Evasion'] },
      { lvlMin: 18, lvlMax: 20, bonusHD: 12, naAdj: 12, abilityAdj: 6, bonusTricks: 7,
        specials: [] },
    ],
    familiar: [
      // level, naAdj, intMin, specials (cumulative; abilities are gained
      // at the listed level, persist thereafter)
      { lvlMin: 1,  lvlMax: 2,  naAdj:  1, intMin: 6,
        specials: ['Alertness', 'Improved Evasion', 'Share Spells', 'Empathic Link'] },
      { lvlMin: 3,  lvlMax: 4,  naAdj:  2, intMin: 7,
        specials: ['Deliver Touch Spells'] },
      { lvlMin: 5,  lvlMax: 6,  naAdj:  3, intMin: 8,
        specials: ['Speak with Master'] },
      { lvlMin: 7,  lvlMax: 8,  naAdj:  4, intMin: 9,
        specials: ['Speak with Animals of Its Kind'] },
      { lvlMin: 9,  lvlMax: 10, naAdj:  5, intMin: 10, specials: [] },
      { lvlMin: 11, lvlMax: 12, naAdj:  6, intMin: 11,
        specials: ['Spell Resistance (5 + master level)'] },
      { lvlMin: 13, lvlMax: 14, naAdj:  7, intMin: 12,
        specials: ['Scry on Familiar'] },
      { lvlMin: 15, lvlMax: 16, naAdj:  8, intMin: 13, specials: [] },
      { lvlMin: 17, lvlMax: 18, naAdj:  9, intMin: 14, specials: [] },
      { lvlMin: 19, lvlMax: 20, naAdj: 10, intMin: 15, specials: [] },
    ],
    special_mount: [
      // Paladin mount only kicks in at L5+. Returns null below L5.
      { lvlMin: 5,  lvlMax: 7,  bonusHD: 2, naAdj:  4, strAdj: 1, intMin: 6,
        specials: ['Empathic Link', 'Improved Evasion', 'Share Spells',
                   'Share Saving Throws'] },
      { lvlMin: 8,  lvlMax: 10, bonusHD: 4, naAdj:  6, strAdj: 2, intMin: 7,
        specials: ['Improved Speed'] },
      { lvlMin: 11, lvlMax: 14, bonusHD: 6, naAdj:  8, strAdj: 3, intMin: 8,
        specials: ['Command Creatures of Its Kind'] },
      { lvlMin: 15, lvlMax: 20, bonusHD: 8, naAdj: 10, strAdj: 4, intMin: 9,
        specials: ['Spell Resistance (5 + master level)'] },
    ],
    // Cohort progression isn't a stat block — Leadership (PHB p.97)
    // grants a cohort whose max level is the leader's level - 2.
    // We expose only the cap rule; the cohort is itself a character
    // and its sheet is built separately.
    cohort: null,
  },

  // Look up the progression row for a given type + effective level.
  // Returns null when the level is below the type's threshold.
  getCompanionProgression(type, effectiveLevel) {
    const table = this.companionProgressions[type];
    if (!Array.isArray(table)) return null;
    for (const row of table) {
      if (effectiveLevel >= row.lvlMin && effectiveLevel <= row.lvlMax) {
        return row;
      }
    }
    // Above L20: clamp to the last row (epic rules vary).
    if (effectiveLevel > 20) return table[table.length - 1];
    return null;
  },

  // ============================================================
  // Creature type → BAB / save / hit-die / skill table
  // ============================================================
  //
  // Per the SRD's "Creature Types" section: each type has a fixed BAB
  // progression (full / 3/4 / 1/2), a set of good saves (those without
  // are "poor"), a hit die size, and a per-HD skill point base. Used
  // by companion.js's AUTO mode to recompute BAB / saves / skills
  // when bonus HD are stacked onto a base creature (animal companion
  // / paladin mount).
  //
  // The `parseCreatureType` helper strips parenthesized subtype lists
  // ("Animal (Aquatic)" → "Animal") so the table only needs one row
  // per primary type.

  creatureTypes: {
    // Format: [babPerHd, [goodSaves], hitDieSize, skillBase]
    // babPerHd: 1 (full), 0.75 (3/4), 0.5 (1/2)
    // skillBase: per-HD addition; the FIRST HD also gets ×4 multiplier
    //   per MM ("a creature with racial hit dice gains skill points as
    //   if it were a 1st-level character...").
    Aberration:         { bab: 0.75, goodSaves: ['Will'],        hd: 8,  skillBase: 2 },
    Animal:             { bab: 0.75, goodSaves: ['Fort', 'Ref'], hd: 8,  skillBase: 2 },
    Construct:          { bab: 0.75, goodSaves: [],              hd: 10, skillBase: 2 },
    Deathless:          { bab: 0.5,  goodSaves: ['Will'],        hd: 12, skillBase: 4 },
    Dragon:             { bab: 1,    goodSaves: ['Fort','Ref','Will'], hd: 12, skillBase: 6 },
    Elemental:          { bab: 0.75, goodSaves: ['Fort'],        hd: 8,  skillBase: 2 },
    Fey:                { bab: 0.5,  goodSaves: ['Ref', 'Will'], hd: 6,  skillBase: 6 },
    Giant:              { bab: 0.75, goodSaves: ['Fort'],        hd: 8,  skillBase: 2 },
    Humanoid:           { bab: 0.75, goodSaves: ['Ref'],         hd: 8,  skillBase: 2 },
    'Magical Beast':    { bab: 1,    goodSaves: ['Fort', 'Ref'], hd: 10, skillBase: 2 },
    'Monstrous Humanoid': { bab: 1,  goodSaves: ['Ref', 'Will'], hd: 8,  skillBase: 2 },
    Ooze:               { bab: 0.75, goodSaves: [],              hd: 10, skillBase: 2 },
    Outsider:           { bab: 1,    goodSaves: ['Fort','Ref','Will'], hd: 8,  skillBase: 8 },
    Plant:              { bab: 0.75, goodSaves: ['Fort'],        hd: 8,  skillBase: 2 },
    Shapechanger:       { bab: 0.75, goodSaves: ['Fort', 'Ref'], hd: 8,  skillBase: 2 },
    Undead:             { bab: 0.5,  goodSaves: ['Will'],        hd: 12, skillBase: 4 },
    Vermin:             { bab: 0.75, goodSaves: ['Fort'],        hd: 8,  skillBase: 2 },
  },

  // Strip parenthesized subtype list ("Animal (Aquatic)" → "Animal"),
  // titlecase the result, and return the primary type. Returns null
  // for unrecognized types (e.g. the one Outsider variant typed as
  // "Construct, Outsider (Lawful)" — caller falls back to no recomputation).
  parseCreatureType(raw) {
    if (!raw) return null;
    const primary = String(raw).split(/[,(]/)[0].trim();
    return this.creatureTypes[primary] ? primary : null;
  },

  // BAB at the given total HD for the type's progression. Floor as
  // per SRD (a 3/4-BAB creature with 4 HD has BAB +3, not +3.5).
  creatureBABAtHD(type, hd) {
    const info = this.creatureTypes[type];
    if (!info || !hd) return 0;
    return Math.floor(info.bab * hd);
  },

  // Base save at the given HD for the type. Good save = floor(HD/2)+2;
  // poor save = floor(HD/3). Per SRD Table 3-1 ("Base Save and Base
  // Attack Bonus" — applies to all creature racial HD as well as
  // class levels).
  creatureSaveAtHD(type, hd, which /* 'Fort' | 'Ref' | 'Will' */) {
    const info = this.creatureTypes[type];
    if (!info || !hd) return 0;
    const isGood = info.goodSaves.includes(which);
    return isGood ? Math.floor(hd / 2) + 2 : Math.floor(hd / 3);
  },

  // Map a creature type to the BAB / save PROGRESSION LABELS that
  // class-picker's multiclass aggregate consumes ('good' / 'average' /
  // 'poor'). Lets a creature's racial Hit Dice be injected as a synthetic
  // class row that pools with class levels through the SAME BAB/save math
  // (so the +2 good-save base is granted once per save type, etc.). BAB
  // factor 1 → good (full), 0.75 → average (3/4), 0.5 → poor (1/2); each
  // of Fort/Ref/Will is 'good' when listed in the type's goodSaves, else
  // 'poor'. Accepts a raw type ("Humanoid (Goblinoid)") or a clean one
  // ("Monstrous Humanoid"); returns null for unrecognized types. The
  // single-block BAB/save this produces matches creatureBABAtHD /
  // creatureSaveAtHD for the same HD count.
  creatureTypeToProg(rawType) {
    const type = this.parseCreatureType(rawType);
    if (!type) return null;
    const info = this.creatureTypes[type];
    const bab = info.bab >= 1 ? 'good' : info.bab >= 0.75 ? 'average' : 'poor';
    const sv = (w) => info.goodSaves.includes(w) ? 'good' : 'poor';
    return { bab, fort: sv('Fort'), ref: sv('Ref'), will: sv('Will') };
  },

  // Skill points per the MM advancement rules:
  //   ×4 multiplier on the FIRST HD, plain on subsequent HD.
  //   Per HD = max(1, skillBase + INT mod) (min 1 from the SRD rule
  //   "characters always get at least 1 skill point per HD").
  creatureSkillPoints(type, hd, intMod) {
    const info = this.creatureTypes[type];
    if (!info || !hd || hd <= 0) return 0;
    const perHd = Math.max(1, info.skillBase + (intMod || 0));
    if (hd === 1) return perHd * 4;
    return perHd * 4 + perHd * (hd - 1);
  },

  // Bonus feat count from racial HD per PHB Table 3-2: 1 feat at HD 1
  // and +1 at every HD divisible by 3 (L3 / 6 / 9 / 12 / ...).
  // Formula: 1 + floor(HD / 3).
  creatureFeatCount(hd) {
    if (!hd || hd < 1) return 0;
    return 1 + Math.floor(hd / 3);
  },

  // User-allocatable ability boosts the COMPANION earns above the
  // base creature's stat block. Per PHB p.59 Table 3-3 (and MM
  // advancement rules): +1 to one ability of choice at HD 4, 8, 12,
  // 16, 20. The base creature's published stat block already reflects
  // any boosts it earned for ITS base HD (a 4-HD base creature has
  // already had its first boost rolled in), so we subtract those out
  // to return only the boosts the player should still be allocating
  // for THIS character's companion. Returns 0 when bonus HD doesn't
  // cross another boost threshold (most common case for low-mid
  // companions).
  //
  // Examples:
  //   base 2 HD, total 3 HD → 0 (no boosts earned at HD 3)
  //   base 2 HD, total 4 HD → 1 (first boost at HD 4, none baked in)
  //   base 4 HD, total 4 HD → 0 (boost already in the stat block)
  //   base 4 HD, total 8 HD → 1 (HD 8 boost is new)
  //   base 6 HD, total 12 HD → 2 (HD 8 + HD 12 are new)
  creatureAbilityBoostsEarned(baseHD, totalHD) {
    const total = Math.floor((totalHD || 0) / 4);
    const baked = Math.floor((baseHD || 0) / 4);
    return Math.max(0, total - baked);
  },

  // Parse a creature's free-text `skills` string into structured
  // rows. Format examples:
  //   "Hide +2, Listen +3, Spot +3"
  //   "Disguise +2 (+4 acting), Listen +5"
  //   "Survival +1*"  (asterisk = situational; preserved in notes)
  //
  // Returns array of {name, modifier, notes} objects. Caller handles
  // the modifier-vs-ranks split (ranks aren't directly stored on
  // creature entries; the modifier IS the total bonus from the
  // statblock).
  parseCreatureSkills(raw) {
    if (!raw || typeof raw !== 'string') return [];
    // Split on commas NOT inside parentheses. Regex would be cleaner
    // with a lookahead; here we walk the string instead.
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === ',' && depth === 0) {
        parts.push(raw.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(raw.slice(start));
    const rows = [];
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      // Match "<name> +<N>" or "<name> -<N>", capturing any trailing
      // text (e.g. "(+4 acting)", "*", or extra modifier clauses).
      const m = trimmed.match(/^(.+?)\s+([+\-]\d+)(.*)$/);
      if (!m) {
        // Some statblocks have skills without a numeric modifier
        // (e.g. "Listen" with no bonus). Treat as a 0-modifier row.
        rows.push({ name: trimmed, modifier: '+0', notes: '' });
        continue;
      }
      rows.push({
        name: m[1].trim(),
        modifier: m[2],
        notes: m[3].trim(),
      });
    }
    return rows;
  },

  // Parse a creature's free-text `feats` string into structured rows.
  //   "Track(B), Weapon Focus (bite)"  → 2 rows, Track marked bonus
  //   "Improved Initiative (B), Weapon Finesse (B)" → both bonus
  //   "Dodge, Flyby Attack, Great Fortitude" → 3 plain feats
  //
  // The "(B)" suffix marks a bonus feat granted by the creature's
  // type (vs. one selected via the regular HD-based progression).
  // Returns {name, bonus} objects.
  parseCreatureFeats(raw) {
    if (!raw || typeof raw !== 'string') return [];
    // Same paren-aware split as skills — feats often have weapon
    // names in parens that contain commas (rare but possible).
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === ',' && depth === 0) {
        parts.push(raw.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(raw.slice(start));
    const rows = [];
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      // Bonus marker can be "(B)" appended or " (B)" with space.
      const bonus = /\(B\)\s*$/.test(trimmed);
      const name = trimmed.replace(/\s*\(B\)\s*$/, '').trim();
      if (!name) continue;
      rows.push({ name, bonus });
    }
    return rows;
  },

  // Parse a creature's free-text `advancement` string into structured
  // size bands. Format examples:
  //   "9-16 HD (Huge); 17-24 HD (Gargantuan)"  → 2 bands
  //   "5 HD (Small); 6-8 HD (Medium)"          → 2 bands (first single-step)
  //   "By character class"                     → null (no size escalation)
  //   "5-8 HD (Large)"                         → 1 band
  //
  // Returns array of {minHD, maxHD, size} OR null when the string is
  // not a parseable advancement table (e.g. "By character class").
  parseCreatureAdvancement(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || /character class/i.test(trimmed)) return null;
    const bands = [];
    for (const seg of trimmed.split(/\s*;\s*/)) {
      // "<lo>(-<hi>)? HD (<size>)"
      const m = seg.match(/^(\d+)(?:\s*[-–]\s*(\d+))?\s*HD\s*\(([^)]+)\)\s*$/);
      if (!m) continue;
      const minHD = parseInt(m[1], 10);
      const maxHD = m[2] ? parseInt(m[2], 10) : minHD;
      const size = m[3].trim();
      bands.push({ minHD, maxHD, size });
    }
    return bands.length ? bands : null;
  },

  // MM Table 4-2: Changes to Statistics by Size, applied per "step"
  // when a creature advances up the size scale. Each row is the
  // delta going FROM the smaller size TO the next larger size; sum
  // step deltas across a multi-size jump (e.g. Medium → Huge =
  // Medium→Large + Large→Huge).
  //
  // The AC/Attack and Grapple/Hide modifiers from size already live
  // in `sizes[].acMod` / `grappleMod` / `hideMod` and are looked up
  // by current size — no need to apply step deltas for those.
  //
  // Format: stepUp[smallerSize] = {str, dex, con, na}
  sizeOrder: ['Fine', 'Diminutive', 'Tiny', 'Small', 'Medium',
              'Large', 'Huge', 'Gargantuan', 'Colossal'],
  sizeStepUp: {
    // From → next-larger size deltas (MM p.291 / SRD)
    'Fine':       { str: +2, dex: -2, con:  0, na: 0 },   // F → D
    'Diminutive': { str: +4, dex: -2, con:  0, na: 0 },   // D → T
    'Tiny':       { str: +4, dex: -2, con:  0, na: 0 },   // T → S
    'Small':      { str: +4, dex: -2, con: +2, na: 0 },   // S → M
    'Medium':     { str: +8, dex: -2, con: +4, na: 2 },   // M → L
    'Large':      { str: +8, dex:  0, con: +4, na: 3 },   // L → H
    'Huge':       { str: +8, dex:  0, con: +4, na: 4 },   // H → G
    'Gargantuan': { str: +8, dex:  0, con: +4, na: 5 },   // G → C
  },

  // Sum per-step deltas from `fromSize` up to `toSize`. Returns
  // {str, dex, con, na} all 0 when sizes are equal. When toSize is
  // SMALLER than fromSize (rare — shrinking via magic etc.) returns
  // the negated cumulative delta. Unknown sizes return null.
  cumulativeSizeDelta(fromSize, toSize) {
    const order = this.sizeOrder;
    const fromIdx = order.indexOf(fromSize);
    const toIdx = order.indexOf(toSize);
    if (fromIdx < 0 || toIdx < 0) return null;
    if (fromIdx === toIdx) return { str: 0, dex: 0, con: 0, na: 0 };
    const out = { str: 0, dex: 0, con: 0, na: 0 };
    const dir = fromIdx < toIdx ? 1 : -1;
    let i = fromIdx;
    while (i !== toIdx) {
      // When going UP: read stepUp at `order[i]` (delta from i to i+1).
      // When going DOWN: read stepUp at `order[i-1]` and negate.
      const stepSize = dir > 0 ? order[i] : order[i - 1];
      const step = this.sizeStepUp[stepSize];
      if (!step) break;
      out.str += dir * step.str;
      out.dex += dir * step.dex;
      out.con += dir * step.con;
      out.na  += dir * step.na;
      i += dir;
    }
    return out;
  },

  // Given parsed advancement bands and a total HD, find the band the
  // creature falls into. Returns the band's size string or null if no
  // band matches (under the lowest band — creature is at base size).
  advancementSizeAtHD(bands, hd) {
    if (!Array.isArray(bands) || !hd) return null;
    for (const b of bands) {
      if (hd >= b.minHD && hd <= b.maxHD) return b.size;
    }
    // Above highest band: clamp to last (per MM rules for advancing
    // beyond the table — DM may continue scaling).
    const last = bands[bands.length - 1];
    if (last && hd > last.maxHD) return last.size;
    return null;
  },

  // Parse hit-die count from a creature's `hit_dice` string
  //   "2d8+4 (13 hp)"  → 2
  //   "1d10"           → 1
  //   "1/2 d8"         → 1 (the half-HD edge case clamps to 1 since
  //                         BAB/skill formulas assume hd >= 1)
  // Returns null if the string doesn't match the expected pattern.
  parseHitDieCount(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    if (/^1\/2\s*d/i.test(s)) return 1;
    const m = s.match(/^(\d+)\s*d/i);
    return m ? parseInt(m[1], 10) : null;
  },

  // Speed reduction table from PHB p.162 (also used for medium/heavy
  // armor speed reductions, which follow the same numeric pattern):
  // a 1/3 reduction rounded to the nearest 5 ft increment.
  //   30 → 20, 20 → 15, 40 → 30, 15 → 10, etc.
  // Heavy and medium loads apply the same reduction.
  reducedSpeed(baseFt) {
    if (!baseFt || baseFt <= 0) return baseFt || 0;
    if (baseFt === 5)  return 5;
    if (baseFt === 10) return 5;
    if (baseFt === 15) return 10;
    if (baseFt === 20) return 15;
    if (baseFt === 30) return 20;
    if (baseFt === 40) return 30;
    if (baseFt === 50) return 35;
    if (baseFt === 60) return 40;
    // Fallback for unusual speeds: 2/3 rule, rounded down to 5 ft.
    return Math.max(5, Math.floor((baseFt * 2 / 3) / 5) * 5);
  },

  // Fly maneuverability classes (MM/PHB), worst → best. The sheet renders a
  // per-fly-speed dropdown of these.
  maneuverabilityLevels: ["clumsy", "poor", "average", "good", "perfect"],

  // Convert the DB's canonical `movement` list — [{mode, speed_ft,
  // maneuverability}] (build-derived, P3) — into the flat
  // {land, fly, flyManeuver, swim, burrow, climb} shape the per-mode boxes
  // consume. Consumers prefer this over re-parsing the prose `speed` string.
  movementListToModes(list) {
    const out = { land: null, fly: null, flyManeuver: null,
                  swim: null, burrow: null, climb: null };
    if (!Array.isArray(list)) return out;
    for (const r of list) {
      if (!r || !r.mode) continue;
      const m = String(r.mode).toLowerCase();
      const v = (typeof r.speed_ft === "number") ? r.speed_ft : parseInt(r.speed_ft, 10);
      if (isNaN(v)) continue;
      if (m === "fly") { out.fly = v; out.flyManeuver = r.maneuverability || null; }
      else if (m in out) out[m] = v;
    }
    return out;
  },

  // Parse a free-text speed line ("20 ft. (4 squares), fly 60 ft. (good),
  // swim 30 ft.") into structured per-mode feet + fly maneuverability. The
  // FIRST keyword-less "N ft." segment is land; fly/swim/burrow/climb are
  // keyed by their mode word (glide folds into fly). "(N squares)" tactical
  // annotations and trailing caveats ("at 5 HD") are ignored. Returns
  // { land, fly, flyManeuver, swim, burrow, climb } with null for absent modes.
  parseSpeedString(str) {
    const out = { land: null, fly: null, flyManeuver: null,
                  swim: null, burrow: null, climb: null };
    if (!str || typeof str !== "string") return out;
    for (let seg of str.split(/[,;]/)) {
      seg = seg.replace(/\(\s*\d+\s*squares?\s*\)/i, "").trim();
      if (!seg) continue;
      const num = seg.match(/(\d+)\s*ft/i);
      if (!num) continue;
      const val = parseInt(num[1], 10);
      const low = seg.toLowerCase();
      if (/\b(fly|glide)\b/.test(low)) {
        // First fly/glide wins; a real fly speed supersedes a glide.
        if (out.fly == null || /\bfly\b/.test(low)) {
          out.fly = val;
          const man = seg.match(/\b(clumsy|poor|average|good|perfect)\b/i);
          out.flyManeuver = man ? man[1].toLowerCase() : out.flyManeuver;
        }
      } else if (/\bswim\b/.test(low)) out.swim = val;
      else if (/\bburrow\b/.test(low)) out.burrow = val;
      else if (/\bclimb\b/.test(low)) out.climb = val;
      else if (out.land == null) out.land = val;   // first bare "N ft." = land
    }
    return out;
  },

  // Size categories and their modifiers
  sizes: {
    "Fine": { acMod: 8, grappleMod: -16, hideMod: 16, carryMult: 1/8 },
    "Diminutive": { acMod: 4, grappleMod: -12, hideMod: 12, carryMult: 1/4 },
    "Tiny": { acMod: 2, grappleMod: -8, hideMod: 8, carryMult: 1/2 },
    "Small": { acMod: 1, grappleMod: -4, hideMod: 4, carryMult: 3/4 },
    "Medium": { acMod: 0, grappleMod: 0, hideMod: 0, carryMult: 1 },
    "Large": { acMod: -1, grappleMod: 4, hideMod: -4, carryMult: 2 },
    "Huge": { acMod: -2, grappleMod: 8, hideMod: -8, carryMult: 4 },
    "Gargantuan": { acMod: -4, grappleMod: 12, hideMod: -12, carryMult: 8 },
    "Colossal": { acMod: -8, grappleMod: 16, hideMod: -16, carryMult: 16 },
  },

  // Categorize a list of structured skill-bonus rows (the canonical
  // `bonuses` shape used by races / creatures / — once reshaped —
  // templates) into the form skills.js consumes. A row is
  //   { bonus_type:'skill', target:<skill name>, amount:N,
  //     bonus_category:<'racial'|…>, condition:<text|null> }.
  // Returns { direct:{skill_lower: amount}, global:N, situational:[…] }:
  //   - condition non-null   → SITUATIONAL (rendered as a per-skill note,
  //                            never added to a total).
  //   - target "all skills" / "all skill checks" / "*"  → GLOBAL (applies
  //                            to every skill row — e.g. a Paragon +N).
  //   - otherwise            → DIRECT, keyed by lower-cased target. A
  //                            "Base (subtype)" target (e.g. "Knowledge
  //                            (nature)") keys by its full lower name so
  //                            skills.js lands it on the matching subtype
  //                            row.
  // Same-type racial bonuses to one skill do NOT stack, so duplicates
  // (e.g. a variant inheriting a base bonus it also re-lists) collapse —
  // FIRST occurrence wins (mergeBonuses lists the variant's row first, so
  // a variant override beats the base, mirroring senses / natural armor).
  // Skips rows whose target isn't a real skill only implicitly — an
  // unmatched key simply lands on no row, so non-skill targets like
  // "Bardic Knowledge" degrade gracefully rather than needing a denylist.
  categorizeSkillBonuses(bonuses) {
    const out = { direct: {}, global: 0, situational: [] };
    if (!Array.isArray(bonuses)) return out;
    const GLOBAL = new Set(['all', 'all skills', 'all skill checks', 'skills', '*']);
    // The only skills that take a parenthetical SUBTYPE. On any other skill
    // a parenthetical is a CONDITION baked into the name ("Hide (sandy
    // area)", "Survival (find water)") — promote it to the condition so the
    // bonus becomes a situational note rather than a direct key that matches
    // no row.
    const SUBTYPE_BASES = new Set(['craft', 'knowledge', 'perform', 'profession']);
    for (const b of bonuses) {
      if (!b || b.bonus_type !== 'skill') continue;
      const target = String(b.target == null ? '' : b.target).trim();
      const amount = (typeof b.amount === 'number') ? b.amount : parseInt(b.amount, 10);
      if (!target || !amount || isNaN(amount)) continue;
      let cond = (b.condition == null) ? '' : String(b.condition).trim();
      let skill = target;
      const paren = target.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      if (paren && !SUBTYPE_BASES.has(paren[1].trim().toLowerCase())) {
        skill = paren[1].trim();
        if (!cond) cond = paren[2].trim();   // the paren WAS the condition
      }
      if (cond) {
        out.situational.push({ skill, amount, condition: cond,
          category: b.bonus_category, source: b.source });
        continue;
      }
      const lower = skill.toLowerCase();
      if (GLOBAL.has(lower)) {
        if (!out.global) out.global = amount;     // first-wins (no same-type stack)
        continue;
      }
      if (!(lower in out.direct)) out.direct[lower] = amount;  // first-wins
    }
    return out;
  },

  // ── Typed-bonus stacking engine (3.5 rules) ────────────────────────────
  // The shared core for any onion that sums typed modifiers — saves, AC,
  // attack, checks. 3.5 rule: bonuses (and penalties) of the SAME type
  // don't stack — only the single best bonus and single worst penalty of
  // each type apply — EXCEPT dodge / circumstance / untyped bonuses, which
  // always stack. (natural_armor is aliased to natural so the two spellings
  // are one type.)
  //
  // Input: a list of { amount, bonus_category|category, ...passthrough }.
  // Output: { total, applied:[...], suppressed:[...] } — `applied` are the
  // modifiers that actually count (post-stacking), `suppressed` are the
  // same-type losers, kept for legible "why isn't this counting" display.
  STACKING_BONUS_CATEGORIES: new Set(['dodge', 'circumstance', 'untyped', 'none', '']),
  _BONUS_CATEGORY_ALIAS: { natural_armor: 'natural' },
  stackBonuses(list) {
    const STACKS = this.STACKING_BONUS_CATEGORIES;
    const ALIAS = this._BONUS_CATEGORY_ALIAS;
    const applied = [];
    const suppressed = [];
    const nonStack = new Map();   // category → { bonus, penalty }
    let total = 0;
    for (const b of (Array.isArray(list) ? list : [])) {
      let amt = (typeof b.amount === 'number') ? b.amount : parseInt(b.amount, 10);
      if (!amt || isNaN(amt)) continue;
      let cat = String(b.bonus_category != null ? b.bonus_category
                       : (b.category != null ? b.category : '')).toLowerCase().trim();
      cat = ALIAS[cat] || cat;
      const item = Object.assign({}, b, { amount: amt, category: cat || 'untyped' });
      if (STACKS.has(cat)) {            // always stacks
        total += amt;
        applied.push(item);
        continue;
      }
      const slot = nonStack.get(cat) || {};
      const key = amt > 0 ? 'bonus' : 'penalty';
      const better = amt > 0
        ? (cur) => amt > cur.amount       // higher bonus wins
        : (cur) => amt < cur.amount;      // lower (worse) penalty wins
      if (!slot[key]) {
        slot[key] = item;
      } else if (better(slot[key])) {
        suppressed.push(slot[key]);
        slot[key] = item;
      } else {
        suppressed.push(item);
      }
      nonStack.set(cat, slot);
    }
    for (const slot of nonStack.values()) {
      for (const k of ['bonus', 'penalty']) {
        if (slot[k]) { total += slot[k].amount; applied.push(slot[k]); }
      }
    }
    return { total, applied, suppressed };
  },

  // Infer which save a conditional modifier belongs to, from its effect
  // keywords. Returns 'fort' | 'ref' | 'will' | null (general / can't tell).
  // Used to tag conditional save bonuses to a specific save row for
  // legibility ("+2 vs poison" → Fortitude).
  inferSaveFromCondition(text) {
    // Leading \b only — no trailing boundary, so prefixes match
    // ("enchantment", "poisoned", "paralyzed", "illusions").
    const s = String(text || '').toLowerCase();
    if (/\b(poison|disease|death|energy drain|paralys|nausea|sicken|fatigue|exhaust|petrif|polymorph|stun|ability damage|ability drain)/.test(s)) return 'fort';
    if (/\b(enchant|charm|compulsion|fear|morale|illusion|phantasm|mind-affecting|mind affecting|hypnos|dominat|insanity|confus|emotion|gaze)/.test(s)) return 'will';
    if (/\b(breath|area|trap|reflex|evasion|fireball|burst|cone|line of effect)/.test(s)) return 'ref';
    return null;
  },

  // Categorize an entry's structured `bonuses` (bonus_type='save') the way
  // categorizeSkillBonuses does for skills. Returns
  //   { direct:{fort:[{amount,bonus_category}], ref:[…], will:[…]},
  //     situational:[{save, amount, condition, category, appliesAll}] }
  // `direct` keeps the unconditional bonuses as a TYPED list per save (NOT
  // pre-stacked) so the consumer can stack them across all sources at once
  // (cross-source stacking). `situational` are the conditional ones, each
  // tagged with the save it applies to (explicit target, else inferred).
  categorizeSaveBonuses(bonuses) {
    const SAVE_KEY = { fortitude: 'fort', fort: 'fort', reflex: 'ref',
                       ref: 'ref', will: 'will' };
    const ALL = ['fort', 'ref', 'will'];
    const uncond = { fort: [], ref: [], will: [] };
    const situational = [];
    for (const b of (Array.isArray(bonuses) ? bonuses : [])) {
      if (!b || b.bonus_type !== 'save') continue;
      const amt = (typeof b.amount === 'number') ? b.amount : parseInt(b.amount, 10);
      if (!amt || isNaN(amt)) continue;
      const target = String(b.target == null ? '' : b.target).trim();
      const tlow = target.toLowerCase();
      const cond = (b.condition == null) ? '' : String(b.condition).trim();
      const cat = b.bonus_category != null ? b.bonus_category : null;
      let saves;
      if (!tlow || tlow === 'all' || tlow === 'saves') saves = ALL;
      else if (SAVE_KEY[tlow]) saves = [SAVE_KEY[tlow]];
      else {
        // Prose target ("Will saves vs spells…") — treat as situational;
        // infer the save from the target text + condition.
        situational.push({ save: this.inferSaveFromCondition(target + ' ' + cond),
                           amount: amt, condition: cond || target, category: cat,
                           source: b.source, appliesAll: false });
        continue;
      }
      if (cond) {
        const save = saves.length === 1 ? saves[0] : this.inferSaveFromCondition(cond);
        situational.push({ save, amount: amt, condition: cond, category: cat,
                           source: b.source, appliesAll: saves.length === 3 });
      } else {
        for (const s of saves) uncond[s].push({ amount: amt, bonus_category: cat });
      }
    }
    return { direct: uncond, situational };
  },

  // Categorize an entry's structured AC bonuses (bonus_type='ac') into the
  // shape the character-tab AC onion already consumes (protItems): a list of
  // { type, ac, touch, flatfooted, stacks } plus a `situational` list for the
  // conditional ones. SIZE and NATURAL are deliberately skipped — the sheet
  // already derives size AC from #char-size and routes natural armor through
  // the #ac-natural field, so re-feeding them here would double-count. The
  // onion's own resolver applies 3.5 stacking (best-per-type; dodge sums).
  categorizeACBonuses(bonuses) {
    const TYPE_MAP = { dodge: 'Dodge', deflection: 'Deflection',
                       natural: 'Natural Armor', natural_armor: 'Natural Armor',
                       armor: 'Armor', shield: 'Shield' };
    const items = [];
    const situational = [];
    for (const b of (Array.isArray(bonuses) ? bonuses : [])) {
      if (!b || b.bonus_type !== 'ac') continue;
      const amt = (typeof b.amount === 'number') ? b.amount : parseInt(b.amount, 10);
      if (!amt || isNaN(amt)) continue;
      const cat = String(b.bonus_category == null ? '' : b.bonus_category).toLowerCase().trim();
      if (cat === 'size' || cat === 'natural' || cat === 'natural_armor') continue;
      const cond = (b.condition == null) ? '' : String(b.condition).trim();
      const type = TYPE_MAP[cat] || (cat ? cat[0].toUpperCase() + cat.slice(1) : 'Untyped');
      if (cond) { situational.push({ type, ac: amt, condition: cond, category: cat, source: b.source }); continue; }
      items.push({
        type, ac: amt,
        // Touch AC keeps everything except armor / shield / natural.
        touch: !(type === 'Armor' || type === 'Shield' || type === 'Natural Armor'),
        // Only dodge bonuses are lost when flat-footed.
        flatfooted: type !== 'Dodge',
        stacks: false,
      });
    }
    return { items, situational };
  },

  // Movement-speed bonus aggregator (effects-aggregator P2). Consumes a flat
  // list of speed bonuses from every source (race / feat / class feature /
  // template / bloodline / condition) and returns per-mode totals the
  // per-mode movement calc layers onto the box values.
  //
  // Shapes handled:
  //   canonical ADD:  {bonus_type:'speed', mode, amount, bonus_category, condition?}
  //   canonical SET:  {bonus_type:'speed', mode, set, maneuver?}   (grants/overrides a mode)
  //   fly-encumbered: {bonus_type:'speed', fly_encumbered_ok:true} (a feature lets you fly loaded)
  //   LEGACY per-mode: {bonus_type:'fly_speed'|'swim_speed'|'burrow_speed'|
  //                     'climb_speed'|'land_speed', condition:'N ft. (maneuver)'}
  //                    — the ad-hoc racial shape (value in `condition`); treated
  //                    as a SET. P3 will canonicalize these into bonus_type:'speed'.
  //
  // Returns { land:{addTotal,set,maneuver}, fly:{…}, swim, burrow, climb,
  //           flyEncumberedOk, situational:[{mode,amount,condition,…}] }.
  // ADDs of the same type don't stack (stackBonuses); SET takes the highest.
  categorizeSpeedBonuses(list) {
    const MODES = ['land', 'fly', 'swim', 'burrow', 'climb'];
    const out = { flyEncumberedOk: false, situational: [] };
    MODES.forEach((m) => { out[m] = { add: [], set: 0, maneuver: null }; });
    const LEGACY = { fly_speed: 'fly', swim_speed: 'swim', burrow_speed: 'burrow',
                     climb_speed: 'climb', land_speed: 'land' };
    const setMode = (mode, val, maneuverStr) => {
      if (val > out[mode].set) {
        out[mode].set = val;
        if (mode === 'fly' && maneuverStr) {
          const mn = String(maneuverStr).match(/\b(clumsy|poor|average|good|perfect)\b/i);
          if (mn) out.fly.maneuver = mn[1].toLowerCase();
        }
      }
    };
    for (const b of (Array.isArray(list) ? list : [])) {
      if (!b) continue;
      const bt = String(b.bonus_type || '').toLowerCase();
      if (b.fly_encumbered_ok || bt === 'fly_while_encumbered') { out.flyEncumberedOk = true; continue; }
      if (LEGACY[bt]) {
        const txt = String(b.condition == null ? (b.target || '') : b.condition);
        const num = txt.match(/(\d+)\s*ft/i);
        if (num) setMode(LEGACY[bt], parseInt(num[1], 10), txt);
        continue;
      }
      if (bt !== 'speed') continue;
      const mode = String(b.mode || 'land').toLowerCase();
      if (!out[mode]) continue;
      if (b.set != null) {
        setMode(mode, parseInt(b.set, 10) || 0, b.maneuver);
      } else if (b.amount != null) {
        const amt = parseInt(b.amount, 10) || 0;
        const cond = b.condition ? String(b.condition).trim() : '';
        if (cond) out.situational.push({ mode, amount: amt, condition: cond,
          category: b.bonus_category, source: b.source });
        else out[mode].add.push({ amount: amt, bonus_category: b.bonus_category,
          // Load/armor gates, dropped in character.js when exceeded:
          //   requires_light    — unarmored + ≤ light load (Monk).
          //   requires_not_heavy — not heavy armor + not heavy load, i.e.
          //                        light/medium OK (Barbarian).
          requires_light: b.requires_light || undefined,
          requires_not_heavy: b.requires_not_heavy || undefined,
          source: b.source });
      }
    }
    for (const m of MODES) out[m].addTotal = this.stackBonuses(out[m].add).total;
    return out;
  },

  // Carrying capacity by STR score (light load max, medium load max, heavy load max)
  carryingCapacity: {
    1: [3, 6, 10],
    2: [6, 13, 20],
    3: [10, 20, 30],
    4: [13, 26, 40],
    5: [16, 33, 50],
    6: [20, 40, 60],
    7: [23, 46, 70],
    8: [26, 53, 80],
    9: [30, 60, 90],
    10: [33, 66, 100],
    11: [38, 76, 115],
    12: [43, 86, 130],
    13: [50, 100, 150],
    14: [58, 116, 175],
    15: [66, 133, 200],
    16: [76, 153, 230],
    17: [86, 173, 260],
    18: [100, 200, 300],
    19: [116, 233, 350],
    20: [133, 266, 400],
    21: [153, 306, 460],
    22: [173, 346, 520],
    23: [200, 400, 600],
    24: [233, 466, 700],
    25: [266, 533, 800],
    26: [306, 613, 920],
    27: [346, 693, 1040],
    28: [400, 800, 1200],
    29: [466, 933, 1400],
  },

  // For STR 30+, multiply the 20-lower value by 4 for each +10
  getCarryingCapacity(strScore) {
    if (strScore <= 0) return [0, 0, 0];
    if (strScore <= 29) return this.carryingCapacity[strScore] || [0, 0, 0];
    // For scores above 29
    const remainder = strScore % 10;
    const base = (remainder === 0) ? 10 : remainder;
    const multiplier = Math.pow(4, Math.floor((strScore - base) / 10) - (base <= 10 ? 0 : 0));
    const baseCapacity = this.carryingCapacity[base + 10] || this.carryingCapacity[base + 20] || [0, 0, 0];
    // Simplified: for very high scores, approximate
    if (strScore <= 29) return this.carryingCapacity[strScore];
    const tens = Math.floor((strScore - 10) / 10);
    const ones = strScore - 10 - (tens * 10);
    const baseVal = this.carryingCapacity[10 + ones] || [33, 66, 100];
    const mult = Math.pow(4, tens);
    return baseVal.map(v => v * mult);
  },

  // Magic item body slots
  itemSlots: [
    { id: "head", label: "Head", description: "Headband, Hat, Helmet, or Phylactery" },
    { id: "eyes", label: "Eyes", description: "Eye Lenses or Goggles" },
    { id: "neck", label: "Neck", description: "Amulet, Brooch, Medallion, Periapt, or Scarab" },
    { id: "shoulders", label: "Shoulders", description: "Cloak, Cape, or Mantle" },
    { id: "ring1", label: "Ring #1", description: "Ring" },
    { id: "ring2", label: "Ring #2", description: "Ring" },
    { id: "hands", label: "Hands", description: "Gloves or Gauntlets" },
    { id: "arms", label: "Arms/Wrists", description: "Bracers or Bracelets" },
    { id: "body", label: "Body", description: "Robe or Suit of Armor" },
    { id: "torso", label: "Torso", description: "Vest, Vestment, or Shirt" },
    { id: "waist", label: "Waist", description: "Belt or Girdle" },
    { id: "feet", label: "Feet", description: "Boots, Shoes, or Slippers" },
  ],

  // Spell levels
  spellLevels: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],

  // Alignment options
  alignments: [
    "Lawful Good", "Neutral Good", "Chaotic Good",
    "Lawful Neutral", "True Neutral", "Chaotic Neutral",
    "Lawful Evil", "Neutral Evil", "Chaotic Evil"
  ],

  // Ability names
  abilities: ["STR", "DEX", "CON", "INT", "WIS", "CHA"],
  abilityNames: {
    STR: "Strength",
    DEX: "Dexterity",
    CON: "Constitution",
    INT: "Intelligence",
    WIS: "Wisdom",
    CHA: "Charisma"
  },

  // Table 4-5: Skill Synergies (PHB p.66)
  // Each entry: { from: skillName, to: skillName, note?: string }
  // "from" having 5+ ranks gives +2 to "to"
  synergies: [
    { from: "Bluff", to: "Diplomacy" },
    { from: "Bluff", to: "Disguise", note: "when acting in character" },
    { from: "Bluff", to: "Intimidate" },
    { from: "Bluff", to: "Sleight of Hand" },
    { from: "Craft", to: "Appraise", note: "related items only" },
    { from: "Decipher Script", to: "Use Magic Device", note: "involving scrolls" },
    { from: "Escape Artist", to: "Use Rope", note: "involving bindings" },
    { from: "Handle Animal", to: "Ride" },
    { from: "Handle Animal", to: "Wild Empathy", note: "class feature" },
    { from: "Jump", to: "Tumble" },
    { from: "Knowledge (Arcana)", to: "Spellcraft" },
    { from: "Knowledge (Arch. & Eng.)", to: "Search", note: "secret doors & compartments" },
    { from: "Knowledge (Dungeoneering)", to: "Survival", note: "when underground" },
    { from: "Knowledge (Geography)", to: "Survival", note: "to avoid getting lost/hazards" },
    { from: "Knowledge (History)", to: "Bardic Knowledge", note: "class feature" },
    { from: "Knowledge (Local)", to: "Gather Information" },
    { from: "Knowledge (Nature)", to: "Survival", note: "aboveground natural environments" },
    { from: "Knowledge (Nobility)", to: "Diplomacy" },
    { from: "Knowledge (Religion)", to: "Turn/Rebuke Undead", note: "class feature" },
    { from: "Knowledge (The Planes)", to: "Survival", note: "on other planes" },
    { from: "Search", to: "Survival", note: "when following tracks" },
    { from: "Sense Motive", to: "Diplomacy" },
    { from: "Spellcraft", to: "Use Magic Device", note: "involving scrolls" },
    { from: "Survival", to: "Knowledge (Nature)" },
    { from: "Tumble", to: "Balance" },
    { from: "Tumble", to: "Jump" },
    { from: "Use Magic Device", to: "Spellcraft", note: "to decipher spells on scrolls" },
    { from: "Use Rope", to: "Climb", note: "involving climbing ropes" },
    { from: "Use Rope", to: "Escape Artist", note: "involving ropes" },
    // Expanded Psionics Handbook
    { from: "Autohypnosis", to: "Knowledge (Psionics)" },
    { from: "Concentration", to: "Autohypnosis" },
    { from: "Knowledge (Psionics)", to: "Psicraft" },
    { from: "Psicraft", to: "Use Psionic Device", note: "involving power stones" },
    { from: "Use Psionic Device", to: "Psicraft", note: "to address power stones" },
    // Races of Stone
    { from: "Perform", to: "Appraise", note: "related performances" },
    // Races of Destiny
    { from: "Knowledge (Local)", to: "Survival", note: "in urban areas" },
  ],

  // Get synergy bonus key from skill name + optional subtype
  getSkillKey(name, subtypeLabel) {
    if (subtypeLabel) return `${name} (${subtypeLabel})`;
    return name;
  },
};
