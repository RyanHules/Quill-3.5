// errata-badge.js — Reusable ✦ badge that surfaces errata records
// attached to any `entry`. Used by the universal lookup modal and
// every per-picker info panel.
//
// Public API:
//
//   ErrataBadge.hasErrata(entryId) → bool
//   ErrataBadge.indicator(entryId) → DOMNode | null
//       small non-clickable ✦ marker, for use in tight rows
//   ErrataBadge.badge(entryId, opts?) → DOMNode | null
//       full button that opens a popover with the diff list
//
// `opts.applied` (default FALSE as of 2026-06-10): when true, only
// renders if the entry has at least one mechanically-applied errata
// record. Default surfaces ANY record, advisory-only included —
// Ryan's call: there's no way to know whether advisory info is
// relevant to the user, so it must be available everywhere it can
// be. (The popover labels each record applied / advisory, so no
// information is lost by showing the badge.)
//
// `opts.label` (default '✦'): the text inside the badge.
//
// CROSS-PRINTING LOOKUP (2026-06-10): errata records attach to ONE
// entry row, but the same item can be printed in several books
// (Astral Construct: XPH and Complete Psionic, both 3.5 — the XPH
// errata hangs on the XPH row while the power-picker's name-dedupe
// resolves the CPsi row). hasErrata / badge / the popover therefore
// fall back to "any entry with the same (type, version, name)"
// when the given id has no records of its own, and the popover
// aggregates records across those printings. Version is part of
// the key DELIBERATELY: uniting 3.0/3.5 same-name entries would be
// exactly the Dimensional Lock-style edition conflation the
// VersionBadge work (2026-05-19) exists to prevent.

(function () {
  if (!window.DB) {
    console.warn('[errata-badge] DB module not loaded');
    return;
  }

  // Build the index lazily on first use so we don't block init.
  // Set<entry_id> for entries with at least one applied errata; same
  // for any errata (incl. advisory). Plus a same-printing-family
  // map: 'type|version|lowername' → Set<entry_id> of errata-bearing
  // rows, for the cross-printing fallback.
  let appliedIds = null;
  let anyIds = null;
  let familyToIds = null;   // Map<famKey, Set<entry_id>> (errata-bearing only)
  let appliedFams = null;   // Set<famKey> with >=1 applied record
  const idToFamCache = new Map();  // entry_id → famKey (lazy, all entries)

  function famKeyOf(type, version, name) {
    return `${type || ''}|${version || ''}|${String(name || '').toLowerCase()}`;
  }

  function buildIndex() {
    if (appliedIds !== null) return;
    appliedIds = new Set();
    anyIds = new Set();
    familyToIds = new Map();
    appliedFams = new Set();
    if (!DB.isLoaded()) return;
    const rows = DB.query(
      "SELECT er.entry_id, er.applied, e.type, e.version, e.name "
      + "FROM errata er JOIN entry e ON e.id = er.entry_id");
    for (const r of rows) {
      anyIds.add(r.entry_id);
      if (r.applied) appliedIds.add(r.entry_id);
      const fam = famKeyOf(r.type, r.version, r.name);
      if (!familyToIds.has(fam)) familyToIds.set(fam, new Set());
      familyToIds.get(fam).add(r.entry_id);
      if (r.applied) appliedFams.add(fam);
    }
  }

  // famKey for ANY entry id (not just errata-bearing ones) — one
  // small query per distinct id, cached. Used by the cross-printing
  // fallback when the direct id carries no records.
  function famKeyForId(id) {
    if (idToFamCache.has(id)) return idToFamCache.get(id);
    let key = null;
    if (DB.isLoaded()) {
      const row = DB.queryOne(
        "SELECT type, version, name FROM entry WHERE id = ?", [id]);
      if (row) key = famKeyOf(row.type, row.version, row.name);
    }
    idToFamCache.set(id, key);
    return key;
  }

  function hasErrata(entryId, opts = {}) {
    buildIndex();
    if (entryId == null) return false;
    const id = Number(entryId);
    const appliedOnly = opts.applied === true;
    // Direct hit on this row.
    if (appliedOnly ? appliedIds.has(id) : anyIds.has(id)) return true;
    // Cross-printing fallback: same type+version+name, different row.
    const fam = famKeyForId(id);
    if (!fam || !familyToIds.has(fam)) return false;
    return appliedOnly ? appliedFams.has(fam) : true;
  }

  // All errata-bearing entry ids relevant to this id (itself +
  // same-family printings). Used by the popover query.
  function errataIdsFor(entryId) {
    buildIndex();
    const id = Number(entryId);
    const ids = new Set();
    if (anyIds.has(id)) ids.add(id);
    const fam = famKeyForId(id);
    if (fam && familyToIds.has(fam)) {
      for (const fid of familyToIds.get(fam)) ids.add(fid);
    }
    return [...ids];
  }

  function indicator(entryId, opts = {}) {
    if (!hasErrata(entryId, opts)) return null;
    const span = document.createElement('span');
    span.className = 'errata-indicator';
    span.title = 'This entry has errata — open detail to see the diff.';
    span.setAttribute('aria-label', 'errata available');
    span.textContent = opts.label || '✦';
    return span;
  }

  function badge(entryId, opts = {}) {
    if (!hasErrata(entryId, opts)) return null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'errata-badge';
    btn.title = 'Show errata';
    btn.setAttribute('aria-label', 'Show errata for this entry');
    btn.textContent = opts.label || '✦ errata';
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      togglePopover(btn, entryId);
    });
    return btn;
  }

  // --- Popover ------------------------------------------------------------

  let popoverEl = null;
  let popoverAnchor = null;

  function togglePopover(anchor, entryId) {
    if (popoverEl && popoverAnchor === anchor) {
      closePopover();
      return;
    }
    openPopover(anchor, entryId);
  }

  function openPopover(anchor, entryId) {
    closePopover();
    // Aggregate across same-(type, version, name) printings so e.g.
    // the Complete Psionic row of Astral Construct surfaces the
    // records attached to the XPH row. Each record's `source` names
    // the errata document, so provenance stays visible.
    const ids = errataIdsFor(entryId);
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    const records = DB.query(
      "SELECT source, kind, field, from_text, to_text, applied, note "
      + "FROM errata WHERE entry_id IN (" + placeholders + ") "
      + "ORDER BY applied DESC, kind, field", ids
    );
    if (!records.length) return;
    popoverEl = document.createElement('div');
    popoverEl.className = 'errata-popover';
    popoverEl.innerHTML = renderRecords(records);
    document.body.appendChild(popoverEl);
    position(popoverEl, anchor);
    popoverAnchor = anchor;
    // Click outside or Esc closes.
    setTimeout(() => {
      document.addEventListener('click', onOutsideClick, true);
      document.addEventListener('keydown', onEsc, true);
    }, 0);
  }

  function closePopover() {
    if (!popoverEl) return;
    popoverEl.remove();
    popoverEl = null;
    popoverAnchor = null;
    document.removeEventListener('click', onOutsideClick, true);
    document.removeEventListener('keydown', onEsc, true);
  }

  function onOutsideClick(ev) {
    if (!popoverEl) return;
    if (popoverEl.contains(ev.target)) return;
    if (popoverAnchor && popoverAnchor.contains(ev.target)) return;
    closePopover();
  }

  function onEsc(ev) {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      closePopover();
    }
  }

  function position(el, anchor) {
    const r = anchor.getBoundingClientRect();
    // Render below the badge by default; flip up if it'd run off the
    // bottom of the viewport.
    const wantWidth = Math.min(420, window.innerWidth - 32);
    el.style.maxWidth = wantWidth + 'px';
    el.style.position = 'fixed';
    // Provisional render to measure.
    el.style.left = '0px';
    el.style.top = '0px';
    el.style.visibility = 'hidden';
    el.style.display = 'block';
    const h = el.offsetHeight;
    const below = r.bottom + 6;
    const above = r.top - h - 6;
    const top = (below + h <= window.innerHeight - 8 || above < 8)
      ? below : above;
    let left = r.left;
    if (left + wantWidth > window.innerWidth - 8) {
      left = window.innerWidth - wantWidth - 8;
    }
    if (left < 8) left = 8;
    el.style.top = top + 'px';
    el.style.left = left + 'px';
    el.style.visibility = '';
  }

  function renderRecords(records) {
    const head = `<div class="errata-popover-head">` +
      `<b>Errata (${records.length})</b>` +
      `<button type="button" class="errata-popover-close" ` +
      `aria-label="Close">×</button>` +
      `</div>`;
    const items = records.map(r => {
      const status = r.applied
        ? `<span class="errata-applied">applied</span>`
        : `<span class="errata-advisory">advisory</span>`;
      const tag = `<span class="errata-kind">${escapeHtml(r.kind || '')}</span>`;
      const fld = r.field
        ? `<span class="errata-field">${escapeHtml(r.field)}</span>` : '';
      const src = `<span class="errata-source">${escapeHtml(r.source || '')}</span>`;
      const diff = (r.from_text || r.to_text)
        ? `<div class="errata-diff">` +
          (r.from_text
            ? `<div class="errata-from">– ${escapeHtml(r.from_text)}</div>`
            : '') +
          (r.to_text
            ? `<div class="errata-to">+ ${escapeHtml(r.to_text)}</div>`
            : '') +
          `</div>`
        : '';
      const note = r.note
        ? `<div class="errata-note">${escapeHtml(r.note)}</div>` : '';
      return `<div class="errata-record">` +
        `<div class="errata-record-head">${status} ${tag} ${fld} ${src}</div>` +
        `${diff}${note}` +
        `</div>`;
    }).join('');
    return head + `<div class="errata-popover-body">${items}</div>`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Delegated close-button click inside the popover.
  document.addEventListener('click', (ev) => {
    if (ev.target instanceof Element &&
        ev.target.classList.contains('errata-popover-close')) {
      closePopover();
    }
  }, true);

  // Convenience wrapper used by the per-picker info panels. Most
  // pickers build their info with `info.innerHTML = bits.join(...)`
  // where the first bit is a `<b>{name}</b>` title. We find that
  // first `<b>` and splice the badge in right after it so the ✦
  // sits inline with the entry name.
  //
  // Some pickers (notably race-picker) lead with a label-style
  // `<b>Ability:</b>` instead of a name — for those we fall back to
  // prepending the badge at the top of the panel.
  //
  // Advisory-inclusive by default — that's now the module-wide
  // default in hasErrata, so no per-call opt-in is needed.
  function attach(infoEl, entryId, opts) {
    if (!infoEl || entryId == null) return;
    const o = opts || {};
    // Avoid duplicates on repeated renders (some pickers re-run
    // updateInfo() on every keystroke).
    infoEl.querySelectorAll('.errata-badge-inline').forEach(b => b.remove());
    if (!hasErrata(entryId, o)) return;
    const btn = badge(entryId, o);
    if (!btn) return;
    btn.classList.add('errata-badge-inline');
    const firstB = infoEl.querySelector('b');
    const labelish = firstB && /:\s*$/.test(firstB.textContent || '');
    if (firstB && !labelish && (!opts || opts.position !== 'prepend')) {
      firstB.insertAdjacentElement('afterend', btn);
    } else {
      infoEl.prepend(btn);
    }
  }

  window.ErrataBadge = { hasErrata, indicator, badge, attach };
})();
