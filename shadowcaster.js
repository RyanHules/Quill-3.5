// D&D 3.5 Character Sheet - Shadowcaster sub-tab (Tome of Magic p.111-113)
// Registered with Spells module via Spells.registerCasterType.

const Shadowcaster = (function () {
  "use strict";

  const int = (v) => parseInt(v) || 0;

  // Bonus-aware ability-mod fn, handed in by Spells.recalc via refreshDCs
  // (the same getModWithBonuses the rest of the Spells tab uses). NOT
  // window.getAbilityMod — app.js never exposes that globally, so the old
  // reliance on it silently computed every mystery DC with mod = 0. Falls
  // back to 0 until the first recalc seeds it.
  let _getMod = null;

  // Default uses/day per group. Fundamentals start at 3/day and become
  // at-will at shadowcaster 14 — user flips the dropdown to "Unlimited"
  // at that point. Apprentice/Initiate/Master default to 1/day.
  const GROUPS = [
    { key: "fund", label: "Fundamentals", sub: "0-level", defaultUses: "3" },
    { key: "app",  label: "Apprentice Mysteries", sub: "1st-3rd", defaultUses: "1" },
    { key: "init", label: "Initiate Mysteries", sub: "4th-6th", defaultUses: "1" },
    { key: "mast", label: "Master Mysteries", sub: "7th-9th", defaultUses: "1" },
  ];

  function usesPerDayOptions(selected) {
    const opts = ["1", "2", "3", "unlimited"];
    return opts.map((v) =>
      `<option value="${v}"${String(selected) === v ? " selected" : ""}>${v === "unlimited" ? "Unlimited" : v}</option>`
    ).join("");
  }

  function abilityOptions(selected) {
    const abs = ["", "INT", "WIS", "CHA"];
    const labels = ["-- None --", "Intelligence", "Wisdom", "Charisma"];
    return abs.map((a, i) => `<option value="${a}"${a === selected ? " selected" : ""}>${labels[i]}</option>`).join("");
  }

  // Per-group mystery-level ranges (used to populate the per-mystery
  // "Level" dropdown). The DC formula is the standard spell DC:
  // 10 + mystery_level + ability_mod.
  const GROUP_LEVELS = {
    fund: [0],
    app:  [1, 2, 3],
    init: [4, 5, 6],
    mast: [7, 8, 9],
  };

  function levelOptions(group, selected) {
    return GROUP_LEVELS[group].map((lv) =>
      `<option value="${lv}"${String(selected) === String(lv) ? " selected" : ""}>${lv}</option>`
    ).join("");
  }

  function buildHTML(idx, data) {
    const groupsHTML = GROUPS.map((g) => {
      const gdata = (data[g.key] || {});
      const usesSel = `<div class="field field-sm"><label>Uses/Day</label><select class="sh-uses" data-group="${g.key}">${usesPerDayOptions(gdata.uses || g.defaultUses)}</select></div>`;
      const mysteries = (gdata.mysteries && gdata.mysteries.length ? gdata.mysteries : [{}]);
      const rows = mysteries.map((m) => mysteryRow(g, m)).join("");
      return `
        <section class="section sh-group" data-group="${g.key}">
          <div class="sh-group-header">
            <h3>${g.label} <small>(${g.sub})</small></h3>
            ${usesSel}
          </div>
          <div class="sh-mystery-list">${rows}</div>
          <button class="btn-add sh-add-mystery" data-group="${g.key}">+ Add Mystery</button>
        </section>
      `;
    }).join("");

    return `
      <section class="section">
        <h2>Shadowcasting</h2>
        <div class="info-grid">
          <div class="field field-sm"><label>Caster Level</label><input type="number" class="sh-caster-level" min="1" value="${data.casterLevel || ""}"></div>
          <div class="field field-sm"><label>Mystery Ability</label><select class="sh-ability">${abilityOptions(data.ability || "CHA")}</select></div>
          <div class="field"><label>Conditional Modifiers</label><input type="text" class="sh-conditional" value="${data.conditional || ""}"></div>
        </div>
        <button class="btn-add sh-reset-all" style="margin-top:0.5rem">Reset All Uses</button>
      </section>
      <div class="shadowcaster-2col">
        ${groupsHTML}
      </div>
    `;
  }

  function mysteryRow(group, m = {}) {
    const usedCount = int(m.used || 0);
    // Each mystery has its own selected level (within the group's
    // allowed range) and a computed DC (10 + level + ability mod).
    const defaultLevel = m.level !== undefined && m.level !== ""
      ? m.level
      : GROUP_LEVELS[group.key][0];
    return `<div class="sh-mystery" data-group="${group.key}">
      <div class="sh-mystery-row">
        <textarea class="sh-myst-name" rows="2" placeholder="Mystery name &amp; description...">${m.name || ""}</textarea>
        <div class="field field-sm sh-level-wrap"><label>Lvl</label><select class="sh-myst-level">${levelOptions(group.key, defaultLevel)}</select></div>
        <div class="field field-sm sh-dc-wrap"><label>DC</label><span class="sh-myst-dc calc-field">--</span></div>
        <div class="field field-sm sh-extra-wrap"><label>+Extra Uses</label><input type="number" class="sh-myst-extra" min="0" value="${m.extra || ""}"></div>
        <div class="sh-myst-checks" data-used="${usedCount}"></div>
        <button class="btn-remove sh-remove-mystery" title="Remove">X</button>
      </div>
    </div>`;
  }

  function rebuildChecks(entry, groupUses) {
    const wrap = entry.querySelector(".sh-myst-checks");
    if (!wrap) return;
    const extra = int(entry.querySelector(".sh-myst-extra")?.value);
    const used = int(wrap.dataset.used) || 0;
    if (groupUses === "unlimited") {
      wrap.innerHTML = `<span class="sh-unlimited">∞</span>`;
      wrap.dataset.used = 0;
      return;
    }
    const total = int(groupUses) + extra;
    let html = "";
    for (let i = 0; i < total; i++) {
      html += `<input type="checkbox" class="sh-use-check"${i < used ? " checked" : ""}>`;
    }
    wrap.innerHTML = html || `<span class="sh-no-uses">—</span>`;
    wrap.querySelectorAll(".sh-use-check").forEach((cb) => {
      cb.addEventListener("change", () => {
        const n = Array.from(wrap.querySelectorAll(".sh-use-check")).filter((c) => c.checked).length;
        wrap.dataset.used = n;
      });
    });
  }

  function groupUsesValue(panel, groupKey) {
    return panel.querySelector(`.sh-uses[data-group="${groupKey}"]`)?.value || "1";
  }

  // Compute and stamp the mystery DC (10 + level + ability mod). The
  // ability mod comes from the bonus-aware mod fn handed in by Spells.recalc
  // via refreshDCs (see _getMod above). We fall back to 0 gracefully until
  // it's seeded.
  function recalcDC(entry, abilityCode) {
    const dcEl = entry.querySelector(".sh-myst-dc");
    if (!dcEl) return;
    const level = int(entry.querySelector(".sh-myst-level")?.value);
    let mod = 0;
    if (abilityCode && typeof _getMod === "function") {
      try { mod = _getMod(abilityCode) || 0; }
      catch (e) { mod = 0; }
    }
    dcEl.textContent = String(10 + level + mod);
  }

  function recalcAllDCs(panel) {
    const ability = panel.querySelector(".sh-ability")?.value || "";
    panel.querySelectorAll(".sh-mystery").forEach((entry) => recalcDC(entry, ability));
  }

  // Re-compute every mystery DC (called from Spells.recalc when ability
  // scores change, so a Cha/Wis/Int bump flows into the DCs). Seeds the
  // module's bonus-aware mod fn that recalcDC reads. Mirrors SLA.refreshDCs.
  function refreshDCs(panel, getMod) {
    if (typeof getMod === "function") _getMod = getMod;
    recalcAllDCs(panel);
  }

  function wire(panel) {
    function wireMystery(entry) {
      const group = entry.dataset.group;
      entry.querySelector(".sh-remove-mystery").addEventListener("click", () => entry.remove());
      const extraEl = entry.querySelector(".sh-myst-extra");
      if (extraEl) extraEl.addEventListener("input", () => rebuildChecks(entry, groupUsesValue(panel, group)));
      const levelEl = entry.querySelector(".sh-myst-level");
      if (levelEl) levelEl.addEventListener("change", () => recalcAllDCs(panel));
      rebuildChecks(entry, groupUsesValue(panel, group));
      recalcDC(entry, panel.querySelector(".sh-ability")?.value || "");
    }

    panel.querySelectorAll(".sh-mystery").forEach(wireMystery);
    // Re-compute DCs whenever the mystery-ability dropdown changes.
    const abilEl = panel.querySelector(".sh-ability");
    if (abilEl) abilEl.addEventListener("change", () => recalcAllDCs(panel));

    panel.querySelectorAll(".sh-add-mystery").forEach((btn) => {
      btn.addEventListener("click", () => {
        const group = GROUPS.find((g) => g.key === btn.dataset.group);
        const list = btn.previousElementSibling;
        const wrap = document.createElement("div");
        wrap.innerHTML = mysteryRow(group, {});
        const entry = wrap.firstElementChild;
        list.appendChild(entry);
        wireMystery(entry);
      });
    });

    panel.querySelectorAll(".sh-uses").forEach((sel) => {
      sel.addEventListener("change", () => {
        const group = sel.dataset.group;
        panel.querySelectorAll(`.sh-mystery[data-group="${group}"]`).forEach((entry) => {
          const wrap = entry.querySelector(".sh-myst-checks");
          if (wrap) wrap.dataset.used = 0;
          rebuildChecks(entry, sel.value);
        });
      });
    });

    panel.querySelector(".sh-reset-all").addEventListener("click", () => {
      panel.querySelectorAll(".sh-myst-checks").forEach((wrap) => {
        wrap.dataset.used = 0;
        wrap.querySelectorAll(".sh-use-check").forEach((cb) => { cb.checked = false; });
      });
    });
  }

  function collect(panel) {
    const caster = {
      casterLevel: panel.querySelector(".sh-caster-level")?.value || "",
      ability: panel.querySelector(".sh-ability")?.value || "",
      conditional: panel.querySelector(".sh-conditional")?.value || "",
    };
    GROUPS.forEach((g) => {
      const g_obj = { uses: panel.querySelector(`.sh-uses[data-group="${g.key}"]`)?.value || g.defaultUses, mysteries: [] };
      panel.querySelectorAll(`.sh-mystery[data-group="${g.key}"]`).forEach((entry) => {
        const wrap = entry.querySelector(".sh-myst-checks");
        g_obj.mysteries.push({
          name: entry.querySelector(".sh-myst-name")?.value || "",
          level: entry.querySelector(".sh-myst-level")?.value || "",
          extra: entry.querySelector(".sh-myst-extra")?.value || "",
          used: wrap ? int(wrap.dataset.used) : 0,
        });
      });
      caster[g.key] = g_obj;
    });
    return caster;
  }

  return { buildHTML, wire, collect, refreshDCs };
})();
