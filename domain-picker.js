// domain-picker.js — Autocompletes cleric domain names from the DB and
// auto-fills the matching Granted Power textarea + appends domain spells
// into the per-level prepared/known lists.
//
// The cleric "Domain Access" UI lives in spells.js inside each
// spellcaster panel: a list of `.domain-entry` divs, each with:
//   input.sc-domain-name      — typed domain name
//   textarea.sc-domain-power  — granted-power text
// Entries are added dynamically when the user clicks "+ Add Domain".
//
// Strategy: attach a shared <datalist> to the body. Use event delegation
// on `.sc-domain-name` for `change`/`input` events so new entries Just
// Work without per-element wiring. The picker doesn't need to know when
// entries are added — it reacts to events when they fire.

(function () {
  if (!window.DB) {
    console.warn('[domain-picker] DB module not loaded');
    return;
  }

  // Map: lowercase domain name → { id, name, granted_power, spells, deities, source }
  let domainIndex = new Map();
  let datalistEl = null;

  function rebuildIndex() {
    const rows = DB.query(
      "SELECT id AS domain_id, name, source, version, "
      + "json_extract(data, '$.granted_power') AS granted_power, "
      + "json_extract(data, '$.spells')        AS spells_json, "
      + "json_extract(data, '$.deities')       AS deities_json "
      + "FROM entry WHERE type = 'domain' "
      + "ORDER BY name COLLATE NOCASE, "
      + "CASE version WHEN '3.5' THEN 0 ELSE 1 END"
    );
    domainIndex = new Map();
    // First pass: the source-recency winner becomes the primary entry
    // (carrying name + source + id for the info-panel header).
    //
    // Second pass: backfill missing fields from older printings of the
    // same domain name. PGtF intentionally ships ~22 PHB-standard
    // domains as deity-list-only "redirect" entries — they document
    // which deities grant the domain in Faerûn but rely on the picker
    // to merge in the PHB version's granted_power + spell list. Past
    // implementations took the first hit wholesale, which left
    // Sha'ir / cleric panels showing deities-only with no spell list.
    for (const r of rows) {
      if (window.BookFilter && !window.BookFilter.allowsEntry({...r, type: 'domain'})) continue;
      const key = (r.name || '').toLowerCase();
      let spells = null, deities = null;
      try { spells = r.spells_json ? JSON.parse(r.spells_json) : null; }
      catch (e) { /* ignore */ }
      try { deities = r.deities_json ? JSON.parse(r.deities_json) : null; }
      catch (e) { /* ignore */ }
      if (!domainIndex.has(key)) {
        // First hit — record as the primary.
        domainIndex.set(key, {
          id: r.domain_id,
          name: r.name,
          source: r.source,
          version: r.version,
          granted_power: r.granted_power || '',
          spells: spells,
          deities: deities,
        });
      } else {
        // Backfill any field the primary entry lacks.
        const existing = domainIndex.get(key);
        if (!existing.granted_power && r.granted_power) {
          existing.granted_power = r.granted_power;
        }
        if (!existing.spells && spells) {
          existing.spells = spells;
        }
        if ((!existing.deities || !existing.deities.length) && deities) {
          existing.deities = deities;
        }
      }
    }
    console.log(`[domain-picker] indexed ${domainIndex.size} domains`);
  }

  function init() {
    rebuildIndex();

    buildDatalist();
    wireDelegation();
    // First sweep — apply <list> attr to any domain inputs already in DOM.
    syncDatalistAttribute();
    // Re-sweep when new domain entries get added. spells.js triggers
    // a click on .sc-add-domain that creates new `.domain-entry` rows;
    // we observe the DOM for subtree additions and re-link inputs.
    observeNewDomainInputs();
    // Rehydrate any .sc-domain-name inputs already populated from a
    // saved character. The .dom-pick-info <div> isn't part of the
    // saved HTML — it's recreated on demand by fillFromDomain. If
    // Spells.loadData fired before this init resolved, the change
    // events it dispatched found no handler; sweep the DOM now.
    rehydrateExistingInputs();

    document.addEventListener('book-filter-changed', () => {
      rebuildIndex();
      // Repopulate the global datalist; the <list> attribute on each
      // input already points at it, so we just need fresh options.
      if (datalistEl) {
        datalistEl.innerHTML = '';
        for (const v of domainIndex.values()) {
          const opt = document.createElement('option');
          opt.value = v.name;
          datalistEl.appendChild(opt);
        }
      }
    });
  }

  function rehydrateExistingInputs() {
    for (const input of document.querySelectorAll('.sc-domain-name')) {
      const key = String(input.value || '').trim().toLowerCase();
      if (key && domainIndex.has(key)) {
        fillFromDomain(input, domainIndex.get(key));
      }
    }
  }

  function buildDatalist() {
    datalistEl = document.getElementById('domain-picker-options');
    if (datalistEl) return;
    datalistEl = document.createElement('datalist');
    datalistEl.id = 'domain-picker-options';
    for (const v of domainIndex.values()) {
      const opt = document.createElement('option');
      opt.value = v.name;
      // No opt.label — Firefox renders it as visible suggestion text.
      datalistEl.appendChild(opt);
    }
    document.body.appendChild(datalistEl);
  }

  function syncDatalistAttribute() {
    for (const input of document.querySelectorAll('.sc-domain-name')) {
      if (input.getAttribute('list') !== 'domain-picker-options') {
        input.setAttribute('list', 'domain-picker-options');
        input.setAttribute('autocomplete', 'off');
      }
    }
  }

  function observeNewDomainInputs() {
    const ob = new MutationObserver((mutations) => {
      let sawNew = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches?.('.domain-entry') ||
              node.querySelector?.('.sc-domain-name')) {
            sawNew = true;
          }
        }
      }
      if (sawNew) syncDatalistAttribute();
    });
    ob.observe(document.body, { childList: true, subtree: true });
  }

  // Event delegation for autocomplete-completion.
  // When a .sc-domain-name input fires `change` (or `input` with exact
  // match), look the typed name up and fill in the sibling Granted Power
  // textarea (if empty) and append spell-list to the user-visible info
  // line (and to the per-level prepared/known textareas if a checkbox
  // is opted in, but for MVP just fill granted power).
  function wireDelegation() {
    document.addEventListener('input', onDomainInput);
    document.addEventListener('change', onDomainChange);
  }

  function onDomainInput(ev) {
    const input = ev.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (!input.classList.contains('sc-domain-name')) return;
    // Only fire on EXACT match (case-insensitive); otherwise the user
    // is mid-typing and we shouldn't clobber the textarea.
    const key = String(input.value || '').trim().toLowerCase();
    if (!domainIndex.has(key)) return;
    fillFromDomain(input, domainIndex.get(key));
  }

  function onDomainChange(ev) {
    const input = ev.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (!input.classList.contains('sc-domain-name')) return;
    const key = String(input.value || '').trim().toLowerCase();
    if (!domainIndex.has(key)) return;
    fillFromDomain(input, domainIndex.get(key));
  }

  function fillFromDomain(input, dom) {
    // Find the sibling Granted Power textarea inside the same
    // .domain-entry container.
    const entry = input.closest('.domain-entry');
    if (!entry) return;
    const power = entry.querySelector('.sc-domain-power');
    if (power && !power.value.trim() && dom.granted_power) {
      power.value = dom.granted_power;
      power.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // Annotate the entry with a small spell-list line that the user can
    // copy from. Inserted once, replaced on each fill.
    let info = entry.querySelector('.dom-pick-info');
    if (!info) {
      info = document.createElement('div');
      info.className = 'dom-pick-info';
      info.style.cssText =
        'grid-column: 1 / -1; font-size:0.8em; color:#ccc; ' +
        'padding:0.25rem 0.5rem; margin-top:0.2rem; ' +
        'background:rgba(255,255,255,0.03); border-left:2px solid #6a8aaa;';
      entry.appendChild(info);
    }
    info.innerHTML = renderInfo(dom);
    // The index record stores the entry id as `id` (not domain_id), so the
    // badge never attached when this read dom.domain_id (undefined).
    if (window.ErrataBadge) ErrataBadge.attach(info, dom.id);
  }

  function renderInfo(dom) {
    const bits = [];
    if (dom.source) {
      bits.push(`<b>${escapeHtml(dom.name)}</b> ` +
        `<span style="opacity:.7">(${escapeHtml(dom.source)})</span>`);
    }
    if (dom.spells && typeof dom.spells === 'object') {
      const lvls = Object.keys(dom.spells)
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
      const parts = lvls.map(l => {
        const s = dom.spells[l];
        return `<b>${l}:</b> ${escapeHtml(String(s || ''))}`;
      });
      bits.push(`<b>Spells:</b> ${parts.join(' &nbsp;·&nbsp; ')}`);
    }
    if (Array.isArray(dom.deities) && dom.deities.length) {
      const fmt = dom.deities.slice(0, 6).join(', ') +
        (dom.deities.length > 6 ? ` +${dom.deities.length - 6} more` : '');
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
