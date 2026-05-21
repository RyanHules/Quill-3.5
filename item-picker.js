// item-picker.js — Autocomplete item search + info panel + add buttons
// for Possessions or Magic Items. Injected into the Equipment tab
// above the existing "+ Add Item" button.
//
// Two destinations:
//   + Gear         → Equipment.addGearRow({ name, weight })  for ordinary
//                    possessions (weapons, mundane gear, consumables)
//   + Magic Item   → Equipment.addMagicItem({ name, weight, special })
//                    for items with a body slot or persistent properties
//
// Data quirks:
//   * Item `name` is stored UPPER CASE — Title-Case for display.
//   * Both 3.5 and 3.0 versions of many items exist — dedup with 3.5 win.
//   * `weight` is a free-form string ("1 lb", "—", "1/2 lb"); parsed to a
//      decimal pound value.
//   * `body_slot` is mostly NULL (parser data quality); we don't try to
//      auto-pick a slot for magic items — user picks via the existing
//      slot dropdown.
//
// UI inserted into the Possessions section (before #btn-add-gear):
//   #item-lookup           (input)   — name autocomplete
//   #item-lookup-type      (select)  — filter by item.type
//   #item-add-gear         (button)  — append to gear table
//   #item-add-magic        (button)  — append to magic items list
//   #item-info             (div)     — info panel
//   <datalist id="item-options">     — autocomplete options

(function () {
  if (!window.DB) {
    console.warn('[item-picker] DB module not loaded');
    return;
  }

  // canonical name (lowercase) → { displayName, primaryRow }
  let itemIndex = new Map();
  // Title-cased names for the datalist, sorted.
  let displayNames = [];
  // type → count
  let typeIndex = new Map();

  const SMALL_WORDS = new Set([
    'of','the','and','or','a','an','in','on','to','for','with','by','at','from','as','is',
  ]);
  function titleCase(s) {
    if (!s) return '';
    const lower = String(s).toLowerCase();
    return lower.replace(/\b([a-z])([a-z'-]*)/gi, (m, first, rest, idx) => {
      const word = first.toLowerCase() + rest.toLowerCase();
      if (idx > 0 && SMALL_WORDS.has(word)) return word;
      return first.toUpperCase() + rest.toLowerCase();
    });
  }

  // "1 lb", "1.5 lb", "—", "1/2 lb", "" → number (pounds, 0 if unknown).
  function parseWeight(s) {
    if (!s) return 0;
    const t = String(s).trim().toLowerCase();
    if (!t || t === '—' || t === '-' || t === 'negligible') return 0;
    // "1/2 lb" or "1/4 lb"
    const frac = t.match(/^(\d+)\s*\/\s*(\d+)/);
    if (frac) return parseInt(frac[1], 10) / parseInt(frac[2], 10);
    // "1 lb", "10 lb.", "1.5 lb"
    const num = t.match(/(\d+(?:\.\d+)?)/);
    if (num) return parseFloat(num[1]) || 0;
    return 0;
  }

  // Parse the headline gp cost of an item from its price/cost string.
  // Returns a number (gp) or null if the value can't be resolved — null
  // means "unknown", and excludes the item from any cost-filter query
  // so the user doesn't have to wade through "—" / "varies" rows.
  //
  // Shape catalog (from sweep across all 4,258 item rows):
  //   simple   3,432 — "2,500 gp", "+50 gp"
  //   compound   102 — "500 gp (least) / 2,000 gp (lesser) / 6,000 gp (greater)"
  //   no-gp      416 — "—", "varies", "2 sp", or other rare units
  //   plus        32 — "+1,000 gp per upgrade"
  //   none       110 — no price/cost at all
  //
  // Strategy: take the FIRST "N gp" match (handles compound tiers
  // and "+N gp" prefixes uniformly). For sp/cp/pp-only entries
  // (mundane sub-gp gear) convert to fractional gp. Everything else
  // returns null so the filter ignores it.
  function parseGpCost(s) {
    if (s == null) return null;
    const t = String(s).trim().toLowerCase();
    if (!t || t === '—' || t === '-' || t.startsWith('varies')) return null;
    // Strip commas so 2,500 parses as 2500. Keep the "+" sign for
    // bonus-only prices like "+50 gp" — treat as the additive amount.
    const cleaned = t.replace(/,/g, '');
    // First "N gp" or "N.N gp" match wins. The leading "+?" matches
    // bonus-only prices uniformly.
    const gp = cleaned.match(/\+?(\d+(?:\.\d+)?)\s*gp\b/);
    if (gp) return parseFloat(gp[1]);
    // Fall back to sp / cp / pp for mundane sub-gp gear.
    //   1 gp = 10 sp = 100 cp; 1 pp = 10 gp.
    const pp = cleaned.match(/\+?(\d+(?:\.\d+)?)\s*pp\b/);
    if (pp) return parseFloat(pp[1]) * 10;
    const sp = cleaned.match(/\+?(\d+(?:\.\d+)?)\s*sp\b/);
    if (sp) return parseFloat(sp[1]) / 10;
    const cp = cleaned.match(/\+?(\d+(?:\.\d+)?)\s*cp\b/);
    if (cp) return parseFloat(cp[1]) / 100;
    return null;
  }

  // Parse the cost-filter input — same syntax as spell-picker's level
  // filter. Returns {min, max} (both inclusive, in gp), or null for
  // no constraint. Commas in the number are allowed (mirrors how
  // prices are naturally written) — "<=1,500" === "<=1500".
  function parseCostFilter(raw) {
    const s = String(raw || '').trim().replace(/,/g, '').replace(/\s+/g, '');
    if (!s) return null;
    const m = s.match(/^(<=|>=|<|>|≤|≥|=)?\s*(\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const op = m[1] || '=';
    const n = parseFloat(m[2]);
    if (isNaN(n)) return null;
    switch (op) {
      case '<':  return { min: 0, max: n - 0.001 };
      case '<=': case '≤': return { min: 0, max: n };
      case '>':  return { min: n + 0.001, max: Infinity };
      case '>=': case '≥': return { min: n, max: Infinity };
      case '=':  default:  return { min: n, max: n };
    }
  }

  function buildIndex() {
    // Query the unified `entry` table. Tiebreak: 3.5 > 3.0, then by
    // newest publication date (so the most recent printing wins for
    // duplicate-named items). Pulls price + cost so we can index a
    // per-item gp value for the cost filter (parsed once at build
    // time so per-keystroke filter refreshes don't re-parse strings).
    const rows = DB.query(
      "SELECT e.id AS item_id, e.name, e.version, e.source, " +
      "       e.item_type AS type, e.type AS entry_type, " +
      "       e.price AS price_str, " +
      "       json_extract(e.data, '$.cost') AS cost_str " +
      "FROM entry e " +
      "LEFT JOIN book b ON b.name = e.source " +
      "WHERE e.type IN ('item', 'weapon', 'armor', 'gear') " +
      "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, " +
      "         b.publication_date DESC, " +
      "         e.name COLLATE NOCASE"
    );
    itemIndex = new Map();
    typeIndex = new Map();
    for (const r of rows) {
      if (!r.name) continue;
      // r.type in this query is the user-facing item subtype
      // ("Wondrous", "Slot: Head", etc.) aliased from e.item_type;
      // the entry-table type lives in r.entry_type ('item' / 'weapon'
      // / 'armor' / 'gear'). Pass entry_type to allowsEntry so the
      // counterpart match keys correctly.
      if (window.BookFilter && !window.BookFilter.allowsEntry(
        { source: r.source, version: r.version, name: r.name,
          type: r.entry_type })) continue;
      const key = r.name.toLowerCase();
      if (!itemIndex.has(key)) {
        // Parse the gp cost ONCE at index time. price wins over cost
        // (price = retail/market for magic items; cost = craft cost
        // for mundane gear). Either falls back to null for "—" /
        // "varies" / unparseable shapes.
        const costGp = parseGpCost(r.price_str) ?? parseGpCost(r.cost_str);
        itemIndex.set(key, {
          displayName: titleCase(r.name),
          primaryRow: r,
          costGp,
        });
      }
      if (r.type) {
        typeIndex.set(r.type, (typeIndex.get(r.type) || 0) + 1);
      }
    }
    displayNames = [...itemIndex.values()]
      .map(v => v.displayName)
      .sort((a, b) => a.localeCompare(b));
    console.log(`[item-picker] indexed ${rows.length} item rows → ` +
      `${itemIndex.size} distinct items, ${typeIndex.size} types`);
  }

  function fullItemRow(itemId) {
    // Per-field columns aliased from entry + JSON sub-fields. The
    // armor_* / damage_* / category / entry_kind fields drive the H3
    // worn-armor / weapon routing buttons (added 2026-05-16).
    return DB.queryOne(
      "SELECT id AS item_id, name, source, version, "
      + "item_type AS type, body_slot, aura, caster_level, price, weight, "
      + "json_extract(data, '$.prerequisites')         AS prerequisites, "
      + "json_extract(data, '$.cost')                  AS cost, "
      + "json_extract(data, '$.description')           AS description, "
      + "json_extract(data, '$.category')              AS category, "
      + "json_extract(data, '$.entry_kind')            AS entry_kind, "
      + "json_extract(data, '$.armor_bonus')           AS armor_bonus, "
      + "json_extract(data, '$.armor_check_penalty')   AS armor_check_penalty, "
      + "json_extract(data, '$.arcane_spell_failure')  AS arcane_spell_failure, "
      + "json_extract(data, '$.max_dex')               AS max_dex, "
      + "json_extract(data, '$.damage_medium')         AS damage_medium, "
      + "json_extract(data, '$.damage_small')          AS damage_small, "
      + "json_extract(data, '$.critical')              AS critical, "
      + "json_extract(data, '$.range_increment')       AS range_increment "
      + "FROM entry WHERE id = ?", [itemId]);
  }

  // Tag → Set<item_id> and per-tag counts for fast filtering.
  const tagIndex = new Map();
  const tagCounts = new Map();

  function buildTagIndex() {
    const rows = DB.query(
      "SELECT t.tag, t.entry_id FROM tag t "
      + "JOIN entry e ON e.id = t.entry_id "
      + "WHERE e.type IN ('item','weapon','armor','gear')"
    );
    for (const r of rows) {
      if (!tagIndex.has(r.tag)) tagIndex.set(r.tag, new Set());
      tagIndex.get(r.tag).add(r.entry_id);
      tagCounts.set(r.tag, (tagCounts.get(r.tag) || 0) + 1);
    }
  }

  function refreshDatalist(datalist, chosenType, chosenTag, costFilter) {
    datalist.innerHTML = '';
    const tagSet = chosenTag ? tagIndex.get(chosenTag) : null;
    const matchedNames = [];
    for (const display of displayNames) {
      const entry = itemIndex.get(display.toLowerCase());
      if (!entry) continue;
      if (chosenType && entry.primaryRow.type !== chosenType) continue;
      if (tagSet && !tagSet.has(entry.primaryRow.item_id)) continue;
      // Cost filter: excludes items with no parseable price (treat
      // null as "out of range" rather than "matches anything", so
      // "<=1000 gp" doesn't sweep in every "—"-priced row).
      if (costFilter) {
        const c = entry.costGp;
        if (c == null) continue;
        if (c < costFilter.min || c > costFilter.max) continue;
      }
      const opt = document.createElement('option');
      opt.value = display;
      // No opt.label — Firefox renders it as visible suggestion text.
      datalist.appendChild(opt);
      matchedNames.push(display);
    }
    return matchedNames;
  }

  function init() {
    const addBtn = document.getElementById('btn-add-gear');
    if (!addBtn) {
      console.warn('[item-picker] #btn-add-gear not found');
      return;
    }
    buildIndex();
    buildTagIndex();

    // Alphabetical filter options so the user can scan to a specific
    // type / tag rather than scrubbing past the most-common ones.
    // Counts stay in the option label as `(N)` for relative-size cues.
    const sortedTypes = [...typeIndex.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]));
    const sortedTags = [...tagCounts.entries()]
      .filter(([, c]) => c >= 5)
      .sort((a, b) => a[0].localeCompare(b[0]));

    const wrap = document.createElement('div');
    wrap.className = 'item-picker';
    wrap.style.cssText =
      'padding:0.5rem; margin-bottom:0.5rem; ' +
      'background:rgba(255,255,255,0.04); border-left:3px solid #6aaa8a; ' +
      'border-radius:3px;';
    wrap.innerHTML = `
      <div style="display:flex;gap:0.4rem;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="flex:2 1 14rem;min-width:12rem">
          <label>Item Lookup</label>
          <input type="text" id="item-lookup" list="item-options"
                 placeholder="e.g. Cloak of Resistance" autocomplete="off">
          <datalist id="item-options"></datalist>
        </div>
        <div class="field" style="flex:1 1 8rem;min-width:7rem">
          <label>Type Filter</label>
          <select id="item-lookup-type">
            <option value="">Any type</option>
            ${sortedTypes.map(([t, c]) =>
              `<option value="${escapeHtml(t)}">${escapeHtml(t)} (${c})</option>`
            ).join('')}
          </select>
        </div>
        <div class="field" style="flex:1 1 8rem;min-width:7rem">
          <label>Tag Filter</label>
          <select id="item-lookup-tag">
            <option value="">Any tag</option>
            ${sortedTags.map(([t, c]) =>
              `<option value="${escapeHtml(t)}">${escapeHtml(t)} (${c})</option>`
            ).join('')}
          </select>
        </div>
        <div class="field field-sm" style="width:6.5rem"
             title="Cost in gp. Plain number = exact match; &lt;N / &lt;=N / &gt;N / &gt;=N to filter by range (commas ok). Items with no listed price are excluded by any cost filter.">
          <label>Cost (gp)</label>
          <input type="text" id="item-lookup-cost" value=""
                 placeholder="&le;5000"
                 autocomplete="off">
        </div>
        <button type="button" id="item-add-gear" class="btn-add"
                title="Add to Possessions list (mundane gear / weapons / consumables)"
                style="height:2rem">+ Gear</button>
        <button type="button" id="item-add-magic" class="btn-add"
                title="Add to Magic Items list (items with body slot or persistent effect)"
                style="height:2rem">+ Magic Item</button>
        <button type="button" id="item-add-armor-affix" class="btn-add"
                title="Append this affix to the Armor's Special Properties"
                style="height:2rem; display:none">+ Armor Affix</button>
        <button type="button" id="item-add-shield-affix" class="btn-add"
                title="Append this affix to the Shield's Special Properties"
                style="height:2rem; display:none">+ Shield Affix</button>
        <button type="button" id="item-equip-armor" class="btn-add"
                title="Equip as worn armor — fills Armor name/bonus/max DEX/check/spell-fail/weight"
                style="height:2rem; display:none">+ Equip Armor</button>
        <button type="button" id="item-equip-shield" class="btn-add"
                title="Equip as worn shield — fills Shield name/bonus/check/spell-fail/weight"
                style="height:2rem; display:none">+ Equip Shield</button>
        <button type="button" id="item-add-weapon" class="btn-add"
                title="Add a new attack row pre-filled with this weapon's damage / crit / type"
                style="height:2rem; display:none">+ Add as Weapon</button>
      </div>
      <div id="item-info"
           style="display:none;font-size:0.85em;color:#ccc;margin-top:0.4rem">
      </div>
    `;
    addBtn.parentElement.insertBefore(wrap, addBtn);

    const itemInput     = document.getElementById('item-lookup');
    const typeSel       = document.getElementById('item-lookup-type');
    const tagSel        = document.getElementById('item-lookup-tag');
    const addGear       = document.getElementById('item-add-gear');
    const addMagic      = document.getElementById('item-add-magic');
    const addArmorAffix = document.getElementById('item-add-armor-affix');
    const addShieldAffix= document.getElementById('item-add-shield-affix');
    const equipArmor    = document.getElementById('item-equip-armor');
    const equipShield   = document.getElementById('item-equip-shield');
    const addWeapon     = document.getElementById('item-add-weapon');
    const info          = document.getElementById('item-info');
    const datalist      = document.getElementById('item-options');
    const costInput     = document.getElementById('item-lookup-cost');

    // Shared browsing-chip helper — same pattern as spell-picker.
    // Chip click: set value + show info DIRECTLY without dispatching
    // 'input' (which would narrow the chip wall to the picked entry).
    const results = (typeof PickerResults !== 'undefined')
      ? PickerResults.attach(wrap, {
          itemNoun: 'item',
          onPick: (name) => {
            itemInput.value = name;
            updateInfo();
            itemInput.focus();
          },
        })
      : null;

    function applyFilters() {
      const costFilter = parseCostFilter(costInput.value);
      const names = refreshDatalist(datalist, typeSel.value, tagSel.value,
                                    costFilter);
      const n = names.length;
      const parts = [];
      if (typeSel.value) parts.push(typeSel.value);
      if (tagSel.value)  parts.push(`tag:${tagSel.value}`);
      if (costFilter) {
        // Compact label: "≤5,000 gp", "≥1 gp", "100-500 gp", "500 gp".
        const fmt = (v) => v === Infinity ? '∞'
          : Math.abs(v - Math.round(v)) < 0.01
            ? Math.round(v).toLocaleString()
            : v.toFixed(2).replace(/\.?0+$/, '');
        let label;
        if (costFilter.min === 0 && costFilter.max !== Infinity) {
          label = `≤${fmt(costFilter.max)} gp`;
        } else if (costFilter.max === Infinity) {
          label = `≥${fmt(costFilter.min)} gp`;
        } else if (Math.abs(costFilter.min - costFilter.max) < 0.001) {
          label = `${fmt(costFilter.min)} gp`;
        } else {
          label = `${fmt(costFilter.min)}-${fmt(costFilter.max)} gp`;
        }
        parts.push(label);
      }
      itemInput.placeholder = parts.length
        ? `${n} ${parts.join(' + ')} item${n === 1 ? '' : 's'}`
        : 'e.g. Cloak of Resistance';
      if (results) results.render(names, { typedFilter: itemInput.value.trim() });
    }
    applyFilters();
    typeSel.addEventListener('change', applyFilters);
    tagSel.addEventListener('change', applyFilters);
    costInput.addEventListener('input', applyFilters);
    // Re-render chips as the user types — substring filter on names.
    itemInput.addEventListener('input', applyFilters);

    document.addEventListener('book-filter-changed', () => {
      buildIndex();
      applyFilters();
    });

    // Detect whether `item_type` is an armor- or shield-affix. The DB
    // uses several near-synonyms ("Armor Special Ability", "Magic
    // Armor Property", "Armor Property" etc.) — match any of them.
    // Returns 'armor' / 'shield' / null.
    function affixCategory(itemType) {
      if (!itemType) return null;
      const t = String(itemType).toLowerCase();
      if (/(^|\b)(magic\s+)?armor\s+(property|special ability)\b/.test(t)) return 'armor';
      if (/(^|\b)(magic\s+)?shield\s+(property|special ability)\b/.test(t)) return 'shield';
      return null;
    }

    // H3 (2026-05-16 play-feel pass): classify the selected item to
    // pick which button(s) to surface. Returns one of:
    //   'affix-armor'   → "+ Armor Affix" (append to armor-special)
    //   'affix-shield'  → "+ Shield Affix" (append to shield-special)
    //   'armor'         → "+ Equip Armor" (populate worn-armor fields)
    //   'shield'        → "+ Equip Shield" (populate worn-shield fields)
    //   'weapon'        → "+ Add as Weapon" (new attack row)
    //   null            → fall back to default "+ Gear" / "+ Magic Item"
    // Driven by `entry_kind` (armor/weapon) + `category` (Shield vs
    // Light/Medium/Heavy Armor) when available, with the existing
    // item_type-based affix detection as the higher-precedence rule.
    function classifyItem(full) {
      if (!full) return null;
      const affix = affixCategory(full.type);
      if (affix === 'armor')  return 'affix-armor';
      if (affix === 'shield') return 'affix-shield';
      if (full.entry_kind === 'weapon') return 'weapon';
      if (full.entry_kind === 'armor') {
        const cat = String(full.category || '').toLowerCase();
        if (cat === 'shield') return 'shield';
        if (/light armor|medium armor|heavy armor/.test(cat)) return 'armor';
        // "Armor Extra" → Masterwork upgrade, shield spikes, etc. —
        // not a base equip; fall through to Gear/Magic Item.
        return null;
      }
      return null;
    }

    // Show the right button(s) for the selected item and hide the rest.
    function updateActionButtons(full) {
      const kind = classifyItem(full);
      addArmorAffix.style.display  = kind === 'affix-armor'  ? '' : 'none';
      addShieldAffix.style.display = kind === 'affix-shield' ? '' : 'none';
      equipArmor.style.display     = kind === 'armor'        ? '' : 'none';
      equipShield.style.display    = kind === 'shield'       ? '' : 'none';
      addWeapon.style.display      = kind === 'weapon'       ? '' : 'none';
      // Hide generic destinations when we have a more specific routing.
      const hideDefaults = kind !== null;
      addGear.style.display  = hideDefaults ? 'none' : '';
      addMagic.style.display = hideDefaults ? 'none' : '';
    }
    // Legacy alias for the prior implementation. Routes through the new
    // classify path so the affix-only call sites keep working.
    function updateAffixButtons(itemType) {
      updateActionButtons(itemType ? { type: itemType } : null);
    }

    function updateInfo() {
      const typed = itemInput.value.trim();
      if (!typed) {
        info.style.display = 'none'; info.innerHTML = '';
        updateAffixButtons(null);
        return;
      }
      const entry = itemIndex.get(typed.toLowerCase());
      if (!entry) {
        info.style.display = 'none'; info.innerHTML = '';
        updateAffixButtons(null);
        return;
      }
      const full = fullItemRow(entry.primaryRow.item_id);
      if (!full) return;
      const bits = [];
      // Title line: bold name + source attribution. The VersionBadge
      // (3.0 pill) is attached at the panel root via attach() below
      // — replaces the old low-opacity "(3.5)" suffix.
      const srcSuffix = full.source ? ` <span style="opacity:.7; font-size:0.9em">— ${escapeHtml(full.source)}</span>` : '';
      bits.push(`<b>${escapeHtml(entry.displayName)}</b>${srcSuffix}`);
      if (full.type)         bits.push(`<b>Type:</b> ${escapeHtml(full.type)}`);
      if (full.body_slot)    bits.push(`<b>Slot:</b> ${escapeHtml(full.body_slot)}`);
      if (full.aura)         bits.push(`<b>Aura:</b> ${escapeHtml(full.aura)}`);
      if (full.caster_level) bits.push(`<b>CL:</b> ${escapeHtml(full.caster_level)}`);
      if (full.prerequisites)bits.push(`<b>Prereq:</b> ${escapeHtml(full.prerequisites)}`);
      if (full.price)        bits.push(`<b>Price:</b> ${escapeHtml(full.price)}`);
      if (full.weight)       bits.push(`<b>Weight:</b> ${escapeHtml(full.weight)}`);
      if (full.cost)         bits.push(`<b>Cost:</b> ${escapeHtml(full.cost)}`);
      if (full.description) {
        const trimmed = full.description.length > 400
          ? full.description.slice(0, 400) + '…'
          : full.description;
        bits.push(`<b>Description:</b> ${escapeHtml(trimmed)}`);
      }
      info.innerHTML = bits.join('<br>');
      if (window.ErrataBadge) ErrataBadge.attach(info, entry.primaryRow.item_id);
      if (window.VersionBadge) VersionBadge.attach(info, full.version);
      info.style.display = 'block';
      // Pass the full row (not just item_type) so classifyItem can use
      // entry_kind + category for the new armor/shield/weapon routing.
      updateActionButtons(full);
    }
    itemInput.addEventListener('input', updateInfo);
    itemInput.addEventListener('change', updateInfo);

    function flash(msg, color) {
      const note = document.createElement('div');
      note.style.cssText = `margin-top:0.3rem;color:${color};font-style:italic`;
      note.textContent = msg;
      info.appendChild(note);
      info.style.display = 'block';
      setTimeout(() => note.remove(), 3500);
    }

    function resolveTyped() {
      const typed = itemInput.value.trim();
      if (!typed) { flash('Pick an item first.', '#a66'); return null; }
      const entry = itemIndex.get(typed.toLowerCase());
      if (entry) {
        const full = fullItemRow(entry.primaryRow.item_id);
        return {
          name: entry.displayName,
          weight: parseWeight(full?.weight),
          special: full?.description
            ? (full.description.length > 200
                ? full.description.slice(0, 200) + '…'
                : full.description)
            : '',
        };
      }
      // Custom / not-in-DB item — pass through with no detail.
      return { name: typed, weight: 0, special: '' };
    }

    addGear.addEventListener('click', () => {
      const it = resolveTyped();
      if (!it) return;
      if (typeof Equipment?.addGearRow !== 'function') {
        flash('Equipment module unavailable.', '#a66');
        return;
      }
      Equipment.addGearRow({ name: it.name, weight: it.weight || '' });
      if (typeof Equipment.recalcWeight === 'function') Equipment.recalcWeight();
      flash(`Added "${it.name}" to Possessions.`, '#7a9');
    });

    addMagic.addEventListener('click', () => {
      const it = resolveTyped();
      if (!it) return;
      if (typeof Equipment?.addMagicItem !== 'function') {
        flash('Equipment module unavailable.', '#a66');
        return;
      }
      Equipment.addMagicItem({
        name: it.name,
        weight: it.weight || '',
        special: it.special,
      });
      flash(`Added "${it.name}" to Magic Items.`, '#7a9');
    });

    // Append affix name to the relevant Special Properties textarea
    // (`#armor-special` / `#shield-special`). Duplicates are allowed
    // — a +1 keen flaming holy weapon really does carry three lines.
    function appendAffix(targetId, label) {
      const it = resolveTyped();
      if (!it) return;
      const ta = document.getElementById(targetId);
      if (!ta) {
        flash(`No ${label} field on this sheet.`, '#a66');
        return;
      }
      const cur = String(ta.value || '').replace(/\s+$/, '');
      ta.value = cur ? `${cur}\n${it.name}` : it.name;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      // Equipment.recalc / Character.recalcAC pick up new special-
      // property text through the existing input listener delegation;
      // no explicit recalc call needed.
      flash(`Added "${it.name}" to ${label} Special Properties.`, '#7a9');
    }

    addArmorAffix.addEventListener('click',
      () => appendAffix('armor-special', 'Armor'));
    addShieldAffix.addEventListener('click',
      () => appendAffix('shield-special', 'Shield'));

    // ---- H3: worn-armor / worn-shield / weapon routing -----------------
    //
    // Helper to set a worn-equipment field, dispatch input/change so the
    // dependent calc fields (AC, ACP, ASF, weight) recompute.
    function setField(id, val) {
      const el = document.getElementById(id);
      if (!el) return false;
      el.value = val == null ? '' : String(val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    // Strip "30%" → 30, "-5" stays "-5", "4 lb." → 4.
    function numFromText(raw, fallback) {
      if (raw === null || raw === undefined) return fallback;
      const m = String(raw).match(/-?\d+(?:\.\d+)?/);
      return m ? Number(m[0]) : fallback;
    }

    equipArmor.addEventListener('click', () => {
      const typed = itemInput.value.trim();
      if (!typed) { flash('Pick an armor first.', '#a66'); return; }
      const entry = itemIndex.get(typed.toLowerCase());
      if (!entry) { flash('Unknown armor — fill the worn-armor fields manually.', '#a66'); return; }
      const full = fullItemRow(entry.primaryRow.item_id);
      if (!full) return;
      // Confirm before overwriting an already-equipped armor.
      const cur = document.getElementById('armor-name');
      if (cur && cur.value.trim() &&
          !confirm(`Replace currently-equipped "${cur.value}" with "${entry.displayName}"?`)) {
        return;
      }
      setField('armor-name', entry.displayName);
      setField('armor-type', full.category || '');
      setField('armor-ac-bonus', numFromText(full.armor_bonus, 0));
      if (full.max_dex !== null && full.max_dex !== undefined) {
        setField('armor-max-dex', full.max_dex);
      }
      setField('armor-check-pen', numFromText(full.armor_check_penalty, 0));
      setField('armor-spell-fail', numFromText(full.arcane_spell_failure, ''));
      setField('armor-weight', numFromText(full.weight, ''));
      // Ensure the "worn" checkbox is on so AC picks it up.
      const worn = document.getElementById('armor-worn');
      if (worn && !worn.checked) {
        worn.checked = true;
        worn.dispatchEvent(new Event('change', { bubbles: true }));
      }
      flash(`Equipped "${entry.displayName}".`, '#7a9');
    });

    equipShield.addEventListener('click', () => {
      const typed = itemInput.value.trim();
      if (!typed) { flash('Pick a shield first.', '#a66'); return; }
      const entry = itemIndex.get(typed.toLowerCase());
      if (!entry) { flash('Unknown shield — fill the worn-shield fields manually.', '#a66'); return; }
      const full = fullItemRow(entry.primaryRow.item_id);
      if (!full) return;
      const cur = document.getElementById('shield-name');
      if (cur && cur.value.trim() &&
          !confirm(`Replace currently-equipped "${cur.value}" with "${entry.displayName}"?`)) {
        return;
      }
      setField('shield-name', entry.displayName);
      setField('shield-ac-bonus', numFromText(full.armor_bonus, 0));
      setField('shield-check-pen', numFromText(full.armor_check_penalty, 0));
      setField('shield-spell-fail', numFromText(full.arcane_spell_failure, ''));
      setField('shield-weight', numFromText(full.weight, ''));
      const worn = document.getElementById('shield-worn');
      if (worn && !worn.checked) {
        worn.checked = true;
        worn.dispatchEvent(new Event('change', { bubbles: true }));
      }
      flash(`Equipped "${entry.displayName}".`, '#7a9');
    });

    addWeapon.addEventListener('click', () => {
      const typed = itemInput.value.trim();
      if (!typed) { flash('Pick a weapon first.', '#a66'); return; }
      const entry = itemIndex.get(typed.toLowerCase());
      if (!entry) { flash('Unknown weapon — use "+ Gear" then add an attack manually.', '#a66'); return; }
      const full = fullItemRow(entry.primaryRow.item_id);
      if (!full) return;
      if (typeof Character?.addAttack !== 'function') {
        flash('Character module unavailable.', '#a66'); return;
      }
      // Pick damage column based on character size. Most builds are
      // Medium; Small characters (halflings, gnomes) get the smaller
      // damage die. Other sizes (Large+) need DM adjustment anyway.
      const sizeRaw = document.getElementById('char-size')?.value || 'Medium';
      const useSmall = String(sizeRaw).toLowerCase() === 'small';
      const damage = (useSmall ? full.damage_small : full.damage_medium)
        || full.damage_medium || full.damage_small || '';
      Character.addAttack({
        name: entry.displayName,
        damage: damage,
        crit: full.critical || '',
        range: full.range_increment || '',
        type: full.type || '',
        notes: full.category || '',
      });
      // Also drop the weapon into the Possessions list so the weight
      // and inventory line are tracked. Player can remove if they're
      // not actually carrying it.
      if (typeof Equipment?.addGearRow === 'function') {
        Equipment.addGearRow({
          name: entry.displayName,
          weight: numFromText(full.weight, ''),
        });
        if (typeof Equipment.recalcWeight === 'function') Equipment.recalcWeight();
      }
      flash(`Added "${entry.displayName}" attack row + gear entry.`, '#7a9');
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  DB.ready.then((db) => {
    if (db) init();
  });
})();
