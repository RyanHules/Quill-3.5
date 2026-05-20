// version-badge.js — Reusable "version pill" UI exposed as global
// `VersionBadge` object.
//
// Why this exists: the DB carries entries from both 3.0 and 3.5
// sourcebooks (FR splats, Manual of the Planes, Magic of Faerun, etc.
// are 3.0). When two printings of the same entry exist, the picker
// source-recency tiebreak prefers the 3.5 version, but 3.0 entries
// still surface in the lookup modal and as fallback content. Without
// a visible label, a player can pick up a 3.0 spell / item / feat
// without realizing the mechanics may differ from 3.5 canon.
//
// The Dimensional Lock incident (2026-05-19): user found a 3.0 MoF
// entry showing alongside the 3.5 PHB entry; the version was
// rendered as low-opacity inline text and was easy to miss. The
// badge below replaces that subtle treatment with a colored chip.
//
// Public API:
//   VersionBadge.html(version)     — returns HTML string for the badge,
//                                     or '' if version is missing / '3.5'
//   VersionBadge.element(version)  — returns a DOM Node, or null
//   VersionBadge.alwaysHtml(v)     — same as html() but also renders
//                                     a 3.5 badge (used when explicit
//                                     parity is desired)
//
// Pass the version string from the entry — e.g. '3.0', '3.5', '3.0e'.
//
// Style: defined in styles.css under `.version-badge`. 3.0 entries
// get an amber chip; 3.5 entries get a muted gray chip (rendered only
// by alwaysHtml so the default presentation stays uncluttered).

(function () {
  function classify(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (!s) return null;
    // Strip patch suffixes ("3.0e", "3.5r") to the major version.
    const m = /^(\d+\.\d+)/.exec(s);
    const major = m ? m[1] : s;
    if (major === '3.5') return { cls: 'version-badge--35', label: '3.5' };
    if (major === '3.0') return { cls: 'version-badge--30', label: '3.0' };
    // Unknown version (homebrew, future printings, etc.) — render the
    // raw string in a neutral chip so the user knows it isn't 3.5.
    return { cls: 'version-badge--other', label: s };
  }

  function html(version) {
    const c = classify(version);
    if (!c || c.label === '3.5') return '';
    return `<span class="version-badge ${c.cls}" title="Edition: ${c.label}">${c.label}</span>`;
  }

  function alwaysHtml(version) {
    const c = classify(version);
    if (!c) return '';
    return `<span class="version-badge ${c.cls}" title="Edition: ${c.label}">${c.label}</span>`;
  }

  function element(version) {
    const c = classify(version);
    if (!c || c.label === '3.5') return null;
    const span = document.createElement('span');
    span.className = `version-badge ${c.cls}`;
    span.title = `Edition: ${c.label}`;
    span.textContent = c.label;
    return span;
  }

  // Convenience: prepend a version badge to a picker's info panel.
  // Skipped silently when the entry is 3.5 (no badge needed) or when
  // a badge is already attached (idempotent across re-renders that
  // didn't clear the panel first). Designed to match the call shape
  // of ErrataBadge.attach so picker code stays uniform.
  function attach(panelEl, version, _opts) {
    if (!panelEl) return;
    // Idempotency — don't double-attach if a re-render is in flight.
    const existing = panelEl.querySelector(':scope > .version-badge');
    if (existing) existing.remove();
    const el = element(version);
    if (!el) return;
    el.classList.add('version-badge--leading');
    panelEl.insertBefore(el, panelEl.firstChild);
  }

  window.VersionBadge = { html, alwaysHtml, element, attach, classify };
})();
