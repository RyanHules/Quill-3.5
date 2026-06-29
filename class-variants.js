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

  // ---- Variant-class inheritance ------------------------------------
  //
  // A "variant class" (Dragon Magazine's Mystic Ranger, Chaos Monk, …)
  // carries a `variant_of` field naming its parent base class. Variants
  // have no ACFs of their own — instead they INHERIT the parent's ACFs
  // and substitution levels, but only the ones whose traded-out class
  // feature(s) the variant actually has, surfaced at the level the
  // VARIANT gains that feature (which often differs from the parent).
  //
  // Matching is heuristic: each variant feature is derived from the
  // class_table (the `special` column + the monk-style speed/AC columns +
  // a "spells" marker), and an ACF/sub-level's free-text `replaces` is
  // tokenized and matched against that feature→level map by whole-word
  // token-subset (so "favored enemy" matches "1st favored enemy" but
  // "track" does NOT match "swift tracker"). Validated against the live
  // DB before shipping; see the prototype in the session scratchpad.
  //
  // Inclusion rule (Ryan 2026-06-29): ACFs are STRICT (the variant must
  // have EVERY feature the ACF replaces); substitution levels are
  // evaluated per-feature (shown if the variant has a replaced feature,
  // since each sub-level entry stands alone).

  const _STRIP = new Set(['the', 'a', 'an', 'to', 'of', 'when', 'standard',
    'enhancement', 'gained', 'any', 'later', 'improvements', 'option',
    'pick', 'and', 'level']);
  const _ORD = {
    first: '1', '1st': '1', second: '2', '2nd': '2', third: '3', '3rd': '3',
    fourth: '4', '4th': '4', fifth: '5', '5th': '5', sixth: '6', '6th': '6',
    seventh: '7', '7th': '7', eighth: '8', '8th': '8', ninth: '9', '9th': '9',
    tenth: '10', '10th': '10',
  };

  function featureWords(s) {
    // Keep parenthetical content (subset matching tolerates extra words
    // but they distinguish tiers — "ki strike (adamantine)" vs the generic
    // "ki strike"). Canonicalize ordinals (third→3) so they match the
    // table's numeral form; crude-singularize; drop filler.
    const out = [];
    for (let w of String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)) {
      if (!w) continue;
      w = _ORD[w] || w;
      if (_STRIP.has(w)) continue;
      if (w.length > 3 && w.endsWith('s') && w !== 'class') w = w.slice(0, -1);
      out.push(w);
    }
    return out;
  }
  function wordSet(s) { return new Set(featureWords(s)); }
  function isSubset(a, b) { for (const x of a) if (!b.has(x)) return false; return true; }

  function buildFeatureLevelMap(classData) {
    // {normalizedFeatureString: earliestLevel}
    const fmap = new Map();
    const add = (feat, lvl) => {
      const n = featureWords(feat).join(' ');
      if (!n || lvl == null) return;
      if (!fmap.has(n) || lvl < fmap.get(n)) fmap.set(n, lvl);
    };
    const table = Array.isArray(classData.class_table) ? classData.class_table : [];
    for (const row of table) {
      const lvl = row.level;
      const sp = row.special;
      if (sp && sp !== '—') for (const piece of String(sp).split(',')) add(piece, lvl);
      const sb = row.unarmored_speed_bonus;
      if (sb && sb !== '+0 ft.' && sb !== '+0' && sb !== '—') { add('fast movement', lvl); add('unarmored speed', lvl); }
      const ac = row.ac_bonus;
      if (ac && ac !== '+0' && ac !== '—') { add('armor class', lvl); add('ac bonus', lvl); }
      const spd = row.spells_per_day;
      if (Array.isArray(spd) && spd.some(x => typeof x === 'number' && x > 0)) { add('spells', lvl); add('spellcasting', lvl); }
    }
    if (classData.spellcasting && !fmap.has('spell') && !fmap.has('spells')) { add('spells', 1); add('spellcasting', 1); }
    return fmap;
  }

  function matchFeatureLevel(token, fmap) {
    // Level a variant feature matches the token, or null. An EXACT
    // word-set match wins over a looser subset match — so "Improved
    // Combat Style" resolves to the L7 feature, not the L3 generic
    // "Combat Style" it's a superset of. Only when there's no exact match
    // do we fall back to the earliest whole-word subset match (either
    // direction), which is what catches generic "Favored Enemy" →
    // "1st favored enemy".
    const ts = wordSet(token);
    if (!ts.size) return null;
    let exact = null, best = null;
    for (const [feat, lvl] of fmap) {
      const fs = wordSet(feat);
      if (ts.size === fs.size && isSubset(ts, fs)) {
        if (exact == null || lvl < exact) exact = lvl;
      } else if (isSubset(ts, fs) || isSubset(fs, ts)) {
        if (best == null || lvl < best) best = lvl;
      }
    }
    return exact != null ? exact : best;
  }

  function evaluateReplaces(replaces, fmap, strict) {
    // → {ok, level, missing[]}. Empty replaces → ok with no specific level.
    if (!replaces) return { ok: true, level: null, missing: [] };
    const toks = String(replaces).split(/,|\band\b|->|\//i)
      .map(s => s.trim()).filter(Boolean);
    if (!toks.length) return { ok: true, level: null, missing: [] };
    const levels = [], missing = [];
    for (const t of toks) {
      const lvl = matchFeatureLevel(t, fmap);
      if (lvl == null) missing.push(t); else levels.push(lvl);
    }
    const ok = strict ? missing.length === 0 : levels.length > 0;
    return { ok, level: levels.length ? Math.min(...levels) : null, missing };
  }

  function getClassData(className) {
    if (!window.DB || !DB.isLoaded()) return null;
    const rows = DB.query(
      "SELECT data FROM entry WHERE type = 'class' AND name = ? "
      + "COLLATE NOCASE LIMIT 1", [className]);
    if (!rows.length) return null;
    try { return JSON.parse(rows[0].data); } catch (e) { return null; }
  }

  // ---- Queries ------------------------------------------------------

  function allACFRows() {
    if (!window.DB || !DB.isLoaded()) return [];
    // Fetch all ACFs; filter in JS by tokenized class match. The DB
    // has ~80 ACFs total — small enough to scan in memory per lookup.
    return DB.query(
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
  }

  function bookOk(r, type) {
    return !window.BookFilter || window.BookFilter.allowsEntry({ ...r, type });
  }

  function getACFs(className) {
    if (!window.DB || !DB.isLoaded()) return [];
    const rows = allACFRows();
    // The class's own ACFs (a base class; or a variant matched by name —
    // variants have none today, but the path stays open).
    const own = rows
      .filter(r => bookOk(r, 'acf') && matchesClass(className, r.class_field))
      .map(r => ({ ...r, _effLevel: r.level }));
    // Variant classes inherit the PARENT's ACFs (strict: every replaced
    // feature must be present), surfaced at the variant's own level.
    const cd = getClassData(className);
    if (cd && cd.variant_of) {
      const fmap = buildFeatureLevelMap(cd);
      for (const r of rows) {
        if (!bookOk(r, 'acf') || !matchesClass(cd.variant_of, r.class_field)) continue;
        const ev = evaluateReplaces(r.replaces, fmap, /* strict */ true);
        if (!ev.ok) continue;
        // Tag the customization with the VARIANT class (not the parent),
        // so the class-picker's replaced-feature strikethrough — which
        // matches a customization's `class` against the applied class —
        // fires for the variant. Otherwise an inherited Ranger ACF on a
        // Mystic Ranger never strikes anything.
        own.push({ ...r, _effLevel: ev.level != null ? ev.level : r.level,
                   _inheritedFrom: cd.variant_of, _effClass: className,
                   _missing: ev.missing });
      }
    }
    return sortByEffLevel(own);
  }

  function sortByEffLevel(list) {
    return list.sort((a, b) => {
      const al = a._effLevel == null ? 99 : Number(a._effLevel);
      const bl = b._effLevel == null ? 99 : Number(b._effLevel);
      if (al !== bl) return al - bl;
      return String(a.name).localeCompare(String(b.name));
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
    const matchesEither = (cls, r) =>
      matchesClass(cls, r.class_field) || matchesClass(cls, r.base_class_field);
    const own = rows
      .filter(r => bookOk(r, 'subst_level') && matchesEither(className, r))
      .map(r => ({ ...r, _effLevel: r.level }));
    // Variant classes inherit the parent's substitution levels, evaluated
    // PER-FEATURE (lenient: shown if the variant has a replaced feature),
    // since each sub-level entry stands alone.
    const cd = getClassData(className);
    if (cd && cd.variant_of) {
      const fmap = buildFeatureLevelMap(cd);
      for (const r of rows) {
        if (!bookOk(r, 'subst_level') || !matchesEither(cd.variant_of, r)) continue;
        const ev = evaluateReplaces(r.replaces, fmap, /* strict */ false);
        if (!ev.ok) continue;
        own.push({ ...r, _effLevel: ev.level != null ? ev.level : r.level,
                   _inheritedFrom: cd.variant_of, _effClass: className,
                   _missing: ev.missing });
      }
    }
    return sortByEffLevel(own);
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

  function inheritTag(r) {
    if (!r._inheritedFrom) return '';
    return ` <span class="cv-inherited" title="Inherited from the parent class ${escapeHtml(r._inheritedFrom)}; shown at this variant's level for the replaced feature">via ${escapeHtml(r._inheritedFrom)}</span>`;
  }
  function partialNote(r) {
    // Lenient (sub-level) inheritance may match only some replaced
    // features. Surface what the variant lacks so the player adjudicates.
    if (!r._missing || !r._missing.length) return '';
    return `<div class="cv-partial"><b>Note:</b> partially applicable — this variant lacks: ${escapeHtml(r._missing.join(', '))}.</div>`;
  }

  function renderACFItem(r) {
    const effLevel = r._effLevel != null ? r._effLevel : r.level;
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
      <div class="cv-variant cv-variant-acf${r._inheritedFrom ? ' cv-inherited-item' : ''}"
           data-name="${escapeHtml(r.name)}"
           data-kind="ACF"
           data-class="${escapeHtml(r._effClass || r.class_field)}"
           data-level="${escapeHtml(effLevel ?? '')}"
           data-replaces="${escapeHtml(r.replaces ?? '')}"
           data-source="${escapeHtml(r.source ?? '')}">
        <details>
          <summary>
            <span class="cv-name">${escapeHtml(r.name)}</span>${levelTag(effLevel)}${inheritTag(r)}
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
    const effLevel = r._effLevel != null ? r._effLevel : r.level;
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
      <div class="cv-variant cv-variant-sub${r._inheritedFrom ? ' cv-inherited-item' : ''}"
           data-name="${escapeHtml(r.name)}"
           data-kind="Sub Level"
           data-class="${escapeHtml(r._effClass || r.class_field || r.base_class_field)}"
           data-level="${escapeHtml(effLevel ?? '')}"
           data-race="${escapeHtml(r.race ?? '')}"
           data-replaces="${escapeHtml(r.replaces ?? '')}"
           data-source="${escapeHtml(r.source ?? '')}">
        <details>
          <summary>
            <span class="cv-name">${escapeHtml(r.name)}</span>${levelTag(effLevel)}${inheritTag(r)}${raceTag}
            <span class="cv-source">(${escapeHtml(r.source || '?')})</span>
            <button class="cv-add btn-add btn-add-inline" type="button"
                    title="Append a tagged line to the Class Features tab's Customizations textarea">
              + To Customizations
            </button>
          </summary>
          ${replaces}${prereq}${benefit}${partialNote(r)}${levelsSummary}
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
    const cd = getClassData(className);
    const inheritNote = (cd && cd.variant_of)
      ? ` <span class="cv-inherit-note">— inherits valid ${escapeHtml(cd.variant_of)} variants at this variant's levels</span>`
      : '';
    const wrap = document.createElement('div');
    wrap.className = 'class-variants';
    let html = '';
    if (acfs.length) {
      html += `
        <details class="cv-section" open>
          <summary class="cv-section-head">
            Alternate Class Features for ${escapeHtml(className)}
            <span class="cv-section-count">(${acfs.length})</span>${inheritNote}
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
            <span class="cv-section-count">(${subs.length})</span>${inheritNote}
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
    // Exposed for the test suite + introspection:
    buildFeatureLevelMap, evaluateReplaces, matchFeatureLevel, getClassData,
  };
})();
