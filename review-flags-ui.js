// review-flags-ui.js — header ⚑ button + review dashboard modal (2026-07-09).
//
// The FILING surfaces are split by consumer: entry-review flags are filed from
// the lookup modal (review-flags.js wiring in lookup.js), and char-sheet
// bug/feature reports are filed here. This modal is the single place to SEE
// everything open — it files sheet reports and lists open items from BOTH
// surfaces with a resolve button, closing the loop the user can act on.
(function () {
  'use strict';
  let triggerBtn = null, badgeEl = null, modalEl = null;

  function openCount() {
    const s = window.SheetReports ? SheetReports.getOpen().length : 0;
    const e = window.ReviewFlags ? ReviewFlags.getOpen().length : 0;
    return s + e;
  }

  function ensureTriggerButton() {
    if (document.getElementById('review-flags-trigger-btn')) return;
    triggerBtn = document.createElement('button');
    triggerBtn.id = 'review-flags-trigger-btn';
    triggerBtn.type = 'button';
    triggerBtn.className = 'review-flags-trigger';
    triggerBtn.title = 'Review flags & report a bug / feature';
    triggerBtn.setAttribute('aria-label', 'Open review flags');
    triggerBtn.innerHTML = '<span class="rf-icon">⚑</span>' +
      '<span class="rf-badge" id="review-flags-badge" hidden></span>';
    triggerBtn.addEventListener('click', open);
    const anchor = document.getElementById('book-filter-trigger-btn') ||
                   document.getElementById('lookup-trigger-btn');
    const header = document.querySelector('header');
    if (anchor && anchor.parentNode === header) header.insertBefore(triggerBtn, anchor);
    else if (header) header.appendChild(triggerBtn);
    else document.body.appendChild(triggerBtn);
    badgeEl = triggerBtn.querySelector('#review-flags-badge');
    refreshBadge();
  }

  function refreshBadge() {
    if (!badgeEl) return;
    const n = openCount();
    badgeEl.textContent = String(n);
    badgeEl.hidden = n === 0;
    triggerBtn.classList.toggle('review-flags-active', n > 0);
  }

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.className = 'review-flags-modal';
    modalEl.hidden = true;
    modalEl.innerHTML =
      '<div class="rf-backdrop" data-rf-close></div>' +
      '<div class="rf-card" role="dialog" aria-label="Review flags">' +
        '<div class="rf-head"><h2>Review &amp; Reports</h2>' +
          '<button type="button" class="rf-close" data-rf-close>×</button></div>' +
        '<div class="rf-report-form">' +
          '<label>Report a sheet bug / feature</label>' +
          '<div class="rf-report-row">' +
            '<select id="rf-report-kind"><option value="bug">Bug</option>' +
              '<option value="feature">Feature</option></select>' +
            '<input type="text" id="rf-report-note" placeholder="What\'s wrong / what would help?">' +
            '<button type="button" id="rf-report-submit">Add</button>' +
          '</div>' +
        '</div>' +
        '<div class="rf-section"><h3>Open sheet reports</h3>' +
          '<div id="rf-sheet-list" class="rf-list"></div></div>' +
        '<div class="rf-section"><h3>Open entry-review flags</h3>' +
          '<div id="rf-entry-list" class="rf-list"></div></div>' +
      '</div>';
    document.body.appendChild(modalEl);

    modalEl.addEventListener('click', (ev) => {
      const t = ev.target;
      if (t.closest('[data-rf-close]')) { close(); return; }
      const resolveSheet = t.closest('[data-resolve-sheet]');
      if (resolveSheet && window.SheetReports) {
        SheetReports.resolve(resolveSheet.getAttribute('data-resolve-sheet'));
        return;
      }
      const resolveEntry = t.closest('[data-resolve-entry]');
      if (resolveEntry && window.ReviewFlags) {
        ReviewFlags.resolve(resolveEntry.getAttribute('data-resolve-entry'));
        return;
      }
    });
    modalEl.querySelector('#rf-report-submit').addEventListener('click', () => {
      const kind = modalEl.querySelector('#rf-report-kind').value;
      const noteEl = modalEl.querySelector('#rf-report-note');
      const note = noteEl.value.trim();
      if (!note || !window.SheetReports) return;
      SheetReports.add(kind, note).then(() => { noteEl.value = ''; });
    });
    return modalEl;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function renderLists() {
    if (!modalEl) return;
    const sheetList = modalEl.querySelector('#rf-sheet-list');
    const entryList = modalEl.querySelector('#rf-entry-list');
    const reports = window.SheetReports ? SheetReports.getOpen() : [];
    const flags = window.ReviewFlags ? ReviewFlags.getOpen() : [];
    sheetList.innerHTML = reports.length ? reports.map(r =>
      `<div class="rf-item"><span class="rf-kind rf-kind-${r.kind}">${r.kind}</span>` +
      `<span class="rf-note">${escapeHtml(r.note)}</span>` +
      `<button type="button" data-resolve-sheet="${escapeHtml(r.id)}">resolve</button></div>`
    ).join('') : '<div class="rf-empty">None.</div>';
    entryList.innerHTML = flags.length ? flags.map(f =>
      `<div class="rf-item"><span class="rf-ref">${escapeHtml(f.ref.name || '?')}` +
      `<span class="rf-src">${escapeHtml(f.ref.source || '')}</span></span>` +
      `<span class="rf-note">${escapeHtml(f.note || '')}</span>` +
      `<button type="button" data-resolve-entry="${escapeHtml(f.id)}">resolve</button></div>`
    ).join('') : '<div class="rf-empty">None.</div>';
  }

  function open() { ensureModal(); modalEl.hidden = false; renderLists(); }
  function close() { if (modalEl) modalEl.hidden = true; }

  document.addEventListener('review-flags-changed', () => { refreshBadge(); renderLists(); });
  document.addEventListener('sheet-reports-changed', () => { refreshBadge(); renderLists(); });

  function init() { ensureTriggerButton(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
