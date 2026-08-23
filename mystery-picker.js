// mystery-picker.js — Shadowcaster mystery picker. Wires into the
// Spells > Shadowcasting sub-tab (built by shadowcaster.js).
//
// Two integrations per shadowcaster panel:
//   (1) Event-delegated autocomplete on each .sh-myst-name textarea —
//       typing an exact-match mystery name fills in the description
//       below the name.
//   (2) A per-panel picker bar (path + progression filter + mystery
//       autocomplete + add button) injected above the four group
//       sections. The add button inserts a new mystery row into the
//       group matching the mystery's progression
//       (Fundamental → fund, Apprentice → app, Initiate → init,
//        Master → mast) and fills in its textarea.

(function () {
  if (!window.DB) {
    console.warn('[mystery-picker] DB module not loaded');
    return;
  }

  const mysteryIndex = new Map();
  let datalistCounter = 0;
  let paths = [];

  // Map from progression label → shadowcaster group key.
  const PROG_TO_GROUP = {
    'Fundamental': 'fund',
    'Apprentice':  'app',
    'Initiate':    'init',
    'Master':      'mast',
  };

  function rebuildIndex() {
    const rows = DB.query(
      "SELECT id AS mystery_id, name, source, version, "
      + "json_extract(data, '$.path')                 AS path, "
      + "json_extract(data, '$.mystery_level')        AS mystery_level, "
      + "json_extract(data, '$.level_in_progression') AS progression, "
      + "json_extract(data, '$.type')                 AS type, "
      + "json_extract(data, '$.school')               AS school, "
      + "json_extract(data, '$.components')           AS components, "
      + "json_extract(data, '$.casting_time')         AS casting_time, "
      + "json_extract(data, '$.range')                AS range, "
      + "json_extract(data, '$.target')               AS target, "
      + "json_extract(data, '$.duration')             AS duration, "
      + "json_extract(data, '$.saving_throw')         AS saving_throw, "
      + "json_extract(data, '$.spell_resistance')     AS spell_resistance, "
      + "json_extract(data, '$.description')          AS description "
      + "FROM entry WHERE type = 'mystery' "
      + "ORDER BY name COLLATE NOCASE, "
      + "CASE version WHEN '3.5' THEN 0 ELSE 1 END"
    );
    mysteryIndex.clear();
    const pathSet = new Set();
    for (const r of rows) {
      if (window.BookFilter && !window.BookFilter.allowsEntry({...r, type: 'mystery'})) continue;
      const key = (r.name || '').toLowerCase();
      if (mysteryIndex.has(key)) continue;
      mysteryIndex.set(key, r);
      if (r.path) pathSet.add(r.path);
    }
    paths = [...pathSet].sort();
    console.log(`[mystery-picker] indexed ${mysteryIndex.size} mysteries ` +
      `across ${paths.length} paths`);
  }

  function init() {
    rebuildIndex();

    buildSharedDatalist();
    syncTextareaAttributes();
    wireTextareaDelegation();
    observePanels();

    document.addEventListener('book-filter-changed', () => {
      rebuildIndex();
      const dl = document.getElementById('mystery-picker-all');
      if (dl) {
        dl.innerHTML = '';
        for (const m of mysteryIndex.values()) {
          const opt = document.createElement('option');
          opt.value = m.name;
          dl.appendChild(opt);
        }
      }
    });
  }

  // ---------- Per-textarea autocomplete (uses sh-myst-name) ----------------

  function buildSharedDatalist() {
    let dl = document.getElementById('mystery-picker-all');
    if (dl) return;
    dl = document.createElement('datalist');
    dl.id = 'mystery-picker-all';
    for (const m of mysteryIndex.values()) {
      const opt = document.createElement('option');
      opt.value = m.name;
      // No opt.label — Firefox renders it as visible suggestion text.
      dl.appendChild(opt);
    }
    document.body.appendChild(dl);
  }

  function syncTextareaAttributes() {
    for (const ta of document.querySelectorAll('.sh-myst-name')) {
      if (ta.getAttribute('list') !== 'mystery-picker-all') {
        ta.setAttribute('list', 'mystery-picker-all');
        ta.setAttribute('autocomplete', 'off');
      }
    }
  }

  function wireTextareaDelegation() {
    const handler = (ev) => {
      const ta = ev.target;
      if (!(ta instanceof HTMLTextAreaElement)) return;
      if (!ta.classList.contains('sh-myst-name')) return;
      // Match only on the first line — the user may continue typing
      // their own notes below.
      const firstLine = String(ta.value || '').split(/\r?\n/, 1)[0].trim();
      const m = mysteryIndex.get(firstLine.toLowerCase());
      if (!m) return;
      fillFromMystery(ta, m);
    };
    document.addEventListener('input', handler);
    document.addEventListener('change', handler);
  }

  function fillFromMystery(textarea, m) {
    const cur = String(textarea.value || '');
    const lines = cur.split(/\r?\n/);
    // Only fill if the textarea has just the bare name (no body text).
    // Otherwise the user has already edited it — leave it alone.
    const bodyExists = lines.slice(1).some(l => l.trim().length);
    if (bodyExists) return;
    textarea.value = `${m.name}\n${formatMysteryDesc(m)}`;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function formatMysteryDesc(m) {
    const head = [m.path, m.progression, `L${m.mystery_level ?? '?'}`]
      .filter(Boolean).join(' · ');
    const meta = [m.school, m.range, m.duration, m.saving_throw]
      .filter(Boolean).join(' · ');
    const lines = [head];
    if (meta) lines.push(meta);
    if (m.description) lines.push(m.description);
    return lines.join('\n');
  }

  // ---------- Per-panel picker bar -----------------------------------------

  function observePanels() {
    const ob = new MutationObserver(() => {
      sweepPanels();
      syncTextareaAttributes();
    });
    ob.observe(document.body, { childList: true, subtree: true });
    sweepPanels();
  }

  function sweepPanels() {
    const panels = document.querySelectorAll(
      '#spells-content [data-caster-type="shadowcaster"]'
    );
    for (const panel of panels) {
      if (panel.querySelector('.mystery-picker')) continue;
      injectPicker(panel);
    }
  }

  function injectPicker(panel) {
    // The mystery groups (`.sh-group[data-group="fund"]`, …) are nested
    // inside a `.shadowcaster-2col` grid, NOT direct children of the panel —
    // so inject the picker bar before that grid (or before the first group's
    // actual parent) so it sits above the groups. (Inserting at the PANEL
    // level relative to firstGroup threw NotFoundError because firstGroup
    // isn't a child of the panel — the bar silently never appeared; the
    // MutationObserver swallowed the error.)
    const firstGroup = panel.querySelector('.sh-group');
    if (!firstGroup) return;
    const anchor = panel.querySelector('.shadowcaster-2col') || firstGroup;
    const anchorParent = anchor.parentElement;
    if (!anchorParent) return;

    const dlId = `mystery-picker-options-${++datalistCounter}`;
    const pathOptions = paths
      .map(p => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`)
      .join('');

    const wrap = document.createElement('div');
    wrap.className = 'mystery-picker';
    wrap.style.cssText =
      'padding:0.5rem; margin-bottom:0.5rem; ' +
      'background:rgba(255,255,255,0.04); border-left:3px solid #6a8a6a; ' +
      'border-radius:3px;';
    wrap.innerHTML = `
      <div style="display:flex;gap:0.4rem;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="flex:1 1 10rem;min-width:8rem">
          <label>Path</label>
          <select class="myp-path">
            <option value="">(any)</option>
            ${pathOptions}
          </select>
        </div>
        <div class="field" style="flex:1 1 8rem;min-width:7rem">
          <label>Progression</label>
          <select class="myp-prog">
            <option value="">(any)</option>
            <option value="Fundamental">Fundamental</option>
            <option value="Apprentice">Apprentice (1-3)</option>
            <option value="Initiate">Initiate (4-6)</option>
            <option value="Master">Master (7-9)</option>
          </select>
        </div>
        <div class="field" style="flex:1 1 11rem;min-width:9rem">
          <label>Tags</label>
          <div class="myp-tag-host"></div>
        </div>
        <div class="field" style="flex:2 1 14rem;min-width:12rem">
          <label>Mystery</label>
          <input type="text" class="myp-mystery" list="${dlId}"
                 placeholder="(filter then pick)" autocomplete="off">
          <datalist id="${dlId}"></datalist>
        </div>
        <button type="button" class="btn-add myp-add"
                title="Add a mystery row to the matching group">
          + Add
        </button>
      </div>
      <div class="myp-info"
           style="display:none;font-size:0.85em;color:#ccc;margin-top:0.4rem">
      </div>
    `;
    anchorParent.insertBefore(wrap, anchor);
    wirePicker(panel, wrap, dlId);
  }

  function wirePicker(panel, picker, dlId) {
    const pathSel  = picker.querySelector('.myp-path');
    const progSel  = picker.querySelector('.myp-prog');
    const mysIn    = picker.querySelector('.myp-mystery');
    const info     = picker.querySelector('.myp-info');
    const addBtn   = picker.querySelector('.myp-add');
    const datalist = picker.querySelector(`#${dlId}`);
    const tagHost  = picker.querySelector('.myp-tag-host');

    // Shared tag-filter (chip widget + per-type index + contextual counts).
    const tags = (window.PickerTagFilter)
      ? PickerTagFilter.attach(tagHost, {
          type: 'mystery',
          placeholder: 'Filter by tag(s)…',
          onChange: () => refresh(),
        })
      : null;

    // Shared browsing-chip helper. Chip click: set value + show info
    // DIRECTLY without dispatching 'input' (which would narrow the
    // chip wall to the picked entry). Spell-picker behavior.
    const results = (typeof PickerResults !== 'undefined')
      ? PickerResults.attach(picker, {
          itemNoun: 'mystery',
          onPick: (name) => {
            mysIn.value = name;
            updateInfo();
            mysIn.focus();
          },
        })
      : null;

    function refresh() {
      const path = pathSel.value;
      const prog = progSel.value;
      const tagF = tags ? tags.buildFilter() : null;
      datalist.innerHTML = '';
      const names = [];
      // preTagIds = passing every filter EXCEPT tags, for contextual counts.
      const preTagIds = new Set();
      for (const m of mysteryIndex.values()) {
        if (path && m.path !== path) continue;
        if (prog && m.progression !== prog) continue;
        preTagIds.add(m.mystery_id);
        if (tagF && !tags.passes(tagF, m.mystery_id)) continue;
        const opt = document.createElement('option');
        opt.value = m.name;
        // No opt.label — Firefox renders it as visible suggestion text.
        datalist.appendChild(opt);
        names.push(m.name);
      }
      const n = names.length;
      mysIn.placeholder = n
        ? `${n} myster${n === 1 ? 'y' : 'ies'}`
        : '(no matches)';
      if (results) results.render(names, { typedFilter: mysIn.value.trim() });
      if (tags) tags.refreshCounts(preTagIds);
    }

    function updateInfo() {
      const m = mysteryIndex.get(mysIn.value.trim().toLowerCase());
      if (!m) { info.style.display = 'none'; info.innerHTML = ''; return; }
      info.style.display = 'block';
      let html = renderInfo(m);
      // Other mysteries in the same path — clickable pills.
      // Shadowcaster paths typically have ~10 mysteries each across
      // Fundamental/Apprentice/Initiate/Master tiers; useful to see
      // siblings at a glance.
      if (window.Lookup && Lookup.renderSiblingsRow && m.path) {
        html += Lookup.renderSiblingsRow(
          `Other ${m.path} mysteries`,
          'mystery', 'path', m.path, m.name
        );
      }
      // "This mystery functions like the spell summon monster I, except…" —
      // 20 of the shadowcaster mysteries are deltas of a PHB spell (and
      // Greater Flesh Fails of its own lesser mystery). Offered inline.
      if (window.Lookup && Lookup.renderBaseReference) {
        const baseRef = Lookup.renderBaseReference({
          id: m.mystery_id, name: m.name, source: m.source,
          description: m.description,
        }, 'mystery');
        if (baseRef) html += baseRef;
      }
      info.innerHTML = html;
      if (window.Lookup && Lookup.wireSeeAlsoPills) {
        Lookup.wireSeeAlsoPills(info);
      }
      if (window.ErrataBadge) ErrataBadge.attach(info, m.mystery_id);
    }

    function add() {
      const m = mysteryIndex.get(mysIn.value.trim().toLowerCase());
      if (!m) return;
      const groupKey = PROG_TO_GROUP[m.progression];
      if (!groupKey) return;
      // Click the matching group's "+ Add Mystery" button so
      // shadowcaster.js wires up all the right per-row event handlers.
      const groupBtn = panel.querySelector(
        `.sh-add-mystery[data-group="${groupKey}"]`);
      if (!groupBtn) return;
      groupBtn.click();
      // Fill the just-added row (last .sh-mystery in the group).
      const rows = panel.querySelectorAll(
        `.sh-mystery[data-group="${groupKey}"]`);
      const last = rows[rows.length - 1];
      if (!last) return;
      const ta = last.querySelector('.sh-myst-name');
      if (!ta) return;
      ta.value = `${m.name}\n${formatMysteryDesc(m)}`;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    pathSel.addEventListener('change', () => { refresh(); updateInfo(); });
    progSel.addEventListener('change', () => { refresh(); updateInfo(); });
    // Typing narrows the chip wall via substring filter.
    mysIn.addEventListener('input',    () => { updateInfo(); refresh(); });
    mysIn.addEventListener('change',   updateInfo);
    addBtn.addEventListener('click',   add);

    refresh();
  }

  function renderInfo(m) {
    const verBadge = (window.VersionBadge ? VersionBadge.html(m.version) : '');
    const head = `<b>${escapeHtml(m.name)}</b>${verBadge} ` +
      `<span style="opacity:.7">(${escapeHtml(m.source || '?')})</span>`;
    const bits = [head];
    const meta = [
      m.path, m.progression, `L${m.mystery_level ?? '?'}`,
      m.school, m.type,
    ].filter(Boolean).map(escapeHtml).join(' · ');
    if (meta) bits.push(meta);
    const cast = [
      m.components, m.casting_time, m.range, m.duration,
      m.saving_throw, m.spell_resistance,
    ].filter(Boolean).map(escapeHtml).join(' · ');
    if (cast) bits.push(cast);
    if (m.description) {
      const d = m.description.length > 350
        ? m.description.slice(0, 350) + '…' : m.description;
      bits.push(escapeHtml(d));
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
