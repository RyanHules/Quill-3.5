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

  // ---- Non-blocking dialogs (test mode) ------------------------------
  // Native confirm()/alert() dialogs HALT the page until dismissed,
  // which both blocks autonomous runs (the harness can't click "OK")
  // and freezes any in-flight preview eval into a timeout. While the
  // playfeel harness is loaded, auto-accept confirms and swallow alerts
  // so flows like "New Character" (app.js confirms "Start a new
  // character?"), class/sub-tab removal, etc. never stall a test.
  // Scoped to `?playfeel=1` only — normal sheet use keeps its prompts.
  window.confirm = () => true;
  window.alert = () => {};

  // ---- Tiny test framework -----------------------------------------------

  const scenarios = [];
  const regressions = [];
  let lastResults = null;

  // Concurrency guard. Every test drives ONE shared sheet (newCharacter /
  // applyClass mutate the same DOM + module state), so two runs in flight
  // interleave and corrupt each other — a concurrent newCharacter can wipe
  // a maneuvers panel another run JUST created, which surfaces as phantom
  // order-dependent failures like "M5 … expected 6, got 0" / "M8 … got 2"
  // even though each test passes single-threaded. Run All, the per-test ▶
  // buttons, and the class sweep all route through this flag and refuse to
  // start while a run is active. (Diagnosed 2026-05-29: the M5/M8 reds only
  // reproduced when a second run was launched mid-run.)
  let isRunning = false;

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
  // "New"; the harness-wide confirm suppressor (top of this file)
  // auto-accepts the "Start a new character?" prompt, so this never
  // blocks — even when driven from an autonomous preview eval.
  async function newCharacter() {
    $('#btn-new').click();
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

  // Multi-bloodline (2026-06-09) helpers. The strength <select> and slot
  // tracker are now PER-BLOODLINE blocks under #bloodline-blocks (no single
  // #bloodline-strength / #bloodline-thresholds), and clearing the name input
  // no longer removes a selection — you remove via the chip ×.
  function setBloodlineStrength(value, idx = 0) {
    const sel = document.querySelectorAll('#bloodline-blocks .bloodline-strength')[idx];
    if (!sel) throw new Error(`setBloodlineStrength: no select at block ${idx}`);
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function removeBloodlineChip(idx = 0) {
    const x = document.querySelectorAll(
      '#bloodline-applied-list .bloodline-chip-remove')[idx];
    if (!x) throw new Error(`removeBloodlineChip: no chip at ${idx}`);
    x.click();
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
    // Eldritch Knight is now recognized as an arcane-advancing PrC
    // (canonical "+1 level of existing spellcasting class" marker /
    // `_class_metadata.py` advancement metadata, resolved via
    // class-picker's effectiveSpellLevel), so CL advances correctly.
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
  // These three exercise PrCs that advance martial maneuvers + IL. The
  // sheet handles spell-progression advancement (via Source A canonical-
  // marker regex on class_table.special) AND the parallel ToB IL pillar:
  // effectiveInitiatorLevel reads the maneuver-advancer registry
  // (DB `entry.data.maneuver_advancement` / `_FALLBACK_MANEUVER_ADVANCERS`
  // via `getManeuverAdvancementSpec`) and adds each advancer's FULL level
  // to every martial-adept panel's `.tom-init-level`. Both casting and
  // IL now advance correctly, so these are green.

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
    // ToB IL (p.39): Crusader 5 + RKV's FULL level (+2, per its Chapter 5
    // write-up) + 1/2 of all OTHER levels (Cleric 5) = floor(5/2) = 2.
    // IL = 5 + 2 + 2 = 9.
    expectValue('[data-caster-type="maneuvers"] .tom-init-level',
      '9', 'IL 9 (Crusader 5 + RKV full +2 + floor(5 other/2))');
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
    // ToB IL (p.39): Warblade 5 + JPM's FULL level (+2, per its Chapter 5
    // write-up) + 1/2 of all OTHER levels (Wizard 5) = floor(5/2) = 2.
    // IL = 5 + 2 + 2 = 9.
    expectValue('[data-caster-type="maneuvers"] .tom-init-level',
      '9', 'IL 9 (Warblade 5 + JPM full +2 + floor(5 other/2))');
  });

  scenario('Crusader 5 / Swordsage 5 / Master of Nine 2 — multi-discipline advancer', async () => {
    await newCharacter();
    setAbilities({ STR: 14, DEX: 14, CON: 14, INT: 10, WIS: 14, CHA: 10 });
    await applyClass('Crusader', 5);
    await applyClass('Swordsage', 5);
    await applyClass('Master of Nine', 2);

    expect(classChips().length, 3, 'three chips');
    expectValue('#char-level', '12', 'char level 12');
    // ToB IL (p.39): Crusader 5 + MoN's FULL level (+2) + 1/2 of OTHER
    // levels (Swordsage 5) = floor(5/2) = 2. Crusader IL = 5+2+2 = 9.
    // The first maneuvers panel is the crusader (applied first); each ToB
    // class now carries its own IL (see the IL-MC regression for the
    // dual-panel assertion).
    expectValue('[data-caster-type="maneuvers"] .tom-init-level',
      '9', 'IL 9 (Crusader 5 + MoN full +2 + floor(5 other/2))');
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

  // ---- Spell-adjacent subsystem sub-tabs (2026-06-07) ----------------
  //
  // Beyond native spellcasting + psionics + maneuvers, applying a class
  // that uses invocations (Warlock / Dragonfire Adept), vestige binding
  // (Binder), or shadowcasting (Shadowcaster) auto-creates the matching
  // Spells sub-tab and seeds its level field (and any count column the
  // class_table carries). Removing the class tears the tab down. Static
  // guards live in tests/test_pickers.js ('spell-adjacent subsystem
  // sub-tab wiring' group); these are the runtime checks.

  regression('SA1: Warlock 5 creates an Invocations tab seeded to CL 5', async () => {
    await newCharacter();
    await applyClass('Warlock', 5);
    expectExists('[data-caster-type="invocations"]', 'SA1: Invocations sub-tab created');
    expectValue('[data-caster-type="invocations"] .invo-caster-level', '5', 'SA1: Caster Level 5');
    // invocations_known is in the Warlock class_table columns (L5 → 3).
    expectValue('[data-caster-type="invocations"] .invo-known-count', '3', 'SA1: Invocations Known 3');
    // Highest grade is parsed out of the `special` column (least at L1,
    // lesser at L6) — at Warlock 5 it's still Least.
    expectValue('[data-caster-type="invocations"] .invo-highest-grade', 'Least', 'SA1: Highest Grade Least');
  });

  regression('SA2: Binder 5 creates a Vestige Binding tab seeded to binder level 5', async () => {
    await newCharacter();
    await applyClass('Binder', 5);
    expectExists('[data-caster-type="binding"]', 'SA2: Binding sub-tab created');
    expectValue('[data-caster-type="binding"] .bind-level', '5', 'SA2: Effective Binder Level 5');
    // max_vestige_level "3rd" (top-level row field) → 3 at Binder L5.
    expectValue('[data-caster-type="binding"] .bind-max-vestige', '3', 'SA2: Max Vestige Level 3');
  });

  regression('SA3: Shadowcaster 5 creates a Shadowcasting tab seeded to CL 5', async () => {
    await newCharacter();
    await applyClass('Shadowcaster', 5);
    expectExists('[data-caster-type="shadowcaster"]', 'SA3: Shadowcasting sub-tab created');
    expectValue('[data-caster-type="shadowcaster"] .sh-caster-level', '5', 'SA3: Caster Level 5');
  });

  regression('SA4: Dragonfire Adept 5 creates an Invocations tab', async () => {
    await newCharacter();
    await applyClass('Dragonfire Adept', 5);
    expectExists('[data-caster-type="invocations"]', 'SA4: Invocations sub-tab created');
    expectValue('[data-caster-type="invocations"] .invo-caster-level', '5', 'SA4: Caster Level 5');
    expectValue('[data-caster-type="invocations"] .invo-highest-grade', 'Least', 'SA4: Highest Grade Least');
  });

  // SA6 / SA7 guard the 2026-07-31 dead-code fix: effectiveInvocationLevel
  // and effectiveMysteryLevel were computed and never used, so PrCs that
  // advance those pillars advanced nothing the player could see.
  regression('SA6: Eldritch Theurge advances the Warlock invocation pillar', async () => {
    await newCharacter();
    await applyClass('Warlock', 5);
    expectValue('[data-caster-type="invocations"] .invo-caster-level', '5', 'SA6: base CL 5');
    await applyClass('Eldritch Theurge', 5);
    // ET advances invocations at every one of its levels → effective 10.
    expectValue('[data-caster-type="invocations"] .invo-caster-level', '10', 'SA6: CL 10 after ET 5');
    expectValue('[data-caster-type="invocations"] .invo-known-count', '6', 'SA6: 6 invocations known at effective 10');
    expectValue('[data-caster-type="invocations"] .invo-highest-grade', 'Lesser', 'SA6: Lesser unlocked at effective 10');
  });

  regression('SA7: Master of Shadow advances the Shadowcaster mystery pillar', async () => {
    await newCharacter();
    await applyClass('Shadowcaster', 4);
    expectValue('[data-caster-type="shadowcaster"] .sh-caster-level', '4', 'SA7: base CL 4');
    await applyClass('Master of Shadow', 10);
    // MoS advances mysteries at L2-L10 (skips L1) → +9 → effective 13.
    expectValue('[data-caster-type="shadowcaster"] .sh-caster-level', '13', 'SA7: CL 13 after MoS 10');
  });

  regression('SA5: removing the class tears down its subsystem sub-tab', async () => {
    await newCharacter();
    await applyClass('Warlock', 5);
    expectExists('[data-caster-type="invocations"]', 'SA5: tab present after apply');
    removeClass('Warlock');
    await wait(300);
    const orphan = document.querySelector('[data-caster-type="invocations"]');
    expect(orphan, null, 'SA5: Invocations tab removed with the Warlock (no orphan)');
  });

  // Shadowcaster mystery DC = 10 + mystery level + ability mod (2026-06-09).
  // Runtime guard for the latent bug fixed this session: recalcDC used to read
  // window.getAbilityMod (never set by app.js) so every DC computed with mod 0
  // (a 1st-level mystery always showed DC 11 regardless of Cha). The fix routes
  // the bonus-aware mod fn through Shadowcaster.refreshDCs from Spells.recalc.
  // Static guards live in tests/test_pickers.js ('shadowcaster:' group); this
  // drives the actual numbers and proves they track an ability-score change.
  regression('SC-DC: shadowcaster mystery DC = 10 + level + ability mod, tracks Cha', async () => {
    await newCharacter();
    await applyClass('Shadowcaster', 5);
    const panel = document.querySelector('[data-caster-type="shadowcaster"]');
    if (!panel) fail('SC-DC: no shadowcaster panel after applying Shadowcaster 5');
    // Mystery ability = Cha (the default); set it explicitly for robustness.
    const abil = panel.querySelector('.sh-ability');
    abil.value = 'CHA';
    abil.dispatchEvent(new Event('change', { bubbles: true }));
    // Default mysteries per group: fund L0, app L1, init L4, mast L7.
    const dc = (group) => panel
      .querySelector(`.sh-mystery[data-group="${group}"] .sh-myst-dc`).textContent;

    setAbilities({ CHA: 18 });            // mod +4
    await wait(50);
    expect(dc('fund'), '14', 'SC-DC: Fundamentals L0 → 10+0+4=14 at Cha 18');
    expect(dc('app'), '15',
      'SC-DC: Apprentice L1 → 10+1+4=15 at Cha 18 (the mod-0 bug would give 11)');
    expect(dc('mast'), '21', 'SC-DC: Master L7 → 10+7+4=21 at Cha 18');

    setAbilities({ CHA: 20 });            // mod +5
    await wait(50);
    expect(dc('app'), '16', 'SC-DC: Apprentice L1 DC tracks Cha 20 → 16');

    setAbilities({ CHA: 8 });             // mod -1
    await wait(50);
    expect(dc('app'), '10', 'SC-DC: Apprentice L1 DC tracks Cha 8 → 10');
  });

  regression('IL-MC: multiclass initiator level is per-class (ToB p.39 example)', async () => {
    // The book's worked example: a 7th-level crusader / 5th-level
    // swordsage has crusader IL 9 (7 + floor(5/2)) and swordsage IL 8
    // (5 + floor(7/2)) — each ToB class computes its own IL = its level
    // + 1/2 of all other character levels.
    await newCharacter();
    await applyClass('Crusader', 7);
    await applyClass('Swordsage', 5);
    const panelFor = (name) =>
      [...document.querySelectorAll('[data-caster-type="maneuvers"]')]
        .find(p => (p.querySelector('.caster-notes')?.value || '')
          .trim().toLowerCase() === name.toLowerCase());
    const cru = panelFor('Crusader');
    const swd = panelFor('Swordsage');
    if (!cru || !swd) fail('IL-MC: expected both Crusader and Swordsage maneuver panels');
    expect(cru.querySelector('.tom-init-level').value, '9', 'IL-MC: crusader IL 9');
    expect(swd.querySelector('.tom-init-level').value, '8', 'IL-MC: swordsage IL 8');
  });

  regression('IL-MC: single-class IL equals class level', async () => {
    // No "other levels" → IL = class level (Warblade 5 → IL 5).
    await newCharacter();
    await applyClass('Warblade', 5);
    expectValue('[data-caster-type="maneuvers"] .tom-init-level', '5', 'IL-MC: Warblade IL 5');
    // Add 4 non-ToB levels → IL = 5 + floor(4/2) = 7.
    await applyClass('Fighter', 4);
    expectValue('[data-caster-type="maneuvers"] .tom-init-level', '7',
      'IL-MC: Warblade 5 / Fighter 4 → IL 5 + floor(4/2) = 7');
  });

  regression('IL-MC: maneuver advancer is all-target (MoN advances both)', async () => {
    // Every ToB IL-advancer adds its FULL level to EVERY martial adept's
    // IL ("your initiator level", unqualified). Crusader 5 / Swordsage 5
    // / Master of Nine 2: both panels = 5 + MoN 2 + floor(5/2)=2 = 9
    // (swordsage was 8 under the old single-target model).
    await newCharacter();
    await applyClass('Crusader', 5);
    await applyClass('Swordsage', 5);
    await applyClass('Master of Nine', 2);
    const panelFor = (name) =>
      [...document.querySelectorAll('[data-caster-type="maneuvers"]')]
        .find(p => (p.querySelector('.caster-notes')?.value || '')
          .trim().toLowerCase() === name.toLowerCase());
    expect(panelFor('Crusader').querySelector('.tom-init-level').value, '9',
      'IL-MC: crusader IL 9 (MoN full +2)');
    expect(panelFor('Swordsage').querySelector('.tom-init-level').value, '9',
      'IL-MC: swordsage ALSO IL 9 (MoN is all-target)');
  });

  regression('IL-MC: advancer PrC counts full from level 1 (RKV 1)', async () => {
    // The advancing schedule is the maneuvers-known schedule, not IL —
    // so a lone RKV 1 (first maneuver not until level 2) still adds its
    // full +1. Crusader 5 / RKV 1 → IL 5 + 1 + floor(0/2) = 6 (was 5
    // when the schedule gated the IL contribution).
    await newCharacter();
    await applyClass('Crusader', 5);
    await applyClass('Ruby Knight Vindicator', 1);
    expectValue('[data-caster-type="maneuvers"] .tom-init-level', '6',
      'IL-MC: Crusader 5 / RKV 1 → IL 6 (RKV full +1 from level 1)');
  });

  regression('GE1: gestalt synthesis canary (order-independent, no double-dip)', async () => {
    // The load-bearing math invariant. Fighter 5/Wizard 5 // Wizard 5/Fighter 5
    // must equal both its side-swapped twin AND Fighter 10 // Wizard 10, all
    // three = BAB 10 / Fort 7 / Ref 3 / Will 7. This locks three properties at
    // once: order-independence within a side, side-swap symmetry, and the
    // absence of the GitP "+2 per new class" double-dip (which would make the
    // F5/W5//W5/F5 build's saves diverge). If this goes red, the synthesis math
    // has regressed. Calls the REAL exposed ClassPicker.gestaltTotals.
    const F = { bab: 'good', fort: 'good', ref: 'poor', will: 'poor' };
    const W = { bab: 'poor', fort: 'poor', ref: 'poor', will: 'good' };
    const e = (prog, level) => ({ prog, level });
    const G = (a, b) => ClassPicker.gestaltTotals(a, b);
    const key = (t) => `${t.bab}/${t.fort}/${t.ref}/${t.will}/${t.lvl}`;
    const fwwf = G([e(F, 5), e(W, 5)], [e(W, 5), e(F, 5)]);
    const wffw = G([e(W, 5), e(F, 5)], [e(F, 5), e(W, 5)]);
    const f10w10 = G([e(F, 10)], [e(W, 10)]);
    expect(key(fwwf), '10/7/3/7/10',
      'GE1: F5/W5 // W5/F5 must be BAB10/Fort7/Ref3/Will7/L10');
    expect(key(wffw), key(fwwf), 'GE1: side-swap must be identical');
    expect(key(f10w10), key(fwwf),
      'GE1: must equal F10 // W10 (no +2-per-class double-dip)');
  });

  regression('GE2: gestalt apply writes synthesis to the sheet + round-trips', async () => {
    // End-to-end: Fighter 10 // Wizard 10 through the real picker, then a
    // collectData → loadData cycle. Verifies the engine reaches the sheet
    // fields, the gestalt level is max (not sum), and Side B persists.
    await newCharacter();
    ClassPicker.setGestalt(true);
    await applyClass('Fighter', 10);     // Side A (default)
    ClassPicker.setActiveSide('B');
    await applyClass('Wizard', 10);      // Side B
    expectValue('#bab-1', '10', 'GE2: BAB = max(Fighter10, Wizard10) = 10');
    expectValue('#fort-base', '7', 'GE2: Fort good (Fighter side) = 7');
    expectValue('#will-base', '7', 'GE2: Will good (Wizard side) = 7');
    expectValue('#ref-base', '3', 'GE2: Ref poor both sides = 3');
    expectValue('#char-level', '10', 'GE2: gestalt level = 10, not 20');
    const cls = $('#char-class').value;
    if (!cls.includes('//'))
      fail(`GE2: #char-class should use " // " gestalt notation, got "${cls}"`);
    // Save round-trip.
    const blob = Character.collectData();
    if (!blob._gestalt) fail('GE2: collectData omitted the _gestalt flag');
    if (!Array.isArray(blob._multiclassB) || blob._multiclassB.length !== 1)
      fail('GE2: collectData did not emit a 1-entry _multiclassB');
    await newCharacter();
    expect(ClassPicker.isGestalt(), false, 'GE2: newCharacter clears gestalt');
    Character.loadData(blob);
    await wait(80);
    expect(ClassPicker.isGestalt(), true, 'GE2: loadData restores gestalt');
    expect(ClassPicker.getStateB().length, 1, 'GE2: Side B (Wizard) restored');
    expectValue('#bab-1', '10', 'GE2: BAB persists across reload (authoritative)');
  });

  regression('GE3: non-gestalt save omits _gestalt and _multiclassB', async () => {
    // Byte-identity guard: a plain single-stack character must not gain the
    // gestalt keys, so existing saves stay unchanged.
    await newCharacter();
    await applyClass('Fighter', 5);
    const blob = Character.collectData();
    if ('_gestalt' in blob)
      fail('GE3: non-gestalt collectData wrote a _gestalt key');
    if ('_multiclassB' in blob)
      fail('GE3: non-gestalt collectData wrote a _multiclassB key');
    expect(ClassPicker.isGestalt(), false, 'GE3: gestalt stays off');
  });

  regression('GE4: track-agnostic advancement — Side-B advancer advances Side-A caster', async () => {
    // The core gestalt advancement rule (Ryan, 2026-06-29): progression is
    // track-agnostic, so a Mystic Theurge on Side B advances the Wizard on
    // Side A. Wizard 10 // Cleric 5 / Mystic Theurge 5 → Wizard CL 10+5=15,
    // Cleric CL 5+5=10.
    await newCharacter();
    ClassPicker.setGestalt(true);
    ClassPicker.setActiveSide('A'); await applyClass('Wizard', 10);
    ClassPicker.setActiveSide('B');
    await applyClass('Cleric', 5);
    await applyClass('Mystic Theurge', 5);
    await wait(300);
    const clOf = (name) => {
      const p = [...document.querySelectorAll('#spells-content [data-caster-type="spellcasting"]')]
        .find(pp => (pp.querySelector('.caster-notes')?.value || '').trim() === name);
      return p ? p.querySelector('.sc-caster-level')?.value : null;
    };
    expect(clOf('Wizard'), '15',
      'GE4: Side-B Mystic Theurge must advance the Side-A Wizard to CL 15 (cross-track)');
    expect(clOf('Cleric'), '10',
      'GE4: Mystic Theurge advances the Side-B Cleric to CL 10');
  });

  regression('GE5: gestalt monster class on Side B (synthesis + extensions + round-trip)', async () => {
    // Phase 3: a Savage-Species monster class on a gestalt side. Its BAB/save
    // progression feeds the synthesis (it fills Side A's empty L6 here), and
    // its size/NA/ability extensions apply character-global. Fighter 6 // Ogre
    // (Monster Class) 6 → size Large, NA 5, +8 Str template.
    await newCharacter();
    ClassPicker.setGestalt(true);
    ClassPicker.setActiveSide('A'); await applyClass('Fighter', 6);
    ClassPicker.setActiveSide('B'); await applyClass('Ogre (Monster Class)', 6);
    await wait(300);
    const v = (id) => (document.getElementById(id) || {}).value;
    expect(v('char-size'), 'Large', 'GE5: Ogre monster class sets size Large');
    expect(v('ac-natural'), '5', 'GE5: Ogre natural armor 5');
    expect(v('str-template'), '8', 'GE5: Ogre +8 Str in the Template column');
    expect(v('char-level'), '6', 'GE5: gestalt level = 6 (not 12)');
    // Round-trip: the monster extensions survive on Side B.
    const blob = Character.collectData();
    const ogre = (blob._multiclassB || []).find(s => /Ogre/.test(s.className));
    if (!ogre || !ogre.monsterExt)
      fail('GE5: Ogre monsterExt was not persisted on _multiclassB');
    await newCharacter();
    Character.loadData(blob); await wait(150);
    expect(v('char-size'), 'Large', 'GE5: size Large restored after reload');
    expect(v('str-template'), '8', 'GE5: +8 Str restored after reload');
    // Removing the Side-B monster class reverses every extension.
    ClassPicker.removeClass('Ogre (Monster Class)', 'B'); await wait(150);
    expect(v('str-template'), '0', 'GE5: removing Side-B Ogre reverses the +8 Str');
    expect(v('char-size'), '', 'GE5: removing Side-B Ogre clears the Large size');
  });

  regression('GE6: gestalt racial HD lands on the active side', async () => {
    // Phase 3: creature-as-race racial HD can occupy a gestalt side. Driving
    // addRacialHD directly (the creature-race-picker calls it); with gestalt on
    // and Side B active, the synthetic racial-HD row lands on Side B and its
    // prog feeds the synthesis.
    await newCharacter();
    ClassPicker.setGestalt(true);
    ClassPicker.setActiveSide('A'); await applyClass('Fighter', 4);
    ClassPicker.setActiveSide('B');
    ClassPicker.addRacialHD({ creatureRace: 'Test Beast', count: 4,
      creatureType: 'magical beast',
      prog: { bab: 'good', fort: 'good', ref: 'good', will: 'poor' } });
    await wait(150);
    const onB = ClassPicker.getStateB().some(e => e.racialHD);
    const onA = ClassPicker.getState().some(e => e.racialHD);
    if (!onB) fail('GE6: racial HD did not land on the active (B) side');
    if (onA) fail('GE6: racial HD leaked onto Side A');
    // removeRacialHD finds it across sides.
    ClassPicker.removeRacialHD(); await wait(120);
    if (ClassPicker.getStateB().some(e => e.racialHD))
      fail('GE6: removeRacialHD did not remove the Side-B racial HD');
  });

  regression('GE7: activeSide resets across characters (no Side-B leak)', async () => {
    // Regression for the activeSide-leak bug (2026-06-29): building on Side B
    // then starting a NEW character must not carry activeSide='B' forward, or
    // the next gestalt character's first class silently lands on Side B. Caught
    // originally as an order-dependent GE2 failure (Fighter//Wizard both on B,
    // summing to BAB 15 instead of the gestalt max of 10).
    await newCharacter();
    ClassPicker.setGestalt(true);
    ClassPicker.setActiveSide('B');
    await applyClass('Wizard', 5);     // lands on Side B
    expect(ClassPicker.getStateB().length, 1, 'GE7: Wizard applied to Side B');
    // New character, re-enable gestalt, apply WITHOUT setting side → must be A.
    await newCharacter();
    ClassPicker.setGestalt(true);
    await applyClass('Fighter', 5);
    expect(ClassPicker.getState().length, 1,
      'GE7: first class lands on Side A after newCharacter (activeSide reset)');
    expect(ClassPicker.getStateB().length, 0,
      'GE7: Side B is empty — activeSide did not leak from the prior character');
  });

  regression('SM: incarnum class copies soulmeld counts to Equipment tab', async () => {
    // Totemist 5 → Equipment soulmeld counters seeded from the class
    // table columns (soulmelds 4, essentia 3, chakra binds 1).
    await newCharacter();
    await applyClass('Totemist', 5);
    document.querySelector('.tab[data-tab="tab-equipment"]').click();
    await wait(150);
    expectValue('#sm-max-soulmelds', '4', 'SM: Max Soulmelds 4');
    expectValue('#sm-max-essentia', '3', 'SM: Max Essentia 3');
    expectValue('#sm-max-binds', '1', 'SM: Max Binds 1');
    // Level-up re-syncs auto-marked counts (Totemist 8 → soulmelds 5,
    // essentia 5, chakra binds 2).
    await applyClass('Totemist', 8);
    expectValue('#sm-max-soulmelds', '5', 'SM: re-sync soulmelds 5 at L8');
    expectValue('#sm-max-essentia', '5', 'SM: re-sync essentia 5 at L8');
    // Removing the class strips the auto-filled counts.
    removeClass('Totemist');
    await wait(200);
    expect((document.querySelector('#sm-max-soulmelds').value || '').trim(), '',
      'SM: removeClass clears the auto-filled Max Soulmelds');
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

  // The auto-fill marker on #sm-base-capacity (data-from-level) isn't part of
  // _fromClassMarkers, so a loaded character stopped auto-tracking level-ups
  // (reported on gorrash: level 5 -> 6 didn't bump capacity 1 -> 2). Equipment
  // .loadData re-derives the marker when the loaded value matches the level.
  regression('SS-ESSENTIA: base essentia capacity resumes level-tracking after save/load', async () => {
    await newCharacter();
    // Character level 5 -> auto base capacity 1 (MoI Table 2-1).
    set('char-level', '5');
    await wait(120);
    expectValue('#sm-base-capacity', '1', 'SS-ESSENTIA: L5 auto-fills capacity 1');
    // Round-trip through App save/load (the marker isn't persisted; must re-derive).
    const blob = appCollect();
    appLoad(blob);
    await wait(150);
    expectValue('#sm-base-capacity', '1', 'SS-ESSENTIA: capacity restored to 1 after load');
    // Level up 5 -> 6 : capacity must auto-increment 1 -> 2 (froze pre-fix).
    set('char-level', '6');
    await wait(120);
    expectValue('#sm-base-capacity', '2',
      'SS-ESSENTIA: capacity auto-increments to 2 on level-up after load (was frozen at 1)');
  });

  // A saved character whose _templates[*].templateId is STALE — it points at a
  // DIFFERENT template than its `name`. entry.id renumbers on every full DB
  // rebuild, so this is what every pre-rebuild save becomes. The 2026-08-13
  // bleed: Unseelie Fey saved as id 3593 later resolved to its sibling Seelie
  // Court Fey, so the sheet showed Diplomacy +4 / Listen -4 / Spot -4 instead
  // of Unseelie Fey's Intimidate +4, "from a template", on a character that
  // never had it. loadData must resolve by NAME, not the brittle id. The test
  // poisons the save with the WRONG template's live id so it's robust to future
  // renumbering.
  regression('SS-TPL: template resolves by name when the saved id is stale', async () => {
    await newCharacter();
    const uf = DB.queryOne("SELECT id FROM entry WHERE type='template' AND name='Unseelie Fey' " +
      "ORDER BY CASE version WHEN '3.5' THEN 0 ELSE 1 END LIMIT 1");
    const wrong = DB.queryOne("SELECT id FROM entry WHERE type='template' AND name='Seelie Court Fey' LIMIT 1");
    if (!uf) fail('SS-TPL: Unseelie Fey template not in DB');
    if (!wrong) fail('SS-TPL: Seelie Court Fey collision fixture missing from DB');
    // Old-style save: correct name, STALE id pointing at the wrong template,
    // no `source` (pre-2026-08-13 saves lacked it).
    appLoad({ _templates: [{ name: 'Unseelie Fey', templateId: wrong.id, version: '3.5' }] });
    await wait(150);
    const direct = (TemplatePicker.getActiveSkillBonuses() || {}).direct || {};
    expect(direct.intimidate, 4,
      'SS-TPL: stale-id template resolves by name to Unseelie Fey (Intimidate +4)');
    expect(!!direct.diplomacy, false,
      'SS-TPL: must NOT pick up Seelie Court Fey (Diplomacy +4) via the stale id');
    expect(TemplatePicker.getApplied()[0].templateId, uf.id,
      'SS-TPL: resolver self-heals the stale templateId to the current id');
  });

  // The invocation highest-grade / known-count fields live in a dynamic panel
  // with class-based (no-id) selectors, so their data-from-class markers aren't
  // persisted — a loaded Warlock stopped advancing them on level-up (reported
  // on aku: warlock 5 -> 6 didn't update highest grade). makeClassFieldSetter's
  // self-heal + the post-load reconcileClassPillars pass re-stamp the markers.
  regression('SS-INVO: warlock invocation grade/known resume level-tracking after save/load', async () => {
    await newCharacter();
    await applyClass('Warlock', 5);
    const gradeSel = "[data-caster-type='invocations'] .invo-highest-grade";
    const knownSel = "[data-caster-type='invocations'] .invo-known-count";
    if (!$(gradeSel)) fail('SS-INVO: no invocations panel after applying Warlock 5');
    expectValue(gradeSel, 'Least', 'SS-INVO: Warlock 5 highest grade = Least');
    expectValue(knownSel, '3', 'SS-INVO: Warlock 5 invocations known = 3');
    // Round-trip: the grade/known markers have no id, so they aren't persisted.
    const blob = appCollect();
    appLoad(blob);
    await wait(250);
    expectValue(gradeSel, 'Least', 'SS-INVO: highest grade restored after load');
    // Level up 5 -> 6 : grade Least -> Lesser, known 3 -> 4 (froze pre-fix).
    await applyClass('Warlock', 6);
    expectValue(gradeSel, 'Lesser',
      'SS-INVO: highest grade advances to Lesser on level-up after load (was frozen at Least)');
    expectValue(knownSel, '4',
      'SS-INVO: invocations known advances to 4 on level-up after load');
  });

  // The actual repro (aku) was a GESTALT character with the Warlock on track B,
  // so the count fields must resume level-tracking there too (classPool unions
  // both sides). Guards the specific shape that broke, not just the plain case.
  regression('SS-INVO-GESTALT: track-B warlock invocation counts resume level-tracking after save/load', async () => {
    await newCharacter();
    ClassPicker.setGestalt(true);
    ClassPicker.setActiveSide('A');
    await applyClass('Fighter', 5);
    ClassPicker.setActiveSide('B');
    await applyClass('Warlock', 5);
    const gradeSel = "[data-caster-type='invocations'] .invo-highest-grade";
    if (!$(gradeSel)) fail('SS-INVO-GESTALT: no invocations panel for track-B Warlock');
    expectValue(gradeSel, 'Least', 'SS-INVO-GESTALT: track-B Warlock 5 grade = Least');
    const blob = appCollect();
    if (!blob._multiclassB) fail('SS-INVO-GESTALT: save omitted _multiclassB');
    appLoad(blob);
    await wait(250);
    expectValue(gradeSel, 'Least', 'SS-INVO-GESTALT: grade restored after gestalt load');
    ClassPicker.setActiveSide('B');
    await applyClass('Warlock', 6);
    expectValue(gradeSel, 'Lesser',
      'SS-INVO-GESTALT: track-B grade advances to Lesser on level-up after load');
    ClassPicker.setGestalt(false);   // don't leak gestalt into later specs
  });

  regression('SS-AC: ability-to-AC stacks/overlaps NA, round-trips + migrates legacy', async () => {
    await newCharacter();
    document.querySelector('[data-tab="tab-character"]').click();
    await wait(150);

    // --- Natural Armor math: stack (increase) vs overlap (highest) -------
    // DEX 14 (+2), WIS 18 (+4), manual natural armor 2, Medium size.
    set('dex-score', 14);
    set('wis-score', 18);
    set('ac-natural', 2);
    Character.addAbilityAcRow({ ability: 'WIS', type: 'Natural Armor' }); // stack ON by default
    $('#ability-ac-list').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(50);
    // Stacks: NA = 2 (manual) + 4 (WIS) = 6 -> total 18, touch 12 (NA off touch), FF 16.
    expectText('#ac-total', '18', 'SS-AC: stacking NA adds to the manual field (2+4)');
    expectText('#ac-touch', '12', 'SS-AC: natural armor never applies to touch');
    expectText('#ac-flatfooted', '16', 'SS-AC: stacking NA applies flat-footed');
    // Uncheck stack -> overlap: NA = highest(2,4) = 4 -> total 16, FF 14.
    const cb = $('#ability-ac-list .ability-ac-stack-cb');
    if (!cb) fail('SS-AC: stack toggle checkbox not found on the Natural Armor row');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(50);
    expectText('#ac-total', '16', 'SS-AC: overlap NA takes the highest of (2,4)');
    expectText('#ac-flatfooted', '14', 'SS-AC: overlap NA flat-footed reflects highest');

    // --- Round-trip incl. stack flag + duplicate ability ----------------
    await newCharacter();
    document.querySelector('[data-tab="tab-character"]').click();
    await wait(150);
    Character.addAbilityAcRow({ ability: 'WIS', type: 'Natural Armor', stack: true });
    Character.addAbilityAcRow({ ability: 'WIS', type: 'Dodge' });
    await wait(50);
    const blob = Character.collectData();
    expect((blob['ability-ac-bonuses'] || []).length, 2,
      'SS-AC: collectData emits both ability-to-AC rows');
    expect(blob['ability-ac-bonuses'][0].type, 'Natural Armor',
      'SS-AC: first row type persisted');
    expect(blob['ability-ac-bonuses'][0].stack, true,
      'SS-AC: stack flag persisted on the Natural Armor row');
    // New character clears the list, then reload restores the rows in order.
    await newCharacter();
    expect($$('#ability-ac-list .ability-ac-row').length, 0,
      'SS-AC: new character clears the ability-to-AC list');
    Character.loadData(blob);
    await wait(100);
    const rows = $$('#ability-ac-list .ability-ac-row')
      .map(r => r.querySelector('.ability-ac-ability').value + '/' +
                r.querySelector('.ability-ac-type').value);
    expect(rows.join(', '), 'WIS/Natural Armor, WIS/Dodge',
      'SS-AC: loadData restores both rows in order');
    expect($('#ability-ac-list .ability-ac-row .ability-ac-stack-cb').checked, true,
      'SS-AC: restored Natural Armor row keeps its stack toggle checked');

    // Legacy migration — bean_uisce's exact shape: cha-to-ac true / Deflection,
    // the rest off. Only the checked one becomes a row; in-play characters
    // must not silently lose their bonus.
    await newCharacter();
    Character.loadData({
      'con-to-ac': false, 'con-to-ac-type': 'Untyped',
      'int-to-ac': false, 'int-to-ac-type': 'Untyped',
      'wis-to-ac': false, 'wis-to-ac-type': 'Untyped',
      'cha-to-ac': true,  'cha-to-ac-type': 'Deflection',
    });
    await wait(100);
    const migrated = $$('#ability-ac-list .ability-ac-row')
      .map(r => r.querySelector('.ability-ac-ability').value + '/' +
                r.querySelector('.ability-ac-type').value);
    expect(migrated.join(', '), 'CHA/Deflection',
      'SS-AC: legacy cha-to-ac:Deflection migrates to exactly one row');
  });

  regression('SS-ATK: weapon attack calculator computes, round-trips, preserves free-text', async () => {
    await newCharacter();
    document.querySelector('[data-tab="tab-character"]').click();
    await wait(150);

    // STR 18 (+4), DEX 14 (+2), BAB 6, Large size (acMod -1).
    // One attack with the calculator on: ability DEX, other +2
    //   -> 6 (BAB) + -1 (size) + 2 (DEX) + 2 (other) = +9.
    set('str-score', 18);
    set('dex-score', 14);
    set('char-size', 'Large');
    set('bab-1', 6);
    Character.addAttack({ name: 'Test Blade', calcAbility: 'DEX', calcMisc: '2', calcAuto: true });
    set('bab-1', 6);   // programmatic addAttack fires no event — force a recalc
    await wait(50);

    expectText('#attacks-container .attack-entry .atk-calc-bab', '+6', 'SS-ATK: BAB auto-filled');
    expectText('#attacks-container .attack-entry .atk-calc-size', '-1', 'SS-ATK: Large size modifier (= AC size mod)');
    expectText('#attacks-container .attack-entry .atk-calc-abilmod', '+2', 'SS-ATK: chosen-ability (DEX) mod');
    expectText('#attacks-container .attack-entry .atk-calc-total', '+9', 'SS-ATK: total = BAB + size + ability + other');
    expectValue('#attacks-container .attack-entry .atk-bonus', '+9', 'SS-ATK: fill-bonus drives the Attack Bonus field');
    expect($('#attacks-container .attack-entry .atk-bonus').readOnly, true, 'SS-ATK: auto-filled bonus is read-only');

    // collectData carries the three calc fields.
    const blob = Character.collectData();
    const atk = (blob.attacks || [])[0] || {};
    expect(atk.calcAbility, 'DEX', 'SS-ATK: calcAbility persisted');
    expect(atk.calcMisc, '2', 'SS-ATK: calcMisc persisted');
    expect(atk.calcAuto, true, 'SS-ATK: calcAuto persisted');

    // New character clears attacks; reload restores the calculator state AND
    // (since the whole tab round-trips) recomputes +9 from rehydrated str/size/bab.
    await newCharacter();
    expect($$('#attacks-container .attack-entry').length, 0, 'SS-ATK: new character clears attacks');
    Character.loadData(blob);
    await wait(100);
    set('bab-1', 6);   // force a recalc after rehydration
    await wait(50);
    const r = $('#attacks-container .attack-entry');
    expectValue('#attacks-container .attack-entry .atk-calc-ability', 'DEX', 'SS-ATK: ability restored');
    expectValue('#attacks-container .attack-entry .atk-calc-misc', '2', 'SS-ATK: other-bonus restored');
    expect(r.querySelector('.atk-calc-auto-cb').checked, true, 'SS-ATK: fill-bonus toggle restored');
    expectText('#attacks-container .attack-entry .atk-calc-total', '+9', 'SS-ATK: restored total recomputes from rehydrated str/size/bab');
    expectValue('#attacks-container .attack-entry .atk-bonus', '+9', 'SS-ATK: restored fill-bonus re-drives the field');

    // Backward-compat: an OLD save (no calc fields) keeps its free-text /
    // iterative bonus, stays editable, and the calculator defaults to STR/off.
    await newCharacter();
    Character.loadData({ attacks: [{ name: 'Old Bow', bonus: '+7/+2', damage: '1d8' }] });
    set('bab-1', 6);
    await wait(50);
    const o = $('#attacks-container .attack-entry');
    expectValue('#attacks-container .attack-entry .atk-bonus', '+7/+2', 'SS-ATK: legacy free-text bonus preserved');
    expect(o.querySelector('.atk-bonus').readOnly, false, 'SS-ATK: legacy bonus stays editable (auto off)');
    expectValue('#attacks-container .attack-entry .atk-calc-ability', 'STR', 'SS-ATK: legacy attack defaults to STR');
    expect(o.querySelector('.atk-calc-auto-cb').checked, false, 'SS-ATK: legacy attack auto off');
  });

  regression('SS-CF: class-feature special abilities keep their origin marker + dont duplicate', async () => {
    await newCharacter();
    document.querySelector('[data-tab="tab-feats"]').click();
    await wait(100);

    // A class-derived ability (tagged with its origin class) + a plain one.
    Feats.addSpecialAbility('[Fighter 1] Bonus Feat', 'Fighter');
    Feats.addSpecialAbility('Improved Grab (custom)');

    // collectData must persist the marker (object shape) for class entries and
    // keep plain abilities as bare strings.
    const blob = Feats.collectData();
    expect(blob.specialAbilities.some(a => a && typeof a === 'object' && a.fromClass === 'Fighter'), true,
      'SS-CF: collectData persists the fromClass marker as { text, fromClass }');
    expect(blob.specialAbilities.some(a => a === 'Improved Grab (custom)'), true,
      'SS-CF: a plain user-typed ability stays a bare string');

    // loadData must restore the marker — without it (the pre-fix bug) a later
    // class re-apply can't find its own entries and re-adds them on top.
    Feats.loadData(blob);
    await wait(50);
    expect($$('#special-abilities-container [data-from-class="Fighter"]').length, 1,
      'SS-CF: the data-from-class marker is restored on load');

    // End-to-end dedup: replicate populateSpecialAbilities step-1 over a mix
    // that includes a LEGACY untagged entry (pre-fix save). Both the tagged and
    // the "[Fighter " prefixed entries must be removed; other class + custom kept.
    Feats.loadData({ specialAbilities: [
      { text: '[Fighter 1] Bonus Feat', fromClass: 'Fighter' },
      '[Fighter 2] Bravery',            // legacy untagged — caught by the prefix backstop
      '[Wizard 1] Scribe Scroll',       // different class — kept
      'Improved Grab (custom)'          // user-typed — kept
    ]});
    await wait(50);
    const cont = $('#special-abilities-container');
    const tag = 'Fighter', prefix = '[Fighter ';
    cont.querySelectorAll('.special-ability-entry').forEach(ta => {
      if (ta.dataset.fromClass === tag || (ta.value || '').startsWith(prefix)) {
        const row = ta.closest('.feat-row'); if (row) row.remove();
      }
    });
    const remaining = $$('#special-abilities-container .special-ability-entry')
      .map(t => t.value).sort().join(' | ');
    const expected = ['[Wizard 1] Scribe Scroll', 'Improved Grab (custom)'].sort().join(' | ');
    expect(remaining, expected,
      'SS-CF: dedup removes BOTH the tagged and the legacy-prefixed Fighter ' +
      'entries and keeps the other class + custom ability');
  });

  regression('SS-CR: monster race (race-picker) applies RHD + NA and round-trips', async () => {
    // Monster race via the MAIN race-picker. Bugbear migrated from a creature
    // as_character block to a type=race entry in the MM I v3 walk, so it now
    // routes through race-picker.js (not creature-race-picker.js). A race with
    // racial Hit Dice injects a SYNTHETIC class row into the multiclass
    // aggregate via ClassPicker.addRacialHD; the row has no DB class, so its
    // prog can't be rehydrated on load — class-picker persists prog +
    // creatureRace directly in _multiclass and reconstructs from the stub.
    // Also guards that the racial natural-armor bonus reaches #ac-natural.
    await newCharacter();
    document.querySelector('[data-tab="tab-character"]').click();
    await wait(150);
    set('char-race', 'Bugbear');   // unified Race field; 3 Humanoid racial HD, +3 NA
    await wait(400);
    // Adjustment layer landed on the Race column + size + natural armor.
    expectValue('#str-race', '4', 'SS-CR: Bugbear +4 Str in the race column');
    expectValue('#char-size', 'Medium', 'SS-CR: Bugbear size Medium');
    expectValue('#ac-natural', '3', 'SS-CR: Bugbear +3 natural armor applied');
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
    set('char-race', 'Bugbear');                         // unified Race field; racial-HD row + race-col adj + tagged specials
    await wait(350);
    Bloodline.loadData({ _bloodlines: [{                 // bloodline state + DOM panel
      name: 'Fireclaw', source: 'Diamond Soul (Homebrew)',
      strength: 'major', slotsPaid: [true], notes: '' }] });
    await wait(50);

    // Sanity: the seeding actually took (else the post-reset asserts are vacuous).
    if (ClassPicker.getState().length < 2)
      fail('RESET: precondition — expected classes + racial-HD row seeded');
    expect(ClassFeatures.getCustomizations().length, 1,
      'RESET: precondition — a customization was seeded');
    if (!Bloodline.collectData()._bloodlines)
      fail('RESET: precondition — a bloodline was seeded');

    // --- New Character, then assert nothing bled through ---
    await newCharacter();
    const v = id => (document.getElementById(id) || {}).value;
    const nonzero = s => s && s !== '0' && String(s).trim() !== '';
    const leaks = [];
    if (ClassPicker.getState().length)
      leaks.push(`ClassPicker retains ${ClassPicker.getState().length} class/racial-HD row(s)`);
    if (ClassFeatures.getCustomizations().length)
      leaks.push(`ClassFeatures retains ${ClassFeatures.getCustomizations().length} customization(s)`);
    if (Bloodline.collectData()._bloodlines)
      leaks.push(`Bloodline retains ${Bloodline.collectData()._bloodlines.length} selection(s)`);
    if (v('char-race') && v('char-race').trim())
      leaks.push(`#char-race not cleared: "${v('char-race')}"`);
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

  regression('SS-BL: bloodline ability bumps apply by level + round-trip', async () => {
    // Fireclaw is a Diamond Soul homebrew bloodline (off by default).
    // Enable the homebrew book so the DB-driven catalog includes it,
    // then verify (1) the per-level ability bumps reach the Character
    // tab at the right levels and (2) the selection round-trips through
    // collectData/loadData.
    await newCharacter();
    await waitForDb();
    await wait(300);   // let homebrew/book_content register on DB.ready
    if (typeof HomebrewBookContent !== 'undefined') {
      HomebrewBookContent.setBookEnabled('book_DS', true);
    } else if (typeof HomebrewFilter !== 'undefined') {
      HomebrewFilter.setEnabled('entry_DS_bloodline_fireclaw', true);
    }
    await wait(200);
    // Picker now lives on the Character tab (next to Template Lookup).
    document.querySelector('[data-tab="tab-character"]').click();
    await wait(150);
    // Odd base scores so a +1 bump flips the total into a new modifier.
    setAbilities({ CHA: 13, DEX: 13, CON: 13 });
    set('char-level', '2');
    await wait(100);
    set('bloodline-name', 'Fireclaw');
    await wait(250);
    expect(Bloodline._getStates()[0] && Bloodline._getStates()[0].strength, 'major',
      'SS-BL: strength defaults to the only column (major)');
    expectVisible('#bloodline-blocks .bloodline-progression',
      'SS-BL: trait progression renders on selection');
    // L2: the first ability bump (CHA) is at L3, so nothing active yet.
    expect(JSON.stringify(Bloodline.getActiveBonuses().abilities), '{}',
      'SS-BL: no ability bump active at L2');
    expectText('#cha-total', '13', 'SS-BL: CHA total unbumped at L2');
    // L3 → CHA +1 (13 → 14).
    set('char-level', '3');
    await wait(100);
    expect(Bloodline.getActiveBonuses().abilities.CHA, 1,
      'SS-BL: CHA bump active at L3');
    expectText('#cha-total', '14', 'SS-BL: CHA total reflects the +1 bump at L3');
    // L8 → CHA + DEX + CON all bumped.
    set('char-level', '8');
    await wait(100);
    const b8 = Bloodline.getActiveBonuses().abilities;
    expect(b8.CHA, 1, 'SS-BL: CHA bumped at L8');
    expect(b8.DEX, 1, 'SS-BL: DEX bumped at L8');
    expect(b8.CON, 1, 'SS-BL: CON bumped at L8');
    expectText('#dex-total', '14', 'SS-BL: DEX total reflects the bump at L8');
    // Fireclaw's L2 skill boost is written in the homebrew SHORTHAND
    // ("+2 Tumble (Skill Boost)"), not the UA "+N on <Skill> checks"
    // wording — getActiveSkillBonuses must still parse it (regression
    // 2026-06-05: homebrew skill bonus was silently dropped).
    expect(Bloodline.getActiveSkillBonuses().direct['tumble'], 2,
      'SS-BL: Fireclaw "+2 Tumble (Skill Boost)" homebrew skill bonus parses');
    // --- round-trip ---
    const blob = Bloodline.collectData();
    expect(blob._bloodlines[0].name, 'Fireclaw', 'SS-BL: collectData persists name');
    expect(blob._bloodlines[0].strength, 'major', 'SS-BL: collectData persists strength');
    await newCharacter();                       // clears via Bloodline.loadData({})
    await wait(150);
    expect(Bloodline.collectData()._bloodlines, null,
      'SS-BL: New Character clears the bloodline selection');
    expect(JSON.stringify(Bloodline.getActiveBonuses().abilities), '{}',
      'SS-BL: no stale bumps survive New Character');
    // The homebrew toggle is campaign-level (persists across New), so
    // the catalog still includes Fireclaw for the reload.
    Bloodline.loadData(blob);
    await wait(250);
    // Multi-bloodline: the name input is an add-box (cleared after add), so
    // the restored selection lives in the state/chip, not the input.
    expect(Bloodline._getStates()[0] && Bloodline._getStates()[0].name, 'Fireclaw',
      'SS-BL: loadData restores the name');
    expect(Bloodline._getStates()[0] && Bloodline._getStates()[0].strength, 'major',
      'SS-BL: loadData restores the strength');
    set('char-level', '8');
    await wait(100);
    expect(Bloodline.getActiveBonuses().abilities.CON, 1,
      'SS-BL: bumps re-derive from the restored selection after reload');
  });

  regression('SS-BL3: bloodline-level slots round-trip + survive an unresolved load', async () => {
    // Bug fixed 2026-06-05: checked bloodline-level slots vanished on reload.
    // Loading a saved character BEFORE DB.ready built the catalog left the
    // bloodline unresolved, and syncSlots() then wiped state.slotsPaid. Two
    // assertions: (1) the slots round-trip through save/clear/load, and
    // (2) an UNRESOLVED selection (the same code path as load-before-DB-ready:
    // currentStrength() === null) preserves the saved flags rather than wiping
    // them. Celestial is a published UA bloodline (3 strengths), no homebrew.
    await newCharacter();
    await waitForDb();
    await wait(200);
    document.querySelector('[data-tab="tab-character"]').click();
    await wait(150);
    set('char-level', '20');
    set('bloodline-name', 'Celestial');
    await wait(250);
    // Major has 3 thresholds (L3/6/12). The tracker lives on Feats & Abilities.
    document.querySelector('[data-tab="tab-feats"]').click();
    await wait(150);
    setBloodlineStrength('major');
    await wait(200);
    const boxAt = (i) => document.querySelector(
      `#bloodline-blocks .bloodline-slot-paid[data-slot="${i}"]`);
    expect(!!boxAt(0) && !!boxAt(2), true,
      'SS-BL3: major bloodline shows the 3 slot checkboxes');
    // Check Bloodline 1 (slot 0) + Bloodline 3 (slot 2). render() rebuilds the
    // panel on each change, so re-query the live box for the second toggle.
    boxAt(0).checked = true;
    boxAt(0).dispatchEvent(new Event('change', { bubbles: true }));
    await wait(120);
    boxAt(2).checked = true;
    boxAt(2).dispatchEvent(new Event('change', { bubbles: true }));
    await wait(150);
    const blob = Bloodline.collectData();
    expect(JSON.stringify(blob._bloodlines[0].slotsPaid), '[true,false,true]',
      'SS-BL3: collectData persists the checked bloodline-level slots');
    // (1) save → New Character → reload.
    await newCharacter();
    await wait(150);
    Bloodline.loadData(blob);
    await wait(250);
    expect(JSON.stringify(Bloodline.collectData()._bloodlines[0].slotsPaid),
      '[true,false,true]', 'SS-BL3: slots survive a save/clear/load round-trip');
    // (2) load-before-resolve: a selection whose entry does NOT resolve must
    // preserve slotsPaid (guards the load-before-DB-ready wipe). Also
    // exercises the legacy single-`_bloodline` → stack migration on load.
    Bloodline.loadData({ _bloodline: { name: '__nope_unresolved_bloodline__',
      source: '', strength: 'major', slotsPaid: [true, false, true], notes: '' } });
    await wait(150);
    expect(JSON.stringify(Bloodline.collectData()._bloodlines[0].slotsPaid),
      '[true,false,true]',
      'SS-BL3: an unresolved selection preserves slotsPaid (load-before-DB-ready guard)');
  });

  regression('SS-BL4: bloodline skill bonuses — direct in total, affinity as note', async () => {
    // Direct skill boosts ("+2 on Sense Motive checks") fold into the skill
    // TOTAL; affinity bonuses ("Celestial affinity +6") are SITUATIONAL — a
    // note on the 5 social skills, NEVER added to the total. Uses Celestial
    // (published UA, 3 strengths). Delta-checks the total with vs without the
    // bloodline so it's robust to the base ability mod.
    await newCharacter();
    await waitForDb();
    await wait(200);
    document.querySelector('[data-tab="tab-character"]').click();
    await wait(150);
    // Base 10 (mod +0); the +1 ability bump keeps it +0, so deltas are clean.
    setAbilities({ WIS: 10, CHA: 10 });
    set('char-level', '20');
    set('bloodline-name', 'Celestial');
    await wait(250);
    document.querySelector('[data-tab="tab-feats"]').click();
    await wait(100);
    setBloodlineStrength('major');
    await wait(200);
    // Parsed bonuses.
    const skb = Bloodline.getActiveSkillBonuses();
    expect(skb.direct['sense motive'], 2, 'SS-BL4: direct "+2 Sense Motive" parsed');
    const celAff = (skb.affinities || []).find(a => /celestial/i.test(a.vs));
    expect(celAff && celAff.value, 6,
      'SS-BL4: Celestial affinity scales to +6 at L20 (one entry per bloodline)');
    // Read skill totals on the Skills tab.
    document.querySelector('[data-tab="tab-skills"]').click();
    await wait(200);
    const rowOf = (name) => [...document.querySelectorAll(
      '#skills-body-left tr, #skills-body-right tr')].find(
      x => x.querySelector('.skill-name')?.textContent.trim() === name);
    const totalOf = (name) => {
      const r = rowOf(name);
      return r ? parseInt(r.querySelector('.skill-total')?.textContent, 10) : null;
    };
    const noteOf = (name) => {
      const r = rowOf(name);
      return r ? (r.querySelector('.skill-notes-toggle')?.dataset.synergy || '') : '';
    };
    const smWith = totalOf('Sense Motive');     // +2 direct in total
    const bluffWith = totalOf('Bluff');         // affinity NOT in total
    expect(/affinity/i.test(noteOf('Bluff')), true,
      'SS-BL4: Bluff carries the affinity situational note');
    expect(/affinity/i.test(noteOf('Sense Motive')), false,
      'SS-BL4: non-social Sense Motive has no affinity note');
    // Clear the bloodline; the direct bonus must leave the total, and Bluff
    // (which only had the note) must be unchanged.
    document.querySelector('[data-tab="tab-character"]').click();
    await wait(100);
    removeBloodlineChip();   // multi: clear via the chip ×, not by emptying the input
    await wait(250);
    document.querySelector('[data-tab="tab-skills"]').click();
    await wait(150);
    expect(smWith - totalOf('Sense Motive'), 2,
      'SS-BL4: direct +2 leaves the Sense Motive total when the bloodline clears');
    expect(bluffWith - totalOf('Bluff'), 0,
      'SS-BL4: affinity was never in the Bluff total (delta 0 on clear)');
  });

  regression('SS-BL5: bloodline bumps show in Template/Bloodline column, not Item', async () => {
    // Bloodline ability bumps surface in the read-only Template / Bloodline
    // column (which hides when empty), NOT the Item Bonus column.
    await newCharacter();
    await waitForDb();
    await wait(200);
    document.querySelector('[data-tab="tab-character"]').click();
    await wait(150);
    setAbilities({ STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 });
    await wait(100);
    const table = () => document.querySelector('.ability-table');
    expect(table().classList.contains('hide-tplbl-col'), true,
      'SS-BL5: Template/Bloodline column hidden when no template or bloodline');
    set('char-level', '20');
    set('bloodline-name', 'Celestial');
    await wait(250);
    document.querySelector('[data-tab="tab-feats"]').click();
    await wait(100);
    setBloodlineStrength('major');
    await wait(250);
    document.querySelector('[data-tab="tab-character"]').click();
    await wait(150);
    // Celestial major @ L20 bumps WIS/CHA/CON +1.
    expect(table().classList.contains('hide-tplbl-col'), false,
      'SS-BL5: column shown once a bloodline contributes');
    expectText('#wis-tplbl', '+1',
      'SS-BL5: WIS bloodline bump lands in the Template/Bloodline column');
    expectText('#wis-misc', '',
      'SS-BL5: WIS bloodline bump is NOT in the Misc column');
    expectText('#wis-total', '11', 'SS-BL5: WIS total still includes the bump');
    expectText('#str-tplbl', '',
      'SS-BL5: STR (no Celestial bump) stays blank in the column');
    // Clearing the bloodline hides the column again and resets the total.
    removeBloodlineChip();   // multi: clear via the chip ×, not by emptying the input
    await wait(250);
    expect(table().classList.contains('hide-tplbl-col'), true,
      'SS-BL5: column hides again when the bloodline clears');
    expectText('#wis-total', '10', 'SS-BL5: WIS total back to base on clear');
  });

  regression('SS-BL6: multiple bloodlines stack — bumps sum, removal is independent, round-trip', async () => {
    // Multi-bloodline (2026-06-09): a character can carry more than one
    // bloodline (UA frames it singular but doesn't forbid it; "independent
    // tracks"). Ability bumps + direct skill bonuses SUM across all; removing
    // one leaves the others; the stack round-trips as `_bloodlines`.
    await newCharacter();
    await waitForDb();
    await wait(200);
    document.querySelector('[data-tab="tab-character"]').click();
    await wait(150);
    set('char-level', '20');
    // Two published UA bloodlines, both major where available. Celestial
    // (major) bumps WIS/CHA/CON; pair it with a second to prove summing.
    set('bloodline-name', 'Celestial');
    await wait(200);
    set('bloodline-name', 'Demon');
    await wait(250);
    expect(Bloodline._getStates().length, 2, 'SS-BL6: two bloodlines on the stack');
    expect(document.querySelectorAll('#bloodline-applied-list .bloodline-chip').length, 2,
      'SS-BL6: two chips render on the Character tab');
    // Pick major on each block (Celestial idx 0, Demon idx 1) so both
    // contribute their full progression.
    document.querySelector('[data-tab="tab-feats"]').click();
    await wait(150);
    setBloodlineStrength('major', 0);
    await wait(150);
    setBloodlineStrength('major', 1);
    await wait(200);
    expect(document.querySelectorAll('#bloodline-blocks .bloodline-block').length, 2,
      'SS-BL6: two bloodline blocks render on the Feats tab');
    // Both bloodlines' active ability bumps are present and summed (no key
    // collisions). Capture the combined set, then remove one.
    const both = Bloodline.getActiveBonuses().abilities;
    const combinedKeys = Object.keys(both).length;
    if (combinedKeys < 1)
      fail('SS-BL6: expected at least one ability bump from the two bloodlines');
    // Every UA bloodline grants an affinity vs ITS creature type — distinct,
    // non-overlapping conditions — so two bloodlines yield TWO affinity notes,
    // not one collapsed value.
    const affs = Bloodline.getActiveSkillBonuses().affinities;
    expect(affs.length, 2, 'SS-BL6: two bloodlines surface two distinct affinities');
    const vsSet = affs.map(a => a.vs).join('|').toLowerCase();
    expect(/celestial/.test(vsSet) && /demon/.test(vsSet), true,
      'SS-BL6: the two affinities are vs their own creature types (celestials + demons)');
    // Round-trip the stack.
    const blob = Bloodline.collectData();
    expect(Array.isArray(blob._bloodlines) && blob._bloodlines.length, 2,
      'SS-BL6: collectData emits a 2-element _bloodlines array');
    await newCharacter();
    await wait(150);
    Bloodline.loadData(blob);
    await wait(250);
    set('char-level', '20');
    await wait(150);
    expect(Bloodline._getStates().map(s => s.name).sort().join(','), 'Celestial,Demon',
      'SS-BL6: both bloodlines survive the round-trip');
    expect(JSON.stringify(Bloodline.getActiveBonuses().abilities),
      JSON.stringify(both),
      'SS-BL6: summed ability bumps re-derive identically after reload');
    // Remove Celestial (idx 0) — Demon must remain with its own bumps.
    document.querySelector('[data-tab="tab-character"]').click();
    await wait(100);
    removeBloodlineChip(0);
    await wait(200);
    expect(Bloodline._getStates().map(s => s.name).join(','), 'Demon',
      'SS-BL6: removing one bloodline leaves the other');
  });

  regression('AB-TEMP: Temp is a score delta (+ round-trips); Misc hides when empty', async () => {
    // Temp became a temporary score ADJUSTMENT (delta), not a full alternate
    // score, and the redundant Temp Score / Temp Mod columns were removed.
    // Item Bonus → Misc (hides when empty). Verifies the delta math + skill
    // propagation + the new persistence key + the Misc hide-when-empty toggle.
    await newCharacter();
    await waitForDb();
    await wait(150);
    document.querySelector('[data-tab="tab-character"]').click();
    await wait(150);
    setAbilities({ STR: 14 });   // +2 mod
    await wait(120);
    const table = document.querySelector('.ability-table');
    expect(table.classList.contains('hide-misc-col'), true,
      'AB-TEMP: Misc column hidden when no items/rage/conditions');
    expectText('#str-mod', '+2', 'AB-TEMP: STR 14 = +2 before temp');
    // Temp +4 (Bull's Strength): effective 18 → +4 mod; Total stays 14.
    set('str-temp', '4');
    await wait(150);
    expectText('#str-mod', '+4',
      'AB-TEMP: Temp +4 lifts STR 14 to an effective 18 (+4)');
    expectText('#str-total', '18',
      'AB-TEMP: Total reflects the effective score including Temp (18)');
    // Propagates to a STR-based skill (Climb, 0 ranks) → +4.
    document.querySelector('[data-tab="tab-skills"]').click();
    await wait(150);
    const climbTotal = () => parseInt([...document.querySelectorAll(
      '#skills-body-left tr, #skills-body-right tr')].find(
      x => x.querySelector('.skill-name')?.textContent.trim() === 'Climb')
      ?.querySelector('.skill-total')?.textContent, 10);
    expect(climbTotal(), 4, 'AB-TEMP: Temp propagates to STR-based skills (Climb +4)');
    // Negative temp (ability damage): STR 14 - 4 = effective 10 → +0.
    document.querySelector('[data-tab="tab-character"]').click();
    await wait(120);
    set('str-temp', '-4');
    await wait(150);
    expectText('#str-mod', '+0', 'AB-TEMP: negative Temp models ability damage');
    // Persistence: new `-temp-adj` key, NOT the old full-score `-temp` key.
    set('str-temp', '3');
    await wait(100);
    const blob = Character.collectData();
    expect(blob['str-temp-adj'], '3', 'AB-TEMP: Temp persists under str-temp-adj');
    expect(blob['str-temp'], undefined,
      'AB-TEMP: the old full-score str-temp key is no longer written');
  });

  regression('SS-BL2: bonus feats inject + bloodline level in Class & Level box', async () => {
    // (c) bonus feats auto-inject into the Feats list as marked
    // data-from-bloodline rows (derived, not persisted); (b) the
    // bloodline level appears in the Class & Level box, counting slots
    // taken in the tracker.
    await newCharacter();
    await waitForDb();
    await wait(300);
    if (typeof HomebrewBookContent !== 'undefined') {
      HomebrewBookContent.setBookEnabled('book_DS', true);
    }
    await wait(200);
    // Picker-managed Class & Level box needs picked classes.
    await applyClass('Scout', 3);
    await applyClass('Rogue', 2);
    document.querySelector('[data-tab="tab-character"]').click();
    await wait(150);
    set('bloodline-name', 'Fireclaw');
    await wait(250);
    set('char-level', '8');     // user override above the class total (5)
    await wait(200);
    // (c) Dodge(L4) + Mobility(L6) + Spring Attack(L8) injected, marked.
    const injected = () => $$('#feats-container .feat-row[data-from-bloodline="1"] .feat-entry')
      .map(t => t.value);
    let feats = injected();
    expect(feats.length, 3, 'SS-BL2: 3 bonus feats injected at L8');
    expectIncludes(feats.join(' | '), 'Dodge', 'SS-BL2: Dodge injected');
    expectIncludes(feats.join(' | '), 'Mobility', 'SS-BL2: Mobility injected');
    expectIncludes(feats.join(' | '), 'Spring Attack', 'SS-BL2: Spring Attack injected');
    // Derived, not persisted — Feats.collectData excludes them.
    const fblob = Feats.collectData();
    if ((fblob.feats || []).some(f => /bloodline/i.test(f))) {
      fail('SS-BL2: injected bonus feats leaked into Feats.collectData (would double on reload)');
    }
    // Lowering level drops the now-inactive bonus feats (Spring Attack L8,
    // Mobility L6) — at L5 only Dodge (L4) remains.
    set('char-level', '5');
    await wait(200);
    feats = injected();
    expect(feats.length, 1, 'SS-BL2: at L5 only the L4 bonus feat (Dodge) is injected');
    set('char-level', '8');
    await wait(150);
    // (b) Class & Level box gains the bloodline once a slot is taken.
    document.querySelector('[data-tab="tab-feats"]').click();
    await wait(150);
    const slot0 = $('#bloodline-blocks .bloodline-slot-paid');
    if (!slot0) fail('SS-BL2: slot checkbox missing in the tracker');
    slot0.checked = true;
    slot0.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(200);
    const cl = $('#char-class').value;
    expectIncludes(cl, 'Scout 3', 'SS-BL2: classes still present in Class & Level box');
    expectIncludes(cl, 'Fireclaw Bloodline 1',
      'SS-BL2: bloodline level (1 slot taken) appended to the Class & Level box');
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
    // Fill scalars + Known entries under Lesser. Known invocations are
    // structured ROWS since the 2026-06-08 rework (saved as
    // invoList-<grade> arrays) — the per-grade textareas this test
    // originally drove no longer exist. (Test modernized 2026-07-05,
    // first full suite run since the rework.)
    panel.querySelector('.invo-caster-level').value = '6';
    panel.querySelector('.invo-highest-grade').value = 'Lesser';
    panel.querySelector('.invo-known-count').value = '4';
    Spells.addInvocationKnown(panel, 'lesser', 'Eldritch Spear');
    Spells.addInvocationKnown(panel, 'lesser', 'Walk Unseen');
    // Force a dispatch so any input listeners catch it.
    panel.querySelectorAll('input, textarea').forEach(el => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Round-trip via Spells.collect/load.
    const blob = Spells.collectData();
    const invo = blob.casters.find(c => c.type === 'invocations');
    if (!invo) fail('SS3: collectData did not include invocations caster');
    expect(invo.casterLevel, '6', 'SS3: casterLevel round-tripped');
    expect(invo.highestGrade, 'Lesser', 'SS3: highestGrade round-tripped');
    expect(JSON.stringify(invo['invoList-lesser']),
      JSON.stringify(['Eldritch Spear', 'Walk Unseen']),
      'SS3: per-grade Known rows round-tripped');
    // Wipe + reload.
    Spells.loadData({ casters: [] });
    await wait(200);
    if ($('[data-caster-type="invocations"]')) fail('SS3: panel should be gone after reload-empty');
    Spells.loadData(blob);
    await wait(300);
    const restored = $('[data-caster-type="invocations"]');
    if (!restored) fail('SS3: panel not rebuilt on loadData');
    expect(restored.querySelector('.invo-caster-level').value, '6',
      'SS3: casterLevel restored to panel');
    const names = [...restored.querySelectorAll(
      '.invo-known-list[data-grade="lesser"] .invo-known-row .invo-known-name')]
      .map(i => i.value.trim()).filter(Boolean);
    expect(JSON.stringify(names), JSON.stringify(['Eldritch Spear', 'Walk Unseen']),
      'SS3: Lesser known rows restored');
  });

  regression('PS1: prepared-used checkbox syncs expended slots (delta, floor, reset, removal walk-back)', async () => {
    await newCharacter();
    document.querySelector('[data-tab="tab-spells"]').click();
    await wait(150);
    $('#btn-add-spellcasting').click();
    await wait(300);
    const panels = $$('[data-caster-type="spellcasting"]');
    const panel = panels[panels.length - 1];
    if (!panel) fail('PS1: spellcasting panel did not spawn');
    const usedInp = panel.querySelector('.sc-used[data-lvl="1"]');
    if (!usedInp) fail('PS1: level-1 .sc-used input missing');
    // Pre-existing manual expenditure — the checkbox must DELTA on top of
    // it (a recount would clobber spontaneous-conversion bookkeeping).
    usedInp.value = 2;
    const addPrep = panel.querySelector('.sc-add-prepared[data-lvl="1"]');
    addPrep.click(); addPrep.click();
    const rows = panel.querySelectorAll('.sc-prepared-list[data-lvl="1"] .sc-prepared-row');
    if (rows.length !== 2) fail('PS1: expected 2 prepared rows, got ' + rows.length);
    const cb1 = rows[0].querySelector('.sc-prep-used');
    const cb2 = rows[1].querySelector('.sc-prep-used');
    const toggle = (cb) => {
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    };
    toggle(cb1);
    expect(usedInp.value, '3', 'PS1: check adds +1 on the manual base');
    toggle(cb2);
    expect(usedInp.value, '4', 'PS1: second check adds another +1');
    toggle(cb1);
    expect(usedInp.value, '3', 'PS1: uncheck walks back -1');
    usedInp.value = 0;
    toggle(cb2);
    expect(usedInp.value, '0', 'PS1: uncheck floors at 0');
    // Removing a still-checked row walks its expenditure back too.
    toggle(cb1); toggle(cb2);           // both checked, used 0 -> 2
    expect(usedInp.value, '2', 'PS1: both re-checked');
    rows[0].querySelector('.sc-prep-remove').click();
    await wait(50);
    expect(usedInp.value, '1', 'PS1: removing a checked row decrements');
    // Reset clears the count AND the surviving checkmark together.
    panel.querySelector('.sc-reset-slots').click();
    expect(usedInp.value, '0', 'PS1: reset zeroes the used count');
    expect(cb2.checked, false, 'PS1: reset unchecks the surviving prep-used box');
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

  // Removing a gear row or magic item changes carried weight, which must
  // recompute the LOAD tier (Light/Medium/Heavy). That computation lives in the
  // global recalcAll (character.js), NOT in recalcWeight — so the pre-fix
  // removal handlers (which called only recalcWeight) left the load tier stale
  // until a weight field was edited. The removal itself must now cascade.
  regression('LOAD: removing an item recomputes the load tier (no field edit)', async () => {
    await newCharacter();
    if (!dbReady()) fail('LOAD: DB not loaded — re-run once [DB] Loaded appears.');
    const loadText = () => (document.getElementById('load-category') || {}).textContent;
    // STR 10 -> Light <=33 lb, Medium 34-66 lb.
    set('str-score', '10');
    document.getElementById('gear-body').innerHTML = '';
    document.getElementById('magic-items-container').innerHTML = '';
    window.recalcAll();
    await wait(50);
    expect(loadText(), 'Light', 'LOAD: empty load is Light');

    // --- gear removal path ---
    Equipment.addGearRow({ name: 'Anvil', location: 'Bag', weight: 40 });
    window.recalcAll();               // setup: establish the Medium baseline
    await wait(50);
    expect(loadText(), 'Medium', 'LOAD: 40 lb of gear -> Medium (setup)');
    // The fix: the removal CLICK alone recomputes the load tier — no recalcAll
    // is called after it here, so a revert to bare recalcWeight() fails this.
    $$('#gear-body tr.gear-row .gear-remove-btn')[0].click();
    await wait(50);
    expect(loadText(), 'Light',
      'LOAD: removing the gear row drops Medium -> Light with no field edit (stale pre-fix)');

    // --- magic-item removal path (shares recalcWeightAndCascade) ---
    Equipment.addMagicItem({ name: 'Lead Cloak', weight: 40, special: 'x' });
    window.recalcAll();               // setup
    await wait(50);
    expect(loadText(), 'Medium', 'LOAD: 40 lb magic item -> Medium (setup)');
    document.querySelector('#magic-items-container .magic-item-entry .btn-remove').click();
    await wait(50);
    expect(loadText(), 'Light',
      'LOAD: removing the magic item drops Medium -> Light with no field edit');
  });

  // The power-picker's Class filter is injected async into psionics panels and
  // was never part of the saved panel data, so it reset on reload (rmsnd87u6).
  // spells.js now persists caster.ppClass + stamps panel.dataset.ppClass, and
  // power-picker restores from that dataset when it injects the bar.
  regression('SS-PPCLASS: power-picker class filter round-trips through save/load', async () => {
    await newCharacter();
    if (!dbReady()) fail('SS-PPCLASS: DB not loaded — re-run once [DB] Loaded appears.');
    const barSel = '#spells-content [data-caster-type="psionics"] .power-picker .pp-class';
    Spells.addCaster('psionics', {});
    // Wait for power-picker's async MutationObserver to inject the bar.
    for (let i = 0; i < 60 && !document.querySelector(barSel); i++) await wait(80);
    const sel = document.querySelector(barSel);
    if (!sel) fail('SS-PPCLASS: power-picker bar never injected into the psionics panel');
    const opts = Array.from(sel.options).map(o => o.value).filter(Boolean);
    const chosen = opts.find(o => o === 'Psion/Wilder') || opts[0];
    sel.value = chosen;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const blob = Spells.collectData();
    const psi = (blob.casters || []).find(c => c && c.type === 'psionics');
    expect(psi && psi.ppClass, chosen,
      'SS-PPCLASS: collectData saves the chosen power-picker class filter');
    // Reload the blob; the filter must restore after the bar is re-injected.
    Spells.loadData(blob);
    for (let i = 0; i < 60; i++) {
      const s = document.querySelector(barSel);
      if (s && s.value === chosen) break;
      await wait(80);
    }
    const sel2 = document.querySelector(barSel);
    expect(sel2 && sel2.value, chosen,
      'SS-PPCLASS: class filter restores on load (reset to (any) pre-fix)');
  });

  // Improved Grapple grants a flat +4 on grapple checks (PHB p.95). The sheet
  // detects the feat (Feats.getGrappleBonus) and folds it into the grapple
  // total as a labelled Feat component (rmsnf91kc).
  regression('GRAPPLE: Improved Grapple adds +4 to the grapple total', async () => {
    await newCharacter();
    set('str-score', '14');            // +2 STR -> baseline grapple +2
    window.recalcAll();
    await wait(50);
    const total = () => document.getElementById('grapple-total').textContent;
    const feat  = () => document.getElementById('grapple-feat').textContent;
    expect(total(), '+2', 'GRAPPLE: baseline (BAB 0 + STR +2) is +2');
    expect(feat(), '+0', 'GRAPPLE: no feat bonus before Improved Grapple');
    Feats.addFeat('Improved Grapple');
    window.recalcAll();
    await wait(50);
    expect(feat(), '+4', 'GRAPPLE: Improved Grapple shows +4 in the Feat component');
    expect(total(), '+6', 'GRAPPLE: total folds in the +4 (feat was ignored pre-fix)');
    // Paren-qualified feat text still matches (hasFeat strips the trailing "(...)").
    const ta = document.querySelector('#feats-container .feat-entry');
    ta.value = 'Improved Grapple (Str 13)';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    window.recalcAll();
    await wait(50);
    expect(feat(), '+4', 'GRAPPLE: qualified "Improved Grapple (…)" still detected');
  });

  // Long-term care is a dedicated "Rest (Long-term care)" button now, not a
  // sticky toggle that could silently carry into a later plain rest (rmso1h7vo).
  // Normal rest heals 1 hp/level; long-term care heals 2/level (PHB p.146/p.75).
  regression('REST: dedicated long-term-care button heals 2x, plain rest 1x', async () => {
    await newCharacter();
    if (!dbReady()) fail('REST: DB not loaded — re-run once [DB] Loaded appears.');
    await applyClass('Fighter', 5);
    const setv = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
    setv('hp-total', '50'); setv('hp-current', '10'); setv('hp-nonlethal', '3'); setv('hp-temp', '2');
    await wait(50);
    expect(!!document.getElementById('rest-long-term-care'), false,
      'REST: the sticky long-term-care toggle was removed');
    expect(!!document.getElementById('btn-rest-longterm'), true,
      'REST: a dedicated Rest (Long-term care) button exists');
    // Plain rest: 1/level x5 = +5 -> 15, and clears nonlethal + temp.
    document.getElementById('btn-rest').click();
    await wait(50);
    expectValue('#hp-current', '15', 'REST: plain rest heals 1/level (10 -> 15)');
    expectValue('#hp-nonlethal', '0', 'REST: rest clears nonlethal');
    expectValue('#hp-temp', '0', 'REST: rest clears temp HP');
    // Long-term care: 2/level x5 = +10 -> 20.
    setv('hp-current', '10');
    await wait(40);
    document.getElementById('btn-rest-longterm').click();
    await wait(50);
    expectValue('#hp-current', '20', 'REST: long-term care heals 2/level (10 -> 20)');
  });

  // The item picker auto-fills a magic item's body slot from the DB body_slot
  // (mostly NULL) or, failing that, the item NAME (rmsnu5814). Unworn items
  // (wands/rods) correctly stay None.
  regression('ITEMSLOT: item picker auto-fills the magic-item body slot', async () => {
    await newCharacter();
    if (!dbReady()) fail('ITEMSLOT: DB not loaded — re-run once [DB] Loaded appears.');
    const input = document.getElementById('item-lookup');
    if (!input) fail('ITEMSLOT: item picker input (#item-lookup) not present');
    const pickMagic = (like) => {
      const row = DB.queryOne("SELECT name FROM entry WHERE type IN ('item','weapon','armor','gear') " +
        "AND name LIKE ? ORDER BY length(name) LIMIT 1", [like]);
      if (!row) return null;
      document.getElementById('magic-items-container').innerHTML = '';
      input.value = row.name;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('item-add-magic').click();
      const e = document.querySelector('#magic-items-container .magic-item-entry .mi-slot');
      return { name: row.name, slot: e ? e.value : '(none)' };
    };
    const cases = [
      ['Cloak of Resistance%', 'shoulders'],
      ['Ring of Protection%', 'ring1'],
      ['Amulet of%', 'neck'],
      ['Boots of%', 'feet'],
      ['Wand of%', ''],           // unworn -> None
    ];
    for (const [like, want] of cases) {
      const r = pickMagic(like);
      if (r) expect(r.slot, want, `ITEMSLOT: "${r.name}" -> slot "${want || '(none)'}"`);
    }
  });

  // A 📌-pinned skill stays a class skill through class add/remove (rmsny857o).
  // The gap it closes: hand-mark a skill, apply a class that also grants it,
  // remove that class -> reconciliation used to untick it. Pins survive, and
  // round-trip through save/load.
  regression('SKILLPIN: pinned skill survives class add/remove + save/load', async () => {
    await newCharacter();
    if (!dbReady()) fail('SKILLPIN: DB not loaded — re-run once [DB] Loaded appears.');
    const rowFor = (name) => [...document.querySelectorAll('#skills-body-left tr, #skills-body-right tr')]
      .find(r => r.querySelector('.skill-name') && r.querySelector('.skill-name').textContent.trim() === name);
    const tumble = rowFor('Tumble');
    if (!tumble) fail('SKILLPIN: Tumble row not found');
    const cb = () => rowFor('Tumble').querySelector('.skill-class-check');
    // Pin Tumble (no class yet).
    tumble.querySelector('.skill-pin').click();
    await wait(60);
    expect(cb().checked, true, 'SKILLPIN: pinning checks the class-skill box');
    expect(cb().dataset.pinned, '1', 'SKILLPIN: pin flag set');
    // Apply Rogue (grants Tumble -> the box gains a class source), then remove.
    await applyClass('Rogue', 3);
    await wait(80);
    expect(cb().checked, true, 'SKILLPIN: still checked while Rogue grants Tumble');
    removeClass('Rogue');
    await wait(200);
    // Pre-fix, removeClassSkills unticked here (last source gone).
    expect(cb().checked, true, 'SKILLPIN: still a class skill after Rogue removed (pin survives)');
    expect(cb().dataset.pinned, '1', 'SKILLPIN: still pinned after class churn');
    // Save/load round-trip.
    const blob = appCollect();
    appLoad(blob);
    await wait(150);
    expect(cb().checked, true, 'SKILLPIN: pin survives save/load (checked)');
    expect(cb().dataset.pinned, '1', 'SKILLPIN: pin survives save/load (flag)');
  });

  // Build Timeline "Feats taken" is an editable list of rows, not a one-per-line
  // textarea (rmso7nk4t). Rows add/edit/remove and sync the level's feats_taken.
  regression('BTFEATS: build-timeline feats-taken is an editable list', async () => {
    await newCharacter();
    CharacterHistory.set([
      { level: 1, class_taken: 'Fighter', hp_rolled: 10, feats_taken: ['Power Attack', 'Cleave'],
        skills_purchased: {}, spells_learned: [], spells_unlearned: [], choices: {}, notes: '' },
    ], { reconstructed: false });
    BuildTimeline.render();
    await wait(60);
    const row = document.querySelector('.bt-row[data-level="1"]');
    if (!row) fail('BTFEATS: level-1 row not rendered');
    (row.querySelector('.bt-row-summary, .bt-row-head, .bt-row-toggle') || row).click();
    await wait(60);
    expect(!!document.querySelector('.bt-edit-feats'), false, 'BTFEATS: old textarea is gone');
    const list = document.querySelector('.bt-feats-list');
    if (!list) fail('BTFEATS: feats list not rendered');
    expect([...list.querySelectorAll('.bt-feat-input')].map(i => i.value).join('|'),
      'Power Attack|Cleave', 'BTFEATS: existing feats render as rows');
    // Add a feat.
    document.querySelector('.bt-feat-add').click();
    const inputs = () => [...list.querySelectorAll('.bt-feat-input')];
    const ni = inputs()[inputs().length - 1];
    ni.value = 'Weapon Focus';
    ni.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(40);
    expect(CharacterHistory.get()[0].feats_taken.join('|'), 'Power Attack|Cleave|Weapon Focus',
      'BTFEATS: add appends to feats_taken');
    // Remove Cleave (index 1).
    list.querySelectorAll('.bt-feat-remove')[1].click();
    await wait(40);
    expect(CharacterHistory.get()[0].feats_taken.join('|'), 'Power Attack|Weapon Focus',
      'BTFEATS: remove drops the feat');
  });

  // Auto-granted bonus feats land at their GRANTING level in the Build Timeline,
  // not the generic PHB feat schedule (rmso7oje3). class-picker/bloodline stamp
  // data-feat-level; collectFeatsForTimeline + reconstructFromTotals place them.
  regression('BONUSFEAT: bonus feats land at their granting level in the timeline', async () => {
    await newCharacter();
    if (!dbReady()) fail('BONUSFEAT: DB not loaded — re-run once [DB] Loaded appears.');
    // Real flow: Ranger grants Track (L1) + Endurance (L3) as fixed bonus feats.
    await applyClass('Ranger', 5);
    await wait(200);
    const bonusRows = [...document.querySelectorAll('#feats-container .feat-row[data-feat-level]')]
      .map(r => (r.querySelector('.feat-entry')?.value || '').split('\n')[0].trim());
    expect(bonusRows.includes('Track') && bonusRows.includes('Endurance'), true,
      'BONUSFEAT: Ranger injects Track + Endurance as level-stamped bonus feats');
    const tl = CharacterHistory.get() || [];
    const at = (L) => (tl.find(e => e.level === L) || {}).feats_taken || [];
    expect(at(1).includes('Track'), true, 'BONUSFEAT: Track at its granting level L1');
    expect(at(3).includes('Endurance'), true, 'BONUSFEAT: Endurance at its granting level L3');
    expect(at(1).includes('Endurance'), false, 'BONUSFEAT: Endurance not mislevelled to L1');
    // Non-schedule proof: a bonus feat stamped L4 (not a feat-schedule slot)
    // must land at L4 purely from its level, not the schedule.
    const h = CharacterHistory.reconstructFromTotals(
      [{ className: 'Fighter', level: 5 }], [],
      { bonusFeats: [{ name: 'Dodge', level: 4 }], hitDieByClass: { Fighter: 10 } });
    expect(((h.find(e => e.level === 4) || {}).feats_taken || []).includes('Dodge'), true,
      'BONUSFEAT: a level-4 bonus feat lands at L4 (the schedule has no L4 slot)');
  });

  regression('SS5: Possessions + Magic Items ⓘ rules panel round-trip (panel-open save safety)', async () => {
    await newCharacter();
    if (!dbReady()) fail(
      'SS5: DB not loaded — re-run after [DB] Loaded appears in console.');
    document.querySelector('[data-tab="tab-equipment"]').click();
    await wait(150);

    // --- Possessions (gear) ⓘ panel + weapon stat line ---
    document.getElementById('gear-body').innerHTML = '';
    Equipment.addGearRow({ name: 'Cloak of Resistance', location: 'Worn', weight: 1 });
    Equipment.addGearRow({ name: 'Longsword', location: 'Belt', weight: 4 });
    const gearRows = $$('#gear-body tr.gear-row');
    expect(gearRows.length, 2, 'SS5: two gear rows added');

    // Open the weapon's panel — must surface the weapon stat line.
    const swordRow = gearRows.find(r => r.querySelector('.gear-name').value === 'Longsword');
    swordRow.querySelector('.gear-info-btn').click();
    const swordPanel = swordRow.nextElementSibling;
    if (!swordPanel || !swordPanel.classList.contains('gear-rules-row')) {
      fail('SS5: gear ⓘ did not insert a sibling rules-panel row');
    }
    const swordText = swordPanel.querySelector('.feat-rules').innerText;
    expectIncludes(swordText, 'Damage:', 'SS5: weapon panel shows a Damage line');
    expectIncludes(swordText, '1d8', 'SS5: Longsword medium damage 1d8 rendered');
    expectIncludes(swordText, 'Critical:', 'SS5: weapon panel shows a Critical line');

    // Save-stability: collect WHILE the panel is open. The panel row has
    // no .gear-name input — an unscoped collector would throw right here.
    let blob, threw = null;
    try { blob = Equipment.collectData(); }
    catch (e) { threw = String(e); }
    expect(threw, null, 'SS5: collectData must not throw with a gear panel open');
    expect(blob.gear.length, 2, 'SS5: exactly two gear items collected (panel row excluded)');
    expect(blob.gear.map(g => g.name).join('|'), 'Cloak of Resistance|Longsword',
      'SS5: gear names + order intact (no phantom null row)');

    // Round-trip: load the blob back, gear survives.
    Equipment.loadData(blob);
    await wait(100);
    expect($$('#gear-body tr.gear-row .gear-name').map(i => i.value).join('|'),
      'Cloak of Resistance|Longsword', 'SS5: gear round-trips through loadData');

    // --- Magic Items ⓘ panel ---
    document.getElementById('magic-items-container').innerHTML = '';
    Equipment.addMagicItem({ name: 'Cloak of Resistance', weight: 1, special: 'x' });
    const entry = document.querySelector('#magic-items-container .magic-item-entry');
    if (!entry) fail('SS5: magic item entry not created');
    entry.querySelector('.mi-info-btn').click();
    const miPanel = entry.querySelector(':scope > .feat-rules');
    if (!miPanel) fail('SS5: magic-item ⓘ did not insert a rules panel');
    expectIncludes(miPanel.innerText, 'Cloak of Resistance', 'SS5: magic-item panel shows the item');
    expectIncludes(miPanel.innerText, 'Aura:', 'SS5: magic-item panel shows the Aura line');

    // Save-stability: collect WHILE the magic-item panel is open.
    let miThrew = null, miBlob;
    try { miBlob = Equipment.collectData(); }
    catch (e) { miThrew = String(e); }
    expect(miThrew, null, 'SS5: collectData must not throw with a magic-item panel open');
    const magic = (miBlob.magicItems || []).filter(m => m.name === 'Cloak of Resistance');
    expect(magic.length, 1, 'SS5: exactly one magic item collected (panel not counted as an entry)');

    // Second click collapses the magic-item panel.
    entry.querySelector('.mi-info-btn').click();
    expect(!!entry.querySelector(':scope > .feat-rules'), false,
      'SS5: second click collapses the magic-item panel');
  });

  regression('SS5b: Possessions ⓘ panel does not reflow / overflow the gear table', async () => {
    await newCharacter();
    if (!dbReady()) fail(
      'SS5b: DB not loaded — re-run after [DB] Loaded appears in console.');
    document.querySelector('[data-tab="tab-equipment"]').click();
    await wait(150);

    // "Cornucopia of the Needful" carries the worst-case content: a
    // ~54-char unbreakable slash-list token. Under the old table-layout
    // (auto) that token fed the column-width algorithm and reflowed the
    // Item/Location/Weight/Actions columns (and overflowed at narrow
    // widths) when the panel opened. table-layout:fixed on .gear-table
    // decouples the columns from the colspan cell.
    const tbody = document.getElementById('gear-body');
    tbody.innerHTML = '';
    Equipment.addGearRow({ name: 'Cornucopia of the Needful', location: 'Bag', weight: 1 });
    Equipment.addGearRow({ name: 'Backpack', location: 'Back', weight: 2 });
    const table = document.querySelector('.gear-table');
    const section = table.closest('.section');
    const row0 = tbody.querySelector('tr.gear-row');
    const widths = () => [...row0.children].map(td => Math.round(td.getBoundingClientRect().width)).join(',');
    const closed = widths();

    row0.querySelector('.gear-info-btn').click();
    await wait(50);
    const panel = row0.nextElementSibling && row0.nextElementSibling.querySelector('.feat-rules');
    if (!panel) fail('SS5b: gear ⓘ panel did not open');
    // Guard against a false green: if the item ever drops out of the DB
    // the panel shows the short "homebrew" fallback (which never
    // reflowed), so confirm the long DB content actually rendered.
    expectIncludes(panel.innerText, 'Cornucopia of the Needful',
      'SS5b: real DB content must render (else swap to another long-token item)');

    expect(widths(), closed,
      'SS5b: opening the panel must NOT reflow the gear columns ' +
      '(table-layout:fixed regressed?)');
    expect(panel.scrollWidth > panel.clientWidth + 1, false,
      'SS5b: panel content must not overflow horizontally (overflow-wrap regressed?)');
    expect(table.getBoundingClientRect().width > section.clientWidth + 1, false,
      'SS5b: table must not overflow its section when the panel is open');
  });

  regression('SS6: report/flag mutations route through atomic ops + adopt authoritative state (R0)', async () => {
    // Client half of the R0 fix (the server/concurrency half lives in
    // tests/test_save_server.py, which can drive real threads — playfeel
    // can't). Here we stub SaveBackend's flag layer with an in-memory store
    // (mirroring the server's op semantics) so the test NEVER touches the real
    // reviews/sheet-reports.json, and assert: every mutation routes a single
    // atomic op (add/resolve/remove) instead of a whole-array persist; the
    // module adopts the authoritative state the op returns; refresh() pulls in
    // another tab's writes; and a local add can't clobber a concurrently-added
    // report. SheetReports + ReviewFlags share this exact path — SheetReports
    // is representative.
    if (!window.SheetReports || !window.SaveBackend) fail('SS6: modules missing');
    const realOp = SaveBackend.flagOp;
    const realLoad = SaveBackend.loadFlags;
    const store = { flags: [] };
    const ops = [];
    SaveBackend.flagOp = async (surface, op) => {
      ops.push(op);
      if (op.op === 'add') {
        if (op.flag && op.flag.id && !store.flags.some(f => f.id === op.flag.id)) {
          store.flags.push(op.flag);
        }
      } else if (op.op === 'resolve') {
        const f = store.flags.find(x => x.id === op.id);
        if (f) { f.status = 'resolved'; f.resolved = op.resolved; }
      } else if (op.op === 'remove') {
        store.flags = store.flags.filter(x => x.id !== op.id);
      } else if (op.op === 'edit') {
        const f = store.flags.find(x => x.id === op.id);
        if (f) {
          if (typeof op.note === 'string') f.note = op.note;
          if (op.kind === 'bug' || op.kind === 'feature') f.kind = op.kind;
          f.edited = op.edited;
        }
      }
      return JSON.parse(JSON.stringify(store));   // authoritative snapshot
    };
    SaveBackend.loadFlags = async () => JSON.parse(JSON.stringify(store));

    try {
      await SheetReports.refresh();
      expect(SheetReports.getOpen().length, 0, 'SS6: starts empty against the stub store');

      // add -> single add op, module adopts result
      const rep = await SheetReports.add('bug', 'SS6 test report');
      expect(ops[ops.length - 1].op, 'add', 'SS6: add routes an atomic add op');
      expect(ops[ops.length - 1].flag.id, rep.id, 'SS6: add op carries the built flag (not a whole array)');
      expect(SheetReports.getOpen().length, 1, 'SS6: module adopted the add');

      // A DIFFERENT tab writes directly to the shared store (stale-snapshot case).
      store.flags.push({ id: 'other-tab', kind: 'bug', note: 'from another tab', status: 'open' });
      expect(SheetReports.getOpen().length, 1, 'SS6: this tab is unaware pre-refresh');
      await SheetReports.refresh();
      expect(SheetReports.getOpen().length, 2,
        'SS6: refresh() pulls the other tab\'s report (live cross-tab refresh)');

      // Local add must NOT clobber the concurrently-added report — this is the
      // exact failure R0 was: adopt-authoritative keeps both.
      const rep2 = await SheetReports.add('feature', 'SS6 second');
      const openIds = SheetReports.getOpen().map(r => r.id);
      if (!openIds.includes('other-tab') || !openIds.includes(rep2.id)) {
        fail('SS6: local add clobbered a concurrently-added report (adopt-authoritative regressed)');
      }
      expect(SheetReports.getOpen().length, 3, 'SS6: all three coexist, no clobber');

      // resolve -> resolve op with id + timestamp, leaves the open list
      await SheetReports.resolve(rep.id);
      const rOp = ops[ops.length - 1];
      expect(rOp.op, 'resolve', 'SS6: resolve routes a resolve op');
      expect(rOp.id, rep.id, 'SS6: resolve op carries the id');
      if (!rOp.resolved) fail('SS6: resolve op carries a timestamp');
      if (SheetReports.getOpen().some(r => r.id === rep.id)) {
        fail('SS6: resolved report should leave the open list');
      }

      // edit -> edit op amends note + kind in place (re-phrase without re-filing)
      await SheetReports.edit(rep2.id, { note: 'SS6 revised note', kind: 'bug' });
      const eOp = ops[ops.length - 1];
      expect(eOp.op, 'edit', 'SS6: edit routes an edit op');
      expect(eOp.id, rep2.id, 'SS6: edit op carries the id (not a whole array)');
      const edited = SheetReports.getAll().find(r => r.id === rep2.id);
      expect(edited.note, 'SS6 revised note', 'SS6: edit updated the note in the adopted state');
      expect(edited.kind, 'bug', 'SS6: edit switched the kind (feature -> bug)');
      if (!edited.edited) fail('SS6: edit op stamps an edited timestamp');
      expect(edited.status, 'open', 'SS6: edit preserves status');

      // remove -> remove op, gone from everything
      await SheetReports.remove('other-tab');
      expect(ops[ops.length - 1].op, 'remove', 'SS6: remove routes a remove op');
      if (SheetReports.getAll().some(r => r.id === 'other-tab')) {
        fail('SS6: removed report should be gone from getAll');
      }
    } finally {
      // Restore the real backend and reload the real store into the module so
      // the suite leaves the user's actual reports untouched.
      SaveBackend.flagOp = realOp;
      SaveBackend.loadFlags = realLoad;
      await SheetReports.refresh();
    }
  });

  regression('SS7: soulmelds do not bleed across a load-over-load (S2)', async () => {
    await newCharacter();
    const slot = $('.magic-item-slot[data-slot-id="hands"]');
    if (!slot) fail('SS7: hands slot not built');
    const q = (s) => slot.querySelector(s);

    // Character A: a bound soulmeld in the hands slot + a totem.
    const chk = q('.slot-soulmeld-check');
    chk.checked = true; chk.dispatchEvent(new Event('change'));
    q('.slot-sm-name').value = 'Bloodtalons';
    q('.slot-sm-base').value = 'Base A';
    q('.slot-sm-bind-effect').value = 'Bind A';
    q('.slot-sm-bound').checked = true;
    $('#totem-sm-name').value = 'Blink Shirt';
    $('#totem-sm-base').value = 'Totem base A';

    const blobA = Equipment.collectData();
    if (!blobA.slotSoulmelds?.hands) fail('SS7: A did not collect a hands soulmeld');
    if (!blobA.totem) fail('SS7: A did not collect a totem');

    // A round-trips (positive path must still populate).
    Equipment.loadData(blobA);
    await wait(60);
    expect(q('.slot-sm-name').value, 'Bloodtalons', 'SS7: soulmeld restores on its own load');
    expect($('#totem-sm-name').value, 'Blink Shirt', 'SS7: totem restores on its own load');

    // Character B has NO soulmelds. Loading B over A must clear the slot + totem
    // (the S2 bug left A's soulmeld sitting in the slot).
    const blobB = Equipment.collectData();
    delete blobB.slotSoulmelds;
    delete blobB.totem;
    Equipment.loadData(blobB);
    await wait(60);
    expect(q('.slot-soulmeld-check').checked, false, 'SS7: slot checkbox cleared (no bleed)');
    expect(q('.slot-sm-name').value, '', 'SS7: slot soulmeld name cleared (no bleed)');
    expect(q('.slot-sm-base').value, '', 'SS7: slot base cleared');
    expect(q('.slot-sm-bind-effect').value, '', 'SS7: slot bind effect cleared');
    expect(q('.slot-sm-bound').checked, false, 'SS7: slot bound flag cleared');
    expect(q('.slot-soulmeld-area').style.display, 'none', 'SS7: soulmeld area hidden');
    expect($('#totem-sm-name').value, '', 'SS7: totem name cleared (no bleed)');
    expect($('#totem-sm-base').value, '', 'SS7: totem base cleared');

    // Double-chakra -> single must clear the second soulmeld too.
    chk.checked = true; chk.dispatchEvent(new Event('change'));
    const dbl = q('.slot-sm-double'); dbl.checked = true; dbl.dispatchEvent(new Event('change'));
    q('.slot-sm-name').value = 'Primary'; q('.slot-sm2-name').value = 'Second';
    const blobDbl = Equipment.collectData();
    const smSingle = JSON.parse(JSON.stringify(blobDbl));
    smSingle.slotSoulmelds.hands.double = false;
    delete smSingle.slotSoulmelds.hands.name2;
    Equipment.loadData(smSingle);
    await wait(60);
    expect(q('.slot-sm-double').checked, false, 'SS7: double flag cleared on single load');
    expect(q('.slot-sm2-name').value, '', 'SS7: second soulmeld name cleared on double->single');
    expect(q('.slot-sm-second').style.display, 'none', 'SS7: second soulmeld section hidden');
  });

  regression('SS8: Incarnate Expanded Soulmeld Capacity folds into capacity (S3)', async () => {
    await newCharacter();
    if (!dbReady()) fail('SS8: DB not loaded — re-run after [DB] Loaded appears in console.');
    document.querySelector('[data-tab="tab-equipment"]').click();
    await wait(100);
    const slot = $('.magic-item-slot[data-slot-id="hands"]');
    if (!slot) fail('SS8: hands slot not built');
    const q = (s) => slot.querySelector(s);
    const pipCount = () =>
      q('.essentia-pips:not(.essentia-pips-2)').querySelectorAll('.essentia-pip').length;

    // Shape a soulmeld with a base capacity of 2, no meldshaping class yet.
    const chk = q('.slot-soulmeld-check');
    chk.checked = true; chk.dispatchEvent(new Event('change'));
    set('sm-base-capacity', '2');
    await wait(50);
    expect(pipCount(), 2, 'SS8: base capacity 2, no class -> 2 pips');
    expect(ClassPicker.getActiveSoulmeldCapacityBonus(), 0, 'SS8: no Incarnate -> +0');
    expect(document.getElementById('sm-cap-bonus-note').hidden, true, 'SS8: note hidden with no bonus');

    // Incarnate 3 -> +1 capacity to every soulmeld.
    await applyClass('Incarnate', 3);
    expect(ClassPicker.getActiveSoulmeldCapacityBonus(), 1, 'SS8: Incarnate 3 -> +1');
    expect(pipCount(), 3, 'SS8: capacity now 3 (base 2 + Incarnate 1)');
    const note = document.getElementById('sm-cap-bonus-note');
    expect(note.hidden, false, 'SS8: capacity note visible');
    expectIncludes(note.textContent, 'Incarnate', 'SS8: note names Incarnate');

    // Incarnate 15 -> +2.
    await applyClass('Incarnate', 15);
    expect(ClassPicker.getActiveSoulmeldCapacityBonus(), 2, 'SS8: Incarnate 15 -> +2');
    expect(pipCount(), 4, 'SS8: capacity now 4 (base 2 + 2)');

    // Remove the class -> bonus gone, capacity back to the manual base.
    removeClass('Incarnate');
    await wait(400);
    expect(ClassPicker.getActiveSoulmeldCapacityBonus(), 0, 'SS8: Incarnate removed -> +0');
    expect(pipCount(), 2, 'SS8: capacity back to base 2');
    expect(document.getElementById('sm-cap-bonus-note').hidden, true, 'SS8: note hidden again');
  });

  regression('SS9: soulmeld effects live in a collapsible ⓘ panel, round-trip intact (S4)', async () => {
    await newCharacter();
    if (!dbReady()) fail('SS9: DB not loaded — re-run after [DB] Loaded appears in console.');
    document.querySelector('[data-tab="tab-equipment"]').click();
    await wait(100);
    const slot = $('.magic-item-slot[data-slot-id="hands"]');
    const q = (s) => slot.querySelector(s);
    const chk = q('.slot-soulmeld-check'); chk.checked = true; chk.dispatchEvent(new Event('change'));

    // Simulate the picker filling the (now hidden) effect fields.
    q('.slot-sm-base').value = 'Claws deal 1d6';
    q('.slot-sm-bind-effect').value = '(Hands) +2 on grapple';

    // The panel + its edit fields start hidden — this is the layout fix (long
    // prose no longer towers in the slot).
    const panel = slot.querySelector('.slot-soulmeld-area > .slot-sm-info');
    expect(panel.hidden, true, 'SS9: effect panel hidden by default');
    expect(panel.querySelector('.slot-sm-edit-fields').hidden, true, 'SS9: edit fields hidden by default');

    // ⓘ opens a read-only view of the effects.
    slot.querySelector('.slot-soulmeld-area > .slot-sm-nameline .btn-sm-info').click();
    expect(panel.hidden, false, 'SS9: ⓘ opens the panel');
    const viewText = panel.querySelector('.slot-sm-info-view').innerText;
    expectIncludes(viewText, 'Claws deal 1d6', 'SS9: view shows the Base effect');
    expectIncludes(viewText, '+2 on grapple', 'SS9: view shows the Bind effect');
    expect(panel.querySelector('.slot-sm-edit-fields').hidden, true, 'SS9: read-only until ✎ Edit');

    // ✎ Edit reveals the editable fields (homebrew / override path).
    panel.querySelector('.btn-sm-edit').click();
    expect(panel.querySelector('.slot-sm-edit-fields').hidden, false, 'SS9: Edit reveals the fields');

    // Save-stability: effect text still round-trips (the fields just moved).
    const blob = Equipment.collectData();
    expect(blob.slotSoulmelds.hands.base, 'Claws deal 1d6', 'SS9: base still collected');
    expect(blob.slotSoulmelds.hands.bindEffect, '(Hands) +2 on grapple', 'SS9: bind still collected');
    const empty = Equipment.collectData(); delete empty.slotSoulmelds;
    Equipment.loadData(empty); await wait(40);
    expect(q('.slot-sm-base').value, '', 'SS9: cleared on load-empty');
    Equipment.loadData(blob); await wait(40);
    expect(q('.slot-sm-base').value, 'Claws deal 1d6', 'SS9: base restored on load');
    expect(slot.querySelector('.slot-soulmeld-area > .slot-sm-info').hidden, true,
      'SS9: panel reset to collapsed after load');
  });

  regression('SS10: Divine Grace (+Serenity swap) + Mental Bastion save recognition (A1/A2)', async () => {
    await newCharacter();
    if (!dbReady()) fail('SS10: DB not loaded — re-run after [DB] Loaded appears in console.');
    // Cha 16 (+3), Wis 12 (+1) so the Cha→Wis Serenity swap is distinguishable.
    set('cha-score', '16');
    set('wis-score', '12');
    await wait(50);

    // Divine Grace (Paladin 2): +Cha (+3) on ALL saves, unconditional.
    await applyClass('Paladin', 2);
    let sv = ClassPicker.getActiveSaveBonuses();
    expect(sv.direct.fort.some(e => e.amount === 3), true, 'SS10: Divine Grace +3 (Cha) on Fort');
    expect(sv.direct.ref.some(e => e.amount === 3) && sv.direct.will.some(e => e.amount === 3), true,
      'SS10: Divine Grace applies to all three saves');

    // Serenity feat swaps Cha → Wis (+1) for Divine Grace.
    Feats.addFeat('Serenity');
    await wait(30);
    sv = ClassPicker.getActiveSaveBonuses();
    expect(sv.direct.fort.some(e => e.amount === 1), true, 'SS10: with Serenity, Divine Grace uses Wis (+1)');
    expect(sv.direct.fort.some(e => e.amount === 3), false, 'SS10: Cha (+3) no longer applied under Serenity');

    // Mental Bastion (Dread Necromancer 4): +2 vs sleep/stun/…, a SITUATIONAL note.
    await applyClass('Dread Necromancer', 4);
    sv = ClassPicker.getActiveSaveBonuses();
    const mb = sv.situational.find(s =>
      /Mental Bastion/i.test(s.source || '') || /sleep, stunning/i.test(s.condition || ''));
    if (!mb) fail('SS10: Mental Bastion did not surface as a situational save note');
    expect(mb.amount, 2, 'SS10: Mental Bastion is +2 at level 4');
    expect(mb.appliesAll, true, 'SS10: Mental Bastion applies to all saves (conditionally)');
  });

  regression('SS11: ACF/sub-level customizations extract grants + real replaces, strike features (C1/C2)', async () => {
    await newCharacter();
    if (!dbReady()) fail('SS11: DB not loaded — re-run after [DB] Loaded appears in console.');
    if (typeof ClassVariants === 'undefined') fail('SS11: ClassVariants missing');

    // --- Extraction correctness (the C1 nuance) ---
    // Kobold Rogue: L1 alters trapfinding + L3 augments trap sense (NOT
    // replacements) — only L8 Improved Uncanny Dodge is truly replaced.
    const subs = ClassVariants.getSubLevels('Rogue');
    const kobold = subs.find(r => r.name === 'Kobold Rogue');
    if (!kobold) fail('SS11: Kobold Rogue sub-level not found for Rogue');
    const kri = ClassVariants.replaceInfo(kobold);
    expect(kri.features.includes('improved uncanny dodge'), true,
      'SS11: Kobold Rogue replaces improved uncanny dodge (L8)');
    expect(kri.features.some(f => /trapfinding|trap sense/.test(f)), false,
      'SS11: altered/augmented features are NOT counted as replaced');
    const kg = ClassVariants.grantsInfo(kobold);
    expectIncludes(kg, 'Rapid Retreat', 'SS11: Kobold Rogue grants summarized from levels');

    // Dungeon Specialist ACF: prose "give up both fast movement and evasion".
    const acfs = ClassVariants.getACFs('Scout');
    const dspec = acfs.find(r => r.name === 'Dungeon Specialist');
    if (!dspec) fail('SS11: Dungeon Specialist ACF not found for Scout');
    const dri = ClassVariants.replaceInfo(dspec);
    expect(dri.features.includes('fast movement') && dri.features.includes('evasion'), true,
      'SS11: Dungeon Specialist replaces fast movement + evasion (parsed from prose)');

    // --- Customization row shows Grants + Replaces (C2) ---
    ClassFeatures.getCustomizations().slice().forEach((_, i) => {}); // no-op; ensure API
    ClassFeatures.addCustomization({
      kind: 'Sub Level', name: 'Kobold Rogue', class: 'Rogue', level: 1,
      race: 'Kobold', replaces: kri.display, replacesFeatures: kri.features.join('|'),
      grants: kg, source: 'Races of the Dragon',
    });
    const row = document.querySelector('#class-customizations-list .cf-customization[data-cust-key="Kobold Rogue|Rogue"]');
    if (!row) fail('SS11: customization row not created');
    expect(!!row.querySelector('.cf-cust-grants'), true, 'SS11: row shows a Grants line');
    expect(!!row.querySelector('.cf-cust-replaces'), true, 'SS11: row shows a Replaces line');
    expectIncludes(row.querySelector('.cf-cust-grants').textContent, 'Rapid Retreat',
      'SS11: Grants line names the gained feature');

    // --- Round-trip: grants + replacesFeatures survive collect/load ---
    const custs = ClassFeatures.getCustomizations();
    const kr = custs.find(c => c.name === 'Kobold Rogue');
    expect(kr.grants.includes('Rapid Retreat'), true, 'SS11: grants collected');
    expect(kr.replacesFeatures.includes('improved uncanny dodge'), true, 'SS11: replacesFeatures collected');
  });

  regression('SS12: Dread Necromancer spells/day land in the correct level box (P1)', async () => {
    await newCharacter();
    if (!dbReady()) fail('SS12: DB not loaded — re-run after [DB] Loaded appears in console.');
    await applyClass('Dread Necromancer', 4);
    // DN L4 spells/day: 6 first-level, 3 second-level, no cantrips. Array is
    // ['-', 6, 3, ...] with a leading level-0 placeholder — the offset must be
    // 0 so index 1 (6) maps to the 1st-level box, not the 2nd.
    const perDay = (lvl) =>
      document.querySelector(`#spells-content .sc-per-day[data-lvl="${lvl}"]`)?.value;
    if (document.querySelector('#spells-content .sc-per-day[data-lvl="1"]') == null)
      fail('SS12: no DN spellcasting panel / slots created');
    expect(perDay(1), '6', 'SS12: 1st-level slots = 6 (was landing in the 2nd box)');
    expect(perDay(2), '3', 'SS12: 2nd-level slots = 3');
    expect(perDay(0) || '', '', 'SS12: no 0-level (cantrip) slots');
  });

  regression('SS13: Empower Turning is not treated as a spell metamagic feat (P2)', async () => {
    await newCharacter();
    if (!dbReady()) fail('SS13: DB not loaded — re-run after [DB] Loaded appears in console.');
    expect(MetamagicCatalog.has('Empower Turning'), false,
      'SS13: Empower Turning removed from the metamagic catalog');
    // DB tags it [General] with no metamagic block, so the spells-tab lookup
    // (DB → catalog fallback) now returns null.
    expect(Spells.lookupMetamagicFromDB('Empower Turning'), null,
      'SS13: lookupMetamagicFromDB returns null for Empower Turning');
    // Sanity: a genuine metamagic feat still resolves.
    const emp = Spells.lookupMetamagicFromDB('Empower Spell');
    expect(!!emp && emp.levelAdjustment === 2, true, 'SS13: Empower Spell still resolves (+2)');
  });

  regression('SS14: bloodline levels count toward max skill ranks (K1)', async () => {
    await newCharacter();
    set('char-level', '10');
    await wait(30);
    const maxClass = () => document.getElementById('max-class-ranks').textContent;
    const maxCross = () => document.getElementById('max-crossclass-ranks').textContent;
    // Baseline (no bloodline): max class ranks = level + 3.
    expect(maxClass(), '13', 'SS14: base max class ranks = 13 at L10');

    // With 3 bloodline levels, the cap folds them in (10 + 3 + 3 = 16). Stub the
    // count so the test doesn't have to drive the full bloodline UI; this
    // exercises the actual fix (character.js reads getTotalBloodlineLevels and
    // recomputes on the bloodline-changed event).
    const orig = Bloodline.getTotalBloodlineLevels;
    Bloodline.getTotalBloodlineLevels = () => 3;
    try {
      document.dispatchEvent(new CustomEvent('bloodline-changed'));
      await wait(30);
      expect(maxClass(), '16', 'SS14: +3 bloodline levels -> max class ranks 16');
      expect(maxCross(), '8', 'SS14: cross-class = 16 / 2 = 8');
    } finally {
      Bloodline.getTotalBloodlineLevels = orig;
      document.dispatchEvent(new CustomEvent('bloodline-changed'));
    }
  });

  regression('SS15: Empower Turning surfaces a chip in the Turn/Rebuke section', async () => {
    await newCharacter();
    const host = document.getElementById('turn-feat-chips');
    if (!host) fail('SS15: #turn-feat-chips container missing');
    const recalc = () =>
      document.getElementById('char-level').dispatchEvent(new Event('input', { bubbles: true }));
    recalc(); await wait(50);
    expect(host.querySelector('.turn-feat-chip'), null, 'SS15: no chip without the feat');

    Feats.addFeat('Empower Turning');
    recalc(); await wait(80);
    const chip = host.querySelector('.turn-feat-chip');
    if (!chip) fail('SS15: chip not rendered after adding Empower Turning');
    expectIncludes(host.querySelector('.turn-feat-chip-name').textContent, 'Empower Turning',
      'SS15: chip names the feat');
    expectIncludes(host.querySelector('.turn-feat-chip-eff').textContent, '1.5',
      'SS15: chip shows the ×1.5 turning-damage effect');
  });

  regression('SS16: multiple bloodlines joined by " // " in the Class & Level label', async () => {
    await newCharacter();
    if (!dbReady()) fail('SS16: DB not loaded — re-run after [DB] Loaded appears in console.');
    const rows = DB.query("SELECT name, source FROM entry WHERE type='bloodline' ORDER BY name LIMIT 2");
    if (rows.length < 2) fail('SS16: need 2 bloodlines in the DB');
    Bloodline.loadData({ _bloodlines: [
      { name: rows[0].name, source: rows[0].source, strength: 'minor', slotsPaid: [true], notes: '' },
      { name: rows[1].name, source: rows[1].source, strength: 'minor', slotsPaid: [true], notes: '' },
    ] });
    await wait(60);
    const label = Bloodline.getClassLevelLabel();
    Bloodline.loadData({ _bloodlines: null });   // cleanup
    expectIncludes(label, ' // ', 'SS16: bloodlines separated by " // " (gestalt-style)');
    if (/,\s/.test(label)) fail('SS16: should not use a comma separator between bloodlines');
  });

  regression('SS17: LoadTracker load-telemetry API is present + tracking', async () => {
    if (typeof LoadTracker !== 'object') fail('SS17: window.LoadTracker missing');
    // Mechanism, not environment outcome — a transient module 404 legitimately
    // flips isReady() false (that's the feature working), so we don't assert it.
    expect(typeof LoadTracker.isReady, 'function', 'SS17: isReady() exposed');
    expect(typeof LoadTracker.onReady, 'function', 'SS17: onReady() exposed');
    const st = LoadTracker.status();
    expect(typeof st.modules.total, 'number', 'SS17: status().modules.total is numeric');
    if (st.modules.total < 40) fail('SS17: expected the full module set tracked, got ' + st.modules.total);
    expect(typeof st.db, 'string', 'SS17: DB state tracked (pending/done/failed)');
    if (!Array.isArray(st.modules.pending)) fail('SS17: status().modules.pending is a list');
  });

  regression('SS18: normalized spells/day land in the correct level boxes (offset retired)', async () => {
    await newCharacter();
    if (!dbReady()) fail('SS18: DB not loaded — re-run after [DB] Loaded appears in console.');
    const perDay = (lvl) =>
      document.querySelector(`#spells-content .sc-per-day[data-lvl="${lvl}"]`)?.value ?? '';
    // Dread Necromancer — no cantrips, casts 1st-9th: box 0 empty, box 1 has slots
    // (previously offset +1, landing 1st-level in the 2nd box).
    await applyClass('Dread Necromancer', 20);
    expect(perDay(0), '', 'SS18: DN has no 0-level (cantrip) box filled');
    expect(perDay(1), '6', 'SS18: DN 1st-level slots in the 1st box');
    expect(perDay(9), '5', 'SS18: DN 9th-level slots present');
    // Reset before the next class — applyClass ADDS a caster panel, and perDay()
    // reads the first panel; a fresh character leaves exactly one.
    await newCharacter();
    // Magewright — a length-6 CANTRIP caster (0-5): box 0 = cantrips (previously
    // the length heuristic shoved them into the 1st box).
    await applyClass('Magewright', 20);
    expect(perDay(0), '3', 'SS18: Magewright cantrips in the 0-level box');
    expect(perDay(5), '2', 'SS18: Magewright 5th-level slots present');
  });

  regression('SS19: worn magic-item save bonuses apply, type-stack, and round-trip (Cloak of Resistance)', async () => {
    await newCharacter();
    const fortTotal = () => parseInt(document.querySelector('#fort-total').textContent) || 0;
    const base = fortTotal();
    // Cloak of Resistance +2 — resistance to all three saves, worn.
    Equipment.addMagicItem({ name: 'Cloak of Resistance +2', worn: true, hasSaveBonuses: true,
      saveBonuses: { fort: '2', ref: '2', will: '2', type: 'resistance' } });
    window.recalcAll(); await wait(20);
    expect(fortTotal(), base + 2, 'SS19: worn resistance +2 raises Fort by 2');
    const agg = Equipment.getActiveSaveBonuses();
    expect(agg.direct.fort.some(e => e.amount === 2 && e.bonus_category === 'resistance'), true,
      'SS19: aggregator exposes the item resistance bonus on Fort');
    // A 2nd resistance bonus must NOT stack (highest wins).
    Equipment.addMagicItem({ name: 'Ring of Resistance +1', worn: true, hasSaveBonuses: true,
      saveBonuses: { fort: '1', ref: '1', will: '1', type: 'resistance' } });
    window.recalcAll(); await wait(20);
    expect(fortTotal(), base + 2, 'SS19: a 2nd resistance bonus does not stack (max wins)');
    // A different type (luck) DOES stack.
    const items = $$('.magic-item-entry');
    const ring = items[items.length - 1];
    ring.querySelector('.mi-save-type').value = 'luck';
    ring.querySelector('.mi-save-type').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(20);
    expect(fortTotal(), base + 3, 'SS19: resistance (+2) + luck (+1) stack to +3');
    // Unworn items drop out.
    const cloak = items[0];
    cloak.querySelector('.mi-worn').checked = false;
    cloak.querySelector('.mi-worn').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(20);
    expect(fortTotal(), base + 1, 'SS19: unworn cloak drops out (only luck +1 remains)');
    // collect -> load round-trip: identical total + persisted fields intact.
    const blob = App.collectData();
    const saved = (blob.magicItems || []).find(m => m.hasSaveBonuses && m.name === 'Cloak of Resistance +2');
    if (!saved) fail('SS19: cloak save bonuses not captured by collectData');
    expect(saved.saveBonuses.type, 'resistance', 'SS19: saved bonus type persists');
    expect(String(saved.saveBonuses.fort), '2', 'SS19: saved per-save amount persists');
    App.loadData(blob);
    window.recalcAll(); await wait(20);
    expect(fortTotal(), base + 1, 'SS19: Fort total identical after a collect/load round-trip');
  });

  regression('SS22: item-name auto-fill applies, respects overrides, round-trips', async () => {
    await newCharacter();
    document.querySelector('.tab[data-tab="tab-equipment"]').click();
    const named = async (name) => {
      Equipment.addMagicItem({});
      const it = [...document.querySelectorAll('.magic-item-entry')].pop();
      const nm = it.querySelector('.mi-name');
      nm.value = name;
      nm.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(120);
      return it;
    };
    const fortTotal = () => parseInt(document.querySelector('#fort-total').textContent, 10) || 0;
    const base = fortTotal();

    const cloak = await named('Cloak of Resistance +2');
    expect(cloak.querySelector('.mi-save-toggle').checked, true,
      'SS22: save section auto-enabled');
    expect(cloak.querySelector('.mi-save-fort').value, '2', 'SS22: fort filled from the name');
    expect(cloak.querySelector('.mi-save-type').value, 'resistance', 'SS22: typed resistance');
    expect(fortTotal(), base + 2, 'SS22: the bonus reaches the Fort total');

    // Renaming to another family clears what the OLD name filled...
    const nm = cloak.querySelector('.mi-name');
    nm.value = 'Headband of Intellect +4';
    nm.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(120);
    expect(cloak.querySelector('.mi-save-fort').value, '',
      'SS22: the previous name\'s auto-fill is cleared on rename');
    expect(cloak.querySelector('.mi-ab-int').value, '4', 'SS22: INT filled from the new name');

    // ...but a value the PLAYER typed is never clobbered.
    const intBox = cloak.querySelector('.mi-ab-int');
    intBox.value = '6';
    intBox.dispatchEvent(new Event('input', { bubbles: true }));
    nm.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(120);
    expect(intBox.value, '6', 'SS22: a hand-edited value survives a re-run');

    // An unreadable name must fill nothing at all.
    const junk = await named('Some Homebrew Doodad');
    expect(junk.querySelector('.mi-auto-hint').style.display, 'none',
      'SS22: an unrecognised item shows no hint');
    expect(junk.querySelector('.mi-save-toggle').checked, false,
      'SS22: and enables nothing');

    // Auto-filled values are ordinary field values, so they must round-trip.
    const blob = App.collectData();
    const saved = (blob.magicItems || []).find(m => m.name === 'Headband of Intellect +4');
    if (!saved) fail('SS22: the auto-filled item was not captured by collectData');
    expect(String(saved.abilityBonuses.INT), '6', 'SS22: the override persists, not the auto value');
    App.loadData(blob);
    window.recalcAll(); await wait(60);
    const reloaded = [...document.querySelectorAll('.magic-item-entry')]
      .find(e => e.querySelector('.mi-name').value === 'Headband of Intellect +4');
    if (!reloaded) fail('SS22: the item did not survive the load');
    expect(reloaded.querySelector('.mi-ab-int').value, '6',
      'SS22: value identical after a collect/load round-trip');
  });

  regression('SS21: item-borne armour bonuses reach the Defense Onion armor box', async () => {
    await newCharacter();
    const box = (id) => document.getElementById(id).textContent;
    const setF = (id, v) => {
      const e = document.getElementById(id);
      if (e.type === 'checkbox') e.checked = v; else e.value = v;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    };
    // Bracers of Armor +4, worn, with NO worn armour. The AC total was always
    // right, but #ac-armor was written from the Equipment tab's armour field
    // alone and reported 0 — the bonus was invisible in its own box.
    Equipment.addMagicItem({
      name: 'Bracers of Armor +4', slot: 'arms', worn: true, isProtective: true,
      acBonuses: [{ ac: 4, type: 'Armor', touch: false, flatfooted: true }],
    });
    await wait(40); window.recalcAll(); await wait(80);
    expect(box('ac-armor'), '4', 'SS21: item armour bonus shows in the armor box');
    const withItemOnly = parseInt(box('ac-total'), 10);
    // Same-type bonuses do NOT stack in 3.5 — the higher applies, and the box
    // must show whichever won, not the sum.
    setF('armor-ac-bonus', '6'); setF('armor-worn', true);
    await wait(40); window.recalcAll(); await wait(80);
    expect(box('ac-armor'), '6', 'SS21: worn armour +6 outranks the item +4');
    expect(parseInt(box('ac-total'), 10), withItemOnly + 2,
      'SS21: AC total rises by the DIFFERENCE (6-4), i.e. no stacking');
    setF('armor-ac-bonus', '2');
    await wait(40); window.recalcAll(); await wait(80);
    expect(box('ac-armor'), '4', 'SS21: the better item wins when worn armour is weaker');
    // Shield stays its own bucket.
    setF('shield-ac-bonus', '3'); setF('shield-worn', true);
    await wait(40); window.recalcAll(); await wait(80);
    expect(box('ac-shield'), '3', 'SS21: shield box unaffected by armour resolution');
    expect(box('ac-armor'), '4', 'SS21: armour box unaffected by the shield');
  });

  regression('SS20: feat rows stay aligned regardless of the prereq badge glyph', async () => {
    await newCharacter();
    document.querySelector('.tab[data-tab="tab-feats"]').click();
    // The prereq badge sits between the flex:1 name box and the row edge, and
    // its glyph changes with status. Every glyph measures differently (· 24.5px,
    // ✓ 25.0, ✗ 25.9, — 28.4), so an intrinsically-sized badge propagates those
    // pixels backwards and each row ends up a different width. Pin the badge and
    // the name boxes agree.
    const container = document.getElementById('feats-container');
    container.innerHTML = '';
    // Cover every row shape: DB-matched (structured namebox), free text
    // (textarea), a choice feat (spec input), and a derived source-tagged grant.
    ['Power Attack', 'Toughness', 'Some Homebrew Thing', 'Weapon Focus']
      .forEach(f => Feats.addFeat(f));
    Feats.addFeat('Extra Rage', { sourceLabel: 'Barbarian 1' });
    const rows = [...container.querySelectorAll('.feat-row')];
    if (rows.length < 5) fail('SS20: expected 5 feat rows, got ' + rows.length);
    const glyphs = ['·', '✓', '✗', '?', '—'];
    rows.forEach((r, i) => {
      r.querySelector('.btn-feat-prereq').textContent = glyphs[i];
    });
    await wait(20);
    const widths = rows.map(r => {
      const main = r.querySelector('.feat-namebox') || r.querySelector('.feat-entry');
      const b = main.getBoundingClientRect();
      return { w: Math.round(b.width), right: Math.round(b.right) };
    });
    // Guard the guard: a hidden tab measures everything as 0, which would
    // read as "all equal" and pass vacuously.
    if (!widths.every(x => x.w > 100)) {
      fail('SS20: name boxes measured ' + JSON.stringify(widths) +
           ' — tab not laid out, measurement is vacuous');
    }
    const distinctW = new Set(widths.map(x => x.w));
    const distinctR = new Set(widths.map(x => x.right));
    if (distinctW.size !== 1 || distinctR.size !== 1) {
      fail('SS20: feat rows misaligned across badge glyphs — widths ' +
           [...distinctW].join('/') + ', right edges ' + [...distinctR].join('/'));
    }
    container.innerHTML = '';
  });

  regression('SA-INFO: Special Abilities ⓘ resolves racial traits + skill tricks + class features', async () => {
    await newCharacter();
    if (!dbReady()) fail(
      'SA-INFO: DB not loaded — re-run after [DB] Loaded appears in console.');
    const cont = document.getElementById('special-abilities-container');

    // Helper: open the ⓘ panel on the special-ability row whose text
    // starts with `frag`, return its innerText, then collapse again.
    const panelTextFor = (frag) => {
      const row = $$('#special-abilities-container .feat-row').find(r =>
        (r.querySelector('.special-ability-entry')?.value || '').startsWith(frag));
      if (!row) return null;
      row.querySelector('.btn-feat-info').click();
      const txt = row.querySelector('.feat-rules')?.innerText || '';
      row.querySelector('.btn-feat-info').click();   // collapse
      return txt;
    };

    // 1. PHB racial trait. The race-picker auto-fills NAME ONLY; the
    //    description is surfaced on demand via the ⓘ panel (which matches
    //    by name). Previously this row carried the full description inline
    //    AND hit the "No class prefix detected" dead-end on ⓘ.
    set('char-race', 'Dwarf');
    await wait(200);
    const stoneRow = $$('#special-abilities-container .feat-row').find(r =>
      (r.querySelector('.special-ability-entry')?.value || '').startsWith('Stonecunning'));
    if (!stoneRow) fail('SA-INFO: Dwarf did not auto-fill a Stonecunning row');
    expect(stoneRow.querySelector('.special-ability-entry').value, 'Stonecunning',
      'SA-INFO: racial trait auto-fills NAME ONLY (no inline description)');
    const stone = panelTextFor('Stonecunning');
    expectIncludes(stone, 'Stonecunning', 'SA-INFO: racial panel shows the trait name');
    expectIncludes(stone, 'Dwarf racial trait', 'SA-INFO: racial panel attributes the race');
    expectIncludes(stone, 'racial bonus on Search', 'SA-INFO: racial panel resolves the description by NAME');
    if (/No class prefix detected/i.test(stone)) {
      fail('SA-INFO: racial trait still hits the class-prefix dead-end');
    }

    // 2. Splat race with a typed trait — the [Ex]/[Su]/[Sp] tag surfaces.
    //    Use the Stormwrack printing by its ACTUAL name, "Elf, Aquatic"
    //    (the bare "Aquatic Elf" now exact-matches the UA environmental
    //    variant, whose low-light is the plain ×2 — no "Superior" trait).
    //    Stormwrack's aquatic elf carries the typed Superior Low-Light
    //    Vision (Ex) racial trait. (DB fix 2026-07-05: the appendix
    //    sample-NPC stat block had been clobbering the Ch.2 race writeup.)
    set('char-race', 'Elf, Aquatic');
    await wait(200);
    const slv = panelTextFor('Superior Low-Light Vision');
    if (slv == null) fail('SA-INFO: Elf, Aquatic did not auto-fill Superior Low-Light Vision');
    expectIncludes(slv, '[Ex]', 'SA-INFO: typed racial trait surfaces its Ex/Su/Sp tag');

    // 3. Skill trick (special-ability-picker format) resolves + shows Benefit.
    Feats.addSpecialAbility('Acrobatic Backstab · Movement skill trick\nplaceholder');
    const trick = panelTextFor('Acrobatic Backstab');
    expectIncludes(trick, 'Benefit:', 'SA-INFO: skill-trick panel shows the Benefit line');
    expectIncludes(trick, 'Complete Scoundrel', 'SA-INFO: skill-trick panel shows the source');

    // 4. Class feature (class-picker format) still resolves (regression).
    Feats.addSpecialAbility('[Barbarian 1] Fast Movement');
    const cf = panelTextFor('[Barbarian 1] Fast Movement');
    expectIncludes(cf, 'Fast Movement', 'SA-INFO: class-feature panel still resolves');
    expectIncludes(cf, 'Barbarian', 'SA-INFO: class-feature panel attributes the class');

    // 5. Custom / homebrew falls back gracefully (no false DB match).
    Feats.addSpecialAbility('Totally Invented Homebrew Knack');
    const custom = panelTextFor('Totally Invented Homebrew Knack');
    expectIncludes(custom, 'custom or homebrew', 'SA-INFO: unmatched entry falls back gracefully');
  });

  regression('SA-INFO-CR: Special Abilities ⓘ resolves creature-as-race abilities', async () => {
    await newCharacter();
    if (!dbReady()) fail(
      'SA-INFO-CR: DB not loaded — re-run after [DB] Loaded appears in console.');

    const panelTextFor = (frag) => {
      const r = $$('#special-abilities-container .feat-row').find(row =>
        (row.querySelector('.special-ability-entry')?.value || '').startsWith(frag));
      if (!r) return null;
      r.querySelector('.btn-feat-info').click();
      const txt = r.querySelector('.feat-rules')?.innerText || '';
      r.querySelector('.btn-feat-info').click();
      return txt;
    };

    // Hound Archon migrated to a type=race entry (MM I v3 walk), so it routes
    // through the MAIN race-picker. For a monster race the picker auto-fills
    // the creature's INDIVIDUAL special abilities (tagged data-from-race), and
    // the ⓘ resolver renders each against the creature entry + its subtype-
    // trait rule (Aura of Menace's full prose lives in "Archon Traits").
    set('char-race', 'Hound Archon');   // unified Race field
    await wait(400);
    const fromCreature = $$('#special-abilities-container ' +
      '[data-from-race="1"]');
    if (!fromCreature.length) fail(
      'SA-INFO-CR: race-picker did not auto-fill any creature special abilities');
    expectValue('#char-race', 'Hound Archon',
      'SA-INFO-CR: race-picker writes the creature name into #char-race');

    // Tier 1 — Aura of Menace resolves to FULL rules. Its prose lives in the
    // "Archon Traits" subtype rule (the stat block is terse), so this also
    // guards the subtype-trait merge + fullest-description preference.
    const aura = panelTextFor('Aura of menace');
    if (aura == null) fail('SA-INFO-CR: no "Aura of menace" row auto-filled');
    expectIncludes(aura, 'Aura of Menace', 'SA-INFO-CR: ability name resolves');
    expectIncludes(aura, '[Su]', 'SA-INFO-CR: surfaces the Su/Sp/Ex kind');
    expectIncludes(aura, 'creature ability', 'SA-INFO-CR: panel attributes the creature');
    expectIncludes(aura, 'righteous aura', 'SA-INFO-CR: full subtype-trait description rendered');
    if (/custom or homebrew/i.test(aura)) {
      fail('SA-INFO-CR: a real creature ability hit the homebrew fallback');
    }

    // Tier 2 — a listed quality with NO detail block (DR isn't an Archon
    // subtype trait) gets the honest stub, NOT "custom or homebrew".
    const dr = panelTextFor('damage reduction 10/evil');
    if (dr == null) fail('SA-INFO-CR: no "damage reduction 10/evil" row auto-filled');
    expectIncludes(dr, 'No detailed rules text',
      'SA-INFO-CR: undetailed creature ability gets the honest stub');
    if (/custom or homebrew/i.test(dr)) {
      fail('SA-INFO-CR: undetailed creature ability hit the homebrew fallback');
    }

    // Save-stability — the resolver keys off #char-race, which Character
    // persists, so resolution survives a reload (the ability rows persist
    // as plain text). Verify the creature name is collected, and that a
    // value-only restore (no picker re-apply) still resolves the panel.
    const blob = Character.collectData();
    expect(blob['char-race'], 'Hound Archon',
      'SA-INFO-CR: creature name persists in #char-race');
    document.getElementById('char-race').value = '';
    Character.loadData(blob, () => 0);
    expectValue('#char-race', 'Hound Archon',
      'SA-INFO-CR: #char-race round-trips through loadData');
    const auraAfter = panelTextFor('Aura of menace');
    expectIncludes(auraAfter, 'Aura of Menace',
      'SA-INFO-CR: panel still resolves after a value-only #char-race restore');
  });

  // ============================================================
  // Class-A save-stability net — AUTO-EXPANDING round-trip tests
  // ============================================================
  //
  // A string of save-loss bugs (companion compType, class _multiclass,
  // gear-rules crash, bloodline slot, soulmeld checkbox) share one root
  // cause: a field collectData emits is not restored identically by
  // loadData (or vice versa). The hand-written SS# regressions above each
  // guard ONE field; this section guards the WHOLE blob generically, so
  // NEW fields are covered automatically with no per-field test to add.
  //
  // Property under test is a FIXED POINT:
  //     loadData(x); A = collectData();   // first load normalizes
  //     loadData(A); B = collectData();   // second must not change it
  //     assert deepEqual(A, B)
  // Any field collected-but-not-loaded, loaded-into-a-different-shape, or
  // dropped breaks the fixed point and names itself in the diff. Two
  // rounds (not one) so legacy-save migration converges on the first load
  // and doesn't false-fail.
  //
  // Seeded two ways, both auto-expanding: (1) real library saves — every
  // character you own; new saves + new fields covered for free; (2) a
  // fuzz-filled synthetic character — covers new plain fields before any
  // save uses them.

  // Stable (sorted-key) stringify so object key order doesn't read as a diff.
  function rtStableStringify(v) {
    return JSON.stringify(v, function (k, val) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        return Object.keys(val).sort().reduce((o, kk) => { o[kk] = val[kk]; return o; }, {});
      }
      return val;
    });
  }
  // First divergence path (or null when equal) — turns a failure into an
  // actionable "this exact field didn't round-trip".
  function rtFirstDiff(a, b, path) {
    path = path || '$';
    const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
    const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
    if (ta !== tb) return `${path}: type ${ta}≠${tb} (${rtStableStringify(a)} vs ${rtStableStringify(b)})`;
    if (ta === 'object') {
      for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
        const d = rtFirstDiff(a[k], b[k], `${path}.${k}`);
        if (d) return d;
      }
      return null;
    }
    if (ta === 'array') {
      if (a.length !== b.length) return `${path}: array length ${a.length}≠${b.length}`;
      for (let i = 0; i < a.length; i++) {
        const d = rtFirstDiff(a[i], b[i], `${path}[${i}]`);
        if (d) return d;
      }
      return null;
    }
    if (a !== b) return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
    return null;
  }

  // Collapse benign "absent ↔ empty" differences: null/undefined/''/[]/{}
  // all canonicalize to "absent" (dropped). A loaded-from-nothing field
  // that comes back as [] must NOT read as data loss — but a real value
  // ("RT5") that comes back empty/absent still diffs (value vs dropped).
  function rtCanonical(v) {
    if (v === null || v === undefined || v === '') return undefined;
    if (Array.isArray(v)) {
      const a = v.map(rtCanonical);
      return a.length ? a : undefined;     // keep element positions; drop only a wholly-empty array
    }
    if (typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) {
        const cv = rtCanonical(v[k]);
        if (cv !== undefined) o[k] = cv;
      }
      return Object.keys(o).length ? o : undefined;
    }
    return v;
  }
  // Collect up to `limit` divergence paths (not just the first) so one run
  // gives the full diagnostic instead of whack-a-mole.
  function rtAllDiffs(a, b, limit, path, out) {
    limit = limit || 15; path = path || '$'; out = out || [];
    if (out.length >= limit) return out;
    const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
    const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
    if (ta !== tb) { out.push(`${path}: ${ta}(${JSON.stringify(a)}) vs ${tb}(${JSON.stringify(b)})`); return out; }
    if (ta === 'object') {
      for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
        rtAllDiffs(a[k], b[k], limit, `${path}.${k}`, out); if (out.length >= limit) break;
      }
      return out;
    }
    if (ta === 'array') {
      if (a.length !== b.length) { out.push(`${path}: array length ${a.length}≠${b.length}`); return out; }
      for (let i = 0; i < a.length; i++) { rtAllDiffs(a[i], b[i], limit, `${path}[${i}]`, out); if (out.length >= limit) break; }
      return out;
    }
    if (a !== b) out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    return out;
  }

  // DIRECTIONAL loss/mutation walk: report only where `a` (the pre-load
  // collect) held a value that `b` (post-load) failed to preserve. Fields
  // `b` GAINS (derived-on-load defaults like history_reconstructed) are
  // ignored — this guards "did I lose/corrupt what I had", which is the
  // "field silently not saved" class. Inputs are pre-canonicalized, so
  // `a` carries only real (non-empty) values.
  function rtLossDiffs(a, b, limit, path, out) {
    limit = limit || 15; path = path || '$'; out = out || [];
    if (out.length >= limit || a === undefined) return out;
    if (b === undefined) { out.push(`${path}: LOST ${JSON.stringify(a)}`); return out; }
    const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
    const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
    if (ta !== tb) { out.push(`${path}: ${ta}(${JSON.stringify(a)}) → ${tb}(${JSON.stringify(b)})`); return out; }
    if (ta === 'object') {
      for (const k of Object.keys(a)) { rtLossDiffs(a[k], b[k], limit, `${path}.${k}`, out); if (out.length >= limit) break; }
      return out;
    }
    if (ta === 'array') {
      if (a.length !== b.length) { out.push(`${path}: array ${a.length}→${b.length}`); return out; }
      for (let i = 0; i < a.length; i++) { rtLossDiffs(a[i], b[i], limit, `${path}[${i}]`, out); if (out.length >= limit) break; }
      return out;
    }
    if (a !== b) out.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    return out;
  }

  function appCollect() {
    if (!(window.App && typeof App.collectData === 'function'))
      fail('round-trip: window.App.collectData not exposed (app.js)');
    return App.collectData();
  }
  // Deep-copy on the way in: some module loaders mutate the blob they're
  // given, which would corrupt the A we compare against B.
  function appLoad(blob) {
    if (!(window.App && typeof App.loadData === 'function'))
      fail('round-trip: window.App.loadData not exposed (app.js)');
    App.loadData(JSON.parse(JSON.stringify(blob)));
  }

  // The reusable assertion: load → collect (A, normalized) → load A →
  // collect (B) → A must deep-equal B.
  async function assertFixedPoint(startBlob, label) {
    appLoad(startBlob);
    await wait(70);
    const A = appCollect();
    appLoad(A);
    await wait(70);
    const B = appCollect();
    const diff = rtFirstDiff(rtCanonical(A), rtCanonical(B), '$');
    if (diff) fail(`${label}: not a save/load fixed point → ${diff}`);
  }

  // Fuzz every plain editable control with a distinctive value so the
  // fixed-point check runs on a richly non-default character. v1 sets
  // text/number/select (not checkbox/radio — those cascade panel
  // creation; the library saves cover that state). Returns count set.
  function fuzzFillSheet() {
    // Skip the test panel, modals, and NAVIGATION/ACTION controls that
    // trigger side effects rather than holding saved data. #character-select
    // is the load-saved-character dropdown — setting it fires loadCharacter()
    // which async-clobbers the whole sheet mid-test (it is not a saved field).
    const SKIP_ANCESTORS = ['[id*="playfeel"]', '#character-select',
      '#lookup-modal', '#book-filter-modal', '#homebrew-modal',
      '.modal', '.modal-overlay', '.lookup-overlay'];
    const inScope = (el) => {
      if (el.disabled || el.readOnly) return false;
      if (el.classList.contains('calc-field')) return false;
      const t = (el.type || 'text').toLowerCase();
      if (['hidden', 'file', 'button', 'submit', 'reset', 'image', 'color'].includes(t)) return false;
      for (const sel of SKIP_ANCESTORS) { if (el.closest(sel)) return false; }
      return true;
    };
    let i = 0;
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (!inScope(el)) continue;
      const tag = el.tagName.toLowerCase();
      const type = (el.type || 'text').toLowerCase();
      try {
        if (tag === 'select') {
          const opts = Array.from(el.options).filter(o => !o.disabled);
          if (opts.length <= 1) continue;
          el.value = opts[opts.length - 1].value;
        } else if (type === 'checkbox' || type === 'radio') {
          continue;
        } else if (type === 'number' || type === 'range') {
          el.value = String((i % 18) + 1);
        } else {
          el.value = 'RT' + i;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        i++;
      } catch (e) { /* skip one uncooperative control */ }
    }
    return i;
  }

  regression('SS-RT1: fuzz-filled fields survive a save/load round trip', async () => {
    // Round-trip FIDELITY (not just a fixed point): a value collectData
    // emits must come back identical after loadData — that's the "field
    // silently not saved" class. Compare the pre-load collect against the
    // post-load collect; absent↔empty normalization is canonicalized away,
    // so a real value coming back empty/absent still fails.
    await newCharacter();
    const n = fuzzFillSheet();
    if (n < 5) fail(`SS-RT1: fuzz set only ${n} fields — walker found nothing to fill`);
    const raw = appCollect();
    appLoad(raw);
    await wait(90);
    const after = appCollect();
    const diffs = rtLossDiffs(rtCanonical(raw), rtCanonical(after), 15);
    if (diffs.length)
      fail(`SS-RT1: ${n} fields fuzzed — ${diffs.length} field(s) lost/mutated on reload:\n  ` +
           diffs.join('\n  '));
    await newCharacter();
  });

  regression('SS-RT2: library saves round-trip to a fixed point', async () => {
    if (!(window.SaveBackend && typeof SaveBackend.list === 'function'))
      fail('SS-RT2: SaveBackend not available');
    const all = await SaveBackend.list();
    const lib = all.filter(e => (e.folder || '').split('/')[0] === 'library');
    const pool = lib.length ? lib : all;
    if (!pool.length) { console.log('[playfeel] SS-RT2: no saves to check — skipping'); return; }
    // Sample for speed in the default run; full sweep = PlayFeel.runSaveRoundTrip().
    const SAMPLE = 12;
    const step = Math.max(1, Math.floor(pool.length / SAMPLE));
    const picked = [];
    for (let i = 0; i < pool.length && picked.length < SAMPLE; i += step) picked.push(pool[i]);
    console.log(`[playfeel] SS-RT2: checking ${picked.length} of ${pool.length} library saves ` +
                `(sampled; PlayFeel.runSaveRoundTrip() runs all)`);
    const failures = [];
    for (const entry of picked) {
      let blob;
      try { blob = await SaveBackend.load(entry.qualified); }
      catch (e) { failures.push(`${entry.qualified}: load threw ${e.message}`); continue; }
      if (!blob) continue;
      try { await assertFixedPoint(blob, `save "${entry.qualified}"`); }
      catch (e) { failures.push(e.message); }
    }
    await newCharacter();   // leave the sheet clean for downstream tests
    if (failures.length)
      fail(`SS-RT2: ${failures.length}/${picked.length} saves not fixed points:\n  ` +
           failures.slice(0, 6).join('\n  '));
  });

  regression('SS-FLAG: entry review flag persists, reloads, and resolves', async () => {
    if (!window.ReviewFlags) fail('SS-FLAG: ReviewFlags not loaded');
    const ref = { name: '__pf_test_entry__', source: 'Playfeel', type: 'creature' };
    // Clean any residue from a prior aborted run.
    for (const f of ReviewFlags.getAll().filter(f => f.ref && f.ref.name === ref.name))
      await ReviewFlags.remove(f.id);
    await wait(50);
    await ReviewFlags.add(ref, 'pf test note');
    expect(ReviewFlags.isFlagged(ref), true, 'SS-FLAG: entry flagged after add');
    expect(ReviewFlags.openFor(ref).length, 1, 'SS-FLAG: exactly one open flag');
    // Persistence round-trip: re-init from the store, flag must survive.
    await ReviewFlags.init();
    await wait(50);
    expect(ReviewFlags.isFlagged(ref), true, 'SS-FLAG: flag survives reload (persisted to store)');
    const id = ReviewFlags.openFor(ref)[0].id;
    await ReviewFlags.resolve(id);
    expect(ReviewFlags.isFlagged(ref), false, 'SS-FLAG: resolved flag no longer counts as open');
    await ReviewFlags.remove(id);   // leave the store clean
  });

  regression('SS-FLAG: sheet report persists and resolves', async () => {
    if (!window.SheetReports) fail('SS-FLAG: SheetReports not loaded');
    const before = SheetReports.getOpen().length;
    const rep = await SheetReports.add('bug', '__pf_test_report__');
    expect(SheetReports.getOpen().length, before + 1, 'SS-FLAG: report added to open set');
    await SheetReports.init();
    await wait(50);
    const found = SheetReports.getAll().find(r => r.note === '__pf_test_report__');
    if (!found) fail('SS-FLAG: sheet report did not survive reload (not persisted)');
    await SheetReports.resolve(found.id);
    expect(SheetReports.getOpen().some(r => r.id === found.id), false,
      'SS-FLAG: resolved report no longer open');
    await SheetReports.remove(found.id);   // leave the store clean
  });

  // ---- GR: soulmeld granted effects + granted attacks (2026-08-21) --------
  //
  // WHAT THESE COVER THAT THE NODE SUITE CANNOT. tests/test_pickers.js guards
  // the DATA (every granted attack states its damage, every bound item names
  // its chakra) and the WIRING (the module reads the field, the destinations
  // are called). Neither can answer the question that matters: shape a
  // soulmeld and does a row appear with the right number in it?
  //
  // That gap is not hypothetical. The whole feature was built against a fully
  // green Node suite while two real bugs sat in it — the damage total lagged a
  // pass behind the essentia pips, and a rider's descriptive note was being
  // passed as its CONDITION, which made damage the claw deals on every swing
  // display as situational and drop out of the total. Both were invisible
  // until someone moved a pip and read the number.

  // Shape a soulmeld into the totem slot with N essentia, bound.
  async function shapeTotem(name, essentia, bound = true) {
    // ORDER MATTERS. The essentia pips for a slot are rendered when the
    // CAPACITY changes, and only for slots that already hold a soulmeld — so
    // setting the capacity before the name renders nothing, and no amount of
    // waiting fixes it. Name first, capacity second. (Found by probing the
    // live DOM: the only pips on the page belonged to a different slot.)
    set('totem-sm-name', name);
    const b = $('#totem-sm-bound');
    if (b) { b.checked = !!bound; b.dispatchEvent(new Event('change', { bubbles: true })); }
    set('sm-max-soulmelds', 4);
    set('sm-max-binds', 2);
    set('sm-base-capacity', 4);
    set('sm-max-essentia', 8);
    window.recalcAll();
    // The pips are rendered FROM the capacity, so they do not exist until a
    // pass after it is set — and not reliably on the first one. Poll rather
    // than sleeping a guessed interval: a fixed wait here made this flaky in
    // exactly the way that gets a test deleted instead of fixed.
    let pips = [];
    for (let tries = 0; tries < 20; tries++) {
      await wait(50);
      pips = document.querySelectorAll('#totem-essentia-pips .essentia-pip');
      if (pips.length) break;
    }
    if (!pips.length) fail('shapeTotem: essentia pips never rendered');
    for (let i = 0; i < essentia && i < pips.length; i++) pips[i].click();
    await wait(200);
    return pips.length;
  }

  // The FIRST attack row, creating one if the sheet has none. `#btn-new`
  // empties the attacks container outright, so a fresh character has zero rows
  // — the blank one exists only on an untouched page load.
  async function firstAttackRow() {
    let row = $('#attacks-container .attack-entry');
    if (!row) {
      $('#btn-add-attack').click();
      await wait(250);
      row = $('#attacks-container .attack-entry');
    }
    if (!row) fail('firstAttackRow: could not create an attack row');
    return row;
  }

  // Fill an attack row as a weapon of the player's own.
  function fillWeaponRow(row, { name, crit, dice, style }) {
    row.querySelector('.atk-name').value = name;
    if (crit != null) row.querySelector('.atk-crit').value = crit;
    if (dice != null) row.querySelector('.dmg-dice').value = dice;
    row.querySelector('.dmg-style').value = style;
    ['.atk-name', '.atk-crit', '.dmg-dice'].forEach(sel =>
      row.querySelector(sel).dispatchEvent(new Event('input', { bubbles: true })));
    row.querySelector('.dmg-style').dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Incarnum capacity. TWO different fields, and only one of them makes pips:
  //   #sm-base-capacity  the per-soulmeld essentia CAP — this is what
  //                      equipment.js#getCapacity reads to build the pips
  //   #sm-max-essentia   the character's whole essentia POOL, a separate
  //                      number that does not affect any slot's pip count
  // Setting only the pool renders no pips at all, silently, which is how GR9
  // first failed. One helper so the distinction is made once.
  function setIncarnumCapacity(perSoulmeld = 4, pool = 8) {
    set('sm-base-capacity', perSoulmeld);
    set('sm-max-essentia', pool);
    set('sm-max-soulmelds', 4);
    set('sm-max-binds', 2);
  }

  // Bind a soulmeld into a named body slot (not the totem).
  function bindSlot(slotId, name) {
    const slot = document.querySelector(`.magic-item-slot[data-slot-id="${slotId}"]`);
    if (!slot) fail(`bindSlot: no ${slotId} slot`);
    const sw = slot.querySelector('.slot-soulmeld-check');
    if (sw && !sw.checked) { sw.checked = true; sw.dispatchEvent(new Event('change', { bubbles: true })); }
    const n = slot.querySelector('.slot-sm-name');
    n.value = name;
    n.dispatchEvent(new Event('input', { bubbles: true }));
    n.dispatchEvent(new Event('change', { bubbles: true }));
    const b = slot.querySelector('.slot-sm-bound');
    b.checked = true;
    b.dispatchEvent(new Event('change', { bubbles: true }));
    return slot;
  }

  function grantedRow(attackName) {
    return document.querySelector(
      `#attacks-container .attack-entry[data-from-class^="soulmeld:"][data-from-class$="|${attackName}"]`);
  }

  regression('GR1: shaping a soulmeld creates its attack row, resolved', async () => {
    // `typeof` on the BARE identifier, not window.SoulmeldEffects: the module
    // is const-declared, so it never lands on window and the window check is
    // always false. Documented trap; it cost a session once already.
    if (typeof SoulmeldEffects === 'undefined') fail('GR1: soulmeld-effects.js not loaded');
    await newCharacter();
    setAbilities({ STR: 18 });
    await shapeTotem('Kruthik Claws', 3);

    const row = grantedRow('Claw');
    if (!row) fail('GR1: no managed attack row for the granted claws');
    expect(row.querySelector('.dmg-dice').value, '1d6', 'GR1: claw die');
    expect(row.querySelector('.dmg-style').value, 'natural',
      'GR1: a granted natural attack uses a natural fighting style, so the '
      + 'sheet supplies the Strength multiplier and Power Attack per RAW');
    // Str 18 -> +4 at x1 for a primary natural attack.
    expect(row.querySelector('.dmg-total').textContent, '1d6+4 plus 3d4 acid',
      'GR1: the acid rider scales with essentia (3 points = 3d4) and, being '
      + 'UNCONDITIONAL, is part of the headline damage');
  });

  regression('GR2: moving an essentia pip moves the damage in the same pass',
    async () => {
      await newCharacter();
      setAbilities({ STR: 18 });
      await shapeTotem('Kruthik Claws', 3);
      const row = grantedRow('Claw');
      if (!row) fail('GR2: no managed attack row');
      const at3 = row.querySelector('.dmg-total').textContent;

      document.querySelectorAll('#totem-essentia-pips .essentia-pip')[3].click();
      await wait(200);
      const at4 = row.querySelector('.dmg-total').textContent;

      // The REGRESSION: this used to lag one recalc behind, so the rider
      // visibly read 4d4 while the total still showed the 3-essentia figure
      // until something unrelated triggered another pass.
      expect(at3, '1d6+4 plus 3d4 acid', 'GR2: 3 essentia');
      expect(at4, '1d6+4 plus 4d4 acid',
        'GR2: the total must follow the pip in the SAME pass, not the next one');
    });

  regression('GR3: unbinding removes the row; a hand-edited row is never taken',
    async () => {
      await newCharacter();
      setAbilities({ STR: 18 });
      await shapeTotem('Kruthik Claws', 2);
      if (!grantedRow('Claw')) fail('GR3: no managed row to start from');

      const b = $('#totem-sm-bound');
      b.checked = false;
      b.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(200);
      expect(!!grantedRow('Claw'), false,
        'GR3: the claws come from the TOTEM bind, so unbinding removes them');

      b.checked = true;
      b.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(200);
      const row = grantedRow('Claw');
      if (!row) fail('GR3: re-binding did not restore the row');

      // Simulate the state AFTER a real keystroke handed the row over. A
      // synthetic event cannot set isTrusted — which IS the guard — so this
      // asserts the property that actually matters: once the marker is gone,
      // the sync never touches or deletes the row again.
      delete row.dataset.fromClass;
      row.querySelector('.atk-name').value = 'My Own Claws';
      // Untick `fill damage` first, which is what a player does before typing
      // their own. While it is ticked the equation OWNS that field and keeps
      // rewriting it — correctly, and for managed and unmanaged rows alike.
      const auto = row.querySelector('.dmg-auto-cb');
      auto.checked = false;
      auto.dispatchEvent(new Event('change', { bubbles: true }));
      row.querySelector('.atk-damage').value = '1d6+9 hand typed';
      set('totem-sm-name', '');
      await wait(200);

      const survivor = [...document.querySelectorAll('#attacks-container .attack-entry')]
        .find(r => r.querySelector('.atk-name').value === 'My Own Claws');
      if (!survivor) fail('GR3: unshaping DELETED a row the player had taken over');
      expect(survivor.querySelector('.atk-damage').value, '1d6+9 hand typed',
        'GR3: the player’s hand-typed damage survived unshaping');
      expect(document.querySelectorAll('[data-from-class^="soulmeld:"]').length, 0,
        'GR3: no managed rows left behind');
    });

  regression('GR4: a bind that IMPROVES an attack changes the row', async () => {
    // Claws of the Wyrm grants claws while merely SHAPED, and its hands bind
    // improves their damage one die step ("from 1d6 to 1d8, if you are
    // Medium" — the book names the case). These modifiers spent a day as inert
    // tags: the panel announced the improvement and the row kept the old die.
    await newCharacter();
    setAbilities({ STR: 12 });
    set('char-size', 'Medium');
    const slot = document.querySelector('.magic-item-slot[data-slot-id="hands"]');
    if (!slot) fail('GR4: no hands slot');
    const sw = slot.querySelector('.slot-soulmeld-check');
    if (sw && !sw.checked) { sw.checked = true; sw.dispatchEvent(new Event('change', { bubbles: true })); }
    const nameEl = slot.querySelector('.slot-sm-name');
    nameEl.value = 'Claws of the Wyrm';
    nameEl.dispatchEvent(new Event('input', { bubbles: true }));
    nameEl.dispatchEvent(new Event('change', { bubbles: true }));
    const bound = slot.querySelector('.slot-sm-bound');
    bound.checked = false;
    bound.dispatchEvent(new Event('change', { bubbles: true }));
    window.recalcAll();
    await wait(200);

    const row = grantedRow('Claw');
    if (!row) fail('GR4: Claws of the Wyrm grants claws while shaped');
    expect(row.querySelector('.dmg-dice').value, '1d6',
      'GR4: Medium claws are 1d6 unbound');

    bound.checked = true;
    bound.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(250);
    expect(grantedRow('Claw').querySelector('.dmg-dice').value, '1d8',
      'GR4: the hands bind steps the damage up one step, 1d6 -> 1d8');
  });

  regression('GR5: granted feats, senses and movement reach their own sections',
    async () => {
      await newCharacter();
      // Basilisk Mask: low-light vision while shaped, Blind-Fight on the brow
      // bind. The eyes slot IS the brow chakra.
      const slot = document.querySelector('.magic-item-slot[data-slot-id="eyes"]');
      const sw = slot.querySelector('.slot-soulmeld-check');
      if (sw && !sw.checked) { sw.checked = true; sw.dispatchEvent(new Event('change', { bubbles: true })); }
      const nameEl = slot.querySelector('.slot-sm-name');
      nameEl.value = 'Basilisk Mask';
      nameEl.dispatchEvent(new Event('input', { bubbles: true }));
      nameEl.dispatchEvent(new Event('change', { bubbles: true }));
      const bound = slot.querySelector('.slot-sm-bound');
      bound.checked = true;
      bound.dispatchEvent(new Event('change', { bubbles: true }));
      window.recalcAll();
      await wait(250);

      const featRow = document.querySelector(
        '#feats-container .feat-row[data-from-soulmeld="1"] .feat-entry');
      if (!featRow) fail('GR5: the brow bind’s granted feat never reached the Feats tab');
      expect(featRow.value, 'Blind-Fight', 'GR5: granted feat name');

      const senses = $('#senses-list').textContent;
      if (!/low-light/i.test(senses)) {
        fail('GR5: low-light vision never reached the Senses block — got '
          + JSON.stringify(senses.slice(0, 120)));
      }
      // Derived rows must NOT persist: they re-derive from what is shaped.
      const saved = Feats.collectData();
      if ((saved.feats || []).some(f => /Blind-Fight/.test(f || ''))) {
        fail('GR5: a soulmeld-granted feat was written into the save; it must '
          + 're-derive, or it outlives unshaping the soulmeld');
      }
    });

  regression('GR6: Girallon’s rend rides the claw as a separate instance',
    async () => {
      // The rend is NOT an attack: it takes no attack roll ("This attack
      // automatically deals..."), it fires because two claws already hit, and
      // it has no attack line of its own. So it is a conditional RIDER on the
      // claw. What distinguishes it from an ordinary rider is that its damage
      // is a distinct INSTANCE rather than bundled into the claw's, which is
      // what matters when damage reduction is applied to each.
      //
      // It used to be modelled as its own attack row. That produced an attack
      // line nobody rolls.
      await newCharacter();
      setAbilities({ STR: 18 });

      set('totem-sm-name', 'Girallon Arms');
      const tb = $('#totem-sm-bound');
      tb.checked = true;
      tb.dispatchEvent(new Event('change', { bubbles: true }));
      bindSlot('arms', 'Girallon Arms');
      set('sm-max-essentia', 8);
      window.recalcAll();
      await wait(250);

      const claw = grantedRow('Claw');
      if (!claw) fail('GR6: the totem bind grants no claws');
      if (grantedRow('Rend')) {
        fail('GR6: the rend must not be an attack ROW — it takes no attack '
          + 'roll and there is nothing to roll on that line');
      }
      expect(claw.querySelector('.dmg-dice').value, '1d4', 'GR6: claw die');
      const readout = claw.querySelector('.dmg-riders-readout').textContent;
      expectIncludes(readout, 'rend 2d4+8',
        'GR6: double the claw dice and double Strength, on the claw');
      expectIncludes(readout, 'separate instance',
        'GR6: and flagged as its own damage instance');
      // Conditional, so it must never join the headline damage.
      expect(claw.querySelector('.dmg-total').textContent, '1d4+4',
        'GR6: the rend is NOT summed into the claw’s own damage');
    });

  regression('GR7: the rend rides ANY claw, and follows it when it is improved',
    async () => {
      // The common case, and GR6 is the rare one: Girallon's rend is its ARMS
      // bind and its claws are its TOTEM bind, and binding one soulmeld to two
      // chakras at once requires the Totemist's Totem Chakra Bind at 11th.
      // Below that the claws are a racial one or another soulmeld's, exactly
      // as the book says.
      //
      // It also has to follow the claw UP: Improved Natural Attack steps a
      // 1d8 claw to 2d6, and the rend is double THAT, not double the printed
      // value. That composition is why the rend resolves by reference.
      await newCharacter();
      setAbilities({ STR: 18 });
      fillWeaponRow(await firstAttackRow(),
        { name: 'Claw', dice: '1d8', style: 'natural' });
      bindSlot('arms', 'Girallon Arms');
      set('sm-max-essentia', 8);
      window.recalcAll();
      await wait(250);

      const row = $('#attacks-container .attack-entry');
      expectIncludes(row.querySelector('.dmg-riders-readout').textContent,
        'rend 2d8+8',
        'GR7: double the RACIAL 1d8 claw, not a hard-coded 2d4');

      // Now step the claw up and the rend must follow.
      Feats.addFeat('Improved Natural Attack (Claw)');
      window.recalcAll();
      await wait(250);
      expect(row.querySelector('.dmg-dice-meld').textContent, '→ 2d6',
        'GR7: Improved Natural Attack steps 1d8 to 2d6 (the MM progression)');
      expectValue('#attacks-container .attack-entry .dmg-dice', '1d8',
        'GR7: ...shown beside the box, never written into it');
      expect(row.querySelector('.dmg-total').textContent, '2d6+4',
        'GR7: the stepped die drives the total');
      expectIncludes(row.querySelector('.dmg-riders-readout').textContent,
        'rend 4d6+8',
        'GR7: and the rend doubles the STEPPED die, not the printed one');
    });

  regression('GR8: a bind that improves WEAPONS reaches the player’s own rows',
    async () => {
      // `manufactured` and `unarmed` scopes reached nothing for a day: the
      // only consumer was the soulmelds' own granted attacks, and none of
      // those is a manufactured weapon. Mauling Gauntlets' arms bind doubles
      // the threat range of "any melee weapon wielded" — the player's rows.
      await newCharacter();
      setAbilities({ STR: 18 });
      const row = await firstAttackRow();
      fillWeaponRow(row, { name: 'Greatsword', crit: '19-20/x2', dice: '2d6',
                           style: 'two-hand' });
      bindSlot('arms', 'Mauling Gauntlets');
      set('sm-max-essentia', 8);
      window.recalcAll();
      await wait(250);

      const chip = row.querySelector('.atk-crit-meld');
      expect(chip.textContent, '→ 17-20',
        'GR8: 3.5 doubles the SIZE of the threat range — 19-20 has two numbers, '
        + 'so it becomes four');
      // The player's own box must be untouched: it is free text and may carry
      // information the sheet cannot reconstruct.
      expectValue('#attacks-container .attack-entry .atk-crit', '19-20/x2',
        'GR8: the improvement is shown BESIDE the Critical box, not written in');

      // And the scope has to be real in both directions, or "it applies to
      // everything" would pass this test just as well.
      $('#btn-add-attack').click();
      await wait(250);
      const rows = $$('#attacks-container .attack-entry');
      const nat = rows[rows.length - 1];
      fillWeaponRow(nat, { name: 'Bite', crit: '20/x2', style: 'natural' });
      window.recalcAll();
      await wait(200);
      expect(nat.querySelector('.atk-crit-meld').textContent, '',
        'GR8: a MANUFACTURED-scope bind must not touch a natural attack');

      // Swap to a natural-scope bind and the mirror must hold.
      bindSlot('arms', 'Dread Carapace');
      window.recalcAll();
      await wait(250);
      expect(nat.querySelector('.atk-crit-meld').textContent, '→ 19-20',
        'GR8: Dread Carapace doubles "all natural attacks" — 20 becomes 19-20');
      expect(rows[0].querySelector('.atk-crit-meld').textContent, '',
        'GR8: ...and must not touch the greatsword');
    });

  regression('GR9: granted flight fills the maneuverability box and then lets go',
    async () => {
      // Auto-filled from whatever granted the flight, but EDITABLE, because the
      // granted value is a default and not a law — Improved Flight raises it a
      // step and the sheet has no way to know.
      //
      // The trusted-keystroke half cannot be driven from here: a synthetic
      // event cannot set `isTrusted`, and `isTrusted` IS the guard. So this
      // asserts the two halves that ARE testable — it fills and marks itself,
      // and once the marker is gone a recalc never touches it again — plus the
      // save round-trip, which is what makes the handover survive a reload.
      await newCharacter();
      bindSlot('shoulders', 'Pegasus Cloak');   // fly 10 ft per essentia, average
      setIncarnumCapacity();
      window.recalcAll();
      await wait(200);
      const slot = document.querySelector('.magic-item-slot[data-slot-id="shoulders"]');
      const pips = slot.querySelectorAll('.essentia-pip');
      for (let i = 0; i < 3 && i < pips.length; i++) pips[i].click();
      await wait(250);
      window.recalcAll();
      await wait(150);

      const man = $('#speed-fly-maneuver');
      expect(man.value, 'average', 'GR9: filled from the soulmeld that grants the flight');
      expect(man.dataset.fromSpeed != null, true, 'GR9: and marked as auto-filled');
      expect($('#speed-fly-current').textContent, '30',
        'GR9: 3 essentia at 10 ft each');

      // The marker must PERSIST, or a loaded character reads as player-owned
      // and the box freezes at whatever it held when saved.
      expect(Character.collectData()._flyManeuverAuto, true,
        'GR9: the auto-fill marker round-trips');

      // Post-handover: the marker is gone (a real keystroke deletes it) and the
      // player's choice must survive every subsequent recalc.
      delete man.dataset.fromSpeed;
      man.value = 'perfect';
      window.recalcAll();
      await wait(150);
      expect(man.value, 'perfect',
        'GR9: once handed over, a recalc must not overwrite the player');
      expect(!!Character.collectData()._flyManeuverAuto, false,
        'GR9: ...and it saves as theirs, not as auto-filled');
    });

  regression('GR10: a bind that attaches a RULE shows it at the attack', async () => {
    // Worg Pelt's hands bind lets a bite hit trip for free. No number, so it
    // is not a rider — an attack_rider must state its damage — but it is a
    // rule the player needs AT the attack rather than in a panel they would
    // have to go looking for mid-combat.
    await newCharacter();
    setAbilities({ STR: 16 });
    fillWeaponRow(await firstAttackRow(),
      { name: 'Bite', dice: '1d6', style: 'natural' });
    bindSlot('hands', 'Worg Pelt');
    window.recalcAll();
    await wait(250);

    const row = $('#attacks-container .attack-entry');
    expectIncludes(row.querySelector('.dmg-riders-readout').textContent,
      'free trip attempt',
      'GR10: the trip rule reaches the Bite row');
    expectIncludes(row.querySelector('.dmg-riders-readout').textContent,
      'Worg Pelt', 'GR10: ...and says which soulmeld put it there');

    // Scoped to BITES. A note that shows on every attack proves nothing.
    $('#btn-add-attack').click();
    await wait(250);
    const rows = $$('#attacks-container .attack-entry');
    const claw = rows[rows.length - 1];
    fillWeaponRow(claw, { name: 'Claw', dice: '1d4', style: 'natural' });
    window.recalcAll();
    await wait(200);
    expect(claw.querySelector('.dmg-riders-readout').textContent, '',
      'GR10: the bite-only rule must not appear on a claw');
  });

  regression('GR11: a bind can improve a movement mode it already granted',
    async () => {
      // Airstep Sandals grants flight with GOOD maneuverability while shaped;
      // its feet bind makes that same flight PERFECT. A modifier on a mode
      // rather than a grant of one — the movement twin of the attack
      // modifiers, and inert until now.
      await newCharacter();
      const slot = document.querySelector('.magic-item-slot[data-slot-id="feet"]');
      const sw = slot.querySelector('.slot-soulmeld-check');
      if (sw && !sw.checked) { sw.checked = true; sw.dispatchEvent(new Event('change', { bubbles: true })); }
      const n = slot.querySelector('.slot-sm-name');
      n.value = 'Airstep Sandals';
      n.dispatchEvent(new Event('input', { bubbles: true }));
      n.dispatchEvent(new Event('change', { bubbles: true }));
      const b = slot.querySelector('.slot-sm-bound');
      b.checked = false;
      b.dispatchEvent(new Event('change', { bubbles: true }));
      set('sm-max-essentia', 8);
      window.recalcAll();
      await wait(250);

      const flyOf = () => (SoulmeldEffects.grantedMovement()
        .find(m => m.mode === 'fly') || {});
      expect(flyOf().maneuverability, 'good',
        'GR11: shaped, the sandals fly with GOOD maneuverability');

      b.checked = true;
      b.dispatchEvent(new Event('change', { bubbles: true }));
      window.recalcAll();
      await wait(250);
      expect(flyOf().maneuverability, 'perfect',
        'GR11: the feet bind upgrades that same flight to PERFECT');
      // It is an ACTIVATED flight (a move action, beginning and ending on a
      // solid surface), so it must NOT grant a standing fly speed.
      expect(flyOf().activated, true,
        'GR11: still a move action, not a standing speed');
    });

  regression('GR12: a monk’s fists get their own die AND count as both kinds',
    async () => {
      // The damage ladder comes from the DB, not a copied table: the Monk
      // entry carries the Medium progression as a per-level
      // `columns.unarmed_damage` and Table 3-11 for Small/Large.
      //
      // And a monk's unarmed strike is BOTH kinds of weapon — the class
      // feature says "treated both as a manufactured weapon and a natural
      // weapon" — which is what finally gives the `unarmed` modifier scope
      // something real to reason about. Mauling Gauntlets doubles the threat
      // range of "any melee weapon wielded", and on a monk that includes fists.
      await newCharacter();
      setAbilities({ STR: 16 });
      set('class-lookup', 'Monk');
      set('class-lookup-level', 8);
      $('#class-lookup-apply').click();
      await wait(400);
      expect(ClassPicker.getClassLevel('Monk'), 8, 'GR12: monk 8 applied');

      // The table, by level and size, read from the DB.
      expect(ClassPicker.getMonkUnarmedDamage().dice, '1d10',
        'GR12: a level 8 Medium monk deals 1d10');
      set('char-size', 'Small');
      expect(ClassPicker.getMonkUnarmedDamage().dice, '1d8',
        'GR12: ...1d8 if Small (Table 3-11)');
      set('char-size', 'Large');
      expect(ClassPicker.getMonkUnarmedDamage().dice, '2d8',
        'GR12: ...2d8 if Large');
      // The book gives three sizes and no more. Anything else must say so
      // rather than extrapolate up an unrelated ladder.
      set('char-size', 'Huge');
      const huge = ClassPicker.getMonkUnarmedDamage();
      expect(huge.dice, null, 'GR12: Huge is not in the tables');
      expectIncludes(huge.note || '', 'Small, Medium and Large',
        'GR12: ...and it says why rather than guessing');
      set('char-size', 'Medium');

      $('#btn-add-attack').click();
      await wait(250);
      const rows = $$('#attacks-container .attack-entry');
      const fists = rows[rows.length - 1];
      fillWeaponRow(fists, { name: 'Unarmed strike', crit: '20/x2', style: 'unarmed' });
      window.recalcAll();
      await wait(200);
      expect(fists.querySelector('.dmg-dice-meld').textContent, '→ 1d10',
        'GR12: the row shows the monk die');
      expect(fists.querySelector('.dmg-total').textContent, '1d10+3',
        'GR12: and it drives the total (Str 16 = +3)');

      // Now the both-kinds rule.
      bindSlot('arms', 'Mauling Gauntlets');
      setIncarnumCapacity();
      window.recalcAll();
      await wait(250);
      expect(fists.querySelector('.atk-crit-meld').textContent, '→ 19-20',
        'GR12: a MANUFACTURED-scope bind reaches a monk’s unarmed strike');

      // ...and must NOT reach a non-monk's. Remove the monk levels and it goes.
      ClassPicker.clearAll();
      await wait(350);
      window.recalcAll();
      await wait(200);
      expect(ClassPicker.getClassLevel('Monk'), 0, 'GR12: monk levels gone');
      expect(fists.querySelector('.atk-crit-meld').textContent, '',
        'GR12: an ordinary unarmed strike is neither manufactured nor natural');
    });

  regression('GR13: Dread Carapace reaches natural attacks — the book’s worked example',
    async () => {
      // A REGRESSION I caused and Ryan caught on Gorrash. `condition` was
      // doing three jobs at once, and one of them was restating the scope
      // ("when using a claw or other natural attack" on a row that already
      // says applies_to='natural'). The day the sheet started correctly
      // refusing to sum conditional rows into a weapon's total, those rows
      // stopped working — including the one the module documents as its
      // worked example.
      //
      // The book prints the numbers, so the test uses them: at 5 essentia,
      // +12 with a bite, +6 with any other natural attack, -6 to hit.
      await newCharacter();
      setAbilities({ STR: 18 });
      bindSlot('torso', 'Dread Carapace');
      // Unbind: every one of these is a SHAPED effect, not a bind.
      const torso = document.querySelector('.magic-item-slot[data-slot-id="torso"]');
      const bound = torso.querySelector('.slot-sm-bound');
      bound.checked = false;
      bound.dispatchEvent(new Event('change', { bubbles: true }));
      setIncarnumCapacity(6, 8);
      window.recalcAll();
      await wait(200);

      const mk = async (name) => {
        $('#btn-add-attack').click();
        await wait(200);
        const rows = $$('#attacks-container .attack-entry');
        const r = rows[rows.length - 1];
        fillWeaponRow(r, { name, dice: '1d6', style: 'natural' });
        return r;
      };
      const bite = await mk('Bite');
      const claw = await mk('Claw');

      const pips = torso.querySelectorAll('.essentia-pip');
      for (let i = 0; i < 5 && i < pips.length; i++) pips[i].click();
      await wait(250);
      window.recalcAll();
      await wait(150);

      expect(bite.querySelector('.dmg-meld').textContent, '+12',
        'GR13: +2 and +2/point with a bite = +12 at 5 essentia');
      expect(claw.querySelector('.dmg-meld').textContent, '+6',
        'GR13: +1 and +1/point with another natural attack = +6');
      // The bite row SUPERSEDES the natural row rather than stacking with it —
      // the book says "+2 with a bite OR +1 with another natural attack". 18
      // would be the double-count.
      expect(bite.querySelector('.atk-calc-meld').textContent, '-6',
        'GR13: and the natural-weapon attack penalty applies to both');
      expect(claw.querySelector('.atk-calc-meld').textContent, '-6',
        'GR13: ...to the claw as well');
    });

  regression('GR14: an edited granted attack is never duplicated', async () => {
    // Reported on Gorrash. The handover used to ERASE the row's key, which
    // made it unrecognisable — so the next sync saw the attack as missing and
    // created a SECOND identical claw. One keystroke plus any essentia change
    // or reload, and the character had two, which double-counts if both get
    // rolled. It now MARKS the row instead of erasing its identity.
    await newCharacter();
    setAbilities({ STR: 18 });
    set('totem-sm-name', 'Landshark Boots');
    const tb = $('#totem-sm-bound');
    tb.checked = true;
    tb.dispatchEvent(new Event('change', { bubbles: true }));
    setIncarnumCapacity();
    window.recalcAll();
    await wait(250);
    const pips = $$('#totem-essentia-pips .essentia-pip');
    for (let i = 0; i < 2 && i < pips.length; i++) pips[i].click();
    await wait(250);

    const claws = () => $$('#attacks-container .attack-entry')
      .filter(r => /Landshark/.test(r.querySelector('.atk-name').value));
    expect(claws().length, 1, 'GR14: one granted claw to begin with');

    // Take the row over, the way a real keystroke does.
    const row = claws()[0];
    row.dataset.playerOwned = '1';
    row.querySelector('.atk-notes').value = 'mine';

    // Reallocate essentia — the case that used to duplicate.
    if (pips[2]) pips[2].click();
    await wait(300);
    expect(claws().length, 1,
      'GR14: reallocating essentia must not create a rival row');
    expect(claws()[0].querySelector('.atk-notes').value, 'mine',
      'GR14: and the player edit survives');

    // Unshaping must LEAVE an owned row rather than deleting their work.
    set('totem-sm-name', '');
    await wait(300);
    expect(claws().length, 1,
      'GR14: an owned row survives losing its soulmeld');
  });

  regression('GR15: a soulmeld enhancement bonus is TYPED, not a generic meld',
    async () => {
      // It was folded into the untyped "Meld" term, which hid what kind of
      // bonus it was and would have ADDED it on top of a magic weapon's.
      // Enhancement bonuses do not stack — the highest applies.
      await newCharacter();
      setAbilities({ STR: 18 });
      set('totem-sm-name', 'Landshark Boots');
      const tb = $('#totem-sm-bound');
      tb.checked = true;
      tb.dispatchEvent(new Event('change', { bubbles: true }));
      setIncarnumCapacity();
      window.recalcAll();
      await wait(250);
      const pips = $$('#totem-essentia-pips .essentia-pip');
      for (let i = 0; i < 3 && i < pips.length; i++) pips[i].click();
      await wait(300);

      const row = $('#attacks-container .attack-entry[data-from-class^="soulmeld:"]');
      if (!row) fail('GR15: no granted claw row');
      expect(row.querySelector('.atk-calc-enh').textContent, '+3',
        'GR15: 3 essentia = a +3 ENHANCEMENT bonus, shown in the Enh term');
      expect(row.querySelector('.atk-calc-meld').textContent, '+0',
        'GR15: ...and not in the untyped Meld term');

      // Non-stacking, in both directions.
      const enh = row.querySelector('.dmg-enh');
      enh.value = '1';
      enh.dispatchEvent(new Event('input', { bubbles: true }));
      window.recalcAll();
      await wait(150);
      expect(row.querySelector('.atk-calc-enh').textContent, '+3',
        'GR15: a +1 weapon does not add to a +3 soulmeld enhancement');
      enh.value = '5';
      enh.dispatchEvent(new Event('input', { bubbles: true }));
      window.recalcAll();
      await wait(150);
      expect(row.querySelector('.atk-calc-enh').textContent, '+5',
        'GR15: ...and a +5 weapon wins instead');
    });

  regression('GR16: the enhancement shows on the DAMAGE row and publishes correctly',
    async () => {
      // It was always in the damage TOTAL, but nothing on the damage row said
      // so: the attack row grew a visible "Enh +3" while the damage row's Enh
      // is the player's own input box, which stays empty when the bonus comes
      // from a soulmeld. "Applied to attack and not to damage" is exactly what
      // that looks like, and is what Ryan reported.
      //
      // The display gap was also hiding a real defect — the publisher read the
      // raw box, so `damage_structured.enhancement` said 0 beside a `rendered`
      // of "1d6+7". Components that do not sum to the total next to them is
      // precisely what that field exists to prevent.
      await newCharacter();
      setAbilities({ STR: 18 });
      set('totem-sm-name', 'Landshark Boots');
      const tb = $('#totem-sm-bound');
      tb.checked = true;
      tb.dispatchEvent(new Event('change', { bubbles: true }));
      setIncarnumCapacity();
      window.recalcAll();
      await wait(250);
      const pips = $$('#totem-essentia-pips .essentia-pip');
      for (let i = 0; i < 3 && i < pips.length; i++) pips[i].click();
      await wait(300);

      const row = $('#attacks-container .attack-entry[data-from-class^="soulmeld:"]');
      if (!row) fail('GR16: no granted claw row');

      expect(row.querySelector('.dmg-enh-meld').textContent, '+3',
        'GR16: the damage row SHOWS the enhancement that applied');
      expectValue('#attacks-container .attack-entry[data-from-class^="soulmeld:"] .dmg-enh', '',
        'GR16: ...beside the player’s box, not written into it');
      expect(row.querySelector('.dmg-total').textContent, '1d6+7',
        'GR16: 1d6 + Str 4 + enhancement 3');

      // And the published structure must agree with the string beside it.
      if (typeof LivePublish !== 'undefined' && LivePublish.snapshot) {
        const atk = (LivePublish.snapshot().attacks || [])
          .find(a => /Landshark/.test(a.name || ''));
        if (!atk || !atk.damage_structured) fail('GR16: the attack did not publish');
        expect(atk.damage_structured.enhancement, 3,
          'GR16: the published enhancement is the one that APPLIED, not the box');
        expect(atk.damage_structured.rendered, '1d6+7',
          'GR16: ...and it agrees with the rendered string');
      }
    });

  regression('GR17: renaming a granted row detaches its own soulmeld’s bonus',
    async () => {
      // A KNOWN EDGE, pinned so that changing it is a decision rather than an
      // accident. `applies_to_attack` matches by NAME: Landshark Boots' "+1
      // enhancement per essentia with the landshark boots claw attacks" finds
      // the row called "Claw (Landshark Boots)".
      //
      // Rename that row past recognition and the bonus stops applying. That is
      // defensible — the row is the player's once edited and may now describe a
      // different weapon entirely — but it is SILENT, which is the part worth
      // knowing about. Dread Carapace's scope-wide bonus is unaffected, which
      // is the discriminator: this is about the name-scoped bonus only.
      await newCharacter();
      setAbilities({ STR: 18 });
      set('totem-sm-name', 'Landshark Boots');
      const tb = $('#totem-sm-bound');
      tb.checked = true;
      tb.dispatchEvent(new Event('change', { bubbles: true }));
      // Dread Carapace too, shaped, for the contrast.
      bindSlot('torso', 'Dread Carapace');
      const torso = document.querySelector('.magic-item-slot[data-slot-id="torso"]');
      const tbound = torso.querySelector('.slot-sm-bound');
      tbound.checked = false;
      tbound.dispatchEvent(new Event('change', { bubbles: true }));
      setIncarnumCapacity();
      window.recalcAll();
      await wait(250);
      const pips = $$('#totem-essentia-pips .essentia-pip');
      for (let i = 0; i < 3 && i < pips.length; i++) pips[i].click();
      await wait(300);

      const row = $('#attacks-container .attack-entry[data-from-class^="soulmeld:"]');
      if (!row) fail('GR17: no granted claw row');
      expect(row.querySelector('.atk-calc-enh').textContent, '+3',
        'GR17: the name-scoped enhancement applies while the name matches');
      expect(row.querySelector('.dmg-meld').textContent, '+1',
        'GR17: and Dread Carapace’s scope-wide +1 applies too');

      // Rename it past recognition — as a player taking the row over might.
      row.dataset.playerOwned = '1';
      const nameEl = row.querySelector('.atk-name');
      nameEl.value = 'Rending Talons';
      nameEl.dispatchEvent(new Event('input', { bubbles: true }));
      window.recalcAll();
      await wait(200);

      expect(row.querySelector('.atk-calc-enh').textContent, '+0',
        'GR17: the NAME-scoped bonus detaches — known, silent, and deliberate');
      expect(row.querySelector('.dmg-meld').textContent, '+1',
        'GR17: the SCOPE-wide bonus still applies, because it never keyed on '
        + 'the name');
    });

  regression('GR18: the totemist’s totem chakra bind raises capacity, and only there',
    async () => {
      // MoI's Totem Chakra Bind prints TWO worked examples and both are
      // asserted here verbatim, because a capacity rule is exactly the kind of
      // thing that can be off by one in a direction nobody notices:
      //
      //   "a 2nd-level totemist can invest up to 2 points of essentia in any
      //    soulmeld bound to his totem chakra bind (rather than the normal
      //    limit of 1 point)"
      //   "a 15th-level totemist could invest up to 5 points"
      //
      // The MIRROR CLAUSES are the discriminators, and without them this spec
      // would pass against a bonus that simply raised everything: the bonus
      // must vanish when the meld is UNBOUND (the book hangs it on the bind,
      // not on the slot), and it must not reach a BODY slot at all.
      await newCharacter();
      set('char-level', '2');
      await applyClass('Totemist', 2);
      const details = document.querySelector('.slot-totem details');
      if (details) details.open = true;
      set('totem-sm-name', 'Girallon Arms');
      await wait(200);
      const totemPips = () => $$('#totem-essentia-pips .essentia-pip').length;

      expect(totemPips(), 1, 'GR18: unbound at 2nd — the ordinary Table 2-1 ceiling');
      const tb = $('#totem-sm-bound');
      tb.checked = true;
      tb.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(250);
      expect(totemPips(), 2, 'GR18: bound at 2nd — the book’s first worked example');

      // Second worked example. Character level drives the base (Table 2-1),
      // totemist level drives the bonus — 3 + 2 = 5.
      set('char-level', '15');
      await applyClass('Totemist', 15);
      await wait(250);
      expect(totemPips(), 5, 'GR18: bound at 15th — the book’s second worked example');

      tb.checked = false;
      tb.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(250);
      expect(totemPips(), 3, 'GR18: unbinding drops it back to the base ceiling');

      // A body slot is never the totem chakra, however high the totemist is.
      const arms = document.querySelector('.magic-item-slot[data-slot-id="arms"]');
      const chk = arms.querySelector('.slot-soulmeld-check');
      chk.checked = true;
      chk.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(250);
      expect(arms.querySelectorAll('.essentia-pips:not(.essentia-pips-2) .essentia-pip').length,
        3, 'GR18: the totem bonus does not leak to a body slot');
    });

  regression('GR19: Necrocarnate’s +1 is name-scoped and stacks with the incarnate bonus',
    async () => {
      // "When you attain 9th level, the essentia capacity of each necrocarnum
      // meld you shape increases by 1" — and the entry says in as many words
      // that it stacks with the incarnate's expanded soulmeld capacity, which
      // is why this is added rather than max'd.
      //
      // Both directions again: a necrocarnum meld gets it, a plain meld in the
      // same slot does not. Renaming the meld is what moves the ceiling, so
      // this also pins that the name listener is wired.
      await newCharacter();
      set('char-level', '15');
      await applyClass('Incarnate', 6);
      await applyClass('Necrocarnate', 9);

      const arms = document.querySelector('.magic-item-slot[data-slot-id="arms"]');
      const chk = arms.querySelector('.slot-soulmeld-check');
      chk.checked = true;
      chk.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(250);
      const nameEl = arms.querySelector('.slot-sm-name');
      const pips = () => arms.querySelectorAll(
        '.essentia-pips:not(.essentia-pips-2) .essentia-pip').length;

      nameEl.value = 'Girallon Arms';
      nameEl.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(200);
      expect(pips(), 4, 'GR19: base 3 (char 15) + 1 incarnate — no necrocarnum bonus');

      nameEl.value = 'Necrocarnum Vestments';
      nameEl.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(200);
      expect(pips(), 5, 'GR19: a necrocarnum meld stacks the +1 on top');
    });

  regression('GR20: an essentia pip moves a PULLED total with no other interaction',
    async () => {
      // Ryan, 2026-08-22, moving essentia on Gorrash: the wormtail belt's AC
      // did not change until he edited an unrelated field.
      //
      // GR2 already covers a pip moving DAMAGE, and it passed throughout —
      // that path is PUSHED (syncGrantedAttacks recalcs when the attack
      // signature changes). AC, saves, initiative and grapple are PULLED:
      // app.js reads getActiveACBonuses and friends during recalcAll, so they
      // only move if something asks for a recalc, and the pip handler only
      // refreshed the readouts. A meld whose whole contribution is pulled — a
      // pure natural-armour one like the wormtail belt — therefore went stale.
      //
      // THE DISCRIMINATOR is that this spec calls no recalc of its own. SME2
      // covers the same soulmeld and could not catch this, because it calls
      // window.recalcAll() explicitly after shaping. Do not add one here.
      await newCharacter();
      await waitForDb();
      setAbilities({ DEX: 10 });
      set('char-level', '12');
      await wait(300);

      const slot = $('.magic-item-slot[data-slot-id="waist"]');
      const check = slot.querySelector('.slot-soulmeld-check');
      check.checked = true;
      check.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(250);
      const inp = slot.querySelector('.slot-sm-name');
      inp.value = 'Wormtail Belt';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(800);

      const pips = () => slot.querySelectorAll(
        '.essentia-pips:not(.essentia-pips-2) .essentia-pip');
      if (pips().length < 3) fail(`GR20: needed 3 pips, got ${pips().length}`);

      // +2 enhancement natural armour at rest.
      expect($('#ac-total').textContent, '12', 'GR20: AC before any essentia');

      // ONE pip click, and then nothing else at all.
      pips()[2].click();
      await wait(500);
      expect($('#ac-total').textContent, '15',
        'GR20: +1 per essentia reaches AC on the pip click itself');
      expect($('#ac-touch').textContent, '10',
        'GR20: ...still never against a touch attack');

      // And back down, so a stale-high value cannot pass either.
      pips()[0].click();
      await wait(500);
      expect($('#ac-total').textContent, '12',
        'GR20: clearing the essentia moves it back in the same pass');
    });

  // ---- LB: live resolved-state bus, inbound half (phase 2, 2026-08-20) ----
  //
  // THE SPLIT WITH tests/test_live_bus.py IS DELIBERATE, and each suite covers
  // what the other mocks. That Python suite boots a real server and drives the
  // protocol — deadlines, staleness, the allowlist, three-state outcomes — with
  // a FAKE TAB standing in for the browser. These regressions are the mirror
  // image: a fake server (none at all — `applyCommand` is pure DOM, no network)
  // driving the REAL sheet, so they answer the one question the protocol suite
  // structurally cannot: when a command lands, does the sheet actually move, and
  // do the DERIVED numbers move with it?
  //
  // That question is the whole point of the bus. A write that sets an input and
  // fails to cascade through recalcAll would pass every check in test_live_bus.py
  // — the fake tab there reports whatever it likes — and would hand the rig a
  // snapshot whose HP had changed and whose saves had not.

  regression('LB1: an inbound write moves the raw field AND the derived numbers', async () => {
    if (!window.LiveCommands) fail('LB1: live-commands.js not loaded');
    await newCharacter();
    setAbilities({ STR: 18, CON: 14, DEX: 10, WIS: 10 });
    set('hp-total', '45');
    set('hp-current', '45');
    // Rage's ability bump comes from the Class Features numbers a Barbarian's
    // class-picker apply would fill in; set them by hand so rage_active has
    // something to fold in (a blank sheet rages for +0, which would make this
    // test pass without proving anything).
    set('rage-str-con', '4');
    set('rage-will', '2');
    set('rage-ac', '-2');
    $('#rage-active').checked = false;
    window.recalcAll();
    await wait(120);

    const before = {
      str: $('#str-total').textContent.trim(),
      ac: parseInt($('#ac-total').textContent, 10),
      will: parseInt($('#will-total').textContent, 10),
    };

    const r = LiveCommands.applyCommand({
      id: 'pf-lb1', source: 'playfeel', reason: 'LB1',
      fields: { 'hp.current': 29, 'rage_active': true },
    });
    // Sampled BEFORE any wait: applyCommand is synchronous, so the flash class
    // is on the element the instant it returns, and it self-removes on a timer.
    // Asserting it after an await made this a race against FLASH_MS — and the
    // harness shim that compresses long setTimeouts for hidden-tab runs shortens
    // exactly that timer, so the test went red for a reason that had nothing to
    // do with the sheet. Sample the instant, assert later.
    const flashed = $('#hp-current').classList.contains('live-written');
    await wait(150);

    expect(r.applied.length, 2, 'LB1: both fields applied');
    expect(r.rejected.length, 0, `LB1: nothing rejected (got ${JSON.stringify(r.rejected)})`);
    // Raw field.
    expectValue('#hp-current', '29', 'LB1: current HP took the written value');
    // Derived. This is an OUTCOME assertion and deliberately path-agnostic: two
    // mechanisms currently produce it (each field's dispatched `input` hits
    // app.js's delegated recalc, and applyCommand calls recalcAll at the end),
    // so disabling either one alone leaves this green. Verified by mutation on
    // 2026-08-20 — worth stating, because an earlier version of this comment
    // claimed the test isolated the explicit recalc, and it does not. What it
    // guards is the thing that actually matters to a consumer: after a write,
    // the derived numbers in the snapshot are right.
    expect($('#str-total').textContent.trim(), '22',
      `LB1: rage must fold +4 Str into the TOTAL (was ${before.str})`);
    expect(parseInt($('#ac-total').textContent, 10), before.ac - 2,
      'LB1: rage AC penalty reached the AC total');
    expect(parseInt($('#will-total').textContent, 10), before.will + 2,
      'LB1: rage morale bonus reached the Will save');
    // Echo is read back AFTER the recalc, so it reports what the sheet holds.
    expect(r.echo['hp.current'], 29, 'LB1: echo reports the post-recalc value');
    expect(r.echo['rage_active'], true, 'LB1: echo reports the checkbox state');
    // A number moving on its own must not be silent.
    expect(flashed, true, 'LB1: a written field flashes (live-written class applied)');
  });

  regression('LB1b: a multi-field write costs ONE recalc, not one per field',
    async () => {
      // app.js has a delegated `input` listener over the character / skills /
      // equipment / spells / class-feature containers, so every field a write
      // places used to trigger its own full pass: five fields cost SEVEN, six
      // of them immediately superseded. `batchRecalc` coalesces them.
      //
      // This counts REAL passes by instrumenting Character.recalc, which every
      // pass goes through — not by trusting a flag that says a batch happened.
      if (!window.LiveCommands) fail('LB1b: live-commands.js not loaded');
      if (typeof window.batchRecalc !== 'function') {
        fail('LB1b: app.js exposes no batchRecalc — the coalescing is gone');
      }
      await newCharacter();
      setAbilities({ STR: 14, CON: 12 });
      set('hp-total', '40');
      window.recalcAll();
      await wait(120);

      let passes = 0;
      const orig = Character.recalc;
      Character.recalc = function () { passes++; return orig.apply(this, arguments); };
      try {
        const r = LiveCommands.applyCommand({
          id: 'pf-lb1b', source: 'playfeel', reason: 'LB1b',
          fields: { 'hp.current': 21, 'hp.temp': 3, 'hp.nonlethal': 2,
                    'xp': 1234, 'money.gp': 50 },
        });
        expect(r.applied.length, 5, 'LB1b: all five fields applied');
        expect(passes, 1,
          `LB1b: five fields must cost ONE recalc, got ${passes}`);
      } finally {
        Character.recalc = orig;
      }

      // The saving must not have cost the cascade. The echo is read AFTER the
      // recalc, so a stale echo would mean the single pass ran too early.
      expectValue('#hp-current', '21', 'LB1b: the write still landed');
      expect($('#hp-current').value, '21', 'LB1b: and the DOM agrees');
    });

  regression('LB2: the player outranks the rig — a focused field is refused, not overwritten', async () => {
    if (!window.LiveCommands) fail('LB2: live-commands.js not loaded');
    // The Character tab must be VISIBLE: focus() on an element inside a hidden
    // panel is a no-op, activeElement stays on <body>, and the guard under test
    // never gets a chance to fire. Run in isolation this passed (whatever ran
    // before happened to leave the right tab open); in a full run it went red
    // for a reason that had nothing to do with the focus guard.
    document.querySelector('.tab[data-tab="tab-character"]').click();
    await wait(80);
    set('hp-current', '29');
    set('hp-temp', '0');
    await wait(60);
    $('#hp-current').focus();
    // Assert the PRECONDITION separately. Without this, a focus() that silently
    // fails makes the test assert nothing while still reporting a verdict — the
    // difference between "the guard held" and "the guard was never asked".
    if (document.activeElement !== $('#hp-current')) {
      fail('LB2: could not focus #hp-current — precondition failed, guard untested');
    }
    const r = LiveCommands.applyCommand({
      id: 'pf-lb2', fields: { 'hp.current': 1, 'hp.temp': 7 },
    });
    await wait(120);
    $('#hp-current').blur();

    expect(r.applied.join(','), 'hp.temp', 'LB2: only the unfocused field applied');
    expect(r.rejected.length, 1, 'LB2: exactly one refusal');
    expect(r.rejected[0].field, 'hp.current', 'LB2: the focused field is the refused one');
    expectIncludes(r.rejected[0].reason, 'field-focused', 'LB2: refusal names the reason');
    // The actual point: mid-keystroke overwrite did NOT happen.
    expectValue('#hp-current', '29', 'LB2: the focused field kept the player\'s value');
    expectValue('#hp-temp', '7', 'LB2: the other field still landed');
  });

  regression('LB3: a field this tab cannot place is refused, not silently dropped', async () => {
    if (!window.LiveCommands) fail('LB3: live-commands.js not loaded');
    // The server allowlist is what stops a caller writing nonsense; this is the
    // OTHER half — a field the server blessed that this tab has no mapping for
    // is a genuine divergence between the two lists, so it must surface as a
    // refusal rather than as a no-op that reports success.
    const r = LiveCommands.applyCommand({
      id: 'pf-lb3', fields: { 'totally.made.up': 1, 'hp.nonlethal': 3 },
    });
    await wait(120);
    expect(r.applied.join(','), 'hp.nonlethal', 'LB3: the real field applied');
    expect(r.rejected.length, 1, 'LB3: the unmappable field was refused');
    expectIncludes(r.rejected[0].reason, 'unknown-field', 'LB3: refusal names the divergence');
    expect(Object.prototype.hasOwnProperty.call(r.echo, 'totally.made.up'), false,
      'LB3: a refused field must not appear in the echo');
  });

  regression('LB4: conditions are all-or-nothing — one bad name changes nothing', async () => {
    if (!window.LiveCommands) fail('LB4: live-commands.js not loaded');
    const active = () => $$('.condition-toggle').filter(b => b.checked)
      .map(b => b.dataset.condition).sort().join(',');

    LiveCommands.applyCommand({ id: 'pf-lb4a', fields: { conditions: ['Shaken'] } });
    await wait(150);
    expect(active(), 'Shaken', 'LB4: the good write landed');
    // conditions.js only refreshes its summary from its own loader — poking the
    // checkboxes directly left them right and the summary blank (found in the
    // browser 2026-08-20, invisible from outside the DOM).
    expect(($('#conditions-summary').textContent || '').includes('Shaken'), true,
      'LB4: the summary line refreshed, not just the checkboxes');

    const r = LiveCommands.applyCommand({
      id: 'pf-lb4b', fields: { conditions: ['Prone', 'Definitely Not A Condition'] },
    });
    await wait(150);
    expect(r.applied.length, 0, 'LB4: the whole field was refused');
    expectIncludes(r.rejected[0].reason, 'Definitely Not A Condition',
      'LB4: the refusal names the offending condition');
    // A partial apply would leave a state matching neither the request nor the
    // prior state, and nothing downstream could tell.
    expect(active(), 'Shaken', 'LB4: prior conditions untouched by the refused write');

    LiveCommands.applyCommand({ id: 'pf-lb4c', fields: { conditions: [] } });
    await wait(150);
    expect(active(), '', 'LB4: an empty list clears them');
  });

  // `Spells` is a const-declared module, NOT a window property — `window.Spells`
  // is undefined even when the module is loaded and working. Gate on the bare
  // identifier via typeof. (Cost a red here on first run, and it is written down
  // in my notes from the last time it cost one.)
  async function addSpellcastingPanelWithSlots(lvl, perDayCount, label) {
    if (typeof Spells === 'undefined') fail(`${label}: Spells module not loaded`);
    Spells.addCaster('spellcasting', {});
    await wait(300);
    const panels = $$('[data-caster-type="spellcasting"]');
    const panel = panels[panels.length - 1];
    if (!panel || !panel.id) fail(`${label}: no spellcasting panel with an id`);
    const perDay = panel.querySelector(`.sc-per-day[data-lvl="${lvl}"]`);
    if (!perDay) fail(`${label}: no per-day input at level ${lvl}`);
    perDay.value = String(perDayCount);
    perDay.dispatchEvent(new Event('input', { bubbles: true }));
    window.recalcAll();
    await wait(150);
    return panel;
  }

  regression('LB5: pool depletion reaches the computed remaining-slots field', async () => {
    if (!window.LiveCommands) fail('LB5: live-commands.js not loaded');
    const panel = await addSpellcastingPanelWithSlots(1, 4, 'LB5');

    const r = LiveCommands.applyCommand({
      id: 'pf-lb5', fields: { [`pools.spell_slots.${panel.id}.1.used`]: 2 },
    });
    await wait(200);
    expect(r.applied.length, 1, `LB5: the slot write applied (${JSON.stringify(r.rejected)})`);
    expect(panel.querySelector('.sc-used[data-lvl="1"]').value, '2', 'LB5: used slots written');
    expect(panel.querySelector('.sc-remain[data-lvl="1"]').textContent.trim(), '2',
      'LB5: remaining recomputed (4 per day - 2 used) — the recalc cascaded');

    // A caster id that isn't on this sheet must say so precisely, not throw.
    const bad = LiveCommands.applyCommand({
      id: 'pf-lb5b', fields: { 'pools.spell_slots.caster-999.1.used': 1 },
    });
    expect(bad.applied.length, 0, 'LB5: unknown caster id applied nothing');
    expectIncludes(bad.rejected[0].reason, 'caster-999', 'LB5: refusal names the missing panel');
  });

  regression('LB6: the sheet publishes pool CAPACITIES and never depletion (ownership split)', async () => {
    if (!window.LivePublish) fail('LB6: live-publish.js not loaded');
    // The split's whole point is one owner per number: the sheet hands over the
    // ceiling, the consumer tracks what it has spent. Publishing `used`/`spent`
    // would invite two writers for one quantity — so this asserts the ABSENCE of
    // those keys anywhere under pools, which no static guard can see.
    //
    // Builds its OWN caster panel rather than reusing LB5's: a test that only
    // passes when its neighbour ran first is the order-dependent fragility this
    // suite has been bitten by before, and it fails in a way that blames the
    // wrong code.
    const panel = await addSpellcastingPanelWithSlots(1, 4, 'LB6');
    const snap = LivePublish.snapshot();
    if (!snap || !snap.pools) fail('LB6: snapshot carries no pools');
    const mine = (snap.pools.spell_slots || []).find(s => s.id === panel.id);
    if (!mine) fail(`LB6: this test's caster panel (${panel.id}) was not published`);
    const lvl = (mine.levels || []).find(l => l.level === 1);
    if (!lvl) fail('LB6: expected the level-1 row to be published');
    expect(lvl.capacity, 4, 'LB6: capacity IS published (the sheet owns the ceiling)');
    const asText = JSON.stringify(snap.pools);
    expect(asText.includes('"used"'), false,
      'LB6: `used` must never be published — the consumer owns depletion');
    expect(asText.includes('"spent"'), false,
      'LB6: `spent` must never be published — the consumer owns depletion');

    // Leave the sheet clean. LB1/LB4/LB5 leave conditions, HP and caster panels
    // behind, and these run last — a test that quietly hands its residue to
    // whatever gets added after it is how order-dependent phantoms start.
    await newCharacter();
  });

  regression('LB7: defensive riders take the DB\'s structure instead of flattening it', async () => {
    if (typeof DefenseRiders === 'undefined') fail('LB7: defense-riders.js not loaded');
    await newCharacter();
    await wait(150);

    // A race the DB carries BOTH structured resistances and immunities for.
    // The old path turned these into a prose line in the notes box; the point
    // of the module is that the structure survives the trip.
    set('char-race', 'Bladeling (as Characters)');
    $('#char-race').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(900);

    const s = DefenseRiders.getStructured();
    expect(s.resistances.length, 2, `LB7: two racial resistances (got ${JSON.stringify(s.resistances)})`);
    expect(s.resistances.every(r => r.amount === 5), true, 'LB7: both resist 5');
    expect(s.resistances.map(r => r.damage_type).sort().join(','), 'cold,fire',
      'LB7: the damage types survived as data, not prose');
    expect(s.immunities.sort().join(','), 'acid,rust attacks', 'LB7: immunities structured');
    // The whole point: nothing was written into the free-text box.
    expect(($('#ac-defense-notes').value || '').trim(), '',
      'LB7: the race must NOT flatten its riders into the notes box any more');

    // Ownership: a hand-added rider survives a race change, race rows don't.
    DefenseRiders.addRow({ kind: 'vulnerability', type: 'cold iron' });
    set('char-race', 'Deep Gnome');
    $('#char-race').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(900);
    const after = DefenseRiders.getStructured();
    expect(after.resistances.length, 0, 'LB7: the old race took its resistances with it');
    expect(after.immunities.length, 0, 'LB7: and its immunities');
    expect(after.vulnerabilities.join(','), 'cold iron',
      'LB7: the hand-added rider survived the race change');

    // DR entries + several regenerations with DIFFERENT bypasses, which is the
    // case a single amount/bypass pair cannot hold.
    DefenseRiders.addDR({ amount: 10, bypass: 'cold iron' });
    DefenseRiders.addDR({ amount: 5, bypass: null, stacks_with: 'same-bypass' });
    DefenseRiders.addDR({ amount: 2, bypass: 'magic', stacks_with: 'all' });
    // Several regenerations with DIFFERENT bypasses — the case a single
    // amount/bypass pair cannot hold.
    DefenseRiders.addRegen({ amount: 5, bypass: 'acid, fire' });
    DefenseRiders.addRegen({ amount: 3, bypass: 'sonic' });
    $('#fast-healing').value = '3';

    const dr = DefenseRiders.getStructured().damage_reduction;
    expect(dr.length, 3, 'LB7: three DR entries');
    expect(dr[1].bypass, null, 'LB7: a blank bypass is null, not "" — 5/— means nothing bypasses it');
    // THREE states, not a boolean: Berserker Strength stacks only with DR of
    // the same kind, Black Blood Cultist stacks with any source, and the DMG
    // default is neither. A boolean would over-apply the first.
    expect(dr[0].stacks_with, 'none', 'LB7: default is non-stacking (DMG p.292)');
    expect(dr[1].stacks_with, 'same-bypass', 'LB7: the Berserker Strength case');
    expect(dr[2].stacks_with, 'all', 'LB7: the Black Blood Cultist case');
    expect(DefenseRiders.drText(), '10/cold iron, 5/—, 2/magic',
      'LB7: the books\' notation renders from the structure');

    // Regeneration resolves the OPPOSITE way from DR, and unlike DR the sheet
    // CAN resolve it: highest rate, bypassed by the INTERSECTION of the bypass
    // sets (a type must get past EVERY source to stay lethal).
    const resolved = DefenseRiders.resolveRegeneration();
    expect(resolved.amount, 5, 'LB7: resolved regeneration takes the HIGHEST rate');
    expect(resolved.bypass, null,
      'LB7: {acid,fire} ∩ {sonic} is empty — nothing bypasses, so both sources ' +
      'together are strictly tougher than either alone');
    expect(resolved.sources, 2, 'LB7: and it reports how many sources it merged');

    // Round trip.
    const blob = DefenseRiders.collectData();
    $('#defense-riders-list').innerHTML = '';
    $('#dr-entries-list').innerHTML = '';
    $('#regen-entries-list').innerHTML = '';
    $('#fast-healing').value = '';
    DefenseRiders.loadData(blob);
    await wait(150);
    const rt = DefenseRiders.getStructured();
    expect(rt.vulnerabilities.join(','), 'cold iron', 'LB7: riders round-trip');
    expect(rt.fast_healing, 3, 'LB7: fast healing round-trips as a number');
    expect(rt.damage_reduction.length, 3, 'LB7: DR entries round-trip');
    expect(rt.damage_reduction[1].stacks_with, 'same-bypass',
      'LB7: and so does each entry\'s stacking mode');
    expect(rt.damage_reduction[2].stacks_with, 'all', 'LB7: including the other one');
    expect(rt.regeneration.length, 2, 'LB7: BOTH regenerations survive');
    expect(rt.regeneration.map(g => g.bypass).join('|'), 'acid, fire|sonic',
      'LB7: each regeneration keeps its own bypass');

    // Legacy free-text DR migrates into rows, and an unparseable one does NOT
    // vanish — it stays in the box so nothing the player typed is lost.
    //
    // NB the load ORDER is load-bearing and reproduced here on purpose:
    // character.js owns #damage-reduction and app.js runs Character.loadData
    // BEFORE DefenseRiders.loadData, so by migration time the field already
    // holds the saved string. Calling DefenseRiders.loadData alone migrates
    // nothing, which is what this test did on its first run — the code was
    // right and the test was not driving the real path. A static guard in
    // test_pickers.js pins the ordering.
    const loadWithLegacyDR = async (drString) => {
      $('#damage-reduction').value = drString;      // what Character.loadData does
      DefenseRiders.loadData({ 'damage-reduction': drString });
      await wait(120);
    };
    await loadWithLegacyDR('15/CI; 10/evil');
    const migrated = DefenseRiders.getStructured().damage_reduction;
    expect(migrated.length, 2, 'LB7: a legacy DR string migrates to rows');
    expect(migrated.map(d => d.amount).join(','), '15,10', 'LB7: with its amounts');
    expect(($('#damage-reduction').value || '').trim(), '',
      'LB7: and the legacy box empties once migrated');

    await loadWithLegacyDR('see SA');
    expect(DefenseRiders.getStructured().damage_reduction.length, 0,
      'LB7: an unparseable DR string produces NO rows (never a half-parse)');
    expectValue('#damage-reduction', 'see SA',
      'LB7: and stays visible in the legacy box rather than being dropped');
    expect($('#damage-reduction').closest('.legacy-dr-field').style.display !== 'none', true,
      'LB7: the legacy box is SHOWN while it still holds something');

    // An OLD save has no _defense_riders at all and must load as empty, not
    // throw — the field is new and every existing character predates it.
    DefenseRiders.loadData({ 'char-name': 'legacy' });
    await wait(100);
    expect(DefenseRiders.getStructured().resistances.length, 0,
      'LB7: a pre-module save loads clean');

    // And the migration flag: rider prose still in the notes must stop an
    // empty structured list reading as a clean "none".
    $('#ac-defense-notes').value = 'Resist 5: Sonic';
    expect(DefenseRiders.notesMayContainRiders(), true,
      'LB7: unmigrated rider prose in the notes is flagged');
    expect(LivePublish.snapshot().defense.notes_may_contain_riders, true,
      'LB7: and the flag reaches the published snapshot');
    $('#ac-defense-notes').value = 'Wears a red hat.';
    expect(DefenseRiders.notesMayContainRiders(), false,
      'LB7: ordinary notes are not flagged (the flag must be able to be false)');

    await newCharacter();
  });

  // ---- DMG: the damage equation + shared combat options (phase A) ---------

  function dmgRow() { return $('.attack-entry .damage-calc-row'); }
  function dmgTerm(sel) { return ($(`.attack-entry ${sel}`) || {}).textContent; }
  function setStyle(v) {
    $('.attack-entry .dmg-style').value = v;
    window.recalcAll();
  }

  regression('DMG1: fighting style drives BOTH the Str multiplier and Power Attack', async () => {
    if (typeof DamageCalc === 'undefined') fail('DMG1: damage-calc.js not loaded');
    await newCharacter();
    // "New" leaves NO attack rows (character.js deliberately does not seed one
    // — only a cold page load does), so the row has to be added before there
    // is anything to calculate on.
    $('#btn-add-attack').click();
    await wait(200);
    setAbilities({ STR: 20 });            // +5
    set('bab-1', '11');
    await wait(200);
    const row = $('.attack-entry');
    if (!row) fail('DMG1: no attack row after + Add Attack');
    if (!row.querySelector('.damage-calc-row')) fail('DMG1: no damage row attached to it');
    row.querySelector('.atk-name').value = 'Greatsword';
    row.querySelector('.dmg-dice').value = '2d6';
    row.querySelector('.dmg-enh').value = '2';
    set('co-power-attack', '5');
    setStyle('two-hand');
    await wait(150);

    // Two-handed: Str x1.5 (floored) and Power Attack DOUBLED — PHB Power
    // Attack, "instead add twice the number subtracted".
    expect(dmgTerm('.dmg-abil-val'), '+7', 'DMG1: two-handed Str is floor(5 × 1½) = +7');
    expect(dmgTerm('.dmg-pa'), '+10', 'DMG1: two-handed Power Attack is doubled');
    expect(dmgTerm('.dmg-total'), '2d6+19', 'DMG1: 7 Str + 2 enh + 10 PA');

    // Light: no Power Attack damage at all. "You can't add the bonus from
    // Power Attack to the damage dealt with a light weapon."
    setStyle('light');
    await wait(120);
    expect(dmgTerm('.dmg-abil-val'), '+5', 'DMG1: light weapon takes full Str');
    expect(dmgTerm('.dmg-pa'), '+0', 'DMG1: a LIGHT weapon gets NO Power Attack damage');
    // The second clause of the same sentence: "...even though the penalty on
    // attack rolls still applies." A light weapon pays for Power Attack and
    // gets nothing. This is the assertion that stops someone "fixing" the
    // style-blind attack penalty by making it conditional.
    expect(dmgTerm('.atk-calc-co'), '-5',
      'DMG1: ...but the attack penalty STILL applies to a light weapon');

    // Natural secondary: half Str, but Power Attack DOES apply — Ryan's ruling
    // that natural weapons are an explicit exception to the light-weapon bar.
    // Its own style rather than a branch inside "light" so the call stays
    // visible in the dropdown.
    setStyle('natural-secondary');
    await wait(120);
    expect(dmgTerm('.dmg-abil-val'), '+2', 'DMG1: secondary natural takes half Str');
    expect(dmgTerm('.dmg-pa'), '+5', 'DMG1: natural weapons DO get Power Attack');

    setStyle('off-hand');
    await wait(120);
    expect(dmgTerm('.dmg-abil-val'), '+2', 'DMG1: off-hand takes half Str');
    expect(dmgTerm('.dmg-pa'), '+0', 'DMG1: off-hand gets no Power Attack');
  });

  regression('DMG2: combat options are shared — and Combat Expertise never touches damage', async () => {
    if (typeof CombatOptions === 'undefined') fail('DMG2: combat-options.js not loaded');
    if (!$('.attack-entry .damage-calc-row')) {
      // Standalone-run guard: these build on DMG1's row, and a lone
      // run has none. Seed one rather than fail for a reason that has
      // nothing to do with what the test is checking.
      $('#btn-add-attack').click();
      await wait(250);
      $('.attack-entry .dmg-dice').value = '2d6';
      setAbilities({ STR: 20 });
      set('bab-1', '11');
      set('co-power-attack', '5');
      await wait(150);
    }
    setStyle('two-hand');
    set('co-combat-expertise', '0');
    $('#co-heedless-charge').checked = false;
    window.recalcAll();
    await wait(150);
    const dmgBefore = dmgTerm('.dmg-total');
    const acBefore = parseInt($('#ac-total').textContent, 10);

    set('co-combat-expertise', '4');
    await wait(180);
    // Attack and AC only. The feat text is explicit: "-5 on your attack roll
    // and ... the same number as a dodge bonus to your Armor Class". No damage.
    expect(parseInt($('#ac-total').textContent, 10), acBefore + 4,
      'DMG2: Combat Expertise adds a dodge bonus to AC');
    expect(dmgTerm('.dmg-total'), dmgBefore,
      'DMG2: Combat Expertise must NOT change damage');
    expect(dmgTerm('.atk-calc-co'), '-9', 'DMG2: both options hit the attack roll (PA 5 + CE 4)');

    // Heedless Charge MOVES Power Attack's penalty to AC. Damage unchanged —
    // it is usually described as a damage feat and it is not one.
    $('#co-heedless-charge').checked = true;
    $('#co-heedless-charge').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(180);
    expect(dmgTerm('.atk-calc-co'), '-4', 'DMG2: Heedless Charge takes PA off the attack roll');
    expect(parseInt($('#ac-total').textContent, 10), acBefore - 1,
      'DMG2: ...and onto AC (+4 CE − 5 PA)');
    expect(dmgTerm('.dmg-total'), dmgBefore, 'DMG2: Heedless Charge does not change damage');

    // Below -5 it is inert, and says so rather than silently doing nothing.
    set('co-power-attack', '3');
    await wait(180);
    expect(CombatOptions.heedlessActive(), false,
      'DMG2: Heedless Charge needs a Power Attack of 5+');
    expectIncludes($('#co-readout').textContent, 'inert',
      'DMG2: an inert Heedless Charge is surfaced, not swallowed');
    $('#co-heedless-charge').checked = false;
    set('co-power-attack', '5');
    set('co-combat-expertise', '0');
    await wait(150);
  });

  regression('DMG3: Weapon Specialization is read off the Feats tab, enhancement is shared', async () => {
    // The sheet SHIPS with one blank attack row, so "does a damage row
    // exist" is true even on a fresh load — the old guard therefore never
    // fired standalone and this spec failed for want of a weapon name.
    // Test whether the row has actually been SET UP instead.
    if (!$('.attack-entry .dmg-dice') || !$('.attack-entry .dmg-dice').value) {
      // Standalone-run guard: these build on DMG1's row, and a lone
      // run has none. Seed one rather than fail for a reason that has
      // nothing to do with what the test is checking.
      $('#btn-add-attack').click();
      await wait(250);
      $('.attack-entry .dmg-dice').value = '2d6';
      // The weapon NAME too. Weapon Specialization is matched to a row BY
      // NAME, so a guard that seeds the dice and not the name makes this
      // spec fail standalone for a reason that has nothing to do with what
      // it checks — the exact false red the guard exists to prevent. (Found
      // 2026-08-21 while diagnosing whether an unrelated change had broken
      // it; DMG3 passes in natural order after DMG1, which seeds the name.)
      $('.attack-entry .atk-name').value = 'Greatsword';
      setAbilities({ STR: 20 });
      set('bab-1', '11');
      set('co-power-attack', '5');
      await wait(150);
    }
    setStyle('two-hand');
    await wait(120);
    const before = dmgTerm('.dmg-total');
    // Feats.addFeat takes the text directly, which is both shorter and less
    // fragile than clicking + then hunting for the row that appeared. (A blank
    // sheet has no feat rows at all, so indexing into the list found nothing.)
    Feats.addFeat('Weapon Specialization (Greatsword)');
    await wait(200);
    const ta = $$('#feats-container .feat-entry').slice(-1)[0];
    if (!ta) fail('DMG3: no feat row after addFeat');
    ta.value = 'Weapon Specialization (Greatsword)';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    window.recalcAll();
    await wait(180);
    expect(Feats.getWeaponSpecBonuses().greatsword, 2,
      'DMG3: the aggregator reads +2 per Specialization feat, not +1');
    expect(dmgTerm('.dmg-spec'), '+2', 'DMG3: matched to this row by weapon name');
    expect(dmgTerm('.dmg-total') !== before, true, 'DMG3: and it reaches the total');

    // A non-matching weapon name must NOT pick it up.
    $('.attack-entry .atk-name').value = 'Dagger';
    window.recalcAll();
    await wait(150);
    expect(dmgTerm('.dmg-spec'), '+0', 'DMG3: Specialization does not leak to another weapon');
    $('.attack-entry .atk-name').value = 'Greatsword';

    // Enhancement is ONE field feeding both equations — that is the point of
    // putting it on the damage row and reading it from the attack calc.
    $('.attack-entry .dmg-enh').value = '3';
    window.recalcAll();
    await wait(150);
    expect(dmgTerm('.atk-calc-enh'), '+3', 'DMG3: enhancement reaches the ATTACK bonus');
    expectIncludes(dmgTerm('.dmg-total'), '2d6+', 'DMG3: and the damage total');
  });

  regression('DMG4: the equation is OPT-IN — unticked, it never touches the damage field', async () => {
    // The data-safety property. 517 saved attack rows carry hand-typed damage
    if (!$('.attack-entry .damage-calc-row')) {
      // Standalone-run guard: these build on DMG1's row, and a lone
      // run has none. Seed one rather than fail for a reason that has
      // nothing to do with what the test is checking.
      $('#btn-add-attack').click();
      await wait(250);
      $('.attack-entry .dmg-dice').value = '2d6';
      setAbilities({ STR: 20 });
      set('bab-1', '11');
      set('co-power-attack', '5');
      await wait(150);
    }
    // strings; this equation must be inert against every one of them until a
    // player asks for it, exactly like the attack calculator above it.
    const row = $('.attack-entry');
    row.querySelector('.dmg-auto-cb').checked = false;
    row.querySelector('.atk-damage').value = '1d8+S+1 (hand typed)';
    window.recalcAll();
    await wait(180);
    expectValue('.attack-entry .atk-damage', '1d8+S+1 (hand typed)',
      'DMG4: an unticked equation must leave the player\'s text alone');
    expect(row.querySelector('.atk-damage').readOnly, false,
      'DMG4: and leave the field editable');

    row.querySelector('.dmg-auto-cb').checked = true;
    window.recalcAll();
    await wait(180);
    expect(row.querySelector('.atk-damage').value, dmgTerm('.dmg-total'),
      'DMG4: ticked, it drives the field');
    expect(row.querySelector('.atk-damage').readOnly, true,
      'DMG4: and locks it, so the two can never disagree');

    // Round trip, through the app's own collect/load.
    const total = dmgTerm('.dmg-total');
    const blob = appCollect();
    expect(!!blob.attacks[0].damageCalc, true, 'DMG4: the equation state is saved');
    appLoad(blob);
    await wait(500);
    expect(dmgTerm('.dmg-total'), total, 'DMG4: and survives a reload');
    expect($$('.attack-entry .damage-calc-row').length, 1,
      'DMG4: exactly one damage row after reload (no duplicate attach)');
    await newCharacter();
  });

  regression('DMG5: damage riders — unconditional folds in, conditional never does', async () => {
    if (typeof DamageCalc === 'undefined') fail('DMG5: damage-calc.js not loaded');
    await newCharacter();
    $('#btn-add-attack').click();
    await wait(250);
    setAbilities({ STR: 20 });
    set('bab-1', '11');
    const row = $('.attack-entry');
    row.querySelector('.dmg-dice').value = '2d6';
    row.querySelector('.dmg-style').value = 'two-hand';
    row.querySelector('.dmg-enh').value = '2';
    row.querySelector('.dmg-auto-cb').checked = true;
    set('co-power-attack', '5');
    await wait(150);
    const base = row.querySelector('.dmg-total').textContent;
    expect(base, '2d6+19', 'DMG5: baseline before riders');

    const add = row.querySelector('.dmg-rider-add');
    add.click(); add.click();
    await wait(120);
    const riders = row.querySelectorAll('.dmg-rider');
    expect(riders.length, 2, 'DMG5: + rider adds a rider (its button lives in a SIBLING row — ' +
      'a listener bound to the damage row never sees it, which renders fine and does nothing)');
    riders[0].querySelector('.dmg-rider-amount').value = '1d6';
    riders[0].querySelector('.dmg-rider-label').value = 'fire';
    riders[1].querySelector('.dmg-rider-amount').value = '2d6';
    riders[1].querySelector('.dmg-rider-label').value = 'holy';
    riders[1].querySelector('.dmg-rider-cond').value = 'vs evil';
    window.recalcAll();
    await wait(150);

    expect(row.querySelector('.dmg-total').textContent, '2d6+19 plus 1d6 fire',
      'DMG5: an unconditional rider joins the line, carrying its own DICE');
    expectIncludes(row.querySelector('.dmg-riders-readout').textContent, '2d6 holy vs evil',
      'DMG5: a conditional rider is listed separately');
    // THE assertion. Summing "2d6 vs evil" into the headline figure would
    // overstate every swing against everything that is not evil.
    expect(row.querySelector('.dmg-total').textContent.includes('2d6 holy'), false,
      'DMG5: a CONDITIONAL rider must never be folded into the base total');
    expect(row.querySelector('.atk-damage').value, '2d6+19 plus 1d6 fire',
      'DMG5: and the filled field matches the total');

    // Structured, and round-tripped.
    const structured = DamageCalc.readRiders(row);
    expect(structured.length, 2, 'DMG5: both riders are published structured');
    expect(structured[1].condition, 'vs evil', 'DMG5: with their conditions intact');
    const blob = appCollect();
    expect(blob.attacks[0].damageCalc.riders.length, 2, 'DMG5: riders are saved');
    appLoad(blob);
    await wait(500);
    expect($('.attack-entry .dmg-total').textContent, '2d6+19 plus 1d6 fire',
      'DMG5: and survive a reload');
    // A blank rider row is someone mid-typing, not a fact about the weapon.
    $('.attack-entry .dmg-rider-add').click();
    window.recalcAll();
    await wait(150);
    expect(DamageCalc.readRiders($('.attack-entry')).length, 2,
      'DMG5: an empty rider row is not published');
    await newCharacter();
  });

  regression('SME1: essentia reaches the numbers, and only the right weapons', async () => {
    if (typeof SoulmeldEffects === 'undefined') fail('SME1: soulmeld-effects.js not loaded');
    await newCharacter();
    await waitForDb();
    $('#btn-add-attack').click();
    await wait(250);
    setAbilities({ STR: 18 });
    set('bab-1', '8');
    set('char-level', '12');
    set('sm-base-capacity', '5');

    // Shape Dread Carapace in the totem chakra and invest 5 essentia — the
    // amount the book's OWN worked example uses, so the expected numbers come
    // from Magic of Incarnum rather than from me.
    const nameInput = $('#totem-sm-name');
    nameInput.value = 'Dread Carapace';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(700);
    set('totem-sm-extra-cap', '2');       // level band gives 3; +2 = the example's 5
    await wait(400);
    const pips = $$('#totem-essentia-pips .essentia-pip');
    if (pips.length < 5) fail(`SME1: expected 5 essentia pips, got ${pips.length}`);
    pips[4].click();
    await wait(300);
    expect(SoulmeldEffects.shaped()[0].essentia, 5, 'SME1: five essentia invested');

    // NOTHING is typed in. The effects come from the DB's structured
    // `bonuses` on the soulmeld itself, so shaping it is the whole input.
    const dbRows = SoulmeldEffects.dbRowsFor('Dread Carapace');
    if (!dbRows.length) fail('SME1: Dread Carapace carries no DB bonus rows');

    // MoI's own example: 5 essentia gives -6 attack, and +12 damage with a
    // bite or +6 with another natural weapon. If this ever reads +5/-5 the
    // base point (the soulmeld's own, before any essentia) has been dropped.
    const computed = SoulmeldEffects.computeAll();
    const pick = (type, scope) => computed.find(
      e => e.bonus_type === type && (e.applies_to || 'all') === scope);
    expect(pick('damage', 'natural').amount, 6,
      'SME1: +6 damage at 5 essentia — the book\'s worked example');
    expect(pick('damage', 'bite').amount, 12,
      'SME1: +12 with a bite, which the same example gives');
    expect(pick('attack', 'natural').amount, -6,
      'SME1: -6 attack at 5 essentia');

    // The panel renders those same rows, editable, without having created them.
    $('.slot-totem details').open = true;
    const panel = $('.slot-totem details > .slot-sm-info');
    if (panel.hidden) $('.slot-totem .btn-sm-info').click();
    await wait(300);
    const block = $('.slot-totem .sme-block');
    if (!block) fail('SME1: no effects block in the soulmeld panel');
    if (!block.querySelectorAll('.sme-row').length)
      fail('SME1: the panel shows no rows for a soulmeld the DB has effects for');

    // THE CHAKRA GUARD. Dread Carapace's spell resistance is on its HEART
    // bind. Shaped in the TOTEM slot and bound, it must NOT apply — a bound
    // row belongs to one chakra, and 55 of the 94 soulmelds bind to several
    // with a different effect in each.
    const boundBox = $('#totem-sm-bound');
    if (boundBox) {
      boundBox.checked = true;
      boundBox.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(250);
      expect(SoulmeldEffects.computeAll().some(e => e.bonus_type === 'spell_resistance'),
        false, 'SME1: a Heart-bind effect must not fire in the Totem chakra');
      boundBox.checked = false;
      boundBox.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(250);
    }

    // It must reach the weapon — and ONLY a weapon it applies to.
    const row = $('.attack-entry');
    row.querySelector('.dmg-dice').value = '1d6';
    row.querySelector('.dmg-auto-cb').checked = true;
    row.querySelector('.dmg-style').value = 'natural';
    window.recalcAll();
    await wait(200);
    expect(row.querySelector('.dmg-meld').textContent, '+6', 'SME1: reaches natural damage');
    expect(row.querySelector('.atk-calc-meld').textContent, '-6', 'SME1: and natural attack');
    expect(row.querySelector('.dmg-total').textContent, '1d6+10',
      'SME1: Str +4 plus meld +6');

    // THE guard. A natural-only soulmeld effect on a longsword would be wrong
    // in a way nobody would notice until a fight.
    row.querySelector('.dmg-style').value = 'two-hand';
    window.recalcAll();
    await wait(200);
    expect(row.querySelector('.dmg-meld').textContent, '+0',
      'SME1: a natural-only effect must NOT touch a manufactured weapon');
    expect(row.querySelector('.atk-calc-meld').textContent, '+0',
      'SME1: ...on the attack side either');

    // Round trip.
    row.querySelector('.dmg-style').value = 'natural';
    window.recalcAll();
    await wait(150);
    const blob = appCollect();
    // Unedited effects are NOT saved into the character — they are the book's,
    // read live from the DB. That is the point: a correction to the data
    // reaches every character instead of being frozen into each blob at the
    // moment the soulmeld was first shaped.
    const savedRows = (blob._soulmeld_effects || {})['totem:0'];
    expect(!savedRows || !savedRows.rows.length, true,
      'SME1: an unedited soulmeld stores nothing — the DB is the source');
    appLoad(blob);
    await wait(900);
    expect(SoulmeldEffects.computeAll().some(e => e.bonus_type === 'attack' && e.amount === -6),
      true, 'SME1: and the effects survive a reload anyway, from the DB');
    expect($('.attack-entry .dmg-total').textContent, '1d6+10',
      'SME1: with the derived total intact');
    await newCharacter();
  });

  regression('AC1: Combat Expertise is a DODGE bonus, and Heedless Charge is not', async () => {
    if (typeof CombatOptions === 'undefined') fail('AC1: combat-options.js not loaded');
    await newCharacter();
    await waitForDb();
    setAbilities({ DEX: 10 });          // mod 0, so the arithmetic is legible
    set('bab-1', '10');                 // enough BAB for a 5-point Power Attack
    await wait(300);

    const acNum = (sel) => parseInt($(sel).textContent, 10) || 0;
    const base = { total: acNum('#ac-total'), touch: acNum('#ac-touch'),
                   ff: acNum('#ac-flatfooted') };

    // Combat Expertise 5. PHB: "add the same number (+5 or less) as a DODGE
    // bonus to your Armor Class"; the Dodge feat carries the type's rule — "A
    // condition that makes you lose your Dexterity bonus to Armor Class (if
    // any) also makes you lose dodge bonuses."
    set('co-combat-expertise', '5');
    await wait(400);
    window.recalcAll();
    await wait(300);
    expect(acNum('#ac-total'), base.total + 5,
      'AC1: Combat Expertise reaches normal AC');
    expect(acNum('#ac-touch'), base.touch + 5,
      'AC1: ...and touch AC, because a dodge bonus applies to touch');
    expect(acNum('#ac-flatfooted'), base.ff,
      'AC1: ...but NOT flat-footed AC — a dodge bonus is lost with your Dex bonus');

    // Now add Heedless Charge (Shock Trooper): "you can assign any portion of
    // the attack roll penalty from Power Attack to your Armor Class instead".
    // No type is given, so it is an UNTYPED penalty and applies everywhere.
    //
    // THE GUARD. These used to be netted into one number, so +5 dodge with a
    // -5 moved penalty came through as 0 — right for normal AC and wrong
    // flat-footed, where you lose the dodge and keep the penalty.
    set('co-power-attack', '5');
    const hc = $('#co-heedless-charge');
    hc.checked = true;
    hc.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(400);
    window.recalcAll();
    await wait(300);
    expect(acNum('#ac-total'), base.total,
      'AC1: +5 dodge and -5 untyped net out on normal AC');
    expect(acNum('#ac-flatfooted'), base.ff - 5,
      'AC1: but flat-footed loses the dodge and KEEPS the penalty — the bug netting hid');

    await newCharacter();
  });

  regression('AC2: a raging barbarian cannot use Combat Expertise', async () => {
    if (typeof CombatOptions === 'undefined') fail('AC2: combat-options.js not loaded');
    await newCharacter();
    await waitForDb();
    setAbilities({ DEX: 10 });
    set('bab-1', '10');
    await wait(300);
    const acNum = (sel) => parseInt($(sel).textContent, 10) || 0;
    const base = acNum('#ac-total');

    set('co-combat-expertise', '5');
    await wait(350);
    window.recalcAll();
    await wait(300);
    expect(acNum('#ac-total'), base + 5, 'AC2: Combat Expertise applies normally');

    // Rage's own text: "He can use any feat except Combat Expertise, item
    // creation feats, and metamagic feats."
    const rage = $('#rage-active');
    if (!rage) fail('AC2: no #rage-active toggle');
    rage.checked = true;
    rage.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(500);
    expect(CombatOptions.combatExpertise(), 0,
      'AC2: the feat goes inert while raging');
    expect(CombatOptions.attackPenalty(), 0,
      'AC2: ...so its attack penalty stops applying too — you are not using it');

    // THE GUARD that matters for trust: it goes INERT, it is not DELETED. A
    // player who typed 5 must still see 5 in the box, and must be told why it
    // did nothing.
    expect($('#co-combat-expertise').value, '5',
      'AC2: the declared value is preserved, not silently erased');
    expectIncludes($('#co-readout').textContent, 'INERT while raging',
      'AC2: and the readout says why');

    rage.checked = false;
    rage.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(500);
    expect(CombatOptions.combatExpertise(), 5,
      'AC2: ending the rage restores it');
    await newCharacter();
  });

  regression('AC3: raging blocks the right skills, and only those', async () => {
    await newCharacter();
    await waitForDb();
    await wait(300);
    const rowFor = (label) => {
      for (const tr of $$('#skills-body-left tr, #skills-body-right tr')) {
        const n = tr.querySelector('.skill-name');
        if (n && n.textContent.trim() === label) return tr;
      }
      return null;
    };
    const blocked = (label) => {
      const tr = rowFor(label);
      if (!tr) fail(`AC3: no skill row for ${label}`);
      return tr.classList.contains('skill-rage-blocked');
    };

    const rage = $('#rage-active');
    if (!rage) fail('AC3: no #rage-active toggle');
    rage.checked = true;
    rage.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(600);

    // Rage: "cannot use any Charisma-, Dexterity-, or Intelligence-based
    // skills (except Balance, Escape Artist, Intimidate, and Ride), the
    // Concentration skill..."
    expect(blocked('Hide'), true, 'AC3: a DEX skill is blocked');
    expect(blocked('Bluff'), true, 'AC3: a CHA skill is blocked');
    expect(blocked('Search'), true, 'AC3: an INT skill is blocked');
    // The four named exemptions.
    expect(blocked('Balance'), false, 'AC3: Balance is exempt');
    expect(blocked('Escape Artist'), false, 'AC3: Escape Artist is exempt');
    expect(blocked('Intimidate'), false, 'AC3: Intimidate is exempt');
    expect(blocked('Ride'), false, 'AC3: Ride is exempt');
    // Concentration is CON-based, so the ability clause alone would MISS it —
    // the rule names it separately and so must the code.
    expect(blocked('Concentration'), true,
      'AC3: Concentration is blocked despite being CON-based');
    // Everything else is untouched.
    expect(blocked('Climb'), false, 'AC3: a STR skill is unaffected');
    expect(blocked('Listen'), false, 'AC3: a WIS skill is unaffected');

    // The number is struck through, NOT destroyed.
    const hide = rowFor('Hide');
    const shown = hide.querySelector('.skill-total').textContent;
    expect(/^[+-]?\d+$/.test(shown.trim()) || shown.trim() === 'NR', true,
      'AC3: the total is still a real value, just struck through');

    rage.checked = false;
    rage.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(600);
    expect(blocked('Hide'), false, 'AC3: ending the rage clears it');
    await newCharacter();
  });

  regression('SME2: soulmeld defences reach the right totals, and stay out of the wrong ones', async () => {
    if (typeof SoulmeldEffects === 'undefined') fail('SME2: soulmeld-effects.js not loaded');
    await newCharacter();
    await waitForDb();
    setAbilities({ DEX: 10 });          // mod 0, so the AC arithmetic is legible
    set('char-level', '12');
    // NOT setting #sm-base-capacity: a synthetic `input` is not trusted, and
    // the clear-on-user-edit listener only stands down for a TRUSTED event, so
    // syncBaseCapacityFromLevel silently writes the level-12 value straight
    // back over it. This spec used to set 5 and then quietly run on 3. It does
    // not need a particular base — every shape() below adds 3 extra capacity,
    // which is all the essentia any of them invests.
    await wait(300);

    const shape = async (slotId, name, bind) => {
      const slot = $(`.magic-item-slot[data-slot-id="${slotId}"]`);
      // ENABLE the slot's soulmeld first. Without this the name and the pips
      // are filled in on a slot that is not shaped, nothing reaches the
      // character, and the whole scenario reads as a clean 10/10/10 — which is
      // how this spec sat red while the feature underneath it worked.
      const check = slot.querySelector('.slot-soulmeld-check');
      if (!check.checked) {
        check.checked = true;
        check.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(250);
      }
      const inp = slot.querySelector('.slot-sm-name');
      inp.value = name;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(800);
      const cap = slot.querySelector('.slot-sm-extra-cap');
      cap.value = '3';
      cap.dispatchEvent(new Event('input', { bubbles: true }));
      cap.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(600);
      const pips = slot.querySelectorAll('.essentia-pips:not(.essentia-pips-2) .essentia-pip');
      if (pips.length < 3) fail(`SME2: ${name} got ${pips.length} essentia pips, needed 3`);
      pips[2].click();
      await wait(400);
      if (bind) {
        const b = slot.querySelector('.slot-sm-bound');
        b.checked = true;
        b.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(400);
      }
    };

    // Wormtail Belt: +2 enhancement NATURAL ARMOR, +1 per essentia -> +5 at 3.
    await shape('waist', 'Wormtail Belt', false);
    window.recalcAll();
    await wait(400);

    // THE GUARD this test exists for. Natural armor never applies against a
    // touch attack. The first cut summed every soulmeld AC point into one
    // untyped bucket that character.js adds to the full, touch AND flat-footed
    // totals alike, so this read 15/15/15 and a touch attack was resolving
    // against armour that does not stop it.
    expect($('#ac-total').textContent, '15', 'SME2: +5 natural armor reaches normal AC');
    expect($('#ac-touch').textContent, '10', 'SME2: ...and NOT touch AC');
    expect($('#ac-flatfooted').textContent, '15', 'SME2: ...but does apply flat-footed');

    // Frost Helm: cold resistance 5 per essentia -> 15, unconditional, so it
    // belongs in the structured rider list rather than in a number only this
    // module knows about.
    await shape('head', 'Frost Helm', false);
    window.recalcAll();
    await wait(500);
    const riders = Array.from(document.querySelectorAll('.defense-rider-row'))
      .filter(r => (r.dataset.from || '').indexOf('soulmeld:') === 0)
      .map(r => `${r.querySelector('.rider-kind').value}:${r.querySelector('.rider-amount').value}:${r.querySelector('.rider-type').value}`);
    expect(riders.join(','), 'resistance:15:cold',
      'SME2: an unconditional energy resistance becomes a real rider row');

    // Wind Cloak's DR is "2/magic, +2 per essentia" but ONLY against ranged
    // weapons. A structured DR row has nowhere to put that condition, so
    // entering it flat would claim a defence the character does not have.
    await shape('shoulders', 'Wind Cloak', false);
    window.recalcAll();
    await wait(500);
    const drFromMeld = Array.from(document.querySelectorAll('.dr-entry-row'))
      .filter(r => (r.dataset.from || '').indexOf('soulmeld:') === 0);
    expect(drFromMeld.length, 0,
      'SME2: a CONDITIONAL damage reduction must not become a flat DR row');
    const skipped = SoulmeldEffects.getDefenseRiderSpec().conditional
      .map(e => e.bonus_type);
    expect(skipped.indexOf('damage_reduction') !== -1, true,
      'SME2: ...and is reported as skipped rather than dropped silently');

    // Unshaping retires the rows it owned — a rider nothing grants any more is
    // worse than one that never appeared.
    const head = $('.magic-item-slot[data-slot-id="head"] .slot-sm-name');
    head.value = '';
    head.dispatchEvent(new Event('input', { bubbles: true }));
    head.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(900);
    const stillThere = Array.from(document.querySelectorAll('.defense-rider-row'))
      .filter(r => r.dataset.from === 'soulmeld:Frost Helm').length;
    expect(stillThere, 0, 'SME2: unshaping retires the rider rows it granted');

    await newCharacter();
  });

  // Exhaustive variant — round-trips EVERY library save. Slow; run on
  // demand from the console, not part of the default suite.
  async function runSaveRoundTrip() {
    const all = await SaveBackend.list();
    const lib = all.filter(e => (e.folder || '').split('/')[0] === 'library');
    const pool = lib.length ? lib : all;
    const failures = [];
    for (const entry of pool) {
      let blob;
      try { blob = await SaveBackend.load(entry.qualified); }
      catch (e) { failures.push(`${entry.qualified}: load threw ${e.message}`); continue; }
      if (!blob) continue;
      appLoad(blob); await wait(40); const A = appCollect();
      appLoad(A);    await wait(40); const B = appCollect();
      const d = rtFirstDiff(A, B, '$');
      if (d) failures.push(`${entry.qualified}: ${d}`);
    }
    await newCharacter();
    console.log(`[playfeel] runSaveRoundTrip: ${failures.length} not-fixed-point of ${pool.length}`);
    if (failures.length) console.log(failures.join('\n'));
    return { total: pool.length, failures };
  }

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
    if (isRunning) {
      setStatus('⚠ A run is already in progress — wait for it to finish.');
      return null;
    }
    isRunning = true;
    try {
      return await runClassSweepInner(opts);
    } finally {
      isRunning = false;
    }
  }

  async function runClassSweepInner(opts = {}) {
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
    if (isRunning) {
      setStatus('⚠ A run is already in progress — wait for it to finish.');
      return lastResults;
    }
    isRunning = true;
    try {
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
    } finally {
      isRunning = false;
    }
  }

  async function runSpec(spec) {
    if (isRunning) {
      setStatus('⚠ A run is already in progress — wait for it to finish.');
      return null;
    }
    isRunning = true;
    try {
      await waitForDb();
      setStatus(`Running ${spec.name}…`);
      renderRunning(spec);
      const r = await runOne(spec);
      renderResult(r);
      setStatus(r.status === 'pass' ? `✓ ${spec.name}` : `✗ ${spec.name}: ${r.error}`);
      return r;
    } finally {
      isRunning = false;
    }
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
    runAll, runSpec, runClassSweep, runSaveRoundTrip,
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
