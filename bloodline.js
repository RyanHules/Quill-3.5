// bloodline.js — UA Bloodlines subsystem support (Unearthed Arcana
// p.10-14) exposed as the global `Bloodline` object.
//
// A bloodline represents a non-human ancestor in a character's
// lineage (elemental, celestial, fey, dragon, etc.). The character
// picks ONE bloodline + ONE strength (minor / intermediate / major);
// each strength is a per-character-level trait progression. This
// module lives in the Class Features tab and does three things:
//
//   1. **Tracker / reference.** Pick a bloodline + strength, see the
//      full per-level trait list with the rows at or below the
//      character's level highlighted as active. Track the bloodline-
//      level slot thresholds (e.g. major = L3/L6/L12) and whether
//      each has been slotted — UA imposes a 20% XP penalty for a
//      missed slot (surfaced as an informational note; not applied).
//
//   2. **Auto ability bumps.** Many bloodline traits are permanent
//      ability-score increases (Fireclaw: CHA at L3, DEX at L6, CON
//      at L8). Those — and ONLY those — are auto-applied: each trait
//      carries a structured `ability` payload, and `getActiveBonuses`
//      sums the bumps for every trait at or below the current level,
//      feeding the shared bonus layer in app.js's collectActiveBonuses
//      (→ score → modifier → all downstream calcs). The other trait
//      types (energy resistance, bonus feats, SLAs, subtype changes)
//      are GM-adjudicated and stay reference-only by design.
//
//   3. **Catalog.** The bloodline list is DB-driven (`entry WHERE
//      type='bloodline'`), filtered through BookFilter.allowsEntry
//      (which also gates HomebrewFilter), so homebrew bloodlines like
//      Fireclaw only appear once Diamond Soul homebrew is enabled.
//      Degrades to a plain text input when the DB isn't loaded.
//
// Save shape (per-character, omitted/null when unset):
//   _bloodline: { name, source, strength, slotsPaid: [bool,...], notes }
// Resolved by name+source (never DB id — ids renumber on rebuild;
// CLAUDE.md save-stability rule #7). The saved selection is the
// authoritative state; the trait data is re-resolved from the DB on
// DB.ready and on every filter change (save-stability rule #4).

const Bloodline = (function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  // Persisted selection — the authoritative state. The DB-resolved
  // trait data lives in `resolved`, rebuilt whenever the DB or the
  // selection changes.
  let state = { name: '', source: '', strength: '', slotsPaid: [], notes: '' };

  // name|source (lowercased) → { id, name, source, version } stub.
  const catalog = new Map();
  // The currently-resolved entry's parsed `data` JSON (or null).
  let resolved = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getCharLevel() {
    return parseInt($('#char-level')?.value, 10) || 0;
  }

  // ------------------------------------------------------------------
  // DB catalog
  // ------------------------------------------------------------------

  function buildCatalog() {
    catalog.clear();
    const datalist = $('#bloodline-options');
    if (datalist) datalist.innerHTML = '';
    if (typeof DB === 'undefined' || !DB.isLoaded || !DB.isLoaded()) return;

    let rows = [];
    try {
      rows = DB.query(
        "SELECT e.id AS bl_id, e.name, e.version, e.source, "
        + "       b.publication_date "
        + "FROM entry e "
        + "LEFT JOIN book b ON b.name = e.source "
        + "WHERE e.type = 'bloodline' "
        + "ORDER BY e.name COLLATE NOCASE, "
        + "         CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, "
        + "         b.publication_date DESC");
    } catch (err) {
      console.warn('[bloodline] catalog query failed:', err);
      return;
    }

    let kept = 0;
    for (const r of rows) {
      // BookFilter.allowsEntry also delegates to HomebrewFilter, so a
      // single gate covers both the campaign-scope filter and the
      // per-entry homebrew toggle.
      if (window.BookFilter
          && !window.BookFilter.allowsEntry({ ...r, type: 'bloodline' })) {
        continue;
      }
      const key = (r.name + '|' + (r.source || '')).toLowerCase();
      if (catalog.has(key)) continue;
      catalog.set(key, {
        id: r.bl_id, name: r.name, source: r.source, version: r.version,
      });
      if (datalist) {
        const opt = document.createElement('option');
        opt.value = r.name;  // no opt.label (Firefox datalist note)
        datalist.appendChild(opt);
      }
      kept++;
    }
    console.log(`[bloodline] ${kept}/${rows.length} bloodlines available`);
  }

  // Resolve the current `state` selection against the DB catalog and
  // parse its `data` JSON into `resolved`. Match by name first
  // (case-insensitive); prefer an exact name+source hit when the save
  // carried a source, else fall back to any same-name entry.
  function resolveSelection() {
    resolved = null;
    if (!state.name) return;
    if (typeof DB === 'undefined' || !DB.isLoaded || !DB.isLoaded()) return;

    const wantName = state.name.trim().toLowerCase();
    let stub = state.source
      ? catalog.get((state.name + '|' + state.source).toLowerCase())
      : null;
    if (!stub) {
      for (const s of catalog.values()) {
        if (s.name.toLowerCase() === wantName) { stub = s; break; }
      }
    }
    if (!stub) return;
    // Keep the canonical source so saves resolve unambiguously later.
    state.source = stub.source || state.source;
    const row = DB.queryOne(
      "SELECT name, source, version, data FROM entry WHERE id = ?",
      [stub.id]);
    if (!row) return;
    try {
      resolved = { id: stub.id, ...JSON.parse(row.data || '{}'),
                   _source: row.source, _version: row.version };
    } catch (e) {
      resolved = null;
    }
  }

  // ------------------------------------------------------------------
  // Strength + slot helpers
  // ------------------------------------------------------------------

  function strengthKeys() {
    if (!resolved || !resolved.strengths) return [];
    return Object.keys(resolved.strengths);
  }

  function currentStrength() {
    const keys = strengthKeys();
    if (!keys.length) return null;
    if (state.strength && keys.includes(state.strength)) {
      return resolved.strengths[state.strength];
    }
    // Default to the saved strength if valid, else the first column.
    state.strength = keys.includes(state.strength) ? state.strength : keys[0];
    return resolved.strengths[state.strength];
  }

  function activeTraits() {
    const s = currentStrength();
    if (!s || !Array.isArray(s.traits)) return [];
    const lvl = getCharLevel();
    return s.traits.filter(t => (t.level || 0) <= lvl);
  }

  // Reset slotsPaid length to match the selected strength's threshold
  // count, preserving existing paid flags positionally.
  function syncSlots() {
    const s = currentStrength();
    // When the strength can't be resolved yet — e.g. a saved character is
    // loaded BEFORE DB.ready has built the bloodline catalog — do NOT
    // clobber state.slotsPaid. Wiping it here loses the saved bloodline-
    // level checkboxes for good, because the DB.ready handler re-renders
    // from `state` and there's nothing left to restore (save-stability
    // rule #4). Leave the saved flags intact; render() re-syncs them once
    // the entry resolves and req has a real length.
    if (!s || !Array.isArray(s.bloodline_levels_required)) return;
    const req = s.bloodline_levels_required;
    state.slotsPaid = req.map((_, i) => !!state.slotsPaid[i]);
  }

  // ------------------------------------------------------------------
  // Auto ability bumps — the only mechanical effect this module
  // applies. Summed across every active trait's `ability` payload.
  // ------------------------------------------------------------------

  function getActiveBonuses() {
    const bonuses = { abilities: {} };
    for (const t of activeTraits()) {
      const ab = t.ability;
      if (!ab || typeof ab !== 'object') continue;
      for (const [k, v] of Object.entries(ab)) {
        const key = String(k).toUpperCase();
        const n = parseInt(v, 10) || 0;
        if (n) bonuses.abilities[key] = (bonuses.abilities[key] || 0) + n;
      }
    }
    return bonuses;
  }

  // The 5 social skills a bloodline-affinity bonus applies to (UA: "all
  // Bluff, Diplomacy, Gather Information, Intimidate, and Perform checks").
  const AFFINITY_SKILLS = ['Bluff', 'Diplomacy', 'Gather Information',
                           'Intimidate', 'Perform'];

  // Skill bonuses granted by active traits, for skills.js to apply. TWO
  // kinds, surfaced separately because they behave differently:
  //   - direct: an unconditional "+N on <Skill> checks" — folds into the
  //     skill's TOTAL (keyed by skill name, lower-cased; "Perform" matches
  //     every Perform subtype via the base name on the skills side).
  //   - affinity: the situational "<X> affinity +2/+4/+6" — applies ONLY
  //     to the 5 social skills vs creatures of the bloodline, so it is a
  //     NOTE, never added to the total. Affinity REPLACES (it scales
  //     2→4→6), so we take the max active value, not a sum.
  // The trait NAME is parsed (not a structured field) because trait_type
  // already disambiguates Skill vs Affinity vs Ex, and the published UA
  // names are perfectly regular ("+2 on Sense Motive checks", "Celestial
  // affinity +4"). A malformed name simply contributes nothing.
  function getActiveSkillBonuses() {
    const direct = {};
    let affinityValue = 0;
    let affinityVs = '';
    for (const t of activeTraits()) {
      if (t.trait_type === 'Skill') {
        const m = /^\+(\d+)\s+on\s+(.+?)\s+checks$/i.exec(t.name || '');
        if (m) {
          const n = parseInt(m[1], 10) || 0;
          const key = m[2].trim().toLowerCase();
          if (n) direct[key] = (direct[key] || 0) + n;
        }
      } else if (t.trait_type === 'Affinity') {
        const m = /affinity\s+\+(\d+)/i.exec(t.name || '');
        if (m) {
          const n = parseInt(m[1], 10) || 0;
          if (n > affinityValue) affinityValue = n;
          if (!affinityVs && t.description) {
            const dm = /interact with\s+([^.]+)\.?/i.exec(t.description);
            if (dm) affinityVs = dm[1].trim();
          }
        }
      }
    }
    return {
      direct,
      affinity: affinityValue
        ? { value: affinityValue,
            vs: affinityVs || `creatures of your ${state.name} bloodline`,
            skills: AFFINITY_SKILLS.slice() }
        : null,
    };
  }

  // Auto-inject the bonus feats granted by active traits into the Feats
  // tab as marked rows (`data-from-bloodline`). Reconciling + idempotent:
  // rebuilds only when the active set actually changes, so slot toggles
  // and repeat calls don't thrash the user's feat rows. These rows are
  // DERIVED, not persisted — Feats.collectData skips data-from-bloodline
  // rows, so they re-derive on load rather than round-tripping as user
  // feats (same model as the ability bumps). The "substitute if already
  // taken" clause is a GM call, so the granted feat's text carries a
  // note rather than auto-resolving.
  function syncBonusFeats() {
    const container = document.getElementById('feats-container');
    if (!container || typeof Feats === 'undefined'
        || typeof Feats.addFeat !== 'function') return;
    const wanted = [];
    if (state.name) {
      for (const t of activeTraits()) {
        if (Array.isArray(t.bonus_feats)) {
          for (const f of t.bonus_feats) {
            wanted.push({ feat: String(f), level: t.level });
          }
        }
      }
    }
    const existing = [...container.querySelectorAll(
      '.feat-row[data-from-bloodline="1"]')];
    const existingKeys = existing.map(r => r.dataset.blFeatKey || '');
    const wantedKeys = wanted.map(w => `${w.feat}|${w.level}`);
    const inSync = existingKeys.length === wantedKeys.length
      && existingKeys.every((k, i) => k === wantedKeys[i]);
    if (inSync) return;
    existing.forEach(r => r.remove());
    for (const w of wanted) {
      Feats.addFeat(`${w.feat} (${state.name} bloodline — L${w.level})`);
      const rows = container.querySelectorAll('.feat-row');
      const row = rows[rows.length - 1];
      if (!row) continue;
      row.dataset.fromBloodline = '1';
      row.dataset.blFeatKey = `${w.feat}|${w.level}`;
      row.classList.add('feat-from-bloodline');
      const ta = row.querySelector('.feat-entry');
      if (ta) ta.dataset.fromBloodline = '1';
    }
  }

  // Label for the Class & Level box, appended by class-picker:
  // "<Name> Bloodline <N>" where N = bloodline-level slots taken (the
  // paid checkboxes in the tracker). Empty until at least one slot is
  // taken — UA bloodline levels are real class levels, so the count
  // tracks how many you've actually spent.
  function getClassLevelLabel() {
    if (!state.name) return '';
    const n = state.slotsPaid.filter(Boolean).length;
    if (n < 1) return '';
    return `${state.name} Bloodline ${n}`;
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  function render() {
    const section = $('#bloodline-section');
    if (!section) return;
    const empty = $('#bloodline-empty');
    const header = $('#bloodline-header');
    const strengthRow = $('#bloodline-strength-row');
    const strengthSel = $('#bloodline-strength');
    const thresholds = $('#bloodline-thresholds');
    const progression = $('#bloodline-progression');

    const hasSelection = !!state.name;
    const hasData = !!(resolved && resolved.strengths);

    if (empty) empty.style.display = hasSelection ? 'none' : 'block';

    // --- Strength selector (populated from the resolved entry) ---
    if (strengthSel) {
      const keys = strengthKeys();
      strengthRow.style.display = keys.length > 1 ? '' : 'none';
      const sCur = currentStrength();  // also normalizes state.strength
      strengthSel.innerHTML = '';
      for (const k of keys) {
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = k.charAt(0).toUpperCase() + k.slice(1);
        if (k === state.strength) opt.selected = true;
        strengthSel.appendChild(opt);
      }
      void sCur;
    }

    // --- Picker summary (the Character-tab Bloodline Lookup) ---
    // A one-line "what's selected + where the detail lives" note, so the
    // picker (Character tab) and the panel (Feats & Abilities tab) stay
    // legible despite living on different tabs.
    const pickSummary = $('#bloodline-pick-summary');
    if (pickSummary) {
      if (!hasSelection) {
        pickSummary.style.display = 'none';
        pickSummary.innerHTML = '';
      } else {
        pickSummary.style.display = 'block';
        const strengthLabel = state.strength
          ? state.strength.charAt(0).toUpperCase() + state.strength.slice(1)
          : '';
        pickSummary.innerHTML =
          `<b>${escapeHtml(state.name)}</b>`
          + (strengthLabel ? ` — ${escapeHtml(strengthLabel)}` : '')
          + ` <span style="opacity:.7">· full traits + slot tracker on the `
          + `<b>Feats &amp; Abilities</b> tab</span>`;
      }
    }

    // --- Header (origin + description + badges) ---
    if (header) {
      if (!hasSelection) {
        header.innerHTML = '';
        header.style.display = 'none';
      } else if (!hasData) {
        // Selected but DB hasn't resolved it (not loaded, or homebrew
        // toggle off / book filtered out). Show a graceful note.
        header.style.display = 'block';
        header.innerHTML =
          `<b>${escapeHtml(state.name)}</b>`
          + `<div style="margin-top:0.3rem;color:#c8a14a;font-style:italic">`
          + `Bloodline details unavailable — the DB isn't loaded, or this `
          + `bloodline's source is hidden by the 📚 / 🏠 filters. The `
          + `selection is saved and ability bonuses re-apply once it's `
          + `visible.</div>`;
      } else {
        header.style.display = 'block';
        const bits = [];
        bits.push(`<b>${escapeHtml(resolved.name || state.name)}</b>`
          + (resolved._source
              ? ` <span style="opacity:.6">(${escapeHtml(resolved._source)})</span>`
              : ''));
        if (resolved.bloodline_origin) {
          bits.push(`<b>Origin:</b> ${escapeHtml(resolved.bloodline_origin)}`);
        }
        if (resolved.summary) {
          bits.push(`<div style="margin-top:0.3rem;line-height:1.4">`
            + escapeHtml(resolved.summary) + `</div>`);
        }
        header.innerHTML = bits.join('<br>');
        if (window.ErrataBadge && resolved.id) {
          ErrataBadge.attach(header, resolved.id);
        }
        if (window.VersionBadge) {
          VersionBadge.attach(header, resolved._version || resolved.version);
        }
      }
    }

    // --- Slot-threshold tracker ---
    if (thresholds) {
      const s = currentStrength();
      const req = (s && Array.isArray(s.bloodline_levels_required))
        ? s.bloodline_levels_required : [];
      if (!hasData || !req.length) {
        thresholds.innerHTML = '';
        thresholds.style.display = 'none';
      } else {
        syncSlots();
        const lvl = getCharLevel();
        const rows = req.map((th, i) => {
          const paid = !!state.slotsPaid[i];
          const due = lvl >= th && !paid;
          let status, color;
          if (paid) { status = 'slotted'; color = '#5fbf6f'; }
          else if (due) { status = '⚠ due — 20% XP penalty'; color = '#d9534f'; }
          else { status = 'not yet due'; color = '#888'; }
          return `<label class="bloodline-slot" style="display:flex;`
            + `align-items:center;gap:0.4rem;padding:0.15rem 0">`
            + `<input type="checkbox" class="bloodline-slot-paid" `
            + `data-slot="${i}"${paid ? ' checked' : ''}> `
            + `<span>Bloodline ${i + 1} <span style="opacity:.7">`
            + `(due by L${th})</span></span> `
            + `<span style="margin-left:auto;color:${color};font-size:0.9em">`
            + `${status}</span></label>`;
        }).join('');
        thresholds.innerHTML =
          `<div style="font-weight:600;margin:0.4rem 0 0.2rem">`
          + `Bloodline levels <span style="font-weight:400;opacity:.7;`
          + `font-size:0.85em">— a “bloodline” class level must be slotted `
          + `by each character level or take a 20% XP penalty (UA RAW)`
          + `</span></div>` + rows;
        thresholds.style.display = 'block';
      }
    }

    // --- Per-level trait progression ---
    if (progression) {
      const s = currentStrength();
      const traits = (s && Array.isArray(s.traits)) ? s.traits : [];
      if (!hasData || !traits.length) {
        progression.innerHTML = '';
        progression.style.display = hasSelection && hasData ? 'block' : 'none';
        if (hasSelection && hasData) {
          progression.innerHTML =
            `<div style="opacity:.7;font-style:italic">No traits listed for `
            + `this strength.</div>`;
        }
      } else {
        const lvl = getCharLevel();
        progression.style.display = 'block';
        progression.innerHTML =
          `<div style="font-weight:600;margin:0.5rem 0 0.2rem">`
          + `Trait progression`
          + (state.strength
              ? ` <span style="opacity:.7;font-weight:400;font-size:0.85em">`
                + `(${escapeHtml(state.strength)})</span>` : '')
          + `</div>`
          + traits.map(t => renderTraitRow(t, lvl)).join('');
      }
    }
  }

  function renderTraitRow(t, charLvl) {
    const active = (t.level || 0) <= charLvl;
    const bumpChip = (t.ability && typeof t.ability === 'object')
      ? Object.entries(t.ability).map(([k, v]) =>
          `<span class="bloodline-bump-chip">`
          + `${v > 0 ? '+' : ''}${escapeHtml(v)} ${escapeHtml(String(k).toUpperCase())}`
          + `</span>`).join(' ')
      : '';
    return `<div class="bloodline-trait${active ? ' bloodline-trait-active' : ''}">`
      + `<span class="bloodline-trait-lvl">L${escapeHtml(t.level)}</span>`
      + `<div class="bloodline-trait-body">`
      + `<div class="bloodline-trait-head">`
      + `<b>${escapeHtml(t.name || '')}</b>`
      + (t.trait_type
          ? ` <span class="bloodline-trait-type">(${escapeHtml(t.trait_type)})</span>`
          : '')
      + (bumpChip ? ' ' + bumpChip : '')
      + (active ? '' : ` <span class="bloodline-trait-pending">— at L${escapeHtml(t.level)}</span>`)
      + `</div>`
      + (t.description
          ? `<div class="bloodline-trait-desc">${escapeHtml(t.description)}</div>`
          : '')
      + `</div></div>`;
  }

  // ------------------------------------------------------------------
  // Change handling
  // ------------------------------------------------------------------

  // Re-resolve + re-render + fire recalc (ability bumps may have
  // shifted). `reresolve` is false for pure-level / threshold changes
  // where the selected entry hasn't changed.
  function refresh(reresolve) {
    if (reresolve) resolveSelection();
    syncSlots();
    render();
    syncBonusFeats();
    document.dispatchEvent(new CustomEvent('bloodline-changed'));
  }

  function wire() {
    const nameInput = $('#bloodline-name');
    const strengthSel = $('#bloodline-strength');
    const thresholds = $('#bloodline-thresholds');

    if (nameInput) {
      const onName = () => {
        const v = nameInput.value.trim();
        if (v !== state.name) {
          state.name = v;
          state.source = '';     // re-resolve canonical source from catalog
          state.strength = '';   // reset to the entry's first column
          state.slotsPaid = [];
          refresh(true);
        }
      };
      nameInput.addEventListener('change', onName);
      nameInput.addEventListener('input', () => {
        // Only commit when the typed value matches a catalog entry, so
        // mid-typing keystrokes don't thrash. Otherwise treat as cleared.
        const key = nameInput.value.trim().toLowerCase();
        const hit = [...catalog.values()]
          .some(s => s.name.toLowerCase() === key);
        if (hit || !nameInput.value.trim()) onName();
      });
    }

    if (strengthSel) {
      strengthSel.addEventListener('change', () => {
        state.strength = strengthSel.value;
        state.slotsPaid = [];   // thresholds differ per strength
        refresh(false);
      });
    }

    if (thresholds) {
      thresholds.addEventListener('change', (ev) => {
        const cb = ev.target.closest('.bloodline-slot-paid');
        if (!cb) return;
        const i = parseInt(cb.dataset.slot, 10);
        if (!Number.isNaN(i)) {
          state.slotsPaid[i] = cb.checked;
          render();  // status colors
          // Bloodline-level count (slots taken) feeds the Class & Level
          // box, so notify even though bumps/feats are unaffected.
          document.dispatchEvent(new CustomEvent('bloodline-changed'));
        }
      });
    }

    // Character level drives active-trait highlighting, the ability
    // bumps, AND which bonus feats are granted. recalcAll already fires
    // on #char-level input (app.js) so the bumps recompute there; here we
    // re-render the panel + re-sync the injected bonus-feat rows.
    const lvl = $('#char-level');
    if (lvl) {
      const onLvl = () => { render(); syncBonusFeats(); };
      lvl.addEventListener('input', onLvl);
      lvl.addEventListener('change', onLvl);
    }
  }

  // ------------------------------------------------------------------
  // Save / load
  // ------------------------------------------------------------------

  function collectData() {
    if (!state.name) return { _bloodline: null };
    return {
      _bloodline: {
        name: state.name,
        source: state.source || '',
        strength: state.strength || '',
        slotsPaid: state.slotsPaid.slice(),
        notes: state.notes || '',
      },
    };
  }

  function loadData(data) {
    // CLEAR on an absent/null `_bloodline` (a new character or an old
    // pre-bloodline save), restore when present. loadData is always a
    // full-state load, so "leave alone" would desync internal `state`
    // from the input the generic reset loop just cleared — the same
    // bleed-bug class as the ClassFeatures customizations fix
    // (app.js#newCharacter). New Character calls Bloodline.loadData({})
    // explicitly so this path clears the internal state + the panel.
    const bl = data && data._bloodline;
    if (bl && bl.name) {
      state = {
        name: String(bl.name),
        source: bl.source ? String(bl.source) : '',
        strength: bl.strength ? String(bl.strength) : '',
        slotsPaid: Array.isArray(bl.slotsPaid)
          ? bl.slotsPaid.map(Boolean) : [],
        notes: bl.notes ? String(bl.notes) : '',
      };
    } else {
      state = { name: '', source: '', strength: '', slotsPaid: [], notes: '' };
    }
    const nameInput = $('#bloodline-name');
    if (nameInput) nameInput.value = state.name;
    // Re-resolve against the DB if it's ready; otherwise DB.ready will
    // resolve + render once the catalog is built.
    refresh(true);
  }

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------

  function init() {
    wire();
    render();
    // DB-dependent catalog: populate on ready, then resolve the
    // (possibly already-loaded) selection + re-render. Re-run on any
    // filter change so toggling Diamond Soul homebrew on/off surfaces
    // or hides homebrew bloodlines live.
    if (typeof DB !== 'undefined' && DB.ready) {
      DB.ready.then(() => {
        buildCatalog();
        resolveSelection();
        render();
        syncBonusFeats();
        // A bloodline that resolved post-load may carry ability bumps +
        // bonus feats; make sure the sheet recalculates with them.
        document.dispatchEvent(new CustomEvent('bloodline-changed'));
      });
    }
    const onFilter = () => {
      buildCatalog();
      resolveSelection();
      render();
      syncBonusFeats();
      document.dispatchEvent(new CustomEvent('bloodline-changed'));
    };
    document.addEventListener('book-filter-changed', onFilter);
    document.addEventListener('homebrew-filter-changed', onFilter);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return {
    getActiveBonuses,
    getActiveSkillBonuses,
    getClassLevelLabel,
    collectData,
    loadData,
    // Exposed for tests / debugging.
    _getState: () => ({ ...state, slotsPaid: state.slotsPaid.slice() }),
  };
})();

window.Bloodline = Bloodline;
