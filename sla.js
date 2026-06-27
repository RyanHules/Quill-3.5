// D&D 3.5 Character Sheet — Spell-Like Abilities sub-tab (Spells tab).
// Registered with the Spells module via addCaster("sla").
//
// One SLA sub-tab holds a list of abilities. Each ability carries its OWN
// caster level, key ability, and save DC, because a character's SLAs come
// from heterogeneous sources (race, feat, class, item) that rarely share a
// caster level or casting stat — so a panel-level CL/stat would be wrong.
//
// Usage tracking mirrors the shadowcaster checkbox pattern (.sla-checks
// with data-used). The save DC auto-computes (10 + the mimicked spell's
// level, via Sorcerer/Wizard → Cleric → Druid, + the key-ability modifier)
// and the player can override it by typing — clearing the field re-enables
// auto. Caster level is display-only and defaults to character level when
// blank.
//
// DB-additive: with no DB, manual entry still works; only the spell-level
// lookup (for auto-DC) and the spell-name datalist degrade.

const SLA = (function () {
  "use strict";

  const int = (v) => parseInt(v) || 0;

  // Bonus-aware ability-mod fn, handed in by Spells.recalc (the same
  // getModWithBonuses the rest of the Spells tab uses). NOT window.getAbilityMod
  // — app.js never exposes that globally (shadowcaster's reliance on it is a
  // latent bug). Falls back to 0 until the first recalc seeds it.
  let _getMod = null;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // SLA frequencies. "at will" → unlimited (∞, no checkboxes); the rest are
  // discrete daily uses. Covers the vast majority; higher counts are rare.
  const FREQS = ["at will", "1", "2", "3", "4", "5", "6", "8", "10"];
  function freqOptions(sel) {
    return FREQS.map((f) =>
      `<option value="${f}"${String(sel) === f ? " selected" : ""}>${f === "at will" ? "At will" : f + "/day"}</option>`
    ).join("");
  }

  function abilityOptions(sel) {
    const abs = ["INT", "WIS", "CHA", "STR", "DEX", "CON"];
    const labels = ["Int", "Wis", "Cha", "Str", "Dex", "Con"];
    return abs.map((a, i) =>
      `<option value="${a}"${a === sel ? " selected" : ""}>${labels[i]}</option>`
    ).join("");
  }

  // Shared spell-name datalist, built once off the DB for autocomplete.
  let datalistBuilt = false;
  function ensureSpellDatalist() {
    if (datalistBuilt) return;
    if (typeof DB === "undefined" || !DB.isLoaded || !DB.isLoaded()) return;
    let dl = document.getElementById("sla-spell-options");
    if (!dl) {
      dl = document.createElement("datalist");
      dl.id = "sla-spell-options";
      document.body.appendChild(dl);
    }
    try {
      const rows = DB.query("SELECT DISTINCT name FROM entry WHERE type='spell' ORDER BY name COLLATE NOCASE");
      // No option.label — Firefox renders it as visible suggestion text
      // (see CLAUDE.md datalist note).
      dl.innerHTML = rows.map((r) => `<option value="${esc(r.name)}"></option>`).join("");
      datalistBuilt = true;
    } catch (e) { /* degrade to free text */ }
  }

  // Mimicked-spell level for the save DC: Sorcerer/Wizard → Cleric → Druid,
  // then the lowest of any remaining list. Returns null when the spell isn't
  // found (homebrew / DB not ready) so the DC is left untouched.
  function lookupSpellLevel(name) {
    if (!name || typeof DB === "undefined" || !DB.isLoaded || !DB.isLoaded()) return null;
    let rows;
    try {
      rows = DB.query(
        "SELECT scl.class_name AS cls, scl.level AS lvl "
        + "FROM entry e JOIN spell_class_level scl ON scl.entry_id = e.id "
        + "WHERE e.type = 'spell' AND LOWER(e.name) = ?",
        [name.trim().toLowerCase()]);
    } catch (e) { return null; }
    if (!rows || !rows.length) return null;
    const byClass = {};
    for (const r of rows) {
      if (!(r.cls in byClass) || r.lvl < byClass[r.cls]) byClass[r.cls] = r.lvl;
    }
    for (const cls of ["Sorcerer", "Wizard", "Cleric", "Druid"]) {
      if (cls in byClass) return byClass[cls];
    }
    return Math.min.apply(null, rows.map((r) => r.lvl));
  }

  function buildHTML(idx, data) {
    const slas = (Array.isArray(data.slas) && data.slas.length) ? data.slas : [{}];
    const rows = slas.map(slaRow).join("");
    return `
      <section class="section">
        <h2>Spell-Like Abilities</h2>
        <p class="sla-note">Each ability tracks its own caster level, key ability, and save DC (sources differ). The DC auto-computes from the named spell (Sorcerer/Wizard → Cleric → Druid level) + the key-ability modifier; type a value to override, clear it to re-enable auto. Caster level defaults to character level when blank.</p>
        <button class="btn-add sla-reset-all" type="button">Reset All Uses</button>
      </section>
      <div class="sla-list">${rows}</div>
      <button class="btn-add sla-add" type="button">+ Add Spell-Like Ability</button>
    `;
  }

  function slaRow(s = {}) {
    const used = int(s.used || 0);
    const auto = s.dcAuto === false ? "0" : "1";
    return `<div class="sla-entry" data-from-source="${esc(s.fromSource || "")}">
      <div class="sla-row">
        <div class="field sla-name-wrap"><label>Ability (mimicked spell)</label><input type="text" class="sla-name" list="sla-spell-options" value="${esc(s.spell || "")}" placeholder="e.g. Darkness"></div>
        <div class="field field-sm"><label>Uses/Day</label><select class="sla-freq">${freqOptions(s.freq || "1")}</select></div>
        <div class="sla-checks" data-used="${used}"></div>
        <div class="field field-sm"><label>CL</label><input type="number" class="sla-cl" min="0" value="${esc(s.casterLevel || "")}" placeholder="char"></div>
        <div class="field field-sm"><label>Ability</label><select class="sla-ability">${abilityOptions(s.ability || "CHA")}</select></div>
        <div class="field field-sm"><label>Save DC</label><input type="number" class="sla-dc" value="${esc(s.dc || "")}" data-auto="${auto}"></div>
        <div class="field sla-src-wrap"><label>Source</label><input type="text" class="sla-source" value="${esc(s.source || "")}" placeholder="race / feat / class"></div>
        <button class="btn-feat-info sla-info" type="button" title="Show spell rules" aria-expanded="false">ⓘ</button>
        <button class="btn-remove sla-remove" type="button" title="Remove">X</button>
      </div>
    </div>`;
  }

  function rebuildChecks(entry) {
    const wrap = entry.querySelector(".sla-checks");
    if (!wrap) return;
    const freq = entry.querySelector(".sla-freq")?.value || "1";
    const used = int(wrap.dataset.used) || 0;
    if (freq === "at will") {
      wrap.innerHTML = `<span class="sla-unlimited" title="At will">∞</span>`;
      wrap.dataset.used = 0;
      return;
    }
    const total = int(freq);
    let html = "";
    for (let i = 0; i < total; i++) {
      html += `<input type="checkbox" class="sla-use-check"${i < used ? " checked" : ""}>`;
    }
    wrap.innerHTML = html || `<span class="sla-no-uses">—</span>`;
    wrap.querySelectorAll(".sla-use-check").forEach((cb) => {
      cb.addEventListener("change", () => {
        wrap.dataset.used = Array.from(wrap.querySelectorAll(".sla-use-check"))
          .filter((c) => c.checked).length;
      });
    });
  }

  // Compute + stamp the save DC unless the player has overridden it
  // (data-auto="0"). Reads the ability mod from the global recalc system.
  function recalcDC(entry) {
    const dcEl = entry.querySelector(".sla-dc");
    if (!dcEl || dcEl.dataset.auto === "0") return;
    const name = entry.querySelector(".sla-name")?.value || "";
    const lvl = lookupSpellLevel(name);
    if (lvl == null) return;  // unknown spell — leave the field as-is
    const abil = entry.querySelector(".sla-ability")?.value || "CHA";
    let mod = 0;
    if (typeof _getMod === "function") {
      try { mod = _getMod(abil) || 0; } catch (e) { mod = 0; }
    }
    dcEl.value = String(10 + lvl + mod);  // programmatic set — no input event
  }

  // Per-row ⓘ rules panel: shows the mimicked spell's rules text (school /
  // components / range / duration / save / SR / description), rendered by the
  // same Spells.renderSpellRules the Spells-Known list uses so the two match.
  // Transient (not persisted); auto-collapses when the spell name is edited so
  // stale text never sits under a renamed ability — mirrors the Feats-tab ⓘ.
  function collapseSlaRules(entry) {
    entry.querySelector(".feat-rules")?.remove();
    entry.querySelector(".sla-info")?.setAttribute("aria-expanded", "false");
  }
  function toggleSlaRules(entry) {
    if (entry.querySelector(".feat-rules")) { collapseSlaRules(entry); return; }
    const name = (entry.querySelector(".sla-name")?.value || "").trim();
    const panel = document.createElement("div");
    panel.className = "feat-rules";
    if (!name) {
      panel.innerHTML = "<i>Enter a spell name above to see its rules text.</i>";
    } else if (typeof Spells !== "undefined" &&
               typeof Spells.renderSpellRules === "function") {
      panel.innerHTML = Spells.renderSpellRules(name);
    } else {
      panel.innerHTML = "<i>Spell rules unavailable (DB not loaded).</i>";
    }
    entry.appendChild(panel);
    entry.querySelector(".sla-info")?.setAttribute("aria-expanded", "true");
  }

  function wireEntry(entry) {
    rebuildChecks(entry);
    recalcDC(entry);
    entry.querySelector(".sla-remove")?.addEventListener("click", () => entry.remove());
    entry.querySelector(".sla-info")?.addEventListener("click", () => toggleSlaRules(entry));
    entry.querySelector(".sla-freq")?.addEventListener("change", () => {
      const wrap = entry.querySelector(".sla-checks");
      if (wrap) wrap.dataset.used = 0;
      rebuildChecks(entry);
    });
    const nameEl = entry.querySelector(".sla-name");
    if (nameEl) {
      nameEl.addEventListener("input", () => { recalcDC(entry); collapseSlaRules(entry); });
      nameEl.addEventListener("change", () => recalcDC(entry));
    }
    entry.querySelector(".sla-ability")?.addEventListener("change", () => recalcDC(entry));
    const dc = entry.querySelector(".sla-dc");
    if (dc) {
      dc.addEventListener("input", () => {
        // Typing a value pins it (manual override); clearing re-enables auto.
        dc.dataset.auto = dc.value.trim() === "" ? "1" : "0";
        if (dc.dataset.auto === "1") recalcDC(entry);
      });
    }
  }

  function wire(panel) {
    ensureSpellDatalist();
    panel.querySelectorAll(".sla-entry").forEach((e) => wireEntry(e));
    panel.querySelector(".sla-add")?.addEventListener("click", () => {
      const list = panel.querySelector(".sla-list");
      const wrap = document.createElement("div");
      wrap.innerHTML = slaRow({});
      const entry = wrap.firstElementChild;
      list.appendChild(entry);
      wireEntry(entry);
    });
    panel.querySelector(".sla-reset-all")?.addEventListener("click", () => {
      panel.querySelectorAll(".sla-checks").forEach((wrap) => {
        wrap.dataset.used = 0;
        wrap.querySelectorAll(".sla-use-check").forEach((cb) => { cb.checked = false; });
      });
    });
  }

  // Re-compute every DC (called from Spells.recalc when ability scores
  // change, so a Cha bump updates the SLA DCs without touching each row).
  // Seeds the module's bonus-aware mod fn for the per-entry handlers too.
  function refreshDCs(panel, getMod) {
    if (typeof getMod === "function") _getMod = getMod;
    panel.querySelectorAll(".sla-entry").forEach((e) => recalcDC(e));
  }

  // ============================================================
  // Auto-population from sources (race now; templates/classes later)
  // ============================================================
  // SLA rows are PUSH-based, not pull-based: each row carries usage state
  // that must persist, so a source (e.g. a race) injects real rows tagged
  // data-from-source and reconciles them on change — mirroring how
  // race-picker manages Special Abilities (data-from-race) and bonus feats.

  function findOrCreatePanel() {
    let panel = document.querySelector("[data-caster-type='sla']");
    if (!panel && typeof Spells !== "undefined" && Spells.addCaster) {
      Spells.addCaster("sla");
      panel = document.querySelector("[data-caster-type='sla']");
    }
    return panel;
  }

  // Drop transient fully-blank rows (no name, no source, not source-tagged)
  // so a freshly auto-created tab doesn't show an empty row above injected ones.
  function removeBlankRows(list) {
    list.querySelectorAll(".sla-entry").forEach((e) => {
      const hasName = (e.querySelector(".sla-name")?.value || "").trim();
      const hasSrc = (e.querySelector(".sla-source")?.value || "").trim();
      if (!hasName && !hasSrc && !e.dataset.fromSource) e.remove();
    });
  }

  // Remove auto-rows whose source tag exactly matches / starts with X.
  function clearSource(label) {
    document.querySelectorAll("[data-caster-type='sla'] .sla-entry").forEach((e) => {
      if (e.dataset.fromSource === label) e.remove();
    });
  }
  function clearSourcePrefix(prefix) {
    document.querySelectorAll("[data-caster-type='sla'] .sla-entry").forEach((e) => {
      if ((e.dataset.fromSource || "").startsWith(prefix)) e.remove();
    });
  }

  // Inject (replacing any rows already under this exact label) the SLAs for a
  // source. entries: [{spell, freq, casterLevel, ability, source?}]. DC is left
  // to auto-compute. No-op (and no tab created) when entries is empty.
  function syncSource(label, entries) {
    clearSource(label);
    if (!entries || !entries.length) return;
    const panel = findOrCreatePanel();
    if (!panel) return;
    const list = panel.querySelector(".sla-list");
    if (!list) return;
    removeBlankRows(list);
    for (const e of entries) {
      const wrap = document.createElement("div");
      wrap.innerHTML = slaRow({
        spell: e.spell || "",
        freq: e.freq || "1",
        casterLevel: e.casterLevel || "",
        ability: e.ability || "CHA",
        dc: "",
        dcAuto: true,
        source: e.source || label,
        fromSource: label,
        used: 0,
      });
      const entry = wrap.firstElementChild;
      list.appendChild(entry);
      wireEntry(entry);
    }
    refreshDCs(panel, _getMod);
  }

  function collect(panel) {
    const slas = [];
    panel.querySelectorAll(".sla-entry").forEach((entry) => {
      const spell = entry.querySelector(".sla-name")?.value || "";
      const source = entry.querySelector(".sla-source")?.value || "";
      const fromSource = entry.dataset.fromSource || "";
      // Skip rows that are entirely blank (no spell, no source label).
      if (!spell.trim() && !source.trim() && !fromSource) return;
      const wrap = entry.querySelector(".sla-checks");
      const dcEl = entry.querySelector(".sla-dc");
      slas.push({
        spell,
        freq: entry.querySelector(".sla-freq")?.value || "1",
        casterLevel: entry.querySelector(".sla-cl")?.value || "",
        ability: entry.querySelector(".sla-ability")?.value || "CHA",
        dc: dcEl ? dcEl.value : "",
        dcAuto: !(dcEl && dcEl.dataset.auto === "0"),
        source,
        fromSource,
        used: wrap ? int(wrap.dataset.used) : 0,
      });
    });
    return { slas };
  }

  return { buildHTML, wire, collect, refreshDCs, syncSource, clearSource, clearSourcePrefix };
})();
