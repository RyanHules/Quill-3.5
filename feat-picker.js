// feat-picker.js — Autocomplete feat search + info panel + add button,
// injected into the Feats & Abilities tab above "+ Add Feat".
//
// Data quirks handled:
//   * All feat `name` values in the DB are stored UPPER CASE
//     ("POWER ATTACK"). We Title-Case for display + autocomplete; lookup
//     is case-insensitive so manually-typed "power attack" still finds
//     the row.
//   * Both 3.5 and 3.0 versions exist for many feats (separate rows).
//     Deduped case-insensitively, with 3.5 preferred (as in spell-picker).
//   * `types_csv` is comma-separated and case-fragmented (GENERAL vs
//     General). Normalized to Title Case for the type filter; the filter
//     matches if ANY of the row's types matches the selected one.
//
// UI inserted into #tab-feats (between the Feats section header and
// the "+ Add Feat" button):
//   #feat-lookup           (input)   — feat name autocomplete
//   #feat-lookup-type      (select)  — filter by type (Any / General / Metamagic / …)
//   #feat-lookup-add       (button)  — append to Feats list
//   #feat-info             (div)     — feat detail panel
//   <datalist id="feat-options">     — autocomplete options

(function () {
  if (!window.DB) {
    console.warn('[feat-picker] DB module not loaded');
    return;
  }

  // Title-case "POWER ATTACK" → "Power Attack"; preserve apostrophes,
  // hyphens, and parenthesized clauses ("Mounted Combat (Special)").
  // Lowercase short connectives.
  const SMALL_WORDS = new Set([
    'of', 'the', 'and', 'or', 'a', 'an', 'in', 'on', 'to',
    'for', 'with', 'by', 'at', 'from', 'as', 'is',
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

  // canonicalNameLower → { displayName, primary: row, allRows: [...] }
  let featIndex = new Map();
  // canonical type (Title Case) → { count, raw: [original strings...] }
  let typeIndex = new Map();
  // sorted display names for the datalist
  let displayNames = [];

  function normalizeType(raw) {
    if (!raw) return null;
    const trimmed = String(raw).trim();
    if (!trimmed) return null;
    return titleCase(trimmed);
  }

  // Tag → Set<feat_id> for fast filtering, plus per-tag counts.
  const tagIndex = new Map();
  const tagCounts = new Map();

  function buildTagIndex() {
    const rows = DB.query(
      "SELECT t.tag, t.entry_id FROM tag t "
      + "JOIN entry e ON e.id = t.entry_id "
      + "WHERE e.type IN ('feat', 'acf')"
    );
    for (const r of rows) {
      if (!tagIndex.has(r.tag)) tagIndex.set(r.tag, new Set());
      tagIndex.get(r.tag).add(r.entry_id);
      tagCounts.set(r.tag, (tagCounts.get(r.tag) || 0) + 1);
    }
  }

  function buildIndex() {
    // Query the unified `entry` table. Skill tricks moved out to the
    // Special Abilities picker (2026-05-17) since they're not feats and
    // belong in a different list. ACFs stay here for now — they're a
    // class-feature swap; we'll relocate them to a class-context picker
    // (Class Features tab / class-picker info panel) when that lands.
    // Ties between same-named feats resolve to 3.5 first, then newest
    // publication date.
    const rows = DB.query(
      "SELECT e.id AS feat_id, e.name, e.version, e.types_csv, e.source " +
      "FROM entry e " +
      "LEFT JOIN book b ON b.name = e.source " +
      "WHERE e.type IN ('feat', 'acf') " +
      "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, " +
      "         b.publication_date DESC, " +
      "         e.name COLLATE NOCASE"
    );
    featIndex = new Map();
    typeIndex = new Map();
    for (const r of rows) {
      if (!r.name) continue;
      if (window.BookFilter && !window.BookFilter.allowsEntry({...r, type: 'feat'})) continue;
      const key = r.name.toLowerCase();
      const display = titleCase(r.name);
      if (!featIndex.has(key)) {
        featIndex.set(key, { displayName: display, primary: r, allRows: [r] });
      } else {
        featIndex.get(key).allRows.push(r);
      }
      if (r.types_csv) {
        for (const t of String(r.types_csv).split(/\s*,\s*/)) {
          const norm = normalizeType(t);
          if (!norm) continue;
          if (!typeIndex.has(norm)) typeIndex.set(norm, 0);
          typeIndex.set(norm, typeIndex.get(norm) + 1);
        }
      }
    }
    displayNames = [...featIndex.values()]
      .map(v => v.displayName)
      .sort((a, b) => a.localeCompare(b));
    console.log(`[feat-picker] indexed ${rows.length} feat rows → ` +
      `${featIndex.size} distinct feats, ${typeIndex.size} types`);
  }

  // Returns true iff `entry`'s types include the chosen type (case-
  // insensitive). "" = no filter (Any).
  function matchesType(entry, chosenType) {
    if (!chosenType) return true;
    const raw = entry.primary.types_csv || '';
    return String(raw)
      .split(/\s*,\s*/)
      .map(t => normalizeType(t))
      .some(t => t && t.toLowerCase() === chosenType.toLowerCase());
  }

  function matchesTag(entry, chosenTag) {
    if (!chosenTag) return true;
    const set = tagIndex.get(chosenTag);
    if (!set) return false;
    // Match if ANY versioned row (3.5 or 3.0) has this tag.
    return entry.allRows.some(r => set.has(r.feat_id));
  }

  function refreshDatalist(datalist, chosenType, chosenTag) {
    datalist.innerHTML = '';
    const matchedNames = [];
    for (const display of displayNames) {
      const entry = featIndex.get(display.toLowerCase());
      if (!entry) continue;
      if (!matchesType(entry, chosenType)) continue;
      if (!matchesTag(entry, chosenTag)) continue;
      const opt = document.createElement('option');
      opt.value = display;
      // Don't set opt.label — Firefox renders it as visible suggestion
      // text alongside the value, so a label like "General, Fighter"
      // looks like the completion text rather than metadata. (Same
      // bug we hit on soulmeld-picker.) Feat-type info is already
      // shown in the info panel below.
      datalist.appendChild(opt);
      matchedNames.push(display);
    }
    return matchedNames;
  }

  function fullFeatRow(featId) {
    // The picker uses {prerequisites, benefit, normal, special,
    // description} — all live inside entry.data as JSON.
    const row = DB.queryOne(
      "SELECT id AS feat_id, name, source, version, types_csv, "
      + "json_extract(data, '$.prerequisites') AS prerequisites, "
      + "json_extract(data, '$.benefit')       AS benefit, "
      + "json_extract(data, '$.normal')        AS normal, "
      + "json_extract(data, '$.special')       AS special, "
      + "json_extract(data, '$.description')   AS description "
      + "FROM entry WHERE id = ?", [featId]);
    return row;
  }

  function init() {
    const feats = document.querySelector('#tab-feats .section');
    const addBtn = document.getElementById('btn-add-feat');
    if (!feats || !addBtn) {
      console.warn('[feat-picker] feats UI not found');
      return;
    }
    buildIndex();
    buildTagIndex();

    // Build type-filter options from index. Alphabetical order so the
    // user can scan to a specific type (Fighter / Metamagic / etc.)
    // without scrubbing past whatever happens to be most common. The
    // `(N)` count suffix on each option still surfaces relative size.
    const sortedTypes = [...typeIndex.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]));
    // Top tags only — keep the list tractable (>=5 feats per tag).
    const sortedTags = [...tagCounts.entries()]
      .filter(([, c]) => c >= 5)
      .sort((a, b) => a[0].localeCompare(b[0]));

    const wrap = document.createElement('div');
    wrap.className = 'feat-picker';
    wrap.style.cssText =
      'padding:0.5rem; margin-bottom:0.5rem; ' +
      'background:rgba(255,255,255,0.04); border-left:3px solid #aa8a6a; ' +
      'border-radius:3px;';
    wrap.innerHTML = `
      <div style="display:flex;gap:0.4rem;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="flex:2 1 14rem;min-width:12rem">
          <label>Feat Lookup</label>
          <input type="text" id="feat-lookup" list="feat-options"
                 placeholder="e.g. Power Attack" autocomplete="off">
          <datalist id="feat-options"></datalist>
        </div>
        <div class="field" style="flex:1 1 8rem;min-width:7rem">
          <label>Type Filter</label>
          <select id="feat-lookup-type">
            <option value="">Any type</option>
            ${sortedTypes.map(([t, c]) =>
              `<option value="${t}">${t} (${c})</option>`
            ).join('')}
          </select>
        </div>
        <div class="field" style="flex:1 1 8rem;min-width:7rem">
          <label>Tag Filter</label>
          <select id="feat-lookup-tag">
            <option value="">Any tag</option>
            ${sortedTags.map(([t, c]) =>
              `<option value="${t}">${t} (${c})</option>`
            ).join('')}
          </select>
        </div>
        <button type="button" id="feat-lookup-add" class="btn-add"
                style="height:2rem">+ Add to Feats</button>
      </div>
      <div id="feat-info"
           style="display:none;font-size:0.85em;color:#ccc;margin-top:0.4rem">
      </div>
    `;
    addBtn.parentElement.insertBefore(wrap, addBtn);

    const featInput = document.getElementById('feat-lookup');
    const typeSelect = document.getElementById('feat-lookup-type');
    const tagSelect = document.getElementById('feat-lookup-tag');
    const addLookupBtn = document.getElementById('feat-lookup-add');
    const info = document.getElementById('feat-info');
    const datalist = document.getElementById('feat-options');

    // Shared browsing-chip helper — surfaces the current filter's
    // matches as a click-to-pick chip wall below the picker bar.
    // See picker-results.js for the rendering contract.
    //
    // Chip click: set value + show info DIRECTLY, but don't dispatch
    // 'input' — the input event would re-narrow the chip wall to the
    // picked entry. Matches spell-picker's behavior (chip wall stays
    // open after a pick, so the user can scan / re-pick).
    const results = (typeof PickerResults !== 'undefined')
      ? PickerResults.attach(wrap, {
          itemNoun: 'feat',
          onPick: (name) => {
            featInput.value = name;
            updateInfo();
            featInput.focus();
          },
        })
      : null;

    function refreshPlaceholder(n) {
      const parts = [];
      if (typeSelect.value) parts.push(typeSelect.value);
      if (tagSelect.value)  parts.push(`tag:${tagSelect.value}`);
      featInput.placeholder = parts.length
        ? `${n} ${parts.join(' + ')} feat${n === 1 ? '' : 's'}`
        : 'e.g. Power Attack';
    }
    function applyFilters() {
      const names = refreshDatalist(datalist, typeSelect.value, tagSelect.value);
      refreshPlaceholder(names.length);
      if (results) results.render(names, { typedFilter: featInput.value.trim() });
    }

    applyFilters();

    typeSelect.addEventListener('change', applyFilters);
    tagSelect.addEventListener('change', applyFilters);
    // Re-render chips when the user types — substring filter on names
    // so the chip wall tracks what they're looking for.
    featInput.addEventListener('input', applyFilters);

    // Rebuild the index when the active book set changes so the
    // datalist reflects only in-scope sources.
    document.addEventListener('book-filter-changed', () => {
      buildIndex();
      applyFilters();
    });

    function updateInfo() {
      const typed = featInput.value.trim();
      if (!typed) { info.style.display = 'none'; info.innerHTML = ''; return; }
      const entry = featIndex.get(typed.toLowerCase());
      if (!entry) { info.style.display = 'none'; info.innerHTML = ''; return; }
      const full = fullFeatRow(entry.primary.feat_id);
      if (!full) { info.style.display = 'none'; info.innerHTML = ''; return; }

      const bits = [];
      // Title line: bold name + source attribution. Edition pill
      // (3.0 / non-3.5) attaches at the panel root via attach() below.
      const srcSuffix = full.source ? ` <span style="opacity:.7; font-size:0.9em">— ${escapeHtml(full.source)}</span>` : '';
      bits.push(`<b>${escapeHtml(entry.displayName)}</b>${srcSuffix}`);
      if (full.types_csv) {
        const types = String(full.types_csv).split(/\s*,\s*/)
          .map(t => normalizeType(t)).filter(Boolean).join(', ');
        if (types) bits.push(`<b>Type:</b> ${escapeHtml(types)}`);
      }
      if (full.prerequisites && full.prerequisites.trim()) {
        // Live ✓/✗/? check against the current character state.
        // Warn-only — never blocks. See feat-prereqs.js for parser
        // coverage and known limitations.
        if (typeof FeatPrereqs !== 'undefined') {
          const ev = FeatPrereqs.evaluate(full.prerequisites);
          const sumSym = ev.summary.label;
          const sumCls = `fp-summary fp-summary-${ev.summary.status}`;
          // M8 (2026-05-16 play-feel pass): for single-atom prereqs the
          // summary line repeats verbatim what the per-atom chip says
          // ("Prereq: ✓ Str 13" + "✓ Str 13 — have 16"). Drop the
          // summary in that case and surface only the chip — its value-
          // hint suffix is more informative anyway. For multi-atom
          // prereqs (Cleave: Str 13 + Power Attack) the summary's raw
          // text helps readability, so keep both.
          if (ev.atoms && ev.atoms.length === 1) {
            bits.push(`<b>Prereq:</b> <span class="fp-atoms">${ev.html}</span>`);
          } else {
            bits.push(
              `<b>Prereq:</b> <span class="${sumCls}">${sumSym}</span> ` +
              `${escapeHtml(full.prerequisites)}<br>` +
              `<span class="fp-atoms">${ev.html}</span>`
            );
          }
        } else {
          bits.push(`<b>Prereq:</b> ${escapeHtml(full.prerequisites)}`);
        }
      }
      if (full.benefit && full.benefit.trim()) {
        bits.push(`<b>Benefit:</b> ${escapeHtml(full.benefit)}`);
      }
      if (full.normal && full.normal.trim()) {
        bits.push(`<b>Normal:</b> ${escapeHtml(full.normal)}`);
      }
      if (full.special && full.special.trim()) {
        bits.push(`<b>Special:</b> ${escapeHtml(full.special)}`);
      }
      info.innerHTML = bits.join('<br>');
      if (window.ErrataBadge) ErrataBadge.attach(info, entry.primary.feat_id);
      if (window.VersionBadge) VersionBadge.attach(info, full.version);
      info.style.display = 'block';
    }
    featInput.addEventListener('input', updateInfo);
    featInput.addEventListener('change', updateInfo);

    function flash(msg, color) {
      const note = document.createElement('div');
      note.style.cssText = `margin-top:0.3rem;color:${color};font-style:italic`;
      note.textContent = msg;
      info.appendChild(note);
      info.style.display = 'block';
      setTimeout(() => note.remove(), 3500);
    }

    addLookupBtn.addEventListener('click', () => {
      const typed = featInput.value.trim();
      if (!typed) { flash('Pick a feat first.', '#a66'); return; }
      // Use the canonical Title-Case display name if found in the index
      // so the entered text is consistent across DB-known feats; allow
      // fully custom ("homebrew") entries through unchanged.
      const entry = featIndex.get(typed.toLowerCase());
      const text = entry ? entry.displayName : typed;
      // Dedup vs existing feat-entries (case-insensitive whole-text match).
      const existing = Array.from(
        document.querySelectorAll('#feats-container .feat-entry')
      ).map(t => (t.value || '').trim().toLowerCase());
      if (existing.includes(text.toLowerCase())) {
        flash(`"${text}" already in Feats list.`, '#aa8');
        return;
      }
      // Reuse the first empty row if there is one (so an initial blank
      // row added by app.js doesn't get left behind).
      const blanks = Array.from(
        document.querySelectorAll('#feats-container .feat-entry')
      ).filter(t => !(t.value || '').trim());
      if (blanks.length) {
        blanks[0].value = text;
        blanks[0].dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        Feats.addFeat(text);
      }
      flash(`Added "${text}" to Feats.`, '#7a9');
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
