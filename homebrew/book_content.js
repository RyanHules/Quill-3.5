// homebrew/book_content.js — surface homebrew BOOKS in the homebrew
// filter modal, alongside the per-subsystem rule toggles.
//
// Why this exists
// ---------------
// The HomebrewFilter modal was originally designed for per-rule
// subsystem toggles (Item Familiar variants, etc.). When Diamond Soul
// shipped a homebrew BOOK (the Tidecaller PrC + Rooted Calling feat)
// it went into the BookFilter — visible in the 📚 modal but invisible
// in the 🏠 modal. The user expected to find ALL homebrew content in
// the 🏠 modal, since "homebrew" is the right mental category for
// campaign-specific extensions regardless of whether they're rules or
// content.
//
// This module bridges that gap: at module load, it queries the DB
// for every book with `book_type = 'homebrew'` and registers a
// HomebrewFilter rule per book, in a "Homebrew content" category.
// The rule:
//   - displays the book name + a description listing the entries it
//     contains (so the user can see Tidecaller / Rooted Calling /
//     etc. without having to dig into pickers)
//   - has `informational: true` because the actual visibility gate
//     still lives in BookFilter — toggling here is a convenience
//     view, not a separate filter axis
//   - when toggled in the 🏠 modal, mirrors the change to BookFilter
//     so the two stay coherent
//   - listens to `book-filter-changed` and re-applies its own state
//     so a change in the 📚 modal updates the 🏠 modal's checkbox
//
// Adding a new homebrew book? Nothing to do here — register it in
// the DB with book_type='homebrew' (per build_sqlite_db.py's
// BOOK_METADATA) and this module will pick it up automatically.

(function () {
  if (!window.HomebrewFilter) {
    console.warn('[homebrew/book_content] HomebrewFilter not loaded; ' +
      'homebrew book entries will not appear in the toggle UI.');
    return;
  }
  if (!window.DB || !window.DB.ready) {
    console.warn('[homebrew/book_content] DB not loaded; ' +
      'homebrew book entries will not appear in the toggle UI.');
    return;
  }

  // Rule key prefix so we can identify which rules belong to us
  // (vs. the per-subsystem rules registered by other modules).
  const KEY_PREFIX = 'book_';

  // Track which books we registered, keyed by abbreviation, so we
  // can sync state with BookFilter without rescanning the DB.
  // value: { abbrev, name, ruleKey }
  const registered = new Map();

  // ---- DB-driven registration ---------------------------------------------

  DB.ready.then(() => {
    if (!DB.isLoaded()) return;

    // Pull every homebrew book + a summary line listing its entries.
    let books = [];
    try {
      books = DB.query(
        "SELECT abbreviation, name, summary " +
        "FROM book WHERE book_type = 'homebrew' " +
        "ORDER BY name");
    } catch (err) {
      console.warn('[homebrew/book_content] DB query failed:', err);
      return;
    }
    if (!books.length) return;

    for (const b of books) {
      registerBookRule(b);
    }
    // Apply initial state from BookFilter so the checkboxes load
    // matching what the book filter currently allows.
    syncFromBookFilter();
  });

  // ---- Per-book rule registration -----------------------------------------

  function registerBookRule(book) {
    const abbrev = book.abbreviation;
    if (!abbrev) return;
    const ruleKey = KEY_PREFIX + abbrev;

    // Entry inventory — describe what the book provides so the user
    // can decide whether to enable it without opening a picker.
    let entries = [];
    try {
      entries = DB.query(
        "SELECT type, name FROM entry " +
        "WHERE source = $src ORDER BY type, name",
        { $src: book.name });
    } catch (_) {
      // Non-fatal — we'll just show the book summary instead.
    }
    const typeLabel = { prc: 'PrC', feat: 'Feat', spell: 'Spell',
                        item: 'Item', class: 'Class', race: 'Race',
                        domain: 'Domain', deity: 'Deity',
                        invocation: 'Invocation', maneuver: 'Maneuver',
                        mystery: 'Mystery', power: 'Power',
                        rule: 'Rule', template: 'Template',
                        creature: 'Creature', soulmeld: 'Soulmeld',
                        vestige: 'Vestige', plane: 'Plane',
                        organization: 'Organization' };
    const inventory = entries.length
      ? entries.map(e =>
          `${typeLabel[e.type] || e.type}: ${e.name}`
        ).join('; ')
      : null;

    const description = inventory
      ? `Contents: ${inventory}.`
      : (book.summary || '(homebrew book — no description on file)');

    HomebrewFilter.registerRule({
      key: ruleKey,
      name: book.name,
      category: 'Homebrew content',
      description,
      defaultEnabled: false,
      informational: true,  // visibility actually lives in BookFilter
      source: book.name,
    });
    registered.set(abbrev, { abbrev, name: book.name, ruleKey });
  }

  // ---- BookFilter ↔ HomebrewFilter state bridge ---------------------------

  // Internal flag to suppress feedback loops while we're mid-sync.
  let syncing = false;

  function syncFromBookFilter() {
    if (!window.BookFilter) return;
    const active = BookFilter.getActiveAbbrevs();
    // Empty active set = "all books allowed" (BookFilter default).
    // So if active is empty, every homebrew book counts as enabled.
    const allAllowed = active.size === 0;
    syncing = true;
    try {
      for (const [abbrev, info] of registered) {
        const on = allAllowed || active.has(abbrev);
        HomebrewFilter.setEnabled(info.ruleKey, on);
      }
    } finally {
      syncing = false;
    }
  }

  function syncToBookFilter(ruleKey, enabled) {
    if (syncing || !window.BookFilter) return;
    // Find the abbrev for this rule.
    let target = null;
    for (const info of registered.values()) {
      if (info.ruleKey === ruleKey) { target = info; break; }
    }
    if (!target) return;

    const active = new Set(BookFilter.getActiveAbbrevs());
    if (active.size === 0) {
      // The "all books allowed" default means toggling a single
      // homebrew rule shouldn't suddenly narrow the filter to JUST
      // that book — that would be surprising. So if the user
      // ENABLES while everything is implicitly allowed, do nothing
      // (the rule is already effectively on). If they DISABLE in
      // this state, we have to seed the active set with everything
      // EXCEPT the disabled book, otherwise the disable does
      // nothing.
      if (enabled) return;
      const allBooks = BookFilter.getBooks();
      const seeded = new Set();
      for (const b of allBooks) {
        if (b.abbreviation !== target.abbrev) seeded.add(b.abbreviation);
      }
      BookFilter.setActiveAbbrevs(seeded);
      return;
    }
    // Active set is non-empty — just add or remove the abbrev.
    if (enabled) {
      active.add(target.abbrev);
    } else {
      active.delete(target.abbrev);
    }
    BookFilter.setActiveAbbrevs(active);
  }

  // Listen for changes from EITHER side.
  document.addEventListener('homebrew-filter-changed', (ev) => {
    const key = ev.detail && ev.detail.key;
    if (!key) {
      // Bulk load (character load with saved homebrew state). We
      // intentionally do NOT sync to BookFilter on bulk loads — the
      // character's own BookFilter save data handles its visibility.
      return;
    }
    if (!key.startsWith(KEY_PREFIX)) return;
    syncToBookFilter(key, HomebrewFilter.isEnabled(key));
  });

  document.addEventListener('book-filter-changed', () => {
    syncFromBookFilter();
  });

  // Expose a tiny module surface (mostly for debugging).
  window.HomebrewBookContent = {
    getRegistered() { return [...registered.values()]; },
    refresh: syncFromBookFilter,
  };
})();
