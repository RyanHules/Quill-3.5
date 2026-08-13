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
  // While a report is being edited inline, editingKey = '<surface>:<id>' (e.g.
  // 'sheet:r...' / 'entry:f...'). renderLists() swaps that row for an editor.
  let editingKey = null;

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
            '<textarea id="rf-report-note" rows="3" ' +
              'placeholder="What\'s wrong / what would help?  (Ctrl+Enter to add)"></textarea>' +
            '<div class="rf-report-controls">' +
              '<select id="rf-report-kind"><option value="bug">Bug</option>' +
                '<option value="feature">Feature</option></select>' +
              '<button type="button" id="rf-report-submit">Add</button>' +
            '</div>' +
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
      // ---- inline edit: enter / cancel / save ----
      const editSheet = t.closest('[data-edit-sheet]');
      if (editSheet) {
        editingKey = 'sheet:' + editSheet.getAttribute('data-edit-sheet');
        renderLists(); focusEditor(); return;
      }
      const editEntry = t.closest('[data-edit-entry]');
      if (editEntry) {
        editingKey = 'entry:' + editEntry.getAttribute('data-edit-entry');
        renderLists(); focusEditor(); return;
      }
      if (t.closest('.rf-edit-cancel')) { editingKey = null; renderLists(); return; }
      const saveSheet = t.closest('[data-save-sheet]');
      if (saveSheet && window.SheetReports) {
        const row = saveSheet.closest('.rf-item');
        const note = row.querySelector('.rf-edit-textarea').value;
        const kindEl = row.querySelector('.rf-edit-kind');
        editingKey = null;
        SheetReports.edit(saveSheet.getAttribute('data-save-sheet'),
          { note, kind: kindEl ? kindEl.value : undefined });
        return;
      }
      const saveEntry = t.closest('[data-save-entry]');
      if (saveEntry && window.ReviewFlags) {
        const row = saveEntry.closest('.rf-item');
        const note = row.querySelector('.rf-edit-textarea').value;
        editingKey = null;
        ReviewFlags.edit(saveEntry.getAttribute('data-save-entry'), { note });
        return;
      }
    });
    function submitReport() {
      const kind = modalEl.querySelector('#rf-report-kind').value;
      const noteEl = modalEl.querySelector('#rf-report-note');
      const note = noteEl.value.trim();
      if (!note || !window.SheetReports) return;
      SheetReports.add(kind, note).then(() => { noteEl.value = ''; });
    }
    modalEl.querySelector('#rf-report-submit').addEventListener('click', submitReport);
    // Ctrl/Cmd+Enter submits from the multi-line note box (plain Enter inserts
    // a newline — the box is a textarea now, not a single-line input).
    modalEl.querySelector('#rf-report-note').addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
        ev.preventDefault();
        submitReport();
      }
    });
    return modalEl;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function focusEditor() {
    const ta = modalEl && modalEl.querySelector('.rf-edit-textarea');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  // Inline editor for the row currently being edited. Preserves any in-progress
  // text across re-renders (e.g. a background poll) by reading the live textarea.
  function editorRowHtml(item, surface) {
    const existing = modalEl.querySelector('.rf-edit-textarea');
    const preserved = (existing && existing.dataset.editId === item.id)
      ? existing.value : (item.note || '');
    const kindSel = surface === 'sheet'
      ? '<select class="rf-edit-kind">' +
          `<option value="bug"${item.kind === 'bug' ? ' selected' : ''}>bug</option>` +
          `<option value="feature"${item.kind === 'feature' ? ' selected' : ''}>feature</option>` +
        '</select>'
      : '';
    return '<div class="rf-item rf-item-editing">' + kindSel +
      `<textarea class="rf-edit-textarea" data-edit-id="${escapeHtml(item.id)}" rows="2">` +
      `${escapeHtml(preserved)}</textarea>` +
      `<button type="button" class="rf-edit-save" data-save-${surface}="${escapeHtml(item.id)}">save</button>` +
      '<button type="button" class="rf-edit-cancel">cancel</button></div>';
  }

  function renderLists() {
    if (!modalEl) return;
    const sheetList = modalEl.querySelector('#rf-sheet-list');
    const entryList = modalEl.querySelector('#rf-entry-list');
    const reports = window.SheetReports ? SheetReports.getOpen() : [];
    const flags = window.ReviewFlags ? ReviewFlags.getOpen() : [];
    sheetList.innerHTML = reports.length ? reports.map(r =>
      editingKey === 'sheet:' + r.id ? editorRowHtml(r, 'sheet') :
      `<div class="rf-item"><span class="rf-kind rf-kind-${r.kind}">${r.kind}</span>` +
      `<span class="rf-note">${escapeHtml(r.note)}</span>` +
      `<button type="button" class="rf-edit-btn" data-edit-sheet="${escapeHtml(r.id)}" title="Edit report">✎</button>` +
      `<button type="button" data-resolve-sheet="${escapeHtml(r.id)}">resolve</button></div>`
    ).join('') : '<div class="rf-empty">None.</div>';
    entryList.innerHTML = flags.length ? flags.map(f =>
      editingKey === 'entry:' + f.id ? editorRowHtml(f, 'entry') :
      `<div class="rf-item"><span class="rf-ref">${escapeHtml(f.ref.name || '?')}` +
      `<span class="rf-src">${escapeHtml(f.ref.source || '')}</span></span>` +
      `<span class="rf-note">${escapeHtml(f.note || '')}</span>` +
      `<button type="button" class="rf-edit-btn" data-edit-entry="${escapeHtml(f.id)}" title="Edit flag note">✎</button>` +
      `<button type="button" data-resolve-entry="${escapeHtml(f.id)}">resolve</button></div>`
    ).join('') : '<div class="rf-empty">None.</div>';
  }

  // Re-pull both surfaces from the backend so the list reflects flags filed in
  // other concurrently-open tabs. The `*-changed` events the modules emit on
  // adopt() drive refreshBadge + renderLists, so we don't render here directly.
  function refreshFromBackend() {
    if (window.SheetReports && SheetReports.refresh) SheetReports.refresh();
    if (window.ReviewFlags && ReviewFlags.refresh) ReviewFlags.refresh();
  }

  let pollTimer = null;
  function startPoll() {
    if (pollTimer) return;
    // Only meaningful while the dashboard is open AND the tab is visible — a
    // background tab's flags will be pulled the moment it regains focus.
    pollTimer = setInterval(() => {
      // Don't pull mid-edit — a re-render would disrupt the open editor.
      if (editingKey) return;
      if (modalEl && !modalEl.hidden && document.visibilityState === 'visible') {
        refreshFromBackend();
      }
    }, 8000);
  }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function open() {
    ensureModal();
    modalEl.hidden = false;
    renderLists();
    refreshFromBackend();  // pull the freshest state on open
    startPoll();
  }
  function close() { if (modalEl) modalEl.hidden = true; stopPoll(); }

  document.addEventListener('review-flags-changed', () => { refreshBadge(); renderLists(); });
  document.addEventListener('sheet-reports-changed', () => { refreshBadge(); renderLists(); });

  // Reactive refresh on tab focus / visibility — switching back to a tab pulls
  // whatever other tabs have filed since, updating the badge even when the
  // dashboard is closed.
  window.addEventListener('focus', refreshFromBackend);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshFromBackend();
  });
  // localStorage-mode tabs share the store synchronously; the storage event
  // lets a passive tab react to a sibling tab's write without polling.
  window.addEventListener('storage', (e) => {
    if (e.key && e.key.indexOf('dnd35-flags-') === 0) refreshFromBackend();
  });

  function init() { ensureTriggerButton(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
