// deity-picker.js — Autocomplete + info panel on the Character tab's
// Deity field. Queries `entry WHERE type='deity'` (121 entries, all
// from FRCS today). On exact-match input the info panel renders
// alignment / rank / pantheon / domains / favored weapon / symbol /
// portfolio / worshipers + a short description. Alignment dropdown
// is auto-filled (when blank) from the deity's `alignment` two-
// letter code.
//
// Future enhancement: clickable domain chips in the info panel that
// insert into the next-empty `.sc-domain-name` slot on the Spells
// tab. For MVP the user reads the domain list and types it in
// manually (matches how other deity-related sheet fields work).

(function () {
  if (!window.DB) {
    console.warn('[deity-picker] DB module not loaded');
    return;
  }

  // Lower-case name → deity record.
  const deityIndex = new Map();
  let datalist = null;
  let infoPanel = null;

  // Two-letter alignment codes from the deity stat blocks map to the
  // character sheet's alignment dropdown values. "N" / "TN" both
  // resolve to True Neutral.
  const ALIGNMENT_BY_CODE = {
    LG: 'Lawful Good',  NG: 'Neutral Good',  CG: 'Chaotic Good',
    LN: 'Lawful Neutral', N: 'True Neutral', TN: 'True Neutral',
    CN: 'Chaotic Neutral',
    LE: 'Lawful Evil',  NE: 'Neutral Evil',  CE: 'Chaotic Evil',
  };

  function init() {
    const deityInput = document.getElementById('char-deity');
    if (!deityInput) {
      console.warn('[deity-picker] #char-deity input not found');
      return;
    }

    // 1. Insert <datalist> for autocomplete.
    datalist = document.getElementById('deity-options');
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = 'deity-options';
      deityInput.setAttribute('list', 'deity-options');
      deityInput.setAttribute('autocomplete', 'off');
      deityInput.parentElement.appendChild(datalist);
    }

    // 2. Insert info panel below the deity field. The Character info-
    // grid spans the full width; setting grid-column to span all cells
    // makes the panel appear on its own row below the grid.
    //
    // Default-hidden: the panel only opens when the user clicks the
    // ⓘ button next to the deity input. Deity details are rarely
    // needed during play, so they shouldn't always be in the way.
    infoPanel = document.getElementById('deity-info');
    if (!infoPanel) {
      infoPanel = document.createElement('div');
      infoPanel.id = 'deity-info';
      infoPanel.className = 'race-info deity-info';
      // Reuse race-info's styling (dark themed left-bordered card) but
      // override the left-border color so deity / race info are
      // visually distinct.
      infoPanel.style.cssText =
        'grid-column: 1 / -1; padding: 0.5rem; margin-top: 0.25rem; ' +
        'font-size: 0.85em; color: #ccc; background: rgba(255,255,255,0.04); ' +
        'border-left: 3px solid #aa8a6a; border-radius: 3px; display: none;';
      // Append after the info-grid (deityInput.parentElement is the
      // grid <div> that wraps the deity-input-row; parentElement of
      // that is the .field cell; the info-grid is the field's parent).
      // Find the info-grid by walking up.
      let container = deityInput.parentElement;
      while (container && !container.classList.contains('info-grid')) {
        container = container.parentElement;
      }
      (container || deityInput.parentElement).parentElement.appendChild(infoPanel);
    }

    // Wire the ⓘ toggle button (added in index.html alongside the
    // deity input). Click toggles the panel + flips aria-expanded so
    // screen readers + the user's "is it open?" intuition both match.
    const infoBtn = document.getElementById('deity-info-btn');
    if (infoBtn) {
      infoBtn.addEventListener('click', () => {
        const opening = infoPanel.style.display === 'none' || !infoPanel.style.display;
        if (opening) {
          // Re-render in case the user typed a different deity since
          // the last open.
          onDeityChosen(deityInput.value);
          infoPanel.style.display = 'block';
          infoBtn.setAttribute('aria-expanded', 'true');
          infoBtn.classList.add('info-btn-active');
        } else {
          infoPanel.style.display = 'none';
          infoBtn.setAttribute('aria-expanded', 'false');
          infoBtn.classList.remove('info-btn-active');
        }
      });
    }

    // 3a. Browse chip wall — surfaces the full deity list as
    // clickable chips below the info panel, so the user can scan
    // by alignment / pantheon visually (the chip click sets the
    // value + opens info).
    let browseWrap = document.getElementById('deity-browse');
    if (!browseWrap) {
      browseWrap = document.createElement('div');
      browseWrap.id = 'deity-browse';
      browseWrap.style.cssText =
        'grid-column: 1 / -1; margin-top: 0.25rem;';
      infoPanel.parentElement.appendChild(browseWrap);
    }
    // Chip click: set value + run the auto-fill / info-show flow
    // DIRECTLY without dispatching 'input' (the input event handler
    // re-renders the chip wall narrowed to the picked entry — we want
    // the chip wall to stay full for continued browsing). Spell-picker
    // behavior. onDeityChosen handles alignment + info panel.
    //
    // Collapsed by default — the chip wall is only really pertinent
    // at character creation. Once the player has a deity, they don't
    // need a 149-row chip wall on every page load. Native <details>
    // disclosure lets them re-open with one click; the open/closed
    // state persists across input changes within a session.
    const deityResults = (typeof PickerResults !== 'undefined')
      ? PickerResults.attach(browseWrap, {
          itemNoun: 'deity',
          collapsible: true,
          collapsedByDefault: true,
          onPick: (name) => {
            deityInput.value = name;
            onDeityChosen(name);
            deityInput.focus();
          },
        })
      : null;

    // 3. Populate options from DB. Same source-recency tiebreak as
    // every other picker (3.5 first, then newest publication date).
    function populate() {
      const deities = DB.query(
        "SELECT e.id AS deity_id, e.name, e.version, e.source, "
        + "       b.publication_date "
        + "FROM entry e "
        + "LEFT JOIN book b ON b.name = e.source "
        + "WHERE e.type = 'deity' "
        + "ORDER BY e.name COLLATE NOCASE, "
        + "         CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, "
        + "         b.publication_date DESC"
      );
      deityIndex.clear();
      datalist.innerHTML = '';
      const browseNames = [];
      let kept = 0;
      for (const r of deities) {
        if (window.BookFilter && !window.BookFilter.allowsEntry({...r, type: 'deity'})) continue;
        const key = r.name.toLowerCase();
        if (deityIndex.has(key)) continue;  // first hit wins (3.5 preferred)
        deityIndex.set(key, { id: r.deity_id, name: r.name });
        const opt = document.createElement('option');
        opt.value = r.name;
        // No opt.label — Firefox renders labels as visible completion
        // text (CLAUDE.md datalist note).
        datalist.appendChild(opt);
        browseNames.push(r.name);
        kept++;
      }
      if (deityResults) {
        deityResults.render(browseNames,
          { typedFilter: deityInput.value.trim() });
      }
      console.log(`[deity-picker] ${kept}/${deities.length} deities available`);
    }
    populate();
    document.addEventListener('book-filter-changed', populate);

    // 4. On input/change: try exact-match lookup, optionally auto-
    //    fill alignment. Only re-render the info panel when it's
    //    already open — the panel is now toggle-driven (default
    //    closed) since deity details are rarely needed during play.
    const onChange = () => onDeityChosen(deityInput.value);
    deityInput.addEventListener('change', onChange);
    deityInput.addEventListener('input', () => {
      // Re-narrow the chip wall as the user types — substring filter
      // matches the spell-picker behavior.
      if (deityResults) {
        const browseNames = Array.from(datalist.options).map(o => o.value);
        deityResults.render(browseNames,
          { typedFilter: deityInput.value.trim() });
      }
      if (deityIndex.has(deityInput.value.trim().toLowerCase())) {
        onChange();
      } else if (infoPanel && infoPanel.style.display !== 'none') {
        // User has cleared / mistyped — clear the now-stale info.
        hideInfo();
      }
    });

    // Re-render the info panel on book-filter change ONLY if it's
    // already open; otherwise just leave it for the next toggle.
    document.addEventListener('book-filter-changed', () => {
      if (deityInput.value.trim() &&
          infoPanel && infoPanel.style.display !== 'none') {
        onChange();
      }
    });

    // Rehydrate on init: if a saved character already has a deity
    // typed, auto-fill alignment immediately. The info panel stays
    // closed by default — user opens via the ⓘ button.
    if (deityInput.value.trim()) {
      const key = deityInput.value.trim().toLowerCase();
      const stub = deityIndex.get(key);
      if (stub) {
        const row = DB.queryOne(
          "SELECT data FROM entry WHERE id = ?", [stub.id]);
        if (row && row.data) {
          try {
            const d = JSON.parse(row.data);
            maybeAutoFillAlignment(d.alignment);
          } catch (e) { /* ignore */ }
        }
      }
    }

    // Click handler for domain chips inside the info panel. Single
    // delegated listener — chips are re-rendered on every renderInfo
    // call, so we can't bind per-chip cleanly.
    infoPanel.addEventListener('click', (ev) => {
      const chip = ev.target.closest('.deity-domain-chip');
      if (!chip) return;
      ev.preventDefault();
      insertDomainIntoSpellsTab(chip.dataset.domain);
    });
  }

  // Find an appropriate `.sc-domain-name` input across all
  // spellcasting panels and stuff `domainName` into it. Priority:
  //   1. First empty `.sc-domain-name` inside a panel with Domain
  //      Access toggled ON.
  //   2. If no empty slot but at least one Domain-Access panel
  //      exists, click that panel's "+ Add Domain" to create a row
  //      and fill the new one.
  //   3. If no Domain-Access panel exists, flash a hint.
  function insertDomainIntoSpellsTab(domainName) {
    if (!domainName) return;
    const panels = document.querySelectorAll(
      '#spells-content [data-caster-type="spellcasting"]');
    let firstDomainAccessPanel = null;
    for (const panel of panels) {
      const toggle = panel.querySelector('.sc-domain-toggle');
      if (!toggle || !toggle.checked) continue;
      if (!firstDomainAccessPanel) firstDomainAccessPanel = panel;
      // Reject empty if it already has the same name (case-insensitive
      // de-dupe — clicking the same chip twice shouldn't double-fill).
      const inputs = panel.querySelectorAll('.sc-domain-name');
      for (const inp of inputs) {
        if (String(inp.value).trim().toLowerCase() === domainName.toLowerCase()) {
          flashChipNote(`${domainName} already in this panel.`);
          return;
        }
      }
      for (const inp of inputs) {
        if (!inp.value.trim()) {
          fillDomainInput(inp, domainName);
          flashChipNote(`Added ${domainName}.`);
          return;
        }
      }
    }
    // No empty slot found — create one in the first Domain-Access panel.
    if (firstDomainAccessPanel) {
      const addBtn = firstDomainAccessPanel.querySelector('.sc-add-domain');
      if (addBtn) {
        addBtn.click();
        // Fill the newly-appended row.
        const inputs = firstDomainAccessPanel.querySelectorAll('.sc-domain-name');
        const newInput = inputs[inputs.length - 1];
        if (newInput) {
          fillDomainInput(newInput, domainName);
          flashChipNote(`Added ${domainName} (new row).`);
          return;
        }
      }
    }
    // No spellcasting panel has Domain Access on — guide the user.
    flashChipNote(
      'No spellcasting panel with Domain Access enabled. ' +
      'Toggle it on in the Spells tab first.',
      true);
  }

  function fillDomainInput(input, domainName) {
    input.value = domainName;
    // Dispatch input + change so domain-picker's delegation picks it
    // up and fills sibling power / info via fillFromDomain.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Append a brief feedback line under the info panel. Auto-removes
  // after ~3 seconds. `warn` = true colors it amber.
  function flashChipNote(msg, warn) {
    if (!infoPanel) return;
    const existing = infoPanel.querySelector('.deity-chip-note');
    if (existing) existing.remove();
    const note = document.createElement('div');
    note.className = 'deity-chip-note';
    note.style.cssText =
      'margin-top:0.3rem;font-style:italic;color:' +
      (warn ? '#c8a14a' : '#7a9') + ';';
    note.textContent = msg;
    infoPanel.appendChild(note);
    setTimeout(() => note.remove(), 3500);
  }

  function onDeityChosen(typedName) {
    const key = typedName.trim().toLowerCase();
    const stub = deityIndex.get(key);
    if (!stub) { hideInfo(); return; }
    // Pull full record only on demand — keeps the per-keystroke
    // lookup cheap.
    const row = DB.queryOne(
      "SELECT name, source, version, data FROM entry WHERE id = ?",
      [stub.id]);
    if (!row) { hideInfo(); return; }
    let d = {};
    try { d = JSON.parse(row.data || '{}'); }
    catch (e) { /* ignore */ }
    renderInfo(row, d);
    maybeAutoFillAlignment(d.alignment);
  }

  function maybeAutoFillAlignment(code) {
    const target = ALIGNMENT_BY_CODE[String(code || '').toUpperCase()];
    if (!target) return;
    const sel = document.getElementById('char-alignment');
    if (!sel) return;
    // Only fill when blank, or when we previously filled it
    // ourselves (data-from-deity marker, same pattern as
    // data-from-class). User edits clear the marker via the input
    // listener wired below.
    const isBlank = !sel.value;
    const ourFill = sel.dataset.fromDeity === '1';
    if (!isBlank && !ourFill) return;
    if (sel.value !== target) {
      sel.value = target;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    sel.dataset.fromDeity = '1';
    if (!sel.dataset.fromDeityWired) {
      sel.dataset.fromDeityWired = '1';
      sel.addEventListener('change', (ev) => {
        if (ev.isTrusted) delete sel.dataset.fromDeity;
      });
    }
  }

  function renderInfo(row, d) {
    if (!infoPanel) return;
    const bits = [];
    bits.push(`<b>${escapeHtml(d.name || row.name)}</b>`
      + (d.title ? ` <span style="opacity:.7">— ${escapeHtml(d.title)}</span>` : '')
      + ` <span style="opacity:.6">(${escapeHtml(row.source || '?')})</span>`);
    const meta = [];
    if (d.alignment) meta.push(`<b>Alignment:</b> ${escapeHtml(d.alignment)}`);
    if (d.rank)      meta.push(`<b>Rank:</b> ${escapeHtml(d.rank)}`);
    if (d.pantheon)  meta.push(`<b>Pantheon:</b> ${escapeHtml(d.pantheon)}`);
    if (meta.length) bits.push(meta.join(' &nbsp;·&nbsp; '));
    if (d.portfolio) bits.push(`<b>Portfolio:</b> ${escapeHtml(d.portfolio)}`);
    if (Array.isArray(d.domains) && d.domains.length) {
      // Render each domain as a clickable chip so the player can
      // insert it directly into the Spells tab's domain list
      // without tab-hopping + retyping. Wired via event delegation
      // on the info panel itself.
      const chips = d.domains.map(name =>
        `<button type="button" class="deity-domain-chip" ` +
        `data-domain="${escapeHtml(name)}" ` +
        `title="Insert ${escapeHtml(name)} into a Spells-tab domain slot">` +
        escapeHtml(name) + `</button>`
      ).join(' ');
      bits.push(`<b>Domains:</b> ${chips}`);
    }
    if (d.favored_weapon) {
      bits.push(`<b>Favored weapon:</b> ${escapeHtml(d.favored_weapon)}`);
    }
    if (d.symbol) {
      bits.push(`<b>Symbol:</b> ${escapeHtml(d.symbol)}`);
    }
    if (d.worshipers) {
      bits.push(`<b>Worshipers:</b> ${escapeHtml(d.worshipers)}`);
    }
    let html = bits.join('<br>');
    if (d.description) {
      html += `<div class="deity-info-desc" style="margin-top:0.4rem;line-height:1.4">`
        + escapeHtml(d.description) + '</div>';
    }
    infoPanel.innerHTML = html;
    if (window.ErrataBadge) ErrataBadge.attach(infoPanel, row.deity_id || row.id);
    if (window.VersionBadge) VersionBadge.attach(infoPanel, row.version || d.version);
    // Note: display state is owned by the ⓘ toggle button, NOT by
    // this render path. Filling content while closed is fine — the
    // user sees fresh content the next time they click open.
  }

  function hideInfo() {
    if (!infoPanel) return;
    infoPanel.style.display = 'none';
    infoPanel.innerHTML = '';
    // Reset the toggle button state so the chevron / aria-expanded
    // match the actual panel state.
    const btn = document.getElementById('deity-info-btn');
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      btn.classList.remove('info-btn-active');
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  DB.ready.then((db) => { if (db) init(); });
})();
