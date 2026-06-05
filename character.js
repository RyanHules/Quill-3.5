// D&D 3.5 Character Sheet - Character Tab Module

const Character = (function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const int = (v) => parseInt(v) || 0;
  const expr = (v) => DND35.evalExpr(v);
  const fmt = (n) => (n >= 0 ? "+" + n : String(n));

  let attackCount = 0;

  // ============================================================
  // Recalculate character tab fields
  // ============================================================
  function recalc(getAbilityMod, bonuses = {}) {
    const abilityBonuses = bonuses.abilities || {};
    const bloodlineBonuses = bonuses.bloodlineAbilities || {};
    const saveBonuses = bonuses.saves || {};
    const acBonus = bonuses.ac || 0;

    // Ability modifiers. The merged `bonus` still drives the math; for
    // DISPLAY we split it so the derived Template / Bloodline column carries
    // template + bloodline and the Misc column carries the rest (items / rage
    // / conditions). Both hide when empty. The Modifier is the EFFECTIVE mod —
    // getAbilityMod folds in the Temp adjustment (delta).
    let anyTplbl = false;
    let anyMisc = false;
    DND35.abilities.forEach((ab) => {
      const lower = ab.toLowerCase();
      const bonus = abilityBonuses[ab] || 0;             // merged active bonus
      const bloodlineBonus = bloodlineBonuses[ab] || 0;  // bloodline portion
      const miscBonus = bonus - bloodlineBonus;          // items/rage/conditions
      const rawScore = int($(`#${lower}-score`).value);
      const raceMod = int($(`#${lower}-race`)?.value);   // racial adjustment
      const tplMod  = int($(`#${lower}-template`)?.value); // template (hidden backing input)
      const totalScore = rawScore + raceMod + tplMod + bonus;  // permanent total
      // Misc column — non-bloodline active bonuses; hides when empty.
      const miscEl = $(`#${lower}-misc`);
      if (miscEl) miscEl.textContent = miscBonus ? fmt(miscBonus) : "";
      if (miscBonus !== 0) anyMisc = true;
      // Template / Bloodline column — template adjustment + bloodline bumps.
      const tplblVal = tplMod + bloodlineBonus;
      const tplblEl = $(`#${lower}-tplbl`);
      if (tplblEl) tplblEl.textContent = tplblVal ? fmt(tplblVal) : "";
      if (tplblVal !== 0) anyTplbl = true;
      // Total = permanent score (only when there's a base score). Modifier =
      // effective mod, including the writable Temp adjustment.
      const totalEl = $(`#${lower}-total`);
      if (totalEl) totalEl.textContent = rawScore ? totalScore : "";
      $(`#${lower}-mod`).textContent = fmt(getAbilityMod(ab));
    });
    // Hide the derived columns entirely when nothing's in them (common case).
    const abilityTable = document.querySelector(".ability-table");
    if (abilityTable) {
      abilityTable.classList.toggle("hide-tplbl-col", !anyTplbl);
      abilityTable.classList.toggle("hide-misc-col", !anyMisc);
    }

    // Size modifier
    const size = $("#char-size").value;
    const sizeData = DND35.sizes[size] || DND35.sizes["Medium"];

    // ---- Armor auto-application ----
    const armorWorn = $("#armor-worn").checked;
    const shieldWorn = $("#shield-worn").checked;
    const armorACBonus = armorWorn ? int($("#armor-ac-bonus").value) : 0;
    const shieldACBonus = shieldWorn ? int($("#shield-ac-bonus").value) : 0;
    const armorMaxDexStr = $("#armor-max-dex").value.trim();
    const armorMaxDex = armorWorn && armorMaxDexStr !== "" ? int(armorMaxDexStr) : Infinity;
    const armorCheckPen = armorWorn ? int($("#armor-check-pen").value) : 0;
    const shieldCheckPen = shieldWorn ? int($("#shield-check-pen").value) : 0;
    const armorTotalCheckPen = armorCheckPen + shieldCheckPen;
    const armorSpellFail = armorWorn ? int($("#armor-spell-fail").value) : 0;
    const shieldSpellFail = shieldWorn ? int($("#shield-spell-fail").value) : 0;
    const totalSpellFailure = armorSpellFail + shieldSpellFail;

    // Auto-set AC armor/shield fields on character tab (now read-only spans)
    $("#ac-armor").textContent = armorACBonus;
    $("#ac-shield").textContent = shieldACBonus;

    // ---- Carrying load penalties (Table 9-2, PHB p.162) ----
    const strScore = int($("#str-score").value) || 10;
    const rawCapacity = DND35.getCarryingCapacity(strScore);
    const carryMult = sizeData.carryMult || 1;
    const capacity = rawCapacity.map(v => Math.floor(v * carryMult));
    let totalWeight = 0;
    // Scope to `tr.gear-row` — the collapsible item-rules panel rows
    // (`tr.gear-rules-row`) carry no .gear-weight input.
    $$("#gear-body tr.gear-row").forEach((row) => {
      totalWeight += parseFloat(row.querySelector(".gear-weight")?.value) || 0;
    });
    totalWeight += parseFloat($("#armor-weight").value) || 0;
    totalWeight += parseFloat($("#shield-weight").value) || 0;
    // Magic items: every .magic-item-entry has its own weight input.
    // Same gap as the coin-weight fix below — encumbrance ignored
    // magic-item weight entirely until 2026-05-18 (a +5 plate cloak
    // and other worn magic items silently dropped off the load).
    // Mirrors equipment.js#recalcWeight's same line.
    $$("#magic-items-container .magic-item-entry").forEach((entry) => {
      totalWeight += parseFloat(entry.querySelector(".mi-weight")?.value) || 0;
    });
    // Coin weight — per PHB, 50 coins of any type weigh 1 lb. Without
    // this the load category ignored money entirely (gear summary
    // showed it, but the displayed total + encumbrance penalty used a
    // money-less number — easy to overload a character without
    // realizing). Mirrors equipment.js#recalcWeight's same line.
    const coinCount = ["money-cp", "money-sp", "money-gp", "money-pp"]
      .reduce((sum, id) => sum + (parseInt($(`#${id}`)?.value) || 0), 0);
    totalWeight += coinCount / 50;
    const loadCategory = DND35.getLoadCategory(totalWeight, capacity);
    // "Ignore encumbrance" toggle short-circuits load-based penalties
    // — used for Dwarves (speed unaffected by load), monks at their
    // class-feature speed (Slow Fall etc. are conditional), and other
    // niche features. Default off.
    const ignoreEncumbrance = $("#ignore-encumbrance")?.checked;
    const effectiveLoadCategory = ignoreEncumbrance ? "light" : loadCategory;
    const loadPenalties = DND35.carryingLoads[effectiveLoadCategory];

    // Use worse of armor or load for max dex and check penalty (don't stack)
    const effectiveMaxDex = Math.min(armorMaxDex, loadPenalties.maxDex);
    const effectiveCheckPenalty = Math.min(armorTotalCheckPen, loadPenalties.checkPenalty);

    // Speed reduction from load (PHB Table 9-2). Light → no change;
    // medium/heavy → reducedSpeed() drops by ~1/3 (rounded to 5 ft).
    // Parses leading integer from the base-speed input ("30 ft." → 30)
    // so the user can keep their preferred annotation format.
    const baseSpeedRaw = String($("#char-speed")?.value || "");
    const baseSpeedMatch = baseSpeedRaw.match(/-?\d+/);
    const baseSpeed = baseSpeedMatch ? parseInt(baseSpeedMatch[0], 10) : 0;
    const speedReduces = !ignoreEncumbrance &&
                          (loadCategory === "medium" || loadCategory === "heavy");
    const currentSpeed = speedReduces ? DND35.reducedSpeed(baseSpeed) : baseSpeed;
    const speedEl = $("#speed-current");
    if (speedEl) {
      if (!baseSpeed) {
        speedEl.textContent = "--";
        speedEl.classList.remove("speed-reduced");
      } else if (speedReduces && currentSpeed < baseSpeed) {
        speedEl.textContent = `${currentSpeed} ft (from ${baseSpeed})`;
        speedEl.classList.add("speed-reduced");
      } else {
        speedEl.textContent = `${currentSpeed} ft`;
        speedEl.classList.remove("speed-reduced");
      }
    }

    // Auto-set armor check penalty (effective = worse of armor or load)
    $("#armor-check-penalty").value = effectiveCheckPenalty;
    $("#armor-check-penalty-display").textContent = effectiveCheckPenalty;

    // Auto-set arcane spell failure (read by Spells.recalc for display in each spellcasting panel)
    $("#arcane-spell-failure").value = totalSpellFailure;

    // Show load category
    const loadDisplayEl = $("#load-category");
    if (loadDisplayEl) {
      loadDisplayEl.textContent = loadCategory.charAt(0).toUpperCase() + loadCategory.slice(1);
      loadDisplayEl.className = `load-indicator load-${loadCategory}`;
    }

    // AC calculation with max dex cap (worse of armor or load).
    // Conditions (Flat-footed / Blinded / Helpless / Paralyzed /
    // Stunned / Cowering / Pinned) zero out the Dex contribution via
    // `bonuses.loseDexToAC`; Paralyzed / Helpless additionally drop
    // the Dex score itself to 0 (modeled as `bonuses.dexToZero`).
    let dexMod = getAbilityMod("DEX");
    if (bonuses.dexToZero) dexMod = DND35.abilityModifier(0);  // mod = -5
    let cappedDexMod = Math.min(dexMod, effectiveMaxDex);
    if (bonuses.loseDexToAC && cappedDexMod > 0) cappedDexMod = 0;
    const naturalArmor = int($("#ac-natural").value);
    const acMisc = expr($("#ac-misc").value);
    const acSize = sizeData.acMod;

    $("#ac-dex").textContent = fmt(cappedDexMod);
    $("#ac-size").textContent = fmt(acSize);

    // Ability-to-AC bonuses (e.g. Monk WIS, Paladin CHA)
    const abilityACItems = [];
    ["CON", "INT", "WIS", "CHA"].forEach((ab) => {
      const lower = ab.toLowerCase();
      if ($(`#${lower}-to-ac`)?.checked) {
        const abMod = getAbilityMod(ab);
        if (abMod > 0) {
          const type = $(`#${lower}-to-ac-type`)?.value || "Untyped";
          // Ability-to-AC applies to touch and flat-footed (dodge doesn't apply to FF)
          abilityACItems.push({ type, ac: abMod, touch: true, flatfooted: type !== "Dodge" });
        }
      }
    });

    // Resolve protective item bonuses with D&D 3.5 stacking rules
    // Same bonus type: take highest (except dodge, circumstance, untyped which stack)
    const protItems = Equipment.getProtectiveItems().concat(abilityACItems);
    const STACKING_TYPES = ["Dodge", "Circumstance", "Untyped"];

    // Seed with character tab bonuses
    const armorTouchAC = $("#armor-touch-ac")?.checked || false;
    const shieldTouchAC = $("#shield-touch-ac")?.checked || false;
    const bestByType = {
      "Armor": { ac: armorACBonus, touch: armorTouchAC, flatfooted: true },
      "Shield": { ac: shieldACBonus, touch: shieldTouchAC, flatfooted: true },
      "Natural Armor": { ac: naturalArmor, touch: false, flatfooted: true },
    };

    let stackingTotal = 0, stackingTouch = 0, stackingFF = 0;

    protItems.forEach((item) => {
      if (STACKING_TYPES.includes(item.type)) {
        stackingTotal += item.ac;
        if (item.touch) stackingTouch += item.ac;
        if (item.flatfooted) stackingFF += item.ac;
      } else {
        const existing = bestByType[item.type];
        if (!existing || item.ac > existing.ac) {
          bestByType[item.type] = { ac: item.ac, touch: item.touch, flatfooted: item.flatfooted };
        }
      }
    });

    // Auto-set deflection display from resolved equipment bonuses
    const deflectionBest = bestByType["Deflection"];
    $("#ac-deflection").textContent = deflectionBest ? deflectionBest.ac : 0;

    // Show dynamic bonus type boxes for non-standard types from equipment
    const bonusTypesContainer = $("#ac-bonus-types");
    if (bonusTypesContainer) {
      bonusTypesContainer.innerHTML = "";
      const STANDARD_TYPES = ["Armor", "Shield", "Natural Armor", "Deflection"];
      Object.entries(bestByType).forEach(([type, data]) => {
        if (STANDARD_TYPES.includes(type) || data.ac === 0) return;
        const div = document.createElement("div");
        div.className = "field field-sm";
        div.innerHTML = `<label>${type}</label><span class="calc-field">${data.ac}</span>`;
        bonusTypesContainer.appendChild(div);
      });
    }

    // Sum resolved bonuses
    let resolvedTotal = 0, resolvedTouch = 0, resolvedFF = 0;
    Object.values(bestByType).forEach((best) => {
      resolvedTotal += best.ac;
      if (best.touch) resolvedTouch += best.ac;
      if (best.flatfooted) resolvedFF += best.ac;
    });

    const acTotal = 10 + cappedDexMod + acSize + acMisc + resolvedTotal + stackingTotal + acBonus;
    const touchAC = 10 + cappedDexMod + acSize + acMisc + resolvedTouch + stackingTouch + acBonus;
    const flatFootedAC = 10 + acSize + acMisc + resolvedFF + stackingFF + acBonus;

    $("#ac-total").textContent = acTotal;
    $("#ac-touch").textContent = touchAC;
    $("#ac-flatfooted").textContent = flatFootedAC;

    // Saving throws
    [
      { prefix: "fort", ability: "CON" },
      { prefix: "ref", ability: "DEX" },
      { prefix: "will", ability: "WIS" },
    ].forEach(({ prefix, ability }) => {
      const abilityMod = getAbilityMod(ability);
      $(`#${prefix}-ability`).textContent = fmt(abilityMod);
      const saveBonus = saveBonuses[prefix] || 0;
      const total =
        int($(`#${prefix}-base`).value) +
        abilityMod +
        int($(`#${prefix}-magic`).value) +
        expr($(`#${prefix}-misc`).value) +
        int($(`#${prefix}-temp`).value) +
        saveBonus;
      $(`#${prefix}-total`).textContent = fmt(total);
    });

    // Initiative
    const initDex = getAbilityMod("DEX");
    $("#init-dex").textContent = fmt(initDex);
    $("#init-total").textContent = fmt(initDex + expr($("#init-misc").value));

    // BAB boxes (4 iterative attacks: highest, -5, -10, -15)
    const bab1 = int($("#bab-1").value);
    for (let n = 2; n <= 4; n++) {
      const val = bab1 - (n - 1) * 5;
      const el = $(`#bab-${n}`);
      const sep = $(`#bab-sep-${n}`);
      const plus = $(`#bab-plus-${n}`);
      if (val > 0) {
        el.textContent = val;
        el.style.display = "";
        if (sep) sep.style.display = "";
        if (plus) plus.style.display = "";
      } else {
        el.style.display = "none";
        if (sep) sep.style.display = "none";
        if (plus) plus.style.display = "none";
      }
    }

    // Grapple
    const strMod = getAbilityMod("STR");
    const grappleSize = sizeData.grappleMod;

    $("#grapple-bab").textContent = fmt(bab1);
    $("#grapple-str").textContent = fmt(strMod);
    $("#grapple-size").textContent = fmt(grappleSize);
    $("#grapple-total").textContent = fmt(bab1 + strMod + grappleSize + expr($("#grapple-misc").value));

    // Max skill ranks
    const level = int($("#char-level").value) || 1;
    $("#max-class-ranks").textContent = level + 3;
    $("#max-crossclass-ranks").textContent = (level + 3) / 2;

    // XP progress (PHB Table 3-2). XP_for(L) = 1000 * L * (L-1) / 2.
    // The character "is" level N from XP_for(N) through XP_for(N+1)-1.
    // Display: "N → N+1 (X to go)" or "N+1 reached (excess Y)" once
    // the player has enough XP for the next tier.
    //
    // The To-Next-Level box sits in a `field field-sm` column — wide
    // annotations (Item Familiar multiplier suffix + "(≈ N raw)" hint,
    // previously appended here) overflow and break the row's grid.
    // Keep the call to ItemFamiliar.getXpMultiplier so the hook stays
    // available for future consumers; drop the inline notes from the
    // displayed string (the homebrew rule's still "on" in the model
    // even though we don't surface it here).
    const xpEl = $("#char-xp");
    const xpProgEl = $("#xp-progress");
    if (typeof ItemFamiliar !== "undefined" && ItemFamiliar.getXpMultiplier) {
      ItemFamiliar.getXpMultiplier();  // call retained for hook visibility
    }
    if (xpEl && xpProgEl) {
      const xp = int(xpEl.value);
      const charLevel = level;
      const xpFor = (L) => 1000 * L * (L - 1) / 2;
      const nextLvl = charLevel + 1;
      const need = xpFor(nextLvl);
      if (xp <= 0) {
        xpProgEl.textContent = `${need.toLocaleString()} for L${nextLvl}`;
      } else if (xp >= need) {
        const excess = xp - need;
        xpProgEl.textContent =
          `L${nextLvl} reached (+${excess.toLocaleString()} excess)`;
      } else {
        const togo = need - xp;
        xpProgEl.textContent = `${togo.toLocaleString()} to L${nextLvl}`;
      }
    }

    // Carrying capacity display
    $("#carry-light").textContent = `0-${capacity[0]} lb.`;
    $("#carry-medium").textContent = `${capacity[0] + 1}-${capacity[1]} lb.`;
    $("#carry-heavy").textContent = `${capacity[1] + 1}-${capacity[2]} lb.`;
    $("#carry-overhead").textContent = `${capacity[2]} lb.`;
    $("#carry-offground").textContent = `${capacity[2] * 2} lb.`;
    $("#carry-drag").textContent = `${capacity[2] * 5} lb.`;

    // Total gear weight display
    $("#total-weight").textContent = totalWeight.toFixed(1);
  }

  // ============================================================
  // Attacks
  // ============================================================
  function addAttack(data = {}) {
    const container = $("#attacks-container");
    const div = document.createElement("div");
    div.className = "attack-entry";
    div.dataset.attackIndex = attackCount++;

    div.innerHTML = `
      <div class="attack-row">
        <div class="field" style="flex:2"><label>Weapon</label><input type="text" class="atk-name" value="${data.name || ""}"></div>
        <div class="field"><label>Attack Bonus</label><input type="text" class="atk-bonus" value="${data.bonus || ""}"></div>
        <div class="field"><label>Damage</label><input type="text" class="atk-damage" value="${data.damage || ""}"></div>
        <div class="field field-sm"><label>Critical</label><input type="text" class="atk-crit" value="${data.crit || ""}"></div>
      </div>
      <div class="attack-row">
        <div class="field field-sm"><label>Range</label><input type="text" class="atk-range" value="${data.range || ""}"></div>
        <div class="field field-sm"><label>Type</label><input type="text" class="atk-type" value="${data.type || ""}"></div>
        <div class="field" style="flex:2"><label>Notes</label><input type="text" class="atk-notes" value="${data.notes || ""}"></div>
        <button class="btn-remove" onclick="this.closest('.attack-entry').remove()">Remove</button>
      </div>
    `;
    container.appendChild(div);
  }

  // ============================================================
  // Collect / Load
  // ============================================================
  function collectData() {
    const data = {};

    // Character info
    [
      "char-name", "char-player", "char-class", "char-race", "char-type",
      "char-alignment", "char-deity", "char-level", "char-size", "char-age",
      "char-gender", "char-height", "char-weight", "char-eyes", "char-hair",
      "char-skin", "char-campaign", "char-xp", "char-speed", "damage-reduction",
    ].forEach((id) => {
      const el = $(`#${id}`);
      if (el) data[id] = el.value;
    });

    // Ability scores (base, racial adjustment, template, temp adjustment).
    // Temp is persisted under a NEW key (`-temp-adj`) because its meaning
    // changed from a full alternate score to a temporary +/- adjustment
    // (2026-06-05); the old `-temp` key in pre-change saves is intentionally
    // not loaded so a stale full score never reloads as a huge delta.
    DND35.abilities.forEach((ab) => {
      const lower = ab.toLowerCase();
      data[`${lower}-score`] = $(`#${lower}-score`).value;
      data[`${lower}-race`] = $(`#${lower}-race`)?.value || "";
      data[`${lower}-template`] = $(`#${lower}-template`)?.value || "";
      data[`${lower}-temp-adj`] = $(`#${lower}-temp`)?.value || "";
    });

    // HP
    ["hp-total", "hp-current", "hp-temp", "hp-nonlethal"].forEach((id) => {
      data[id] = $(`#${id}`).value;
    });

    // AC (natural, misc, and miss-chance are manual inputs; armor,
    // shield, deflection are auto-calculated). Miss chance lives in
    // the renamed "Defense Onion" section but uses the ac-* ID prefix
    // for save-file backwards-compatibility with older saves.
    ["ac-natural", "ac-misc", "ac-miss-chance", "ac-defense-notes"].forEach((id) => {
      const el = $(`#${id}`);
      if (el) data[id] = el.value;
    });

    // Ability-to-AC toggles
    ["con", "int", "wis", "cha"].forEach((ab) => {
      data[`${ab}-to-ac`] = $(`#${ab}-to-ac`)?.checked || false;
      data[`${ab}-to-ac-type`] = $(`#${ab}-to-ac-type`)?.value || "Untyped";
    });
    data["ignore-encumbrance"] = $("#ignore-encumbrance")?.checked || false;

    // Saves
    ["fort", "ref", "will"].forEach((prefix) => {
      ["base", "magic", "misc", "temp"].forEach((suffix) => {
        data[`${prefix}-${suffix}`] = $(`#${prefix}-${suffix}`).value;
      });
    });
    data["save-conditional"] = $("#save-conditional").value;

    // Initiative, BAB, Grapple
    data["init-misc"] = $("#init-misc").value;
    data["bab-1"] = $("#bab-1").value;
    data["grapple-misc"] = $("#grapple-misc").value;
    data["spell-resistance"] = $("#spell-resistance").value;

    // Attacks
    data.attacks = [];
    $$("#attacks-container .attack-entry").forEach((entry) => {
      data.attacks.push({
        name: entry.querySelector(".atk-name").value,
        bonus: entry.querySelector(".atk-bonus").value,
        damage: entry.querySelector(".atk-damage").value,
        crit: entry.querySelector(".atk-crit").value,
        range: entry.querySelector(".atk-range").value,
        type: entry.querySelector(".atk-type").value,
        notes: entry.querySelector(".atk-notes").value,
      });
    });

    return data;
  }

  function loadData(data, getAbilityMod) {
    // Simple fields
    [
      "char-name", "char-player", "char-class", "char-race", "char-type",
      "char-alignment", "char-deity", "char-level", "char-size", "char-age",
      "char-gender", "char-height", "char-weight", "char-eyes", "char-hair",
      "char-skin", "char-campaign", "char-xp", "char-speed", "damage-reduction",
      "hp-total", "hp-current", "hp-temp", "hp-nonlethal",
      "ac-natural", "ac-misc", "ac-miss-chance", "ac-defense-notes",
      "save-conditional", "init-misc", "bab-1", "grapple-misc",
      "spell-resistance", "languages",
    ].forEach((id) => {
      const el = $(`#${id}`);
      if (el && data[id] !== undefined) el.value = data[id];
    });

    // Abilities (base, racial adjustment, temp)
    DND35.abilities.forEach((ab) => {
      const lower = ab.toLowerCase();
      if (data[`${lower}-score`] !== undefined) $(`#${lower}-score`).value = data[`${lower}-score`];
      if (data[`${lower}-race`] !== undefined) {
        const el = $(`#${lower}-race`);
        if (el) el.value = data[`${lower}-race`];
      }
      if (data[`${lower}-template`] !== undefined) {
        const el = $(`#${lower}-template`);
        if (el) el.value = data[`${lower}-template`];
      }
      // Temp = the new temporary adjustment (delta). The pre-2026-06-05
      // `-temp` key (a full alternate score) is intentionally NOT loaded so a
      // stale value never reloads as a huge +/- delta.
      if (data[`${lower}-temp-adj`] !== undefined) {
        const el = $(`#${lower}-temp`);
        if (el) el.value = data[`${lower}-temp-adj`];
      }
    });

    // Ability-to-AC toggles
    ["con", "int", "wis", "cha"].forEach((ab) => {
      if (data[`${ab}-to-ac`] !== undefined) $(`#${ab}-to-ac`).checked = data[`${ab}-to-ac`];
      if (data[`${ab}-to-ac-type`] !== undefined) $(`#${ab}-to-ac-type`).value = data[`${ab}-to-ac-type`];
    });
    if (data["ignore-encumbrance"] !== undefined && $("#ignore-encumbrance")) {
      $("#ignore-encumbrance").checked = !!data["ignore-encumbrance"];
    }

    // Saves
    ["fort", "ref", "will"].forEach((prefix) => {
      ["base", "magic", "misc", "temp"].forEach((suffix) => {
        const key = `${prefix}-${suffix}`;
        if (data[key] !== undefined) $(`#${key}`).value = data[key];
      });
    });

    // Attacks
    $("#attacks-container").innerHTML = "";
    attackCount = 0;
    if (data.attacks) data.attacks.forEach((atk) => addAttack(atk));
  }

  function resetAttacks() {
    $("#attacks-container").innerHTML = "";
    attackCount = 0;
  }

  // ============================================================
  // Public API
  // ============================================================
  return { recalc, addAttack, collectData, loadData, resetAttacks };
})();
