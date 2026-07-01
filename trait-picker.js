// D&D 3.5 Character Sheet — UA Traits & Flaws picker
// ============================================================
// A Character-tab chip picker (mirrors template-picker) for the UA
// character TRAITS (benefit + drawback) and FLAWS (an `effect` penalty
// taken for a bonus feat). Catalog = entry WHERE type IN ('trait','flaw'),
// gated by BookFilter/HomebrewFilter. Each applied trait/flaw's
// hand-verified structured `bonuses` (DB, 2026-07-01) feeds the effects
// aggregator via getActive{Skill,Save,AC,Init}Bonuses — the SAME generic
// categorizers (DND35.categorize*Bonuses) that race/template/feat use — so
// the skill/save/AC/initiative part auto-applies; the rest (speed, hp/level,
// attack, caster level, choices) is surfaced as benefit/drawback prose.
//
// Soft creation limit (Ryan, 2026-07-01): warn past 2 traits / 2 flaws but
// don't block (house rules / retraining). Persistence: monkey-patches
// Character.collectData/loadData, adding `_traits`/`_flaws: [{name, source}]`.
// Resolves entries by name+source (never brittle DB id — save-stability #7).
const TraitPicker = (function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  // applied = [{ name, source, kind }]  (kind: 'trait' | 'flaw')
  let applied = [];
  let catalog = [];          // [{name, source, kind}] in scope
  const SOFT_LIMIT = 2;

  // ---- catalog -------------------------------------------------------
  function inScope(row) {
    if (typeof BookFilter !== 'undefined' && BookFilter.allowsEntry
        && !BookFilter.allowsEntry({ source: row.source, version: row.version,
                                     name: row.name, type: row.type })) {
      return false;
    }
    return true;
  }

  function buildCatalog() {
    catalog = [];
    if (typeof DB === 'undefined' || !DB.isLoaded || !DB.isLoaded()) return;
    const rows = DB.query(
      "SELECT name, source, version, type FROM entry WHERE type IN ('trait','flaw') "
      + "ORDER BY name") || [];
    const seen = new Set();
    for (const r of rows) {
      if (!inScope(r)) continue;
      const key = r.type + '|' + (r.name || '').toLowerCase();
      if (seen.has(key)) continue;         // name-dedupe across printings
      seen.add(key);
      catalog.push({ name: r.name, source: r.source, kind: r.type });
    }
    populateDatalist();
  }

  function populateDatalist() {
    const dl = document.getElementById('trait-flaw-options');
    if (!dl) return;
    dl.innerHTML = '';
    for (const c of catalog) {
      const o = document.createElement('option');
      o.value = c.name;            // NO label attr (Firefox datalist bug)
      dl.appendChild(o);
    }
  }

  function findCatalog(name) {
    const nl = (name || '').trim().toLowerCase();
    return catalog.find(c => c.name.toLowerCase() === nl) || null;
  }

  // ---- entry resolution (by name+source, type-scoped) ----------------
  function resolveData(t) {
    if (typeof DB === 'undefined' || !DB.isLoaded || !DB.isLoaded()) return null;
    let row = null;
    if (t.source) {
      row = DB.queryOne(
        "SELECT data FROM entry WHERE type=? AND name=? AND source=? LIMIT 1",
        [t.kind, t.name, t.source]);
    }
    if (!row) {
      row = DB.queryOne(
        "SELECT data FROM entry WHERE type=? AND name=? "
        + "ORDER BY CASE version WHEN '3.5' THEN 0 ELSE 1 END LIMIT 1",
        [t.kind, t.name]);
    }
    if (!row) return null;
    try { return JSON.parse(row.data || '{}'); } catch (e) { return null; }
  }

  // ---- apply / remove ------------------------------------------------
  function addByName(name) {
    const c = findCatalog(name);
    const info = document.getElementById('trait-flaw-info');
    if (!c) {
      if (name) flash(info, `No trait or flaw named "${name}" in scope.`, '#c88');
      return false;
    }
    if (applied.some(a => a.name.toLowerCase() === c.name.toLowerCase()
                          && a.kind === c.kind)) {
      flash(info, `${c.name} already added.`, '#c88');
      return false;
    }
    applied.push({ name: c.name, source: c.source, kind: c.kind });
    renderApplied();
    showInfo(c);   // sets panel.innerHTML — must run BEFORE flash (which appends)
    const count = applied.filter(a => a.kind === c.kind).length;
    if (count > SOFT_LIMIT) {
      flash(info, `Note: ${count} ${c.kind}s applied — UA allows ${SOFT_LIMIT} `
        + `${c.kind}${SOFT_LIMIT === 1 ? '' : 's'} at creation. Kept anyway.`, '#e0b050');
    }
    recalc();
    return true;
  }

  function remove(name, kind) {
    const before = applied.length;
    applied = applied.filter(a => !(a.name === name && a.kind === kind));
    if (applied.length !== before) { renderApplied(); recalc(); }
  }

  function recalc() {
    if (typeof window.recalcAll === 'function') window.recalcAll();
  }

  // ---- UI -------------------------------------------------------------
  function ensureUI() {
    const host = document.getElementById('trait-picker-host');
    if (!host || host.dataset.built === '1') return;
    host.dataset.built = '1';
    host.innerHTML =
      '<details class="picker-section" id="trait-picker" open>'
      + '<summary style="cursor:pointer;font-weight:600">Traits &amp; Flaws '
      + '<span style="font-weight:400;opacity:0.6;font-size:0.85em">(UA — 2 each at creation)</span></summary>'
      + '<div style="display:flex;gap:0.4rem;margin:0.4rem 0;flex-wrap:wrap">'
      + '<input type="text" id="trait-flaw-name" list="trait-flaw-options" '
      + 'placeholder="Trait or flaw name…" style="flex:1;min-width:140px">'
      + '<datalist id="trait-flaw-options"></datalist>'
      + '<button type="button" id="trait-flaw-add" class="btn-add">+ Add</button>'
      + '</div>'
      + '<div id="trait-flaw-applied-list" style="display:flex;gap:0.35rem;'
      + 'flex-wrap:wrap;align-items:center;margin-bottom:0.3rem"></div>'
      + '<div id="trait-flaw-info" class="picker-info" style="display:none"></div>'
      + '</details>';

    const input = document.getElementById('trait-flaw-name');
    const addBtn = document.getElementById('trait-flaw-add');
    addBtn.addEventListener('click', () => {
      if (addByName(input.value)) input.value = '';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); }
    });
    input.addEventListener('change', () => {
      // exact match → show info preview (don't auto-add)
      const c = findCatalog(input.value);
      if (c) showInfo(c);
    });
    populateDatalist();
  }

  function renderApplied() {
    const list = document.getElementById('trait-flaw-applied-list');
    if (!list) return;
    list.innerHTML = '';
    if (!applied.length) return;
    for (const a of applied) {
      const chip = document.createElement('span');
      chip.className = 'template-chip';
      chip.dataset.trait = a.name;
      const isFlaw = a.kind === 'flaw';
      chip.style.cssText =
        `background:rgba(${isFlaw ? '150,90,120' : '106,150,106'},0.22);`
        + 'padding:0.15rem 0.5rem;border-radius:3px;font-size:0.85em;'
        + 'display:inline-flex;gap:0.35rem;align-items:center;';
      const txt = document.createElement('span');
      txt.textContent = a.name.replace(/\s*\((Trait|Flaw)\)\s*$/i, '')
        + (isFlaw ? ' ⚑' : '');
      txt.title = a.kind;
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.title = `Remove ${a.name}`;
      x.style.cssText = 'background:transparent;border:0;color:#c88;'
        + 'cursor:pointer;font-size:1.1em;padding:0;line-height:1;';
      x.addEventListener('click', () => remove(a.name, a.kind));
      chip.appendChild(txt);
      chip.appendChild(x);
      list.appendChild(chip);
    }
  }

  function showInfo(c) {
    const panel = document.getElementById('trait-flaw-info');
    if (!panel) return;
    const d = resolveData(c);
    if (!d) { panel.style.display = 'none'; return; }
    const parts = [];
    parts.push(`<b>${escapeHtml(c.name)}</b>`);
    if (d.benefit) parts.push(`<b>Benefit:</b> ${escapeHtml(d.benefit)}`);
    if (d.drawback) parts.push(`<b>Drawback:</b> ${escapeHtml(d.drawback)}`);
    if (d.effect) parts.push(`<b>Effect:</b> ${escapeHtml(d.effect)}`);
    if (d.description) parts.push(`<span style="opacity:0.8">${escapeHtml(d.description)}</span>`);
    panel.innerHTML = parts.join('<br>');
    panel.style.display = 'block';
    // Edition + errata badges (best-effort; mirror other pickers)
    if (typeof VersionBadge !== 'undefined' && VersionBadge.attach) {
      VersionBadge.attach(panel, d.version);
    }
  }

  function flash(panel, msg, color) {
    if (!panel) return;
    const note = document.createElement('div');
    note.style.cssText = `margin-top:0.3rem;color:${color};font-style:italic`;
    note.textContent = msg;
    panel.appendChild(note);
    panel.style.display = 'block';
    setTimeout(() => note.remove(), 4500);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---- aggregator feeds (mirror template-picker) ---------------------
  function getActiveSkillBonuses() {
    const merged = { direct: {}, global: 0, situational: [] };
    if (typeof DND35 === 'undefined' || !DND35.categorizeSkillBonuses) return merged;
    for (const a of applied) {
      const d = resolveData(a);
      if (!d || !Array.isArray(d.bonuses)) continue;
      const cat = DND35.categorizeSkillBonuses(d.bonuses);
      for (const [k, v] of Object.entries(cat.direct)) {
        merged.direct[k] = (merged.direct[k] || 0) + v;   // untyped → stack
      }
      merged.global += cat.global;
      cat.situational.forEach(s => { s.source = a.name; });
      merged.situational.push(...cat.situational);
    }
    return merged;
  }

  function getActiveSaveBonuses() {
    const merged = { direct: { fort: [], ref: [], will: [] }, situational: [] };
    if (typeof DND35 === 'undefined' || !DND35.categorizeSaveBonuses) return merged;
    for (const a of applied) {
      const d = resolveData(a);
      if (!d || !Array.isArray(d.bonuses)) continue;
      const cat = DND35.categorizeSaveBonuses(d.bonuses);
      for (const k of ['fort', 'ref', 'will']) merged.direct[k].push(...cat.direct[k]);
      cat.situational.forEach(s => { s.source = a.name; });
      merged.situational.push(...cat.situational);
    }
    return merged;
  }

  function getActiveACBonuses() {
    const merged = { items: [], situational: [] };
    if (typeof DND35 === 'undefined' || !DND35.categorizeACBonuses) return merged;
    for (const a of applied) {
      const d = resolveData(a);
      if (!d || !Array.isArray(d.bonuses)) continue;
      const cat = DND35.categorizeACBonuses(d.bonuses);
      cat.items.forEach(i => { i.source = a.name; });
      cat.situational.forEach(s => { s.source = a.name; });
      merged.items.push(...cat.items);
      merged.situational.push(...cat.situational);
    }
    return merged;
  }

  // Initiative bonus (untyped, stacks) — summed. The aggregator has no
  // initiative onion yet, so character.js consumes this scalar directly.
  function getActiveInitBonus() {
    let total = 0;
    for (const a of applied) {
      const d = resolveData(a);
      if (!d || !Array.isArray(d.bonuses)) continue;
      for (const b of d.bonuses) {
        if (b && b.bonus_type === 'initiative' && !b.condition) {
          const amt = (typeof b.amount === 'number') ? b.amount : parseInt(b.amount, 10);
          if (amt && !isNaN(amt)) total += amt;
        }
      }
    }
    return total;
  }

  // ---- persistence (monkey-patch Character) --------------------------
  function installPersistenceHooks() {
    if (typeof Character === 'undefined' || Character._traitHooked) return;
    const origCollect = Character.collectData;
    const origLoad = Character.loadData;
    Character.collectData = function () {
      const out = origCollect.apply(this, arguments) || {};
      const traits = applied.filter(a => a.kind === 'trait')
        .map(a => ({ name: a.name, source: a.source }));
      const flaws = applied.filter(a => a.kind === 'flaw')
        .map(a => ({ name: a.name, source: a.source }));
      if (traits.length) out._traits = traits;
      if (flaws.length) out._flaws = flaws;
      return out;
    };
    Character.loadData = function (data) {
      const r = origLoad.apply(this, arguments);
      applied = [];
      if (data && Array.isArray(data._traits)) {
        for (const t of data._traits) applied.push({ name: t.name, source: t.source, kind: 'trait' });
      }
      if (data && Array.isArray(data._flaws)) {
        for (const f of data._flaws) applied.push({ name: f.name, source: f.source, kind: 'flaw' });
      }
      renderApplied();
      return r;
    };
    Character._traitHooked = true;
  }

  // ---- init ----------------------------------------------------------
  function init() {
    ensureUI();
    installPersistenceHooks();
    if (typeof DB !== 'undefined' && DB.ready) {
      DB.ready.then(() => { buildCatalog(); renderApplied(); });
    }
    document.addEventListener('book-filter-changed', buildCatalog);
    document.addEventListener('homebrew-filter-changed', buildCatalog);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // NB: this IIFE is assigned to `const TraitPicker`, so it MUST return the
  // API — the consumers (skills.js/app.js/character.js) reference the lexical
  // `TraitPicker`, which resolves to this const (and shadows window). Also
  // mirror it onto window for parity with the other pickers.
  const api = {
    getApplied: () => applied.slice(),
    add: addByName,
    remove,
    getActiveSkillBonuses,
    getActiveSaveBonuses,
    getActiveACBonuses,
    getActiveInitBonus,
    _rebuildCatalog: buildCatalog,
  };
  window.TraitPicker = api;
  return api;
})();
