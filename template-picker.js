// template-picker.js — Apply / remove template stacks (Half-Dragon,
// Vampire, Lich, Fiendish, Celestial, etc.) on top of the base race.
//
// Templates are additive layers: ability mods stack into the new
// ability-table Template column; natural armor adds to #ac-natural;
// LA is reflected in the info panel only (the "Total Level (+LA)"
// field is user-managed); creature type may override #char-type;
// per-template traits populate Special Abilities tagged with
// data-from-template="<TemplateName>" so removing a template only
// strips that template's contributions.
//
// UI injected into the basic-info section (after #race-info):
//   #template-lookup           (input)        — autocomplete
//   #template-lookup-apply     (button)       — apply
//   #template-info             (div)          — info preview panel
//   #template-applied-list     (div)          — chips for applied templates
//   <datalist id="template-options">          — autocomplete options
//
// Persistence: monkey-patches Character.collectData / loadData,
// appending `_templates: [{name, templateId, version, abilityMods,
// naturalArmor, creatureTypeBefore}]` so removal can correctly
// reverse the contributions on load.

(function () {
  if (!window.DB) {
    console.warn('[template-picker] DB module not loaded');
    return;
  }

  let templateIndex = new Map(); // lower(name) → row
  let appliedTemplates = [];     // [{ name, templateId, version, ...reversal info }]
  // The character's creature type BEFORE any template was applied (e.g. the
  // race's "Humanoid"). Captured when the first template lands; restored when
  // the last is removed. Creature type can't be reversed by delta the way
  // ability mods can (it's a string, not additive), so instead of snapshotting
  // a per-template "type before me" — which restores a STALE value when a lower
  // template is removed from a stack — we recompute the live type from the
  // remaining stack (recomputeCreatureType): the most-recently-applied template
  // that specifies a type change wins, else this base. Null when no template
  // is applied. Persisted as `_templateBaseType`.
  let baseCreatureType = null;

  const ABILITY_KEYS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

  function init() {
    const raceInput = document.getElementById('char-race');
    if (!raceInput) {
      console.warn('[template-picker] #char-race not found');
      return;
    }

    // Index templates (3.5 preferred over 3.0 if collisions exist;
    // ties broken by newest publication date).
    function rebuildIndex() {
      const rows = DB.query(
        "SELECT e.id AS template_id, e.name, e.source, e.version, "
        + "json_extract(e.data, '$.template_type')      AS template_type, "
        + "json_extract(e.data, '$.level_adjustment')   AS level_adjustment, "
        + "COALESCE(json_extract(e.data, '$.new_creature_type'), "
        + "         json_extract(e.data, '$.type_change')) AS new_creature_type, "
        + "json_extract(e.data, '$.description')        AS description "
        + "FROM entry e "
        + "LEFT JOIN book b ON b.name = e.source "
        + "WHERE e.type = 'template' "
        + "ORDER BY e.name COLLATE NOCASE, "
        + "         CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, "
        + "         b.publication_date DESC"
      );
      templateIndex = new Map();
      for (const r of rows) {
        if (window.BookFilter && !window.BookFilter.allowsEntry({...r, type: 'template'})) continue;
        const key = (r.name || '').toLowerCase();
        if (!templateIndex.has(key)) templateIndex.set(key, r);
      }
    }
    rebuildIndex();

    buildUI(raceInput);
    installPersistenceHooks();
    renderAppliedList();

    document.addEventListener('book-filter-changed', () => {
      rebuildIndex();
      const dl = document.getElementById('template-options');
      if (!dl) return;
      dl.innerHTML = '';
      for (const [, r] of templateIndex) {
        const opt = document.createElement('option');
        opt.value = r.name;
        dl.appendChild(opt);
      }
    });
  }

  function buildUI(raceInput) {
    // Inject AFTER the info-grid (the grandparent of the race input)
    // so the template-picker spans the full section width on its own
    // row, not squeezed into a flex cell of the info-grid.
    const infoGrid = raceInput.closest('.info-grid');
    const section = infoGrid?.parentElement || raceInput.closest('.section');
    // Preferred home: the consolidated "Lookups & Pickers" disclosure
    // (#template-lookup-host). Falls back to the old after-the-info-grid
    // placement if that host isn't present.
    const host = document.getElementById('template-lookup-host');
    if (!host && !section) return;

    const wrap = document.createElement('div');
    wrap.id = 'template-picker';
    // Template lookup is rarely needed once a campaign starts — collapse
    // by default. User can expand via the summary chevron.
    wrap.innerHTML = `
      <details class="picker-section">
        <summary>Template Lookup</summary>
        <div>
          <div class="field" style="flex:2 1 14rem; min-width:12rem">
            <label>Template Lookup</label>
            <input type="text" id="template-lookup" list="template-options"
                   placeholder="e.g. Half-Dragon, Vampire, Lich" autocomplete="off">
            <datalist id="template-options"></datalist>
          </div>
          <button type="button" id="template-lookup-apply" class="btn-add btn-add-inline">+ Apply Template</button>
        </div>
        <div id="template-info" class="race-info" style="display:none; border-left-color:#aa6a6a"></div>
        <div id="template-applied-list"></div>
      </details>
    `;
    if (host) {
      host.appendChild(wrap);
    } else if (infoGrid && infoGrid.nextSibling) {
      // Legacy placement: first child after the info-grid.
      section.insertBefore(wrap, infoGrid.nextSibling);
    } else {
      section.appendChild(wrap);
    }

    // Populate datalist
    const dl = document.getElementById('template-options');
    for (const [, r] of templateIndex) {
      const opt = document.createElement('option');
      opt.value = r.name;
      dl.appendChild(opt);
    }

    const tInput = document.getElementById('template-lookup');
    const apply  = document.getElementById('template-lookup-apply');
    const info   = document.getElementById('template-info');

    const refresh = () => updatePreview(info, tInput.value);
    tInput.addEventListener('input', refresh);
    tInput.addEventListener('change', refresh);
    apply.addEventListener('click', () => applyTemplate(tInput.value, info));
  }

  function lookupTemplate(typedName) {
    if (!typedName) return null;
    return templateIndex.get(typedName.trim().toLowerCase()) || null;
  }

  // Re-derive a template's cleaned type change from the DB by name — used to
  // migrate old saves that stored per-template `creatureTypeBefore` but no
  // `typeChange`. Returns null when the template can't be resolved (DB not
  // loaded yet, book-filtered out, renamed entry) — the template then simply
  // doesn't drive a type recompute, which is the safe degradation.
  function deriveTypeChangeForName(name) {
    const idx = lookupTemplate(name);
    if (!idx) return null;
    const detail = templateDetail(idx.template_id);
    return (detail && detail.tpl && detail.tpl.new_creature_type_clean) || null;
  }

  function templateDetail(templateId) {
    // No sub-tables any more — everything lives in entry.data JSON.
    const row = DB.queryOne(
      "SELECT id AS template_id, name, source, version, data "
      + "FROM entry WHERE id = ?", [templateId]
    );
    if (!row) return null;
    let parsed = {};
    try { parsed = JSON.parse(row.data || '{}'); }
    catch (e) { console.warn('[template-picker] bad data JSON', e); }

    // `type_change` text is verbose ("Augmented (dragon) base creature",
    // "Undead (template added to evil dragon)", etc.). We keep the raw
    // text for the info panel but expose a cleaned-up version
    // (`new_creature_type_clean`) for stamping into `#char-type`.
    const rawType = parsed.new_creature_type || parsed.type_change || null;
    const tpl = {
      template_id: row.template_id,
      name: row.name,
      source: row.source,
      version: row.version,
      template_type: parsed.template_type || null,
      level_adjustment: parsed.level_adjustment || null,
      new_creature_type: rawType,
      new_creature_type_clean: cleanCreatureType(rawType),
      // Pull natural-armor bonus out of either a structured bonuses row
      // OR the free-form armor_class text ("Natural armor +N", "+N natural").
      natural_armor_bonus: deriveNaturalArmor(parsed),
      description: parsed.description || null,
    };

    // ability_changes: dict like {Str: "+4", Cha: "+2"} → list of
    // {ability, modifier:int} rows for the existing apply loop.
    const mods = [];
    if (parsed.ability_changes && typeof parsed.ability_changes === 'object'
        && !Array.isArray(parsed.ability_changes)) {
      for (const [ab, raw] of Object.entries(parsed.ability_changes)) {
        const n = parseInt(String(raw).replace(/^\+/, ''), 10);
        if (!Number.isFinite(n) || n === 0) continue;
        mods.push({ ability: ab, modifier: n });
      }
    }

    // Traits: union of special_qualities_added + special_attacks_added.
    // Each item may be a string ("Name: description") or {name, description}.
    const traits = [];
    const seen = new Set();
    const push = (raw) => {
      if (typeof raw === 'string') {
        const idx = raw.indexOf(': ');
        const name = idx > 0 ? raw.slice(0, idx) : raw;
        const description = idx > 0 ? raw.slice(idx + 2) : '';
        const key = name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        traits.push({ name, description });
      } else if (raw && typeof raw === 'object') {
        const name = raw.name || '';
        if (!name) return;
        const key = name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        traits.push({ name, description: raw.description || '' });
      }
    };
    if (Array.isArray(parsed.special_qualities_added)) {
      parsed.special_qualities_added.forEach(push);
    }
    if (Array.isArray(parsed.special_attacks_added)) {
      parsed.special_attacks_added.forEach(push);
    }

    // Movement: best-effort parse of `speed_change` string for fly/swim
    // modes. Picker only uses {mode, speed_ft, maneuverability}.
    const movement = parseSpeedChange(parsed.speed_change);

    // Energy resistance: legacy dict shape `{cold: 10, fire: 10}` OR
    // structured bonuses rows with bonus_type='energy_resistance'.
    const resistance = [];
    if (parsed.energy_resistance &&
        typeof parsed.energy_resistance === 'object' &&
        !Array.isArray(parsed.energy_resistance)) {
      for (const [k, v] of Object.entries(parsed.energy_resistance)) {
        resistance.push({ damage_type: k, amount: v });
      }
    }
    if (Array.isArray(parsed.bonuses)) {
      for (const b of parsed.bonuses) {
        if (b?.bonus_type === 'energy_resistance' && b.target) {
          resistance.push({ damage_type: b.target, amount: b.amount });
        }
      }
    }
    return { tpl, mods, traits, movement, resistance };
  }

  // Pull a numeric natural-armor bonus out of either the bonuses list or
  // the `armor_class` free-form description ("+4 natural armor",
  // "Natural armor as base creature, +2"). Returns 0 if none found.
  function deriveNaturalArmor(parsed) {
    if (Array.isArray(parsed.bonuses)) {
      for (const b of parsed.bonuses) {
        if (b?.bonus_type === 'natural_armor' &&
            typeof b.amount === 'number') {
          return b.amount;
        }
      }
    }
    const ac = parsed.armor_class;
    if (typeof ac === 'string') {
      const m = ac.match(/(?:^|\+|\b)(\d+)\s*natural\s*armor/i);
      if (m) return parseInt(m[1], 10);
      const m2 = ac.match(/natural\s*armor\s*(?:[+:]\s*)?(\d+)/i);
      if (m2) return parseInt(m2[1], 10);
    }
    return 0;
  }

  // Parse a speed-change string like "Fly 30 ft (perfect)" into one or
  // Reduce the verbose SRD `type_change` text down to something
  // suitable for the `#char-type` field. Returns null when the text
  // is a placeholder ("Template") or prose that doesn't describe a
  // clean type change. Patterns covered:
  //   "Augmented (X) base creature"       → "Augmented (X)"  (cap subtype)
  //   "X (template added to Y)"           → "X"
  //   "X (... type changes to Y)"         → "X"
  //   "X (Augmented)"                     → "X (Augmented)"
  //   "Type changes to X..."              → "X"
  //   "X - augmented"                     → "X"
  //   "Template" / "Retains creature type"→ null
  function cleanCreatureType(typeChange) {
    if (!typeChange || typeof typeChange !== 'string') return null;
    const s = typeChange.trim();
    if (!s) return null;

    if (/^template$/i.test(s)) return null;
    if (/^retains creature type/i.test(s)) return null;

    // "Augmented (X) base creature"  — title-case the subtype list.
    let m = s.match(/^Augmented\s*\(([^)]+)\)\s*base creature\.?$/i);
    if (m) return `Augmented (${titleCaseSubtype(m[1])})`;

    // "X (template added to ...)" or "X (type changes to ...)".
    m = s.match(
      /^([A-Z][A-Za-z][A-Za-z ]*?)\s*\((?:template added to|type changes to)\b/i);
    if (m) return m[1].trim();

    // "X - augmented" — return X (already includes subtype).
    m = s.match(/^(.+?)\s*-\s*augmented\.?$/i);
    if (m) return m[1].trim();

    // "Type changes to X." — X greedy up to the first period (so
    // parenthetical subtypes like "(native subtype)" are preserved).
    m = s.match(/^Type changes to\s+([^.]+)/i);
    if (m) return titleCaseHead(m[1].trim());

    // "X (Augmented)" — pass through.
    if (/^[A-Z]\w+(?:\s+\w+)*\s*\(Augmented\)\.?$/i.test(s)) {
      return s.replace(/\.?$/, '');
    }

    // Fallback: pass through (don't lose info).
    return s;
  }

  // Title-case the subtype slug inside `Augmented (...)`. Slashes and
  // commas are kept as separators; everything else gets the first
  // letter of each word capitalized.
  function titleCaseSubtype(s) {
    return s.split(/([,/])/)
      .map(part => /^[,/]$/.test(part)
        ? part
        : part.replace(/\b[a-z]/g, c => c.toUpperCase()))
      .join('');
  }

  // Capitalize the first letter of the leading type word, leave any
  // parenthetical subtype contents unchanged (the SRD uses lower-case
  // there sometimes; preserving as-is keeps the source data honest).
  function titleCaseHead(s) {
    return s.replace(/^([a-z])/, c => c.toUpperCase());
  }

  function parseSpeedChange(s) {
    if (typeof s !== 'string') return [];
    const out = [];
    const rx = /(Fly|Swim|Climb|Burrow)\s+(\d+)\s*ft\.?\s*(?:\(([^)]+)\))?/gi;
    let m;
    while ((m = rx.exec(s)) !== null) {
      out.push({
        mode: m[1].toLowerCase(),
        speed_ft: parseInt(m[2], 10),
        maneuverability: m[3] || null,
      });
    }
    return out;
  }

  function updatePreview(panel, typedName) {
    const tpl = lookupTemplate(typedName);
    if (!tpl) {
      panel.style.display = 'none';
      panel.innerHTML = '';
      return;
    }
    const detail = templateDetail(tpl.template_id);
    if (!detail) return;

    const bits = [];
    bits.push(`<b>${escapeHtml(tpl.name)}</b>` +
      ` <span style="opacity:.7">(${escapeHtml(tpl.version || '?')}, ${escapeHtml(tpl.source || '?')})</span>`);

    if (detail.mods.length) {
      const fmt = detail.mods.map(m =>
        `${m.modifier > 0 ? '+' : ''}${m.modifier} ${m.ability}`
      ).join(', ');
      bits.push(`<b>Ability:</b> ${fmt}`);
    }
    if (tpl.new_creature_type) {
      bits.push(`<b>Type → ${escapeHtml(tpl.new_creature_type)}</b>`);
    }
    if (tpl.natural_armor_bonus) {
      bits.push(`<b>Natural Armor:</b> +${tpl.natural_armor_bonus}`);
    }
    if (tpl.level_adjustment) {
      bits.push(`<b>LA:</b> +${tpl.level_adjustment}`);
    }
    if (detail.movement.length) {
      const moves = detail.movement.map(m =>
        `${m.mode} ${m.speed_ft || '?'} ft.${m.maneuverability ? ' (' + m.maneuverability + ')' : ''}`
      ).join(', ');
      bits.push(`<b>Movement:</b> ${moves}`);
    }
    if (detail.resistance.length) {
      const r = detail.resistance.map(x => `${x.damage_type} ${x.amount}`).join(', ');
      bits.push(`<b>Resist:</b> ${r}`);
    }
    if (detail.traits.length) {
      const t = detail.traits.slice(0, 6).map(x => {
        const desc = (x.description || '').replace(/"/g, '&quot;');
        return `<span title="${desc}" style="border-bottom:1px dotted">` +
               escapeHtml(x.name) + '</span>';
      }).join(', ');
      const more = detail.traits.length > 6
        ? ` <span style="opacity:.7">+${detail.traits.length - 6} more</span>`
        : '';
      bits.push(`<b>Traits:</b> ${t}${more}`);
    }
    panel.innerHTML = bits.join(' &nbsp;·&nbsp; ');
    if (window.ErrataBadge) ErrataBadge.attach(panel, tpl.template_id);
    if (window.VersionBadge) VersionBadge.attach(panel, tpl.version);
    panel.style.display = 'block';
  }

  function applyTemplate(typedName, infoPanel) {
    const tpl = lookupTemplate(typedName);
    if (!tpl) {
      flashPanel(infoPanel, 'Pick a template first.', '#a66');
      return;
    }
    if (appliedTemplates.some(t => t.name.toLowerCase() === tpl.name.toLowerCase())) {
      flashPanel(infoPanel, `${tpl.name} already applied.`, '#aa8');
      return;
    }
    const detail = templateDetail(tpl.template_id);
    if (!detail) return;

    // Prefer the rich `detail.tpl` over the index-row `tpl`. The index
    // query only selects a subset of columns; templateDetail() builds
    // the full record including derived fields like natural_armor_bonus.
    const full = detail.tpl;

    // Capture the pre-template base creature type the first time a template
    // lands, so removing the whole stack restores it (see baseCreatureType).
    if (!appliedTemplates.length) {
      const tf0 = document.getElementById('char-type');
      baseCreatureType = tf0 ? (tf0.value || '') : '';
    }

    // Track contributions for clean removal.
    const reversal = {
      name: full.name,
      templateId: full.template_id,
      version: full.version,
      abilityMods: {},          // ability → amount we added
      naturalArmorAdded: 0,
      // This template's own cleaned type change (or null). Used to recompute
      // the live #char-type from the stack on any apply/remove.
      typeChange: full.new_creature_type_clean || null,
    };

    // 1. Stack ability mods into the Template column.
    for (const m of detail.mods) {
      const a = m.ability.toLowerCase();
      const el = document.getElementById(`${a}-template`);
      if (!el) continue;
      const cur = parseInt(el.value, 10) || 0;
      el.value = cur + (m.modifier || 0);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      reversal.abilityMods[m.ability] = m.modifier || 0;
    }

    // 2. Natural armor bonus stacks into #ac-natural.
    if (full.natural_armor_bonus) {
      const na = document.getElementById('ac-natural');
      if (na) {
        const cur = parseInt(na.value, 10) || 0;
        na.value = cur + full.natural_armor_bonus;
        na.dispatchEvent(new Event('input', { bubbles: true }));
        reversal.naturalArmorAdded = full.natural_armor_bonus;
      }
    }

    // 4. Populate Special Abilities with this template's traits.
    populateTemplateTraits(tpl.name, detail.traits);

    appliedTemplates.push(reversal);
    // 3 (deferred to here). Recompute creature type from the full stack now
    // that this template is on it — the cleaned form (e.g. "Augmented
    // (Dragon)") of the topmost template that specifies one, else the base.
    recomputeCreatureType();
    renderAppliedList();
    if (typeof window.recalcAll === 'function') {
      try { window.recalcAll(); } catch (e) { /* non-fatal */ }
    }

    const summary = [];
    if (Object.keys(reversal.abilityMods).length) {
      summary.push(Object.entries(reversal.abilityMods)
        .map(([a, n]) => `${n > 0 ? '+' : ''}${n} ${a}`).join(', '));
    }
    if (tpl.natural_armor_bonus) summary.push(`+${tpl.natural_armor_bonus} NA`);
    if (tpl.level_adjustment) summary.push(`LA +${tpl.level_adjustment}`);
    flashPanel(infoPanel,
      `Applied ${tpl.name}${summary.length ? ': ' + summary.join('; ') : ''}.`,
      '#7a9');
  }

  function removeTemplate(name) {
    const idx = appliedTemplates.findIndex(t =>
      t.name.toLowerCase() === name.toLowerCase());
    if (idx < 0) return;
    const reversal = appliedTemplates.splice(idx, 1)[0];

    // 1. Subtract ability mods.
    for (const [ab, amt] of Object.entries(reversal.abilityMods)) {
      const el = document.getElementById(`${ab.toLowerCase()}-template`);
      if (!el) continue;
      const cur = parseInt(el.value, 10) || 0;
      const next = cur - amt;
      el.value = next === 0 ? '' : String(next);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // 2. Subtract natural armor.
    if (reversal.naturalArmorAdded) {
      const na = document.getElementById('ac-natural');
      if (na) {
        const cur = parseInt(na.value, 10) || 0;
        const next = cur - reversal.naturalArmorAdded;
        na.value = next === 0 ? '0' : String(next);
        na.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    // 3. Recompute creature type from the templates that REMAIN — the
    //    topmost remaining type-changer wins, else the base. This is
    //    order-independent: removing a lower template no longer restores a
    //    stale snapshot that clobbers an upper template's type change.
    recomputeCreatureType();
    // When the stack empties, forget the base so the next first-applied
    // template re-captures a fresh one.
    if (!appliedTemplates.length) baseCreatureType = null;
    // 4. Strip this template's traits.
    document
      .querySelectorAll(`[data-from-template="${cssEscape(reversal.name)}"]`)
      .forEach(node => {
        const row = node.closest('.feat-row');
        if (row) row.remove();
      });
    renderAppliedList();
    if (typeof window.recalcAll === 'function') {
      try { window.recalcAll(); } catch (e) { /* non-fatal */ }
    }
  }

  // Set #char-type from the current template stack: the most-recently-applied
  // template that specifies a (cleaned) type change wins; if none do, fall
  // back to the captured pre-template base type. Order-independent, so it's
  // correct no matter which template in a multi-template stack is removed.
  function recomputeCreatureType() {
    const tf = document.getElementById('char-type');
    if (!tf) return;
    let val = baseCreatureType || '';
    for (let i = appliedTemplates.length - 1; i >= 0; i--) {
      if (appliedTemplates[i].typeChange) { val = appliedTemplates[i].typeChange; break; }
    }
    tf.value = val;
    tf.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function populateTemplateTraits(templateName, traits) {
    const container = document.getElementById('special-abilities-container');
    if (!container || typeof Feats?.addSpecialAbility !== 'function') return;
    const skipNames = new Set(['Darkvision', 'Low-Light Vision']);
    for (const t of traits) {
      if (!t.name && !t.description) continue;
      if (skipNames.has(t.name) && !t.description) continue;
      const text = t.description
        ? `[${templateName}] ${t.name}: ${t.description}`
        : `[${templateName}] ${t.name}`;
      Feats.addSpecialAbility(text);
      const rows = container.querySelectorAll('.feat-row');
      const lastTa = rows[rows.length - 1]?.querySelector(
        '.special-ability-entry'
      );
      if (lastTa) lastTa.setAttribute('data-from-template', templateName);
    }
  }

  function renderAppliedList() {
    const list = document.getElementById('template-applied-list');
    if (!list) return;
    list.innerHTML = '';
    if (!appliedTemplates.length) return;
    const label = document.createElement('span');
    label.textContent = 'Templates:';
    label.style.cssText = 'font-size:0.85em; opacity:0.7';
    list.appendChild(label);
    for (const t of appliedTemplates) {
      const chip = document.createElement('span');
      chip.className = 'template-chip';
      chip.dataset.template = t.name;
      chip.style.cssText =
        'background:rgba(170,106,106,0.2); padding:0.15rem 0.5rem; ' +
        'border-radius:3px; font-size:0.85em; ' +
        'display:inline-flex; gap:0.35rem; align-items:center;';
      const txt = document.createElement('span');
      txt.textContent = t.name;
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.title = `Remove ${t.name}`;
      x.style.cssText =
        'background:transparent; border:0; color:#c88; cursor:pointer; ' +
        'font-size:1.1em; padding:0; line-height:1;';
      x.addEventListener('click', () => removeTemplate(t.name));
      chip.appendChild(txt);
      chip.appendChild(x);
      list.appendChild(chip);
    }
  }

  function flashPanel(panel, msg, color) {
    if (!panel) return;
    const note = document.createElement('div');
    note.style.cssText = `margin-top:0.3rem;color:${color};font-style:italic`;
    note.textContent = msg;
    panel.appendChild(note);
    panel.style.display = 'block';
    setTimeout(() => note.remove(), 4000);
  }

  // ============================================================
  // Save / Load persistence (monkey-patches Character)
  // ============================================================

  function installPersistenceHooks() {
    if (typeof Character === 'undefined' || Character._tplHooked) return;
    Character._tplHooked = true;
    const origCollect = Character.collectData;
    const origLoad    = Character.loadData;
    Character.collectData = function () {
      const out = origCollect.apply(this, arguments) || {};
      if (appliedTemplates.length) {
        out._templates = appliedTemplates.map(t => ({
          name: t.name,
          templateId: t.templateId,
          version: t.version,
          abilityMods: t.abilityMods,
          naturalArmorAdded: t.naturalArmorAdded,
          typeChange: t.typeChange || null,
        }));
        // The pre-template base type — not derivable from any template, so it
        // must round-trip for a later full-stack removal to restore it.
        out._templateBaseType = baseCreatureType;
      }
      return out;
    };
    Character.loadData = function (data) {
      const ret = origLoad.apply(this, arguments);
      appliedTemplates = [];
      baseCreatureType = null;
      if (data && Array.isArray(data._templates)) {
        for (const t of data._templates) {
          appliedTemplates.push({
            name: t.name,
            templateId: t.templateId,
            version: t.version || '3.5',
            abilityMods: t.abilityMods || {},
            naturalArmorAdded: t.naturalArmorAdded || 0,
            // New saves carry typeChange; old saves had per-template
            // creatureTypeBefore (no typeChange) — re-derive the cleaned
            // type from the DB so removal recompute still works.
            typeChange: (t.typeChange != null)
              ? t.typeChange
              : deriveTypeChangeForName(t.name),
          });
        }
        if (appliedTemplates.length) {
          if (typeof data._templateBaseType === 'string') {
            baseCreatureType = data._templateBaseType;
          } else if (data._templates[0]
                     && data._templates[0].creatureTypeBefore != null) {
            // Migration: the first-applied template's "type before me" IS the
            // pre-template base type in the old per-template-snapshot scheme.
            baseCreatureType = data._templates[0].creatureTypeBefore;
          } else {
            baseCreatureType = '';
          }
        }
      }
      // Note: #char-type itself round-trips as a normal Character field, so we
      // do NOT recompute it here — the saved value is already the correct
      // final type. We only restore the stack + base so future removals work.
      renderAppliedList();
      return ret;
    };
  }

  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(s);
    }
    return String(s).replace(/[^a-zA-Z0-9_-]/g, ch =>
      '\\' + ch.charCodeAt(0).toString(16) + ' ');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  DB.ready.then((db) => {
    if (db) init();
  });

  window.TemplatePicker = {
    getApplied: () => appliedTemplates.slice(),
    apply: applyTemplate,
    remove: removeTemplate,
  };
})();
