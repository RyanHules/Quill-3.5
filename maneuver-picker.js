// maneuver-picker.js — Tome of Battle maneuver picker. Wires into the
// Spells tab > Maneuvers sub-tab in two places:
//   (1) Autocomplete on each .tom-readied-name input: typing a known
//       maneuver name fills the sibling .tom-readied-desc textarea.
//   (2) A per-panel picker bar above the maneuver-lists section:
//       choose discipline + level (+ class filter), pick a maneuver,
//       button to append into the per-level Known Maneuvers textarea.

(function () {
  if (!window.DB) {
    console.warn('[maneuver-picker] DB module not loaded');
    return;
  }

  // Map: lowercase name → maneuver record
  let maneuverIndex = new Map();
  // Map: discipline → sorted array of maneuver records
  let byDiscipline = new Map();
  let disciplines = [];
  let datalistCounter = 0;

  function rebuildIndex() {
    const rows = DB.query(
      "SELECT id AS maneuver_id, name, source, version, discipline, "
      + "json_extract(data, '$.type')              AS type, "
      + "json_extract(data, '$.level')             AS level, "
      + "json_extract(data, '$.initiation_action') AS initiation_action, "
      + "json_extract(data, '$.range')             AS range, "
      + "json_extract(data, '$.target')            AS target, "
      + "json_extract(data, '$.duration')          AS duration, "
      + "json_extract(data, '$.saving_throw')      AS saving_throw, "
      + "json_extract(data, '$.prerequisite')      AS prerequisite, "
      + "json_extract(data, '$.classes')           AS classes_json, "
      + "json_extract(data, '$.description')       AS description "
      + "FROM entry WHERE type = 'maneuver' "
      + "ORDER BY name COLLATE NOCASE, "
      + "CASE version WHEN '3.5' THEN 0 ELSE 1 END"
    );
    maneuverIndex = new Map();
    byDiscipline = new Map();
    for (const r of rows) {
      if (window.BookFilter && !window.BookFilter.allowsEntry({...r, type: 'maneuver'})) continue;
      const key = (r.name || '').toLowerCase();
      if (maneuverIndex.has(key)) continue;
      let classes = null;
      try { classes = r.classes_json ? JSON.parse(r.classes_json) : null; }
      catch (e) { /* ignore */ }
      const rec = {
        id: r.maneuver_id,
        name: r.name,
        source: r.source,
        version: r.version,
        discipline: r.discipline,
        type: r.type,
        level: r.level,
        initiation_action: r.initiation_action,
        range: r.range,
        target: r.target,
        duration: r.duration,
        saving_throw: r.saving_throw,
        prerequisite: r.prerequisite,
        classes: classes,
        description: r.description,
      };
      maneuverIndex.set(key, rec);
      const d = r.discipline || '(unknown)';
      if (!byDiscipline.has(d)) byDiscipline.set(d, []);
      byDiscipline.get(d).push(rec);
    }
    disciplines = [...byDiscipline.keys()].sort();
    console.log(`[maneuver-picker] indexed ${maneuverIndex.size} maneuvers ` +
      `across ${disciplines.length} disciplines`);
  }

  function init() {
    rebuildIndex();

    buildSharedDatalist();
    syncReadiedAttributes();
    wireReadiedDelegation();
    // Maneuver panels are added dynamically when the user clicks
    // "+ Maneuvers" on the Spells tab. Watch the DOM for newly-built
    // panels and inject the per-level picker into each.
    observePanels();

    document.addEventListener('book-filter-changed', () => {
      rebuildIndex();
      const dl = document.getElementById('maneuver-picker-all');
      if (dl) {
        dl.innerHTML = '';
        for (const v of maneuverIndex.values()) {
          const opt = document.createElement('option');
          opt.value = v.name;
          dl.appendChild(opt);
        }
      }
    });
  }

  // ---------- All-maneuver datalist for the readied-row inputs --------------

  function buildSharedDatalist() {
    let dl = document.getElementById('maneuver-picker-all');
    if (dl) return;
    dl = document.createElement('datalist');
    dl.id = 'maneuver-picker-all';
    for (const v of maneuverIndex.values()) {
      const opt = document.createElement('option');
      opt.value = v.name;
      // No opt.label — Firefox renders it as visible suggestion text.
      dl.appendChild(opt);
    }
    document.body.appendChild(dl);
  }

  function syncReadiedAttributes() {
    for (const input of document.querySelectorAll('.tom-readied-name')) {
      if (input.getAttribute('list') !== 'maneuver-picker-all') {
        input.setAttribute('list', 'maneuver-picker-all');
        input.setAttribute('autocomplete', 'off');
      }
    }
  }

  function wireReadiedDelegation() {
    const handler = (ev) => {
      const input = ev.target;
      if (!(input instanceof HTMLInputElement)) return;
      if (!input.classList.contains('tom-readied-name')) return;
      const key = String(input.value || '').trim().toLowerCase();
      if (!maneuverIndex.has(key)) return;
      fillFromManeuver(input, maneuverIndex.get(key));
    };
    document.addEventListener('input', handler);
    document.addEventListener('change', handler);
  }

  function fillFromManeuver(input, m) {
    // Fill sibling .tom-readied-desc with a one-line summary if empty.
    const row = input.closest('.tom-readied-row');
    if (!row) return;
    const desc = row.querySelector('.tom-readied-desc');
    if (desc && !desc.value.trim()) {
      desc.value = formatReadiedDesc(m);
      desc.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function formatReadiedDesc(m) {
    const head = [m.discipline, m.type, `L${m.level ?? '?'}`]
      .filter(Boolean).join(' · ');
    const action = m.initiation_action ? ` (${m.initiation_action})` : '';
    const desc = m.description ? `\n${m.description}` : '';
    return `${head}${action}${desc}`;
  }

  // ---------- Per-panel picker bar -----------------------------------------

  function observePanels() {
    const ob = new MutationObserver(() => sweepPanels());
    ob.observe(document.body, { childList: true, subtree: true });
    sweepPanels();
  }

  function sweepPanels() {
    // Maneuvers sub-tab panels live under `#spells-content` and carry
    // `data-caster-type="maneuvers"`. (spells.js creates them in
    // `addCasterTab('maneuvers')`.)
    const panels = document.querySelectorAll(
      '#spells-content [data-caster-type="maneuvers"]'
    );
    for (const panel of panels) {
      const lists = panel.querySelector('.tom-maneuver-lists');
      if (!lists) continue;
      if (panel.querySelector('.maneuver-picker')) continue;
      injectPicker(panel, lists);
    }
  }

  // M5 (2026-05-16 play-feel pass): each ToB martial-adept class
  // accesses only a subset of the 9 disciplines. Filter the picker's
  // discipline dropdown to the panel's class. Detected by the leading
  // word in `.caster-notes` (set by class-picker on apply). When the
  // class isn't recognized (or notes are empty), fall back to showing
  // all 9 disciplines.
  // ToB Table 1-1 / 1-2 / 1-5 class-discipline mappings:
  const CLASS_DISCIPLINES = {
    'Crusader':  ['Devoted Spirit', 'Stone Dragon', 'White Raven'],
    'Swordsage': ['Desert Wind', 'Diamond Mind', 'Setting Sun',
                  'Shadow Hand', 'Stone Dragon', 'Tiger Claw'],
    'Warblade':  ['Diamond Mind', 'Iron Heart', 'Stone Dragon',
                  'Tiger Claw', 'White Raven'],
    // PrCs that gain access to additional / different discipline sets:
    'Bloodclaw Master':      ['Tiger Claw'],
    'Bloodstorm Blade':      ['Iron Heart', 'Stone Dragon', 'Tiger Claw'],
    'Deepstone Sentinel':    ['Stone Dragon'],
    'Eternal Blade':         ['Diamond Mind', 'Iron Heart'],
    'Jade Phoenix Mage':     ['Desert Wind', 'Devoted Spirit',
                              'Diamond Mind', 'Tiger Claw'],
    'Master of Nine':        [], // all 9; empty array → fall back to all
    'Ruby Knight Vindicator':['Devoted Spirit', 'Stone Dragon',
                              'White Raven'],
    'Shadow Sun Ninja':      ['Setting Sun', 'Shadow Hand'],
  };

  function detectClassForPanel(panel) {
    const notes = panel.querySelector('.caster-notes')?.value || '';
    // class-picker writes the bare class name into notes on creation
    // (e.g. "Warblade"). User may have edited; longest prefix match
    // against the known mapping is robust to that.
    const trimmed = notes.trim();
    if (!trimmed) return null;
    // Sort longer names first so "Ruby Knight Vindicator" beats
    // "Crusader" when both substrings could match.
    const names = Object.keys(CLASS_DISCIPLINES).sort(
      (a, b) => b.length - a.length);
    for (const name of names) {
      if (trimmed === name || trimmed.startsWith(name + ' ') ||
          trimmed.toLowerCase().includes(name.toLowerCase())) {
        return name;
      }
    }
    return null;
  }

  function injectPicker(panel, listsEl) {
    const wrap = document.createElement('div');
    wrap.className = 'maneuver-picker';
    wrap.style.cssText =
      'padding:0.5rem; margin-bottom:0.5rem; ' +
      'background:rgba(255,255,255,0.04); border-left:3px solid #aa6a6a; ' +
      'border-radius:3px;';

    const dlId = `maneuver-picker-options-${++datalistCounter}`;
    // Narrow disciplines per class when detectable.
    const detectedClass = detectClassForPanel(panel);
    const classDisc = detectedClass ? CLASS_DISCIPLINES[detectedClass] : null;
    const useDisc = (classDisc && classDisc.length) ? classDisc : disciplines;
    const discOptions = useDisc
      .map(d => `<option value="${escapeAttr(d)}">${escapeHtml(d)}</option>`)
      .join('');

    wrap.innerHTML = `
      <div style="display:flex;gap:0.4rem;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="flex:1 1 10rem;min-width:8rem">
          <label>Discipline</label>
          <select class="mp-discipline">
            <option value="">(any)</option>
            ${discOptions}
          </select>
        </div>
        <div class="field field-sm" style="width:5rem">
          <label>Level</label>
          <input type="number" class="mp-level" min="1" max="9" placeholder="any">
        </div>
        <div class="field" style="flex:2 1 14rem;min-width:12rem">
          <label>Maneuver</label>
          <input type="text" class="mp-maneuver" list="${dlId}"
                 placeholder="(filter then pick)" autocomplete="off">
          <datalist id="${dlId}"></datalist>
        </div>
        <button type="button" class="btn-add mp-add-known"
                title="Append to Known Maneuvers at picked level">
          + Known
        </button>
        <button type="button" class="btn-add mp-add-readied"
                title="Append as a new readied-maneuvers row">
          + Readied
        </button>
      </div>
      <div class="mp-info"
           style="display:none;font-size:0.85em;color:#ccc;margin-top:0.4rem">
      </div>
    `;
    listsEl.parentElement.insertBefore(wrap, listsEl);

    wirePicker(panel, wrap, dlId);
  }

  function wirePicker(panel, picker, dlId) {
    const discSel = picker.querySelector('.mp-discipline');
    const lvlIn   = picker.querySelector('.mp-level');
    const manIn   = picker.querySelector('.mp-maneuver');
    const info    = picker.querySelector('.mp-info');
    const addK    = picker.querySelector('.mp-add-known');
    const addR    = picker.querySelector('.mp-add-readied');
    const datalist = picker.querySelector(`#${dlId}`);

    // Shared browsing-chip helper. Chip click sets value + shows info
    // DIRECTLY without dispatching 'input' — that would narrow the
    // chip wall to the picked entry. Spell-picker behavior.
    const results = (typeof PickerResults !== 'undefined')
      ? PickerResults.attach(picker, {
          itemNoun: 'maneuver',
          onPick: (name) => {
            manIn.value = name;
            updateInfo();
            manIn.focus();
          },
        })
      : null;

    function refresh() {
      const disc = discSel.value || '';
      const lvl  = parseInt(lvlIn.value, 10);
      const wantLevel = Number.isFinite(lvl) && lvl > 0;
      const list = disc ? (byDiscipline.get(disc) || []) :
                          [...maneuverIndex.values()];
      const filtered = list.filter(m =>
        !wantLevel || Number(m.level) === lvl);
      datalist.innerHTML = '';
      const names = [];
      for (const m of filtered) {
        const opt = document.createElement('option');
        opt.value = m.name;
        // No opt.label — Firefox renders it as visible suggestion text.
        datalist.appendChild(opt);
        names.push(m.name);
      }
      manIn.placeholder = filtered.length
        ? `${filtered.length} maneuver${filtered.length === 1 ? '' : 's'}`
        : '(no matches)';
      if (results) results.render(names, { typedFilter: manIn.value.trim() });
    }

    function updateInfo() {
      const key = manIn.value.trim().toLowerCase();
      const m = maneuverIndex.get(key);
      if (!m) { info.style.display = 'none'; info.innerHTML = ''; return; }
      info.style.display = 'block';
      info.innerHTML = renderInfo(m);
      if (window.ErrataBadge) ErrataBadge.attach(info, m.maneuver_id);
    }

    function appendToKnown() {
      const m = maneuverIndex.get(manIn.value.trim().toLowerCase());
      if (!m) return;
      const lvl = Number(m.level);
      if (!Number.isFinite(lvl) || lvl < 1 || lvl > 9) return;
      const ta = panel.querySelector(
        `.tom-maneuver-text[data-lvl="${lvl}"]`);
      if (!ta) return;
      appendLine(ta, m.name);
    }

    function appendToReadied() {
      const m = maneuverIndex.get(manIn.value.trim().toLowerCase());
      if (!m) return;
      // Reuse the user-facing "+ Add Readied Maneuver" button so the
      // row gets all the right event wiring from spells.js.
      const addBtn = panel.querySelector('.tom-add-readied');
      if (!addBtn) return;
      addBtn.click();
      // Fill the last-appended row with our maneuver.
      const rows = panel.querySelectorAll('.tom-readied-row');
      const last = rows[rows.length - 1];
      if (!last) return;
      const name = last.querySelector('.tom-readied-name');
      const desc = last.querySelector('.tom-readied-desc');
      if (name) {
        name.value = m.name;
        name.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (desc) {
        desc.value = formatReadiedDesc(m);
        desc.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    discSel.addEventListener('change', () => { refresh(); updateInfo(); });
    lvlIn.addEventListener('input',   () => { refresh(); updateInfo(); });
    // Typed-name input also refreshes the chip wall so it narrows
    // by substring as the user types.
    manIn.addEventListener('input',   () => { updateInfo(); refresh(); });
    manIn.addEventListener('change',  updateInfo);
    addK.addEventListener('click', appendToKnown);
    addR.addEventListener('click', appendToReadied);

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

  // L5 (2026-05-17 play-feel pass): bring renderInfo up to parity
  // with spell-picker — header line with name+source, full meta
  // strip joined by middots (discipline / type / level / initiation
  // action / range / target / duration / save / prereq / classes),
  // then the rules description on its own line below.
  function renderInfo(m) {
    const bits = [];
    bits.push(`<b>${escapeHtml(m.name)}</b> ` +
      `<span style="opacity:.7">(${escapeHtml(m.source || '?')})</span>`);
    if (m.discipline)        bits.push(`<b>Discipline:</b> ${escapeHtml(m.discipline)}`);
    if (m.type)              bits.push(`<b>Type:</b> ${escapeHtml(m.type)}`);
    if (m.level != null)     bits.push(`<b>Level:</b> ${escapeHtml(String(m.level))}`);
    if (m.initiation_action) bits.push(`<b>Action:</b> ${escapeHtml(m.initiation_action)}`);
    if (m.range)             bits.push(`<b>Range:</b> ${escapeHtml(m.range)}`);
    if (m.target)            bits.push(`<b>Target:</b> ${escapeHtml(m.target)}`);
    if (m.duration)          bits.push(`<b>Duration:</b> ${escapeHtml(m.duration)}`);
    if (m.saving_throw)      bits.push(`<b>Save:</b> ${escapeHtml(m.saving_throw)}`);
    if (m.prerequisite)      bits.push(`<b>Prereq:</b> ${escapeHtml(m.prerequisite)}`);
    if (Array.isArray(m.classes) && m.classes.length) {
      bits.push(`<b>Classes:</b> ${escapeHtml(m.classes.join(', '))}`);
    }
    let html = bits.join(' &nbsp;·&nbsp; ');
    if (m.description) {
      html += `<div class="mp-info-desc" style="margin-top:0.4rem;` +
              `line-height:1.4">${escapeHtml(m.description)}</div>`;
    }
    return html;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  DB.ready.then((db) => { if (db) init(); });
})();
