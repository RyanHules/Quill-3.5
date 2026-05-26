// class-variants.js — Surfaces Alternate Class Features (ACFs) and
// Racial / Planar Substitution Levels for a given class on the
// class-picker info panel.
//
// Both entry types describe a player-selectable variant tied to a
// specific class (ACFs are level-specific feature swaps; sub levels
// replace an entire class level for a particular race or theme).
// Pre-2026-05-17 ACFs were lumped into feat-picker and sub levels
// had no UI at all — neither was actually class-scoped browseable.
// This module gives them a class-context home: when the user types
// a class into the class-picker, a collapsible "Variants" section
// renders below the existing class-features summary.
//
// Each variant gets a "+ To Customizations" button that appends a
// formatted line to the Class Features tab's `#class-customizations`
// textarea — the player keeps free-form notes about which variants
// their character has. Future enhancement: tag the applied-class
// chip directly (e.g. "Wizard 5 [Spelltouched, Drow Sub L5]") and
// have removeClass strip the corresponding customization rows.

const ClassVariants = (function () {
  'use strict';

  // ---- Class-name normalization -------------------------------------
  //
  // ACF `class` strings come in a few shapes:
  //   - "Wizard"                    — exact match
  //   - "Wizard (Necromancer)"      — specialist variant of Wizard
  //   - "Sorcerer / Wizard"         — applies to either
  //   - "Cleric / Paladin"          — applies to either
  // Sub-level `class` / `base_class` strings are always a single
  // class name. To match a user-typed class name against these, we
  // tokenize on "/", "," and the word "or" and check membership.

  function tokenizeClassesField(raw) {
    if (!raw) return [];
    return String(raw)
      .replace(/\([^)]*\)/g, '')           // strip parenthesized specialty
      .split(/\s*(?:\/|,|\bor\b)\s*/i)
      .map(s => s.trim())
      .filter(Boolean);
  }

  function matchesClass(targetClass, candidateField) {
    if (!targetClass || !candidateField) return false;
    const tgt = String(targetClass).toLowerCase();
    // Direct case-insensitive equality first (handles specialist
    // variants like "Wizard (Necromancer)" only if the user typed
    // that exact string — usually they type "Wizard").
    if (candidateField.toLowerCase() === tgt) return true;
    // Bare-name match: "Wizard" → matches "Sorcerer / Wizard" and
    // "Wizard (Necromancer)" via tokenization.
    for (const t of tokenizeClassesField(candidateField)) {
      if (t.toLowerCase() === tgt) return true;
    }
    return false;
  }

  // ---- Queries ------------------------------------------------------

  function getACFs(className) {
    if (!window.DB || !DB.isLoaded()) return [];
    // Fetch all ACFs; filter in JS by tokenized class match. The DB
    // has 72 ACFs total — small enough to scan in memory per lookup.
    const rows = DB.query(
      "SELECT id, name, source, version, "
      + "json_extract(data, '$.class')         AS class_field, "
      + "json_extract(data, '$.level')         AS level, "
      + "json_extract(data, '$.replaces')      AS replaces, "
      + "json_extract(data, '$.prerequisites') AS prerequisite, "
      + "json_extract(data, '$.benefit')       AS benefit, "
      + "json_extract(data, '$.description')   AS description "
      + "FROM entry WHERE type = 'acf' "
      + "ORDER BY CAST(json_extract(data, '$.level') AS INTEGER), "
      + "         name COLLATE NOCASE"
    );
    return rows.filter(r => {
      if (window.BookFilter && !window.BookFilter.allowsEntry({...r, type: 'acf'})) return false;
      return matchesClass(className, r.class_field);
    });
  }

  function getSubLevels(className) {
    if (!window.DB || !DB.isLoaded()) return [];
    // Sub levels come in two shapes:
    //   - PlH-style: `class` field, single `level`, one entry per level
    //   - MoI-style: `base_class` field + nested `levels` array
    // Match either via class_field OR base_class_field.
    const rows = DB.query(
      "SELECT id, name, source, version, "
      + "json_extract(data, '$.class')                  AS class_field, "
      + "json_extract(data, '$.base_class')             AS base_class_field, "
      + "json_extract(data, '$.race')                   AS race, "
      + "json_extract(data, '$.level')                  AS level, "
      + "json_extract(data, '$.replaces')               AS replaces, "
      + "json_extract(data, '$.prerequisites')          AS prerequisites, "
      + "json_extract(data, '$.requirements')           AS requirements, "
      + "json_extract(data, '$.benefit')                AS benefit, "
      + "json_extract(data, '$.description')            AS description, "
      + "json_extract(data, '$.kind')                   AS kind, "
      + "json_extract(data, '$.levels')                 AS levels_json "
      + "FROM entry WHERE type = 'subst_level' "
      + "ORDER BY CAST(json_extract(data, '$.level') AS INTEGER), "
      + "         name COLLATE NOCASE"
    );
    return rows.filter(r => {
      if (window.BookFilter && !window.BookFilter.allowsEntry({...r, type: 'subst_level'})) return false;
      return matchesClass(className, r.class_field) ||
             matchesClass(className, r.base_class_field);
    });
  }

  // ---- Rendering ----------------------------------------------------

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function levelTag(level) {
    if (level == null) return '';
    return ` <span class="cv-level">L${escapeHtml(level)}</span>`;
  }

  function renderACFItem(r) {
    const replaces = r.replaces
      ? `<div class="cv-replaces"><b>Replaces:</b> ${escapeHtml(r.replaces)}</div>`
      : '';
    const prereq = r.prerequisite
      ? `<div class="cv-prereq"><b>Prereq:</b> ${escapeHtml(r.prerequisite)}</div>`
      : '';
    const benefit = r.benefit
      ? `<div class="cv-benefit"><b>Benefit:</b> ${escapeHtml(r.benefit)}</div>`
      : '';
    return `
      <div class="cv-variant cv-variant-acf"
           data-name="${escapeHtml(r.name)}"
           data-kind="ACF"
           data-class="${escapeHtml(r.class_field)}"
           data-level="${escapeHtml(r.level ?? '')}"
           data-replaces="${escapeHtml(r.replaces ?? '')}"
           data-source="${escapeHtml(r.source ?? '')}">
        <details>
          <summary>
            <span class="cv-name">${escapeHtml(r.name)}</span>${levelTag(r.level)}
            <span class="cv-source">(${escapeHtml(r.source || '?')})</span>
            <button class="cv-add btn-add btn-add-inline" type="button"
                    title="Append a tagged line to the Class Features tab's Customizations textarea">
              + To Customizations
            </button>
          </summary>
          ${replaces}${prereq}${benefit}
        </details>
      </div>
    `;
  }

  function renderSubLevelItem(r) {
    // For MoI-style entries the `levels` field is a JSON array of
    // {level, special, description} rows. Render a compact summary.
    let levelsSummary = '';
    if (r.levels_json) {
      try {
        const lvls = JSON.parse(r.levels_json);
        if (Array.isArray(lvls) && lvls.length) {
          levelsSummary = '<div class="cv-sub-levels"><b>Levels:</b> ' +
            lvls.map(l => `L${escapeHtml(l.level)}: ${escapeHtml(l.special || '—')}`).join('; ') +
            '</div>';
        }
      } catch (e) { /* ignore */ }
    }
    const raceTag = r.race
      ? ` <span class="cv-race">${escapeHtml(r.race)}</span>` : '';
    const replaces = r.replaces
      ? `<div class="cv-replaces"><b>Replaces:</b> ${escapeHtml(r.replaces)}</div>`
      : '';
    const prereq = (r.prerequisites || r.requirements)
      ? `<div class="cv-prereq"><b>Prereq:</b> ${escapeHtml(r.prerequisites || r.requirements)}</div>`
      : '';
    const benefit = r.benefit
      ? `<div class="cv-benefit"><b>Benefit:</b> ${escapeHtml(r.benefit)}</div>`
      : '';
    return `
      <div class="cv-variant cv-variant-sub"
           data-name="${escapeHtml(r.name)}"
           data-kind="Sub Level"
           data-class="${escapeHtml(r.class_field || r.base_class_field)}"
           data-level="${escapeHtml(r.level ?? '')}"
           data-race="${escapeHtml(r.race ?? '')}"
           data-replaces="${escapeHtml(r.replaces ?? '')}"
           data-source="${escapeHtml(r.source ?? '')}">
        <details>
          <summary>
            <span class="cv-name">${escapeHtml(r.name)}</span>${levelTag(r.level)}${raceTag}
            <span class="cv-source">(${escapeHtml(r.source || '?')})</span>
            <button class="cv-add btn-add btn-add-inline" type="button"
                    title="Append a tagged line to the Class Features tab's Customizations textarea">
              + To Customizations
            </button>
          </summary>
          ${replaces}${prereq}${benefit}${levelsSummary}
        </details>
      </div>
    `;
  }

  function renderInto(panel, className) {
    if (!panel || !className) return;
    // Strip any prior variants section so re-renders don't accumulate.
    const old = panel.querySelector('.class-variants');
    if (old) old.remove();
    const acfs = getACFs(className);
    const subs = getSubLevels(className);
    if (!acfs.length && !subs.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'class-variants';
    let html = '';
    if (acfs.length) {
      html += `
        <details class="cv-section" open>
          <summary class="cv-section-head">
            Alternate Class Features for ${escapeHtml(className)}
            <span class="cv-section-count">(${acfs.length})</span>
          </summary>
          <div class="cv-list">${acfs.map(renderACFItem).join('')}</div>
        </details>
      `;
    }
    if (subs.length) {
      html += `
        <details class="cv-section">
          <summary class="cv-section-head">
            Substitution Levels for ${escapeHtml(className)}
            <span class="cv-section-count">(${subs.length})</span>
          </summary>
          <div class="cv-list">${subs.map(renderSubLevelItem).join('')}</div>
        </details>
      `;
    }
    wrap.innerHTML = html;
    panel.appendChild(wrap);
    wireAddButtons(wrap);
  }

  function wireAddButtons(wrap) {
    wrap.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.cv-add');
      if (!btn) return;
      // Stop the details element from toggling open/closed when the
      // user clicks the button inside the summary.
      ev.preventDefault();
      ev.stopPropagation();
      const variant = btn.closest('.cv-variant');
      if (!variant) return;
      appendToCustomizations(variant.dataset);
    });
  }

  function appendToCustomizations(meta) {
    // The Class Features tab now hosts a structured customizations
    // list; class-features.js owns the data model + de-dupe logic.
    if (typeof ClassFeatures === 'undefined' ||
        typeof ClassFeatures.addCustomization !== 'function') {
      console.warn('[class-variants] ClassFeatures.addCustomization unavailable');
      return;
    }
    ClassFeatures.addCustomization({
      kind:     meta.kind || 'ACF',
      name:     meta.name,
      class:    meta.class || '',
      level:    meta.level || null,
      race:     meta.race || '',
      replaces: meta.replaces || '',
      source:   meta.source || '',
      notes:    '',
    });
  }

  return {
    getACFs, getSubLevels, renderInto, matchesClass,
  };
})();
