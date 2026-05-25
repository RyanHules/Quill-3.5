// homebrew-filter-ui.js — the 🏠 button + modal for toggling
// homebrew rules registered with HomebrewFilter.
//
// Mirrors book-filter-ui.js in structure: a header button slots in
// next to the lookup + book-filter triggers, opens a modal showing
// every registered rule grouped by category with a checkbox per
// rule and a "What it does" hint underneath.
//
// The modal stays purely declarative — toggling a checkbox calls
// `HomebrewFilter.setEnabled`, which fires the change event;
// downstream consumers (pickers, character calc paths) react to
// the event and re-apply their rule.

(function () {
  let modalEl = null;
  let triggerBtn = null;

  // ---- Trigger button -----------------------------------------------------

  function insertTrigger() {
    if (triggerBtn) return;
    // The lookup + book-filter triggers live in the same header row
    // near the tabs. Slot in to the LEFT of the book-filter button so
    // the order reads as 🔍 / 🏠 / 📚.
    const bookBtn = document.getElementById('book-filter-trigger-btn');
    const lookupBtn = document.getElementById('lookup-trigger-btn');
    const host = (bookBtn && bookBtn.parentElement)
      || (lookupBtn && lookupBtn.parentElement);
    if (!host) return;
    triggerBtn = document.createElement('button');
    triggerBtn.id = 'homebrew-filter-trigger-btn';
    triggerBtn.type = 'button';
    triggerBtn.className = 'lookup-trigger-btn homebrew-filter-trigger-btn';
    triggerBtn.title = 'Homebrew rules — toggle per-rule house rules and ' +
      'campaign-specific homebrew. Default state is RAW (everything off).';
    triggerBtn.innerHTML = '🏠<span class="hbf-count" id="hbf-count"></span>';
    triggerBtn.addEventListener('click', open);
    if (bookBtn) {
      host.insertBefore(triggerBtn, bookBtn);
    } else {
      host.appendChild(triggerBtn);
    }
    refreshCount();
    document.addEventListener('homebrew-filter-changed', refreshCount);
  }

  function refreshCount() {
    if (!triggerBtn) return;
    const countEl = triggerBtn.querySelector('#hbf-count');
    if (!countEl || !window.HomebrewFilter) return;
    const n = window.HomebrewFilter.getActiveKeys().length;
    countEl.textContent = n > 0 ? String(n) : '';
    countEl.style.display = n > 0 ? '' : 'none';
  }

  // ---- Modal --------------------------------------------------------------

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.id = 'homebrew-filter-modal';
    modalEl.className = 'book-filter-modal';
    modalEl.style.display = 'none';
    // NB: reuse the BOOK filter's class names — .book-filter-card
    // (not .book-filter-panel) and .book-filter-header (not -head).
    // The CSS rules at line 2724+ in styles.css are scoped to those
    // exact class names, providing the panel's width / background /
    // flex layout / max-height etc. Using the alternate names left
    // the panel unstyled, so the backdrop overlay covered the
    // (correctly populated) rules list and the modal LOOKED blank.
    // Bug found 2026-05-22.
    modalEl.innerHTML = `
      <div class="book-filter-backdrop" data-close="1"></div>
      <div class="book-filter-card" role="dialog" aria-modal="true"
           aria-labelledby="homebrew-filter-title">
        <div class="book-filter-header">
          <div>
            <div class="book-filter-title" id="homebrew-filter-title">
              Homebrew &amp; house rules
            </div>
            <div class="book-filter-sub">
              Toggle per-rule. Default state is RAW — each rule is
              opt-in. Changes save with the character.
            </div>
          </div>
          <button type="button" class="book-filter-close"
                  data-close="1" aria-label="Close">×</button>
        </div>
        <div class="book-filter-status" id="homebrew-filter-status"></div>
        <div class="book-filter-list" id="homebrew-filter-list"></div>
        <div class="book-filter-footer">
          <span class="book-filter-hint">
            <kbd>Esc</kbd> cancel
          </span>
          <span>
            <button type="button" class="book-filter-cancel"
                    data-close="1">Cancel</button>
            <button type="button" class="book-filter-apply"
                    id="homebrew-filter-apply">Apply</button>
          </span>
        </div>
      </div>
    `;
    document.body.appendChild(modalEl);
    modalEl.addEventListener('click', (ev) => {
      const t = ev.target;
      if (t instanceof Element && t.dataset.close === '1') close();
    });
    modalEl.querySelector('#homebrew-filter-apply')
      .addEventListener('click', applySelection);
    return modalEl;
  }

  function renderList() {
    const listEl = modalEl.querySelector('#homebrew-filter-list');
    if (!window.HomebrewFilter) {
      listEl.innerHTML = '<div class="book-filter-empty">Homebrew module unavailable.</div>';
      return;
    }
    const allRules = window.HomebrewFilter.getRules();
    if (!allRules.length) {
      listEl.innerHTML =
        '<div class="book-filter-empty">No homebrew rules registered yet. ' +
        'Each rule self-registers when its module loads — if you see ' +
        'this message, no rule bundles are present in this build.</div>';
      return;
    }
    // Group by category. Rules with a `parentKey` are skipped at
    // the top level — they render as children under their parent's
    // row instead (e.g. Item Familiar Diamond Soul rules nest under
    // the Diamond Soul book parent). Categories that end up empty
    // after this filter are omitted from the modal entirely so we
    // don't show ghost "Item Familiar" headers with nothing under
    // them.
    const groups = new Map();
    for (const r of allRules) {
      if (r.parentKey) continue;
      if (!groups.has(r.category)) groups.set(r.category, []);
      groups.get(r.category).push(r);
    }

    // Parent/child rendering for homebrew books: a parent rule
    // (key prefix "book_") gets rendered with a chevron + bulk
    // checkbox, followed by indented child entry rows. The child
    // entries are the per-content toggles registered via
    // HomebrewFilter.registerEntry from homebrew/book_content.js.
    // Other rule categories (Item Familiar etc.) render flat as
    // before — they have no children.
    // A rule "has children" if it's referenced as parentKey by any
    // entry or rule. The Diamond Soul parent gets BOTH content
    // entries (Tidecaller, Rooted Calling) AND subsystem rules
    // (Item Familiar variants) as children — see getChildren().
    const HBF = window.HomebrewFilter;
    // Sort categories alphabetically AND sort rules within each
    // category alphabetically by name. Registration order is whatever
    // the script-tag order in index.html happens to be — alphabetical
    // is the more predictable browse order in a menu the user opens
    // looking for a specific rule.
    const byName = (a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''));
    const sortedCats = [...groups.keys()].sort(
      (a, b) => String(a).localeCompare(String(b)));
    let html = '';
    for (const cat of sortedCats) {
      const rs = [...groups.get(cat)].sort(byName);
      html += `<div class="book-filter-group" data-group="${escapeAttr(cat)}">`
        + `<div class="book-filter-grouphead"><span>${escapeHtml(cat)}</span></div>`;
      for (const r of rs) {
        const hasChildren = HBF.getChildren
          && HBF.getChildren(r.key).length > 0;
        if (hasChildren) {
          html += renderParentWithChildren(r);
        } else {
          html += renderFlatRule(r);
        }
      }
      html += `</div>`;
    }
    listEl.innerHTML = html;
    listEl.addEventListener('change', onListChange);
    listEl.addEventListener('click', onListClick);
    applyIndeterminate(listEl);
    refreshStatus();
  }

  function renderFlatRule(r) {
    const checked = window.HomebrewFilter.isEnabled(r.key) ? 'checked' : '';
    const info = r.informational
      ? '<span class="hbf-info-tag" title="No mechanical effect — '
        + 'sheet-level flag for visibility only">info</span>'
      : '';
    const src = r.source
      ? `<span class="hbf-src" title="Source">${escapeHtml(r.source)}</span>`
      : '';
    return `<label class="hbf-row" data-key="${escapeAttr(r.key)}">`
      + `<input type="checkbox" data-key="${escapeAttr(r.key)}" ${checked}>`
      + `<span class="hbf-rowtext">`
      +   `<span class="hbf-rowtitle">`
      +     `${escapeHtml(r.name)} ${info} ${src}`
      +   `</span>`
      +   (r.description
            ? `<span class="hbf-desc">${escapeHtml(r.description)}</span>`
            : '')
      + `</span>`
      + `</label>`;
  }

  function renderParentWithChildren(r) {
    const HBF = window.HomebrewFilter;
    // Sort children alphabetically too — a Diamond Soul book parent
    // collects both content entries (Tidecaller, Rooted Calling…)
    // and subsystem rules (Item Familiar variants) as children, and
    // their registration order is whatever the homebrew/*.js script-
    // tag order happens to be. Alphabetical reads as the natural
    // browse order when the user is looking for a specific entry.
    const children = (HBF.getChildren ? HBF.getChildren(r.key) : [])
      .slice()
      .sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || '')));
    const state = computeParentState(children);
    const checked = state === 'all';
    const indeterminate = state === 'some';
    // Children sub-list is collapsed by default — user clicks the
    // chevron to expand. Persists nothing across reloads (intentional;
    // homebrew is rarely-opened UI, no need to bother).
    const collapsed = true;
    const chevron = collapsed ? '▶' : '▼';
    const childSrc = r.source
      ? `<span class="hbf-src" title="Source">${escapeHtml(r.source)}</span>`
      : '';

    let html = `<div class="hbf-parent" data-parent-key="${escapeAttr(r.key)}">`
      + `<label class="hbf-row hbf-row-parent" data-key="${escapeAttr(r.key)}">`
      +   `<button type="button" class="hbf-chevron" `
      +     `data-parent-toggle="${escapeAttr(r.key)}" `
      +     `aria-label="Expand/collapse">${chevron}</button>`
      +   `<input type="checkbox" data-parent-key="${escapeAttr(r.key)}"`
      +     ` ${checked ? 'checked' : ''}`
      +     ` ${indeterminate ? 'data-indeterminate="1"' : ''}>`
      +   `<span class="hbf-rowtext">`
      +     `<span class="hbf-rowtitle">${escapeHtml(r.name)} ${childSrc}</span>`
      +     `<span class="hbf-desc">`
      +       `${children.length} ${children.length === 1 ? 'item' : 'items'}`
      +       ` — toggle individually below, or use this checkbox to toggle all`
      +     `</span>`
      +   `</span>`
      + `</label>`;
    html += `<div class="hbf-children" `
      +     `data-children-of="${escapeAttr(r.key)}"`
      +     ` style="display: ${collapsed ? 'none' : 'block'};">`;
    for (const c of children) {
      html += c.kind === 'entry'
        ? renderChildEntry(c)
        : renderChildRule(c);
    }
    html += `</div></div>`;
    return html;
  }

  const TYPE_LABEL = {
    prc: 'PrC', feat: 'Feat', spell: 'Spell', item: 'Item',
    class: 'Class', race: 'Race', domain: 'Domain',
    deity: 'Deity', invocation: 'Invocation',
    maneuver: 'Maneuver', mystery: 'Mystery', power: 'Power',
    rule: 'Rule', template: 'Template', creature: 'Creature',
    soulmeld: 'Soulmeld', vestige: 'Vestige', plane: 'Plane',
    organization: 'Organization', acf: 'ACF',
    subst_level: 'Subst. Level', skill_trick: 'Skill Trick',
  };

  function renderChildEntry(c) {
    const HBF = window.HomebrewFilter;
    const cChecked = HBF.isEnabled(c.key) ? 'checked' : '';
    const typeLabel = TYPE_LABEL[c.type] || c.type;
    return `<label class="hbf-row hbf-row-child" data-key="${escapeAttr(c.key)}">`
      + `<input type="checkbox" data-entry-key="${escapeAttr(c.key)}" ${cChecked}>`
      + `<span class="hbf-rowtext">`
      +   `<span class="hbf-rowtitle">`
      +     `${escapeHtml(c.name)}`
      +     `<span class="hbf-child-type">${escapeHtml(typeLabel)}</span>`
      +   `</span>`
      + `</span>`
      + `</label>`;
  }

  function renderChildRule(c) {
    const HBF = window.HomebrewFilter;
    const cChecked = HBF.isEnabled(c.key) ? 'checked' : '';
    const info = c.informational
      ? '<span class="hbf-info-tag" title="No mechanical effect — '
        + 'sheet-level flag for visibility only">info</span>'
      : '';
    // Use the rule's category as a sub-tag so the user can tell
    // a Diamond Soul rule from a Diamond Soul content entry.
    const catTag = c.category
      ? `<span class="hbf-child-type">${escapeHtml(c.category)}</span>`
      : '';
    return `<label class="hbf-row hbf-row-child hbf-row-child-rule" `
      +   `data-key="${escapeAttr(c.key)}">`
      + `<input type="checkbox" data-key="${escapeAttr(c.key)}" ${cChecked}>`
      + `<span class="hbf-rowtext">`
      +   `<span class="hbf-rowtitle">`
      +     `${escapeHtml(c.name)} ${catTag} ${info}`
      +   `</span>`
      +   (c.description
            ? `<span class="hbf-desc">${escapeHtml(c.description)}</span>`
            : '')
      + `</span>`
      + `</label>`;
  }

  // Parent tristate: 'all' (every child enabled), 'none' (every
  // child disabled), 'some' (mixed). Walks both child kinds via
  // the same HomebrewFilter.isEnabled lookup.
  function computeParentState(children) {
    const HBF = window.HomebrewFilter;
    let on = 0, off = 0;
    for (const c of children) {
      if (HBF.isEnabled(c.key)) on++; else off++;
    }
    if (on && !off) return 'all';
    if (off && !on) return 'none';
    return 'some';
  }

  // After renderList writes innerHTML, set the indeterminate flag
  // on any parent checkbox that needs it (HTML can't express this
  // declaratively).
  function applyIndeterminate(root) {
    const cbs = root.querySelectorAll(
      'input[type=checkbox][data-indeterminate="1"]');
    cbs.forEach(cb => { cb.indeterminate = true; });
  }

  // Delegated change handler — child + parent + flat-rule checkboxes
  // all flow through here. Each sets HomebrewFilter state and the
  // change event triggers a status refresh.
  //
  // Note on the data-key / data-entry-key / data-parent-key split:
  // child entries use `data-entry-key` so we can find their parent
  // via HomebrewFilter.getEntries(); child rules use `data-key`
  // (same as flat rules) and parent lookup goes through
  // HomebrewFilter.getRules(). Both flow through the same
  // setEnabled — only the parent re-render path differs.
  function onListChange(ev) {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement) || t.type !== 'checkbox') return;
    const HBF = window.HomebrewFilter;
    if (t.dataset.parentKey) {
      // Parent checkbox: bulk-toggle every child (both entries and
      // parented rules) to the parent's new state. Each setEnabled
      // emits a homebrew-filter-changed event; that's fine — they
      // batch visually because re-render is local.
      const children = HBF.getChildren
        ? HBF.getChildren(t.dataset.parentKey)
        : [];
      for (const c of children) {
        HBF.setEnabled(c.key, t.checked);
      }
      reRenderParent(t.dataset.parentKey);
    } else if (t.dataset.entryKey) {
      HBF.setEnabled(t.dataset.entryKey, t.checked);
      reRenderParentForChild(t.dataset.entryKey, 'entry');
    } else if (t.dataset.key) {
      HBF.setEnabled(t.dataset.key, t.checked);
      // Could be a flat rule (no parent) or a child rule (has
      // parentKey). Update the parent tristate if needed.
      reRenderParentForChild(t.dataset.key, 'rule');
    }
    refreshStatus();
  }

  // Click handler for the chevron (it's a <button>, not an input,
  // so it fires click not change).
  function onListClick(ev) {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const parentKey = t.dataset.parentToggle;
    if (!parentKey) return;
    ev.preventDefault();
    const wrapper = modalEl.querySelector(
      `.hbf-children[data-children-of="${cssEscape(parentKey)}"]`);
    if (!wrapper) return;
    const isHidden = wrapper.style.display === 'none';
    wrapper.style.display = isHidden ? 'block' : 'none';
    t.textContent = isHidden ? '▼' : '▶';
  }

  function reRenderParent(parentKey) {
    const wrap = modalEl.querySelector(
      `.hbf-parent[data-parent-key="${cssEscape(parentKey)}"]`);
    if (!wrap) return;
    const HBF = window.HomebrewFilter;
    // Update each child checkbox (both entry-kind and rule-kind)
    // to match HomebrewFilter state.
    wrap.querySelectorAll('input[data-entry-key]').forEach(cb => {
      cb.checked = HBF.isEnabled(cb.dataset.entryKey);
    });
    wrap.querySelectorAll('.hbf-row-child-rule input[data-key]').forEach(cb => {
      cb.checked = HBF.isEnabled(cb.dataset.key);
    });
    // Update parent indeterminate / checked from the unified child list.
    const children = HBF.getChildren ? HBF.getChildren(parentKey) : [];
    const state = computeParentState(children);
    const parentCb = wrap.querySelector('input[data-parent-key]');
    if (parentCb) {
      parentCb.checked = (state === 'all');
      parentCb.indeterminate = (state === 'some');
    }
  }

  // After a child toggles, find its parent (if any) and refresh
  // the parent's tristate. `kind` is 'entry' or 'rule' — they
  // come from different HomebrewFilter registries so the lookup
  // path differs.
  function reRenderParentForChild(childKey, kind) {
    const HBF = window.HomebrewFilter;
    let parentKey = null;
    if (kind === 'entry' && HBF.getEntries) {
      const entry = HBF.getEntries().find(e => e.key === childKey);
      parentKey = entry && entry.parentKey;
    } else if (kind === 'rule' && HBF.getRules) {
      const rule = HBF.getRules().find(r => r.key === childKey);
      parentKey = rule && rule.parentKey;
    }
    if (parentKey) reRenderParent(parentKey);
  }

  // Browser-safe CSS.escape polyfill — older Edge / very old Chrome.
  function cssEscape(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }


  function refreshStatus() {
    const listEl = modalEl.querySelector('#homebrew-filter-list');
    const statusEl = modalEl.querySelector('#homebrew-filter-status');
    if (!listEl || !statusEl) return;
    const checked = listEl.querySelectorAll('input[type=checkbox]:checked').length;
    const total = listEl.querySelectorAll('input[type=checkbox]').length;
    if (!total) { statusEl.textContent = ''; return; }
    if (!checked) {
      statusEl.textContent = 'No homebrew rules active — sheet behaves as RAW.';
      statusEl.className = 'book-filter-status book-filter-status-neutral';
    } else {
      statusEl.textContent =
        `${checked} of ${total} homebrew rules active.`;
      statusEl.className = 'book-filter-status book-filter-status-active';
    }
  }

  function applySelection() {
    const listEl = modalEl.querySelector('#homebrew-filter-list');
    const cbs = listEl.querySelectorAll('input[type=checkbox]');
    for (const cb of cbs) {
      window.HomebrewFilter.setEnabled(cb.dataset.key, cb.checked);
    }
    close();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  // ---- Open / close ------------------------------------------------------

  function open() {
    ensureModal();
    modalEl.style.display = '';
    renderList();
    document.addEventListener('keydown', onKeydown);
  }
  function close() {
    if (modalEl) modalEl.style.display = 'none';
    document.removeEventListener('keydown', onKeydown);
  }
  function onKeydown(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  }

  // ---- Init --------------------------------------------------------------

  // Insert the trigger after DOM is parsed. Order doesn't matter for
  // HomebrewFilter (already initialized when this loads).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insertTrigger);
  } else {
    insertTrigger();
  }
})();
