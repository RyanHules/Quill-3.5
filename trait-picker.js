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
  let resultWalls = [];      // [{kind, wall}] — PickerResults chip walls
  const SOFT_LIMIT = 2;
  const TRAIT_PICKER_OPEN_KEY = 'dnd35-trait-picker-open';  // collapse-state persistence

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
    renderBrowse();
  }

  // Repaint the browsing chip walls from the current catalog, narrowed by
  // whatever is typed in the name box. Called on catalog rebuild (book
  // filter change / DB load) and on every keystroke.
  function renderBrowse() {
    if (!resultWalls.length) return;
    const typed = (document.getElementById('trait-flaw-name')?.value || '').trim();
    for (const { kind, wall } of resultWalls) {
      wall.render(catalog.filter(c => c.kind === kind).map(c => c.name),
                  { typedFilter: typed });
    }
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
      '<details class="picker-section" id="trait-picker">'
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
      + '<div id="trait-flaw-browse"></div>'
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
    // Browsing chip walls — the whole in-scope catalog laid out below the
    // search box, the way feat-picker does it. Traits and flaws get
    // separate walls because you budget them separately (2 of each at
    // creation), and several flaws don't carry a "(Flaw)" name suffix to
    // tell them apart in a merged list. 48 entries total, so no cap is hit.
    const browse = document.getElementById('trait-flaw-browse');
    if (browse && typeof PickerResults !== 'undefined') {
      const pick = (name) => {
        // Preview on click, don't auto-add — the user still presses
        // + Add. Mirrors feat-picker's chip behavior, and means a
        // mis-click can't silently blow the 2-per-kind budget.
        input.value = name;
        const c = findCatalog(name);
        if (c) showInfo(c);
        input.focus();
      };
      resultWalls = ['trait', 'flaw'].map(kind => ({
        kind,
        wall: PickerResults.attach(browse, { itemNoun: kind, onPick: pick }),
      }));
    }
    // Re-render the walls as the user types so the chips narrow with the
    // datalist. `change` alone would only fire on blur / autocomplete pick.
    input.addEventListener('input', renderBrowse);
    populateDatalist();
    renderBrowse();

    // Remember the collapse state across page reloads. This section used to
    // force `open` on every load (unlike the other picker-sections, which
    // default folded); now it defaults folded for a first-time user and then
    // persists whatever the user chooses.
    const details = document.getElementById('trait-picker');
    if (details) {
      try { details.open = localStorage.getItem(TRAIT_PICKER_OPEN_KEY) === '1'; } catch (e) {}
      details.addEventListener('toggle', () => {
        try { localStorage.setItem(TRAIT_PICKER_OPEN_KEY, details.open ? '1' : '0'); } catch (e) {}
      });
    }
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
      // Hovering a chip should say what the trait DOES. The chip is the only
      // place an applied trait is visible on the Character tab, and a title
      // of just "trait" told the player nothing they didn't already know.
      txt.title = chipTooltip(a);
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

  // Tooltip for an applied trait/flaw chip: its actual mechanical effect,
  // pulled from the same DB row the info panel uses. UA traits state a
  // benefit AND a drawback (that's the trade), so both are shown; flaws
  // carry only a drawback. Falls back to the bare kind when the DB isn't
  // loaded yet or the entry can't be resolved (homebrew, renamed).
  function chipTooltip(a) {
    const d = resolveData(a);
    if (!d) return a.kind === 'flaw' ? 'Flaw' : 'Trait';
    const parts = [];
    if (d.benefit)  parts.push(`Benefit: ${d.benefit}`);
    if (d.drawback) parts.push(`Drawback: ${d.drawback}`);
    if (d.effect)   parts.push(`Effect: ${d.effect}`);
    if (!parts.length && d.description) parts.push(d.description);
    if (!parts.length) return a.kind === 'flaw' ? 'Flaw' : 'Trait';
    // Native tooltips don't scroll, so cap the length rather than render a
    // wall of text the player can't dismiss.
    const text = parts.join('\n');
    return text.length > 600 ? text.slice(0, 597) + '…' : text;
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
  // `byKind` splits the same numbers into trait- vs flaw-sourced buckets.
  // The merged `direct`/`global` stay authoritative for the skill TOTAL (a
  // trait's +1 and a flaw's -4 do both apply); the split exists so the
  // Skills tab can label them separately. Reporting a +1 trait and a -4
  // flaw as a single "-3 trait" chip is actively wrong about where the
  // number came from — a flaw's penalty is not a trait's doing.
  function getActiveSkillBonuses() {
    const merged = {
      direct: {}, global: 0, situational: [],
      byKind: { trait: { direct: {}, global: 0 },
                flaw:  { direct: {}, global: 0 } },
    };
    if (typeof DND35 === 'undefined' || !DND35.categorizeSkillBonuses) return merged;
    for (const a of applied) {
      const d = resolveData(a);
      if (!d || !Array.isArray(d.bonuses)) continue;
      const cat = DND35.categorizeSkillBonuses(d.bonuses);
      const bucket = merged.byKind[a.kind === 'flaw' ? 'flaw' : 'trait'];
      for (const [k, v] of Object.entries(cat.direct)) {
        merged.direct[k] = (merged.direct[k] || 0) + v;   // untyped → stack
        bucket.direct[k] = (bucket.direct[k] || 0) + v;
      }
      merged.global += cat.global;
      bucket.global += cat.global;
      cat.situational.forEach(s => { s.source = a.name; s.kind = a.kind; });
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

  // Initiative bonuses (typed onion feed, mirrors getActiveSaveBonuses).
  // Replaced the old unconditional scalar 2026-07-05 when the initiative
  // aggregator landed — app.js now stacks the typed list cross-source.
  function getActiveInitiativeBonuses() {
    const merged = { direct: [], situational: [] };
    if (typeof DND35 === 'undefined' || !DND35.categorizeInitiativeBonuses) return merged;
    for (const a of applied) {
      const d = resolveData(a);
      if (!d || !Array.isArray(d.bonuses)) continue;
      const cat = DND35.categorizeInitiativeBonuses(d.bonuses);
      cat.direct.forEach(b => { b.source = a.name; });
      cat.situational.forEach(s => { s.source = a.name; });
      merged.direct.push(...cat.direct);
      merged.situational.push(...cat.situational);
    }
    return merged;
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
    getActiveInitiativeBonuses,
    _rebuildCatalog: buildCatalog,
  };
  window.TraitPicker = api;
  return api;
})();
