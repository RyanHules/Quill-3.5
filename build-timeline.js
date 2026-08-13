// build-timeline.js — Build Timeline edit-in-place view.
//
// Phase 2 of #3 plan. Renders the `CharacterHistory.get()` array as
// a collapsible list of per-level rows on the Character tab. Each
// row shows a one-line summary and expands inline to an editor for
// the core fields (class, HP rolled, ability boost at L4/8/etc.,
// notes). Edits write back through `CharacterHistory.set()` and
// trigger a recalc.
//
// Scope for this phase (intentionally tight):
//   ✓ Display every level row with class / HP / ability boost / feat
//     count / reconstructed flag.
//   ✓ Inline-edit class (autocomplete against applied class names),
//     HP rolled, ability boost dropdown, notes textarea.
//   ✓ Add / remove level buttons.
//   ✓ Editing a row clears its `_reconstructed` flag; the global
//     "auto-reconstructed" badge hides when no rows remain flagged.
//
// Deferred to later sessions:
//   • Per-level feat editing (currently shows a count, with the
//     feat list in the row's tooltip via title attr).
//   • Skill ranks editor per level.
//   • Spells learned / unlearned editor (for spontaneous casters).
//   • Class-specific choices (specialty school, domain, etc.).

const BuildTimeline = (function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  let wired = false;
  // Track which rows are currently expanded so re-renders preserve
  // state across CharacterHistory updates.
  const expandedLevels = new Set();

  function init() {
    if (wired) return;
    wired = true;
    const addBtn = $('#bt-add-level');
    if (addBtn) addBtn.addEventListener('click', onAddLevel);
    render();
  }

  function render() {
    const section = $('#build-timeline-section');
    const rowsEl  = $('#bt-rows');
    if (!section || !rowsEl) return;
    if (typeof CharacterHistory === 'undefined') return;
    const history = CharacterHistory.get();
    // Hide the whole section if the character has no history yet
    // (no classes applied). The class-picker reconstruction kicks
    // in on save/load, but a fresh character starts empty.
    if (!history || !history.length) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';
    rowsEl.innerHTML = '';
    for (const entry of history) {
      rowsEl.appendChild(renderRow(entry));
    }
    refreshGlobalBadge();
  }

  function refreshGlobalBadge() {
    const badge = $('#bt-reconstructed-badge');
    if (!badge) return;
    const history = CharacterHistory.get() || [];
    const anyReconstructed = history.some(e => e._reconstructed);
    badge.style.display = anyReconstructed ? '' : 'none';
  }

  function renderRow(entry) {
    const row = document.createElement('div');
    row.className = 'bt-row';
    row.dataset.level = String(entry.level);
    if (entry._reconstructed) row.classList.add('bt-row-reconstructed');
    row.appendChild(renderSummary(entry));
    if (expandedLevels.has(entry.level)) {
      row.classList.add('bt-row-expanded');
      row.appendChild(renderEditor(entry));
    }
    return row;
  }

  // Gestalt mode reflects the live class-picker toggle. When on, the
  // timeline shows + edits a second class per level (Side B).
  function gestaltOn() {
    return typeof ClassPicker !== 'undefined' &&
      typeof ClassPicker.isGestalt === 'function' && ClassPicker.isGestalt();
  }

  function renderSummary(entry) {
    const sum = document.createElement('div');
    sum.className = 'bt-row-summary';
    const isBoostLvl = CharacterHistory.isAbilityBoostLevel(entry.level);
    const featCount = (entry.feats_taken || []).length;
    const featTitle = featCount
      ? `Feats this level: ${(entry.feats_taken || []).join(', ')}`
      : 'No feats this level';
    // Gestalt: "Side A // Side B"; non-gestalt: just the single class.
    const classDisplay = gestaltOn()
      ? `${entry.class_taken || '(unknown)'} // ${entry.class_taken_b || '(none)'}`
      : (entry.class_taken || '(unknown)');
    sum.innerHTML =
      `<span class="bt-level">L${entry.level}</span>` +
      `<span class="bt-class">${escapeHtml(classDisplay)}</span>` +
      `<span class="bt-hp" title="Hit points rolled at this level">HP ${entry.hp_rolled ?? '?'}</span>` +
      (isBoostLvl
        ? `<span class="bt-boost" title="Ability score increase">` +
          (entry.ability_boost
            ? `+${escapeHtml(entry.ability_boost)}`
            : `<span style="color:#fc8">+?</span>`) +
          `</span>`
        : '') +
      `<span class="bt-feats" title="${escapeAttr(featTitle)}">` +
      `${featCount} feat${featCount === 1 ? '' : 's'}</span>` +
      (entry._reconstructed
        ? `<span class="bt-row-recon-badge" title="Auto-reconstructed — review and edit to clear">⚠</span>`
        : '') +
      `<button type="button" class="bt-row-expand" title="Edit">` +
      (expandedLevels.has(entry.level) ? '▾' : '▸') + `</button>` +
      `<button type="button" class="bt-row-remove" title="Remove this level (and all levels above it)">×</button>`;
    sum.querySelector('.bt-row-expand').addEventListener('click',
      () => toggleExpand(entry.level));
    sum.querySelector('.bt-row-remove').addEventListener('click',
      () => removeLevelAndAbove(entry.level));
    // Click anywhere on the summary (outside buttons) also toggles.
    sum.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      toggleExpand(entry.level);
    });
    return sum;
  }

  function renderEditor(entry) {
    const ed = document.createElement('div');
    ed.className = 'bt-row-editor';
    const isBoostLvl = CharacterHistory.isAbilityBoostLevel(entry.level);

    // Class options: applied class names from ClassPicker plus the
    // current value (in case the user types in something not yet
    // applied via the picker — homebrew, future classes, etc.).
    const classNames = new Set();
    if (typeof ClassPicker !== 'undefined' &&
        typeof ClassPicker.getState === 'function') {
      for (const c of ClassPicker.getState()) {
        if (c.className) classNames.add(c.className);
      }
    }
    if (entry.class_taken) classNames.add(entry.class_taken);
    const classOpts = [...classNames].sort().map(n =>
      `<option${n === entry.class_taken ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');

    // Gestalt Side B class options: Side B's applied classes + the entry's
    // current value, plus a leading blank so a level can be Side-B-empty.
    const gestalt = gestaltOn();
    let classOptsB = '';
    if (gestalt) {
      const namesB = new Set();
      if (typeof ClassPicker !== 'undefined' &&
          typeof ClassPicker.getStateB === 'function') {
        for (const c of ClassPicker.getStateB()) {
          if (c.className) namesB.add(c.className);
        }
      }
      if (entry.class_taken_b) namesB.add(entry.class_taken_b);
      const curB = entry.class_taken_b || '';
      classOptsB =
        `<option value=""${curB === '' ? ' selected' : ''}>(none)</option>` +
        [...namesB].sort().map(n =>
          `<option${n === curB ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');
    }

    const abilityOpts = ['', 'STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']
      .map(ab => `<option value="${ab}"${ab === (entry.ability_boost || '') ? ' selected' : ''}>` +
        (ab || '(none)') + `</option>`).join('');

    ed.innerHTML =
      `<div class="bt-editor-grid">` +
        `<label>${gestalt ? 'Class (Side A)' : 'Class'}<select class="bt-edit-class">${classOpts}</select></label>` +
        (gestalt
          ? `<label>Class (Side B)<select class="bt-edit-class-b">${classOptsB}</select></label>`
          : '') +
        `<label>HP rolled<input type="number" class="bt-edit-hp" min="0" value="${entry.hp_rolled ?? ''}"></label>` +
        (isBoostLvl
          ? `<label>Ability boost<select class="bt-edit-boost">${abilityOpts}</select></label>`
          : `<span class="bt-no-boost" style="opacity:.5">No ability boost (not L4/8/12/16/20)</span>`) +
        `<div class="bt-edit-feats-label"><span>Feats taken</span>` +
          `<div class="bt-feats-list">` +
            (entry.feats_taken || []).map(f => featRowHtml(f)).join('') +
          `</div>` +
          `<button type="button" class="bt-feat-add">+ Add feat</button>` +
        `</div>` +
        `<label class="bt-edit-notes-label">Notes` +
        `<textarea class="bt-edit-notes" rows="1">${escapeHtml(entry.notes || '')}</textarea>` +
        `</label>` +
      `</div>`;

    // Wire each input to write through to the history entry.
    ed.querySelector('.bt-edit-class').addEventListener('change', (e) => {
      updateEntry(entry.level, { class_taken: e.target.value });
    });
    const classBEl = ed.querySelector('.bt-edit-class-b');
    if (classBEl) classBEl.addEventListener('change', (e) => {
      updateEntry(entry.level, { class_taken_b: e.target.value || null });
    });
    ed.querySelector('.bt-edit-hp').addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      updateEntry(entry.level, { hp_rolled: isNaN(v) ? null : v });
    });
    const boostEl = ed.querySelector('.bt-edit-boost');
    if (boostEl) boostEl.addEventListener('change', (e) => {
      updateEntry(entry.level, { ability_boost: e.target.value || null });
    });
    // Feats-taken list (report rmso7nk4t): one row per feat instead of a
    // one-per-line textarea. Mutate the list DOM directly + sync feats_taken
    // without a full re-render (updateEntry never re-renders, so focus holds).
    const featsList = ed.querySelector('.bt-feats-list');
    const syncFeats = () => {
      const feats = [...featsList.querySelectorAll('.bt-feat-input')]
        .map(i => i.value.trim()).filter(Boolean);
      updateEntry(entry.level, { feats_taken: feats });
    };
    featsList.addEventListener('input', (e) => {
      if (e.target.classList.contains('bt-feat-input')) syncFeats();
    });
    featsList.addEventListener('click', (e) => {
      const rm = e.target.closest('.bt-feat-remove');
      if (rm) { rm.closest('.bt-feat-row').remove(); syncFeats(); }
    });
    ed.querySelector('.bt-feat-add').addEventListener('click', () => {
      featsList.insertAdjacentHTML('beforeend', featRowHtml(''));
      const inputs = featsList.querySelectorAll('.bt-feat-input');
      inputs[inputs.length - 1].focus();
    });
    ed.querySelector('.bt-edit-notes').addEventListener('input', (e) => {
      updateEntry(entry.level, { notes: e.target.value });
    });
    return ed;
  }

  function toggleExpand(level) {
    if (expandedLevels.has(level)) expandedLevels.delete(level);
    else                            expandedLevels.add(level);
    render();
  }

  // Apply a partial update to the entry at `level`, clearing the
  // _reconstructed flag since the user has now touched the row.
  // Re-renders the timeline + fires a recalc so dependent UIs (the
  // future per-level validator) pick up the change.
  function updateEntry(level, patch) {
    const history = (CharacterHistory.get() || []).map(e => {
      if (e.level !== level) return e;
      const next = Object.assign({}, e, patch);
      delete next._reconstructed;
      return next;
    });
    CharacterHistory.set(history, { reconstructed: anyReconstructed(history) });
    // Don't re-render mid-typing — the editor inputs are the source of
    // truth right now and re-rendering would blow away focus. Just
    // refresh the summary line in place + the global badge.
    refreshRowSummary(level);
    refreshGlobalBadge();
    if (patch && ('class_taken' in patch || 'class_taken_b' in patch)) notifyChanged();
  }

  function anyReconstructed(history) {
    return (history || []).some(e => e._reconstructed);
  }

  // Broadcast a timeline change so dependent UIs refresh. Today the
  // class-picker listens to re-point the Skills tab's class-skill checkboxes
  // at the new "current" (last-in-timeline) class. Fire only when the class
  // ORDER could have changed (add/remove level, change a level's class) —
  // not on every notes/HP keystroke.
  function notifyChanged() {
    document.dispatchEvent(new CustomEvent('build-timeline-changed'));
  }

  function refreshRowSummary(level) {
    const row = document.querySelector(
      `.bt-row[data-level="${level}"]`);
    if (!row) return;
    const entry = (CharacterHistory.get() || [])
      .find(e => e.level === level);
    if (!entry) return;
    row.classList.toggle('bt-row-reconstructed', !!entry._reconstructed);
    const oldSum = row.querySelector('.bt-row-summary');
    const newSum = renderSummary(entry);
    if (oldSum && newSum) oldSum.replaceWith(newSum);
  }

  function onAddLevel() {
    const history = (CharacterHistory.get() || []).slice();
    const newLevel = history.length + 1;
    // Default new level: same class as last level (if any), average HP.
    const lastEntry = history.length ? history[history.length - 1] : null;
    const lastClass = lastEntry ? lastEntry.class_taken : '';
    const newEntry = {
      level: newLevel,
      class_taken: lastClass,
      hp_rolled: null,
      ability_boost: null,
      skills_purchased: {},
      feats_taken: [],
      spells_learned: [],
      spells_unlearned: [],
      choices: {},
      notes: '',
    };
    // Gestalt: carry a Side B default + keep the per-level dual-class shape.
    if (gestaltOn()) newEntry.class_taken_b = lastEntry ? (lastEntry.class_taken_b || null) : null;
    history.push(newEntry);
    CharacterHistory.set(history, { reconstructed: anyReconstructed(history) });
    expandedLevels.add(newLevel);
    render();
    notifyChanged();
  }

  function removeLevelAndAbove(level) {
    // Remove this level and all levels above it (you can't have L8
    // without L7). Confirm before destructive action.
    const history = (CharacterHistory.get() || []);
    const removeCount = history.length - level + 1;
    if (removeCount <= 0) return;
    if (!confirm(
      `Remove level ${level}` +
      (removeCount > 1 ? ` and ${removeCount - 1} level${removeCount === 2 ? '' : 's'} above it` : '') +
      `? This affects your build history only — class levels on the ` +
      `Class Lookup section won't change automatically.`)) {
      return;
    }
    const trimmed = history.slice(0, level - 1);
    expandedLevels.delete(level);
    CharacterHistory.set(trimmed, { reconstructed: anyReconstructed(trimmed) });
    render();
    notifyChanged();
  }

  // One editable feat row in the Build Timeline editor's Feats-taken list
  // (report rmso7nk4t: a list instead of a one-per-line textarea).
  function featRowHtml(val) {
    return `<div class="bt-feat-row">` +
      `<input type="text" class="bt-feat-input" value="${escapeAttr(val)}" placeholder="Feat name">` +
      `<button type="button" class="bt-feat-remove" title="Remove feat">×</button>` +
      `</div>`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  return { init, render };
})();
