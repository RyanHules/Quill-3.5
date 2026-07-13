// D&D 3.5 Character Sheet - Equipment Tab Module

const Equipment = (function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ============================================================
  // Gear rows
  // ============================================================
  function addGearRow(data = {}) {
    const tbody = $("#gear-body");
    const tr = document.createElement("tr");
    tr.className = "gear-row";
    // The ⓘ button toggles a collapsible panel (an inserted sibling
    // <tr>) showing the item's rules text from the DB — the same
    // affordance the Feats tab gives each feat row. Falls back
    // gracefully for homebrew / custom items with no DB match, and
    // auto-collapses when the item name is edited so stale text never
    // sits under a renamed item.
    tr.innerHTML = `
      <td><input type="text" class="gear-name" value="${data.name || ""}" placeholder="Item name"></td>
      <td><input type="text" class="gear-location" value="${data.location || ""}" placeholder="Location"></td>
      <td><input type="number" class="gear-weight" value="${data.weight || ""}" min="0" step="0.1" style="width:70px"></td>
      <td class="gear-actions">
        <button type="button" class="btn-feat-info gear-info-btn" title="Show item rules" aria-expanded="false">ⓘ</button>
        <button type="button" class="btn-remove gear-remove-btn">X</button>
      </td>
    `;
    tbody.appendChild(tr);
    tr.querySelector(".gear-weight").addEventListener("input", recalcWeight);
    tr.querySelector(".gear-info-btn").addEventListener("click", () => toggleGearRules(tr));
    tr.querySelector(".gear-remove-btn").addEventListener("click", () => removeGearRow(tr));
    // Collapse the rules panel whenever the user edits the item name.
    tr.querySelector(".gear-name").addEventListener("input", () => collapseGearRules(tr));
  }

  function removeGearRow(tr) {
    // Drop the attached rules panel (the sibling <tr>) first, then the
    // row itself, then recalc since the dropped weight changes the total.
    collapseGearRules(tr);
    tr.remove();
    recalcWeight();
  }

  // Build the .feat-rules panel element for a given item name — shared
  // by the Possessions (gear) ⓘ toggle and the Magic Items ⓘ toggle.
  // Handles the empty-name / DB-not-loaded / lookup paths and attaches
  // the errata + version badges. Reuses the feat panel styling for
  // visual parity with the Feats tab.
  function buildItemRulesPanel(name) {
    const panel = document.createElement("div");
    panel.className = "feat-rules";
    if (!name) {
      panel.innerHTML = '<i style="opacity:.7">Type an item name first.</i>';
    } else if (!(window.DB && DB.isLoaded())) {
      panel.innerHTML = '<i style="opacity:.7">Database not loaded — rules text unavailable.</i>';
    } else {
      const rendered = renderItemRules(name);
      panel.innerHTML = rendered.html;
      if (rendered.entryId && window.ErrataBadge) ErrataBadge.attach(panel, rendered.entryId);
      if (rendered.version && window.VersionBadge) VersionBadge.attach(panel, rendered.version);
    }
    return panel;
  }

  function toggleGearRules(tr) {
    const next = tr.nextElementSibling;
    if (next && next.classList.contains("gear-rules-row")) {
      collapseGearRules(tr);
      return;
    }
    const btn = tr.querySelector(".gear-info-btn");
    const name = (tr.querySelector(".gear-name").value || "").trim();
    const rulesTr = document.createElement("tr");
    rulesTr.className = "gear-rules-row";
    const td = document.createElement("td");
    td.colSpan = 4;
    td.appendChild(buildItemRulesPanel(name));
    rulesTr.appendChild(td);
    tr.after(rulesTr);
    btn.setAttribute("aria-expanded", "true");
    btn.classList.add("active");
  }

  function collapseGearRules(tr) {
    const next = tr.nextElementSibling;
    if (next && next.classList.contains("gear-rules-row")) next.remove();
    const btn = tr.querySelector(".gear-info-btn");
    if (btn) {
      btn.setAttribute("aria-expanded", "false");
      btn.classList.remove("active");
    }
  }

  // Magic Items ⓘ panel — same affordance as the Possessions rows, but
  // the panel is inserted as a block-level sibling right after the
  // entry's header row (a .magic-item-entry is a block container, so
  // the .feat-rules div spans full width).
  function toggleMagicItemRules(entry) {
    if (entry.querySelector(":scope > .feat-rules")) {
      collapseMagicItemRules(entry);
      return;
    }
    const header = entry.querySelector(".mi-header-row");
    const btn = entry.querySelector(".mi-info-btn");
    const name = (entry.querySelector(".mi-name")?.value || "").trim();
    header.after(buildItemRulesPanel(name));
    if (btn) {
      btn.setAttribute("aria-expanded", "true");
      btn.classList.add("active");
    }
  }

  function collapseMagicItemRules(entry) {
    const panel = entry.querySelector(":scope > .feat-rules");
    if (panel) panel.remove();
    const btn = entry.querySelector(".mi-info-btn");
    if (btn) {
      btn.setAttribute("aria-expanded", "false");
      btn.classList.remove("active");
    }
  }

  // Look up a possessions item by typed name (case-insensitive) and
  // render its rules panel HTML. Mirrors feats.js renderFeatRules:
  // whole-string match first, then strip a trailing "+N" enhancement
  // and/or parenthetical and retry (so "Cloak of Resistance +1" still
  // resolves to the base "Cloak of Resistance"). Field set matches the
  // item-picker info panel so every item / weapon / armor / gear shape
  // renders gracefully — missing fields are simply omitted. Returns
  // { html, entryId, version }.
  function renderItemRules(name) {
    const select =
      "SELECT e.id, e.name, e.version, e.source, e.item_type AS type, " +
      "  e.body_slot, e.aura, e.caster_level, e.price, e.weight, " +
      "  json_extract(e.data, '$.prerequisites')   AS prerequisites, " +
      "  json_extract(e.data, '$.cost')            AS cost, " +
      "  json_extract(e.data, '$.description')      AS description, " +
      "  json_extract(e.data, '$.damage_medium')   AS damage_medium, " +
      "  json_extract(e.data, '$.damage_small')    AS damage_small, " +
      "  json_extract(e.data, '$.critical')        AS critical, " +
      "  json_extract(e.data, '$.range_increment') AS range_increment " +
      "FROM entry e " +
      "WHERE e.type IN ('item','weapon','armor','gear') " +
      "  AND LOWER(e.name) = LOWER(?) " +
      "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END LIMIT 1";
    let row = DB.queryOne(select, [name]);
    if (!row) {
      const stripped = name
        .replace(/\s*\([^)]*\)\s*$/, "")
        .replace(/\s*\+\d+\s*$/, "")
        .trim();
      if (stripped && stripped !== name) row = DB.queryOne(select, [stripped]);
    }
    if (!row) {
      return {
        html: '<i style="opacity:.7">No rules text found in database — ' +
          'this looks like a homebrew or custom item.</i>',
        entryId: null, version: null,
      };
    }
    // Treat bare dash placeholders ("-", "—") as empty so the panel
    // doesn't print noise lines like "Cost: -" — same convention
    // feats.js uses for "-" prerequisites.
    const has = (v) => {
      const s = String(v == null ? "" : v).trim();
      return s !== "" && s !== "-" && s !== "—";
    };
    const bits = [];
    const verBadge = (window.VersionBadge ? VersionBadge.html(row.version) : "");
    bits.push(`<b>${escapeHtml(row.name)}</b>${verBadge}` +
      (has(row.source) ? ` <span style="opacity:.7">(${escapeHtml(row.source)})</span>` : ""));
    if (has(row.type))          bits.push(`<b>Type:</b> ${escapeHtml(row.type)}`);
    if (has(row.body_slot))     bits.push(`<b>Slot:</b> ${escapeHtml(row.body_slot)}`);
    if (has(row.aura))          bits.push(`<b>Aura:</b> ${escapeHtml(row.aura)}`);
    if (has(row.caster_level))  bits.push(`<b>CL:</b> ${escapeHtml(row.caster_level)}`);
    // Weapon stat line — only mundane/magic weapons carry these (no
    // non-weapon item in the DB has damage_medium). Show both damage
    // columns when the Small die differs from the Medium die.
    if (has(row.damage_medium) || has(row.damage_small)) {
      const dm = has(row.damage_medium) ? row.damage_medium : null;
      const ds = has(row.damage_small) ? row.damage_small : null;
      const dmg = (dm && ds && dm !== ds) ? `${dm} (M) / ${ds} (S)` : (dm || ds);
      bits.push(`<b>Damage:</b> ${escapeHtml(dmg)}`);
    }
    if (has(row.critical))        bits.push(`<b>Critical:</b> ${escapeHtml(row.critical)}`);
    if (has(row.range_increment)) bits.push(`<b>Range:</b> ${escapeHtml(row.range_increment)}`);
    if (has(row.prerequisites)) bits.push(`<b>Prereq:</b> ${escapeHtml(row.prerequisites)}`);
    if (has(row.price))         bits.push(`<b>Price:</b> ${escapeHtml(row.price)}`);
    if (has(row.weight))        bits.push(`<b>Weight:</b> ${escapeHtml(row.weight)}`);
    if (has(row.cost))          bits.push(`<b>Cost:</b> ${escapeHtml(row.cost)}`);
    if (has(row.description))   bits.push(`<b>Description:</b> ${escapeHtml(row.description)}`);
    return { html: bits.join("<br>"), entryId: row.id, version: row.version };
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ============================================================
  // Magic Items (formerly Protective Items)
  // ============================================================
  const BONUS_TYPES = [
    "Untyped", "Deflection", "Dodge", "Natural Armor", "Sacred", "Profane",
    "Insight", "Luck", "Morale", "Circumstance", "Enhancement", "Shield", "Armor",
  ];

  function buildSlotOptions(selected) {
    let html = '<option value="">None</option>';
    DND35.itemSlots.forEach((slot) => {
      html += `<option value="${slot.id}"${slot.id === selected ? " selected" : ""}>${slot.label}</option>`;
    });
    return html;
  }

  function addMagicItem(data = {}) {
    const container = $("#magic-items-container");
    const div = document.createElement("div");
    div.className = "magic-item-entry";
    div.dataset.miId = "mi-" + (magicItemIdCounter++);

    const worn = data.worn !== false;
    const isProtective = data.isProtective || false;
    const hasAbility = data.hasAbilityBonuses || false;

    div.innerHTML = `
      <div class="mi-row mi-header-row">
        <div class="field" style="flex:2"><label>Item</label><input type="text" class="mi-name" value="${data.name || ""}"></div>
        <div class="field field-sm"><label>Body Slot</label><select class="mi-slot">${buildSlotOptions(data.slot || "")}</select></div>
        <div class="field field-sm"><label>Weight</label><input type="number" class="mi-weight" value="${data.weight || ""}" step="0.1"></div>
        <button type="button" class="btn-feat-info mi-info-btn" title="Show item rules" aria-expanded="false" style="align-self:flex-end">ⓘ</button>
        <button class="btn-remove" style="align-self:flex-end" onclick="Equipment.removeMagicItem(this)">X</button>
      </div>
      <div class="mi-row">
        <div class="field" style="flex:2"><label>Special</label><textarea class="mi-special" rows="1">${data.special || ""}</textarea></div>
        <label class="mi-toggle"><input type="checkbox" class="mi-worn" ${worn ? "checked" : ""}> Worn</label>
        <label class="mi-toggle"><input type="checkbox" class="mi-protective-toggle" ${isProtective ? "checked" : ""}> Protective Item</label>
        <label class="mi-toggle"><input type="checkbox" class="mi-ability-toggle" ${hasAbility ? "checked" : ""}> Ability Bonuses</label>
        <label class="mi-toggle"><input type="checkbox" class="mi-skill-toggle" ${data.hasSkillBonuses ? "checked" : ""}> Skill Bonuses</label>
      </div>
      <div class="mi-protective-section" style="${isProtective ? "" : "display:none"}">
        <div class="mi-ac-bonuses"></div>
        <button class="btn-add mi-btn-add-ac" style="margin-top:0.3rem">+ Add AC Bonus</button>
      </div>
      <div class="mi-ability-section" style="${hasAbility ? "" : "display:none"}">
        <div class="mi-row">
          ${DND35.abilities.map(ab => `<div class="field field-sm"><label>${ab}</label><input type="number" class="mi-ability mi-ab-${ab.toLowerCase()}" value="${(data.abilityBonuses && data.abilityBonuses[ab]) || ""}" data-ability="${ab}"></div>`).join("")}
        </div>
      </div>
      <div class="mi-skill-section" style="${data.hasSkillBonuses ? "" : "display:none"}">
        <div class="mi-skill-bonuses"></div>
        <button class="btn-add mi-btn-add-skill" style="margin-top:0.3rem">+ Add Skill Bonus</button>
      </div>
    `;
    container.appendChild(div);

    // Wire toggle visibility
    const protToggle = div.querySelector(".mi-protective-toggle");
    const abilToggle = div.querySelector(".mi-ability-toggle");
    const skillToggle = div.querySelector(".mi-skill-toggle");
    const protSection = div.querySelector(".mi-protective-section");
    const abilSection = div.querySelector(".mi-ability-section");
    const skillSection = div.querySelector(".mi-skill-section");
    protToggle.addEventListener("change", () => protSection.style.display = protToggle.checked ? "" : "none");
    abilToggle.addEventListener("change", () => abilSection.style.display = abilToggle.checked ? "" : "none");
    skillToggle.addEventListener("change", () => skillSection.style.display = skillToggle.checked ? "" : "none");

    // Wire body slot linkage
    const slotSelect = div.querySelector(".mi-slot");
    const nameInput = div.querySelector(".mi-name");
    slotSelect.addEventListener("change", () => syncSlot(div));
    nameInput.addEventListener("input", () => syncSlot(div));
    div.querySelector(".mi-worn")?.addEventListener("change", () => syncSlot(div));

    // ⓘ rules panel toggle + auto-collapse when the item name is edited
    // (so stale text never sits under a renamed item).
    div.querySelector(".mi-info-btn")?.addEventListener("click", () => toggleMagicItemRules(div));
    nameInput.addEventListener("input", () => collapseMagicItemRules(div));

    // Live weight recalculation when the user edits a magic item's
    // weight. Without this, editing .mi-weight needs a separate
    // recalc trigger (tab switch, save/load, etc.) to update the
    // total — easy to miss.
    div.querySelector(".mi-weight")?.addEventListener("input", recalcWeight);

    // Wire add AC bonus button
    div.querySelector(".mi-btn-add-ac").addEventListener("click", () => addACBonus(div));

    // Wire add skill bonus button
    div.querySelector(".mi-btn-add-skill").addEventListener("click", () => addSkillBonus(div));

    // Load existing AC bonuses
    if (data.acBonuses && data.acBonuses.length > 0) {
      data.acBonuses.forEach(b => addACBonus(div, b));
    } else if (data.ac && parseInt(data.ac)) {
      // Backwards compat: old single AC bonus format
      addACBonus(div, { ac: data.ac, type: data.type || "Untyped", touch: data.touch || false, flatfooted: data.flatfooted !== false });
    } else if (isProtective) {
      addACBonus(div); // add one empty row
    }

    // Load existing skill bonuses
    if (data.skillBonuses) data.skillBonuses.forEach(sb => addSkillBonus(div, sb));

    // Initial slot sync
    if (data.slot) syncSlot(div);
  }

  function addACBonus(itemDiv, data = {}) {
    const container = itemDiv.querySelector(".mi-ac-bonuses");
    const row = document.createElement("div");
    row.className = "mi-row mi-ac-bonus-row";
    const typeOptions = BONUS_TYPES.map(t =>
      `<option value="${t}"${t === (data.type || "Untyped") ? " selected" : ""}>${t}</option>`
    ).join("");
    row.innerHTML = `
      <div class="field field-sm"><label>AC Bonus</label><input type="number" class="mi-ac-val" value="${data.ac || "0"}"></div>
      <div class="field field-sm"><label>Bonus Type</label><select class="mi-ac-type">${typeOptions}</select></div>
      <label class="mi-toggle"><input type="checkbox" class="mi-ac-touch" ${data.touch ? "checked" : ""}> Touch</label>
      <label class="mi-toggle"><input type="checkbox" class="mi-ac-ff" ${data.flatfooted !== false ? "checked" : ""}> Flat-Footed</label>
      <button class="btn-remove" style="font-size:0.6rem;padding:0.15rem 0.4rem" onclick="this.closest('.mi-ac-bonus-row').remove()">X</button>
    `;
    container.appendChild(row);
  }

  function addSkillBonus(itemDiv, data = {}) {
    const container = itemDiv.querySelector(".mi-skill-bonuses");
    const row = document.createElement("div");
    row.className = "mi-row mi-skill-bonus-row";
    row.innerHTML = `
      <div class="field" style="flex:2"><label>Skill</label><input type="text" class="mi-skill-name" value="${data.skill || ""}" placeholder="e.g. Spot, Hide"></div>
      <div class="field field-sm"><label>Bonus</label><input type="number" class="mi-skill-val" value="${data.bonus || "0"}"></div>
      <button class="btn-remove" style="font-size:0.6rem;padding:0.15rem 0.4rem" onclick="this.closest('.mi-skill-bonus-row').remove()">X</button>
    `;
    container.appendChild(row);
  }

  function syncSlot(itemDiv) {
    const slotId = itemDiv.querySelector(".mi-slot")?.value;
    const name = itemDiv.querySelector(".mi-name")?.value || "";
    const worn = itemDiv.querySelector(".mi-worn")?.checked;
    // Clear any previous slot ownership by this item
    const prevSlot = itemDiv.dataset.prevSlot;
    if (prevSlot) {
      const prevEl = $(`#slot-${prevSlot}`);
      if (prevEl && prevEl.dataset.ownedBy === itemDiv.dataset.miId) {
        prevEl.value = "";
        prevEl.readOnly = false;
        delete prevEl.dataset.ownedBy;
      }
    }
    // Set new slot
    if (slotId && worn) {
      const slotEl = $(`#slot-${slotId}`);
      if (slotEl) {
        slotEl.value = name;
        slotEl.readOnly = true;
        slotEl.dataset.ownedBy = itemDiv.dataset.miId;
      }
    }
    itemDiv.dataset.prevSlot = slotId || "";
  }

  function removeMagicItem(btn) {
    const entry = btn.closest(".magic-item-entry");
    // Clear linked slot
    const slotId = entry.querySelector(".mi-slot")?.value;
    if (slotId) {
      const slotEl = $(`#slot-${slotId}`);
      if (slotEl && slotEl.dataset.ownedBy === entry.dataset.miId) {
        slotEl.value = "";
        slotEl.readOnly = false;
        delete slotEl.dataset.ownedBy;
      }
    }
    entry.remove();
    // Removing a magic item drops its weight from the total — recalc
    // so the displayed Total Weight + load category catch up.
    recalcWeight();
  }

  let magicItemIdCounter = 0;

  // ============================================================
  // Magic Item Slots / Soulmelds Worn
  // ============================================================
  function buildMagicItemSlots() {
    const grid = $("#magic-items-grid");
    grid.innerHTML = "";

    // Counters bar
    const countersDiv = document.createElement("div");
    countersDiv.className = "soulmeld-counters";
    countersDiv.innerHTML = `
      <div class="field field-sm"><label>Max Soulmelds</label><input type="number" id="sm-max-soulmelds" min="0" value="0"></div>
      <div class="field field-sm"><label>Max Essentia</label><input type="number" id="sm-max-essentia" min="0" value="0"></div>
      <div class="field field-sm"><label>Max Binds</label><input type="number" id="sm-max-binds" min="0" value="0"></div>
      <div class="field field-sm"><label>Base Capacity</label><input type="number" id="sm-base-capacity" min="0" value="0"></div>
      <div class="field field-sm"><label>Shaped</label><span id="sm-count-shaped" class="calc-field">0</span></div>
      <div class="field field-sm"><label>Essentia Used</label><span id="sm-count-essentia" class="calc-field">0</span></div>
      <div class="field field-sm"><label>Binds Used</label><span id="sm-count-binds" class="calc-field">0</span></div>
    `;
    grid.appendChild(countersDiv);

    // Body slots
    DND35.itemSlots.forEach((slot) => {
      const div = document.createElement("div");
      div.className = "magic-item-slot";
      div.dataset.slotId = slot.id;
      div.innerHTML = `
        <div class="slot-header">
          <label>${slot.label}</label>
          <div class="slot-desc">${slot.description}</div>
          <label class="mi-toggle slot-sm-toggle"><input type="checkbox" class="slot-soulmeld-check"> Soulmeld</label>
        </div>
        <input type="text" id="slot-${slot.id}" class="slot-item-name" placeholder="Item name">
        <div class="slot-soulmeld-area" style="display:none">
          <input type="text" class="slot-sm-name" placeholder="Soulmeld name">
          <div class="slot-sm-options">
            <label class="mi-toggle"><input type="checkbox" class="slot-sm-bound"> Bound</label>
            <label class="mi-toggle"><input type="checkbox" class="slot-sm-split"> Split Chakra</label>
            <label class="mi-toggle"><input type="checkbox" class="slot-sm-double"> Double Chakra</label>
          </div>
          <div class="slot-sm-fields">
            <div class="field field-sm"><label>Base Effect</label><textarea class="slot-sm-base" rows="1"></textarea></div>
            <div class="field field-sm"><label>Bind Effect</label><textarea class="slot-sm-bind-effect" rows="1"></textarea></div>
            <div class="field field-sm"><label>Extra Capacity</label><input type="number" class="slot-sm-extra-cap" min="0" value="0"></div>
          </div>
          <div class="essentia-pips">
            <label>Essentia:</label>
          </div>
          <div class="slot-sm-second" style="display:none">
            <input type="text" class="slot-sm2-name" placeholder="Second soulmeld">
            <div class="slot-sm-options">
              <label class="mi-toggle"><input type="checkbox" class="slot-sm2-bound"> Bound</label>
            </div>
            <div class="slot-sm-fields">
              <div class="field field-sm"><label>Base Effect</label><textarea class="slot-sm2-base" rows="1"></textarea></div>
              <div class="field field-sm"><label>Bind Effect</label><textarea class="slot-sm2-bind-effect" rows="1"></textarea></div>
              <div class="field field-sm"><label>Extra Capacity</label><input type="number" class="slot-sm2-extra-cap" min="0" value="0"></div>
            </div>
            <div class="essentia-pips essentia-pips-2">
              <label>Essentia:</label>
            </div>
          </div>
        </div>
      `;
      grid.appendChild(div);

      // Wire soulmeld toggle
      const smCheck = div.querySelector(".slot-soulmeld-check");
      const smArea = div.querySelector(".slot-soulmeld-area");
      const itemInput = div.querySelector(".slot-item-name");
      smCheck.addEventListener("change", () => {
        smArea.style.display = smCheck.checked ? "" : "none";
        if (smCheck.checked && !div.querySelector(".slot-sm-split").checked) {
          itemInput.style.display = "none";
        } else {
          itemInput.style.display = "";
        }
        rebuildEssentiaPips(div);
        recalcSoulmelds();
      });

      // Wire split chakra (shows item input alongside soulmeld)
      div.querySelector(".slot-sm-split").addEventListener("change", () => {
        itemInput.style.display = (smCheck.checked && !div.querySelector(".slot-sm-split").checked) ? "none" : "";
        recalcSoulmelds();
      });

      // Wire double chakra (shows second soulmeld)
      div.querySelector(".slot-sm-double").addEventListener("change", () => {
        div.querySelector(".slot-sm-second").style.display = div.querySelector(".slot-sm-double").checked ? "" : "none";
        rebuildEssentiaPips(div, true);
        recalcSoulmelds();
      });

      div.querySelector(".slot-sm-bound").addEventListener("change", recalcSoulmelds);
      div.querySelector(".slot-sm2-bound").addEventListener("change", recalcSoulmelds);
      div.querySelector(".slot-sm-extra-cap").addEventListener("input", () => rebuildEssentiaPips(div));
      div.querySelector(".slot-sm2-extra-cap").addEventListener("input", () => rebuildEssentiaPips(div, true));
    });

    // Totem entry
    const totemDiv = document.createElement("div");
    totemDiv.className = "magic-item-slot slot-totem";
    totemDiv.innerHTML = `
      <details>
        <summary>Totem (Totemist only)</summary>
        <input type="text" class="slot-sm-name" id="totem-sm-name" placeholder="Totem soulmeld">
        <div class="slot-sm-options">
          <label class="mi-toggle"><input type="checkbox" id="totem-sm-bound"> Bound</label>
          <label class="mi-toggle"><input type="checkbox" id="totem-sm-double"> Double Chakra</label>
        </div>
        <div class="slot-sm-fields">
          <div class="field field-sm"><label>Base Effect</label><input type="text" id="totem-sm-base"></div>
          <div class="field field-sm"><label>Bind Effect</label><input type="text" id="totem-sm-bind-effect"></div>
          <div class="field field-sm"><label>Extra Capacity</label><input type="number" id="totem-sm-extra-cap" min="0" value="0"></div>
        </div>
        <div class="essentia-pips" id="totem-essentia-pips">
          <label>Essentia:</label>
        </div>
        <div id="totem-sm-second" style="display:none">
          <input type="text" id="totem-sm2-name" placeholder="Second soulmeld">
          <div class="slot-sm-options">
            <label class="mi-toggle"><input type="checkbox" id="totem-sm2-bound"> Bound</label>
          </div>
          <div class="slot-sm-fields">
            <div class="field field-sm"><label>Base Effect</label><input type="text" id="totem-sm2-base"></div>
            <div class="field field-sm"><label>Bind Effect</label><input type="text" id="totem-sm2-bind-effect"></div>
            <div class="field field-sm"><label>Extra Capacity</label><input type="number" id="totem-sm2-extra-cap" min="0" value="0"></div>
          </div>
          <div class="essentia-pips" id="totem-essentia-pips-2">
            <label>Essentia:</label>
          </div>
        </div>
      </details>
    `;
    grid.appendChild(totemDiv);

    // Wire totem
    const totemBound = totemDiv.querySelector("#totem-sm-bound");
    const totemDouble = totemDiv.querySelector("#totem-sm-double");
    totemBound?.addEventListener("change", recalcSoulmelds);
    totemDouble?.addEventListener("change", () => {
      const second = totemDiv.querySelector("#totem-sm-second");
      if (second) second.style.display = totemDouble.checked ? "" : "none";
      rebuildTotemPips(true);
      recalcSoulmelds();
    });
    totemDiv.querySelector("#totem-sm-extra-cap")?.addEventListener("input", () => rebuildTotemPips(false));
    totemDiv.querySelector("#totem-sm2-extra-cap")?.addEventListener("input", () => rebuildTotemPips(true));
    totemDiv.querySelector("#totem-sm2-bound")?.addEventListener("change", recalcSoulmelds);

    // Counter inputs trigger recalc
    ["sm-max-soulmelds", "sm-max-essentia", "sm-max-binds", "sm-base-capacity"].forEach(id => {
      const el = $(`#${id}`);
      if (el) el.addEventListener("input", () => { rebuildAllPips(); recalcSoulmelds(); });
    });
  }

  // ============================================================
  // Essentia pip management
  // ============================================================
  function getCapacity(slotDiv) {
    const base = parseInt($("#sm-base-capacity")?.value) || 0;
    const extra = parseInt(slotDiv.querySelector(".slot-sm-extra-cap")?.value) || 0;
    return base + extra;
  }

  function rebuildEssentiaPips(slotDiv, alsoSecond) {
    const cap = getCapacity(slotDiv);
    const pipsContainer = slotDiv.querySelector(".essentia-pips:not(.essentia-pips-2)");
    buildPipButtons(pipsContainer, cap);
    if (alsoSecond || slotDiv.querySelector(".slot-sm-double")?.checked) {
      const base = parseInt($("#sm-base-capacity")?.value) || 0;
      const extra2 = parseInt(slotDiv.querySelector(".slot-sm2-extra-cap")?.value) || 0;
      const pips2 = slotDiv.querySelector(".essentia-pips-2");
      if (pips2) buildPipButtons(pips2, base + extra2);
    }
    recalcSoulmelds();
  }

  function rebuildTotemPips(alsoSecond) {
    const base = parseInt($("#sm-base-capacity")?.value) || 0;
    const extra = parseInt($("#totem-sm-extra-cap")?.value) || 0;
    const pips = $("#totem-essentia-pips");
    if (pips) buildPipButtons(pips, base + extra);
    if (alsoSecond) {
      const extra2 = parseInt($("#totem-sm2-extra-cap")?.value) || 0;
      const pips2 = $("#totem-essentia-pips-2");
      if (pips2) buildPipButtons(pips2, base + extra2);
    }
    recalcSoulmelds();
  }

  function rebuildAllPips() {
    $$(".magic-item-slot[data-slot-id]").forEach(slot => {
      if (slot.querySelector(".slot-soulmeld-check")?.checked) {
        rebuildEssentiaPips(slot);
      }
    });
    // Totem
    if ($("#totem-sm-name")?.value) rebuildTotemPips($("#totem-sm-double")?.checked);
  }

  function buildPipButtons(container, maxPips) {
    // Preserve current filled count
    const currentFilled = container.querySelectorAll(".essentia-pip.filled").length;
    const label = container.querySelector("label");
    container.innerHTML = "";
    if (label) container.appendChild(label);
    else { const l = document.createElement("label"); l.textContent = "Essentia:"; container.appendChild(l); }
    for (let i = 1; i <= Math.max(maxPips, 0); i++) {
      const btn = document.createElement("button");
      btn.className = "essentia-pip" + (i <= currentFilled ? " filled" : "");
      btn.dataset.pip = i;
      btn.addEventListener("click", () => toggleSlotPip(btn));
      container.appendChild(btn);
    }
  }

  function fillPips(container, count) {
    if (!container) return;
    container.querySelectorAll(".essentia-pip").forEach((p, i) => {
      p.classList.toggle("filled", i < count);
    });
  }

  function toggleSlotPip(btn) {
    const pip = parseInt(btn.dataset.pip);
    const pips = btn.parentElement.querySelectorAll(".essentia-pip");
    const currentlyFilled = btn.classList.contains("filled");
    pips.forEach(p => {
      const pVal = parseInt(p.dataset.pip);
      if (currentlyFilled) { if (pVal >= pip) p.classList.remove("filled"); }
      else { if (pVal <= pip) p.classList.add("filled"); }
    });
    recalcSoulmelds();
  }

  // Reset a body-slot's soulmeld sub-fields to their empty defaults. loadData
  // calls this for EVERY slot before repopulating, because a soulmeld is only
  // serialized when its checkbox is on (collectData gates on it) — so loading a
  // character with no soulmeld in a slot would otherwise leave the PREVIOUS
  // character's soulmeld sitting in that slot (the S2 cross-save bleed). Clears
  // both the primary and the double-chakra second soulmeld, and empties the
  // pips (buildPipButtons preserves filled count, so rebuild-then-fill(0)).
  function clearSlotSoulmeld(slotDiv) {
    if (!slotDiv) return;
    const setVal = (sel, v) => { const el = slotDiv.querySelector(sel); if (el) el.value = v; };
    const setChk = (sel) => { const el = slotDiv.querySelector(sel); if (el) el.checked = false; };
    setChk(".slot-soulmeld-check");
    const area = slotDiv.querySelector(".slot-soulmeld-area");
    if (area) area.style.display = "none";
    setVal(".slot-sm-name", ""); setChk(".slot-sm-bound"); setChk(".slot-sm-split");
    setChk(".slot-sm-double"); setVal(".slot-sm-base", ""); setVal(".slot-sm-bind-effect", "");
    setVal(".slot-sm-extra-cap", "0");
    setVal(".slot-sm2-name", ""); setChk(".slot-sm2-bound"); setVal(".slot-sm2-base", "");
    setVal(".slot-sm2-bind-effect", ""); setVal(".slot-sm2-extra-cap", "0");
    const second = slotDiv.querySelector(".slot-sm-second");
    if (second) second.style.display = "none";
    // Soulmeld off => the plain magic-item input for this slot is shown again.
    const itemInput = slotDiv.querySelector(".slot-item-name");
    if (itemInput) itemInput.style.display = "";
    rebuildEssentiaPips(slotDiv, true);
    fillPips(slotDiv.querySelector(".essentia-pips:not(.essentia-pips-2)"), 0);
    fillPips(slotDiv.querySelector(".essentia-pips-2"), 0);
  }

  // Totem equivalent of clearSlotSoulmeld — same S2 bleed applies (data.totem is
  // only present when a totem soulmeld is set).
  function clearTotem() {
    const setVal = (id, v) => { const el = $(`#${id}`); if (el) el.value = v; };
    const setChk = (id) => { const el = $(`#${id}`); if (el) el.checked = false; };
    setVal("totem-sm-name", ""); setChk("totem-sm-bound"); setChk("totem-sm-double");
    setVal("totem-sm-base", ""); setVal("totem-sm-bind-effect", ""); setVal("totem-sm-extra-cap", "0");
    setVal("totem-sm2-name", ""); setChk("totem-sm2-bound"); setVal("totem-sm2-base", "");
    setVal("totem-sm2-bind-effect", ""); setVal("totem-sm2-extra-cap", "0");
    const second = $("#totem-sm-second"); if (second) second.style.display = "none";
    const details = $(".slot-totem details"); if (details) details.open = false;
    rebuildTotemPips(true);
    fillPips($("#totem-essentia-pips"), 0);
    fillPips($("#totem-essentia-pips-2"), 0);
  }

  // ============================================================
  // Soulmeld counter recalculation
  // ============================================================
  function recalcSoulmelds() {
    let shaped = 0, essentia = 0, binds = 0;

    $$(".magic-item-slot[data-slot-id]").forEach(slot => {
      if (!slot.querySelector(".slot-soulmeld-check")?.checked) return;
      shaped++;
      binds += slot.querySelector(".slot-sm-bound")?.checked ? 1 : 0;
      essentia += slot.querySelectorAll(".essentia-pips:not(.essentia-pips-2) .essentia-pip.filled").length;
      if (slot.querySelector(".slot-sm-double")?.checked && slot.querySelector(".slot-sm2-name")?.value) {
        shaped++;
        binds += slot.querySelector(".slot-sm2-bound")?.checked ? 1 : 0;
        essentia += slot.querySelectorAll(".essentia-pips-2 .essentia-pip.filled").length;
      }
    });

    // Totem
    if ($("#totem-sm-name")?.value) {
      shaped++;
      binds += $("#totem-sm-bound")?.checked ? 1 : 0;
      essentia += $$("#totem-essentia-pips .essentia-pip.filled").length;
      if ($("#totem-sm-double")?.checked && $("#totem-sm2-name")?.value) {
        shaped++;
        binds += $("#totem-sm2-bound")?.checked ? 1 : 0;
        essentia += $$("#totem-essentia-pips-2 .essentia-pip.filled").length;
      }
    }

    const maxSm = parseInt($("#sm-max-soulmelds")?.value) || 0;
    const maxEss = parseInt($("#sm-max-essentia")?.value) || 0;
    const maxBinds = parseInt($("#sm-max-binds")?.value) || 0;

    setCounterDisplay("sm-count-shaped", shaped, maxSm);
    setCounterDisplay("sm-count-essentia", essentia, maxEss);
    setCounterDisplay("sm-count-binds", binds, maxBinds);
  }

  function setCounterDisplay(id, current, max) {
    const el = $(`#${id}`);
    if (!el) return;
    el.textContent = current;
    el.classList.toggle("counter-over", max > 0 && current > max);
  }

  // ============================================================
  // Weight recalculation
  // ============================================================
  function recalcWeight() {
    let totalWeight = 0;
    $$("#gear-body tr.gear-row").forEach((row) => {
      totalWeight += parseFloat(row.querySelector(".gear-weight")?.value) || 0;
    });
    totalWeight += parseFloat($("#armor-weight").value) || 0;
    totalWeight += parseFloat($("#shield-weight").value) || 0;
    // Magic items: every .magic-item-entry has its own weight input.
    // Pre-2026-05-18, only #gear-body + armor + shield contributed —
    // a +5 plate cloak (5 lb) and other magic items were silently
    // dropped from encumbrance.
    $$("#magic-items-container .magic-item-entry").forEach((entry) => {
      totalWeight += parseFloat(entry.querySelector(".mi-weight")?.value) || 0;
    });
    // Item Familiars: the bonded item is still a physical object that
    // the character has to carry. Aggregates across all item-familiar
    // panels, filtered by carried + not-lost status (a lost item
    // familiar weighs 0 against the master since it's not on them).
    if (typeof ItemFamiliar !== "undefined" && ItemFamiliar.getTotalWeight) {
      totalWeight += ItemFamiliar.getTotalWeight();
    }
    // Coin weight: per PHB, 50 coins of any type weigh 1 lb.
    const coinCount = ["money-cp", "money-sp", "money-gp", "money-pp"]
      .reduce((sum, id) => sum + (parseInt($(`#${id}`)?.value) || 0), 0);
    totalWeight += coinCount / 50;
    $("#total-weight").textContent = totalWeight.toFixed(1);
  }

  // ============================================================
  // Collect / Load
  // ============================================================
  function collectData() {
    const data = {};

    // Armor & shield fields
    [
      "armor-name", "armor-type", "armor-ac-bonus", "armor-max-dex",
      "armor-check-pen", "armor-spell-fail", "armor-speed", "armor-weight", "armor-special",
      "shield-name", "shield-ac-bonus", "shield-weight", "shield-check-pen",
      "shield-spell-fail", "shield-special",
    ].forEach((id) => {
      data[id] = $(`#${id}`).value;
    });

    // Worn state
    data["armor-worn"] = $("#armor-worn").checked;
    data["shield-worn"] = $("#shield-worn").checked;
    data["armor-touch-ac"] = $("#armor-touch-ac").checked;
    data["shield-touch-ac"] = $("#shield-touch-ac").checked;

    // Magic items
    data.magicItems = [];
    $$(".magic-item-entry").forEach((entry) => {
      const item = {
        name: entry.querySelector(".mi-name").value,
        weight: entry.querySelector(".mi-weight").value,
        special: entry.querySelector(".mi-special").value,
        slot: entry.querySelector(".mi-slot").value,
        worn: entry.querySelector(".mi-worn").checked,
        isProtective: entry.querySelector(".mi-protective-toggle").checked,
        hasAbilityBonuses: entry.querySelector(".mi-ability-toggle").checked,
      };
      // AC bonuses
      item.acBonuses = [];
      entry.querySelectorAll(".mi-ac-bonus-row").forEach(row => {
        item.acBonuses.push({
          ac: row.querySelector(".mi-ac-val").value,
          type: row.querySelector(".mi-ac-type").value,
          touch: row.querySelector(".mi-ac-touch").checked,
          flatfooted: row.querySelector(".mi-ac-ff").checked,
        });
      });
      // Ability bonuses
      if (item.hasAbilityBonuses) {
        item.abilityBonuses = {};
        DND35.abilities.forEach(ab => {
          const val = entry.querySelector(`.mi-ab-${ab.toLowerCase()}`)?.value;
          if (val) item.abilityBonuses[ab] = val;
        });
      }
      // Skill bonuses
      item.hasSkillBonuses = entry.querySelector(".mi-skill-toggle")?.checked || false;
      if (item.hasSkillBonuses) {
        item.skillBonuses = [];
        entry.querySelectorAll(".mi-skill-bonus-row").forEach(row => {
          const skill = row.querySelector(".mi-skill-name")?.value || "";
          const bonus = row.querySelector(".mi-skill-val")?.value || "0";
          if (skill) item.skillBonuses.push({ skill, bonus });
        });
      }
      data.magicItems.push(item);
    });

    // Magic item slots + soulmelds
    data.slotSoulmelds = {};
    DND35.itemSlots.forEach((slot) => {
      data[`slot-${slot.id}`] = $(`#slot-${slot.id}`).value;
      const slotDiv = $(`.magic-item-slot[data-slot-id="${slot.id}"]`);
      if (slotDiv?.querySelector(".slot-soulmeld-check")?.checked) {
        const sm = {
          enabled: true,
          name: slotDiv.querySelector(".slot-sm-name")?.value || "",
          bound: slotDiv.querySelector(".slot-sm-bound")?.checked || false,
          split: slotDiv.querySelector(".slot-sm-split")?.checked || false,
          double: slotDiv.querySelector(".slot-sm-double")?.checked || false,
          base: slotDiv.querySelector(".slot-sm-base")?.value || "",
          bindEffect: slotDiv.querySelector(".slot-sm-bind-effect")?.value || "",
          extraCap: slotDiv.querySelector(".slot-sm-extra-cap")?.value || "0",
          essentia: slotDiv.querySelectorAll(".essentia-pips:not(.essentia-pips-2) .essentia-pip.filled").length,
        };
        if (sm.double) {
          sm.name2 = slotDiv.querySelector(".slot-sm2-name")?.value || "";
          sm.bound2 = slotDiv.querySelector(".slot-sm2-bound")?.checked || false;
          sm.base2 = slotDiv.querySelector(".slot-sm2-base")?.value || "";
          sm.bindEffect2 = slotDiv.querySelector(".slot-sm2-bind-effect")?.value || "";
          sm.extraCap2 = slotDiv.querySelector(".slot-sm2-extra-cap")?.value || "0";
          sm.essentia2 = slotDiv.querySelectorAll(".essentia-pips-2 .essentia-pip.filled").length;
        }
        data.slotSoulmelds[slot.id] = sm;
      }
    });

    // Soulmeld counters
    ["sm-max-soulmelds", "sm-max-essentia", "sm-max-binds", "sm-base-capacity"].forEach(id => {
      data[id] = $(`#${id}`)?.value || "0";
    });

    // Totem
    const totemName = $("#totem-sm-name")?.value;
    if (totemName) {
      data.totem = {
        name: totemName,
        bound: $("#totem-sm-bound")?.checked || false,
        double: $("#totem-sm-double")?.checked || false,
        base: $("#totem-sm-base")?.value || "",
        bindEffect: $("#totem-sm-bind-effect")?.value || "",
        extraCap: $("#totem-sm-extra-cap")?.value || "0",
        essentia: $$("#totem-essentia-pips .essentia-pip.filled").length,
      };
      if (data.totem.double) {
        data.totem.name2 = $("#totem-sm2-name")?.value || "";
        data.totem.bound2 = $("#totem-sm2-bound")?.checked || false;
        data.totem.base2 = $("#totem-sm2-base")?.value || "";
        data.totem.bindEffect2 = $("#totem-sm2-bind-effect")?.value || "";
        data.totem.extraCap2 = $("#totem-sm2-extra-cap")?.value || "0";
        data.totem.essentia2 = $$("#totem-essentia-pips-2 .essentia-pip.filled").length;
      }
    }

    // Gear. Scope to `tr.gear-row` so the collapsible item-rules
    // panel rows (`tr.gear-rules-row`, which have no .gear-* inputs)
    // are skipped — an unscoped `#gear-body tr` would match an open
    // panel row and throw on `.gear-name.value` while saving.
    data.gear = [];
    $$("#gear-body tr.gear-row").forEach((row) => {
      data.gear.push({
        name: row.querySelector(".gear-name").value,
        location: row.querySelector(".gear-location").value,
        weight: row.querySelector(".gear-weight").value,
      });
    });
    data["possessions-notes"] = $("#possessions-notes")?.value || "";

    // Money
    ["money-cp", "money-sp", "money-gp", "money-pp"].forEach((id) => {
      data[id] = $(`#${id}`).value;
    });

    return data;
  }

  function loadData(data) {
    // Armor & shield fields
    [
      "armor-name", "armor-type", "armor-ac-bonus", "armor-max-dex",
      "armor-check-pen", "armor-spell-fail", "armor-speed", "armor-weight", "armor-special",
      "shield-name", "shield-ac-bonus", "shield-weight", "shield-check-pen",
      "shield-spell-fail", "shield-special",
      "money-cp", "money-sp", "money-gp", "money-pp",
    ].forEach((id) => {
      const el = $(`#${id}`);
      if (el && data[id] !== undefined) el.value = data[id];
    });

    // Worn state (default to true)
    $("#armor-worn").checked = data["armor-worn"] !== undefined ? data["armor-worn"] : true;
    $("#shield-worn").checked = data["shield-worn"] !== undefined ? data["shield-worn"] : true;
    $("#armor-touch-ac").checked = data["armor-touch-ac"] || false;
    $("#shield-touch-ac").checked = data["shield-touch-ac"] || false;

    // Soulmeld counters
    ["sm-max-soulmelds", "sm-max-essentia", "sm-max-binds", "sm-base-capacity"].forEach(id => {
      const el = $(`#${id}`);
      if (el && data[id] !== undefined) el.value = data[id];
    });

    // Magic item slots + soulmelds
    DND35.itemSlots.forEach((slot) => {
      const key = `slot-${slot.id}`;
      if (data[key] !== undefined) $(`#${key}`).value = data[key];

      // Always clear the slot's soulmeld first, so a soulmeld from a
      // previously-loaded character can't bleed into this one (S2).
      const slotDiv = $(`.magic-item-slot[data-slot-id="${slot.id}"]`);
      clearSlotSoulmeld(slotDiv);

      const sm = data.slotSoulmelds?.[slot.id];
      if (sm?.enabled) {
        if (!slotDiv) return;
        const check = slotDiv.querySelector(".slot-soulmeld-check");
        check.checked = true;
        slotDiv.querySelector(".slot-soulmeld-area").style.display = "";
        slotDiv.querySelector(".slot-sm-name").value = sm.name || "";
        slotDiv.querySelector(".slot-sm-bound").checked = sm.bound || false;
        slotDiv.querySelector(".slot-sm-split").checked = sm.split || false;
        slotDiv.querySelector(".slot-sm-double").checked = sm.double || false;
        slotDiv.querySelector(".slot-sm-base").value = sm.base || "";
        slotDiv.querySelector(".slot-sm-bind-effect").value = sm.bindEffect || "";
        slotDiv.querySelector(".slot-sm-extra-cap").value = sm.extraCap || "0";
        // Show/hide item based on split
        const itemInput = slotDiv.querySelector(".slot-item-name");
        itemInput.style.display = sm.split ? "" : "none";
        // Build pips and fill
        rebuildEssentiaPips(slotDiv);
        fillPips(slotDiv.querySelector(".essentia-pips:not(.essentia-pips-2)"), sm.essentia || 0);
        if (sm.double) {
          slotDiv.querySelector(".slot-sm-second").style.display = "";
          slotDiv.querySelector(".slot-sm2-name").value = sm.name2 || "";
          slotDiv.querySelector(".slot-sm2-bound").checked = sm.bound2 || false;
          slotDiv.querySelector(".slot-sm2-base").value = sm.base2 || "";
          slotDiv.querySelector(".slot-sm2-bind-effect").value = sm.bindEffect2 || "";
          slotDiv.querySelector(".slot-sm2-extra-cap").value = sm.extraCap2 || "0";
          rebuildEssentiaPips(slotDiv, true);
          fillPips(slotDiv.querySelector(".essentia-pips-2"), sm.essentia2 || 0);
        }
      }
    });

    // Totem — clear first so a previous character's totem can't bleed (S2).
    clearTotem();
    if (data.totem) {
      const details = $(".slot-totem details");
      if (details) details.open = true;
      $("#totem-sm-name").value = data.totem.name || "";
      $("#totem-sm-bound").checked = data.totem.bound || false;
      $("#totem-sm-double").checked = data.totem.double || false;
      $("#totem-sm-base").value = data.totem.base || "";
      $("#totem-sm-bind-effect").value = data.totem.bindEffect || "";
      $("#totem-sm-extra-cap").value = data.totem.extraCap || "0";
      rebuildTotemPips(false);
      fillPips($("#totem-essentia-pips"), data.totem.essentia || 0);
      if (data.totem.double) {
        $("#totem-sm-second").style.display = "";
        $("#totem-sm2-name").value = data.totem.name2 || "";
        $("#totem-sm2-bound").checked = data.totem.bound2 || false;
        $("#totem-sm2-base").value = data.totem.base2 || "";
        $("#totem-sm2-bind-effect").value = data.totem.bindEffect2 || "";
        $("#totem-sm2-extra-cap").value = data.totem.extraCap2 || "0";
        rebuildTotemPips(true);
        fillPips($("#totem-essentia-pips-2"), data.totem.essentia2 || 0);
      }
    }

    // Legacy soulmelds from class features
    if (data.soulmelds && data.soulmelds.length > 0 && !data.slotSoulmelds) {
      // Old format: standalone soulmeld entries — can't auto-map to slots, ignore
    }

    recalcSoulmelds();

    // Gear
    $("#gear-body").innerHTML = "";
    if (data.gear) data.gear.forEach((g) => addGearRow(g));
    if (data["possessions-notes"] !== undefined) $("#possessions-notes").value = data["possessions-notes"];

    // Magic items (with backwards compat for old protectiveItems format)
    $("#magic-items-container").innerHTML = "";
    magicItemIdCounter = 0;
    if (data.magicItems) {
      data.magicItems.forEach((m) => addMagicItem(m));
    } else if (data.protectiveItems) {
      // Legacy format: convert protective items to magic items
      data.protectiveItems.forEach((p) => addMagicItem({
        name: p.name, weight: p.weight, special: p.special, worn: true,
        isProtective: true, ac: p.ac, type: p.type, touch: p.touch, flatfooted: p.flatfooted,
      }));
    }
  }

  // ============================================================
  // Get AC bonuses from worn magic items (for AC calculation)
  // ============================================================
  function getProtectiveItems() {
    const items = [];
    $$(".magic-item-entry").forEach((entry) => {
      const worn = entry.querySelector(".mi-worn")?.checked;
      const isProt = entry.querySelector(".mi-protective-toggle")?.checked;
      if (!worn || !isProt) return;
      entry.querySelectorAll(".mi-ac-bonus-row").forEach(row => {
        const ac = parseInt(row.querySelector(".mi-ac-val").value) || 0;
        if (ac === 0) return;
        items.push({
          type: row.querySelector(".mi-ac-type").value || "Untyped",
          ac,
          touch: row.querySelector(".mi-ac-touch").checked,
          flatfooted: row.querySelector(".mi-ac-ff").checked,
        });
      });
    });
    return items;
  }

  // ============================================================
  // Get active ability bonuses from worn magic items
  // ============================================================
  function getActiveBonuses() {
    const bonuses = { abilities: {}, saves: {}, ac: 0 };
    $$(".magic-item-entry").forEach((entry) => {
      const worn = entry.querySelector(".mi-worn")?.checked;
      const hasAbility = entry.querySelector(".mi-ability-toggle")?.checked;
      if (!worn || !hasAbility) return;
      DND35.abilities.forEach(ab => {
        const val = parseInt(entry.querySelector(`.mi-ab-${ab.toLowerCase()}`)?.value) || 0;
        if (val) bonuses.abilities[ab] = (bonuses.abilities[ab] || 0) + val;
      });
    });
    return bonuses;
  }

  // ============================================================
  // Get active skill bonuses from worn magic items
  // Returns { "Spot": 5, "Hide": 3, ... }
  // ============================================================
  function getSkillBonuses() {
    const bonuses = {};
    $$(".magic-item-entry").forEach((entry) => {
      const worn = entry.querySelector(".mi-worn")?.checked;
      const hasSkill = entry.querySelector(".mi-skill-toggle")?.checked;
      if (!worn || !hasSkill) return;
      entry.querySelectorAll(".mi-skill-bonus-row").forEach(row => {
        const skill = (row.querySelector(".mi-skill-name")?.value || "").trim();
        const val = parseInt(row.querySelector(".mi-skill-val")?.value) || 0;
        if (skill && val) bonuses[skill] = (bonuses[skill] || 0) + val;
      });
    });
    return bonuses;
  }

  // ============================================================
  // Paper Doll
  // ============================================================
  function updatePaperDoll() {
    const doll = $("#paper-doll");
    if (!doll) return;

    // Clear all slot states
    doll.querySelectorAll(".doll-slot").forEach((el) => {
      el.classList.remove("doll-has-item", "doll-has-soulmeld", "doll-has-both");
      if (el.dataset.slot === "armor" || el.dataset.slot === "shield") el.style.display = "none";
    });

    // Check each body slot
    DND35.itemSlots.forEach((slot) => {
      const slotDiv = $(`.magic-item-slot[data-slot-id="${slot.id}"]`);
      if (!slotDiv) return;
      const hasItem = !!slotDiv.querySelector(".slot-item-name")?.value?.trim();
      const hasSoulmeld = slotDiv.querySelector(".slot-soulmeld-check")?.checked || false;
      const cls = (hasItem && hasSoulmeld) ? "doll-has-both" : hasItem ? "doll-has-item" : hasSoulmeld ? "doll-has-soulmeld" : "";
      if (!cls) return;
      doll.querySelectorAll(`[data-slot="${slot.id}"]`).forEach((el) => {
        el.classList.add(cls);
      });
    });

    // Armor and shield
    const armorWorn = $("#armor-worn")?.checked;
    const armorName = $("#armor-name")?.value?.trim();
    if (armorWorn && armorName) {
      const el = doll.querySelector('[data-slot="armor"]');
      if (el) { el.style.display = ""; el.classList.add("doll-has-item"); }
    }

    const shieldWorn = $("#shield-worn")?.checked;
    const shieldName = $("#shield-name")?.value?.trim();
    if (shieldWorn && shieldName) {
      const el = doll.querySelector('[data-slot="shield"]');
      if (el) { el.style.display = ""; el.classList.add("doll-has-item"); }
    }
  }

  // ============================================================
  // Coin / armor / shield inputs — recalc weight on change
  // ============================================================
  ["money-cp", "money-sp", "money-gp", "money-pp", "armor-weight", "shield-weight"]
    .forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("input", recalcWeight);
    });

  // ============================================================
  // Public API
  // ============================================================
  return {
    addGearRow, addMagicItem, buildMagicItemSlots, removeMagicItem,
    recalcWeight, getProtectiveItems, getActiveBonuses, getSkillBonuses,
    updatePaperDoll, collectData, loadData,
    // Exposed so other item surfaces (e.g. the Magic Items list) can
    // reuse the same name→DB rules lookup the Possessions ⓘ panel uses.
    renderItemRules,
  };
})();
