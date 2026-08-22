// vestige-picker.js — Vestige autocomplete + auto-fill for the
// Spells > Binding sub-tab (Tome of Magic binder).
//
// Each vestige row in the Binding panel (built by spells.js's
// vestigeRow) has:
//   .vestige-name        — name input
//   .vestige-level       — vestige level (1-8)
//   .vestige-dc          — binding DC
//   .vestige-good-pact   — Good Pact toggle (suppresses Sign/Influence)
//   .vestige-abilities   — granted abilities textarea
//   .vestige-sign        — sign + influence text (hidden when Good Pact)
//
// Strategy: shared datalist on every `.vestige-name` input. On exact
// match, auto-fill level / DC / granted abilities (combined into one
// readable block) / sign + influence. Skip filling fields the user has
// already typed into so manual edits survive.
//
// Per-panel picker bar (Vestige Level filter + Vestige autocomplete +
// "+ Bind") is injected at the top of each Bound Vestiges section.

(function () {
  if (!window.DB) {
    console.warn('[vestige-picker] DB module not loaded');
    return;
  }

  // Lower-case name → vestige record (built in init).
  const vestigeIndex = new Map();
  let datalistCounter = 0;

  function rebuildIndex() {
    const rows = DB.query(
      "SELECT id AS vestige_id, name, source, version, "
      + "json_extract(data, '$.vestige_level')         AS vestige_level, "
      + "json_extract(data, '$.binding_dc')            AS binding_dc, "
      + "json_extract(data, '$.special_requirement')   AS special_requirement, "
      + "json_extract(data, '$.manifestation')         AS manifestation, "
      + "json_extract(data, '$.sign')                  AS sign, "
      + "json_extract(data, '$.influence')             AS influence, "
      + "json_extract(data, '$.granted_abilities')     AS granted_abilities_json, "
      + "json_extract(data, '$.legend')                AS legend, "
      + "json_extract(data, '$.description')           AS description "
      + "FROM entry WHERE type = 'vestige' "
      + "ORDER BY CAST(json_extract(data, '$.vestige_level') AS INTEGER), "
      + "         name COLLATE NOCASE"
    );
    vestigeIndex.clear();
    for (const r of rows) {
      if (window.BookFilter && !window.BookFilter.allowsEntry({...r, type: 'vestige'})) continue;
      const key = (r.name || '').toLowerCase();
      if (vestigeIndex.has(key)) continue;
      let abilities = [];
      try {
        const raw = r.granted_abilities_json;
        abilities = raw ? JSON.parse(raw) : [];
      } catch (e) { /* ignore */ }
      vestigeIndex.set(key, {
        id: r.vestige_id,
        name: r.name,
        source: r.source,
        version: r.version,
        vestige_level: r.vestige_level,
        binding_dc: r.binding_dc,
        special_requirement: r.special_requirement,
        manifestation: r.manifestation,
        sign: r.sign,
        influence: r.influence,
        legend: r.legend,
        description: r.description,
        abilities: Array.isArray(abilities) ? abilities : [],
      });
    }
    console.log(`[vestige-picker] indexed ${vestigeIndex.size} vestiges`);
  }

  function init() {
    rebuildIndex();

    buildSharedDatalist();
    syncInputAttributes();
    wireDelegation();
    observePanels();

    document.addEventListener('book-filter-changed', () => {
      rebuildIndex();
      const dl = document.getElementById('vestige-picker-all');
      if (dl) {
        dl.innerHTML = '';
        for (const v of vestigeIndex.values()) {
          const opt = document.createElement('option');
          opt.value = v.name;
          dl.appendChild(opt);
        }
      }
    });
  }

  // ---------- Shared datalist on .vestige-name inputs ----------------------

  function buildSharedDatalist() {
    let dl = document.getElementById('vestige-picker-all');
    if (dl) return;
    dl = document.createElement('datalist');
    dl.id = 'vestige-picker-all';
    for (const v of vestigeIndex.values()) {
      const opt = document.createElement('option');
      opt.value = v.name;
      // No opt.label — Firefox renders it as visible suggestion text.
      dl.appendChild(opt);
    }
    document.body.appendChild(dl);
  }

  function syncInputAttributes() {
    for (const inp of document.querySelectorAll('.vestige-name')) {
      if (inp.getAttribute('list') !== 'vestige-picker-all') {
        inp.setAttribute('list', 'vestige-picker-all');
        inp.setAttribute('autocomplete', 'off');
      }
    }
  }

  function wireDelegation() {
    const handler = (ev) => {
      const inp = ev.target;
      if (!(inp instanceof HTMLInputElement)) return;
      if (!inp.classList.contains('vestige-name')) return;
      const v = vestigeIndex.get(
        String(inp.value || '').trim().toLowerCase());
      if (!v) return;
      fillFromVestige(inp, v);
    };
    document.addEventListener('input', handler);
    document.addEventListener('change', handler);
  }

  function fillFromVestige(input, v) {
    const entry = input.closest('.vestige-entry');
    if (!entry) return;
    const levelEl = entry.querySelector('.vestige-level');
    const dcEl    = entry.querySelector('.vestige-dc');
    const abilEl  = entry.querySelector('.vestige-abilities');
    const signEl  = entry.querySelector('.vestige-sign');

    if (levelEl && !levelEl.value.trim() && v.vestige_level != null) {
      levelEl.value = v.vestige_level;
      levelEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (dcEl && !dcEl.value.trim() && v.binding_dc != null) {
      dcEl.value = v.binding_dc;
      dcEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (abilEl && !abilEl.value.trim()) {
      const block = formatAbilities(v.abilities);
      if (block) {
        abilEl.value = block;
        abilEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    if (signEl && !signEl.value.trim()) {
      const txt = combineSignInfluence(v);
      if (txt) {
        signEl.value = txt;
        signEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }

  function formatAbilities(abilities) {
    if (!Array.isArray(abilities) || !abilities.length) return '';
    return abilities.map(a => {
      const name = a.name || '';
      const type = a.type ? ` (${a.type})` : '';
      const desc = a.description ? `: ${a.description}` : '';
      return `${name}${type}${desc}`;
    }).join('\n');
  }

  function combineSignInfluence(v) {
    const parts = [];
    if (v.sign) parts.push(`Sign: ${v.sign}`);
    if (v.influence) parts.push(`Influence: ${v.influence}`);
    return parts.join(' | ');
  }

  // ---------- Per-panel picker bar (Level filter + autocomplete + Bind) ----

  function observePanels() {
    const ob = new MutationObserver(() => {
      sweepPanels();
      syncInputAttributes();
    });
    ob.observe(document.body, { childList: true, subtree: true });
    sweepPanels();
  }

  function sweepPanels() {
    const panels = document.querySelectorAll(
      '#spells-content [data-caster-type="binding"]'
    );
    for (const panel of panels) {
      if (panel.querySelector('.vestige-picker')) continue;
      injectPicker(panel);
    }
  }

  function injectPicker(panel) {
    // The Bound Vestiges section starts with `.vestige-list`. Inject
    // the picker bar right before it.
    const list = panel.querySelector('.vestige-list');
    if (!list) return;

    const dlId = `vestige-picker-options-${++datalistCounter}`;
    const wrap = document.createElement('div');
    wrap.className = 'vestige-picker';
    wrap.style.cssText =
      'padding:0.5rem; margin-bottom:0.5rem; ' +
      'background:rgba(255,255,255,0.04); border-left:3px solid #6a8aaa; ' +
      'border-radius:3px;';
    wrap.innerHTML = `
      <div style="display:flex;gap:0.4rem;align-items:flex-end;flex-wrap:wrap">
        <div class="field field-sm" style="width:5.5rem">
          <label>Level</label>
          <input type="text" class="vp-level" placeholder="1-8 or ≤N"
                 title="Exact level (e.g. 3) or range (<=3, >=2, <5).&#10;Leave empty for all levels.">
        </div>
        <div class="field" style="flex:1 1 12rem;min-width:10rem">
          <label>Tags</label>
          <div class="vp-tag-host"></div>
        </div>
        <div class="field" style="flex:2 1 14rem;min-width:12rem">
          <label>Vestige</label>
          <input type="text" class="vp-vestige" list="${dlId}"
                 placeholder="(filter then pick)" autocomplete="off">
          <datalist id="${dlId}"></datalist>
        </div>
        <button type="button" class="btn-add vp-bind"
                title="Add a new bound-vestige row pre-filled">
          + Bind
        </button>
      </div>
      <div class="vp-info"
           style="display:none;font-size:0.85em;color:#ccc;margin-top:0.4rem">
      </div>
    `;
    list.parentElement.insertBefore(wrap, list);
    wirePicker(panel, wrap, dlId);
  }

  function wirePicker(panel, picker, dlId) {
    const lvlIn   = picker.querySelector('.vp-level');
    const vesIn   = picker.querySelector('.vp-vestige');
    const info    = picker.querySelector('.vp-info');
    const bindBtn = picker.querySelector('.vp-bind');
    const datalist = picker.querySelector(`#${dlId}`);
    const tagHost = picker.querySelector('.vp-tag-host');

    // Shared tag-filter (chip widget + per-type index + contextual counts).
    const tags = (window.PickerTagFilter)
      ? PickerTagFilter.attach(tagHost, {
          type: 'vestige',
          placeholder: 'Filter by tag(s)…',
          onChange: () => refresh(),
        })
      : null;

    // Shared browsing-chip helper. Chip click: set value + show info
    // DIRECTLY without dispatching 'input' (which would narrow the
    // chip wall to the picked entry). Spell-picker behavior.
    const results = (typeof PickerResults !== 'undefined')
      ? PickerResults.attach(picker, {
          itemNoun: 'vestige',
          onPick: (name) => {
            vesIn.value = name;
            updateInfo();
            vesIn.focus();
          },
        })
      : null;

    function refresh() {
      const lvlF = window.PickerTagFilter
        ? PickerTagFilter.parseLevel(lvlIn.value) : null;
      const tagF = tags ? tags.buildFilter() : null;
      datalist.innerHTML = '';
      const names = [];
      // preTagIds = the set passing every filter EXCEPT tags, for the
      // contextual tag counts (so picking one tag doesn't zero the rest).
      const preTagIds = new Set();
      for (const v of vestigeIndex.values()) {
        if (lvlF) {
          const L = Number(v.vestige_level);
          if (!(L >= lvlF.min && L <= lvlF.max)) continue;
        }
        preTagIds.add(v.id);
        if (tagF && !tags.passes(tagF, v.id)) continue;
        const opt = document.createElement('option');
        opt.value = v.name;
        // No opt.label — Firefox renders it as visible suggestion text.
        datalist.appendChild(opt);
        names.push(v.name);
      }
      const n = names.length;
      vesIn.placeholder = n
        ? `${n} vestige${n === 1 ? '' : 's'}`
        : '(no matches)';
      if (results) results.render(names, { typedFilter: vesIn.value.trim() });
      if (tags) tags.refreshCounts(preTagIds);
    }

    function updateInfo() {
      const v = vestigeIndex.get(vesIn.value.trim().toLowerCase());
      if (!v) { info.style.display = 'none'; info.innerHTML = ''; return; }
      info.style.display = 'block';
      info.innerHTML = renderInfo(v);
      // The index record stores the entry id as `id` (not vestige_id), so the
      // badge never attached when this read v.vestige_id (undefined).
      if (window.ErrataBadge) ErrataBadge.attach(info, v.id);
    }

    function bind() {
      const v = vestigeIndex.get(vesIn.value.trim().toLowerCase());
      if (!v) return;
      // Take over an EMPTY vestige entry if there is one, the way the feat
      // picker reuses a blank feat row (report rmszworfj-3ehb). A binding
      // panel opens with a blank row, so binding your first vestige used to
      // append a second one and leave the empty one sitting above it.
      //
      // "Empty" means the NAME is blank — that is the row's identity. A row
      // where someone has typed a level or a DC but no name is still an
      // unfilled row waiting for a vestige, and those values are preserved
      // by writing only the name here and letting the existing
      // event-delegated autocomplete fill the rest.
      const blank = [...panel.querySelectorAll('.vestige-entry')].find(
        row => !(row.querySelector('.vestige-name')?.value || '').trim());
      let target = blank;
      if (!target) {
        // Reuse the user-facing "+ Add Vestige" button so spells.js wires
        // the row's events.
        const addBtn = panel.querySelector('.bind-add-vestige');
        if (!addBtn) return;
        addBtn.click();
        const rows = panel.querySelectorAll('.vestige-entry');
        target = rows[rows.length - 1];
      }
      if (!target) return;
      const nameInp = target.querySelector('.vestige-name');
      if (!nameInp) return;
      nameInp.value = v.name;
      nameInp.dispatchEvent(new Event('input', { bubbles: true }));
      nameInp.dispatchEvent(new Event('change', { bubbles: true }));
    }

    lvlIn.addEventListener('input',  () => { refresh(); updateInfo(); });
    // Typing narrows the chip wall via substring filter.
    vesIn.addEventListener('input',  () => { updateInfo(); refresh(); });
    vesIn.addEventListener('change', updateInfo);
    bindBtn.addEventListener('click', bind);

    refresh();
  }

  function renderInfo(v) {
    const verBadge = (window.VersionBadge ? VersionBadge.html(v.version) : '');
    const head = `<b>${escapeHtml(v.name)}</b>${verBadge} ` +
      `<span style="opacity:.7">(${escapeHtml(v.source || '?')})</span>`;
    const bits = [head];
    const meta = [
      `Level ${v.vestige_level ?? '?'}`,
      `Binding DC ${v.binding_dc ?? '?'}`,
    ].join(' · ');
    bits.push(meta);
    if (v.sign) bits.push(`<b>Sign:</b> ${escapeHtml(v.sign)}`);
    if (v.influence) bits.push(`<b>Influence:</b> ${escapeHtml(v.influence)}`);
    if (v.abilities && v.abilities.length) {
      const list = v.abilities.map(a =>
        `${escapeHtml(a.name || '')} <span style="opacity:.6">(${escapeHtml(a.type || '?')})</span>`
      ).join(', ');
      bits.push(`<b>Abilities:</b> ${list}`);
    }
    return bits.join('<br>');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  DB.ready.then((db) => { if (db) init(); });
})();
