// picker-results.js — shared chip-wall results helper for every picker.
//
// Each picker's filter inputs (class, level, tag, etc.) narrows the
// pool of matching entries. Without a results display, the user has
// to know what they're looking for AND type its name to surface it via
// the datalist autocomplete. That breaks browsing — e.g. "show me all
// Cleric L3 spells, let me pick one" or "what magic items cost ≤2000
// gp" use cases. This helper renders the current matches as a clickable
// chip wall below the picker bar, so the picker doubles as a browser.
//
// Originally lived inline in spell-picker.js (the .sp-results /
// .sp-result-chip DOM + renderResults function). Extracted on
// 2026-05-21 so every other picker can adopt the same UX with
// minimal per-picker code.
//
// Usage from a picker module:
//
//   const results = PickerResults.attach(picker, {
//     onPick: (name) => {
//       myInput.value = name;
//       myInput.dispatchEvent(new Event('input', { bubbles: true }));
//       myInput.focus();
//     },
//   });
//   // After each filter change:
//   results.render(matchNames, { typedFilter: input.value.trim() });
//
//   // To hide (e.g. when DB isn't loaded):
//   results.clear();
//
// Design notes:
//   - Caps at 100 chips by default to keep the DOM lean. Larger pools
//     surface a "Showing N of M" header WITH a "Show all M" button —
//     narrowing further is a suggestion, not the only way out (Ryan,
//     2026-08-19: a cap the user can't lift makes the pool invisible).
//     The expansion is deliberately one-shot: any later render (a
//     filter change, a keystroke in the name field) drops back to the
//     cap, so a wide filter can never inherit a 5,000-chip wall.
//   - Typed-name filter (when provided via opts.typedFilter) tracks the
//     user's spell-name input — chips collapse to substring matches.
//     If the typed filter zeros the list, surfaces "X matches from
//     filter — none contain 'foo'. Clear or shorten to widen." so the
//     user knows the click-pool is filtered, not empty.
//   - Event-delegated click handler on the results container, so chip
//     re-renders don't need re-wiring. Chip carries data-name + the
//     full display text; onPick gets the name.

(function () {
  'use strict';

  const CHIP_STYLE =
    'display:inline-block; padding:0.18rem 0.5rem; ' +
    'margin:0.12rem; border:1px solid rgba(255,255,255,0.18); ' +
    'border-radius:3px; background:rgba(255,255,255,0.04); ' +
    'color:#cde; cursor:pointer; font-size:0.85em; line-height:1.2; ' +
    'font-family:inherit;';

  const DEFAULT_CAP = 100;

  // The cap-lifting button that rides in the count header.
  const MORE_CLASS = 'picker-results-more';
  const MORE_STYLE =
    'padding:0.05rem 0.4rem; margin-left:0.15rem; ' +
    'border:1px solid rgba(255,255,255,0.28); border-radius:3px; ' +
    'background:rgba(255,255,255,0.06); color:#bdf; cursor:pointer; ' +
    'font-size:0.95em; font-family:inherit; line-height:1.3;';

  function moreButton(label, expand) {
    return `<button type="button" class="${MORE_CLASS}" ` +
      `style="${MORE_STYLE}" data-expand="${expand ? '1' : '0'}">` +
      `${escapeHtml(label)}</button>`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Default English pluralizer. Handles the cases the picker nouns
  // actually use: y-after-consonant → ies, sibilant-end → es,
  // otherwise +s. Callers can pre-supply a plural form via the
  // `pluralNoun` option to bypass this when irregular (e.g.
  // "mystery" → "mysteries" — but we get that right by default).
  function pluralize(noun) {
    const s = String(noun || '');
    if (/[^aeiou]y$/i.test(s)) return s.slice(0, -1) + 'ies';
    if (/(s|sh|ch|x|z)$/i.test(s)) return s + 'es';
    return s + 's';
  }

  // Attach a results pane to `container` (typically the picker root
  // div). Returns a { render, clear, el } handle.
  //
  // opts:
  //   onPick(name, chipEl)       — required: fired on chip click
  //   className                  — optional CSS class on the results
  //                                pane (default 'picker-results')
  //   chipClassName              — optional CSS class on each chip
  //                                (default 'picker-result-chip')
  //   cap                        — max chips to render at once
  //                                (default 100)
  //   itemNoun                   — singular noun for the count header
  //                                (default 'match')
  //   pluralNoun                 — explicit plural form; falls back to
  //                                the default English pluralizer
  //   collapsible                — if true, wraps the chip wall in a
  //                                <details> block so the user can
  //                                fold it away. Useful for pickers
  //                                whose chips are only pertinent at
  //                                character creation (deity, race).
  //                                The summary line shows the count.
  //   collapsedByDefault         — when collapsible, start folded.
  //                                Defaults to false; deity-picker
  //                                opts into this so the chips don't
  //                                eat layout space mid-play.
  //   mount                      — an EXISTING element to render into,
  //                                instead of appending a fresh div to
  //                                `container`. For pickers whose
  //                                markup already reserves a slot at a
  //                                specific place in the bar (spell-
  //                                picker's `.sp-results`, which sits
  //                                above the info panel, not below it).
  function attach(container, opts) {
    opts = opts || {};
    const className = opts.className || 'picker-results';
    const chipClass = opts.chipClassName || 'picker-result-chip';
    const cap       = opts.cap        || DEFAULT_CAP;
    const noun      = opts.itemNoun   || 'match';
    const nounPlural = opts.pluralNoun || pluralize(noun);
    const collapsible = !!opts.collapsible;
    const collapsedByDefault = !!opts.collapsedByDefault;

    // Render into the caller's own slot when it supplied one, so the
    // chip wall keeps its place in that picker's layout; otherwise
    // append a fresh pane at the end of the container.
    const div = opts.mount || document.createElement('div');
    if (!opts.mount) {
      div.className = className;
      div.style.cssText =
        'display:none; margin-top:0.5rem; font-size:0.85em;';
      container.appendChild(div);
    } else {
      div.style.display = 'none';
    }

    // When collapsible, render content INSIDE a <details>/<summary>
    // so the user gets a native disclosure widget. We track the
    // open/closed state separately so toggling doesn't blow away on
    // re-render (the user's intent persists across filter changes).
    let detailsOpen = !collapsedByDefault;
    function syncDetailsOpen() {
      const details = div.querySelector('details');
      if (details) details.open = detailsOpen;
    }
    div.addEventListener('toggle', (ev) => {
      if (ev.target.tagName === 'DETAILS') {
        detailsOpen = ev.target.open;
      }
    }, true);

    // Show-all state. `expanded` lifts the cap for the CURRENT list
    // only — `render` clears it on every call, so the button has to be
    // re-clicked after any filter change. `lastRender` is what the
    // button replays.
    let expanded = false;
    let lastRender = null;

    // Event-delegated click so chip re-renders don't re-wire handlers.
    div.addEventListener('click', (ev) => {
      const more = ev.target.closest('.' + MORE_CLASS);
      if (more) {
        // In collapsible mode the header lives inside a <summary>, and
        // a click there toggles the disclosure — suppress that so the
        // button only ever changes the cap.
        ev.preventDefault();
        ev.stopPropagation();
        // Re-render the same list with the cap lifted (or restored).
        expanded = more.dataset.expand === '1';
        if (lastRender) render(lastRender.names, lastRender.opts2, true);
        return;
      }
      const chip = ev.target.closest('.' + chipClass);
      if (!chip) return;
      const name = chip.dataset.name || chip.textContent || '';
      if (typeof opts.onPick === 'function') {
        opts.onPick(name, chip);
      }
    });

    function clear() {
      div.style.display = 'none';
      div.innerHTML = '';
    }

    // Render `names` as chips. opts2.typedFilter, when truthy, applies
    // a case-insensitive substring filter to the names (so chips
    // narrow as the user types in the picker's name input).
    function render(names, opts2, keepExpanded) {
      opts2 = opts2 || {};
      // A fresh render means a fresh filter — collapse back to the cap
      // unless this call IS the show-all button replaying itself.
      if (!keepExpanded) expanded = false;
      lastRender = { names, opts2 };
      const typedRaw = String(opts2.typedFilter || '').trim();
      const typed = typedRaw.toLowerCase();
      // Defensive copy + sort so callers don't have to pre-sort.
      const all = (names || []).slice()
        .filter(n => typeof n === 'string')
        .sort((a, b) => a.localeCompare(b));
      const filtered = typed
        ? all.filter(n => n.toLowerCase().includes(typed))
        : all;

      if (filtered.length === 0) {
        // If the typed filter zeros the list but the un-typed filter
        // had matches, surface that explicitly — the chip wall is
        // narrowed by the typed text, not empty by category.
        if (typed && all.length > 0) {
          const word = all.length === 1 ? noun : nounPlural;
          div.innerHTML =
            `<div style="opacity:0.7">${all.length} ${word}` +
            ` from filter — none contain &quot;${escapeHtml(typedRaw)}&quot;. ` +
            `Clear or shorten the name field to widen.</div>`;
          div.style.display = 'block';
          return;
        }
        clear();
        return;
      }

      const overCap = filtered.length > cap;
      const shown = (overCap && !expanded) ? filtered.slice(0, cap) : filtered;
      const matchSuffix = typed
        ? ` containing &quot;${escapeHtml(typedRaw)}&quot;`
        : '';
      const chips = shown.map(n =>
        `<button type="button" class="${chipClass}" ` +
        `style="${CHIP_STYLE}" ` +
        `data-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`
      ).join('');
      const wordShown   = nounPlural;
      const wordCounted = filtered.length === 1 ? noun : nounPlural;
      // Over the cap the header carries a button, so the user can lift
      // it instead of being told to narrow further and left there.
      let headerText;
      if (overCap && !expanded) {
        headerText =
          `Showing ${cap} of ${filtered.length} ${wordShown}${matchSuffix} ` +
          moreButton(`Show all ${filtered.length}`, true);
      } else if (overCap) {
        headerText =
          `Showing all ${filtered.length} ${wordShown}${matchSuffix} ` +
          moreButton(`Show first ${cap}`, false);
      } else {
        headerText = `${filtered.length} ${wordCounted}${matchSuffix}`;
      }

      if (collapsible) {
        // <details>/<summary> gives the user a native fold widget.
        // The summary line carries the count so users can see how
        // many matches are hiding without expanding.
        const openAttr = detailsOpen ? ' open' : '';
        div.innerHTML =
          `<details${openAttr} style="margin:0">` +
          `<summary style="cursor:pointer; opacity:0.7; ` +
          `padding:0.15rem 0; user-select:none">${headerText}</summary>` +
          `<div style="margin-top:0.25rem">${chips}</div>` +
          `</details>`;
      } else {
        const header = `<div style="opacity:0.7; margin-bottom:0.25rem">${headerText}</div>`;
        div.innerHTML = header + `<div>${chips}</div>`;
      }
      div.style.display = 'block';
    }

    return { render, clear, el: div };
  }

  window.PickerResults = { attach };
})();
