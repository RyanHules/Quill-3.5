// tag-filter.js — chip-style multi-tag filter with autocomplete.
//
// Replaces the single-tag <select> dropdown that each picker used to
// carry. The user types in a text input, sees an autocomplete dropdown
// of matching tags (with per-tag spell/feat/item counts), picks one,
// and it becomes a removable chip. Multiple chips combine via an
// AND/OR toggle (default AND). The complete filter state is exposed
// via getSelected() / getMode(); the picker re-applies filters
// whenever the onChange callback fires.
//
// Usage:
//
//   const tagFilter = TagFilter.attach(container, {
//     tags: [['evil-descriptor', 42], ['mind-affecting', 156], …],
//     defaultMode: 'and',  // optional, defaults to 'and'
//     placeholder: 'Filter by tag(s)…',
//     onChange: () => applyFilters(),
//   });
//
//   const selected = tagFilter.getSelected();  // ['evil-descriptor', …]
//   const mode = tagFilter.getMode();          // 'and' | 'or'
//
// Design notes:
//   - Tags are passed in as [name, count] tuples so the autocomplete
//     can show the count and the picker can sort by relevance.
//   - Selected tags shown as chips with × buttons; Backspace from
//     the empty input removes the rightmost chip (standard
//     chip-input UX).
//   - Autocomplete dropdown is keyboard-navigable (↑↓ Enter Esc).
//   - The AND/OR toggle sits inline with the chips; tiny click target
//     but visible state.
//   - Empty selection = no tag filter (same as the old "Any tag").

(function () {
  'use strict';

  const CHIP_STYLE =
    'display:inline-flex; align-items:center; gap:0.25rem; ' +
    'padding:0.1rem 0.4rem; margin:0.1rem; ' +
    'background:rgba(106,138,170,0.25); ' +
    'border:1px solid rgba(106,138,170,0.5); border-radius:3px; ' +
    'font-size:0.85em; line-height:1.4;';
  const CHIP_X_STYLE =
    'background:none; border:none; color:#cde; cursor:pointer; ' +
    'padding:0 0.15rem; font-size:1em; line-height:1;';
  const MODE_BTN_STYLE =
    'display:inline-block; padding:0.1rem 0.4rem; margin:0.1rem; ' +
    'background:rgba(255,255,255,0.06); ' +
    'border:1px solid rgba(255,255,255,0.18); border-radius:3px; ' +
    'color:#bdf; cursor:pointer; font-size:0.78em; ' +
    'font-family:inherit; font-weight:bold; user-select:none;';
  const DROPDOWN_STYLE =
    'position:absolute; top:100%; left:0; right:0; z-index:50; ' +
    'max-height:14rem; overflow-y:auto; ' +
    'background:#1a1f29; border:1px solid #44516a; ' +
    'border-radius:3px; box-shadow:0 4px 10px rgba(0,0,0,0.4); ' +
    'margin-top:0.15rem; display:none;';
  const OPTION_STYLE =
    'display:flex; justify-content:space-between; ' +
    'padding:0.25rem 0.5rem; cursor:pointer; font-size:0.85em;';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Attach a tag filter widget to `container`. Returns a handle.
  function attach(container, opts) {
    opts = opts || {};
    const tagPool   = (opts.tags || []).slice();
    const onChange  = opts.onChange || (() => {});
    const placeholder = opts.placeholder || 'Filter by tag(s)…';
    let combineMode = (opts.defaultMode === 'or') ? 'or' : 'and';

    // Map: tag-name → count, for fast lookup + autocomplete sort.
    const tagCounts = new Map();
    for (const [name, count] of tagPool) tagCounts.set(name, count || 0);

    const selected = new Set();
    let activeIdx = -1;  // highlighted autocomplete row

    // -- DOM scaffold ---------------------------------------------------
    const root = document.createElement('div');
    root.className = 'tag-filter';
    root.style.cssText =
      'position:relative; display:flex; align-items:center; ' +
      'flex-wrap:wrap; gap:0.1rem; padding:0.2rem; ' +
      'min-height:1.8rem; background:rgba(0,0,0,0.18); ' +
      'border:1px solid rgba(255,255,255,0.18); border-radius:3px;';

    // Mode toggle (AND/OR). Click flips. Hidden when <2 tags selected
    // since the choice is moot.
    const modeBtn = document.createElement('button');
    modeBtn.type = 'button';
    modeBtn.className = 'tag-filter-mode';
    modeBtn.style.cssText = MODE_BTN_STYLE + ' display:none;';
    modeBtn.title = 'Click to toggle: AND = spell must have every tag · OR = any tag';
    modeBtn.textContent = combineMode.toUpperCase();
    modeBtn.addEventListener('click', () => {
      combineMode = (combineMode === 'and') ? 'or' : 'and';
      modeBtn.textContent = combineMode.toUpperCase();
      onChange();
    });
    root.appendChild(modeBtn);

    // Chip container — flex item that lets chips wrap inline with the
    // input. Inserted before the input so chips render left of cursor.
    const chipsEl = document.createElement('span');
    chipsEl.className = 'tag-filter-chips';
    chipsEl.style.cssText = 'display:contents;';  // flatten into root
    root.appendChild(chipsEl);

    // Free-text input
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tag-filter-input';
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.style.cssText =
      'flex:1 1 6rem; min-width:5rem; ' +
      'background:transparent; border:none; outline:none; ' +
      'color:inherit; font:inherit; padding:0.2rem;';
    root.appendChild(input);

    // Autocomplete dropdown
    const dropdown = document.createElement('div');
    dropdown.className = 'tag-filter-dropdown';
    dropdown.style.cssText = DROPDOWN_STYLE;
    root.appendChild(dropdown);

    container.appendChild(root);

    // -- Rendering ------------------------------------------------------

    function renderChips() {
      // Wipe existing chips (keep the modeBtn + input).
      chipsEl.innerHTML = '';
      for (const name of selected) {
        const chip = document.createElement('span');
        chip.style.cssText = CHIP_STYLE;
        const txt = document.createElement('span');
        txt.textContent = name;
        chip.appendChild(txt);
        const x = document.createElement('button');
        x.type = 'button';
        x.style.cssText = CHIP_X_STYLE;
        x.textContent = '×';
        x.title = `Remove "${name}"`;
        x.addEventListener('click', () => removeTag(name));
        chip.appendChild(x);
        chipsEl.appendChild(chip);
      }
      // Mode toggle is visible only when 2+ tags selected — with one
      // tag the choice doesn't matter.
      modeBtn.style.display = selected.size >= 2 ? '' : 'none';
    }

    function renderDropdown() {
      const q = input.value.trim().toLowerCase();
      // Filter to tags that match the typed prefix/substring AND
      // aren't already selected. Sort: prefix matches first, then
      // substring matches, each subgroup by descending count.
      const exact = [];
      const prefix = [];
      const substring = [];
      for (const [name, count] of tagPool) {
        if (selected.has(name)) continue;
        const lower = name.toLowerCase();
        if (!q) { substring.push([name, count]); continue; }
        if (lower === q) exact.push([name, count]);
        else if (lower.startsWith(q)) prefix.push([name, count]);
        else if (lower.includes(q)) substring.push([name, count]);
      }
      const sortByCount = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]);
      exact.sort(sortByCount);
      prefix.sort(sortByCount);
      substring.sort(sortByCount);
      const ordered = exact.concat(prefix, substring);

      if (!ordered.length) {
        dropdown.style.display = 'none';
        activeIdx = -1;
        return;
      }
      // Cap at 30 rows — keep the dropdown tractable.
      const shown = ordered.slice(0, 30);
      dropdown.innerHTML = shown.map(([name, count], idx) =>
        `<div class="tag-filter-opt" data-name="${escapeHtml(name)}" ` +
        `style="${OPTION_STYLE}${idx === activeIdx ? ' background:rgba(106,138,170,0.3);' : ''}">` +
        `<span>${escapeHtml(name)}</span>` +
        `<span style="opacity:0.6">${count}</span>` +
        `</div>`
      ).join('');
      dropdown.style.display = 'block';
      // Bound activeIdx to current list size.
      if (activeIdx >= shown.length) activeIdx = shown.length - 1;
    }

    // -- Behavior -------------------------------------------------------

    function addTag(name) {
      if (!tagCounts.has(name)) return;     // unknown tag
      if (selected.has(name)) return;        // already added
      selected.add(name);
      input.value = '';
      activeIdx = -1;
      renderChips();
      renderDropdown();
      onChange();
    }

    function removeTag(name) {
      if (!selected.delete(name)) return;
      renderChips();
      // If dropdown is open, refresh so the newly-removed tag
      // reappears as a suggestion.
      if (dropdown.style.display === 'block') renderDropdown();
      onChange();
    }

    function commitFromActive() {
      const opts = dropdown.querySelectorAll('.tag-filter-opt');
      if (activeIdx >= 0 && activeIdx < opts.length) {
        addTag(opts[activeIdx].dataset.name);
        return true;
      }
      // No highlighted row — try exact match on typed text.
      const q = input.value.trim().toLowerCase();
      for (const [name] of tagPool) {
        if (name.toLowerCase() === q) { addTag(name); return true; }
      }
      return false;
    }

    input.addEventListener('input', () => {
      activeIdx = input.value.trim() ? 0 : -1;  // auto-highlight first match
      renderDropdown();
    });
    input.addEventListener('focus', () => renderDropdown());
    input.addEventListener('blur', () => {
      // Delay close so a mousedown on a dropdown option fires the
      // click handler before the dropdown disappears.
      setTimeout(() => { dropdown.style.display = 'none'; }, 150);
    });
    input.addEventListener('keydown', (ev) => {
      const opts = dropdown.querySelectorAll('.tag-filter-opt');
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        if (opts.length) {
          activeIdx = (activeIdx + 1) % opts.length;
          renderDropdown();
        }
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (opts.length) {
          activeIdx = (activeIdx - 1 + opts.length) % opts.length;
          renderDropdown();
        }
      } else if (ev.key === 'Enter') {
        if (dropdown.style.display === 'block') {
          ev.preventDefault();
          commitFromActive();
        }
      } else if (ev.key === 'Escape') {
        dropdown.style.display = 'none';
        activeIdx = -1;
      } else if (ev.key === 'Backspace' && !input.value && selected.size) {
        // Backspace on empty input removes the most-recently-added
        // chip — standard chip-input UX.
        const last = [...selected].pop();
        removeTag(last);
      } else if (ev.key === ',' || ev.key === 'Tab') {
        // Comma / Tab also commit the highlighted suggestion. Comma
        // is intuitive for chip lists; Tab is the keyboard-equivalent
        // of clicking the next form control.
        if (dropdown.style.display === 'block' && commitFromActive()) {
          ev.preventDefault();
        }
      }
    });

    // Click an autocomplete option — mousedown so we can race the
    // blur (blur fires before click, would hide the dropdown).
    dropdown.addEventListener('mousedown', (ev) => {
      const opt = ev.target.closest('.tag-filter-opt');
      if (!opt) return;
      ev.preventDefault();   // keep input focused
      addTag(opt.dataset.name);
    });

    // Initial render
    renderChips();

    // -- Public API -----------------------------------------------------

    return {
      getSelected: () => [...selected],
      getMode: () => combineMode,
      hasFilter: () => selected.size > 0,
      setSelected: (names) => {
        selected.clear();
        for (const n of (names || [])) if (tagCounts.has(n)) selected.add(n);
        renderChips();
        onChange();
      },
      setMode: (mode) => {
        combineMode = (mode === 'or') ? 'or' : 'and';
        modeBtn.textContent = combineMode.toUpperCase();
        onChange();
      },
      clear: () => {
        if (!selected.size) return;
        selected.clear();
        renderChips();
        onChange();
      },
      // Update the pool (e.g. after book-filter change rebuilds the
      // tag list). Strips any selected tag no longer in the pool.
      setTags: (newTags) => {
        tagPool.length = 0;
        tagCounts.clear();
        for (const [name, count] of (newTags || [])) {
          tagPool.push([name, count || 0]);
          tagCounts.set(name, count || 0);
        }
        // Drop selected tags that no longer exist in the new pool.
        let changed = false;
        for (const n of [...selected]) {
          if (!tagCounts.has(n)) { selected.delete(n); changed = true; }
        }
        if (changed) {
          renderChips();
          onChange();
        }
        if (dropdown.style.display === 'block') renderDropdown();
      },
      root,
    };
  }

  window.TagFilter = { attach };
})();
