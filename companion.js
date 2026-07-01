// D&D 3.5 Character Sheet - Companion Tab Module

const Companion = (function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const int = (v) => parseInt(v) || 0;
  const abilMod = (score) => Math.floor((score - 10) / 2);

  let companionIndex = 0;
  let _mainGetAbilityMod = null;

  // ============================================================
  // Add a companion sub-tab
  // ============================================================
  function addCompanion(data = {}) {
    const idx = companionIndex++;
    const name = data.name || "Companion";

    const tabBar = $("#companion-tab-bar");
    const btn = document.createElement("button");
    btn.className = "inner-tab";
    btn.dataset.compIdx = idx;
    btn.textContent = name;
    btn.addEventListener("click", () => switchCompanion(idx));
    btn.addEventListener("dblclick", () => {
      const rm = btn.querySelector(".comp-tab-remove");
      const cur = btn.textContent.replace("×", "").trim();
      const nw = prompt("Rename companion:", cur);
      if (nw && nw.trim()) { btn.textContent = nw.trim(); btn.appendChild(rm); }
    });

    const rm = document.createElement("span");
    rm.className = "caster-tab-remove";
    rm.textContent = "×";
    rm.classList.add("comp-tab-remove");
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`Remove "${btn.textContent.replace("×", "").trim()}"?`)) {
        btn.remove();
        document.getElementById(`companion-${idx}`)?.remove();
        const first = tabBar.querySelector(".inner-tab");
        if (first) first.click();
      }
    });
    btn.appendChild(rm);
    tabBar.appendChild(btn);

    const container = $("#companion-content");
    const panel = document.createElement("div");
    panel.className = "inner-tab-content";
    panel.id = `companion-${idx}`;
    panel.innerHTML = buildCompanionHTML(idx, data);
    container.appendChild(panel);

    wireCompanion(idx, panel, data);
    switchCompanion(idx);
    return idx;
  }

  function switchCompanion(idx) {
    $$(".inner-tab[data-comp-idx]").forEach((t) => t.classList.remove("active"));
    $$("#companion-content > .inner-tab-content").forEach((c) => c.classList.remove("active"));
    const btn = $(`.inner-tab[data-comp-idx="${idx}"]`);
    const panel = $(`#companion-${idx}`);
    if (btn) btn.classList.add("active");
    if (panel) panel.classList.add("active");
  }

  // ============================================================
  // Build companion panel HTML
  // ============================================================
  function buildCompanionHTML(idx, d = {}) {
    // Item Familiar (UA pp.170-173): delegate to the item-familiar
    // module — entirely different layout (no creature stat block;
    // item identity + investment tables + sapience block instead).
    if (typeof ItemFamiliar !== "undefined"
        && ItemFamiliar.isItemFamiliarType(d.compType)) {
      return ItemFamiliar.buildHTML(idx, d);
    }
    const mods = ["STR","DEX","CON","INT","WIS","CHA"].map((ab) => {
      const sc = int(d[`comp-${ab.toLowerCase()}-score`]);
      const boost = d[`comp-${ab.toLowerCase()}-boost`] || "";
      return `<div class="field field-sm">
        <label>${ab}</label>
        <input type="number" class="comp-score" data-ab="${ab}" value="${d[`comp-${ab.toLowerCase()}-score`] || ""}">
        <input type="number" class="comp-ability-boost" data-ab="${ab}" min="0" max="5" value="${boost}"
               title="User-allocated ability boosts (every 4 HD over the base creature's HD — see HD summary).&#10;Folded into the displayed score by AUTO mode.">
        <span class="comp-mod calc-field" data-ab="${ab}">--</span>
      </div>`;
    }).join("");

    return `
    <div class="comp-header info-grid">
      <div class="field"><label>Name</label><input type="text" class="comp-name" value="${d.compName || ""}"></div>
      <div class="field"><label>Type</label><select class="comp-type">
        <option value="animal"${d.compType === "animal" ? " selected" : ""}>Animal Companion</option>
        <option value="familiar"${d.compType === "familiar" ? " selected" : ""}>Familiar</option>
        <option value="cohort"${d.compType === "cohort" ? " selected" : ""}>Cohort</option>
        <option value="psicrystal"${d.compType === "psicrystal" ? " selected" : ""}>Psicrystal</option>
        <option value="item_familiar"${d.compType === "item_familiar" ? " selected" : ""}>Item Familiar</option>
        <option value="other"${d.compType === "other" ? " selected" : ""}>Other</option>
      </select></div>
      <div class="field"><label>Size</label><select class="comp-size">
        ${["Fine","Diminutive","Tiny","Small","Medium","Large","Huge","Gargantuan","Colossal"]
          .map(s => `<option value="${s}"${(d.compSize || "Medium") === s ? " selected" : ""}>${s}</option>`)
          .join("")}
      </select></div>
      <label class="mi-toggle"><input type="checkbox" class="comp-familiar-toggle"${d.isFamiliar ? " checked" : ""}> Familiar</label>
    </div>
    <!-- Auto-computed progression panel (see companion.js
         refreshProgressionPanel). Hidden when no contributing
         classes are detected. Defaults expanded. -->
    <details class="comp-progression-panel" open>
      <summary class="comp-progression-summary">
        <span class="comp-progression-title">Class-Based Progression</span>
        <span class="comp-progression-status"></span>
      </summary>
      <div class="comp-progression-body"></div>
    </details>
    <!-- AUTO/MANUAL toggle + base-creature picker. AUTO derives
         abilities / speed / natural armor / Int from the base
         creature's stats + the progression deltas above. MANUAL
         leaves the panel's stat fields entirely free-entry. -->
    <div class="comp-mode-bar">
      <span class="comp-mode-radios">
        <label class="mi-toggle"><input type="radio" name="comp-mode-${idx}" class="comp-mode-radio" value="manual"${d.compMode === 'auto' ? '' : ' checked'}> Manual</label>
        <label class="mi-toggle"><input type="radio" name="comp-mode-${idx}" class="comp-mode-radio" value="auto"${d.compMode === 'auto' ? ' checked' : ''}> Auto-fill from base creature</label>
      </span>
      <span class="comp-base-creature-field" style="display:${d.compMode === 'auto' ? '' : 'none'}">
        <label class="comp-base-creature-label">Base creature
          <input type="text" class="comp-base-creature" list="creature-options"
                 placeholder="e.g. Wolf" value="${escapeHtml(d.compBaseCreature || '')}">
        </label>
        <label class="comp-template-label">Template (optional)
          <input type="text" class="comp-template" list="template-options"
                 placeholder="e.g. Telthor" value="${escapeHtml(d.compTemplate || '')}">
        </label>
        <span class="comp-template-warning" style="display:none;color:var(--accent);font-size:0.7rem;margin-left:0.5rem"></span>
      </span>
    </div>
    <div class="two-column">
      <div class="column">
        <h3>Ability Scores</h3>
        <div class="companion-abilities">${mods}</div>
        <h3>Hit Points</h3>
        <div class="info-grid">
          <div class="field field-sm"><label>Max HP</label><input type="number" class="comp-hp-max" value="${d.compHpMax || ""}"></div>
          <div class="field field-sm"><label>Current HP</label><input type="number" class="comp-hp-cur" value="${d.compHpCur || ""}"></div>
          <div class="field field-sm"><label>Speed</label><input type="text" class="comp-speed" value="${d.compSpeed || ""}"></div>
          <span class="comp-familiar-hp-note" style="display:none;font-size:0.7rem;color:var(--accent)">HP = ½ master's</span>
        </div>
        <h3>Initiative</h3>
        <div class="info-grid">
          <div class="field field-sm"><label>DEX Mod</label><span class="comp-init-dex calc-field">--</span></div>
          <div class="field field-sm"><label>Misc</label><input type="number" class="comp-init-misc" value="${d.compInitMisc || ""}"></div>
          <div class="field field-sm"><label>Total</label><span class="comp-init-total calc-field">--</span></div>
        </div>
        <h3>Armor Class</h3>
        <div class="info-grid">
          <div class="field field-sm"><label>Armor</label><input type="number" class="comp-ac-armor" value="${d.compAcArmor || ""}"></div>
          <div class="field field-sm"><label>Shield</label><input type="number" class="comp-ac-shield" value="${d.compAcShield || ""}"></div>
          <div class="field field-sm"><label>Natural</label><input type="number" class="comp-ac-natural" value="${d.compAcNatural || ""}"></div>
          <div class="field field-sm"><label>Size</label><input type="number" class="comp-ac-size" value="${d.compAcSize || ""}"></div>
          <div class="field field-sm"><label>Misc</label><input type="number" class="comp-ac-misc" value="${d.compAcMisc || ""}"></div>
        </div>
        <div class="info-grid">
          <div class="field field-sm"><label>AC Total</label><span class="comp-ac-total calc-field">--</span></div>
          <div class="field field-sm"><label>Touch</label><span class="comp-ac-touch calc-field">--</span></div>
          <div class="field field-sm"><label>Flat-Footed</label><span class="comp-ac-ff calc-field">--</span></div>
        </div>
        <h3>Saving Throws</h3>
        <div class="comp-saves">
          ${["Fort","Ref","Will"].map((s, si) => {
            const ab = ["CON","DEX","WIS"][si];
            return `<div class="save-row">
              <span class="save-label">${s}</span>
              <input type="number" class="comp-save-base" data-save="${s}" value="${d[`compSave${s}Base`] || ""}">
              <span class="comp-save-ab calc-field" data-save="${s}">+0</span>
              <input type="number" class="comp-save-misc" data-save="${s}" value="${d[`compSave${s}Misc`] || ""}">
              <span class="comp-save-total calc-field" data-save="${s}">--</span>
              <span class="comp-familiar-save" data-save="${s}" style="display:none;font-size:0.7rem;color:var(--accent)">↑ main</span>
            </div>`;
          }).join("")}
        </div>
        <h3>Grapple</h3>
        <div class="info-grid">
          <div class="field field-sm"><label>BAB</label><input type="number" class="comp-bab" value="${d.compBab || ""}"></div>
          <div class="field field-sm"><label>STR Mod</label><span class="comp-grapple-str calc-field">+0</span></div>
          <div class="field field-sm"><label>Size</label><input type="number" class="comp-grapple-size" value="${d.compGrappleSize || ""}"></div>
          <div class="field field-sm"><label>Misc</label><input type="number" class="comp-grapple-misc" value="${d.compGrappleMisc || ""}"></div>
          <div class="field field-sm"><label>Total</label><span class="comp-grapple-total calc-field">--</span></div>
        </div>
        <h3>Personality</h3>
        <textarea class="comp-personality" rows="2">${d.compPersonality || ""}</textarea>
        <h3>Notes</h3>
        <textarea class="comp-notes" rows="3">${d.compNotes || ""}</textarea>
      </div>
      <div class="column">
        <h3>Attacks</h3>
        <div class="comp-attacks-list"></div>
        <button class="btn-add comp-add-attack">+ Add Attack</button>
        <h3>Skills</h3>
        <div class="comp-skills-list"></div>
        <button class="btn-add comp-add-skill">+ Add Skill</button>
        <h3>Feats</h3>
        <div class="comp-feats-list"></div>
        <button class="btn-add comp-add-feat">+ Add Feat</button>
        <h3>Tricks</h3>
        <div class="comp-tricks-list"></div>
        <button class="btn-add comp-add-trick">+ Add Trick</button>
        <h3>Special Abilities</h3>
        <div class="comp-specials-list"></div>
        <button class="btn-add comp-add-special">+ Add Special Ability</button>
      </div>
    </div>`;
  }

  // ============================================================
  // Wire all interactions for a companion panel
  // ============================================================
  function wireCompanion(idx, panel, d = {}) {
    // Item Familiar (UA pp.170-173): completely different mechanic.
    // Delegate to the item-familiar module + tag the panel so
    // ItemFamiliar.getAllItemFamiliarPanels() can find it for the
    // auto-apply hooks.
    if (typeof ItemFamiliar !== "undefined"
        && ItemFamiliar.isItemFamiliarType(d.compType)) {
      panel.dataset.compTypeActive = "item_familiar";
      ItemFamiliar.wirePanel(idx, panel, d);
      // Wire the comp-type selector so toggling AWAY from item_familiar
      // triggers a panel re-render via the existing dispatch below.
      const compTypeSel = panel.querySelector(".comp-type");
      if (compTypeSel) {
        // CRITICAL: stamp userSet so the global `classes-changed`
        // listener (line ~1856) doesn't silently bump comp-type back
        // to the auto-default when classes are added / removed. The
        // user explicitly picked item_familiar; don't override.
        compTypeSel.dataset.userSet = "1";
        compTypeSel.addEventListener("change", (ev) => {
          if (compTypeSel.value !== "item_familiar") {
            // Re-render: swap to the creature-companion layout.
            // Read CURRENT panel state (life energy ticked, slot
            // invested, etc.) so any unsaved edits survive the swap
            // back if the user toggles to item_familiar later.
            const liveData = ItemFamiliar.collectData(panel);
            const newData = { ...d, ...liveData, compType: compTypeSel.value };
            panel.dataset.compTypeActive = "";
            panel.innerHTML = buildCompanionHTML(idx, newData);
            wireCompanion(idx, panel, newData);
          }
        });
      }
      return;
    }
    // For creature-style companions, mark the dataset too so the
    // active-type registry is consistent.
    panel.dataset.compTypeActive = d.compType || "animal";

    // Recalc on any input
    panel.addEventListener("input", () => recalcCompanion(panel));
    panel.addEventListener("change", () => recalcCompanion(panel));

    // H5: track user-driven comp-type changes so the
    // classes-changed listener doesn't overwrite their choice on a
    // later class apply. Only flips when the change is user-trusted
    // (event.isTrusted distinguishes from synthetic dispatches we
    // make ourselves during auto-default).
    const compTypeSel = panel.querySelector(".comp-type");
    if (compTypeSel) {
      compTypeSel.addEventListener("change", (ev) => {
        if (ev.isTrusted) compTypeSel.dataset.userSet = "1";
        // Item Familiar: swap to the dedicated layout when the value
        // changes to "item_familiar" (user-trusted OR programmatic —
        // the layout swap is idempotent + safe either way).
        if (compTypeSel.value === "item_familiar"
            && typeof ItemFamiliar !== "undefined") {
          // Preserve the user's tab name from the current creature-side
          // panel. Most other creature-only fields don't apply to item
          // familiars, but the name is the one piece of metadata that's
          // shared across both layouts.
          const liveName = panel.querySelector(".comp-name")?.value;
          const newData = {
            ...d,
            compType: "item_familiar",
            ...(liveName !== undefined ? { compName: liveName } : {}),
          };
          panel.innerHTML = buildCompanionHTML(idx, newData);
          wireCompanion(idx, panel, newData);
        }
      });
      // If we're loading an existing companion that had a non-default
      // type stored, treat that as user-set so we don't clobber it.
      if (d.compType && d.compType !== "animal") {
        compTypeSel.dataset.userSet = "1";
      }
      // Initial auto-default: only when no explicit type was loaded.
      if (!d.compType) {
        const auto = defaultCompTypeFromClasses();
        if (auto && compTypeSel.value !== auto) {
          compTypeSel.value = auto;
        }
      }
    }

    // Familiar toggle
    const famToggle = panel.querySelector(".comp-familiar-toggle");
    famToggle.addEventListener("change", () => {
      panel.querySelectorAll(".comp-familiar-save").forEach((el) => {
        el.style.display = famToggle.checked ? "" : "none";
      });
      recalcCompanion(panel);
    });
    if (d.isFamiliar) {
      panel.querySelectorAll(".comp-familiar-save").forEach((el) => { el.style.display = ""; });
    }

    // Dynamic attacks
    const atksContainer = panel.querySelector(".comp-attacks-list");
    panel.querySelector(".comp-add-attack").addEventListener("click", () => addAttackRow(atksContainer));
    (d.compAttacks || [{}]).forEach((a) => addAttackRow(atksContainer, a));

    // Dynamic skills
    const skillsContainer = panel.querySelector(".comp-skills-list");
    panel.querySelector(".comp-add-skill").addEventListener("click", () => addSkillRow(skillsContainer));
    (d.compSkills || []).forEach((s) => addSkillRow(skillsContainer, s));

    // Dynamic feats
    const featsContainer = panel.querySelector(".comp-feats-list");
    panel.querySelector(".comp-add-feat").addEventListener("click", () => addListRow(featsContainer, "comp-feat", "Feat name", "Notes"));
    (d.compFeats || [""]).forEach((f) => addListRow(featsContainer, "comp-feat", "Feat name", "Notes", f));

    // Dynamic tricks
    const tricksContainer = panel.querySelector(".comp-tricks-list");
    panel.querySelector(".comp-add-trick").addEventListener("click", () => addListRow(tricksContainer, "comp-trick", "Trick name", "Description"));
    (d.compTricks || [""]).forEach((t) => addListRow(tricksContainer, "comp-trick", "Trick name", "Description", t));

    // Dynamic special abilities (was a single textarea before 2026-05-16;
    // legacy data with `compSpecial` as a string gets migrated by load).
    const specialsContainer = panel.querySelector(".comp-specials-list");
    panel.querySelector(".comp-add-special").addEventListener("click",
      () => addListRow(specialsContainer, "comp-special", "Ability name", "Description"));
    let specialsSeed = d.compSpecials;
    if (!specialsSeed && d.compSpecial) {
      // Legacy single-string fallback — load as one row.
      specialsSeed = [{ name: "", notes: d.compSpecial }];
    }
    (specialsSeed || [""]).forEach((s) =>
      addListRow(specialsContainer, "comp-special", "Ability name", "Description", s));

    // ---- Mode toggle + base-creature auto-fill --------------------
    // AUTO mode reveals the base-creature input; toggling AUTO with a
    // valid base creature already selected triggers an immediate
    // auto-fill. MANUAL mode hides the base-creature input and
    // re-enables the stat fields for direct editing. Listener wired
    // here at panel-build time (idempotent — only one set per panel).
    const modeRadios = panel.querySelectorAll('.comp-mode-radio');
    const baseField = panel.querySelector('.comp-base-creature-field');
    const baseInput = panel.querySelector('.comp-base-creature');
    function currentMode() {
      const checked = panel.querySelector('.comp-mode-radio:checked');
      return checked ? checked.value : 'manual';
    }
    function syncModeUI() {
      const mode = currentMode();
      if (baseField) baseField.style.display = mode === 'auto' ? '' : 'none';
      applyAutoFillState(panel, mode);
    }
    modeRadios.forEach(r => r.addEventListener('change', () => {
      syncModeUI();
      if (currentMode() === 'auto') autoFillFromBaseCreature(panel);
    }));
    if (baseInput) {
      baseInput.addEventListener('input', () => {
        if (currentMode() === 'auto') autoFillFromBaseCreature(panel);
      });
      baseInput.addEventListener('change', () => {
        if (currentMode() === 'auto') autoFillFromBaseCreature(panel);
      });
    }
    // Template input — optional. AUTO mode applies the template's
    // deltas (ability changes, type/size override, NA bonus,
    // appended SAs/SQs, speed override) ON TOP of the base creature
    // before the existing companion-progression math runs.
    const tplInput = panel.querySelector('.comp-template');
    if (tplInput) {
      tplInput.addEventListener('input', () => {
        syncBaseCreatureDatalist(panel);
        if (currentMode() === 'auto') autoFillFromBaseCreature(panel);
      });
      tplInput.addEventListener('change', () => {
        syncBaseCreatureDatalist(panel);
        if (currentMode() === 'auto') autoFillFromBaseCreature(panel);
      });
    }
    // Initial sync — covers loadData round-trips that restore a
    // template name into the input. Deferred to a microtask so the
    // template-options datalist build (which depends on DB.ready)
    // has a chance to land before we try to swap into a typed one.
    Promise.resolve().then(() => syncBaseCreatureDatalist(panel));
    // Ability-boost inputs: user-owned in both modes, but in AUTO
    // mode a change needs to fold the new boost into the displayed
    // ability score. Single delegated listener on the panel covers
    // all 6 inputs without per-row wiring.
    panel.addEventListener('input', (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;
      if (!t.classList.contains('comp-ability-boost')) return;
      if (currentMode() === 'auto') autoFillFromBaseCreature(panel);
    });
    // Initial state on panel-build (matters for loadData round-trips).
    syncModeUI();
    if (currentMode() === 'auto' && baseInput?.value?.trim()) {
      autoFillFromBaseCreature(panel);
    }

    recalcCompanion(panel);
  }

  // ============================================================
  // Dynamic row helpers
  // ============================================================
  function addAttackRow(container, d = {}) {
    const div = document.createElement("div");
    div.className = "comp-attack-entry";
    div.innerHTML = `
      <input type="text" class="comp-atk-weapon" placeholder="Weapon/Natural" value="${d.weapon || ""}">
      <input type="text" class="comp-atk-bonus" placeholder="Attack Bonus" value="${d.bonus || ""}">
      <input type="text" class="comp-atk-damage" placeholder="Damage" value="${d.damage || ""}">
      <input type="text" class="comp-atk-crit" placeholder="Crit" value="${d.crit || ""}">
      <button class="btn-remove comp-remove-attack" title="Remove">X</button>`;
    div.querySelector(".comp-remove-attack").addEventListener("click", () => div.remove());
    container.appendChild(div);
  }

  function addSkillRow(container, d = {}) {
    const div = document.createElement("div");
    div.className = "comp-skill-row";
    div.innerHTML = `
      <input type="text" class="comp-skill-name" placeholder="Skill name" value="${d.name || ""}">
      <input type="number" class="comp-skill-ranks" placeholder="Ranks" value="${d.ranks || ""}">
      <input type="number" class="comp-skill-misc" placeholder="Misc" value="${d.misc || ""}">
      <span class="comp-skill-total calc-field">--</span>
      <button class="btn-remove" title="Remove">X</button>`;
    div.querySelector(".comp-skill-ranks, .comp-skill-misc") && div.addEventListener("input", () => {
      const total = int(div.querySelector(".comp-skill-ranks").value) + int(div.querySelector(".comp-skill-misc").value);
      div.querySelector(".comp-skill-total").textContent = total >= 0 ? "+" + total : total;
    });
    div.querySelector(".btn-remove").addEventListener("click", () => div.remove());
    container.appendChild(div);
    if (d.name || d.ranks) div.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function addListRow(container, cls, placeholder, notePlaceholder, data = "") {
    const d = typeof data === "object" ? data : { name: data };
    const div = document.createElement("div");
    div.className = `${cls}-entry feat-entry`;
    // Companion feat rows get the same autocomplete and ⓘ rules-toggle
    // wiring that the main Feats tab has — they share the feat-options
    // datalist built by feat-picker.js, and the ⓘ button calls
    // `Feats.renderFeatRules()` (exported from the Feats module).
    const isFeat = cls === "comp-feat";
    const listAttr = isFeat ? ` list="feat-options"` : "";
    const infoBtnHTML = isFeat
      ? `<button type="button" class="btn-feat-info" title="Show rules text" aria-expanded="false">ⓘ</button>`
      : "";
    div.innerHTML = `
      <div class="feat-main">
        <input type="text" class="${cls}-name" placeholder="${placeholder}" value="${d.name || ""}"${listAttr} autocomplete="off">
        ${infoBtnHTML}
        <button class="btn-remove" title="Remove">X</button>
      </div>
      <textarea class="${cls}-notes" rows="1" placeholder="${notePlaceholder}">${d.notes || ""}</textarea>`;
    div.querySelector(".btn-remove").addEventListener("click", () => div.remove());
    if (isFeat) {
      const info = div.querySelector(".btn-feat-info");
      const nameIn = div.querySelector(".comp-feat-name");
      info.addEventListener("click", () => toggleCompFeatRules(div));
      // Collapse panel on edit so stale text doesn't sit under a
      // renamed feat (same UX as the main feats tab).
      nameIn.addEventListener("input", () => collapseCompFeatRules(div));
    }
    container.appendChild(div);
  }

  function toggleCompFeatRules(row) {
    const existing = row.querySelector(".feat-rules");
    if (existing) { collapseCompFeatRules(row); return; }
    const name = (row.querySelector(".comp-feat-name")?.value || "").trim();
    const btn = row.querySelector(".btn-feat-info");
    const panel = document.createElement("div");
    panel.className = "feat-rules";
    if (!name) {
      panel.innerHTML = '<i style="opacity:.7">Type a feat name first.</i>';
    } else if (!(window.DB && DB.isLoaded()) ||
               typeof Feats?.renderFeatRules !== "function") {
      panel.innerHTML = '<i style="opacity:.7">Database not loaded — rules text unavailable.</i>';
    } else {
      const rendered = Feats.renderFeatRules(name);
      panel.innerHTML = rendered.html;
      if (rendered.entryId && window.ErrataBadge) {
        ErrataBadge.attach(panel, rendered.entryId);
      }
    }
    row.appendChild(panel);
    btn.setAttribute("aria-expanded", "true");
    btn.classList.add("active");
  }

  function collapseCompFeatRules(row) {
    const panel = row.querySelector(".feat-rules");
    if (panel) panel.remove();
    const btn = row.querySelector(".btn-feat-info");
    if (btn) {
      btn.setAttribute("aria-expanded", "false");
      btn.classList.remove("active");
    }
  }

  // ============================================================
  // Auto-calculate companion stats
  // ============================================================
  function recalcCompanion(panel) {
    const score = (ab) => int(panel.querySelector(`.comp-score[data-ab="${ab}"]`)?.value);
    const mod = (ab) => abilMod(score(ab));

    // Ability modifier display
    ["STR","DEX","CON","INT","WIS","CHA"].forEach((ab) => {
      const el = panel.querySelector(`.comp-mod[data-ab="${ab}"]`);
      if (el) { const m = mod(ab); el.textContent = (m >= 0 ? "+" : "") + m; }
    });

    // Initiative
    const dexMod = mod("DEX");
    const initMiscEl = panel.querySelector(".comp-init-misc");
    const initTotal = dexMod + int(initMiscEl?.value);
    const initDexEl = panel.querySelector(".comp-init-dex");
    if (initDexEl) initDexEl.textContent = (dexMod >= 0 ? "+" : "") + dexMod;
    const initTotalEl = panel.querySelector(".comp-init-total");
    if (initTotalEl) initTotalEl.textContent = (initTotal >= 0 ? "+" : "") + initTotal;

    // AC
    const armor = int(panel.querySelector(".comp-ac-armor")?.value);
    const shield = int(panel.querySelector(".comp-ac-shield")?.value);
    const natural = int(panel.querySelector(".comp-ac-natural")?.value);
    const acSize = int(panel.querySelector(".comp-ac-size")?.value);
    const acMisc = int(panel.querySelector(".comp-ac-misc")?.value);
    const acTotal = 10 + armor + shield + dexMod + natural + acSize + acMisc;
    const acTouch = 10 + dexMod + acSize + acMisc;
    const acFF = 10 + armor + shield + natural + acSize + acMisc;
    const setEl = (sel, val) => { const el = panel.querySelector(sel); if (el) el.textContent = val; };
    setEl(".comp-ac-total", acTotal);
    setEl(".comp-ac-touch", acTouch);
    setEl(".comp-ac-ff", acFF);

    // Saves
    const saveAbility = { Fort: "CON", Ref: "DEX", Will: "WIS" };
    const isFamiliar = panel.querySelector(".comp-familiar-toggle")?.checked;

    // Familiar: auto-set max HP to floor(master's max HP / 2)
    const hpNote = panel.querySelector(".comp-familiar-hp-note");
    if (hpNote) hpNote.style.display = isFamiliar ? "" : "none";
    if (isFamiliar) {
      const masterHp = int($("#hp-total")?.value);
      if (masterHp > 0) {
        panel.querySelector(".comp-hp-max").value = Math.floor(masterHp / 2);
      }
    }

    ["Fort","Ref","Will"].forEach((s) => {
      const ab = saveAbility[s];
      const abMod = mod(ab);
      const base = int(panel.querySelector(`.comp-save-base[data-save="${s}"]`)?.value);
      const misc = int(panel.querySelector(`.comp-save-misc[data-save="${s}"]`)?.value);
      const abEl = panel.querySelector(`.comp-save-ab[data-save="${s}"]`);
      if (abEl) abEl.textContent = (abMod >= 0 ? "+" : "") + abMod;

      let total = base + abMod + misc;
      // Familiar: use master's save if higher (PHB p.52)
      if (isFamiliar) {
        const mainSave = $(`#${s.toLowerCase()}-total`);
        const mainVal = mainSave ? int(mainSave.textContent) : null;
        if (mainVal !== null && mainVal > total) total = mainVal;
      }
      const totalEl = panel.querySelector(`.comp-save-total[data-save="${s}"]`);
      if (totalEl) totalEl.textContent = (total >= 0 ? "+" : "") + total;
    });

    // Grapple
    const strMod = mod("STR");
    const grappleStrEl = panel.querySelector(".comp-grapple-str");
    if (grappleStrEl) grappleStrEl.textContent = (strMod >= 0 ? "+" : "") + strMod;
    const bab = int(panel.querySelector(".comp-bab")?.value);
    const grappleSize = int(panel.querySelector(".comp-grapple-size")?.value);
    const grappleMisc = int(panel.querySelector(".comp-grapple-misc")?.value);
    const grapple = bab + strMod + grappleSize + grappleMisc;
    setEl(".comp-grapple-total", (grapple >= 0 ? "+" : "") + grapple);

    // Refresh the class-based progression panel.
    refreshProgressionPanel(panel);
  }

  // ============================================================
  // Class-based companion progression (Session 2 of #6 plan)
  // ============================================================
  //
  // Walks the character's applied classes (via ClassPicker.getState),
  // queries each class's class_features for `companion` metadata
  // populated by _companion_metadata.py, and aggregates contributions
  // by companion type. Renders into each companion's progression panel.

  // Returns { animal_companion: { effectiveLevel, contributions:[...],
  //                                negated, modifiers:[...] },
  //           familiar:         { ... },
  //           special_mount:    { ... },
  //           cohort:           { ... }      }
  // `contributions` is a list of { className, level, role, stacking,
  // effective } where `effective` is the level units this class
  // contributes to the type.
  function computeCompanionLevels() {
    const out = {
      animal_companion: { effectiveLevel: 0, contributions: [],
                          negated: false, modifiers: [], notes: [] },
      familiar:         { effectiveLevel: 0, contributions: [],
                          negated: false, modifiers: [], notes: [] },
      special_mount:    { effectiveLevel: 0, contributions: [],
                          negated: false, modifiers: [], notes: [] },
      cohort:           { effectiveLevel: 0, contributions: [],
                          negated: false, modifiers: [], notes: [] },
    };
    if (!window.ClassPicker || typeof ClassPicker.getState !== "function") {
      return out;
    }
    if (!window.DB || !DB.isLoaded()) return out;

    const picked = ClassPicker.getState();
    for (const p of picked) {
      const className = p.className;
      const classLevel = p.level;
      if (!className || !classLevel) continue;
      // Pull the class's features and look at each one's `companion`
      // block. A feature's role determines how this class contributes.
      const row = DB.queryOne(
        "SELECT json_extract(data, '$.class_features') AS cf " +
        "FROM entry WHERE type IN ('class','prc') " +
        "AND name = :n COLLATE NOCASE LIMIT 1",
        { ":n": className });
      if (!row || !row.cf) continue;
      let features;
      try { features = JSON.parse(row.cf); } catch { continue; }
      if (!Array.isArray(features)) continue;
      for (const f of features) {
        const c = f && f.companion;
        if (!c || !c.type || !out[c.type]) continue;
        // Filter by level — only count the feature if the class
        // level is at least the feature's level_acquired. Some
        // features have null/undefined level_acquired (PrCs that
        // grant the feature at L1); treat those as L1.
        const requiredLvl = f.level_acquired || 1;
        if (classLevel < requiredLvl) continue;

        const bucket = out[c.type];
        if (c.role === "negates") {
          bucket.negated = true;
          bucket.notes.push(`${className}: ${c.notes || 'negates ' + c.type}`);
          continue;
        }
        if (c.role === "modifies") {
          bucket.modifiers.push({
            className,
            modifier: c.modifier || c.notes || '(modifier)',
          });
          continue;
        }
        // role === 'grants' or 'advances' — compute effective levels.
        let effective = 0;
        const s = c.stacking;
        if (s === "full" || s === undefined) {
          effective = classLevel;
        } else if (s === "half") {
          effective = Math.floor(classLevel / 2);
        } else if (typeof s === "object" && s !== null) {
          if (typeof s.plus === "number") {
            effective = classLevel + s.plus;
          } else if (typeof s.minus === "number") {
            effective = Math.max(0, classLevel - s.minus);
          } else if (s.custom) {
            // Custom progressions can't be summed simply — flag the
            // class as contributing but mark the stacking as custom
            // so the UI can hint that the user should consult source.
            // Special case: 'extra-companions' (Beastmaster) grants
            // ADDITIONAL companions at reduced effective level — it
            // doesn't add to the primary companion's progression, so
            // we record it as a note but don't bump the aggregate.
            if (s.custom === 'extra-companions') {
              bucket.notes.push(
                `${className}: grants ADDITIONAL companions at ` +
                `reduced levels (L4: ${classLevel - 3}, L7: ${classLevel - 6}, ` +
                `L10: ${classLevel - 9}) — separate from the primary ` +
                `companion's advancement.`);
              continue;
            }
            effective = classLevel;
            bucket.notes.push(
              `${className}: custom progression (${s.custom}) — ` +
              `consult source for exact stat advancement.`);
          }
        }
        bucket.contributions.push({
          className,
          level: classLevel,
          role: c.role,
          stacking: s,
          effective,
          featureName: f.name,
        });
        bucket.effectiveLevel += effective;
        if (c.creature)            bucket.notes.push(`${className}: creature → ${c.creature}`);
        if (c.starting_creatures)  bucket.notes.push(
          // Semicolon separator — some entries contain commas
          // ("Horse, Light" / "Snake, Small Viper" etc.).
          `${className}: starting list → ${c.starting_creatures.join('; ')}`);
        if (c.creature_template)   bucket.notes.push(
          `${className}: template → ${c.creature_template}`);
      }
    }
    return out;
  }

  // Render the per-companion panel showing detected types, effective
  // levels, contributing classes, and the row from the progression
  // table at that level.
  function refreshProgressionPanel(panel) {
    const body = panel.querySelector(".comp-progression-body");
    const status = panel.querySelector(".comp-progression-status");
    const wrap = panel.querySelector(".comp-progression-panel");
    if (!body || !status || !wrap) return;
    const lvls = computeCompanionLevels();
    // Find the companion type most relevant to THIS panel (based on
    // the comp-type dropdown's serialization key — animal / familiar
    // / cohort / psicrystal / other). Maps to computeCompanionLevels
    // bucket key.
    const typeMap = {
      'animal':     'animal_companion',
      'familiar':   'familiar',
      'cohort':     'cohort',
      // No direct selector for special_mount today — Paladin special
      // mounts get used via Familiar/Animal Companion proxies; we
      // surface mount info under whichever type the player picks.
    };
    const selectedType = panel.querySelector(".comp-type")?.value || "";
    const matchType = typeMap[selectedType] || null;

    const sections = [];
    let anyContent = false;

    // Show the matched type prominently if any class contributes;
    // include the other types as a secondary list when they have
    // contributions too (multi-companion characters like Beastmaster
    // with multiple animals + a familiar from a multiclass).
    const TYPE_LABELS = {
      animal_companion: 'Animal Companion',
      familiar:         'Familiar',
      special_mount:    'Special Mount',
      cohort:           'Cohort',
    };
    // Order: matched type first, then any other types with
    // contributions / negations / modifiers.
    const allTypes = Object.keys(lvls);
    const orderedTypes = matchType
      ? [matchType, ...allTypes.filter(t => t !== matchType)]
      : allTypes;
    for (const type of orderedTypes) {
      const bucket = lvls[type];
      const hasAny = bucket.effectiveLevel > 0 ||
                     bucket.negated ||
                     bucket.modifiers.length > 0;
      if (!hasAny) continue;
      anyContent = true;
      sections.push(renderProgressionSection(type, bucket, TYPE_LABELS[type]));
    }

    if (!anyContent) {
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = '';
    body.innerHTML = sections.join('');
    // Status pill in the summary line.
    if (matchType && lvls[matchType].effectiveLevel > 0) {
      const eff = lvls[matchType].effectiveLevel;
      status.textContent = ` — effective ${TYPE_LABELS[matchType]} ` +
        `level ${eff}`;
    } else if (matchType && lvls[matchType].negated) {
      status.textContent = ` — ${TYPE_LABELS[matchType]} negated`;
    } else {
      status.textContent = '';
    }
  }

  function renderProgressionSection(type, bucket, label) {
    const lines = [];
    lines.push(`<div class="comp-prog-section">` +
               `<div class="comp-prog-section-head"><b>${escapeHtml(label)}</b>` +
               (bucket.negated
                 ? ` <span class="comp-prog-negated">negated</span>`
                 : bucket.effectiveLevel > 0
                   ? ` — effective master level <b>${bucket.effectiveLevel}</b>`
                   : '') + `</div>`);
    // Contributing classes.
    if (bucket.contributions.length) {
      const items = bucket.contributions.map(c => {
        const stackingLabel = c.stacking === 'full'    ? 'full'
                            : c.stacking === 'half'    ? 'half'
                            : c.stacking && c.stacking.plus  != null ? `+${c.stacking.plus}`
                            : c.stacking && c.stacking.minus != null ? `−${c.stacking.minus}`
                            : c.stacking && c.stacking.custom        ? `custom: ${c.stacking.custom}`
                            : '?';
        return `<li><b>${escapeHtml(c.className)}</b> L${c.level} ` +
               `(${stackingLabel}) → +${c.effective} effective levels ` +
               `<span class="comp-prog-feature">[${escapeHtml(c.featureName || '')}]</span></li>`;
      });
      lines.push(`<ul class="comp-prog-contributions">${items.join('')}</ul>`);
    }
    // Progression-table row at this effective level.
    // DND35 is a top-level `const` in data.js — bound in script scope
    // but NOT a `window` property. Use a `typeof` guard for cross-
    // module access; see the same trap fixed in feats.js / feat-picker
    // .js (2026-05-16 session notes).
    if (bucket.effectiveLevel > 0 && typeof DND35 !== 'undefined' &&
        typeof DND35.getCompanionProgression === 'function') {
      const row = DND35.getCompanionProgression(type, bucket.effectiveLevel);
      if (row) {
        const bits = [];
        if (row.bonusHD != null)    bits.push(`Bonus HD: +${row.bonusHD}`);
        if (row.naAdj != null)      bits.push(`NA Adj: +${row.naAdj}`);
        if (row.abilityAdj != null) bits.push(`Str/Dex Adj: +${row.abilityAdj}`);
        if (row.strAdj != null)     bits.push(`Str Adj: +${row.strAdj}`);
        if (row.intMin != null)     bits.push(`Min Int: ${row.intMin}`);
        if (row.bonusTricks != null) bits.push(`Bonus Tricks: ${row.bonusTricks}`);
        if (bits.length) {
          lines.push(`<div class="comp-prog-stats">` +
                     bits.map(escapeHtml).join(' &nbsp;·&nbsp; ') +
                     `</div>`);
        }
        if (row.specials && row.specials.length) {
          lines.push(`<div class="comp-prog-specials"><b>Specials at this level:</b> ` +
                     row.specials.map(escapeHtml).join(', ') + `</div>`);
        }
      } else if (type === 'special_mount' && bucket.effectiveLevel < 5) {
        lines.push(`<div class="comp-prog-stats" style="opacity:.7">` +
                   `Paladin special mount only manifests at effective ` +
                   `paladin level 5+ (currently ${bucket.effectiveLevel}).</div>`);
      }
    }
    // Notes + modifiers.
    for (const n of bucket.notes) {
      lines.push(`<div class="comp-prog-note">${escapeHtml(n)}</div>`);
    }
    for (const m of bucket.modifiers) {
      lines.push(`<div class="comp-prog-modifier"><b>${escapeHtml(m.className)}</b> ` +
                 `modifies: ${escapeHtml(m.modifier)}</div>`);
    }
    lines.push(`</div>`);
    return lines.join('');
  }

  // Global #creature-options datalist with every creature name in
  // the DB. Used by the base-creature autocomplete on each companion
  // panel. Built once at DB.ready; tiny (~1,200 names ≈ 30 KB).
  function buildGlobalCreatureDatalist() {
    if (document.getElementById('creature-options')) return;
    if (typeof DB === 'undefined' || !DB.isLoaded()) return;
    // 3.5-first dedup by case-insensitive name; same pattern as the
    // spell datalist build in spell-picker.js.
    const rows = DB.query(
      "SELECT e.name AS name FROM entry e " +
      "LEFT JOIN book b ON b.name = e.source " +
      "WHERE e.type = 'creature' AND e.name IS NOT NULL " +
      "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, " +
      "         b.publication_date DESC, " +
      "         e.name COLLATE NOCASE"
    );
    const seen = new Set();
    const dl = document.createElement('datalist');
    dl.id = 'creature-options';
    for (const r of rows) {
      const key = String(r.name || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const opt = document.createElement('option');
      opt.value = r.name;
      dl.appendChild(opt);
    }
    document.body.appendChild(dl);
    console.log(`[companion] built #creature-options datalist with ` +
      `${seen.size} unique creature names`);
  }

  // ---- Session C: build the global #template-options datalist -----
  //
  // Mirrors buildGlobalCreatureDatalist's shape. 3.5-first dedup by
  // case-insensitive name. The template input on every companion
  // panel references it via `list="template-options"`.

  function buildGlobalTemplateDatalist() {
    if (document.getElementById('template-options')) return;
    if (typeof DB === 'undefined' || !DB.isLoaded()) return;
    const rows = DB.query(
      "SELECT e.name AS name FROM entry e " +
      "LEFT JOIN book b ON b.name = e.source " +
      "WHERE e.type = 'template' AND e.name IS NOT NULL " +
      "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, " +
      "         b.publication_date DESC, " +
      "         e.name COLLATE NOCASE"
    );
    const seen = new Set();
    const dl = document.createElement('datalist');
    dl.id = 'template-options';
    for (const r of rows) {
      const key = String(r.name || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const opt = document.createElement('option');
      opt.value = r.name;
      dl.appendChild(opt);
    }
    document.body.appendChild(dl);
  }

  // ---- Session C: per-type datalists for template-restricted picking.
  //
  // Templates with a `source_creature_type` (Telthor → Fey; Anarchic
  // → Animal/Beast/Plant; Half-Dragon → corporeal creatures) only
  // canonically apply to bases of the right type. When such a
  // template is selected, the Base Creature input swaps to a
  // type-narrowed datalist so the autocomplete suggests *valid*
  // candidates first. The user can still type any name — the warning
  // span calls out non-canonical applications, but doesn't block.
  //
  // Per-type datalists are built lazily on first use and cached on
  // the document. Keys are normalized to the bare type root
  // ("Animal" out of "Animal (Aquatic)") so e.g. Anarchic on
  // Animal/Beast/Plant gets a single broader datalist rather than
  // three narrow ones.

  // Canonical D&D 3.5 creature types. Used by both the warning
  // tokenizer (in applyTemplateToCreature) and the autocomplete
  // narrowing path. "magical beast" / "monstrous humanoid" are
  // two-word types and must be matched BEFORE "beast" / "humanoid"
  // — order matters.
  const COMPANION_CANONICAL_TYPES = [
    'magical beast', 'monstrous humanoid',
    'aberration', 'animal', 'beast', 'construct', 'deathless',
    'dragon', 'elemental', 'fey', 'giant', 'humanoid',
    'ooze', 'outsider', 'plant', 'undead', 'vermin',
  ];

  // Pluck the LAST canonical type word out of a source_creature_type
  // string. The qualifier ("Any", "good", "evil", "corporeal",
  // "incorporeal") always comes first; the actual type word is at
  // the end. Falls back to the leading word when no canonical type
  // matches (e.g. odd prose strings).
  function _typeRoot(t) {
    if (!t) return null;
    const s = String(t).toLowerCase();
    for (const ct of COMPANION_CANONICAL_TYPES) {
      if (new RegExp(`\\b${ct}\\b`, 'i').test(s)) {
        // Capitalize to match creature_type column casing ("Fey", "Outsider").
        return ct.split(' ')
          .map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      }
    }
    // Last-ditch fallback: first word minus parenthetical.
    const first = String(t).replace(/\s*\(.*$/, '').trim();
    return first || null;
  }

  function buildTypedCreatureDatalist(typeRoot) {
    if (!typeRoot) return null;
    const dlId = `creature-options--${typeRoot.toLowerCase()}`;
    let dl = document.getElementById(dlId);
    if (dl) return dlId;
    if (typeof DB === 'undefined' || !DB.isLoaded()) return null;
    const rows = DB.query(
      "SELECT e.name AS name FROM entry e " +
      "LEFT JOIN book b ON b.name = e.source " +
      "WHERE e.type = 'creature' " +
      "AND e.creature_type IS NOT NULL " +
      "AND e.creature_type LIKE :pfx " +
      "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, " +
      "         b.publication_date DESC, " +
      "         e.name COLLATE NOCASE",
      { ':pfx': typeRoot + '%' });
    if (!rows || !rows.length) return null;
    const seen = new Set();
    dl = document.createElement('datalist');
    dl.id = dlId;
    for (const r of rows) {
      const key = String(r.name || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const opt = document.createElement('option');
      opt.value = r.name;
      dl.appendChild(opt);
    }
    document.body.appendChild(dl);
    return dlId;
  }

  // Look up the template's source_creature_type from the DB without
  // re-parsing the full blob. Cached per session so panel re-renders
  // don't re-hit DB for the same template.
  const _templateTypeCache = new Map();
  function getTemplateSourceType(templateName) {
    if (!templateName) return null;
    const key = templateName.toLowerCase();
    if (_templateTypeCache.has(key)) return _templateTypeCache.get(key);
    if (typeof DB === 'undefined' || !DB.isLoaded()) return null;
    const row = DB.queryOne(
      "SELECT json_extract(data, '$.source_creature_type') AS t " +
      "FROM entry WHERE type='template' AND name = :n " +
      "COLLATE NOCASE LIMIT 1", { ':n': templateName });
    const out = row && row.t ? String(row.t) : null;
    _templateTypeCache.set(key, out);
    return out;
  }

  // Swap the panel's Base Creature autocomplete datalist between the
  // global all-creatures list and a type-narrowed list, based on the
  // currently-selected template. Called on template input changes
  // AND on panel-build (so loadData round-trips re-narrow correctly).
  function syncBaseCreatureDatalist(panel) {
    const baseInput = panel.querySelector('.comp-base-creature');
    const tplName = panel.querySelector('.comp-template')?.value?.trim();
    if (!baseInput) return;
    if (!tplName) {
      baseInput.setAttribute('list', 'creature-options');
      return;
    }
    const srcType = getTemplateSourceType(tplName);
    const root = _typeRoot(srcType);
    if (!root) {
      baseInput.setAttribute('list', 'creature-options');
      return;
    }
    const dlId = buildTypedCreatureDatalist(root);
    baseInput.setAttribute('list', dlId || 'creature-options');
  }

  // ---- Session C: apply a template's deltas to a base-creature blob.
  //
  // Returns the SAME creature object when no template / unknown name /
  // DB not loaded — caller doesn't have to guard. For a recognized
  // template, returns a shallow-cloned creature with template effects
  // layered in:
  //   - abilities[*]    + parsed numeric mods from ability_changes
  //     (dict {Str:"+4"} OR free-text "Str +2, Con +4")
  //   - armor_class     + derived natural-armor bonus
  //     (via bonuses[bonus_type=natural_armor] or +N parsed from text)
  //   - type            ← cleaned `type_change` text (when present)
  //   - size            ← `size_change` (when "Same as base creature"
  //     leave alone; when "+1 size" / "Increase by one" not yet
  //     supported — pass through with a warning)
  //   - speed           ← `speed_change` (overrides whole string when
  //     the template gives one)
  //   - alignment       ← `alignment_change` (when present)
  //   - special_attacks / special_qualities — APPENDED to the
  //     existing strings (so the auto-populated SQs row still picks
  //     them up via parseCreatureSkills/Feats).
  //
  // Logs the chosen template into a per-panel warning span when
  // `source_creature_type` doesn't match the base creature's type
  // (e.g. Telthor → Fey-only on a Construct base) so the user knows
  // the apply is non-canonical.

  function applyTemplateToCreature(creature, templateName, panel) {
    // Always clear any prior warning — re-run is idempotent.
    const warnEl = panel?.querySelector('.comp-template-warning');
    if (warnEl) { warnEl.textContent = ''; warnEl.style.display = 'none'; }

    if (!templateName) return creature;
    if (typeof DB === 'undefined' || !DB.isLoaded()) return creature;

    const row = DB.queryOne(
      "SELECT data FROM entry WHERE name = :n COLLATE NOCASE " +
      "AND type = 'template' LIMIT 1", { ':n': templateName });
    if (!row || !row.data) return creature;
    let tpl;
    try { tpl = JSON.parse(row.data); } catch { return creature; }

    // Source-type compatibility hint (warn-only — don't block).
    //
    // `source_creature_type` is messy in the DB: sometimes a bare
    // type ("dragon", "fey"), sometimes a qualified phrase ("good
    // outsider", "Any humanoid"), sometimes verbose prose listing
    // every applicable type. To avoid spurious warnings on prose
    // strings, we tokenize both sides against the canonical
    // D&D 3.5 creature-type list and warn only when the template
    // names AT LEAST one type AND the creature's type doesn't
    // match ANY of those.
    if (warnEl && tpl.source_creature_type && creature.type) {
      const haveType = String(creature.type)
        .split(/[\s(,]/)[0].toLowerCase();   // "Animal" from "Animal (Aquatic)"
      const needText = String(tpl.source_creature_type).toLowerCase();
      const TYPES = ['aberration','animal','beast','construct','deathless',
                     'dragon','elemental','fey','giant','humanoid',
                     'magical beast','monstrous humanoid','ooze',
                     'outsider','plant','undead','vermin'];
      const named = TYPES.filter(t =>
        new RegExp(`\\b${t}\\b`, 'i').test(needText));
      const wildcard = /\bany\b.*\bcreature\b|\bany\s+living\b/i.test(needText);
      const ok = wildcard ||
                 named.length === 0 ||              // unparseable → don't warn
                 named.some(t => t === haveType ||
                                  haveType.includes(t.split(' ')[0]));
      if (!ok) {
        warnEl.textContent = `⚠ ${tpl.name || templateName} normally ` +
          `requires a ${tpl.source_creature_type} base creature ` +
          `(have ${creature.type}). Applying anyway — verify with DM.`;
        warnEl.style.display = '';
      }
    }

    // Deep-enough clone — abilities is the only nested struct we
    // mutate, so a shallow copy + abilities re-copy is sufficient.
    const out = { ...creature, abilities: { ...(creature.abilities || {}) } };

    // Ability changes — dict OR free-text.
    const acMods = parseTemplateAbilityChanges(tpl.ability_changes);
    for (const [ab, delta] of Object.entries(acMods)) {
      // Use Title-case ability key matching creature.abilities shape.
      const key = ab[0].toUpperCase() + ab.slice(1).toLowerCase();
      const cur = out.abilities[key];
      // "—" (em-dash) marks ability loss; convert to null/0.
      if (delta === null) {
        out.abilities[key] = null;
      } else if (typeof cur === 'number') {
        out.abilities[key] = cur + delta;
      }
    }

    // Natural armor from the template's STRUCTURED fields — the sheet reads
    // the field, it does NOT re-derive from prose (the DB project owns the
    // derivation; see its natural_armor_change / natural_armor_set canon):
    //   - natural_armor_change: additive DELTA ("improves by +4" — Half-
    //     Dragon +4, Gelatinous −2).
    //   - natural_armor_set: use-higher OVERLAP value — the result is
    //     max(setValue, base NA) (Lich +5, Mummified +8/+10, Wight +4,
    //     Death Knight +5, ...). Mutually exclusive with the delta.
    // Recover the base NA from the field, else from the AC text (old blobs).
    // Write BOTH the authoritative `natural_armor` integer (what
    // autoFillFromBaseCreature reads) and the `armor_class` text (kept in
    // sync for display / any legacy reader) to the new ABSOLUTE total.
    const baseFieldNa = (typeof out.natural_armor === 'number')
      ? out.natural_armor
      : (() => {
          const m = String(out.armor_class || '').match(/([+\-]?\d+)\s*natural/i);
          return m ? parseInt(m[1], 10) : 0;
        })();
    let newNa = null;
    if (typeof tpl.natural_armor_change === 'number') {
      newNa = baseFieldNa + tpl.natural_armor_change;
    } else if (typeof tpl.natural_armor_set === 'number') {
      newNa = Math.max(baseFieldNa, tpl.natural_armor_set);
    }
    if (newNa !== null) {
      out.natural_armor = newNa;
      if (typeof out.armor_class === 'string') {
        out.armor_class = setAcNaturalToken(out.armor_class, newNa);
      }
    }

    // Type, size, speed, alignment overrides.
    if (tpl.type_change) {
      const cleaned = cleanTemplateTypeChange(tpl.type_change);
      if (cleaned) out.type = cleaned;
    }
    if (tpl.size_change && typeof tpl.size_change === 'string') {
      const m = tpl.size_change.match(
        /\b(Fine|Diminutive|Tiny|Small|Medium|Large|Huge|Gargantuan|Colossal)\b/i);
      if (m) out.size = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    }
    if (tpl.speed_change && typeof tpl.speed_change === 'string' &&
        !/same\s+as\s+(?:base|the)/i.test(tpl.speed_change)) {
      out.speed = tpl.speed_change;
    }
    if (tpl.alignment_change) {
      out.alignment = tpl.alignment_change;
    }

    // SA / SQ concatenation. Each *_added is a list of either
    // strings ("Name: description") or {name, description} objects.
    out.special_attacks   = appendTraits(out.special_attacks,
                                         tpl.special_attacks_added);
    out.special_qualities = appendTraits(out.special_qualities,
                                         tpl.special_qualities_added);

    return out;
  }

  // Parse `ability_changes` (dict or free-text) → {Str: +N, Con: -N, ...}
  // Em-dash / "—" maps to null (ability loss).
  function parseTemplateAbilityChanges(raw) {
    const out = {};
    if (!raw) return out;
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        if (v === '—' || v === '-' || v == null) { out[k] = null; continue; }
        const n = parseInt(String(v).replace(/^\+/, ''), 10);
        if (Number.isFinite(n) && n !== 0) out[k] = n;
      }
      return out;
    }
    if (typeof raw === 'string') {
      // Match "Str +4", "Con -2", "Int —". The "—" / "no Strength" /
      // "Intelligence is at least N" prose hits are ignored (warn-
      // only — we don't model "ability set to N" overrides).
      const rx = /\b(Str|Dex|Con|Int|Wis|Cha)\b\s*([+\-—]\d+|—)/gi;
      let m;
      while ((m = rx.exec(raw)) !== null) {
        const ab = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
        const tok = m[2];
        if (tok === '—') { out[ab] = null; continue; }
        const n = parseInt(tok, 10);
        if (Number.isFinite(n) && n !== 0) out[ab] = n;
      }
      return out;
    }
    return out;
  }

  // Rewrite a base creature's free-text `armor_class` so its "+N natural"
  // token reflects the new ABSOLUTE natural-armor total after a template's
  // change/set has been applied to the structured field. (Kept in sync for
  // display + any legacy text reader; autoFillFromBaseCreature itself reads
  // the structured `natural_armor` field, not this token.) Appends a token
  // when the base string carries none.
  function setAcNaturalToken(acText, na) {
    const m = acText.match(/([+\-]?\d+)\s*natural/i);
    if (m) {
      return acText.replace(m[0], `+${na} natural`);
    }
    // No existing natural token — append. Best-effort: drop into the
    // first " (...)" block, or just suffix.
    if (acText.includes('(')) {
      return acText.replace(/\(([^)]+)\)/,
        (_, inner) => `(${inner}, +${na} natural)`);
    }
    return acText + ` (+${na} natural)`;
  }

  // Reduce a verbose `type_change` like "Type changes to outsider
  // (native, lawful, evil)" or "Augmented humanoid" to a clean type
  // string. Falls back to the raw input when no pattern fires.
  function cleanTemplateTypeChange(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const s = raw.trim();
    let m = s.match(/^Augmented\s+\(([^)]+)\)/i);
    if (m) return `Augmented (${m[1]})`;
    m = s.match(/type\s+changes?\s+to\s+([A-Za-z]+(?:\s*\([^)]+\))?)/i);
    if (m) return m[1];
    m = s.match(/^([A-Z][a-z]+(?:\s*\([^)]+\))?)/);
    if (m) return m[1];
    return null;
  }

  // Append a list of trait records (strings or {name, description})
  // to an existing free-text SA/SQ string. Used for both
  // special_attacks_added and special_qualities_added.
  function appendTraits(existing, added) {
    if (!Array.isArray(added) || !added.length) return existing;
    const parts = [];
    for (const raw of added) {
      if (typeof raw === 'string') {
        // Strings often arrive as "Name: long description". Take
        // just the name + first-clause for the summary line.
        const idx = raw.indexOf(':');
        const name = (idx > 0 ? raw.slice(0, idx) : raw).trim();
        if (name) parts.push(name);
      } else if (raw && typeof raw === 'object' && raw.name) {
        parts.push(String(raw.name).trim());
      }
    }
    if (!parts.length) return existing;
    const addedText = parts.join(', ');
    if (!existing || existing === '—') return addedText;
    return `${existing}, ${addedText}`;
  }

  // ---- AUTO mode: fill stat fields from base creature + progression ----
  //
  // Looks up the base creature in the DB, extracts its abilities /
  // speed / natural armor, applies the progression deltas (bonus HD,
  // NA Adj, Str/Dex Adj, Int floor), and fills the panel's stat
  // fields. Fields filled this way carry data-from-auto so the
  // applyAutoFillState toggle can manage disabled state, and so
  // future switches between AUTO and MANUAL leave manual edits alone
  // when the user types over them.

  function autoFillFromBaseCreature(panel) {
    if (typeof DB === 'undefined' || !DB.isLoaded()) return;
    const baseName = panel.querySelector('.comp-base-creature')?.value?.trim();
    if (!baseName) return;
    const row = DB.queryOne(
      "SELECT data FROM entry WHERE name = :n COLLATE NOCASE " +
      "AND type = 'creature' LIMIT 1", { ':n': baseName });
    if (!row || !row.data) return;
    let creature;
    try { creature = JSON.parse(row.data); } catch { return; }

    // Session C: apply optional template on top of the base creature
    // BEFORE the progression math runs. `applyTemplateToCreature`
    // returns a new blob with template effects layered in (ability
    // changes, type / size / speed overrides, NA bonus from
    // bonuses[] or armor_class text, SAs / SQs concatenated). Empty
    // / unknown template name = no-op. Mismatched base type (e.g.
    // Telthor on a Construct) flashes a hint in the warning span;
    // we still apply, since DMs may rule otherwise.
    const tplName = panel.querySelector('.comp-template')?.value?.trim();
    creature = applyTemplateToCreature(creature, tplName, panel);

    // Compute the active progression row for this panel's selected
    // companion type (key vocabulary: animal / familiar / cohort).
    const lvls = computeCompanionLevels();
    const typeMap = {
      'animal':   'animal_companion',
      'familiar': 'familiar',
      'cohort':   'cohort',
    };
    const selType = panel.querySelector('.comp-type')?.value || '';
    const matchType = typeMap[selType] || null;
    let prog = null;
    let effectiveLevel = 0;
    if (matchType && lvls[matchType] && lvls[matchType].effectiveLevel > 0) {
      effectiveLevel = lvls[matchType].effectiveLevel;
      if (typeof DND35 !== 'undefined' &&
          typeof DND35.getCompanionProgression === 'function') {
        prog = DND35.getCompanionProgression(matchType, effectiveLevel);
      }
    }

    // Compute final stats.
    const base = creature.abilities || {};
    const abilityAdj = (prog && prog.abilityAdj) || 0;  // animal: str+dex
    const strAdj = (prog && prog.strAdj) || 0;          // mount: str
    const naAdj = (prog && prog.naAdj) || 0;
    const intMin = (prog && prog.intMin) || 0;

    // For animal companions, the progression bumps BOTH Str and Dex.
    // For mounts, only Str (via strAdj). Familiars get an Int floor
    // but no ability bumps. Apply accordingly.
    const stats = {
      STR: (base.Str || 0) + (matchType === 'animal_companion' ? abilityAdj : strAdj),
      DEX: (base.Dex || 0) + (matchType === 'animal_companion' ? abilityAdj : 0),
      CON: base.Con || 0,
      INT: Math.max(base.Int || 0, intMin),
      WIS: base.Wis || 0,
      CHA: base.Cha || 0,
    };

    // Natural armor: prefer the structured `natural_armor` integer (the DB
    // carries it on 1648 creatures; verified to agree with the armor_class
    // text token on all 1645 where both exist, and to recover NA on a few
    // where the text lacks a "+N natural" token). Fall back to parsing the
    // free-text armor_class string ("14 (+2 Dex, +2 natural), …" → baseNA=2)
    // for any blob without the field. Template NA is already folded into the
    // field by applyTemplateToCreature above. Default 0 when neither present.
    const acText = String(creature.armor_class || '');
    const naMatch = acText.match(/([+\-]?\d+)\s*natural/i);
    const baseNA = (typeof creature.natural_armor === 'number')
      ? creature.natural_armor
      : (naMatch ? parseInt(naMatch[1], 10) : 0);

    // Size escalation MUST be determined BEFORE we write ability
    // scores / natural armor, because crossing a size band applies
    // MM Table 4-2 deltas to Str / Dex / Con / NA on top of the
    // companion-progression adjustments. computeEscalatedSize
    // returns null when there's no escalation (size stays at base);
    // we then apply the cumulative size delta into `stats` + naAdj
    // before any DOM writes.
    const baseSize = creature.size || 'Medium';
    const escalatedSize = computeEscalatedSize(creature, prog) || baseSize;
    if (typeof DND35.cumulativeSizeDelta === 'function' &&
        escalatedSize !== baseSize) {
      const delta = DND35.cumulativeSizeDelta(baseSize, escalatedSize);
      if (delta) {
        stats.STR += delta.str;
        stats.DEX += delta.dex;
        stats.CON += delta.con;
        // Bumped NA folded into the writeable value below.
        stats._sizeNaDelta = delta.na;
      }
    }

    // User-allocated ability boosts (every 4 total HD over the base
    // creature's HD — see HD summary's "earned vs allocated" line).
    // These are user-owned inputs that AUTO mode READS but never
    // overwrites. Fold them into the stats before writing the final
    // displayed ability scores.
    for (const ab of ['STR','DEX','CON','INT','WIS','CHA']) {
      const boostEl = panel.querySelector(
        `.comp-ability-boost[data-ab="${ab}"]`);
      const boost = int(boostEl?.value) || 0;
      stats[ab] += boost;
    }

    // Apply to the panel's fields. Each is marked data-from-auto so
    // applyAutoFillState can grey them out in AUTO mode.
    const setAuto = (sel, val) => {
      const el = panel.querySelector(sel);
      if (!el) return;
      el.value = String(val);
      el.dataset.fromAuto = '1';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    for (const ab of ['STR','DEX','CON','INT','WIS','CHA']) {
      setAuto(`.comp-score[data-ab="${ab}"]`, stats[ab]);
    }
    if (creature.speed) {
      setAuto('.comp-speed', String(creature.speed));
    }
    setAuto('.comp-ac-natural', baseNA + naAdj + (stats._sizeNaDelta || 0));
    // Write the chosen size + mark from-auto (separate helper because
    // it's just a select.value set, no delta math here).
    writeEscalatedSize(panel, escalatedSize);

    // HD-derived BAB / saves / skill points / feat count. Bonus HD
    // from the progression table stack onto the creature's base HD;
    // the creature type's BAB and good-saves rules recompute against
    // the new total.
    autoFillHDDerivedStats(panel, creature, matchType, prog, stats.INT);
    // Auto-populate skill + feat rows from the creature's free-text
    // statblock fields. Idempotent: removes previous auto-marked
    // rows before adding new ones so re-running AUTO doesn't stack.
    autoFillSkillRows(panel, creature);
    autoFillFeatRows(panel, creature);

    // Re-apply disabled state (since setAuto cleared / set values
    // but the toggle handler runs only on radio change).
    applyAutoFillState(panel, 'auto');
  }

  // Pure-computation companion to autoFillSize — figures out which
  // size band the creature lands in at total HD without touching the
  // DOM. Returns null if the creature has no parseable advancement
  // (size stays at base).
  function computeEscalatedSize(creature, prog) {
    if (typeof DND35 === 'undefined' ||
        typeof DND35.parseCreatureAdvancement !== 'function') return null;
    const baseHD = DND35.parseHitDieCount(creature.hit_dice) || 0;
    const bonusHD = (prog && prog.bonusHD) || 0;
    const totalHD = baseHD + bonusHD;
    if (totalHD <= 0) return null;
    const bands = DND35.parseCreatureAdvancement(creature.advancement);
    if (!bands) return null;
    return DND35.advancementSizeAtHD(bands, totalHD);
  }

  // Compute total HD = base HD + bonus HD, then derive BAB / saves /
  // skill-point budget / feat-count from the creature type. Familiars
  // skip the BAB/save recompute because RAW has them inherit the
  // master's BAB and use the better of (their own, master's) for
  // saves — needs the master's character stats to compute meaningfully,
  // so deferred until a future pass.
  function autoFillHDDerivedStats(panel, creature, matchType, prog, intTotal) {
    // DND35 is a top-level const, not a window property — must use
    // typeof guard rather than property access (which would always
    // be undefined and skip the function silently). See
    // tests/test_pickers.js audit guard for the rationale.
    if (typeof DND35 === 'undefined' ||
        typeof DND35.parseCreatureType !== 'function') return;
    const type = DND35.parseCreatureType(creature.creature_type || creature.type);
    if (!type) {
      // Unknown / unrecognized creature type — skip silently and let
      // the player fill BAB/saves manually. Most unrecognized types
      // are exotic (e.g. "unique celestial paragon"). Leaving them
      // unfilled is safer than computing wrong numbers.
      clearHDSummary(panel);
      return;
    }
    const baseHD = DND35.parseHitDieCount(creature.hit_dice) || 0;
    const bonusHD = (prog && prog.bonusHD) || 0;
    const totalHD = baseHD + bonusHD;
    if (totalHD < 1) { clearHDSummary(panel); return; }

    const setAuto = (sel, val) => {
      const el = panel.querySelector(sel);
      if (!el) return;
      el.value = String(val);
      el.dataset.fromAuto = '1';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };

    // Familiars: per PHB p.52 ("A familiar uses its master's base
    // attack bonus and base save bonuses, but receives no other
    // attack bonuses other than those it would normally gain.")
    // and "It uses its own ability modifiers to saves. Note that the
    // familiar uses its own base save bonuses if they are higher."
    //
    // So:
    //   BAB = master's BAB (unconditional)
    //   Save = max(master's base save, familiar's natural base save)
    if (matchType === 'familiar') {
      const masterBab = parseInt(
        document.getElementById('bab-1')?.value, 10) || 0;
      const masterSaves = {
        Fort: parseInt(document.getElementById('fort-base')?.value, 10) || 0,
        Ref:  parseInt(document.getElementById('ref-base')?.value, 10) || 0,
        Will: parseInt(document.getElementById('will-base')?.value, 10) || 0,
      };
      setAuto('.comp-bab', masterBab);
      for (const which of ['Fort', 'Ref', 'Will']) {
        const natural = DND35.creatureSaveAtHD(type, totalHD, which);
        const best = Math.max(natural, masterSaves[which]);
        setAuto(`.comp-save-base[data-save="${which}"]`, best);
      }
      const intMod = Math.floor((intTotal - 10) / 2);
      const skillPts = DND35.creatureSkillPoints(type, totalHD, intMod);
      const featCount = DND35.creatureFeatCount(totalHD);
      renderHDSummary(panel, {
        type, baseHD, bonusHD, totalHD,
        bab: masterBab, intMod, skillPts, featCount,
        boostsEarned: DND35.creatureAbilityBoostsEarned(baseHD, totalHD),
        boostsAllocated: countAllocatedBoosts(panel),
        familiarNote: `BAB inherited from master (+${masterBab}); ` +
          `saves use max(familiar natural, master's base).`,
      });
      return;
    }

    // Animal companion / special mount / generic creature: recompute
    // from total HD using the type's progression.
    const bab = DND35.creatureBABAtHD(type, totalHD);
    setAuto('.comp-bab', bab);
    for (const which of ['Fort', 'Ref', 'Will']) {
      const save = DND35.creatureSaveAtHD(type, totalHD, which);
      setAuto(`.comp-save-base[data-save="${which}"]`, save);
    }

    const intMod = Math.floor((intTotal - 10) / 2);
    const skillPts = DND35.creatureSkillPoints(type, totalHD, intMod);
    const featCount = DND35.creatureFeatCount(totalHD);
    renderHDSummary(panel, {
      type, baseHD, bonusHD, totalHD, bab, intMod, skillPts, featCount,
      boostsEarned: DND35.creatureAbilityBoostsEarned(baseHD, totalHD),
      boostsAllocated: countAllocatedBoosts(panel),
    });
  }

  function countAllocatedBoosts(panel) {
    let total = 0;
    for (const el of panel.querySelectorAll('.comp-ability-boost')) {
      total += parseInt(el.value, 10) || 0;
    }
    return total;
  }

  // Render (or clear) the HD-derived summary line above the Skills /
  // Feats columns. Gives the player a one-line breakdown of the
  // computed total HD + skill-point budget + bonus-feat count so they
  // know how many rows to fill in.
  function renderHDSummary(panel, info) {
    let el = panel.querySelector('.comp-hd-summary');
    if (!el) {
      // Inject above the AUTO mode bar so it sits with the other
      // computed info.
      const modeBar = panel.querySelector('.comp-mode-bar');
      if (!modeBar) return;
      el = document.createElement('div');
      el.className = 'comp-hd-summary';
      modeBar.parentElement.insertBefore(el, modeBar.nextSibling);
    }
    const bits = [];
    bits.push(`<b>HD:</b> ${info.totalHD} ` +
      `<span style="opacity:.7">(${info.baseHD} base${info.bonusHD ? ` + ${info.bonusHD} bonus` : ''})</span>`);
    bits.push(`<b>Type:</b> ${info.type}`);
    if (info.bab != null) bits.push(`<b>BAB:</b> +${info.bab}`);
    if (info.skillPts != null) bits.push(`<b>Skill points:</b> ${info.skillPts} (INT mod ${info.intMod >= 0 ? '+' : ''}${info.intMod})`);
    if (info.featCount != null) bits.push(`<b>Feats:</b> ${info.featCount}`);
    // Ability boosts: earned over the base creature's HD (every 4
    // total HD past the base's). Color the count gold when there are
    // unallocated boosts, red when over-allocated, default otherwise.
    if (info.boostsEarned != null) {
      const alloc = info.boostsAllocated || 0;
      const earned = info.boostsEarned;
      let cls = '';
      if (alloc < earned) cls = 'comp-hd-boost-under';
      else if (alloc > earned) cls = 'comp-hd-boost-over';
      bits.push(`<b>Ability boosts:</b> ` +
        `<span class="${cls}">${earned} earned / ${alloc} allocated</span>`);
    }
    el.innerHTML = bits.join(' &nbsp;·&nbsp; ');
    if (typeof info.familiarNote === 'string') {
      el.innerHTML += `<div style="margin-top:0.3rem;color:#aaa;font-style:italic">` +
        escapeHtml(info.familiarNote) + '</div>';
    }
    el.style.display = '';
  }

  function clearHDSummary(panel) {
    const el = panel.querySelector('.comp-hd-summary');
    if (el) { el.innerHTML = ''; el.style.display = 'none'; }
  }

  // Auto-populate the companion's skill list from the creature's
  // free-text `skills` field. Statblock modifiers (e.g. "Hide +3")
  // land in the row's "Misc" field; the user can split into Ranks +
  // ability mod later if they want fidelity. Re-running AUTO clears
  // previous auto rows so the list doesn't stack.
  //
  // Note: the displayed modifier IS the creature's TOTAL bonus from
  // the statblock — it already includes ability mods + racial
  // bonuses + skill ranks. We dump it into Misc verbatim so the
  // computed Total stays correct without parsing the breakdown.
  function autoFillSkillRows(panel, creature) {
    if (typeof DND35 === 'undefined' ||
        typeof DND35.parseCreatureSkills !== 'function') return;
    const container = panel.querySelector('.comp-skills-list');
    if (!container) return;
    // Clear previous auto-marked rows for idempotency.
    container.querySelectorAll('.comp-skill-row[data-from-auto="1"]')
      .forEach(r => r.remove());
    const skills = DND35.parseCreatureSkills(creature.skills || '');
    for (const s of skills) {
      // Strip leading "+" so the number input accepts the value
      // (negatives like "-2" are valid number-input strings already).
      const misc = String(s.modifier).replace(/^\+/, '');
      addSkillRow(container, { name: s.name, ranks: '', misc });
      const row = container.lastElementChild;
      if (row) {
        row.dataset.fromAuto = '1';
        // If the parser captured trailing notes ("(+4 acting)" or
        // "*"), surface them as a small hint after the row. Notes
        // aren't stored on skill rows today — append as a tooltip
        // on the name input so the info isn't lost.
        if (s.notes) {
          const nameIn = row.querySelector('.comp-skill-name');
          if (nameIn) nameIn.title = s.notes;
        }
      }
    }
  }

  // Write the computed size into the .comp-size select. The size is
  // determined up front by computeEscalatedSize() because crossing a
  // band also affects ability scores + natural armor (MM Table 4-2
  // deltas applied inline in autoFillFromBaseCreature).
  function writeEscalatedSize(panel, chosen) {
    const sizeSel = panel.querySelector('.comp-size');
    if (!sizeSel || !chosen) return;
    if (sizeSel.value !== chosen) {
      sizeSel.value = chosen;
      sizeSel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    sizeSel.dataset.fromAuto = '1';
  }

  // Auto-populate the companion's feat list from the creature's
  // free-text `feats` field. Bonus-feat markers ("(B)" suffix) are
  // surfaced as a "(racial bonus)" note on the row. Re-running AUTO
  // clears previous auto rows.
  function autoFillFeatRows(panel, creature) {
    if (typeof DND35 === 'undefined' ||
        typeof DND35.parseCreatureFeats !== 'function') return;
    const container = panel.querySelector('.comp-feats-list');
    if (!container) return;
    container.querySelectorAll('.comp-feat-entry[data-from-auto="1"]')
      .forEach(r => r.remove());
    const feats = DND35.parseCreatureFeats(creature.feats || '');
    for (const f of feats) {
      addListRow(container, 'comp-feat', 'Feat name', 'Notes', {
        name: f.name,
        notes: f.bonus ? '(racial bonus feat)' : '',
      });
      const row = container.lastElementChild;
      if (row) row.dataset.fromAuto = '1';
    }
  }

  // When AUTO mode is on, the stat fields populated by autoFillFromBase
  // Creature are disabled to avoid stale manual edits when the user
  // toggles modes back and forth. MANUAL re-enables everything so the
  // sheet behaves like before.
  function applyAutoFillState(panel, mode) {
    const auto = mode === 'auto';
    const fields = panel.querySelectorAll(
      '.comp-score, .comp-speed, .comp-ac-natural, ' +
      '.comp-bab, .comp-save-base, .comp-size');
    for (const el of fields) {
      el.disabled = auto;
      el.classList.toggle('comp-auto-locked', auto);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ============================================================
  // Collect / Load all companions
  // ============================================================
  function collectData() {
    const companions = [];
    $$(".inner-tab[data-comp-idx]").forEach((btn) => {
      const idx = btn.dataset.compIdx;
      const panel = $(`#companion-${idx}`);
      if (!panel) return;
      // Item Familiar: delegate to the item-familiar module.
      // (Its collectData returns a self-contained dict; we tack the
      // tab `name` on top.)
      const compTypeCur = panel.querySelector(".comp-type")?.value || "";
      if (compTypeCur === "item_familiar"
          && typeof ItemFamiliar !== "undefined") {
        const ifamData = ItemFamiliar.collectData(panel);
        ifamData.name = btn.textContent.replace("×", "").trim();
        companions.push(ifamData);
        return;
      }
      const d = {};
      d.name = btn.textContent.replace("×", "").trim();
      d.compName = panel.querySelector(".comp-name")?.value || "";
      d.compType = panel.querySelector(".comp-type")?.value || "";
      d.compSize = panel.querySelector(".comp-size")?.value || "Medium";
      d.isFamiliar = panel.querySelector(".comp-familiar-toggle")?.checked || false;
      d.compMode = panel.querySelector(".comp-mode-radio:checked")?.value || "manual";
      d.compBaseCreature = panel.querySelector(".comp-base-creature")?.value || "";
      d.compTemplate = panel.querySelector(".comp-template")?.value || "";
      ["STR","DEX","CON","INT","WIS","CHA"].forEach((ab) => {
        d[`comp-${ab.toLowerCase()}-score`] = panel.querySelector(`.comp-score[data-ab="${ab}"]`)?.value || "";
        d[`comp-${ab.toLowerCase()}-boost`] = panel.querySelector(`.comp-ability-boost[data-ab="${ab}"]`)?.value || "";
      });
      d.compHpMax = panel.querySelector(".comp-hp-max")?.value || "";
      d.compHpCur = panel.querySelector(".comp-hp-cur")?.value || "";
      d.compSpeed = panel.querySelector(".comp-speed")?.value || "";
      d.compInitMisc = panel.querySelector(".comp-init-misc")?.value || "";
      ["armor","shield","natural","size","misc"].forEach((f) => {
        d[`compAc${f.charAt(0).toUpperCase()+f.slice(1)}`] = panel.querySelector(`.comp-ac-${f}`)?.value || "";
      });
      ["Fort","Ref","Will"].forEach((s) => {
        d[`compSave${s}Base`] = panel.querySelector(`.comp-save-base[data-save="${s}"]`)?.value || "";
        d[`compSave${s}Misc`] = panel.querySelector(`.comp-save-misc[data-save="${s}"]`)?.value || "";
      });
      d.compBab = panel.querySelector(".comp-bab")?.value || "";
      d.compGrappleSize = panel.querySelector(".comp-grapple-size")?.value || "";
      d.compGrappleMisc = panel.querySelector(".comp-grapple-misc")?.value || "";
      d.compPersonality = panel.querySelector(".comp-personality")?.value || "";
      d.compNotes = panel.querySelector(".comp-notes")?.value || "";
      d.compSpecials = Array.from(panel.querySelectorAll(".comp-special-entry")).map((r) => ({
        name: r.querySelector(".comp-special-name")?.value || "",
        notes: r.querySelector(".comp-special-notes")?.value || "",
      }));
      d.compAttacks = Array.from(panel.querySelectorAll(".comp-attack-entry")).map((r) => ({
        weapon: r.querySelector(".comp-atk-weapon")?.value || "",
        bonus: r.querySelector(".comp-atk-bonus")?.value || "",
        damage: r.querySelector(".comp-atk-damage")?.value || "",
        crit: r.querySelector(".comp-atk-crit")?.value || "",
      }));
      d.compSkills = Array.from(panel.querySelectorAll(".comp-skill-row")).map((r) => ({
        name: r.querySelector(".comp-skill-name")?.value || "",
        ranks: r.querySelector(".comp-skill-ranks")?.value || "",
        misc: r.querySelector(".comp-skill-misc")?.value || "",
      }));
      d.compFeats = Array.from(panel.querySelectorAll(".comp-feat-entry")).map((r) => ({
        name: r.querySelector(".comp-feat-name")?.value || "",
        notes: r.querySelector(".comp-feat-notes")?.value || "",
      }));
      d.compTricks = Array.from(panel.querySelectorAll(".comp-trick-entry")).map((r) => ({
        name: r.querySelector(".comp-trick-name")?.value || "",
        notes: r.querySelector(".comp-trick-notes")?.value || "",
      }));
      companions.push(d);
    });
    return { companions };
  }

  // Pre-2026-05-17: compType was saved as the option's display text
  // ("Animal Companion" / "Familiar" / etc.) because the `<option>`
  // elements had no `value` attribute. The build template compared
  // against lowercase keys, so saved Familiars/Cohorts/etc. silently
  // reloaded as Animal Companion. Map old → new before letting
  // anything else consume the field.
  function normalizeCompType(raw) {
    if (!raw) return "";
    const v = String(raw);
    const TEXT_TO_KEY = {
      "Animal Companion": "animal",
      "Familiar":         "familiar",
      "Cohort":           "cohort",
      "Psicrystal":       "psicrystal",
      "Item Familiar":    "item_familiar",
      "Other":            "other",
    };
    return TEXT_TO_KEY[v] || v;
  }

  function loadData(data) {
    const tabBar = $("#companion-tab-bar");
    const content = $("#companion-content");
    if (!tabBar || !content) return;

    // Clear existing
    tabBar.innerHTML = "";
    content.innerHTML = "";
    companionIndex = 0;

    // Legacy migration: single companion from old schema
    if (!data.companions && (data["comp-name"] !== undefined || data.compAttacks)) {
      const legacy = {
        name: "Companion",
        compName: data["comp-name"] || "",
        compType: normalizeCompType(data["comp-type"]),
        compSpeed: data["comp-speed"] || "",
        compNotes: data["comp-personality"] || "",
        compSpecial: data["comp-special"] || "",
        compAttacks: data.compAttacks || [],
        compSkills: [],
        compFeats: data["comp-feats"] ? [{ name: data["comp-feats"], notes: "" }] : [],
        compTricks: data["comp-tricks"] ? [{ name: data["comp-tricks"], notes: "" }] : [],
      };
      ["STR","DEX","CON","INT","WIS","CHA"].forEach((ab) => {
        legacy[`comp-${ab.toLowerCase()}-score`] = data[`comp-${ab.toLowerCase()}`] || "";
      });
      addCompanion(legacy);
    } else {
      (data.companions || []).forEach((c) => {
        c.compType = normalizeCompType(c.compType);
        addCompanion(c);
      });
    }

    // Ensure at least one companion tab exists
    if (companionIndex === 0) addCompanion();
  }

  function setMainGetAbilityMod(fn) { _mainGetAbilityMod = fn; }

  function recalcAll() {
    $$("#companion-content > .inner-tab-content").forEach((panel) => recalcCompanion(panel));
  }

  // H5 (2026-05-16 play-feel pass): pick the most-relevant comp-type
  // dropdown value based on which bucket of computeCompanionLevels()
  // has the highest effective level. Returns a serialization-form
  // value matching the dropdown's `option`-comparison keys (animal /
  // familiar / cohort) or null if no bucket is non-zero.
  function defaultCompTypeFromClasses() {
    if (!window.DB || !DB.isLoaded()) return null;
    const lvls = computeCompanionLevels();
    // Map computeCompanionLevels bucket keys → buildCompanionHTML's
    // option-comparison values. (special_mount has no dedicated
    // dropdown entry — surface via "animal" since the existing
    // progression panel renders the mount info under either type.)
    const KEY_TO_VALUE = {
      familiar:         "familiar",
      animal_companion: "animal",
      special_mount:    "animal",
      cohort:           "cohort",
    };
    let bestKey = null;
    let bestLvl = 0;
    for (const k of Object.keys(lvls)) {
      if (lvls[k].effectiveLevel > bestLvl) {
        bestLvl = lvls[k].effectiveLevel;
        bestKey = k;
      }
    }
    return bestKey ? KEY_TO_VALUE[bestKey] : null;
  }

  // H4 (2026-05-16 play-feel pass): when classes change (apply /
  // remove via class-picker), refresh every existing companion
  // panel's progression panel + recompute the auto-default
  // comp-type for any panel that hasn't had its type explicitly
  // chosen by the user. Without this, applying "Wizard 5" to a
  // fresh sheet left the progression panel empty until some other
  // event triggered recalcCompanion.
  document.addEventListener("classes-changed", () => {
    const defaultType = defaultCompTypeFromClasses();
    $$("#companion-content > .inner-tab-content").forEach((panel) => {
      // Bump comp-type only when the user hasn't explicitly chosen
      // one (marked by absence of `data-user-set` on the select) AND
      // we computed a meaningful default.
      const sel = panel.querySelector(".comp-type");
      if (sel && defaultType && !sel.dataset.userSet) {
        // The `<option>` `value` attrs in buildCompanionHTML use the
        // same key vocabulary as defaultCompTypeFromClasses (animal /
        // familiar / cohort), so we can set the select directly.
        if (sel.value !== defaultType) {
          sel.value = defaultType;
          // Dispatch change so any downstream listeners (AUTO-fill
          // recompute, etc.) react.
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      recalcCompanion(panel);
    });
  });

  // Build the global #creature-options datalist once the DB is loaded.
  // Per-panel base-creature inputs reference it via `list="creature-options"`.
  // companion.js loads BEFORE database.js in index.html so `DB` isn't
  // yet defined when this IIFE runs. Poll briefly for it.
  function _scheduleCreatureDatalistBuild(attempt = 0) {
    if (typeof DB !== 'undefined' && DB.ready) {
      DB.ready.then((db) => {
        if (db) {
          buildGlobalCreatureDatalist();
          buildGlobalTemplateDatalist();  // Session C: template picker datalist
        }
      });
      return;
    }
    if (attempt > 50) return;  // give up after ~5s of polling
    setTimeout(() => _scheduleCreatureDatalistBuild(attempt + 1), 100);
  }
  _scheduleCreatureDatalistBuild();

  return { addCompanion, loadData, collectData, recalcAll, setMainGetAbilityMod };
})();
