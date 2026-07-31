// D&D 3.5 Character Sheet - Character Tab Module

const Character = (function () {
  function _esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  // Capitalized bonus-type prefix for a situational note ("morale" →
  // "morale " ; untyped/blank → ""). The TYPE is the most actionable bit —
  // it tells the player what stacks with what (two morale bonuses don't).
  function _typeLabel(cat) {
    const c = String(cat == null ? "" : cat).toLowerCase().trim();
    if (!c || c === "untyped") return "";
    return c + " ";
  }
  // Render the auto-derived situational save modifiers (from race / template /
  // feat / trait structured `bonuses`) into #save-situational-auto, grouped by
  // the save each applies to (Fortitude / Reflex / Will), with general ones last.
  function renderSituationalSaves(list) {
    const el = document.getElementById("save-situational-auto");
    if (!el) return;
    if (!Array.isArray(list) || !list.length) {
      el.style.display = "none"; el.innerHTML = ""; return;
    }
    const LABEL = { fort: "Fortitude", ref: "Reflex", will: "Will" };
    const groups = { fort: [], ref: [], will: [], general: [] };
    for (const s of list) {
      groups[(s.save && groups[s.save]) ? s.save : "general"].push(s);
    }
    const amt = (n) => (n >= 0 ? "+" + n : String(n));
    const item = (s) =>
      `<li>${amt(s.amount)} ${_esc(_typeLabel(s.category))}${_esc(s.condition || "")}` +
      (s.source ? ` <span class="ss-src">(${_esc(s.source)})</span>` : "") +
      `</li>`;
    let html = "";
    for (const k of ["fort", "ref", "will", "general"]) {
      if (!groups[k].length) continue;
      const head = k === "general" ? "Any save" : LABEL[k];
      html += `<div class="ss-grp"><b>${head}:</b> <ul>${groups[k].map(item).join("")}</ul></div>`;
    }
    el.innerHTML = `<div class="ss-head">Situational (auto-derived):</div>${html}`;
    el.style.display = "";
  }
  // Render auto-derived situational AC modifiers (race/template) into
  // #ac-situational-auto — conditional dodge/deflection/… bonuses the player
  // applies at point of use.
  function renderSituationalAC(list) {
    const el = document.getElementById("ac-situational-auto");
    if (!el) return;
    if (!Array.isArray(list) || !list.length) {
      el.style.display = "none"; el.innerHTML = ""; return;
    }
    const amt = (n) => (n >= 0 ? "+" + n : String(n));
    const items = list.map((s) =>
      `<li>${amt(s.ac)} ${_esc(_typeLabel(s.category))}${_esc(s.condition || "")}` +
      (s.source ? ` <span class="ss-src">(${_esc(s.source)})</span>` : "") +
      `</li>`).join("");
    el.innerHTML = `<div class="ss-head">Situational AC (auto-derived):</div>` +
      `<div class="ss-grp"><ul>${items}</ul></div>`;
    el.style.display = "";
  }
  // Render auto-derived situational initiative modifiers (conditional
  // class-feature/trait rows, e.g. Scout Battle Fortitude's armor-gated
  // +N) into #init-situational-auto.
  function renderSituationalInit(list) {
    const el = document.getElementById("init-situational-auto");
    if (!el) return;
    if (!Array.isArray(list) || !list.length) {
      el.style.display = "none"; el.innerHTML = ""; return;
    }
    const amt = (n) => (n >= 0 ? "+" + n : String(n));
    const items = list.map((s) =>
      `<li>${amt(s.amount)} ${_esc(_typeLabel(s.category))}${_esc(s.condition || "")}` +
      (s.source ? ` <span class="ss-src">(${_esc(s.source)})</span>` : "") +
      `</li>`).join("");
    el.innerHTML = `<div class="ss-head">Situational initiative (auto-derived):</div>` +
      `<div class="ss-grp"><ul>${items}</ul></div>`;
    el.style.display = "";
  }
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
    const acBonus = bonuses.ac || 0;

    // Ability modifiers. The merged `bonus` still drives the math; for
    // DISPLAY we split it so the derived Template / Bloodline column carries
    // template + bloodline and the Misc column carries the rest (items / rage
    // / conditions). Both hide when empty. The Modifier is the EFFECTIVE mod —
    // getAbilityMod folds in the Temp adjustment (delta).
    let anyTplbl = false;
    let anyMisc = false;
    // Effective STR score (base + race + template + active bonuses + temp),
    // captured from the loop below for carrying-capacity math further down.
    let strTotalScore = 10;
    DND35.abilities.forEach((ab) => {
      const lower = ab.toLowerCase();
      const bonus = abilityBonuses[ab] || 0;             // merged active bonus
      const bloodlineBonus = bloodlineBonuses[ab] || 0;  // bloodline portion
      const miscBonus = bonus - bloodlineBonus;          // items/rage/conditions
      const rawScore = int($(`#${lower}-score`).value);
      const raceMod = int($(`#${lower}-race`)?.value);   // racial adjustment
      const tplMod  = int($(`#${lower}-template`)?.value); // template (hidden backing input)
      const tempDelta = int($(`#${lower}-temp`)?.value);   // temporary adjustment (delta)
      // Total is the EFFECTIVE current score — every contributor column to its
      // left (base, race, template/bloodline, misc, temp) sums into it, so
      // Total and the Modifier next to it stay consistent.
      const totalScore = rawScore + raceMod + tplMod + bonus + tempDelta;
      // Capture effective STR for carrying capacity below (full total, not base).
      if (ab === "STR") strTotalScore = rawScore ? totalScore : 10;
      // Misc column — non-bloodline active bonuses; hides when empty.
      const miscEl = $(`#${lower}-misc`);
      if (miscEl) miscEl.textContent = miscBonus ? fmt(miscBonus) : "";
      if (miscBonus !== 0) anyMisc = true;
      // Template / Bloodline column — template adjustment + bloodline bumps.
      const tplblVal = tplMod + bloodlineBonus;
      const tplblEl = $(`#${lower}-tplbl`);
      if (tplblEl) tplblEl.textContent = tplblVal ? fmt(tplblVal) : "";
      if (tplblVal !== 0) anyTplbl = true;
      // Total = effective score incl. Temp (shown only when there's a base
      // score). Modifier = the same effective mod via getAbilityMod.
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

    // NOTE: #ac-armor / #ac-shield are written further down, AFTER worn magic
    // items are resolved into bestByType. Writing them here (from the worn
    // armor/shield fields alone) made the Defense Onion under-report whenever
    // an item carried the bonus instead — Bracers of Armor +4 with no worn
    // armor showed "Armor 0" even though the AC total was right.

    // ---- Carrying load penalties (Table 9-2, PHB p.162) ----
    // Carrying capacity uses the EFFECTIVE Strength score captured above
    // (base + race + template + active bonuses + temp) — a belt of giant
    // strength, Rage, Bull's Strength, etc. all raise how much you can haul.
    // Previously this read the raw #str-score base input, ignoring every bonus.
    const strScore = strTotalScore;
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

    // Per-mode movement (PHB Table 9-2 + flight-encumbrance rule).
    //  - LAND reduces under a medium/heavy load (reducedSpeed, ~2/3 → 5 ft),
    //    unless "ignore encumbrance" is on.
    //  - FLY is DISABLED while carrying a medium/heavy load OR wearing
    //    medium/heavy armor, unless "fly while encumbered" is on (a feat /
    //    class feature / item grants it). Maneuverability shown alongside.
    //  - SWIM / BURROW / CLIMB are shown as entered (not load-reduced).
    const encumbered = (loadCategory === "medium" || loadCategory === "heavy");
    const landReduces = !ignoreEncumbrance && encumbered;
    // Full armor granularity: classify #armor-type once and rank it.
    const armorCat = DND35.armorCategory($("#armor-type")?.value);
    const armorRank = DND35.armorRank[armorCat] || 0;   // none0/light1/medium2/heavy3
    const loadRankNow = DND35.loadRank[loadCategory] ?? 0;   // light0/medium1/heavy2
    // Aggregator (P2): per-mode add/set + a fly-while-encumbered grant from a
    // feat / class feature / race (bonuses.speed via categorizeSpeedBonuses).
    const spd = (bonuses && bonuses.speed) || {};
    const flyOk = ($("#fly-encumbered-ok")?.checked) || !!spd.flyEncumberedOk;
    // Can't fly under a medium/heavy load OR medium/heavy armor (unless flyOk).
    const flyBlocked = (encumbered || armorRank >= 2) && !flyOk;
    const modeBase = (id) => parseInt($(`#${id}`)?.value, 10) || 0;
    // Fast-movement adds carry independent caps (max_armor, max_load = heaviest
    // tolerated); drop an add when EITHER axis is exceeded. Two conditionals,
    // no per-combination cases: Monk={none,light}, Barbarian={medium,medium},
    // Scout={light,light}.
    const gatePasses = (a) =>
      (a.max_armor == null || armorRank <= (DND35.armorRank[a.max_armor] ?? 3)) &&
      (a.max_load == null || loadRankNow <= (DND35.loadRank[a.max_load] ?? 2));
    // Effective base for a mode = max(box + typed-stacked add total, granted
    // set). The box is the character's own listed speed; add layers deltas
    // (Longstrider, Barbarian/Monk fast movement), set grants/overrides a mode
    // (Fly spell, a racial fly). Gated adds drop when over their cap; the
    // survivors re-stack (typed: best-per-type + sum).
    const modeEff = (mode) => {
      const s = spd[mode] || {};
      const adds = (Array.isArray(s.add) ? s.add : []).filter(a => a && gatePasses(a));
      const addTotal = (typeof DND35.stackBonuses === "function")
        ? DND35.stackBonuses(adds).total
        : adds.reduce((t, a) => t + (a.amount || 0), 0);
      return Math.max(modeBase(`speed-${mode}`) + addTotal, s.set || 0);
    };

    // Land — reduced by a medium/heavy load unless ignore-encumbrance.
    const landEff = modeEff("land");
    const landCur = landReduces ? DND35.reducedSpeed(landEff) : landEff;
    const landEl = $("#speed-land-current");
    if (landEl) {
      // Publish the computed number for other modules (skills.js reads it
      // for the Jump speed modifier) — the textContent can be "20 (from
      // 30)" or "--", so consumers shouldn't have to parse the display.
      landEl.dataset.current = landEff ? String(landCur) : "";
      if (!landEff) { landEl.textContent = "--"; landEl.classList.remove("speed-reduced"); }
      else if (landReduces && landCur < landEff) {
        landEl.textContent = `${landCur} (from ${landEff})`;
        landEl.classList.add("speed-reduced");
      } else { landEl.textContent = `${landCur}`; landEl.classList.remove("speed-reduced"); }
    }
    // Fly — blocked (0, struck through) under a medium/heavy load OR medium/
    // heavy armor unless flyOk. Maneuverability shows in the adjacent dropdown.
    const flyEff = modeEff("fly");
    const flyEl = $("#speed-fly-current");
    if (flyEl) {
      if (!flyEff) {
        flyEl.textContent = "--"; flyEl.title = "";
        flyEl.classList.remove("speed-reduced");
      } else if (flyBlocked) {
        flyEl.textContent = "0";
        flyEl.title = "Can't fly under a medium/heavy load or in medium/heavy armor — tick “Fly while encumbered” if a feature allows it.";
        flyEl.classList.add("speed-reduced");
      } else {
        flyEl.textContent = `${flyEff}`; flyEl.title = "";
        flyEl.classList.remove("speed-reduced");
      }
    }
    // Swim / Burrow / Climb — box + aggregator, not load-reduced.
    for (const m of ["swim", "burrow", "climb"]) {
      const el = $(`#speed-${m}-current`);
      if (!el) continue;
      const eff = modeEff(m);
      el.textContent = eff ? `${eff}` : "--";
      el.classList.remove("speed-reduced");
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

    // Ability-to-AC bonuses (e.g. Monk WIS untyped, Paladin CHA deflection,
    // a class feature adding CON as natural armor). A dynamic list of rows;
    // the SAME ability may appear more than once under different bonus types.
    const abilityACItems = [];
    $$("#ability-ac-list .ability-ac-row").forEach((row) => {
      const type = row.querySelector(".ability-ac-type")?.value || "Untyped";
      // The stack toggle only applies to Natural Armor; keep its visibility
      // synced to the chosen type (recalc fires on every row change).
      const isNatural = type === "Natural Armor";
      const stackLabel = row.querySelector(".ability-ac-stack");
      if (stackLabel) stackLabel.style.display = isNatural ? "" : "none";
      const ab = row.querySelector(".ability-ac-ability")?.value;
      if (!ab) return;
      const abMod = getAbilityMod(ab);
      if (abMod <= 0) return;
      // A natural-armor bonus that's set to STACK is an "increase to natural
      // armor" — it adds on top of the manual field and any other natural
      // armor (routed through the stacking accumulators below). Unchecked, it
      // overlaps (highest-applies) like a plain natural armor bonus. Natural
      // armor never applies against touch; dodge is the only type lost when
      // flat-footed.
      const stacks = isNatural &&
        (row.querySelector(".ability-ac-stack-cb")?.checked ?? false);
      abilityACItems.push({
        type,
        ac: abMod,
        touch: !isNatural,
        flatfooted: type !== "Dodge",
        stacks,
      });
    });

    // Resolve protective item bonuses with D&D 3.5 stacking rules
    // Same bonus type: take highest (except dodge, circumstance, untyped which stack)
    // Race/template structured AC bonuses (dodge/deflection/…) join the same
    // resolver; size + natural are excluded upstream (their own fields).
    const protItems = Equipment.getProtectiveItems()
      .concat(abilityACItems)
      .concat(Array.isArray(bonuses.acItems) ? bonuses.acItems : []);
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
      // STACKING_TYPES (dodge / circumstance / untyped) always sum; an
      // ability natural-armor bonus flagged `stacks` (an increase to NA)
      // also sums, on top of the highest-applies Natural Armor bucket.
      if (STACKING_TYPES.includes(item.type) || item.stacks) {
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

    // Auto-set the Defense Onion displays from the RESOLVED bonuses, so a
    // bonus carried by a worn magic item shows in its own box rather than
    // only inside the AC total. Same-type bonuses don't stack in 3.5, so the
    // resolved figure is max(worn armor/shield field, best item of that type)
    // — which is exactly what bestByType holds by this point.
    $("#ac-armor").textContent = (bestByType["Armor"] || {}).ac || 0;
    $("#ac-shield").textContent = (bestByType["Shield"] || {}).ac || 0;
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
    let touchAC = 10 + cappedDexMod + acSize + acMisc + resolvedTouch + stackingTouch + acBonus;
    const flatFootedAC = 10 + acSize + acMisc + resolvedFF + stackingFF + acBonus;

    // Touch-ONLY class-feature bonuses (Wilder's Elude Touch). Applied here,
    // after the totals, because they never touch the full AC and because the
    // RAW cap is expressed against the finished normal AC.
    const touchNotes = [];
    let capTouchToNormal = false;
    for (const f of (bonuses.touchACFeatures || [])) {
      const mod = getAbilityMod(f.ability);
      if (mod > 0) {
        touchAC += mod;
        touchNotes.push(`+${mod} ${f.label} (${f.ability} bonus)`);
      }
      if (f.capToNormalAC) capTouchToNormal = true;
    }
    if (capTouchToNormal && touchAC > acTotal) {
      touchAC = acTotal;
      touchNotes.push(`capped at normal AC ${acTotal}`);
    }

    $("#ac-total").textContent = acTotal;
    $("#ac-touch").textContent = touchAC;
    const touchEl = $("#ac-touch");
    if (touchEl) touchEl.title = touchNotes.join("; ");
    $("#ac-flatfooted").textContent = flatFootedAC;
    // Auto-derived situational AC modifiers (race/template), e.g. a dodge
    // bonus vs a specific creature type.
    renderSituationalAC(bonuses.acSituational || []);

    // Saving throws
    [
      { prefix: "fort", ability: "CON" },
      { prefix: "ref", ability: "DEX" },
      { prefix: "will", ability: "WIS" },
    ].forEach(({ prefix, ability }) => {
      const abilityMod = getAbilityMod(ability);
      $(`#${prefix}-ability`).textContent = fmt(abilityMod);
      // FULL typed stacking: every modifier source (race/template/class/
      // condition — already typed in bonuses.saveTyped) plus the manual
      // fields (Magic Mod = a RESISTANCE bonus by convention; Misc/Temp =
      // untyped, so they always stack) go through one stackBonuses pass.
      // Base + ability mod are the save's foundation, not bonuses, so they're
      // added directly on top.
      const typedList = ((bonuses.saveTyped && bonuses.saveTyped[prefix]) || []).concat([
        { amount: int($(`#${prefix}-magic`).value), bonus_category: "resistance" },
        { amount: expr($(`#${prefix}-misc`).value), bonus_category: "untyped" },
        { amount: int($(`#${prefix}-temp`).value), bonus_category: "untyped" },
      ]);
      const stacked = (typeof DND35 !== "undefined" && DND35.stackBonuses)
        ? DND35.stackBonuses(typedList).total : 0;
      const total = int($(`#${prefix}-base`).value) + abilityMod + stacked;
      $(`#${prefix}-total`).textContent = fmt(total);
    });
    // Auto-derived situational save modifiers (race/template), tagged per
    // save where the data names/implies one; general ones grouped separately.
    renderSituationalSaves(bonuses.saveSituational || []);

    // Initiative — DEX + misc + the typed cross-source stack (traits/flaws,
    // feats like Quick Reconnoiter, class features like Streetfighter's
    // Always Ready or Exemplar's Int-linked Intellectual Agility). Same-type
    // bonuses don't stack; untyped do. Conditional ones render as a note.
    const initDex = getAbilityMod("DEX");
    const initTyped = Array.isArray(bonuses.initiativeTyped) ? bonuses.initiativeTyped : [];
    const initStacked = (typeof DND35 !== "undefined" && DND35.stackBonuses)
      ? DND35.stackBonuses(initTyped).total : 0;
    $("#init-dex").textContent = fmt(initDex);
    $("#init-total").textContent = fmt(initDex + expr($("#init-misc").value) + initStacked);
    renderSituationalInit(bonuses.initiativeSituational || []);

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

    // Per-attack bonus calculators. The size modifier to attack rolls is the
    // same value as the size modifier to AC (sizeData.acMod) in 3.5. Each
    // attack entry computes BAB + size + chosen-ability mod + an "other" expr;
    // when its "fill bonus" box is checked the total drives the (then
    // read-only) Attack Bonus field, else the field stays free-text.
    const atkSizeMod = sizeData.acMod;
    const weaponFocus = bonuses.weaponFocus || {};
    $$("#attacks-container .attack-entry").forEach((entry) => {
      const abilSel = entry.querySelector(".atk-calc-ability");
      if (!abilSel) return; // defensive: pre-calculator render
      const abilMod = getAbilityMod(abilSel.value || "STR");
      const misc = expr(entry.querySelector(".atk-calc-misc")?.value || "");
      // Weapon Focus / Greater Weapon Focus: +1 (each) when the feat's chosen
      // weapon matches this row's weapon name. Match is case-insensitive and
      // whole-word, so feat "longsword" hits "Longsword" and "Masterwork
      // Longsword" but not a coincidental substring.
      const weaponName = (entry.querySelector(".atk-name")?.value || "")
        .trim().toLowerCase();
      let focus = 0;
      if (weaponName) {
        for (const [k, v] of Object.entries(weaponFocus)) {
          if (weaponFocusMatches(weaponName, k)) focus += v;
        }
      }
      const total = bab1 + atkSizeMod + abilMod + misc + focus;
      entry.querySelector(".atk-calc-bab").textContent = fmt(bab1);
      entry.querySelector(".atk-calc-size").textContent = fmt(atkSizeMod);
      entry.querySelector(".atk-calc-abilmod").textContent = fmt(abilMod);
      const focusEl = entry.querySelector(".atk-calc-focus");
      const focusTerm = entry.querySelector(".atk-calc-focus-term");
      const focusOp = entry.querySelector(".atk-calc-focus-op");
      if (focusEl) focusEl.textContent = fmt(focus);
      if (focusTerm) focusTerm.style.display = focus ? "" : "none";
      if (focusOp) focusOp.style.display = focus ? "" : "none";
      entry.querySelector(".atk-calc-total").textContent = fmt(total);
      const bonusInput = entry.querySelector(".atk-bonus");
      if (entry.querySelector(".atk-calc-auto-cb")?.checked) {
        bonusInput.value = fmt(total);
        bonusInput.readOnly = true;
        bonusInput.classList.add("atk-bonus-auto");
      } else {
        bonusInput.readOnly = false;
        bonusInput.classList.remove("atk-bonus-auto");
      }
    });

    // Max skill ranks. Bloodline levels (UA) count toward the character level
    // for the max-ranks cap (K1, Ryan's independent-track model) — #char-level
    // holds class levels only, so fold the bloodline levels in here. recalcAll
    // re-fires on the bloodline-changed event, so this stays current.
    const level = int($("#char-level").value) || 1;
    const bloodlineLevels = (typeof Bloodline !== "undefined" &&
                             Bloodline.getTotalBloodlineLevels)
      ? Bloodline.getTotalBloodlineLevels() : 0;
    const effLevel = level + bloodlineLevels;
    $("#max-class-ranks").textContent = effLevel + 3;
    $("#max-crossclass-ranks").textContent = (effLevel + 3) / 2;

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
  // Ability-to-AC list. Each row contributes one ability modifier to AC
  // under a chosen bonus type. The same ability can be added multiple
  // times (separate rows) — e.g. WIS as a dodge bonus and WIS as insight.
  const AC_ABILITY_OPTIONS = ["CON", "INT", "WIS", "CHA"];
  const AC_TYPE_OPTIONS = ["Untyped", "Dodge", "Insight", "Deflection", "Natural Armor"];

  // Attack-bonus calculator: which ability feeds the attack roll. STR (melee)
  // and DEX (ranged / Weapon Finesse) are the usual two; the rest cover the
  // odd feat/PrC (Zen Archery WIS, a CHA-to-attack class feature, etc.).
  const ATK_ABILITY_OPTIONS = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];

  // True when a Weapon Focus feat's chosen weapon (`featWeapon`, lowercased)
  // applies to an attack row named `attackName` (lowercased). Exact match, or
  // the feat weapon appears as a whole word inside the attack name (so a
  // "Masterwork Longsword" / "Longsword +1" row still gets Weapon Focus
  // (Longsword)). Whole-word so "sword" can't leak into "longsword".
  function weaponFocusMatches(attackName, featWeapon) {
    if (!attackName || !featWeapon) return false;
    if (attackName === featWeapon) return true;
    const esc = featWeapon.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("\\b" + esc + "\\b").test(attackName);
  }

  function addAbilityAcRow(data = {}) {
    const container = $("#ability-ac-list");
    if (!container) return;
    const ability = (data.ability || "WIS").toUpperCase();
    const type = data.type || "Untyped";
    // Natural-armor ability bonuses default to STACKING (an "increase to
    // natural armor", e.g. Dragon Disciple / Bear Warrior — they add on top
    // of existing natural armor). Unchecking makes it overlap (highest of it
    // and the manual Natural Armor field applies). Only meaningful for the
    // Natural Armor type; ignored otherwise.
    const stack = data.stack ?? true;
    const abilityOpts = AC_ABILITY_OPTIONS.map(
      (a) => `<option value="${a}"${a === ability ? " selected" : ""}>${a}</option>`
    ).join("");
    const typeOpts = AC_TYPE_OPTIONS.map(
      (t) => `<option value="${t}"${t === type ? " selected" : ""}>${t}</option>`
    ).join("");
    const row = document.createElement("div");
    row.className = "ability-ac-row";
    const stackHidden = type === "Natural Armor" ? "" : ' style="display:none"';
    row.innerHTML =
      `<select class="ability-ac-ability ac-type-select">${abilityOpts}</select>` +
      `<span class="ability-ac-as">as</span>` +
      `<select class="ability-ac-type ac-type-select">${typeOpts}</select>` +
      `<label class="ability-ac-stack"${stackHidden} title="Stack with (increase) existing natural armor. Uncheck to overlap instead (highest applies).">` +
        `<input type="checkbox" class="ability-ac-stack-cb"${stack ? " checked" : ""}> stack</label>` +
      `<button type="button" class="ability-ac-remove" title="Remove">&times;</button>`;
    container.appendChild(row);
    return row;
  }

  function addAttack(data = {}) {
    const container = $("#attacks-container");
    const div = document.createElement("div");
    div.className = "attack-entry";
    div.dataset.attackIndex = attackCount++;

    const calcAbility = (data.calcAbility || "STR").toUpperCase();
    const atkAbilOpts = ATK_ABILITY_OPTIONS.map(
      (a) => `<option value="${a}"${a === calcAbility ? " selected" : ""}>${a}</option>`
    ).join("");

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
      <div class="attack-row attack-calc-row" title="Attack-bonus calculator: BAB + size modifier + ability mod + other">
        <span class="atk-calc-label">Calc</span>
        <span class="atk-calc-term"><span class="atk-calc-k">BAB</span><span class="calc-field atk-calc-bab">+0</span></span>
        <span class="atk-calc-op">+</span>
        <span class="atk-calc-term"><span class="atk-calc-k">Size</span><span class="calc-field atk-calc-size">+0</span></span>
        <span class="atk-calc-op">+</span>
        <span class="atk-calc-term"><select class="atk-calc-ability">${atkAbilOpts}</select><span class="calc-field atk-calc-abilmod">+0</span></span>
        <span class="atk-calc-op">+</span>
        <span class="atk-calc-term"><span class="atk-calc-k">Other</span><input type="text" class="atk-calc-misc" value="${data.calcMisc || ""}" placeholder="0"></span>
        <span class="atk-calc-op atk-calc-focus-op" style="display:none">+</span>
        <span class="atk-calc-term atk-calc-focus-term" style="display:none" title="Weapon Focus / Greater Weapon Focus bonus for this weapon"><span class="atk-calc-k">Focus</span><span class="calc-field atk-calc-focus">+0</span></span>
        <span class="atk-calc-op">=</span>
        <span class="calc-field atk-calc-total atk-calc-total-big">+0</span>
        <label class="atk-calc-auto" title="Auto-fill the Attack Bonus field above from this total"><input type="checkbox" class="atk-calc-auto-cb"${data.calcAuto ? " checked" : ""}> fill bonus</label>
      </div>
    `;
    if (data.fromClass) {
      div.dataset.fromClass = data.fromClass;
      // Any hand-edit to a managed field hands the row over to the player:
      // the marker goes, and upsertClassAttack stops touching it. Same
      // contract as every other auto-filled field on the sheet.
      div.addEventListener("input", (ev) => {
        if (ev.isTrusted) delete div.dataset.fromClass;
      });
    }
    container.appendChild(div);
    return div;
  }

  // Create / update / remove an attack row OWNED by a class feature (the
  // Warlock's eldritch blast). Keyed by `fromClass` so level-up rewrites the
  // same row instead of stacking duplicates, and removing the class takes the
  // row with it. `spec` of null means "this class no longer grants it".
  //
  // Only rows still carrying the marker are managed — once the player edits
  // one it's theirs, and a later level-up leaves it alone (it also stops
  // being removed with the class, which is the right trade: we never delete
  // something the player typed).
  function upsertClassAttack(key, spec) {
    const container = $("#attacks-container");
    if (!container) return null;
    const esc = String(key).replace(/"/g, '\\"');
    const row = container.querySelector(`.attack-entry[data-from-class="${esc}"]`);
    if (!spec) {
      if (row) row.remove();
      return null;
    }
    if (!row) return addAttack(Object.assign({ fromClass: key }, spec));
    // Refresh in place. Preserve the player's calculator settings (Other
    // modifier, the fill-bonus toggle) — those are theirs even on a managed row.
    const set = (sel, v) => {
      const el = row.querySelector(sel);
      if (el && v != null && el.value !== String(v)) el.value = String(v);
    };
    set(".atk-name", spec.name);
    set(".atk-damage", spec.damage);
    set(".atk-crit", spec.crit);
    set(".atk-range", spec.range);
    set(".atk-type", spec.type);
    set(".atk-notes", spec.notes);
    return row;
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
      "char-skin", "char-campaign", "char-xp", "damage-reduction",
      // Per-mode movement (replaced the single free-text char-speed 2026-07-01;
      // old saves migrate on load).
      "speed-land", "speed-fly", "speed-fly-maneuver",
      "speed-swim", "speed-burrow", "speed-climb",
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

    // Ability-to-AC bonuses (dynamic list; the same ability may repeat
    // under different bonus types). Scoped to the list container so it
    // can't collide with other `select` elements on the tab. See loadData
    // for migration of the pre-2026-06-20 fixed con/int/wis/cha-to-ac keys.
    data["ability-ac-bonuses"] = [];
    $$("#ability-ac-list .ability-ac-row").forEach((row) => {
      data["ability-ac-bonuses"].push({
        ability: row.querySelector(".ability-ac-ability")?.value || "",
        type: row.querySelector(".ability-ac-type")?.value || "Untyped",
        stack: !!row.querySelector(".ability-ac-stack-cb")?.checked,
      });
    });
    data["ignore-encumbrance"] = $("#ignore-encumbrance")?.checked || false;
    data["fly-encumbered-ok"] = $("#fly-encumbered-ok")?.checked || false;

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
        calcAbility: entry.querySelector(".atk-calc-ability")?.value || "STR",
        calcMisc: entry.querySelector(".atk-calc-misc")?.value || "",
        calcAuto: entry.querySelector(".atk-calc-auto-cb")?.checked || false,
        // Round-trip the class-grant marker so a reloaded character's
        // eldritch blast is still recognised as managed — without it, the
        // sync would add a SECOND row on the next class change.
        fromClass: entry.dataset.fromClass || "",
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
      "char-skin", "char-campaign", "char-xp", "damage-reduction",
      "speed-land", "speed-fly", "speed-fly-maneuver",
      "speed-swim", "speed-burrow", "speed-climb",
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

    // Ability-to-AC bonuses (dynamic list). Rebuild rows from the saved
    // list. When the new key is absent (older saves), migrate the fixed
    // con/int/wis/cha-to-ac toggle keys forward — only the ones that were
    // checked become rows, preserving each one's saved bonus type (e.g.
    // bean_uisce's CHA → Deflection).
    if ($("#ability-ac-list")) {
      $("#ability-ac-list").innerHTML = "";
      let acBonuses = data["ability-ac-bonuses"];
      if (!Array.isArray(acBonuses)) {
        acBonuses = [];
        ["con", "int", "wis", "cha"].forEach((ab) => {
          if (data[`${ab}-to-ac`]) {
            acBonuses.push({
              ability: ab.toUpperCase(),
              type: data[`${ab}-to-ac-type`] || "Untyped",
            });
          }
        });
      }
      acBonuses.forEach((b) => addAbilityAcRow(b));
    }
    if (data["ignore-encumbrance"] !== undefined && $("#ignore-encumbrance")) {
      $("#ignore-encumbrance").checked = !!data["ignore-encumbrance"];
    }
    if (data["fly-encumbered-ok"] !== undefined && $("#fly-encumbered-ok")) {
      $("#fly-encumbered-ok").checked = !!data["fly-encumbered-ok"];
    }
    // Migration: pre-2026-07-01 saves stored a single free-text `char-speed`
    // ("30 ft., fly 60 ft. (good)"). Parse it into the new per-mode boxes when
    // the new fields are absent, so no existing character loses their speed.
    if (data["char-speed"] != null && data["speed-land"] == null &&
        typeof DND35 !== "undefined" && DND35.parseSpeedString) {
      const m = DND35.parseSpeedString(String(data["char-speed"]));
      const set = (id, v) => { const el = $(`#${id}`); if (el && v != null) el.value = v; };
      set("speed-land", m.land);
      set("speed-fly", m.fly);
      set("speed-fly-maneuver", m.flyManeuver || "");
      set("speed-swim", m.swim);
      set("speed-burrow", m.burrow);
      set("speed-climb", m.climb);
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
  return { recalc, addAttack, upsertClassAttack, addAbilityAcRow, collectData,
           loadData, resetAttacks };
})();
