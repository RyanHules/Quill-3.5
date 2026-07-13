// bloodline.js — UA Bloodlines subsystem support (Unearthed Arcana
// p.8-14) exposed as the global `Bloodline` object.
//
// A bloodline represents a non-human ancestor in a character's lineage
// (elemental, celestial, fey, dragon, etc.). For each bloodline the
// character picks ONE strength (minor / intermediate / major); each
// strength is a per-character-level trait progression.
//
// UA RAW frames a bloodline in the singular but does NOT cap a character
// at one (there's no "only one bloodline" rule), so this module supports
// a STACK of bloodlines (add/remove, mirroring the Template picker), each
// with its OWN strength + bloodline-level slot tracker ("independent
// tracks" — Ryan's call 2026-06-09). The mechanical auto-effects (ability
// bumps, direct skill bonuses, bonus feats) SUM across every applied
// bloodline. This module lives in the Class Features tab and does three
// things:
//
//   1. **Tracker / reference.** For each added bloodline, see the full
//      per-level trait list with the rows at or below the character's
//      level highlighted as active, plus the bloodline-level slot
//      thresholds and whether each has been slotted — UA imposes a 20%
//      XP penalty for a missed slot (informational; not applied).
//
//   2. **Auto ability bumps.** Many bloodline traits are permanent
//      ability-score increases (Fireclaw: CHA at L3, DEX at L6, CON at
//      L8). Those — and ONLY those — are auto-applied: each trait carries
//      a structured `ability` payload, and `getActiveBonuses` sums the
//      bumps for every active trait of every bloodline, feeding the
//      shared bonus layer in app.js's collectActiveBonuses (→ score →
//      modifier → all downstream calcs). The other trait types (energy
//      resistance, bonus feats, SLAs, subtype changes) are GM-adjudicated
//      and stay reference-only by design (bonus feats are surfaced as
//      marked Feats-list rows, but not auto-resolved).
//
//   3. **Catalog.** The bloodline list is DB-driven (`entry WHERE
//      type='bloodline'`), filtered through BookFilter.allowsEntry
//      (which also gates HomebrewFilter), so homebrew bloodlines like
//      Fireclaw only appear once Diamond Soul homebrew is enabled.
//      Degrades to a plain text input when the DB isn't loaded.
//
// Save shape (per-character, omitted/null when none):
//   _bloodlines: [{ name, source, strength, slotsPaid: [bool,...], notes }, ...]
// Legacy single saves (`_bloodline: {...}`, pre-2026-06-09) migrate
// forward to a one-element array on load. Resolved by name+source (never
// DB id — ids renumber on rebuild; CLAUDE.md save-stability rule #7). The
// saved selection is the authoritative state; the trait data is
// re-resolved from the DB on DB.ready and on every filter change
// (save-stability rule #4).

const Bloodline = (function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  // The character's bloodlines — the persisted, authoritative state. Each
  // entry: { name, source, strength, slotsPaid, notes, resolved }, where
  // `resolved` is the DB-parsed `data` JSON (rebuilt whenever the DB or the
  // selection changes; NOT serialized).
  let states = [];

  // name|source (lowercased) → { id, name, source, version } stub.
  const catalog = new Map();

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

  // Is a typed name a real catalog entry (case-insensitive)?
  function catalogHasName(name) {
    const want = String(name || '').trim().toLowerCase();
    if (!want) return false;
    for (const s of catalog.values()) {
      if (s.name.toLowerCase() === want) return true;
    }
    return false;
  }

  // Resolve ONE bloodline state against the DB catalog and parse its
  // `data` JSON into `bl.resolved`. Match by name first (case-insensitive);
  // prefer an exact name+source hit when the save carried a source, else
  // fall back to any same-name entry.
  function resolveOne(bl) {
    bl.resolved = null;
    if (!bl.name) return;
    if (typeof DB === 'undefined' || !DB.isLoaded || !DB.isLoaded()) return;

    const wantName = bl.name.trim().toLowerCase();
    let stub = bl.source
      ? catalog.get((bl.name + '|' + bl.source).toLowerCase())
      : null;
    if (!stub) {
      for (const s of catalog.values()) {
        if (s.name.toLowerCase() === wantName) { stub = s; break; }
      }
    }
    if (!stub) return;
    // Keep the canonical source so saves resolve unambiguously later.
    bl.source = stub.source || bl.source;
    const row = DB.queryOne(
      "SELECT name, source, version, data FROM entry WHERE id = ?",
      [stub.id]);
    if (!row) return;
    try {
      bl.resolved = { id: stub.id, ...JSON.parse(row.data || '{}'),
                      _source: row.source, _version: row.version };
    } catch (e) {
      bl.resolved = null;
    }
  }

  // Resolve every bloodline state. (Kept named resolveSelection so the
  // DB.ready / filter re-resolve reads naturally and the save-stability
  // guard that requires name/source resolution still applies.)
  function resolveSelection() {
    for (const bl of states) resolveOne(bl);
  }

  // ------------------------------------------------------------------
  // Strength + slot helpers (all per-bloodline-state)
  // ------------------------------------------------------------------

  function strengthKeys(bl) {
    if (!bl || !bl.resolved || !bl.resolved.strengths) return [];
    return Object.keys(bl.resolved.strengths);
  }

  function currentStrength(bl) {
    const keys = strengthKeys(bl);
    if (!keys.length) return null;
    if (bl.strength && keys.includes(bl.strength)) {
      return bl.resolved.strengths[bl.strength];
    }
    // Default to the saved strength if valid, else the first column.
    bl.strength = keys.includes(bl.strength) ? bl.strength : keys[0];
    return bl.resolved.strengths[bl.strength];
  }

  function activeTraits(bl) {
    const s = currentStrength(bl);
    if (!s || !Array.isArray(s.traits)) return [];
    const lvl = getCharLevel();
    return s.traits.filter(t => (t.level || 0) <= lvl);
  }

  // Reset one state's slotsPaid length to match the selected strength's
  // threshold count, preserving existing paid flags positionally.
  function syncSlots(bl) {
    const s = currentStrength(bl);
    // When the strength can't be resolved yet — e.g. a saved character is
    // loaded BEFORE DB.ready has built the bloodline catalog — do NOT
    // clobber bl.slotsPaid. Wiping it here loses the saved bloodline-level
    // checkboxes for good, because the DB.ready handler re-renders from
    // `state` and there's nothing left to restore (save-stability rule #4).
    // Leave the saved flags intact; render() re-syncs them once the entry
    // resolves and req has a real length.
    if (!s || !Array.isArray(s.bloodline_levels_required)) return;
    const req = s.bloodline_levels_required;
    bl.slotsPaid = req.map((_, i) => !!bl.slotsPaid[i]);
  }

  function syncAllSlots() {
    for (const bl of states) syncSlots(bl);
  }

  // ------------------------------------------------------------------
  // Auto ability bumps — the only ability-score effect this module
  // applies. Summed across every active trait of every bloodline.
  // ------------------------------------------------------------------

  function getActiveBonuses() {
    const bonuses = { abilities: {} };
    for (const bl of states) {
      for (const t of activeTraits(bl)) {
        const ab = t.ability;
        if (!ab || typeof ab !== 'object') continue;
        for (const [k, v] of Object.entries(ab)) {
          const key = String(k).toUpperCase();
          const n = parseInt(v, 10) || 0;
          if (n) bonuses.abilities[key] = (bonuses.abilities[key] || 0) + n;
        }
      }
    }
    return bonuses;
  }

  // The 5 social skills a bloodline-affinity bonus applies to (UA: "all
  // Bluff, Diplomacy, Gather Information, Intimidate, and Perform checks").
  const AFFINITY_SKILLS = ['Bluff', 'Diplomacy', 'Gather Information',
                           'Intimidate', 'Perform'];

  // Parse a direct skill-boost trait name into { skill, value }. Handles
  // BOTH the canonical UA wording ("+2 on Sense Motive checks", preserving
  // a Knowledge/Craft subtype like "Knowledge (the planes)") AND the looser
  // homebrew shorthand ("+2 Tumble (Skill Boost)" — Fireclaw). Returns null
  // when the name carries no skill bonus. The trailing-annotation strip only
  // removes a recognized tag in the LAST parens, so a subtype (which UA
  // always writes mid-name, before "checks") is never lost.
  function parseSkillBoost(name) {
    const vm = /\+(\d+)/.exec(name || '');
    if (!vm) return null;
    const value = parseInt(vm[1], 10) || 0;
    if (!value) return null;
    const cleaned = String(name)
      .replace(/\s*\((?:skill boost|skill|ex|sp|su)\)\s*$/i, '');
    const m = /^\+\d+\s+on\s+(.+?)\s+checks$/i.exec(cleaned)   // UA wording
           || /^\+\d+\s+(.+?)(?:\s+checks)?$/i.exec(cleaned);  // shorthand
    const skill = m ? m[1].trim() : '';
    return skill ? { skill, value } : null;
  }

  // Skill bonuses granted by active traits across ALL bloodlines, for
  // skills.js to apply. TWO kinds, surfaced separately because they behave
  // differently:
  //   - direct: unconditional "+N on <Skill> checks" — folds into the
  //     skill's TOTAL (keyed by skill name, lower-cased). SUMMED across
  //     every bloodline ("Perform" matches every Perform subtype via the
  //     base name on the skills side).
  //   - affinities: the situational "<X> affinity +2/+4/+6" — applies ONLY
  //     to the 5 social skills vs creatures OF THAT bloodline, so it is a
  //     NOTE, never added to the total. EVERY UA bloodline grants one, and
  //     each is conditioned on a DIFFERENT creature type (celestials vs
  //     demons vs air elementals …), so they never overlap — we return ONE
  //     affinity per bloodline (a list), not a single collapsed value. Within
  //     a bloodline the affinity REPLACES as it scales 2→4→6, so we take that
  //     bloodline's max active value.
  function getActiveSkillBonuses() {
    const direct = {};
    const affinities = [];
    for (const bl of states) {
      let affVal = 0, affVs = '';
      for (const t of activeTraits(bl)) {
        // trait_type may be combined (homebrew uses e.g. "Ex/Feat"), so
        // match by substring rather than exact equality — the name parse +
        // row match are the real gates, so a non-skill name contributes
        // nothing.
        const tt = t.trait_type || '';
        if (/affinity/i.test(tt)) {
          const m = /affinity\s+\+(\d+)/i.exec(t.name || '');
          if (m) {
            const n = parseInt(m[1], 10) || 0;
            if (n > affVal) {
              affVal = n;
              affVs = '';
              if (t.description) {
                const dm = /interact with\s+([^.]+)\.?/i.exec(t.description);
                if (dm) affVs = dm[1].trim();
              }
            }
          }
        } else if (/skill/i.test(tt)) {
          const parsed = parseSkillBoost(t.name || '');
          if (parsed) {
            const key = parsed.skill.toLowerCase();
            direct[key] = (direct[key] || 0) + parsed.value;
          }
        }
      }
      if (affVal) {
        affinities.push({
          value: affVal,
          vs: affVs || `creatures of your ${bl.name} bloodline`,
          skills: AFFINITY_SKILLS.slice(),
        });
      }
    }
    return { direct, affinities };
  }

  // Auto-inject the bonus feats granted by active traits (across all
  // bloodlines) into the Feats tab as marked rows (`data-from-bloodline`).
  // Reconciling + idempotent: rebuilds only when the active set actually
  // changes, so slot toggles and repeat calls don't thrash the user's feat
  // rows. These rows are DERIVED, not persisted — Feats.collectData skips
  // data-from-bloodline rows, so they re-derive on load rather than
  // round-tripping as user feats (same model as the ability bumps). The
  // row key includes the bloodline NAME so two bloodlines granting the same
  // feat at the same level don't collapse into one. The "substitute if
  // already taken" clause is a GM call, so the granted feat's text carries
  // a note rather than auto-resolving.
  function syncBonusFeats() {
    const container = document.getElementById('feats-container');
    if (!container || typeof Feats === 'undefined'
        || typeof Feats.addFeat !== 'function') return;
    const wanted = [];
    for (const bl of states) {
      if (!bl.name) continue;
      for (const t of activeTraits(bl)) {
        if (Array.isArray(t.bonus_feats)) {
          for (const f of t.bonus_feats) {
            wanted.push({ feat: String(f), level: t.level, bl: bl.name });
          }
        }
      }
    }
    const existing = [...container.querySelectorAll(
      '.feat-row[data-from-bloodline="1"]')];
    const existingKeys = existing.map(r => r.dataset.blFeatKey || '');
    const wantedKeys = wanted.map(w => `${w.bl}|${w.feat}|${w.level}`);
    const inSync = existingKeys.length === wantedKeys.length
      && existingKeys.every((k, i) => k === wantedKeys[i]);
    if (inSync) return;
    existing.forEach(r => r.remove());
    for (const w of wanted) {
      // sourceLabel: renders a read-only info box (like picker-added feats)
      // with the granting bloodline shown as a tag, not an editable spec.
      Feats.addFeat(w.feat, { sourceLabel: `${w.bl} bloodline — L${w.level}` });
      const rows = container.querySelectorAll('.feat-row');
      const row = rows[rows.length - 1];
      if (!row) continue;
      row.dataset.fromBloodline = '1';
      row.dataset.blFeatKey = `${w.bl}|${w.feat}|${w.level}`;
      row.classList.add('feat-from-bloodline');
      const ta = row.querySelector('.feat-entry');
      if (ta) ta.dataset.fromBloodline = '1';
    }
  }

  // Label(s) for the Class & Level box, appended by class-picker:
  // "<Name> Bloodline <N>" per bloodline where N = bloodline-level slots
  // taken (the paid checkboxes in that bloodline's tracker), comma-joined.
  // A bloodline contributes nothing until at least one slot is taken — UA
  // bloodline levels are real class levels, so the count tracks how many
  // you've actually spent.
  function getClassLevelLabel() {
    const parts = [];
    for (const bl of states) {
      if (!bl.name) continue;
      const n = (bl.slotsPaid || []).filter(Boolean).length;
      if (n < 1) continue;
      parts.push(`${bl.name} Bloodline ${n}`);
    }
    // Separate multiple bloodlines with " // " — same notation gestalt uses for
    // its parallel tracks (class-picker), since bloodlines are independent
    // tracks too. Clearer than a comma.
    return parts.join(' // ');
  }

  // Total bloodline levels across every applied bloodline (= paid slots). These
  // count toward the character level for the max-skill-ranks cap (K1); character
  // .js folds this into `#char-level` when computing #max-class-ranks.
  function getTotalBloodlineLevels() {
    let total = 0;
    for (const bl of states) {
      if (!bl.name) continue;
      total += (bl.slotsPaid || []).filter(Boolean).length;
    }
    return total;
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  function render() {
    renderPicker();   // Character-tab chips + summary
    renderPanel();    // Feats-tab per-bloodline blocks
  }

  // Character-tab picker: applied-bloodline chips + a one-line summary.
  function renderPicker() {
    const list = $('#bloodline-applied-list');
    if (list) {
      list.innerHTML = '';
      states.forEach((bl, idx) => {
        const chip = document.createElement('span');
        chip.className = 'template-chip bloodline-chip';
        chip.dataset.blIndex = String(idx);
        chip.style.cssText =
          'background:rgba(140,110,180,0.22); padding:0.15rem 0.5rem; '
          + 'border-radius:3px; font-size:0.85em; margin:0.15rem 0.25rem 0 0; '
          + 'display:inline-flex; gap:0.35rem; align-items:center;';
        const txt = document.createElement('span');
        const strengthLabel = bl.strength
          ? ' (' + bl.strength.charAt(0).toUpperCase() + bl.strength.slice(1) + ')'
          : '';
        txt.textContent = bl.name + strengthLabel;
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'bloodline-chip-remove';
        x.dataset.blIndex = String(idx);
        x.textContent = '×';
        x.title = `Remove ${bl.name}`;
        x.style.cssText =
          'background:transparent; border:0; color:#b39ddb; cursor:pointer; '
          + 'font-size:1.1em; padding:0; line-height:1;';
        chip.appendChild(txt);
        chip.appendChild(x);
        list.appendChild(chip);
      });
    }

    const pickSummary = $('#bloodline-pick-summary');
    if (pickSummary) {
      if (!states.length) {
        pickSummary.style.display = 'none';
        pickSummary.innerHTML = '';
      } else {
        pickSummary.style.display = 'block';
        const parts = states.map(bl => {
          const strengthLabel = bl.strength
            ? bl.strength.charAt(0).toUpperCase() + bl.strength.slice(1)
            : '';
          return `<b>${escapeHtml(bl.name)}</b>`
            + (strengthLabel ? ` — ${escapeHtml(strengthLabel)}` : '');
        });
        pickSummary.innerHTML = parts.join(' &nbsp;·&nbsp; ')
          + ` <span style="opacity:.7">· full traits + slot tracker on the `
          + `<b>Feats &amp; Abilities</b> tab</span>`;
      }
    }
  }

  // Feats-tab panel: one block per bloodline rendered into #bloodline-blocks.
  function renderPanel() {
    const blocks = $('#bloodline-blocks');
    const empty = $('#bloodline-empty');
    if (empty) empty.style.display = states.length ? 'none' : 'block';
    if (!blocks) return;
    if (!states.length) { blocks.innerHTML = ''; return; }
    const lvl = getCharLevel();
    blocks.innerHTML = states
      .map((bl, idx) => renderBlock(bl, idx, lvl)).join('');
    // Errata / version badges can't be set via innerHTML (they attach to a
    // node), so attach them after the markup is in the DOM.
    states.forEach((bl, idx) => {
      const hdr = blocks.querySelector(
        `.bloodline-block[data-bl-index="${idx}"] .bloodline-header`);
      if (!hdr || !bl.resolved) return;
      if (window.ErrataBadge && bl.resolved.id) {
        ErrataBadge.attach(hdr, bl.resolved.id);
      }
      if (window.VersionBadge) {
        VersionBadge.attach(hdr, bl.resolved._version || bl.resolved.version);
      }
    });
  }

  // One bloodline's full block: header + strength selector + slot tracker
  // + per-level trait progression. data-bl-index ties its controls back to
  // states[idx] via event delegation.
  function renderBlock(bl, idx, charLvl) {
    const hasData = !!(bl.resolved && bl.resolved.strengths);
    const out = [];
    out.push(`<div class="bloodline-block" data-bl-index="${idx}" `
      + `style="border:1px solid rgba(140,110,180,0.35);border-radius:5px;`
      + `padding:0.5rem 0.6rem;margin:0 0 0.6rem">`);

    // --- Header (name + origin + summary + remove) ---
    out.push(`<div class="bloodline-header" style="display:block">`);
    if (!hasData) {
      out.push(`<div style="display:flex;align-items:center;gap:0.5rem">`
        + `<b>${escapeHtml(bl.name)}</b>`
        + `<button type="button" class="bloodline-remove" data-bl-index="${idx}" `
        + `title="Remove ${escapeHtml(bl.name)}" `
        + `style="margin-left:auto;background:transparent;border:0;color:#b39ddb;`
        + `cursor:pointer;font-size:1.1em;line-height:1">×</button></div>`
        + `<div style="margin-top:0.3rem;color:#c8a14a;font-style:italic">`
        + `Bloodline details unavailable — the DB isn't loaded, or this `
        + `bloodline's source is hidden by the 📚 / 🏠 filters. The `
        + `selection is saved and ability bonuses re-apply once it's `
        + `visible.</div>`);
    } else {
      out.push(`<div style="display:flex;align-items:center;gap:0.5rem">`
        + `<b>${escapeHtml(bl.resolved.name || bl.name)}</b>`
        + (bl.resolved._source
            ? ` <span style="opacity:.6">(${escapeHtml(bl.resolved._source)})</span>`
            : '')
        + `<button type="button" class="bloodline-remove" data-bl-index="${idx}" `
        + `title="Remove ${escapeHtml(bl.name)}" `
        + `style="margin-left:auto;background:transparent;border:0;color:#b39ddb;`
        + `cursor:pointer;font-size:1.1em;line-height:1">×</button></div>`);
      if (bl.resolved.bloodline_origin) {
        out.push(`<div><b>Origin:</b> ${escapeHtml(bl.resolved.bloodline_origin)}</div>`);
      }
      if (bl.resolved.summary) {
        out.push(`<div style="margin-top:0.3rem;line-height:1.4">`
          + escapeHtml(bl.resolved.summary) + `</div>`);
      }
    }
    out.push(`</div>`); // header

    // --- Strength selector (only when >1 column) ---
    if (hasData) {
      const keys = strengthKeys(bl);
      currentStrength(bl); // normalize bl.strength
      if (keys.length > 1) {
        out.push(`<div class="field field-sm" style="margin-top:0.4rem">`
          + `<label>Strength</label>`
          + `<select class="bloodline-strength" data-bl-index="${idx}">`
          + keys.map(k =>
              `<option value="${escapeHtml(k)}"${k === bl.strength ? ' selected' : ''}>`
              + escapeHtml(k.charAt(0).toUpperCase() + k.slice(1)) + `</option>`).join('')
          + `</select></div>`);
      }
    }

    // --- Slot-threshold tracker ---
    if (hasData) {
      const s = currentStrength(bl);
      const req = (s && Array.isArray(s.bloodline_levels_required))
        ? s.bloodline_levels_required : [];
      if (req.length) {
        syncSlots(bl);
        const lvl = charLvl;
        const rows = req.map((th, i) => {
          const paid = !!bl.slotsPaid[i];
          const due = lvl >= th && !paid;
          let status, color;
          if (paid) { status = 'slotted'; color = '#5fbf6f'; }
          else if (due) { status = '⚠ due — 20% XP penalty'; color = '#d9534f'; }
          else { status = 'not yet due'; color = '#888'; }
          return `<label class="bloodline-slot" style="display:flex;`
            + `align-items:center;gap:0.4rem;padding:0.15rem 0">`
            + `<input type="checkbox" class="bloodline-slot-paid" `
            + `data-bl-index="${idx}" data-slot="${i}"${paid ? ' checked' : ''}> `
            + `<span>Bloodline ${i + 1} <span style="opacity:.7">`
            + `(due by L${th})</span></span> `
            + `<span style="margin-left:auto;color:${color};font-size:0.9em">`
            + `${status}</span></label>`;
        }).join('');
        out.push(`<div class="bloodline-thresholds">`
          + `<div style="font-weight:600;margin:0.4rem 0 0.2rem">`
          + `Bloodline levels <span style="font-weight:400;opacity:.7;`
          + `font-size:0.85em">— a “bloodline” class level must be slotted `
          + `by each character level or take a 20% XP penalty (UA RAW)`
          + `</span></div>` + rows + `</div>`);
      }
    }

    // --- Per-level trait progression ---
    if (hasData) {
      const s = currentStrength(bl);
      const traits = (s && Array.isArray(s.traits)) ? s.traits : [];
      if (!traits.length) {
        out.push(`<div class="bloodline-progression" style="opacity:.7;`
          + `font-style:italic">No traits listed for this strength.</div>`);
      } else {
        out.push(`<div class="bloodline-progression">`
          + `<div style="font-weight:600;margin:0.5rem 0 0.2rem">`
          + `Trait progression`
          + (bl.strength
              ? ` <span style="opacity:.7;font-weight:400;font-size:0.85em">`
                + `(${escapeHtml(bl.strength)})</span>` : '')
          + `</div>`
          + traits.map(t => renderTraitRow(t, charLvl)).join('')
          + `</div>`);
      }
    }

    out.push(`</div>`); // block
    return out.join('');
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

  // Re-resolve (optional) + sync slots + re-render + re-sync the injected
  // bonus-feat rows + notify consumers (skills, class-picker, recalc).
  function refresh(reresolve) {
    if (reresolve) resolveSelection();
    syncAllSlots();
    render();
    syncBonusFeats();
    document.dispatchEvent(new CustomEvent('bloodline-changed'));
  }

  // Add a bloodline by name (from the catalog). No-op when the name is
  // empty, not a real catalog entry, or already in the stack.
  function addBloodline(name) {
    const v = String(name || '').trim();
    if (!v || !catalogHasName(v)) return false;
    const lower = v.toLowerCase();
    if (states.some(bl => bl.name.toLowerCase() === lower)) return false;
    states.push({ name: v, source: '', strength: '',
                  slotsPaid: [], notes: '', resolved: null });
    refresh(true);
    return true;
  }

  function removeBloodline(idx) {
    if (idx < 0 || idx >= states.length) return;
    states.splice(idx, 1);
    refresh(false);  // remaining states already resolved
  }

  function wire() {
    const nameInput = $('#bloodline-name');
    const addBtn = $('#bloodline-add');
    const list = $('#bloodline-applied-list');
    const blocks = $('#bloodline-blocks');

    // Commit the typed bloodline: add it, then clear the box so another can
    // be typed (multi-stack). Fired by the Add button, Enter, or an exact
    // catalog match (so picking a datalist suggestion just works).
    const commit = () => {
      if (!nameInput) return;
      if (addBloodline(nameInput.value)) nameInput.value = '';
    };
    if (nameInput) {
      nameInput.addEventListener('change', commit);
      nameInput.addEventListener('input', () => {
        // Only auto-commit when the typed value is an exact catalog match,
        // so mid-typing keystrokes don't thrash.
        if (catalogHasName(nameInput.value)) commit();
      });
      nameInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      });
    }
    if (addBtn) addBtn.addEventListener('click', commit);

    // Chip remove (Character tab).
    if (list) {
      list.addEventListener('click', (ev) => {
        const x = ev.target.closest('.bloodline-chip-remove');
        if (!x) return;
        const i = parseInt(x.dataset.blIndex, 10);
        if (!Number.isNaN(i)) removeBloodline(i);
      });
    }

    // Per-block controls (Feats tab) via delegation, since blocks are
    // regenerated on every render.
    if (blocks) {
      blocks.addEventListener('change', (ev) => {
        const sel = ev.target.closest('.bloodline-strength');
        if (sel) {
          const i = parseInt(sel.dataset.blIndex, 10);
          if (!Number.isNaN(i) && states[i]) {
            states[i].strength = sel.value;
            states[i].slotsPaid = [];   // thresholds differ per strength
            refresh(false);
          }
          return;
        }
        const cb = ev.target.closest('.bloodline-slot-paid');
        if (cb) {
          const i = parseInt(cb.dataset.blIndex, 10);
          const slot = parseInt(cb.dataset.slot, 10);
          if (!Number.isNaN(i) && !Number.isNaN(slot) && states[i]) {
            states[i].slotsPaid[slot] = cb.checked;
            render();  // status colors
            // Bloodline-level count (slots taken) feeds the Class & Level
            // box, so notify even though bumps/feats are unaffected.
            document.dispatchEvent(new CustomEvent('bloodline-changed'));
          }
        }
      });
      blocks.addEventListener('click', (ev) => {
        const x = ev.target.closest('.bloodline-remove');
        if (!x) return;
        const i = parseInt(x.dataset.blIndex, 10);
        if (!Number.isNaN(i)) removeBloodline(i);
      });
    }

    // Character level drives active-trait highlighting, the ability bumps,
    // AND which bonus feats are granted. recalcAll already fires on
    // #char-level input (app.js) so the bumps recompute there; here we
    // re-render the panels + re-sync the injected bonus-feat rows.
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
    const arr = states.filter(bl => bl.name).map(bl => ({
      name: bl.name,
      source: bl.source || '',
      strength: bl.strength || '',
      slotsPaid: (bl.slotsPaid || []).slice(),
      notes: bl.notes || '',
    }));
    return { _bloodlines: arr.length ? arr : null };
  }

  function loadData(data) {
    // CLEAR on an absent/null bloodline set (a new character or an old
    // pre-bloodline save), restore when present. loadData is always a
    // full-state load, so "leave alone" would desync internal `states`
    // from the inputs the generic reset loop just cleared — the same
    // bleed-bug class as the ClassFeatures customizations fix
    // (app.js#newCharacter). New Character calls Bloodline.loadData({})
    // explicitly so this path clears the internal state + the panels.
    states = [];
    let arr = null;
    if (data && Array.isArray(data._bloodlines)) {
      arr = data._bloodlines;
    } else if (data && data._bloodline && data._bloodline.name) {
      // Legacy single-bloodline save (pre-2026-06-09) → one-element stack.
      arr = [data._bloodline];
    }
    if (arr) {
      for (const bl of arr) {
        if (!bl || !bl.name) continue;
        states.push({
          name: String(bl.name),
          source: bl.source ? String(bl.source) : '',
          strength: bl.strength ? String(bl.strength) : '',
          slotsPaid: Array.isArray(bl.slotsPaid)
            ? bl.slotsPaid.map(Boolean) : [],
          notes: bl.notes ? String(bl.notes) : '',
          resolved: null,
        });
      }
    }
    // The name input is just an add-box in multi mode; keep it empty.
    const nameInput = $('#bloodline-name');
    if (nameInput) nameInput.value = '';
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
    // (possibly already-loaded) selections + re-render. Re-run on any
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
    getTotalBloodlineLevels,
    collectData,
    loadData,
    // Exposed for tests / debugging.
    _getStates: () => states.map(bl => ({
      name: bl.name, source: bl.source, strength: bl.strength,
      slotsPaid: bl.slotsPaid.slice(), notes: bl.notes,
    })),
    _getState: () => {
      const bl = states[0];
      return bl
        ? { name: bl.name, source: bl.source, strength: bl.strength,
            slotsPaid: bl.slotsPaid.slice(), notes: bl.notes }
        : { name: '', source: '', strength: '', slotsPaid: [], notes: '' };
    },
  };
})();

window.Bloodline = Bloodline;
