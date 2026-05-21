// item-familiar.js — Item Familiar (Unearthed Arcana pp.170-173).
//
// An item familiar is a permanent magic item that a character bonds
// with via the Item Familiar feat. The item gains powers + sentience
// as the master levels up; the master can invest XP, skill ranks,
// and spell slots into the item for bonuses.
//
// Integrated as an alternate `compType` on the Companion tab. When
// the user picks "Item Familiar" from the type dropdown, companion.js
// delegates rendering + wiring to this module (no creature stat
// block — entirely different layout).
//
// Public API (exposed on window.ItemFamiliar for cross-module use):
//
//   isItemFamiliarType(t)          — true if compType === 'item_familiar'
//   buildHTML(idx, data)           — full panel HTML for an item-familiar
//   wirePanel(idx, panel, data)    — attach listeners to a built panel
//   collectData(panel)             — read panel state → data dict
//   loadData(panel, data)          — write data dict → panel state
//   recalc(panel)                  — recompute Ego / sapience / spell-slot
//                                    derived displays for one panel
//   getAllSkillBonuses()           — aggregate +N skill bonuses across all
//                                    item-familiar panels (auto-apply hook
//                                    for skills.js)
//   getAllSpellSlotBonuses(className) — aggregate bonus slots by spellcasting
//                                    class (auto-apply hook for spells.js)
//   getXpMultiplier()              — 1.0 or 1.1 depending on Life Energy
//                                    investments (auto-apply hook for
//                                    character.js)
//
// Source: Unearthed Arcana (WotC, 2004) pp.170-173 + the brief CArc
// summary at p.66-68. Tables and special-ability list extracted from
// UA verbatim.

(function () {
  // -- Small helpers (mirrored from the rest of the project) ----------
  function esc(s) {
    // Use nullish-check, not falsy: numeric 0 is a meaningful value
    // (a deliberately-zero price, weight, or invested-slot count) and
    // would otherwise serialize to empty, wiping the user's input.
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
      .replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function int(v) {
    const n = parseInt(String(v || ""), 10);
    return isNaN(n) ? 0 : n;
  }
  function getMasterLevel() {
    const el = document.getElementById("char-level");
    return el ? int(el.value) : 0;
  }

  // -- Rules constants from UA Table 5-12 -----------------------------
  // What benefits unlock at what character level.
  const SAPIENCE_LEVEL = 7;
  const SPECIAL_ABILITY_LEVELS = [10, 14, 18];  // + 21+ thereafter
  const LIFE_ENERGY_MAX_LEVEL = 6;  // can only invest at L6 or lower
  const SKILL_BONUS_PER_RANKS = 3;  // every 3 ranks in item = +1 bonus

  // The 8 canonical special-ability picks (UA p.172-173). Used by the
  // dropdown chooser when the player gains a Special Ability slot.
  const SPECIAL_ABILITIES = [
    "Armor/Shield/Weapon Special Ability (+1-equivalent)",
    "Cantrips/Orisons (0-level spell access)",
    "Greater Power (from DMG Intelligent Item Greater Powers)",
    "Greater Senses (blindsense 30 ft) — prereq Improved Senses",
    "Improved Senses (darkvision 60 ft)",
    "Increased Sapience (+4/+2/+2 abilities; telepathy + languages)",
    "Lesser Power (from DMG Intelligent Item Lesser Powers)",
    "Special Purpose + Dedicated Power",
    "Spell Use (cast invested spell as standard action; req 3rd-level spells)",
  ];

  // How many special-ability slots the master is entitled to at their
  // current level. Returns an integer (0 if below L10).
  function specialAbilitySlotsAvailable(masterLevel) {
    let n = 0;
    for (const lvl of SPECIAL_ABILITY_LEVELS) {
      if (masterLevel >= lvl) n++;
    }
    if (masterLevel >= 21) {
      n += Math.floor((masterLevel - 20) / 3);  // +1 per 3 levels above 20
    }
    return n;
  }

  // -- Public type-check helper ---------------------------------------
  function isItemFamiliarType(t) {
    return String(t || "").toLowerCase() === "item_familiar";
  }

  // -- HTML builder ---------------------------------------------------
  function buildHTML(idx, d) {
    d = d || {};
    const masterLevel = getMasterLevel();
    const showSapience = masterLevel >= SAPIENCE_LEVEL;
    const specialSlots = specialAbilitySlotsAvailable(masterLevel);
    const showSpecials = specialSlots > 0;

    // Pre-build the skill investment + bonus rows.
    const skillRanksRows = (d.skillRanksInItem || []).map((r, i) => skillRankRowHTML(i, r)).join("");
    const skillBonusRows = (d.skillBonusesApplied || []).map((b, i) => skillBonusRowHTML(i, b)).join("");
    const slotRows = (d.spellSlotsInvested || []).map((s, i) => spellSlotRowHTML(i, s)).join("");
    const specialRows = (d.specialAbilities || []).map((a, i) => specialAbilityRowHTML(i, a)).join("");

    return `
    <!-- ItemFamiliar header: identity + carried/lost status ----------- -->
    <div class="ifam-header">
      <div class="info-grid">
        <div class="field"><label>Companion Name</label>
          <input type="text" class="comp-name" value="${esc(d.compName || "")}"
                 placeholder="e.g. The Whispering Ring">
        </div>
        <div class="field"><label>Type</label>
          <select class="comp-type">
            <option value="animal">Animal Companion</option>
            <option value="familiar">Familiar</option>
            <option value="cohort">Cohort</option>
            <option value="psicrystal">Psicrystal</option>
            <option value="item_familiar" selected>Item Familiar</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>
      <div class="info-grid" style="margin-top:0.3rem">
        <div class="field field-lg"><label>Bonded Item Name</label>
          <input type="text" class="ifam-item-name" value="${esc(d.ifamItemName || "")}"
                 list="item-options"
                 placeholder="e.g. +1 Ring of Spell Storing">
        </div>
        <div class="field field-sm"><label>Base Price (gp)</label>
          <input type="number" class="ifam-item-price" min="2000"
                 value="${esc(d.ifamItemPrice ?? "")}"
                 title="Must be ≥2,000 gp (UA p.170).">
        </div>
        <div class="field field-sm"><label>Weight (lb)</label>
          <input type="number" class="ifam-item-weight" min="0" step="0.1"
                 value="${esc(d.ifamItemWeight ?? "")}"
                 title="Item still has weight — it has to be carried like any other piece of gear. Counts toward the carry-weight total on the Equipment tab.">
        </div>
        <div class="field"><label>Alignment</label>
          <input type="text" class="ifam-alignment"
                 value="${esc(d.ifamAlignment || "")}"
                 placeholder="defaults to master's"
                 title="Item familiar's alignment matches master's unless severed by a special-purpose conflict.">
        </div>
      </div>
      <div class="info-grid" style="margin-top:0.3rem">
        <div class="field" style="flex:2 1 100%"><label>Item magical effect / notes</label>
          <textarea class="ifam-item-notes" rows="2"
                    placeholder="The item's intrinsic magical effect (e.g. 'Spell storing — 3rd-level slot') + roleplay notes.">${esc(d.ifamItemNotes || "")}</textarea>
        </div>
      </div>
      <div class="ifam-status" style="margin-top:0.5rem;display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap">
        <label class="mi-toggle"><input type="checkbox" class="ifam-carried"
               ${d.ifamCarried === false ? "" : "checked"}>
          Currently carried
        </label>
        <label class="mi-toggle"><input type="checkbox" class="ifam-lost"
               ${d.ifamLost ? "checked" : ""}>
          Lost or destroyed (severs bonuses, applies XP penalty)
        </label>
        <span class="ifam-loss-penalty calc-field" style="opacity:0.8"></span>
      </div>
    </div>

    <!-- Investments section: Life Energy / Skill Ranks / Spell Slots -- -->
    <h3 style="margin-top:0.8rem">Investments</h3>

    <!-- Life Energy (only at master level ≤6) -->
    <details class="ifam-card ifam-card-life" ${d.lifeEnergyInvested ? "open" : ""}
             style="margin-bottom:0.5rem;padding:0.4rem 0.6rem;
             background:rgba(255,255,255,0.03);border-left:3px solid #b97;
             border-radius:0 3px 3px 0">
      <summary style="cursor:pointer">
        <b>Life Energy</b>
        <span class="ifam-life-status" style="opacity:0.7;margin-left:0.5rem">
          ${d.lifeEnergyInvested ? "✓ invested (+10% XP)" : ""}
        </span>
      </summary>
      <div style="margin-top:0.5rem;display:flex;flex-direction:column;gap:0.3rem">
        <label class="mi-toggle"><input type="checkbox" class="ifam-life-invested"
               ${d.lifeEnergyInvested ? "checked" : ""}>
          Invest life energy (+10% XP — current and future)
        </label>
        <!-- Soft warning when out-of-range, BUT the box is never
             disabled — retrofitting existing characters or DM-allowed
             exceptions need to be possible without UI friction. -->
        <span class="ifam-life-warn" style="color:#dba;font-size:0.85em;
              ${masterLevel > LIFE_ENERGY_MAX_LEVEL && !d.lifeEnergyInvested ? '' : 'display:none'}">
          ⚠ Life energy is normally invested at master level ${LIFE_ENERGY_MAX_LEVEL} or lower (UA p.170). The DM may allow exceptions.
        </span>
        <span style="font-size:0.85em;opacity:0.75">
          Loss penalty: forfeit all bonus XP from the +10% + an extra 200 XP × master level.
        </span>
      </div>
    </details>

    <!-- Skill Ranks invested + bonuses applied -->
    <details class="ifam-card ifam-card-skills" open
             style="margin-bottom:0.5rem;padding:0.4rem 0.6rem;
             background:rgba(255,255,255,0.03);border-left:3px solid #7b9;
             border-radius:0 3px 3px 0">
      <summary style="cursor:pointer">
        <b>Skill Ranks</b>
        <span class="ifam-skill-summary" style="opacity:0.7;margin-left:0.5rem"></span>
      </summary>
      <div style="margin-top:0.5rem">
        <div style="font-size:0.85em;opacity:0.8;margin-bottom:0.3rem">
          Add ranks the player has invested in the item. Every ${SKILL_BONUS_PER_RANKS} ranks
          grants a +1 bonus the master can apply to any skill (can exceed max-ranks cap;
          stacked bonuses to one skill capped by total ranks invested).
        </div>
        <table class="ifam-table" style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="text-align:left">
              <th>Skill</th><th style="width:5rem">Ranks in Item</th><th style="width:2rem"></th>
            </tr>
          </thead>
          <tbody class="ifam-skill-ranks-list">${skillRanksRows}</tbody>
        </table>
        <button class="btn-add ifam-add-skill-rank" style="margin-top:0.3rem">+ Add Skill Investment</button>

        <div style="margin-top:0.6rem;padding-top:0.4rem;border-top:1px dashed rgba(255,255,255,0.08)">
          <div style="font-size:0.85em;opacity:0.8;margin-bottom:0.3rem">
            Apply the resulting +1 bonuses to specific skills. Total bonuses applied
            cannot exceed ⌊total ranks in item ÷ ${SKILL_BONUS_PER_RANKS}⌋.
          </div>
          <table class="ifam-table" style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="text-align:left">
                <th>Skill</th><th style="width:5rem">Bonus</th><th style="width:2rem"></th>
              </tr>
            </thead>
            <tbody class="ifam-skill-bonus-list">${skillBonusRows}</tbody>
          </table>
          <button class="btn-add ifam-add-skill-bonus" style="margin-top:0.3rem">+ Apply Skill Bonus</button>
        </div>
      </div>
    </details>

    <!-- Spell Slots invested + bonus slots gained -->
    <details class="ifam-card ifam-card-slots" open
             style="margin-bottom:0.5rem;padding:0.4rem 0.6rem;
             background:rgba(255,255,255,0.03);border-left:3px solid #79b;
             border-radius:0 3px 3px 0">
      <summary style="cursor:pointer">
        <b>Spell Slots</b>
        <span class="ifam-slots-summary" style="opacity:0.7;margin-left:0.5rem"></span>
      </summary>
      <div style="margin-top:0.5rem">
        <div style="font-size:0.85em;opacity:0.8;margin-bottom:0.3rem">
          Spellcaster only. Invest one spell slot of your highest castable level per
          class — gain a bonus slot 2 levels lower. Auto-updates as caster level rises.
        </div>
        <table class="ifam-table" style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="text-align:left">
              <th>Class</th>
              <th style="width:5rem">Invested Lvl</th>
              <th style="width:5rem">Bonus Slot</th>
              <th style="width:2rem"></th>
            </tr>
          </thead>
          <tbody class="ifam-spell-slot-list">${slotRows}</tbody>
        </table>
        <button class="btn-add ifam-add-slot" style="margin-top:0.3rem">+ Invest Spell Slot</button>
      </div>
    </details>

    <!-- Sapience (master L7+) -->
    <details class="ifam-card ifam-card-sapience" ${showSapience ? "" : "style=\"display:none\""}
             ${d.sapienceUnlocked ? "open" : ""}
             style="margin-bottom:0.5rem;padding:0.4rem 0.6rem;
             background:rgba(255,255,255,0.03);border-left:3px solid #b8d;
             border-radius:0 3px 3px 0;${showSapience ? "" : "display:none"}">
      <summary style="cursor:pointer">
        <b>Sapience</b>
        <span style="opacity:0.7;margin-left:0.5rem;font-size:0.85em">
          unlocked at master L${SAPIENCE_LEVEL}
        </span>
      </summary>
      <div style="margin-top:0.5rem">
        <div style="font-size:0.85em;opacity:0.8;margin-bottom:0.3rem">
          Pick distribution: two scores are 10, one is 12. Item gains an Ego score
          (see DMG p.270). Item gets 60-ft sight + hearing; master gets <b>Alertness</b>
          while wielding.
        </div>
        <div class="info-grid">
          <div class="field field-sm"><label>Int</label>
            <input type="number" class="ifam-sapience-int" min="3" max="20"
                   value="${esc(d.sapienceInt || 10)}"></div>
          <div class="field field-sm"><label>Wis</label>
            <input type="number" class="ifam-sapience-wis" min="3" max="20"
                   value="${esc(d.sapienceWis || 10)}"></div>
          <div class="field field-sm"><label>Cha</label>
            <input type="number" class="ifam-sapience-cha" min="3" max="20"
                   value="${esc(d.sapienceCha || 12)}"></div>
          <div class="field field-sm"><label>Ego</label>
            <span class="ifam-ego calc-field">--</span></div>
        </div>
        <label class="mi-toggle" style="margin-top:0.3rem">
          <input type="checkbox" class="ifam-sapience-unlocked"
                 ${d.sapienceUnlocked ? "checked" : ""}>
          Sapience unlocked (turns on Alertness benefit + senses)
        </label>
        <div class="field" style="margin-top:0.3rem">
          <label>Communication / personality notes</label>
          <textarea class="ifam-sapience-notes" rows="2"
                    placeholder="Tone, agenda, quirks. ('Anxious and over-helpful when in dark places.')">${esc(d.sapienceNotes || "")}</textarea>
        </div>
      </div>
    </details>

    <!-- Special Abilities (master L10+) -->
    <details class="ifam-card ifam-card-specials" ${showSpecials ? "" : "style=\"display:none\""}
             style="margin-bottom:0.5rem;padding:0.4rem 0.6rem;
             background:rgba(255,255,255,0.03);border-left:3px solid #d97;
             border-radius:0 3px 3px 0;${showSpecials ? "" : "display:none"}">
      <summary style="cursor:pointer">
        <b>Special Abilities</b>
        <span class="ifam-specials-count" style="opacity:0.7;margin-left:0.5rem;font-size:0.85em"></span>
      </summary>
      <div style="margin-top:0.5rem">
        <div style="font-size:0.85em;opacity:0.8;margin-bottom:0.3rem">
          Choose from the list each time you gain a slot (L10, L14, L18, +1 per 3 levels
          above 20). Notes field is free-text so you can record the specifics
          (e.g. "Spell Use: stores invisibility").
        </div>
        <div class="ifam-specials-list">${specialRows}</div>
        <button class="btn-add ifam-add-special" style="margin-top:0.3rem">+ Add Special Ability</button>
        <div class="ifam-specials-warning" style="display:none;color:#dba;font-size:0.85em;margin-top:0.3rem"></div>
      </div>
    </details>
    `;
  }

  // Row renderers — each as a small fragment for clean event delegation.
  function skillRankRowHTML(idx, r) {
    return `
      <tr class="ifam-skill-rank-row" data-row="${idx}">
        <td><input type="text" class="ifam-rank-skill" list="skills-options"
                   value="${esc((r && r.skill) || "")}" placeholder="Skill name"></td>
        <td><input type="number" class="ifam-rank-count" min="1" max="99"
                   value="${esc((r && r.ranks) || 1)}" style="width:4rem"></td>
        <td><button class="btn-remove ifam-remove-rank" title="Remove">X</button></td>
      </tr>`;
  }
  function skillBonusRowHTML(idx, b) {
    return `
      <tr class="ifam-skill-bonus-row" data-row="${idx}">
        <td><input type="text" class="ifam-bonus-skill" list="skills-options"
                   value="${esc((b && b.skill) || "")}" placeholder="Skill name"></td>
        <td><input type="number" class="ifam-bonus-amt" min="1" max="20"
                   value="${esc((b && b.bonus) || 1)}" style="width:4rem"></td>
        <td><button class="btn-remove ifam-remove-bonus" title="Remove">X</button></td>
      </tr>`;
  }
  function spellSlotRowHTML(idx, s) {
    return `
      <tr class="ifam-slot-row" data-row="${idx}">
        <td><input type="text" class="ifam-slot-class"
                   value="${esc((s && s.class) || "")}" placeholder="e.g. Wizard"></td>
        <td>
          <input type="number" class="ifam-slot-invested" min="1" max="9"
                 value="${esc((s && s.invested) || "")}" style="width:4rem"
                 title="UA p.171: must be the highest spell level you can cast in this class. Auto-updates when blank or matching the detected highest.">
          <button class="btn-feat-info ifam-slot-auto" title="Re-sync to highest castable level"
                  style="padding:0 0.3rem;line-height:1">↻</button>
          <span class="ifam-slot-warn" style="display:none;color:#dba;font-size:0.85em"></span>
        </td>
        <td><span class="ifam-slot-bonus calc-field">--</span></td>
        <td><button class="btn-remove ifam-remove-slot" title="Remove">X</button></td>
      </tr>`;
  }

  // -- Detect highest castable spell level for a given class name.
  // Walks Spells-tab spellcasting panels, matches by tab label / notes
  // (case-insensitive substring), and returns the highest spell level
  // where the caster has a NON-BONUS slot. Returns null when no
  // matching panel is found.
  //
  // IMPORTANT: bonus slots (ability-mod-derived) do NOT count as
  // "castable" — per the PHB "Bonus Spells" sidebar, you can only
  // RECEIVE bonus spells of a level you can already cast. So a
  // Wizard with perDay-4 = 2 + a phantom L5 bonus (from high INT)
  // can only cast through L4. spells.js gates the same way (see
  // `baseCastable = (perDay + domain + specialist) > 0`), and we
  // mirror it here to keep the two in lockstep.
  //
  // If a save from an older version of the sheet stamped a `bonus-N`
  // value at a level with `perDay-N = 0`, it's a residual — the
  // bonus contributes 0 effective slots and shouldn't bump the
  // item-familiar's invested level either.
  function getHighestCastableLevel(className) {
    const target = String(className || "").trim().toLowerCase();
    if (!target) return null;
    let best = null;
    document.querySelectorAll("[data-caster-type='spellcasting']")
      .forEach(panel => {
        // Match against tab label OR notes textarea (case-insensitive
        // substring). Same matching logic as spells.js uses for the
        // per-class bonus-slot aggregation.
        const id = (panel.id || "").replace(/^caster-/, "");
        const tabBtn = document.querySelector(`.inner-tab[data-caster-idx="${id}"]`);
        const tabLabel = tabBtn ? tabBtn.textContent.replace("×","").trim().toLowerCase() : "";
        const notes = (panel.querySelector(".caster-notes")?.value || "").toLowerCase();
        if (!(tabLabel + " " + notes).includes(target)) return;
        // Walk levels 9..1, take the highest with a non-bonus slot.
        // Skip levels where only `bonus` is non-zero (the ability-
        // mod bonus is gated on base castability per PHB).
        for (let lvl = 9; lvl >= 1; lvl--) {
          const perDay = parseInt(panel.querySelector(`.sc-per-day[data-lvl="${lvl}"]`)?.value, 10) || 0;
          const domain = parseInt(panel.querySelector(`.sc-domain-slots[data-lvl="${lvl}"]`)?.value, 10) || 0;
          const spec = parseInt(panel.querySelector(`.sc-specialist-slots[data-lvl="${lvl}"]`)?.value, 10) || 0;
          if (perDay + domain + spec > 0) {
            if (best === null || lvl > best) best = lvl;
            break;
          }
        }
      });
    return best;
  }
  function specialAbilityRowHTML(idx, a) {
    const sel = a && a.ability ? a.ability : "";
    const notes = a && a.notes ? a.notes : "";
    return `
      <div class="ifam-special-row" data-row="${idx}"
           style="display:flex;gap:0.3rem;margin-bottom:0.25rem;align-items:center">
        <select class="ifam-special-sel" style="flex:1">
          <option value="">— pick ability —</option>
          ${SPECIAL_ABILITIES.map(ab => `<option value="${esc(ab)}"${sel === ab ? " selected" : ""}>${esc(ab)}</option>`).join("")}
        </select>
        <input type="text" class="ifam-special-notes" style="flex:1"
               placeholder="Specifics (e.g. spell stored, target)"
               value="${esc(notes)}">
        <button class="btn-remove ifam-remove-special" title="Remove">X</button>
      </div>`;
  }

  // -- Wire up event listeners on a built panel -----------------------
  function wirePanel(idx, panel, data) {
    if (!panel) return;
    // Skill-ranks rows: add / remove + recompute summary on edits.
    panel.querySelector(".ifam-add-skill-rank")?.addEventListener("click", () => {
      const tbody = panel.querySelector(".ifam-skill-ranks-list");
      const row = document.createElement("tr");
      row.className = "ifam-skill-rank-row";
      row.dataset.row = String(tbody.children.length);
      row.innerHTML = skillRankRowHTML(tbody.children.length, null)
        .replace(/<\/?tr[^>]*>/g, "");
      tbody.appendChild(row);
      recalc(panel);
    });
    panel.querySelector(".ifam-add-skill-bonus")?.addEventListener("click", () => {
      const tbody = panel.querySelector(".ifam-skill-bonus-list");
      const row = document.createElement("tr");
      row.className = "ifam-skill-bonus-row";
      row.dataset.row = String(tbody.children.length);
      row.innerHTML = skillBonusRowHTML(tbody.children.length, null)
        .replace(/<\/?tr[^>]*>/g, "");
      tbody.appendChild(row);
      recalc(panel);
    });
    panel.querySelector(".ifam-add-slot")?.addEventListener("click", () => {
      const tbody = panel.querySelector(".ifam-spell-slot-list");
      const row = document.createElement("tr");
      row.className = "ifam-slot-row";
      row.dataset.row = String(tbody.children.length);
      row.innerHTML = spellSlotRowHTML(tbody.children.length, null)
        .replace(/<\/?tr[^>]*>/g, "");
      tbody.appendChild(row);
      recalc(panel);
    });
    panel.querySelector(".ifam-add-special")?.addEventListener("click", () => {
      const list = panel.querySelector(".ifam-specials-list");
      const div = document.createElement("div");
      div.outerHTML = specialAbilityRowHTML(list.children.length, null);
      list.insertAdjacentHTML("beforeend", specialAbilityRowHTML(list.children.length, null));
      recalc(panel);
    });

    // Event delegation: remove buttons + input recomputes.
    panel.addEventListener("click", (e) => {
      const t = e.target;
      if (t.classList.contains("ifam-remove-rank")) {
        t.closest(".ifam-skill-rank-row")?.remove(); recalc(panel);
      } else if (t.classList.contains("ifam-remove-bonus")) {
        t.closest(".ifam-skill-bonus-row")?.remove(); recalc(panel);
      } else if (t.classList.contains("ifam-remove-slot")) {
        t.closest(".ifam-slot-row")?.remove(); recalc(panel);
      } else if (t.classList.contains("ifam-remove-special")) {
        t.closest(".ifam-special-row")?.remove(); recalc(panel);
      } else if (t.classList.contains("ifam-slot-auto")) {
        // ↻ re-sync: clear the manual override + auto-fill cookie so
        // recalc() writes the current detected highest castable level.
        const row = t.closest(".ifam-slot-row");
        const invInput = row?.querySelector(".ifam-slot-invested");
        if (invInput) {
          invInput.value = "";
          invInput.dataset.autoHighest = "";
        }
        recalc(panel);
        notifyItemFamiliarChanged();
      }
    });
    panel.addEventListener("input", (e) => {
      if (e.target.classList.contains("ifam-rank-count")
       || e.target.classList.contains("ifam-bonus-amt")
       || e.target.classList.contains("ifam-slot-invested")
       || e.target.classList.contains("ifam-slot-class")
       || e.target.classList.contains("ifam-sapience-int")
       || e.target.classList.contains("ifam-sapience-wis")
       || e.target.classList.contains("ifam-sapience-cha")
       || e.target.classList.contains("ifam-item-price")
       || e.target.classList.contains("ifam-item-weight")
       || e.target.classList.contains("ifam-life-invested")
       || e.target.classList.contains("ifam-lost")
       || e.target.classList.contains("ifam-carried")
       || e.target.classList.contains("ifam-sapience-unlocked")) {
        recalc(panel);
        // Cross-tab refreshes: skills.js + spells.js + character.js
        // need to know we changed.
        notifyItemFamiliarChanged();
        // Encumbrance: the weight, carried-status, and lost-status
        // toggles all affect the carry weight on the Equipment tab.
        if ((e.target.classList.contains("ifam-item-weight")
          || e.target.classList.contains("ifam-carried")
          || e.target.classList.contains("ifam-lost"))
          && typeof Equipment !== "undefined" && Equipment.recalcWeight) {
          Equipment.recalcWeight();
        }
      }
    });
    // First pass.
    recalc(panel);
  }

  // -- Recompute derived displays on a panel --------------------------
  function recalc(panel) {
    if (!panel) return;
    const masterLevel = getMasterLevel();

    // Skill-ranks summary: total ranks, total bonuses allowed.
    const ranksRows = panel.querySelectorAll(".ifam-skill-rank-row");
    let totalRanks = 0;
    ranksRows.forEach(r => {
      totalRanks += int(r.querySelector(".ifam-rank-count")?.value);
    });
    const maxBonuses = Math.floor(totalRanks / SKILL_BONUS_PER_RANKS);
    const bonusRows = panel.querySelectorAll(".ifam-skill-bonus-row");
    let totalBonusesApplied = 0;
    bonusRows.forEach(r => {
      totalBonusesApplied += int(r.querySelector(".ifam-bonus-amt")?.value);
    });
    const skillSummary = panel.querySelector(".ifam-skill-summary");
    if (skillSummary) {
      const over = totalBonusesApplied > maxBonuses;
      skillSummary.innerHTML =
        `${totalRanks} ranks invested → ` +
        `<b style="color:${over ? '#e88' : '#9d9'}">${totalBonusesApplied}</b>` +
        ` / ${maxBonuses} bonus${maxBonuses === 1 ? "" : "es"} applied`;
    }

    // Spell-slot rows: bonus-level computation (invested − 2) + UA
    // "highest castable" enforcement (auto-sync when invested is
    // blank or matches the previous auto-fill; warn otherwise so
    // the user can re-sync via the ↻ button if they want).
    panel.querySelectorAll(".ifam-slot-row").forEach(row => {
      const classInput = row.querySelector(".ifam-slot-class");
      const invInput = row.querySelector(".ifam-slot-invested");
      const bonusEl = row.querySelector(".ifam-slot-bonus");
      const warnEl = row.querySelector(".ifam-slot-warn");
      if (!invInput) return;

      const className = (classInput?.value || "").trim();
      const detectedHighest = className ? getHighestCastableLevel(className) : null;

      // Auto-sync behavior (same pattern as the spell-slots bonus
      // auto-fill in spells.js): if the user hasn't typed anything,
      // OR what they typed matches our last auto value, write the
      // current detected value. Any other state = manual override,
      // leave alone but warn.
      const currentInv = invInput.value;
      const lastAuto = invInput.dataset.autoHighest ?? "";
      if (detectedHighest !== null && (currentInv === "" || currentInv === lastAuto)) {
        invInput.value = String(detectedHighest);
        invInput.dataset.autoHighest = String(detectedHighest);
      } else if (detectedHighest !== null && lastAuto !== String(detectedHighest)) {
        // Detected value changed but the user has a manual override;
        // remember the new detected value so a future sync works.
        invInput.dataset.autoHighest = String(detectedHighest);
      }

      const inv = int(invInput.value);
      if (bonusEl) {
        bonusEl.textContent = inv >= 2 ? "Lvl " + (inv - 2) : "—";
      }

      // Warning: divergence from detected highest castable level.
      if (warnEl) {
        if (detectedHighest !== null && inv > 0 && inv !== detectedHighest) {
          warnEl.style.display = "";
          warnEl.textContent = `⚠ Should be Lvl ${detectedHighest} (highest castable per UA p.171).`;
        } else if (className && detectedHighest === null) {
          warnEl.style.display = "";
          warnEl.textContent = `⚠ No matching spellcasting panel for "${className}" — value not auto-synced.`;
        } else {
          warnEl.style.display = "none";
          warnEl.textContent = "";
        }
      }
    });
    const slotsSummary = panel.querySelector(".ifam-slots-summary");
    if (slotsSummary) {
      const n = panel.querySelectorAll(".ifam-slot-row").length;
      slotsSummary.textContent = n ? `${n} class${n === 1 ? "" : "es"} investing` : "";
    }

    // Ego score (DMG p.270 — rough approximation: avg(Int+Wis+Cha) − 10
    // for sapient items; the actual rules calculate from item powers
    // + alignment + intelligent-item status. For simplicity, surface a
    // base "intelligent-item-equivalent" Ego based on stat sum +
    // sapience flag).
    const intSc = int(panel.querySelector(".ifam-sapience-int")?.value) || 10;
    const wisSc = int(panel.querySelector(".ifam-sapience-wis")?.value) || 10;
    const chaSc = int(panel.querySelector(".ifam-sapience-cha")?.value) || 10;
    const sapUnlocked = panel.querySelector(".ifam-sapience-unlocked")?.checked;
    const egoEl = panel.querySelector(".ifam-ego");
    if (egoEl) {
      // Simple heuristic: (Int+Wis+Cha − 30) + (1 per special ability)
      const specialCount = panel.querySelectorAll(".ifam-special-row").length;
      const ego = sapUnlocked ? Math.max(0, (intSc + wisSc + chaSc - 30) + specialCount) : 0;
      egoEl.textContent = sapUnlocked ? String(ego) : "— (sapience not unlocked)";
    }

    // Special-ability slot count.
    const specialsCount = panel.querySelector(".ifam-specials-count");
    const specialsWarn = panel.querySelector(".ifam-specials-warning");
    if (specialsCount) {
      const avail = specialAbilitySlotsAvailable(masterLevel);
      const filled = panel.querySelectorAll(".ifam-special-row").length;
      specialsCount.textContent = `${filled} / ${avail} slot${avail === 1 ? "" : "s"} used`;
      if (specialsWarn) {
        if (filled > avail) {
          specialsWarn.style.display = "";
          specialsWarn.textContent = `⚠ ${filled - avail} special abilities over the master-level cap (${avail}).`;
        } else {
          specialsWarn.style.display = "none";
        }
      }
    }

    // Loss-penalty preview.
    const lossEl = panel.querySelector(".ifam-loss-penalty");
    if (lossEl) {
      const lost = panel.querySelector(".ifam-lost")?.checked;
      if (lost) {
        const lifeInv = panel.querySelector(".ifam-life-invested")?.checked;
        const base = 200 * Math.max(1, masterLevel);
        let label = `⚠ ${base} XP penalty`;
        if (lifeInv) label += " + all bonus XP from Life Energy";
        lossEl.style.color = "#e88";
        lossEl.textContent = label;
      } else {
        lossEl.textContent = "";
      }
    }

    // Life energy status text + soft-warn toggle. The warn surfaces
    // when master > L6 AND not invested; hides once the player ticks
    // the box (DM-permitted exception case) OR drops back to L≤6.
    const lifeCb = panel.querySelector(".ifam-life-invested");
    const lifeStatus = panel.querySelector(".ifam-life-status");
    const lifeWarn = panel.querySelector(".ifam-life-warn");
    const checked = !!lifeCb?.checked;
    if (lifeStatus) {
      lifeStatus.textContent = checked ? "✓ invested (+10% XP)" : "";
    }
    if (lifeWarn) {
      const showWarn = masterLevel > LIFE_ENERGY_MAX_LEVEL && !checked;
      lifeWarn.style.display = showWarn ? "" : "none";
    }
  }

  // -- collectData / loadData -----------------------------------------
  function collectData(panel) {
    if (!panel) return {};
    const skillRanksInItem = Array.from(panel.querySelectorAll(".ifam-skill-rank-row"))
      .map(r => ({
        skill: r.querySelector(".ifam-rank-skill")?.value || "",
        ranks: int(r.querySelector(".ifam-rank-count")?.value),
      }))
      .filter(x => x.skill && x.ranks > 0);
    const skillBonusesApplied = Array.from(panel.querySelectorAll(".ifam-skill-bonus-row"))
      .map(r => ({
        skill: r.querySelector(".ifam-bonus-skill")?.value || "",
        bonus: int(r.querySelector(".ifam-bonus-amt")?.value),
      }))
      .filter(x => x.skill && x.bonus > 0);
    const spellSlotsInvested = Array.from(panel.querySelectorAll(".ifam-slot-row"))
      .map(r => ({
        class: r.querySelector(".ifam-slot-class")?.value || "",
        invested: int(r.querySelector(".ifam-slot-invested")?.value),
      }))
      .filter(x => x.class && x.invested >= 2);
    const specialAbilities = Array.from(panel.querySelectorAll(".ifam-special-row"))
      .map(r => ({
        ability: r.querySelector(".ifam-special-sel")?.value || "",
        notes: r.querySelector(".ifam-special-notes")?.value || "",
      }))
      .filter(x => x.ability);
    return {
      compType: "item_familiar",
      compName: panel.querySelector(".comp-name")?.value || "",
      ifamItemName: panel.querySelector(".ifam-item-name")?.value || "",
      ifamItemPrice: int(panel.querySelector(".ifam-item-price")?.value),
      ifamItemWeight: parseFloat(panel.querySelector(".ifam-item-weight")?.value) || 0,
      ifamItemNotes: panel.querySelector(".ifam-item-notes")?.value || "",
      ifamAlignment: panel.querySelector(".ifam-alignment")?.value || "",
      ifamCarried: panel.querySelector(".ifam-carried")?.checked,
      ifamLost: panel.querySelector(".ifam-lost")?.checked,
      lifeEnergyInvested: panel.querySelector(".ifam-life-invested")?.checked || false,
      skillRanksInItem,
      skillBonusesApplied,
      spellSlotsInvested,
      sapienceUnlocked: panel.querySelector(".ifam-sapience-unlocked")?.checked || false,
      sapienceInt: int(panel.querySelector(".ifam-sapience-int")?.value),
      sapienceWis: int(panel.querySelector(".ifam-sapience-wis")?.value),
      sapienceCha: int(panel.querySelector(".ifam-sapience-cha")?.value),
      sapienceNotes: panel.querySelector(".ifam-sapience-notes")?.value || "",
      specialAbilities,
    };
  }

  function loadData(panel, data) {
    // Build path: re-render the panel HTML from data, then wire up.
    // The caller (companion.js) drives this; we expose it so the
    // delegated load path is symmetric.
    if (!panel || !data) return;
    panel.innerHTML = buildHTML(0, data);
    wirePanel(0, panel, data);
  }

  // -- Cross-tab notification: when an item-familiar value changes,
  // skills.js / spells.js / character.js should refresh.
  let _changeListeners = [];
  function onItemFamiliarChanged(cb) { _changeListeners.push(cb); }
  function notifyItemFamiliarChanged() {
    document.dispatchEvent(new CustomEvent("item-familiar-changed"));
    for (const cb of _changeListeners) {
      try { cb(); } catch (e) { /* swallow */ }
    }
  }

  // -- Aggregate getters for auto-apply hooks -------------------------
  // Walk every item-familiar panel in the document and aggregate.
  function getAllItemFamiliarPanels() {
    return document.querySelectorAll("[data-comp-type-active='item_familiar']");
  }

  // Map of {skillName(lower) → cumulative bonus} from carried,
  // non-lost item familiars. Lost / not-carried item familiars
  // contribute zero (per UA rules).
  function getAllSkillBonuses() {
    const out = {};
    getAllItemFamiliarPanels().forEach(panel => {
      if (!isPanelActive(panel)) return;
      panel.querySelectorAll(".ifam-skill-bonus-row").forEach(row => {
        const skill = (row.querySelector(".ifam-bonus-skill")?.value || "").trim();
        const bonus = int(row.querySelector(".ifam-bonus-amt")?.value);
        if (!skill || bonus <= 0) return;
        const key = skill.toLowerCase();
        out[key] = (out[key] || 0) + bonus;
      });
    });
    return out;
  }

  // List of {class, bonusLevel} bonus slots from carried, non-lost
  // item familiars. Each row contributes (invested-2) as the bonus
  // slot level. Optionally filter by class name.
  function getAllSpellSlotBonuses(className) {
    const out = [];
    const targetCls = className ? String(className).toLowerCase() : null;
    getAllItemFamiliarPanels().forEach(panel => {
      if (!isPanelActive(panel)) return;
      panel.querySelectorAll(".ifam-slot-row").forEach(row => {
        const cls = (row.querySelector(".ifam-slot-class")?.value || "").trim();
        const inv = int(row.querySelector(".ifam-slot-invested")?.value);
        if (!cls || inv < 2) return;
        const bonusLevel = inv - 2;
        if (targetCls && cls.toLowerCase() !== targetCls) return;
        out.push({ class: cls, bonusLevel });
      });
    });
    return out;
  }

  // Total weight from all item-familiar panels. Even a "lost" item
  // familiar contributes 0 weight (it's not on the character), so
  // the carried-vs-lost filter applies. Equipment.recalcWeight()
  // calls this and folds the total into encumbrance.
  function getTotalWeight() {
    let total = 0;
    getAllItemFamiliarPanels().forEach(panel => {
      const lost = panel.querySelector(".ifam-lost")?.checked === true;
      const carried = panel.querySelector(".ifam-carried")?.checked !== false;
      if (lost || !carried) return;
      const w = parseFloat(panel.querySelector(".ifam-item-weight")?.value) || 0;
      total += w;
    });
    return total;
  }

  // XP multiplier from item familiars with Life Energy invested.
  // Stacks multiplicatively if the character has multiple item
  // familiars with Life Energy (rare but possible per UA — though
  // generally a character only has one).
  function getXpMultiplier() {
    let mult = 1.0;
    getAllItemFamiliarPanels().forEach(panel => {
      if (!isPanelActive(panel)) return;
      const checked = panel.querySelector(".ifam-life-invested")?.checked;
      if (checked) mult *= 1.10;
    });
    return mult;
  }

  // A panel is "active" iff: carried AND not lost.
  function isPanelActive(panel) {
    if (!panel) return false;
    const carried = panel.querySelector(".ifam-carried")?.checked !== false;
    const lost = panel.querySelector(".ifam-lost")?.checked === true;
    return carried && !lost;
  }

  // -- Master-level reactivity ----------------------------------------
  // Sapience unlocks at L7, Special Abilities at L10/14/18, Life
  // Energy investment becomes locked out at L7+. The render gates
  // these from masterLevel at build time, so when the master levels
  // up we need to refresh the gates without blowing away the
  // panel's user-entered state. Walks every item-familiar panel and
  // toggles section visibility + the Life Energy disabled flag.
  function refreshAllPanelsForMasterLevel() {
    const masterLevel = getMasterLevel();
    const showSapience = masterLevel >= SAPIENCE_LEVEL;
    const slotsAvail = specialAbilitySlotsAvailable(masterLevel);
    const showSpecials = slotsAvail > 0;
    getAllItemFamiliarPanels().forEach(panel => {
      // Sapience section visibility.
      const sapSec = panel.querySelector(".ifam-card-sapience");
      if (sapSec) sapSec.style.display = showSapience ? "" : "none";
      // Special-abilities section visibility.
      const spcSec = panel.querySelector(".ifam-card-specials");
      if (spcSec) spcSec.style.display = showSpecials ? "" : "none";
      // Refresh derived displays (XP penalty, special-slot count,
      // Life-Energy warning visibility). recalc() reads master level
      // via getMasterLevel() so it picks up the new value too.
      recalc(panel);
    });
  }

  // Wire the master-level watcher once at module load. Triggers
  // whenever the #char-level field changes value.
  document.addEventListener("DOMContentLoaded", () => {
    const charLvlEl = document.getElementById("char-level");
    if (charLvlEl) {
      charLvlEl.addEventListener("input", refreshAllPanelsForMasterLevel);
      charLvlEl.addEventListener("change", refreshAllPanelsForMasterLevel);
    }
  });
  // Also subscribe to the global recalc trigger — class-picker /
  // build-timeline mutate char-level programmatically and may not
  // dispatch input events on it. Listen for the generic
  // classes-changed event.
  document.addEventListener("classes-changed", refreshAllPanelsForMasterLevel);

  // Spells-tab edits affect the "highest castable level" detection
  // for invested-slot rows. Watch the Spells tab and refresh slot
  // rows whenever its inputs change.
  document.addEventListener("input", (e) => {
    if (!e.target?.closest?.("#tab-spells")) return;
    // Only re-recalc the item-familiar panels (Spells-tab itself
    // doesn't need anything from us).
    getAllItemFamiliarPanels().forEach(p => recalc(p));
  });

  // -- Public API -----------------------------------------------------
  window.ItemFamiliar = {
    isItemFamiliarType,
    buildHTML,
    wirePanel,
    collectData,
    loadData,
    recalc,
    getAllSkillBonuses,
    getAllSpellSlotBonuses,
    getXpMultiplier,
    getTotalWeight,
    getHighestCastableLevel,
    onItemFamiliarChanged,
    notifyItemFamiliarChanged,
    // Surfaced rules constants — let tests verify.
    SAPIENCE_LEVEL,
    SPECIAL_ABILITY_LEVELS,
    LIFE_ENERGY_MAX_LEVEL,
    SKILL_BONUS_PER_RANKS,
    SPECIAL_ABILITIES,
    specialAbilitySlotsAvailable,
    refreshAllPanelsForMasterLevel,
  };
})();
