// homebrew/book_content.js — surface homebrew BOOKS in the homebrew
// filter modal as parent/child nested toggles.
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
// Shape of the registration
// -------------------------
// For each homebrew book (book_type='homebrew' in the DB), we
// register:
//
//   * A parent RULE (`book_<abbr>`) that appears in the homebrew
//     modal under "Homebrew content". It's informational — the
//     actual visibility gating is done by the children.  The UI
//     uses the parent for bulk-toggling: clicking it sets all
//     children to the parent's new state.
//
//   * One child ENTRY per content item in the book
//     (`entry_<abbr>_<slug>`), registered via
//     `HomebrewFilter.registerEntry`. Each child's state controls
//     whether that specific (source, type, name) shows up in
//     pickers / lookup — gated through
//     `BookFilter.allowsEntry` → `HomebrewFilter.allowsEntry`.
//
// Defaults: parent + children all OFF, matching the
// "RAW by default, homebrew is opt-in" convention.
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

  // Track books and their child entry keys so the homebrew-filter-ui
  // can render parent/child structure without re-querying the DB.
  // value: { abbrev, name, parentKey, childKeys: [string, ...] }
  const registered = new Map();

  DB.ready.then(() => {
    if (!DB.isLoaded()) return;

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
      registerBookAndContents(b);
    }
  });

  // ---- Registration -------------------------------------------------------

  // Human-friendly type labels for the description / child name
  // prefixes. Falls back to the raw type if not listed.
  const TYPE_LABEL = {
    prc: 'Prestige Class', feat: 'Feat', spell: 'Spell',
    item: 'Item', class: 'Class', race: 'Race',
    domain: 'Domain', deity: 'Deity', invocation: 'Invocation',
    maneuver: 'Maneuver', mystery: 'Mystery', power: 'Power',
    rule: 'Rule', template: 'Template', creature: 'Creature',
    soulmeld: 'Soulmeld', vestige: 'Vestige', plane: 'Plane',
    organization: 'Organization', acf: 'ACF',
    subst_level: 'Substitution Level', skill_trick: 'Skill Trick',
  };

  function _slug(s) {
    return String(s || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  function registerBookAndContents(book) {
    const abbrev = book.abbreviation;
    if (!abbrev) return;
    const parentKey = 'book_' + abbrev;

    // Pull every entry in this book so we can register one child
    // toggle each.
    let entries = [];
    try {
      entries = DB.query(
        "SELECT type, name FROM entry " +
        "WHERE source = $src ORDER BY type, name",
        { $src: book.name });
    } catch (_) {
      // Non-fatal — the parent rule still registers, children just
      // won't appear. That degrades to "whole book is one toggle".
    }

    // Parent rule. Description summarizes the contents for users
    // who haven't expanded the children list yet.
    const inventoryText = entries.length
      ? 'Contains: ' + entries.map(e =>
          `${TYPE_LABEL[e.type] || e.type} — ${e.name}`
        ).join('; ') + '.'
      : (book.summary || '(homebrew book — no entries indexed)');
    HomebrewFilter.registerRule({
      key: parentKey,
      name: book.name,
      category: 'Homebrew content',
      description: inventoryText,
      defaultEnabled: false,
      informational: true,
      source: book.name,
    });

    // Children. Each registers its own state via registerEntry so
    // it can gate visibility independently.
    const childKeys = [];
    for (const e of entries) {
      const eKey = 'entry_' + abbrev + '_' + _slug(e.type) + '_'
        + _slug(e.name);
      HomebrewFilter.registerEntry({
        key: eKey,
        name: e.name,
        type: e.type,
        source: book.name,
        parentKey,
        defaultEnabled: false,
      });
      childKeys.push(eKey);
    }

    registered.set(abbrev, {
      abbrev,
      name: book.name,
      parentKey,
      childKeys,
    });
  }

  // ---- Module surface (for UI + debugging) --------------------------------

  // Bulk-toggle a parent's children. Used by the UI when the user
  // clicks the parent checkbox. Fires only the per-child events
  // (each setEnabled emits one); the UI can debounce its re-render
  // if needed.
  function setBookEnabled(parentKey, enabled) {
    for (const info of registered.values()) {
      if (info.parentKey !== parentKey) continue;
      for (const ck of info.childKeys) {
        HomebrewFilter.setEnabled(ck, enabled);
      }
      return;
    }
  }

  // Derive parent state from its children. Returns:
  //   'all'   — every child enabled
  //   'none'  — every child disabled
  //   'some'  — mixed (used to render an indeterminate checkbox)
  function getBookState(parentKey) {
    let on = 0, off = 0;
    for (const info of registered.values()) {
      if (info.parentKey !== parentKey) continue;
      for (const ck of info.childKeys) {
        if (HomebrewFilter.isEnabled(ck)) on++; else off++;
      }
      break;
    }
    if (on && !off) return 'all';
    if (off && !on) return 'none';
    return 'some';
  }

  window.HomebrewBookContent = {
    getRegistered() { return [...registered.values()]; },
    setBookEnabled,
    getBookState,
  };
})();
