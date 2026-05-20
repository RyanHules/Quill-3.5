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
// On exact match, parse the soulmeld's description into Base / Chakra
// Bind portions and auto-fill `.slot-sm-base` / `.slot-sm-bind-effect`.
// MutationObserver re-syncs `list=` when new inputs appear.

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
    body:      ['Heart'],
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
      + "json_extract(data, '$.description')  AS description "
      + "FROM entry WHERE type = 'soulmeld' "
      + "ORDER BY name COLLATE NOCASE"
    );
    soulmeldIndex.clear();
    for (const r of rows) {
      if (window.BookFilter && !window.BookFilter.allowsEntry({...r, type: 'soulmeld'})) continue;
      const key = (r.name || '').toLowerCase();
      if (soulmeldIndex.has(key)) continue;
      const parsed = parseDescription(r.description || '');
      soulmeldIndex.set(key, {
        name: r.name,
        source: r.source,
        version: r.version,
        chakra: r.chakra,
        classes_csv: r.classes_csv,
        descriptors: r.descriptors,
        saving_throw: r.saving_throw,
        description: r.description,
        baseEffect: parsed.base,
        essentiaScaling: parsed.essentia,
        bindEffects: parsed.binds,   // [{chakra, text}, ...]
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

    document.addEventListener('book-filter-changed', () => {
      rebuildIndex();
      // Rebuild every per-slot datalist + the fallback `-all`.
      buildPerSlotDatalists();
    });
  }

  // Parse a soulmeld description of the form
  //   "Base: <text>. Essentia: <text>."
  //   "Chakra Bind (<chakra>): <text>."
  //   [optionally more Chakra Bind lines]
  // by locating each header keyword and slicing between them.
  function parseDescription(text) {
    const out = { base: '', essentia: '', binds: [] };
    if (!text) return out;
    const headerRx =
      /(Base|Essentia|Chakra Bind\s*\(([^)]+)\))\s*:\s*/g;
    const matches = [];
    let m;
    while ((m = headerRx.exec(text)) !== null) {
      matches.push({
        kind: m[1].startsWith('Chakra Bind') ? 'bind' : m[1].toLowerCase(),
        chakra: m[2] ? m[2].trim() : null,
        headerStart: m.index,
        bodyStart: m.index + m[0].length,
      });
    }
    for (let i = 0; i < matches.length; i++) {
      const cur = matches[i];
      const end = i + 1 < matches.length
        ? matches[i + 1].headerStart : text.length;
      const body = text.slice(cur.bodyStart, end)
        .trim()
        .replace(/^[.\s]+|[.\s]+$/g, '')
        .trim();
      if (cur.kind === 'base') out.base = body;
      else if (cur.kind === 'essentia') out.essentia = body;
      else if (cur.kind === 'bind') out.binds.push({
        chakra: cur.chakra,
        text: body,
      });
    }
    return out;
  }

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
    if (slot) {
      slotId = slot.dataset.slotId || null;
      if (isSecond) {
        baseEl = slot.querySelector('.slot-sm2-base');
        bindEl = slot.querySelector('.slot-sm2-bind-effect');
      } else {
        baseEl = slot.querySelector('.slot-sm-base');
        bindEl = slot.querySelector('.slot-sm-bind-effect');
      }
    } else if (input.id === 'totem-sm-name') {
      baseEl = document.getElementById('totem-sm-base');
      bindEl = document.getElementById('totem-sm-bind-effect');
      slotId = 'totem';
    } else if (input.id === 'totem-sm2-name') {
      baseEl = document.getElementById('totem-sm2-base');
      bindEl = document.getElementById('totem-sm2-bind-effect');
      slotId = 'totem';
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
      bindEl.value = `${prefix}${chosen.text}`;
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

  DB.ready.then((db) => { if (db) init(); });
})();
