// lookup.js — Universal search/lookup modal over every entry in
// `dnd35.db`. Acts as a Spotlight-style reference layer on top of
// the existing 13 per-tab pickers.
//
// Activation:
//   - Ctrl/Cmd+K from anywhere on the page
//   - The "?" button injected into the header next to the title
//
// Behavior:
//   - Modal overlay; click backdrop or press Esc to close
//   - Search box auto-focused
//   - Filter chips for the most common entry types
//   - ↑/↓ to navigate result list; Enter to expand selected row;
//     Esc to close the modal
//
// Phase 1 (this file): modal shell + hotkey + button + keyboard
// nav. Search and result rendering are stubbed out — the index
// build and ranked filter happen in Phase 2; rich result rows +
// inline expand in Phase 3; errata badges in Phase 4; empty-state
// in Phase 5.

(function () {
  if (!window.DB) {
    console.warn('[lookup] DB module not loaded');
    return;
  }

  // ---- DOM construction ---------------------------------------------------

  let modalEl = null;       // the overlay root
  let inputEl = null;       // the search input
  let resultsEl = null;     // the results list container
  let footerEl = null;      // status / hint text at the bottom
  let chipsEl = null;       // the type-filter chip strip
  let selectedIdx = 0;      // index of the highlighted row (for ↑↓ nav)
  let lastResults = [];     // last rendered result list (cached for Enter)

  // Cross-type search index built at DB.ready. Each entry:
  //   { id, name, type, source, tags: Set<string>, nameKey, searchKey }
  // `nameKey` is lowercased+squashed for prefix/contains matching;
  // `searchKey` includes name + type + source + tags for fuzzy fallback.
  let entries = [];
  // Type → count, for the chip strip.
  const typeCounts = new Map();
  // Set of active type filters (empty = no filter).
  const activeTypes = new Set();
  // Lowercase book abbreviation → lowercase full book name. Used by the
  // @source:DMG / source:DMG filter to match against entries that carry
  // the full source string ("Dungeon Master's Guide"). Without this,
  // typing the abbreviation never matches; populated in buildIndex.
  let bookAbbrevMap = new Map();

  // The 8 chips shown by default; everything else is grouped under
  // a "More…" expander. Order is tuned for player-facing utility.
  const PRIMARY_TYPES = [
    'spell', 'feat', 'item', 'creature', 'rule',
    'class', 'prc', 'race',
  ];
  // Display-friendly labels.
  const TYPE_LABELS = {
    spell: 'Spell', feat: 'Feat', item: 'Item', weapon: 'Weapon',
    armor: 'Armor', gear: 'Gear', creature: 'Creature', rule: 'Rule',
    class: 'Class', prc: 'PrC', race: 'Race', template: 'Template',
    domain: 'Domain', deity: 'Deity', region: 'Region', plane: 'Plane',
    maneuver: 'Maneuver', power: 'Power', mystery: 'Mystery',
    vestige: 'Vestige', utterance: 'Utterance', invocation: 'Invocation',
    soulmeld: 'Soulmeld', acf: 'ACF', subst_level: 'Subst. level',
    organization: 'Organization', poison: 'Poison', disease: 'Disease',
    ravage_affliction: 'Ravage/Affliction', skill: 'Skill',
    skill_use: 'Skill use', skill_trick: 'Skill trick',
    condition: 'Condition',
  };

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.id = 'lookup-modal';
    modalEl.className = 'lookup-modal';
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');
    modalEl.setAttribute('aria-label', 'Universal lookup');
    modalEl.style.display = 'none';
    modalEl.innerHTML = `
      <div class="lookup-backdrop" data-close="1"></div>
      <div class="lookup-card">
        <div class="lookup-search-row">
          <input id="lookup-input" type="text" autocomplete="off"
                 spellcheck="false"
                 placeholder="Search anything — feat, spell, rule, item, tag:metamagic, @source:DMG …">
          <button type="button" class="lookup-close" data-close="1"
                  aria-label="Close (Esc)">×</button>
        </div>
        <div class="lookup-chips" id="lookup-chips">
          <!-- Phase 2 will populate type-filter chips here -->
        </div>
        <div class="lookup-results" id="lookup-results" role="listbox">
          <!-- Phase 2/3 will render results here -->
        </div>
        <div class="lookup-footer" id="lookup-footer">
          <span class="lookup-hint">
            <kbd>↑</kbd><kbd>↓</kbd> navigate &nbsp;
            <kbd>Enter</kbd> expand &nbsp;
            <kbd>Esc</kbd> close
          </span>
          <span class="lookup-count" id="lookup-count"></span>
        </div>
      </div>
    `;
    document.body.appendChild(modalEl);

    inputEl   = modalEl.querySelector('#lookup-input');
    resultsEl = modalEl.querySelector('#lookup-results');
    footerEl  = modalEl.querySelector('#lookup-footer');
    chipsEl   = modalEl.querySelector('#lookup-chips');
    // Phase 5: wire click delegation for the empty-state widgets.
    wireEmptyStateClicks();

    // Close on backdrop / × click.
    modalEl.addEventListener('click', (ev) => {
      if (ev.target instanceof Element && ev.target.dataset.close === '1') {
        close();
      }
    });

    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('keydown', onInputKey);
    return modalEl;
  }

  function ensureTriggerButton() {
    // Inject a "?" button into the header. Find the header — falls
    // back to body if the header structure changes.
    if (document.getElementById('lookup-trigger-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'lookup-trigger-btn';
    btn.type = 'button';
    btn.className = 'lookup-trigger';
    btn.title = 'Lookup anything (Ctrl+K)';
    btn.setAttribute('aria-label', 'Open universal lookup');
    btn.innerHTML = '🔍';
    btn.addEventListener('click', open);
    // Try to attach to the header; fall back to a corner-fixed
    // floating button so the user always has the affordance.
    const header = document.querySelector('header');
    if (header) {
      header.appendChild(btn);
    } else {
      btn.classList.add('lookup-trigger-floating');
      document.body.appendChild(btn);
    }
  }

  // ---- Open / close -------------------------------------------------------

  function open() {
    ensureModal();
    modalEl.style.display = '';
    // Defer focus until the browser has painted so the input is
    // actually focusable (Firefox quirk with display toggling).
    requestAnimationFrame(() => inputEl.focus());
    // Re-render in case the DB just loaded or the query persisted.
    render(inputEl.value.trim());
  }

  function close() {
    if (!modalEl) return;
    modalEl.style.display = 'none';
    // Return focus to whatever opened the modal — best-effort by
    // re-clicking the originating element isn't possible, so we just
    // blur our own input.
    inputEl?.blur();
  }

  function toggle() {
    if (!modalEl || modalEl.style.display === 'none') open();
    else close();
  }

  // ---- Keyboard handling --------------------------------------------------

  function onInput() {
    selectedIdx = 0;
    render(inputEl.value.trim());
  }

  function onInputKey(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
      return;
    }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      moveSelection(1);
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      moveSelection(-1);
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      expandSelected();
      return;
    }
  }

  function moveSelection(delta) {
    if (!lastResults.length) return;
    selectedIdx = (selectedIdx + delta + lastResults.length) % lastResults.length;
    paintSelection();
    scrollSelectedIntoView();
  }

  function paintSelection() {
    const rows = resultsEl.querySelectorAll('.lookup-row');
    rows.forEach((r, i) => {
      r.classList.toggle('selected', i === selectedIdx);
      r.setAttribute('aria-selected', i === selectedIdx ? 'true' : 'false');
    });
  }

  function scrollSelectedIntoView() {
    const row = resultsEl.querySelectorAll('.lookup-row')[selectedIdx];
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
  }

  function expandSelected() {
    const row = resultsEl.querySelectorAll('.lookup-row')[selectedIdx];
    if (!row) return;
    if (row.classList.contains('expanded')) {
      row.classList.remove('expanded');
      row.querySelector('.lookup-row-detail')?.remove();
      return;
    }
    // Record the query that produced this result. Saving here (instead
    // of on every input change) keeps the recent list signal-rich:
    // it captures queries the user actually found something useful in.
    if (inputEl) recordRecent(inputEl.value);
    // Collapse any other expanded row (single-expansion mode keeps
    // the list scannable).
    resultsEl.querySelectorAll('.lookup-row.expanded').forEach(r => {
      r.classList.remove('expanded');
      r.querySelector('.lookup-row-detail')?.remove();
    });
    // Render the detail panel inline.
    const entryId = parseInt(row.dataset.entryId, 10);
    const entryType = row.dataset.entryType;
    const detail = renderDetail(entryId, entryType);
    if (detail) {
      row.appendChild(detail);
      row.classList.add('expanded');
    }
  }

  // ---- Detail rendering ---------------------------------------------------

  // Cache fetched detail JSON by entry id; opening the same row twice
  // is cheap.
  const detailCache = new Map();

  function fetchDetail(entryId) {
    if (detailCache.has(entryId)) return detailCache.get(entryId);
    const row = DB.queryOne(
      "SELECT id, type, name, source, version, school, subschool, "
      + "descriptor, types_csv, item_type, body_slot, aura, "
      + "caster_level, price, weight, creature_size, creature_type, "
      + "cr, alignment, discipline, data "
      + "FROM entry WHERE id = ?", [entryId]
    );
    if (!row) { detailCache.set(entryId, null); return null; }
    let parsed = {};
    try { parsed = JSON.parse(row.data || '{}'); }
    catch (e) { /* leave parsed empty */ }
    const combined = Object.assign({}, parsed, row);
    delete combined.data;
    detailCache.set(entryId, combined);
    return combined;
  }

  function renderDetail(entryId, entryType) {
    const data = fetchDetail(entryId);
    if (!data) return null;
    const wrap = document.createElement('div');
    wrap.className = 'lookup-row-detail';
    wrap.innerHTML = renderDetailHtml(data, entryType);
    // Stop click bubbling so clicking inside the detail (e.g. on a
    // link) doesn't collapse the row.
    //
    // EXCEPTION: see_also cross-link clicks (rule entries) need to be
    // handled here, because stopPropagation prevents the document-
    // level [data-lookup-search] handler from firing. Intercept the
    // click, run search(), then stopPropagation so the row stays put
    // — search() will re-render the results list anyway, so the
    // currently expanded row is about to be replaced regardless.
    wrap.addEventListener('click', (ev) => {
      const tgt = ev.target instanceof Element ? ev.target : null;
      // See-also pill → toggle inline-expanded nested view of the
      // linked entry. Multiple can be open at once; clicking an
      // already-open pill closes it.
      const seeAlsoPill = tgt?.closest('[data-see-also-name]');
      if (seeAlsoPill) {
        ev.preventDefault();
        ev.stopPropagation();
        const name = seeAlsoPill.getAttribute('data-see-also-name');
        const container = seeAlsoPill
          .closest('.lookup-rule-see-also')
          ?.querySelector('.lookup-see-also-expansions');
        if (!container) return;
        const existing = container.querySelector(
          `[data-nested-name="${cssAttrEscape(name)}"]`
        );
        if (existing) {
          existing.remove();
          seeAlsoPill.setAttribute('aria-expanded', 'false');
          const caret = seeAlsoPill.querySelector('.lookup-see-also-caret');
          if (caret) caret.textContent = '▸';
        } else {
          container.insertAdjacentHTML(
            'beforeend', renderNestedExpansion(name)
          );
          seeAlsoPill.setAttribute('aria-expanded', 'true');
          const caret = seeAlsoPill.querySelector('.lookup-see-also-caret');
          if (caret) caret.textContent = '▾';
        }
        return;
      }
      // Legacy data-lookup-search → switch the modal's search query.
      // Still wired for any non-see_also caller that uses it; the
      // see-also flow no longer touches this code path.
      const link = tgt?.closest('[data-lookup-search]');
      if (link) {
        ev.preventDefault();
        ev.stopPropagation();
        search(link.getAttribute('data-lookup-search'));
        return;
      }
      // Show more / less toggle for collapsed rule descriptions.
      const toggle = tgt?.closest('[data-action="toggle-desc"]');
      if (toggle) {
        ev.preventDefault();
        ev.stopPropagation();
        const container = toggle.closest('.lookup-detail-desc');
        if (!container) return;
        const collapsed = container.dataset.collapsed === '1';
        const rest = container.querySelector('.lookup-desc-rest');
        if (rest) {
          if (collapsed) {
            rest.hidden = false;
            container.dataset.collapsed = '0';
            toggle.textContent = 'Show less ▴';
          } else {
            rest.hidden = true;
            container.dataset.collapsed = '1';
            toggle.textContent = 'Show full prose ▾';
          }
        }
        return;
      }
      ev.stopPropagation();
    });
    // If this entry has errata of any kind (applied or advisory),
    // append a clickable ✦ errata button to the header that opens a
    // popover listing each record. Anchored to the header so it sits
    // next to the type label.
    if (window.ErrataBadge) {
      // Show even advisory-only records here — the user has opted in
      // by expanding the row.
      const btn = ErrataBadge.badge(entryId, { applied: false });
      if (btn) {
        const head = wrap.querySelector('.lookup-detail-head');
        if (head) head.appendChild(btn);
      }
    }
    return wrap;
  }

  function renderDetailHtml(d, type) {
    const bits = [];
    bits.push(renderHeader(d, type));
    bits.push(renderMeta(d, type));
    if (d.description) {
      bits.push(renderDescription(d, type));
    }
    bits.push(renderTypeSpecific(d, type));
    // Structured data tables for every non-rule type (rules render
    // theirs inside renderRuleExtra, ordered before See-also).
    if (type !== 'rule') bits.push(renderEntryTables(d));
    bits.push(renderTags(d));
    return bits.filter(Boolean).join('');
  }

  // Collapse rule descriptions when structured tables/mechanics make
  // most of the prose redundant. Many Core rule entries now have BOTH
  // a thorough prose description AND a table that lists the same
  // data — when both are present, the table wins and the prose drops
  // to its first paragraph (or `summary` field if available) behind a
  // "Show more" toggle. For entries without tables/mechanics (the
  // vast majority of legacy rules), description stays fully expanded
  // as before.
  function renderDescription(d, type) {
    const desc = String(d.description || '');
    const hasStructured = type === 'rule' && (
      (Array.isArray(d.tables) && d.tables.length) ||
      (d.mechanics && typeof d.mechanics === 'object'
        && Object.keys(d.mechanics).length)
    );
    // Threshold: only collapse when there's meaningfully more prose
    // than the lead paragraph. Below ~350 chars the toggle adds more
    // friction than it saves.
    if (!hasStructured || desc.length < 350) {
      return `<div class="lookup-detail-desc">${escapeHtml(desc)}</div>`;
    }
    const lead = firstParagraph(desc, d.summary);
    // If the lead is the entire description (no second paragraph to
    // hide), no toggle needed.
    if (lead.length >= desc.length - 10) {
      return `<div class="lookup-detail-desc">${escapeHtml(desc)}</div>`;
    }
    return (
      `<div class="lookup-detail-desc lookup-desc-collapsed" data-collapsed="1">` +
      `<div class="lookup-desc-lead">${escapeHtml(lead)}</div>` +
      `<div class="lookup-desc-rest" hidden>${escapeHtml(desc.slice(lead.length).trim())}</div>` +
      `<button type="button" class="lookup-desc-toggle" ` +
      `data-action="toggle-desc">Show full prose ▾</button>` +
      `</div>`
    );
  }

  // Pick the shortest sensible lead: prefer `summary` if it exists
  // AND is a real prefix of (or close enough to) the description's
  // first paragraph; otherwise use the first paragraph break.
  function firstParagraph(desc, summary) {
    if (summary && desc.startsWith(summary)) {
      return summary;
    }
    const breakIdx = desc.indexOf('\n\n');
    if (breakIdx > 0) return desc.slice(0, breakIdx);
    // No paragraph break. Try first sentence.
    const sentMatch = desc.match(/^[^.!?]*[.!?](?:\s|$)/);
    if (sentMatch && sentMatch[0].length > 40
        && sentMatch[0].length < desc.length - 50) {
      return sentMatch[0].trim();
    }
    return summary || desc;
  }

  function renderHeader(d, type) {
    const pieces = [];
    if (d.source) pieces.push(escapeHtml(d.source));
    // Visible "3.0" pill via VersionBadge so the edition is impossible
    // to miss. The header used to inline the version as plain "·
    // 3.0" text, which blended in too easily — the Dimensional Lock
    // confusion (2026-05-19) made that clear.
    const verBadge = (window.VersionBadge ? VersionBadge.html(d.version) : '');
    return `<div class="lookup-detail-head">` +
      `<span class="lookup-detail-type">${escapeHtml(TYPE_LABELS[type] || type)}</span>` +
      (pieces.length ? `<span class="lookup-detail-source">${pieces.join(' · ')}</span>` : '') +
      verBadge +
      `</div>`;
  }

  // Top-of-detail "meta strip" with the most common at-a-glance
  // fields per entry type. School/components for spells, prereq for
  // feats, body slot/price for items, etc.
  function renderMeta(d, type) {
    const fields = META_FIELDS_BY_TYPE[type] || META_FIELDS_BY_TYPE._default;
    const items = [];
    for (const [label, key] of fields) {
      // Spells: collapse School / Subschool / Descriptor into the
      // canonical book-print form "School (Subschool) [Descriptor]"
      // under a single "School:" label, and skip the bare Subschool
      // / Descriptor rows that would otherwise duplicate the info.
      if (type === 'spell' && label === 'School') {
        if (!d.school) continue;
        let v = String(d.school);
        if (d.subschool)  v += ` (${d.subschool})`;
        if (d.descriptor) v += ` [${d.descriptor}]`;
        items.push(`<span class="lookup-meta-item">` +
          `<b>School:</b> ${escapeHtml(v)}</span>`);
        continue;
      }
      if (type === 'spell' && (label === 'Subschool' || label === 'Descriptor')) {
        continue; // folded into the School line above
      }
      const v = pickField(d, key);
      if (v == null || v === '' || v === '—') continue;
      items.push(
        `<span class="lookup-meta-item">` +
        `<b>${escapeHtml(label)}:</b> ${escapeHtml(formatValue(v))}` +
        `</span>`
      );
    }
    if (!items.length) return '';
    return `<div class="lookup-detail-meta">${items.join('')}</div>`;
  }

  // First non-null field from a list. Handles dotted paths into the
  // parsed `data` blob.
  function pickField(d, keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      const v = d[k];
      if (v != null && v !== '') return v;
    }
    return null;
  }

  function formatValue(v) {
    if (v == null) return '';
    if (Array.isArray(v)) return v.join(', ');
    if (typeof v === 'object') {
      // dicts like spell.level → "Sor/Wiz 3, Fire 3"
      return Object.entries(v).map(([k, vv]) => `${k} ${vv}`).join(', ');
    }
    return String(v);
  }

  // Per-type meta fields, in display order. The first key in each
  // tuple is the label; the second is the key (or list of keys) on
  // the entry/data dict.
  const META_FIELDS_BY_TYPE = {
    spell: [
      ['School',     ['school']],
      ['Subschool',  ['subschool']],
      ['Descriptor', ['descriptor']],
      ['Level',      ['level']],
      ['Components', ['components']],
      ['Casting',    ['casting_time']],
      ['Range',      ['range']],
      ['Target',     ['target']],
      ['Area',       ['area']],
      ['Effect',     ['effect']],
      ['Duration',   ['duration']],
      ['Save',       ['saving_throw']],
      ['SR',         ['spell_resistance']],
    ],
    feat: [
      ['Type',       ['types_csv', 'types']],
      // Prereq moved to renderFeatExtra (2026-05-24) so it can render
      // feat names as inline-expandable see-also pills.
    ],
    item: [
      ['Type',       ['item_type', 'type']],
      ['Slot',       ['body_slot']],
      ['Aura',       ['aura']],
      ['CL',         ['caster_level']],
      ['Price',      ['price']],
      ['Weight',     ['weight']],
      // Prereq moved to renderItemExtra (2026-05-24) so it can render
      // Craft feats and spell-name material prereqs as see-also pills.
    ],
    weapon: [
      ['Type',       ['item_type', 'type', 'weapon_type']],
      ['Damage',     ['damage']],
      ['Critical',   ['critical']],
      ['Range',      ['range_increment']],
      ['Price',      ['price']],
      ['Weight',     ['weight']],
    ],
    armor: [
      ['Type',       ['item_type', 'armor_type']],
      ['Bonus',      ['armor_bonus']],
      ['Max Dex',    ['max_dex']],
      ['Check pen.', ['armor_check_penalty']],
      ['ASF',        ['arcane_spell_failure']],
      ['Price',      ['price']],
      ['Weight',     ['weight']],
    ],
    gear: [
      ['Type',       ['item_type', 'type']],
      ['Price',      ['price', 'cost']],
      ['Weight',     ['weight']],
    ],
    creature: [
      ['Size',       ['creature_size', 'size']],
      ['Type',       ['creature_type', 'type']],
      ['CR',         ['cr', 'challenge_rating']],
      ['HD',         ['hit_dice']],
      ['LA',         ['level_adjustment']],
      ['AC',         ['armor_class']],
      ['Alignment',  ['alignment']],
    ],
    race: [
      ['Size',       ['creature_size', 'size']],
      ['Type',       ['creature_type', 'type']],
      ['LA',         ['level_adjustment']],
      ['Favored',    ['favored_class']],
    ],
    template: [
      ['CR adj',     ['cr_adjustment']],
      ['LA',         ['level_adjustment']],
      ['Type',       ['new_creature_type', 'type_change']],
      ['Source ct',  ['source_creature_type']],
    ],
    class: [
      ['HD',         ['hit_die']],
      ['Skill pts',  ['skill_points_per_level']],
      ['Alignment',  ['alignment_restriction', 'alignment']],
    ],
    prc: [
      ['HD',         ['hit_die']],
      ['Skill pts',  ['skill_points_per_level']],
      ['Alignment',  ['alignment_restriction', 'alignment']],
    ],
    maneuver: [
      ['Discipline', ['discipline']],
      ['Type',       ['type']],
      ['Level',      ['level']],
      ['Action',     ['initiation_action']],
      ['Range',      ['range']],
      ['Save',       ['saving_throw']],
    ],
    power: [
      ['Discipline', ['discipline']],
      ['Level',      ['level']],
      ['Time',       ['manifesting_time']],
      ['Range',      ['range']],
      ['PP',         ['power_points']],
      ['Save',       ['saving_throw']],
      ['PR',         ['power_resistance']],
    ],
    mystery: [
      ['Path',       ['path']],
      ['Progression',['level_in_progression']],
      ['Level',      ['mystery_level']],
      ['Type',       ['type']],
      ['School',     ['school']],
    ],
    utterance: [
      ['Lexicon',    ['lexicon']],
      ['Level',      ['level']],
    ],
    vestige: [
      ['Level',      ['vestige_level']],
      ['DC',         ['binding_dc']],
    ],
    soulmeld: [
      ['Chakra',     ['chakra']],
      ['Classes',    ['classes_csv']],
    ],
    invocation: [
      ['Grade',      ['grade']],
      ['Lvl equiv',  ['spell_level_equivalent']],
      ['Subcategory',['subcategory']],
    ],
    domain: [
      ['Deities',    ['deities']],
    ],
    deity: [
      ['Alignment',  ['alignment']],
      ['Domains',    ['domains']],
      ['Symbol',     ['symbol']],
    ],
    region: [],
    plane: [
      ['Type',       ['type']],
      ['Alignment',  ['alignment']],
    ],
    rule: [
      ['Category',   ['category']],
    ],
    skill: [
      ['Key ability',['key_ability']],
      ['Trained only',['trained_only']],
    ],
    skill_use:   [['Skill', ['skill']]],
    skill_trick: [['Category', ['category']], ['Type', ['type']],
                  ['Prereq', ['prerequisites']]],
    poison:      [['Type', ['type']], ['DC', ['save_dc']], ['Price', ['price']]],
    acf:         [['Class', ['class', 'class_name']], ['Level', ['level']],
                  ['Replaces', ['replaces']],
                  ['Prereq', ['prerequisite']]],
    subst_level: [['Class', ['class', 'class_name', 'base_class']],
                  ['Level', ['level']],
                  ['Replaces', ['replaces']],
                  ['Prereq', ['prerequisite', 'requirements']]],
    organization:[['Type', ['type']]],
    ravage_affliction: [['Type', ['type']]],
    condition:   [['Category', ['category']]],
    _default:    [],
  };

  // Type-specific extras shown below the description.
  function renderTypeSpecific(d, type) {
    if (type === 'feat')        return renderFeatExtra(d);
    if (type === 'vestige')     return renderVestigeExtra(d);
    if (type === 'domain')      return renderDomainExtra(d);
    if (type === 'power'        && d.augment)
      return `<div class="lookup-detail-extra"><b>Augment:</b> ${escapeHtml(d.augment)}</div>`;
    if (type === 'class' || type === 'prc') return renderClassExtra(d);
    if (type === 'race')        return renderRaceExtra(d);
    if (type === 'creature')    return renderCreatureExtra(d);
    if (type === 'weapon')      return renderWeaponExtra(d);
    if (type === 'item' || type === 'armor' || type === 'gear')
      return renderItemExtra(d);
    if (type === 'skill')       return renderSkillExtra(d);
    if (type === 'mystery')     return renderMysteryExtra(d);
    if (type === 'rule')        return renderRuleExtra(d);
    if (type === 'acf' || type === 'subst_level'
        || type === 'skill_trick') {
      return renderBenefitExtra(d);
    }
    return '';
  }

  // Reused for ACF / substitution-level / skill-trick — all three
  // entry types carry their actual mechanics in the `benefit` field
  // (with optional `normal` / `special`), exactly like feats. Before
  // 2026-05-20 the lookup modal had no renderer for any of these,
  // which left the panel showing a flavor-only `description` with
  // no rules text — the Decisive Strike (PHB2 ACF) and the 42
  // Complete Scoundrel skill tricks all surfaced this way despite
  // having complete benefit text in the DB. Identical to
  // renderFeatExtra; kept as a separate function so future fields
  // diverging per-type don't entangle.
  //
  // For substitution-level entries: MoI-style entries store their
  // mechanics inside a nested `levels` array of `{level, special,
  // description}` rows (the alt-class-feature for each substitution
  // level: e.g. Aasimar Incarnate replaces L1 + L3 + L7). PlH-style
  // entries store a single replacement at the top level in
  // benefit/replaces. Render both shapes so the modal surfaces the
  // mechanics either way.
  function renderBenefitExtra(d) {
    const lines = [];
    if (d.benefit) lines.push(`<b>Benefit:</b> ${escapeHtml(d.benefit)}`);
    if (d.normal)  lines.push(`<b>Normal:</b> ${escapeHtml(d.normal)}`);
    if (d.special) lines.push(`<b>Special:</b> ${escapeHtml(d.special)}`);
    if (Array.isArray(d.levels) && d.levels.length) {
      // MoI-style per-level breakdown. Each row: {level, special,
      // description}.  Render as a stacked list so the player can
      // see exactly what changes at each substitution level.
      const blocks = d.levels.map(lvl => {
        const sp = lvl.special
          ? ` <span style="opacity:.85">(${escapeHtml(lvl.special)})</span>`
          : '';
        const desc = lvl.description
          ? `<br>${escapeHtml(lvl.description)}`
          : '';
        return `<div class="lookup-sublvl">` +
               `<b>L${escapeHtml(String(lvl.level))}:</b>${sp}${desc}</div>`;
      });
      lines.push(`<b>Substitution levels:</b>` + blocks.join(''));
    }
    return lines.length
      ? `<div class="lookup-detail-extra">${lines.join('<br>')}</div>` : '';
  }

  // Feats: prereqs become a row of see-also-style pills for any
  // chunk that resolves to a real feat in the DB; the rest renders
  // as plain text (ability scores, BAB, skill ranks, alignment, etc.).
  // Plus a "Required by" section that surfaces downstream feats — the
  // user reading Power Attack sees the chain Cleave → Great Cleave →
  // Improved Bull Rush all as one-click expansions.
  //
  // `opts.nested = true` suppresses Required-by (the prereq pills
  // inside a nested feat would still work — they reuse the same
  // see_also expansion container — but we skip downstream-feat
  // querying to keep the nested view focused).
  function renderFeatExtra(d, opts) {
    const nested = !!(opts && opts.nested);
    const parts = [];

    // PREREQUISITES — pills for feats, plain text for everything else
    const prereqText = d.prerequisites || d.prerequisite || '';
    if (prereqText) {
      // Tag with both .lookup-feat-prereq (feat-specific spacing)
      // and .lookup-rule-see-also (so the pill-click handler's
      // `closest('.lookup-rule-see-also')` finds this container and
      // can locate the sibling .lookup-see-also-expansions div).
      parts.push(
        `<div class="lookup-feat-prereq lookup-rule-see-also">` +
        `<b>Prereq:</b> ${renderPrereqWithPills(prereqText)}` +
        `</div>`
      );
    }

    if (d.benefit) {
      parts.push(`<div><b>Benefit:</b> ${escapeHtml(d.benefit)}</div>`);
    }
    if (d.normal) {
      parts.push(`<div><b>Normal:</b> ${escapeHtml(d.normal)}</div>`);
    }
    if (d.special) {
      parts.push(`<div><b>Special:</b> ${escapeHtml(d.special)}</div>`);
    }

    // REQUIRED BY — feats whose prerequisite chain includes this one.
    if (!nested) {
      const dependents = findFeatsRequiring(d.name);
      if (dependents.length) {
        const pills = dependents.map(name =>
          `<button type="button" class="lookup-see-also-pill" ` +
          `data-see-also-name="${escapeHtml(name)}" ` +
          `aria-expanded="false">` +
          `<span class="lookup-see-also-caret">▸</span> ` +
          `${escapeHtml(name)}</button>`
        ).join(' ');
        parts.push(
          `<div class="lookup-rule-see-also lookup-feat-required-by">` +
          `<b>Required by:</b> ${pills}` +
          `<div class="lookup-see-also-expansions"></div>` +
          `</div>`
        );
      }
    }

    return parts.length
      ? `<div class="lookup-detail-extra">${parts.join('')}</div>` : '';
  }

  // Parse a prereq string ("Str 13, Power Attack, base attack bonus +4")
  // into HTML where chunks become clickable pills when they resolve
  // to a DB entry of an allowed type, and plain text otherwise.
  //
  // `opts.allowedTypes` controls which DB entry types can pillify;
  // default `['feat']` (works for feat prereqs). Item creation prereqs
  // pass `['feat', 'spell']` so spell names in "Craft Wondrous Item,
  // haste" pillify too. PrC requirements use the dict-shaped renderer
  // below (renderRequirementsWithPills) instead — that one knows the
  // Feats / Skills / Race / etc. categories already.
  //
  // `opts.skipExpansionsContainer` (default false) — when nested
  // inside another already-has-expansions container, skip the
  // trailing .lookup-see-also-expansions div so we don't end up
  // with two of them inside the same .lookup-rule-see-also (the
  // pill-click handler's querySelector would pick the wrong one).
  function renderPrereqWithPills(text, opts) {
    const allowed = opts?.allowedTypes || ['feat'];
    const skipExpansions = !!(opts && opts.skipExpansionsContainer);
    const chunks = String(text).split(/,\s*/);
    const rendered = chunks.map(chunk => {
      const trimmed = chunk.replace(/[.;]+\s*$/, '').trim();
      if (!trimmed) return '';
      // Plain-text categories: ability scores, BAB, caster level,
      // skill ranks, alignment, special prose. Anything that doesn't
      // look like a bare proper-noun-phrase.
      if (isNonFeatPrereqChunk(trimmed)) {
        return escapeHtml(chunk);
      }
      // Try to resolve as an allowed type. If it matches, render as
      // a pill. Spell-case (item prereqs): D&D book convention writes
      // spell names in italics or lowercase, so resolveSeeAlsoEntry's
      // case-insensitive match works for "haste" → Haste spell.
      const resolved = resolveSeeAlsoEntry(trimmed);
      if (resolved && allowed.includes(resolved.type)) {
        return `<button type="button" class="lookup-see-also-pill" ` +
          `data-see-also-name="${escapeHtml(trimmed)}" ` +
          `aria-expanded="false">` +
          `<span class="lookup-see-also-caret">▸</span> ` +
          `${escapeHtml(trimmed)}</button>`;
      }
      return escapeHtml(chunk);
    });
    // Wrap the prereq block in a container so the pill-expansion
    // logic finds a `.lookup-see-also-expansions` sibling. Match the
    // see-also row's structure so the existing click handler works.
    return rendered.filter(Boolean).join(', ') +
      (skipExpansions ? '' :
        `<div class="lookup-see-also-expansions"></div>`);
  }

  // Render a PrC `requirements` dict as a labeled block, with the
  // Feats sub-category pillified and the rest rendered as plain text.
  // Input shape (from PrC stat blocks):
  //   {Race: "Elf or half-elf.", Feats: "Power Attack, Cleave.",
  //    Skills: "Tumble 8 ranks.", Alignment: "Any chaotic.", ...}
  // The container has .lookup-rule-see-also so the pill click handler
  // finds the .lookup-see-also-expansions sibling we tack on at the end.
  function renderRequirementsWithPills(req) {
    if (!req || typeof req !== 'object') return '';
    const keys = Object.keys(req);
    if (!keys.length) return '';
    // Preferred display order — matches stat-block convention.
    const PRIORITY = [
      'Alignment', 'Race', 'Base Attack Bonus', 'Skills', 'Feats',
      'Spells', 'Spellcasting', 'Class', 'Weapon Proficiency',
      'Special',
    ];
    const ordered = keys.slice().sort((a, b) => {
      const aIdx = PRIORITY.indexOf(a);
      const bIdx = PRIORITY.indexOf(b);
      return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
    });
    const lines = ordered.map(k => {
      const v = req[k];
      if (v == null || v === '') return '';
      const valueHtml = (k === 'Feats')
        ? renderPrereqWithPills(String(v), {
            allowedTypes: ['feat'],
            skipExpansionsContainer: true,
          })
        : escapeHtml(String(v));
      return `<div><b>${escapeHtml(k)}:</b> ${valueHtml}</div>`;
    }).filter(Boolean).join('');
    if (!lines) return '';
    return `<div class="lookup-class-requirements lookup-rule-see-also">` +
      `<b>Requirements</b>${lines}` +
      `<div class="lookup-see-also-expansions"></div>` +
      `</div>`;
  }

  function isNonFeatPrereqChunk(chunk) {
    // Ability score: "Str 13", "Dex 13"
    if (/^(Str|Dex|Con|Int|Wis|Cha)\s+\d+/i.test(chunk)) return true;
    // BAB
    if (/^base attack bonus/i.test(chunk)) return true;
    if (/^bab\s*[+\-]/i.test(chunk)) return true;
    // Caster level
    if (/^caster level/i.test(chunk)) return true;
    // Skill ranks: "5 ranks in Tumble", "Tumble 5 ranks"
    if (/\b(ranks?)\b/i.test(chunk)) return true;
    // Spellcasting requirements
    if (/^(?:able to cast|ability to cast|able to use|must be )/i.test(chunk)) return true;
    if (/^(?:any\s+\d|spellcaster|arcane caster|divine caster)/i.test(chunk)) return true;
    // Class level: "fighter level 4th"
    if (/\blevel\b/i.test(chunk) && /^\w+\s+(level|class)/i.test(chunk)) return true;
    // Alignment
    if (/(?:^|\s)(?:lawful|chaotic|neutral|good|evil)\b/i.test(chunk)
        && /\balignment\b/i.test(chunk)) return true;
    // Race
    if (/^(?:elf|dwarf|halfling|gnome|half-elf|half-orc|human|orc|drow|tiefling|aasimar)\b/i.test(chunk)) return true;
    // Class membership ("any 2 metamagic feats" is a special, not a feat)
    if (/^(any|two|three|four|five|\d+)\s+\w/i.test(chunk)) return true;
    return false;
  }

  // Find feats whose prerequisite string contains the given feat's
  // name. Used by renderFeatExtra to surface the chain downstream
  // ("Required by" section). LIKE %name% as a coarse filter, then
  // a comma-split exact-match per result row to filter false positives
  // (e.g. "Cleave" matching "Great Cleave"'s prereq list — that one's
  // a real positive — but also avoiding "Power Attack" matching a
  // feat that only mentions it in benefit text).
  function findFeatsRequiring(featName) {
    if (!featName || !DB.isLoaded()) return [];
    const rows = DB.query(
      "SELECT name FROM entry " +
      "WHERE type='feat' " +
      "  AND json_extract(data, '$.prerequisites') LIKE ? " +
      "ORDER BY name",
      ['%' + featName + '%']
    );
    if (!rows || !rows.length) return [];
    const lowerName = featName.toLowerCase();
    const matches = new Set();
    for (const row of rows) {
      const stub = DB.queryOne(
        "SELECT data FROM entry WHERE type='feat' AND name=? LIMIT 1",
        [row.name]
      );
      if (!stub) continue;
      let d;
      try { d = JSON.parse(stub.data || '{}'); } catch { continue; }
      const prereq = String(d.prerequisites || d.prerequisite || '');
      const chunks = prereq.split(/,\s*/)
        .map(c => c.replace(/[.;]+\s*$/, '').trim().toLowerCase());
      if (chunks.includes(lowerName)) {
        matches.add(row.name);
      }
    }
    // De-dupe (same name across sources) by name only.
    return Array.from(matches).sort();
  }

  function renderVestigeExtra(d) {
    const lines = [];
    if (d.sign)       lines.push(`<b>Sign:</b> ${escapeHtml(d.sign)}`);
    if (d.influence)  lines.push(`<b>Influence:</b> ${escapeHtml(d.influence)}`);
    if (Array.isArray(d.granted_abilities) && d.granted_abilities.length) {
      const list = d.granted_abilities.map(a =>
        `${escapeHtml(a.name || '')}${a.type ? ` (${escapeHtml(a.type)})` : ''}` +
        (a.description ? `: ${escapeHtml(a.description)}` : '')
      ).join('<br>');
      lines.push(`<b>Granted:</b><br>${list}`);
    }
    return lines.length
      ? `<div class="lookup-detail-extra">${lines.join('<br>')}</div>` : '';
  }

  function renderDomainExtra(d) {
    const lines = [];
    if (d.granted_power) lines.push(`<b>Granted:</b> ${escapeHtml(d.granted_power)}`);
    if (d.spells && typeof d.spells === 'object') {
      const lvls = Object.keys(d.spells)
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
        .map(k => `<b>${escapeHtml(k)}:</b> ${escapeHtml(d.spells[k])}`)
        .join(' · ');
      lines.push(`<b>Spells:</b> ${lvls}`);
    }
    return lines.length
      ? `<div class="lookup-detail-extra">${lines.join('<br>')}</div>` : '';
  }

  // Class / PrC: spellcasting metadata, class skills, hit die / BAB / save
  // progressions (from data.bab_progression etc.), and a compact list of
  // class features. The full class_table is too long for the modal — we
  // show the first 5 rows plus a "(20 levels total)" hint.
  function renderClassExtra(d) {
    const lines = [];
    // PrC requirements — render as a labeled block with feat-name
    // pills (Race / Alignment / Skills / etc. plain text). Goes
    // first because it gates entry to the class.
    if (d.requirements && typeof d.requirements === 'object') {
      const reqHtml = renderRequirementsWithPills(d.requirements);
      if (reqHtml) lines.push(reqHtml);
    }
    if (d.spellcasting && typeof d.spellcasting === 'object') {
      const sc = d.spellcasting;
      const parts = [];
      if (sc.key_ability)  parts.push(`Ability: ${sc.key_ability}`);
      if (sc.style)        parts.push(`Style: ${sc.style}`);
      if (sc.type)         parts.push(`Type: ${sc.type}`);
      if (sc.list)         parts.push(`List: ${sc.list}`);
      if (parts.length)
        lines.push(`<b>Spellcasting:</b> ${escapeHtml(parts.join(' · '))}`);
    }
    const progs = [];
    if (d.bab_progression)  progs.push(`BAB: ${d.bab_progression}`);
    if (d.fort_progression) progs.push(`Fort: ${d.fort_progression}`);
    if (d.ref_progression)  progs.push(`Ref: ${d.ref_progression}`);
    if (d.will_progression) progs.push(`Will: ${d.will_progression}`);
    if (progs.length)
      lines.push(`<b>Progressions:</b> ${escapeHtml(progs.join(' · '))}`);
    // Canonical DB field is `weapon_armor_proficiencies` (plural); the
    // 2026-05-26 field-canon sweep enforces that name. Read plural,
    // fall back to the legacy singular for any un-rebuilt blob.
    const wap = d.weapon_armor_proficiencies || d.weapon_armor_proficiency;
    if (wap)
      lines.push(`<b>Proficiencies:</b> ${escapeHtml(wap)}`);
    if (Array.isArray(d.class_skills) && d.class_skills.length) {
      lines.push(`<b>Class skills:</b> ${escapeHtml(d.class_skills.join(', '))}`);
    }
    if (d.starting_age || d.starting_gold) {
      const parts = [];
      if (d.starting_gold) parts.push(`Starting gold: ${d.starting_gold}`);
      if (d.starting_age)  parts.push(`Starting age: ${d.starting_age}`);
      lines.push(parts.map(escapeHtml).join(' · '));
    }
    if (Array.isArray(d.class_features) && d.class_features.length) {
      // Render full descriptions — previously truncated to 140 chars,
      // which made data inaccessible (a Druid's Wild Shape description
      // is ~1k chars; truncating mid-sentence defeats the point of
      // having it in the DB at all). Per-class total is bounded — max
      // ~20 features, most under 200 chars each — so unbounded render
      // is well within the modal's scroll budget.
      //
      // Prefer `raw_text` (verbatim corpus) over `description` (old
      // summary): the bounds-script sweep populates raw_text with the
      // full feature text from the book. The Wilder Wild Surge case
      // (2026-05-25) — `description`=233ch summary vs `raw_text`=
      // 2011ch full mechanics — was the cautionary tale: the user
      // saw the truncated summary in the lookup modal and assumed
      // the rules were missing, when actually the verbatim was
      // already in the DB on a different field. Falls back to
      // description for features that haven't been swept yet.
      // Body runs through RichText.formatFeatureText (2026-06-09):
      //   - newlines render as <br> instead of collapsing to spaces,
      //   - line-start sub-headings ("Calling a Spell:") bold,
      //   - 3000+ char walls (Geomancer Drift 7k, Binder Soul
      //     Binding 4.6k, ~23 total DB-wide) auto-collapse into a
      //     native <details> "show full text" expander.
      const feats = d.class_features.map(f => {
        const lvl = f.level_acquired != null
          ? `L${f.level_acquired} ` : '';
        const body = f.raw_text || f.description || '';
        const bodyHtml = window.RichText
          ? RichText.formatFeatureText(body) : escapeHtml(body);
        const desc = body ? `: ${bodyHtml}` : '';
        return `<div class="lookup-class-feature">` +
               `<b>${escapeHtml(lvl + (f.name || ''))}</b>${desc}</div>`;
      }).join('');
      lines.push(`<b>Class features:</b>${feats}`);
    }
    // Class table — first 5 rows visible; the rest render hidden so
    // the "… N more levels" footer can reveal them on click without
    // re-running the renderer. The "Special" cell renders full — it
    // used to be truncated to 80 chars but that hid level-tier
    // descriptors (Crusader's "Furious counterstrike, steely resolve"
    // fit, but PrC entries with long "Special" prose got cut).
    if (Array.isArray(d.class_table) && d.class_table.length) {
      const VISIBLE = 5;
      // Unified class table that combines:
      //   - BAB / Fort / Ref / Will / Special (always)
      //   - Spells/Day column when ANY row carries spells_per_day
      //     (handles the 4 distinct shapes: array, dict, "+1 level"
      //     advance string, "1st: 0; 2nd: 1" per-level string)
      //   - Pattern B columns (per-row `columns: {key: N}` dict —
      //     XPH/ToB/MoI/etc. style for power_points_day,
      //     powers_known, max_power_level, maneuvers_known, etc.)
      //   - Spell-advance text extracted from `special` when the
      //     advance is baked there instead of in spells_per_day
      //     (Cerebremancer, Psion Uncarnate, dual-progression PrCs).
      //
      // Goal: one table that matches the book layout. User
      // 2026-05-26: Black Flame Zealot rendered as full-progression
      // because per-level spell info was missing; XPH Psion's PP/Day
      // / Powers Known / Max Lvl rendered as a separate table below
      // instead of merged; Cerebremancer's "+1 level of existing
      // arcane spellcasting class and manifesting class" was stuck
      // in Special instead of its own column.

      // Extract advance text from special, return [cleanedSpecial, advanceText|null]
      // Handles both the long form ("+1 level of existing arcane
      // spellcasting class") and the short form ("+1 level manifesting"
      // — Psion Uncarnate's L2 special) AND the dual-progression form
      // ("+1 level of existing arcane spellcasting class and
      // manifesting class" — Cerebremancer).
      const ADVANCE_RE = /,?\s*\+\d+\s+level(?:s)?(?:\s+of\s+(?:existing\s+)?[a-zA-Z'\-\s]+?)?\s+(?:spellcasting|manifesting)(?:\s+class(?:es)?(?:\s+and\s+(?:spellcasting|manifesting)\s+class(?:es)?)?)?/i;
      function extractAdvance(special) {
        if (typeof special !== 'string') return [special, null];
        const m = special.match(ADVANCE_RE);
        if (!m) return [special, null];
        // Trim trailing/leading comma+space artifacts after extraction
        const cleaned = special.replace(m[0], '').replace(/^[\s,]+|[\s,]+$/g, '').replace(/,\s*,/g, ',').trim();
        return [cleaned || '—', m[0].replace(/^[\s,]+/, '').trim()];
      }

      // Determine row's effective spells_per_day, preferring the
      // dedicated field but falling back to extracted advance text.
      function effectiveSpd(r) {
        if (r.spells_per_day != null) return r.spells_per_day;
        const [, adv] = extractAdvance(r.special || '');
        return adv;  // null when no advance text in special
      }

      function fmtSpd(v) {
        if (v == null) return '—';
        if (Array.isArray(v)) {
          return v.map(x => (x == null || x === '' || x === '-')
            ? '—' : String(x)).join(' / ');
        }
        if (typeof v === 'object') {
          const keys = Object.keys(v).map(k => parseInt(k, 10))
            .filter(n => !isNaN(n)).sort((a, b) => a - b);
          return keys.map(k => {
            const x = v[String(k)];
            return (x == null || x === '' || x === '-' || x === '—')
              ? '—' : String(x);
          }).join(' / ') || '—';
        }
        if (typeof v === 'string') return v;
        return String(v);
      }

      // Collect Pattern B column keys present in this class_table
      const colKeysOrder = [];
      const seenColKey = new Set();
      for (const r of d.class_table) {
        if (r.columns && typeof r.columns === 'object') {
          for (const k of Object.keys(r.columns)) {
            if (!seenColKey.has(k)) {
              seenColKey.add(k);
              colKeysOrder.push(k);
            }
          }
        }
      }
      // Keep only columns with at least one non-empty/non-zero value
      const activeColKeys = colKeysOrder.filter(k =>
        d.class_table.some(r => {
          const v = r.columns && r.columns[k];
          return v != null && v !== '' && v !== '-' && v !== '—' && v !== 0;
        }));
      const COL_LABELS = {
        spells: 'Spells', spells_per_day: 'Spells/Day', spells_known: 'Spells Known',
        power_points_day: 'PP/Day', powers_known: 'Powers Known',
        max_power_level: 'Max Lvl', invocations_known: 'Invocations',
        maneuvers_known: 'Mnv Known', maneuvers_readied: 'Mnv Readied',
        maneuvers_granted: 'Mnv Granted', stances_known: 'Stances',
        infusions_per_day: 'Infusions/Day', essentia: 'Essentia',
        soulmelds: 'Soulmelds', chakra_binds: 'Chakra Binds',
        mind_blade_enhancement: 'Mind Blade', craft_reserve: 'Craft Reserve',
        ac_bonus: 'AC Bonus', unarmed_damage: 'Unarmed',
      };

      // Detect whether any row has effective spells_per_day
      const hasSpd = d.class_table.some(r => effectiveSpd(r) != null);
      const spdHead = hasSpd ? `<th>Spells/Day</th>` : '';
      const colHeads = activeColKeys.map(k =>
        `<th title="${escapeHtml(k)}">${escapeHtml(COL_LABELS[k] || k)}</th>`).join('');
      const head = `<tr><th>L</th><th>BAB</th><th>Fort</th><th>Ref</th>` +
        `<th>Will</th><th>Special</th>${spdHead}${colHeads}</tr>`;
      const body = d.class_table.map((r, i) => {
        const [cleanedSpecial, advText] = extractAdvance(r.special || '');
        const specialDisplay = cleanedSpecial || '—';
        const spdValue = r.spells_per_day != null
          ? r.spells_per_day : advText;
        const spdCell = hasSpd
          ? `<td>${escapeHtml(fmtSpd(spdValue))}</td>` : '';
        const colCells = activeColKeys.map(k => {
          const v = r.columns && r.columns[k];
          const display = (v == null || v === '') ? '—' : String(v);
          return `<td>${escapeHtml(display)}</td>`;
        }).join('');
        const hidden = i >= VISIBLE ? ' class="lookup-row-extra"' : '';
        return `<tr${hidden}><td>${escapeHtml(String(r.level))}</td>` +
               `<td>${escapeHtml(String(r.bab || ''))}</td>` +
               `<td>${escapeHtml(String(r.fort || ''))}</td>` +
               `<td>${escapeHtml(String(r.ref || ''))}</td>` +
               `<td>${escapeHtml(String(r.will || ''))}</td>` +
               `<td>${escapeHtml(specialDisplay)}</td>${spdCell}${colCells}</tr>`;
      }).join('');
      const extra = d.class_table.length - VISIBLE;
      const more = extra > 0
        ? `<div class="lookup-expand-more" data-action="expand-table" ` +
          `tabindex="0" role="button" ` +
          `title="Click to show all ${d.class_table.length} levels">` +
          `… ${extra} more level${extra === 1 ? '' : 's'} (click to expand)` +
          `</div>`
        : '';
      lines.push(`<b>Class table:</b>` +
        `<table class="lookup-class-table">${head}${body}</table>${more}`);
    }
    // Spell-progression / power-progression / maneuver-progression
    // sub-tables: only render Pattern A (per-spell-level slots) here.
    // Pattern B columns are now merged into the main class_table above,
    // so the standalone "Class resources" sub-table is suppressed for
    // them. See renderProgressionTables for the per-shape logic.
    const progTables = renderProgressionTables(d.class_table, true);
    if (progTables) lines.push(progTables);
    return lines.length
      ? `<div class="lookup-detail-extra">${lines.join('<br>')}</div>` : '';
  }

  // Spell / power / maneuver / invocation progression tables for
  // class entries. Two data shapes coexist in the DB:
  //
  //   A) PHB-style — per-row `spells_per_day: [3, 1, "-", ...]`
  //      indexed by spell level 0-9. Sorcerer / Bard also carry
  //      `spells_known: [4, 2, "-", ...]` in parallel. Rendered as
  //      a Spells/Day table + optional Spells Known table; all-"-"
  //      spell-level columns are dropped so a Paladin (4 levels)
  //      doesn't render six empty columns.
  //   B) PHB2 / XPH / ToB / CArc style — per-row `columns: {key: N}`
  //      dict for non-spell-slot resources. Keys observed:
  //      invocations_known, power_points_day, powers_known,
  //      max_power_level, maneuvers_known, maneuvers_readied,
  //      maneuvers_granted, stances_known, infusions_per_day,
  //      essentia, soulmelds, chakra_binds, mind_blade_enhancement,
  //      craft_reserve, ac_bonus, unarmed_damage, spells. Rendered
  //      as a single table keyed by L + one column per non-zero key.
  //
  // A class can carry both shapes simultaneously (rare; some
  // manifesters carry both). Both tables render in that case. Same
  // 5-rows-visible + "(click to expand)" treatment as the BAB/save
  // table — uses the existing data-action="expand-table" handler.
  function renderProgressionTables(classTable, suppressPatternB) {
    if (!Array.isArray(classTable) || !classTable.length) return '';
    const VISIBLE = 5;
    const blocks = [];

    // --- Normalize spells_per_day across the 4 PrC data shapes -------
    // PrC class_table rows carry `spells_per_day` in one of FOUR shapes
    // (audited 2026-05-26 across 111 spellcasting PrCs):
    //   1. Array `[3, 1, "-", "-"]` — PHB-style per-spell-level slots.
    //      Renders via Pattern A. (4 PrCs)
    //   2. Dict `{"1": "1", "2": "—"}` — same data, dict-keyed by spell
    //      level as string. Convert to array. (4 PrCs)
    //   3. String "1st: 0; 2nd: 1" — Assassin-style compact per-level
    //      string. Parse to array. (42 PrCs)
    //   4. String "+1 level of existing arcane spellcasting class" —
    //      spell-advancing PrC pattern. Surface as a compact summary
    //      line instead of a per-level table. (61 PrCs)
    //
    // Shapes 2–4 were silently invisible before this normalization;
    // most spellcasting PrCs showed BAB/saves/special only. User
    // flagged 2026-05-26: this is THE first thing checked to decide if
    // a PrC is worth taking as a caster.
    function normalizeSpd(row) {
      const v = row.spells_per_day;
      if (v == null) return { kind: null };
      if (Array.isArray(v)) {
        row.spells_per_day = v;
        return { kind: 'array' };
      }
      if (typeof v === 'object') {
        // Dict keyed by spell level as string (or int)
        const keys = Object.keys(v).map(k => parseInt(k, 10))
          .filter(n => !isNaN(n));
        if (!keys.length) return { kind: null };
        const max = Math.max(...keys);
        // Build array indexed by spell level (0..max). PHB convention
        // is 0-indexed (cantrips at index 0); dicts here seem 1-keyed
        // (no zero level — sub-9 caster pattern). We preserve the
        // 1-based indexing in the array (index 0 stays "—") so the
        // rendered column headers match expectations.
        const out = [];
        for (let i = 0; i <= max; i++) {
          const k = String(i);
          out.push(v[k] != null ? v[k] : '—');
        }
        row.spells_per_day = out;
        return { kind: 'array' };
      }
      if (typeof v === 'string') {
        const s = v.trim();
        // Shape 4: spell-advancing PrC. Keep string for compact render.
        if (/\+\d+\s*level\s+of\s+(?:existing\s+)?/i.test(s)) {
          return { kind: 'advance', text: s };
        }
        // Shape 3: "1st: 0; 2nd: 1; 3rd: —" — parse to array
        const re = /(\d+)(?:st|nd|rd|th):\s*([\d—\-]+)/g;
        const out = [];
        let m;
        while ((m = re.exec(s)) !== null) {
          const lvl = parseInt(m[1], 10);
          while (out.length <= lvl) out.push('—');
          out[lvl] = m[2];
        }
        if (out.length) {
          row.spells_per_day = out;
          return { kind: 'array' };
        }
        // Unknown string shape — surface as plain text fallback
        return { kind: 'plain', text: s };
      }
      return { kind: null };
    }
    const spdMeta = classTable.map(normalizeSpd);

    // (We no longer emit a separate "Spellcasting:" summary block —
    // per-row spells_per_day is now in the main class_table's
    // Spells/Day column, which is more book-faithful. Pattern A's
    // per-spell-level slot table still renders below for PrCs with
    // their own spell list.)

    // --- Pattern A: spells_per_day / spells_known --------------------
    // Determine which spell-level columns to render. A column is
    // included if any row has a non-"-" non-null value at that index.
    function activeSpellCols(field) {
      const has = classTable.some(r => Array.isArray(r[field]));
      if (!has) return null;
      const len = Math.max(...classTable.map(
        r => Array.isArray(r[field]) ? r[field].length : 0));
      const active = [];
      for (let i = 0; i < len; i++) {
        const used = classTable.some(r => {
          const v = Array.isArray(r[field]) ? r[field][i] : null;
          return v != null && v !== '' && v !== '-' && v !== '—';
        });
        if (used) active.push(i);
      }
      return active.length ? active : null;
    }

    function buildSpellTable(field, label) {
      const cols = activeSpellCols(field);
      if (!cols) return '';
      const headCells = ['<th>L</th>']
        .concat(cols.map(i => `<th>${i}</th>`)).join('');
      const head = `<tr>${headCells}</tr>`;
      const body = classTable.map((r, i) => {
        const arr = Array.isArray(r[field]) ? r[field] : [];
        const cells = cols.map(idx => {
          const v = arr[idx];
          const display = (v == null || v === '') ? '—'
            : (v === '-' ? '—' : String(v));
          return `<td>${escapeHtml(display)}</td>`;
        }).join('');
        const hidden = i >= VISIBLE ? ' class="lookup-row-extra"' : '';
        return `<tr${hidden}><td>${escapeHtml(String(r.level))}</td>${cells}</tr>`;
      }).join('');
      const extra = classTable.length - VISIBLE;
      const more = extra > 0
        ? `<div class="lookup-expand-more" data-action="expand-table" ` +
          `tabindex="0" role="button" ` +
          `title="Click to show all ${classTable.length} levels">` +
          `… ${extra} more level${extra === 1 ? '' : 's'} (click to expand)` +
          `</div>`
        : '';
      return `<b>${escapeHtml(label)}</b>` +
        `<table class="lookup-class-table">${head}${body}</table>${more}`;
    }

    const spdHtml = buildSpellTable('spells_per_day', 'Spells per day:');
    if (spdHtml) blocks.push(spdHtml);
    const skHtml = buildSpellTable('spells_known', 'Spells known:');
    if (skHtml) blocks.push(skHtml);

    // --- Pattern B: per-row columns dict -----------------------------
    // Skipped when caller (the main class_table renderer) has already
    // merged these columns into the unified table. Without that
    // suppression, we'd double-render PP/Day / Powers Known / Max Lvl
    // for every XPH manifester. Standalone Pattern B render is kept
    // for callers that don't pass the flag (no current callers, but
    // future direct renderProgressionTables() invocations work fine).
    if (suppressPatternB) return blocks.join('<br>');
    const colKeys = [];
    const seenKey = new Set();
    for (const r of classTable) {
      if (r.columns && typeof r.columns === 'object') {
        for (const k of Object.keys(r.columns)) {
          if (!seenKey.has(k)) {
            seenKey.add(k);
            colKeys.push(k);
          }
        }
      }
    }
    // Filter out keys that are uniformly empty / 0 / "-" / "—".
    const activeKeys = colKeys.filter(k =>
      classTable.some(r => {
        const v = r.columns && r.columns[k];
        return v != null && v !== '' && v !== '-' && v !== '—' && v !== 0;
      }));
    if (activeKeys.length) {
      const COL_LABELS = {
        spells: 'Spells',
        spells_per_day: 'Spells/Day',
        spells_known: 'Spells Known',
        power_points_day: 'PP/Day',
        powers_known: 'Powers Known',
        max_power_level: 'Max Lvl',
        invocations_known: 'Invocations',
        maneuvers_known: 'Mnv Known',
        maneuvers_readied: 'Mnv Readied',
        maneuvers_granted: 'Mnv Granted',
        stances_known: 'Stances',
        infusions_per_day: 'Infusions/Day',
        essentia: 'Essentia',
        soulmelds: 'Soulmelds',
        chakra_binds: 'Chakra Binds',
        mind_blade_enhancement: 'Mind Blade',
        craft_reserve: 'Craft Reserve',
        ac_bonus: 'AC Bonus',
        unarmed_damage: 'Unarmed',
      };
      const headCells = ['<th>L</th>']
        .concat(activeKeys.map(k =>
          `<th title="${escapeHtml(k)}">${escapeHtml(COL_LABELS[k] || k)}</th>`))
        .join('');
      const head = `<tr>${headCells}</tr>`;
      const body = classTable.map((r, i) => {
        const cells = activeKeys.map(k => {
          const v = r.columns && r.columns[k];
          const display = (v == null || v === '') ? '—' : String(v);
          return `<td>${escapeHtml(display)}</td>`;
        }).join('');
        const hidden = i >= VISIBLE ? ' class="lookup-row-extra"' : '';
        return `<tr${hidden}><td>${escapeHtml(String(r.level))}</td>${cells}</tr>`;
      }).join('');
      const extra = classTable.length - VISIBLE;
      const more = extra > 0
        ? `<div class="lookup-expand-more" data-action="expand-table" ` +
          `tabindex="0" role="button" ` +
          `title="Click to show all ${classTable.length} levels">` +
          `… ${extra} more level${extra === 1 ? '' : 's'} (click to expand)` +
          `</div>`
        : '';
      blocks.push(`<b>Class resources:</b>` +
        `<table class="lookup-class-table">${head}${body}</table>${more}`);
    }

    return blocks.join('<br>');
  }

  // Magic-item / armor / gear creation prereqs: Craft feats + spell
  // names pillify; non-resolvable chunks ("creator must be good")
  // stay as plain text.
  function renderItemExtra(d, opts) {
    const nested = !!(opts && opts.nested);
    const prereqText = d.prerequisites || d.prerequisite || '';
    if (!prereqText) return '';
    const pillText = renderPrereqWithPills(prereqText, {
      allowedTypes: ['feat', 'spell'],
    });
    return `<div class="lookup-detail-extra">` +
      `<div class="lookup-rule-see-also">` +
      `<b>Prereq:</b> ${pillText}` +
      `</div>` +
      `</div>`;
  }

  function renderRaceExtra(d) {
    const lines = [];
    if (Array.isArray(d.ability_mods) && d.ability_mods.length) {
      const mods = d.ability_mods.map(m => {
        const ab = (m.ability || '').toString();
        const sign = (m.modifier || 0) >= 0 ? '+' : '';
        return `${ab} ${sign}${m.modifier}`;
      }).join(', ');
      lines.push(`<b>Ability adjustments:</b> ${escapeHtml(mods)}`);
    }
    if (d.speed) lines.push(`<b>Speed:</b> ${escapeHtml(formatValue(d.speed))}`);
    if (Array.isArray(d.languages) && d.languages.length) {
      const auto = d.languages.filter(l => l.is_automatic).map(l => l.language);
      const bonus = d.languages.filter(l => !l.is_automatic).map(l => l.language);
      const parts = [];
      if (auto.length)  parts.push(`automatic: ${auto.join(', ')}`);
      if (bonus.length) parts.push(`bonus: ${bonus.join(', ')}`);
      lines.push(`<b>Languages:</b> ${escapeHtml(parts.join('; '))}`);
    }
    if (Array.isArray(d.bonuses) && d.bonuses.length) {
      const bs = d.bonuses.map(b => {
        const amt = (b.amount >= 0 ? '+' : '') + (b.amount ?? '');
        return `${amt} ${b.bonus_type || ''} to ${b.target}` +
               (b.condition ? ` (${b.condition})` : '');
      }).join('; ');
      lines.push(`<b>Bonuses:</b> ${escapeHtml(bs)}`);
    }
    if (Array.isArray(d.traits) && d.traits.length) {
      const ts = d.traits.map(t => {
        const desc = t.description ? `: ${truncate(t.description, 200)}` : '';
        return `<div style="margin-left:0.5rem"><b>${escapeHtml(t.name)}</b>${escapeHtml(desc)}</div>`;
      }).join('');
      lines.push(`<b>Traits:</b>${ts}`);
    }
    if (d.favored_class) lines.push(`<b>Favored class:</b> ${escapeHtml(d.favored_class)}`);
    return lines.length
      ? `<div class="lookup-detail-extra">${lines.join('<br>')}</div>` : '';
  }

  function renderCreatureExtra(d) {
    const lines = [];
    // Ability scores.
    if (d.abilities && typeof d.abilities === 'object') {
      const order = ['Str','Dex','Con','Int','Wis','Cha'];
      const parts = order.map(k => {
        const v = d.abilities[k] ?? d.abilities[k.toLowerCase()];
        return `${k} ${v == null ? '—' : v}`;
      });
      lines.push(`<b>Abilities:</b> ${escapeHtml(parts.join(', '))}`);
    }
    if (d.hit_dice)       lines.push(`<b>HD:</b> ${escapeHtml(d.hit_dice)}`);
    if (d.initiative)     lines.push(`<b>Init:</b> ${escapeHtml(formatValue(d.initiative))}`);
    if (d.speed)          lines.push(`<b>Speed:</b> ${escapeHtml(formatValue(d.speed))}`);
    if (d.armor_class)    lines.push(`<b>AC:</b> ${escapeHtml(formatValue(d.armor_class))}`);
    if (d.saves || (d.fort_save != null || d.ref_save != null || d.will_save != null)) {
      const sv = d.saves || {
        Fort: d.fort_save, Ref: d.ref_save, Will: d.will_save,
      };
      lines.push(`<b>Saves:</b> ${escapeHtml(formatValue(sv))}`);
    }
    if (d.base_attack || d.grapple)
      lines.push(`<b>Atk/Grp:</b> ${escapeHtml((d.base_attack || '') + ' / ' + (d.grapple || ''))}`);
    if (d.attack)         lines.push(`<b>Attack:</b> ${escapeHtml(formatValue(d.attack))}`);
    if (d.full_attack)    lines.push(`<b>Full attack:</b> ${escapeHtml(formatValue(d.full_attack))}`);
    if (d.space || d.reach) {
      const parts = [];
      if (d.space) parts.push(`Space: ${d.space}`);
      if (d.reach) parts.push(`Reach: ${d.reach}`);
      lines.push(parts.map(escapeHtml).join(' · '));
    }
    if (d.special_attacks)    lines.push(`<b>Special attacks:</b> ${escapeHtml(formatValue(d.special_attacks))}`);
    if (d.special_qualities)  lines.push(`<b>Special qualities:</b> ${escapeHtml(formatValue(d.special_qualities))}`);
    if (d.spell_like_abilities) {
      lines.push(`<b>SLAs:</b> ${escapeHtml(formatValue(d.spell_like_abilities))}`);
    }
    if (d.feats)          lines.push(`<b>Feats:</b> ${escapeHtml(formatValue(d.feats))}`);
    if (d.skills)         lines.push(`<b>Skills:</b> ${escapeHtml(formatValue(d.skills))}`);
    if (d.environment)    lines.push(`<b>Environment:</b> ${escapeHtml(d.environment)}`);
    if (d.organization)   lines.push(`<b>Organization:</b> ${escapeHtml(formatValue(d.organization))}`);
    if (d.treasure)       lines.push(`<b>Treasure:</b> ${escapeHtml(d.treasure)}`);
    if (d.advancement)    lines.push(`<b>Advancement:</b> ${escapeHtml(formatValue(d.advancement))}`);
    return lines.length
      ? `<div class="lookup-detail-extra">${lines.join('<br>')}</div>` : '';
  }

  function renderWeaponExtra(d) {
    const lines = [];
    const group = d.weapon_group || d.group;
    const category = d.weapon_category || d.category;
    if (group)    lines.push(`<b>Group:</b> ${escapeHtml(group)}`);
    if (category) lines.push(`<b>Category:</b> ${escapeHtml(category)}`);
    if (d.damage_type) lines.push(`<b>Damage type:</b> ${escapeHtml(d.damage_type)}`);
    if (Array.isArray(d.properties) && d.properties.length)
      lines.push(`<b>Properties:</b> ${escapeHtml(d.properties.join(', '))}`);
    if (d.special) lines.push(`<b>Special:</b> ${escapeHtml(d.special)}`);
    // Damage by size, if structured.
    if (d.damage_by_size && typeof d.damage_by_size === 'object') {
      const order = ['Tiny','Small','Medium','Large','Huge'];
      const parts = order
        .filter(s => d.damage_by_size[s])
        .map(s => `${s} ${d.damage_by_size[s]}`);
      if (parts.length) lines.push(`<b>Damage by size:</b> ${escapeHtml(parts.join(' · '))}`);
    }
    return lines.length
      ? `<div class="lookup-detail-extra">${lines.join('<br>')}</div>` : '';
  }

  // Skills: surface synergies from data.js. The DB doesn't carry synergy
  // information today; data.js has the canonical PHB Table 4-5 (plus
  // expansion-book additions). Match by name on either side.
  function renderSkillExtra(d) {
    const lines = [];
    if (d.untrained != null)
      lines.push(`<b>Untrained:</b> ${d.untrained === false || /no/i.test(String(d.untrained)) ? 'no' : 'yes'}`);
    if (d.armor_check_penalty)
      lines.push(`<b>Armor check penalty:</b> applies`);
    if (d.check)        lines.push(`<b>Check:</b> ${escapeHtml(d.check)}`);
    if (d.action)       lines.push(`<b>Action:</b> ${escapeHtml(d.action)}`);
    if (d.try_again)    lines.push(`<b>Try again:</b> ${escapeHtml(d.try_again)}`);
    if (d.synergy)      lines.push(`<b>Synergy:</b> ${escapeHtml(d.synergy)}`);
    // Pull synergies from data.js. SKILL_SYNERGIES is keyed by source
    // skill → list of { target, bonus, condition }. Show synergies
    // both granted by this skill and granted to this skill.
    // `DND35` is a top-level `const` (script-scope binding), not a
    // `window` property. Use a typeof guard for cross-module access.
    if (typeof DND35 !== 'undefined' && DND35.SKILL_SYNERGIES) {
      const grants = [];
      const receives = [];
      const name = d.name || '';
      const key = name.toLowerCase();
      for (const [src, list] of Object.entries(DND35.SKILL_SYNERGIES)) {
        if (src.toLowerCase() === key) {
          for (const s of list) grants.push(`+${s.bonus || 2} ${s.target}${s.condition ? ` (${s.condition})` : ''}`);
        }
        for (const s of list) {
          if ((s.target || '').toLowerCase() === key) {
            receives.push(`from ${src} (5+ ranks) — +${s.bonus || 2}${s.condition ? ` ${s.condition}` : ''}`);
          }
        }
      }
      if (grants.length)
        lines.push(`<b>Grants synergy:</b> ${escapeHtml(grants.join('; '))}`);
      if (receives.length)
        lines.push(`<b>Receives synergy:</b> ${escapeHtml(receives.join('; '))}`);
    }
    return lines.length
      ? `<div class="lookup-detail-extra">${lines.join('<br>')}</div>` : '';
  }

  function renderMysteryExtra(d) {
    const lines = [];
    if (d.range)            lines.push(`<b>Range:</b> ${escapeHtml(d.range)}`);
    if (d.area)             lines.push(`<b>Area:</b> ${escapeHtml(d.area)}`);
    if (d.target)           lines.push(`<b>Target:</b> ${escapeHtml(d.target)}`);
    if (d.duration)         lines.push(`<b>Duration:</b> ${escapeHtml(d.duration)}`);
    if (d.saving_throw)     lines.push(`<b>Save:</b> ${escapeHtml(d.saving_throw)}`);
    if (d.spell_resistance) lines.push(`<b>SR:</b> ${escapeHtml(d.spell_resistance)}`);
    if (d.casting_time)     lines.push(`<b>Casting time:</b> ${escapeHtml(d.casting_time)}`);
    if (d.descriptor)       lines.push(`<b>Descriptor:</b> ${escapeHtml(d.descriptor)}`);
    return lines.length
      ? `<div class="lookup-detail-extra">${lines.join('<br>')}</div>` : '';
  }

  // Rules: render mechanics, tables, see_also cross-links, page ref,
  // and raw_text (collapsed). The 2026-05-24 Core rules pass added
  // structured `mechanics` (dict) + `tables` (list of {name, headers,
  // rows, notes}) + `see_also` (list of cross-link names) + `page`
  // (int) + `raw_text` (verbatim corpus excerpt). All optional; the
  // renderer skips blocks for absent fields so older rules still
  // display cleanly.
  //
  // Tables historically used `caption`/`title`; new ones use `name`.
  // Try all three so legacy data isn't broken by the schema change.
  function renderRuleExtra(d, opts) {
    const nested = !!(opts && opts.nested);
    const parts = [];

    // PAGE (small, leading) — only if not already shown above
    if (d.page) {
      parts.push(`<div class="lookup-rule-page">PHB / DMG / MM p.${escapeHtml(String(d.page))}</div>`);
    }

    // MECHANICS — structured dict rendered as <dl>. Recursively
    // renders nested dicts + lists so multi-level fields like
    // initiation_sequence + size_step_up_baseline come through readable.
    if (d.mechanics && typeof d.mechanics === 'object'
        && Object.keys(d.mechanics).length) {
      parts.push(
        `<div class="lookup-rule-mechanics"><b>Mechanics</b>${
          renderMechValue(d.mechanics)
        }</div>`,
      );
    }

    // TABLES — structured {name, headers, rows, notes}. Note also
    // legacy {caption, title, text}.
    if (Array.isArray(d.tables) && d.tables.length) {
      const blocks = d.tables.map(renderRuleTable).filter(Boolean);
      if (blocks.length) parts.push(blocks.join(''));
    }

    // SEE ALSO — clickable pills that expand the linked entry INLINE
    // below the see-also row. The use case is mid-read clarification:
    // reading Grapple, want to know if Pinning makes someone Helpless,
    // click Pinned → its content drops in beneath the see-also row,
    // read it, close it, keep reading Grapple. Multiple can be open
    // at once. The pill toggles its own expansion. Each nested
    // expansion is compact (no further see_also nesting, no raw_text)
    // to keep the focus on the main entry.
    //
    // Suppressed when `nested` is true so a nested expansion's own
    // see_also can't open further levels (would lose the user in a
    // rabbit hole).
    if (!nested && Array.isArray(d.see_also) && d.see_also.length) {
      const pills = d.see_also.map(n =>
        `<button type="button" class="lookup-see-also-pill" ` +
        `data-see-also-name="${escapeHtml(String(n))}" ` +
        `aria-expanded="false">` +
        `<span class="lookup-see-also-caret">▸</span> ` +
        `${escapeHtml(String(n))}</button>`
      ).join(' ');
      parts.push(
        `<div class="lookup-rule-see-also"><b>See also:</b> ${pills}` +
        `<div class="lookup-see-also-expansions"></div>` +
        `</div>`
      );
    }

    // RAW TEXT — collapsible. Only Core re-extracted rules carry
    // this today; rest of the corpus comes from data extractions
    // that aren't backed by verbatim text. Suppressed in nested view
    // — verbatim corpus is for audit / deep-read, not for the
    // glance-and-go clarification use case.
    if (!nested && d.raw_text && String(d.raw_text).trim()) {
      parts.push(
        `<details class="lookup-rule-raw-text"><summary>Verbatim source text</summary>` +
        `<pre>${escapeHtml(String(d.raw_text))}</pre></details>`
      );
    }

    if (!parts.length) return '';
    return `<div class="lookup-detail-extra">${parts.join('')}</div>`;
  }

  // Render one table entry into HTML. Delegates to the shared
  // RichText renderer (rich-text.js), which normalizes BOTH key
  // dialects — {caption, columns, rows} (the 439-table walk shape)
  // and {name, headers, rows} (the 2026-05-24 Core rules shape) —
  // plus the notes/footnotes/footnote/note and spanning-`header`
  // extras. The pre-RichText local renderer only understood the
  // `headers` dialect, so the `columns` dialect (42 rule tables —
  // Epic Spell development, Siege Engines, …) fell through to a
  // raw-JSON <pre> dump.
  function renderRuleTable(t) {
    if (window.RichText) return RichText.renderTable(t);
    console.warn('[lookup] RichText module missing — table dropped');
    return '';
  }

  // Generic structured-tables block for NON-rule entries (items,
  // templates, creatures, feats, skills, …— 17 types carry `tables`
  // today). Rule entries render their tables inside renderRuleExtra
  // instead, where they sit between Mechanics and See-also.
  function renderEntryTables(d) {
    if (!window.RichText) return '';
    const html = RichText.renderTables(d.tables);
    return html
      ? `<div class="lookup-detail-extra lookup-entry-tables">${html}</div>`
      : '';
  }

  // Recursive renderer for the `mechanics` dict. Dicts → <dl>;
  // arrays → <ul>; primitives → escaped text. Keys are humanized
  // (snake_case → "Title Case") so a JSON-shaped dict reads like
  // a normal rules-text block.
  function renderMechValue(v) {
    if (v == null) return '';
    if (Array.isArray(v)) {
      if (!v.length) return '';
      // Arrays of primitives → bulleted list; arrays of objects →
      // recurse.
      const items = v.map(x => {
        if (x && typeof x === 'object') return `<li>${renderMechValue(x)}</li>`;
        return `<li>${escapeHtml(String(x))}</li>`;
      }).join('');
      return `<ul class="lookup-mech-list">${items}</ul>`;
    }
    if (typeof v === 'object') {
      const rows = Object.entries(v).map(([k, val]) => {
        const label = humanizeKey(k);
        // Inline primitives directly on the dt line; nest objects/
        // arrays as their own dd.
        if (val && typeof val === 'object') {
          return `<dt>${escapeHtml(label)}</dt><dd>${renderMechValue(val)}</dd>`;
        }
        return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(val))}</dd>`;
      }).join('');
      return `<dl class="lookup-mech-dl">${rows}</dl>`;
    }
    return escapeHtml(String(v));
  }

  function humanizeKey(k) {
    return String(k)
      .replace(/_/g, ' ')
      .replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
  }

  // Resolve a see-also name string to the most appropriate DB entry.
  // Cross-link names like "Pinned", "Improved Grapple", "Escape
  // Artist" need a type-priority tiebreak: a "Pinned" link from a
  // grapple rule wants the Pinned CONDITION, not (hypothetically)
  // a Pinned feat. Order: condition > rule > feat > skill > spell >
  // class > prc > everything else. Case-insensitive exact match on
  // name; first hit at the best-priority tier wins.
  const SEE_ALSO_TYPE_PRIORITY = [
    'condition', 'rule', 'feat', 'skill', 'skill_use',
    'spell', 'class', 'prc', 'maneuver', 'power', 'item',
  ];
  function resolveSeeAlsoEntry(name) {
    if (!name || !DB.isLoaded()) return null;
    const rows = DB.query(
      "SELECT id, type, name, source FROM entry " +
      "WHERE LOWER(name) = LOWER(?)",
      [name]
    );
    if (!rows || !rows.length) return null;
    // Sort by type priority, then by source-recency proxy (3.5
    // before 3.0 — we don't have version here so prefer rows that
    // look like the primary book entry).
    const ranked = rows.slice().sort((a, b) => {
      const aIdx = SEE_ALSO_TYPE_PRIORITY.indexOf(a.type);
      const bIdx = SEE_ALSO_TYPE_PRIORITY.indexOf(b.type);
      const aRank = aIdx === -1 ? 99 : aIdx;
      const bRank = bIdx === -1 ? 99 : bIdx;
      return aRank - bRank;
    });
    return ranked[0];
  }

  // Render the inline-expanded view of a see-also entry. Compact
  // header (name · type · source) + description + structured extras
  // (mechanics, tables) — see_also and raw_text are suppressed in
  // this view to keep the focus on the parent entry the user is
  // really reading.
  function renderNestedExpansion(name) {
    const stub = resolveSeeAlsoEntry(name);
    if (!stub) {
      return `<div class="lookup-nested-expansion lookup-nested-notfound">` +
        `<b>${escapeHtml(name)}</b> — not found in the DB.</div>`;
    }
    const data = fetchDetail(stub.id);
    if (!data) {
      return `<div class="lookup-nested-expansion lookup-nested-notfound">` +
        `<b>${escapeHtml(name)}</b> — entry lookup failed.</div>`;
    }
    const type = data.type;
    const typeLabel = TYPE_LABELS[type] || type;
    const head =
      `<div class="lookup-nested-head">` +
      `<span class="lookup-nested-name">${escapeHtml(data.name)}</span>` +
      ` <span class="lookup-nested-type">${escapeHtml(typeLabel)}</span>` +
      (data.source ?
        ` <span class="lookup-nested-source">· ${escapeHtml(data.source)}</span>` : '') +
      `</div>`;
    const desc = data.description
      ? `<div class="lookup-nested-desc">${escapeHtml(String(data.description))}</div>`
      : '';
    // Reuse the type-specific renderer but pass nested=true where
    // supported so the renderer skips its own see_also / required-by
    // / raw_text (which would otherwise let the user open further
    // expansions inside an already-nested one and rabbit-hole).
    // Renderers without nested support are called as-is.
    let extras = '';
    if (type === 'rule') {
      extras = renderRuleExtra(data, { nested: true });
    } else if (type === 'feat') {
      extras = renderFeatExtra(data, { nested: true });
    } else if (type === 'item' || type === 'armor' || type === 'gear') {
      extras = renderItemExtra(data, { nested: true });
    } else if (type === 'class' || type === 'prc') {
      extras = renderClassExtra(data);
    } else {
      extras = renderTypeSpecific(data, type);
    }
    // Tables are content (not navigation), so unlike see_also /
    // raw_text they stay visible in the nested view. Rule entries
    // already include theirs via renderRuleExtra above.
    if (type !== 'rule') extras += renderEntryTables(data);
    return `<div class="lookup-nested-expansion" data-nested-name="${escapeHtml(name)}">` +
      head + desc + extras + `</div>`;
  }

  function truncate(s, n) {
    if (!s) return '';
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function renderTags(d) {
    if (!Array.isArray(d.tags) || !d.tags.length) return '';
    const tags = d.tags.map(t =>
      `<span class="lookup-tag">${escapeHtml(t)}</span>`).join('');
    return `<div class="lookup-detail-tags">${tags}</div>`;
  }

  // ---- Search index -------------------------------------------------------

  function buildIndex() {
    if (entries.length) return;          // already built
    if (!DB.isLoaded()) return;
    // Pull description/benefit/effect text into a `bodyKey` so the
    // search can match on entry contents, not just titles. We query
    // the most commonly populated narrative fields via json_extract
    // (everything per-type ends up here, falling back to NULLs).
    // Roughly ~5 MB of strings in memory for 12.5k entries — fine.
    //
    // For class / prc entries we ALSO pull `class_features` (raw
    // JSON) so the body match can hit feature names. This is what
    // makes "Wild Shape" surface Druid, "Rage" surface Barbarian,
    // "Bardic Music" surface Bard, etc. — without it, a player
    // searching for a feature they remember by name has to guess
    // the parent class to navigate to it. Parsed client-side
    // because SQLite's json1 doesn't ergonomically flatten an
    // array-of-objects into a text blob.
    const rows = DB.query(
      "SELECT id, name, type, source, " +
      "  COALESCE(" +
      "    json_extract(data, '$.description'), " +
      "    json_extract(data, '$.benefit'), " +
      "    json_extract(data, '$.effect'), " +
      "    json_extract(data, '$.granted_power'), " +
      "    json_extract(data, '$.text'), " +
      "    ''" +
      "  ) AS body, " +
      "  CASE WHEN type IN ('class','prc') " +
      "       THEN json_extract(data, '$.class_features') ELSE NULL END " +
      "    AS class_features_json " +
      "FROM entry WHERE name IS NOT NULL"
    );
    // Pull tags in one shot.
    const tagRows = DB.query(
      "SELECT entry_id, tag FROM tag"
    );
    const tagsById = new Map();
    for (const r of tagRows) {
      if (!tagsById.has(r.entry_id)) tagsById.set(r.entry_id, new Set());
      tagsById.get(r.entry_id).add(r.tag);
    }
    // Build an abbreviation→full-name map so @source:DMG matches
    // entries whose source is "Dungeon Master's Guide" (and similar).
    // Without this, the user-natural query @source:DMG fails because
    // entry.source carries the full book name, not the abbreviation.
    const bookRows = DB.query("SELECT name, abbreviation FROM book");
    bookAbbrevMap = new Map();   // lowercase abbrev → lowercase full name
    for (const b of bookRows) {
      if (b.abbreviation) {
        bookAbbrevMap.set(
          b.abbreviation.toLowerCase(),
          (b.name || '').toLowerCase()
        );
      }
    }
    typeCounts.clear();
    entries = rows.map(r => {
      const nameKey = squash(r.name);
      const tags = tagsById.get(r.id) || new Set();
      typeCounts.set(r.type, (typeCounts.get(r.type) || 0) + 1);
      // Parse class_features for class / prc rows. Stores the
      // original feature names (preserved case + punctuation) so
      // rankEntry can return WHICH feature matched as attribution,
      // and folds each feature's name + description into bodyKey for
      // the tier-10 contains match. Defensive try/catch so a single
      // malformed entry can't blank the whole index.
      let featureNames = null;     // null when not class/prc
      let featureBody = '';
      if (r.class_features_json) {
        try {
          const arr = JSON.parse(r.class_features_json);
          if (Array.isArray(arr)) {
            featureNames = [];
            const bits = [];
            for (const f of arr) {
              if (!f || typeof f !== 'object') continue;
              if (f.name) {
                featureNames.push(String(f.name));
                bits.push(f.name);
              }
              // Fold BOTH the old curated summary (description) AND
              // the verbatim corpus excerpt (raw_text) into the
              // search body. raw_text is the higher-fidelity source
              // populated by the bounds-script sweeps; description
              // is the older synthesized version that still exists
              // on un-swept features. Including both maximizes match
              // surface without double-counting (rankEntry uses
              // contains-match, not term-frequency).
              if (f.description) bits.push(String(f.description));
              if (f.raw_text) bits.push(String(f.raw_text));
            }
            featureBody = bits.join(' ');
          }
        } catch (_) {
          // Bad JSON on a class — leave featureNames=null so
          // rank skips feature attribution for this entry.
        }
      }
      // bodyKey is a lower-case, punctuation-flattened version of the
      // entry's primary descriptive text. Used for tier-10 body-text
      // matches in rankEntry. Includes class-feature text for
      // class/prc entries so "Wild Shape" finds Druid.
      const bodyKey = squash(((r.body || '') + ' ' + featureBody).trim());
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        source: r.source,
        tags,
        nameKey,
        // searchKey lets a fuzzy fallback hit tag names and the type
        // label (so a user typing "evocation" still surfaces evocation
        // spells even if their names don't include the word).
        searchKey: nameKey + '·' +
          (TYPE_LABELS[r.type] || r.type).toLowerCase() + '·' +
          (r.source || '').toLowerCase() + '·' +
          [...tags].join('·'),
        bodyKey,
        featureNames,    // null OR list of preserved-case names
      };
    });
    console.log(`[lookup] indexed ${entries.length} entries across ` +
      `${typeCounts.size} types`);
    renderChips();
  }

  // Drop case, punctuation, and runs of whitespace so "Bull's Strength"
  // and "Bull-Headed" both reduce to a stable lowercase key.
  function squash(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/['']/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ---- Search ranking -----------------------------------------------------

  // Parse `feat:metamagic` / `spell:fireball` / `tag:combat-maneuver`
  // / `@source:DMG` prefixes out of the raw query. Returns
  // `{ q, types: Set<string>, tags: Set<string>, sources: Set<string> }`.
  function parseQuery(raw) {
    const out = {
      q: '',
      types: new Set(),
      tags: new Set(),
      sources: new Set(),
    };
    const parts = [];
    for (const token of String(raw || '').split(/\s+/)) {
      if (!token) continue;
      const m = token.match(/^(@?[a-z_]+):(.*)$/i);
      if (m) {
        const k = m[1].toLowerCase();
        const v = m[2];
        if (k === 'tag' && v)       out.tags.add(v.toLowerCase());
        else if ((k === '@source' || k === 'source') && v)
                                    out.sources.add(v.toLowerCase());
        else if (k === 'type' && v) out.types.add(v.toLowerCase());
        else if (k in TYPE_LABELS || k === 'prc' || k === 'class') {
          // `feat:` (no value) filters to feats; `feat:metamagic`
          // filters to feats AND pushes "metamagic" into the query.
          out.types.add(k);
          if (v) parts.push(v);
        }
        else parts.push(token);    // unknown prefix → treat as bare text
      } else {
        parts.push(token);
      }
    }
    out.q = squash(parts.join(' '));
    return out;
  }

  // Find the best-matching class feature for an entry, given the
  // raw query string. Returns the feature's preserved-case name when
  // found, else null. Used only for the visible result page to
  // annotate "(via Wild Shape)" on a Druid row when the user typed
  // "wild shape". Returns null for non-class entries (those have
  // featureNames === null) and when the query doesn't match any
  // feature name (e.g. the entry surfaced via name match, not body).
  //
  // Prefers: exact (case-insensitive) > startsWith > contains.
  function findMatchedFeature(entry, q) {
    if (!entry.featureNames || !entry.featureNames.length) return null;
    if (!q) return null;
    const ql = q.toLowerCase();
    // Don't bother annotating when the entry's NAME already contains
    // the query — the user already sees why it matched.
    if (entry.nameKey.includes(squash(q))) return null;
    let best = null;
    let bestRank = 0;
    for (const f of entry.featureNames) {
      const fl = f.toLowerCase();
      let rank = 0;
      if (fl === ql) rank = 3;
      else if (fl.startsWith(ql)) rank = 2;
      else if (fl.includes(ql)) rank = 1;
      if (rank > bestRank) { bestRank = rank; best = f; }
    }
    return best;
  }

  // Rank a single entry against the parsed query.
  // 0 = no match; higher = better.
  function score(entry, parsed) {
    // Hard filters first.
    if (parsed.types.size && !parsed.types.has(entry.type)) {
      // Also accept type:item matching item/weapon/armor/gear.
      if (!(parsed.types.has('item') &&
            ['item', 'weapon', 'armor', 'gear'].includes(entry.type))) {
        return 0;
      }
    }
    if (activeTypes.size && !activeTypes.has(entry.type)) {
      // Same item-bucket aggregation for chip filters.
      if (!(activeTypes.has('item') &&
            ['item', 'weapon', 'armor', 'gear'].includes(entry.type))) {
        return 0;
      }
    }
    if (parsed.tags.size) {
      // `tag:X` filter: accept entries that have an exact-matching
      // tag OR a tag containing the typed string. Permissive matching
      // is consistent with the bare-text partial-tag behavior — typing
      // `tag:fighter-bonu` should reach the same fighter-bonus-tagged
      // feats as `tag:fighter-bonus`. Same direction works in reverse
      // (a tag is a substring of the typed string) for cases where
      // the user types more than the canonical tag name.
      for (const t of parsed.tags) {
        let hit = false;
        if (entry.tags.has(t)) {
          hit = true;
        } else {
          for (const et of entry.tags) {
            if (et.includes(t) || t.includes(et)) { hit = true; break; }
          }
        }
        if (!hit) return 0;
      }
    }
    if (parsed.sources.size) {
      const src = (entry.source || '').toLowerCase();
      let ok = false;
      for (const s of parsed.sources) {
        // Direct substring match against the full source string handles
        // "@source:dungeon" / "@source:realms" / etc.
        if (src.includes(s)) { ok = true; break; }
        // Abbreviation match: @source:DMG should match entries whose
        // source is "Dungeon Master's Guide". The bookAbbrevMap is
        // {dmg: "dungeon master's guide", ...}. If `s` resolves to a
        // book name AND entry.source matches that name, it's a hit.
        const fullName = bookAbbrevMap.get(s);
        if (fullName && src === fullName) { ok = true; break; }
      }
      if (!ok) return 0;
    }
    // No remaining query text: any entry passing the filters scores 1.
    if (!parsed.q) return 1;

    const q = parsed.q;
    // Tiered scoring on the name:
    //   100 — exact match
    //    80 — prefix match
    //    65 — exact tag match (typing "metamagic" surfaces all
    //         entries tagged metamagic, even if the name doesn't
    //         contain the word). Placed between word-boundary
    //         (60) and prefix (80) — an entry tagged X is more
    //         relevant than a name-substring hit when the user is
    //         clearly searching for a tag.
    //    60 — word-boundary contains match in name
    //    50 — partial tag match (q is a prefix or substring of a
    //         tag name, e.g. "fighter" matching "fighter-bonus";
    //         or a tag's name contains q). Above name-contains so
    //         the dozens of fighter-bonus feats surface before
    //         random entries whose name happens to contain
    //         "fighter".
    //    40 — anywhere contains in name
    //    20 — searchKey contains (type/source fallback)
    //    10 — bodyKey contains (description/benefit/effect full-text)
    if (entry.nameKey === q) return 100;
    if (entry.nameKey.startsWith(q)) return 80;
    for (const tag of entry.tags) {
      if (tag === q) return 65;
    }
    // Word boundary: " " + q must appear, OR nameKey starts with q.
    if ((' ' + entry.nameKey).includes(' ' + q)) return 60;
    // Partial tag matches — tag-name prefix or substring of q.
    // Tag names use dashes ("fighter-bonus"); the bare q is alphanumeric
    // ("fighter"), so use raw includes both directions.
    for (const tag of entry.tags) {
      if (tag.startsWith(q + '-') || tag.includes(q) || q.includes(tag)) return 50;
    }
    if (entry.nameKey.includes(q)) return 40;
    if (entry.searchKey.includes(q)) return 20;
    // Body-text fallback — least specific. Skip for very short queries
    // (<3 chars) to avoid swamping results with noise.
    if (q.length >= 3 && entry.bodyKey && entry.bodyKey.includes(q)) return 10;
    return 0;
  }

  // ---- Chips --------------------------------------------------------------

  function renderChips() {
    if (!chipsEl) return;
    chipsEl.innerHTML = '';
    // Primary chips: PRIMARY_TYPES, with item aggregated.
    for (const t of PRIMARY_TYPES) {
      const count = countForChip(t);
      if (!count) continue;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'lookup-chip' + (activeTypes.has(t) ? ' active' : '');
      chip.dataset.type = t;
      chip.textContent = `${TYPE_LABELS[t] || t} (${count})`;
      chip.addEventListener('click', () => toggleChip(t));
      chipsEl.appendChild(chip);
    }
    // "Clear" chip when filters are active.
    if (activeTypes.size) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'lookup-chip lookup-chip-clear';
      clear.textContent = 'Clear';
      clear.addEventListener('click', () => {
        activeTypes.clear();
        renderChips();
        render(inputEl.value.trim());
      });
      chipsEl.appendChild(clear);
    }
  }

  function countForChip(t) {
    if (t === 'item') {
      return (typeCounts.get('item') || 0) +
             (typeCounts.get('weapon') || 0) +
             (typeCounts.get('armor') || 0) +
             (typeCounts.get('gear') || 0);
    }
    return typeCounts.get(t) || 0;
  }

  function toggleChip(t) {
    if (activeTypes.has(t)) activeTypes.delete(t);
    else activeTypes.add(t);
    renderChips();
    render(inputEl.value.trim());
  }

  // ---- Recent searches ----------------------------------------------------

  // Persistent list of queries the user actually opened something from.
  // We deliberately only record on "expand" — not every keystroke —
  // so the recent list stays signal-rich.
  const RECENT_KEY = 'dnd35-lookup-recent';
  const RECENT_MAX = 8;

  function loadRecent() {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(s => typeof s === 'string') : [];
    } catch (e) { return []; }
  }

  function saveRecent(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); }
    catch (e) { /* private mode etc. — silently ignore */ }
  }

  function recordRecent(q) {
    q = (q || '').trim();
    if (!q) return;
    const list = loadRecent();
    // De-dupe (case-insensitive) and bring to front.
    const filtered = list.filter(s => s.toLowerCase() !== q.toLowerCase());
    filtered.unshift(q);
    saveRecent(filtered.slice(0, RECENT_MAX));
  }

  function clearRecent() {
    saveRecent([]);
  }

  // ---- Render -------------------------------------------------------------

  const MAX_RESULTS = 200;  // Cap rendered rows to keep the DOM lean.

  function renderEmptyState() {
    const recent = loadRecent();

    // Type breakdown: every type that has at least one entry, sorted by
    // count descending. We pull from typeCounts (populated at buildIndex
    // time, also used by the chip strip).
    const types = Array.from(typeCounts.entries())
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);

    const recentHtml = recent.length
      ? `<div class="lookup-empty-section">` +
        `<div class="lookup-empty-head">` +
        `<span>Recent searches</span>` +
        `<button type="button" class="lookup-empty-clear" ` +
        `data-action="clear-recent">Clear</button>` +
        `</div>` +
        `<div class="lookup-empty-recent">` +
        recent.map(q =>
          `<button type="button" class="lookup-recent-chip" ` +
          `data-recent="${escapeHtml(q)}">${escapeHtml(q)}</button>`
        ).join('') +
        `</div></div>`
      : '';

    const browseHtml =
      `<div class="lookup-empty-section">` +
      `<div class="lookup-empty-head">` +
      `<span>Browse by type</span>` +
      `<span class="lookup-empty-total">${entries.length} entries</span>` +
      `</div>` +
      `<div class="lookup-empty-grid">` +
      types.map(([t, n]) =>
        `<button type="button" class="lookup-type-tile" ` +
        `data-type="${escapeHtml(t)}">` +
        `<span class="lookup-type-tile-name">` +
        `${escapeHtml(TYPE_LABELS[t] || t)}</span>` +
        `<span class="lookup-type-tile-count">${n}</span>` +
        `</button>`
      ).join('') +
      `</div></div>`;

    resultsEl.innerHTML =
      `<div class="lookup-empty-state">${recentHtml}${browseHtml}</div>`;
  }

  // Delegate clicks inside the empty-state to: recent chip → re-fill
  // the input; type tile → activate that filter; clear button → wipe
  // recent searches. We attach once during ensureModal().
  function wireEmptyStateClicks() {
    if (!resultsEl || resultsEl.dataset.emptyWired) return;
    resultsEl.dataset.emptyWired = '1';
    resultsEl.addEventListener('click', (ev) => {
      const t = ev.target instanceof Element ? ev.target : null;
      if (!t) return;
      const recentChip = t.closest('[data-recent]');
      if (recentChip) {
        ev.preventDefault();
        inputEl.value = recentChip.getAttribute('data-recent') || '';
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.focus();
        return;
      }
      const typeTile = t.closest('[data-type]');
      if (typeTile && typeTile.classList.contains('lookup-type-tile')) {
        ev.preventDefault();
        const type = typeTile.getAttribute('data-type');
        activeTypes.clear();
        activeTypes.add(type);
        renderChips();
        render(inputEl.value.trim());
        inputEl.focus();
        return;
      }
      if (t.closest('[data-action="clear-recent"]')) {
        ev.preventDefault();
        clearRecent();
        render(inputEl.value.trim());
        return;
      }
    });
    // Capture-phase handler so it runs BEFORE the row's bubble-phase
    // click handler — otherwise expanding-then-collapsing the parent
    // row would eat the expand interaction.
    resultsEl.addEventListener('click', (ev) => {
      const t = ev.target instanceof Element ? ev.target : null;
      if (!t) return;
      const expand = t.closest('[data-action="expand-table"]');
      if (!expand) return;
      ev.preventDefault();
      ev.stopPropagation();
      const tbl = expand.previousElementSibling;
      if (tbl && tbl.tagName === 'TABLE') {
        tbl.classList.add('lookup-expanded');
      }
      expand.remove();
    }, true);
    resultsEl.addEventListener('keydown', (ev) => {
      const t = ev.target instanceof Element ? ev.target : null;
      if (!t) return;
      if ((ev.key === 'Enter' || ev.key === ' ') &&
          t.matches('[data-action="expand-table"]')) {
        ev.preventDefault();
        t.click();
      }
    });
  }

  function render(query) {
    if (!resultsEl) return;
    if (!DB.isLoaded()) {
      resultsEl.innerHTML =
        '<div class="lookup-empty">Database still loading…</div>';
      setCount('');
      lastResults = [];
      return;
    }
    if (!entries.length) buildIndex();

    const parsed = parseQuery(query);
    // Empty state: no query and no filters → show type breakdown + recent
    // searches. Both are clickable: a type chip narrows by type, a recent
    // chip re-fills the input.
    if (!parsed.q && !activeTypes.size && !parsed.types.size &&
        !parsed.tags.size && !parsed.sources.size) {
      renderEmptyState();
      setCount('');
      lastResults = [];
      return;
    }

    // Score + sort. Skip entries whose source is filtered out by the
    // global BookFilter (errata indicators are still surfaced inline
    // on rows that pass; see ErrataBadge wiring below).
    const scored = [];
    for (const e of entries) {
      // `e` carries .type / .name / .version / .source from the index
      // build query — allowsEntry uses all four to support both the
      // 'all' and 'counterpart' hide-3.0 modes.
      if (window.BookFilter && !window.BookFilter.allowsEntry(e)) continue;
      const s = score(e, parsed);
      if (s > 0) scored.push({ entry: e, score: s });
    }
    scored.sort((a, b) =>
      b.score - a.score ||
      a.entry.name.localeCompare(b.entry.name)
    );
    lastResults = scored.slice(0, MAX_RESULTS).map(x => x.entry);

    resultsEl.innerHTML = '';
    if (!lastResults.length) {
      resultsEl.innerHTML =
        '<div class="lookup-empty">No matches.</div>';
      setCount('0');
      return;
    }
    for (let i = 0; i < lastResults.length; i++) {
      const e = lastResults[i];
      const row = document.createElement('div');
      row.className = 'lookup-row' + (i === selectedIdx ? ' selected' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === selectedIdx ? 'true' : 'false');
      row.dataset.entryId = e.id;
      row.dataset.entryType = e.type;
      // Class-feature match attribution: when a class/prc surfaces
      // because the query matched a feature name (e.g. "Wild Shape" →
      // Druid), surface WHICH feature so the user understands why
      // the parent class is in the result list. Runs only for the
      // visible page of results so it stays cheap (string includes
      // over a 20-element list per row, ~max 20 rows).
      const featNote = findMatchedFeature(e, parsed.q);
      const featNoteHtml = featNote
        ? ` <span class="lookup-row-via" title="Matched via class feature">` +
          `(via ${escapeHtml(featNote)})</span>`
        : '';
      row.innerHTML =
        `<span class="lookup-row-type">${escapeHtml(TYPE_LABELS[e.type] || e.type)}</span>` +
        `<span class="lookup-row-name">${escapeHtml(e.name)}${featNoteHtml}</span>` +
        `<span class="lookup-row-meta">${escapeHtml(e.source || '')}` +
        (window.VersionBadge ? VersionBadge.html(e.version) : '') +
        `</span>`;
      // Subtle ✦ marker if this entry has applied errata. We use the
      // indicator (non-clickable) here because the whole row is
      // clickable — the popover lives in the expanded detail panel.
      if (window.ErrataBadge) {
        const ind = ErrataBadge.indicator(e.id);
        if (ind) {
          row.querySelector('.lookup-row-name').appendChild(
            document.createTextNode(' ')
          );
          row.querySelector('.lookup-row-name').appendChild(ind);
        }
      }
      row.addEventListener('click', () => {
        selectedIdx = i;
        paintSelection();
        expandSelected();
      });
      resultsEl.appendChild(row);
    }
    const total = scored.length;
    setCount(
      total > MAX_RESULTS
        ? `showing ${MAX_RESULTS} of ${total}`
        : `${total} match${total === 1 ? '' : 'es'}`
    );
    // Ensure selection is valid.
    if (selectedIdx >= lastResults.length) selectedIdx = 0;
    paintSelection();
  }

  function setCount(text) {
    const el = document.getElementById('lookup-count');
    if (el) el.textContent = text;
  }

  // ---- Global hotkey ------------------------------------------------------

  function wireHotkey() {
    document.addEventListener('keydown', (ev) => {
      // Ctrl+K (Linux/Win) or Cmd+K (Mac). Skip if a modifier-K is
      // happening inside an editable field for some app-specific
      // shortcut (Slack-style); for us the hotkey wins.
      const isK = ev.key === 'k' || ev.key === 'K';
      if (!isK) return;
      if (!(ev.ctrlKey || ev.metaKey)) return;
      // Don't grab Ctrl+K inside contenteditable specifically, but
      // textarea / input is fine — that's where you'd most want it.
      ev.preventDefault();
      toggle();
    });
  }

  // ---- Bootstrap ----------------------------------------------------------

  function init() {
    ensureTriggerButton();
    wireHotkey();
    // Pre-create the modal so it's ready to open instantly. (Skips
    // first-open jank.)
    ensureModal();
    // When the book filter changes, recompute the per-type counts off
    // the cached index (without re-querying the DB) and refresh the
    // chip strip + currently-rendered results.
    document.addEventListener('book-filter-changed', () => {
      typeCounts.clear();
      for (const e of entries) {
        if (window.BookFilter && !window.BookFilter.allowsEntry(e)) continue;
        typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
      }
      renderChips();
      if (modalEl && modalEl.style.display !== 'none' && inputEl) {
        render(inputEl.value.trim());
      }
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Escape for use inside a CSS attribute selector value (between
  // the quotes in `[attr="..."]`). Backslash-escape the actual
  // special chars; this is narrower than CSS.escape() because we
  // only need attribute-value safety, not selector-token safety.
  function cssAttrEscape(s) {
    return String(s).replace(/(["\\])/g, '\\$1');
  }

  // Set the search query and re-render. Used by see_also cross-links
  // in rule detail panels — clicking a related-entry link opens the
  // modal (if not already open) and jumps the search to that name.
  function search(query) {
    open();
    if (inputEl) {
      inputEl.value = String(query || '');
      selectedIdx = 0;
      render(inputEl.value.trim());
    }
  }

  // Delegated click handler for see_also cross-links inside the
  // rule detail panel. Each link carries data-lookup-search="<name>";
  // clicking re-runs the search with that as the query.
  document.addEventListener('click', ev => {
    const link = ev.target.closest?.('[data-lookup-search]');
    if (!link) return;
    ev.preventDefault();
    search(link.getAttribute('data-lookup-search'));
  });

  // Render a single see-also pill (clickable button). Used by
  // renderRuleExtra and renderFeatExtra and exposed below for per-
  // picker info panels that want the same UX.
  function renderSeeAlsoPill(name) {
    return `<button type="button" class="lookup-see-also-pill" ` +
      `data-see-also-name="${escapeHtml(String(name))}" ` +
      `aria-expanded="false">` +
      `<span class="lookup-see-also-caret">▸</span> ` +
      `${escapeHtml(String(name))}</button>`;
  }

  // Render a complete see-also row: label + space-separated pills +
  // empty expansion container. Use as a one-liner from any picker
  // info panel that wants pill behavior. The wrapping div carries
  // .lookup-rule-see-also so the existing click handler's
  // closest('.lookup-rule-see-also').querySelector(
  // '.lookup-see-also-expansions') chain works.
  function renderSeeAlsoRow(label, names) {
    if (!Array.isArray(names) || !names.length) return '';
    const pills = names.map(renderSeeAlsoPill).join(' ');
    return `<div class="lookup-rule-see-also">` +
      `<b>${escapeHtml(label)}:</b> ${pills}` +
      `<div class="lookup-see-also-expansions"></div>` +
      `</div>`;
  }

  // Query DB for entries that share a group value (e.g. all maneuvers
  // of the same discipline, all mysteries of the same path) and
  // render them as a see-also pill row. Excludes the current entry
  // and caps at `limit` entries to keep the panel scannable.
  //
  // For chain-picker types (maneuver / power / mystery / invocation)
  // where a category field (discipline / path / grade) groups related
  // entries — clicking any sibling pill expands its detail inline.
  function renderSiblingsRow(label, type, groupField, groupValue,
                              currentName, limit) {
    if (!groupValue || !DB.isLoaded()) return '';
    const cap = limit || 30;
    const rows = DB.query(
      "SELECT name FROM entry " +
      "WHERE type = ? " +
      "  AND json_extract(data, '$.' || ?) = ? " +
      "  AND name != ? " +
      "ORDER BY name LIMIT ?",
      [type, groupField, String(groupValue), currentName || '', cap]
    );
    if (!rows || !rows.length) return '';
    const names = Array.from(new Set(rows.map(r => r.name)));
    return renderSeeAlsoRow(label, names);
  }

  // Wire the pill-click handler onto an arbitrary container element
  // (e.g. a picker's info panel root). Idempotent — adds at most one
  // listener per element via a dataset flag. After this call, any
  // [data-see-also-name] pill inside the container will toggle its
  // own inline-expanded view in the nearest .lookup-see-also-expansions
  // sibling. This is exactly the modal's behavior, just bound to a
  // different container so picker panels reuse it.
  function wireSeeAlsoPills(containerEl) {
    if (!containerEl || containerEl.dataset.seeAlsoWired === '1') return;
    containerEl.dataset.seeAlsoWired = '1';
    containerEl.addEventListener('click', (ev) => {
      const tgt = ev.target instanceof Element ? ev.target : null;
      const pill = tgt?.closest('[data-see-also-name]');
      if (!pill) return;
      ev.preventDefault();
      ev.stopPropagation();
      const name = pill.getAttribute('data-see-also-name');
      const expansions = pill
        .closest('.lookup-rule-see-also')
        ?.querySelector('.lookup-see-also-expansions');
      if (!expansions) return;
      const existing = expansions.querySelector(
        `[data-nested-name="${cssAttrEscape(name)}"]`
      );
      if (existing) {
        existing.remove();
        pill.setAttribute('aria-expanded', 'false');
        const caret = pill.querySelector('.lookup-see-also-caret');
        if (caret) caret.textContent = '▸';
      } else {
        expansions.insertAdjacentHTML(
          'beforeend', renderNestedExpansion(name)
        );
        pill.setAttribute('aria-expanded', 'true');
        const caret = pill.querySelector('.lookup-see-also-caret');
        if (caret) caret.textContent = '▾';
      }
    });
  }

  // Expose minimal API for per-picker integration (Phase 4 errata
  // badge + deep-linking + rich see-also rendering).
  //
  // search() added 2026-05-24 for rule see_also cross-link rendering.
  // The renderSeeAlso* / wireSeeAlsoPills / renderPrereqWithPills /
  // findFeatsRequiring helpers (also 2026-05-24) let picker info
  // panels reuse the same UX without duplicating code — feat-picker,
  // class-picker, spell-picker etc. can render see-also pill rows
  // and the panel-level wirePills call delegates the click to the
  // existing nested-expansion logic.
  window.Lookup = {
    open, close, toggle, search,
    renderSeeAlsoPill,
    renderSeeAlsoRow,
    renderSiblingsRow,
    renderPrereqWithPills,
    renderRequirementsWithPills,
    findFeatsRequiring,
    wireSeeAlsoPills,
    renderNestedExpansion,
  };

  // Init when the DOM is ready and the DB module exists. We don't
  // need DB.ready to fire — the modal shell works without data; the
  // search just shows "loading" until DB.ready resolves.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
