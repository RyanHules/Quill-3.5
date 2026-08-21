// soulmeld-picker.js — Soulmeld autocomplete + auto-fill for the
// Equipment tab's body-slot soulmeld inputs (and the Totemist totem
// slot at the bottom).
//
// Each magic-item slot in equipment.js has a "Soulmeld" checkbox; when
// checked, the slot exposes `.slot-sm-name` (+ a few related fields).
// Some slots also support Double Chakra, exposing `.slot-sm2-name`.
// The Totemist totem block has the same shape with id-prefixed inputs.
//
// Strategy: **per-slot datalist** — one `<datalist>` per body-slot id
// (head, neck, shoulders, …, totem) containing only the soulmelds
// whose chakra is valid for that slot. The input's `list=` attribute
// points to the matching datalist based on its closest
// `.magic-item-slot[data-slot-id]`. This both narrows suggestions to
// chakra-valid soulmelds AND avoids Firefox rendering option labels
// (chakra names like "Throat" / "Feet") as if they were suggestions.
// On exact match, read the soulmeld's structured base / essentia /
// chakra_binds fields and auto-fill `.slot-sm-base` /
// `.slot-sm-bind-effect`. MutationObserver re-syncs `list=` when new
// inputs appear.

(function () {
  if (!window.DB) {
    console.warn('[soulmeld-picker] DB module not loaded');
    return;
  }

  // Lower-case name → soulmeld record (see init() for shape).
  const soulmeldIndex = new Map();

  // Map equipment.js body-slot IDs to the chakra keywords soulmelds
  // use. Slots with multiple chakras (head → Crown OR Brow) gather
  // soulmelds whose chakra is any of them.
  const SLOT_TO_CHAKRAS = {
    head:      ['Crown', 'Brow'],
    eyes:      ['Brow'],
    neck:      ['Throat'],
    shoulders: ['Shoulders'],
    hands:     ['Hands'],
    arms:      ['Arms'],
    // MoI chakra↔body-slot map: the SOUL chakra corresponds to the Body
    // slot (robe/armor — "soulbound armor" binds to the soul chakra, MoI
    // p.108), while the HEART chakra corresponds to the Torso slot (vest/
    // vestment/shirt — a "blink shirt occupies his heart chakra", MoI p.90).
    // Previously `body` was mis-mapped to Heart (duplicating torso) and Soul
    // had no slot at all, so Soul-chakra soulmelds got no send-to-slot button.
    body:      ['Soul'],
    torso:     ['Heart'],
    waist:     ['Waist'],
    feet:      ['Feet'],
    totem:     ['Totem'],
  };

  function rebuildIndex() {
    const rows = DB.query(
      "SELECT id AS soulmeld_id, name, source, version, "
      + "json_extract(data, '$.chakra')       AS chakra, "
      + "json_extract(data, '$.classes_csv')  AS classes_csv, "
      + "json_extract(data, '$.descriptors')  AS descriptors, "
      + "json_extract(data, '$.saving_throw') AS saving_throw, "
      + "json_extract(data, '$.description')  AS description, "
      + "json_extract(data, '$.essentia')     AS essentia, "
      + "json_extract(data, '$.chakra_binds') AS chakra_binds "
      + "FROM entry WHERE type = 'soulmeld' "
      + "ORDER BY name COLLATE NOCASE"
    );
    soulmeldIndex.clear();
    for (const r of rows) {
      if (window.BookFilter && !window.BookFilter.allowsEntry({...r, type: 'soulmeld'})) continue;
      const key = (r.name || '').toLowerCase();
      if (soulmeldIndex.has(key)) continue;
      // Structured shape (DB canon 2026-08-03, canonical_fields
      // SOULMELD_SHAPE_CANON): `description` is the base effect alone,
      // `essentia` and `chakra_binds` are their own fields. This used to
      // regex-reconstruct all three out of one concatenated `description`
      // ("Base: … Essentia: … Chakra Bind (X): …"), which meant the 5 Dragon
      // Magic soulmelds — already structured, so no "Base:" prefix — rendered
      // with no description and no binds at all (flag fms24421b-kf4n).
      let binds = [];
      try {
        binds = r.chakra_binds ? JSON.parse(r.chakra_binds) : [];
      } catch (e) { /* malformed chakra_binds JSON — treat as none */ }
      if (!Array.isArray(binds)) binds = [];
      soulmeldIndex.set(key, {
        name: r.name,
        source: r.source,
        version: r.version,
        chakra: r.chakra,
        classes_csv: r.classes_csv,
        descriptors: r.descriptors,
        saving_throw: r.saving_throw,
        description: r.description,
        baseEffect: r.description,
        essentiaScaling: r.essentia,
        bindEffects: binds,          // [{chakra, description}, ...]
        // Pre-flattened haystack for the browse panel's text search. The
        // filter used to match NAMES only, which made the panel useless for
        // the actual question you ask of soulmelds — "which ones interact
        // with disease?" — since the mechanic lives in the effect prose, not
        // the name (Lammasu Mantle, Rageclaws, …). Report rms3qb8hx-7cjh.
        // MUST list essentia + bind prose explicitly now: `description` used
        // to carry all three, so building the blob from it alone would
        // silently shrink the haystack to base-effect text only.
        searchBlob: [r.name, r.descriptors, r.classes_csv, r.chakra,
                     r.saving_throw, r.description, r.essentia,
                     ...binds.map(b => `${b.chakra || ''} ${b.description || ''}`)]
          .filter(Boolean).join(' ').toLowerCase(),
      });
    }
    console.log(`[soulmeld-picker] indexed ${soulmeldIndex.size} soulmelds`);
  }

  function init() {
    rebuildIndex();

    buildPerSlotDatalists();
    syncInputs();
    wireDelegation();
    observeNew();
    injectBrowsePanel();

    document.addEventListener('book-filter-changed', () => {
      rebuildIndex();
      // Rebuild every per-slot datalist + the fallback `-all`.
      buildPerSlotDatalists();
      // Rebuild the browse-panel chip wall too.
      if (browseRefresh) browseRefresh();
    });
  }

  // ---- Browse-all chip-wall picker ---------------------------------------
  //
  // The per-slot datalists narrow to chakra-valid soulmelds for each
  // input — perfect for "I know I want a Throat-chakra meld, surface
  // me the options." But it doesn't answer the discovery question:
  // "what Totemist soulmelds exist? Show me everything." For that we
  // need a browse panel.
  //
  // Lives above the Magic Item Slots section on the Equipment tab.
  // Collapsible (closed by default) since users only need it during
  // build / level-up — mid-play it sits out of the way.
  //
  // Filters: Chakra (drops to one slot's pool) + Class (Totemist /
  // Incarnate / Soulborn) + Name (typed substring). Click a chip →
  // expands an inline info panel below the row with Base / Essentia /
  // Chakra Bind effects + Source + a "→ Add to first compatible
  // empty slot" button that finds the first matching .slot-sm-name
  // / .slot-sm2-name input that's empty AND accepts a valid chakra,
  // fills it, and triggers the existing per-input auto-fill flow.

  let browseRefresh = null;

  // All chakras the data uses, in PHB-table reading order. Used to
  // populate the chakra filter dropdown. Lowercase to match the
  // parseChakras() output.
  const ALL_CHAKRAS = [
    'crown', 'brow', 'throat', 'shoulders', 'hands', 'arms',
    'heart', 'waist', 'feet', 'totem', 'soul',
  ];

  // Classes that can grant soulmelds. Matched substring-insensitively
  // against each soulmeld's classes_csv (which is comma-separated
  // free text in the data).
  const SOULMELD_CLASSES = ['Totemist', 'Incarnate', 'Soulborn'];

  function injectBrowsePanel() {
    const host = document.getElementById('magic-items-container');
    if (!host) return;
    if (document.getElementById('soulmeld-browse')) return;

    const wrap = document.createElement('div');
    wrap.id = 'soulmeld-browse';
    wrap.style.cssText =
      'margin: 0.5rem 0 1rem; padding: 0.4rem 0.6rem; ' +
      'background: rgba(255,255,255,0.04); ' +
      'border: 1px solid rgba(255,255,255,0.12); border-radius: 4px;';
    wrap.innerHTML = `
      <details>
        <summary style="cursor:pointer; user-select:none; font-weight:600">
          Browse soulmelds…
          <span id="sm-browse-count" style="opacity:0.65; font-weight:400;
            font-size:0.85em; margin-left:0.4rem"></span>
        </summary>
        <div style="margin-top:0.5rem; display:flex; gap:0.4rem;
                    align-items:center; flex-wrap:wrap; font-size:0.85em;">
          <label>Chakra:
            <select id="sm-browse-chakra"
                    style="background:#15171f;color:#eee;border:1px solid #444;
                           border-radius:3px; padding:0.15rem;">
              <option value="">All</option>
              ${ALL_CHAKRAS.map(c =>
                `<option value="${c}">${c[0].toUpperCase()+c.slice(1)}</option>`
              ).join('')}
            </select>
          </label>
          <label>Class:
            <select id="sm-browse-class"
                    style="background:#15171f;color:#eee;border:1px solid #444;
                           border-radius:3px; padding:0.15rem;">
              <option value="">All</option>
              ${SOULMELD_CLASSES.map(c =>
                `<option value="${c}">${c}</option>`).join('')}
            </select>
          </label>
          <input type="text" id="sm-browse-name"
                 placeholder="Search name or effect text…"
                 title="Searches the whole entry — name, chakra, classes, descriptors and the full effect text. Multiple words all have to match (e.g. &quot;disease&quot;, or &quot;bind fear&quot;)."
                 style="flex:1 1 8rem; min-width:6rem; padding:0.2rem;
                        background:#15171f;color:#eee;border:1px solid #444;
                        border-radius:3px;">
          <button type="button" id="sm-browse-clear"
                  style="background:transparent;color:#bbb;
                         border:1px solid #555; border-radius:3px;
                         padding:0.15rem 0.5rem; cursor:pointer;
                         font-family:inherit; font-size:inherit">Clear</button>
        </div>
        <div id="sm-browse-results-host" style="margin-top:0.4rem"></div>
        <div id="sm-browse-info"
             style="display:none; margin-top:0.4rem; padding:0.4rem 0.6rem;
                    background:rgba(0,0,0,0.25); border-radius:4px;
                    font-size:0.85em; line-height:1.45;"></div>
      </details>
    `;
    // Insert before the slot list so the browse panel doesn't get
    // visually crowded by the slot grid below.
    host.parentElement.insertBefore(wrap, host);

    const chakraSel = wrap.querySelector('#sm-browse-chakra');
    const classSel  = wrap.querySelector('#sm-browse-class');
    const nameInput = wrap.querySelector('#sm-browse-name');
    const clearBtn  = wrap.querySelector('#sm-browse-clear');
    const resultsHost = wrap.querySelector('#sm-browse-results-host');
    const infoPanel = wrap.querySelector('#sm-browse-info');
    const countEl   = wrap.querySelector('#sm-browse-count');

    function getMatching() {
      const chakraFilter = chakraSel.value.toLowerCase();
      const classFilter = classSel.value.toLowerCase();
      const nameFilter = nameInput.value.trim().toLowerCase();
      const matches = [];
      for (const sm of soulmeldIndex.values()) {
        if (chakraFilter && !parseChakras(sm.chakra).includes(chakraFilter)) {
          continue;
        }
        if (classFilter) {
          const cs = String(sm.classes_csv || '').toLowerCase();
          if (!cs.includes(classFilter)) continue;
        }
        // Whitespace-separated terms, ALL of which must appear somewhere in
        // the soulmeld's text (name / chakra / classes / descriptors / save /
        // full description). AND-of-substrings, so "disease bind" narrows
        // rather than widens.
        if (nameFilter) {
          const hay = sm.searchBlob || sm.name.toLowerCase();
          if (!nameFilter.split(/\s+/).filter(Boolean)
                .every(t => hay.includes(t))) continue;
        }
        matches.push(sm);
      }
      matches.sort((a, b) => a.name.localeCompare(b.name));
      return matches;
    }

    const results = (typeof PickerResults !== 'undefined')
      ? PickerResults.attach(resultsHost, {
          itemNoun: 'soulmeld',
          onPick: (name) => {
            const sm = soulmeldIndex.get(name.toLowerCase());
            if (sm) showInfo(sm);
          },
        })
      : null;

    function refresh() {
      const matches = getMatching();
      countEl.textContent = matches.length
        ? `(${matches.length} match${matches.length === 1 ? '' : 'es'})`
        : '';
      if (results) results.render(matches.map(s => s.name));
    }
    browseRefresh = refresh;

    // Inline info panel — shows base / essentia / bind effects per
    // chakra + a "→ Add to slot" button per chakra. Slot routing
    // reuses the existing fillFromSoulmeld() flow by setting the
    // target input's value and dispatching an `input` event (which
    // the delegated handler picks up).
    function showInfo(sm) {
      const bits = [];
      bits.push(
        `<div style="font-weight:600; font-size:1em; color:#cee">` +
        `${escapeHtml(sm.name)} ` +
        `<span style="color:#888; font-weight:400; font-size:0.85em;">` +
        `(chakra: ${escapeHtml(sm.chakra || '?')})</span></div>`);
      if (sm.classes_csv) {
        bits.push(`<div><b>Classes:</b> ${escapeHtml(sm.classes_csv)}</div>`);
      }
      if (sm.descriptors) {
        bits.push(`<div><b>Descriptors:</b> ${escapeHtml(sm.descriptors)}</div>`);
      }
      if (sm.saving_throw) {
        bits.push(`<div><b>Save:</b> ${escapeHtml(sm.saving_throw)}</div>`);
      }
      if (sm.baseEffect) {
        bits.push(`<div style="margin-top:0.25rem"><b>Base:</b> ` +
                  `${escapeHtml(sm.baseEffect)}</div>`);
      }
      if (sm.essentiaScaling) {
        bits.push(`<div><b>Essentia:</b> ${escapeHtml(sm.essentiaScaling)}</div>`);
      }
      if (Array.isArray(sm.bindEffects) && sm.bindEffects.length) {
        for (const b of sm.bindEffects) {
          bits.push(`<div><b>Chakra Bind (${escapeHtml(b.chakra || '?')}):</b> ` +
                    `${escapeHtml(b.description)}</div>`);
        }
      }
      bits.push(`<div style="opacity:0.65; margin-top:0.3rem">` +
                `<i>${escapeHtml(sm.source || '')}</i></div>`);
      // Add-to-slot buttons — one per chakra the soulmeld supports.
      // Each button fills the first compatible empty slot input.
      const chakras = parseChakras(sm.chakra);
      const slotIds = new Set();
      for (const c of chakras) {
        for (const [slotId, validChakras] of Object.entries(SLOT_TO_CHAKRAS)) {
          if (validChakras.some(v => v.toLowerCase() === c)) {
            slotIds.add(slotId);
          }
        }
      }
      if (slotIds.size) {
        const btnsHtml = [...slotIds].map(slotId =>
          `<button type="button" class="sm-browse-add"
                   data-slot-id="${escapeAttr(slotId)}"
                   data-sm-name="${escapeAttr(sm.name)}"
                   style="background:rgba(140,180,220,0.15);
                          border:1px solid rgba(140,180,220,0.4);
                          color:#bcd; border-radius:3px;
                          padding:0.15rem 0.5rem; margin:0.1rem;
                          cursor:pointer; font-family:inherit;
                          font-size:0.82em;">→ ${escapeHtml(slotId)}</button>`
        ).join('');
        bits.push(`<div style="margin-top:0.4rem">` +
                  `<span style="opacity:0.7">Add to first empty slot:</span> ` +
                  `${btnsHtml}</div>`);
      }
      infoPanel.innerHTML = bits.join('');
      infoPanel.style.display = '';
    }

    // Delegated click for the add-to-slot buttons.
    infoPanel.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.sm-browse-add');
      if (!btn) return;
      const targetSlotId = btn.dataset.slotId;
      const smName = btn.dataset.smName;
      const filledIn = fillFirstEmptySlot(targetSlotId, smName);
      if (filledIn) {
        btn.textContent = `✓ filled ${targetSlotId}`;
        btn.disabled = true;
        btn.style.opacity = '0.6';
      } else {
        btn.textContent = `(no empty ${targetSlotId} slot)`;
        btn.disabled = true;
        btn.style.opacity = '0.6';
      }
    });

    // ---- Class filter: default to the character's own meldshaper class ----
    //
    // Opening the browser on "All" means scrolling past Totemist melds when
    // you're playing an Incarnate. Pick the character's class when it's
    // unambiguous, and remember an explicit choice thereafter — an explicit
    // pick always outranks the guess, including a deliberate "All".
    const LS_KEY = 'dnd35-soulmeld-class-filter';

    function characterMeldshaperClass() {
      if (!(window.ClassPicker && typeof ClassPicker.getState === 'function')) return '';
      const picked = ClassPicker.getState()
        .concat(typeof ClassPicker.getStateB === 'function' ? ClassPicker.getStateB() : []);
      const hits = [];
      for (const c of picked) {
        const match = SOULMELD_CLASSES.find(
          sc => sc.toLowerCase() === String(c.className || '').toLowerCase());
        if (match && !hits.includes(match)) hits.push(match);
      }
      // Only auto-pick when there's exactly one — a Totemist/Incarnate
      // multiclass has no single right answer, so leave it on All.
      return hits.length === 1 ? hits[0] : '';
    }

    function applyDefaultClassFilter() {
      let stored = null;
      try { stored = localStorage.getItem(LS_KEY); } catch (e) { /* private mode */ }
      if (stored !== null) {
        // '' is a legitimate stored value meaning "the user chose All".
        if (stored === '' || SOULMELD_CLASSES.includes(stored)) {
          classSel.value = stored;
          return;
        }
      }
      classSel.value = characterMeldshaperClass();
    }

    chakraSel.addEventListener('change', refresh);
    classSel.addEventListener('change', () => {
      try { localStorage.setItem(LS_KEY, classSel.value); } catch (e) { /* ignore */ }
      refresh();
    });
    nameInput.addEventListener('input', refresh);
    clearBtn.addEventListener('click', () => {
      chakraSel.value = '';
      nameInput.value = '';
      // Clear returns the class filter to the character-derived default
      // rather than to All, and forgets the remembered pick — otherwise
      // "Clear" would leave the most restrictive filter still applied.
      try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
      classSel.value = characterMeldshaperClass();
      refresh();
      infoPanel.style.display = 'none';
    });

    // Re-derive whenever the browser is OPENED. The panel is injected once at
    // page load, long before a saved character's classes exist, and loading a
    // character doesn't reliably dispatch classes-changed — so deriving only
    // at wire-up left an existing character on "All". Deriving at open time
    // has no dependence on event timing at all: whenever you look at it, it
    // reflects the character as it is right then.
    const details = wrap.querySelector('details');
    if (details) {
      details.addEventListener('toggle', () => {
        if (!details.open) return;
        let stored = null;
        try { stored = localStorage.getItem(LS_KEY); } catch (e) { /* ignore */ }
        if (stored !== null) return;          // an explicit pick always wins
        const derived = characterMeldshaperClass();
        if (derived !== classSel.value) { classSel.value = derived; refresh(); }
      });
    }
    // Belt and braces: still react to a class change while the panel is open.
    document.addEventListener('classes-changed', () => {
      let stored = null;
      try { stored = localStorage.getItem(LS_KEY); } catch (e) { /* ignore */ }
      if (stored !== null) return;
      const derived = characterMeldshaperClass();
      if (derived !== classSel.value) { classSel.value = derived; refresh(); }
    });

    applyDefaultClassFilter();
    refresh();
  }

  // Find the first .slot-sm-name / .slot-sm2-name input belonging to
  // a slot whose data-slot-id matches `targetSlotId` AND whose value
  // is empty. Set its value + dispatch input so the existing
  // delegated handler picks it up and runs the auto-fill flow.
  // Returns true on success, false if no empty matching slot exists
  // (the user has already filled every applicable slot).
  // Tick a gating checkbox and fire its change handler so the block it
  // reveals (soulmeld area / second-soulmeld block) actually becomes
  // visible. No-op if already checked.
  function ensureChecked(checkbox) {
    if (checkbox && !checkbox.checked) {
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function fillFirstEmptySlot(targetSlotId, soulmeldName) {
    if (targetSlotId === 'totem') {
      // The totem block lives inside a collapsible <details>; open it so
      // the filled field is visible immediately.
      const totemDetails = document.querySelector('.slot-totem details');
      if (totemDetails) totemDetails.open = true;
      for (const id of ['totem-sm-name', 'totem-sm2-name']) {
        const inp = document.getElementById(id);
        if (inp && !inp.value.trim()) {
          // The second soulmeld lives in a Double-Chakra-gated block.
          if (id === 'totem-sm2-name') {
            ensureChecked(document.getElementById('totem-sm-double'));
          }
          inp.value = soulmeldName;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }
    const slots = document.querySelectorAll(
      `.magic-item-slot[data-slot-id="${targetSlotId}"]`);
    for (const slot of slots) {
      for (const cls of ['.slot-sm-name', '.slot-sm2-name']) {
        const inp = slot.querySelector(cls);
        if (inp && !inp.value.trim()) {
          // Tick the slot's Soulmeld checkbox so the soulmeld area
          // (which hosts this input) becomes visible — otherwise the
          // name lands in a display:none field the user can't see.
          ensureChecked(slot.querySelector('.slot-soulmeld-check'));
          // The second soulmeld lives in a Double-Chakra-gated block.
          if (cls === '.slot-sm2-name') {
            ensureChecked(slot.querySelector('.slot-sm-double'));
          }
          inp.value = soulmeldName;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
    }
    return false;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }

  // NOTE: `parseDescription` lived here until 2026-08-03. It rebuilt
  // base/essentia/bind structure out of one concatenated `description`
  // ("Base: … Essentia: … Chakra Bind (X): …"). The DB now stores that
  // structure directly (canonical_fields.SOULMELD_SHAPE_CANON) and
  // rebuildIndex reads the fields, so the parser is gone rather than
  // left dead — a retired helper with a confident comment is how the
  // effectiveInvocationLevel bug hid for weeks (2026-07-31).


  // Decompose a soulmeld's `chakra` string into a list of normalized
  // chakra tokens. Handles all the shapes the data uses:
  //   "Throat"                              → ["throat"]
  //   "Throat (totem)"                      → ["throat", "totem"]
  //   "Crown or Brow"                       → ["crown", "brow"]
  //   "Brow, crown, or throat"              → ["brow", "crown", "throat"]
  //   "Arms, feet, heart, or shoulders (totem)"
  //                                         → ["arms", "feet", "heart", "shoulders", "totem"]
  //   "Soul or waist"                       → ["soul", "waist"]
  function parseChakras(chakraStr) {
    if (!chakraStr) return [];
    return String(chakraStr)
      .toLowerCase()
      .replace(/[()]/g, ',')   // pull "(totem)" inline
      .replace(/\s+or\s+/g, ',')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }

  // Build one datalist per body slot containing only soulmelds whose
  // chakra is valid for that slot. Plus an `-all` fallback datalist
  // for any inputs that don't sit inside a known slot container.
  // Crucially: NO `opt.label` — labels render as visible suggestions
  // in Firefox and (along with the value) confused users into thinking
  // the picker was offering slot names like "Throat" or "Totem".
  function buildPerSlotDatalists() {
    // Group soulmelds by chakra token.
    const byChakra = new Map();
    for (const sm of soulmeldIndex.values()) {
      for (const c of parseChakras(sm.chakra)) {
        if (!byChakra.has(c)) byChakra.set(c, []);
        byChakra.get(c).push(sm);
      }
    }

    // One datalist per slot.
    for (const [slotId, validChakras] of Object.entries(SLOT_TO_CHAKRAS)) {
      const id = `soulmeld-picker-options-${slotId}`;
      let dl = document.getElementById(id);
      if (!dl) {
        dl = document.createElement('datalist');
        dl.id = id;
        document.body.appendChild(dl);
      }
      dl.innerHTML = '';
      const seen = new Set();
      for (const c of validChakras) {
        for (const sm of (byChakra.get(c.toLowerCase()) || [])) {
          if (seen.has(sm.name)) continue;
          seen.add(sm.name);
          const opt = document.createElement('option');
          opt.value = sm.name;
          dl.appendChild(opt);
        }
      }
    }

    // Fallback "all" datalist — used when an input isn't inside a
    // known slot (defensive; shouldn't happen with current UI).
    let dlAll = document.getElementById('soulmeld-picker-options-all');
    if (!dlAll) {
      dlAll = document.createElement('datalist');
      dlAll.id = 'soulmeld-picker-options-all';
      document.body.appendChild(dlAll);
    }
    dlAll.innerHTML = '';
    for (const sm of soulmeldIndex.values()) {
      const opt = document.createElement('option');
      opt.value = sm.name;
      dlAll.appendChild(opt);
    }
  }

  // Resolve the right datalist id for one input by walking up to its
  // enclosing `.magic-item-slot[data-slot-id]`, or recognizing the
  // totem-block id prefix. Inputs we can't classify get the `-all`
  // fallback.
  function datalistFor(input) {
    if (input.id === 'totem-sm-name' || input.id === 'totem-sm2-name') {
      return 'soulmeld-picker-options-totem';
    }
    const slot = input.closest('.magic-item-slot');
    const slotId = slot?.dataset?.slotId;
    if (slotId && SLOT_TO_CHAKRAS[slotId]) {
      return `soulmeld-picker-options-${slotId}`;
    }
    return 'soulmeld-picker-options-all';
  }

  function syncInputs() {
    const inputs = document.querySelectorAll(
      '.slot-sm-name, .slot-sm2-name, #totem-sm-name, #totem-sm2-name'
    );
    for (const inp of inputs) {
      const want = datalistFor(inp);
      if (inp.getAttribute('list') !== want) {
        inp.setAttribute('list', want);
        inp.setAttribute('autocomplete', 'off');
      }
    }
  }

  function observeNew() {
    const ob = new MutationObserver(() => syncInputs());
    ob.observe(document.body, { childList: true, subtree: true });
  }

  function wireDelegation() {
    const handler = (ev) => {
      const inp = ev.target;
      if (!(inp instanceof HTMLInputElement)) return;
      const isPrimary = inp.classList.contains('slot-sm-name') ||
                        inp.id === 'totem-sm-name';
      const isSecond  = inp.classList.contains('slot-sm2-name') ||
                        inp.id === 'totem-sm2-name';
      if (!isPrimary && !isSecond) return;
      const sm = soulmeldIndex.get(
        String(inp.value || '').trim().toLowerCase());
      if (!sm) return;
      fillFromSoulmeld(inp, sm, isSecond);
    };
    document.addEventListener('input', handler);
    document.addEventListener('change', handler);
  }

  function fillFromSoulmeld(input, sm, isSecond) {
    const slot = input.closest('.magic-item-slot');
    let baseEl, bindEl, slotId;
    // TOTEM FIRST. The totem block is itself `.magic-item-slot slot-totem`,
    // so the generic branch below used to swallow it — and its effect fields
    // are addressed by ID (#totem-sm-base), not by the `.slot-sm-base` class
    // the body slots use, so the lookup returned null and nothing ever
    // filled. The ⓘ panel then rendered "No effect details yet" forever,
    // which is what got reported (rms3t1tz7-7818): the totem branch was
    // unreachable dead code. It also has no data-slot-id, so slotId came out
    // null and pickBindForSlot couldn't find the Totem-chakra bind either.
    if (input.id === 'totem-sm-name' || input.id === 'totem-sm2-name') {
      const p = isSecond ? 'totem-sm2' : 'totem-sm';
      baseEl = document.getElementById(`${p}-base`);
      bindEl = document.getElementById(`${p}-bind-effect`);
      slotId = 'totem';
    } else if (slot) {
      slotId = slot.dataset.slotId || null;
      if (isSecond) {
        baseEl = slot.querySelector('.slot-sm2-base');
        bindEl = slot.querySelector('.slot-sm2-bind-effect');
      } else {
        baseEl = slot.querySelector('.slot-sm-base');
        bindEl = slot.querySelector('.slot-sm-bind-effect');
      }
    }

    // Base effect text: combine Base + Essentia so both show up.
    const baseText = sm.essentiaScaling
      ? `${sm.baseEffect} (Essentia: ${sm.essentiaScaling})`
      : sm.baseEffect;
    if (baseEl && !baseEl.value.trim() && baseText) {
      baseEl.value = baseText;
      baseEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Bind effect: pick the bind for this slot's chakra; fall back to
    // first non-Totem (or Totem for totem inputs).
    const chosen = pickBindForSlot(sm.bindEffects, slotId);
    if (bindEl && !bindEl.value.trim() && chosen) {
      const prefix = chosen.chakra ? `(${chosen.chakra}) ` : '';
      bindEl.value = `${prefix}${chosen.description}`;
      bindEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Light hint: if the picked soulmeld's chakra doesn't match the
    // slot, flash a non-blocking warning in the bind textarea
    // placeholder so the user notices the mismatch.
    maybeFlashChakraMismatch(slot || null, sm, slotId);
  }

  function pickBindForSlot(binds, slotId) {
    if (!Array.isArray(binds) || !binds.length) return null;
    const wantList = (SLOT_TO_CHAKRAS[slotId] || []).map(s => s.toLowerCase());
    // Exact chakra match first.
    for (const want of wantList) {
      const hit = binds.find(b => (b.chakra || '').toLowerCase() === want);
      if (hit) return hit;
    }
    // Partial-substring match (e.g. "Feet (totem)" matches "feet").
    for (const want of wantList) {
      const hit = binds.find(b =>
        (b.chakra || '').toLowerCase().includes(want));
      if (hit) return hit;
    }
    if (slotId === 'totem') {
      return binds.find(b => /totem/i.test(b.chakra || '')) || binds[0];
    }
    return binds.find(b => !/totem/i.test(b.chakra || '')) || binds[0];
  }

  function maybeFlashChakraMismatch(slot, sm, slotId) {
    if (!slot || !sm.chakra) return;
    const wantList = SLOT_TO_CHAKRAS[slotId] || [];
    if (!wantList.length) return;
    const chakras = String(sm.chakra)
      .toLowerCase()
      .split(/\s*,\s*|\s+or\s+/);
    const ok = chakras.some(c =>
      wantList.some(w => c.includes(w.toLowerCase())));
    if (ok) return;
    // Mismatch — surface a hint as a one-time tooltip on the slot header.
    const header = slot.querySelector('.slot-header');
    if (!header) return;
    let hint = header.querySelector('.sm-mismatch-hint');
    if (!hint) {
      hint = document.createElement('span');
      hint.className = 'sm-mismatch-hint';
      hint.style.cssText =
        'margin-left:0.5rem; font-size:0.8em; color:#c88; ' +
        'font-style:italic;';
      header.appendChild(hint);
    }
    hint.textContent = `(soulmeld chakra: ${sm.chakra})`;
  }

  // Exposed for soulmeld-effects.js, which needs the slot↔chakra map to tell
  // whether a `when: 'bound'` effect row belongs to the chakra this slot
  // actually is — 55 of the 94 soulmelds bind to more than one, with a
  // different effect in each. Shared rather than copied: a second copy of this
  // map is a second thing to keep true.
  window.SoulmeldPicker = Object.assign(window.SoulmeldPicker || {}, {
    SLOT_TO_CHAKRAS,
  });

  DB.ready.then((db) => { if (db) init(); });
})();
