// race-picker.js — Populate the race input with autocomplete from the
// database, and auto-fill type/size/speed/languages when the user picks
// a race that exists in the DB. Manual typing still works — if the
// typed text doesn't match a known race, no auto-fill happens and the
// existing fields are left alone.
//
// Existing fields populated:
//   #char-race        (input)        — name (typed)
//   #char-type        (input)        — creature type (e.g. "Humanoid")
//   #char-size        (select)       — size
//   #char-speed       (input)        — base speed in feet (e.g. "30 ft.")
//   #languages        (textarea)     — comma-separated automatic languages
//
// Enhancements added:
//   #race-info        (div, new)     — small panel showing ability mods,
//                                       darkvision, favored class, etc.
//   <datalist id="race-options">     — autocomplete options

(function () {
  if (!window.DB) {
    console.warn('[race-picker] DB module not loaded');
    return;
  }

  // Map from lowercase race name → race_id, populated once the DB is ready.
  let raceIndex = new Map();

  function init() {
    const raceInput = document.getElementById('char-race');
    if (!raceInput) {
      console.warn('[race-picker] #char-race input not found');
      return;
    }

    // 1. Insert a <datalist> alongside the input for autocomplete.
    let datalist = document.getElementById('race-options');
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = 'race-options';
      raceInput.setAttribute('list', 'race-options');
      raceInput.setAttribute('autocomplete', 'off');
      raceInput.parentElement.appendChild(datalist);
    }

    // 2. Insert a small info panel below the field for race details.
    let infoPanel = document.getElementById('race-info');
    if (!infoPanel) {
      infoPanel = document.createElement('div');
      infoPanel.id = 'race-info';
      infoPanel.className = 'race-info';
      infoPanel.style.cssText =
        'grid-column: 1 / -1; padding: 0.5rem; margin-top: 0.25rem; ' +
        'font-size: 0.85em; color: #ccc; background: rgba(255,255,255,0.04); ' +
        'border-left: 3px solid #6a8a6a; border-radius: 3px; display: none;';
      raceInput.parentElement.parentElement.appendChild(infoPanel);
    }

    // 3. Populate options from DB.
    // No `race` view any more — query `entry WHERE type='race'`.
    // For duplicate names (e.g. Aasimar in Planar Handbook + FRCS),
    // sort newest source first so the most recent printing wins.
    // 3.5 wins over 3.0 first; then publication_date DESC.
    function populate() {
      const races = DB.query(
        "SELECT e.id AS race_id, e.name, e.version, e.source, "
        + "       b.publication_date "
        + "FROM entry e "
        + "LEFT JOIN book b ON b.name = e.source "
        + "WHERE e.type = 'race' "
        + "ORDER BY e.name, "
        + "         CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, "
        + "         b.publication_date DESC"
      );
      raceIndex = new Map();
      datalist.innerHTML = '';
      let kept = 0;
      for (const r of races) {
        if (window.BookFilter && !window.BookFilter.allowsEntry({...r, type: 'race'})) continue;
        const opt = document.createElement('option');
        // Show version in the dropdown for disambiguation
        opt.value = r.version === '3.5' ? r.name : `${r.name} (${r.version})`;
        datalist.appendChild(opt);
        raceIndex.set(r.name.toLowerCase(), r.race_id);
        kept++;
      }
      console.log(`[race-picker] ${kept}/${races.length} races available`);
    }
    populate();
    document.addEventListener('book-filter-changed', populate);

    // 4. On input change: try to look up the typed name and auto-fill.
    raceInput.addEventListener('change', () => onRaceChosen(raceInput.value));
    raceInput.addEventListener('input', () => {
      // Only auto-fill on exact match (otherwise user is mid-typing)
      const exact = raceIndex.get(raceInput.value.trim().toLowerCase());
      if (exact !== undefined) {
        onRaceChosen(raceInput.value);
      }
    });
  }

  function onRaceChosen(typedName) {
    const key = typedName.trim().toLowerCase()
      .replace(/\s*\(3\.0\)\s*$/, '')
      .replace(/\s*\(3\.5\)\s*$/, '');
    const raceId = raceIndex.get(key);
    if (raceId === undefined) {
      hideInfo();
      return;
    }

    // Pull the entry row + parse JSON sub-fields into the same shape the
    // old per-table queries used to return. The DB now stores everything
    // as JSON in entry.data; we walk those fields and reshape.
    const row = DB.queryOne(
      "SELECT id AS race_id, name, source, version, "
      + "creature_size, creature_type, data "
      + "FROM entry WHERE id = ?", [raceId]
    );
    if (!row) return;
    let parsed = {};
    try { parsed = JSON.parse(row.data || '{}'); }
    catch (e) { console.warn('[race-picker] bad data JSON', e); }
    // Races use two related schemas:
    //   (A) "PHB-style" (33 races): top-level `creature_type`,
    //       `base_speed_ft` (int), `darkvision_ft`, `has_lowlight_vision`,
    //       structured `bonuses` list.
    //   (B) "campaign-book-style" (79 races): top-level `type`,
    //       `speed` (string like "30 ft."), darkvision/lowlight rolled
    //       up inside the bonuses dict/list.
    // We read both shapes so the picker works against either.
    const race = {
      race_id: row.race_id,
      name: row.name,
      source: row.source,
      version: row.version,
      size: row.creature_size || parsed.size || null,
      creature_type: row.creature_type || parsed.creature_type
                                       || parsed.type || null,
      base_speed_ft: (typeof parsed.base_speed_ft === 'number'
                        ? parsed.base_speed_ft
                        : parseSpeedFt(parsed.speed)),
      level_adjustment: parsed.level_adjustment,
      favored_class: parsed.favored_class,
      description: parsed.description,
      // Darkvision / low-light: prefer top-level fields, else extract
      // from the bonuses list.
      darkvision_ft: (typeof parsed.darkvision_ft === 'number'
                        ? parsed.darkvision_ft
                        : extractBonus(parsed.bonuses, 'darkvision')),
      has_lowlight_vision:
        parsed.has_lowlight_vision === true ||
        !!extractBonus(parsed.bonuses, 'low_light_vision'),
      racial_hd: extractBonus(parsed.bonuses, 'racial_HD'),
      racial_hd_die: null,
    };

    // Canonical schema (post-normalize_schema.py):
    //   ability_mods : list of {ability, modifier}
    //   languages    : list of {language, is_automatic}
    //   traits       : list of strings OR list of {name, description, tag}
    const abilityMods = Array.isArray(parsed.ability_mods)
      ? parsed.ability_mods : [];
    const languages   = Array.isArray(parsed.languages)
      ? parsed.languages : [];
    const traits = (Array.isArray(parsed.traits) ? parsed.traits : [])
      .map(t => {
        if (typeof t === 'string') {
          const idx = t.indexOf(': ');
          if (idx > 0) {
            return { name: t.slice(0, idx),
                     description: t.slice(idx + 2), tag: null };
          }
          return { name: t, description: '', tag: null };
        }
        return {
          name: t?.name || '',
          description: t?.description || '',
          tag: t?.tag || null,
        };
      });
    // Movement: race entries store speed as a single string like "30 ft."
    // — no separate movement modes for now. Leave empty.
    const movement = [];

    // 1. Type field
    if (race.creature_type) {
      const typeField = document.getElementById('char-type');
      if (typeField && !typeField.value.trim()) {
        typeField.value = race.creature_type;
        typeField.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    // 1b. Racial ability adjustments — populate the Race column.
    // Always overwrite (not gated on emptiness) since this is the
    // canonical place for the racial bonus once a race is picked.
    const ABILITY_INPUTS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
    // Reset all race inputs first, then apply mods from this race.
    for (const a of ABILITY_INPUTS) {
      const el = document.getElementById(`${a}-race`);
      if (el) el.value = '';
    }
    for (const am of abilityMods) {
      const el = document.getElementById(`${am.ability.toLowerCase()}-race`);
      if (el) {
        el.value = am.modifier;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    // 2. Size dropdown
    if (race.size) {
      const sizeSelect = document.getElementById('char-size');
      if (sizeSelect) {
        sizeSelect.value = race.size;
        sizeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    // 3. Speed field — primary land speed; append other modes if present.
    const speedField = document.getElementById('char-speed');
    if (speedField && !speedField.value.trim() && race.base_speed_ft) {
      const parts = [`${race.base_speed_ft} ft.`];
      for (const m of movement) {
        const mod = m.maneuverability ? ` (${m.maneuverability})` : '';
        parts.push(`${m.mode} ${m.speed_ft || '?'} ft.${mod}`);
      }
      speedField.value = parts.join(', ');
      speedField.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // 4. Languages textarea — only the automatic ones, comma-separated.
    const langField = document.getElementById('languages');
    const automaticLangs = languages
      .filter(l => l.is_automatic)
      .map(l => l.language);
    if (langField && !langField.value.trim() && automaticLangs.length) {
      langField.value = automaticLangs.join(', ');
      langField.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // 5. Info panel — always show for the chosen race.
    showInfo(race, abilityMods, movement, languages, traits);

    // 6. Special abilities — auto-populate from race traits.
    populateSpecialAbilities(traits);
  }

  // Auto-populate Special Abilities from racial traits.
  // We mark race-added rows with data-from-race="1" so subsequent race
  // changes can clean them up without disturbing user-typed entries.
  function populateSpecialAbilities(traits) {
    const container = document.getElementById('special-abilities-container');
    if (!container || typeof Feats?.addSpecialAbility !== 'function') return;

    // 1. Remove previously race-added entries.
    container.querySelectorAll('[data-from-race="1"]').forEach(node => {
      const row = node.closest('.feat-row');
      if (row) row.remove();
    });

    // 2. Add the new race's traits.
    for (const t of traits) {
      // Skip empty/duplicative entries (Darkvision/Low-Light Vision are
      // expressed elsewhere in the info panel; skip if the description
      // is empty AND the name is one of those known fields).
      const skipNames = new Set(['Darkvision', 'Low-Light Vision']);
      if (skipNames.has(t.name) && !t.description) continue;
      const text = t.description
        ? `${t.name}: ${t.description}`
        : t.name;
      Feats.addSpecialAbility(text);
      // Tag the textarea we just added so we can find/remove it later.
      // (The textarea is inside the last appended .feat-row.)
      const rows = container.querySelectorAll('.feat-row');
      const lastTa = rows[rows.length - 1]?.querySelector(
        '.special-ability-entry'
      );
      if (lastTa) lastTa.setAttribute('data-from-race', '1');
    }
  }

  function showInfo(race, abilityMods, movement, languages, traits) {
    const panel = document.getElementById('race-info');
    if (!panel) return;
    const bits = [];

    // Ability mods
    if (abilityMods.length) {
      const fmt = abilityMods.map(a =>
        `${a.modifier > 0 ? '+' : ''}${a.modifier} ${a.ability}`
      ).join(', ');
      bits.push(`<b>Ability:</b> ${fmt}`);
    }
    // Vision
    const vision = [];
    if (race.darkvision_ft) vision.push(`darkvision ${race.darkvision_ft} ft.`);
    if (race.has_lowlight_vision) vision.push('low-light vision');
    if (vision.length) bits.push(`<b>Vision:</b> ${vision.join(', ')}`);
    // Favored class
    if (race.favored_class) {
      bits.push(`<b>Favored Class:</b> ${escapeHtml(race.favored_class)}`);
    }
    // Level adjustment
    if (race.level_adjustment) {
      bits.push(`<b>LA:</b> +${race.level_adjustment}`);
    }
    // Racial HD
    if (race.racial_hd && race.racial_hd_die) {
      bits.push(
        `<b>Racial HD:</b> ${race.racial_hd}d${race.racial_hd_die}`
      );
    }
    // Bonus languages (compact)
    const bonusLangs = languages.filter(l => !l.is_automatic).map(l => l.language);
    if (bonusLangs.length) {
      bits.push(`<b>Bonus Languages:</b> ${bonusLangs.join(', ')}`);
    }
    // Notable traits (just names, with descriptions on hover)
    if (traits.length) {
      const trait_html = traits.slice(0, 6).map(t => {
        const desc = (t.description || '').replace(/"/g, '&quot;');
        return `<span title="${desc}" style="border-bottom:1px dotted">` +
               escapeHtml(t.name) + '</span>';
      }).join(', ');
      bits.push(`<b>Traits:</b> ${trait_html}`);
    }

    panel.innerHTML = bits.join(' &nbsp;·&nbsp; ');
    // race-picker's info panel doesn't repeat the race name (it's in
    // the input). Prepend the errata badge so the ✦ sits at the top
    // of the panel, above the property bits.
    if (window.ErrataBadge) ErrataBadge.attach(panel, race.race_id, { position: 'prepend', applied: false });
    // Edition pill — only renders if the entry is non-3.5 so the
    // common case stays uncluttered.
    if (window.VersionBadge) VersionBadge.attach(panel, race.version);
    panel.style.display = bits.length ? 'block' : 'none';
  }

  function hideInfo() {
    const panel = document.getElementById('race-info');
    if (panel) panel.style.display = 'none';
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Parse a race speed string like "30 ft." or "20 ft." into an integer.
  function parseSpeedFt(s) {
    if (typeof s !== 'string') return null;
    const m = s.match(/(\d+)\s*ft/i);
    return m ? parseInt(m[1], 10) : null;
  }

  // Find a typed bonus row in the canonical bonuses list and return its
  // amount (or, for boolean-style rows, true). Returns null if absent.
  function extractBonus(bonuses, bonusType) {
    if (!Array.isArray(bonuses)) return null;
    for (const b of bonuses) {
      if (!b || b.bonus_type !== bonusType) continue;
      if (b.amount !== null && b.amount !== undefined) return b.amount;
      return true;
    }
    return null;
  }

  // Wait for DB to load, then init.
  DB.ready.then((db) => {
    if (db) init();
  });
})();
