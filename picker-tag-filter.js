// picker-tag-filter.js — shared tag-filter helper for the spell-adjacent
// pickers (power / maneuver / mystery / vestige / invocation).
//
// Wraps the TagFilter chip widget with a per-type tag index + AND/OR/exclude
// test + contextual per-tag counts, so each picker gets spell-picker-grade
// tag filtering without copy-pasting the ~80 lines of index/filter/count
// logic into five files. The filter logic is lifted verbatim from
// spell-picker.js (buildTagFilter / spellPassesTagFilter / refreshTagCounts)
// and generalized over an arbitrary entry `type`.
//
// Also exports parseLevel(raw) — the spell-picker's level-range expression
// parser ("3", "<=3", ">=2", "<5", Unicode ≤/≥) — reused by the
// numeric-level pickers so "show me everything level N and under" works the
// same way it does for spells.
//
// Usage:
//   const tags = PickerTagFilter.attach(tagHostEl, {
//     type: 'vestige', onChange: refresh, minCount: 1,
//   });
//   // inside refresh():
//   const f = tags.buildFilter();              // {include,exclude} | null
//   for (const rec of index.values()) {
//     ...other filters → preTagIds.add(rec.id)...   // for contextual counts
//     if (f && !tags.passes(f, rec.id)) continue;   // tag filter
//     ...emit rec...
//   }
//   tags.refreshCounts(preTagIds);   // counts ignore the tag filter itself

(function () {
  if (!window.DB) {
    console.warn('[picker-tag-filter] DB module not loaded');
    return;
  }

  // type → { index: Map<tag, Set<id>>, counts: Map<tag, number> }, built
  // lazily on first attach() for a type and cached for the session.
  const _byType = new Map();

  function getTagData(type) {
    if (_byType.has(type)) return _byType.get(type);
    const index = new Map();
    const counts = new Map();
    try {
      const rows = DB.query(
        "SELECT t.tag AS tag, t.entry_id AS id FROM tag t "
        + "JOIN entry e ON e.id = t.entry_id WHERE e.type = ?", [type]);
      for (const r of rows) {
        if (!index.has(r.tag)) index.set(r.tag, new Set());
        index.get(r.tag).add(r.id);
        counts.set(r.tag, (counts.get(r.tag) || 0) + 1);
      }
    } catch (e) { /* no tags for this type / DB issue → empty filter */ }
    const data = { index, counts };
    _byType.set(type, data);
    return data;
  }

  // Parse a level-filter expression. "" → null (no constraint); "3" → exact;
  // "<=3"/"≤3" → 0..3; "<3" → 0..2; ">=2"/"≥2" → 2..99; ">2" → 3..99.
  // max defaults to 99 (the pickers clamp to their own level ceiling).
  function parseLevel(raw) {
    const s = String(raw || '').trim().replace(/\s+/g, '');
    if (!s) return null;
    const m = s.match(/^(<=|>=|<|>|≤|≥|=)?(\d{1,2})$/);
    if (!m) return null;
    const op = m[1] || '=';
    const n = parseInt(m[2], 10);
    if (isNaN(n)) return null;
    switch (op) {
      case '<':            return { min: 0, max: n - 1 };
      case '<=': case '≤': return { min: 0, max: n };
      case '>':            return { min: n + 1, max: 99 };
      case '>=': case '≥': return { min: n, max: 99 };
      default:             return { min: n, max: n };
    }
  }

  // Attach a tag filter to `hostEl`. Returns a controller; if TagFilter is
  // unavailable the controller is an inert no-op so callers don't need a
  // separate code path.
  function attach(hostEl, opts) {
    opts = opts || {};
    const minCount = opts.minCount == null ? 1 : opts.minCount;
    const { index, counts } = getTagData(opts.type);

    if (typeof TagFilter === 'undefined' || !hostEl) {
      return {
        hasFilter: () => false,
        buildFilter: () => null,
        passes: () => true,
        refreshCounts: () => {},
        tagFilter: null,
      };
    }

    const sortedTags = [...counts.entries()]
      .filter(([, c]) => c >= minCount)
      .sort((a, b) => a[0].localeCompare(b[0]));

    const tf = TagFilter.attach(hostEl, {
      tags: sortedTags,
      placeholder: opts.placeholder || 'Filter by tag(s)…',
      onChange: opts.onChange || (() => {}),
    });

    // Build a {include, exclude} test from the selected tags + AND/OR mode.
    // include = ids satisfying the positive side (null = no positives, all
    // pass); exclude = union of negated tags' ids (null = none). Returns null
    // when nothing is selected. (Mirrors spell-picker.buildTagFilter.)
    function buildFilter() {
      if (!tf.hasFilter()) return null;
      const positives = tf.getSelected();
      const negatives = tf.getExcluded();
      const mode = tf.getMode();

      let include = null;
      if (positives.length) {
        const sets = positives.map(t => index.get(t)).filter(Boolean);
        if (!sets.length) {
          include = new Set();           // unknown positives → nothing matches
        } else if (mode === 'or') {
          include = new Set();
          for (const s of sets) for (const id of s) include.add(id);
        } else {
          sets.sort((a, b) => a.size - b.size);   // intersect smallest-first
          include = new Set();
          for (const id of sets[0]) {
            let inAll = true;
            for (let i = 1; i < sets.length; i++) {
              if (!sets[i].has(id)) { inAll = false; break; }
            }
            if (inAll) include.add(id);
          }
        }
      }
      let exclude = null;
      if (negatives.length) {
        const sets = negatives.map(t => index.get(t)).filter(Boolean);
        if (sets.length) {
          exclude = new Set();
          for (const s of sets) for (const id of s) exclude.add(id);
        }
      }
      return { include, exclude };
    }

    // Does an entry id pass the built filter? Untagged entries pass any
    // all-negative filter (they're in no tag set).
    function passes(f, id) {
      if (!f) return true;
      if (f.include && !f.include.has(id)) return false;
      if (f.exclude && f.exclude.has(id)) return false;
      return true;
    }

    // Push contextual per-tag counts into the dropdown: how many of
    // `candidateIds` (the set filtered by everything EXCEPT the tag filter)
    // carry each tag. Intersect smaller-set-first for cache friendliness.
    function refreshCounts(candidateIds) {
      if (typeof tf.setCounts !== 'function') return;
      const ids = (candidateIds instanceof Set)
        ? candidateIds : new Set(candidateIds || []);
      const newCounts = new Map();
      for (const [tag, set] of index.entries()) {
        let n = 0;
        const [small, big] = set.size < ids.size ? [set, ids] : [ids, set];
        for (const id of small) if (big.has(id)) n++;
        newCounts.set(tag, n);
      }
      tf.setCounts(newCounts);
    }

    return {
      hasFilter: () => tf.hasFilter(),
      buildFilter,
      passes,
      refreshCounts,
      tagFilter: tf,
    };
  }

  window.PickerTagFilter = { attach, parseLevel };
})();
