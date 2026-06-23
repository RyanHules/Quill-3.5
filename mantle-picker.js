// mantle-picker.js — Autocompletes Complete Psionic mantle names from the DB,
// auto-fills the Granted Ability textarea, and shows the mantle's leveled power
// list (+ the Divine Mind specialized aura + deity access) in an info line.
//
// Mirrors domain-picker.js exactly — a mantle is a domain-analogue for the
// Ardent / Divine Mind (and any psionic character with the Tap Mantle feat).
// The "Mantle Access" UI lives in spells.js inside each Psionics panel: a list
// of `.mantle-entry` divs, each with:
//   input.psi-mantle-name      — typed mantle name
//   textarea.psi-mantle-power  — granted-ability text
// Entries are added dynamically via "+ Add Mantle".
//
// Strategy (same as domain-picker): a shared <datalist> on the body + event
// delegation on `.psi-mantle-name`, so new entries Just Work without per-element
// wiring.

(function () {
  if (!window.DB) {
    console.warn('[mantle-picker] DB module not loaded');
    return;
  }

  // lower-name → { mantle_id, name, source, version, granted_power, powers, aura, deities }
  let mantleIndex = new Map();
  let datalistEl = null;

  function rebuildIndex() {
    const rows = DB.query(
      "SELECT id AS mantle_id, name, source, version, "
      + "json_extract(data, '$.granted_power')    AS granted_power, "
      + "json_extract(data, '$.powers')           AS powers_json, "
      + "json_extract(data, '$.divine_mind_aura') AS aura, "
      + "json_extract(data, '$.deities')          AS deities_json "
      + "FROM entry WHERE type = 'mantle' "
      + "ORDER BY name COLLATE NOCASE, "
      + "CASE version WHEN '3.5' THEN 0 ELSE 1 END"
    );
    mantleIndex = new Map();
    for (const r of rows) {
      if (window.BookFilter && !window.BookFilter.allowsEntry({ ...r, type: 'mantle' })) continue;
      const key = (r.name || '').toLowerCase();
      if (mantleIndex.has(key)) continue;  // source-recency winner is first
      let powers = null, deities = null;
      try { powers = r.powers_json ? JSON.parse(r.powers_json) : null; } catch (e) { /* */ }
      try { deities = r.deities_json ? JSON.parse(r.deities_json) : null; } catch (e) { /* */ }
      mantleIndex.set(key, {
        mantle_id: r.mantle_id,
        name: r.name,
        source: r.source,
        version: r.version,
        granted_power: r.granted_power || '',
        powers: powers,
        aura: r.aura || '',
        deities: deities,
      });
    }
    console.log(`[mantle-picker] indexed ${mantleIndex.size} mantles`);
  }

  function init() {
    rebuildIndex();
    buildDatalist();
    document.addEventListener('input', onMantleEvent);
    document.addEventListener('change', onMantleEvent);
    syncDatalistAttribute();
    observeNewInputs();
    rehydrateExistingInputs();

    document.addEventListener('book-filter-changed', () => {
      rebuildIndex();
      if (datalistEl) {
        datalistEl.innerHTML = '';
        for (const v of mantleIndex.values()) {
          const opt = document.createElement('option');
          opt.value = v.name;
          datalistEl.appendChild(opt);
        }
      }
    });
  }

  function rehydrateExistingInputs() {
    for (const input of document.querySelectorAll('.psi-mantle-name')) {
      const key = String(input.value || '').trim().toLowerCase();
      if (key && mantleIndex.has(key)) fillFromMantle(input, mantleIndex.get(key));
    }
  }

  function buildDatalist() {
    datalistEl = document.getElementById('mantle-picker-options');
    if (datalistEl) return;
    datalistEl = document.createElement('datalist');
    datalistEl.id = 'mantle-picker-options';
    for (const v of mantleIndex.values()) {
      const opt = document.createElement('option');
      opt.value = v.name;  // no opt.label — Firefox renders it as visible text
      datalistEl.appendChild(opt);
    }
    document.body.appendChild(datalistEl);
  }

  function syncDatalistAttribute() {
    for (const input of document.querySelectorAll('.psi-mantle-name')) {
      if (input.getAttribute('list') !== 'mantle-picker-options') {
        input.setAttribute('list', 'mantle-picker-options');
        input.setAttribute('autocomplete', 'off');
      }
    }
  }

  function observeNewInputs() {
    const ob = new MutationObserver((mutations) => {
      let sawNew = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches?.('.mantle-entry') || node.querySelector?.('.psi-mantle-name')) {
            sawNew = true;
          }
        }
      }
      if (sawNew) syncDatalistAttribute();
    });
    ob.observe(document.body, { childList: true, subtree: true });
  }

  function onMantleEvent(ev) {
    const input = ev.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (!input.classList.contains('psi-mantle-name')) return;
    const key = String(input.value || '').trim().toLowerCase();
    if (!mantleIndex.has(key)) return;  // only fire on EXACT match
    fillFromMantle(input, mantleIndex.get(key));
  }

  function fillFromMantle(input, m) {
    const entry = input.closest('.mantle-entry');
    if (!entry) return;
    const power = entry.querySelector('.psi-mantle-power');
    if (power && !power.value.trim() && m.granted_power) {
      power.value = m.granted_power;
      power.dispatchEvent(new Event('input', { bubbles: true }));
    }
    let info = entry.querySelector('.mantle-pick-info');
    if (!info) {
      info = document.createElement('div');
      info.className = 'mantle-pick-info dom-pick-info';  // reuse domain info styling
      info.style.cssText =
        'grid-column: 1 / -1; font-size:0.8em; color:#ccc; ' +
        'padding:0.25rem 0.5rem; margin-top:0.2rem; ' +
        'background:rgba(255,255,255,0.03); border-left:2px solid #8a6aaa;';
      entry.appendChild(info);
    }
    info.innerHTML = renderInfo(m);
    if (window.ErrataBadge) ErrataBadge.attach(info, m.mantle_id);
  }

  function renderInfo(m) {
    const bits = [];
    bits.push(`<b>${escapeHtml(m.name)}</b> ` +
      `<span style="opacity:.7">(${escapeHtml(m.source || 'mantle')})</span>`);
    // powers is a LIST of {level, name} — group by level for display.
    if (Array.isArray(m.powers) && m.powers.length) {
      const byLvl = {};
      for (const p of m.powers) {
        if (!p) continue;
        const l = (p.level != null) ? String(p.level) : '?';
        (byLvl[l] = byLvl[l] || []).push(p.name);
      }
      const lvls = Object.keys(byLvl).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
      const parts = lvls.map(l => `<b>${l}:</b> ${escapeHtml(byLvl[l].join(', '))}`);
      bits.push(`<b>Powers:</b> ${parts.join(' &nbsp;·&nbsp; ')}`);
    }
    if (m.aura) {
      const a = String(m.aura);
      bits.push(`<b>Divine Mind aura:</b> ${escapeHtml(a.slice(0, 160))}${a.length > 160 ? '…' : ''}`);
    }
    if (Array.isArray(m.deities) && m.deities.length) {
      const fmt = m.deities.slice(0, 6).join(', ') +
        (m.deities.length > 6 ? ` +${m.deities.length - 6} more` : '');
      bits.push(`<b>Deities:</b> ${escapeHtml(fmt)}`);
    }
    return bits.join(' &nbsp;|&nbsp; ');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  DB.ready.then((db) => { if (db) init(); });
})();
