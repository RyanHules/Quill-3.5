// invocation-picker.js — Warlock / Dragonfire Adept invocation picker.
//
// As of 2026-05-17 invocations live on their own Spells sub-tab
// (mirroring Maneuvers / Mysteries / Vestiges). This module observes
// every `data-caster-type="invocations"` panel and injects a picker
// bar above its per-grade Known list: Grade filter + Subcategory
// filter + invocation autocomplete + "+ Known" button. The "+ Known"
// button appends the picked invocation to the textarea matching the
// invocation's grade (Least → `.invo-text[data-grade="least"]` etc.).
//
// History: pre-2026-05-17 this lived on the Feats & Abilities tab and
// wrote to the Special Abilities list. Moved here because invocations
// are a class-spell-list equivalent (known, at-will, picked at
// level-up) — they belong with the other spell-list-style mechanics.

(function () {
  if (!window.DB) {
    console.warn('[invocation-picker] DB module not loaded');
    return;
  }

  // Lower-case name → invocation record (see init).
  const invocationIndex = new Map();
  let grades = [];
  let subcategories = [];
  let datalistCounter = 0;

  function rebuildIndex() {
    const rows = DB.query(
      "SELECT id AS invocation_id, name, source, version, "
      + "json_extract(data, '$.kind')                    AS kind, "
      + "json_extract(data, '$.classes')                 AS classes, "
      + "json_extract(data, '$.grade')                   AS grade, "
      + "json_extract(data, '$.spell_level_equivalent')  AS spell_level_equivalent, "
      + "json_extract(data, '$.minimum_level')           AS minimum_level, "
      + "json_extract(data, '$.subcategory')             AS subcategory, "
      + "json_extract(data, '$.description')             AS description "
      + "FROM entry WHERE type = 'invocation' "
      + "ORDER BY name COLLATE NOCASE, "
      + "CASE version WHEN '3.5' THEN 0 ELSE 1 END"
    );
    invocationIndex.clear();
    const gradeSet = new Set();
    const subSet = new Set();
    for (const r of rows) {
      if (window.BookFilter && !window.BookFilter.allowsEntry({...r, type: 'invocation'})) continue;
      const key = (r.name || '').toLowerCase();
      if (invocationIndex.has(key)) continue;
      // `classes` is a JSON array of the classes that can take this
      // invocation (Warlock / Dragonfire Adept / both).
      try { r.classes = JSON.parse(r.classes || '[]'); }
      catch (e) { r.classes = []; }
      invocationIndex.set(key, r);
      if (r.grade) gradeSet.add(r.grade);
      if (r.subcategory) subSet.add(r.subcategory);
    }
    // Sort grades by canonical D&D order (Least → Lesser → Greater → Dark).
    const ORDER = ['Least', 'Lesser', 'Greater', 'Dark'];
    grades = [...gradeSet].sort((a, b) => {
      const ai = ORDER.indexOf(a), bi = ORDER.indexOf(b);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return a.localeCompare(b);
    });
    subcategories = [...subSet].sort();
    console.log(`[invocation-picker] indexed ${invocationIndex.size} ` +
      `invocations across ${grades.length} grades, ` +
      `${subcategories.length} subcategories`);
  }

  function init() {
    rebuildIndex();
    observePanels();
    document.addEventListener('book-filter-changed', () => {
      rebuildIndex();
      // Re-inject pickers so dropdown options reflect the new index.
      document.querySelectorAll('.invocation-picker').forEach(p => p.remove());
      sweepPanels();
    });
  }

  // ---------- Per-panel picker bar -----------------------------------------

  function observePanels() {
    const ob = new MutationObserver(() => sweepPanels());
    ob.observe(document.body, { childList: true, subtree: true });
    sweepPanels();
  }

  function sweepPanels() {
    const panels = document.querySelectorAll(
      '#spells-content [data-caster-type="invocations"]'
    );
    for (const panel of panels) {
      const lists = panel.querySelector('.invo-grade-lists');
      if (!lists) continue;
      if (panel.querySelector('.invocation-picker')) continue;
      injectPicker(panel, lists);
    }
  }

  function injectPicker(panel, listsEl) {
    const wrap = document.createElement('div');
    wrap.className = 'invocation-picker';
    wrap.style.cssText =
      'padding:0.5rem; margin-bottom:0.5rem; ' +
      'background:rgba(255,255,255,0.04); border-left:3px solid #6a6a8a; ' +
      'border-radius:3px;';

    const dlId = `invo-picker-options-${++datalistCounter}`;
    const gradeOpts = grades
      .map(g => `<option value="${escapeAttr(g)}">${escapeHtml(g)}</option>`)
      .join('');
    const subOpts = subcategories
      .map(s => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`)
      .join('');

    wrap.innerHTML = `
      <div style="display:flex;gap:0.4rem;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="flex:1 1 8rem;min-width:7rem">
          <label>Grade</label>
          <select class="ip-grade">
            <option value="">Any grade</option>
            ${gradeOpts}
          </select>
        </div>
        <div class="field" style="flex:1 1 10rem;min-width:9rem">
          <label>Subcategory</label>
          <select class="ip-sub">
            <option value="">Any subcategory</option>
            ${subOpts}
          </select>
        </div>
        <div class="field" style="flex:1 1 11rem;min-width:9rem">
          <label>Tags</label>
          <div class="ip-tag-host"></div>
        </div>
        <div class="field" style="flex:2 1 14rem;min-width:12rem">
          <label>Invocation</label>
          <input type="text" class="ip-invo" list="${dlId}"
                 placeholder="(filter then pick)" autocomplete="off">
          <datalist id="${dlId}"></datalist>
        </div>
        <button type="button" class="btn-add ip-add-known"
                title="Append to Known Invocations for this invocation's grade">
          + Known
        </button>
      </div>
      <div class="ip-info"
           style="display:none;font-size:0.85em;color:#ccc;margin-top:0.4rem">
      </div>
    `;
    listsEl.parentElement.insertBefore(wrap, listsEl);
    wirePicker(panel, wrap, dlId);
  }

  function wirePicker(panel, picker, dlId) {
    const gradeSel = picker.querySelector('.ip-grade');
    const subSel   = picker.querySelector('.ip-sub');
    const invoIn   = picker.querySelector('.ip-invo');
    const info     = picker.querySelector('.ip-info');
    const addK     = picker.querySelector('.ip-add-known');
    const datalist = picker.querySelector(`#${dlId}`);
    const tagHost  = picker.querySelector('.ip-tag-host');

    // Shared tag-filter (chip widget + per-type index + contextual counts).
    const tags = (window.PickerTagFilter)
      ? PickerTagFilter.attach(tagHost, {
          type: 'invocation',
          placeholder: 'Filter by tag(s)…',
          onChange: () => refresh(),
        })
      : null;

    // Shared browsing-chip helper. Chip click: set value + show info
    // DIRECTLY without dispatching 'input' (which would narrow the
    // chip wall to the picked entry). Spell-picker behavior.
    const results = (typeof PickerResults !== 'undefined')
      ? PickerResults.attach(picker, {
          itemNoun: 'invocation',
          onPick: (name) => {
            invoIn.value = name;
            updateInfo();
            invoIn.focus();
          },
        })
      : null;

    function refresh() {
      const g = gradeSel.value;
      const s = subSel.value;
      const tagF = tags ? tags.buildFilter() : null;
      // Restrict to invocations this panel's class can take. The panel is
      // stamped with data-invo-class when a Warlock / Dragonfire Adept
      // class creates it; a manually-added panel has none → show all.
      const panelClass = panel.dataset.invoClass || '';
      datalist.innerHTML = '';
      const names = [];
      // preTagIds = passing every filter EXCEPT tags, for contextual counts.
      const preTagIds = new Set();
      for (const r of invocationIndex.values()) {
        if (panelClass && Array.isArray(r.classes)
            && !r.classes.includes(panelClass)) continue;
        if (g && r.grade !== g) continue;
        if (s && r.subcategory !== s) continue;
        preTagIds.add(r.invocation_id);
        if (tagF && !tags.passes(tagF, r.invocation_id)) continue;
        const opt = document.createElement('option');
        opt.value = r.name;
        // No opt.label — Firefox renders it as visible suggestion text.
        datalist.appendChild(opt);
        names.push(r.name);
      }
      const n = names.length;
      const parts = [];
      if (g) parts.push(g);
      if (s) parts.push(s);
      // Show the live count whenever ANY filter (grade / sub / tag) is active,
      // so tag-only filtering surfaces its count too (matches the other pickers).
      const filtering = parts.length || (tags && tags.hasFilter());
      invoIn.placeholder = filtering
        ? `${n} ${parts.length ? parts.join(' + ') + ' ' : ''}` +
          `invocation${n === 1 ? '' : 's'}`
        : 'e.g. Eldritch Spear';
      if (results) results.render(names, { typedFilter: invoIn.value.trim() });
      if (tags) tags.refreshCounts(preTagIds);
    }

    function updateInfo() {
      const r = invocationIndex.get(invoIn.value.trim().toLowerCase());
      if (!r) { info.style.display = 'none'; info.innerHTML = ''; return; }
      info.style.display = 'block';
      let html = renderInfo(r);
      // Other invocations of the same grade (Least / Lesser / Greater
      // / Dark). Useful for warlocks browsing what else they can pick
      // up at the same grade.
      if (window.Lookup && Lookup.renderSiblingsRow && r.grade) {
        html += Lookup.renderSiblingsRow(
          `Other ${r.grade} invocations`,
          'invocation', 'grade', r.grade, r.name
        );
      }
      // "As draconic flight, except…" — Greater Draconic Flight is a delta of
      // its own lesser version, and Word of Changing is a delta of baleful
      // polymorph. Offered inline like everywhere else.
      if (window.Lookup && Lookup.renderBaseReference) {
        const baseRef = Lookup.renderBaseReference({
          id: r.invocation_id, name: r.name, source: r.source,
          description: r.description,
        }, 'invocation');
        if (baseRef) html += baseRef;
      }
      info.innerHTML = html;
      if (window.Lookup && Lookup.wireSeeAlsoPills) {
        Lookup.wireSeeAlsoPills(info);
      }
      if (window.ErrataBadge) ErrataBadge.attach(info, r.invocation_id);
    }

    function addToKnown() {
      const r = invocationIndex.get(invoIn.value.trim().toLowerCase());
      if (!r) { flash('Pick an invocation first.', '#a66'); return; }
      const grade = (r.grade || '').toLowerCase();
      // Known invocations are now structured rows (mirroring Spells
      // Known); route to the matching grade list. Breath effects land in
      // the Dragonfire Adept panel's "breath effect" list.
      const list = panel.querySelector(`.invo-known-list[data-grade="${grade}"]`);
      if (!list) { flash(`No "${r.grade}" list on this panel.`, '#a66'); return; }
      const exists = Array.from(list.querySelectorAll('.invo-known-name'))
        .some(inp => inp.value.trim().toLowerCase() === r.name.trim().toLowerCase());
      if (exists) { flash(`"${r.name}" already in ${r.grade}.`, '#aa8'); return; }
      if (typeof Spells !== 'undefined' && Spells.addInvocationKnown) {
        Spells.addInvocationKnown(panel, grade, r.name);
        flash(`Added "${r.name}" to ${r.grade}.`, '#7a9');
      } else {
        flash('Spells module not ready.', '#a66');
      }
    }

    function flash(msg, color) {
      const note = document.createElement('div');
      note.style.cssText = `margin-top:0.3rem;color:${color};font-style:italic`;
      note.textContent = msg;
      info.appendChild(note);
      info.style.display = 'block';
      setTimeout(() => note.remove(), 3500);
    }

    gradeSel.addEventListener('change', refresh);
    subSel  .addEventListener('change', refresh);
    // Typed-name input refreshes BOTH the info panel and the chip wall.
    invoIn  .addEventListener('input',  () => { updateInfo(); refresh(); });
    invoIn  .addEventListener('change', updateInfo);
    addK    .addEventListener('click',  addToKnown);

    refresh();
  }

  function renderInfo(r) {
    const verBadge = (window.VersionBadge ? VersionBadge.html(r.version) : '');
    const head = `<b>${escapeHtml(r.name)}</b>${verBadge} ` +
      `<span style="opacity:.7">(${escapeHtml(r.source || '?')})</span>`;
    const bits = [head];
    const meta = [
      r.grade && `${r.grade}${r.grade === 'Breath Effect' ? '' : ' invocation'}`,
      r.minimum_level != null ? `min. class level ${r.minimum_level}` : null,
      r.spell_level_equivalent != null
        ? `lvl-equiv ${r.spell_level_equivalent}` : null,
      r.subcategory && r.subcategory !== r.grade ? r.subcategory : null,
    ].filter(Boolean).map(escapeHtml).join(' · ');
    if (meta) bits.push(meta);
    let html = bits.join('<br>');
    if (r.description) {
      html += `<div class="ip-info-desc" style="margin-top:0.4rem;` +
              `line-height:1.4">${escapeHtml(r.description)}</div>`;
    }
    return html;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  DB.ready.then((db) => { if (db) init(); });
})();
