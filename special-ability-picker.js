// special-ability-picker.js — Picker for the Feats & Abilities tab's
// "Special Abilities" list. Today this surfaces skill tricks (Complete
// Scoundrel + a handful from other splats — 42 entries total) since
// they're the highest-leverage "player-selectable thing that isn't a
// feat and isn't tied to a class or race."
//
// Scope was intentionally narrowed to skill tricks per the 2026-05-17
// design conversation. ACFs and substitution levels are class-tied
// and want a class-context picker (likely on the Class Features tab
// or surfaced from class-picker) — deferred until that lands.
// Invocations were moved out to their own Spells sub-tab; the old
// invocation-picker UI no longer lives next to btn-add-special-ability.
//
// UI: picker bar injected next to "+ Add Special Ability" with a
// Category filter (Interaction / Manipulation / Mental / Movement)
// + skill-trick autocomplete + "+ Add to Specials" button.

(function () {
  if (!window.DB) {
    console.warn('[special-ability-picker] DB module not loaded');
    return;
  }

  const trickIndex = new Map();        // lower(name) → row
  let categories = [];                 // sorted distinct categories

  function rebuildIndex() {
    const rows = DB.query(
      "SELECT id AS trick_id, name, source, version, "
      + "json_extract(data, '$.category')      AS category, "
      + "json_extract(data, '$.prerequisites') AS prerequisites, "
      + "json_extract(data, '$.benefit')       AS benefit, "
      + "json_extract(data, '$.description')   AS description "
      + "FROM entry WHERE type = 'skill_trick' "
      + "ORDER BY name COLLATE NOCASE, "
      + "         CASE version WHEN '3.5' THEN 0 ELSE 1 END"
    );
    trickIndex.clear();
    const catSet = new Set();
    for (const r of rows) {
      if (window.BookFilter && !window.BookFilter.allowsEntry({...r, type: 'skill_trick'})) continue;
      const key = (r.name || '').toLowerCase();
      if (trickIndex.has(key)) continue;
      trickIndex.set(key, r);
      if (r.category) catSet.add(r.category);
    }
    categories = [...catSet].sort();
    console.log(`[special-ability-picker] indexed ${trickIndex.size} ` +
      `skill tricks across ${categories.length} categories`);
  }

  function init() {
    rebuildIndex();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectUI);
    } else {
      injectUI();
    }

    document.addEventListener('book-filter-changed', () => {
      rebuildIndex();
      // Repopulate the category dropdown + datalist with the now-
      // narrower set. Re-injecting the whole UI is simpler than
      // surgically updating fields.
      const wrap = document.querySelector('.special-ability-picker');
      if (wrap) {
        wrap.remove();
        injectUI();
      }
    });
  }

  function injectUI() {
    if (document.querySelector('.special-ability-picker')) return;
    const addBtn = document.getElementById('btn-add-special-ability');
    if (!addBtn) {
      console.warn('[special-ability-picker] #btn-add-special-ability not found');
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'special-ability-picker';
    wrap.style.cssText =
      'padding:0.5rem; margin-bottom:0.5rem; ' +
      'background:rgba(255,255,255,0.04); border-left:3px solid #6a8aaa; ' +
      'border-radius:3px;';

    const catOpts = categories
      .map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`)
      .join('');

    wrap.innerHTML = `
      <div style="display:flex;gap:0.4rem;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="flex:1 1 10rem;min-width:9rem">
          <label>Category</label>
          <select id="sap-lookup-category">
            <option value="">Any category</option>
            ${catOpts}
          </select>
        </div>
        <div class="field" style="flex:2 1 14rem;min-width:12rem">
          <label>Skill Trick</label>
          <input type="text" id="sap-lookup" list="sap-trick-options"
                 placeholder="e.g. Acrobatic Backstab" autocomplete="off">
          <datalist id="sap-trick-options"></datalist>
        </div>
        <button type="button" id="sap-lookup-add" class="btn-add"
                style="height:2rem"
                title="Add to Special Abilities list">
          + Add to Specials
        </button>
      </div>
      <div id="sap-info"
           style="display:none;font-size:0.85em;color:#ccc;margin-top:0.4rem">
      </div>
    `;
    addBtn.parentElement.insertBefore(wrap, addBtn);
    wirePicker();
  }

  function wirePicker() {
    const catSel  = document.getElementById('sap-lookup-category');
    const trickIn = document.getElementById('sap-lookup');
    const info    = document.getElementById('sap-info');
    const addBtn  = document.getElementById('sap-lookup-add');
    const datalist = document.getElementById('sap-trick-options');

    function refresh() {
      const c = catSel.value;
      datalist.innerHTML = '';
      let n = 0;
      for (const r of trickIndex.values()) {
        if (c && r.category !== c) continue;
        const opt = document.createElement('option');
        opt.value = r.name;
        // No opt.label — Firefox renders it as visible suggestion text.
        datalist.appendChild(opt);
        n++;
      }
      trickIn.placeholder = c
        ? `${n} ${c} skill trick${n === 1 ? '' : 's'}`
        : 'e.g. Acrobatic Backstab';
    }

    function updateInfo() {
      const r = trickIndex.get(trickIn.value.trim().toLowerCase());
      if (!r) { info.style.display = 'none'; info.innerHTML = ''; return; }
      info.style.display = 'block';
      info.innerHTML = renderInfo(r);
      if (window.ErrataBadge) ErrataBadge.attach(info, r.trick_id);
    }

    function addToSpecials() {
      const r = trickIndex.get(trickIn.value.trim().toLowerCase());
      if (!r) { flash('Pick a skill trick first.', '#a66'); return; }
      const text = formatForSpecials(r);
      // De-dupe by name (case-insensitive) so re-adding is a no-op.
      const existing = Array.from(
        document.querySelectorAll('#special-abilities-container ' +
          '.special-ability-entry')
      ).map(t => (t.value || '').toLowerCase());
      if (existing.some(s => s.startsWith(r.name.toLowerCase()))) {
        flash(`"${r.name}" already in Special Abilities.`, '#aa8');
        return;
      }
      if (typeof Feats !== 'undefined' &&
          typeof Feats.addSpecialAbility === 'function') {
        Feats.addSpecialAbility(text);
        flash(`Added "${r.name}".`, '#7a9');
      } else {
        flash('Feats module unavailable.', '#a66');
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

    catSel .addEventListener('change', refresh);
    trickIn.addEventListener('input',  updateInfo);
    trickIn.addEventListener('change', updateInfo);
    addBtn .addEventListener('click',  addToSpecials);

    refresh();
  }

  function formatForSpecials(r) {
    const head = [
      r.name,
      r.category && `${r.category} skill trick`,
    ].filter(Boolean).join(' · ');
    const body = r.benefit || r.description || '';
    return body ? `${head}\n${body}` : head;
  }

  function renderInfo(r) {
    const bits = [];
    bits.push(`<b>${escapeHtml(r.name)}</b> ` +
      `<span style="opacity:.7">(${escapeHtml(r.source || '?')})</span>`);
    if (r.category)      bits.push(`<b>Category:</b> ${escapeHtml(r.category)}`);
    if (r.prerequisites) bits.push(`<b>Prereq:</b> ${escapeHtml(r.prerequisites)}`);
    let html = bits.join(' &nbsp;·&nbsp; ');
    if (r.benefit) {
      html += `<div class="sap-info-benefit" style="margin-top:0.4rem;` +
              `line-height:1.4"><b>Benefit:</b> ${escapeHtml(r.benefit)}</div>`;
    }
    if (r.description && r.description !== r.benefit) {
      html += `<div class="sap-info-desc" style="margin-top:0.3rem;` +
              `line-height:1.4;opacity:.85">${escapeHtml(r.description)}</div>`;
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
