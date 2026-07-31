// power-picker.js — Psionic power picker. Mirrors spell-picker's
// pattern but targets the Spells > Psionics sub-tab.
//
// Per psionics panel ([data-caster-type="psionics"]) we inject a small
// picker bar above the per-level power-text textareas:
//
//   [Class ▾]  [Level]  [Power ▾]  [+ Known]
//
// "Class" is one of the keys in entry.data.level (a dict like
// {"Psion/Wilder": 3, "Telepath": 3}). When the user picks a class the
// power list filters to those that have an entry for that class. "+
// Known" appends the power name to .psi-power-text[data-lvl="N"].

(function () {
  if (!window.DB) {
    console.warn('[power-picker] DB module not loaded');
    return;
  }

  // Maps: lowercase name → record; classKey → array of (record, level)
  const powerIndex = new Map();
  const byClass = new Map();
  let classNames = [];
  let datalistCounter = 0;

  // Categorize each "class" key in entry.data.level into one of three
  // buckets so the picker's Class dropdown groups by kind. Without
  // this, the 35 keys (3 base classes + 6 Psion disciplines + 26
  // Ardent mantles) sort alphabetically into one flat list — Psychic
  // Warrior ends up below dozens of mantles, making the dropdown
  // look like a tags / descriptors list and burying the real classes.
  //
  // Sources:
  //   - Base classes: XPH (Psion/Wilder + Psychic Warrior) + CPsi
  //     (Lurk + Ardent + Divine Mind + Erudite). Ardent / Divine
  //     Mind / Erudite don't have direct keys in entry.data.level
  //     because they manifest via mantles or borrow another class's
  //     list — see COMPOSITE_POWER_LISTS below for the routing.
  //   - Psion disciplines: XPH p.17 — the six Psion specializations.
  //   - Mantles: Complete Psionic — Ardent's mantle list, also
  //     accessible to Divine Mind via the Divine Mind mantle pool.
  const POWER_CLASS_CATEGORIES = {
    classes: new Set([
      'Psion/Wilder', 'Psychic Warrior', 'Lurk',
      'Ardent', 'Divine Mind', 'Erudite',
    ]),
    disciplines: new Set([
      'Egoist', 'Kineticist', 'Nomad', 'Seer', 'Shaper', 'Telepath',
    ]),
    // Mantles = everything else (computed at index time).
  };

  function categorizePowerClassKey(key) {
    if (POWER_CLASS_CATEGORIES.classes.has(key)) return 'classes';
    if (POWER_CLASS_CATEGORIES.disciplines.has(key)) return 'disciplines';
    return 'mantles';
  }

  // Composite power lists — classes whose "list" is a union of other
  // class/discipline/mantle keys rather than their own tagged entries
  // in entry.data.level. Mirrors COMPOSITE_LISTS in spell-picker.js
  // (Sha'ir). When the user picks a composite class, the picker
  // fans out across the listed keys and dedupes by power name.
  //
  // - Ardent (Complete Psionic): picks 2 mantles at L1, +1 per 3
  //   levels — the full Ardent list is the union of ALL 26 mantles.
  // - Divine Mind (Complete Psionic): picks 1 mantle from a deity-
  //   restricted Table 1-4 list, gains a second at L6 and third at
  //   L12. Practically every mantle is accessible to SOME divine
  //   mind via SOME deity, so we surface the full pool here and let
  //   the player narrow by mantle in the picker if they want.
  // - Erudite (Complete Psionic): "knows" any Psion power via the
  //   Psion/Wilder list (with the unique-power schools-from-class
  //   restriction enforced elsewhere). Picker just surfaces the
  //   Psion list.
  //
  // Filled at index time so unknown mantles introduced by future
  // splats automatically flow into the Ardent / Divine Mind pools.
  const COMPOSITE_POWER_LISTS = {
    'Ardent':      { from: 'mantles' },
    'Divine Mind': { from: 'mantles' },
    'Erudite':     { from: ['Psion/Wilder'] },
  };

  // Resolve a class key (possibly composite) into the concrete list
  // of underlying keys to query. Returns the input key itself for
  // non-composite classes.
  function expandPowerClassKey(key) {
    const spec = COMPOSITE_POWER_LISTS[key];
    if (!spec) return [key];
    if (Array.isArray(spec.from)) return spec.from.slice();
    if (spec.from === 'mantles') {
      // Every key NOT in classes-or-disciplines is a mantle by
      // construction (see categorizePowerClassKey).
      const out = [];
      for (const k of byClass.keys()) {
        if (categorizePowerClassKey(k) === 'mantles') out.push(k);
      }
      return out;
    }
    return [key];
  }

  function rebuildIndex() {
    const rows = DB.query(
      "SELECT id AS power_id, name, source, version, discipline, "
      + "json_extract(data, '$.level')              AS level_json, "
      + "json_extract(data, '$.display')            AS display, "
      + "json_extract(data, '$.manifesting_time')   AS manifesting_time, "
      + "json_extract(data, '$.range')              AS range, "
      + "json_extract(data, '$.target')             AS target, "
      + "json_extract(data, '$.duration')           AS duration, "
      + "json_extract(data, '$.saving_throw')       AS saving_throw, "
      + "json_extract(data, '$.power_resistance')   AS power_resistance, "
      + "json_extract(data, '$.power_points')       AS power_points, "
      + "json_extract(data, '$.augment')            AS augment, "
      + "json_extract(data, '$.description')        AS description, "
      + "json_extract(data, '$.tables')             AS tables_json "
      + "FROM entry WHERE type = 'power' "
      + "ORDER BY name COLLATE NOCASE, "
      + "CASE version WHEN '3.5' THEN 0 ELSE 1 END"
    );
    powerIndex.clear();
    byClass.clear();
    for (const r of rows) {
      if (window.BookFilter && !window.BookFilter.allowsEntry({...r, type: 'power'})) continue;
      const key = (r.name || '').toLowerCase();
      if (powerIndex.has(key)) continue;
      let levelMap = null;
      try { levelMap = r.level_json ? JSON.parse(r.level_json) : null; }
      catch (e) { /* ignore */ }
      const rec = {
        id: r.power_id,
        name: r.name,
        source: r.source,
        version: r.version,
        discipline: r.discipline,
        levelMap: levelMap || {},
        display: r.display,
        manifesting_time: r.manifesting_time,
        range: r.range,
        target: r.target,
        duration: r.duration,
        saving_throw: r.saving_throw,
        power_resistance: r.power_resistance,
        power_points: r.power_points,
        augment: r.augment,
        description: r.description,
        tables_json: r.tables_json,
      };
      powerIndex.set(key, rec);
      if (levelMap && typeof levelMap === 'object') {
        for (const [cls, lvl] of Object.entries(levelMap)) {
          if (!byClass.has(cls)) byClass.set(cls, []);
          byClass.get(cls).push({ rec, level: Number(lvl) });
        }
      }
    }
    classNames = [...byClass.keys()].sort();
    console.log(`[power-picker] indexed ${powerIndex.size} powers ` +
      `across ${classNames.length} class lists`);
  }

  function init() {
    rebuildIndex();
    buildGlobalPowerDatalist();
    observePanels();
    // Per-panel pickers read from byClass at refresh time, so simply
    // rebuilding the index here is enough — next time the user touches
    // a class/level filter the new options will materialize. Also
    // re-emit the global datalist so the structured-row autocomplete
    // honors the new filter.
    document.addEventListener('book-filter-changed', () => {
      rebuildIndex();
      buildGlobalPowerDatalist();
    });
  }

  // Global #power-options datalist with every power name in the DB.
  // Used by the structured Known list's row inputs (created in
  // spells.js::createPsiKnownRow with `list="power-options"`) so the
  // user gets autocomplete when typing directly into a row instead
  // of going through the picker bar. Mirrors spell-picker.js's
  // buildGlobalSpellDatalist; sits at ~430 <option>s, well below the
  // size threshold where datalists become sluggish.
  function buildGlobalPowerDatalist() {
    const prior = document.getElementById('power-options');
    if (prior) prior.remove();
    const dl = document.createElement('datalist');
    dl.id = 'power-options';
    const seen = new Set();
    // Iterate the already-built powerIndex so the dedup + book-filter
    // logic from rebuildIndex carries through without another query.
    for (const rec of powerIndex.values()) {
      const key = rec.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const opt = document.createElement('option');
      opt.value = rec.name;
      // No `label` — Firefox renders labels as visible suggestion
      // text in datalists (see CLAUDE.md datalist note).
      dl.appendChild(opt);
    }
    document.body.appendChild(dl);
  }

  function observePanels() {
    const ob = new MutationObserver(() => sweep());
    ob.observe(document.body, { childList: true, subtree: true });
    sweep();
  }

  function sweep() {
    const panels = document.querySelectorAll(
      '#spells-content [data-caster-type="psionics"]'
    );
    for (const panel of panels) {
      if (panel.querySelector('.power-picker')) continue;
      injectPicker(panel);
    }
  }

  // Render the Class dropdown's <option>s as three <optgroup>s
  // (Classes / Disciplines / Mantles). Each group is alphabetized
  // within itself so the user can scan quickly. Empty groups are
  // skipped — e.g. a campaign with the Complete Psionic book
  // filtered out won't render the Mantles group at all.
  //
  // Composite classes (Ardent / Divine Mind / Erudite) don't appear
  // as keys in byClass — their lists are built by union over other
  // keys at query time — so we splice them into the Classes group
  // manually, gated on at least one of their underlying keys being
  // present in the current book-filter view.
  function renderClassOptions() {
    const grouped = { classes: [], disciplines: [], mantles: [] };
    for (const name of classNames) {
      grouped[categorizePowerClassKey(name)].push(name);
    }
    // Splice in composite classes IF their underlying pool has any
    // entries — keeps a Complete-Psionic-disabled campaign from
    // showing dead-end "Ardent" options.
    for (const compName of Object.keys(COMPOSITE_POWER_LISTS)) {
      const expanded = expandPowerClassKey(compName);
      const reachable = expanded.some(k => byClass.has(k));
      if (reachable && !grouped.classes.includes(compName)) {
        grouped.classes.push(compName);
      }
    }
    const labels = {
      classes:     'Classes',
      disciplines: 'Psion Disciplines',
      mantles:     'Ardent / Divine Mind Mantles',
    };
    const html = [];
    for (const k of ['classes', 'disciplines', 'mantles']) {
      if (!grouped[k].length) continue;
      html.push(`<optgroup label="${escapeAttr(labels[k])}">`);
      for (const name of grouped[k].sort()) {
        html.push(
          `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`
        );
      }
      html.push('</optgroup>');
    }
    return html.join('');
  }

  function injectPicker(panel) {
    const listsEl = panel.querySelector('.psi-power-lists');
    if (!listsEl) return;
    const tabsEl = panel.querySelector('.spell-list-tabs');
    if (!tabsEl) return;

    const dlId = `power-picker-options-${++datalistCounter}`;
    const wrap = document.createElement('div');
    wrap.className = 'power-picker';
    wrap.style.cssText =
      'padding:0.5rem; margin-bottom:0.5rem; ' +
      'background:rgba(255,255,255,0.04); border-left:3px solid #6a6aaa; ' +
      'border-radius:3px;';
    wrap.innerHTML = `
      <div style="display:flex;gap:0.4rem;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="flex:1 1 10rem;min-width:8rem">
          <label>Class</label>
          <select class="pp-class">
            <option value="">(any)</option>
            ${renderClassOptions()}
          </select>
        </div>
        <div class="field field-sm" style="width:5.5rem">
          <label>Level</label>
          <input type="text" class="pp-level" placeholder="1-9 or ≤N"
                 title="Exact level (e.g. 3) or range (<=3, >=2, <5).&#10;Leave empty for all levels.">
        </div>
        <div class="field field-sm" style="width:6.5rem">
          <label>Display</label>
          <select class="pp-display" title="Filter by the power's Display — how its manifestation is perceived (Auditory / Material / Mental / Olfactory / Visual).">
            <option value="">Any</option>
            <option value="Auditory">Auditory</option>
            <option value="Material">Material</option>
            <option value="Mental">Mental</option>
            <option value="Olfactory">Olfactory</option>
            <option value="Visual">Visual</option>
          </select>
        </div>
        <div class="field" style="flex:1 1 11rem;min-width:9rem">
          <label>Tags</label>
          <div class="pp-tag-host"></div>
        </div>
        <div class="field" style="flex:2 1 14rem;min-width:12rem">
          <label>Power</label>
          <input type="text" class="pp-power" list="${dlId}"
                 placeholder="(filter then pick)" autocomplete="off">
          <datalist id="${dlId}"></datalist>
        </div>
        <button type="button" class="btn-add pp-add-known"
                title="Append to power list at the matching level">
          + Known
        </button>
      </div>
      <div class="pp-info"
           style="display:none;font-size:0.85em;color:#ccc;margin-top:0.4rem">
      </div>
    `;
    tabsEl.parentElement.insertBefore(wrap, tabsEl);
    wirePicker(panel, wrap, dlId);
  }

  function wirePicker(panel, picker, dlId) {
    const classSel = picker.querySelector('.pp-class');
    const lvlIn    = picker.querySelector('.pp-level');
    const displaySel = picker.querySelector('.pp-display');
    const pwrIn    = picker.querySelector('.pp-power');
    const info     = picker.querySelector('.pp-info');
    const addK     = picker.querySelector('.pp-add-known');
    const datalist = picker.querySelector(`#${dlId}`);
    const tagHost  = picker.querySelector('.pp-tag-host');

    // Shared tag-filter (chip widget + per-type index + contextual counts).
    const tags = (window.PickerTagFilter)
      ? PickerTagFilter.attach(tagHost, {
          type: 'power',
          placeholder: 'Filter by tag(s)…',
          onChange: () => refresh(),
        })
      : null;

    function currentList() {
      const cls = classSel.value;
      const lvlF = window.PickerTagFilter
        ? PickerTagFilter.parseLevel(lvlIn.value) : null;
      const inRange = (L) =>
        !lvlF || (L != null && L >= lvlF.min && L <= lvlF.max);
      if (cls) {
        // Composite classes (Ardent / Divine Mind / Erudite) fan
        // out across their underlying keys; native classes just
        // return their own bucket. Dedup by power id so a single
        // mantle-shared power doesn't show up twice for Ardent.
        const keys = expandPowerClassKey(cls);
        const seen = new Set();
        const items = [];
        for (const key of keys) {
          for (const entry of (byClass.get(key) || [])) {
            if (!inRange(entry.level)) continue;
            if (seen.has(entry.rec.id)) continue;
            seen.add(entry.rec.id);
            items.push({ rec: entry.rec, level: entry.level });
          }
        }
        return items;
      }
      // No class filter: list all powers; show the lowest in-range level
      // for each power that has one (or its minimum level when unfiltered).
      const out = [];
      for (const rec of powerIndex.values()) {
        const lvls = Object.values(rec.levelMap || {});
        if (lvlF) {
          const inR = lvls.filter(L => L >= lvlF.min && L <= lvlF.max);
          if (inR.length) out.push({ rec, level: Math.min(...inR) });
        } else {
          out.push({ rec, level: lvls.length ? Math.min(...lvls) : null });
        }
      }
      return out;
    }

    // Shared browsing-chip helper — matches the spell-picker pattern
    // so the user can scan the current filter's matches without
    // having to know the exact power name.
    //
    // Chip click: set value + show info DIRECTLY without dispatching
    // 'input' (which would narrow the chip wall to the picked entry).
    const results = (typeof PickerResults !== 'undefined')
      ? PickerResults.attach(picker, {
          itemNoun: 'power',
          onPick: (name) => {
            pwrIn.value = name;
            updateInfo();
            pwrIn.focus();
          },
        })
      : null;

    function refresh() {
      let list = currentList();
      // Display filter (Auditory / Material / Mental / Olfactory / Visual).
      // A power's `display` can name two ("Material and visual"), so match by
      // substring rather than equality.
      const disp = displaySel ? displaySel.value.toLowerCase() : '';
      if (disp) {
        list = list.filter(({ rec }) =>
          String(rec.display || '').toLowerCase().includes(disp));
      }
      const tagF = tags ? tags.buildFilter() : null;
      datalist.innerHTML = '';
      const seen = new Set();
      const names = [];
      // preTagIds = passing class+level+display (but NOT tags), deduped by
      // name, for the contextual tag counts.
      const preTagIds = new Set();
      let shown = 0;
      for (const { rec } of list) {
        const k = rec.name.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        preTagIds.add(rec.id);
        if (tagF && !tags.passes(tagF, rec.id)) continue;
        const opt = document.createElement('option');
        opt.value = rec.name;
        // No opt.label — Firefox renders it as visible suggestion text.
        datalist.appendChild(opt);
        names.push(rec.name);
        shown++;
      }
      pwrIn.placeholder = shown
        ? `${shown} power${shown === 1 ? '' : 's'}`
        : '(no matches)';
      if (results) results.render(names, { typedFilter: pwrIn.value.trim() });
      if (tags) tags.refreshCounts(preTagIds);
    }

    function updateInfo() {
      const rec = powerIndex.get(pwrIn.value.trim().toLowerCase());
      if (!rec) { info.style.display = 'none'; info.innerHTML = ''; return; }
      info.style.display = 'block';
      let html = renderInfo(rec);
      // Other powers in the same discipline. Powers have a flat
      // `discipline` field (Psychometabolism etc.); levels are a
      // per-class dict, so we group by discipline only.
      if (window.Lookup && Lookup.renderSiblingsRow && rec.discipline) {
        html += Lookup.renderSiblingsRow(
          `Other ${rec.discipline} powers`,
          'power', 'discipline', rec.discipline, rec.name
        );
      }
      info.innerHTML = html;
      if (window.Lookup && Lookup.wireSeeAlsoPills) {
        Lookup.wireSeeAlsoPills(info);
      }
      // NB: the index query aliases `id AS power_id`, but rebuildIndex
      // renames it to `rec.id` — attaching with rec.power_id passed
      // undefined and the badge NEVER rendered (caught 2026-06-10; 26
      // powers carry errata records, incl. Astral Construct ×2).
      if (window.ErrataBadge) ErrataBadge.attach(info, rec.id);
    }

    function appendKnown() {
      const rec = powerIndex.get(pwrIn.value.trim().toLowerCase());
      if (!rec) return;
      const cls = classSel.value;
      let lvl;
      if (cls && rec.levelMap[cls] !== undefined) {
        lvl = Number(rec.levelMap[cls]);
      } else if (cls && COMPOSITE_POWER_LISTS[cls]) {
        // Composite class (Ardent / Divine Mind / Erudite): the
        // selected class isn't a key in rec.levelMap, but one of its
        // underlying keys is. Pick the LOWEST level across all
        // composite keys the power appears on — matches RAW for
        // Ardent who picks the lowest mantle-level of a power
        // available in her mantle list.
        const keys = expandPowerClassKey(cls);
        const candidates = keys
          .filter(k => rec.levelMap[k] !== undefined)
          .map(k => Number(rec.levelMap[k]));
        if (candidates.length) lvl = Math.min(...candidates);
      }
      if (lvl === undefined) {
        const userLvl = parseInt(lvlIn.value, 10);
        const lvls = Object.values(rec.levelMap || {}).map(Number);
        lvl = Number.isFinite(userLvl) && lvls.includes(userLvl)
          ? userLvl
          : (lvls.length ? Math.min(...lvls) : 1);
      }
      if (!Number.isFinite(lvl) || lvl < 1) return;
      // Ensure the level's Known list exists — click "+ Add Power
      // Level" until the level is in range. The .psi-add-level
      // button is the original "+ Add Power Level" control on the
      // PP-costs/DCs side.
      let listEl = panel.querySelector(
        `.psi-known-list[data-lvl="${lvl}"]`);
      let safety = 0;
      while (!listEl && safety++ < 10) {
        const addBtn = panel.querySelector('.psi-add-level');
        if (!addBtn) break;
        addBtn.click();
        listEl = panel.querySelector(
          `.psi-known-list[data-lvl="${lvl}"]`);
      }
      if (!listEl) return;
      // Dedup: don't append if a row with this power name already
      // exists at this level (case-insensitive).
      const wantedName = rec.name.toLowerCase();
      const existing = [...listEl.querySelectorAll('.psi-known-name')]
        .some(el => (el.value || '').trim().toLowerCase() === wantedName);
      if (existing) return;
      // Prefer the structured-row API if spells.js exposes it;
      // gracefully degrade to the legacy textarea otherwise (e.g. if
      // a future caster panel reverts the structural change).
      if (typeof Spells?.addKnownPower === 'function') {
        Spells.addKnownPower(listEl, lvl, rec.name);
      } else {
        const ta = panel.querySelector(`.psi-power-text[data-lvl="${lvl}"]`);
        if (ta) appendLine(ta, rec.name);
      }
    }

    classSel.addEventListener('change', () => { refresh(); updateInfo(); });
    lvlIn.addEventListener('input',    () => { refresh(); updateInfo(); });
    if (displaySel) displaySel.addEventListener('change', () => { refresh(); updateInfo(); });
    // pwrIn input: refresh BOTH the info panel AND the chip wall —
    // typing in the power name narrows the chips by substring match.
    pwrIn.addEventListener('input',    () => { updateInfo(); refresh(); });
    pwrIn.addEventListener('change',   updateInfo);
    addK.addEventListener('click',     appendKnown);

    refresh();
  }

  function appendLine(textarea, line) {
    if (!textarea) return;
    const lines = String(textarea.value || '').split(/\r?\n/);
    const exists = lines.some(
      l => l.trim().toLowerCase() === line.trim().toLowerCase());
    if (exists) return;
    const existing = String(textarea.value || '').replace(/\s+$/, '');
    textarea.value = existing ? `${existing}\n${line}` : line;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function renderInfo(rec) {
    const verBadge = (window.VersionBadge ? VersionBadge.html(rec.version) : '');
    const head = `<b>${escapeHtml(rec.name)}</b>${verBadge} ` +
      `<span style="opacity:.7">(${escapeHtml(rec.source || '?')})</span>`;
    const bits = [head];
    const meta = [
      rec.discipline,
      rec.display && `Display: ${rec.display}`,
      `PP: ${rec.power_points ?? '?'}`,
      rec.manifesting_time,
      rec.range,
      rec.duration,
    ].filter(Boolean).map(escapeHtml).join(' · ');
    if (meta) bits.push(meta);
    const lvls = Object.entries(rec.levelMap || {})
      .map(([c, l]) => `${c} ${l}`)
      .join(', ');
    if (lvls) bits.push(`<b>Classes:</b> ${escapeHtml(lvls)}`);
    if (rec.saving_throw) bits.push(`<b>Save:</b> ${escapeHtml(rec.saving_throw)}`);
    if (rec.power_resistance) bits.push(`<b>PR:</b> ${escapeHtml(rec.power_resistance)}`);
    // Base effect FIRST, augmentation after — Augment describes what
    // spending extra power points CHANGES about the effect below it, so
    // printing it first read as the whole power. And no truncation: the
    // description IS the power's mechanics (every one of them matters at
    // the table), so a 350-char cut silently hid the back half of most
    // powers. Report rms3qhc3r-gedx.
    if (rec.description) bits.push(escapeHtml(rec.description));
    if (rec.augment) bits.push(`<b>Augment:</b> ${escapeHtml(rec.augment)}`);
    // Structured data tables (Object Reading study times, Remote
    // Viewing save modifiers).
    if (rec.tables_json && window.RichText) {
      try {
        const tablesHtml = RichText.renderTables(JSON.parse(rec.tables_json));
        if (tablesHtml) bits.push(tablesHtml);
      } catch (e) { /* malformed tables JSON — skip */ }
    }
    return bits.join('<br>');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  DB.ready.then((db) => { if (db) init(); });
})();
