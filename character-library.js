// character-library.js — full-library browser for saved characters.
//
// The character-select dropdown shows only the active working set
// (root + saves/active/). This modal is the way to browse, search,
// and load the FULL save library — including imported_characters
// staged under saves/library/ (potentially hundreds of entries).
//
// Activation:
//   - 📂 button in the header (next to the existing save controls)
//   - Future: Ctrl+O hotkey
//
// Features:
//   - Live search across name + char-player + class + race + deity
//     + campaign + notes (full text) + feats/abilities + tags
//   - Folder filter chips (sourced dynamically from list() output)
//   - Tag filter chips (sourced dynamically; multi-select; AND logic)
//   - Sort: by name (default), by modified date, by class, by folder
//   - Per-row preview: level / class / race / alignment + first
//     ~120 chars of notes (with search-match highlighting)
//   - Click → load + close modal
//   - Refreshes when the file system might have changed (on each
//     open). No live event stream — file edits outside the sheet
//     are visible after the next reopen.
//
// Search implementation: lazy. The list endpoint returns metadata
// only (no notes/feats), so the modal fetches each character's
// full data on demand for content matching. We CACHE the loaded
// data per qualified-name for the session, so repeated searches
// don't re-hit the network. Cache invalidates on modal-close to
// keep memory bounded (worst case ~400 chars * ~50KB ≈ 20MB if
// fully loaded; in practice search-as-you-type warms a fraction).
//
// Performance: with 400 characters and a typed query, we run the
// regex over the cached + freshly-fetched full bodies. Fully cached
// + filtered: <50ms. First-typed-letter fetches all candidates in
// parallel via Promise.all — fast even with cold cache because the
// server is local.

(function () {
  let triggerBtn = null;
  let modalEl = null;
  // Per-qualified-name cached full body. Cleared on modal close to
  // bound memory; warmed by search + initial open.
  let dataCache = new Map();
  // The metadata array from SaveBackend.list(), last fetched.
  let lastListing = [];
  // Active filter state.
  let activeFolder = null;        // null = all
  let activeTags = new Set();
  let activeSearch = '';
  let activeSort = 'name';        // 'name' | 'modified' | 'class' | 'folder'

  // ---- Trigger button -----------------------------------------------------

  function insertTrigger() {
    if (triggerBtn) return;
    // Slot next to the existing save controls. The save row has
    // #character-select / #btn-save / #btn-export — find that
    // container and append.
    const select = document.getElementById('character-select');
    if (!select) {
      // Try again once the rest of init finishes — happens on
      // very-early-load races.
      setTimeout(insertTrigger, 100);
      return;
    }
    const host = select.parentElement;
    triggerBtn = document.createElement('button');
    triggerBtn.id = 'char-library-trigger-btn';
    triggerBtn.type = 'button';
    triggerBtn.className = 'lib-trigger';
    triggerBtn.title =
      'Browse saved character library (full search + folders + tags)';
    triggerBtn.textContent = '📂';
    triggerBtn.addEventListener('click', open);
    // Place it right after the select, before the new/save buttons,
    // so the eye reads: pick → browse → new → save → export → import.
    select.insertAdjacentElement('afterend', triggerBtn);
  }

  // ---- Modal --------------------------------------------------------------

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.id = 'char-library-modal';
    modalEl.className = 'char-lib-modal';
    modalEl.style.display = 'none';
    modalEl.innerHTML = `
      <div class="char-lib-backdrop" data-close="1"></div>
      <div class="char-lib-card" role="dialog" aria-modal="true"
           aria-labelledby="char-lib-title">
        <div class="char-lib-header">
          <div>
            <div class="char-lib-title" id="char-lib-title">
              Character library
            </div>
            <div class="char-lib-sub" id="char-lib-summary">
              Loading...
            </div>
          </div>
          <button type="button" class="char-lib-close" data-close="1"
                  aria-label="Close">×</button>
        </div>
        <div class="char-lib-controls">
          <input type="search" id="char-lib-search"
                 placeholder="Search name, class, race, notes, deity, campaign…"
                 autocomplete="off">
          <select id="char-lib-sort" title="Sort by">
            <option value="name">Sort: Name</option>
            <option value="modified">Sort: Recently modified</option>
            <option value="class">Sort: Class</option>
            <option value="folder">Sort: Folder</option>
          </select>
        </div>
        <div class="char-lib-filters">
          <div class="char-lib-filter-row">
            <span class="char-lib-filter-label">Folder:</span>
            <span id="char-lib-folder-chips"></span>
          </div>
          <div class="char-lib-filter-row">
            <span class="char-lib-filter-label">Tags:</span>
            <span id="char-lib-tag-chips"></span>
          </div>
        </div>
        <div class="char-lib-list" id="char-lib-list">
          <div class="char-lib-empty">Loading character list…</div>
        </div>
        <div class="char-lib-footer">
          <span class="char-lib-hint">
            <kbd>Esc</kbd> close &nbsp; <kbd>↑↓</kbd> nav &nbsp; <kbd>Enter</kbd> load
          </span>
          <span id="char-lib-status"></span>
        </div>
      </div>
    `;
    document.body.appendChild(modalEl);
    wireEvents();
    return modalEl;
  }

  function wireEvents() {
    modalEl.addEventListener('click', (ev) => {
      const t = ev.target;
      if (t instanceof Element && t.dataset.close === '1') close();
    });
    const search = modalEl.querySelector('#char-lib-search');
    search.addEventListener('input', () => {
      activeSearch = search.value.trim().toLowerCase();
      render();
    });
    const sort = modalEl.querySelector('#char-lib-sort');
    sort.addEventListener('change', () => {
      activeSort = sort.value;
      render();
    });
    // Delegated click for filter chips + list rows.
    modalEl.addEventListener('click', (ev) => {
      const folderChip = ev.target.closest('[data-folder-chip]');
      if (folderChip) {
        const f = folderChip.dataset.folderChip;
        activeFolder = (activeFolder === f) ? null : (f === '__all__' ? null : f);
        render();
        return;
      }
      const tagChip = ev.target.closest('[data-tag-chip]');
      if (tagChip) {
        const t = tagChip.dataset.tagChip;
        if (activeTags.has(t)) activeTags.delete(t);
        else activeTags.add(t);
        render();
        return;
      }
      // Move buttons take precedence over row-click — stop the row's
      // load handler from firing under the button.
      const moveBtn = ev.target.closest('[data-move-to]');
      if (moveBtn) {
        ev.stopPropagation();
        const fromQ = moveBtn.dataset.moveFrom;
        const toFolder = moveBtn.dataset.moveTo;
        handleMove(fromQ, toFolder);
        return;
      }
      const row = ev.target.closest('[data-qualified]');
      if (row) {
        const qualified = row.dataset.qualified;
        loadAndClose(qualified);
        return;
      }
    });
  }

  // Move a save into the target folder. Slug stays the same (filesystem
  // identity); only the folder prefix changes. After a successful move
  // we drop the cached body (it's keyed by the OLD qualified) and
  // refresh. If the move target is the currently-loaded character,
  // update AppState so subsequent Saves write to the new location.
  // Defensive notification — falls back to a console log + alert
  // if the App.showNotification helper isn't wired (very early load,
  // or app.js failed to expose it). Don't poke #notification
  // directly: it's lazily created by showNotification, so the
  // element may not exist yet on first interaction.
  function notify(msg, isError) {
    if (window.App && typeof window.App.showNotification === 'function') {
      window.App.showNotification(msg, !!isError);
    } else {
      console.warn('[char-lib] (no notification helper) ' + msg);
      if (isError) alert(msg);
    }
  }

  async function handleMove(fromQ, toFolder) {
    const { name: slug } = SaveBackend.parseQualified(fromQ);
    const toQ = toFolder ? `${toFolder}/${slug}` : slug;
    try {
      await SaveBackend.move(fromQ, toQ);
    } catch (e) {
      console.error('[char-lib] move failed:', e);
      notify(`Move failed: ${e.message}`, true);
      return;
    }
    // Invalidate caches.
    dataCache.delete(fromQ);
    // Sync the currently-loaded-character pointer so the next Save
    // hits the new path, not the old one.
    if (window.AppState && window.AppState.currentQualifiedName === fromQ) {
      window.AppState.currentQualifiedName = toQ;
    }
    // Refresh the dropdown — if we moved between active/root, its
    // visible set changed.
    if (window.App && window.App.updateCharacterSelect) {
      window.App.updateCharacterSelect();
    }
    // Refresh the modal listing.
    await refresh();
    notify(`Moved "${slug}" → ${toFolder || 'root'}`);
  }

  // ---- Data load + search -------------------------------------------------

  // Returns the cached full data for `qualified`, fetching if absent.
  // Sets the cache entry to null on fetch failure so we don't retry
  // every keystroke.
  async function loadFull(qualified) {
    if (dataCache.has(qualified)) return dataCache.get(qualified);
    try {
      const d = await SaveBackend.load(qualified);
      dataCache.set(qualified, d || null);
      return d || null;
    } catch (e) {
      console.warn('[char-lib] load failed for', qualified, e);
      dataCache.set(qualified, null);
      return null;
    }
  }

  // Concurrently warm cache for an array of qualified names. Used to
  // pre-fetch matching candidates so search highlighting + snippets
  // work without per-row latency.
  async function warmCache(qualifieds) {
    const cold = qualifieds.filter(q => !dataCache.has(q));
    if (!cold.length) return;
    await Promise.all(cold.map(loadFull));
  }

  // Build the search-target text for a character entry (combines
  // metadata + cached full body when available). Returns lowercase
  // for case-insensitive match.
  function searchText(entry, full) {
    const bits = [
      entry.name, entry.qualified, entry.folder,
      ...(entry.tags || []),
    ];
    if (full) {
      bits.push(
        full['char-name'], full['char-player'], full['char-class'],
        full['char-race'], full['char-deity'], full['char-campaign'],
        full['char-alignment'], full['char-gender'], full['notes'],
      );
      // Feats / specialAbilities are arrays of strings.
      if (Array.isArray(full.feats)) bits.push(...full.feats);
      if (Array.isArray(full.specialAbilities)) bits.push(...full.specialAbilities);
      // Attack notes (most attack arrays have a `notes` field).
      if (Array.isArray(full.attacks)) {
        for (const a of full.attacks) if (a && a.notes) bits.push(a.notes);
      }
      // Caster panel notes / spells text — searchable for "fireball"
      // etc.
      if (Array.isArray(full.casters)) {
        for (const c of full.casters) {
          if (!c) continue;
          for (const v of Object.values(c)) {
            if (typeof v === 'string') bits.push(v);
          }
        }
      }
    }
    return bits.filter(Boolean).join(' \n ').toLowerCase();
  }

  // ---- Render -------------------------------------------------------------

  async function refresh() {
    try {
      lastListing = await SaveBackend.list();
    } catch (e) {
      console.error('[char-lib] list failed:', e);
      lastListing = [];
    }
    render();
  }

  async function render() {
    const listEl = modalEl.querySelector('#char-lib-list');
    const summaryEl = modalEl.querySelector('#char-lib-summary');
    const statusEl = modalEl.querySelector('#char-lib-status');

    renderFolderChips();
    renderTagChips();

    // Apply folder + tag filters first (metadata-only, fast).
    let entries = lastListing.slice();
    if (activeFolder !== null) {
      entries = entries.filter(e => e.folder === activeFolder);
    }
    if (activeTags.size) {
      entries = entries.filter(e =>
        [...activeTags].every(t => (e.tags || []).includes(t)));
    }

    // Search: if active, warm cache for filtered candidates then
    // filter by full-text. Without search we can render immediately
    // from metadata alone.
    if (activeSearch) {
      statusEl.textContent = 'Searching…';
      const qualifieds = entries.map(e => e.qualified);
      await warmCache(qualifieds);
      const q = activeSearch;
      entries = entries.filter(e => {
        const full = dataCache.get(e.qualified);
        return searchText(e, full).includes(q);
      });
      statusEl.textContent = '';
    }

    // Sort.
    const cmp = sortComparator(activeSort);
    entries.sort(cmp);

    summaryEl.textContent =
      `${entries.length} of ${lastListing.length} characters` +
      (activeFolder !== null ? ` · folder: ${activeFolder || '(root)'}` : '') +
      (activeTags.size ? ` · tags: ${[...activeTags].join(', ')}` : '') +
      (activeSearch ? ` · matching "${activeSearch}"` : '');

    if (!entries.length) {
      listEl.innerHTML =
        '<div class="char-lib-empty">No matches.</div>';
      return;
    }

    // Render rows. Snippet shows ~120ch of notes around the first
    // match (when searching), else just the first 120ch of notes.
    listEl.innerHTML = entries.map(e => renderRow(e)).join('');
  }

  function sortComparator(key) {
    if (key === 'modified') {
      // Descending (newest first); null modified sorts last.
      return (a, b) => {
        if (!a.modified && !b.modified) return a.name.localeCompare(b.name);
        if (!a.modified) return 1;
        if (!b.modified) return -1;
        return b.modified.localeCompare(a.modified);
      };
    }
    if (key === 'class') {
      return (a, b) => {
        const da = dataCache.get(a.qualified);
        const db = dataCache.get(b.qualified);
        const ca = (da && da['char-class']) || '';
        const cb = (db && db['char-class']) || '';
        return ca.localeCompare(cb) || a.name.localeCompare(b.name);
      };
    }
    if (key === 'folder') {
      return (a, b) =>
        (a.folder || '').localeCompare(b.folder || '') ||
        a.name.localeCompare(b.name);
    }
    // Default: by name.
    return (a, b) => a.name.localeCompare(b.name);
  }

  function renderRow(entry) {
    const full = dataCache.get(entry.qualified);
    const meta = [];
    if (full) {
      if (full['char-level']) meta.push(`L${escapeHtml(full['char-level'])}`);
      if (full['char-class']) meta.push(escapeHtml(full['char-class']));
      if (full['char-race']) meta.push(escapeHtml(full['char-race']));
      if (full['char-alignment']) meta.push(escapeHtml(full['char-alignment']));
    }
    const metaLine = meta.length
      ? `<div class="char-lib-meta">${meta.join(' · ')}</div>` : '';
    const snippet = renderSnippet(full, activeSearch);
    const folderTag = entry.folder
      ? `<span class="char-lib-folder">${escapeHtml(entry.folder)}/</span>`
      : '';
    const tagBits = (entry.tags || [])
      .map(t => `<span class="char-lib-tag">${escapeHtml(t)}</span>`)
      .join('');
    // Move buttons — hover-revealed, contextual to where the entry
    // currently lives. Library entry: "→ active" (promote / unretire).
    // Active entry: "→ library" (retire). Root entry: both (the user
    // freshly built a character at root and needs to file it).
    // Buttons carry both data-move-from (qualified) and data-move-to
    // (target folder name) so the click handler doesn't have to
    // re-derive anything.
    const moveBtns = renderMoveButtons(entry);
    return (
      `<div class="char-lib-row" data-qualified="${escapeAttr(entry.qualified)}">` +
        `<div class="char-lib-row-head">` +
          folderTag +
          `<span class="char-lib-name">${escapeHtml(entry.name)}</span>` +
          (entry.slug !== entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
            ? ` <span class="char-lib-slug">(${escapeHtml(entry.slug)})</span>`
            : '') +
          (tagBits
            ? ` <span class="char-lib-tags">${tagBits}</span>` : '') +
          moveBtns +
        `</div>` +
        metaLine +
        snippet +
      `</div>`
    );
  }

  function renderMoveButtons(entry) {
    const buttons = [];
    const folder = entry.folder || '';
    const qAttr = escapeAttr(entry.qualified);
    // "→ active": shown when the entry isn't already in active/
    if (folder !== 'active') {
      buttons.push(
        `<button type="button" class="char-lib-move-btn" ` +
        `data-move-from="${qAttr}" data-move-to="active" ` +
        `title="Move to saves/active/ (unretire — visible in dropdown)">` +
        `→ active</button>`);
    }
    // "→ library": shown when the entry isn't already in library/
    if (folder !== 'library') {
      buttons.push(
        `<button type="button" class="char-lib-move-btn" ` +
        `data-move-from="${qAttr}" data-move-to="library" ` +
        `title="Move to saves/library/ (retire — hidden from dropdown, ` +
        `git-ignored)">` +
        `→ library</button>`);
    }
    if (!buttons.length) return '';
    return `<span class="char-lib-moves">${buttons.join('')}</span>`;
  }

  function renderSnippet(full, query) {
    if (!full) return '';
    const notes = String(full.notes || '').trim();
    if (!notes) return '';
    let start = 0;
    let display = notes;
    if (query) {
      const idx = notes.toLowerCase().indexOf(query);
      if (idx > 0) {
        start = Math.max(0, idx - 30);
      }
    }
    display = notes.slice(start, start + 240);
    if (start > 0) display = '…' + display;
    if (notes.length > start + 240) display = display + '…';
    // Highlight the query match.
    let html = escapeHtml(display);
    if (query) {
      const re = new RegExp(
        '(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')',
        'gi');
      html = html.replace(re, '<mark>$1</mark>');
    }
    return `<div class="char-lib-snippet">${html}</div>`;
  }

  function renderFolderChips() {
    const host = modalEl.querySelector('#char-lib-folder-chips');
    const folders = new Map();    // folder -> count
    folders.set('', 0);           // root always rendered
    for (const e of lastListing) {
      const f = e.folder || '';
      folders.set(f, (folders.get(f) || 0) + 1);
    }
    const chips = ['__all__', ...[...folders.keys()].sort()];
    host.innerHTML = chips.map(f => {
      const isAll = f === '__all__';
      const label = isAll ? `All (${lastListing.length})`
        : (f === '' ? `(root) (${folders.get(f)})`
                     : `${f} (${folders.get(f)})`);
      const isActive = isAll ? activeFolder === null : activeFolder === f;
      return `<button type="button" class="char-lib-chip` +
        (isActive ? ' char-lib-chip-active' : '') +
        `" data-folder-chip="${escapeAttr(f)}">` +
        escapeHtml(label) + `</button>`;
    }).join('');
  }

  function renderTagChips() {
    const host = modalEl.querySelector('#char-lib-tag-chips');
    const tags = new Map();
    for (const e of lastListing) {
      for (const t of (e.tags || [])) {
        tags.set(t, (tags.get(t) || 0) + 1);
      }
    }
    if (!tags.size) {
      host.innerHTML =
        '<span class="char-lib-empty-inline">(no tags applied yet)</span>';
      return;
    }
    const sorted = [...tags.keys()].sort();
    host.innerHTML = sorted.map(t => {
      const isActive = activeTags.has(t);
      return `<button type="button" class="char-lib-chip` +
        (isActive ? ' char-lib-chip-active' : '') +
        `" data-tag-chip="${escapeAttr(t)}">` +
        escapeHtml(`${t} (${tags.get(t)})`) + `</button>`;
    }).join('');
  }

  // ---- Load + open / close ------------------------------------------------

  async function loadAndClose(qualified) {
    if (window.App && window.App.loadCharacter) {
      await window.App.loadCharacter(qualified);
    }
    close();
  }

  function open() {
    ensureModal();
    modalEl.style.display = '';
    document.addEventListener('keydown', onKeydown);
    // Focus the search box for instant typing.
    setTimeout(() => {
      const s = modalEl.querySelector('#char-lib-search');
      if (s) s.focus();
    }, 0);
    refresh();
  }

  function close() {
    if (modalEl) modalEl.style.display = 'none';
    document.removeEventListener('keydown', onKeydown);
    // Clear cache to bound memory — next open re-warms on demand.
    dataCache.clear();
  }

  function onKeydown(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  }

  // ---- Utils --------------------------------------------------------------

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  // ---- Init ---------------------------------------------------------------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insertTrigger);
  } else {
    insertTrigger();
  }
})();
