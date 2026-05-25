// book-filter.js — campaign-scope filter for picker results.
//
// Lets the user restrict every picker (and the universal lookup
// modal) to a subset of source books — e.g. "only PHB / DMG / FRCS
// for my Realms campaign". Filter state is **per-character** and
// persists in saved sheets. By default no filter is active and
// every book is in scope.
//
// Design notes:
// - Filter key is the book ABBREVIATION (e.g. "PHB", "FRCS"). The
//   `book` table has multiple rows that share an abbreviation
//   (the 5 "Forgotten Realms Campaign Setting (X entry)" variants
//   all have abbrev=FRCS) — filtering by abbrev keeps those
//   together naturally.
// - Source-string → abbrev resolution is cached in memory after the
//   DB loads. Sources with no matching book row (homebrew, future
//   additions) are *always allowed* — we don't want a stale filter
//   set to silently hide newly added content the user can't see in
//   the modal yet.
// - Errata indicators are unaffected by this filter; the universal
//   lookup modal still surfaces errata icons for hidden entries
//   when they appear elsewhere (e.g. as prereqs).
//
// Public API:
//   BookFilter.ready                — Promise (resolves after DB load)
//   BookFilter.getBooks()           — array of {name, abbreviation,
//                                      publication_date, edition,
//                                      book_type, publisher}
//   BookFilter.getActiveAbbrevs()   — Set<string>
//   BookFilter.setActiveAbbrevs(set) — replace + fire event
//   BookFilter.clear()              — alias for setActiveAbbrevs(new Set())
//   BookFilter.isActive()           — boolean (false when empty)
//   BookFilter.allowsSource(src)    — boolean (filter-aware row check)
//   BookFilter.allowsAbbrev(abbrev) — boolean
//   BookFilter.collectData()        — { _book_filter: [...] | null }
//   BookFilter.loadData(data)       — reads `_book_filter` if present
//
// Event:
//   document dispatches 'book-filter-changed' (no detail) whenever
//   the active set changes. Pickers re-run their index on this event.

(function () {
  const EVENT_NAME = 'book-filter-changed';

  // Internal state.
  let books = [];                    // all book rows, sorted by date
  let sourceToAbbrev = new Map();    // source string → abbrev
  let sourceToEdition = new Map();   // source string → '3.0' / '3.5' / ...
  let activeAbbrevs = new Set();     // empty = no filter
  // 3-state hide-3.0 mode:
  //   'off'         — show all 3.0 entries (default)
  //   'counterpart' — hide a 3.0 entry only when a 3.5 entry with
  //                   the same (type, name) exists. Most useful for
  //                   FR / Planar / MotP campaigns that want 3.5
  //                   updates by default but still need 3.0-only
  //                   content for spells / items that never got a
  //                   3.5 reprint.
  //   'all'         — hide every 3.0 entry regardless of counterparts.
  let hide30Mode = 'off';
  // Counterpart index: key = `${type}|${lower-name}` for any entry
  // that has a 3.5 row in the DB. Built on DB.ready below.
  let counterparts35 = new Set();

  function buildBookIndex() {
    if (!window.DB || !window.DB.isLoaded()) return;
    try {
      books = window.DB.query(
        "SELECT name, abbreviation, publication_date, edition, " +
        "book_type, publisher, summary FROM book " +
        "ORDER BY CASE edition WHEN '3.5' THEN 0 ELSE 1 END, " +
        "         publication_date ASC, name ASC"
      );
      sourceToAbbrev = new Map();
      sourceToEdition = new Map();
      for (const b of books) {
        if (b.name && b.abbreviation) {
          sourceToAbbrev.set(b.name, b.abbreviation);
        }
        if (b.name && b.edition) {
          sourceToEdition.set(b.name, b.edition);
        }
      }
      console.log(`[book-filter] indexed ${books.length} books, ` +
        `${new Set(books.map(b => b.abbreviation)).size} distinct abbrevs`);
    } catch (err) {
      console.warn('[book-filter] failed to index books:', err);
    }
    buildCounterpartIndex();
  }

  // Build the set of (type, lower-name) keys that have at least one
  // 3.5 entry. Used by `counterpart` mode to hide 3.0 rows only when
  // a 3.5 row of the same name+type exists. Strict keying — cross-
  // type matches don't count (a 3.0 feat named 'X' doesn't get hidden
  // because there's an unrelated 3.5 item named 'X').
  function buildCounterpartIndex() {
    if (!window.DB || !window.DB.isLoaded()) return;
    try {
      const rows = window.DB.query(
        "SELECT DISTINCT type, LOWER(name) AS lname " +
        "FROM entry WHERE version = '3.5'"
      );
      counterparts35 = new Set(rows.map(r => `${r.type}|${r.lname}`));
      console.log(`[book-filter] indexed ${counterparts35.size} 3.5 ` +
        `(type, name) keys for counterpart matching`);
    } catch (err) {
      console.warn('[book-filter] failed to build counterpart index:', err);
    }
  }

  const ready = (async function init() {
    if (!window.DB) return;
    await window.DB.ready;
    buildBookIndex();
  })();

  function getBooks() {
    return books.slice();
  }

  function getActiveAbbrevs() {
    return new Set(activeAbbrevs);
  }

  function isActive() {
    return activeAbbrevs.size > 0 || hide30Mode !== 'off';
  }

  // 3-state hide-3.0 mode. Stacks with the abbrev filter.
  // Valid values: 'off', 'counterpart', 'all'.  Any other input maps
  // to 'off' for safety.
  function getHide30Mode() {
    return hide30Mode;
  }
  function setHide30Mode(mode) {
    let next = String(mode || 'off');
    if (next !== 'off' && next !== 'counterpart' && next !== 'all') {
      next = 'off';
    }
    if (next === hide30Mode) return;
    hide30Mode = next;
    document.dispatchEvent(new CustomEvent(EVENT_NAME));
  }
  // Back-compat shims for callers that still think in terms of a
  // boolean. `true` maps to 'all' (the strictest filter, matches the
  // pre-2026-05-20 boolean semantics); `false` maps to 'off'.
  function getHide30() {
    return hide30Mode !== 'off';
  }
  function setHide30(flag) {
    setHide30Mode(flag ? 'all' : 'off');
  }
  // True when a 3.5 entry with the same (type, lower-name) exists in
  // the DB. Returns false if the counterpart index hasn't been built
  // yet (DB still loading) — callers should fail open in that case.
  function has35Counterpart(name, type) {
    if (!name || !type) return false;
    return counterparts35.has(`${type}|${String(name).toLowerCase()}`);
  }

  function setActiveAbbrevs(setLike) {
    const next = new Set();
    if (setLike) {
      for (const a of setLike) {
        if (typeof a === 'string' && a) next.add(a);
      }
    }
    // Skip no-op changes so we don't churn pickers needlessly.
    if (next.size === activeAbbrevs.size &&
        [...next].every(a => activeAbbrevs.has(a))) {
      return;
    }
    activeAbbrevs = next;
    document.dispatchEvent(new CustomEvent(EVENT_NAME));
  }

  function clear() {
    setActiveAbbrevs(new Set());
  }

  function allowsAbbrev(abbrev) {
    if (activeAbbrevs.size === 0) return true;
    if (!abbrev) return true;        // homebrew / unknown — always allow
    return activeAbbrevs.has(abbrev);
  }

  function allowsSource(source) {
    // Hide-3.0 in 'all' mode drops everything from a 3.0 source —
    // 'counterpart' mode can't decide without the entry's name+type,
    // so source-only calls fail open for that mode (downstream
    // pickers that have a full entry should call allowsEntry instead).
    if (hide30Mode === 'all' && source) {
      const ed = sourceToEdition.get(source);
      if (ed && /^3\.0/.test(ed)) return false;
    }
    if (activeAbbrevs.size === 0) return true;
    if (!source) return true;
    const abbrev = sourceToAbbrev.get(source);
    if (!abbrev) return true;        // unknown source — always allow
    return activeAbbrevs.has(abbrev);
  }

  // Entry-level check: combines source filter + hide-3.0 with the
  // entry's own `version`, `name`, and `type` fields. This is the
  // method 'counterpart' mode needs — callers that only have source
  // can use allowsSource() but it can't make the counterpart
  // distinction.
  //
  // Pickers should call this with the full result row (which selects
  // name + type + source + version in its SQL).
  function allowsEntry(entry) {
    if (!entry) return true;
    const isThirtyEntry = !!(entry.version && /^3\.0/.test(entry.version));
    if (isThirtyEntry) {
      if (hide30Mode === 'all') return false;
      if (hide30Mode === 'counterpart') {
        // Hide ONLY when a 3.5 version of the same (type, name) exists.
        // 3.0 entries with no 3.5 counterpart pass through (FR-only
        // spells, MotP cosmology, MoF items that never got reprinted).
        if (has35Counterpart(entry.name, entry.type)) return false;
      }
    }
    // Source-edition check is still useful even when the entry's
    // version field isn't set (some older rows had version blanks).
    if (!allowsSource(entry.source)) return false;
    // Per-entry homebrew gate. HomebrewFilter registers individual
    // entries from homebrew books (Tidecaller, Rooted Calling, etc.)
    // so users can toggle them granularly. For non-homebrew sources
    // this is always a no-op (allowsEntry returns true). When a
    // homebrew entry is registered, its toggle decides visibility
    // regardless of book filter state — i.e. a homebrew entry's
    // per-entry toggle being OFF hides it even when the book itself
    // is allowed.
    if (window.HomebrewFilter
        && typeof window.HomebrewFilter.allowsEntry === 'function'
        && !window.HomebrewFilter.allowsEntry(entry)) {
      return false;
    }
    return true;
  }

  function collectData() {
    const out = {
      _book_filter: activeAbbrevs.size > 0
        ? [...activeAbbrevs].sort()
        : null,
    };
    // Persist the 3-state mode under `_hide_30_mode`. Omit when off
    // to keep saves tidy. The legacy `_hide_30: true` field is no
    // longer written — the loader migrates it forward.
    if (hide30Mode !== 'off') {
      out._hide_30_mode = hide30Mode;
    }
    return out;
  }

  function loadData(data) {
    if (data) {
      // New 3-state field takes priority over the legacy boolean.
      // Migration: old `_hide_30: true` → 'all' (the strict pre-
      // 2026-05-20 behavior); `false` / absent → leave at 'off'.
      if ('_hide_30_mode' in data) {
        setHide30Mode(data._hide_30_mode);
      } else if ('_hide_30' in data) {
        setHide30Mode(data._hide_30 ? 'all' : 'off');
      }
    }
    if (!data || !('_book_filter' in data)) {
      // Older saves had no filter field — leave whatever the user
      // had set in their UI session intact rather than wiping it.
      return;
    }
    const arr = data._book_filter;
    if (Array.isArray(arr) && arr.length) {
      setActiveAbbrevs(new Set(arr));
    } else {
      clear();
    }
  }

  window.BookFilter = {
    ready,
    getBooks,
    getActiveAbbrevs,
    setActiveAbbrevs,
    clear,
    isActive,
    allowsSource,
    allowsAbbrev,
    allowsEntry,
    getHide30,        // legacy boolean accessor
    setHide30,        // legacy boolean accessor (true → 'all')
    getHide30Mode,    // 3-state accessor: 'off' | 'counterpart' | 'all'
    setHide30Mode,
    has35Counterpart,
    collectData,
    loadData,
    EVENT_NAME,
  };

  // Bridge homebrew toggles into book-filter-changed so every picker
  // and the lookup modal pick up the change. Without this bridge:
  // pickers eagerly index at module load + re-index only on
  // book-filter-changed, so toggling Tidecaller (or any other
  // per-entry homebrew toggle) in the 🏠 modal leaves the class-
  // picker datalist stale until a book-filter event fires or the
  // page reloads. Bug surfaced 2026-05-24 with Tidecaller missing
  // from the class-picker after a homebrew state change.
  //
  // BookFilter.allowsEntry already delegates to HomebrewFilter, so
  // the visibility rule is unified — only the change notification
  // was missing. Re-dispatching as book-filter-changed (rather than
  // adding a second event every consumer needs to wire) means the
  // existing listeners just work.
  document.addEventListener('homebrew-filter-changed', () => {
    document.dispatchEvent(new CustomEvent(EVENT_NAME));
  });
})();
