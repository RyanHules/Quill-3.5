// feat-prereqs.js — Best-effort parser for D&D 3.5 feat prerequisite
// strings, plus a checker that evaluates parsed atoms against the
// current character state. Used by:
//   - feat-picker.js info panel (live ✓/✗/? markers on each atom)
//   - feats.js Feats-tab rows (per-feat indicator beside each row)
//
// Phase A — present-tense only. We compare against current totals,
// which means we miss "had STR 14 at the time, has STR 12 now after
// Cat's Grace wore off" mid-build cases. Phase B (after the level-
// history substrate ships) will replay the same parser/checker
// against per-level state snapshots.
//
// Warn-only — never blocks. Lots of prereqs are unparseable free-
// text class features ("ability to wild shape", "skirmish or sneak
// attack ability", "arrow of death class feature") that fall back
// to "?" markers; DM rulings, ACFs, and EITR homebrew also routinely
// invalidate the parsed result.

const FeatPrereqs = (function () {
  // ---- Parser --------------------------------------------------------
  //
  // Returns a list of atoms — each is `{ kind, ...payload, raw }`.
  // Kinds: 'ability', 'bab', 'casterLevel', 'classLevel', 'castSpells',
  // 'skill', 'feat', 'alignment', 'unparsed'.
  //
  // The prereq string is normalized then split on commas / semicolons,
  // and each fragment is matched against a series of regexes in
  // priority order. Anything that doesn't match emits an 'unparsed'
  // atom carrying the raw text so the UI can show a "?" marker.

  const ABILITIES = ['STR','DEX','CON','INT','WIS','CHA'];
  // Books spell the ability out about as often as they abbreviate it
  // ("Constitution 13" on Disease Immunity, "Intelligence 13+" on
  // Inscribe Rune). Without these the fragment fell through to the
  // generic class-level pattern and rendered "✗ no levels in
  // Constitution" — a confident, wrong ✗ on very common feats.
  const ABILITY_FULL = {
    STRENGTH: 'STR', DEXTERITY: 'DEX', CONSTITUTION: 'CON',
    INTELLIGENCE: 'INT', WISDOM: 'WIS', CHARISMA: 'CHA',
  };
  // Long forms first: alternation is left-biased, and "Str" would
  // otherwise win the first position and strand "ength 13".
  const ABILITY_RX_PARTS =
    [...Object.keys(ABILITY_FULL), ...ABILITIES].join('|');

  // "Ability to cast 3rd-level arcane spells" and its many phrasings.
  // Kept as a named constant because parse() also needs it to decide
  // whether an " or " inside a fragment is an alternation to split
  // ("Spell Focus (evocation) or evoker level 1st") or part of the
  // spell clause itself ("9th-level arcane or divine spells",
  // "2nd-level or higher arcane spells") — those must NOT be split.
  // Covers: ability/able to · an optional adverb ("spontaneously") ·
  // cast/manifest · "at least one" · "or higher" · a two-flavor tail ·
  // spell(s)/power(s).
  const CAST_SPELLS_RX =
    /\b(?:ability|able)\s+to\s+(?:\w+ly\s+)?(cast|manifest)\s+(?:at\s+least\s+one\s+)?(\d+)(?:st|nd|rd|th)?[\s-]+level\s+(?:or\s+higher\s+)?(arcane|divine|psionic)?(?:\s+or\s+(?:arcane|divine|psionic))?\s*(?:spells?|powers?)/i;

  // Each pattern: regex + builder function (match → atom).
  const PATTERNS = [
    // "Caster level 5th" / "manifester level 3rd" / "arcane caster
    // level 6th" / "Divine caster level 5th". Matched FIRST so it
    // doesn't get caught by the more generic "Class level N" pattern.
    // The optional "spell" prefix picks up the "Spellcaster level 11th+"
    // / "arcane spellcaster level 7th" spellings — `\b` sits before the
    // whole word, so a bare `(?:caster)` never matched those.
    {
      rx: /\b(arcane|divine|psionic)?\s*(?:spell)?(?:caster|manifester)\s+level\s+(\d+)(?:st|nd|rd|th)?\+?/i,
      build: (m) => ({
        kind: 'casterLevel',
        flavor: m[1] ? m[1].toLowerCase() : 'any',
        level: parseInt(m[2], 10),
      }),
    },
    // "Character level 6th" / "character level 3rd". MUST precede the
    // generic class-level pattern, which would otherwise capture
    // "Character" as a class name and report "no levels in Character"
    // on all 33 feats that use this phrasing.
    {
      rx: /\bcharacter\s+level\s+(\d+)(?:st|nd|rd|th)?\+?/i,
      build: (m) => ({ kind: 'characterLevel', level: parseInt(m[1], 10) }),
    },
    // "base attack bonus +6" — also matches "BAB +N".
    {
      rx: /\b(?:base\s+attack\s+bonus|BAB)\s*\+?(\d+)/i,
      build: (m) => ({ kind: 'bab', value: parseInt(m[1], 10) }),
    },
    // "Ability to cast 3rd-level [arcane|divine] spells" / similar.
    {
      rx: CAST_SPELLS_RX,
      build: (m) => ({
        kind: 'castSpells',
        level: parseInt(m[2], 10),
        // "manifest" is always psionic even when the text doesn't say so
        // ("ability to manifest 9th-level powers").
        flavor: m[3] ? m[3].toLowerCase()
                     : (/^manifest$/i.test(m[1]) ? 'psionic' : 'any'),
      }),
    },
    // Skill ranks — "Skill 9 ranks" / "Skill (subtype) 5 ranks".
    // Order matters: the skill name itself can contain a parenthetical
    // (Knowledge (the planes), Craft (alchemy), etc.), so the regex
    // greedily captures everything before "N ranks".
    {
      rx: /\b([A-Z][\w']*(?:\s+\([^)]+\))?(?:\s+[A-Z]\w*)?)\s+(\d+)\s+ranks?\b/,
      build: (m) => ({
        kind: 'skill',
        skill: m[1].trim(),
        ranks: parseInt(m[2], 10),
      }),
    },
    // Class level — "Warmage level 4th" / "Fighter level 6" / "5th-level
    // Wizard". Matched AFTER caster-level so "Caster level 5th" doesn't
    // false-match as if "Caster" were a class.
    {
      rx: /\b([A-Z]\w+(?:\s+[A-Z]\w+)?)\s+level\s+(\d+)(?:st|nd|rd|th)?\+?/i,
      build: (m) => ({
        kind: 'classLevel',
        className: m[1].trim(),
        level: parseInt(m[2], 10),
      }),
    },
    {
      rx: /\b(\d+)(?:st|nd|rd|th)?-level\s+([A-Z]\w+)/i,
      build: (m) => ({
        kind: 'classLevel',
        className: m[2].trim(),
        level: parseInt(m[1], 10),
      }),
    },
    // Bare class-name + level — e.g. "Wizard 5", "Cleric 3+". Anchored
    // to the full fragment so it doesn't false-match substrings, and
    // excludes ability names via negative lookahead so "Str 13" still
    // routes to the ability pattern below.
    {
      rx: new RegExp(
        `^(?!(?:${ABILITY_RX_PARTS})\\b)` +
        `([A-Z]\\w+(?:\\s+[A-Z]\\w+)?)\\s+(\\d+)(?:st|nd|rd|th)?\\+?$`,
        'i'
      ),
      build: (m) => ({
        kind: 'classLevel',
        className: m[1].trim(),
        level: parseInt(m[2], 10),
      }),
    },
    // Ability scores — "Str 13", "Dex 13", "Con 14" etc. After the
    // longer-form patterns above so e.g. "Cha 15" doesn't false-match
    // as "Caster level Cha 15" garbage.
    {
      rx: new RegExp(`\\b(${ABILITY_RX_PARTS})\\s+(\\d+)`, 'i'),
      build: (m) => {
        const k = m[1].toUpperCase();
        return {
          kind: 'ability',
          ability: ABILITY_FULL[k] || k,   // "CONSTITUTION" → "CON"
          value: parseInt(m[2], 10),
        };
      },
    },
    // Alignment — "Evil alignment" / "Chaotic alignment" / "Any chaotic"
    {
      rx: /\b(lawful|chaotic|good|evil|neutral)(?:\s+(lawful|chaotic|good|evil|neutral))?\s+alignment/i,
      build: (m) => ({
        kind: 'alignment',
        parts: [m[1], m[2]].filter(Boolean).map(s => s.toLowerCase()),
      }),
    },
    // L6 (2026-05-17 play-feel pass): "Proficiency with weapon" /
    // "Proficient with weapon" — Weapon Focus, Improved Critical,
    // Weapon Specialization, etc. The placeholder "weapon" is filled
    // in at feat-pick time (e.g. Weapon Focus (Longsword)); the prereq
    // itself doesn't name the specific weapon. We treat it as
    // "satisfied" when the character has any class that grants broad
    // weapon proficiency (Fighter, Paladin, etc.) and "unknown"
    // otherwise — the user picks the specific weapon and the check is
    // only as smart as the class taxonomy can be without DB metadata.
    {
      rx: /\bprofic(?:ient|iency)\s+with\s+(weapon|the\s+chosen\s+weapon|chosen\s+weapon)\b/i,
      build: () => ({ kind: 'weaponProficiency' }),
    },
  ];

  // Classes that grant proficiency with all simple AND martial weapons
  // — the broad-strikes set. If the character has any of these as a
  // class, "Proficiency with weapon" is treated as satisfied for the
  // common Weapon Focus / Greater Weapon Focus / Improved Critical
  // cases. Not exhaustive (e.g. Samurai is in Complete Warrior; PrCs
  // that add proficiencies are not listed); the checker degrades
  // gracefully to 'unknown' for anyone else, so misses are non-fatal.
  const MARTIAL_PROFICIENT_CLASSES = new Set([
    'Fighter', 'Paladin', 'Ranger', 'Barbarian', 'Hexblade',
    'Knight', 'Marshal', 'Samurai', 'Swashbuckler', 'Scout',
    'Warblade', 'Crusader', 'Swordsage', 'Duskblade',
    // Specific divine + arcane classes that grant martial weapons
    // via deity or alignment also slot in here.
    'Soulborn', 'Totemist', 'Incarnate',
  ]);

  function parse(rawText) {
    if (!rawText) return [];
    const text = String(rawText).trim();
    if (!text || text === '-' || text === '—' || /^none$/i.test(text)) {
      return [];
    }
    // Split on commas + semicolons. We keep the original fragment text
    // on each atom so we can show it in tooltips and so unparsed atoms
    // can carry their raw form for display.
    const fragments = text
      .split(/\s*[,;]\s*/)
      // Strip trailing periods, and a leading "or " left behind when a
      // book writes an alternation across commas ("Crusader, Swordsage,
      // or Warblade level 1+") — without this the third fragment parsed
      // as a class literally named "or Warblade".
      .map(f => f.replace(/^or\s+/i, '').replace(/\.\s*$/, '').trim())
      .filter(Boolean);
    const atoms = [];
    for (const frag of fragments) {
      // "A or B" alternation — satisfied if EITHER side is. Skipped when
      // the "or" belongs to a cast-spells clause ("9th-level arcane or
      // divine spells"), which is one requirement, not two.
      if (!CAST_SPELLS_RX.test(frag)) {
        const alts = splitAlternatives(frag);
        // Only keep the split when EVERY branch parses to something
        // real. An unparsed branch means the "or" wasn't a requirement
        // boundary at all — "sneak attack +2d6 or sudden strike +2d6",
        // "size Large or larger", "lay on hands or wholeness of body
        // class feature" — and splitting there just doubles the "?"
        // chips, or worse invents a feat named "Ability to cast arcane
        // spells as a bard". Falling back re-parses the fragment whole,
        // which is exactly the pre-alternation behavior.
        if (alts.length > 1) {
          const options = alts.map(parseFragment);
          if (options.every(o => o.kind !== 'unparsed')) {
            atoms.push({ kind: 'anyOf', options, raw: frag });
            continue;
          }
        }
      }
      atoms.push(parseFragment(frag));
    }
    return atoms;
  }

  // Split a fragment on " or " — but only at parenthesis depth 0. A book
  // that writes "Weapon Focus (warhammer or light hammer)" means ONE feat
  // with a choice inside it, not two requirements; a naive split yields
  // the mangled pair ["Weapon Focus (warhammer", "light hammer)"].
  // Returns [frag] when there's nothing to split.
  function splitAlternatives(frag) {
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < frag.length; i++) {
      const ch = frag[i];
      if (ch === '(') { depth++; continue; }
      if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
      if (depth !== 0) continue;
      const m = /^\s+or\s+/i.exec(frag.slice(i));
      if (m) {
        parts.push(frag.slice(start, i));
        i += m[0].length - 1;
        start = i + 1;
      }
    }
    parts.push(frag.slice(start));
    return parts.map(s => s.trim()).filter(Boolean);
  }

  // Parse a single (already split + cleaned) fragment into one atom.
  function parseFragment(frag) {
    for (const { rx, build } of PATTERNS) {
      const m = frag.match(rx);
      if (m) return { ...build(m), raw: frag };
    }
    // Fall through to a feat-name check OR unparsed.
    // For now we emit 'feat' for any short capitalized phrase that
    // doesn't contain digits — the checker will look it up against
    // the character's actual feat list. If the lookup fails, the
    // checker downgrades to 'unparsed'.
    if (/^[A-Z][\w'’,\s\-()]+$/.test(frag) && !/\d/.test(frag)) {
      return { kind: 'feat', name: frag.trim(), raw: frag };
    }
    return { kind: 'unparsed', raw: frag };
  }

  // ---- Character-state snapshot --------------------------------------
  //
  // Reads the DOM + class-picker state into a single object that the
  // checker consumes. Called on each evaluation; cheap enough that we
  // don't bother memoizing.

  function snapshot() {
    const s = { abilities: {}, classes: [], featNames: new Set(),
                skillRanks: new Map(), bab: 0, alignment: '',
                casterLevels: { arcane: 0, divine: 0, psionic: 0, any: 0 } };
    // Abilities: use the displayed totals (`#str-total` etc.) since
    // those include racial / template / item bonuses. The total is
    // what the prereq actually cares about.
    for (const ab of ABILITIES) {
      const tot = document.getElementById(`${ab.toLowerCase()}-total`);
      s.abilities[ab] = tot ? parseInt(tot.textContent, 10) || 0 : 0;
    }
    // BAB: take the first BAB-iterative value as the base attack
    // bonus (the sheet renders BAB-1 / -6 / -11 / -16 for iteratives;
    // BAB-1 IS the base bonus).
    const babEl = document.getElementById('bab-1');
    s.bab = babEl ? parseInt(babEl.value, 10) || 0 : 0;
    // Classes: prefer ClassPicker.getState; fall back to parsing the
    // free-text #char-class textarea if no classes are picked.
    if (window.ClassPicker && typeof ClassPicker.getState === 'function') {
      for (const e of ClassPicker.getState()) {
        s.classes.push({ name: e.className, level: e.level });
      }
    }
    if (!s.classes.length) {
      const txt = document.getElementById('char-class')?.value || '';
      // "Fighter 5 / Wizard 3" → [{Fighter,5},{Wizard,3}]
      for (const part of txt.split(/\s*\/\s*/)) {
        const m = part.match(/^(.+?)\s+(\d+)\s*$/);
        if (m) s.classes.push({ name: m[1].trim(), level: parseInt(m[2], 10) });
      }
    }
    // Caster levels: walk each spellcasting panel's caster-level
    // input; flavor (arcane / divine / psionic) is best-effort from
    // the notes string (or DB class metadata if available).
    for (const panel of document.querySelectorAll('[data-caster-type="spellcasting"]')) {
      const lvl = parseInt(panel.querySelector('.sc-caster-level')?.value, 10) || 0;
      if (!lvl) continue;
      const notes = (panel.querySelector('.caster-notes')?.value || '').toLowerCase();
      // Crude flavor inference from the panel's notes. Picks the
      // best-known match; if ambiguous (e.g. Sha'ir has both), counts
      // toward both flavors.
      const flavors = new Set();
      if (/cleric|paladin|druid|ranger|favored\s+soul|spirit\s+shaman|healer|shugenja|sha'?ir|urban\s+druid/.test(notes)) flavors.add('divine');
      if (/wizard|sorcerer|bard|warmage|beguiler|dread\s+necromancer|hexblade|duskblade|spellthief|sha'?ir|jester/.test(notes)) flavors.add('arcane');
      if (!flavors.size) { flavors.add('arcane'); flavors.add('divine'); }
      for (const f of flavors) s.casterLevels[f] = Math.max(s.casterLevels[f], lvl);
      s.casterLevels.any = Math.max(s.casterLevels.any, lvl);
    }
    for (const panel of document.querySelectorAll('[data-caster-type="psionics"]')) {
      const lvl = parseInt(panel.querySelector('.psi-manifester-level')?.value, 10) || 0;
      if (!lvl) continue;
      s.casterLevels.psionic = Math.max(s.casterLevels.psionic, lvl);
      s.casterLevels.any = Math.max(s.casterLevels.any, lvl);
    }
    // Feats taken: each .feat-entry textarea's first line, stripped
    // of trailing parentheticals ("Power Attack (Str 13)" → "Power
    // Attack").
    for (const el of document.querySelectorAll('#feats-container .feat-entry')) {
      const raw = (el.value || '').trim();
      if (!raw) continue;
      const firstLine = raw.split(/\r?\n/)[0].trim();
      const stripped = firstLine.replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (stripped) s.featNames.add(stripped.toLowerCase());
    }
    // Skill ranks: every .skill-row's name + ranks input.
    for (const inp of document.querySelectorAll('.skill-ranks')) {
      const ranks = parseFloat(inp.value) || 0;
      if (ranks <= 0) continue;
      const row = inp.closest('tr');
      const name = row?.querySelector('.skill-name')?.textContent?.trim();
      if (name) s.skillRanks.set(name.toLowerCase(), ranks);
    }
    // Alignment.
    s.alignment = (document.getElementById('char-alignment')?.value || '').toLowerCase();
    // Character level — what "Character level 6th" prereqs mean. Prefer
    // ClassPicker's own total (it counts racial HD and takes the MAX of
    // the two sides under gestalt rather than summing them); fall back to
    // the #char-level box, then to summing whatever classes we found.
    if (window.ClassPicker && typeof ClassPicker.totalCharacterLevel === 'function') {
      s.characterLevel = ClassPicker.totalCharacterLevel();
    }
    if (!s.characterLevel) {
      s.characterLevel =
        parseInt(document.getElementById('char-level')?.value, 10) ||
        s.classes.reduce((n, c) => n + (c.level || 0), 0);
    }
    return s;
  }

  // ---- Checker -------------------------------------------------------
  //
  // Given parsed atoms + a snapshot, returns
  //   { atoms: [{ ...atom, status: 'satisfied'|'unmet'|'unknown', detail }] }
  // The UI maps statuses to ✓/✗/? markers.

  // Is `name` a real class or PrC in the DB? Backs the classLevel
  // safety net above. Built once, lazily; returns true when the DB
  // isn't available so a DB-less sheet keeps its old behavior instead
  // of turning every class prereq into a "?".
  let _classNameSet = null;
  function isKnownClassName(name) {
    if (!(window.DB && DB.isLoaded())) return true;
    if (!_classNameSet) {
      _classNameSet = new Set(
        (DB.query("SELECT DISTINCT LOWER(name) AS n FROM entry " +
                  "WHERE type IN ('class','prc')") || [])
          .map(r => r.n));
    }
    return _classNameSet.has(String(name).toLowerCase());
  }

  function check(atoms, state) {
    state = state || snapshot();
    const out = [];
    for (const a of atoms) {
      out.push({ ...a, ...checkOne(a, state) });
    }
    return { atoms: out };
  }

  function checkOne(a, state) {
    switch (a.kind) {
      case 'ability': {
        const have = state.abilities[a.ability] || 0;
        return {
          status: have >= a.value ? 'satisfied' : 'unmet',
          detail: `have ${have}`,
        };
      }
      case 'bab': {
        return {
          status: state.bab >= a.value ? 'satisfied' : 'unmet',
          detail: `have +${state.bab}`,
        };
      }
      case 'casterLevel': {
        const have = state.casterLevels[a.flavor] || 0;
        return {
          status: have >= a.level ? 'satisfied' : 'unmet',
          detail: `have ${a.flavor} CL ${have}`,
        };
      }
      case 'castSpells': {
        // Heuristic: a character can cast Nth-level spells if any
        // spellcasting panel of the right flavor has caster level
        // sufficient (rough: CL N requires CL >= 2N-1 for fullcasters
        // — close enough for v1, false-negatives possible for half-
        // casters; tolerable since this is warn-only).
        const cl = state.casterLevels[a.flavor === 'any' ? 'any' : a.flavor] || 0;
        const need = Math.max(1, 2 * a.level - 1);
        return {
          status: cl >= need ? 'satisfied' : (cl > 0 ? 'unknown' : 'unmet'),
          detail: cl > 0 ? `have CL ${cl}` : 'no caster level',
        };
      }
      case 'characterLevel': {
        const have = state.characterLevel || 0;
        return {
          status: have >= a.level ? 'satisfied' : 'unmet',
          detail: `have character level ${have}`,
        };
      }
      case 'classLevel': {
        const want = a.className.toLowerCase();
        const hit = state.classes.find(c => c.name.toLowerCase() === want);
        const have = hit ? hit.level : 0;
        if (have >= a.level) return { status: 'satisfied', detail: `have L${have}` };
        // Safety net for parser overreach. The generic "<Name> level N"
        // pattern is greedy enough to swallow fragments that were never
        // class levels at all — "Fly speed 90", "Leadership score 25",
        // "essentia pool 2", "Meldshaper level 9th". Reporting those as
        // ✗ "no levels in Fly speed" is confidently wrong; if the DB has
        // never heard of the name as a class, degrade to "?" instead.
        // (DB-less mode keeps the old behavior — nothing to check against.)
        if (have === 0 && !isKnownClassName(a.className)) {
          return {
            status: 'unknown',
            detail: `"${a.className}" isn't a tracked class — check manually`,
          };
        }
        return {
          status: 'unmet',
          detail: have ? `have L${have}` : `no levels in ${a.className}`,
        };
      }
      case 'anyOf': {
        // "Spell Focus (evocation) or evoker level 1st" — one requirement
        // met by either branch. Satisfied if any option is; unmet only if
        // every option is definitively unmet.
        const results = a.options.map(o => checkOne(o, state));
        const hit = results.find(r => r.status === 'satisfied');
        if (hit) return { status: 'satisfied', detail: hit.detail };
        if (results.every(r => r.status === 'unmet')) {
          return {
            status: 'unmet',
            detail: results.map(r => r.detail).join(' / '),
          };
        }
        return {
          status: 'unknown',
          detail: results.map(r => r.detail).join(' / '),
        };
      }
      case 'skill': {
        const want = a.skill.toLowerCase();
        const have = state.skillRanks.get(want) || 0;
        return {
          status: have >= a.ranks ? 'satisfied' : 'unmet',
          detail: `have ${have} rank${have === 1 ? '' : 's'}`,
        };
      }
      case 'feat': {
        const want = a.name.toLowerCase();
        const have = state.featNames.has(want);
        // If the "feat" name isn't in the character's list AND isn't
        // a known feat in the DB at all, downgrade to 'unknown' so we
        // don't false-fail on free-text class-feature requirements
        // like "skirmish or sneak attack ability".
        if (have) return { status: 'satisfied', detail: 'taken' };
        if (window.DB && DB.isLoaded()) {
          const exists = DB.queryOne(
            "SELECT 1 AS x FROM entry WHERE type='feat' " +
            "AND name = :n COLLATE NOCASE LIMIT 1", { ':n': a.name });
          if (!exists) {
            return { status: 'unknown', detail: 'not a known feat name' };
          }
        }
        return { status: 'unmet', detail: 'not taken' };
      }
      case 'alignment': {
        const have = state.alignment;
        if (!have) return { status: 'unknown', detail: 'no alignment set' };
        const ok = a.parts.every(p => have.includes(p));
        return {
          status: ok ? 'satisfied' : 'unmet',
          detail: `have ${have}`,
        };
      }
      case 'weaponProficiency': {
        // "Proficiency with weapon" — generic prereq on Weapon Focus
        // and kin. Strictly correct evaluation requires knowing the
        // chosen weapon (Weapon Focus is parameterized: e.g. "Weapon
        // Focus (Longsword)") AND whether the character is proficient
        // with THAT specific weapon. We don't track weapon proficiency
        // per-weapon on the sheet today — we'd need DB class
        // metadata (currently null on core classes) or a sheet-side
        // proficiencies field. As a pragmatic heuristic, if the
        // character has any class in MARTIAL_PROFICIENT_CLASSES, mark
        // satisfied with a "covered by ..." detail; otherwise leave
        // 'unknown' so the user sees the `?` and verifies manually.
        const broadlyProf = state.classes
          .find(c => MARTIAL_PROFICIENT_CLASSES.has(c.name));
        if (broadlyProf) {
          return {
            status: 'satisfied',
            detail: `${broadlyProf.name} grants martial proficiency`,
          };
        }
        return {
          status: 'unknown',
          detail: 'depends on the specific weapon chosen',
        };
      }
      case 'unparsed':
        return { status: 'unknown', detail: 'unparsed' };
      default:
        return { status: 'unknown', detail: '' };
    }
  }

  // ---- Rendering helpers --------------------------------------------
  //
  // Produces an HTML fragment with each atom inline. ✓ green, ✗ red,
  // ? amber. Used by both feat-picker.js (info panel) and feats.js
  // (per-row indicator).

  const STATUS_SYM = { satisfied: '✓', unmet: '✗', unknown: '?' };
  const STATUS_CLS = { satisfied: 'fp-ok', unmet: 'fp-bad', unknown: 'fp-unk' };

  function renderAtoms(atoms) {
    if (!atoms.length) {
      return '<span class="fp-none">no prereqs</span>';
    }
    const parts = atoms.map(a => {
      const sym = STATUS_SYM[a.status] || '?';
      const cls = STATUS_CLS[a.status] || 'fp-unk';
      const title = a.detail ? ` title="${escapeAttr(a.detail)}"` : '';
      return `<span class="fp-atom ${cls}"${title}>` +
             `${sym} ${escapeHtml(a.raw)}</span>`;
    });
    return parts.join(' ');
  }

  // Worst-status summary indicator (for compact row badges).
  function summary(atoms) {
    if (!atoms.length) return { status: 'satisfied', label: '—' };
    let worst = 'satisfied';
    for (const a of atoms) {
      if (a.status === 'unmet') return { status: 'unmet', label: '✗' };
      if (a.status === 'unknown' && worst === 'satisfied') worst = 'unknown';
    }
    return {
      status: worst,
      label: worst === 'satisfied' ? '✓' : '?',
    };
  }

  // Convenience: parse + check + render in one shot, given a prereq
  // string. Returns { html, summary }.
  function evaluate(prereqText, state) {
    const atoms = parse(prereqText);
    const checked = check(atoms, state).atoms;
    return { html: renderAtoms(checked), summary: summary(checked), atoms: checked };
  }

  // ---- Phase B: history-aware snapshot ------------------------------
  //
  // `snapshotAtLevel(level, opts)` returns the same shape as
  // `snapshot()` but rewound to the character's state AT the moment a
  // level-N feat is being picked. Per RAW the picking order within a
  // level is class → HP → skills → feats → ability boost (if HD%4),
  // so feats see "after this level's class, before this level's
  // boost." Concretely:
  //   - classes: cumulative through level (inclusive — class taken
  //     AT this level counts)
  //   - featNames: cumulative through level-1 (we're CHECKING level-N
  //     feats; the audit special-cases same-level prereqs)
  //   - skillRanks: cumulative through level-1
  //   - abilities: current totals minus boosts at level >= N. Doesn't
  //     account for unrelated mid-build ability shifts (item swaps,
  //     re-rolls) since history doesn't track those — but the
  //     boost case is the common one.
  //   - bab + casterLevels: derived from the cumulative classes via
  //     the same bab_progression lookups class-picker uses.
  //   - alignment: not tracked per-level; uses current.
  //
  // `opts` shape:
  //   { history: [...] | undefined,    // CharacterHistory.get() result
  //     currentAbilities: {STR:.., ..}, // defaults to live #*-total
  //     currentAlignment: 'lawful good' }
  //
  // Falls back to the live `snapshot()` when `history` is empty (so
  // callers don't have to guard).

  // Cache class metadata lookups (bab_progression, flavor) by name
  // so per-level evaluation doesn't re-query for every feat.
  const _classMetaCache = new Map();
  function getClassMetadata(className) {
    if (_classMetaCache.has(className)) return _classMetaCache.get(className);
    let meta = { bab: null, flavor: null };
    if (window.DB && DB.isLoaded()) {
      const r = DB.queryOne(
        "SELECT json_extract(data, '$.bab_progression')           AS bab, " +
        "       json_extract(data, '$.spellcasting.class_type')   AS flavor " +
        "FROM entry WHERE type IN ('class','prc') " +
        "AND name = ? COLLATE NOCASE LIMIT 1", [className]);
      if (r) {
        meta.bab = r.bab || null;
        // class_type can be 'arcane' / 'divine' / 'psionic' OR an
        // array (Sha'ir is ['arcane','divine']). Normalize to a flat
        // list of strings.
        const f = r.flavor;
        if (f) {
          try {
            const parsed = (typeof f === 'string' && f.startsWith('['))
              ? JSON.parse(f) : f;
            meta.flavor = Array.isArray(parsed) ? parsed : [String(parsed)];
          } catch (e) {
            meta.flavor = [String(f)];
          }
        }
      }
    }
    _classMetaCache.set(className, meta);
    return meta;
  }

  // Local copy of class-picker's babAt formula. Mirrors the canonical
  // SRD progressions: full (1×), three-quarters (×0.75), half (×0.5).
  function babAtLevel(prog, lvl) {
    if (lvl <= 0) return 0;
    const p = String(prog || '').toLowerCase();
    if (p.startsWith('good') || p === 'full' || p === 'high') return lvl;
    if (p.startsWith('ave') || p.startsWith('avg') || p.startsWith('mid') ||
        p === 'three-quarters' || p === '3/4') {
      return Math.floor(lvl * 3 / 4);
    }
    if (p.startsWith('poor') || p === 'half' || p === '1/2') {
      return Math.floor(lvl / 2);
    }
    return 0;
  }

  function snapshotAtLevel(level, opts) {
    opts = opts || {};
    const hist = Array.isArray(opts.history) ? opts.history : [];
    if (!hist.length) {
      // No history → fall back to present-tense (Phase A behavior).
      return snapshot();
    }

    // Current totals as the baseline for ability rewind.
    const currentAbilities = opts.currentAbilities || (() => {
      const out = {};
      for (const ab of ABILITIES) {
        const tot = document.getElementById(`${ab.toLowerCase()}-total`);
        out[ab] = tot ? parseInt(tot.textContent, 10) || 0 : 0;
      }
      return out;
    })();

    // Classes: cumulative through `level` (inclusive). Gestalt records two
    // classes per level (class_taken + class_taken_b); each side is an
    // independent progression. For class-level / caster prereqs we take the
    // higher level per class name across sides (you don't stack the same
    // class's levels across sides); BAB is per-side-summed then maxed below.
    const countSide = (field) => {
      const m = new Map();  // className → count
      for (const e of hist) {
        if (e.level > level) continue;
        const c = e[field];
        if (c) m.set(c, (m.get(c) || 0) + 1);
      }
      return m;
    };
    const clA = countSide('class_taken');
    const clB = countSide('class_taken_b');  // empty for non-gestalt histories
    const classLevels = new Map(clA);
    for (const [name, n] of clB) {
      classLevels.set(name, Math.max(classLevels.get(name) || 0, n));
    }
    const classes = [...classLevels].map(([name, lvl]) => ({ name, level: lvl }));

    // Feats: through level - 1 (the feat we're checking is AT this
    // level; the audit handles same-level prereqs separately).
    const featNames = new Set();
    for (const e of hist) {
      if (e.level >= level) continue;
      for (const fn of (e.feats_taken || [])) {
        const s = String(fn || '').trim()
          .replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
        if (s) featNames.add(s);
      }
    }

    // Skill ranks: through level - 1.
    const skillRanks = new Map();
    for (const e of hist) {
      if (e.level >= level) continue;
      for (const [name, ranks] of Object.entries(e.skills_purchased || {})) {
        const key = name.toLowerCase();
        skillRanks.set(key, (skillRanks.get(key) || 0) + (parseFloat(ranks) || 0));
      }
    }

    // Abilities: subtract boosts at levels >= N (those happened AFTER
    // this level's feat was picked).
    const abilities = { ...currentAbilities };
    for (const e of hist) {
      if (e.level < level) continue;
      const boost = e.ability_boost;
      if (boost && typeof abilities[boost] === 'number') {
        abilities[boost] = abilities[boost] - 1;
      }
    }

    // Caster levels: a class's caster level is its level on whichever side it
    // appears (a max), so the combined `classes` set is correct here.
    const casterLevels = { arcane: 0, divine: 0, psionic: 0, any: 0 };
    for (const { name, level: lvl } of classes) {
      const meta = getClassMetadata(name);
      if (meta.flavor && meta.flavor.length) {
        for (const f of meta.flavor) {
          const key = f === 'manifesting' ? 'psionic' : f;
          if (casterLevels[key] != null) {
            casterLevels[key] = Math.max(casterLevels[key], lvl);
            casterLevels.any = Math.max(casterLevels.any, lvl);
          }
        }
      }
    }
    // BAB is gestalt-synthesized as max(Side A total, Side B total) — NOT the
    // sum of both sides — so sum each side independently and take the better.
    // Non-gestalt (clB empty) reduces to Side A's sum, unchanged.
    const babForSide = (m) => {
      let b = 0;
      for (const [name, lvl] of m) b += babAtLevel(getClassMetadata(name).bab, lvl);
      return b;
    };
    const babA = babForSide(clA);
    const bab = clB.size ? Math.max(babA, babForSide(clB)) : babA;

    return {
      abilities, classes, featNames, skillRanks, bab,
      alignment: (opts.currentAlignment ||
        (document.getElementById('char-alignment')?.value || '').toLowerCase()),
      casterLevels,
      // At level N the character level IS N — that's what this snapshot
      // is pinned to, so no reconstruction from the history is needed.
      characterLevel: level,
    };
  }

  // Convenience: parse + history-aware snapshot + check + render.
  // Mirrors `evaluate()` but pinned to the level the feat was taken.
  function evaluateAtLevel(prereqText, level, opts) {
    const atoms = parse(prereqText);
    const state = snapshotAtLevel(level, opts);
    const checked = check(atoms, state).atoms;
    return {
      html: renderAtoms(checked),
      summary: summary(checked),
      atoms: checked,
      state,
    };
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  return {
    parse, check, snapshot, renderAtoms, summary, evaluate,
    // Phase B (history-aware):
    snapshotAtLevel, evaluateAtLevel,
  };
})();
