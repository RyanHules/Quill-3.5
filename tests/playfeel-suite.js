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
    expectValue('[data-caster-type="invocations"] .invo-level', '5', 'SA1: Invoker Level 5');
    expectValue('[data-caster-type="invocations"] .invo-caster-level', '5', 'SA1: Caster Level 5');
    // invocations_known is in the Warlock class_table columns (L5 → 3).
    expectValue('[data-caster-type="invocations"] .invo-known-count', '3', 'SA1: Invocations Known 3');
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
    expectValue('[data-caster-type="invocations"] .invo-level', '5', 'SA4: Invoker Level 5');
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
    set('char-race', 'Aquatic Elf');
    await wait(200);
    const slv = panelTextFor('Superior Low-Light Vision');
    if (slv == null) fail('SA-INFO: Aquatic Elf did not auto-fill Superior Low-Light Vision');
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
