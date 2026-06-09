// D&D 3.5 Character Sheet - Spells Tab Module (Dynamic Sub-tabs)

const Spells = (function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const int = (v) => parseInt(v) || 0;
  let casterIndex = 0;
  let _getAbilityMod = null;
  const SPELL_LABELS = ["0 (Cantrips)", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"];
  const SPELL_LIST_LABELS = ["0-Level (Cantrips)", "1st Level", "2nd Level", "3rd Level", "4th Level", "5th Level", "6th Level", "7th Level", "8th Level", "9th Level"];
  const SPELL_SHORT = ["0", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"];

  function spellOrd(i) { return i < SPELL_LABELS.length ? SPELL_LABELS[i] : i + "th"; }
  function spellListLabel(i) { return i < SPELL_LIST_LABELS.length ? SPELL_LIST_LABELS[i] : i + "th Level"; }
  function spellShort(i) { return i < SPELL_SHORT.length ? SPELL_SHORT[i] : i + "th"; }
  // --- Add a caster sub-tab (spellcasting or psionics) ---
  function addCaster(type, data = {}) {
    const idx = casterIndex++;
    const DEFAULT_NAMES = { spellcasting: "Spellcasting", psionics: "Psionics", maneuvers: "Maneuvers", epic: "Epic Spellcasting", binding: "Binding", shadowcaster: "Shadowcasting", invocations: "Invocations", sla: "Spell-Like Abilities" };
    const defaultName = DEFAULT_NAMES[type] || type;
    const name = data.name || defaultName;

    // Create inner-tab button
    const tabBar = $("#spells-tab-bar");
    const btn = document.createElement("button");
    btn.className = "inner-tab";
    btn.dataset.casterIdx = idx;
    btn.textContent = name;
    btn.addEventListener("click", () => switchCaster(idx));
    btn.addEventListener("dblclick", () => renameCaster(btn));
    tabBar.appendChild(btn);

    // Create content panel
    const container = $("#spells-content");
    const panel = document.createElement("div");
    panel.className = "inner-tab-content";
    panel.id = `caster-${idx}`;
    panel.dataset.casterType = type;

    // Sub-tab notes field (for differentiating multiple tabs of same type).
    // Multi-line textarea — auto-expands to fit content via app.js's
    // autoExpandAll() rebind on load.
    const notesHTML = `<div class="field caster-notes-field"><label>Notes</label><textarea class="caster-notes auto-expand" rows="1" placeholder="e.g. Cleric spells, Arcane Trickster, etc.">${data.notes || ""}</textarea></div>`;

    if (type === "spellcasting") {
      panel.innerHTML = notesHTML + buildSpellcastingHTML(idx, data);
      container.appendChild(panel);
      panel._casterData = data;
      buildSpellLists(idx, panel);
      wireLevelTabs(panel);
      wireSpecialistDomainToggles(panel);
      refreshMetamagicReference(panel);
      // Sync ✨ button visibility for any rows created during build.
      refreshAllKnownRowMetamagicVis();
    } else if (type === "psionics") {
      panel.innerHTML = notesHTML + buildPsionicsHTML(idx, data);
      container.appendChild(panel);
      buildPsiPowerLists(idx, panel);
      wireLevelTabs(panel);
    } else if (type === "maneuvers") {
      panel.innerHTML = notesHTML + buildManeuversHTML(idx, data);
      container.appendChild(panel);
      buildManeuverLists(idx, panel);
      wireReadiedManeuvers(panel, data);
      wireLevelTabs(panel);
    } else if (type === "epic") {
      panel.innerHTML = notesHTML + buildEpicHTML(idx, data);
      container.appendChild(panel);
      wireEpicSpells(panel);
    } else if (type === "binding") {
      panel.innerHTML = notesHTML + buildBindingHTML(idx, data);
      container.appendChild(panel);
      wireBindingVestiges(panel);
    } else if (type === "invocations") {
      panel.innerHTML = notesHTML + buildInvocationsHTML(idx, data);
      container.appendChild(panel);
      panel._casterData = data;
      // Stamp the panel's class so invocation-picker can filter to the
      // invocations this class can take (Warlock vs Dragonfire Adept).
      if (data.invoClass) panel.dataset.invoClass = data.invoClass;
      buildInvocationLists(idx, panel);
      wireLevelTabs(panel);
    } else if (type === "shadowcaster") {
      panel.innerHTML = notesHTML + Shadowcaster.buildHTML(idx, data);
      container.appendChild(panel);
      Shadowcaster.wire(panel);
    } else if (type === "sla") {
      panel.innerHTML = notesHTML + SLA.buildHTML(idx, data);
      container.appendChild(panel);
      SLA.wire(panel);
    }

    // Add remove button to tab
    const removeBtn = document.createElement("span");
    removeBtn.className = "caster-tab-remove";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`Remove "${btn.textContent.replace("×", "").trim()}"?`)) {
        btn.remove();
        panel.remove();
        // Activate first remaining tab if any
        const first = tabBar.querySelector(".inner-tab");
        if (first) first.click();
      }
    });
    btn.appendChild(removeBtn);

    // Activate this new tab
    switchCaster(idx);
    if (_getAbilityMod) recalc(_getAbilityMod);
    return idx;
  }
  function switchCaster(idx) {
    $$(".inner-tab[data-caster-idx]").forEach((t) => t.classList.remove("active"));
    $$("#spells-content > .inner-tab-content").forEach((c) => c.classList.remove("active"));
    const btn = $(`.inner-tab[data-caster-idx="${idx}"]`);
    const panel = $(`#caster-${idx}`);
    if (btn) btn.classList.add("active");
    if (panel) panel.classList.add("active");
    setTimeout(() => window.autoExpandAll && window.autoExpandAll(), 10);
  }
  function renameCaster(btn) {
    const removeSpan = btn.querySelector(".caster-tab-remove");
    const currentName = btn.textContent.replace("×", "").trim();
    const newName = prompt("Rename tab:", currentName);
    if (newName && newName.trim()) {
      btn.textContent = newName.trim();
      btn.appendChild(removeSpan);
    }
  }
  function buildAbilityOptions(selected, includePhysical = true) {
    let abilities = ["", "INT", "WIS", "CHA"];
    let labels = ["-- None --", "Intelligence", "Wisdom", "Charisma"];
    if (includePhysical) {
      abilities.push("STR", "DEX", "CON");
      labels.push("Strength", "Dexterity", "Constitution");
    }
    return abilities.map((ab, i) =>
      `<option value="${ab}"${ab === selected ? " selected" : ""}>${labels[i]}</option>`
    ).join("");
  }
  // Classes whose Known list IS literally a spellbook. The column
  // header reads "Spellbook" instead of "Known" so the UI matches
  // the in-fiction object. Detection is by tab name (data.name);
  // user-renamed tabs lose the relabel — acceptable tradeoff vs.
  // cross-module dataset stamping for a cosmetic-only tweak.
  const SPELLBOOK_CLASS_NAMES = new Set([
    'Wizard', 'Wu Jen', 'Archivist',
  ]);
  function isSpellbookCaster(data) {
    return !!(data && SPELLBOOK_CLASS_NAMES.has(data.name));
  }
  function knownLabelFor(data) {
    return isSpellbookCaster(data) ? 'Spellbook' : 'Known';
  }

  // PHB 3.5 schools of magic. Wizard specialty + prohibited fields
  // were free-text before — typos like "Necromany" left bonuses
  // unverifiable. Dropdowns hard-constrain to the canonical eight.
  // Universal is listed but disabled in select rendering because it
  // can't be picked as a specialty (and isn't prohibitable per RAW).
  const SPELL_SCHOOLS = [
    'Abjuration', 'Conjuration', 'Divination', 'Enchantment',
    'Evocation', 'Illusion', 'Necromancy', 'Transmutation',
  ];
  function schoolOptionsHTML(selected) {
    const sel = String(selected || '');
    const opts = ['<option value=""></option>'];
    for (const s of SPELL_SCHOOLS) {
      const isSel = sel.toLowerCase() === s.toLowerCase() ? ' selected' : '';
      opts.push(`<option value="${s}"${isSel}>${s}</option>`);
    }
    return opts.join('');
  }

  // --- Spellcasting HTML builder ---
  function buildSpellcastingHTML(idx, data) {
    const domainVis = data.domainAccess ? "" : "display:none";
    const specVis = data.specialist ? "" : "display:none";
    const maxLevel = data.maxLevel || 9;
    const rows = [];
    for (let i = 0; i <= maxLevel; i++) {
      const hasBonusSlot = i >= 1;
      rows.push(`<tr>
        <td>${spellOrd(i)}</td>
        <td><input type="number" class="sc-known" data-lvl="${i}" min="0" value="${data[`known-${i}`] || ""}"></td>
        <td><span class="sc-dc calc-field" data-lvl="${i}">--</span></td>
        <td><input type="number" class="sc-per-day" data-lvl="${i}" min="0" value="${data[`perDay-${i}`] || ""}"></td>
        <td><input type="number" class="sc-bonus" data-lvl="${i}" min="0" value="${data[`bonus-${i}`] || ""}"></td>
        <td class="sc-domain-col" style="${domainVis}">${hasBonusSlot ? `<input type="number" class="sc-domain-slots" data-lvl="${i}" min="0" value="${data[`domain-${i}`] || ""}">` : ""}</td>
        <td class="sc-specialist-col" style="${specVis}">${hasBonusSlot ? `<input type="number" class="sc-specialist-slots" data-lvl="${i}" min="0" value="${data[`specialist-${i}`] || ""}">` : ""}</td>
        <td><input type="number" class="sc-extra" data-lvl="${i}" min="0" value="${data[`extra-${i}`] || ""}"
                   title="Extra slots from feats, items, irregular PrCs, etc. Survives class re-apply; not auto-overwritten."></td>
        <td><input type="number" class="sc-used" data-lvl="${i}" min="0" value="${data[`used-${i}`] || "0"}"></td>
        <td><span class="sc-remain calc-field" data-lvl="${i}">--</span></td>
      </tr>`);
    }

    const levelTabs = Array.from({ length: maxLevel + 1 }, (_, i) =>
      `<button class="spell-level-tab${i === 0 ? " active" : ""}" data-level="${i}">${spellShort(i)}</button>`
    ).join("");

    // Build prohibited schools list
    const prohibitedSchools = data.prohibitedSchools || [];
    // Legacy migration: pull from old prohibited1/prohibited2 fields
    if (prohibitedSchools.length === 0) {
      if (data.prohibited1) prohibitedSchools.push(data.prohibited1);
      if (data.prohibited2) prohibitedSchools.push(data.prohibited2);
    }
    // Default to one empty entry
    if (prohibitedSchools.length === 0) prohibitedSchools.push("");

    const prohibitedHTML = prohibitedSchools.map((s) =>
      `<div class="prohibited-entry"><select class="sc-prohibited">${schoolOptionsHTML(s)}</select><button class="btn-remove sc-remove-prohibited" title="Remove">X</button></div>`
    ).join("");

    // Show-prepared default: spontaneous casters (Sorcerer, Bard, Beguiler,
    // etc.) typically don't need a separate prepared column, so the
    // checkbox starts unchecked for them. Prepared casters (Wizard,
    // Cleric, Druid, etc.) default to checked. The user can toggle either
    // way per panel; the choice persists via `showPrepared` in the saved
    // data.
    const showPrepared = data.showPrepared !== undefined
      ? !!data.showPrepared
      : true;
    // Spells Known list visibility — defaults on; Cleric / Druid /
    // other prepared-from-list casters (who can prepare any spell on
    // their list) typically turn this off.
    const showKnown = data.showKnown !== undefined
      ? !!data.showKnown
      : true;
    return `
      <section class="section">
        <h2>Spellcasting</h2>
        <div class="sc-spontaneous-mm-warning" style="display:none;
             margin-bottom:0.5rem;padding:0.4rem 0.6rem;
             background:rgba(170,140,80,0.15);
             border-left:3px solid #c98;color:#dba;font-size:0.85em">
          ⚠ <b>Spontaneous metamagic:</b> applying metamagic feats at
          cast time takes one step longer than the spell's normal
          action (standard → full-round; full-round → 1 round).
          Quickened spells still use a swift action.
        </div>
        <details class="sc-metamagic-ref" style="display:none;
                 margin-bottom:0.5rem;padding:0.4rem 0.6rem;
                 background:rgba(255,255,255,0.03);
                 border-left:2px solid #6a8aaa;border-radius:0 3px 3px 0">
          <summary style="cursor:pointer;font-size:0.9em;color:#cce">
            Metamagic Reference
            <span class="sc-mm-ref-count" style="opacity:0.6"></span>
          </summary>
          <div class="sc-mm-ref-body" style="margin-top:0.4rem;font-size:0.85em;color:#ccd"></div>
          <!-- v2 Phase B: round + day usage trackers. Surfaced inside
               the Reference panel so they share visibility with the
               feat list. The two counters are independent: the round
               counter is a free-form int (player updates each turn),
               and the daily-reset button strips "[Used today]"
               markers from all Sudden* feats. -->
          <div class="sc-mm-trackers" style="display:none;
               margin-top:0.5rem;padding-top:0.4rem;
               border-top:1px solid rgba(255,255,255,0.08);
               font-size:0.85em;color:#ccd;
               display:flex;flex-wrap:wrap;gap:1rem;align-items:center">
            <label style="display:flex;align-items:center;gap:0.4rem">
              Quickened this round:
              <input type="number" class="sc-quickened-this-round"
                     min="0" max="9" value="${data.quickenedThisRound || 0}"
                     style="width:3rem">
              <button class="btn-feat-info sc-quickened-reset"
                      title="Reset to 0 (start of next round)">
                ↻
              </button>
            </label>
            <button class="btn-feat-info sc-mm-reset-daily" style="font-size:0.85em"
                    title="Strip [Used today] marker from every Sudden* feat. Use after a long rest.">
              Reset Sudden* daily uses
            </button>
          </div>
        </details>
        <div class="spell-header">
          <div class="field field-sm"><label>Caster Level</label><input type="number" class="sc-caster-level" min="1" value="${data.casterLevel || ""}"></div>
          <div class="field"><label>Spellcasting Ability</label><select class="sc-ability">${buildAbilityOptions(data.ability || "", false)}</select></div>
          <div class="field"
               title="Optional override. Set ONLY for classes whose bonus spells per day use a different ability than DCs (Favored Soul: CHA bonus / WIS DC; Spirit Shaman: WIS bonus / CHA DC). Leave blank for everyone else — bonus spells fall back to Spellcasting Ability.">
            <label>Bonus Spell Ability <span style="opacity:.6;font-weight:normal">(if different)</span></label>
            <select class="sc-bonus-ability">${buildAbilityOptions(data.bonusAbility || "", true)}</select>
          </div>
          <div class="field"><label>Arcane Spell Failure %</label><span class="sc-spell-fail calc-field">0%</span></div>
          <div class="field"><label>Conditional Modifiers</label><textarea class="sc-conditional" rows="1">${data.conditional || ""}</textarea></div>
        </div>
        <div class="spell-header" style="margin-top:0.5rem">
          <label class="mi-toggle"><input type="checkbox" class="sc-specialist-toggle" ${data.specialist ? "checked" : ""}> Specialist</label>
          <label class="mi-toggle"><input type="checkbox" class="sc-domain-toggle" ${data.domainAccess ? "checked" : ""}> Domain Access</label>
          <label class="mi-toggle"><input type="checkbox" class="sc-show-known" ${showKnown ? "checked" : ""}> Show ${isSpellbookCaster(data) ? "Spellbook" : "Spells Known"}</label>
          <label class="mi-toggle"><input type="checkbox" class="sc-show-prepared" ${showPrepared ? "checked" : ""}> Show Prepared</label>
        </div>
        <div class="sc-specialist-section" style="${specVis}">
          <div class="info-grid">
            <div class="field"><label>Specialty School</label><select class="sc-specialty-school" title="+2 on Spellcraft checks for this school">${schoolOptionsHTML(data.specialtySchool)}</select></div>
          </div>
          <div class="sc-prohibited-list">
            <label>Prohibited Schools</label>
            ${prohibitedHTML}
            <button class="btn-add sc-add-prohibited" style="margin-top:0.3rem">+ Add Prohibited School</button>
          </div>
        </div>
        <div class="sc-domain-section" style="${domainVis}">
          <div class="sc-domain-list"></div>
          <button class="btn-add sc-add-domain" style="margin-top:0.3rem">+ Add Domain</button>
        </div>
        <div class="spellcasting-2col">
          <div class="spellcasting-list-col">
            <h3>Spell List &amp; Prepared</h3>
            <div class="spell-list-tabs">${levelTabs}</div>
            <div class="sc-spell-lists"></div>
          </div>
          <div class="spellcasting-slot-col">
            <h3>Slots / DCs</h3>
            <table class="spell-slots-table" data-max-level="${maxLevel}">
              <thead><tr>
                <th>Lvl</th><th>Known</th><th>DC</th><th>/Day</th><th>Bonus</th>
                <th class="sc-domain-col" style="${domainVis}">Dom</th>
                <th class="sc-specialist-col" style="${specVis}">Spec</th>
                <th title="Extra slots from feats / items / irregular PrCs">Extra</th>
                <th>Used</th><th>Left</th>
              </tr></thead>
              <tbody>${rows.join("")}</tbody>
            </table>
            <div style="display:flex;flex-direction:column;gap:0.3rem;margin-top:0.5rem">
              <button class="btn-add sc-add-level">+ Add Spell Level</button>
              <button class="btn-add sc-reset-slots">Reset Expended Slots</button>
            </div>
          </div>
        </div>
      </section>
    `;
  }
  function buildSpellLists(idx, panel) {
    const container = panel.querySelector(".sc-spell-lists");
    const maxLevel = int(panel.querySelector(".spell-slots-table")?.dataset.maxLevel || 9);
    const data = panel._casterData || {};
    for (let i = 0; i <= maxLevel; i++) {
      appendSpellListDiv(container, i, i === 0, data);
    }

    panel.querySelector(".sc-reset-slots").addEventListener("click", () => {
      panel.querySelectorAll(".sc-used").forEach((el) => { el.value = 0; });
      recalc();
    });

    panel.querySelector(".sc-add-level").addEventListener("click", () => {
      addSpellcastingLevel(panel);
    });
  }
  function appendSpellListDiv(container, i, active, data) {
    const lbl = spellListLabel(i);
    const knownLbl = knownLabelFor(data || {});
    const div = document.createElement("div");
    div.className = `spell-list-content${active ? " active" : ""}`;
    div.dataset.level = i;
    div.innerHTML = `
      <div class="two-column">
        <div class="column sc-known-col">
          <h3>${lbl} - ${knownLbl}
            <span class="sc-known-count" data-lvl="${i}"></span>
          </h3>
          <div class="sc-known-list" data-lvl="${i}"></div>
          <button class="btn-add sc-add-known" data-lvl="${i}" style="margin-top:0.3rem">+ Add Spell</button>
        </div>
        <div class="column sc-prepared-col">
          <h3>${lbl} - Prepared Spells
            <span class="sc-prepared-count" data-lvl="${i}"
                  title="Prepared spells / total slots — shows when you're under or over-prepared."></span>
          </h3>
          <!-- v2 Phase C structural-restructure (2026-05-19): Prepared
               is a structured row list (mirroring the Known column).
               Legacy textarea saves migrate via loadData. See
               createPreparedRow + addPreparedSpell. -->
          <div class="sc-prepared-list" data-lvl="${i}"></div>
          <button class="btn-add sc-add-prepared" data-lvl="${i}" style="margin-top:0.3rem">+ Add Prepared Spell</button>
        </div>
      </div>
    `;
    container.appendChild(div);
    // Wire + Add Spell button to insert an empty row.
    div.querySelector(".sc-add-known").addEventListener("click", () => {
      const row = createKnownRow(div.querySelector(`.sc-known-list[data-lvl="${i}"]`), i, "");
      row.querySelector(".sc-known-name").focus();
    });
    div.querySelector(".sc-add-prepared").addEventListener("click", () => {
      const panel2 = div.closest("[data-caster-type='spellcasting']");
      const row = createPreparedRow(
        div.querySelector(`.sc-prepared-list[data-lvl="${i}"]`),
        i, { baseName: "", metamagic: [], used: false });
      row.querySelector(".sc-prep-name").focus();
      if (panel2) updatePreparedCount(panel2, i, null);
    });
  }

  // v2 Phase C structural-restructure (2026-05-19): build a single
  // Prepared-spell row. Each row carries its metamagic state in
  // data-* attributes so the ✏ Edit button can reopen the preparer
  // pre-populated without re-parsing the rendered name.
  //
  // Row shape (data-* attributes):
  //   data-base="Fireball"
  //   data-metamagic='["Empower Spell","Maximize Spell"]'  (JSON)
  //   data-heighten-target="5"  (if Heighten in metamagic; else "")
  //   data-sanctum-in="0"|"1"   (if Sanctum in metamagic; else "0")
  //
  // The display name is computed from these via
  // MetamagicPreparer.renderPreparedLine (or just the base name when
  // no metamagic). Auto-updates whenever metamagic state changes.
  //
  // `data`: { baseName, metamagic, heightenTarget?, sanctumIn?, used }
  function createPreparedRow(listEl, lvl, data) {
    data = data || {};
    const baseName = data.baseName || "";
    const metamagic = Array.isArray(data.metamagic) ? data.metamagic : [];
    const heightenTarget = data.heightenTarget ?? null;
    const sanctumIn = !!data.sanctumIn;
    const used = !!data.used;

    const row = document.createElement("div");
    row.className = "sc-prepared-row";
    row.dataset.base = baseName;
    row.dataset.metamagic = JSON.stringify(metamagic);
    row.dataset.heightenTarget = heightenTarget !== null ? String(heightenTarget) : "";
    row.dataset.sanctumIn = sanctumIn ? "1" : "0";

    // Compute the rendered display name (without the [X] used prefix —
    // the checkbox handles that visually).
    const displayName = (typeof MetamagicPreparer !== "undefined")
      ? MetamagicPreparer.renderPreparedLine({
          name: baseName,
          metamagic, heightenTarget, sanctumIn, used: false,
        })
      : baseName;

    const hasMM = metamagic.length > 0;

    row.innerHTML =
      `<input type="checkbox" class="sc-prep-used"${used ? " checked" : ""} ` +
      `title="Mark as used / expended for the day">` +
      `<input type="text" class="sc-prep-name" value="${escapeAttr(displayName)}" ` +
      `placeholder="Spell name" autocomplete="off">` +
      `<button class="btn-feat-info sc-prep-info" title="Show rules">ⓘ</button>` +
      `<button class="btn-feat-info sc-prep-edit-mm" title="Edit metamagic" ` +
      `style="display:${hasMM ? '' : 'none'}">✏</button>` +
      `<button class="btn-remove sc-prep-remove" title="Remove">X</button>`;
    listEl.appendChild(row);

    const usedCb   = row.querySelector(".sc-prep-used");
    const nameInp  = row.querySelector(".sc-prep-name");
    const infoBtn  = row.querySelector(".sc-prep-info");
    const editBtn  = row.querySelector(".sc-prep-edit-mm");
    const rmBtn    = row.querySelector(".sc-prep-remove");
    const panel    = listEl.closest("[data-caster-type='spellcasting']");

    // Used checkbox: just a state toggle, recalc the per-level count.
    usedCb.addEventListener("change", () => {
      if (panel) updatePreparedCount(panel, lvl, null);
    });

    // Name input: when the user edits manually, treat as freehand —
    // clear the metamagic chips since the name no longer reflects them.
    // (Most users either freehand a plain spell name or use the picker;
    // mixing the two without acknowledgement is the path to confusion.)
    nameInp.addEventListener("input", () => {
      // Only nuke the metamagic state if the user explicitly diverged
      // from the picker-rendered name. Compare against the current
      // expected display.
      const expected = (typeof MetamagicPreparer !== "undefined")
        ? MetamagicPreparer.renderPreparedLine({
            name: row.dataset.base,
            metamagic: JSON.parse(row.dataset.metamagic || "[]"),
            heightenTarget: row.dataset.heightenTarget ? parseInt(row.dataset.heightenTarget, 10) : null,
            sanctumIn: row.dataset.sanctumIn === "1",
            used: false,
          })
        : row.dataset.base;
      if (nameInp.value !== expected) {
        // Best-effort: re-parse the user's freehand into base + metamagic.
        const parsed = (typeof MetamagicPreparer !== "undefined")
          ? MetamagicPreparer.parsePreparedLine(nameInp.value) : null;
        if (parsed) {
          row.dataset.base = parsed.name;
          row.dataset.metamagic = JSON.stringify(parsed.metamagic);
          row.dataset.heightenTarget = parsed.heightenTarget !== null
            ? String(parsed.heightenTarget) : "";
          row.dataset.sanctumIn = parsed.sanctumIn ? "1" : "0";
          // Used state lives on the checkbox, not in the parsed result.
        } else {
          row.dataset.base = nameInp.value;
          row.dataset.metamagic = "[]";
          row.dataset.heightenTarget = "";
          row.dataset.sanctumIn = "0";
        }
        // Update edit-button visibility to reflect new metamagic state.
        const mmList = JSON.parse(row.dataset.metamagic || "[]");
        editBtn.style.display = mmList.length > 0 ? "" : "none";
      }
      if (panel) updatePreparedCount(panel, lvl, null);
    });

    // ⓘ rules toggle: same DB lookup as Known column.
    infoBtn.addEventListener("click", () => {
      togglePreparedRules(row, row.dataset.base);
    });

    // ✏ edit-metamagic: reopen the preparer with the row's current
    // metamagic state. Replace this row in place (or move to a
    // different level if effective level changes).
    editBtn.addEventListener("click", () => {
      openEditMetamagicOnRow(panel, row, lvl);
    });

    rmBtn.addEventListener("click", () => {
      row.remove();
      if (panel) updatePreparedCount(panel, lvl, null);
    });

    if (panel) updatePreparedCount(panel, lvl, null);
    return row;
  }

  // Build a synthetic anchor row + open the MetamagicPreparer in edit
  // mode pre-populated from `row`'s data attributes. On save, update
  // the row in place (or relocate to the new effective level).
  //
  // Idempotency: ✏ is a TOGGLE — clicking it again on an already-open
  // edit chip closes the chip + preparer instead of stacking duplicates.
  // The preparer's own toggle-check (in MetamagicPreparer.open) only
  // scans inside the anchor it's given, so it never sees the previous
  // anchor when each call creates a fresh one. Pre-check here against
  // a per-row marker class instead.
  function openEditMetamagicOnRow(panel, row, lvl) {
    if (!panel || !row || typeof MetamagicPreparer === "undefined") return;

    // If an edit-chip for this row is already open, close it + bail.
    // The chip is inserted right after the row and carries
    // sc-known-row-virtual; double-checking the data-edit-row-id
    // attribute we stamp below guards against finding a chip that
    // belongs to a different row's edit session.
    const editBtn = row.querySelector(".sc-prep-edit-mm");
    const rowId = row.dataset.editRowId || row.dataset.base || "";
    let next = row.nextSibling;
    while (next && next.nodeType === 1) {
      if (next.classList.contains("sc-known-row-virtual")
          && next.dataset.editRowId === rowId) {
        next.remove();
        if (editBtn) editBtn.classList.remove("active");
        return;
      }
      // Only look at the immediate next sibling — don't chase past
      // sibling rows that aren't ours.
      break;
    }

    const baseName = row.dataset.base || "";
    const metamagic = JSON.parse(row.dataset.metamagic || "[]");
    const heightenTarget = row.dataset.heightenTarget
      ? parseInt(row.dataset.heightenTarget, 10) : null;
    const sanctumIn = row.dataset.sanctumIn === "1";

    // Resolve the spell's true base level via the Known list (same
    // lookup the old textarea-based picker used).
    let baseLevel = null;
    panel.querySelectorAll(".sc-known-row").forEach((kr) => {
      if (baseLevel !== null) return;
      const knownName = kr.querySelector(".sc-known-name")?.value;
      if (knownName && knownName.toLowerCase() === baseName.toLowerCase()) {
        const list = kr.closest(".sc-known-list");
        if (list?.dataset.lvl != null) baseLevel = parseInt(list.dataset.lvl, 10);
      }
    });
    if (baseLevel === null) {
      // Fallback: subtract raw metamagic costs from this row's level.
      let totalRaw = 0;
      for (const featName of metamagic) {
        if (featName === "Heighten Spell" || featName === "Improved Heighten Spell") continue;
        const meta = Spells.lookupMetamagicFromDB(featName);
        if (meta && typeof meta.levelAdjustment === "number") totalRaw += meta.levelAdjustment;
      }
      baseLevel = Math.max(0, lvl - totalRaw);
    }

    // Synthetic anchor row (the preparer attaches its picker as a
    // child element of this DOM node). Inserted right under the row
    // being edited, removed when the preparer closes.
    //
    // editRowId tags the anchor so a second ✏ click on the same row
    // finds + collapses this chip instead of stacking a duplicate.
    // Mirrors the marker stamped on `row` below.
    if (!row.dataset.editRowId) {
      row.dataset.editRowId = `prep-${lvl}-${baseName}-${Date.now()}`;
    }
    const anchor = document.createElement("div");
    anchor.className = "sc-known-row sc-known-row-virtual";
    anchor.dataset.editRowId = row.dataset.editRowId;
    anchor.style.cssText = "padding:0.3rem;background:rgba(255,255,255,0.02)";
    anchor.innerHTML =
      `<span style="opacity:0.75;font-size:0.9em">Editing: <b>${escapeAttr(baseName)}</b> ` +
      `<span style="opacity:0.6">(base lvl ${baseLevel})</span></span>`;
    row.parentElement.insertBefore(anchor, row.nextSibling);
    if (editBtn) editBtn.classList.add("active");

    MetamagicPreparer.open({
      panel, anchorRow: anchor, baseLevel, spellName: baseName,
      prepopulate: { metamagic, heightenTarget, sanctumIn },
      onPrepare: ({ modName, effLevel }) => {
        // Parse the new modified name back into structured form.
        const parsed = MetamagicPreparer.parsePreparedLine(modName)
          || { name: baseName, metamagic: [], heightenTarget: null, sanctumIn: false };
        const newRowData = {
          baseName: parsed.name,
          metamagic: parsed.metamagic,
          heightenTarget: parsed.heightenTarget,
          sanctumIn: parsed.sanctumIn,
          used: row.querySelector(".sc-prep-used")?.checked || false,
        };
        if (effLevel === lvl) {
          // Update this row in place.
          row.dataset.base = newRowData.baseName;
          row.dataset.metamagic = JSON.stringify(newRowData.metamagic);
          row.dataset.heightenTarget = newRowData.heightenTarget !== null
            ? String(newRowData.heightenTarget) : "";
          row.dataset.sanctumIn = newRowData.sanctumIn ? "1" : "0";
          // renderPreparedLine uses `.name`, not `.baseName` — translate.
          const newDisplay = MetamagicPreparer.renderPreparedLine({
            name: newRowData.baseName,
            metamagic: newRowData.metamagic,
            heightenTarget: newRowData.heightenTarget,
            sanctumIn: newRowData.sanctumIn,
            used: false,
          });
          row.querySelector(".sc-prep-name").value = newDisplay;
          row.querySelector(".sc-prep-edit-mm").style.display =
            newRowData.metamagic.length > 0 ? "" : "none";
        } else {
          // Move to the target level's list.
          const targetList = panel.querySelector(`.sc-prepared-list[data-lvl="${effLevel}"]`);
          row.remove();
          if (targetList) {
            createPreparedRow(targetList, effLevel, newRowData);
          }
          updatePreparedCount(panel, lvl, null);
          updatePreparedCount(panel, effLevel, null);
        }
        anchor.remove();
        if (editBtn) editBtn.classList.remove("active");
      },
    });
  }

  // ⓘ panel for Prepared rows — same shape as the Known column's
  // togglePreparedRules — query DB by spell name, render the rules
  // block under the row.
  function togglePreparedRules(row, spellName) {
    const existing = row.querySelector(".sc-prep-rules");
    const infoBtn = row.querySelector(".sc-prep-info");
    if (existing) {
      existing.remove();
      infoBtn?.classList.remove("active");
      return;
    }
    const name = (spellName || "").trim();
    if (!name) return;
    const rules = document.createElement("div");
    rules.className = "feat-rules sc-prep-rules";
    rules.innerHTML = renderSpellRules(name);
    row.appendChild(rules);
    infoBtn?.classList.add("active");
  }

  // Public-API helper for metamagic-preparer.js's default (non-edit)
  // "Prepare" path — let the picker add a structured prepared row
  // instead of writing to the old textarea.
  function addPreparedSpell(panel, lvl, data) {
    if (!panel) return null;
    const listEl = panel.querySelector(`.sc-prepared-list[data-lvl="${lvl}"]`);
    if (!listEl) return null;
    return createPreparedRow(listEl, lvl, data);
  }

  // Build a single Known-spell row (feat-row-style: name input + ⓘ +
  // →Prep + ×). The ⓘ rules expansion and →Prep handlers attach here;
  // they're scoped per row but read DB / sibling DOM at click time.
  //
  // `opts.freebie`: row is a class-granted spell (Sand Shaper's
  // Desert Insight, etc.) — visually marked + excluded from the
  // per-level count-vs-cap. Source string (`opts.source`) shown in
  // the row's tooltip so the user knows where it came from.
  function createKnownRow(listEl, lvl, spellName, opts) {
    opts = opts || {};
    const row = document.createElement("div");
    row.className = "sc-known-row";
    if (opts.freebie) row.classList.add("sc-known-freebie");
    if (opts.freebie) row.dataset.freebie = "1";
    if (opts.source) row.dataset.source = opts.source;
    const titleAttr = opts.source
      ? ` title="Granted by: ${escapeAttr(opts.source)}"`
      : '';
    row.innerHTML =
      `<input type="text" class="sc-known-name" list="spell-options" ` +
      `autocomplete="off"${titleAttr} ` +
      `value="${escapeAttr(spellName)}" placeholder="Spell name">` +
      (opts.freebie
        ? `<span class="sc-known-freebie-badge" title="${escapeAttr(
            opts.source ? 'Granted by: ' + opts.source : 'Class-granted'
          )} — doesn't count toward Known cap">★</span>`
        : '') +
      `<button class="btn-feat-info sc-known-info" title="Show rules">ⓘ</button>` +
      // ✨ Metamagic-preparer button: opens an inline picker that
      // lets the player apply metamagic feats while copying the
      // spell to Prepared. Shown only when the character has at
      // least one metamagic feat (refreshKnownRowMetamagicVis below).
      `<button class="btn-feat-info sc-known-mm" title="Prepare with metamagic" ` +
      `style="display:none">&#10024;</button>` +
      `<button class="btn-feat-info sc-known-to-prep" title="Copy to Prepared">&rarr;</button>` +
      `<button class="btn-remove sc-known-remove" title="Remove">X</button>`;
    listEl.appendChild(row);
    const nameInput = row.querySelector(".sc-known-name");
    const infoBtn   = row.querySelector(".sc-known-info");
    const mmBtn     = row.querySelector(".sc-known-mm");
    const prepBtn   = row.querySelector(".sc-known-to-prep");
    const rmBtn     = row.querySelector(".sc-known-remove");
    const panel = listEl.closest(".inner-tab-content");

    nameInput.addEventListener("input", () => {
      // Collapse any rules panel — the row's spell identity may have
      // changed, so a stale rules block would be misleading.
      const existing = row.querySelector(".sc-known-rules");
      if (existing) existing.remove();
      infoBtn.classList.remove("active");
      updateKnownCount(panel, lvl);
    });
    infoBtn.addEventListener("click", () => toggleKnownRules(row, nameInput.value));
    mmBtn.addEventListener("click", () => {
      if (!window.MetamagicPreparer) return;
      MetamagicPreparer.open({
        panel,
        anchorRow: row,
        baseLevel: lvl,
        spellName: nameInput.value,
      });
    });
    prepBtn.addEventListener("click", () => copyKnownToPrepared(panel, lvl, nameInput.value));
    // Show/hide ✨ based on current metamagic-feat availability.
    refreshKnownRowMetamagicVis(row);
    rmBtn.addEventListener("click", () => {
      row.remove();
      updateKnownCount(panel, lvl);
    });

    // Re-evaluate the count immediately so the header updates when
    // rows are added from loadData / spell-picker / Sha'ir prefill.
    updateKnownCount(panel, lvl);
    return row;
  }

  function escapeAttr(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
      .replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Show / hide the ✨ button on a single Known row based on whether
  // the character currently has any metamagic feats. Idempotent — safe
  // to call repeatedly (e.g. on Feats-tab edits and on row creation).
  function refreshKnownRowMetamagicVis(row) {
    if (!row) return;
    const btn = row.querySelector(".sc-known-mm");
    if (!btn) return;
    const hasMM = window.MetamagicPreparer
      && MetamagicPreparer.characterHasAnyMetamagic();
    btn.style.display = hasMM ? "" : "none";
    // If the character lost all metamagic feats while a picker was
    // open on this row, close the stale picker.
    if (!hasMM) {
      const open = row.querySelector(".sc-mm-prep");
      if (open) {
        open.remove();
        btn.classList.remove("active");
      }
    }
  }

  // Refresh ✨ visibility across every Known row in every spellcasting
  // panel. Called from the existing Feats-tab live-refresh listener
  // (see refreshMetamagicReference, line ~1707).
  function refreshAllKnownRowMetamagicVis() {
    document.querySelectorAll(".sc-known-row")
      .forEach(refreshKnownRowMetamagicVis);
  }

  // Update the "(N / cap)" header counter. Cap comes from the slots
  // table's per-level `.sc-known` input (auto-filled from class data;
  // user-editable). Over-cap turns the counter red.
  function updateKnownCount(panel, lvl) {
    if (!panel) return;
    const list = panel.querySelector(`.sc-known-list[data-lvl="${lvl}"]`);
    const counter = panel.querySelector(`.sc-known-count[data-lvl="${lvl}"]`);
    if (!list || !counter) return;
    // Freebie rows (class-granted spells like Sand Shaper's Desert
    // Insight) are visible in the list but don't count toward the
    // user's spells-known cap. Suffix the counter with "+N free" when
    // any are present so the player sees both numbers.
    const allRows = list.querySelectorAll(".sc-known-row");
    let countable = 0, freebies = 0;
    for (const r of allRows) {
      if (r.dataset.freebie === '1') freebies++;
      else countable++;
    }
    const capEl = panel.querySelector(`.sc-known[data-lvl="${lvl}"]`);
    const cap = capEl && capEl.value !== "" ? parseInt(capEl.value, 10) : null;
    const freeSuffix = freebies ? ` + ${freebies} free` : '';
    if (cap !== null && !isNaN(cap)) {
      counter.textContent = ` (${countable} / ${cap}${freeSuffix})`;
      counter.classList.toggle("sc-known-over", countable > cap);
    } else if (countable + freebies > 0) {
      counter.textContent = ` (${countable}${freeSuffix})`;
      counter.classList.remove("sc-known-over");
    } else {
      counter.textContent = "";
      counter.classList.remove("sc-known-over");
    }
  }

  // Update the "(N / Y)" sub-line under the Prepared header. N is the
  // count of structured prepared rows; rows with an empty name are
  // skipped. Y is the total slot count for this level (perDay + bonus
  // + domain + specialist). Hidden when the Prepared column is hidden
  // (spontaneous casters never set it). Over-prepared (N > Y) turns
  // the counter red. Under-prepared dims it.
  //
  // `totalSlots` is optional — when null we read the current value from
  // the slots row so the counter stays consistent when rows mutate
  // without a full recalc.
  function updatePreparedCount(panel, lvl, totalSlots) {
    if (!panel) return;
    const counter = panel.querySelector(`.sc-prepared-count[data-lvl="${lvl}"]`);
    const listEl = panel.querySelector(`.sc-prepared-list[data-lvl="${lvl}"]`);
    if (!counter || !listEl) return;
    // If the Prepared column is hidden (spontaneous), suppress the
    // counter — it has nothing to count and the header isn't shown.
    const showPrepared = panel.querySelector('.sc-show-prepared')?.checked;
    if (!showPrepared) { counter.textContent = ''; return; }
    // If caller didn't pass totalSlots, read live from the slots table.
    if (totalSlots == null) {
      const perDay  = int(panel.querySelector(`.sc-per-day[data-lvl="${lvl}"]`)?.value);
      const bonus   = int(panel.querySelector(`.sc-bonus[data-lvl="${lvl}"]`)?.value);
      const domain  = int(panel.querySelector(`.sc-domain-slots[data-lvl="${lvl}"]`)?.value);
      const spec    = int(panel.querySelector(`.sc-specialist-slots[data-lvl="${lvl}"]`)?.value);
      totalSlots = perDay + bonus + domain + spec;
    }
    // No slots at this level — caster can't prepare here, hide.
    if (!totalSlots || totalSlots <= 0) { counter.textContent = ''; return; }
    let n = 0;
    listEl.querySelectorAll('.sc-prepared-row').forEach((r) => {
      const nameInp = r.querySelector('.sc-prep-name');
      if (nameInp && nameInp.value.trim()) n++;
    });
    counter.textContent = ` (${n} / ${totalSlots})`;
    counter.classList.toggle('sc-prepared-over', n > totalSlots);
    counter.classList.toggle('sc-prepared-under', n < totalSlots);
  }

  // Append `spellName` as a new structured row in the level's Prepared
  // list. v2 Phase C structural-restructure (2026-05-19): Prepared is no
  // longer a textarea — each spell is its own row with independent
  // metamagic state. The → button on a Known row goes through here.
  //
  // v2 Phase D (2026-05-21): consult the spell-picker's metamagic
  // tickboxes — if the user has any ticked when they click →, apply
  // them to the new Prepared row at the appropriately-bumped level.
  // Matches the user's mental model: tick metamagic in the picker,
  // then click → on a Known spell to prepare it WITH the ticked
  // metamagic (vs. having to switch to the picker's own +Prepared
  // button after selecting the spell again).
  function copyKnownToPrepared(panel, lvl, spellName) {
    const name = (spellName || "").trim();
    if (!name) return;
    const mm = collectPickerMetamagic(panel, lvl);
    addPreparedSpell(panel, mm.effectiveLevel, {
      baseName: name,
      metamagic: mm.featNames,
      heightenTarget: mm.heightenTarget,
      sanctumIn: false,
      used: false,
    });
  }

  // Pull the current metamagic-tickbox state from the panel's spell
  // picker. Returns `{ effectiveLevel, featNames: [], heightenTarget }`
  // — when no picker / no ticked metamagic, effectiveLevel is the
  // base level and featNames is empty (so the call sites get
  // pre-fix behavior).
  function collectPickerMetamagic(panel, baseLvl) {
    const empty = { effectiveLevel: baseLvl, featNames: [], heightenTarget: null };
    if (!panel) return empty;
    const picker = panel.querySelector('.spell-picker');
    if (!picker) return empty;
    const checks = picker.querySelectorAll('.sp-mm-check:checked');
    if (!checks.length) return empty;
    const featNames = [];
    let sumDelta = 0;
    let heightenTarget = null;
    for (const cb of checks) {
      const featName = cb.dataset.feat;
      if (!featName) continue;
      featNames.push(featName);
      const meta = lookupMetamagicFromDB(featName);
      if (!meta) continue;
      if (meta.levelAdjustment === 'variable') {
        // Heighten Spell pattern — read the per-feat target input.
        const num = picker.querySelector(
          `.sp-mm-target[data-feat="${CSS.escape(featName)}"]`);
        const t = parseInt(num?.value, 10);
        if (Number.isFinite(t)) heightenTarget = t;
      } else if (typeof meta.levelAdjustment === 'number'
                 && !isNaN(meta.levelAdjustment)) {
        sumDelta += meta.levelAdjustment;
      }
    }
    // Heighten replaces total when higher than the additive sum.
    let effectiveLevel = baseLvl + sumDelta;
    if (heightenTarget !== null) {
      effectiveLevel = Math.max(effectiveLevel, heightenTarget);
    }
    // Clamp to valid spell-level range so we don't try to insert a
    // L11 row that doesn't have a list element.
    effectiveLevel = Math.max(0, Math.min(9, effectiveLevel));
    return { effectiveLevel, featNames, heightenTarget };
  }

  // ⓘ rules panel — query the DB for the spell by name and render
  // school / casting time / range / target / save / SR / description.
  // Falls back gracefully when DB isn't loaded or the spell name has
  // no match (homebrew, typo, etc.).
  function toggleKnownRules(row, spellName) {
    const existing = row.querySelector(".sc-known-rules");
    const infoBtn = row.querySelector(".sc-known-info");
    if (existing) {
      existing.remove();
      infoBtn.classList.remove("active");
      return;
    }
    const name = (spellName || "").trim();
    if (!name) return;
    const rules = document.createElement("div");
    rules.className = "feat-rules sc-known-rules";
    rules.innerHTML = renderSpellRules(name);
    row.appendChild(rules);
    infoBtn.classList.add("active");
  }

  function renderSpellRules(name) {
    if (!window.DB || !DB.isLoaded()) {
      return `<i>DB not loaded — pickers unavailable.</i>`;
    }
    // Strip a trailing parenthetical (e.g. "Detect Magic (Lesser)" →
    // retry without if the first lookup misses) and try case-insensitive.
    let row = DB.queryOne(
      "SELECT id, data FROM entry WHERE type='spell' " +
      "AND name = :n COLLATE NOCASE LIMIT 1", { ":n": name });
    if (!row) {
      const stripped = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
      if (stripped && stripped !== name) {
        row = DB.queryOne(
          "SELECT id, data FROM entry WHERE type='spell' " +
          "AND name = :n COLLATE NOCASE LIMIT 1", { ":n": stripped });
      }
    }
    if (!row) {
      return `<i>No DB match for <b>${escapeAttr(name)}</b> ` +
             `(homebrew or unknown spell).</i>`;
    }
    let d;
    try { d = JSON.parse(row.data); } catch (e) { return `<i>Parse error.</i>`; }
    const bits = [];
    if (d.school) {
      const subs = [d.school];
      if (d.subschool) subs.push(`(${d.subschool})`);
      if (d.descriptor) subs.push(`[${d.descriptor}]`);
      bits.push(`<b>${escapeAttr(name)}:</b> ${escapeAttr(subs.join(" "))}`);
    } else {
      bits.push(`<b>${escapeAttr(name)}</b>`);
    }
    if (d.casting_time)     bits.push(`<b>Time:</b> ${escapeAttr(d.casting_time)}`);
    if (d.range)            bits.push(`<b>Range:</b> ${escapeAttr(d.range)}`);
    if (d.target)           bits.push(`<b>Target:</b> ${escapeAttr(d.target)}`);
    if (d.area)             bits.push(`<b>Area:</b> ${escapeAttr(d.area)}`);
    if (d.effect)           bits.push(`<b>Effect:</b> ${escapeAttr(d.effect)}`);
    if (d.duration)         bits.push(`<b>Duration:</b> ${escapeAttr(d.duration)}`);
    if (d.saving_throw)     bits.push(`<b>Save:</b> ${escapeAttr(d.saving_throw)}`);
    if (d.spell_resistance) bits.push(`<b>SR:</b> ${escapeAttr(d.spell_resistance)}`);
    let html = bits.join(" &nbsp;·&nbsp; ");
    if (d.description) {
      html += `<div style="margin-top:0.4rem">${escapeAttr(d.description)}</div>`;
    }
    return html;
  }
  function addSpellcastingLevel(panel) {
    const table = panel.querySelector(".spell-slots-table");
    const maxLevel = int(table?.dataset.maxLevel || 9) + 1;
    if (table) table.dataset.maxLevel = maxLevel;
    const i = maxLevel;

    // Add table row
    const domainVis = panel.querySelector(".sc-domain-toggle")?.checked ? "" : "display:none";
    const specVis = panel.querySelector(".sc-specialist-toggle")?.checked ? "" : "display:none";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${spellOrd(i)}</td>
      <td><input type="number" class="sc-known" data-lvl="${i}" min="0"></td>
      <td><span class="sc-dc calc-field" data-lvl="${i}">--</span></td>
      <td><input type="number" class="sc-per-day" data-lvl="${i}" min="0"></td>
      <td><input type="number" class="sc-bonus" data-lvl="${i}" min="0"></td>
      <td class="sc-domain-col" style="${domainVis}"><input type="number" class="sc-domain-slots" data-lvl="${i}" min="0"></td>
      <td class="sc-specialist-col" style="${specVis}"><input type="number" class="sc-specialist-slots" data-lvl="${i}" min="0"></td>
      <td><input type="number" class="sc-extra" data-lvl="${i}" min="0"
                 title="Extra slots from feats / items / irregular PrCs"></td>
      <td><input type="number" class="sc-used" data-lvl="${i}" min="0" value="0"></td>
      <td><span class="sc-remain calc-field" data-lvl="${i}">--</span></td>`;
    table.querySelector("tbody").appendChild(tr);

    appendDynLevelTab(panel, i);
    appendSpellListDiv(panel.querySelector(".sc-spell-lists"), i, false,
      panel._casterData || {});
  }
  function switchLevelTab(panel, btn, lvl) {
    panel.querySelectorAll(".spell-level-tab").forEach((t) => t.classList.remove("active"));
    panel.querySelectorAll(".spell-list-content").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    panel.querySelectorAll(".spell-list-content").forEach((c) => { if (c.dataset.level === String(lvl)) c.classList.add("active"); });
    setTimeout(() => window.autoExpandAll && window.autoExpandAll(), 10);
  }
  function appendDynLevelTab(panel, i) {
    const btn = document.createElement("button");
    btn.className = "spell-level-tab"; btn.dataset.level = i; btn.textContent = spellShort(i);
    btn.addEventListener("click", () => switchLevelTab(panel, btn, i));
    panel.querySelector(".spell-list-tabs").appendChild(btn);
  }
  function wireLevelTabs(panel) {
    panel.querySelectorAll(".spell-level-tab").forEach((btn) => {
      btn.addEventListener("click", () => switchLevelTab(panel, btn, btn.dataset.level));
    });
  }
  function wireSpecialistDomainToggles(panel) {
    const specToggle = panel.querySelector(".sc-specialist-toggle");
    const domToggle = panel.querySelector(".sc-domain-toggle");
    const specSection = panel.querySelector(".sc-specialist-section");
    const domSection = panel.querySelector(".sc-domain-section");

    function toggleColumns(panel, colClass, show) {
      panel.querySelectorAll(`.${colClass}`).forEach((el) => {
        el.style.display = show ? "" : "none";
      });
    }

    if (specToggle && specSection) {
      specToggle.addEventListener("change", () => {
        specSection.style.display = specToggle.checked ? "" : "none";
        toggleColumns(panel, "sc-specialist-col", specToggle.checked);
      });
    }
    if (domToggle && domSection) {
      domToggle.addEventListener("change", () => {
        domSection.style.display = domToggle.checked ? "" : "none";
        toggleColumns(panel, "sc-domain-col", domToggle.checked);
      });
    }

    // Show Prepared toggle — hides the prepared-spells textarea
    // (alongside its header) when unchecked. Spontaneous casters
    // typically uncheck this since they don't prepare spells daily.
    const prepToggle = panel.querySelector(".sc-show-prepared");
    if (prepToggle) {
      const applyPrep = () => {
        const show = prepToggle.checked;
        panel.classList.toggle("sc-no-prepared", !show);
      };
      prepToggle.addEventListener("change", applyPrep);
      applyPrep();  // apply initial state
    }
    // Show Spells Known toggle — hides the Known list column.
    // Cleric / Druid / other prepared-from-full-list casters (which
    // can prepare any spell on their class list without limit)
    // typically uncheck this.
    const knownToggle = panel.querySelector(".sc-show-known");
    if (knownToggle) {
      const applyKnown = () => {
        panel.classList.toggle("sc-no-known", !knownToggle.checked);
      };
      knownToggle.addEventListener("change", applyKnown);
      applyKnown();
    }

    // v2 Phase B trackers: Quickened-this-round reset + Sudden* daily
    // reset. Both live inside the Metamagic Reference details panel.
    const qReset = panel.querySelector(".sc-quickened-reset");
    if (qReset) {
      qReset.addEventListener("click", (e) => {
        e.preventDefault();
        const counter = panel.querySelector(".sc-quickened-this-round");
        if (counter) {
          counter.value = "0";
          counter.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
    }
    const dailyReset = panel.querySelector(".sc-mm-reset-daily");
    if (dailyReset) {
      dailyReset.addEventListener("click", (e) => {
        e.preventDefault();
        if (!window.MetamagicPreparer) return;
        const n = MetamagicPreparer.resetAllDailyUses();
        // Tiny inline confirmation that fades.
        const orig = dailyReset.textContent;
        dailyReset.textContent = n > 0
          ? `↻ Reset ${n} feat${n === 1 ? "" : "s"}`
          : "↻ No Sudden* uses to reset";
        setTimeout(() => { dailyReset.textContent = orig; }, 2000);
      });
    }

    // Wire prohibited schools add/remove
    wireProhibitedSchools(panel);
    // Wire dynamic domain entries
    wireDomainEntries(panel, panel._casterData || {});
  }
  function wireProhibitedSchools(panel) {
    const list = panel.querySelector(".sc-prohibited-list");
    if (!list) return;

    list.querySelector(".sc-add-prohibited").addEventListener("click", () => {
      addProhibitedEntry(list, "");
    });

    list.querySelectorAll(".sc-remove-prohibited").forEach((btn) => {
      btn.addEventListener("click", () => removeProhibitedEntry(btn));
    });
  }
  function addProhibitedEntry(list, value) {
    const div = document.createElement("div");
    div.className = "prohibited-entry";
    div.innerHTML = `<select class="sc-prohibited">${schoolOptionsHTML(value)}</select><button class="btn-remove sc-remove-prohibited" title="Remove">X</button>`;
    list.insertBefore(div, list.querySelector(".sc-add-prohibited"));
    div.querySelector(".sc-remove-prohibited").addEventListener("click", () => removeProhibitedEntry(div.querySelector(".sc-remove-prohibited")));
  }
  function removeProhibitedEntry(btn) {
    const list = btn.closest(".sc-prohibited-list");
    const entries = list.querySelectorAll(".prohibited-entry");
    if (entries.length <= 1) {
      // Keep at least one entry, just clear it (reset select to blank).
      entries[0].querySelector(".sc-prohibited").value = "";
      return;
    }
    btn.closest(".prohibited-entry").remove();
  }
  function addDomainEntry(container, data = {}) {
    const div = document.createElement("div");
    div.className = "domain-entry";
    div.innerHTML = `
      <div class="field"><label>Domain Name</label><input type="text" class="sc-domain-name" value="${data.name || ""}"></div>
      <div class="field"><label>Granted Power</label><textarea class="sc-domain-power" rows="2">${data.power || ""}</textarea></div>
      <button class="btn-remove sc-remove-domain" title="Remove">X</button>
    `;
    container.appendChild(div);
    div.querySelector(".sc-remove-domain").addEventListener("click", () => {
      const entries = container.querySelectorAll(".domain-entry");
      if (entries.length <= 1) {
        div.querySelector(".sc-domain-name").value = "";
        div.querySelector(".sc-domain-power").value = "";
        return;
      }
      div.remove();
    });
    const ta = div.querySelector(".sc-domain-power");
    if (window.autoExpand) window.autoExpand(ta);
  }
  function wireDomainEntries(panel, data = {}) {
    const container = panel.querySelector(".sc-domain-list");
    const addBtn = panel.querySelector(".sc-add-domain");
    if (!container || !addBtn) return;

    // Load data — support new array format and legacy domain1/domain2 format
    const domains = data.domains || [];
    if (domains.length > 0) {
      domains.forEach(d => addDomainEntry(container, d));
    } else if (data.domain1Name || data.domain2Name) {
      // Backwards compat: legacy hardcoded 2-domain format
      if (data.domain1Name || data.domain1Power) {
        addDomainEntry(container, { name: data.domain1Name || "", power: data.domain1Power || "" });
      }
      if (data.domain2Name || data.domain2Power) {
        addDomainEntry(container, { name: data.domain2Name || "", power: data.domain2Power || "" });
      }
      if (!container.children.length) addDomainEntry(container);
    } else {
      addDomainEntry(container);
      addDomainEntry(container);
    }

    addBtn.addEventListener("click", () => addDomainEntry(container));
  }
  // --- Psionics HTML builder ---
  // Base PP cost by power level (XPH Table 3-3)
  const PP_COSTS = [0, 1, 3, 5, 7, 9, 11, 13, 15, 17];

  function psiPPCost(i) { return PP_COSTS[i] !== undefined ? PP_COSTS[i] : (PP_COSTS[9] + (i - 9) * 2); }

  function buildPsionicsHTML(idx, data) {
    const maxLevel = data.maxLevel || 9;
    const dcRows = [];
    for (let i = 1; i <= maxLevel; i++) {
      dcRows.push(`<tr>
        <td>${spellOrd(i)}</td>
        <td class="psi-pp-cost">${psiPPCost(i)}</td>
        <td><span class="psi-dc calc-field" data-lvl="${i}">--</span></td>
      </tr>`);
    }

    const levelTabs = Array.from({ length: maxLevel }, (_, i) =>
      `<button class="spell-level-tab${i === 0 ? " active" : ""}" data-level="${i + 1}">${spellShort(i + 1)}</button>`
    ).join("");

    return `
      <section class="section">
        <h2>Psionics</h2>
        <div class="info-grid">
          <div class="field"><label>Primary Discipline</label><input type="text" class="psi-discipline" value="${data.discipline || ""}"></div>
          <div class="field field-sm"><label>Manifesting Ability</label><select class="psi-ability">${buildAbilityOptions(data.ability || "")}</select></div>
          <div class="field field-sm"><label>Manifester Level</label><input type="number" class="psi-manifester-level" min="1" value="${data.manifesterLevel || ""}"></div>
        </div>
        <div class="info-grid" style="margin-top:0.4rem">
          <div class="field field-sm"><label>Base PP</label><input type="number" class="psi-pp-base" min="0" value="${data.ppBase || ""}"></div>
          <div class="field field-sm"><label>Bonus PP</label><span class="psi-pp-bonus calc-field">--</span></div>
          <div class="field field-sm"><label>Extra PP</label><input type="number" class="psi-pp-extra" min="0" value="${data.ppExtra || ""}" placeholder="Items, etc."></div>
          <div class="field field-sm"><label>PP/Day</label><span class="psi-pp-day calc-field">--</span></div>
          <div class="field field-sm"><label>PP Spent</label><input type="number" class="psi-pp-spent" min="0" value="${data.ppSpent || "0"}"></div>
          <div class="field field-sm"><label>PP Remaining</label><span class="psi-pp-remaining calc-field">--</span></div>
          <div class="field field-sm"><label>Powers Known <span class="psi-known-count"></span></label><input type="number" class="psi-powers-known" min="0" value="${data.powersKnown || ""}"></div>
          <div class="field field-sm"><label>Max Power Level</label><input type="number" class="psi-max-level" min="1" max="9" value="${data.maxLevel || ""}"></div>
        </div>
        <div class="spellcasting-2col">
          <div class="spellcasting-list-col">
            <h3>Powers List</h3>
            <div class="spell-list-tabs">${levelTabs}</div>
            <div class="psi-power-lists"></div>
          </div>
          <div class="spellcasting-slot-col">
            <h3>PP Costs / DCs</h3>
            <table class="spell-slots-table psi-dc-table" data-max-level="${maxLevel}">
              <thead><tr><th>Lvl</th><th>PP</th><th>DC</th></tr></thead>
              <tbody>${dcRows.join("")}</tbody>
            </table>
            <button class="btn-add psi-add-level" style="margin-top:0.5rem">+ Add Power Level</button>
          </div>
        </div>
      </section>
    `;
  }
  function buildPsiPowerLists(idx, panel) {
    const container = panel.querySelector(".psi-power-lists");
    const maxLevel = int(panel.querySelector(".psi-dc-table")?.dataset.maxLevel || 9);
    for (let i = 1; i <= maxLevel; i++) {
      appendPsiPowerDiv(container, i, i === 1);
    }
    panel.querySelector(".psi-add-level").addEventListener("click", () => {
      addPsionicsLevel(panel);
    });
    // Refresh the Powers Known counter when the cap input changes
    // (so the over-cap red flash + "/N" suffix update live).
    const cap = panel.querySelector(".psi-powers-known");
    if (cap) cap.addEventListener("input", () =>
      updatePsionicsKnownCount(panel));
  }
  function appendPsiPowerDiv(container, i, active) {
    const div = document.createElement("div");
    div.className = `spell-list-content${active ? " active" : ""}`;
    div.dataset.level = i;
    // v2 Phase D (2026-05-21): replaced the per-level textarea with
    // a structured Known-powers list mirroring the spellcasting
    // pattern. Each row carries its own name input + ⓘ info toggle
    // + remove button. The power-picker's "+ Known" button appends
    // here via Spells.addKnownPower. Legacy textarea saves
    // (`power-${i}: "name1\nname2"`) migrate to rows on load.
    div.innerHTML = `
      <h3>${spellOrd(i)} Level Powers</h3>
      <div class="psi-known-list" data-lvl="${i}"></div>
      <button type="button" class="btn-add psi-add-known-row"
              data-lvl="${i}" style="margin-top:0.3rem">
        + Add Power
      </button>
    `;
    container.appendChild(div);
    div.querySelector(".psi-add-known-row").addEventListener("click", () => {
      const listEl = div.querySelector(`.psi-known-list[data-lvl="${i}"]`);
      const row = createPsiKnownRow(listEl, i, "");
      row.querySelector(".psi-known-name").focus();
    });
  }

  // Build one structured Known-powers row inside `listEl`. The row
  // mirrors createKnownRow's pattern: name input + ⓘ info button +
  // X remove. The ⓘ button toggles an inline rules panel rendered
  // by renderPowerRules. Called from:
  //   - The per-level "+ Add Power" button (empty row)
  //   - power-picker.js via Spells.addKnownPower (pre-filled)
  //   - loadData migration (one row per legacy text-N line)
  function createPsiKnownRow(listEl, lvl, powerName) {
    const row = document.createElement("div");
    row.className = "psi-known-row sc-known-row"; // share the sc-* styling
    row.innerHTML =
      `<input type="text" class="psi-known-name sc-known-name" ` +
      `list="power-options" autocomplete="off" ` +
      `value="${escapeAttr(powerName || "")}" placeholder="Power name">` +
      `<button class="btn-feat-info psi-known-info sc-known-info" ` +
      `title="Show rules">ⓘ</button>` +
      `<button class="btn-remove psi-known-remove sc-known-remove" ` +
      `title="Remove">X</button>`;
    listEl.appendChild(row);
    const nameInput = row.querySelector(".psi-known-name");
    const infoBtn   = row.querySelector(".psi-known-info");
    const rmBtn     = row.querySelector(".psi-known-remove");
    const panel = listEl.closest(".inner-tab-content");
    nameInput.addEventListener("input", () => {
      // Collapse stale rules panel — the row's power identity may
      // have changed.
      const existing = row.querySelector(".psi-known-rules");
      if (existing) existing.remove();
      infoBtn.classList.remove("active");
      updatePsionicsKnownCount(panel);
    });
    infoBtn.addEventListener("click", () =>
      togglePowerRules(row, nameInput.value));
    rmBtn.addEventListener("click", () => {
      row.remove();
      updatePsionicsKnownCount(panel);
    });
    updatePsionicsKnownCount(panel);
    return row;
  }

  // Total all Known-power rows across every level on the panel and
  // surface the count next to the Powers Known input. Mirrors
  // updateKnownCount's color cue: red when count exceeds the cap.
  function updatePsionicsKnownCount(panel) {
    if (!panel) return;
    const counter = panel.querySelector(".psi-known-count");
    if (!counter) return;
    let count = 0;
    panel.querySelectorAll(".psi-known-row .psi-known-name").forEach((el) => {
      if (el.value && el.value.trim()) count++;
    });
    const capEl = panel.querySelector(".psi-powers-known");
    const cap = capEl && capEl.value !== "" ? parseInt(capEl.value, 10) : null;
    if (cap !== null && !isNaN(cap)) {
      counter.textContent = ` (${count} / ${cap})`;
      counter.classList.toggle("sc-known-over", count > cap);
    } else if (count > 0) {
      counter.textContent = ` (${count})`;
      counter.classList.remove("sc-known-over");
    } else {
      counter.textContent = "";
      counter.classList.remove("sc-known-over");
    }
  }

  // ⓘ rules panel for a Known-power row — query the DB by name and
  // render discipline / display / PP / range / target / save / PR /
  // augment / description. Mirrors toggleKnownRules but for powers.
  function togglePowerRules(row, powerName) {
    const existing = row.querySelector(".psi-known-rules");
    const infoBtn = row.querySelector(".psi-known-info");
    if (existing) {
      existing.remove();
      infoBtn.classList.remove("active");
      return;
    }
    const name = (powerName || "").trim();
    if (!name) return;
    const rules = document.createElement("div");
    rules.className = "feat-rules psi-known-rules sc-known-rules";
    rules.innerHTML = renderPowerRules(name);
    row.appendChild(rules);
    infoBtn.classList.add("active");
  }

  function renderPowerRules(name) {
    if (!window.DB || !DB.isLoaded()) {
      return `<i>DB not loaded — pickers unavailable.</i>`;
    }
    // Strip a trailing parenthetical (e.g. "Energy Bolt (Fire)" →
    // retry without if first lookup misses) and try case-insensitive.
    let row = DB.queryOne(
      "SELECT id, data FROM entry WHERE type='power' " +
      "AND name = :n COLLATE NOCASE LIMIT 1", { ":n": name });
    if (!row) {
      const stripped = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
      if (stripped && stripped !== name) {
        row = DB.queryOne(
          "SELECT id, data FROM entry WHERE type='power' " +
          "AND name = :n COLLATE NOCASE LIMIT 1", { ":n": stripped });
      }
    }
    if (!row) {
      return `<i>No DB match for <b>${escapeAttr(name)}</b> ` +
             `(homebrew or unknown power).</i>`;
    }
    let d;
    try { d = JSON.parse(row.data); } catch (e) { return `<i>Parse error.</i>`; }
    const bits = [];
    // Title line: power name + discipline label
    const disc = d.discipline || "";
    bits.push(`<b>${escapeAttr(name)}</b>` +
      (disc ? ` <span style="opacity:.7">[${escapeAttr(disc)}]</span>` : ""));
    // Class/level mapping (e.g. "Psion/Wilder 3, Telepath 3")
    if (d.level && typeof d.level === "object") {
      const lvls = Object.entries(d.level)
        .map(([c, l]) => `${c} ${l}`).join(", ");
      if (lvls) bits.push(`<b>Level:</b> ${escapeAttr(lvls)}`);
    }
    if (d.display)           bits.push(`<b>Display:</b> ${escapeAttr(d.display)}`);
    if (d.manifesting_time)  bits.push(`<b>Manifesting:</b> ${escapeAttr(d.manifesting_time)}`);
    if (d.range)             bits.push(`<b>Range:</b> ${escapeAttr(d.range)}`);
    if (d.target)            bits.push(`<b>Target:</b> ${escapeAttr(d.target)}`);
    if (d.area)              bits.push(`<b>Area:</b> ${escapeAttr(d.area)}`);
    if (d.effect)            bits.push(`<b>Effect:</b> ${escapeAttr(d.effect)}`);
    if (d.duration)          bits.push(`<b>Duration:</b> ${escapeAttr(d.duration)}`);
    if (d.saving_throw)      bits.push(`<b>Save:</b> ${escapeAttr(d.saving_throw)}`);
    if (d.power_resistance)  bits.push(`<b>PR:</b> ${escapeAttr(d.power_resistance)}`);
    if (d.power_points)      bits.push(`<b>PP:</b> ${escapeAttr(d.power_points)}`);
    let html = bits.join(" &nbsp;·&nbsp; ");
    if (d.augment) {
      html += `<div style="margin-top:0.4rem"><b>Augment:</b> ` +
              `${escapeAttr(d.augment)}</div>`;
    }
    if (d.description) {
      html += `<div style="margin-top:0.4rem">${escapeAttr(d.description)}</div>`;
    }
    return html;
  }

  // Public-API helper for power-picker.js to append a structured row
  // into the psionics panel's Known list. Returns the row element.
  function addKnownPower(listEl, lvl, powerName) {
    return createPsiKnownRow(listEl, lvl, powerName);
  }
  function addPsionicsLevel(panel) {
    const table = panel.querySelector(".psi-dc-table");
    const maxLevel = int(table?.dataset.maxLevel || 9) + 1;
    if (table) table.dataset.maxLevel = maxLevel;
    const i = maxLevel;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${spellOrd(i)}</td><td class="psi-pp-cost">${psiPPCost(i)}</td><td><span class="psi-dc calc-field" data-lvl="${i}">--</span></td>`;
    table.querySelector("tbody").appendChild(tr);

    appendDynLevelTab(panel, i);

    appendPsiPowerDiv(panel.querySelector(".psi-power-lists"), i, false);
  }
  // --- Tome of Battle Maneuvers HTML builder ---
  function buildManeuversHTML(idx, data) {
    const levelTabs = SPELL_SHORT.slice(1).map((label, i) =>
      `<button class="spell-level-tab${i === 0 ? " active" : ""}" data-level="${i + 1}">${label}</button>`
    ).join("");

    return `
      <section class="section">
        <h2>Martial Maneuvers</h2>
        <div class="info-grid">
          <div class="field field-sm"><label>Initiator Level</label><input type="number" class="tom-init-level" min="1" value="${data.initLevel || ""}"></div>
          <div class="field field-sm"><label>Maneuvers Known</label><input type="number" class="tom-known-count" min="0" value="${data.knownCount || ""}"></div>
          <div class="field field-sm"><label>Maneuvers Readied</label><input type="number" class="tom-readied-count" min="0" value="${data.readiedCount || ""}"></div>
          <div class="field field-sm"><label>Stances Known</label><input type="number" class="tom-stances-count" min="0" value="${data.stancesCount || ""}"></div>
        </div>
      </section>
      <section class="section">
        <h2>Known Maneuvers & Stances</h2>
        <div class="spell-list-tabs">${levelTabs}</div>
        <div class="tom-maneuver-lists"></div>
      </section>
      <section class="section">
        <h2>Readied Maneuvers</h2>
        <div class="tom-readied-list"></div>
        <div style="display:flex;gap:0.5rem;margin-top:0.3rem">
          <button class="btn-add tom-add-readied">+ Add Readied Maneuver</button>
          <button class="btn-add tom-reset-readied">Reset Expended</button>
        </div>
      </section>
    `;
  }
  function addReadiedManeuver(container, data = {}) {
    const row = document.createElement("div");
    row.className = "tom-readied-row";
    row.innerHTML = `
      <label class="tom-expended-label" title="Expended">
        <input type="checkbox" class="tom-expended"${data.expended ? " checked" : ""}>
      </label>
      <input type="text" class="tom-readied-name" placeholder="Maneuver name" value="${data.name || ""}">
      <textarea class="tom-readied-desc" rows="1" placeholder="Description / notes">${data.desc || ""}</textarea>
      <button class="btn-remove tom-remove-readied" title="Remove">X</button>
    `;
    container.appendChild(row);
    row.querySelector(".tom-remove-readied").addEventListener("click", () => row.remove());
    const cb = row.querySelector(".tom-expended");
    cb.addEventListener("change", () => row.classList.toggle("expended", cb.checked));
    if (data.expended) row.classList.add("expended");
    const ta = row.querySelector(".tom-readied-desc");
    if (window.autoExpand) window.autoExpand(ta);
  }
  function wireReadiedManeuvers(panel, data = {}) {
    const container = panel.querySelector(".tom-readied-list");
    const addBtn = panel.querySelector(".tom-add-readied");
    const resetBtn = panel.querySelector(".tom-reset-readied");

    // Load existing data (backwards compat: old string format → convert)
    const readiedArr = data.readiedManeuvers || [];
    if (readiedArr.length > 0) {
      readiedArr.forEach(m => addReadiedManeuver(container, m));
    } else if (data.readied && typeof data.readied === "string" && data.readied.trim()) {
      // Backwards compat: old single textarea format — split lines into entries
      data.readied.split("\n").filter(l => l.trim()).forEach(line => {
        addReadiedManeuver(container, { name: line.trim() });
      });
    } else {
      addReadiedManeuver(container);
    }

    addBtn.addEventListener("click", () => addReadiedManeuver(container));
    resetBtn.addEventListener("click", () => {
      container.querySelectorAll(".tom-expended").forEach(cb => { cb.checked = false; });
      container.querySelectorAll(".tom-readied-row").forEach(r => r.classList.remove("expended"));
    });
  }
  function buildManeuverLists(idx, panel) {
    const container = panel.querySelector(".tom-maneuver-lists");
    for (let i = 1; i <= 9; i++) {
      const div = document.createElement("div");
      div.className = `spell-list-content${i === 1 ? " active" : ""}`;
      div.dataset.level = i;
      div.innerHTML = `
        <div class="two-column">
          <div class="column">
            <h3>${SPELL_LABELS[i]} Level - Known Maneuvers</h3>
            <textarea class="tom-maneuver-text" data-lvl="${i}" rows="8" placeholder="Enter ${SPELL_LABELS[i]} level maneuvers, one per line..."></textarea>
          </div>
          <div class="column">
            <h3>${SPELL_LABELS[i]} Level - Known Stances</h3>
            <textarea class="tom-stance-text" data-lvl="${i}" rows="8" placeholder="Enter ${SPELL_LABELS[i]} level stances, one per line..."></textarea>
          </div>
        </div>
      `;
      container.appendChild(div);
    }
  }
  // --- Epic Spellcasting HTML builder ---
  function buildEpicHTML(idx, data) {
    const spellRows = (data.epicSpells || [""]).map((s, i) => epicSpellRow(s, i)).join("");
    return `
      <section class="section">
        <h2>Epic Spellcasting</h2>
        <div class="info-grid">
          <div class="field"><label>Slot Skill (ranks ÷ 10)</label><select class="epic-skill">
            <option value="know-arcana"${(data.epicSkill || "know-arcana") === "know-arcana" ? " selected" : ""}>Knowledge (Arcana)</option>
            <option value="know-religion"${data.epicSkill === "know-religion" ? " selected" : ""}>Knowledge (Religion)</option>
            <option value="know-nature"${data.epicSkill === "know-nature" ? " selected" : ""}>Knowledge (Nature)</option>
          </select></div>
          <div class="field field-sm"><label>Skill Ranks</label><input type="number" class="epic-skill-ranks" min="0" value="${data.epicSkillRanks || ""}"></div>
          <div class="field field-sm"><label>Slots/Day</label><span class="epic-slots-day calc-field">--</span></div>
          <div class="field field-sm"><label>Slots Used</label><input type="number" class="epic-slots-used" min="0" value="${data.epicSlotsUsed || "0"}"></div>
          <div class="field field-sm"><label>Remaining</label><span class="epic-slots-remain calc-field">--</span></div>
        </div>
        <div class="info-grid" style="margin-top:0.4rem">
          <div class="field field-sm"><label>Spellcraft Ranks</label><input type="number" class="epic-spellcraft" min="0" value="${data.epicSpellcraft || ""}" placeholder="For seed DCs"></div>
          <div class="field"><label>Conditional Modifiers</label><textarea class="epic-conditional" rows="1">${data.epicConditional || ""}</textarea></div>
        </div>
      </section>
      <section class="section">
        <h2>Epic Spells</h2>
        <div class="epic-spell-list">${spellRows}</div>
        <button class="btn-add epic-add-spell" style="margin-top:0.5rem">+ Add Epic Spell</button>
      </section>
    `;
  }
  function epicSpellRow(data = "", index = 0) {
    const d = typeof data === "object" ? data : { name: data };
    return `<div class="epic-spell-entry">
      <div class="field" style="flex:1"><label>Spell Name</label><input type="text" class="epic-spell-name" value="${d.name || ""}"></div>
      <div class="field field-sm"><label>DC</label><input type="number" class="epic-spell-dc" value="${d.dc || ""}"></div>
      <div class="field" style="flex:2"><label>Effect / Notes</label><textarea class="epic-spell-notes" rows="1">${d.notes || ""}</textarea></div>
      <button class="btn-remove epic-remove-spell" title="Remove">X</button>
    </div>`;
  }
  function wireEpicSpells(panel) {
    panel.querySelector(".epic-add-spell").addEventListener("click", () => {
      const list = panel.querySelector(".epic-spell-list");
      const div = document.createElement("div");
      div.innerHTML = epicSpellRow();
      const entry = div.firstElementChild;
      list.appendChild(entry);
      entry.querySelector(".epic-remove-spell").addEventListener("click", () => entry.remove());
    });
    panel.querySelectorAll(".epic-remove-spell").forEach((btn) => {
      btn.addEventListener("click", () => btn.closest(".epic-spell-entry").remove());
    });
  }
  // --- Vestige Binding HTML builder ---
  function buildBindingHTML(idx, data) {
    const vestigeRows = (data.vestiges || [""]).map((v, i) => vestigeRow(v)).join("");
    return `
      <section class="section">
        <h2>Vestige Binding</h2>
        <div class="info-grid">
          <div class="field field-sm"><label>Effective Binder Level</label><input type="number" class="bind-level" min="1" value="${data.binderLevel || ""}"></div>
          <div class="field field-sm"><label>Max Vestige Level</label><input type="number" class="bind-max-vestige" min="1" max="8" value="${data.maxVestige || ""}"></div>
          <div class="field field-sm"><label>Max Vestiges Bound</label><input type="number" class="bind-max-bound" min="1" value="${data.maxBound || ""}"></div>
          <div class="field field-sm"><label>Binding Check Mod</label><input type="number" class="bind-check-mod" value="${data.bindCheckMod || ""}"></div>
        </div>
        <div class="info-grid" style="margin-top:0.4rem">
          <div class="field field-sm"><label>Currently Bound</label><span class="bind-count calc-field">0</span></div>
          <div class="field"><label>Conditional Modifiers</label><textarea class="bind-conditional" rows="1">${data.bindConditional || ""}</textarea></div>
        </div>
      </section>
      <section class="section">
        <h2>Bound Vestiges</h2>
        <div class="vestige-list">${vestigeRows}</div>
        <button class="btn-add bind-add-vestige" style="margin-top:0.5rem">+ Add Vestige</button>
      </section>
    `;
  }
  function vestigeRow(data = "") {
    const d = typeof data === "object" ? data : { name: data };
    return `<div class="vestige-entry">
      <div class="vestige-header">
        <div class="field" style="flex:1"><label>Vestige Name</label><input type="text" class="vestige-name" value="${d.name || ""}"></div>
        <div class="field field-sm"><label>Level</label><input type="number" class="vestige-level" min="1" max="8" value="${d.level || ""}"></div>
        <div class="field field-sm"><label>Binding DC</label><input type="number" class="vestige-dc" value="${d.dc || ""}"></div>
        <label class="mi-toggle"><input type="checkbox" class="vestige-good-pact"${d.goodPact ? " checked" : ""}> Good Pact</label>
        <button class="btn-remove bind-remove-vestige" title="Remove">X</button>
      </div>
      <div class="field"><label>Granted Abilities</label><textarea class="vestige-abilities" rows="2">${d.abilities || ""}</textarea></div>
      <div class="vestige-pact-info" style="${d.goodPact ? "display:none" : ""}">
        <div class="field"><label>Sign &amp; Influence</label><input type="text" class="vestige-sign" value="${d.sign || ""}"></div>
      </div>
    </div>`;
  }
  function wireBindingVestiges(panel) {
    panel.querySelector(".bind-add-vestige").addEventListener("click", () => {
      const list = panel.querySelector(".vestige-list");
      const div = document.createElement("div");
      div.innerHTML = vestigeRow();
      const entry = div.firstElementChild;
      list.appendChild(entry);
      wireVestigeEntry(entry);
      recalcBindCount(panel);
    });
    panel.querySelectorAll(".vestige-entry").forEach((entry) => wireVestigeEntry(entry));
  }
  function wireVestigeEntry(entry) {
    entry.querySelector(".bind-remove-vestige").addEventListener("click", () => {
      const panel = entry.closest(".inner-tab-content");
      entry.remove();
      recalcBindCount(panel);
    });
    const goodPact = entry.querySelector(".vestige-good-pact");
    const pactInfo = entry.querySelector(".vestige-pact-info");
    goodPact.addEventListener("change", () => {
      pactInfo.style.display = goodPact.checked ? "none" : "";
    });
  }
  function recalcBindCount(panel) {
    const count = panel.querySelectorAll(".vestige-entry").length;
    const el = panel.querySelector(".bind-count");
    const max = int(panel.querySelector(".bind-max-bound")?.value);
    if (el) {
      el.textContent = count;
      el.classList.toggle("counter-over", max > 0 && count > max);
    }
  }

  // --- Invocations (Warlock / Dragonfire Adept / etc.) ----------------
  //
  // Invocations are graded — Least / Lesser / Greater / Dark — and
  // a Warlock-style class knows a fixed number per grade. We render
  // a tabbed list per grade with a Known textarea each, mirroring the
  // maneuver / spell pattern. The invocation-picker (per-panel) wires
  // a picker bar above the tabs so the player can filter + insert.
  //
  // No DCs / per-day tracking because Warlock invocations are at-will;
  // a "Caster Level" field is enough for save-DC calculations the
  // user does manually (10 + spell-level-equivalent + CHA).
  const INVOCATION_GRADES = ['Least', 'Lesser', 'Greater', 'Dark'];

  // Dragonfire Adept panels get an extra "Breath Effects" tab — those DB
  // entries are grade='Breath Effect' with a minimum_level, distinct from
  // the four invocation grades. Warlock panels keep the standard four.
  function invoGradesFor(data) {
    return (data && data.invoClass === 'Dragonfire Adept')
      ? INVOCATION_GRADES.concat(['Breath Effect'])
      : INVOCATION_GRADES;
  }

  function buildInvocationsHTML(idx, data) {
    const gradeTabs = invoGradesFor(data).map((g, i) =>
      `<button class="spell-level-tab${i === 0 ? " active" : ""}" data-level="${i}">${g === 'Breath Effect' ? 'Breath Effects' : g}</button>`
    ).join("");
    return `
      <section class="section">
        <h2>Invocations</h2>
        <div class="info-grid">
          <div class="field field-sm"><label>Invoker Level</label><input type="number" class="invo-level" min="1" value="${data.invokerLevel || ""}"></div>
          <div class="field field-sm"><label>Caster Level</label><input type="number" class="invo-caster-level" min="1" value="${data.casterLevel || ""}" title="For save DCs, dispels, etc. Usually = invoker level."></div>
          <div class="field field-sm"><label>Highest Grade</label><input type="text" class="invo-highest-grade" value="${data.highestGrade || ""}" placeholder="e.g. Greater"></div>
          <div class="field field-sm"><label>Invocations Known</label><input type="number" class="invo-known-count" min="0" value="${data.knownCount || ""}"></div>
          <div class="field"><label>Conditional Modifiers</label><textarea class="invo-conditional" rows="1">${data.conditional || ""}</textarea></div>
        </div>
      </section>
      <section class="section">
        <h2>Known Invocations</h2>
        <div class="spell-list-tabs">${gradeTabs}</div>
        <div class="invo-grade-lists"></div>
      </section>
    `;
  }

  function buildInvocationLists(idx, panel) {
    const container = panel.querySelector(".invo-grade-lists");
    const data = panel._casterData || {};
    invoGradesFor(data).forEach((grade, i) => {
      const gradeKey = grade.toLowerCase();
      const isBreath = grade === 'Breath Effect';
      const div = document.createElement("div");
      div.className = `spell-list-content${i === 0 ? " active" : ""}`;
      div.dataset.level = i;
      const heading = isBreath ? 'Breath Effects' : `${grade} Invocations`;
      const addLbl = isBreath ? '+ Add Breath Effect' : '+ Add Invocation';
      div.innerHTML = `
        <h3>${heading}</h3>
        <div class="invo-known-list" data-grade="${gradeKey}"></div>
        <button class="btn-add invo-add-known" data-grade="${gradeKey}" style="margin-top:0.3rem">${addLbl}</button>
      `;
      container.appendChild(div);
      // Populate rows: prefer the structured invoList-<grade> array;
      // migrate a legacy invo-<grade> textarea string (one name per line).
      const list = div.querySelector(".invo-known-list");
      let names = [];
      const arr = data[`invoList-${gradeKey}`];
      if (Array.isArray(arr)) {
        names = arr.filter(Boolean);
      } else if (typeof data[`invo-${gradeKey}`] === "string") {
        names = data[`invo-${gradeKey}`].split(/\r?\n/)
          .map(s => s.trim()).filter(Boolean);
      }
      names.forEach(n => createInvoRow(list, gradeKey, n));
      div.querySelector(".invo-add-known").addEventListener("click", () => {
        const row = createInvoRow(list, gradeKey, "");
        row.querySelector(".invo-known-name").focus();
      });
    });
  }

  // Build a single Known-invocation row (name input + ⓘ rules + ×),
  // mirroring createKnownRow. The ⓘ panel reads the DB at click time.
  function createInvoRow(listEl, gradeKey, name) {
    const row = document.createElement("div");
    row.className = "sc-known-row invo-known-row";
    row.innerHTML =
      `<input type="text" class="invo-known-name" autocomplete="off" ` +
      `value="${escapeAttr(name)}" placeholder="Invocation name">` +
      `<button class="btn-feat-info invo-known-info" title="Show rules">&#9432;</button>` +
      `<button class="btn-remove invo-known-remove" title="Remove">X</button>`;
    listEl.appendChild(row);
    const nameInput = row.querySelector(".invo-known-name");
    const infoBtn   = row.querySelector(".invo-known-info");
    const rmBtn     = row.querySelector(".invo-known-remove");
    nameInput.addEventListener("input", () => {
      const ex = row.querySelector(".invo-known-rules");
      if (ex) ex.remove();
      infoBtn.classList.remove("active");
    });
    infoBtn.addEventListener("click", () => toggleInvoRules(row, nameInput.value));
    rmBtn.addEventListener("click", () => row.remove());
    return row;
  }

  function toggleInvoRules(row, name) {
    const existing = row.querySelector(".invo-known-rules");
    const infoBtn = row.querySelector(".invo-known-info");
    if (existing) { existing.remove(); infoBtn.classList.remove("active"); return; }
    if (!(name || "").trim()) return;
    const rules = document.createElement("div");
    rules.className = "feat-rules invo-known-rules";
    rules.innerHTML = renderInvocationRules(name.trim());
    row.appendChild(rules);
    infoBtn.classList.add("active");
  }

  // ⓘ rules panel for an invocation — grade / class access / minimum
  // level / spell-level-equiv / description. Mirrors renderSpellRules.
  function renderInvocationRules(name) {
    if (!window.DB || !DB.isLoaded()) return `<i>DB not loaded.</i>`;
    let row = DB.queryOne(
      "SELECT id, data FROM entry WHERE type='invocation' " +
      "AND name = :n COLLATE NOCASE LIMIT 1", { ":n": name });
    if (!row) {
      const stripped = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
      if (stripped && stripped !== name) {
        row = DB.queryOne(
          "SELECT id, data FROM entry WHERE type='invocation' " +
          "AND name = :n COLLATE NOCASE LIMIT 1", { ":n": stripped });
      }
    }
    if (!row) {
      return `<i>No DB match for <b>${escapeAttr(name)}</b> ` +
             `(homebrew or unknown invocation).</i>`;
    }
    let d;
    try { d = JSON.parse(row.data); } catch (e) { return `<i>Parse error.</i>`; }
    const isBreath = d.grade === 'Breath Effect';
    const bits = [`<b>${escapeAttr(name)}</b>`];
    const meta = [
      d.grade && (isBreath ? 'Breath Effect' : `${d.grade} invocation`),
      d.minimum_level != null ? `min. class level ${d.minimum_level}` : null,
      d.spell_level_equivalent != null ? `lvl-equiv ${d.spell_level_equivalent}` : null,
      (d.subcategory && d.subcategory !== d.grade) ? d.subcategory : null,
    ].filter(Boolean).map(escapeAttr).join(" · ");
    if (meta) bits.push(meta);
    let html = bits.join("<br>");
    if (d.description) {
      html += `<div style="margin-top:0.4rem">${escapeAttr(d.description)}</div>`;
    }
    return html;
  }

  // Public helper for invocation-picker's "+ Known": add a row to the
  // matching grade list, de-duped by name. Returns the row (or null).
  function addInvocationKnown(panel, gradeKey, name) {
    const list = panel && panel.querySelector(
      `.invo-known-list[data-grade="${gradeKey}"]`);
    if (!list || !name) return null;
    const exists = Array.from(list.querySelectorAll(".invo-known-name"))
      .some(inp => inp.value.trim().toLowerCase() === name.trim().toLowerCase());
    if (exists) return null;
    return createInvoRow(list, gradeKey, name);
  }

  // --- Recalculate DCs and slot tracking for all casters ---
  function recalc(getAbilityMod) {
    if (getAbilityMod) _getAbilityMod = getAbilityMod;
    // Fall back to the cached ability-mod accessor when called without
    // args (e.g. from intra-module live-update handlers).
    const abilityModFn = getAbilityMod || _getAbilityMod;
    // Get arcane spell failure from character tab
    const spellFail = int($("#arcane-spell-failure")?.value);

    // Item Familiar bonus spell slots (UA p.171): collect once per
    // recalc since the same global pool applies to all panels (matched
    // by panel-label substring). Each invested slot of level N grants
    // a bonus slot of level N-2 in the same class.
    const allIfamBonuses = (typeof ItemFamiliar !== "undefined"
      && ItemFamiliar.getAllSpellSlotBonuses)
      ? ItemFamiliar.getAllSpellSlotBonuses() : [];

    // Spellcasting sub-tabs
    $$("[data-caster-type='spellcasting']").forEach((panel) => {
      const ability = panel.querySelector(".sc-ability")?.value || "";
      const abilityMod = ability && abilityModFn ? abilityModFn(ability) : 0;
      // Match this panel's class name against the item-familiar
      // invested-slot rows. Liberal: panel-tab-label or notes
      // containing the class name (case-insensitive substring) hits.
      const idx = (panel.id || "").replace(/^caster-/, "");
      const tabBtn = document.querySelector(`.inner-tab[data-caster-idx="${idx}"]`);
      const panelLabel = (tabBtn ? tabBtn.textContent.replace("×","").trim() : "").toLowerCase();
      const panelNotes = (panel.querySelector(".caster-notes")?.value || "").toLowerCase();
      const panelIdentity = panelLabel + " " + panelNotes;
      const ifamBonusesByLevel = {};
      for (const b of allIfamBonuses) {
        if (panelIdentity.includes(b.class.toLowerCase())) {
          ifamBonusesByLevel[b.bonusLevel] = (ifamBonusesByLevel[b.bonusLevel] || 0) + 1;
        }
      }
      // M-dual (2026-05-16): bonus spells per day can come from a
      // DIFFERENT ability than spell DCs for a handful of classes —
      // Favored Soul (CHA bonus / WIS DC) and Spirit Shaman (WIS
      // bonus / CHA DC) are the canonical 3.5 cases. The
      // `.sc-bonus-ability` select is an optional override; when
      // blank, bonus spells fall back to the main spellcasting
      // ability (the common case).
      const bonusAbilityOverride = panel.querySelector(".sc-bonus-ability")?.value || "";
      const bonusAbility = bonusAbilityOverride || ability;
      const bonusAbilityMod = bonusAbility && abilityModFn ? abilityModFn(bonusAbility) : 0;
      const failEl = panel.querySelector(".sc-spell-fail");
      if (failEl) failEl.textContent = spellFail + "%";
      const maxLevel = int(panel.querySelector(".spell-slots-table")?.dataset.maxLevel || 9);

      // Classes whose "spells" never allow saving throws (Artificer
      // infusions) get "—" in the DC column instead of the computed
      // 10 + level + key-ability mod. Stamped on the panel by
      // class-picker.js when the class is applied.
      const noSaveDc = panel.dataset.noSaveDc === '1';

      for (let i = 0; i <= maxLevel; i++) {
        const dcEl = panel.querySelector(`.sc-dc[data-lvl="${i}"]`);
        if (dcEl) {
          if (noSaveDc) dcEl.textContent = '—';
          else dcEl.textContent = ability ? 10 + i + abilityMod : "--";
        }

        // Auto-fill bonus spell slots from the BONUS-SPELL ability
        // modifier (PHB Table 1-1). For most classes that's the same
        // as the spellcasting ability, but Favored Soul (CHA bonus,
        // WIS DC) and Spirit Shaman (WIS bonus, CHA DC) split them —
        // use the .sc-bonus-ability override when set.
        // Spell level N gets +1 bonus slot when the relevant mod >=
        // N, plus +1 for every 4 mod points above N. Cantrips never
        // get bonus slots.
        //
        // We track the previously auto-filled value on the element's
        // dataset; if the current input matches the stored auto value
        // (or is empty), the user hasn't manually overridden, and
        // we update. Anything else is a manual edit and we leave it.
        const bonusEl = panel.querySelector(`.sc-bonus[data-lvl="${i}"]`);
        if (bonusEl && bonusAbility) {
          const autoVal = (i >= 1 && bonusAbilityMod >= i)
            ? Math.floor((bonusAbilityMod - i) / 4) + 1
            : 0;
          const displayVal = autoVal > 0 ? String(autoVal) : "";
          const lastAuto = bonusEl.dataset.autoBonus ?? "";
          const current = bonusEl.value;
          if (current === "" || current === lastAuto) {
            bonusEl.value = displayVal;
            bonusEl.dataset.autoBonus = displayVal;
          }
        }
        const perDay = int(panel.querySelector(`.sc-per-day[data-lvl="${i}"]`)?.value);
        const bonus = int(panel.querySelector(`.sc-bonus[data-lvl="${i}"]`)?.value);
        const domain = int(panel.querySelector(`.sc-domain-slots[data-lvl="${i}"]`)?.value);
        const specialist = int(panel.querySelector(`.sc-specialist-slots[data-lvl="${i}"]`)?.value);
        // Extra slots from feats / irregular PrCs / items. Unlike
        // `bonus` (auto-filled from ability mod and gated on base
        // castability), `extra` is purely user-controlled and never
        // overwritten — the rebuild-killer use case is "I have +1
        // L3 slot from Bracers of Wizardry that I want to track."
        // Counted toward the total even when base perDay is 0 (some
        // sources grant access to levels you can't normally cast).
        const extra = int(panel.querySelector(`.sc-extra[data-lvl="${i}"]`)?.value);
        const used = int(panel.querySelector(`.sc-used[data-lvl="${i}"]`)?.value);
        // PHB Bonus Spells sidebar: "You can only receive bonus spells
        // of a level you can already cast." If base `perDay` is 0 and
        // there's no domain/specialist slot at this level either, the
        // caster can't cast at level N — so the ability-mod bonus
        // contributes 0. Without this gate, a Wizard 5 with INT 18
        // would show a phantom L4 slot (base 0, bonus +1) even though
        // Wizard L4 access starts at class level 7.
        const baseCastable = (perDay + domain + specialist) > 0;
        const effectiveBonus = baseCastable ? bonus : 0;
        // Item Familiar bonus slots (UA p.171). Stack with the regular
        // pool — the user can use them like any other slot.
        const ifamBonus = ifamBonusesByLevel[i] || 0;
        const totalSlots = perDay + effectiveBonus + domain + specialist + extra + ifamBonus;
        const remaining = totalSlots - used;
        const el = panel.querySelector(`.sc-remain[data-lvl="${i}"]`);
        if (el) {
          const row = el.closest("tr");
          if (totalSlots > 0) {
            el.textContent = remaining;
            el.classList.remove("spell-remain-zero", "spell-remain-low");
            if (row) row.classList.remove("spell-row-exhausted");
            if (remaining <= 0) {
              el.classList.add("spell-remain-zero");
              if (row) row.classList.add("spell-row-exhausted");
            } else if (remaining <= Math.ceil(totalSlots * 0.25)) {
              el.classList.add("spell-remain-low");
            }
          } else {
            el.textContent = "--";
            el.classList.remove("spell-remain-zero", "spell-remain-low");
            if (row) row.classList.remove("spell-row-exhausted");
          }
        }
        // Refresh the Known-list counter — cap can change when the
        // user edits the slot table's Known column or auto-fill runs.
        updateKnownCount(panel, i);
        // L2 (2026-05-17 play-feel pass): "Prepared: X / Y" sub-line
        // under the per-level Prepared Spells header. Lets prepared
        // casters see at a glance whether they're under-prepared
        // (X < Y, common at low levels) or over-prepared (X > Y,
        // usually a user-error). Counts non-blank, non-comment lines
        // in the textarea — `// rest of day` and the like are skipped
        // so freeform notes don't inflate the count.
        updatePreparedCount(panel, i, totalSlots);
        // M6 (2026-05-16 play-feel pass): hide the level tab + list
        // content when the caster has no access at this level. Avoids
        // the dead L5-L9 tabs on a Wizard 5 / L4-L9 on a Sand Shaper 1
        // panel etc. The tab/content are restored automatically when
        // the caster gains access (e.g. levelling, advancer apply).
        // Selector note: spell-level-tab uses `data-level` (camelCase
        // dataset.level), NOT `data-lvl` like the slot-table cells.
        const tabBtn = panel.querySelector(
          `.spell-level-tab[data-level="${i}"]`);
        const contentDiv = panel.querySelector(
          `.spell-list-content[data-level="${i}"]`);
        const showLevel = totalSlots > 0 || i === 0;  // always keep L0
        if (tabBtn) tabBtn.style.display = showLevel ? '' : 'none';
        if (contentDiv && !showLevel) {
          contentDiv.style.display = 'none';
          contentDiv.classList.remove('active');
        } else if (contentDiv && showLevel && contentDiv.style.display === 'none') {
          contentDiv.style.display = '';
        }
      }
      // If the currently-active level tab was hidden by the loop above,
      // switch to the highest still-visible level.
      const activeTab = panel.querySelector('.spell-level-tab.active');
      if (activeTab && activeTab.style.display === 'none') {
        const visible = Array.from(panel.querySelectorAll('.spell-level-tab'))
          .filter(t => t.style.display !== 'none');
        const fallback = visible[visible.length - 1] || visible[0];
        if (fallback) fallback.click();
      }
    });

    // Psionics sub-tabs
    $$("[data-caster-type='psionics']").forEach((panel) => {
      const ability = panel.querySelector(".psi-ability")?.value || "";
      const abilityMod = ability && abilityModFn ? abilityModFn(ability) : 0;
      const manifesterLevel = int(panel.querySelector(".psi-manifester-level")?.value);
      const maxLevel = int(panel.querySelector(".psi-dc-table")?.dataset.maxLevel || 9);

      for (let i = 1; i <= maxLevel; i++) {
        const dcEl = panel.querySelector(`.psi-dc[data-lvl="${i}"]`);
        if (dcEl) dcEl.textContent = ability ? 10 + i + abilityMod : "--";
      }

      // Bonus PP = ability modifier × manifester level ÷ 2 (round down), min 0
      const bonusPP = (ability && manifesterLevel > 0)
        ? Math.max(0, Math.floor(abilityMod * manifesterLevel / 2))
        : 0;
      const basePP = int(panel.querySelector(".psi-pp-base")?.value);
      const extraPP = int(panel.querySelector(".psi-pp-extra")?.value);
      const ppDay = basePP + bonusPP + extraPP;
      const ppSpent = int(panel.querySelector(".psi-pp-spent")?.value);
      const ppRemaining = ppDay - ppSpent;
      const bonusEl = panel.querySelector(".psi-pp-bonus");
      if (bonusEl) bonusEl.textContent = (ability && manifesterLevel > 0) ? bonusPP : "--";

      const dayEl = panel.querySelector(".psi-pp-day");
      if (dayEl) dayEl.textContent = basePP > 0 ? ppDay : "--";

      const ppRemainEl = panel.querySelector(".psi-pp-remaining");
      if (ppRemainEl) {
        if (ppDay > 0) {
          ppRemainEl.textContent = ppRemaining;
          ppRemainEl.classList.remove("spell-remain-zero", "spell-remain-low");
          if (ppRemaining <= 0) ppRemainEl.classList.add("spell-remain-zero");
          else if (ppRemaining <= Math.ceil(ppDay * 0.25)) ppRemainEl.classList.add("spell-remain-low");
        } else {
          ppRemainEl.textContent = "--";
          ppRemainEl.classList.remove("spell-remain-zero", "spell-remain-low");
        }
      }
    });

    recalcEpicAndBinding();
  }
  function resetSlots() {
    $$(".sc-used").forEach((el) => { el.value = 0; });
  }
  function recalcEpicAndBinding() {
    // Epic spellcasting: slots/day = floor(ranks / 10) per ELH p.72
    $$("[data-caster-type='epic']").forEach((panel) => {
      const ranks = int(panel.querySelector(".epic-skill-ranks")?.value);
      const slotsDay = Math.floor(ranks / 10);
      const used = int(panel.querySelector(".epic-slots-used")?.value);
      const remaining = slotsDay - used;
      const dayEl = panel.querySelector(".epic-slots-day");
      if (dayEl) dayEl.textContent = ranks > 0 ? slotsDay : "--";
      const remainEl = panel.querySelector(".epic-slots-remain");
      if (remainEl) {
        if (slotsDay > 0) {
          remainEl.textContent = remaining;
          remainEl.classList.remove("spell-remain-zero", "spell-remain-low");
          if (remaining <= 0) remainEl.classList.add("spell-remain-zero");
        } else {
          remainEl.textContent = "--";
          remainEl.classList.remove("spell-remain-zero", "spell-remain-low");
        }
      }
    });

    // Binding: count bound vestiges
    $$("[data-caster-type='binding']").forEach((panel) => {
      recalcBindCount(panel);
    });

    // M6 (2026-05-16 play-feel pass): hide unused maneuver level
    // tabs for martial-adept panels. ToB initiator max maneuver level
    // = ceil(IL / 2). Warblade 5 → 3; show L1-L3, hide L4-L9. When
    // IL is unset, leave all levels visible so the panel remains
    // usable as a manual workspace.
    $$("[data-caster-type='maneuvers']").forEach((panel) => {
      const il = int(panel.querySelector(".tom-init-level")?.value);
      if (!il) return;
      const maxManLevel = Math.ceil(il / 2);
      let visibleCount = 0;
      let lastVisibleTab = null;
      for (let lvl = 1; lvl <= 9; lvl++) {
        const tab = panel.querySelector(
          `.spell-level-tab[data-level="${lvl}"]`);
        const content = panel.querySelector(
          `.spell-list-content[data-level="${lvl}"]`);
        const show = lvl <= maxManLevel;
        if (tab) tab.style.display = show ? '' : 'none';
        if (content && !show) {
          content.style.display = 'none';
          content.classList.remove('active');
        } else if (content && show && content.style.display === 'none') {
          content.style.display = '';
        }
        if (show) { visibleCount++; if (tab) lastVisibleTab = tab; }
      }
      // If the active tab got hidden, fall back to the highest still-visible.
      const activeTab = panel.querySelector('.spell-level-tab.active');
      if (activeTab && activeTab.style.display === 'none' && lastVisibleTab) {
        lastVisibleTab.click();
      }
    });

    // SLA sub-tabs: re-compute each ability's auto save DC so an ability-
    // score change (e.g. a Cha bump) flows into the DCs. Manual overrides
    // are respected inside refreshDCs.
    if (typeof SLA !== "undefined" && SLA.refreshDCs) {
      // _getAbilityMod is the bonus-aware mod fn captured by recalc(); this
      // runs inside recalcEpicAndBinding(), which has no getAbilityMod param.
      $$("[data-caster-type='sla']").forEach((panel) => SLA.refreshDCs(panel, _getAbilityMod));
    }

    // Shadowcaster sub-tabs: re-compute every mystery DC so an ability-score
    // change (e.g. a Cha bump) flows into the DCs. Same latent-bug fix as SLA
    // — the old recalcDC read window.getAbilityMod, which app.js never sets,
    // so every mystery DC computed with mod = 0. _getAbilityMod is the
    // bonus-aware mod fn captured by recalc().
    if (typeof Shadowcaster !== "undefined" && Shadowcaster.refreshDCs) {
      $$("[data-caster-type='shadowcaster']").forEach((panel) => Shadowcaster.refreshDCs(panel, _getAbilityMod));
    }
  }

  // No-op stub for app.js backward compat
  function buildSpellListsLegacy() {}
  // --- Collect / Load ---
  function collectData() {
    const data = { casters: [] };

    $$(".inner-tab[data-caster-idx]").forEach((btn) => {
      const idx = btn.dataset.casterIdx;
      const panel = $(`#caster-${idx}`);
      if (!panel) return;

      const type = panel.dataset.casterType;
      const removeSpan = btn.querySelector(".caster-tab-remove");
      const name = btn.textContent.replace("×", "").trim();
      const caster = { type, name };
      caster.notes = panel.querySelector(".caster-notes")?.value || "";

      if (type === "spellcasting") {
        caster.casterLevel = panel.querySelector(".sc-caster-level")?.value || "";
        caster.ability = panel.querySelector(".sc-ability").value;
        // v2 Phase B: quickened-spells-this-round runtime counter.
        // Persisted so it survives a save/reload mid-combat, but
        // it's the player's responsibility to reset each round
        // (or click the ↻ button next to the field).
        caster.quickenedThisRound = panel.querySelector(".sc-quickened-this-round")?.value || "0";
        // Optional bonus-spell ability override (Favored Soul / Spirit
        // Shaman). Empty string means "use the main spellcasting
        // ability" (the common case); see recalc().
        caster.bonusAbility = panel.querySelector(".sc-bonus-ability")?.value || "";
        caster.conditional = panel.querySelector(".sc-conditional").value;
        caster.specialist = panel.querySelector(".sc-specialist-toggle")?.checked || false;
        caster.showPrepared = panel.querySelector(".sc-show-prepared")?.checked ?? true;
        caster.showKnown = panel.querySelector(".sc-show-known")?.checked ?? true;
        caster.specialtySchool = panel.querySelector(".sc-specialty-school")?.value || "";
        caster.prohibitedSchools = Array.from(panel.querySelectorAll(".sc-prohibited")).map((el) => el.value).filter((v) => v);
        caster.domainAccess = panel.querySelector(".sc-domain-toggle")?.checked || false;
        caster.domains = Array.from(panel.querySelectorAll(".domain-entry")).map(entry => ({
          name: entry.querySelector(".sc-domain-name")?.value || "",
          power: entry.querySelector(".sc-domain-power")?.value || "",
        }));
        const scMax = int(panel.querySelector(".spell-slots-table")?.dataset.maxLevel || 9);
        caster.maxLevel = scMax;
        for (let i = 0; i <= scMax; i++) {
          caster[`known-${i}`] = panel.querySelector(`.sc-known[data-lvl="${i}"]`)?.value || "";
          caster[`perDay-${i}`] = panel.querySelector(`.sc-per-day[data-lvl="${i}"]`)?.value || "";
          caster[`bonus-${i}`] = panel.querySelector(`.sc-bonus[data-lvl="${i}"]`)?.value || "";
          caster[`extra-${i}`] = panel.querySelector(`.sc-extra[data-lvl="${i}"]`)?.value || "";
          caster[`used-${i}`] = panel.querySelector(`.sc-used[data-lvl="${i}"]`)?.value || "0";
          // Spells Known is now a structured list (per spell name).
          // Save as an array; legacy `text-${i}` is preserved on load
          // for one-shot migration (see loadData). Rows that came from
          // a class spell-addition feature (Sand Shaper's Desert
          // Insight, etc.) carry a freebie + source pair so the
          // round-trip preserves them; legacy string-only saves load
          // back as plain (non-freebie) entries.
          const knownRows = panel.querySelectorAll(
            `.sc-known-list[data-lvl="${i}"] .sc-known-row`);
          caster[`knownList-${i}`] = Array.from(knownRows).map(r => {
            const name = r.querySelector(".sc-known-name")?.value || "";
            if (!name) return null;
            if (r.dataset.freebie === '1') {
              return { name, freebie: true, source: r.dataset.source || '' };
            }
            return name;
          }).filter(Boolean);
          // v2 Phase C structural-restructure (2026-05-19): Prepared
          // is now a list of structured row objects. Each carries its
          // metamagic state so an "Edit metamagic" reopen reads back
          // the same picker selection that produced it. Legacy strings
          // are still loaded via `prepared-${i}` (textarea form, one
          // spell per line) and migrated through MetamagicPreparer's
          // parsePreparedLine — see loadData.
          const prepRows = panel.querySelectorAll(
            `.sc-prepared-list[data-lvl="${i}"] .sc-prepared-row`);
          caster[`preparedList-${i}`] = Array.from(prepRows).map(r => {
            const baseName = r.dataset.base || "";
            if (!baseName) return null;
            const metamagic = JSON.parse(r.dataset.metamagic || "[]");
            const heightenTarget = r.dataset.heightenTarget
              ? parseInt(r.dataset.heightenTarget, 10) : null;
            const sanctumIn = r.dataset.sanctumIn === "1";
            const used = r.querySelector(".sc-prep-used")?.checked || false;
            const entry = { baseName, metamagic, used };
            if (heightenTarget !== null) entry.heightenTarget = heightenTarget;
            if (sanctumIn) entry.sanctumIn = true;
            return entry;
          }).filter(Boolean);
          if (i >= 1) {
            caster[`domain-${i}`] = panel.querySelector(`.sc-domain-slots[data-lvl="${i}"]`)?.value || "";
            caster[`specialist-${i}`] = panel.querySelector(`.sc-specialist-slots[data-lvl="${i}"]`)?.value || "";
          }
        }
      } else if (type === "psionics") {
        caster.discipline = panel.querySelector(".psi-discipline")?.value || "";
        caster.manifesterLevel = panel.querySelector(".psi-manifester-level")?.value || "";
        caster.ppBase = panel.querySelector(".psi-pp-base")?.value || "";
        caster.ppExtra = panel.querySelector(".psi-pp-extra")?.value || "";
        caster.ppSpent = panel.querySelector(".psi-pp-spent")?.value || "0";
        caster.powersKnown = panel.querySelector(".psi-powers-known")?.value || "";
        caster.ability = panel.querySelector(".psi-ability")?.value || "";
        const psiMax = int(panel.querySelector(".psi-dc-table")?.dataset.maxLevel || 9);
        caster.maxLevel = psiMax;
        // v2 Phase D (2026-05-21): Known powers is now a structured
        // list (per-level array of names). Legacy `power-${i}: "n1\nn2"`
        // textarea strings still load via the loadData migration path
        // below for one-shot conversion; new saves emit
        // `knownPowersList-${i}: [names]`.
        for (let i = 1; i <= psiMax; i++) {
          const rows = panel.querySelectorAll(
            `.psi-known-list[data-lvl="${i}"] .psi-known-row`);
          caster[`knownPowersList-${i}`] = Array.from(rows)
            .map(r => (r.querySelector(".psi-known-name")?.value || "").trim())
            .filter(Boolean);
        }
      } else if (type === "maneuvers") {
        caster.initLevel = panel.querySelector(".tom-init-level")?.value || "";
        caster.knownCount = panel.querySelector(".tom-known-count")?.value || "";
        caster.readiedCount = panel.querySelector(".tom-readied-count")?.value || "";
        caster.stancesCount = panel.querySelector(".tom-stances-count")?.value || "";
        caster.readiedManeuvers = Array.from(panel.querySelectorAll(".tom-readied-row")).map(row => ({
          name: row.querySelector(".tom-readied-name")?.value || "",
          desc: row.querySelector(".tom-readied-desc")?.value || "",
          expended: row.querySelector(".tom-expended")?.checked || false,
        }));
        for (let i = 1; i <= 9; i++) {
          caster[`maneuver-${i}`] = panel.querySelector(`.tom-maneuver-text[data-lvl="${i}"]`)?.value || "";
          caster[`stance-${i}`] = panel.querySelector(`.tom-stance-text[data-lvl="${i}"]`)?.value || "";
        }
      } else if (type === "epic") {
        caster.epicSkill = panel.querySelector(".epic-skill")?.value || "spellcraft";
        caster.epicSkillRanks = panel.querySelector(".epic-skill-ranks")?.value || "";
        caster.epicSlotsUsed = panel.querySelector(".epic-slots-used")?.value || "0";
        caster.epicSpellcraft = panel.querySelector(".epic-spellcraft")?.value || "";
        caster.epicConditional = panel.querySelector(".epic-conditional")?.value || "";
        caster.epicSpells = Array.from(panel.querySelectorAll(".epic-spell-entry")).map((entry) => ({
          name: entry.querySelector(".epic-spell-name")?.value || "",
          dc: entry.querySelector(".epic-spell-dc")?.value || "",
          notes: entry.querySelector(".epic-spell-notes")?.value || "",
        }));
      } else if (type === "shadowcaster") {
        Object.assign(caster, Shadowcaster.collect(panel));
      } else if (type === "sla") {
        Object.assign(caster, SLA.collect(panel));
      } else if (type === "binding") {
        caster.binderLevel = panel.querySelector(".bind-level")?.value || "";
        caster.maxVestige = panel.querySelector(".bind-max-vestige")?.value || "";
        caster.maxBound = panel.querySelector(".bind-max-bound")?.value || "";
        caster.bindCheckMod = panel.querySelector(".bind-check-mod")?.value || "";
        caster.bindConditional = panel.querySelector(".bind-conditional")?.value || "";
        caster.vestiges = Array.from(panel.querySelectorAll(".vestige-entry")).map((entry) => ({
          name: entry.querySelector(".vestige-name")?.value || "",
          level: entry.querySelector(".vestige-level")?.value || "",
          dc: entry.querySelector(".vestige-dc")?.value || "",
          goodPact: entry.querySelector(".vestige-good-pact")?.checked || false,
          abilities: entry.querySelector(".vestige-abilities")?.value || "",
          sign: entry.querySelector(".vestige-sign")?.value || "",
        }));
      } else if (type === "invocations") {
        caster.invokerLevel = panel.querySelector(".invo-level")?.value || "";
        caster.casterLevel = panel.querySelector(".invo-caster-level")?.value || "";
        caster.highestGrade = panel.querySelector(".invo-highest-grade")?.value || "";
        caster.knownCount = panel.querySelector(".invo-known-count")?.value || "";
        caster.conditional = panel.querySelector(".invo-conditional")?.value || "";
        caster.invoClass = panel.dataset.invoClass || "";
        // Per-grade Known invocations are structured rows (mirroring
        // Spells Known). Saved as invoList-<gradeKey> arrays; legacy
        // invo-<gradeKey> textarea strings migrate at build time
        // (buildInvocationLists). Includes the breath-effect tab.
        panel.querySelectorAll(".invo-known-list").forEach((list) => {
          caster[`invoList-${list.dataset.grade}`] = Array.from(
            list.querySelectorAll(".invo-known-row .invo-known-name"))
            .map(inp => inp.value.trim()).filter(Boolean);
        });
      }

      data.casters.push(caster);
    });

    return data;
  }
  function loadData(data) {
    // Clear existing
    $("#spells-tab-bar").innerHTML = "";
    $("#spells-content").innerHTML = "";
    casterIndex = 0;

    if (data.casters) {
      // Migrate legacy domain/specialty data from class features into first spellcasting caster
      let legacyMigrated = false;
      data.casters.forEach((caster) => {
        if (!legacyMigrated && caster.type === "spellcasting" && !caster.specialist && !caster.domainAccess) {
          if (data["domain1-name"] || data["specialty-school"]) {
            if (data["specialty-school"]) {
              caster.specialist = true;
              caster.specialtySchool = data["specialty-school"];
              caster.prohibited1 = data["prohibited1"] || "";
              caster.prohibited2 = data["prohibited2"] || "";
            }
            if (data["domain1-name"]) {
              caster.domainAccess = true;
              caster.domains = [
                { name: data["domain1-name"], power: data["domain1-power"] || "" },
                { name: data["domain2-name"] || "", power: data["domain2-power"] || "" },
              ];
            }
            legacyMigrated = true;
          }
        }
      });
      data.casters.forEach((caster) => {
        const idx = addCaster(caster.type, caster);
        const panel = $(`#caster-${idx}`);
        if (!panel) return;

        if (caster.type === "spellcasting") {
          const scMax = int(caster.maxLevel || 9);
          for (let i = 0; i <= scMax; i++) {
            // Spells Known: new structured array (`knownList-N`) takes
            // precedence; fall back to legacy textarea string
            // (`text-N`) split by newline for one-shot migration.
            const listEl = panel.querySelector(
              `.sc-known-list[data-lvl="${i}"]`);
            if (listEl) {
              listEl.innerHTML = "";  // clear any default-empty rows
              // Entries may be plain strings (legacy / non-freebie) or
              // `{ name, freebie, source }` objects. Normalize on load.
              let entries = [];
              if (Array.isArray(caster[`knownList-${i}`])) {
                entries = caster[`knownList-${i}`];
              } else if (typeof caster[`text-${i}`] === "string") {
                entries = caster[`text-${i}`]
                  .split(/\r?\n/).map(s => s.trim()).filter(s => s);
              }
              for (const e of entries) {
                if (typeof e === 'string') {
                  createKnownRow(listEl, i, e);
                } else if (e && typeof e === 'object' && e.name) {
                  createKnownRow(listEl, i, e.name,
                    { freebie: !!e.freebie, source: e.source || '' });
                }
              }
            }
            // Prepared list (v2 Phase C structural restructure).
            // New saves carry `preparedList-${i}` as an array of objects.
            // Legacy saves carry `prepared-${i}` as a newline string;
            // migrate by parsing each line via MetamagicPreparer when
            // available, so any "Empowered Fireball [X]" lines from
            // the old format survive with their structured metamagic
            // state intact.
            const prepListEl = panel.querySelector(
              `.sc-prepared-list[data-lvl="${i}"]`);
            if (prepListEl) {
              prepListEl.innerHTML = "";
              let prepEntries = [];
              if (Array.isArray(caster[`preparedList-${i}`])) {
                prepEntries = caster[`preparedList-${i}`];
              } else if (typeof caster[`prepared-${i}`] === "string") {
                // Legacy migration: parse each non-empty / non-comment
                // line. Skip the "// …" comment lines the old format
                // ignored in the counter, since they had no spell.
                const lines = caster[`prepared-${i}`]
                  .split(/\r?\n/).map(s => s.trim())
                  .filter(s => s && !s.startsWith("//"));
                for (const line of lines) {
                  if (typeof MetamagicPreparer !== "undefined"
                      && MetamagicPreparer.parsePreparedLine) {
                    const parsed = MetamagicPreparer.parsePreparedLine(line);
                    if (parsed) {
                      prepEntries.push({
                        baseName: parsed.name,
                        metamagic: parsed.metamagic || [],
                        heightenTarget: parsed.heightenTarget ?? null,
                        sanctumIn: !!parsed.sanctumIn,
                        used: !!parsed.used,
                      });
                      continue;
                    }
                  }
                  // Fallback: take the raw line as the base name. Drop
                  // a trailing "[X]" / "[x]" marker as the used flag.
                  let used = false;
                  let name = line;
                  const m = line.match(/^(.*?)\s*\[\s*[Xx✓]\s*\]\s*$/);
                  if (m) { name = m[1].trim(); used = true; }
                  prepEntries.push({ baseName: name, metamagic: [], used });
                }
              }
              for (const e of prepEntries) {
                createPreparedRow(prepListEl, i, e);
              }
            }
          }
        } else if (caster.type === "psionics") {
          const psiMax = int(caster.maxLevel || 9);
          for (let i = 1; i <= psiMax; i++) {
            const listEl = panel.querySelector(
              `.psi-known-list[data-lvl="${i}"]`);
            if (!listEl) continue;
            // Prefer the v2 structured save (knownPowersList-N: [names]);
            // fall back to the legacy textarea string (power-N: "n1\nn2")
            // split per line for one-shot migration. Both paths feed
            // createPsiKnownRow so the resulting DOM is identical.
            const newList = caster[`knownPowersList-${i}`];
            let names = [];
            if (Array.isArray(newList)) {
              names = newList.filter(n => typeof n === "string" && n.trim());
            } else if (typeof caster[`power-${i}`] === "string"
                       && caster[`power-${i}`].trim()) {
              names = caster[`power-${i}`].split(/\r?\n/)
                .map(s => s.trim()).filter(Boolean);
            }
            for (const name of names) {
              createPsiKnownRow(listEl, i, name);
            }
          }
        } else if (caster.type === "maneuvers") {
          for (let i = 1; i <= 9; i++) {
            const mEl = panel.querySelector(`.tom-maneuver-text[data-lvl="${i}"]`);
            if (mEl && caster[`maneuver-${i}`]) mEl.value = caster[`maneuver-${i}`];
            const sEl = panel.querySelector(`.tom-stance-text[data-lvl="${i}"]`);
            if (sEl && caster[`stance-${i}`]) sEl.value = caster[`stance-${i}`];
          }
        }
      });
    }

    // Rehydrate domain info panels. The .dom-pick-info <div> that
    // shows the 1st–9th domain spell list is created on-demand by
    // domain-picker.js when the user types or selects a domain name —
    // it isn't part of the saved HTML. After load, the .sc-domain-name
    // inputs have their values restored but no info panel sits below
    // them, so fire a `change` event on each populated input to let
    // the domain-picker's event delegation re-render the info line.
    document.querySelectorAll('.sc-domain-name').forEach(input => {
      if (input.value && input.value.trim()) {
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    recalc();
  }
  // Public-API helper for spell-picker.js so it can append into the
  // structured Known list without needing to know how rows are built.
  function addKnownSpell(listEl, lvl, spellName, opts) {
    return createKnownRow(listEl, lvl, spellName, opts);
  }

  // DB-first metamagic lookup; falls back to JS catalog. Mirrors the
  // helper in spell-picker.js so the Reference panel and the picker
  // agree on every entry (all 79 catalogued feats, plus homebrew via
  // the JS catalog). Returns `{ levelAdjustment, effect,
  // actionTypeMod? }` or null.
  const _mmRefCache = new Map();
  function lookupMetamagicFromDB(name) {
    const key = String(name || "").trim();
    if (!key) return null;
    if (_mmRefCache.has(key)) return _mmRefCache.get(key);
    let result = null;
    if (window.DB && DB.isLoaded()) {
      const row = DB.queryOne(
        "SELECT json_extract(data, '$.metamagic.level_adjustment') AS adj, " +
        "       json_extract(data, '$.metamagic.action_type_mod')   AS act, " +
        "       json_extract(data, '$.metamagic.effect_summary')    AS eff " +
        "FROM entry WHERE type='feat' AND name = :n COLLATE NOCASE " +
        "AND types_csv LIKE '%Metamagic%' LIMIT 1", { ":n": key });
      if (row && row.adj !== null) {
        const adj = row.adj;
        result = {
          levelAdjustment: (adj === "variable") ? "variable"
                          : (typeof adj === "number" ? adj : parseInt(adj, 10)),
          effect: row.eff || "",
          actionTypeMod: row.act || undefined,
        };
      }
    }
    if (!result && window.MetamagicCatalog && MetamagicCatalog.has(key)) {
      result = MetamagicCatalog.get(key);
    }
    _mmRefCache.set(key, result);
    return result;
  }

  // --- Metamagic Reference panel + spontaneous-caster warning --------
  // Reads the character's metamagic feats from the Feats tab, filters
  // against the catalog, and populates the per-panel reference. Also
  // surfaces the spontaneous-caster action-type warning when the
  // panel's notes contain a known spontaneous class name. Called on
  // panel build and whenever the Feats tab fires an input/change.
  function refreshMetamagicReference(panel) {
    if (!panel) return;
    const ref = panel.querySelector(".sc-metamagic-ref");
    const refBody = panel.querySelector(".sc-mm-ref-body");
    const refCount = panel.querySelector(".sc-mm-ref-count");
    const warning = panel.querySelector(".sc-spontaneous-mm-warning");
    if (!ref || !refBody) return;

    // Pull metamagic feats from the Feats tab. Feat names live in
    // .feat-entry textareas (first line = feat name; additional
    // lines are notes). Each name is looked up in the DB first
    // (covers all 79 catalogued metamagic feats via build-time
    // _metamagic_metadata.py), with the JS catalog as fallback for
    // homebrew entries that aren't in the DB.
    const featInputs = document.querySelectorAll("#feats-container .feat-entry");
    const mmEntries = [];
    for (const el of featInputs) {
      const raw = String(el.value || "").trim();
      if (!raw) continue;
      const firstLine = raw.split(/\r?\n/)[0].trim();
      const name = firstLine.replace(/\s*\([^)]*\)\s*$/, "").trim();
      if (!name) continue;
      const meta = lookupMetamagicFromDB(name);
      if (meta) mmEntries.push({ name, meta });
    }

    // v2 Phase B trackers section: only show when the character has
    // ≥1 metamagic feat (otherwise nothing to track).
    const trackers = panel.querySelector(".sc-mm-trackers");
    if (trackers) {
      trackers.style.display = mmEntries.length ? "flex" : "none";
    }

    if (!mmEntries.length) {
      ref.style.display = "none";
      refBody.innerHTML = "";
      refCount.textContent = "";
    } else {
      ref.style.display = "";
      refCount.textContent = ` (${mmEntries.length} feat${mmEntries.length === 1 ? "" : "s"})`;
      const rows = mmEntries.map(({ name, meta }) => {
        const adj = typeof meta.levelAdjustment === "number"
          ? `+${meta.levelAdjustment}`
          : "±var";
        const action = meta.actionTypeMod
          ? ` <span style="opacity:0.7">[${meta.actionTypeMod}]</span>`
          : "";
        return `<div style="margin-bottom:0.25rem">` +
               `<b>${escapeAttr(name)}</b> ` +
               `<span style="opacity:0.8">${adj}</span>${action} — ` +
               `${escapeAttr(meta.effect)}</div>`;
      });
      refBody.innerHTML = rows.join("");
    }
    const mmFeats = mmEntries.map(e => e.name);

    // Spontaneous-caster warning: only show when this panel's notes
    // contain a known spontaneous class name AND the character has
    // at least one metamagic feat (no warning needed otherwise).
    if (warning) {
      const notes = (panel.querySelector(".caster-notes")?.value || "").toLowerCase();
      const SPONTANEOUS = [
        "sorcerer", "bard", "favored soul", "spirit shaman", "warmage",
        "beguiler", "dread necromancer", "healer", "hexblade",
        "duskblade", "spellthief", "shugenja",
      ];
      // Sha'ir is technically spontaneous-by-stat-block, but spells
      // function as prepared once a gen retrieves them — metamagic is
      // baked in during retrieval, so the increased-casting-time
      // reminder doesn't apply. Deliberately omitted above.
      const isSpontaneous = SPONTANEOUS.some(c => notes.includes(c));
      warning.style.display = (isSpontaneous && mmFeats.length > 0) ? "" : "none";
    }
  }

  // Live-refresh whenever feats change on the Feats tab.
  document.addEventListener("input", (e) => {
    if (e.target?.closest?.("#tab-feats")) {
      document.querySelectorAll("[data-caster-type='spellcasting']")
        .forEach((p) => refreshMetamagicReference(p));
      // Also refresh the per-row ✨ button visibility — gaining or
      // losing a metamagic feat should immediately toggle it.
      refreshAllKnownRowMetamagicVis();
    }
    // v2 Phase C structural-restructure (2026-05-19): the per-row ✏
    // edit button now lives directly on each .sc-prepared-row and is
    // shown when that row has metamagic — no whole-panel sweep needed.
  });
  // Also refresh whenever the panel notes change (since the
  // spontaneous warning depends on the class name in the notes).
  document.addEventListener("input", (e) => {
    if (e.target?.classList?.contains("caster-notes")) {
      const panel = e.target.closest("[data-caster-type='spellcasting']");
      if (panel) refreshMetamagicReference(panel);
    }
  });

  // --- Public API ---
  return {
    addCaster,
    buildSpellLists: buildSpellListsLegacy,
    recalc,
    resetSlots,
    collectData,
    loadData,
    addKnownSpell,
    addKnownPower,
    addInvocationKnown,
    // v2 Phase C structural restructure: the metamagic preparer
    // writes prepared spells as structured rows via this helper
    // (instead of newline-appending to the old textarea).
    addPreparedSpell,
    // Exposed for metamagic-preparer.js (lets the preparer reuse the
    // same DB-first / catalog-fallback lookup that the Reference panel
    // uses, so the two stay in lockstep).
    lookupMetamagicFromDB,
    refreshMetamagicReference,
  };
})();
