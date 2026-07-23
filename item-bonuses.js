// item-bonuses.js — Read a magic item's ALWAYS-ON mechanical bonuses out of
// its name, so typing "Cloak of Resistance +2" fills the save boxes instead
// of making the player do it by hand.
//
// Exposed as the global `ItemBonuses`. Pure (no DOM) apart from the optional
// Ioun-Stone lookup, which reads the DB when it's loaded; equipment.js owns
// the actual filling.
//
// SCOPE — deliberately narrow, and the narrowness is the point.
// A DB-wide survey found 680 of 4475 items carrying a parseable "+N <type>
// bonus" phrase, but the large majority are SITUATIONAL: "+6 circumstance
// bonus on Escape Artist checks made when the wearer is bound", "+2
// competence bonus" under some condition. Auto-filling those as static
// bonuses would silently inflate a character's numbers, and a sheet that
// quietly lies about its totals is worse than one that makes you type. So
// we only handle items whose bonus is unconditional AND whose magnitude is
// stated in the name (or fixed by the item), plus the Ioun Stones, whose
// effects the DMG states as a structured table.
//
// Everything else is left alone on purpose.

const ItemBonuses = (function () {

  // ---- Ability nouns ------------------------------------------------
  // Keyed by the word that appears in the item's name. Includes the flavour
  // synonyms books and homebrew actually use, so "Circlet of Intelligence"
  // works alongside the RAW "Headband of Intellect".
  const ABILITY_WORDS = [
    [/\b(?:ogre power|giant strength|strength|might)\b/i, 'STR'],
    [/\b(?:dexterity|agility)\b/i,                        'DEX'],
    [/\b(?:health|constitution|vitality|endurance)\b/i,   'CON'],
    [/\b(?:intellect|intelligence)\b/i,                   'INT'],
    [/\b(?:wisdom)\b/i,                                   'WIS'],
    [/\b(?:charisma|persuasion)\b/i,                      'CHA'],
  ];

  // Items whose bonus is a fixed magnitude with no "+N" in the name.
  const FIXED_MAGNITUDE = [
    [/^gauntlets of ogre power$/i, 2],
  ];

  // ---- Name parsing -------------------------------------------------

  // "Cloak of Resistance +2" -> { base: "Cloak of Resistance", plus: 2 }
  // Also tolerates "+2 Cloak of Resistance" and a trailing ", +2".
  function splitPlus(name) {
    const s = String(name || '').trim();
    let m = s.match(/^(.*?)[\s,]*\+\s*(\d+)\s*$/);
    if (m) return { base: m[1].trim(), plus: parseInt(m[2], 10) };
    m = s.match(/^\+\s*(\d+)\s+(.*)$/);
    if (m) return { base: m[2].trim(), plus: parseInt(m[1], 10) };
    return { base: s, plus: null };
  }

  // Parse "+1 competence bonus on attack rolls, saves, skill checks, and
  // ability checks" / "+2 enhancement bonus to Dexterity" / "+1 insight
  // bonus to AC" — the shape the DMG Ioun Stone table states its effects in.
  // Returns { amount, type, targets[] } or null.
  function parseEffectPhrase(text) {
    const m = String(text || '').match(
      /\+(\d+)\s+(\w+)\s+bonus\s+(?:to|on)\s+([^.;]+)/i);
    if (!m) return null;
    return {
      amount: parseInt(m[1], 10),
      type: m[2].toLowerCase(),
      // "attack rolls, saves, skill checks, and ability checks" splits on the
      // comma first, so the last item arrives as "and ability checks" — strip
      // the leading conjunction or it leaks into the summary text.
      targets: m[3].split(/\s*,\s*|\s+and\s+|\s+or\s+/i)
        .map(t => t.trim().toLowerCase().replace(/^(?:and|or)\s+/, '').trim())
        .filter(Boolean),
    };
  }

  // ---- Ioun Stones ---------------------------------------------------
  // The DMG prints one "Ioun Stones" entry with a colour table; the player
  // writes the colour into the item name ("Pale Green Ioun Stone"). Read the
  // structured table rather than restating it here, so the DB stays the
  // single source of truth.
  let _iounRows = null;      // [{color, effect}] | null (not loaded / no DB)
  function iounRows() {
    if (_iounRows !== null) return _iounRows;
    _iounRows = [];
    if (!(typeof DB !== 'undefined' && DB.isLoaded && DB.isLoaded())) {
      _iounRows = null;                       // retry once the DB is up
      return null;
    }
    try {
      const row = DB.queryOne(
        "SELECT data FROM entry WHERE type IN ('item','weapon','armor','gear') " +
        "AND name = 'Ioun Stones' LIMIT 1");
      const tables = row ? (JSON.parse(row.data).tables || []) : [];
      for (const t of tables) {
        const cols = (t.columns || []).map(c => String(c).toLowerCase());
        const ci = cols.indexOf('color'), ei = cols.indexOf('effect');
        if (ci < 0 || ei < 0) continue;
        for (const r of (t.rows || [])) {
          const cells = Array.isArray(r) ? r
            : (r && typeof r === 'object') ? Object.values(r) : null;
          if (!cells) continue;
          _iounRows.push({ color: String(cells[ci] || ''), effect: String(cells[ei] || '') });
        }
      }
    } catch (e) { /* malformed table — degrade to no ioun support */ }
    return _iounRows;
  }

  function parseIoun(name) {
    if (!/ioun\s+stone/i.test(name)) return null;
    const rows = iounRows();
    if (!rows || !rows.length) return null;
    // Strip the "ioun stone" words and any parens, leaving the colour.
    const said = String(name)
      .replace(/\bioun\s+stones?\b/ig, ' ')
      .replace(/[()]/g, ' ')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    if (!said) return null;
    // Longest colour first so "pale green" wins over a bare "green", and
    // "lavender and green" over "lavender".
    const sorted = rows.slice().sort((a, b) => b.color.length - a.color.length);
    const hit = sorted.find(r => r.color && said.includes(r.color.toLowerCase()));
    if (!hit) return null;
    const eff = parseEffectPhrase(hit.effect);
    if (!eff) return null;                    // non-numeric stone (Alertness, etc.)
    return specFromEffect(eff, `Ioun Stone (${hit.color})`);
  }

  // Turn a parsed "+N <type> bonus to <targets>" into a fill spec.
  function specFromEffect(eff, label) {
    const spec = { label, saves: null, abilities: null, ac: [], skills: [],
                   attack: 0, notes: '' };
    // Match target words on a WORD BOUNDARY, never as a bare substring.
    // "attack rolls" contains the letters "ac", so a substring test gave the
    // Pale Green Ioun Stone a phantom +1 AC it does not grant.
    // Bounded on both sides, but tolerating a plural, so "save" still finds
    // "saves" while "ac" does NOT find "attack" (no boundary before its "ac")
    // and does not find "actions" (no boundary after).
    const has = (...words) => eff.targets.some(t =>
      words.some(w => new RegExp(
        '\\b' + w.replace(/\s+/g, '\\s+') + '(?:s|es)?\\b', 'i').test(t)));
    // Abilities named directly ("+2 enhancement bonus to Dexterity").
    for (const [rx, ab] of ABILITY_WORDS) {
      if (eff.targets.some(t => rx.test(t))) {
        spec.abilities = spec.abilities || {};
        spec.abilities[ab] = eff.amount;
      }
    }
    if (has('saving throw', 'save')) {
      spec.saves = { fort: eff.amount, ref: eff.amount, will: eff.amount,
                     type: eff.type };
    }
    if (has('ac', 'armor class')) {
      spec.ac.push({ ac: eff.amount, type: titleCaseType(eff.type),
                     touch: touchesTouchAC(eff.type), flatfooted: true });
    }
    if (has('skill check', 'skill')) {
      spec.skills.push({ skill: 'All skills', amount: eff.amount, type: eff.type });
    }
    if (has('attack roll', 'attack')) spec.attack = eff.amount;
    // Things the sheet has no dedicated box for still deserve a note.
    const leftovers = eff.targets.filter(t =>
      /ability check|caster level|initiative/.test(t));
    if (leftovers.length) {
      spec.notes = `+${eff.amount} ${eff.type} bonus on ${leftovers.join(', ')}`;
    }
    return anyContent(spec) ? spec : null;
  }

  // Deflection and dodge bonuses apply against touch attacks; armor,
  // shield and natural armor do not.
  function touchesTouchAC(type) {
    return /^(deflection|dodge|insight|luck|sacred|profane|competence|morale)$/i
      .test(type);
  }
  function titleCaseType(t) {
    const map = { 'natural': 'Natural Armor' };
    if (map[t]) return map[t];
    return String(t).replace(/\b\w/g, c => c.toUpperCase());
  }

  function anyContent(s) {
    return !!(s.saves || s.abilities || (s.ac && s.ac.length) ||
              (s.skills && s.skills.length) || s.attack || s.notes);
  }

  // ---- The name-scaled families -------------------------------------
  //
  // Each returns a spec given the magnitude parsed off the name. Order
  // matters: "Amulet of Natural Armor" must beat the bare "armor" test.

  function parseFamily(base, plus) {
    const n = base.toLowerCase();

    // Fixed-magnitude items ignore any +N in the name.
    for (const [rx, amount] of FIXED_MAGNITUDE) {
      if (rx.test(base)) {
        return abilitySpec(base, amount, n) || null;
      }
    }
    if (!plus || plus <= 0) return null;   // every family below scales with +N

    // --- Saves: "of resistance" -------------------------------------
    if (/\bresistance\b/.test(n) && !/\bspell resistance\b/.test(n)) {
      return { label: `${base} +${plus}`, saves: {
        fort: plus, ref: plus, will: plus, type: 'resistance',
      }, abilities: null, ac: [], skills: [], attack: 0, notes: '' };
    }

    // --- AC ---------------------------------------------------------
    // Natural armor BEFORE plain armor, else "amulet of natural armor"
    // would match the armor family.
    if (/\bnatural armor\b/.test(n)) return acSpec(base, plus, 'Natural Armor', false);
    if (/\bprotection\b/.test(n))    return acSpec(base, plus, 'Deflection', true);
    if (/\bdeflection\b/.test(n))    return acSpec(base, plus, 'Deflection', true);
    if (/\bbracers of armor\b/.test(n) || /\barmor\b/.test(n) && /\bbracers\b/.test(n)) {
      return acSpec(base, plus, 'Armor', false);
    }
    if (/\bshield\b/.test(n) && /\bring of\b/.test(n)) {
      return acSpec(base, plus, 'Shield', false);
    }

    // --- Abilities --------------------------------------------------
    return abilitySpec(base, plus, n);
  }

  function acSpec(base, plus, type, touch) {
    return { label: `${base} +${plus}`, saves: null, abilities: null,
             ac: [{ ac: plus, type, touch: !!touch, flatfooted: true }],
             skills: [], attack: 0, notes: '' };
  }

  function abilitySpec(base, amount, lowerName) {
    for (const [rx, ab] of ABILITY_WORDS) {
      if (rx.test(lowerName)) {
        const abilities = {}; abilities[ab] = amount;
        return { label: `${base} +${amount}`, saves: null, abilities,
                 ac: [], skills: [], attack: 0, notes: '' };
      }
    }
    return null;
  }

  // ---- Public entry point -------------------------------------------
  //
  // Returns a fill spec, or null when the item isn't one we can read
  // confidently. Null is the common and CORRECT answer for most items.
  function forItem(name) {
    if (!name || !String(name).trim()) return null;
    const ioun = parseIoun(name);
    if (ioun) return ioun;
    const { base, plus } = splitPlus(name);
    if (!base) return null;
    return parseFamily(base, plus);
  }

  // Human-readable one-liner for the "we filled this in" hint.
  function describe(spec) {
    if (!spec) return '';
    const bits = [];
    if (spec.abilities) {
      for (const [ab, v] of Object.entries(spec.abilities)) bits.push(`+${v} ${ab}`);
    }
    if (spec.saves) bits.push(`+${spec.saves.fort} ${spec.saves.type} to all saves`);
    for (const a of (spec.ac || [])) bits.push(`+${a.ac} ${a.type} AC`);
    for (const s of (spec.skills || [])) bits.push(`+${s.amount} ${s.type} to ${s.skill}`);
    if (spec.attack) bits.push(`+${spec.attack} attack`);
    if (spec.notes) bits.push(spec.notes);
    return bits.join(', ');
  }

  return {
    forItem, describe,
    // Exposed for the test suite:
    splitPlus, parseEffectPhrase, parseIoun, specFromEffect,
  };
})();

if (typeof window !== 'undefined') window.ItemBonuses = ItemBonuses;
