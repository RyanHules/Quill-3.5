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
    organization: 'Organization', poison: 'Poison',
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
    wrap.addEventListener('click', (ev) => ev.stopPropagation());
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
      bits.push(`<div class="lookup-detail-desc">${escapeHtml(d.description)}</div>`);
    }
    bits.push(renderTypeSpecific(d, type));
    bits.push(renderTags(d));
    return bits.filter(Boolean).join('');
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
      ['Prereq',     ['prerequisites']],
    ],
    item: [
      ['Type',       ['item_type', 'type']],
      ['Slot',       ['body_slot']],
      ['Aura',       ['aura']],
      ['CL',         ['caster_level']],
      ['Price',      ['price']],
      ['Weight',     ['weight']],
      ['Prereq',     ['prerequisites']],
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

  function renderFeatExtra(d) {
    const lines = [];
    if (d.benefit) lines.push(`<b>Benefit:</b> ${escapeHtml(d.benefit)}`);
    if (d.normal)  lines.push(`<b>Normal:</b> ${escapeHtml(d.normal)}`);
    if (d.special) lines.push(`<b>Special:</b> ${escapeHtml(d.special)}`);
    return lines.length
      ? `<div class="lookup-detail-extra">${lines.join('<br>')}</div>` : '';
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
    if (d.weapon_armor_proficiency)
      lines.push(`<b>Proficiencies:</b> ${escapeHtml(d.weapon_armor_proficiency)}`);
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
      const feats = d.class_features.map(f => {
        const lvl = f.level_acquired != null
          ? `L${f.level_acquired} ` : '';
        const desc = f.description
          ? `: ${escapeHtml(truncate(f.description, 140))}` : '';
        return `<div style="margin-left:0.5rem">` +
               `<b>${escapeHtml(lvl + (f.name || ''))}</b>${desc}</div>`;
      }).join('');
      lines.push(`<b>Class features:</b>${feats}`);
    }
    // Class table — first few rows, with a "20 levels total" note.
    if (Array.isArray(d.class_table) && d.class_table.length) {
      const rows = d.class_table.slice(0, 5);
      const head = `<tr><th>L</th><th>BAB</th><th>Fort</th><th>Ref</th><th>Will</th><th>Special</th></tr>`;
      const body = rows.map(r => {
        const special = truncate(r.special || '—', 80);
        return `<tr><td>${escapeHtml(String(r.level))}</td>` +
               `<td>${escapeHtml(String(r.bab || ''))}</td>` +
               `<td>${escapeHtml(String(r.fort || ''))}</td>` +
               `<td>${escapeHtml(String(r.ref || ''))}</td>` +
               `<td>${escapeHtml(String(r.will || ''))}</td>` +
               `<td>${escapeHtml(special)}</td></tr>`;
      }).join('');
      const more = d.class_table.length > rows.length
        ? `<div style="opacity:0.6;font-size:0.85em">… ${d.class_table.length - rows.length} more level${d.class_table.length - rows.length === 1 ? '' : 's'}.</div>`
        : '';
      lines.push(`<b>Class table:</b>` +
        `<table class="lookup-class-table">${head}${body}</table>${more}`);
    }
    return lines.length
      ? `<div class="lookup-detail-extra">${lines.join('<br>')}</div>` : '';
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

  // Rules: render tables when present. Tables come in two shapes from
  // extraction: structured `{headers, rows}` or freeform text. We
  // handle both.
  function renderRuleExtra(d) {
    if (!Array.isArray(d.tables) || !d.tables.length) return '';
    const blocks = d.tables.map(t => {
      const cap = t.caption || t.title || '';
      if (Array.isArray(t.rows) && Array.isArray(t.headers)) {
        const head = `<tr>${t.headers.map(h =>
          `<th>${escapeHtml(String(h))}</th>`).join('')}</tr>`;
        const body = t.rows.map(row => {
          if (Array.isArray(row)) {
            return `<tr>${row.map(c => `<td>${escapeHtml(String(c))}</td>`).join('')}</tr>`;
          }
          if (typeof row === 'object') {
            return `<tr>${t.headers.map(h =>
              `<td>${escapeHtml(String(row[h] ?? ''))}</td>`).join('')}</tr>`;
          }
          return '';
        }).join('');
        return (cap ? `<div style="margin-top:0.4rem"><b>${escapeHtml(cap)}</b></div>` : '') +
          `<table class="lookup-rule-table">${head}${body}</table>`;
      }
      // Freeform: just show whatever string representation we have.
      const text = typeof t === 'string' ? t : (t.text || JSON.stringify(t));
      return (cap ? `<div style="margin-top:0.4rem"><b>${escapeHtml(cap)}</b></div>` : '') +
        `<pre style="white-space:pre-wrap;font-size:0.85em;margin:0.2rem 0">${escapeHtml(text)}</pre>`;
    });
    return `<div class="lookup-detail-extra">${blocks.join('')}</div>`;
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
    const rows = DB.query(
      "SELECT id, name, type, source, " +
      "  COALESCE(" +
      "    json_extract(data, '$.description'), " +
      "    json_extract(data, '$.benefit'), " +
      "    json_extract(data, '$.effect'), " +
      "    json_extract(data, '$.granted_power'), " +
      "    json_extract(data, '$.text'), " +
      "    ''" +
      "  ) AS body " +
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
      // bodyKey is a lower-case, punctuation-flattened version of the
      // entry's primary descriptive text. Used for tier-10 body-text
      // matches in rankEntry.
      const bodyKey = squash(r.body || '');
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
      row.innerHTML =
        `<span class="lookup-row-type">${escapeHtml(TYPE_LABELS[e.type] || e.type)}</span>` +
        `<span class="lookup-row-name">${escapeHtml(e.name)}</span>` +
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

  // Expose minimal API for the future per-picker integration (Phase 4
  // errata badge + maybe deep-linking from a picker into the modal).
  window.Lookup = { open, close, toggle };

  // Init when the DOM is ready and the DB module exists. We don't
  // need DB.ready to fire — the modal shell works without data; the
  // search just shows "loading" until DB.ready resolves.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
