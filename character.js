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
  // Spell resistance / miss chance contributed by shaped soulmelds, shown
  // beside the manual box rather than written into it. Neither stacks, so the
  // effective value is max(what you typed, best soulmeld source). A CONDITIONAL
  // winner is shown and labelled rather than silently counted or silently
  // dropped: Fellmist Robe's concealment really does not apply to an adjacent
  // attacker, and Displacer Mantle's really does apply generally — the sheet
  // cannot tell those apart, so it says which it is and lets the player judge.
  function renderDerivedDefense() {
    const SME = (typeof SoulmeldEffects !== "undefined") ? SoulmeldEffects : null;
    const show = (elId, fieldId, best, unit, parseManual) => {
      const el = document.getElementById(elId);
      if (!el) return;
      if (!best || !best.amount) { el.hidden = true; el.textContent = ""; return; }
      const raw = (document.getElementById(fieldId) || {}).value;
      const manual = parseManual(raw);
      const effective = Math.max(manual, best.amount);
      const beat = best.amount > manual;
      el.hidden = false;
      el.textContent = beat
        ? `→ ${effective}${unit} (${best.from})${best.conditional ? " *" : ""}`
        : `${best.from} grants ${best.amount}${unit}${best.conditional ? " *" : ""}`;
      el.title = [
        `${best.from}: ${best.amount}${unit}`,
        best.conditional ? `CONDITIONAL — ${best.condition}` : "unconditional",
        `does not stack; the highest single source applies (you have ${manual}${unit} typed in)`,
      ].join("\n");
    };
    show("sr-effective", "spell-resistance",
         SME && SME.getBestSpellResistance ? SME.getBestSpellResistance() : null,
         "", (v) => parseInt(v, 10) || 0);
    // Turn resistance is added to your effective HD against a turn attempt, and
    // like SR it does not stack — the best source applies.
    show("tr-effective", "turn-resistance",
         SME && SME.getBestTurnResistance ? SME.getBestTurnResistance() : null,
         "", (v) => parseInt(v, 10) || 0);
    // The miss-chance box accepts "50/20" — several sources, highest wins — so
    // the manual side is the max of its parts, not a parse of the whole string.
    show("miss-chance-effective", "ac-miss-chance",
         SME && SME.getBestMissChance ? SME.getBestMissChance() : null,
         "%", (v) => String(v || "").split("/")
           .reduce((m, p) => Math.max(m, parseInt(p, 10) || 0), 0));
  }

  // A SUMMED derived contribution, shown beside the field it adds to. Unlike
  // the best-of pair above these add — two sources of extra hit points give you
  // both lots — so the chip shows the total and names every contributor.
  function SME_extraHP() {
    return (typeof SoulmeldEffects !== "undefined" && SoulmeldEffects.getExtraHP)
      ? SoulmeldEffects.getExtraHP() : null;
  }
  function renderDerivedSum(elId, sum, prefix, suffix) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!sum || !sum.amount) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = `${prefix}${sum.amount >= 0 ? "+" : ""}${sum.amount}${suffix}`;
    el.title = sum.froms.join("\n");
  }

  // One chip per ability that currently has a CHECK bonus, saying how much,
  // from what, and whether the book extends it to that ability's skill checks.
  // That last part is the whole reason this is worth showing: two soulmelds
  // grant a Strength-check bonus and only one of them reaches Climb.
  function renderAbilityCheckBonuses() {
    const host = document.getElementById("ability-check-bonuses");
    if (!host) return;
    const rows = [];
    if (typeof SoulmeldEffects !== "undefined" && SoulmeldEffects.flatRows) {
      try {
        for (const e of SoulmeldEffects.flatRows()) {
          if (e.bonus_type !== "ability_check" || !e.amount) continue;
          rows.push({
            ability: e.target || "any check",
            amount: e.amount,
            skills: !!e.includes_ability_skills,
            source: e.soulmeld,
            condition: e.condition || "",
          });
        }
      } catch (err) { /* a picker mid-load must not break the panel */ }
    }
    if (!rows.length) { host.hidden = true; host.innerHTML = ""; return; }
    host.hidden = false;
    host.innerHTML = '<span class="ability-check-label">Check bonuses:</span>'
      + rows.map((r) => {
        const tip = [`${r.source}: ${r.amount >= 0 ? "+" : ""}${r.amount} to ${r.ability} checks`,
                     r.skills
                       ? `also applies to ${r.ability}-based SKILL checks`
                       : `ability checks ONLY — not this ability's skill checks`,
                     r.condition].filter(Boolean).join(" — ");
        return `<span class="ability-check-chip${r.skills ? " with-skills" : ""}" `
          + `title="${escapeAttrCh(tip)}">`
          + `${r.amount >= 0 ? "+" : ""}${r.amount} ${escapeAttrCh(r.ability)}`
          + (r.skills ? " <b>+skills</b>" : "")
          + `<span class="ability-check-from">${escapeAttrCh(r.source)}</span></span>`;
      }).join("");
  }

  function escapeAttrCh(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

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
      //
      // A NONABILITY shows the dash the books print rather than a number. The
      // contributor columns above still render their values — they are real
      // and they come back if the flag is unticked — but they must not reach
      // the Total, or the row would read "-2" for a creature that has no score
      // to reduce. getAbilityMod already returns +0 here.
      const nonAbility = !!$(`#${lower}-nonability`)?.checked;
      const totalEl = $(`#${lower}-total`);
      if (totalEl) {
        totalEl.textContent = nonAbility ? "—" : (rawScore ? totalScore : "");
      }
      if (nonAbility) $(`#${lower}-score`).classList.add("is-nonability");
      else $(`#${lower}-score`).classList.remove("is-nonability");
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
    // Carried weight comes from Equipment.carriedWeight() — the SINGLE
    // implementation (equipment.js). This used to be a second copy of the
    // same sum, and the copies disagreed twice: coin weight was in the
    // display total and not in the load category (2026-05-17), and
    // magic-item weight was in neither (2026-05-18). Both were fixed by
    // editing two places at once, which is not a fix, it is a coincidence
    // waiting to lapse. Extradimensional containers (2026-08-22) would have
    // been the third: the display would have stopped counting a stowed chain
    // shirt while encumbrance kept counting it.
    // recalcWeight() rather than carriedWeight(): it computes the same thing
    // and also refreshes the Total Weight box and the container readout, so a
    // structural change that only goes through recalcAll (adding a gear row,
    // loading a character) repaints them too.
    const carried = (typeof Equipment !== "undefined" && Equipment.recalcWeight)
      ? Equipment.recalcWeight() : null;
    if (!carried && !recalc._warnedNoEquipment) {
      recalc._warnedNoEquipment = true;
      console.warn("[character] Equipment.carriedWeight unavailable — load " +
        "category is computing against 0 lb.");
    }
    const totalWeight = carried ? carried.total : 0;
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
    // Maneuverability, auto-selected from whatever GRANTED the flight — a
    // soulmeld, a race, a class feature. The aggregator already resolved which
    // source won (best speed), so its maneuverability is the one that applies,
    // and making the player re-pick it from a dropdown after the sheet already
    // knew is busywork.
    //
    // It stays EDITABLE, because the granted value is a default and not a law:
    // Improved Flight and similar effects raise maneuverability by a step, and
    // the sheet has no way to know. Marked `data-from-speed` and cleared on the
    // player's first real edit, the same handover every other auto-filled field
    // on this sheet uses.
    const manEl = $("#speed-fly-maneuver");
    if (manEl && spd.fly && spd.fly.maneuver) {
      const owned = manEl.dataset.fromSpeed != null;
      if (!manEl.value || owned) {
        if (manEl.value !== spd.fly.maneuver) manEl.value = spd.fly.maneuver;
        manEl.dataset.fromSpeed = spd.fly.maneuver;
        if (!manEl.dataset.fromSpeedWired) {
          manEl.dataset.fromSpeedWired = "1";
          manEl.addEventListener("change", (ev) => {
            if (ev.isTrusted) delete manEl.dataset.fromSpeed;
          });
        }
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

    // Spell resistance and miss chance from shaped soulmelds. Both are typed
    // in by hand, and NEITHER STACKS — the single highest source applies (the
    // miss-chance field says so itself: "50/20 → highest wins at 50"). So the
    // effective figure is shown beside the box rather than written into it:
    // the box is the player's, and a value that changes every time an essentia
    // pip moves has no business overwriting what they typed.
    renderDerivedDefense();

    // Senses and the light source. Recomputed here rather than pushed, because
    // a race change, a soulmeld, an essentia pip and a template all move it.
    if (typeof Senses !== "undefined" && Senses.render) Senses.render();

    // The combat-options readout depends on state OUTSIDE its own inputs — the
    // Rage toggle makes a declared Combat Expertise inert — and its own
    // listeners only fire for its own boxes, so it would otherwise sit stale
    // saying a bonus applied when Rage had just switched it off.
    if (typeof CombatOptions !== "undefined" && CombatOptions.refresh) {
      CombatOptions.refresh();
    }

    // Extra MAXIMUM hit points. Shown as "+N" beside the total the player
    // typed rather than folded into it, because the box is theirs: the sheet
    // does not know their rolled hit dice, so it can add to their number but
    // must never replace it. Necrocarnum Vestments' are explicitly NOT
    // temporary hp — dropping essentia can leave you dead — so they belong on
    // the maximum and not in the Temp HP box.
    renderDerivedSum("hp-extra", SME_extraHP(), "", " max hp");

    // Which abilities currently have a CHECK bonus, and whether it reaches
    // that ability's skills. Shown under the ability table because that is
    // where you look when asking "what is my Strength check", and a bonus to
    // checks is invisible in the score / modifier columns.
    renderAbilityCheckBonuses();

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

      // Show the resistance bonus DERIVED from worn items (a cloak of
      // resistance, a periapt) beside the Magic box (report rmsrtdp1q-bud9).
      //
      // The maths was never wrong: the item's bonus already reaches the total
      // through saveTyped, which is also what makes two resistance bonuses
      // correctly NOT stack. What was wrong is that the total then did not
      // add up from the columns the player can see — the +2 arrived from
      // nowhere.
      //
      // Shown BESIDE the box rather than written into it, the same way the
      // soulmeld enhancement chip sits beside the damage box. Writing it in
      // would make a derived value look player-typed, and it would keep
      // granting the bonus after the cloak came off. (It would not even
      // change the total: the Magic box is itself typed `resistance`, so the
      // two would collapse to the higher one.)
      const chip = $(`#${prefix}-magic-derived`);
      if (chip) {
        const derived = ((bonuses.saveTyped && bonuses.saveTyped[prefix]) || [])
          .filter(b => b && Number(b.amount) > 0);
        // Report the one that WINS its type, not the sum — that is what the
        // total actually used.
        const best = new Map();
        for (const b of derived) {
          const cat = b.bonus_category || 'untyped';
          if (cat === 'untyped') continue;          // untyped stack; not a single winner
          const cur = best.get(cat);
          if (!cur || Number(b.amount) > Number(cur.amount)) best.set(cat, b);
        }
        const parts = [...best.values()]
          .sort((a, b) => Number(b.amount) - Number(a.amount));
        if (parts.length) {
          const top = parts[0];
          chip.textContent = `+${top.amount}`;
          chip.title = parts
            .map(b => `+${b.amount} ${b.bonus_category}` +
                      (b.source ? ` (${b.source})` : ''))
            .join('\n') +
            '\n\nAlready included in the total. Shown here because it is ' +
            'derived from your gear, not typed into the Magic box.';
          chip.style.display = '';
        } else {
          chip.textContent = '';
          chip.title = '';
          chip.style.display = 'none';
        }
      }
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
    // Flat feat bonus (Improved Grapple +4, PHB p.95) from Feats.getGrappleBonus.
    const grappleFeat = (bonuses.grapple && bonuses.grapple.amount) || 0;

    $("#grapple-bab").textContent = fmt(bab1);
    $("#grapple-str").textContent = fmt(strMod);
    $("#grapple-size").textContent = fmt(grappleSize);
    const grappleFeatEl = $("#grapple-feat");
    if (grappleFeatEl) grappleFeatEl.textContent = fmt(grappleFeat);
    // Girallon Arms and Kraken Mantle both grant a grapple bonus that scales
    // with essentia. Its own box rather than folded into Feat, so the formula
    // still reconciles by eye — which is the whole point of showing the parts.
    const grappleMeldSum = (typeof SoulmeldEffects !== "undefined"
                            && SoulmeldEffects.getGrappleBonus)
      ? SoulmeldEffects.getGrappleBonus() : { amount: 0, froms: [] };
    const grappleMeld = grappleMeldSum.amount || 0;
    const grappleMeldEl = $("#grapple-meld");
    if (grappleMeldEl) {
      grappleMeldEl.textContent = fmt(grappleMeld);
      grappleMeldEl.title = grappleMeldSum.froms.join(", ");
    }
    $("#grapple-total").textContent = fmt(bab1 + strMod + grappleSize + grappleFeat + grappleMeld + expr($("#grapple-misc").value));

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
      // Power Attack / Combat Expertise, declared once in Combat Options and
      // paid by every attack this round. Heedless Charge moves Power Attack's
      // share onto AC instead, which CombatOptions resolves.
      const coPenalty = (typeof CombatOptions !== "undefined")
        ? CombatOptions.attackPenalty() : 0;
      // Soulmeld attack effects, filtered by this row's fighting style for the
      // same reason the damage side filters: Dread Carapace's penalty is a
      // natural-weapon penalty and must not touch a longsword.
      let meldAtk = 0, meldEnhAtk = 0;
      const rowStyle = entry.querySelector(".dmg-style")?.value || "one-hand";
      if (typeof SoulmeldEffects !== "undefined" && SoulmeldEffects.getWeaponMods) {
        try {
          const m = SoulmeldEffects.getWeaponMods(rowStyle, weaponName);
          meldAtk = m.attack || 0;
          // Kept OUT of the Meld term: an enhancement bonus is typed and does
          // not stack with the weapon's own, so it belongs in Enh below where
          // that rule is applied. Bundling it into an untyped "Meld" number
          // both hid what kind of bonus it was and would have added it on top
          // of a magic weapon's.
          meldEnhAtk = m.enhAttack || 0;
        } catch (e) { meldAtk = 0; meldEnhAtk = 0; }
      }
      // HIGHEST enhancement wins, it does not sum: a +1 weapon and a soulmeld's
      // +1 enhancement give +1. Declared here rather than earlier because it
      // reads meldEnhAtk, which the block above produces.
      const enhTyped = int(entry.querySelector(".dmg-enh")?.value) || 0;
      const enhAtk = Math.max(enhTyped, meldEnhAtk);
      // Soulmeld binds that IMPROVE this weapon rather than adding to it —
      // Mauling Gauntlets doubling the threat range of "any melee weapon
      // wielded", Dread Carapace doubling it for "all natural attacks". Those
      // scopes existed for a day and reached nothing, because the only thing
      // consulting them was the soulmelds' OWN granted attacks and none of
      // those is a manufactured weapon.
      //
      // Shown BESIDE the player's Critical box, never written into it: that
      // box is theirs, it is free text, and a derived value that overwrote a
      // hand-typed "19-20/x2 (keen)" would destroy information the sheet
      // cannot reconstruct. Same choice as spell resistance and miss chance.
      const critMeldEl = entry.querySelector(".atk-crit-meld");
      if (critMeldEl) {
        let shown = "";
        let why = "";
        if (typeof SoulmeldEffects !== "undefined"
            && SoulmeldEffects.getAttackRowModifiers) {
          try {
            const mods = SoulmeldEffects.getAttackRowModifiers(rowStyle)
              .filter(m => m.threat_range_double);
            if (mods.length) {
              const critText = entry.querySelector(".atk-crit")?.value || "";
              const doubled = SoulmeldEffects.doubleThreatRange(critText);
              // These never stack with each other, so ONE applies however many
              // are in force — doubling twice is not a rule 3.5 has.
              const m = mods[0];
              shown = doubled ? `→ ${doubled}` : "→ threat ×2";
              why = `${m.soulmeld} doubles this weapon's threat range`
                + (mods.length > 1
                   ? ` (${mods.length} sources; they do not stack)` : "")
                + (m.no_stack_with ? `. Does not stack with ${m.no_stack_with}.` : "")
                + (doubled ? "" : " — enter a threat range to see the result.");
            }
          } catch (e) { shown = ""; }
        }
        critMeldEl.textContent = shown;
        critMeldEl.title = why;
        critMeldEl.style.display = shown ? "" : "none";
      }
      const total = bab1 + atkSizeMod + abilMod + misc + focus + enhAtk + coPenalty + meldAtk;
      // Crit CONFIRMATION. Deliberately NOT in `total` above: it applies only
      // to the confirmation roll, and folding it into the attack bonus would
      // inflate every swing. Power Critical is the only unconditional
      // weapon-named 3.5 feat here — the others (Confound the Big Folk, Vow of
      // Vengeance, Mark of Avernus) are situational and stay in the tooltip.
      let critConfirm = 0;
      const critNotes = [];
      const styleNow = entry.querySelector(".dmg-style")?.value || "one-hand";
      if (typeof SoulmeldEffects !== "undefined" && SoulmeldEffects.getConfirmCritBonus) {
        try {
          const c = SoulmeldEffects.getConfirmCritBonus(styleNow);
          critConfirm += c.amount || 0;
          critNotes.push(...(c.froms || []), ...(c.conditional || []));
        } catch (e) { /* leave it at zero */ }
      }
      if (typeof Feats !== "undefined" && Feats.getCritConfirmBonuses && weaponName) {
        // Matched the same way Weapon Focus is — whole-word, so the feat's
        // "longsword" hits "Masterwork Longsword" but not a stray substring.
        for (const [k, v] of Object.entries(Feats.getCritConfirmBonuses())) {
          if (weaponFocusMatches(weaponName, k)) {
            critConfirm += v;
            critNotes.push(`Power Critical (${k}) +${v}`);
          }
        }
      }
      const critEl = entry.querySelector(".atk-calc-crit");
      const critTerm = entry.querySelector(".atk-calc-crit-term");
      const critOp = entry.querySelector(".atk-calc-crit-op");
      const showCrit = !!(critConfirm || critNotes.length);
      if (critEl) { critEl.textContent = fmt(critConfirm); critEl.title = critNotes.join("; "); }
      if (critTerm) critTerm.style.display = showCrit ? "" : "none";
      if (critOp) critOp.style.display = showCrit ? "" : "none";

      const meldEl = entry.querySelector(".atk-calc-meld");
      const meldTerm = entry.querySelector(".atk-calc-meld-term");
      const meldOp = entry.querySelector(".atk-calc-meld-op");
      if (meldEl) meldEl.textContent = fmt(meldAtk);
      if (meldTerm) meldTerm.style.display = meldAtk ? "" : "none";
      if (meldOp) meldOp.style.display = meldAtk ? "" : "none";
      const coEl = entry.querySelector(".atk-calc-co");
      const coTerm = entry.querySelector(".atk-calc-co-term");
      const coOp = entry.querySelector(".atk-calc-co-op");
      if (coEl) coEl.textContent = fmt(coPenalty);
      if (coTerm) coTerm.style.display = coPenalty ? "" : "none";
      if (coOp) coOp.style.display = coPenalty ? "" : "none";
      const enhEl = entry.querySelector(".atk-calc-enh");
      const enhTerm = entry.querySelector(".atk-calc-enh-term");
      const enhOp = entry.querySelector(".atk-calc-enh-op");
      if (enhEl) {
        enhEl.textContent = fmt(enhAtk);
        enhEl.title = meldEnhAtk && meldEnhAtk >= enhTyped
          ? "Enhancement bonus from a soulmeld. Enhancement bonuses do not "
            + "stack — the highest applies."
          : "";
      }
      if (enhTerm) enhTerm.style.display = enhAtk ? "" : "none";
      if (enhOp) enhOp.style.display = enhAtk ? "" : "none";
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

      // The damage equation for this same row. Given the bonus-aware ability
      // modifier and the Weapon Specialization map so it never has to reach for
      // globals of its own.
      if (typeof DamageCalc !== "undefined") {
        DamageCalc.recalcRow(entry, {
          getAbilityMod,
          expr,
          weaponSpec: bonuses.weaponSpec || {},
          naturalAttackSteps: bonuses.naturalAttackSteps || {},
          matches: weaponFocusMatches,
        });
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

    // Total gear weight display is written by Equipment.recalcWeight above —
    // writing it again here is what produced the 2026-05-17 money bug, where
    // equipment.js's money-inclusive total was overwritten by a money-less one.
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
        <div class="field field-sm"><label>Critical</label><input type="text" class="atk-crit" value="${data.crit || ""}"><span class="atk-crit-meld" title="A soulmeld is improving this weapon's threat range. Shown beside your own Critical box rather than written into it — the box is yours." style="display:none"></span></div>
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
        <span class="atk-calc-op atk-calc-enh-op" style="display:none">+</span>
        <span class="atk-calc-term atk-calc-enh-term" style="display:none" title="Weapon enhancement bonus — the SAME field as the damage row's Enh below. Entered once, paid to both."><span class="atk-calc-k">Enh</span><span class="calc-field atk-calc-enh">+0</span></span>
        <span class="atk-calc-op atk-calc-crit-op" style="display:none">+</span>
        <span class="atk-calc-term atk-calc-crit-term" style="display:none" title="Bonus on the roll to CONFIRM a critical threat — not on the attack itself, so it is not in the total above."><span class="atk-calc-k">Crit</span><span class="calc-field atk-calc-crit">+0</span></span>
        <span class="atk-calc-op atk-calc-meld-op" style="display:none">+</span>
        <span class="atk-calc-term atk-calc-meld-term" style="display:none" title="Soulmeld effects that apply to this weapon, from the essentia invested in them."><span class="atk-calc-k">Meld</span><span class="calc-field atk-calc-meld">+0</span></span>
        <span class="atk-calc-op atk-calc-co-op" style="display:none">+</span>
        <span class="atk-calc-term atk-calc-co-term" style="display:none" title="Power Attack + Combat Expertise, declared in Combat Options. Heedless Charge moves the Power Attack half onto AC instead of the attack roll."><span class="atk-calc-k">Options</span><span class="calc-field atk-calc-co">+0</span></span>
        <span class="atk-calc-op">=</span>
        <span class="calc-field atk-calc-total atk-calc-total-big">+0</span>
        <label class="atk-calc-auto" title="Auto-fill the Attack Bonus field above from this total"><input type="checkbox" class="atk-calc-auto-cb"${data.calcAuto ? " checked" : ""}> fill bonus</label>
      </div>
    `;
    container.appendChild(div);
    // The damage equation is a sibling of the attack calculator above and lives
    // in its own module — same row, same grammar, same opt-in fill checkbox.
    if (typeof DamageCalc !== "undefined") DamageCalc.attachRow(div, data.damageCalc || {});
    if (data.fromClass) {
      div.dataset.fromClass = data.fromClass;
      if (data.playerOwned) div.dataset.playerOwned = "1";
      // Any hand-edit hands the row over to the player. It is marked OWNED
      // rather than having its key erased, and the difference matters:
      //
      // erasing the key made the row unrecognisable, so the next sync saw the
      // attack as missing and created a SECOND one. One keystroke on a
      // soulmeld's claw row, then any essentia change or reload, and the
      // character had two identical claws — which double-counts if you roll
      // both. Reported on Gorrash 2026-08-21.
      //
      // Keeping the key preserves every property the erase was protecting:
      // upsertClassAttack refuses to overwrite an owned row's fields and
      // refuses to delete it when the source goes away. It just also knows the
      // row is still THIS attack, so it never makes a rival for it.
      div.addEventListener("input", (ev) => {
        if (ev.isTrusted) div.dataset.playerOwned = "1";
      });
    }
    return div;
  }

  // Create / update / remove an attack row OWNED by something other than the
  // player — a class feature (the Warlock's eldritch blast) or a shaped
  // soulmeld (Kruthik Claws' two claws). Keyed by `fromClass` so a level-up or
  // an essentia change rewrites the SAME row instead of stacking duplicates,
  // and losing the source takes the row with it. `spec` of null means "this
  // source no longer grants it".
  //
  // Only rows still carrying the marker are managed — once the player edits
  // one it's theirs, and a later level-up leaves it alone (it also stops
  // being removed with the class, which is the right trade: we never delete
  // something the player typed).
  //
  // The attribute is still `data-from-class` because saved characters carry it
  // and renaming it would strand every managed row in every existing save. The
  // KEY is namespaced instead — soulmeld rows use "soulmeld:<slot>|<attack>" —
  // so the two owners can never collide over one row.
  function upsertClassAttack(key, spec) {
    const container = $("#attacks-container");
    if (!container) return null;
    const esc = String(key).replace(/"/g, '\\"');
    let row = container.querySelector(`.attack-entry[data-from-class="${esc}"]`);
    if (!spec) {
      // The source is gone. An OWNED row is the player's work and stays;
      // anything else was ours to remove.
      if (row && !row.dataset.playerOwned) row.remove();
      return null;
    }
    if (!row) {
      // ADOPT a matching unowned row before making a new one. This covers rows
      // saved before ownership was tracked — their key was erased on the first
      // edit, so they arrive unrecognisable, and creating a second identical
      // attack beside one the player already has is exactly the bug this
      // change exists to stop. Matched on the name we would have given it.
      const want = String(spec.name || "").trim().toLowerCase();
      if (want) {
        for (const cand of container.querySelectorAll(".attack-entry")) {
          if (cand.dataset.fromClass) continue;
          const n = (cand.querySelector(".atk-name")?.value || "").trim().toLowerCase();
          if (n !== want) continue;
          cand.dataset.fromClass = key;
          cand.dataset.playerOwned = "1";   // it was theirs before we found it
          row = cand;
          break;
        }
      }
      if (!row) return addAttack(Object.assign({ fromClass: key }, spec));
    }
    // An owned row keeps every value the player put in it. It is still
    // identified, so the sync will not duplicate it, but nothing here writes
    // to it.
    if (row.dataset.playerOwned) return row;
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
    // Save-stability: the fly-maneuverability dropdown is AUTO-FILLED from
    // whatever granted the flight, and hands over to the player on their first
    // edit. Its VALUE round-trips through the list above, but the marker does
    // not — and without the marker a loaded character reads as player-owned,
    // so the dropdown would freeze at whatever it held when saved and never
    // follow a changed soulmeld or race again.
    const manSave = $("#speed-fly-maneuver");
    if (manSave && manSave.dataset.fromSpeed != null) data._flyManeuverAuto = true;

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
      // Nonability flag (2026-09-01). Persisted as a BOOLEAN because the
      // score field is `type=number` and physically cannot hold the dash the
      // books print — see app.js getAbilityMod. The modifier fields are saved
      // alongside it and deliberately kept: unticking the box has to restore
      // them, so the flag makes them inert rather than erasing them.
      data[`${lower}-nonability`] = !!$(`#${lower}-nonability`)?.checked;
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
        // The damage equation's own state (dice, fighting style, ability terms,
        // enhancement, fill toggle). Nested under one key so the attack row's
        // flat fields stay readable, and absent on a row that predates the
        // calculator — addAttack defaults it to {}.
        damageCalc: (typeof DamageCalc !== "undefined")
          ? DamageCalc.collectRow(entry) : null,
        // Round-trip the class-grant marker so a reloaded character's
        // eldritch blast is still recognised as managed — without it, the
        // sync would add a SECOND row on the next class change.
        fromClass: entry.dataset.fromClass || "",
        // Persisted so a reload knows the row is the player's. Without it the
        // load looks like a fresh managed row, the sync overwrites their edits,
        // and the handover silently expires every time they open the sheet.
        playerOwned: entry.dataset.playerOwned === "1" || undefined,
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
      const naEl = $(`#${lower}-nonability`);
      if (naEl) {
        // Absent key => false, so every pre-2026-09-01 save loads unchanged.
        // A legacy dash sitting in the score field (from an import, or from
        // before the field was numeric) counts as the flag being set.
        const legacyDash = ["—", "–", "-"]
          .indexOf(String(data[`${lower}-score`] ?? "").trim()) !== -1;
        naEl.checked = !!data[`${lower}-nonability`] || legacyDash;
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
    // Re-stamp the fly-maneuverability auto-fill marker (see collectData). A
    // save WITHOUT the flag is a player-owned value and must be left alone —
    // which is also the right answer for every character saved before the flag
    // existed, since those dropdowns were all hand-picked.
    const manLoad = $("#speed-fly-maneuver");
    if (manLoad) {
      if (data._flyManeuverAuto) manLoad.dataset.fromSpeed = manLoad.value || "";
      else delete manLoad.dataset.fromSpeed;
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
  // Rest (report rmsca08wf-1mwl)
  // ============================================================
  //
  // A night's rest does two things: restores every daily spell / power /
  // maneuver expenditure (Spells.restAll owns that half), and heals hit
  // points. PHB p.146 "Natural Healing": after 8 hours of rest you recover
  // 1 hp per character level. Long-term care (a DC 15 Heal check from an
  // attendant, PHB p.75) doubles it.
  //
  // Nonlethal damage heals at 1 point per character level per HOUR, so a
  // full 8-hour rest clears any nonlethal total a PC realistically carries —
  // zeroed here rather than modelled hour-by-hour.
  //
  // Temp HP is cleared too (report rmsee2qqz): temporary hit points come from
  // a spell/effect with its own duration, and an 8-hour rest outlasts
  // virtually every temp-HP source (Aid is minutes, false life is hours), so
  // by morning they're gone. Zeroed here rather than modelled per-source.
  // longTerm doubles the natural healing (DC 15 Heal check from an attendant,
  // PHB p.75). It's a per-action argument now — a dedicated "Rest (Long-term
  // care)" button passes true — rather than a sticky toggle that could silently
  // carry into a later plain rest (report rmso1h7vo).
  function restEightHours(longTerm = false) {
    const level = (window.ClassPicker && ClassPicker.totalCharacterLevel)
      ? ClassPicker.totalCharacterLevel() : 0;
    const perLevel = longTerm ? 2 : 1;
    const heal = Math.max(0, level) * perLevel;

    const curEl = $("#hp-current");
    const totalEl = $("#hp-total");
    let healed = 0;
    if (curEl) {
      const total = int(totalEl?.value);
      const before = int(curEl.value);
      // Cap at Total HP when a total is set; otherwise just add.
      const after = total > 0 ? Math.min(total, before + heal) : before + heal;
      healed = after - before;
      curEl.value = after;
      curEl.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const nl = $("#hp-nonlethal");
    const nlCleared = int(nl?.value);
    if (nl && nlCleared) {
      nl.value = 0;
      nl.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const tmp = $("#hp-temp");
    const tmpCleared = int(tmp?.value);
    if (tmp && tmpCleared) {
      tmp.value = 0;
      tmp.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // NB: `Spells` is a top-level `const`, NOT a window property — guarding
    // it off the window object silently short-circuits to false and the
    // caster half of the rest never runs (I shipped exactly that bug, and the
    // "no window.X guards on top-level const modules" audit exists for it).
    // ClassPicker above IS explicitly assigned to window, hence the different
    // check there.
    if (typeof Spells !== "undefined" && typeof Spells.restAll === "function") {
      Spells.restAll();
    }
    // No bare recalc() here: Character.recalc takes (getAbilityMod, bonuses)
    // and throws without them. The `input` events dispatched above already
    // bubble to app.js's listener, which runs the full recalcAll pass.

    const out = $("#rest-result");
    if (out) {
      const bits = [];
      bits.push(level > 0
        ? `+${healed} hp (${perLevel}/level × ${level}${longTerm ? ", long-term care" : ""})`
        : "no class levels — set a class to heal");
      if (nlCleared) bits.push(`${nlCleared} nonlethal cleared`);
      if (tmpCleared) bits.push(`${tmpCleared} temp HP cleared`);
      bits.push("slots/PP/maneuvers restored");
      out.textContent = bits.join(" · ");
      clearTimeout(out._t);
      out._t = setTimeout(() => { out.textContent = ""; }, 8000);
    }
  }

  // ============================================================
  // Public API
  // ============================================================
  return { recalc, addAttack, upsertClassAttack, addAbilityAcRow, collectData,
           loadData, resetAttacks, restEightHours };
})();
