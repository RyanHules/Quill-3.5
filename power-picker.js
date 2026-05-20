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
      + "json_extract(data, '$.description')        AS description "
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
    observePanels();
    // Per-panel pickers read from byClass at refresh time, so simply
    // rebuilding the index here is enough — next time the user touches
    // a class/level filter the new options will materialize.
    document.addEventListener('book-filter-changed', rebuildIndex);
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
            ${classNames.map(c =>
              `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="field field-sm" style="width:5rem">
          <label>Level</label>
          <input type="number" class="pp-level" min="1" max="9" placeholder="any">
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
    const pwrIn    = picker.querySelector('.pp-power');
    const info     = picker.querySelector('.pp-info');
    const addK     = picker.querySelector('.pp-add-known');
    const datalist = picker.querySelector(`#${dlId}`);

    function currentList() {
      const cls = classSel.value;
      const lvl = parseInt(lvlIn.value, 10);
      const wantLevel = Number.isFinite(lvl) && lvl > 0;
      let items;
      if (cls) {
        items = (byClass.get(cls) || []).slice();
        if (wantLevel) items = items.filter(x => x.level === lvl);
        return items.map(x => ({ rec: x.rec, level: x.level }));
      }
      // No class filter: list all powers; if a level was given, pick
      // the minimum level for each power that matches.
      const out = [];
      for (const rec of powerIndex.values()) {
        const lvls = Object.values(rec.levelMap || {});
        const minLvl = lvls.length ? Math.min(...lvls) : null;
        if (wantLevel) {
          if (lvls.includes(lvl)) out.push({ rec, level: lvl });
        } else {
          out.push({ rec, level: minLvl });
        }
      }
      return out;
    }

    function refresh() {
      const list = currentList();
      datalist.innerHTML = '';
      const seen = new Set();
      for (const { rec, level } of list) {
        const k = rec.name.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        const opt = document.createElement('option');
        opt.value = rec.name;
        // No opt.label — Firefox renders it as visible suggestion text.
        datalist.appendChild(opt);
      }
      pwrIn.placeholder = list.length
        ? `${list.length} power${list.length === 1 ? '' : 's'}`
        : '(no matches)';
    }

    function updateInfo() {
      const rec = powerIndex.get(pwrIn.value.trim().toLowerCase());
      if (!rec) { info.style.display = 'none'; info.innerHTML = ''; return; }
      info.style.display = 'block';
      info.innerHTML = renderInfo(rec);
      if (window.ErrataBadge) ErrataBadge.attach(info, rec.power_id);
    }

    function appendKnown() {
      const rec = powerIndex.get(pwrIn.value.trim().toLowerCase());
      if (!rec) return;
      const cls = classSel.value;
      let lvl;
      if (cls && rec.levelMap[cls] !== undefined) {
        lvl = Number(rec.levelMap[cls]);
      } else {
        const userLvl = parseInt(lvlIn.value, 10);
        const lvls = Object.values(rec.levelMap || {}).map(Number);
        lvl = Number.isFinite(userLvl) && lvls.includes(userLvl)
          ? userLvl
          : (lvls.length ? Math.min(...lvls) : 1);
      }
      if (!Number.isFinite(lvl) || lvl < 1) return;
      // Add new level row if missing (existing add-level button is
      // .psi-add-level — click it until we have enough levels).
      let ta = panel.querySelector(`.psi-power-text[data-lvl="${lvl}"]`);
      let safety = 0;
      while (!ta && safety++ < 10) {
        const addBtn = panel.querySelector('.psi-add-level');
        if (!addBtn) break;
        addBtn.click();
        ta = panel.querySelector(`.psi-power-text[data-lvl="${lvl}"]`);
      }
      if (!ta) return;
      appendLine(ta, rec.name);
    }

    classSel.addEventListener('change', () => { refresh(); updateInfo(); });
    lvlIn.addEventListener('input',    () => { refresh(); updateInfo(); });
    pwrIn.addEventListener('input',    updateInfo);
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
    const head = `<b>${escapeHtml(rec.name)}</b> ` +
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
    if (rec.augment) bits.push(`<b>Augment:</b> ${escapeHtml(rec.augment)}`);
    if (rec.description) {
      const d = rec.description.length > 350
        ? rec.description.slice(0, 350) + '…' : rec.description;
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
