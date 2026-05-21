// spell-picker.js — Inject a spell autocomplete + filter widget into
// every Spellcasting sub-tab. Lets the user search for spells by
// class+level, see school/components/duration, and add them to the
// appropriate Known/Available or Prepared textarea with one click.
//
// Pure additive — `spells.js` is untouched; we attach via a
// MutationObserver on #spells-content that fires when new
// `.inner-tab-content[data-caster-type="spellcasting"]` panels appear.
//
// Per-panel UI inserted above the level tabs:
//   .sp-class    (input + datalist) — class picker (Wizard, Sorcerer, …)
//   .sp-level    (input number)     — spell level 0..9 (or higher)
//   .sp-spell    (input + datalist) — spell name autocomplete (filtered)
//   .sp-add-known (button)          — append to .sc-spell-text[data-lvl=N]
//   .sp-add-prep  (button)          — add a row to .sc-prepared-list[data-lvl=N]
//   .sp-info     (div)              — school, components, range, …
//
// The class column in `spell_class_level` is messy: a mix of full names
// ("Wizard"), abbreviations ("Wiz"), case-different duplicates ("wizard",
// "C l e r i c"). We normalize via CLASS_ALIASES + space-collapse, then
// reverse-map canonical name → [raw variants] so a lookup for "Wizard"
// finds spells filed under any of those variants.

(function () {
  if (!window.DB) {
    console.warn('[spell-picker] DB module not loaded');
    return;
  }

  // Lowercased input → canonical class name. Order doesn't matter; the
  // raw DB values are normalized through this map at index-build time.
  const CLASS_ALIASES = {
    // Core casters
    'wiz': 'Wizard',         'wizard': 'Wizard',
    'sor': 'Sorcerer',       'sorcerer': 'Sorcerer',
    'clr': 'Cleric',         'cleric': 'Cleric',
    'drd': 'Druid',          'druid': 'Druid',
    'pal': 'Paladin',        'paladin': 'Paladin',
    'rgr': 'Ranger',         'ranger': 'Ranger',
    'brd': 'Bard',           'bard': 'Bard',
    // Common prestige + alt casters
    'asn': 'Assassin',       'assassin': 'Assassin',
    'blk': 'Blackguard',     'blackguard': 'Blackguard',
    'hrp': 'Harper Scout',   'harper scout': 'Harper Scout',
    'hexblade': 'Hexblade',
    'wmg': 'Warmage',        'warmage': 'Warmage',
    'wuj': 'Wu Jen',         'wij': 'Wu Jen',  'wu jen': 'Wu Jen',
    'shu': 'Shugenja',       'shugenja': 'Shugenja',
    'sha': 'Shugenja',       // ambiguous; shugenja is the most common in spell tables
    'soh': 'Sohei',
    'maho': 'Maho-tsukai',
    'duskblade': 'Duskblade',
    'beguiler': 'Beguiler',
    'dread necromancer': 'Dread Necromancer',
    'healer': 'Healer',
    'urban druid': 'Urban Druid',
    'death delver': 'Death Delver',
    'champion of gwynharwyf': 'Champion of Gwynharwyf',
    'apostle of peace': 'Apostle of Peace',
  };

  // canonical class name → [raw class_name variants in DB]
  let canonical = new Map();
  // sorted canonical names for the class datalist
  let classNamesSorted = [];
  // used to mint unique datalist IDs per panel
  let datalistCounter = 0;

  // Collapse runs of single letters separated by spaces ("C l e r i c" →
  // "cleric"), then trim/lowercase.
  function squashKey(s) {
    let t = String(s || '').trim();
    if (/^(\s*[a-zA-Z]\s+){2,}[a-zA-Z]\s*$/.test(t)) {
      t = t.replace(/\s+/g, '');
    }
    return t.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function normalizeClass(rawName) {
    const k = squashKey(rawName);
    if (!k) return null;
    if (CLASS_ALIASES[k]) return CLASS_ALIASES[k];
    // Title-case the squashed form so "wizard" / "WIZARD" / "Wizard"
    // collapse to one bucket even without an explicit alias. Only
    // uppercase letters that follow whitespace or are at the very
    // start — NOT `\b\w`, which also matches after apostrophes and
    // would turn "sha'ir" into "Sha'Ir" (breaking the canonical
    // lookup for Sha'ir, M'jhal, etc.).
    return k.replace(/(^|\s)(\w)/g, (m, sep, c) => sep + c.toUpperCase());
  }

  // Composite spell lists — casters whose "list" is a union of other
  // classes' lists rather than their own tagged entries in
  // spell_class_level. The picker resolves these by querying all
  // listed source classes at the given level.
  //
  // Sha'ir (Dragon Compendium): Sor/Wiz list + 9 elemental/conceptual
  // domain lists (Air, Chaos, Earth, Fire, Knowledge, Law, Luck,
  // Sun, Water). The class itself has no entries in spell_class_level.
  //
  // Add more composite casters here as they come up. The values are
  // raw class_name strings as they appear in spell_class_level.
  const COMPOSITE_LISTS = {
    "Sha'ir": [
      'Sorcerer', 'Wizard',
      'Air', 'Chaos', 'Earth', 'Fire',
      'Knowledge', 'Law', 'Luck', 'Sun', 'Water',
    ],
  };

  function buildCanonicalMap() {
    const rows = DB.query("SELECT DISTINCT class_name FROM spell_class_level");
    canonical = new Map();
    for (const r of rows) {
      if (!r.class_name) continue;
      const norm = normalizeClass(r.class_name);
      if (!norm) continue;
      if (!canonical.has(norm)) canonical.set(norm, []);
      canonical.get(norm).push(r.class_name);
    }
    // Layer in composite-list casters whose spell list is the union
    // of other classes' lists. We map each composite name to ALL the
    // source class names so spellsFor() picks them up.
    for (const [compositeName, sources] of Object.entries(COMPOSITE_LISTS)) {
      canonical.set(compositeName, sources.slice());
    }
    classNamesSorted = [...canonical.keys()].sort((a, b) => a.localeCompare(b));
    console.log(`[spell-picker] indexed ${rows.length} raw class entries → ` +
      `${classNamesSorted.length} canonical classes ` +
      `(incl. ${Object.keys(COMPOSITE_LISTS).length} composite)`);
  }

  function spellsFor(canonicalName, level) {
    const variants = canonical.get(canonicalName);
    if (!variants || !variants.length) return [];
    const placeholders = variants.map(() => '?').join(',');
    // Order 3.5 rows first, then newest publication date, so the
    // case-insensitive dedup picks the canonical 3.5 form (e.g.
    // Spell Compendium "Cure Light Wounds" wins over PHB if both
    // exist, since SC is newer).
    return DB.query(
      "SELECT DISTINCT e.id AS spell_id, e.name, e.school, e.version, " +
      "       e.source, b.publication_date " +
      "FROM entry e JOIN spell_class_level scl ON e.id = scl.entry_id " +
      "LEFT JOIN book b ON b.name = e.source " +
      "WHERE e.type = 'spell' " +
      `AND scl.class_name IN (${placeholders}) AND scl.level = ? ` +
      "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, " +
      "         b.publication_date DESC, " +
      "         e.name COLLATE NOCASE",
      [...variants, level]
    );
  }

  // Look up a spell's level in a specific class's spell list. The
  // picker's `.sp-level` input is a FILTER for the autocomplete list,
  // not the routing destination — if the user types a spell name
  // directly (without first filtering by level), the level input
  // stays at its default 0 and the spell would route to L0 known /
  // prepared regardless of its actual level. This helper resolves the
  // canonical level by joining through `spell_class_level`. Returns
  // null when the spell isn't on the class's list (e.g. user picked
  // Cleric class but typed a Sor/Wiz-only spell).
  function spellLevelForClass(spellName, canonicalClassName) {
    if (!spellName || !canonicalClassName) return null;
    const variants = canonical.get(canonicalClassName);
    if (!variants || !variants.length) return null;
    const placeholders = variants.map(() => '?').join(',');
    const r = DB.queryOne(
      "SELECT scl.level AS lvl FROM entry e " +
      "JOIN spell_class_level scl ON scl.entry_id = e.id " +
      "WHERE e.type = 'spell' AND e.name = ? COLLATE NOCASE " +
      `AND scl.class_name IN (${placeholders}) ` +
      "ORDER BY scl.level ASC LIMIT 1",
      [spellName, ...variants]
    );
    if (!r || r.lvl === null || r.lvl === undefined) return null;
    const n = parseInt(r.lvl, 10);
    return isNaN(n) ? null : n;
  }

  // Return all class-level mappings for a spell, formatted as
  // "Sor/Wiz 3, Fire 3, Destruction 4" etc. — same shape commonly
  // printed in source books. Used by the picker's info panel so the
  // user can see what level a spell IS for whatever class they care
  // about, not just the one filter-selected.
  function allClassLevelsForSpell(spellName) {
    if (!spellName) return [];
    const rows = DB.query(
      "SELECT scl.class_name AS cls, scl.level AS lvl " +
      "FROM entry e JOIN spell_class_level scl ON scl.entry_id = e.id " +
      "WHERE e.type = 'spell' AND e.name = ? COLLATE NOCASE " +
      "ORDER BY scl.level, scl.class_name",
      [spellName]
    );
    if (!rows.length) return [];
    // Group by level, normalize/dedupe class names within a level.
    // Collapse Sorcerer + Wizard at the same level → "Sor/Wiz".
    const byLevel = new Map();
    for (const r of rows) {
      const norm = normalizeClass(r.cls) || r.cls;
      const lvl = parseInt(r.lvl, 10);
      if (isNaN(lvl)) continue;
      if (!byLevel.has(lvl)) byLevel.set(lvl, new Set());
      byLevel.get(lvl).add(norm);
    }
    const out = [];
    for (const [lvl, classSet] of [...byLevel].sort((a, b) => a[0] - b[0])) {
      // Sor/Wiz combined display when both at the same level.
      let names = [...classSet];
      const hasSorc = names.some(n => /^sorcerer$/i.test(n));
      const hasWiz  = names.some(n => /^wizard$/i.test(n));
      if (hasSorc && hasWiz) {
        names = names.filter(n => !/^(sorcerer|wizard)$/i.test(n));
        names.unshift('Sor/Wiz');
      }
      // Sort alphabetically with Sor/Wiz first if present.
      names.sort((a, b) => {
        if (a === 'Sor/Wiz') return -1;
        if (b === 'Sor/Wiz') return 1;
        return a.localeCompare(b);
      });
      for (const n of names) out.push(`${n} ${lvl}`);
    }
    return out;
  }

  function spellByName(name) {
    // Case-insensitive match so "Fireball" matches both 3.5 "Fireball"
    // and 3.0 "FIREBALL"; 3.5 wins via the ORDER BY, then newest book.
    return DB.queryOne(
      "SELECT e.id AS spell_id, e.name, e.source, e.version, "
      + "e.school, e.subschool, e.descriptor, "
      + "json_extract(e.data, '$.components')        AS components, "
      + "json_extract(e.data, '$.casting_time')      AS casting_time, "
      + "json_extract(e.data, '$.range')             AS range, "
      + "json_extract(e.data, '$.target')            AS target, "
      + "json_extract(e.data, '$.area')              AS area, "
      + "json_extract(e.data, '$.effect')            AS effect, "
      + "json_extract(e.data, '$.duration')          AS duration, "
      + "json_extract(e.data, '$.saving_throw')      AS saving_throw, "
      + "json_extract(e.data, '$.spell_resistance')  AS spell_resistance, "
      + "json_extract(e.data, '$.description')       AS description "
      + "FROM entry e "
      + "LEFT JOIN book b ON b.name = e.source "
      + "WHERE e.type = 'spell' AND e.name = ? COLLATE NOCASE "
      + "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, "
      + "         b.publication_date DESC LIMIT 1",
      [name]
    );
  }

  // Append `entry` as its own line to `textarea`, skipping if an
  // exact-trimmed-equals match already exists. Triggers the input event
  // so spell counters update.
  function appendLine(textarea, entry) {
    if (!textarea) return false;
    // Prepared lists routinely contain duplicates — wizards prepare
    // Fireball ×3, etc. — and metamagicked entries differ from their
    // base spell only by a `[suffix]`, so dedup-by-name would be
    // actively wrong. Just append.
    const existing = String(textarea.value || '').replace(/\s+$/, '');
    textarea.value = existing ? `${existing}\n${entry}` : entry;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function buildSharedClassDatalist() {
    let dl = document.getElementById('spell-picker-class-options');
    if (dl) return dl;
    dl = document.createElement('datalist');
    dl.id = 'spell-picker-class-options';
    for (const c of classNamesSorted) {
      const opt = document.createElement('option');
      opt.value = c;
      dl.appendChild(opt);
    }
    document.body.appendChild(dl);
    return dl;
  }

  // Tag → Set<spell_id> + counts for fast filtering.
  const spellTagIndex = new Map();
  const spellTagCounts = new Map();
  let spellTagsBuilt = false;

  function buildSpellTagIndex() {
    if (spellTagsBuilt) return;
    spellTagsBuilt = true;
    const rows = DB.query(
      "SELECT t.tag, t.entry_id FROM tag t "
      + "JOIN entry e ON e.id = t.entry_id WHERE e.type = 'spell'"
    );
    for (const r of rows) {
      if (!spellTagIndex.has(r.tag)) spellTagIndex.set(r.tag, new Set());
      spellTagIndex.get(r.tag).add(r.entry_id);
      spellTagCounts.set(r.tag, (spellTagCounts.get(r.tag) || 0) + 1);
    }
  }

  function injectPicker(panel) {
    if (!panel || panel.querySelector('.spell-picker')) return;
    const tabsEl = panel.querySelector('.spell-list-tabs');
    if (!tabsEl) return; // panel not ready yet

    buildSharedClassDatalist();
    buildSpellTagIndex();

    const dlId = `spell-picker-spells-${++datalistCounter}`;
    // Top tags only — keep the dropdown tractable. Alphabetical so
    // the user can scan to a specific tag (Compulsion / Fear / etc.)
    // rather than scrubbing past whatever happens to be most common.
    // Counts stay in the option label as `(N)` for relative-size cues.
    const sortedTags = [...spellTagCounts.entries()]
      .filter(([, c]) => c >= 20)
      .sort((a, b) => a[0].localeCompare(b[0]));
    const wrap = document.createElement('div');
    wrap.className = 'spell-picker';
    wrap.style.cssText =
      'padding:0.5rem; margin-bottom:0.5rem; ' +
      'background:rgba(255,255,255,0.04); border-left:3px solid #8a6a8a; ' +
      'border-radius:3px;';
    wrap.innerHTML = `
      <div style="display:flex;gap:0.4rem;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="flex:1 1 10rem;min-width:8rem">
          <label>Class</label>
          <input type="text" class="sp-class" list="spell-picker-class-options"
                 placeholder="e.g. Wizard" autocomplete="off">
        </div>
        <div class="field field-sm" style="width:5rem">
          <label>Level</label>
          <input type="text" class="sp-level" value=""
                 placeholder="0-9 or <=N"
                 title="Exact level (e.g. 3) or range (<=3, >=2, <5).&#10;Leave empty for all levels.">
        </div>
        <div class="field" style="flex:1 1 8rem;min-width:7rem">
          <label>Tag</label>
          <select class="sp-tag">
            <option value="">Any tag</option>
            ${sortedTags.map(([t, c]) =>
              `<option value="${escapeHtml(t)}">${escapeHtml(t)} (${c})</option>`
            ).join('')}
          </select>
        </div>
        <div class="field" style="flex:2 1 14rem;min-width:12rem">
          <label>Spell</label>
          <input type="text" class="sp-spell" list="${dlId}"
                 placeholder="(pick class + level first)" autocomplete="off">
          <datalist id="${dlId}"></datalist>
        </div>
        <button type="button" class="btn-add sp-add-known"
                title="Add to Known/Available list at the picker level">
          + Known
        </button>
        <button type="button" class="btn-add sp-add-prep"
                title="Add to Prepared list at the picker level">
          + Prepared
        </button>
      </div>
      <div class="sp-metamagic" style="display:none;margin-top:0.4rem;
                                       padding-top:0.4rem;
                                       border-top:1px dashed rgba(255,255,255,0.1);
                                       font-size:0.85em">
        <span style="opacity:0.8;margin-right:0.4rem">Metamagic:</span>
        <span class="sp-mm-options" style="display:inline-flex;flex-wrap:wrap;gap:0.5rem"></span>
        <span class="sp-mm-effective" style="margin-left:0.5rem;opacity:0.85"></span>
      </div>
      <div class="sp-results"
           style="display:none;margin-top:0.5rem;font-size:0.85em">
      </div>
      <div class="sp-info"
           style="display:none;font-size:0.85em;color:#ccc;margin-top:0.4rem">
      </div>
    `;
    tabsEl.parentElement.insertBefore(wrap, tabsEl);

    wirePicker(panel, wrap, dlId);
  }

  function wirePicker(panel, picker, dlId) {
    const classInput = picker.querySelector('.sp-class');
    const levelInput = picker.querySelector('.sp-level');
    const tagSelect  = picker.querySelector('.sp-tag');
    const spellInput = picker.querySelector('.sp-spell');
    const info       = picker.querySelector('.sp-info');
    const addKnown   = picker.querySelector('.sp-add-known');
    const addPrep    = picker.querySelector('.sp-add-prep');
    const datalist   = picker.querySelector(`#${dlId}`);
    const mmWrap     = picker.querySelector('.sp-metamagic');
    const mmOpts     = picker.querySelector('.sp-mm-options');
    const mmEff      = picker.querySelector('.sp-mm-effective');

    let currentSpells = []; // last filter result, by lowercase name
    let currentByName = new Map();

    // Parse the level filter expression. Supports:
    //   ""           → no level constraint
    //   "3"          → exact level 3
    //   "<=3" / "≤3" → level ≤ 3 (cantrips through 3)
    //   "<3"         → level < 3 (cantrips, 1st, 2nd)
    //   ">=2" / "≥2" → level ≥ 2
    //   ">2"         → level > 2
    // Returns {min, max} both inclusive, OR null for no constraint.
    // The level-X-and-below feature is what the user asks for most often
    // ("show me all Cleric spells level 3 and under so I can pick which
    // to memorize") so we support it as a first-class input format.
    function parseLevelFilter(raw) {
      const s = String(raw || '').trim().replace(/\s+/g, '');
      if (!s) return null;
      // Match operator + number. Recognize Unicode ≤ ≥ for power users.
      const m = s.match(/^(<=|>=|<|>|≤|≥|=)?\s*(\d{1,2})$/);
      if (!m) return null;
      const op = m[1] || '=';
      const n = parseInt(m[2], 10);
      if (isNaN(n)) return null;
      switch (op) {
        case '<':  return { min: 0, max: n - 1 };
        case '<=': case '≤': return { min: 0, max: n };
        case '>':  return { min: n + 1, max: 9 };
        case '>=': case '≥': return { min: n, max: 9 };
        case '=':  default:  return { min: n, max: n };
      }
    }

    function refreshSpellList() {
      const cls = normalizeClass(classInput.value);
      const lvlFilter = parseLevelFilter(levelInput.value);
      const tag = tagSelect.value;
      const tagSet = tag ? spellTagIndex.get(tag) : null;
      datalist.innerHTML = '';
      currentSpells = [];
      currentByName = new Map();
      // If neither class nor level nor tag is set, fall back to the
      // global #spell-options datalist (full DB autocomplete) — matches
      // the UX of the other pickers and lets a user type a spell name
      // directly without first narrowing.
      const haveFilter = (cls && canonical.has(cls)) || lvlFilter || tagSet;
      if (!haveFilter) {
        spellInput.setAttribute('list', 'spell-options');
        const globalDl = document.getElementById('spell-options');
        const total = globalDl ? globalDl.children.length : 0;
        spellInput.placeholder = total
          ? `(${total} spells — set class / level / tag to narrow)`
          : '(pick class + level first)';
        renderResults();
        updateInfoPanel();
        return;
      }
      // Filter is set — use the per-instance filtered datalist.
      spellInput.setAttribute('list', dlId);
      // Build the candidate list. Class+level path uses spellsFor (fast,
      // indexed via spell_class_level). Class-only / level-only / tag-only
      // paths union across all (class, level) rows passing the filter.
      let candidates = [];
      if (cls && canonical.has(cls) && lvlFilter && lvlFilter.min === lvlFilter.max) {
        // Exact level + class — the indexed fast path.
        candidates = spellsFor(cls, lvlFilter.min);
      } else if (cls && canonical.has(cls)) {
        // Class set but level is a range or absent — union the per-level
        // results across the filter range (or 0..9 if absent).
        const lo = lvlFilter ? lvlFilter.min : 0;
        const hi = lvlFilter ? lvlFilter.max : 9;
        const seenIds = new Set();
        for (let l = lo; l <= hi; l++) {
          for (const s of spellsFor(cls, l)) {
            if (seenIds.has(s.spell_id)) continue;
            seenIds.add(s.spell_id);
            candidates.push(s);
          }
        }
      } else if (lvlFilter) {
        // No class set, but level (or range) is — query all spells with
        // any class-level mapping in range. Spell may appear multiple
        // times if it has multiple class entries; the case-insensitive
        // dedup below collapses those.
        candidates = DB.query(
          "SELECT DISTINCT e.id AS spell_id, e.name, e.school, e.version, " +
          "       e.source, b.publication_date " +
          "FROM entry e JOIN spell_class_level scl ON e.id = scl.entry_id " +
          "LEFT JOIN book b ON b.name = e.source " +
          "WHERE e.type = 'spell' AND scl.level BETWEEN ? AND ? " +
          "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, " +
          "         b.publication_date DESC, e.name COLLATE NOCASE",
          [lvlFilter.min, lvlFilter.max]
        );
      } else if (tagSet) {
        // Tag only — pull every spell with that tag (no level filter).
        // tagSet is a Set of spell entry IDs, so query by id.
        const ids = Array.from(tagSet);
        if (ids.length) {
          const placeholders = ids.map(() => '?').join(',');
          candidates = DB.query(
            "SELECT e.id AS spell_id, e.name, e.school, e.version, " +
            "       e.source, b.publication_date " +
            "FROM entry e LEFT JOIN book b ON b.name = e.source " +
            `WHERE e.type = 'spell' AND e.id IN (${placeholders}) ` +
            "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, " +
            "         b.publication_date DESC, e.name COLLATE NOCASE",
            ids
          );
        }
      }
      currentSpells = candidates;
      // Dedupe by case-insensitive name; prefer 3.5 over 3.0 since the
      // ORDER BY in spellsFor puts 3.5 rows first. Apply tag + book filters.
      for (const s of currentSpells) {
        if (tagSet && !tagSet.has(s.spell_id)) continue;
        if (window.BookFilter && !window.BookFilter.allowsEntry({...s, type: 'spell'})) continue;
        const k = s.name.toLowerCase();
        if (currentByName.has(k)) continue;
        currentByName.set(k, s);
        const opt = document.createElement('option');
        opt.value = s.name;
        // No opt.label — Firefox renders it as visible suggestion text.
        datalist.appendChild(opt);
      }
      const n = currentByName.size;
      const suffix = tag ? ` (tag:${tag})` : '';
      const lvlLabel = lvlFilter
        ? (lvlFilter.min === lvlFilter.max
            ? `${lvlFilter.min}`
            : (lvlFilter.min === 0 ? `≤${lvlFilter.max}`
                : (lvlFilter.max === 9 ? `≥${lvlFilter.min}`
                    : `${lvlFilter.min}-${lvlFilter.max}`)))
        : 'any';
      const clsLabel = (cls && canonical.has(cls)) ? cls : 'any';
      spellInput.placeholder =
        n
          ? `${n} ${clsLabel} ${lvlLabel} spell${n === 1 ? '' : 's'}${suffix}`
          : `(no ${clsLabel} ${lvlLabel} spells${suffix})`;
      renderResults();
      refreshTagCounts();
      updateInfoPanel();
    }

    // Recompute the tag dropdown's per-tag counts based on the current
    // class + level + spell-name filter set (deliberately ignoring the
    // tag dropdown itself — otherwise picking a tag would zero out
    // every other option's count, which is the opposite of useful).
    // Lets the user see at a glance "if I switch to Wizard L3, 14
    // spells have the fire tag, 6 have ice, 22 have evocation...".
    //
    // Implementation: walks the candidate spells (computed by
    // refreshSpellList's class/level path OR the global pool when no
    // class/level filter is set), intersects each tag's id-set with
    // the candidate ids, and rewrites the option labels in place.
    // Cheap: ~100 tags × O(|tag-set| ∩ |candidates|) — runs in <1ms
    // for the typical Wizard-L3 case.
    function refreshTagCounts() {
      const cls = normalizeClass(classInput.value);
      const lvlFilter = parseLevelFilter(levelInput.value);
      const typedRaw = spellInput.value.trim();
      const typed = typedRaw.toLowerCase();
      const haveFilter = (cls && canonical.has(cls)) || lvlFilter || typed
                       || (window.BookFilter && window.BookFilter.isActive());

      // No filter at all → restore the global counts the dropdown was
      // built with. Skip the per-tag re-count work entirely.
      if (!haveFilter) {
        for (const opt of tagSelect.querySelectorAll('option')) {
          if (!opt.value) continue;
          const n = spellTagCounts.get(opt.value) || 0;
          opt.textContent = `${opt.value} (${n})`;
        }
        return;
      }

      // Build the spell-id set the user is currently browsing —
      // class + level + name + book filter, BUT NOT the tag filter.
      // We reuse refreshSpellList's candidate-fetch branches; the
      // only difference is that we don't apply the tag filter to the
      // results and we DO apply the typed-name filter.
      const baseIds = computeCandidateIds(
        { ignoreTag: true, applyName: true });

      // Update each option's text label with the new count.
      for (const opt of tagSelect.querySelectorAll('option')) {
        if (!opt.value) continue;
        const idSet = spellTagIndex.get(opt.value);
        if (!idSet) {
          opt.textContent = `${opt.value} (0)`;
          continue;
        }
        // Iterate over the smaller side for the intersection — tag
        // sets are typically smaller (~50-500 spells) than the
        // class+level base set (~100-3500).
        let n = 0;
        const [smaller, larger] = idSet.size <= baseIds.size
          ? [idSet, baseIds] : [baseIds, idSet];
        for (const id of smaller) if (larger.has(id)) n++;
        opt.textContent = `${opt.value} (${n})`;
      }
    }

    // Shared helper: returns the set of spell ids matching the
    // current filters with optional knobs.  Used by both
    // refreshSpellList (full filter) and refreshTagCounts (skips the
    // tag filter so the dropdown can show counts for OTHER tags).
    function computeCandidateIds(opts) {
      const ignoreTag = opts && opts.ignoreTag;
      const applyName = opts && opts.applyName;
      const cls = normalizeClass(classInput.value);
      const lvlFilter = parseLevelFilter(levelInput.value);
      const tag = ignoreTag ? '' : tagSelect.value;
      const tagSet = tag ? spellTagIndex.get(tag) : null;
      const typedRaw = spellInput.value.trim();
      const typed = applyName ? typedRaw.toLowerCase() : '';

      let candidates = [];
      if (cls && canonical.has(cls) && lvlFilter && lvlFilter.min === lvlFilter.max) {
        candidates = spellsFor(cls, lvlFilter.min);
      } else if (cls && canonical.has(cls)) {
        const lo = lvlFilter ? lvlFilter.min : 0;
        const hi = lvlFilter ? lvlFilter.max : 9;
        const seenIds = new Set();
        for (let l = lo; l <= hi; l++) {
          for (const s of spellsFor(cls, l)) {
            if (seenIds.has(s.spell_id)) continue;
            seenIds.add(s.spell_id);
            candidates.push(s);
          }
        }
      } else if (lvlFilter) {
        candidates = DB.query(
          "SELECT DISTINCT e.id AS spell_id, e.name, e.source, " +
          "       e.version, b.publication_date " +
          "FROM entry e JOIN spell_class_level scl ON e.id = scl.entry_id " +
          "LEFT JOIN book b ON b.name = e.source " +
          "WHERE e.type = 'spell' AND scl.level BETWEEN ? AND ? " +
          "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, " +
          "         b.publication_date DESC, e.name COLLATE NOCASE",
          [lvlFilter.min, lvlFilter.max]
        );
      } else if (tagSet && !ignoreTag) {
        const ids = Array.from(tagSet);
        if (ids.length) {
          const placeholders = ids.map(() => '?').join(',');
          candidates = DB.query(
            "SELECT e.id AS spell_id, e.name, e.source, " +
            "       e.version, b.publication_date " +
            "FROM entry e LEFT JOIN book b ON b.name = e.source " +
            `WHERE e.type = 'spell' AND e.id IN (${placeholders}) ` +
            "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, " +
            "         b.publication_date DESC, e.name COLLATE NOCASE",
            ids
          );
        }
      } else if (typed && ignoreTag) {
        // Tag-count case with only a name filter: scan all spells.
        // The global spell-options datalist isn't a usable spell-id
        // source, so query the DB.  Cap to a reasonable result count
        // — the user is going to keep typing anyway.
        candidates = DB.query(
          "SELECT e.id AS spell_id, e.name, e.source, e.version " +
          "FROM entry e WHERE e.type = 'spell' " +
          "  AND LOWER(e.name) LIKE ? LIMIT 2000",
          [`%${typed}%`]
        );
      }

      const baseIds = new Set();
      const seen = new Set();
      for (const s of candidates) {
        if (tagSet && !tagSet.has(s.spell_id)) continue;
        if (window.BookFilter && !window.BookFilter.allowsEntry(
              { ...s, type: 'spell' })) continue;
        if (typed && !s.name.toLowerCase().includes(typed)) continue;
        // Dedupe — multi-class spells appear once per class.
        if (seen.has(s.spell_id)) continue;
        seen.add(s.spell_id);
        baseIds.add(s.spell_id);
      }
      return baseIds;
    }

    // Render the current matches as a clickable result list below the
    // search row. Without this, the user gets only the datalist
    // autocomplete (which requires typing); the result list shows
    // everything matching the filter even before they type. The user
    // can click a result to load it into the spell input + info panel.
    function renderResults() {
      const resultsEl = picker.querySelector('.sp-results');
      if (!resultsEl) return;
      // Filter the chip list by the typed spell name (case-insensitive
      // substring match), so the chips track what the user is actually
      // looking for. Without this, the chip wall sat between the picker
      // inputs and the info panel showing whatever spell the user
      // ultimately typed — making the picker awkward to use as a
      // narrowing-down tool.
      const typedRaw = spellInput.value.trim();
      const typed = typedRaw.toLowerCase();
      const allNames = Array.from(currentByName.keys())
        .map(k => currentByName.get(k).name)
        .sort((a, b) => a.localeCompare(b));
      const names = typed
        ? allNames.filter(n => n.toLowerCase().includes(typed))
        : allNames;
      if (names.length === 0) {
        // If the typed name filter killed every match, surface that
        // explicitly rather than hiding the panel (so the user knows
        // they're filtering, not that nothing matches the class/level).
        if (typed && allNames.length > 0) {
          resultsEl.innerHTML =
            `<div style="opacity:0.7">${allNames.length} match` +
            `${allNames.length === 1 ? '' : 'es'} from filter — none ` +
            `contain "${escapeHtml(typedRaw)}". Clear or shorten the ` +
            `spell-name field to widen.</div>`;
          resultsEl.style.display = 'block';
          return;
        }
        resultsEl.style.display = 'none';
        resultsEl.innerHTML = '';
        return;
      }
      // Cap at 100 to keep the DOM lean. The full count is shown in the
      // header so the user knows there's more if they narrow further.
      const cap = 100;
      const shown = names.slice(0, cap);
      const truncated = names.length > cap;
      const chipStyle = 'display:inline-block;padding:0.18rem 0.5rem;' +
        'margin:0.12rem;border:1px solid rgba(255,255,255,0.18);' +
        'border-radius:3px;background:rgba(255,255,255,0.04);' +
        'color:#cde;cursor:pointer;font-size:0.85em;line-height:1.2;' +
        'font-family:inherit';
      const chips = shown.map(n =>
        `<button type="button" class="sp-result-chip" style="${chipStyle}" ` +
        `data-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`
      ).join('');
      const matchSuffix = typed
        ? ` containing &quot;${escapeHtml(typedRaw)}&quot;`
        : '';
      const header = truncated
        ? `<div style="opacity:0.7;margin-bottom:0.25rem">Showing ${cap} of ${names.length} matches${matchSuffix} — narrow further to see more</div>`
        : `<div style="opacity:0.7;margin-bottom:0.25rem">${names.length} match${names.length === 1 ? '' : 'es'}${matchSuffix}</div>`;
      resultsEl.innerHTML = header + `<div>${chips}</div>`;
      resultsEl.style.display = 'block';
    }

    function updateInfoPanel() {
      const typed = spellInput.value.trim();
      if (!typed) { info.style.display = 'none'; info.innerHTML = ''; return; }
      // Look up by typed name (prefer current filter, fall back to any spell).
      let s = currentByName.get(typed.toLowerCase());
      if (!s) s = spellByName(typed);
      if (!s) { info.style.display = 'none'; info.innerHTML = ''; return; }
      // Pull the full record for richer info if we only got a stub.
      const full = (s.description !== undefined) ? s : spellByName(s.name);
      const bits = [];
      // Title line: bold name + VersionBadge (3.0 pill only renders
      // for non-3.5 entries) + source attribution. Replaces the old
      // inline "(3.5)" tag, which blended in and led to the
      // Dimensional Lock confusion (2026-05-19).
      const verBadge = (window.VersionBadge ? VersionBadge.html(full.version) : '');
      const srcSuffix = full.source ? ` <span style="opacity:.7; font-size:0.9em">— ${escapeHtml(full.source)}</span>` : '';
      bits.push(`<b>${escapeHtml(full.name)}</b>${verBadge}${srcSuffix}`);
      // Show every class/level mapping (e.g. "Sor/Wiz 3, Fire 3").
      // The picker's class+level filter is just one slice; the
      // info panel should give the player the full picture.
      const classLevels = allClassLevelsForSpell(full.name);
      if (classLevels.length) {
        bits.push(`<b>Level:</b> ${escapeHtml(classLevels.join(', '))}`);
      }
      if (full.school) {
        // Canonical 3.5 book form: "School (Subschool) [Descriptor]" —
        // subschool in parens, descriptor in brackets. Matches how
        // every printed sourcebook lays out the spell header line, and
        // matches the universal lookup modal's rendering.
        let schoolLine = escapeHtml(full.school);
        if (full.subschool) schoolLine += ` (${escapeHtml(full.subschool)})`;
        if (full.descriptor) schoolLine += ` [${escapeHtml(full.descriptor)}]`;
        bits.push(`<b>School:</b> ${schoolLine}`);
      }
      if (full.components)    bits.push(`<b>Components:</b> ${escapeHtml(full.components)}`);
      if (full.casting_time)  bits.push(`<b>Cast:</b> ${escapeHtml(full.casting_time)}`);
      if (full.range)         bits.push(`<b>Range:</b> ${escapeHtml(full.range)}`);
      // Target / Effect / Area — per PHB spell-block convention these
      // sit between Range and Duration. RAW each spell uses exactly
      // ONE of the three (mutually exclusive), but render all that are
      // present so the picker handles legitimate edge cases (e.g.
      // teleportation circles that print both Target and Effect).
      if (full.target)        bits.push(`<b>Target:</b> ${escapeHtml(full.target)}`);
      if (full.effect)        bits.push(`<b>Effect:</b> ${escapeHtml(full.effect)}`);
      if (full.area)          bits.push(`<b>Area:</b> ${escapeHtml(full.area)}`);
      if (full.duration)      bits.push(`<b>Duration:</b> ${escapeHtml(full.duration)}`);
      if (full.saving_throw)  bits.push(`<b>Save:</b> ${escapeHtml(full.saving_throw)}`);
      if (full.spell_resistance) bits.push(`<b>SR:</b> ${escapeHtml(full.spell_resistance)}`);
      // Description (rules text) on its own line below the meta strip.
      let html = bits.join(' &nbsp;·&nbsp; ');
      if (full.description) {
        html += `<div class="sp-info-desc" style="margin-top:0.4rem;` +
                `line-height:1.4">${escapeHtml(full.description)}</div>`;
      }
      info.innerHTML = html;
      if (window.ErrataBadge) ErrataBadge.attach(info, full.spell_id);
      info.style.display = 'block';
    }

    classInput.addEventListener('input', refreshSpellList);
    levelInput.addEventListener('input', refreshSpellList);
    levelInput.addEventListener('input', refreshMetamagicRow);
    tagSelect.addEventListener('change', refreshSpellList);
    spellInput.addEventListener('input', updateInfoPanel);
    spellInput.addEventListener('input', renderResults);
    // Tag-count refresh on every spell-name keystroke — lets the user
    // see "as I narrow by name, how many of those still have each tag".
    spellInput.addEventListener('input', refreshTagCounts);
    spellInput.addEventListener('change', updateInfoPanel);
    // Book-filter changes affect the candidate set — re-count tags.
    document.addEventListener('book-filter-changed', refreshTagCounts);

    // Initial paint: ensure the dropdown shows global counts and
    // (when filters are pre-populated from a save load) the
    // class/level-narrowed counts on first render.
    refreshTagCounts();

    // Result-chip clicks: fill the spell input + show the info panel.
    // Event-delegated so chips re-rendered on every refreshSpellList
    // still wire up. The chip carries the spell name in data-name.
    picker.addEventListener('click', (ev) => {
      const chip = ev.target.closest('.sp-result-chip');
      if (!chip) return;
      spellInput.value = chip.dataset.name || chip.textContent;
      updateInfoPanel();
      spellInput.focus();
    });

    // ---- Class auto-detect from caster notes -----------------------
    // The class-picker prefills each spellcasting panel's
    // `.caster-notes` with the class name (e.g. "Sorcerer", "Wizard",
    // "Druid") when "Apply to Sheet" is clicked. Surface that as the
    // picker's default Class filter so the user doesn't have to
    // re-type it. Only fills classInput when it's currently empty —
    // never overrides a manual choice. Re-runs on notes changes.
    function autoDetectClassFromNotes() {
      if (classInput.value.trim()) return;  // user already chose
      const notesEl = panel.querySelector('.caster-notes');
      const raw = (notesEl?.value || '').trim();
      if (!raw) return;
      // Try the first line / first canonical match. Notes may have
      // extra text appended ("Sha'ir — retrieves any Sor/Wiz spell…"),
      // so we walk canonical names and pick the longest one that
      // appears in the notes (longest wins so "Battle Sorcerer" beats
      // "Sorcerer" when both are present).
      const lower = raw.toLowerCase();
      let bestMatch = null;
      for (const name of classNamesSorted) {
        if (lower.includes(name.toLowerCase())) {
          if (!bestMatch || name.length > bestMatch.length) bestMatch = name;
        }
      }
      if (bestMatch) {
        classInput.value = bestMatch;
        classInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    // Initial sniff: the panel's notes may already be set from
    // class-picker apply or save load.
    autoDetectClassFromNotes();
    // Future sniff: re-detect when notes change (user types in the
    // notes field, or class-picker re-applies).
    const notesEl = panel.querySelector('.caster-notes');
    if (notesEl) {
      notesEl.addEventListener('input', autoDetectClassFromNotes);
    }

    // --- Metamagic row -------------------------------------------------
    // Read the character's metamagic feats from the Feats tab, filter
    // against the catalog, and build a checkbox + numeric-input row.
    // Re-runs whenever the picker becomes visible, the base level
    // changes, or feats get added on the Feats tab.
    function readCharacterMetamagicFeats() {
      // Feats live in #feats-container as .feat-entry textareas;
      // each textarea's first line is the feat name (additional
      // lines are notes/details).
      const inputs = document.querySelectorAll('#feats-container .feat-entry');
      const names = [];
      for (const el of inputs) {
        const raw = String(el.value || '').trim();
        if (!raw) continue;
        // Take only the first line as the feat name. Strip a trailing
        // parenthetical ("Quicken Spell (Spec)" → "Quicken Spell").
        const firstLine = raw.split(/\r?\n/)[0].trim();
        const stripped = firstLine.replace(/\s*\([^)]*\)\s*$/, '').trim();
        if (stripped) names.push(stripped);
      }
      // Filter to names that look up successfully in DB (preferred)
      // or the local catalog (fallback for homebrew). DB lookup
      // hits `entry.data.metamagic.level_adjustment`.
      return names.filter(n => lookupMetamagic(n) !== null);
    }

    // Unified metamagic lookup: DB first, JS catalog fallback. Returns
    // `{ levelAdjustment, effect, actionTypeMod, variableTarget? }`
    // or null. Cached per-name to avoid re-querying.
    const _mmLookupCache = new Map();
    function lookupMetamagic(name) {
      const key = String(name || '').trim();
      if (!key) return null;
      if (_mmLookupCache.has(key)) return _mmLookupCache.get(key);
      let result = null;
      if (window.DB && DB.isLoaded()) {
        const row = DB.queryOne(
          "SELECT json_extract(data, '$.metamagic.level_adjustment') AS adj, " +
          "       json_extract(data, '$.metamagic.action_type_mod')   AS act, " +
          "       json_extract(data, '$.metamagic.effect_summary')    AS eff " +
          "FROM entry WHERE type='feat' AND name = :n COLLATE NOCASE " +
          "AND types_csv LIKE '%Metamagic%' LIMIT 1", { ':n': key });
        if (row && row.adj !== null) {
          const adj = row.adj;
          result = {
            levelAdjustment: (adj === 'variable') ? 'variable'
                             : (typeof adj === 'number' ? adj : parseInt(adj, 10)),
            effect: row.eff || '',
            actionTypeMod: row.act || undefined,
            variableTarget: (key === 'Heighten Spell' || key === 'Improved Heighten Spell'),
          };
        }
      }
      // Fall back to the JS catalog (homebrew feats not in DB).
      if (!result && window.MetamagicCatalog && MetamagicCatalog.has(key)) {
        result = MetamagicCatalog.get(key);
      }
      _mmLookupCache.set(key, result);
      return result;
    }

    function refreshMetamagicRow() {
      const feats = readCharacterMetamagicFeats();
      // When the panel has "Show Prepared" turned off (typical for
      // spontaneous casters — Sorcerer/Bard/Sha'ir/etc.), there's
      // nowhere visible for a metamagic-tagged spell to land: + Prepared
      // would still drop it into the (hidden) prepared list, and the
      // user would correctly conclude that "the tickboxes don't do
      // anything". Hide the metamagic row + the + Prepared button
      // entirely in that case so the picker matches what the panel
      // actually shows. The Show-Prepared listener below re-fires
      // this method when the user toggles the column back on.
      const prepHidden = panel.classList.contains('sc-no-prepared');
      addPrep.style.display = prepHidden ? 'none' : '';
      if (!feats.length || prepHidden) {
        mmWrap.style.display = 'none';
        mmOpts.innerHTML = '';
        mmEff.textContent = '';
        return;
      }
      mmWrap.style.display = '';
      // Preserve checkbox/input state across rebuilds so the row stays
      // sticky when the user changes spell level.
      const prevState = collectMetamagicState();
      mmOpts.innerHTML = '';
      for (const featName of feats) {
        const meta = lookupMetamagic(featName);
        if (!meta) continue;
        const label = document.createElement('label');
        label.style.cssText = 'display:inline-flex;align-items:center;gap:0.2rem';
        label.title = meta.effect;
        if (meta.variableTarget) {
          // Heighten Spell — target-level number input next to the
          // checkbox. The checkbox enables it; the number sets target.
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'sp-mm-check';
          cb.dataset.feat = featName;
          cb.dataset.variable = '1';
          const num = document.createElement('input');
          num.type = 'number';
          num.className = 'sp-mm-target';
          num.dataset.feat = featName;
          num.min = '0';
          num.max = '9';
          num.style.cssText = 'width:3.2rem';
          // Restore prior state, with a default target one level up.
          const baseLvl = parseInt(levelInput.value, 10);
          const priorChecked = prevState.checked.has(featName);
          const priorTarget = prevState.targets.get(featName);
          cb.checked = priorChecked;
          num.value = priorTarget !== undefined
            ? priorTarget
            : (isNaN(baseLvl) ? '' : Math.min(9, baseLvl + 1));
          cb.addEventListener('change', recomputeEffective);
          num.addEventListener('input', recomputeEffective);
          label.append(cb, document.createTextNode(' '),
            document.createTextNode(featName), document.createTextNode(' → '),
            num);
        } else {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'sp-mm-check';
          cb.dataset.feat = featName;
          cb.checked = prevState.checked.has(featName);
          cb.addEventListener('change', recomputeEffective);
          const adj = meta.levelAdjustment;
          const adjLabel = (typeof adj === 'number')
            ? ` (+${adj})`
            : ` (±?)`;
          label.append(cb, document.createTextNode(' '),
            document.createTextNode(featName + adjLabel));
        }
        mmOpts.appendChild(label);
      }
      recomputeEffective();
    }

    function collectMetamagicState() {
      const checked = new Set();
      const targets = new Map();
      for (const cb of mmOpts.querySelectorAll('.sp-mm-check')) {
        if (cb.checked) checked.add(cb.dataset.feat);
      }
      for (const num of mmOpts.querySelectorAll('.sp-mm-target')) {
        targets.set(num.dataset.feat, num.value);
      }
      return { checked, targets };
    }

    // Compute the spell's effective level (base + sum of fixed
    // adjustments) plus the Heighten target if active. Returns
    // { effectiveLevel, parts: [{name, delta}], suffixes: [string] }.
    // `baseOverride`, when provided, takes priority over the picker's
    // level input. This is how the +Known / +Prepared buttons feed in
    // the spell's ACTUAL level (resolved via spellLevelForClass)
    // rather than the level-filter input, which may not have been
    // touched. The level filter remains authoritative when no override
    // is supplied — e.g. for the live "Effective level: N" display
    // before the user picks a specific spell.
    function effectiveMetamagic(baseOverride) {
      const base = (typeof baseOverride === 'number' && !isNaN(baseOverride))
        ? baseOverride
        : parseInt(levelInput.value, 10);
      const baseValid = !isNaN(base) && base >= 0;
      const parts = [];
      const suffixes = [];
      let total = baseValid ? base : 0;
      let heightenTarget = null;
      for (const cb of mmOpts.querySelectorAll('.sp-mm-check')) {
        if (!cb.checked) continue;
        const meta = lookupMetamagic(cb.dataset.feat);
        if (!meta) continue;
        if (meta.variableTarget) {
          const num = mmOpts.querySelector(
            `.sp-mm-target[data-feat="${cb.dataset.feat}"]`);
          const t = parseInt(num?.value, 10);
          if (!isNaN(t) && t > base) {
            heightenTarget = Math.max(heightenTarget || 0, t);
            parts.push({ name: cb.dataset.feat, delta: t - base });
            suffixes.push(`Heightened to ${t}`);
          }
        } else if (typeof meta.levelAdjustment === 'number') {
          total += meta.levelAdjustment;
          parts.push({ name: cb.dataset.feat, delta: meta.levelAdjustment });
          // Strip the trailing " Spell" so the bracket suffix reads
          // "Empowered" not "Empower Spell". A few feats don't have
          // that suffix so we fall back to the literal name.
          const tag = featNameToTag(cb.dataset.feat);
          suffixes.push(tag);
        }
      }
      // Heighten target replaces total when higher than the additive.
      if (heightenTarget !== null) {
        total = Math.max(total, heightenTarget);
      }
      return { effectiveLevel: total, base, parts, suffixes, baseValid };
    }

    function recomputeEffective() {
      const r = effectiveMetamagic();
      if (!r.baseValid || r.parts.length === 0) {
        mmEff.textContent = '';
        return;
      }
      mmEff.innerHTML =
        `→ <b>L${r.effectiveLevel}</b> slot ` +
        `<span style="opacity:0.6">(${r.parts
          .map(p => `${p.name} +${p.delta}`).join(', ')})</span>`;
    }

    function featNameToTag(name) {
      // "Empower Spell" → "Empowered"; "Maximize Spell" → "Maximized";
      // most metamagic feats end in " Spell". For odd ones (Sanctum
      // Spell stays as-is; Energy Substitution, etc.) return the name.
      const m = name.match(/^(\w+)\s+Spell$/);
      if (!m) return name;
      const stem = m[1];
      // -ify → -ified (Purify → Purified), -en → -ened, default +ed/+d
      if (stem.endsWith('y'))      return stem.slice(0, -1) + 'ied';   // Purify, …
      if (stem.endsWith('e'))      return stem + 'd';                  // Maximize, Quicken (-en/-ed) handled below
      if (stem.endsWith('en'))     return stem + 'ed';                 // Widen → Widened, Heighten → Heightened
      // Generic regular past participle.
      return stem + 'ed';
    }

    // The metamagic row needs to refresh whenever the user opens or
    // returns to this panel — feats may have been added on the Feats
    // tab in the meantime. Use a focus listener on the picker root
    // plus a document-level listener on #feats-container, plus an
    // initial sweep.
    picker.addEventListener('focusin', refreshMetamagicRow);
    document.addEventListener('input', (e) => {
      if (e.target?.closest?.('#feats-container')) refreshMetamagicRow();
    });
    // When the user flips the panel's Show Prepared toggle on/off, the
    // picker needs to re-evaluate whether to surface + Prepared and
    // the metamagic row. Listen on the panel for the toggle's change
    // event — the toggle is .sc-show-prepared in spells.js.
    const prepToggle = panel.querySelector('.sc-show-prepared');
    if (prepToggle) {
      prepToggle.addEventListener('change', refreshMetamagicRow);
    }
    // Initial render.
    refreshMetamagicRow();

    function flash(msg, color) {
      const note = document.createElement('div');
      note.style.cssText = `margin-top:0.3rem;color:${color};font-style:italic`;
      note.textContent = msg;
      info.appendChild(note);
      info.style.display = 'block';
      setTimeout(() => note.remove(), 3500);
    }

    function add(kind) {
      const name = spellInput.value.trim();
      if (!name) { flash('Pick a spell first.', '#a66'); return; }

      // Resolve the spell's ACTUAL level for the selected class via
      // spell_class_level. The picker's `.sp-level` input is just a
      // filter on the autocomplete list — if the user typed a spell
      // name directly without first setting the level, the input
      // would still be at its default 0 and the spell would route to
      // L0. Fall back to the input value only when the spell isn't
      // on the chosen class's list (homebrew / cross-class typo).
      const className = normalizeClass(classInput.value);
      let baseLvl = spellLevelForClass(name, className);
      const inputLvl = parseInt(levelInput.value, 10);
      if (baseLvl === null && !isNaN(inputLvl)) {
        baseLvl = inputLvl;
      }
      if (baseLvl === null || isNaN(baseLvl)) {
        flash('Could not determine spell level. Pick a class first.', '#a66');
        return;
      }

      // Metamagic ignored for Known — you learn / scribe the base
      // spell. Apply at cast/prep time. Surface a one-shot flash if
      // the user has metamagic ticked + clicks + Known so they don't
      // assume the tickboxes are broken — common confusion path
      // (reported 2026-05-21 against the spell picker).
      if (kind === 'known') {
        const hasTickedMetamagic = mmOpts &&
          mmOpts.querySelector('.sp-mm-check:checked');
        if (hasTickedMetamagic) {
          flash('Metamagic applies at prep / cast time, not when ' +
                'scribing — added base spell. Use "+ Prepared" to ' +
                'lock in a metamagic-ed cast.', '#aa8');
        }
        const target = panel.querySelector(`.sc-known-list[data-lvl="${baseLvl}"]`);
        if (!target) {
          flash(`No level ${baseLvl} list — try Add Spell Level first.`, '#a66');
          return;
        }
        // Skip duplicates — match case-insensitively on existing rows.
        const existing = Array.from(target.querySelectorAll('.sc-known-name'))
          .map(el => (el.value || '').trim().toLowerCase());
        if (existing.includes(name.toLowerCase())) {
          flash(`"${name}" already in L${baseLvl} Known.`, '#aa8');
          return;
        }
        if (typeof Spells !== 'undefined' &&
            typeof Spells.addKnownSpell === 'function') {
          Spells.addKnownSpell(target, baseLvl, name);
        } else {
          const row = document.createElement('div');
          row.className = 'sc-known-row';
          row.innerHTML =
            `<input type="text" class="sc-known-name" value="${name}">`;
          target.appendChild(row);
        }
        flash(`Added "${name}" to L${baseLvl} Known.`, '#7a9');
        return;
      }
      // Prepared path — apply any active metamagic. v2 Phase C
      // structural restructure (2026-05-19): route through
      // Spells.addPreparedSpell so the resulting row carries its
      // metamagic state for later edit/round-trip.
      const r = effectiveMetamagic(baseLvl);
      const lvl = r.parts.length > 0 ? r.effectiveLevel : baseLvl;
      const listEl = panel.querySelector(`.sc-prepared-list[data-lvl="${lvl}"]`);
      if (!listEl) {
        flash(`No level ${lvl} Prepared list — try Add Spell Level first.`, '#a66');
        return;
      }
      if (typeof Spells !== 'undefined' &&
          typeof Spells.addPreparedSpell === 'function') {
        // Build the metamagic-state payload from the checked feats.
        // Heighten target maps from the picker's per-feat target input;
        // Sanctum direction isn't surfaced in the spell-picker (it has
        // no in/out toggle), so default to false (out-of-sanctum = +1).
        const metamagic = r.parts.map(p => p.name);
        let heightenTarget = null;
        for (const cb of mmOpts.querySelectorAll('.sp-mm-check')) {
          if (!cb.checked) continue;
          const meta = lookupMetamagic(cb.dataset.feat);
          if (meta && meta.variableTarget) {
            const num = mmOpts.querySelector(
              `.sp-mm-target[data-feat="${cb.dataset.feat}"]`);
            const t = parseInt(num?.value, 10);
            if (!isNaN(t)) heightenTarget = t;
          }
        }
        Spells.addPreparedSpell(panel, lvl, {
          baseName: name, metamagic, heightenTarget,
          sanctumIn: false, used: false,
        });
      } else {
        // Fallback for the unlikely case Spells.addPreparedSpell isn't
        // available yet — append a row directly.
        const row = document.createElement('div');
        row.className = 'sc-prepared-row';
        row.innerHTML =
          `<input type="checkbox" class="sc-prep-used">` +
          `<input type="text" class="sc-prep-name" value="${name}">`;
        listEl.appendChild(row);
      }
      const entry = r.suffixes.length
        ? `${name} [${r.suffixes.join(', ')}]`
        : name;
      flash(
        r.suffixes.length
          ? `Added "${entry}" to L${lvl} Prepared.`
          : `Added "${entry}" to Prepared.`,
        '#7a9'
      );
    }
    addKnown.addEventListener('click', () => add('known'));
    addPrep .addEventListener('click', () => add('prep'));
  }

  function injectIntoExistingPanels() {
    document
      .querySelectorAll('#spells-content [data-caster-type="spellcasting"]')
      .forEach(injectPicker);
  }

  function watchForNewPanels() {
    const root = document.getElementById('spells-content');
    if (!root) return;
    const obs = new MutationObserver(muts => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.('[data-caster-type="spellcasting"]')) {
            // Defer slightly so spells.js can finish populating innards.
            setTimeout(() => injectPicker(node), 0);
          } else {
            node.querySelectorAll?.('[data-caster-type="spellcasting"]')
                .forEach(p => setTimeout(() => injectPicker(p), 0));
          }
        }
      }
    });
    obs.observe(root, { childList: true, subtree: true });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Global #spell-options datalist with every spell name in the DB.
  // Used by the structured Known list's row inputs (created in
  // spells.js::createKnownRow with `list="spell-options"`) so the
  // user gets autocomplete when typing directly into a row instead
  // of going through the picker bar. Built once at DB.ready; tiny
  // (~2,800 <option> elements ≈ <100 KB).
  function buildGlobalSpellDatalist() {
    // Remove any prior datalist so we can rebuild after a filter change.
    const prior = document.getElementById('spell-options');
    if (prior) prior.remove();
    // 3.5-first dedup by case-insensitive name so we don't emit two
    // "Fireball" options when both 3.0 and 3.5 versions are indexed.
    const rows = DB.query(
      "SELECT e.name AS name, e.source FROM entry e " +
      "LEFT JOIN book b ON b.name = e.source " +
      "WHERE e.type = 'spell' AND e.name IS NOT NULL " +
      "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, " +
      "         b.publication_date DESC, " +
      "         e.name COLLATE NOCASE"
    );
    const seen = new Set();
    const dl = document.createElement('datalist');
    dl.id = 'spell-options';
    for (const r of rows) {
      if (window.BookFilter && !window.BookFilter.allowsEntry({...r, type: 'spell'})) continue;
      const key = String(r.name || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const opt = document.createElement('option');
      opt.value = r.name;
      // No `label` attribute — Firefox renders labels as visible
      // suggestion text in datalists (see CLAUDE.md datalist note).
      dl.appendChild(opt);
    }
    document.body.appendChild(dl);
    console.log(`[spell-picker] built #spell-options datalist with ` +
      `${seen.size} unique spell names`);
  }

  DB.ready.then((db) => {
    if (!db) return;
    buildCanonicalMap();
    buildGlobalSpellDatalist();
    injectIntoExistingPanels();
    watchForNewPanels();
    // On book-filter change, rebuild the global datalist; per-panel
    // pickers are re-evaluated lazily next time the user touches a
    // class/level filter input, so no further refresh is needed.
    document.addEventListener('book-filter-changed',
      () => buildGlobalSpellDatalist());
  });
})();
