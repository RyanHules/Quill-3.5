// D&D 3.5 Character Sheet - Class Features Tab Module

const ClassFeatures = (function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const int = (v) => parseInt(v) || 0;

  const FIELDS = [
    "turn-per-day", "turn-check", "turn-damage",
    "rage-per-day", "rage-duration", "rage-str-con", "rage-will", "rage-ac",
    "rage-used", "rage-rounds",
  ];

  // ============================================================
  // Active Bonuses (bonus layer for rage, future: equipment, etc.)
  // Returns { abilities: { STR: N, ... }, saveBonuses: [{save,amount,
  // bonus_category}], ac: N } — saveBonuses is a TYPED list so the saves
  // recalc can cross-source-stack it.
  // ============================================================
  function getActiveBonuses() {
    const bonuses = { abilities: {}, saveBonuses: [], ac: 0 };

    // Rage toggle
    const rageActive = $("#rage-active");
    if (rageActive && rageActive.checked) {
      const strCon = int($("#rage-str-con")?.value) || 0;
      const willBonus = int($("#rage-will")?.value) || 0;
      const acPenalty = int($("#rage-ac")?.value) || 0;

      if (strCon) {
        bonuses.abilities.STR = (bonuses.abilities.STR || 0) + strCon;
        bonuses.abilities.CON = (bonuses.abilities.CON || 0) + strCon;
      }
      // Rage's +Will is a MORALE bonus (RAW).
      if (willBonus) {
        bonuses.saveBonuses.push({ save: "will", amount: willBonus,
                                   bonus_category: "morale" });
      }
      if (acPenalty) bonuses.ac += acPenalty;
    }

    return bonuses;
  }

  // ============================================================
  // Class Customizations (ACFs + Sub Levels)
  // ============================================================
  //
  // Structured list of variants the player has selected for their
  // applied classes. Populated by class-variants.js's
  // "+ To Customizations" button; can also be manually edited /
  // removed via the row UI.
  //
  // Each entry: { kind, name, class, level, race, replaces, source, notes }
  //   - kind: 'ACF' | 'Sub Level'
  //   - name: variant display name (e.g. "Spelltouched")
  //   - class: which class it modifies (e.g. "Wizard")
  //   - level: int class level it kicks in at
  //   - race: present for racial sub levels
  //   - replaces: free-text from the ACF/sub-level entry; used by
  //     class-picker to strike through the corresponding class
  //     features in the cumulative-features preview
  //   - source: book name
  //   - notes: user-editable free-form notes
  //
  // Public API: getCustomizations(), addCustomization(meta),
  // removeCustomization(idx).

  // Lookup map from each row's data-cust-idx → meta object so
  // collectData can rebuild the array in DOM order.
  const customizationMeta = new Map();
  let nextCustIdx = 0;

  function getCustomizations() {
    const out = [];
    $$('#class-customizations-list .cf-customization').forEach((row) => {
      const idx = row.dataset.custIdx;
      const meta = customizationMeta.get(idx);
      if (!meta) return;
      // Notes is the only field the user can mutate post-add — pull
      // its current value, but keep the rest of the metadata frozen.
      const notes = row.querySelector('.cf-cust-notes')?.value || '';
      out.push({ ...meta, notes });
    });
    return out;
  }

  function addCustomization(meta) {
    if (!meta || !meta.name) return null;
    const list = $('#class-customizations-list');
    if (!list) return null;
    // De-dupe by (name, class) — re-adding the same ACF for the same
    // class is a no-op. Different classes can have same-named ACFs in
    // principle (rare), so the class is part of the key.
    const existing = [...customizationMeta.values()].find(m =>
      m.name === meta.name && m.class === meta.class);
    if (existing) {
      // Flash the existing row briefly so the user knows it's a no-op.
      const row = list.querySelector(
        `.cf-customization[data-cust-key="${escapeAttr(meta.name + '|' + meta.class)}"]`);
      if (row) {
        row.classList.add('cf-cust-flash');
        setTimeout(() => row.classList.remove('cf-cust-flash'), 600);
      }
      return null;
    }
    const idx = String(nextCustIdx++);
    const normalized = {
      kind: String(meta.kind || 'ACF'),
      name: String(meta.name),
      class: String(meta.class || ''),
      level: meta.level != null && meta.level !== '' ? Number(meta.level) : null,
      race: meta.race ? String(meta.race) : '',
      replaces: meta.replaces ? String(meta.replaces) : '',
      source: meta.source ? String(meta.source) : '',
      notes: meta.notes ? String(meta.notes) : '',
    };
    customizationMeta.set(idx, normalized);
    const row = buildCustomizationRow(idx, normalized);
    list.appendChild(row);
    refreshCustomizationsEmptyState();
    // Notify class-picker so it can re-render its strike-through
    // preview if its info panel is open.
    document.dispatchEvent(new CustomEvent('class-customizations-changed'));
    return idx;
  }

  function removeCustomization(idx) {
    const row = $(`#class-customizations-list .cf-customization[data-cust-idx="${escapeAttr(idx)}"]`);
    if (row) row.remove();
    customizationMeta.delete(String(idx));
    refreshCustomizationsEmptyState();
    document.dispatchEvent(new CustomEvent('class-customizations-changed'));
  }

  // Bulk remove every customization whose `class` matches `className`
  // (tokenized — see ClassVariants.matchesClass). Called from
  // class-picker when the user removes a class from the multiclass
  // list. Returns the array of removed metas (for UI feedback).
  function removeCustomizationsForClass(className) {
    if (!className) return [];
    const matches = (typeof ClassVariants !== 'undefined' &&
                     typeof ClassVariants.matchesClass === 'function')
      ? ClassVariants.matchesClass
      : (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
    const toRemove = [];
    for (const [idx, meta] of customizationMeta) {
      if (matches(className, meta.class)) toRemove.push([idx, meta]);
    }
    for (const [idx] of toRemove) {
      const row = $(`#class-customizations-list .cf-customization[data-cust-idx="${escapeAttr(idx)}"]`);
      if (row) row.remove();
      customizationMeta.delete(String(idx));
    }
    if (toRemove.length) {
      refreshCustomizationsEmptyState();
      document.dispatchEvent(new CustomEvent('class-customizations-changed'));
    }
    return toRemove.map(([, meta]) => meta);
  }

  function refreshCustomizationsEmptyState() {
    const list = $('#class-customizations-list');
    const empty = $('#class-customizations-empty');
    if (!list || !empty) return;
    const hasAny = list.querySelector('.cf-customization');
    empty.style.display = hasAny ? 'none' : '';
  }

  function buildCustomizationRow(idx, meta) {
    const row = document.createElement('div');
    row.className = 'cf-customization';
    row.dataset.custIdx = idx;
    row.dataset.custKey = `${meta.name}|${meta.class}`;
    const lvlBits = [meta.class || '?'];
    if (meta.level != null) lvlBits.push(`L${meta.level}`);
    const classLine = lvlBits.join(' ');
    const raceLine = meta.race
      ? `<span class="cf-cust-race">${escapeHtml(meta.race)}</span>` : '';
    const replacesLine = meta.replaces
      ? `<div class="cf-cust-replaces"><b>Replaces:</b> ${escapeHtml(meta.replaces)}</div>` : '';
    const sourceLine = meta.source
      ? `<span class="cf-cust-source">${escapeHtml(meta.source)}</span>` : '';
    row.innerHTML = `
      <div class="cf-cust-head">
        <span class="cf-cust-kind">${escapeHtml(meta.kind)}</span>
        <span class="cf-cust-name">${escapeHtml(meta.name)}</span>
        <span class="cf-cust-class">${escapeHtml(classLine)}</span>
        ${raceLine}
        ${sourceLine}
        <button class="cf-cust-remove btn-remove" type="button"
                title="Remove this customization">×</button>
      </div>
      ${replacesLine}
      <textarea class="cf-cust-notes auto-expand" rows="1"
                placeholder="Notes (e.g. which weapon you focused, current charges, etc.)">${escapeHtml(meta.notes || '')}</textarea>
    `;
    row.querySelector('.cf-cust-remove').addEventListener('click', () => {
      removeCustomization(idx);
    });
    // Auto-expand the notes textarea once rendered (matches the rest
    // of the sheet's auto-expand pattern via app.js's autoExpandAll).
    setTimeout(() => {
      if (typeof window.autoExpand === 'function') {
        window.autoExpand(row.querySelector('.cf-cust-notes'));
      }
    }, 0);
    return row;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // Migrate the pre-2026-05-17 textarea format
  //   `[ACF] Spelltouched (Wizard L1)` (one per line)
  // into structured rows. We re-look-up each entry in the DB to
  // re-populate the `replaces` field so the strike-through preview
  // works for migrated saves. Loses any free-form text the user
  // added (the textarea was free-form); acceptable since the field
  // was created literally yesterday.
  function migrateLegacyTextarea(text) {
    if (!text || typeof text !== 'string') return [];
    const rx = /^\s*\[(ACF|Sub Level)\]\s+(.+?)\s+\(([^)]+)\)(?:\s+—\s+(.+))?\s*$/i;
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(rx);
      if (!m) continue;
      const kind = m[1];
      const name = m[2].trim();
      const classAndLevel = m[3].trim();
      const race = (m[4] || '').trim();
      const lvlMatch = classAndLevel.match(/^(.+?)\s+L(\d+)\s*$/i);
      const className = lvlMatch ? lvlMatch[1].trim() : classAndLevel;
      const level = lvlMatch ? Number(lvlMatch[2]) : null;
      // Pull the entry's full row from the DB so we can recover
      // `replaces`. Falls back to a stub entry if DB unavailable.
      let replaces = '', source = '';
      if (window.DB && DB.isLoaded()) {
        const type = kind.toLowerCase() === 'sub level' ? 'subst_level' : 'acf';
        const row = DB.queryOne(
          "SELECT source, json_extract(data, '$.replaces') AS replaces "
          + "FROM entry WHERE type = ? AND name = ? COLLATE NOCASE LIMIT 1",
          [type, name]);
        if (row) {
          replaces = row.replaces || '';
          source = row.source || '';
        }
      }
      rows.push({ kind, name, class: className, level, race, replaces, source, notes: '' });
    }
    return rows;
  }


  // ============================================================
  // Collect / Load
  // ============================================================
  function collectData() {
    const data = {};
    FIELDS.forEach((id) => {
      const el = $(`#${id}`);
      if (el) data[id] = el.value;
    });
    data["rage-active"] = $("#rage-active")?.checked || false;

    data.notes = $("#notes").value;

    // Class customizations as a structured array (replaces the
    // pre-2026-05-17 textarea field of the same name).
    data.customizations = getCustomizations();

    return data;
  }

  function loadData(data) {
    FIELDS.forEach((id) => {
      const el = $(`#${id}`);
      if (el && data[id] !== undefined) el.value = data[id];
    });

    const rageActive = $("#rage-active");
    if (rageActive) rageActive.checked = data["rage-active"] || false;

    if (data.notes !== undefined) $("#notes").value = data.notes;

    // Class customizations: clear + rebuild. Handles both shapes:
    //   - new structured array on `data.customizations`
    //   - legacy textarea string on `data["class-customizations"]`
    //     (parsed via migrateLegacyTextarea)
    const list = $('#class-customizations-list');
    if (list) {
      list.innerHTML = '';
      customizationMeta.clear();
      nextCustIdx = 0;
      let rows = [];
      if (Array.isArray(data.customizations)) {
        rows = data.customizations;
      } else if (typeof data['class-customizations'] === 'string') {
        rows = migrateLegacyTextarea(data['class-customizations']);
      }
      for (const r of rows) addCustomization(r);
      refreshCustomizationsEmptyState();
    }
  }

  // ============================================================
  // Public API
  // ============================================================
  return {
    getActiveBonuses, collectData, loadData,
    getCustomizations, addCustomization, removeCustomization,
    removeCustomizationsForClass,
  };
})();
