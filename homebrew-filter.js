// homebrew-filter.js — Per-rule homebrew toggle exposed as global
// `HomebrewFilter` object.
//
// The character sheet is built around RAW 3.5 mechanics, but home
// campaigns frequently layer house rules on top — replaced feats,
// custom items, alternate progressions, opt-in subsystems. This
// module is the registry + state-bag for those rules. Each
// homebrew bundle (a feat replacement, a custom item, an opt-in
// subsystem) registers itself with HomebrewFilter at module load,
// then watches the `homebrew-filter-changed` event and the
// `DB.ready` promise to apply its effect when enabled.
//
// Design notes:
//
// - **Per-rule granular toggles.** Each rule has its own checkbox;
//   the user picks which ones their campaign uses. There is no
//   single master switch — that's a deliberate choice so a player
//   sharing the sheet doesn't accidentally inherit every rule from
//   the original author's campaign.
//
// - **Persistence is per-character.** The HomebrewFilter state
//   round-trips through `collectData` / `loadData` so a saved
//   character carries its homebrew config. A different character
//   in the same browser session starts from the registered
//   defaults.
//
// - **Defaults are conservative.** Most rules default to OFF so the
//   sheet behaves like RAW when first opened. A rule can opt-in to
//   `defaultEnabled: true` if it's nearly-RAW or considered
//   universally beneficial (e.g. average-rounded-up HP).
//
// - **Rules can be informational.** Not every homebrew has a
//   mechanical effect — some are policy/posture rules (HP rules,
//   take-10 liberality, attrition pacing). Those register with
//   `informational: true` and surface in the UI as toggles whose
//   only effect is making the user's preference visible to anyone
//   who opens the save.
//
// - **Categories.** Each rule has a category for grouping in the UI
//   ("Item Familiar", "Feats", "Items", "Subsystems", "Sneez
//   homebrew", "Policy"). The filter modal renders one section per
//   category.
//
// Public API:
//
//   HomebrewFilter.registerRule({
//     key,                  // unique short identifier (snake_case)
//     name,                 // display name (e.g. "Free Item Familiar feat")
//     category,             // grouping bucket
//     description,          // 1-3 sentence summary shown in modal
//     defaultEnabled,       // boolean, default false
//     informational,        // boolean, default false (no mechanical effect)
//     source,               // optional citation (e.g. "Diamond Soul campaign")
//   })
//
//   HomebrewFilter.getRules()      — array of registered rule metas
//   HomebrewFilter.isEnabled(key)  — boolean
//   HomebrewFilter.setEnabled(key, on)
//   HomebrewFilter.getActiveKeys() — array of currently-enabled keys
//   HomebrewFilter.collectData()   — { _homebrew: {key: bool, ...} | null }
//   HomebrewFilter.loadData(data)  — reads `_homebrew` if present
//   HomebrewFilter.EVENT_NAME      — 'homebrew-filter-changed'
//
// Event detail: { key: string|null, enabled: bool|null } — `key` is
// the specific rule that changed; null means a bulk load.

(function () {
  const EVENT_NAME = 'homebrew-filter-changed';

  // Registry: key → meta.  Insertion order preserved.
  const rules = new Map();
  // State: key → boolean. Defaults are loaded from rules' defaultEnabled
  // at registration time; user choices override them.
  const state = new Map();

  // Per-entry registry — separate from `rules`. Used by homebrew
  // book bundles (homebrew/book_content.js) to register a toggle
  // per content entry (e.g. each PrC / feat in a homebrew book)
  // alongside the parent book rule. The parent-child relationship
  // is captured by the entry's `parentKey` field, which must match
  // a registered rule's key. Pickers consult `allowsEntry()` to
  // check whether a specific (source, type, name) triple should
  // be hidden.
  //
  // entries: key → meta. Insertion order preserved.
  //   meta = { key, name, type, source, parentKey, defaultEnabled }
  //
  // Note: entries DON'T appear via getRules() — they're a separate
  // surface from per-subsystem rules. They share the SAME state Map
  // though, so a single key namespace covers both. Use distinct
  // prefixes (e.g. "book_DS" for the parent rule, "entry_DS_..."
  // for children) to avoid collisions.
  const entries = new Map();
  // Index: source name → array of entry keys (for fast lookup in
  // allowsEntry without scanning every entry).
  const entriesBySource = new Map();

  function registerRule(meta) {
    if (!meta || !meta.key) {
      console.warn('[homebrew] registerRule called with no key:', meta);
      return;
    }
    if (rules.has(meta.key)) {
      // Quiet idempotency — fine for hot-reload during development.
      return;
    }
    rules.set(meta.key, {
      key: meta.key,
      name: meta.name || meta.key,
      category: meta.category || 'Other',
      description: meta.description || '',
      defaultEnabled: !!meta.defaultEnabled,
      informational: !!meta.informational,
      source: meta.source || null,
      // Optional parent reference. When set, this rule renders as a
      // child of the named parent rule in the UI (the parent's
      // bulk-toggle affects it; it doesn't appear at top level in
      // its own category). Used by per-subsystem rules tied to a
      // homebrew book (e.g. Item Familiar variants nesting under
      // Diamond Soul). Parent must be a rule key — typically a
      // "book_<ABBR>" parent registered by homebrew/book_content.js.
      parentKey: meta.parentKey || null,
    });
    if (!state.has(meta.key)) {
      state.set(meta.key, !!meta.defaultEnabled);
    }
  }

  function getRules() {
    return [...rules.values()];
  }

  function isEnabled(key) {
    return !!state.get(key);
  }

  function getActiveKeys() {
    return [...state.entries()]
      .filter(([, v]) => v)
      .map(([k]) => k);
  }

  function setEnabled(key, on) {
    const next = !!on;
    const prev = !!state.get(key);
    if (next === prev) return;
    state.set(key, next);
    document.dispatchEvent(new CustomEvent(EVENT_NAME,
      { detail: { key, enabled: next } }));
  }

  function _bulkApply(map) {
    // Apply a {key: bool} bag without firing per-key events. Fires
    // ONE bulk-change event at the end so each consumer re-renders
    // exactly once during a save-load.
    let changed = false;
    for (const [k, v] of Object.entries(map || {})) {
      const next = !!v;
      const prev = !!state.get(k);
      if (next !== prev) {
        state.set(k, next);
        changed = true;
      }
    }
    if (changed) {
      document.dispatchEvent(new CustomEvent(EVENT_NAME,
        { detail: { key: null, enabled: null } }));
    }
  }

  // ---- Per-entry registry (homebrew BOOK contents) ------------------------

  function registerEntry(meta) {
    if (!meta || !meta.key || !meta.source || !meta.name) {
      console.warn('[homebrew] registerEntry needs key, source, name:', meta);
      return;
    }
    if (entries.has(meta.key)) return;  // idempotent
    entries.set(meta.key, {
      key: meta.key,
      name: meta.name,
      type: meta.type || '',
      source: meta.source,
      parentKey: meta.parentKey || null,
      defaultEnabled: !!meta.defaultEnabled,
    });
    if (!state.has(meta.key)) {
      state.set(meta.key, !!meta.defaultEnabled);
    }
    if (!entriesBySource.has(meta.source)) {
      entriesBySource.set(meta.source, []);
    }
    entriesBySource.get(meta.source).push(meta.key);
  }

  function getEntries() {
    return [...entries.values()];
  }

  function getChildEntries(parentKey) {
    if (!parentKey) return [];
    return [...entries.values()].filter(e => e.parentKey === parentKey);
  }

  function getChildRules(parentKey) {
    if (!parentKey) return [];
    return [...rules.values()].filter(r => r.parentKey === parentKey);
  }

  // Unified child list: both content entries and per-subsystem rules
  // that have been parented to this rule. Each item carries a `kind`
  // discriminator ('entry' | 'rule') so the UI can render them
  // differently — entries get a compact type-tagged row; rules get
  // a fuller row with description + info tag.
  function getChildren(parentKey) {
    const out = [];
    for (const e of getChildEntries(parentKey)) {
      out.push({ kind: 'entry', ...e });
    }
    for (const r of getChildRules(parentKey)) {
      out.push({ kind: 'rule', ...r });
    }
    return out;
  }

  // Picker-side visibility gate. Returns true if no entry registration
  // covers this (source, type, name) triple, OR if its toggle is on.
  // Returns false ONLY when a registered entry's toggle is off.
  //
  // Match semantics: source must match exactly; type and name are
  // matched case-insensitively. type-mismatches don't disqualify (a
  // homebrew toggle for "spell:fireball" still covers the entry
  // regardless of how the caller spells the type), but if BOTH the
  // registered entry and the caller's entry specify a non-empty type,
  // they must match.
  function allowsEntry(entry) {
    if (!entry || !entry.source) return true;
    const keys = entriesBySource.get(entry.source);
    if (!keys || !keys.length) return true;
    const callName = String(entry.name || '').trim().toLowerCase();
    const callType = String(entry.type || '').trim().toLowerCase();
    for (const k of keys) {
      const e = entries.get(k);
      if (!e) continue;
      const eName = String(e.name || '').trim().toLowerCase();
      const eType = String(e.type || '').trim().toLowerCase();
      if (eName !== callName) continue;
      if (eType && callType && eType !== callType) continue;
      return !!state.get(k);
    }
    return true;
  }

  function collectData() {
    // Only persist deviations from the registered defaults — keeps
    // saves clean and lets future default-changes propagate to
    // existing characters automatically.
    const out = {};
    for (const [key, meta] of rules) {
      const cur = !!state.get(key);
      if (cur !== !!meta.defaultEnabled) {
        out[key] = cur;
      }
    }
    for (const [key, meta] of entries) {
      const cur = !!state.get(key);
      if (cur !== !!meta.defaultEnabled) {
        out[key] = cur;
      }
    }
    return { _homebrew: Object.keys(out).length ? out : null };
  }

  function loadData(data) {
    if (!data || !('_homebrew' in data)) {
      // Older saves: leave the current UI state alone.
      return;
    }
    // Reset everything to the registered defaults first, THEN apply
    // the save's deviations. This way a save that explicitly turned
    // a default-on rule off survives a default change.
    const baseline = {};
    for (const [key, meta] of rules) {
      baseline[key] = !!meta.defaultEnabled;
    }
    for (const [key, meta] of entries) {
      baseline[key] = !!meta.defaultEnabled;
    }
    const savedDeviations = data._homebrew || {};
    _bulkApply({ ...baseline, ...savedDeviations });
  }

  window.HomebrewFilter = {
    registerRule,
    getRules,
    registerEntry,
    getEntries,
    getChildEntries,
    getChildRules,
    getChildren,
    allowsEntry,
    isEnabled,
    setEnabled,
    getActiveKeys,
    collectData,
    loadData,
    EVENT_NAME,
  };
})();
