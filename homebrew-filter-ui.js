// homebrew-filter-ui.js — the 🏠 button + modal for toggling
// homebrew rules registered with HomebrewFilter.
//
// Mirrors book-filter-ui.js in structure: a header button slots in
// next to the lookup + book-filter triggers, opens a modal showing
// every registered rule grouped by category with a checkbox per
// rule and a "What it does" hint underneath.
//
// The modal stays purely declarative — toggling a checkbox calls
// `HomebrewFilter.setEnabled`, which fires the change event;
// downstream consumers (pickers, character calc paths) react to
// the event and re-apply their rule.

(function () {
  let modalEl = null;
  let triggerBtn = null;

  // ---- Trigger button -----------------------------------------------------

  function insertTrigger() {
    if (triggerBtn) return;
    // The lookup + book-filter triggers live in the same header row
    // near the tabs. Slot in to the LEFT of the book-filter button so
    // the order reads as 🔍 / 🏠 / 📚.
    const bookBtn = document.getElementById('book-filter-trigger-btn');
    const lookupBtn = document.getElementById('lookup-trigger-btn');
    const host = (bookBtn && bookBtn.parentElement)
      || (lookupBtn && lookupBtn.parentElement);
    if (!host) return;
    triggerBtn = document.createElement('button');
    triggerBtn.id = 'homebrew-filter-trigger-btn';
    triggerBtn.type = 'button';
    triggerBtn.className = 'lookup-trigger-btn homebrew-filter-trigger-btn';
    triggerBtn.title = 'Homebrew rules — toggle per-rule house rules and ' +
      'campaign-specific homebrew. Default state is RAW (everything off).';
    triggerBtn.innerHTML = '🏠<span class="hbf-count" id="hbf-count"></span>';
    triggerBtn.addEventListener('click', open);
    if (bookBtn) {
      host.insertBefore(triggerBtn, bookBtn);
    } else {
      host.appendChild(triggerBtn);
    }
    refreshCount();
    document.addEventListener('homebrew-filter-changed', refreshCount);
  }

  function refreshCount() {
    if (!triggerBtn) return;
    const countEl = triggerBtn.querySelector('#hbf-count');
    if (!countEl || !window.HomebrewFilter) return;
    const n = window.HomebrewFilter.getActiveKeys().length;
    countEl.textContent = n > 0 ? String(n) : '';
    countEl.style.display = n > 0 ? '' : 'none';
  }

  // ---- Modal --------------------------------------------------------------

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.id = 'homebrew-filter-modal';
    modalEl.className = 'book-filter-modal';
    modalEl.style.display = 'none';
    modalEl.innerHTML = `
      <div class="book-filter-backdrop" data-close="1"></div>
      <div class="book-filter-panel" role="dialog" aria-modal="true"
           aria-labelledby="homebrew-filter-title">
        <div class="book-filter-head">
          <div>
            <div class="book-filter-title" id="homebrew-filter-title">
              Homebrew &amp; house rules
            </div>
            <div class="book-filter-sub">
              Toggle per-rule. Default state is RAW — each rule is
              opt-in. Changes save with the character.
            </div>
          </div>
          <button type="button" class="book-filter-close"
                  data-close="1" aria-label="Close">×</button>
        </div>
        <div class="book-filter-status" id="homebrew-filter-status"></div>
        <div class="book-filter-list" id="homebrew-filter-list"></div>
        <div class="book-filter-footer">
          <span class="book-filter-hint">
            <kbd>Esc</kbd> cancel
          </span>
          <span>
            <button type="button" class="book-filter-cancel"
                    data-close="1">Cancel</button>
            <button type="button" class="book-filter-apply"
                    id="homebrew-filter-apply">Apply</button>
          </span>
        </div>
      </div>
    `;
    document.body.appendChild(modalEl);
    modalEl.addEventListener('click', (ev) => {
      const t = ev.target;
      if (t instanceof Element && t.dataset.close === '1') close();
    });
    modalEl.querySelector('#homebrew-filter-apply')
      .addEventListener('click', applySelection);
    return modalEl;
  }

  function renderList() {
    const listEl = modalEl.querySelector('#homebrew-filter-list');
    if (!window.HomebrewFilter) {
      listEl.innerHTML = '<div class="book-filter-empty">Homebrew module unavailable.</div>';
      return;
    }
    const allRules = window.HomebrewFilter.getRules();
    if (!allRules.length) {
      listEl.innerHTML =
        '<div class="book-filter-empty">No homebrew rules registered yet. ' +
        'Each rule self-registers when its module loads — if you see ' +
        'this message, no rule bundles are present in this build.</div>';
      return;
    }
    // Group by category.
    const groups = new Map();
    for (const r of allRules) {
      if (!groups.has(r.category)) groups.set(r.category, []);
      groups.get(r.category).push(r);
    }

    let html = '';
    for (const [cat, rs] of groups) {
      html += `<div class="book-filter-group" data-group="${escapeAttr(cat)}">`
        + `<div class="book-filter-grouphead"><span>${escapeHtml(cat)}</span></div>`;
      for (const r of rs) {
        const checked = window.HomebrewFilter.isEnabled(r.key) ? 'checked' : '';
        const info = r.informational
          ? '<span class="hbf-info-tag" title="No mechanical effect — '
            + 'sheet-level flag for visibility only">info</span>'
          : '';
        const src = r.source
          ? `<span class="hbf-src" title="Source">${escapeHtml(r.source)}</span>`
          : '';
        html += `<label class="hbf-row" data-key="${escapeAttr(r.key)}">`
          + `<input type="checkbox" data-key="${escapeAttr(r.key)}" ${checked}>`
          + `<span class="hbf-rowtext">`
          +   `<span class="hbf-rowtitle">`
          +     `${escapeHtml(r.name)} ${info} ${src}`
          +   `</span>`
          +   (r.description
                ? `<span class="hbf-desc">${escapeHtml(r.description)}</span>`
                : '')
          + `</span>`
          + `</label>`;
      }
      html += `</div>`;
    }
    listEl.innerHTML = html;
    listEl.addEventListener('change', refreshStatus);
    refreshStatus();
  }

  function refreshStatus() {
    const listEl = modalEl.querySelector('#homebrew-filter-list');
    const statusEl = modalEl.querySelector('#homebrew-filter-status');
    if (!listEl || !statusEl) return;
    const checked = listEl.querySelectorAll('input[type=checkbox]:checked').length;
    const total = listEl.querySelectorAll('input[type=checkbox]').length;
    if (!total) { statusEl.textContent = ''; return; }
    if (!checked) {
      statusEl.textContent = 'No homebrew rules active — sheet behaves as RAW.';
      statusEl.className = 'book-filter-status book-filter-status-neutral';
    } else {
      statusEl.textContent =
        `${checked} of ${total} homebrew rules active.`;
      statusEl.className = 'book-filter-status book-filter-status-active';
    }
  }

  function applySelection() {
    const listEl = modalEl.querySelector('#homebrew-filter-list');
    const cbs = listEl.querySelectorAll('input[type=checkbox]');
    for (const cb of cbs) {
      window.HomebrewFilter.setEnabled(cb.dataset.key, cb.checked);
    }
    close();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  // ---- Open / close ------------------------------------------------------

  function open() {
    ensureModal();
    modalEl.style.display = '';
    renderList();
    document.addEventListener('keydown', onKeydown);
  }
  function close() {
    if (modalEl) modalEl.style.display = 'none';
    document.removeEventListener('keydown', onKeydown);
  }
  function onKeydown(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  }

  // ---- Init --------------------------------------------------------------

  // Insert the trigger after DOM is parsed. Order doesn't matter for
  // HomebrewFilter (already initialized when this loads).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insertTrigger);
  } else {
    insertTrigger();
  }
})();
