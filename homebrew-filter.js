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
    const savedDeviations = data._homebrew || {};
    _bulkApply({ ...baseline, ...savedDeviations });
  }

  window.HomebrewFilter = {
    registerRule,
    getRules,
    isEnabled,
    setEnabled,
    getActiveKeys,
    collectData,
    loadData,
    EVENT_NAME,
  };
})();
