// tests/playfeel-suite.js
//
// Browser-side play-feel test suite. Loaded by index.html only when
// the URL contains `?playfeel=1`. Drives the actual sheet modules
// (no mocking) and reports pass/fail in a floating panel.
//
// Scenarios live in two buckets:
//   - `scenarios[]`  — end-to-end character builds (~7 cases, mostly
//                       at L12 to exercise PrCs + advancers)
//   - `regressions[]` — quick one-assertion checks guarding the
//                       H1-H6 + M1-M9 fixes from the 2026-05-16
//                       play-feel pass (PLAYFEEL-NOTES.md). Add one
//                       per future bug fix; they're fast & high signal.
//
// To run from the browser: open http://localhost:3000/?playfeel=1
//   then click "Run All". The panel pins to the top-right; close it
//   with the × in its header.
//
// To run from Node (CI / Claude harness): preview MCP can eval
//   `await PlayFeel.runAll(); PlayFeel.getResults()` once the page
//   has loaded.

(function () {
  'use strict';

  // ---- Gate: only run when explicitly requested ----------------------
  const params = new URLSearchParams(location.search);
  if (!params.has('playfeel')) return;

  // ---- Tiny test framework -----------------------------------------------

  const scenarios = [];
  const regressions = [];
  let lastResults = null;

  function scenario(name, fn) { scenarios.push({ name, fn, kind: 'scenario' }); }
  function regression(name, fn) { regressions.push({ name, fn, kind: 'regression' }); }

  class AssertError extends Error {}
  function fail(msg) { throw new AssertError(msg); }

  function expect(actual, expected, label) {
    if (actual !== expected) {
      fail(`${label || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  function expectText(sel, expected, label) {
    const el = document.querySelector(sel);
    if (!el) fail(`${label || sel}: element not found`);
    const actual = (el.textContent ?? '').trim();
    if (actual !== expected) {
      fail(`${label || sel}: expected text ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  function expectValue(sel, expected, label) {
    const el = document.querySelector(sel);
    if (!el) fail(`${label || sel}: element not found`);
    const actual = el.value;
    if (actual !== expected) {
      fail(`${label || sel}: expected value ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  function expectIncludes(haystack, needle, label) {
    const s = String(haystack);
    if (!s.includes(needle)) {
      fail(`${label || 'string'}: expected to contain ${JSON.stringify(needle)}, got ${JSON.stringify(s.slice(0, 100))}`);
    }
  }
  function expectExists(sel, label) {
    const el = document.querySelector(sel);
    if (!el) fail(`${label || sel}: element not found`);
    return el;
  }
  function expectVisible(sel, label) {
    const el = expectExists(sel, label);
    if (el.style.display === 'none') fail(`${label || sel}: element is hidden`);
    return el;
  }
  function expectHidden(sel, label) {
    const el = document.querySelector(sel);
    if (!el) return;  // missing = effectively hidden
    if (el.style.display !== 'none') fail(`${label || sel}: element is visible (expected hidden)`);
  }
  function expectGE(actual, expected, label) {
    if (!(actual >= expected)) fail(`${label || 'value'}: expected >= ${expected}, got ${actual}`);
  }

  // ---- Sheet-driving helpers --------------------------------------------

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

  // Reset the sheet to a known-clean state. Equivalent to clicking
  // "New" but bypasses the confirm prompt.
  async function newCharacter() {
    const origConfirm = window.confirm;
    window.confirm = () => true;
    try {
      $('#btn-new').click();
    } finally {
      window.confirm = origConfirm;
    }
    await wait(350);
  }

  // Dispatch input + change so dependent calcs run.
  function set(id, value) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`set: #${id} not found`);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setAbilities(scores) {
    for (const [ab, v] of Object.entries(scores)) {
      set(`${ab.toLowerCase()}-score`, v);
    }
  }

  // Apply a class via the class-picker UI. Waits for the apply to
  // settle (class-changed event listeners + recalcAll).
  async function applyClass(name, level) {
    set('class-lookup', name);
    await wait(300);
    set('class-lookup-level', String(level));
    $('#class-lookup-apply').click();
    // Class apply is heavy: applies skill ticks, populates Class
    // Features tab, may add a Spells sub-tab, then triggers
    // recalcAll + dispatches classes-changed. 600ms covers all.
    await wait(600);
  }

  function removeClass(className) {
    const chip = $$('#mc-classes-list .mc-class-chip').find(c =>
      (c.dataset.class || '').toLowerCase() === className.toLowerCase());
    if (!chip) throw new Error(`removeClass: chip for "${className}" not found`);
    chip.querySelector('button').click();
  }

  async function pickItem(name) {
    set('item-lookup', name);
    await wait(350);
  }

  function classChips() {
    return $$('#mc-classes-list .mc-class-chip').map(c => c.textContent.trim());
  }

  // ---- DB readiness ------------------------------------------------------

  function dbReady() {
    return typeof DB !== 'undefined' && DB.isLoaded && DB.isLoaded();
  }

  async function waitForDb(timeoutMs = 15000) {
    const start = Date.now();
    while (!dbReady()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`DB failed to load within ${timeoutMs}ms`);
      }
      await wait(100);
    }
  }

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ---- Scenarios (full character builds) --------------------------------

  scenario('Fighter 12 — Human, martial baseline', async () => {
    await newCharacter();
    set('char-race', 'Human');
    setAbilities({ STR: 18, DEX: 14, CON: 14, INT: 10, WIS: 12, CHA: 8 });
    await applyClass('Fighter', 12);

    expect(classChips().length, 1, 'one applied class chip');
    expectValue('#char-class', 'Fighter 12', 'top-of-sheet class line');
    expectValue('#char-level', '12', 'char level');
    expectValue('#bab-1', '12', 'iterative-1 BAB');
    // Fighter 12: full BAB → 12/7/2 iteratives
    expectText('#bab-2', '7', 'iterative-2 BAB');
    expectText('#bab-3', '2', 'iterative-3 BAB');
    // Saves: Fort good (2 + 12/2 = 8) + CON +2 = +10; Ref poor (12/3 = 4) + DEX +2 = +6; Will poor + WIS +1 = +5
    expectText('#fort-total', '+10', 'fort total');
    expectText('#ref-total', '+6', 'ref total');
    expectText('#will-total', '+5', 'will total');
    // Class skills auto-ticked (7 Fighter skills)
    const ticked = $$('input.skill-class-check:checked').length;
    expectGE(ticked, 7, 'fighter class skills ticked');
    // History reconstructed to 12 rows
    expect(CharacterHistory.get().length, 12, 'history rows');
  });

  scenario('Sorcerer 12 — Half-Elf, spontaneous arcane', async () => {
    await newCharacter();
    set('char-race', 'Half-Elf');
    setAbilities({ STR: 10, DEX: 14, CON: 12, INT: 10, WIS: 12, CHA: 18 });
    await applyClass('Sorcerer', 12);

    expectValue('#bab-1', '6', 'sorcerer 12 BAB poor (6)');
    expectText('#fort-total', '+5', 'fort poor + CON +1');
    expectText('#will-total', '+9', 'will good + WIS +1');
    // Caster panel exists with Sorcerer notes
    const panel = expectExists('#caster-0', 'sorcerer panel');
    expectValue('#caster-0 .caster-notes', 'Sorcerer', 'caster notes');
    // M1: spontaneous defaults — Show Prepared should be OFF
    const showPrep = panel.querySelector('.sc-show-prepared');
    expect(showPrep.checked, false, 'M1: sorcerer Show Prepared default off');
    expect(panel.querySelector('.sc-show-known').checked, true, 'M1: sorcerer Show Known default on');
    // Spells Known at L12 (Sor table): 0/5/5/4/4/4/3/3/2/1 → L0=9, L1=5, L2=5, etc.
    // Just check L6 known cap is set (Sor L12 = 3 known L6 spells)
    const l6Cap = panel.querySelector('.sc-known[data-lvl="6"]')?.value;
    expectGE(parseInt(l6Cap || '0', 10), 1, 'L6 known cap set');
    // CHA 18 → DCs L0=14, L1=15, ... L6=20
    expectText('#caster-0 .sc-dc[data-lvl="0"]', '14', 'L0 DC = 10 + CHA 4');
    expectText('#caster-0 .sc-dc[data-lvl="6"]', '20', 'L6 DC');
  });

  scenario('Cleric 12 — Human, prepared divine + 2 domains', async () => {
    await newCharacter();
    set('char-race', 'Human');
    setAbilities({ STR: 14, DEX: 10, CON: 14, INT: 10, WIS: 18, CHA: 12 });
    await applyClass('Cleric', 12);

    expectValue('#bab-1', '9', 'cleric 12 BAB medium = 9');
    expectText('#fort-total', '+10', 'fort good + CON +2');
    expectText('#will-total', '+12', 'will good + WIS +4');
    const panel = expectExists('#caster-0', 'cleric panel');
    // M1: prepared full-list — Known hidden, Prepared shown
    expect(panel.querySelector('.sc-show-known').checked, false, 'M1: cleric Show Known default off');
    expect(panel.querySelector('.sc-show-prepared').checked, true, 'M1: cleric Show Prepared default on');
    // 2 domain rows exist by default
    const domains = panel.querySelectorAll('.sc-domain-name');
    expect(domains.length, 2, 'cleric 2 domain rows');
    // Domain slot at L6 (cleric 12 can cast through L6) = 1
    expectValue('#caster-0 .sc-domain-slots[data-lvl="6"]', '1', 'L6 domain slot');
    // L6 castable; L7+ not yet at L12
    expectText('#caster-0 .sc-remain[data-lvl="6"]', String(1 + 1 + 1), 'L6 slots = base 1 + WIS bonus 1 + domain 1');
    expectText('#caster-0 .sc-remain[data-lvl="7"]', '--', 'L7 still locked at cleric 12');
    // M3: Class Features auto-populated with computed values (CHA +1)
    expectValue('#turn-per-day', '4', 'M3: turn-per-day = 3 + 1');
    expectValue('#turn-check', '1d20 + 1', 'M3: turn-check');
    // turn-damage = 2d6 + 12 + 1 = 2d6 + 13
    expectValue('#turn-damage', '2d6 + 13', 'M3: turn-damage');
  });

  scenario('Wizard 7 / Loremaster 5 — full-caster advancer', async () => {
    await newCharacter();
    set('char-race', 'Gray Elf');
    setAbilities({ STR: 8, DEX: 14, CON: 12, INT: 18, WIS: 12, CHA: 10 });
    await applyClass('Wizard', 7);
    await applyClass('Loremaster', 5);

    expect(classChips().length, 2, 'two chips');
    expectValue('#char-level', '12', 'char level 12');
    // Loremaster advances Wizard CL by 5 → total CL 12
    expectValue('#caster-0 .sc-caster-level', '12', 'CL 12 from Wiz 7 + Loremaster 5');
    // L6 spells unlock at CL 11, L7 at CL 13. So Wiz 12 effective: L0-L6.
    // Base Wizard 12: 4/5/5/4/4/3/2/1/0/0
    // INT 18 (+4 mod) bonus spells L1-L4
    expectText('#caster-0 .sc-remain[data-lvl="6"]', '2', 'L6 slots base 2');
    expectText('#caster-0 .sc-remain[data-lvl="7"]', '--', 'L7 still locked');
  });

  scenario('Wizard 5 / Eldritch Knight 7 — caster→martial PrC', async () => {
    await newCharacter();
    set('char-race', 'Human');
    setAbilities({ STR: 14, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 8 });
    await applyClass('Wizard', 5);
    await applyClass('Eldritch Knight', 7);

    expectValue('#char-level', '12', 'char level 12');
    // EK has full BAB. PHB strict per-class: BAB = sum of each class's BAB.
    // Wizard 5 BAB = 2, EK 7 BAB = 7, total = 9.
    expectValue('#bab-1', '9', 'EK 7 + Wizard 5 BAB');
    expectValue('#caster-0 .caster-notes', 'Wizard', 'panel notes still Wizard');
    // EK advances arcane casting at L2-L10 of the PrC (L1 is non-
    // advancing). Wizard 5 (CL 5) + EK 7 (6 advancing levels) = CL 11.
    // CURRENTLY FAILS — Eldritch Knight has no advancement metadata
    // in the DB (`_class_metadata.py` missing entry) and isn't in
    // HARDCODED_ADVANCERS either, so the sheet silently leaves CL
    // stuck at the Wizard portion. Fix lands in the sibling DB
    // project; this scenario stays red until then.
    expectValue('#caster-0 .sc-caster-level', '11',
      'CL 11 (Wizard 5 + EK 7 advancing levels 2-7 = 6 advances)');
    // L5 spells unlocked at Wizard 9 / CL 11.
    expectText('#caster-0 .sc-remain[data-lvl="5"]', '2', 'L5 base 1 + INT bonus 1');
  });

  scenario("Sha'ir 3 / Durthan 2 / Sand Shaper 1 / Durthan 3 — interleaved PrCs", async () => {
    await newCharacter();
    setAbilities({ STR: 8, DEX: 14, CON: 12, INT: 14, WIS: 12, CHA: 16 });
    await applyClass("Sha'ir", 3);
    await applyClass('Durthan', 2);
    await applyClass('Sand Shaper', 1);
    await applyClass('Durthan', 3);  // re-apply: bumps Durthan 2 → 3

    expect(classChips().length, 3, 'three chips (Durthan bumped not duplicated)');
    expectValue('#char-level', '7', 'char level 3+3+1');
    // CL = Sha'ir 3 + Durthan 3 + Sand Shaper L1 non-advancing 0 = 6
    expectValue('#caster-0 .sc-caster-level', '6', 'CL 6');
    // Single Sha'ir caster panel (no duplicates)
    expect($$('#spells-tab-bar .inner-tab').length, 1, 'single caster tab');
    // 9 Sha'ir domains preserved
    expect($$('#caster-0 .sc-domain-name').length, 9, '9 Sha\'ir domains');
    // M9: freebies capped at castable level. CL 6 → max L3 castable.
    // Catalog has 7+7+10+4+6+4+2+2+1 = 43 across L1-L9.
    // Filtered to L1-L3: 7+7+10 = 24.
    const freebies = $$('#spells-content .sc-known-row[data-freebie="1"]');
    const freebieByLvl = {};
    for (const r of freebies) {
      const lvl = r.closest('.sc-known-list')?.dataset.lvl;
      freebieByLvl[lvl] = (freebieByLvl[lvl] || 0) + 1;
    }
    expect(freebies.length, 24, 'M9: 24 freebies (L1-L3 only)');
    expect(!!freebieByLvl['4'], false, 'M9: no L4+ freebies');
  });

  // ---- ToB PrC scenarios -------------------------------------------------
  // These three exercise PrCs that advance martial maneuvers + IL +
  // maneuvers-known. The sheet currently handles spell-progression
  // advancement (via Source A canonical-marker regex on
  // class_table.special) but does NOT yet handle the parallel
  // maneuver-progression advancement. So these scenarios are
  // partially red — casting advances correctly, IL/maneuvers don't.
  // They stay red until a ToB advancement path lands in class-picker,
  // mirroring the existing casting-advancement machinery.

  scenario('Cleric 5 / Crusader 5 / Ruby Knight Vindicator 2 — divine + maneuver advancer', async () => {
    await newCharacter();
    setAbilities({ STR: 14, DEX: 10, CON: 14, INT: 10, WIS: 16, CHA: 14 });
    await applyClass('Cleric', 5);
    await applyClass('Crusader', 5);
    await applyClass('Ruby Knight Vindicator', 2);

    expect(classChips().length, 3, 'three chips');
    expectValue('#char-level', '12', 'char level 12');
    // BAB: Cleric 5 (avg) = 3, Crusader 5 (good) = 5, RKV 2 (good) = 2 → 10
    expectValue('#bab-1', '10', 'BAB sum');
    // RKV advances casting at L2/3/4/5/7/8/9/10. At RKV 2, +1 → CL 6.
    expectValue('[data-caster-type="spellcasting"] .sc-caster-level',
      '6', 'cleric CL 6 (Cleric 5 + RKV L2 advance)');
    // RKV also advances martial maneuver progression at the same
    // levels. CURRENTLY FAILS — ToB maneuver advancement isn't wired
    // into class-picker. Expected: IL 6 (Crusader 5 + RKV L2 advance).
    expectValue('[data-caster-type="maneuvers"] .tom-init-level',
      '6', 'IL 6 — KNOWN BUG: ToB PrC maneuver advancement not wired');
  });

  scenario('Wizard 5 / Warblade 5 / Jade Phoenix Mage 2 — arcane + maneuver advancer', async () => {
    await newCharacter();
    setAbilities({ STR: 14, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 10 });
    await applyClass('Wizard', 5);
    await applyClass('Warblade', 5);
    await applyClass('Jade Phoenix Mage', 2);

    expect(classChips().length, 3, 'three chips');
    expectValue('#char-level', '12', 'char level 12');
    // BAB: Wiz 5 (poor) = 2, Warblade 5 (good) = 5, JPM 2 (good) = 2 → 9
    expectValue('#bab-1', '9', 'BAB sum');
    // JPM advances casting at L2/3/4/5/7/8/9/10. At JPM 2, +1 → Wizard CL 6.
    expectValue('[data-caster-type="spellcasting"] .sc-caster-level',
      '6', 'wizard CL 6 (Wiz 5 + JPM L2 advance)');
    // Same ToB-advancement bug as RKV.
    expectValue('[data-caster-type="maneuvers"] .tom-init-level',
      '6', 'IL 6 — KNOWN BUG: ToB PrC maneuver advancement not wired');
  });

  scenario('Crusader 5 / Swordsage 5 / Master of Nine 2 — multi-discipline advancer', async () => {
    await newCharacter();
    setAbilities({ STR: 14, DEX: 14, CON: 14, INT: 10, WIS: 14, CHA: 10 });
    await applyClass('Crusader', 5);
    await applyClass('Swordsage', 5);
    await applyClass('Master of Nine', 2);

    expect(classChips().length, 3, 'three chips');
    expectValue('#char-level', '12', 'char level 12');
    // MoN advances IL of all initiator classes at every level.
    // Expected: at MoN 2, both Crusader and Swordsage IL should
    // increase by 2. CURRENTLY FAILS — ToB advancement not wired.
    // We assert on the primary panel's IL; multi-IL handling for
    // dual martial-adept multiclass is a separate fix.
    expectValue('[data-caster-type="maneuvers"] .tom-init-level',
      '7', 'IL 7 — KNOWN BUG: ToB PrC maneuver advancement not wired');
  });

  scenario('Cleric 5 / Contemplative 5 / Heirophant 2 — chained PrCs', async () => {
    await newCharacter();
    setAbilities({ STR: 10, DEX: 10, CON: 14, INT: 12, WIS: 18, CHA: 14 });
    await applyClass('Cleric', 5);
    await applyClass('Contemplative', 5);
    await applyClass('Hierophant', 2);

    expect(classChips().length, 3, 'three chips');
    expectValue('#char-level', '12', 'char level 12');
    // Both Contemplative + Hierophant advance Cleric → CL 12
    expectValue('#caster-0 .sc-caster-level', '12', 'CL 12 from chained PrCs');
    // L6 unlocked
    expectText('#caster-0 .sc-remain[data-lvl="6"]', '3', 'L6: base 1 + WIS bonus 1 + domain 1');
  });

  // ---- Regression mini-suite -------------------------------------------
  // One assertion each for H1-H6 + M1-M9. Fast guards against the
  // 2026-05-16 play-feel pass fixes regressing. PLAYFEEL-NOTES.md has
  // full descriptions; the assertion below is the single observable
  // signal for each.

  regression('H1: btn-new clears CharacterHistory', async () => {
    await newCharacter();
    await applyClass('Cleric', 3);
    expectGE(CharacterHistory.get().length, 3, 'history populated');
    await newCharacter();
    // L3 (2026-05-17): get() now normalizes empty → [] so callers
    // don't need defensive `|| []`. Use hasLoaded() to distinguish
    // "never loaded / cleared" from "loaded but empty".
    expect(CharacterHistory.hasLoaded(), false, 'history cleared after New');
    expect(CharacterHistory.get().length, 0, 'cleared history reads as []');
  });

  regression('H2: applying class auto-reconstructs history', async () => {
    await newCharacter();
    expect(CharacterHistory.hasLoaded(), false, 'no history initially');
    expect(CharacterHistory.get().length, 0, 'get() returns [] initially');
    await applyClass('Wizard', 5);
    expect(CharacterHistory.get().length, 5, 'history reconstructed to 5 rows');
    expect(CharacterHistory.get()[0]?.class_taken, 'Wizard', 'first row is Wizard');
  });

  regression('H3: item-picker exposes + Equip Armor for Chainmail', async () => {
    await newCharacter();
    document.querySelector('.tab[data-tab="tab-equipment"]').click();
    await wait(150);
    await pickItem('Chainmail');
    expectVisible('#item-equip-armor', '+ Equip Armor button visible');
    expectHidden('#item-equip-shield', '+ Equip Shield hidden');
    expectHidden('#item-add-weapon', '+ Add as Weapon hidden');
  });

  regression('H3: item-picker exposes + Add as Weapon for Longsword', async () => {
    await newCharacter();
    document.querySelector('.tab[data-tab="tab-equipment"]').click();
    await wait(150);
    await pickItem('Longsword');
    expectVisible('#item-add-weapon', '+ Add as Weapon visible');
    expectHidden('#item-equip-armor', '+ Equip Armor hidden');
  });

  regression('H4+H5: applying Wizard 5 surfaces familiar progression', async () => {
    await newCharacter();
    await applyClass('Wizard', 5);
    document.querySelector('.tab[data-tab="tab-companion"]').click();
    await wait(200);
    const wrap = expectExists('#companion-0 .comp-progression-panel');
    expect(wrap.style.display !== 'none', true, 'H4: progression panel visible');
    expectIncludes(wrap.querySelector('.comp-progression-body').innerHTML, 'Familiar',
      'H4: panel mentions Familiar');
    // Save-stability fix (2026-05-17): comp-type stores the key
    // ("familiar"), not the display text. See companion.js
    // normalizeCompType for old-save migration.
    expectValue('#companion-0 .comp-type', 'familiar', 'H5: comp-type auto-defaulted to Familiar');
  });

  regression('H6: Wizard 5 INT 18 has no L4 phantom slot', async () => {
    await newCharacter();
    setAbilities({ INT: 18 });
    await applyClass('Wizard', 5);
    expectText('#caster-0 .sc-remain[data-lvl="4"]', '--',
      'H6: L4 must be "--" (base 0, bonus suppressed)');
    expectText('#caster-0 .sc-remain[data-lvl="3"]', '2', 'L3 base 1 + INT bonus 1');
  });

  regression("H6: Sha'ir 3 CHA 16 has no L3 phantom slot", async () => {
    await newCharacter();
    setAbilities({ CHA: 16 });
    await applyClass("Sha'ir", 3);
    expectText('#caster-0 .sc-remain[data-lvl="3"]', '--',
      'H6: L3 must be "--" (Sha\'ir CL 3 base [5,3,1,-...])');
  });

  regression('M1: Sorcerer hides Prepared, shows Known', async () => {
    await newCharacter();
    await applyClass('Sorcerer', 5);
    const panel = expectExists('#caster-0');
    expect(panel.querySelector('.sc-show-prepared').checked, false, 'Prepared off');
    expect(panel.querySelector('.sc-show-known').checked, true, 'Known on');
  });

  regression('M2: Warblade 5 ToB counts auto-populated', async () => {
    await newCharacter();
    await applyClass('Warblade', 5);
    const panel = expectExists('[data-caster-type="maneuvers"]');
    expectValue('[data-caster-type="maneuvers"] .tom-init-level', '5', 'IL 5');
    expectValue('[data-caster-type="maneuvers"] .tom-known-count', '6', 'Known 6');
    expectValue('[data-caster-type="maneuvers"] .tom-readied-count', '4', 'Readied 4');
    expectValue('[data-caster-type="maneuvers"] .tom-stances-count', '2', 'Stances 2');
  });

  regression('M3: Cleric 5 CHA 14 turn-per-day = 5', async () => {
    await newCharacter();
    setAbilities({ CHA: 14 });
    await applyClass('Cleric', 5);
    expectValue('#turn-per-day', '5', 'M3: 3 + CHA mod 2 = 5');
  });

  regression('M4: maneuver-picker + Readied populates row', async () => {
    await newCharacter();
    await applyClass('Warblade', 5);
    document.querySelector('.tab[data-tab="tab-spells"]').click();
    await wait(200);
    const panel = expectExists('[data-caster-type="maneuvers"]');
    const mp = panel.querySelector('.maneuver-picker');
    const manIn = mp.querySelector('.mp-maneuver');
    manIn.value = 'Steel Wind';
    manIn.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(250);
    const before = panel.querySelectorAll('.tom-readied-row').length;
    Array.from(mp.querySelectorAll('button')).find(b => /\+ Readied/.test(b.textContent)).click();
    await wait(250);
    const rows = panel.querySelectorAll('.tom-readied-row');
    expect(rows.length, before + 1, 'one new row added');
    const last = rows[rows.length - 1];
    expectValue('[data-caster-type="maneuvers"] .tom-readied-row:last-child .tom-readied-name',
                'Steel Wind', 'name populated');
  });

  regression('M5: Warblade discipline dropdown narrowed to 5', async () => {
    await newCharacter();
    await applyClass('Warblade', 5);
    document.querySelector('.tab[data-tab="tab-spells"]').click();
    await wait(200);
    const opts = $$('[data-caster-type="maneuvers"] .mp-discipline option');
    // 5 disciplines + 1 empty "(any)" option
    expect(opts.length, 6, '5 Warblade disciplines + 1 empty');
    expectIncludes(opts.map(o => o.value).join('|'), 'Iron Heart', 'Iron Heart in list');
  });

  regression('M6: Wizard 5 hides L4-L9 spell tabs', async () => {
    await newCharacter();
    setAbilities({ INT: 14 });
    await applyClass('Wizard', 5);
    document.querySelector('.tab[data-tab="tab-spells"]').click();
    await wait(200);
    const l3tab = expectExists('#caster-0 .spell-level-tab[data-level="3"]');
    expect(l3tab.style.display === 'none', false, 'L3 tab visible');
    const l4tab = expectExists('#caster-0 .spell-level-tab[data-level="4"]');
    expect(l4tab.style.display, 'none', 'L4 tab hidden');
    const l9tab = expectExists('#caster-0 .spell-level-tab[data-level="9"]');
    expect(l9tab.style.display, 'none', 'L9 tab hidden');
  });

  regression('M7: Fresh-applied class triggers HP/feats/skills audit info', async () => {
    await newCharacter();
    await applyClass('Fighter', 5);
    const issues = Audit.collect();
    const ids = issues.map(i => i.id);
    expectIncludes(ids.join('|'), 'm7:hp-not-set', 'HP-not-set fired');
    expectIncludes(ids.join('|'), 'm7:no-feats', 'no-feats fired');
    expectIncludes(ids.join('|'), 'm7:no-skill-ranks', 'no-skill-ranks fired');
  });

  regression('M8: feat-picker prereq dedup for single-atom feats', async () => {
    await newCharacter();
    setAbilities({ STR: 16 });
    await applyClass('Fighter', 5);
    document.querySelector('.tab[data-tab="tab-feats"]').click();
    await wait(150);
    set('feat-lookup', 'Power Attack');
    await wait(400);
    const info = expectExists('#feat-info');
    // Single-atom: count "Str 13" occurrences in info — should be exactly 1
    const matches = (info.textContent.match(/Str\s*13/g) || []).length;
    expect(matches, 1, 'M8: only one "Str 13" in info panel');
  });

  regression("M9: Sand Shaper L1 freebies cap at Sha'ir CL 3 max castable", async () => {
    await newCharacter();
    setAbilities({ CHA: 14 });
    await applyClass("Sha'ir", 3);
    await applyClass('Sand Shaper', 1);
    // CL 3, max castable L2. Catalog L1-L2: 7+7 = 14 freebies.
    const freebies = $$('#spells-content .sc-known-row[data-freebie="1"]');
    expect(freebies.length, 14, 'M9: 14 freebies (L1-L2 only)');
  });

  regression("M9b: Desert Insight unlocks new freebies when target caster levels up", async () => {
    // The bug: applyClassSpellAdditions only fired when the granting
    // class (Sand Shaper) itself was (re-)applied. So if you applied
    // Sand Shaper while your wizard was still too low to cast L3, then
    // later leveled the wizard up to unlock L3 — the L3 desert spells
    // (Control Sand / Haboob / Slipsand etc.) never appeared. Fix:
    // refreshAllSpellTabs re-fires applyClassSpellAdditions for every
    // CATALOG-listed class at the end of its pass, so a level-up of
    // any class triggers the freebie expansion.
    await newCharacter();
    setAbilities({ CHA: 14, INT: 14 });
    // Wizard 4 + Sand Shaper 1 → CL 5 → max castable L3 (since wiz
    // L5 spells unlock at CL 9). Sand Shaper L1 doesn't advance.
    // Wiz 4 casts up to L2. So freebies should be L1+L2 only at this
    // point: 7 + 7 = 14.
    await applyClass('Wizard', 4);
    await applyClass('Sand Shaper', 1);
    let freebies = $$('#spells-content .sc-known-row[data-freebie="1"]');
    expect(freebies.length, 14, 'M9b: 14 freebies before wizard levels up');
    // Level the wizard up to 5 → casts L3 spells now. The L3 Desert
    // Insight spells (Control Sand, Desiccate, Dispel Magic, Dominate
    // Animal, Haboob, Slipsand, Summon Desert Ally III, Sunstroke,
    // Tormenting Thirst, Wind Wall = 10 spells) should appear.
    await applyClass('Wizard', 5);
    freebies = $$('#spells-content .sc-known-row[data-freebie="1"]');
    expect(freebies.length, 24,
      'M9b: 24 freebies after wizard levels up to L3 access (was 14 pre-fix)');
    // Confirm the L3 row has the expected spell, not just a count.
    const l3Names = [
      ...$$('#spells-content .sc-known-list[data-lvl="3"] '
            + '.sc-known-row[data-freebie="1"] .sc-known-name')
    ].map(el => (el.value || '').trim().toLowerCase());
    if (!l3Names.includes('haboob')) {
      fail('M9b: expected Haboob in L3 freebies after wizard level-up; got ' +
           JSON.stringify(l3Names));
    }
  });

  // ---- Save-stability regressions (2026-05-17 sweep) -----------------
  //
  // Each fix in the save-stability sweep gets a regression here that
  // exercises the actual collectData → loadData round-trip path.
  // Static-source regression guards live in tests/test_pickers.js;
  // these are the runtime checks.

  regression('SS1: companion compType round-trips as a key (not display text)', async () => {
    await newCharacter();
    document.querySelector('[data-tab="tab-companion"]').click();
    await wait(200);
    const sel = $('#companion-0 .comp-type');
    if (!sel) fail('SS1: companion select not found');
    sel.value = 'familiar';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(100);
    const blob = Companion.collectData();
    expect(blob.companions[0].compType, 'familiar',
      'SS1: collectData emits the key, not display text');
    // Force the select back to default + reload to prove the round-trip.
    sel.value = 'animal';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(100);
    Companion.loadData(blob);
    await wait(200);
    expectValue('#companion-0 .comp-type', 'familiar',
      'SS1: loadData restores the saved Familiar (was reloading as Animal Companion pre-fix)');
  });

  regression('SS1: companion loadData migrates legacy display-text compType', async () => {
    await newCharacter();
    // Simulate an old save: compType is the option's display text.
    const legacyBlob = {
      companions: [{
        name: 'Test', compName: 'Bob', compType: 'Familiar', compType_legacy: true,
      }],
    };
    Companion.loadData(legacyBlob);
    await wait(200);
    expectValue('#companion-0 .comp-type', 'familiar',
      'SS1: old "Familiar" display-text compType migrates to "familiar" key on load');
  });

  regression('SS-CR: creature-race racial-HD row round-trips via _multiclass', async () => {
    // Creature-as-race (creature-race-picker.js): picking a creature with
    // racial Hit Dice injects a SYNTHETIC class row into the multiclass
    // aggregate. That row has no DB class, so its prog can't be rehydrated
    // on load — class-picker persists prog + creatureRace directly in
    // _multiclass and reconstructs the row from the stub. This drives the
    // real collectData → loadData round-trip end to end.
    await newCharacter();
    document.querySelector('[data-tab="tab-character"]').click();
    await wait(150);
    set('char-creature-race', 'Bugbear');   // 3 Humanoid racial HD
    await wait(400);
    // Adjustment layer landed on the Race column + size.
    expectValue('#str-race', '4', 'SS-CR: Bugbear +4 Str in the race column');
    expectValue('#char-size', 'Medium', 'SS-CR: Bugbear size Medium');
    // Synthetic racial-HD row reached the aggregate.
    let st = ClassPicker.getState().filter(e => e.racialHD);
    expect(st.length, 1, 'SS-CR: exactly one synthetic racial-HD row');
    expect(st[0].level, 3, 'SS-CR: 3 racial HD');
    expect(st[0].prog.bab, 'average', 'SS-CR: Humanoid → average (3/4) BAB');
    expect(st[0].prog.ref, 'good', 'SS-CR: Humanoid → good Ref save');
    // BAB pooled through the aggregate: floor(3 × 3/4) = +2.
    expectValue('#bab-1', '2', 'SS-CR: racial HD contributes BAB +2');
    // Round-trip through Character.collectData / loadData (class-picker
    // monkey-patches both to carry _multiclass).
    const blob = Character.collectData();
    const rrow = (blob._multiclass || []).find(s => s.racialHD);
    if (!rrow) fail('SS-CR: collectData dropped the synthetic racial-HD row');
    expect(rrow.creatureRace, 'Bugbear', 'SS-CR: creatureRace persisted');
    expect(rrow.prog.bab, 'average',
      'SS-CR: prog persisted directly (synthetic row cannot rehydrate from DB)');
    // Wipe, then reload.
    await newCharacter();
    expect(ClassPicker.getState().filter(e => e.racialHD).length, 0,
      'SS-CR: new character clears the synthetic row');
    Character.loadData(blob);
    await wait(300);
    st = ClassPicker.getState().filter(e => e.racialHD);
    expect(st.length, 1, 'SS-CR: loadData restores the synthetic row');
    expect(st[0].prog.ref, 'good', 'SS-CR: restored prog labels intact');
    expectValue('#bab-1', '2', 'SS-CR: restored BAB +2 after reload');
  });

  regression('RESET: New Character clears every module\'s state', async () => {
    // Systematic reset-hygiene guard (added after the 2026-05-29 finding
    // that ClassFeatures customizations survived "New Character" — a whole
    // CLASS of bug where a module's DOM list / JS store isn't wired into
    // the reset path). Seed state across modules, click New, assert a clean
    // slate everywhere. A new state-bearing module that forgets to wire
    // into the reset path fails here loudly instead of silently bleeding
    // the previous character's data into the next sheet.
    await newCharacter();
    document.querySelector('[data-tab="tab-character"]').click();
    await wait(150);

    // --- seed state across several modules ---
    setAbilities({ STR: 16, INT: 14 });
    await applyClass('Wizard', 3);                        // pickedClasses
    ClassFeatures.addCustomization({                      // customizations Map+DOM
      kind: 'ACF', name: 'Spelltouched', class: 'Wizard', level: 1,
      replaces: 'Scribe Scroll', source: 'Unearthed Arcana',
    });
    await wait(50);
    set('char-creature-race', 'Bugbear');                // racial-HD row + race-col adj + tagged specials
    await wait(350);

    // Sanity: the seeding actually took (else the post-reset asserts are vacuous).
    if (ClassPicker.getState().length < 2)
      fail('RESET: precondition — expected classes + racial-HD row seeded');
    expect(ClassFeatures.getCustomizations().length, 1,
      'RESET: precondition — a customization was seeded');

    // --- New Character, then assert nothing bled through ---
    await newCharacter();
    const v = id => (document.getElementById(id) || {}).value;
    const nonzero = s => s && s !== '0' && String(s).trim() !== '';
    const leaks = [];
    if (ClassPicker.getState().length)
      leaks.push(`ClassPicker retains ${ClassPicker.getState().length} class/racial-HD row(s)`);
    if (ClassFeatures.getCustomizations().length)
      leaks.push(`ClassFeatures retains ${ClassFeatures.getCustomizations().length} customization(s)`);
    if (nonzero(v('char-creature-race')))
      leaks.push(`#char-creature-race not cleared: "${v('char-creature-race')}"`);
    if (nonzero(v('str-race')))
      leaks.push(`#str-race (race-column adj) not cleared: "${v('str-race')}"`);
    if (v('char-class') && v('char-class').trim())
      leaks.push(`#char-class not cleared: "${v('char-class')}"`);
    if (nonzero(v('bab-1')))
      leaks.push(`#bab-1 not reset: "${v('bab-1')}"`);
    const autoSpecials = document.querySelectorAll(
      '#special-abilities-container [data-from-race="1"], ' +
      '#special-abilities-container [data-from-creature-race="1"], ' +
      '#special-abilities-container [data-from-class]');
    if (autoSpecials.length)
      leaks.push(`${autoSpecials.length} auto-added special-ability row(s) survive`);
    if (leaks.length)
      fail('RESET: New Character left state behind (a module is not wired ' +
           'into the reset path):\n  - ' + leaks.join('\n  - '));
  });

  regression('SS4: class customizations round-trip + legacy textarea migration', async () => {
    // The Class Customizations list is structured (added 2026-05-17,
    // refactored same day from a free-form textarea). Two contracts:
    //   (a) Structured round-trip: add → collectData → loadData →
    //       same rows + notes survive.
    //   (b) Legacy migration: a save with `class-customizations: <str>`
    //       (pre-refactor) gets parsed into rows on load.
    await newCharacter();
    // (a) Structured round-trip via addCustomization.
    ClassFeatures.addCustomization({
      kind: 'ACF', name: 'Spelltouched', class: 'Wizard', level: 1,
      replaces: 'Scribe Scroll', source: 'Unearthed Arcana',
    });
    await wait(50);
    let collected = ClassFeatures.collectData();
    expect(Array.isArray(collected.customizations), true,
      'SS4: collectData emits customizations as an array');
    expect(collected.customizations.length, 1,
      'SS4: one customization captured');
    expect(collected.customizations[0].name, 'Spelltouched',
      'SS4: customization name preserved');
    expect(collected.customizations[0].replaces, 'Scribe Scroll',
      'SS4: customization replaces field preserved');

    // Edit the notes on the row, re-collect, confirm notes round-trip.
    const noteTa = $('#class-customizations-list .cf-cust-notes');
    if (!noteTa) fail('SS4: notes textarea missing on row');
    noteTa.value = 'gained Spelltouched feat';
    noteTa.dispatchEvent(new Event('input', { bubbles: true }));
    collected = ClassFeatures.collectData();
    expect(collected.customizations[0].notes, 'gained Spelltouched feat',
      'SS4: notes textarea round-tripped through collectData');

    // Wipe + reload from the collected blob.
    ClassFeatures.loadData({ customizations: [] });
    await wait(50);
    expect($$('#class-customizations-list .cf-customization').length, 0,
      'SS4: wipe cleared the list');
    ClassFeatures.loadData(collected);
    await wait(50);
    expect($$('#class-customizations-list .cf-customization').length, 1,
      'SS4: loadData rebuilt the row');
    expect($('#class-customizations-list .cf-cust-name')?.textContent, 'Spelltouched',
      'SS4: rebuilt row shows the right name');

    // (b) Legacy textarea migration.
    ClassFeatures.loadData({
      'class-customizations':
        '[ACF] Spelltouched (Wizard L1)\n[Sub Level] Drow Wizard Substitution Level 5 (Wizard L5)',
    });
    await wait(50);
    const migrated = $$('#class-customizations-list .cf-customization');
    expect(migrated.length, 2, 'SS4: legacy 2-line textarea migrated to 2 rows');
    const names = [...migrated].map(r => r.querySelector('.cf-cust-name')?.textContent);
    if (!names.includes('Spelltouched')) {
      fail('SS4: legacy migration lost Spelltouched');
    }
  });

  regression('ACF2: chip tagging + auto-strip on class remove', async () => {
    // (a) Applied class chip carries a .mc-chip-tag per matching
    //     customization.
    // (b) Removing the class via the chip's × button strips the
    //     customizations from the Class Features list.
    await newCharacter();
    await applyClass('Wizard', 3);
    const chips = $$('.mc-class-chip');
    if (chips.length === 0) {
      fail('ACF2: Wizard did not apply (no chip) — possibly DB still loading.');
    }
    // Pre-apply tags should be absent.
    expect(chips[0].querySelectorAll('.mc-chip-tag').length, 0,
      'ACF2: chip has no tags before any customization');
    // Add a customization and watch the chip refresh live via the
    // class-customizations-changed event.
    ClassFeatures.addCustomization({
      kind: 'ACF', name: 'Spelltouched', class: 'Wizard', level: 1,
      replaces: 'Scribe Scroll', source: 'Unearthed Arcana',
    });
    await wait(100);
    const refreshedChip = $('.mc-class-chip[data-class="Wizard"]');
    if (!refreshedChip) fail('ACF2: Wizard chip vanished after customization add');
    const tags = refreshedChip.querySelectorAll('.mc-chip-tag');
    expect(tags.length, 1, 'ACF2: chip shows one customization tag');
    expectIncludes(tags[0].textContent, 'Spelltouched',
      'ACF2: tag text mentions the customization name');
    // Remove the class via the × button. Customization should be auto-
    // stripped from the list.
    expect(ClassFeatures.getCustomizations().length, 1, 'ACF2: 1 cust before remove');
    refreshedChip.querySelector('button').click();
    await wait(200);
    expect(ClassFeatures.getCustomizations().length, 0,
      'ACF2: customization auto-stripped when class removed');
    expect($('.mc-class-chip[data-class="Wizard"]'), null,
      'ACF2: chip gone after remove');
  });

  regression('ACF1: customization strikes through replaced features in info panel', async () => {
    // The whole point of "customizations do something" — Spelltouched
    // (ACF that replaces Wizard\'s Scribe Scroll) should appear as
    // <s>Scribe Scroll</s> in the Class Lookup info panel for Wizard.
    await newCharacter();
    // Pre-load a Wizard Spelltouched customization (skip the variants-
    // section click flow so this test doesn't depend on Wizard being
    // typed first).
    ClassFeatures.addCustomization({
      kind: 'ACF', name: 'Spelltouched', class: 'Wizard', level: 1,
      replaces: 'Scribe Scroll', source: 'Unearthed Arcana',
    });
    await wait(50);
    // Trigger the info panel by typing Wizard + level 1.
    set('class-lookup', 'Wizard');
    set('class-lookup-level', '1');
    await wait(400);
    const panel = $('#class-info');
    if (!panel || panel.style.display === 'none') {
      fail('ACF1: class-info panel did not render (DB still loading?)');
    }
    const hasStrike = panel.querySelector('.cf-replaced > s');
    if (!hasStrike) {
      fail('ACF1: no struck-through feature in panel HTML:\n' +
        panel.innerHTML.slice(0, 400));
    }
    expectIncludes(hasStrike.textContent, 'Scribe Scroll',
      'ACF1: struck feature is Scribe Scroll');
  });

  regression('SS3: invocations panel round-trips per-grade Known + scalars', async () => {
    await newCharacter();
    // Add an invocations panel via the Spells tab button.
    document.querySelector('[data-tab="tab-spells"]').click();
    await wait(150);
    const addBtn = $('#btn-add-invocations');
    if (!addBtn) fail('SS3: + Invocations button missing');
    addBtn.click();
    await wait(300);
    const panel = $('[data-caster-type="invocations"]');
    if (!panel) fail('SS3: invocations panel did not spawn');
    // Fill some fields + a Known entry under Lesser.
    panel.querySelector('.invo-level').value = '6';
    panel.querySelector('.invo-caster-level').value = '6';
    panel.querySelector('.invo-highest-grade').value = 'Lesser';
    panel.querySelector('.invo-known-count').value = '4';
    panel.querySelector('.invo-text[data-grade="lesser"]').value =
      'Eldritch Spear\nWalk Unseen';
    // Force a dispatch so any input listeners catch it.
    panel.querySelectorAll('input, textarea').forEach(el => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Round-trip via Spells.collect/load.
    const blob = Spells.collectData();
    const invo = blob.casters.find(c => c.type === 'invocations');
    if (!invo) fail('SS3: collectData did not include invocations caster');
    expect(invo.invokerLevel, '6', 'SS3: invokerLevel round-tripped');
    expect(invo.highestGrade, 'Lesser', 'SS3: highestGrade round-tripped');
    expect(invo['invo-lesser'], 'Eldritch Spear\nWalk Unseen',
      'SS3: per-grade Known textarea round-tripped');
    // Wipe + reload.
    Spells.loadData({ casters: [] });
    await wait(200);
    if ($('[data-caster-type="invocations"]')) fail('SS3: panel should be gone after reload-empty');
    Spells.loadData(blob);
    await wait(300);
    const restored = $('[data-caster-type="invocations"]');
    if (!restored) fail('SS3: panel not rebuilt on loadData');
    expect(restored.querySelector('.invo-level').value, '6',
      'SS3: invokerLevel restored to panel');
    expect(restored.querySelector('.invo-text[data-grade="lesser"]').value,
      'Eldritch Spear\nWalk Unseen',
      'SS3: Lesser textarea restored');
  });

  regression('SS2: data-from-class markers survive a save/load round-trip', async () => {
    await newCharacter();
    setAbilities({ CHA: 14 });
    await applyClass('Cleric', 3);
    // Sanity check: Cleric actually applied. Without this the next
    // assertion's "marker missing" failure misleads the user into
    // thinking the marker code is broken when really the apply
    // didn't take (e.g. DB never loaded in the preview harness).
    const chips = $$('.mc-class-chip');
    if (chips.length === 0) fail(
      'SS2: Cleric did not apply (no mc-class-chip) — possibly DB ' +
      'still loading. Re-run after [DB] Loaded appears in console.');
    const tpd = document.getElementById('turn-per-day');
    if (!tpd) fail('SS2: turn-per-day field not found');
    expect(tpd.dataset.fromClass, 'Cleric',
      'SS2: marker stamped by Cleric apply');
    // Round-trip via Character.collect/load (which class-picker wraps
    // to emit/consume _fromClassMarkers).
    const blob = Character.collectData();
    expect(blob._fromClassMarkers && blob._fromClassMarkers['turn-per-day'], 'Cleric',
      'SS2: collectData emits _fromClassMarkers["turn-per-day"]="Cleric"');
    // Clear the marker manually to simulate the post-load state where
    // origLoad has restored the VALUE but not yet the marker.
    delete tpd.dataset.fromClass;
    Character.loadData(blob);
    await wait(100);
    expect(tpd.dataset.fromClass, 'Cleric',
      'SS2: loadData re-stamps the marker so a future class-remove can clean the field');
  });

  // ---- Per-class application sweep -------------------------------------
  //
  // Iterates every class + PrC in the DB and verifies the sheet can
  // apply it without throwing. Catches application-time bugs that the
  // Node-side metadata audit can't see (e.g. class-picker crashing on
  // a class whose data shape diverges from the canonical schema).
  //
  // ~500-700ms per class × 451 classes ≈ 4-6 minutes for the full
  // sweep. Opt-in via the "Sweep classes" button or
  // `PlayFeel.runClassSweep()`.
  //
  // Per-class assertions (deliberately minimal — depth lives in
  // scenario tests for curated classes):
  //   - apply() doesn't throw
  //   - exactly one chip is added
  //   - char-level reads back to the applied level
  //   - if the class has a `spellcasting` block, a caster panel
  //     spawns OR (for non-advancing-at-L1 PrCs) doesn't
  //
  // Sweep budget can be narrowed via the second arg:
  //   PlayFeel.runClassSweep({ types: ['class'], maxCount: 30 })

  async function runClassSweep(opts = {}) {
    await waitForDb();
    setStatus('Class sweep starting…');
    const typeFilter = opts.types || ['class', 'prc'];
    const maxCount = opts.maxCount || Infinity;
    const placeholders = typeFilter.map(() => '?').join(',');
    const rows = DB.query(
      `SELECT name, type, json_extract(data, '$.class_table') as ct
       FROM entry WHERE type IN (${placeholders})
       ORDER BY type, name COLLATE NOCASE`,
      typeFilter,
    );
    const trimmed = rows.slice(0, maxCount);
    const results = [];

    // Build a sweep-results panel section.
    let sweepContainer = document.getElementById('playfeel-sweep-results');
    if (!sweepContainer) {
      const panel = document.getElementById('playfeel-panel');
      const header = document.createElement('div');
      header.className = 'pf-section-title';
      header.textContent = `Class sweep (${trimmed.length} entries)`;
      panel.appendChild(header);
      sweepContainer = document.createElement('div');
      sweepContainer.className = 'pf-list pf-sweep-list';
      sweepContainer.id = 'playfeel-sweep-results';
      panel.appendChild(sweepContainer);
    }
    sweepContainer.innerHTML = '';

    let passed = 0, failed = 0;
    const failedRows = [];
    const t0 = performance.now();

    for (let i = 0; i < trimmed.length; i++) {
      const entry = trimmed[i];
      // Pick the lowest level present in class_table (PrCs may start
      // at L1 of the PrC's own table, not character L1).
      let applyLevel = 1;
      try {
        const ct = entry.ct ? JSON.parse(entry.ct) : [];
        const levels = ct.map(r => Number(r.level)).filter(n => !isNaN(n));
        if (levels.length) applyLevel = Math.min(...levels);
      } catch (e) { /* default to 1 */ }

      setStatus(`Sweep ${i + 1}/${trimmed.length}: ${entry.name}`);
      let outcome;
      try {
        outcome = await sweepOneClass(entry.name, applyLevel);
      } catch (err) {
        outcome = { ok: false, error: err.message || String(err) };
      }
      const result = { name: entry.name, type: entry.type, ...outcome };
      results.push(result);
      if (result.ok) passed++;
      else { failed++; failedRows.push(result); }

      // Render row
      const row = document.createElement('div');
      row.className = `pf-row pf-${result.ok ? 'pass' : 'fail'}`;
      row.innerHTML = `
        <span class="pf-name"></span>
        <span class="pf-result"></span>
      `;
      row.querySelector('.pf-name').textContent = `${entry.name} [${entry.type}]`;
      if (result.ok) {
        row.querySelector('.pf-result').textContent = '✓';
      } else {
        const r = row.querySelector('.pf-result');
        r.innerHTML = `<span class="pf-err" title="${escapeAttr(result.error)}">✗ ${escapeHtml((result.error || '').slice(0, 60))}</span>`;
      }
      // Only keep failed rows in the visible list to limit DOM growth.
      if (!result.ok) sweepContainer.appendChild(row);

      // Yield to the event loop occasionally to keep the UI responsive.
      if (i % 10 === 0) await wait(0);
    }

    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus(`Sweep done: ${passed} passed / ${failed} failed in ${elapsed}s`);
    if (failed === 0) {
      const ok = document.createElement('div');
      ok.className = 'pf-row pf-pass';
      ok.style.padding = '0.4rem 0.6rem';
      ok.textContent = `✓ All ${trimmed.length} classes applied cleanly.`;
      sweepContainer.appendChild(ok);
    }
    return { passed, failed, failedRows, elapsed };
  }

  async function sweepOneClass(name, level) {
    // Suppress alerts/confirms for the duration of this sweep step.
    const origAlert = window.alert;
    const origConfirm = window.confirm;
    window.alert = () => {};
    window.confirm = () => true;
    try {
      await newCharacter();
      const chipsBefore = classChips().length;
      // Catch synchronous and async throws.
      try {
        await applyClass(name, level);
      } catch (err) {
        return { ok: false, error: `apply threw: ${err.message || err}` };
      }
      const chipsAfter = classChips().length;
      if (chipsAfter !== chipsBefore + 1) {
        return { ok: false, error: `expected +1 chip, got ${chipsAfter - chipsBefore} (${chipsAfter} total)` };
      }
      const chip = classChips()[classChips().length - 1] || '';
      if (!chip.toLowerCase().includes(name.toLowerCase())) {
        return { ok: false, error: `chip text "${chip}" doesn't contain "${name}"` };
      }
      const charLevel = parseInt(document.getElementById('char-level')?.value || '0', 10);
      if (charLevel !== level) {
        return { ok: false, error: `char-level = ${charLevel}, expected ${level}` };
      }
      return { ok: true };
    } finally {
      window.alert = origAlert;
      window.confirm = origConfirm;
    }
  }

  // ---- Runner -----------------------------------------------------------

  async function runOne(spec) {
    const startedAt = performance.now();
    try {
      await spec.fn();
      return {
        name: spec.name, kind: spec.kind,
        status: 'pass', durationMs: performance.now() - startedAt,
      };
    } catch (err) {
      return {
        name: spec.name, kind: spec.kind,
        status: 'fail', error: err.message || String(err),
        durationMs: performance.now() - startedAt,
      };
    }
  }

  async function runAll() {
    await waitForDb();
    setStatus('Running…');
    const results = [];
    // Regressions first — fast and high-signal.
    for (const r of regressions) {
      renderRunning(r);
      results.push(await runOne(r));
      renderResult(results[results.length - 1]);
    }
    for (const s of scenarios) {
      renderRunning(s);
      results.push(await runOne(s));
      renderResult(results[results.length - 1]);
    }
    lastResults = results;
    const passed = results.filter(r => r.status === 'pass').length;
    const failed = results.length - passed;
    setStatus(`${passed} passed / ${failed} failed (${results.length} total)`);
    return results;
  }

  async function runSpec(spec) {
    await waitForDb();
    setStatus(`Running ${spec.name}…`);
    renderRunning(spec);
    const r = await runOne(spec);
    renderResult(r);
    setStatus(r.status === 'pass' ? `✓ ${spec.name}` : `✗ ${spec.name}: ${r.error}`);
    return r;
  }

  // ---- UI ---------------------------------------------------------------

  function setStatus(msg) {
    const el = document.getElementById('playfeel-status');
    if (el) el.textContent = msg;
  }

  function specRowId(spec) {
    return `playfeel-row-${spec.kind}-${slug(spec.name)}`;
  }
  function slug(s) { return String(s).replace(/[^a-z0-9]+/gi, '-').toLowerCase(); }

  function renderRunning(spec) {
    const row = document.getElementById(specRowId(spec));
    if (!row) return;
    row.className = 'pf-row pf-running';
    row.querySelector('.pf-result').textContent = '…';
  }

  function renderResult(r) {
    const row = document.getElementById(specRowId(r));
    if (!row) return;
    row.className = `pf-row pf-${r.status}`;
    const resultCell = row.querySelector('.pf-result');
    if (r.status === 'pass') {
      resultCell.textContent = `✓ ${Math.round(r.durationMs)}ms`;
    } else {
      resultCell.innerHTML = `<span class="pf-err" title="${escapeAttr(r.error)}">✗ ${escapeHtml(r.error.slice(0, 80))}</span>`;
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  function buildUI() {
    const panel = document.createElement('div');
    panel.id = 'playfeel-panel';
    panel.innerHTML = `
      <div class="pf-header">
        <span class="pf-title">Play-feel test suite</span>
        <button id="playfeel-run-all" class="pf-btn">Run All</button>
        <button id="playfeel-sweep" class="pf-btn pf-btn-alt"
                title="Apply every class in the DB, verify no errors (~4-6 min)">Sweep Classes</button>
        <button id="playfeel-close" class="pf-close" title="Close panel">×</button>
      </div>
      <div id="playfeel-status" class="pf-status">Ready. Click Run All.</div>
      <div class="pf-section-title">Regressions (${regressions.length})</div>
      <div class="pf-list" id="playfeel-list-regressions"></div>
      <div class="pf-section-title">Scenarios (${scenarios.length})</div>
      <div class="pf-list" id="playfeel-list-scenarios"></div>
    `;
    document.body.appendChild(panel);

    const regList = panel.querySelector('#playfeel-list-regressions');
    for (const r of regressions) regList.appendChild(makeRow(r));
    const scnList = panel.querySelector('#playfeel-list-scenarios');
    for (const s of scenarios) scnList.appendChild(makeRow(s));

    panel.querySelector('#playfeel-run-all').addEventListener('click', () => runAll());
    panel.querySelector('#playfeel-sweep').addEventListener('click', () => {
      if (!confirm('Apply every class in the DB (~451 classes, ~4-6 min). Proceed?')) return;
      runClassSweep();
    });
    panel.querySelector('#playfeel-close').addEventListener('click', () => panel.remove());
  }

  function makeRow(spec) {
    const row = document.createElement('div');
    row.className = 'pf-row';
    row.id = specRowId(spec);
    row.innerHTML = `
      <button class="pf-run-one" title="Run this one">▶</button>
      <span class="pf-name"></span>
      <span class="pf-result"></span>
    `;
    row.querySelector('.pf-name').textContent = spec.name;
    row.querySelector('.pf-run-one').addEventListener('click', () => runSpec(spec));
    return row;
  }

  function injectStyles() {
    const css = `
      #playfeel-panel {
        position: fixed; top: 0.5rem; right: 0.5rem;
        width: 28rem; max-height: 90vh; overflow-y: auto;
        background: rgba(20, 25, 35, 0.97); color: #ddd;
        border: 1px solid #466; border-radius: 6px;
        font: 12px/1.4 system-ui, sans-serif;
        z-index: 99999; padding: 0; box-shadow: 0 4px 18px rgba(0,0,0,0.5);
      }
      #playfeel-panel .pf-header {
        display: flex; align-items: center; gap: 0.5rem;
        padding: 0.5rem 0.75rem;
        background: #2a3850; border-bottom: 1px solid #466;
        border-radius: 6px 6px 0 0;
      }
      #playfeel-panel .pf-title { font-weight: 700; flex: 1; }
      #playfeel-panel .pf-btn {
        background: #4a6; color: #fff; border: 0;
        padding: 0.25rem 0.6rem; border-radius: 3px;
        cursor: pointer; font: inherit; font-weight: 600;
      }
      #playfeel-panel .pf-btn-alt { background: #6a4a8a; }
      #playfeel-panel .pf-close {
        background: transparent; border: 0; color: #aaa;
        font-size: 1.2em; cursor: pointer; padding: 0 0.3rem;
      }
      #playfeel-panel .pf-status {
        padding: 0.4rem 0.75rem; background: #1a2030;
        border-bottom: 1px solid #333;
        font-style: italic; color: #9ad;
      }
      #playfeel-panel .pf-section-title {
        padding: 0.4rem 0.75rem 0.2rem;
        font-weight: 700; font-size: 0.85em; color: #8ab;
        text-transform: uppercase; letter-spacing: 0.05em;
      }
      #playfeel-panel .pf-list { padding: 0 0.25rem 0.5rem; }
      #playfeel-panel .pf-row {
        display: flex; align-items: center; gap: 0.4rem;
        padding: 0.2rem 0.5rem; border-radius: 3px;
        border-left: 3px solid #555;
      }
      #playfeel-panel .pf-row + .pf-row { margin-top: 2px; }
      #playfeel-panel .pf-row.pf-running { border-color: #ca6; background: rgba(200,166,80,0.08); }
      #playfeel-panel .pf-row.pf-pass    { border-color: #4a6; }
      #playfeel-panel .pf-row.pf-fail    { border-color: #d44; background: rgba(220,68,68,0.08); }
      #playfeel-panel .pf-name { flex: 1; font-size: 11px; }
      #playfeel-panel .pf-result { font-size: 11px; opacity: 0.85; }
      #playfeel-panel .pf-row.pf-pass .pf-result { color: #6c9; }
      #playfeel-panel .pf-row.pf-fail .pf-result { color: #f88; }
      #playfeel-panel .pf-err { font-family: monospace; }
      #playfeel-panel .pf-run-one {
        background: transparent; border: 1px solid #466;
        color: #9ad; cursor: pointer; padding: 0 0.25rem;
        border-radius: 2px; font-size: 10px; line-height: 1;
      }
      #playfeel-panel .pf-run-one:hover { background: #2a3850; color: #fff; }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---- Bootstrap --------------------------------------------------------

  // Expose for Node-side preview MCP orchestration. Also keeps the
  // results around for inspection after a run.
  window.PlayFeel = {
    runAll, runSpec, runClassSweep,
    scenarios, regressions,
    getResults: () => lastResults,
  };

  // Mount the UI once the DOM is built. Wait for the rest of the
  // sheet to wire up first (DB load happens async).
  function init() {
    injectStyles();
    buildUI();
    // Don't auto-run; let the user click Run All. (We could
    // auto-run when ?playfeel=run is passed, but explicit is nicer.)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
