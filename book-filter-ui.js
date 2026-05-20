// book-filter-ui.js — header button + modal UI for BookFilter.
//
// Adds a 📚 button to the header alongside the lookup button. Clicking
// it opens a modal where the user picks which source books are in
// scope for the campaign. The modal lists every book grouped by
// book_type (core / splat / campaign), with preset shortcuts
// ("Core only", "All", "Clear") and a count badge on the trigger
// button when a filter is active.
//
// State lives in BookFilter; this module is purely UI.

(function () {
  // ---- Trigger button (header) -------------------------------------------

  let triggerBtn = null;
  let badgeEl = null;
  let modalEl = null;

  function ensureTriggerButton() {
    if (document.getElementById('book-filter-trigger-btn')) return;
    triggerBtn = document.createElement('button');
    triggerBtn.id = 'book-filter-trigger-btn';
    triggerBtn.type = 'button';
    triggerBtn.className = 'book-filter-trigger';
    triggerBtn.title = 'Filter pickers by source book';
    triggerBtn.setAttribute('aria-label', 'Open book filter');
    triggerBtn.innerHTML = '<span class="bf-icon">📚</span>' +
      '<span class="bf-badge" id="book-filter-badge" hidden></span>';
    triggerBtn.addEventListener('click', open);

    // Insert before the lookup trigger (which sits at margin-left:auto)
    // so the two buttons live together in the header tail.
    const lookupBtn = document.getElementById('lookup-trigger-btn');
    const header = document.querySelector('header');
    if (lookupBtn && lookupBtn.parentNode === header) {
      header.insertBefore(triggerBtn, lookupBtn);
    } else if (header) {
      header.appendChild(triggerBtn);
    } else {
      document.body.appendChild(triggerBtn);
    }
    badgeEl = triggerBtn.querySelector('#book-filter-badge');
    refreshBadge();
  }

  function refreshBadge() {
    if (!badgeEl) return;
    if (window.BookFilter && window.BookFilter.isActive()) {
      const n = window.BookFilter.getActiveAbbrevs().size;
      badgeEl.textContent = String(n);
      badgeEl.hidden = false;
      triggerBtn.classList.add('book-filter-active');
    } else {
      badgeEl.hidden = true;
      triggerBtn.classList.remove('book-filter-active');
    }
  }

  // ---- Modal -------------------------------------------------------------

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.id = 'book-filter-modal';
    modalEl.className = 'book-filter-modal';
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');
    modalEl.setAttribute('aria-label', 'Source book filter');
    modalEl.style.display = 'none';
    modalEl.innerHTML = `
      <div class="book-filter-backdrop" data-close="1"></div>
      <div class="book-filter-card">
        <div class="book-filter-header">
          <div>
            <div class="book-filter-title">Source book filter</div>
            <div class="book-filter-sub">
              Restrict pickers and the universal lookup to a subset
              of books. Errata indicators still appear regardless.
            </div>
          </div>
          <button type="button" class="book-filter-close"
                  data-close="1" aria-label="Close">×</button>
        </div>
        <div class="book-filter-presets">
          <button type="button" data-preset="all">Select all</button>
          <button type="button" data-preset="core">Core only (PHB / DMG / MM)</button>
          <button type="button" data-preset="35">All 3.5 books</button>
          <button type="button" data-preset="clear">Clear (no filter)</button>
        </div>
        <fieldset class="book-filter-hide30 book-filter-hide30-group">
          <legend>3.0 edition material</legend>
          <label>
            <input type="radio" name="hide30-mode" value="off">
            <span class="hbm-label"><b>Show all 3.0 entries</b></span>
            <span class="hbm-hint">
              Default — every 3.0 entry visible, marked with a
              <span class="version-badge version-badge--30">3.0</span> pill.
            </span>
          </label>
          <label>
            <input type="radio" name="hide30-mode" value="counterpart">
            <span class="hbm-label"><b>Hide 3.0 entries with a 3.5 counterpart</b></span>
            <span class="hbm-hint">
              Hides a 3.0 row only when a 3.5 row of the same name +
              type exists (so the 3.5 version wins by default). 3.0-only
              content stays visible — FR / MotP / MoF entries that
              never got a 3.5 reprint. Catches the Dimensional Lock
              case (MoF 3.0 row hidden when PHB 3.5 row is canonical).
              A few same-name-different-mechanic spells (Tortoise
              Shell, Cocoon, Aura of Glory, Celebration) are also
              hidden — flip to "Show all" if you need them.
            </span>
          </label>
          <label>
            <input type="radio" name="hide30-mode" value="all">
            <span class="hbm-label"><b>Hide all 3.0 entries</b></span>
            <span class="hbm-hint">
              Strict — every entry whose book is edition 3.0 is hidden.
              Stacks with the per-book filter above.
            </span>
          </label>
        </fieldset>
        <div class="book-filter-status" id="book-filter-status"></div>
        <div class="book-filter-list" id="book-filter-list"></div>
        <div class="book-filter-footer">
          <span class="book-filter-hint">
            <kbd>Esc</kbd> cancel
          </span>
          <span>
            <button type="button" class="book-filter-cancel"
                    data-close="1">Cancel</button>
            <button type="button" class="book-filter-apply"
                    id="book-filter-apply">Apply</button>
          </span>
        </div>
      </div>
    `;
    document.body.appendChild(modalEl);

    modalEl.addEventListener('click', (ev) => {
      const t = ev.target;
      if (t instanceof Element && t.dataset.close === '1') close();
    });
    modalEl.querySelector('#book-filter-apply')
      .addEventListener('click', applySelection);
    modalEl.querySelectorAll('[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
    });
    return modalEl;
  }

  function renderList() {
    const listEl = modalEl.querySelector('#book-filter-list');
    if (!window.BookFilter) {
      listEl.innerHTML = '<div class="book-filter-empty">Database not loaded.</div>';
      return;
    }
    const books = window.BookFilter.getBooks();
    if (!books.length) {
      listEl.innerHTML = '<div class="book-filter-empty">No books found.</div>';
      return;
    }
    const active = window.BookFilter.getActiveAbbrevs();

    // Group by book_type, then de-duplicate by abbreviation within each
    // group (variant FRCS entries shouldn't render as 5 checkboxes).
    const groups = new Map(); // book_type → Map<abbrev, {name, abbreviation, ...}>
    for (const b of books) {
      const grp = b.book_type || 'other';
      if (!groups.has(grp)) groups.set(grp, new Map());
      const byAbbrev = groups.get(grp);
      if (!byAbbrev.has(b.abbreviation)) {
        byAbbrev.set(b.abbreviation, b);
      }
    }
    const order = ['core', 'splat', 'campaign', 'other'];
    const groupLabels = {
      core: 'Core', splat: 'Splatbooks', campaign: 'Campaign settings',
      other: 'Other',
    };

    let html = '';
    for (const grp of order) {
      const byAbbrev = groups.get(grp);
      if (!byAbbrev) continue;
      const entries = [...byAbbrev.values()];
      html += `<div class="book-filter-group" data-group="${grp}">`;
      html += `<div class="book-filter-grouphead">`
        + `<span>${groupLabels[grp] || grp}</span> `
        + `<button type="button" class="book-filter-grouptoggle" `
        +   `data-group-action="${grp}">all / none</button>`
        + `</div>`;
      for (const b of entries) {
        const checked = active.has(b.abbreviation) ? 'checked' : '';
        const year = (b.publication_date || '').slice(0, 4);
        const edition = b.edition || '';
        // Olórin-style narrative summary, sourced from the book
        // table's `summary` column (populated by
        // _book_summaries_data.py in the DB project). Rendered as
        // an indented sub-line under the checkbox so the user knows
        // what each book is about before checking the box.
        const summary = (b.summary || '').trim();
        const summaryHtml = summary
          ? `<div class="bf-summary">${escapeHtml(summary)}</div>`
          : '';
        html += `<label class="book-filter-row">`
          + `<input type="checkbox" value="${escapeHtml(b.abbreviation)}" ${checked}>`
          + `<span class="bf-abbr">${escapeHtml(b.abbreviation)}</span>`
          + `<span class="bf-name">${escapeHtml(b.name)}</span>`
          + `<span class="bf-meta">${escapeHtml(edition)}${year ? ' · ' + year : ''}</span>`
          + summaryHtml
          + `</label>`;
      }
      html += `</div>`;
    }
    listEl.innerHTML = html;

    // Wire group toggles.
    listEl.querySelectorAll('[data-group-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const grp = btn.dataset.groupAction;
        const cbs = listEl.querySelectorAll(
          `.book-filter-group[data-group="${grp}"] input[type=checkbox]`);
        const anyOff = [...cbs].some(cb => !cb.checked);
        cbs.forEach(cb => { cb.checked = anyOff; });
        refreshStatus();
      });
    });
    listEl.addEventListener('change', refreshStatus);
    refreshStatus();
  }

  function refreshStatus() {
    const listEl = modalEl.querySelector('#book-filter-list');
    const statusEl = modalEl.querySelector('#book-filter-status');
    const checked = listEl.querySelectorAll('input[type=checkbox]:checked');
    const total = listEl.querySelectorAll('input[type=checkbox]');
    if (!total.length) { statusEl.textContent = ''; return; }
    if (checked.length === 0) {
      statusEl.textContent = '0 books selected — pickers will show all sources.';
      statusEl.className = 'book-filter-status book-filter-status-neutral';
    } else if (checked.length === total.length) {
      statusEl.textContent = `All ${total.length} books selected — same as no filter.`;
      statusEl.className = 'book-filter-status book-filter-status-neutral';
    } else {
      statusEl.textContent = `${checked.length} of ${total.length} books selected.`;
      statusEl.className = 'book-filter-status book-filter-status-active';
    }
  }

  function applyPreset(name) {
    const listEl = modalEl.querySelector('#book-filter-list');
    const cbs = listEl.querySelectorAll('input[type=checkbox]');
    if (name === 'clear') {
      cbs.forEach(cb => { cb.checked = false; });
    } else if (name === 'all') {
      cbs.forEach(cb => { cb.checked = true; });
    } else if (name === 'core') {
      const core = new Set(['PHB', 'DMG', 'MM']);
      cbs.forEach(cb => { cb.checked = core.has(cb.value); });
    } else if (name === '35') {
      // Edition is rendered in the .bf-meta span — read off label text.
      cbs.forEach(cb => {
        const row = cb.closest('label');
        const meta = row && row.querySelector('.bf-meta');
        cb.checked = !!(meta && /3\.5/.test(meta.textContent));
      });
    }
    refreshStatus();
  }

  function applySelection() {
    const listEl = modalEl.querySelector('#book-filter-list');
    // The per-book list lives inside #book-filter-list. The hide-3.0
    // checkbox is OUTSIDE that list (it's a sibling label) so we
    // intentionally scope the abbrev-collection query to the list.
    const cbs = listEl.querySelectorAll('input[type=checkbox]:checked');
    const total = listEl.querySelectorAll('input[type=checkbox]').length;
    const set = new Set();
    for (const cb of cbs) set.add(cb.value);
    // "All selected" is equivalent to "no filter" — collapse to clear
    // so downstream code doesn't waste cycles checking memberships.
    if (set.size === total) set.clear();
    window.BookFilter.setActiveAbbrevs(set);
    // Hide-3.0 mode is independent of the abbrev filter — a 3-state
    // radio group (off / counterpart / all).
    const selected = modalEl.querySelector(
      'input[name="hide30-mode"]:checked');
    if (selected) window.BookFilter.setHide30Mode(selected.value);
    close();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- Open / close ------------------------------------------------------

  function open() {
    ensureModal();
    modalEl.style.display = '';
    // Sync the hide-3.0 radio with whatever BookFilter currently has
    // — covers the case where a save-load just changed the mode.
    if (window.BookFilter) {
      const mode = window.BookFilter.getHide30Mode
        ? window.BookFilter.getHide30Mode()
        : (window.BookFilter.getHide30() ? 'all' : 'off');
      const radio = modalEl.querySelector(
        `input[name="hide30-mode"][value="${mode}"]`);
      if (radio) radio.checked = true;
    }
    renderList();
    document.addEventListener('keydown', onKeydown);
  }

  function close() {
    if (modalEl) modalEl.style.display = 'none';
    document.removeEventListener('keydown', onKeydown);
  }

  function onKeydown(ev) {
    if (ev.key === 'Escape') { close(); ev.preventDefault(); }
  }

  // ---- Init --------------------------------------------------------------

  function init() {
    ensureTriggerButton();
    document.addEventListener('book-filter-changed', refreshBadge);
    // The trigger badge may have been wrong if the filter was loaded
    // from storage before the button was injected.
    refreshBadge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
