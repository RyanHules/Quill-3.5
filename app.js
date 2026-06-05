// D&D 3.5 Character Sheet - Main Application (coordinator)
// Delegates tab-specific logic to: character.js, skills.js, equipment.js,
// spells.js, feats.js, companion.js, class-features.js

(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ============================================================
  // Auto-expanding textareas
  // ============================================================
  function autoExpand(el) {
    if (!el) return;
    el.style.height = "auto";
    const h = el.scrollHeight;
    if (h > 0) {
      el.style.height = h + "px";
      return;
    }
    // scrollHeight is 0 when the element is inside a hidden tab,
    // closed <details>, or otherwise not laid out yet. Retry after
    // the next paint — by then layout has settled. This is the
    // root-cause fix for the "multi-line textarea shows as 1 line
    // after load until I click it" bug: load happens before the
    // freshly-activated tab has laid out its contents.
    requestAnimationFrame(() => {
      const h2 = el.scrollHeight;
      if (h2 > 0) el.style.height = h2 + "px";
    });
  }

  document.addEventListener("input", (e) => {
    if (e.target.tagName === "TEXTAREA") autoExpand(e.target);
  });

  // <details> elements (Class Lookup, Build Timeline, etc.) lay out
  // their contents only when open — any textarea inside reports
  // scrollHeight=0 while closed. Re-expand on every open so notes
  // restored from a save don't show as single-line until clicked.
  document.addEventListener("toggle", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || t.tagName !== "DETAILS") return;
    if (!t.open) return;
    t.querySelectorAll("textarea").forEach(autoExpand);
  }, true);  // capture, since `toggle` doesn't bubble

  function autoExpandAll() {
    $$("textarea").forEach((ta) => autoExpand(ta));
  }

  // Expose for use by other modules (e.g., spells.js sub-tab switching)
  window.autoExpand = autoExpand;
  window.autoExpandAll = autoExpandAll;

  // ============================================================
  // Tab navigation
  // ============================================================
  $$(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".tab").forEach((t) => t.classList.remove("active"));
      $$(".tab-content").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      $(`#${btn.dataset.tab}`).classList.add("active");
      setTimeout(autoExpandAll, 10);
    });
  });

  // Inner tabs for non-spells tabs (if any)
  $$(".inner-tab[data-inner]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const parent = btn.closest(".tab-content");
      parent.querySelectorAll(".inner-tab").forEach((t) => t.classList.remove("active"));
      parent.querySelectorAll(".inner-tab-content").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      $(`#${btn.dataset.inner}`).classList.add("active");
      setTimeout(autoExpandAll, 10);
    });
  });

  // ============================================================
  // Get ability modifier (used by multiple modules)
  // ============================================================
  function getAbilityMod(ability, abilityBonuses) {
    const ab = ability.toLowerCase();
    const base = $(`#${ab}-score`)?.value;
    const race = $(`#${ab}-race`)?.value;
    const tpl  = $(`#${ab}-template`)?.value;
    // "—" (em dash), "–" (en dash), or "-" (hyphen) means "no ability
    // score" — RAW says constructs/undead with no score get +0 mod, not
    // the -5 a literal 0 would produce. Short-circuit before the
    // arithmetic so racial/template/bonus/temp adjustments don't bring a
    // scoreless ability back into negative-mod territory.
    if (base === "—" || base === "–" || base === "-") return 0;
    let score = parseInt(base) || 0;
    score += parseInt(race) || 0;  // racial adjustment always applies
    score += parseInt(tpl)  || 0;  // template adjustment (Half-Dragon, etc.)
    if (abilityBonuses) score += abilityBonuses[ability] || 0;
    // Temp is a temporary ADJUSTMENT to the score (e.g. +4 Bull's Strength,
    // -2 ability damage), not a full alternate score — so it stacks like
    // every other modifier rather than replacing the base.
    score += parseInt($(`#${ab}-temp`)?.value) || 0;
    return DND35.abilityModifier(score);
  }

  // ============================================================
  // Bonus layer — collects active bonuses from all sources
  // Returns { abilities: { STR: N, ... }, saves: { will: N, ... }, ac: N }
  // ============================================================
  function collectActiveBonuses() {
    // `abilities` is the merged active-bonus sum used for modifier math.
    // `bloodlineAbilities` mirrors only the bloodline portion so the
    // Character tab can show it in the Template / Bloodline column instead
    // of lumping it into the Item Bonus column.
    const bonuses = { abilities: {}, saves: {}, ac: 0, bloodlineAbilities: {} };

    // Class features (rage, future: other toggles)
    if (typeof ClassFeatures.getActiveBonuses === "function") {
      const cf = ClassFeatures.getActiveBonuses();
      for (const [ab, val] of Object.entries(cf.abilities || {})) {
        bonuses.abilities[ab] = (bonuses.abilities[ab] || 0) + val;
      }
      for (const [save, val] of Object.entries(cf.saves || {})) {
        bonuses.saves[save] = (bonuses.saves[save] || 0) + val;
      }
      bonuses.ac += cf.ac || 0;
    }

    // Equipment: worn item ability bonuses
    if (typeof Equipment.getActiveBonuses === "function") {
      const eq = Equipment.getActiveBonuses();
      for (const [ab, val] of Object.entries(eq.abilities || {})) {
        bonuses.abilities[ab] = (bonuses.abilities[ab] || 0) + val;
      }
    }

    // Conditions: penalties from active conditions (Fatigued/Exhausted
    // hit Str/Dex; Blinded/Cowering/etc. hit AC; Shaken/etc. hit
    // saves). Other effects (attack penalty, skill penalty, speed
    // multiplier) surface in the Conditions summary but aren't yet
    // auto-applied — see TODO Phase 2.
    if (typeof Conditions !== "undefined" &&
        typeof Conditions.getActiveBonuses === "function") {
      const cn = Conditions.getActiveBonuses();
      for (const [ab, val] of Object.entries(cn.abilities || {})) {
        bonuses.abilities[ab] = (bonuses.abilities[ab] || 0) + val;
      }
      for (const [save, val] of Object.entries(cn.saves || {})) {
        bonuses.saves[save] = (bonuses.saves[save] || 0) + val;
      }
      bonuses.ac += cn.ac || 0;
      // Carry-through flags for downstream consumers.
      if (cn.loseDexToAC) bonuses.loseDexToAC = true;
      if (cn.dexToZero)   bonuses.dexToZero = true;
      if (cn.strToZero)   bonuses.strToZero = true;
    }

    // Bloodline: permanent ability-score bumps from the active traits
    // of the selected UA bloodline + strength (e.g. Fireclaw CHA at L3,
    // DEX at L6, CON at L8). Derived live from the selection + current
    // character level — no persisted ability field to collide with the
    // Template-column writers.
    if (typeof Bloodline !== "undefined" &&
        typeof Bloodline.getActiveBonuses === "function") {
      const bl = Bloodline.getActiveBonuses();
      for (const [ab, val] of Object.entries(bl.abilities || {})) {
        bonuses.abilities[ab] = (bonuses.abilities[ab] || 0) + val;
        bonuses.bloodlineAbilities[ab] =
          (bonuses.bloodlineAbilities[ab] || 0) + val;
      }
    }

    return bonuses;
  }

  // ============================================================
  // Recalculate everything (orchestrator)
  // ============================================================
  function recalcAll() {
    const bonuses = collectActiveBonuses();
    const getModWithBonuses = (ability) => getAbilityMod(ability, bonuses.abilities);

    Character.recalc(getModWithBonuses, bonuses);
    Skills.recalc(getModWithBonuses);
    Spells.recalc(getModWithBonuses);
    Equipment.updatePaperDoll();

    // Re-run the audit after every recalc so the floating widget
    // reflects current state across all tabs.
    if (typeof Audit !== "undefined") {
      document.dispatchEvent(new Event("audit-refresh"));
    }

    // Visual indicator for rage
    const rageSection = $("#rage-section");
    if (rageSection) {
      rageSection.classList.toggle("rage-active", $("#rage-active")?.checked || false);
    }
  }

  // ============================================================
  // Save / Load / Export / Import
  // ============================================================
  function collectData() {
    return Object.assign({},
      Character.collectData(),
      Equipment.collectData(),
      Spells.collectData(),
      Feats.collectData(),
      Companion.collectData(),
      ClassFeatures.collectData(),
      typeof Bloodline !== "undefined" ? Bloodline.collectData() : {},
      typeof Conditions !== "undefined" ? Conditions.collectData() : {},
      typeof Audit !== "undefined" ? Audit.collectData() : {},
      typeof CharacterHistory !== "undefined" ? CharacterHistory.collectData() : {},
      typeof BookFilter !== "undefined" ? BookFilter.collectData() : {},
      typeof HomebrewFilter !== "undefined" ? HomebrewFilter.collectData() : {},
      { skills: Skills.collectData(), customSkills: Skills.collectCustomSkills() }
    );
  }

  function loadData(data) {
    if (!data) return;
    Character.loadData(data, getAbilityMod);
    Equipment.loadData(data);
    Spells.loadData(data);
    Feats.loadData(data);
    Companion.loadData(data);
    ClassFeatures.loadData(data);
    if (typeof Bloodline !== "undefined") Bloodline.loadData(data);
    if (typeof Conditions !== "undefined") Conditions.loadData(data);
    if (typeof Audit !== "undefined") Audit.loadData(data);
    if (typeof BookFilter !== "undefined") BookFilter.loadData(data);
    if (typeof HomebrewFilter !== "undefined") HomebrewFilter.loadData(data);
    if (data.skills) Skills.loadData(data.skills, getAbilityMod);
    Skills.loadCustomSkills(data.customSkills || [], getAbilityMod);
    // CharacterHistory runs LAST so it can reconstruct from current
    // totals if the saved data has no history field (migration path).
    // The reconstruction inputs (applied classes, current feat names,
    // per-class hit dies) are read off the now-populated state.
    if (typeof CharacterHistory !== "undefined") {
      const pickedClasses = (typeof ClassPicker !== "undefined" &&
                  typeof ClassPicker.getState === "function")
        ? ClassPicker.getState() : [];
      const opts = {
        classes: pickedClasses,
        feats: collectCurrentFeatNames(),
        options: {
          pathfinderFeats: false,
          hitDieByClass: collectHitDiceFromDB(pickedClasses),
        },
      };
      CharacterHistory.loadData(data, opts);
    }
    if (typeof BuildTimeline !== "undefined") BuildTimeline.render();
    recalcAll();
    setTimeout(autoExpandAll, 20);
  }

  // Helper used by CharacterHistory reconstruction. Gathers feat names
  // from the Feats tab's textareas (first line of each .feat-entry,
  // stripped of trailing parentheticals) so we can lay them onto the
  // RAW feat schedule when reconstructing a missing history.
  // Query the DB for each applied class's hit_die value so reconstruct-
  // FromTotals can populate the per-level hp_rolled with the right
  // average (Wizard d4 = 3 HP / level after L1, etc.) instead of
  // falling back to its generic d8 default.
  function collectHitDiceFromDB(pickedClasses) {
    if (typeof DB === "undefined" || !DB.isLoaded()) return {};
    const out = {};
    for (const c of pickedClasses) {
      if (!c.className) continue;
      const row = DB.queryOne(
        "SELECT json_extract(data, '$.hit_die') AS hd FROM entry " +
        "WHERE type IN ('class','prc') AND name = :n COLLATE NOCASE LIMIT 1",
        { ":n": c.className });
      if (row && row.hd) out[c.className] = parseInt(row.hd, 10) || 8;
    }
    return out;
  }

  function collectCurrentFeatNames() {
    const out = [];
    for (const el of document.querySelectorAll("#feats-container .feat-entry")) {
      const raw = (el.value || "").trim();
      if (!raw) continue;
      const firstLine = raw.split(/\r?\n/)[0].trim();
      const stripped = firstLine.replace(/\s*\([^)]*\)\s*$/, "").trim();
      if (stripped) out.push(stripped);
    }
    return out;
  }

  // ---- Persistence ----
  //
  // All save / load / delete operations route through SaveBackend
  // (save-backend.js), which transparently picks server mode (Python
  // save_server.py serving /api/saves over filesystem-backed JSON)
  // when available, falling back to localStorage when the page is
  // served by plain `python -m http.server`. The functions below
  // are async because SaveBackend is async — call sites are event
  // handlers, which handle async functions fine.

  // The qualified name (folder + name) of the currently-loaded
  // character. Set on loadCharacter; cleared on newCharacter. When
  // set, saveCharacter writes to that path so loading active/Dust
  // and pressing Save overwrites saves/active/Dust.json rather than
  // duplicating to saves/dust.json.
  //
  // Exposed via window.AppState so the character-list modal can
  // read + write it (clicking a row should update it, and the
  // modal's "Save here" form needs to set it before saving).
  let currentQualifiedName = null;
  window.AppState = {
    get currentQualifiedName() { return currentQualifiedName; },
    set currentQualifiedName(v) { currentQualifiedName = v; },
  };

  // Decide which qualified name a Save click should write to.
  //   - If a character was loaded from a specific path, overwrite
  //     that path (preserves folder organization).
  //   - Else default to the bare char-name at the root of saves/.
  // Returns null if there's no usable name (e.g. fresh sheet with
  // an empty char-name field) — caller should handle that case.
  function resolveSaveTarget(data) {
    if (currentQualifiedName) return currentQualifiedName;
    const bare = (data["char-name"] || "").trim();
    return bare || null;
  }

  // The dropdown is for QUICK ACCESS to the working set, not the
  // full library (which could be 400+ entries — far too many to
  // scroll through). Limit it to:
  //   - root saves    (folder === '')
  //   - saves/active/ (folder === 'active')
  // The list-view modal (📂 button) handles the full library
  // including saves/library/ and any future custom folders.
  function isDropdownVisible(entry) {
    return !entry.folder || entry.folder === 'active';
  }

  async function updateCharacterSelect() {
    const select = $("#character-select");
    let entries = [];
    try {
      entries = await SaveBackend.list();
    } catch (e) {
      console.warn('[app] failed to list saves:', e);
      // Render an empty dropdown but don't blank the page — user can
      // still hand-type a name and save.
    }
    // Active / root saves only — full library lives in the modal.
    entries = entries.filter(isDropdownVisible)
      .sort((a, b) => a.qualified.localeCompare(b.qualified));
    select.innerHTML = '<option value="">-- Saved Characters --</option>';
    entries.forEach((e) => {
      const opt = document.createElement("option");
      opt.value = e.qualified;
      // Show "active/Dust" so the user can distinguish from a root
      // "Dust" if both somehow exist.
      opt.textContent = e.qualified;
      select.appendChild(opt);
    });
    // Re-sync the selection so the dropdown reflects what's loaded.
    if (currentQualifiedName) {
      select.value = currentQualifiedName;
    }
  }

  async function saveCharacter() {
    const data = collectData();
    const target = resolveSaveTarget(data);
    if (!target) {
      showNotification(
        'Cannot save: enter a character name first.', true);
      return;
    }
    try {
      await SaveBackend.save(target, data);
    } catch (e) {
      console.error('[app] save failed:', e);
      showNotification(`Save failed: ${e.message}`, true);
      return;
    }
    currentQualifiedName = target;
    await updateCharacterSelect();
    const where = SaveBackend.mode === 'server'
      ? ` (to ${target})` : '';
    showNotification(`Saved!${where}`);
  }

  async function loadCharacter(qualified) {
    let data;
    try {
      data = await SaveBackend.load(qualified);
    } catch (e) {
      console.error('[app] load failed:', e);
      showNotification(`Load failed: ${e.message}`, true);
      return;
    }
    if (data) {
      loadData(data);
      currentQualifiedName = qualified;
      // Sync the dropdown so it shows what was just loaded (even
      // when loaded via the modal, which is the common case for
      // library/ characters).
      const select = $("#character-select");
      if (select) {
        // If the loaded character isn't in the dropdown (i.e. it
        // came from saves/library/), refresh the dropdown to NOT
        // show it as selected — leave the dropdown's first item.
        if (isDropdownVisible({ folder: SaveBackend.parseQualified(qualified).folder })) {
          select.value = qualified;
        } else {
          select.value = '';
        }
      }
      showNotification(`"${qualified}" loaded!`);
    } else {
      showNotification(`"${qualified}" not found.`, true);
    }
  }

  async function deleteCharacter() {
    const qualified = $("#character-select").value;
    if (!qualified) return;
    if (!confirm(`Delete "${qualified}"?`)) return;
    try {
      await SaveBackend.delete(qualified);
    } catch (e) {
      console.error('[app] delete failed:', e);
      showNotification(`Delete failed: ${e.message}`, true);
      return;
    }
    if (currentQualifiedName === qualified) currentQualifiedName = null;
    await updateCharacterSelect();
    showNotification(`"${qualified}" deleted.`);
  }

  // Expose loadCharacter so the list-view modal can call it.
  // showNotification gets exposed below (after its definition) — it's
  // declared further down in this IIFE, so we do that wiring in a
  // separate window.App assignment near the notification block.
  window.App = window.App || {};
  window.App.loadCharacter = loadCharacter;
  window.App.updateCharacterSelect = updateCharacterSelect;

  // First-run migration prompt: shown ONCE if SaveBackend is in
  // server mode AND legacy localStorage has saves AND the user
  // hasn't already answered the prompt. After they answer (either
  // way) we set MIGRATION_DONE_KEY so the banner doesn't reappear.
  async function maybeOfferMigration() {
    await SaveBackend.ready;
    if (SaveBackend.mode !== 'server') return;
    if (!SaveBackend.hasLocalStorageSaves()) return;
    if (localStorage.getItem(SaveBackend.MIGRATION_DONE_KEY)) return;

    // Inline banner (not a modal — non-blocking, dismissable).
    const banner = document.createElement('div');
    banner.id = 'save-migration-banner';
    banner.style.cssText =
      'position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);' +
      'background:#2b3050;color:#dde;padding:0.75rem 1rem;border-radius:6px;' +
      'border:1px solid #557;box-shadow:0 4px 16px rgba(0,0,0,0.5);' +
      'font-size:0.9rem;max-width:540px;z-index:2000;display:flex;' +
      'gap:0.5rem;align-items:center;flex-wrap:wrap;';
    banner.innerHTML =
      '<span><b>Local save server detected.</b> Found ' +
      '<b>' + Object.keys(JSON.parse(
          localStorage.getItem(SaveBackend.CHARACTERS_KEY) || '{}'
        )).length + '</b> ' +
      'saves in browser storage. Migrate them to the server so they ' +
      'survive port / browser changes?</span>' +
      '<button id="mig-yes" style="background:#557;color:white;border:0;' +
      'padding:0.4rem 0.8rem;border-radius:4px;cursor:pointer;">' +
      'Migrate</button>' +
      '<button id="mig-no" style="background:transparent;color:#bbb;' +
      'border:1px solid #557;padding:0.4rem 0.8rem;border-radius:4px;' +
      'cursor:pointer;">Keep in browser</button>';
    document.body.appendChild(banner);

    banner.querySelector('#mig-yes').addEventListener('click', async () => {
      banner.querySelector('#mig-yes').disabled = true;
      banner.querySelector('#mig-yes').textContent = 'Migrating…';
      try {
        const r = await SaveBackend.migrateFromLocalStorage();
        localStorage.setItem(
          SaveBackend.MIGRATION_DONE_KEY,
          new Date().toISOString());
        banner.remove();
        const note = r.errors.length
          ? `Migrated ${r.copied} of ${r.total}. ` +
            `${r.errors.length} failed — check console for details.`
          : `Migrated ${r.copied} of ${r.total} saves to server.`;
        showNotification(note, r.errors.length > 0);
        await updateCharacterSelect();
      } catch (e) {
        console.error('[app] migration failed:', e);
        showNotification(`Migration failed: ${e.message}`, true);
      }
    });
    banner.querySelector('#mig-no').addEventListener('click', () => {
      localStorage.setItem(
        SaveBackend.MIGRATION_DONE_KEY,
        new Date().toISOString());
      banner.remove();
    });
  }

  function exportCharacter() {
    const data = collectData();
    const name = data["char-name"] || "character";
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/[^a-z0-9]/gi, "_")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importCharacter(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        loadData(data);
        showNotification("Character imported!");
      } catch {
        showNotification("Error: Invalid file format.", true);
      }
    };
    reader.readAsText(file);
  }

  function newCharacter() {
    if (!confirm("Start a new character? Unsaved changes will be lost.")) return;
    // Reset the loaded-character pointer so the next Save creates a
    // new file rather than overwriting the previous one.
    currentQualifiedName = null;
    $$("input, select, textarea").forEach((el) => {
      if (el.type === "checkbox") el.checked = (el.id === "armor-worn" || el.id === "shield-worn");
      else if (el.tagName === "SELECT") el.selectedIndex = el.id === "char-size" ? 4 : 0;
      else el.value = el.type === "number" && el.defaultValue ? el.defaultValue : "";
    });

    Character.resetAttacks();
    Character.addAttack();
    Skills.resetCustomSkills();
    Skills.build(getAbilityMod);
    Feats.loadData({ feats: [""], specialAbilities: [""] });
    $("#gear-body").innerHTML = "";
    for (let i = 0; i < 5; i++) Equipment.addGearRow();
    $("#magic-items-container").innerHTML = "";
    // Character.loadData triggers class-picker's persistence hook,
    // which clears `pickedClasses` and re-renders the chip list.
    // Without this, classes from the previous character stay
    // visually applied (reported 2026-05-16).
    Character.loadData({}, getAbilityMod);
    Spells.loadData({});
    Companion.loadData({});
    // Class customizations (ACFs / sub levels) live in a DOM list +
    // a JS Map, neither of which the generic input-reset loop above
    // clears — so without this the previous character's customizations
    // bleed into the fresh sheet (reported 2026-05-29). loadData({})
    // empties the list, the Map, and re-renders the empty state.
    ClassFeatures.loadData({});
    // Bloodline selection lives in a JS state object + a DOM panel the
    // generic input-reset loop only half-clears (it blanks the input
    // but not the module's internal `state`). loadData({}) resets both
    // so the previous character's bloodline + its ability bumps don't
    // bleed into the fresh sheet.
    if (typeof Bloodline !== "undefined") Bloodline.loadData({});
    // Clear the unified Race field's collision resolutions (Centaur/Gnoll
    // standard-vs-monster choices) so they don't carry into a new sheet.
    if (typeof RaceUnify !== "undefined" && RaceUnify.reset) RaceUnify.reset();
    // H1 (2026-05-16 play-feel pass): without this, the previous
    // character's Build Timeline rows bleed through into the fresh
    // character and the audit flags stale "Timeline has N Foo levels
    // but applied classes show 0" warnings. `Character.loadData({})`
    // already clears `pickedClasses`, so wiping history is now safe —
    // the next class-apply will dispatch `classes-changed` and let
    // app.js fabricate a fresh reconstruction from the new totals.
    if (typeof CharacterHistory !== "undefined") CharacterHistory.clear();
    if (typeof BuildTimeline !== "undefined") BuildTimeline.render();

    recalcAll();
    showNotification("New character sheet ready.");
  }

  // ============================================================
  // Notifications
  // ============================================================
  function showNotification(msg, isError = false) {
    let notif = $("#notification");
    if (!notif) {
      notif = document.createElement("div");
      notif.id = "notification";
      notif.style.cssText = `
        position: fixed; bottom: 1rem; right: 1rem; padding: 0.75rem 1.25rem;
        border-radius: 6px; font-size: 0.85rem; font-weight: 600;
        z-index: 1000; transition: opacity 0.3s; pointer-events: none;
      `;
      document.body.appendChild(notif);
    }
    notif.style.background = isError ? "#f44336" : "#4caf50";
    notif.style.color = "white";
    notif.textContent = msg;
    notif.style.opacity = "1";
    setTimeout(() => (notif.style.opacity = "0"), 2500);
  }

  // Expose for the character-library modal (and any other late-loading
  // module). It needs the lazy-creation behavior — poking #notification
  // directly silently dropped messages before any showNotification call
  // had created the element. That's how the 2026-05-25 "moves are
  // silent on failure" symptom surfaced.
  window.App = window.App || {};
  window.App.showNotification = showNotification;

  // ============================================================
  // Event wiring
  // ============================================================
  $("#btn-save").addEventListener("click", saveCharacter);
  $("#btn-export").addEventListener("click", exportCharacter);
  $("#btn-import").addEventListener("click", () => $("#file-import").click());
  $("#file-import").addEventListener("change", (e) => {
    if (e.target.files[0]) importCharacter(e.target.files[0]);
    e.target.value = "";
  });
  $("#btn-new").addEventListener("click", newCharacter);
  $("#btn-delete").addEventListener("click", deleteCharacter);
  $("#character-select").addEventListener("change", (e) => {
    if (e.target.value) loadCharacter(e.target.value);
  });
  $("#btn-add-spellcasting").addEventListener("click", () => Spells.addCaster("spellcasting"));
  $("#btn-add-psionics").addEventListener("click", () => Spells.addCaster("psionics"));
  $("#btn-add-maneuvers").addEventListener("click", () => Spells.addCaster("maneuvers"));
  $("#btn-add-invocations").addEventListener("click", () => Spells.addCaster("invocations"));
  $("#btn-add-epic").addEventListener("click", () => Spells.addCaster("epic"));
  $("#btn-add-binding").addEventListener("click", () => Spells.addCaster("binding"));
  $("#btn-add-shadowcaster").addEventListener("click", () => Spells.addCaster("shadowcaster"));
  $("#btn-add-companion").addEventListener("click", () => Companion.addCompanion());
  $("#btn-add-attack").addEventListener("click", () => Character.addAttack());
  $("#btn-add-feat").addEventListener("click", () => Feats.addFeat());
  $("#btn-add-special-ability").addEventListener("click", () => Feats.addSpecialAbility());
  $("#btn-add-gear").addEventListener("click", () => Equipment.addGearRow());
  $("#btn-add-magic-item").addEventListener("click", () => Equipment.addMagicItem());
  $("#btn-add-custom-skill").addEventListener("click", () => Skills.addCustomSkill());

  // H2 (2026-05-16 play-feel pass): when the applied-class set
  // changes via class-picker, reconstruct CharacterHistory if it
  // hasn't been explicitly authored yet. Without this hook, history
  // stays null after applying classes to a fresh sheet — and the
  // history-aware audit checks (Phase 1) silently no-op. Guarded
  // against overwriting a user-curated Timeline: if any non-
  // reconstructed history row exists, we leave it alone and let the
  // Build Timeline view handle reconciliation drift via its own
  // audit warnings.
  document.addEventListener("classes-changed", () => {
    if (typeof CharacterHistory === "undefined") return;
    if (typeof BuildTimeline === "undefined") return;
    const existing = CharacterHistory.get();
    // BuildTimeline edits delete the _reconstructed property (rather
    // than setting it to false), so absence of the flag = user-edited.
    const hasUserEdits = Array.isArray(existing) && existing.length > 0 &&
      existing.some(row => row && !row._reconstructed);
    if (hasUserEdits) {
      // User has touched the Timeline — render to surface drift
      // warnings but don't fabricate over their edits.
      BuildTimeline.render();
      return;
    }
    const pickedClasses = (typeof ClassPicker !== "undefined" &&
                typeof ClassPicker.getState === "function")
      ? ClassPicker.getState() : [];
    if (!pickedClasses.length) {
      // No classes — clear stale reconstruction.
      CharacterHistory.clear();
      BuildTimeline.render();
      return;
    }
    const rebuilt = CharacterHistory.reconstructFromTotals(
      pickedClasses,
      collectCurrentFeatNames(),
      {
        pathfinderFeats: false,
        hitDieByClass: collectHitDiceFromDB(pickedClasses),
      },
    );
    CharacterHistory.set(rebuilt, { reconstructed: true });
    BuildTimeline.render();
  });

  // Auto-recalc on any input change in relevant tabs
  document.addEventListener("input", (e) => {
    const target = e.target;
    if (
      target.closest("#tab-character") ||
      target.closest("#tab-skills") ||
      target.closest("#tab-equipment") ||
      target.closest("#tab-spells") ||
      target.closest("#tab-class-features") ||
      target.id === "char-level"
    ) {
      recalcAll();
    }
  });

  // Also recalc on change events (dropdowns, checkboxes)
  $("#char-size").addEventListener("change", recalcAll);
  $("#armor-worn").addEventListener("change", recalcAll);
  $("#shield-worn").addEventListener("change", recalcAll);
  $("#armor-touch-ac").addEventListener("change", recalcAll);
  $("#ignore-encumbrance")?.addEventListener("change", recalcAll);
  $("#shield-touch-ac").addEventListener("change", recalcAll);
  $("#rage-active").addEventListener("change", recalcAll);
  ["con","int","wis","cha"].forEach(ab => {
    $(`#${ab}-to-ac`)?.addEventListener("change", recalcAll);
    $(`#${ab}-to-ac-type`)?.addEventListener("change", recalcAll);
  });
  document.addEventListener("change", (e) => {
    if (e.target.closest("#tab-equipment") || e.target.closest("#tab-spells")) recalcAll();
  });

  // ============================================================
  // Initialize
  // ============================================================
  Skills.build(getAbilityMod);
  Equipment.buildMagicItemSlots();
  if (typeof Conditions !== "undefined") Conditions.build();
  if (typeof Audit !== "undefined") Audit.build();
  if (typeof BuildTimeline !== "undefined") BuildTimeline.init();

  Character.addAttack();
  for (let i = 0; i < 5; i++) Equipment.addGearRow();
  Feats.addFeat();
  Feats.addSpecialAbility();
  Companion.loadData({});

  // Conditions-changed event → re-aggregate bonuses + recalc.
  document.addEventListener("conditions-changed", recalcAll);
  // Item-familiar-changed: skill bonuses / bonus slots / XP multiplier
  // can shift, so refresh every tab's recalcs.
  document.addEventListener("item-familiar-changed", recalcAll);
  // Bloodline-changed: selection / strength / character-level shifts can
  // change the auto-applied ability bumps, so re-aggregate + recalc.
  document.addEventListener("bloodline-changed", recalcAll);

  // Initial population is async; fire-and-forget — recalcAll doesn't
  // depend on it. The dropdown will fill in once SaveBackend resolves
  // (server probe takes <50 ms typically).
  updateCharacterSelect();
  maybeOfferMigration();
  recalcAll();

  // Ctrl+S to save
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      saveCharacter();
    }
  });

  // Initial auto-expand
  setTimeout(autoExpandAll, 50);
})();
