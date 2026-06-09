// rich-text.js — Shared renderers for rich DB content, exposed as
// global `RichText`. Two jobs:
//
//   1. renderTable / renderTables — turn an entry's structured
//      `tables` field into real HTML tables. The DB carries TWO key
//      dialects (846 entries across 17 types, audited 2026-06-09):
//        - {caption, columns, rows}   — 439 tables (walk-era shape)
//        - {name, headers, rows}      — 16 tables (2026-05-24 Core
//          rules shape)
//      plus optional extras that appear in small numbers: `notes` /
//      `footnotes` / `footnote` / `note` (string OR list of strings)
//      and `header` (a single spanning column-group line, e.g.
//      "Ability Score | Bonus Power Points by Class Level"). A
//      renderer that reads only one dialect silently degrades the
//      other to a JSON dump — that was a live bug in lookup.js's
//      renderRuleTable before this module existed.
//
//   2. formatFeatureText — long-form prose legibility for class
//      features (and any other long DB text). Escapes, converts
//      newlines to <br>, bolds line-start sub-headings ("Calling a
//      Spell:" …), and auto-collapses anything over `collapseAt`
//      chars (default 3000) into a native <details> expander showing
//      the first few sentences. Flat OCR blobs (no newlines — e.g.
//      Geomancer's 7k-char Drift) get NO heading heuristics, only
//      the collapse: inline heading detection on unstructured text
//      is too false-positive-prone to ship.
//
// No DB access, no DOM access at module load — pure string → HTML
// helpers, callable from Node (tests) with a stub `window`.

(function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- Tables -------------------------------------------------------------

  // Collect the table's footnote-ish extras under their four key
  // spellings; normalize string-or-list to a list of strings.
  function tableNotes(t) {
    const v = t.notes ?? t.footnotes ?? t.footnote ?? t.note;
    if (v == null || v === '') return [];
    return Array.isArray(v) ? v.map(x => String(x)) : [String(v)];
  }

  // Render one table object into HTML. Emits the existing
  // .lookup-rule-table classes (styles.css rules are unscoped, so
  // picker info panels get the same styling for free) alongside
  // rt-* classes for any future divergence.
  function renderTable(t) {
    if (t == null) return '';
    if (typeof t === 'string') {
      return `<pre class="rt-table-freeform">${escapeHtml(t)}</pre>`;
    }
    const cap = t.caption || t.name || t.title || '';
    const capHtml = cap
      ? `<div class="rt-table-caption lookup-rule-table-caption">${escapeHtml(cap)}</div>`
      : '';
    const notesHtml = tableNotes(t).map(n =>
      `<div class="rt-table-notes lookup-rule-table-notes">${escapeHtml(n)}</div>`
    ).join('');
    const cols = Array.isArray(t.columns) ? t.columns
               : Array.isArray(t.headers) ? t.headers : null;
    const rows = Array.isArray(t.rows) ? t.rows : null;

    if (rows) {
      // Spanning column-group header line (rare `header` key).
      const span = (typeof t.header === 'string' && t.header.trim() && cols)
        ? `<tr><th class="rt-table-span" colspan="${cols.length}">` +
          `${escapeHtml(t.header)}</th></tr>`
        : '';
      const head = cols
        ? `<tr>${cols.map(h => `<th>${escapeHtml(String(h))}</th>`).join('')}</tr>`
        : '';
      const body = rows.map(row => {
        if (Array.isArray(row)) {
          return `<tr>${row.map(c =>
            `<td>${escapeHtml(c == null ? '' : String(c))}</td>`).join('')}</tr>`;
        }
        // Object rows keyed by column name (legacy Core-rules shape).
        if (row && typeof row === 'object' && cols) {
          return `<tr>${cols.map(h =>
            `<td>${escapeHtml(String(row[h] ?? ''))}</td>`).join('')}</tr>`;
        }
        return '';
      }).join('');
      return capHtml +
        `<table class="rt-table lookup-rule-table">${span}${head}${body}</table>` +
        notesHtml;
    }

    // No rows array at all — freeform fallback. Should not fire for
    // any current DB shape (audited 2026-06-09: all 498 tables carry
    // rows + columns|headers); kept for defensive coverage of future
    // extractions.
    const text = typeof t.text === 'string' ? t.text : JSON.stringify(t);
    return capHtml +
      `<pre class="rt-table-freeform">${escapeHtml(text)}</pre>` +
      notesHtml;
  }

  // Render a `tables` list. Returns '' for missing/empty input so
  // callers can unconditionally concatenate.
  function renderTables(tables) {
    if (!Array.isArray(tables) || !tables.length) return '';
    return tables.map(renderTable).filter(Boolean).join('');
  }

  // ---- Long-form feature text ----------------------------------------------

  // Escape + structure a prose body: newlines become <br>, and when
  // the text has real newlines, line-start "Heading Words:" runs are
  // bolded so sub-structure surfaces visually (Mage of the Arcane
  // Order's "Calling a Spell:" / "Spellpool Debt:", Paragnostic
  // Apostle's per-power list, …). Flat single-blob texts are left
  // unstyled — a mid-sentence "for example:" must not turn bold.
  function formatBody(s) {
    let h = escapeHtml(s);
    if (/\n/.test(s)) {
      h = h.replace(
        /(^|\n)([A-Z][A-Za-z0-9'’()/ -]{2,60}:)(?=\s)/g,
        (m, pre, head) => `${pre}<b>${head}</b>`
      );
    }
    return h.replace(/\n/g, '<br>');
  }

  // Pick a lead snippet for the collapsed view: whole sentences up
  // to `max` chars; fall back to a word boundary when the text has
  // no usable early sentence break.
  function pickLead(s, max) {
    let end = 0;
    const re = /[.!?](?=\s|$)/g;
    let m;
    while ((m = re.exec(s))) {
      const e = m.index + 1;
      if (e > max) break;
      end = e;
    }
    if (end < 80) {
      const cut = s.lastIndexOf(' ', max);
      end = cut > 80 ? cut : Math.min(max, s.length);
    }
    return s.slice(0, end);
  }

  // Format a (possibly long) feature text. Under `collapseAt` chars
  // (default 3000 — catches the ~23 wall-of-text class features
  // while leaving merely-long ones expanded) the body renders fully;
  // over it, a native <details> shows the first few sentences with
  // the rest behind a "show full text" toggle. Native <details>
  // needs no click-handler wiring, so the same HTML works in the
  // lookup modal, picker info panels, and the Feats-tab ⓘ panels.
  function formatFeatureText(text, opts) {
    const s = String(text == null ? '' : text);
    if (!s) return '';
    const collapseAt = (opts && opts.collapseAt) || 3000;
    if (s.length <= collapseAt) return formatBody(s);
    const lead = pickLead(s, (opts && opts.leadChars) || 300);
    const rest = s.slice(lead.length).replace(/^\s+/, '');
    return `<details class="rt-collapse">` +
      `<summary>` +
      `<span class="rt-collapse-lead">${formatBody(lead)}</span>` +
      `<span class="rt-collapse-hint"> … show full text ▾</span>` +
      `</summary>` +
      `<span class="rt-collapse-rest">${formatBody(rest)}</span>` +
      `</details>`;
  }

  window.RichText = {
    escapeHtml,
    renderTable,
    renderTables,
    formatFeatureText,
  };
})();
