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

  // Cache of the last-computed racial skill bonuses, keyed by #char-race
  // value, so the per-keystroke skills recalc doesn't re-query the DB.
  // Dropped in populate() (DB-ready + book-filter change).
  let _skillBonusCache = null;

  // The current race's optional_features (own or inherited from the base for a
  // variant), captured at pick time so the info-panel "+ Add" chips can resolve
  // a clicked feature to its full text without re-querying. See
  // addOptionalFeatureToCharacter.
  let _currentOptionalFeatures = [];

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
    // Delegation: clicking an "+ Add" optional-feature chip in the info panel
    // applies that feature onto the character (Feats-tab Special Abilities).
    // Attached once here (showInfo rewrites innerHTML each render, so a
    // per-render listener would stack). Mirrors deity-picker's domain-chip
    // insert pattern.
    infoPanel.addEventListener('click', (ev) => {
      const chip = ev.target.closest('[data-optfeat]');
      if (!chip) return;
      addOptionalFeatureToCharacter(chip.dataset.optfeat);
    });

    // 2b. Browsing-chip wall — surfaces the full race list as
    // clickable chips below the input, so the player can scan rather
    // than knowing the exact name. Sits in the same row layout as
    // the info panel so it inherits the grid placement.
    let browseWrap = document.getElementById('race-browse');
    if (!browseWrap) {
      browseWrap = document.createElement('div');
      browseWrap.id = 'race-browse';
      browseWrap.style.cssText =
        'grid-column: 1 / -1; margin-top: 0.25rem;';
      // Prefer the consolidated "Lookups & Pickers" disclosure; fall back
      // to the info-grid (next to the input) if that host is absent.
      const host = document.getElementById('race-browse-host')
        || raceInput.parentElement.parentElement;
      host.appendChild(browseWrap);
    }
    // Chip click: set value + run the auto-fill / info-show flow
    // DIRECTLY without dispatching 'input' (the input event handler
    // re-renders the chip wall narrowed to the picked entry — we want
    // the chip wall to stay full for continued browsing). Spell-picker
    // behavior. onRaceChosen handles both alignment-token writes and
    // info-panel render.
    const raceResults = (typeof PickerResults !== 'undefined')
      ? PickerResults.attach(browseWrap, {
          itemNoun: 'race',
          // Collapsed by default — you generally only browse one picker
          // at a time, so don't let the chip wall clutter the
          // consolidated "Lookups & Pickers" area (matches deity browse).
          collapsible: true,
          collapsedByDefault: true,
          onPick: (name) => {
            raceInput.value = name;
            onRaceChosen(name);
            raceInput.focus();
          },
        })
      : null;

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
      const browseNames = [];
      const seenOpt = new Set();
      let kept = 0;
      for (const r of races) {
        if (window.BookFilter && !window.BookFilter.allowsEntry({...r, type: 'race'})) continue;
        // Show version in the dropdown for disambiguation; 3.0-only races
        // render as "Race (3.0)" so they stay distinct from a 3.5 namesake.
        const optValue = r.version === '3.5' ? r.name : `${r.name} (${r.version})`;
        // Dedup the datalist by display value (a race printed in several
        // 3.5 books would otherwise add identical "Drow" suggestions).
        if (!seenOpt.has(optValue)) {
          seenOpt.add(optValue);
          const opt = document.createElement('option');
          opt.value = optValue;
          datalist.appendChild(opt);
        }
        // FIRST occurrence per name wins. The query orders best-first (3.5
        // before 3.0, then publication_date DESC), so the first row for a
        // name is the most recent printing — "newest source wins", matching
        // every other picker's tiebreak. (Was `raceIndex.set` every
        // iteration → last-set-wins, which silently inverted it to
        // oldest-source-wins.)
        if (!raceIndex.has(r.name.toLowerCase())) {
          browseNames.push(optValue);
          raceIndex.set(r.name.toLowerCase(), r.race_id);
        }
        kept++;
      }
      if (raceResults) {
        raceResults.render(browseNames,
          { typedFilter: raceInput.value.trim() });
      }
      console.log(`[race-picker] ${kept}/${races.length} races available`);
      // The index just (re)built — a race may have entered/left book scope,
      // so drop the skill-bonus cache and recompute on the next recalc.
      _skillBonusCache = null;
      document.dispatchEvent(new CustomEvent('race-changed'));
    }
    populate();
    document.addEventListener('book-filter-changed', populate);

    // 4. On input change: try to look up the typed name and auto-fill.
    raceInput.addEventListener('change', () => onRaceChosen(raceInput.value));
    raceInput.addEventListener('input', () => {
      // Re-narrow the chip wall as the user types so it acts as a
      // substring search, matching spell-picker's behavior.
      if (raceResults) {
        // Re-render from the current datalist options (no DB requery
        // needed — the populate() pass already filtered by book scope).
        const browseNames = Array.from(datalist.options).map(o => o.value);
        raceResults.render(browseNames,
          { typedFilter: raceInput.value.trim() });
      }
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
    // Unified Race field: defer to the chooser on a race/creature
    // collision (Centaur, Gnoll) until the player picks which they mean.
    if (window.RaceUnify && !RaceUnify.claim('race', typedName)) {
      hideInfo();
      return;
    }
    // Clean slate across BOTH pickers first, so switching from a monster
    // race back to a standard one doesn't leave stale ability mods /
    // racial HD behind.
    if (window.RaceUnify) RaceUnify.teardownAll();

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
    // Environmental / variant races (Unearthed Arcana: Arctic Kobold, Desert
    // Dwarf, Aquatic Elf, …) are printed as "standard <base> racial traits
    // with the following modifications." They carry their OWN final ability
    // mods / size / speed / languages (already merged — do NOT re-apply the
    // base's, that double-counts), but only their DELTA traits, senses, and
    // bonuses. Resolve the base race so we can fold its descriptive traits +
    // senses + natural armor in below, where the variant doesn't override.
    const baseParsed = resolveVariantBase(parsed);
    // Races use ONE canonical shape (unified 2026-05-29 by the DB project's
    // normalize_schema.py): top-level `creature_type` (bare string),
    // `base_speed_ft` (int), `senses` (list of {sense, range_ft?, multiplier?}),
    // and structured `bonuses` / `ability_mods` / `languages` / `traits` lists.
    const race = {
      race_id: row.race_id,
      name: row.name,
      source: row.source,
      version: row.version,
      size: row.creature_size || parsed.size || null,
      creature_type: row.creature_type || parsed.creature_type || null,
      // Creature subtypes (e.g. Silverbrow Human → ["human","dragonblood"]).
      // Surfaced parenthetically in #char-type — "Humanoid (human,
      // dragonblood)" — so subtypes set in the data actually show on the type.
      subtypes: Array.isArray(parsed.subtypes) ? parsed.subtypes : [],
      base_speed_ft: parsed.base_speed_ft,
      level_adjustment: parsed.level_adjustment,
      favored_class: parsed.favored_class,
      description: parsed.description,
      // Variant senses union the base's (darkvision etc.), variant winning.
      senses: mergeSenses(parsed.senses, baseParsed && baseParsed.data.senses),
      // Base race name when this is a variant, for the info-panel label.
      variant_of: baseParsed ? baseParsed.name : null,
      // Racial Hit Dice — monster races (Ogre, Troll, …) carry extra racial HD
      // on top of class levels; canonical top-level fields since 2026-06-03.
      // Default 0 for PC-style races so existing entries (PHB, etc.) don't break.
      racial_hd: (typeof parsed.racial_hd === 'number')
        ? parsed.racial_hd
        : (extractBonus(parsed.bonuses, 'racial_HD') || 0),
      racial_hd_die: (typeof parsed.racial_hd_die === 'number')
        ? parsed.racial_hd_die : null,
      racial_hd_type: parsed.racial_hd_type
        || (parsed.racial_hd ? (row.creature_type || parsed.creature_type) : null),
      // Structured defenses (mirror the creature shapes; propagated on
      // monster->race). Wired into the sheet's SR / DR fields + defense notes.
      spell_resistance: (parsed.spell_resistance != null && parsed.spell_resistance !== '')
        ? parsed.spell_resistance : null,
      damage_reduction: Array.isArray(parsed.damage_reduction) ? parsed.damage_reduction : null,
      immunities: Array.isArray(parsed.immunities) ? parsed.immunities : null,
      resistances: Array.isArray(parsed.resistances) ? parsed.resistances : null,
      // Added 2026-08-20 with the structured rider store. These two were absent
      // from this blob, so a race carrying them handed over `undefined` and the
      // data was dropped silently — the DB has both fields and nothing here was
      // reading them.
      vulnerabilities: Array.isArray(parsed.vulnerabilities) ? parsed.vulnerabilities : null,
      // The DB writes regeneration as a single {amount, bypass} object, not a
      // list; the rider store accepts either and normalises.
      regeneration: (parsed.regeneration && typeof parsed.regeneration === 'object')
        ? parsed.regeneration : null,
      // Racial natural-armor bonus as a first-class integer (the DB carries
      // it as top-level `natural_armor` on 58 races today). Preferred over the
      // legacy bonuses-row / trait-text parse in the NA-apply block below — it
      // recovers NA on the ~52 monster races that have the field but no
      // structured `bonuses` natural-armor row. Variant races inherit the
      // base's field DELTA-style when they carry none (mirrors mergeSenses /
      // mergeBonuses inheritance); null falls back to the bonuses parse.
      natural_armor: (typeof parsed.natural_armor === 'number')
        ? parsed.natural_armor
        : (baseParsed && typeof baseParsed.data.natural_armor === 'number'
            ? baseParsed.data.natural_armor : null),
    };

    // Canonical schema (post-normalize_schema.py):
    //   ability_mods : list of {ability, modifier}
    //   languages    : list of {language, is_automatic}
    //   traits       : list of {name, description, tag}
    const abilityMods = Array.isArray(parsed.ability_mods)
      ? parsed.ability_mods : [];
    const languages   = Array.isArray(parsed.languages)
      ? parsed.languages : [];
    // For a variant race, present the base race's traits first, then the
    // variant's own modification traits (dropping the bare pointer line).
    // For a normal race this is just the race's own traits.
    const traits = buildTraitList(parsed.traits, baseParsed && baseParsed.data);
    // Optional racial features — an ADDITIVE, independently-selectable menu of
    // traits (RotD web-enhancement kobold options) that layer onto the race in
    // any combination and trade nothing out. Lives on the BASE race, so a
    // variant inherits it via baseParsed (no per-variant duplication) — an
    // Arctic Kobold gets the same optional kit as the base Kobold.
    const optionalFeatures = Array.isArray(parsed.optional_features)
      ? parsed.optional_features
      : (baseParsed && Array.isArray(baseParsed.data.optional_features)
          ? baseParsed.data.optional_features : []);
    _currentOptionalFeatures = optionalFeatures;

    // 1. Type field — include subtypes parenthetically ("Humanoid (human,
    //    dragonblood)") so subtypes carried in the data show on the type.
    if (race.creature_type) {
      const typeField = document.getElementById('char-type');
      if (typeField && !typeField.value.trim()) {
        const subs = Array.isArray(race.subtypes) ? race.subtypes.filter(Boolean) : [];
        typeField.value = subs.length
          ? `${race.creature_type} (${subs.join(', ')})`
          : race.creature_type;
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

    // 3. Movement — land from the canonical numeric base_speed_ft; the exotic
    // modes (Raptoran fly, Aventi swim, …) parsed from the prose `speed`
    // string. Only fill an EMPTY box so a manual entry / prior race isn't
    // clobbered.
    const setModeIfEmpty = (id, val) => {
      const el = document.getElementById(id);
      if (el && !el.value.trim() && val != null && val !== '') {
        el.value = String(val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
    if (race.base_speed_ft) setModeIfEmpty('speed-land', race.base_speed_ft);
    // Prefer the structured `movement` field (P3); fall back to parsing the
    // prose `speed` string for old blobs / land-only races (no movement field).
    if (typeof DND35 !== 'undefined') {
      const mv = (Array.isArray(parsed.movement) && parsed.movement.length
                  && DND35.movementListToModes)
        ? DND35.movementListToModes(parsed.movement)
        : (DND35.parseSpeedString ? DND35.parseSpeedString(parsed.speed || '') : null);
      if (mv) {
        setModeIfEmpty('speed-land', mv.land);   // prose land if base_speed_ft absent
        setModeIfEmpty('speed-fly', mv.fly);
        setModeIfEmpty('speed-fly-maneuver', mv.flyManeuver);
        setModeIfEmpty('speed-swim', mv.swim);
        setModeIfEmpty('speed-burrow', mv.burrow);
        setModeIfEmpty('speed-climb', mv.climb);
      }
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

    // 4a. Natural armor — monster races carry a racial natural-armor bonus
    // in `bonuses` ({bonus_type:'ac', bonus_category:'natural'}). Apply to
    // #ac-natural with ownership so it propagates into AC and a later race
    // switch clears only what we wrote (the field is shared with equipment
    // and monster-class extensions).
    // Variant races inherit the base's natural armor when they don't carry
    // their own (Arctic Kobold has empty bonuses but is still a +1-NA kobold).
    // Prefer the structured `natural_armor` integer; fall back to the legacy
    // bonuses-row / trait-text parse for old DB blobs that lack the field.
    const racialNA = (typeof race.natural_armor === 'number')
      ? race.natural_armor
      : naturalArmorFromBonuses(
          mergeBonuses(parsed.bonuses, baseParsed && baseParsed.data.bonuses));
    if (racialNA != null && racialNA > 0) {
      raceSetOwned('ac-natural', String(racialNA), 'input', true);
    }

    // 4c. Structured defenses — SR → #spell-resistance, DR → #damage-reduction
    // (both shared, ownership-tracked), and immunities / resistances /
    // vulnerabilities into the structured rider rows.
    //
    // These used to be flattened into a prose line in #ac-defense-notes, which
    // was the sharpest form of the missing-field problem: the DB hands us
    // `resistances: [{amount, damage_type}]` and we turned it into a sentence,
    // so anything reading the sheet downstream had to parse English to answer
    // "does fire hurt this character". defense-riders.js takes the DB's shapes
    // through unchanged. Ownership is per-source, so re-applying or removing
    // the race takes exactly its rows.
    if (race.spell_resistance != null) {
      raceSetOwned('spell-resistance', String(race.spell_resistance), 'input', true);
    }
    // DR only goes to the legacy text box when the structured store is absent
    // — otherwise it would be written twice, and two writers for one number is
    // the collision the ownership split exists to prevent.
    if (race.damage_reduction && race.damage_reduction.length
        && typeof DefenseRiders === 'undefined') {
      const dr = race.damage_reduction
        .map(d => `${d.amount}/${d.bypass || '—'}`).join(', ');
      raceSetOwned('damage-reduction', dr, 'input');
    }
    if (typeof DefenseRiders !== 'undefined') {
      // Keyed by name so the marker is human-readable in a save file and
      // survives a DB rebuild (entry ids renumber; names don't).
      DefenseRiders.applyFromSource(`race:${race.name}`, {
        resistances: race.resistances,
        immunities: race.immunities,
        vulnerabilities: race.vulnerabilities,
        damage_reduction: race.damage_reduction,
        regeneration: race.regeneration,
      });
    } else {
      // No structured store on this page (older cached module set) — fall back
      // to the prose line rather than dropping the data on the floor.
      const defNotes = [];
      if (race.immunities && race.immunities.length)
        defNotes.push(`Immune to ${race.immunities.join(', ')}`);
      if (race.resistances && race.resistances.length)
        defNotes.push('Resist ' + race.resistances
          .map(r => `${r.damage_type} ${r.amount}`).join(', '));
      if (defNotes.length) raceSetDefenseNotes(defNotes.join('; '));
    }

    // 4d. Racial casting/initiation — auto-spawn the matching caster panel(s)
    // (Valkyrie's swordsage maneuvers at IL 10, pre-loaded from
    // maneuvers_and_stances). Spawn-only; live stacking with class levels next.
    spawnRacialCasterPanels(parsed);

    // 4b. Racial HD → synthetic class row. Monster races (Bugbear, Ogre,
    // Troll, …) carry racial Hit Dice that must pool into the BAB / save /
    // HP / total-level aggregate — not merely display. Mirrors the creature-
    // race-picker's integration (DND35.creatureTypeToProg → ClassPicker.
    // addRacialHD). The synthetic "(racial HD)" row persists via class-
    // picker's _multiclass and is torn down by RaceUnify.teardownAll() above
    // on the next race change, so no stale racial HD survives a race switch.
    if (race.racial_hd && race.racial_hd > 0 &&
        window.ClassPicker && typeof ClassPicker.addRacialHD === 'function') {
      const prog = (typeof DND35 !== 'undefined' && DND35.creatureTypeToProg)
        ? DND35.creatureTypeToProg(race.racial_hd_type) : null;
      if (prog) {
        ClassPicker.addRacialHD({
          creatureRace: race.name,
          creatureType: race.racial_hd_type,
          count: race.racial_hd,
          prog,
        });
      }
    }

    // 5. Info panel — always show for the chosen race.
    showInfo(race, abilityMods, languages, traits, optionalFeatures);

    // 6. Special abilities. For a monster race (racial HD + a type=creature
    // counterpart) auto-fill the creature's INDIVIDUAL special abilities —
    // richer + per-ability ⓘ-resolvable (including subtype-trait prose like
    // Archon "Aura of Menace") — instead of the walk's coarse bundled traits
    // ("Special Qualities"). PC races keep their per-trait list. Either path
    // tags rows data-from-race so resetWrites cleans them up on a race switch.
    // Spell-Like Abilities → dedicated SLA sub-tab (structured `spell_likes`;
    // a variant inherits the base race's when it carries none of its own).
    // Push-based: inject real rows tagged "Race: <name>" so usage state
    // persists, reconciling on every race change (clear the Race: prefix first).
    const slaEntries = buildRaceSLAEntries(parsed, baseParsed, race.name);
    if (typeof SLA !== 'undefined') {
      if (SLA.clearSourcePrefix) SLA.clearSourcePrefix('Race:');
      if (SLA.syncSource && slaEntries.length) {
        SLA.syncSource('Race: ' + race.name, slaEntries);
      }
    }

    const creatureSpecials = (race.racial_hd && race.racial_hd > 0)
      ? creatureAbilityRows(race.name) : [];
    if (creatureSpecials.length) {
      populateCreatureSpecials(creatureSpecials);
    } else {
      // When the SLAs went to the SLA tab, drop the "Spell-Like Abilities"
      // trait from the Special Abilities dump so it isn't double-listed.
      const traitsForSpecials = slaEntries.length
        ? traits.filter((t) => !/spell-?like/i.test((t && t.name) || ''))
        : traits;
      populateSpecialAbilities(traitsForSpecials);
    }

    // Racial skill bonuses are pull-based (skills.js reads
    // getActiveSkillBonuses on recalc), so just invalidate the cache and
    // poke a recalc — app.js listens for race-changed → recalcAll.
    _skillBonusCache = null;
    document.dispatchEvent(new CustomEvent('race-changed'));
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

    // 2. Add the new race's traits — NAME ONLY. The full description is
    // surfaced on demand via the row's ⓘ panel (Feats.renderAbilityRules
    // → renderRacialTraitRules looks the trait up by name against the
    // current race), so dumping the description inline here would be
    // redundant — you'd be carrying the text just to render the same text.
    for (const t of traits) {
      // Skip empty/duplicative entries (Darkvision/Low-Light Vision are
      // expressed elsewhere in the info panel; skip if the description
      // is empty AND the name is one of those known fields). Also skip
      // any nameless trait — without a name the ⓘ panel can't resolve it.
      const skipNames = new Set(['Darkvision', 'Low-Light Vision']);
      if (skipNames.has(t.name) && !t.description) continue;
      if (!t.name || !String(t.name).trim()) continue;
      const text = t.name;
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

  // For a monster race, pull the matching creature's INDIVIDUAL special
  // abilities (attacks + qualities) — the per-ability data the walk's bundled
  // race traits flatten. Returns a de-duped, ordered name list ([] when no
  // creature counterpart or no specials). The ⓘ resolver renders each against
  // the creature entry + its subtype-trait rules (Archon Traits, …).
  function creatureAbilityRows(name) {
    if (!name || !window.DB || !DB.isLoaded || !DB.isLoaded()) return [];
    const cre = DB.queryOne(
      "SELECT json_extract(data, '$.special_attacks') AS sa, " +
      "  json_extract(data, '$.special_qualities') AS sq " +
      "FROM entry WHERE type='creature' AND name = ? COLLATE NOCASE " +
      "ORDER BY CASE version WHEN '3.5' THEN 0 ELSE 1 END LIMIT 1", [name]);
    if (!cre) return [];
    const parseList = (s) => {
      if (s == null) return [];
      let v; try { v = JSON.parse(s); } catch (e) { v = s; }
      if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
      if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean);
      return [];
    };
    const seen = new Set(), out = [];
    for (const a of parseList(cre.sa).concat(parseList(cre.sq))) {
      const k = a.toLowerCase();
      if (k && !seen.has(k)) { seen.add(k); out.push(a); }
    }
    return out;
  }

  // Add creature ability rows to the Special Abilities list, tagged
  // data-from-race so resetWrites cleans them up on a race switch.
  function populateCreatureSpecials(list) {
    const container = document.getElementById('special-abilities-container');
    if (!container || typeof Feats?.addSpecialAbility !== 'function') return;
    container.querySelectorAll('[data-from-race="1"]').forEach((node) => {
      const row = node.closest('.feat-row');
      if (row) row.remove();
    });
    for (const text of list) {
      if (!text) continue;
      Feats.addSpecialAbility(String(text));
      const rows = container.querySelectorAll('.feat-row');
      const lastTa = rows[rows.length - 1]?.querySelector('.special-ability-entry');
      if (lastTa) lastTa.setAttribute('data-from-race', '1');
    }
  }

  function showInfo(race, abilityMods, languages, traits, optionalFeatures) {
    const panel = document.getElementById('race-info');
    if (!panel) return;
    const bits = [];

    // Variant-of label — makes it explicit that the traits below combine
    // the base race's kit with this variant's modifications.
    if (race.variant_of) {
      bits.push(`<b>Variant of:</b> ${escapeHtml(race.variant_of)}`);
    }
    // Ability mods
    if (abilityMods.length) {
      const fmt = abilityMods.map(a =>
        `${a.modifier > 0 ? '+' : ''}${a.modifier} ${a.ability}`
      ).join(', ');
      bits.push(`<b>Ability:</b> ${fmt}`);
    }
    // Vision / senses (canonical `senses` list of {sense, range_ft?, multiplier?})
    const vision = formatSenses(race.senses);
    if (vision) bits.push(`<b>Vision:</b> ${vision}`);
    // Favored class
    if (race.favored_class) {
      bits.push(`<b>Favored Class:</b> ${escapeHtml(race.favored_class)}`);
    }
    // Level adjustment
    if (race.level_adjustment) {
      bits.push(`<b>LA:</b> +${race.level_adjustment}`);
    }
    // Racial HD — monster races carry extra racial Hit Dice on top of class
    // levels (Ogre = 4d8 Giant); racial_hd 0 (PC-style races) shows nothing.
    if (race.racial_hd && race.racial_hd_die) {
      const t = race.racial_hd_type ? ` ${escapeHtml(race.racial_hd_type)}` : '';
      bits.push(
        `<b>Racial HD:</b> ${race.racial_hd}d${race.racial_hd_die}${t}`
      );
    }
    // Structured defenses (SR / DR / immunities / resistances)
    const defBits = [];
    if (race.spell_resistance != null) defBits.push(`SR ${race.spell_resistance}`);
    if (race.damage_reduction && race.damage_reduction.length)
      defBits.push('DR ' + race.damage_reduction
        .map(d => `${d.amount}/${d.bypass || '—'}`).join(', '));
    if (race.immunities && race.immunities.length)
      defBits.push(`Immune ${race.immunities.join(', ')}`);
    if (race.resistances && race.resistances.length)
      defBits.push('Resist ' + race.resistances
        .map(r => `${r.damage_type} ${r.amount}`).join(', '));
    if (defBits.length) bits.push(`<b>Defenses:</b> ${escapeHtml(defBits.join('; '))}`);
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
    // Optional Features — additive racial-trait menu (RotD web-enhancement
    // kobold options). Independently selectable + combinable + inherited by
    // every kobold variant. Shown distinctly from the always-on traits.
    if (Array.isArray(optionalFeatures) && optionalFeatures.length) {
      const of_html = optionalFeatures.map(f => {
        const desc = (f.description || '').replace(/"/g, '&quot;');
        return `<span class="race-optfeat-chip" data-optfeat="${escapeHtml(f.name)}" ` +
               `title="${desc}" role="button" tabindex="0" ` +
               `style="cursor:pointer; border:1px solid #6a8a6a; border-radius:3px; ` +
               `padding:0 .35em; margin:0 .15em; display:inline-block;">` +
               `+ ${escapeHtml(f.name)}</span>`;
      }).join(' ');
      bits.push(`<b>Optional Features:</b> ${of_html}` +
        ` <span style="opacity:.6">(click to add)</span>`);
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

  // Apply an optional racial feature onto the character: append it to the
  // Feats-tab Special Abilities list. This is OPT-IN — optional features are
  // deliberately NOT part of the auto-populated always-on racial traits. The
  // full verbatim text goes inline so the row is self-contained; the feats.js
  // ⓘ resolver does NOT resolve optional features (they live in
  // `optional_features`, not `traits`), so no confusing cross-lookup surfaces.
  // De-dupes by feature name.
  function addOptionalFeatureToCharacter(name) {
    const want = (name || '').trim().toLowerCase();
    const feat = (_currentOptionalFeatures || []).find(
      f => f && (f.name || '').trim().toLowerCase() === want
    );
    if (!feat) return;
    if (typeof Feats === 'undefined' || typeof Feats.addSpecialAbility !== 'function') {
      flashOptFeatNote('Feats module not ready.', true);
      return;
    }
    // De-dupe: skip if a Special Abilities row already leads with this name
    // (first line up to a ": " separator — the same key the ⓘ resolver uses).
    const container = document.getElementById('special-abilities-container');
    const already = container && Array.from(
      container.querySelectorAll('.special-ability-entry')
    ).some(ta => {
      const first = (ta.value || '').split(/\r?\n/)[0].split(/:\s/)[0].trim().toLowerCase();
      return first === feat.name.trim().toLowerCase();
    });
    if (already) { flashOptFeatNote(`${feat.name} already added.`); return; }
    // The book prints each trait's text leading with its own "Label: …". Drop
    // that leading label when it duplicates the (possibly disambiguated) feature
    // name, so the row isn't "Slight Build\nSlight Build: …". Only strips when
    // the label is a prefix of the name, so unrelated leading clauses survive.
    let desc = (feat.description || '').trim();
    const m = desc.match(/^([^:\n]{1,40}):\s+/);
    if (m && feat.name.trim().toLowerCase().startsWith(m[1].trim().toLowerCase())) {
      desc = desc.slice(m[0].length);
    }
    Feats.addSpecialAbility(`${feat.name}\n${desc}`);
    flashOptFeatNote(`Added ${feat.name} to Special Abilities.`);
  }

  // Transient status note appended under the race info panel (mirrors
  // deity-picker's flashChipNote). Cleared on a timer; also wiped whenever
  // showInfo re-renders the panel.
  function flashOptFeatNote(msg, warn) {
    const panel = document.getElementById('race-info');
    if (!panel) return;
    let note = panel.querySelector('.race-optfeat-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'race-optfeat-note';
      note.style.cssText = 'margin-top:.35em; font-size:.9em;';
      panel.appendChild(note);
    }
    note.textContent = msg;
    note.style.color = warn ? '#d88' : '#8a8';
    clearTimeout(note._t);
    note._t = setTimeout(() => { if (note && note.parentElement) note.textContent = ''; }, 2500);
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

  // Render the canonical `senses` list into a compact human string.
  // Each sense is {sense, range_ft?, multiplier?}: range-based senses
  // (darkvision / blindsense / blindsight / tremorsense) show their feet;
  // low-light vision shows ×N when superior; scent has no range.
  function formatSenses(senses) {
    if (!Array.isArray(senses) || !senses.length) return '';
    const parts = [];
    for (const s of senses) {
      if (!s || !s.sense) continue;
      switch (s.sense) {
        case 'darkvision':
          parts.push(`darkvision${s.range_ft ? ` ${s.range_ft} ft.` : ''}`);
          break;
        case 'low_light_vision':
          parts.push('low-light vision'
            + (s.multiplier && s.multiplier >= 4 ? ' (×4)' : ''));
          break;
        case 'blindsense':
        case 'blindsight':
        case 'tremorsense':
          parts.push(`${s.sense.replace('_', '-')}`
            + (s.range_ft ? ` ${s.range_ft} ft.` : ''));
          break;
        case 'scent':
          parts.push('scent');
          break;
        default:
          parts.push(String(s.sense).replace(/_/g, ' '));
      }
    }
    return parts.join(', ');
  }

  // --- Variant (environmental) race inheritance ---------------------------
  // UA variant races store a "standard <base> racial traits …" pointer trait
  // instead of duplicating the base's descriptive traits / senses / natural
  // armor. We resolve the base race at pick time and fold those in. The
  // base name is the capture group of this pattern; feats.js re-derives it
  // the same way for the ⓘ resolver, so keep the two in sync.
  const VARIANT_BASE_RE = /\b(?:all\s+)?standard\s+(.+?)\s+racial\s+traits/i;

  // Return the base race name a variant points at, or null. Reads the
  // pointer out of a traits list (canonical {name, description} shape).
  function variantBaseName(traits) {
    if (!Array.isArray(traits)) return null;
    for (const t of traits) {
      const m = VARIANT_BASE_RE.exec((t && t.name) || '');
      if (m) return m[1].trim();
    }
    return null;
  }

  function isVariantPointer(trait) {
    return !!(trait && VARIANT_BASE_RE.test((trait.name) || ''));
  }

  // Resolve a variant's base race to {name, data} (parsed JSON), or null
  // when `parsed` isn't a variant / the base can't be found. Reuses the
  // picker's own raceIndex so resolution matches what the user could pick
  // (3.5-preferred, newest source).
  function resolveVariantBase(parsed) {
    // Explicit structured link (`variant_of`, a bare base-race name) wins;
    // fall back to the legacy "standard <base> racial traits" pointer trait.
    const baseName = (parsed && typeof parsed.variant_of === 'string'
      && parsed.variant_of.trim())
      ? parsed.variant_of.trim()
      : variantBaseName(parsed && parsed.traits);
    if (!baseName) return null;
    const baseId = raceIndex.get(baseName.toLowerCase());
    if (baseId === undefined) return null;
    const brow = DB.queryOne('SELECT name, data FROM entry WHERE id = ?', [baseId]);
    if (!brow) return null;
    let bdata = {};
    try { bdata = JSON.parse(brow.data || '{}'); }
    catch (e) { return null; }
    return { name: brow.name, data: bdata };
  }

  // Variant senses are FULL-when-present, not additive: every UA variant
  // that lists its own senses lists the complete set ([low_light_vision]),
  // replacing the base's (the bright-environment variants trade darkvision
  // FOR low-light — "replaces darkvision"). So if the variant carries any
  // senses, those are authoritative; otherwise inherit the base's wholesale
  // (Arctic Kobold has no senses of its own and is still a darkvision race).
  // Contrast with bonuses (mergeBonuses), which ARE delta-style.
  function mergeSenses(variantSenses, baseSenses) {
    const v = Array.isArray(variantSenses) ? variantSenses.filter(s => s && s.sense) : [];
    if (v.length) return v;
    return Array.isArray(baseSenses) ? baseSenses.filter(s => s && s.sense) : [];
  }

  // Concatenate variant bonuses ahead of the base's. naturalArmorFromBonuses
  // returns the first natural-armor match, so the variant's value (if any)
  // wins and the base's is the fallback.
  function mergeBonuses(variantBonuses, baseBonuses) {
    return [].concat(
      Array.isArray(variantBonuses) ? variantBonuses : [],
      Array.isArray(baseBonuses) ? baseBonuses : []
    );
  }

  // Build the displayed trait list. For a variant race: base traits first,
  // then the variant's own modification traits, dropping the "standard
  // <base> racial traits" pointer (the base traits it points at are now
  // shown explicitly). Dedup by lowercased name with the variant winning,
  // so a restated trait shows the variant's version once. For a normal race
  // (baseData null) this is just the race's own traits, pointer-free.
  function buildTraitList(parsedTraits, baseData) {
    const norm = (t) => ({
      name: (t && t.name) || '',
      description: (t && t.description) || '',
      tag: (t && t.tag) || null,
    });
    const variantTraits = (Array.isArray(parsedTraits) ? parsedTraits : [])
      .filter(t => !isVariantPointer(t))
      .map(norm);
    if (!baseData) return variantTraits;
    const variantNames = new Set(
      variantTraits.map(t => t.name.trim().toLowerCase()).filter(Boolean));
    const baseTraits = (Array.isArray(baseData.traits) ? baseData.traits : [])
      .filter(t => !variantNames.has(((t && t.name) || '').trim().toLowerCase()))
      .map(norm);
    return baseTraits.concat(variantTraits);
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

  // Pull a monster race's racial natural-armor bonus out of `bonuses`. The
  // canonical shape is {bonus_type:'ac', bonus_category:'natural', target:
  // 'natural armor', amount:N} — distinct from other AC bonuses, so match on
  // the category/target, not bonus_type alone (extractBonus is too coarse).
  function naturalArmorFromBonuses(bonuses) {
    if (!Array.isArray(bonuses)) return null;
    for (const b of bonuses) {
      if (!b || b.bonus_type !== 'ac') continue;
      const cat = String(b.bonus_category || '').toLowerCase();
      const tgt = String(b.target || '').toLowerCase();
      if (cat === 'natural' || tgt.includes('natural')) {
        return (b.amount != null) ? b.amount : null;
      }
    }
    return null;
  }

  // Ownership helpers for SHARED fields (#ac-natural is also touched by
  // equipment, monster-class extensions, and manual entry). Write only when
  // the field is empty or already race-owned; mark ownership so resetWrites
  // clears exactly what the race wrote and leaves foreign/manual values
  // intact. Mirrors the creature-race-picker's setOwnedOrEmpty/clearOwned.
  const RACE_OWN = 'raceOwned';   // dataset key → data-race-owned attribute
  function raceSetOwned(id, value, evt, treatZeroAsEmpty) {
    const el = document.getElementById(id);
    if (!el) return false;
    const owned = !!el.dataset[RACE_OWN];
    const raw = String(el.value).trim();
    const empty = !raw || (treatZeroAsEmpty && raw === '0');
    if (owned || empty) {
      el.value = value;
      el.dataset[RACE_OWN] = '1';
      el.dispatchEvent(new Event(evt, { bubbles: true }));
      return true;
    }
    return false;
  }
  function raceClearOwned(id, val, evt) {
    const el = document.getElementById(id);
    if (el && el.dataset[RACE_OWN]) {
      el.value = val;
      delete el.dataset[RACE_OWN];
      el.dispatchEvent(new Event(evt, { bubbles: true }));
    }
  }
  // #defense-notes is shared free text that may hold user content. The race's
  // immunities/resistances go in as a single tagged line, tracked verbatim so a
  // race switch removes exactly that line and leaves manual notes intact.
  function raceSetDefenseNotes(text) {
    const el = document.getElementById('ac-defense-notes');
    if (!el) return;
    if (el.dataset.raceDefNote) raceClearDefenseNotes();   // re-apply cleanly
    const seg = `[Race] ${text}`;
    const cur = String(el.value).trim();
    el.value = cur ? `${cur}\n${seg}` : seg;
    el.dataset.raceDefNote = seg;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function raceClearDefenseNotes() {
    const el = document.getElementById('ac-defense-notes');
    if (!el || !el.dataset.raceDefNote) return;
    const seg = el.dataset.raceDefNote;
    el.value = String(el.value)
      .split('\n').filter(line => line !== seg).join('\n').replace(/\n+$/, '');
    delete el.dataset.raceDefNote;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Tier 2 — auto-spawn caster panels for a race's `racial_casting` (a racial
  // use of a class subsystem: Valkyrie's swordsage initiation at IL 10, a
  // creature "as a 7th-level sorcerer"). Spawn-only for now — the panel seeds
  // at the racial BASE level; live stacking (level = base + class levels) is
  // the next step. Panels are tracked + torn down on a race switch.
  const raceCasterPanels = [];
  const SUBSYSTEM_TO_CASTER = {
    maneuvers: 'maneuvers', spells: 'spellcasting',
    powers: 'psionics', invocations: 'invocations',
  };
  function spawnRacialCasterPanels(parsed) {
    if (typeof Spells === 'undefined' || typeof Spells.addCaster !== 'function') return;
    const list = Array.isArray(parsed.racial_casting) ? parsed.racial_casting : [];
    let spawnedManeuvers = false;
    list.forEach((rc) => {
      const casterType = SUBSYSTEM_TO_CASTER[rc.subsystem];
      if (!casterType) return;
      const cls = rc.as_class
        ? rc.as_class.replace(/\b\w/, (c) => c.toUpperCase()) : '';
      const kind = rc.subsystem === 'maneuvers' ? 'Maneuvers' : 'Casting';
      const data = { name: `${cls ? cls + ' ' : ''}${kind} (racial)` };
      // Notes = the as_class so the class-picker's findExistingCasterPanel
      // reuses THIS panel when that class is applied (the merge), instead of
      // spawning a duplicate. Category casting (no as_class) stays standalone.
      if (rc.as_class) data.notes = rc.as_class.toLowerCase();
      if (rc.subsystem === 'maneuvers') data.initLevel = rc.level;
      else if (rc.subsystem === 'powers') data.manifesterLevel = rc.level;
      const idx = Spells.addCaster(casterType, data);
      raceCasterPanels.push(idx);
      const panel = document.getElementById(`caster-${idx}`);
      if (panel) {
        // Mark race-owned + carry the stacking metadata the class-picker's
        // racial pass reads (IL = racialBase + stacks_with class levels).
        panel.dataset.fromRace = '1';
        panel.dataset.racialBase = String(rc.level);
        panel.dataset.racialAsClass = rc.as_class || '';
        panel.dataset.racialStacksWith = rc.stacks_with || '';
      }
      if (rc.subsystem === 'maneuvers') {
        spawnedManeuvers = true;
        if (parsed.maneuvers_and_stances) preloadManeuvers(idx, parsed.maneuvers_and_stances);
      }
    });
    // Stack onto any pre-existing class levels immediately (e.g. a Valkyrie
    // applied on top of swordsage levels already on the sheet).
    if (spawnedManeuvers && window.ClassPicker
        && typeof ClassPicker.refreshManeuverTabs === 'function') {
      ClassPicker.refreshManeuverTabs();
    }
  }
  function preloadManeuvers(idx, ms) {
    const panel = document.getElementById(`caster-${idx}`);
    if (!panel) return;
    const fill = (items, sel) => (items || []).forEach((it) => {
      const m = /^(.*?)\s*\((\d+)(?:st|nd|rd|th)\)\s*$/.exec(it);
      const name = m ? m[1].trim() : it.replace(/\s*\([^)]*\)\s*$/, '').trim();
      const lvl = m ? m[2] : '1';
      const ta = panel.querySelector(`${sel}[data-lvl="${lvl}"]`);
      if (ta) ta.value = (ta.value ? ta.value + '\n' : '') + name;
    });
    fill(ms.strikes, '.tom-maneuver-text');
    fill(ms.boosts, '.tom-maneuver-text');
    fill(ms.counters, '.tom-maneuver-text');
    fill(ms.stances, '.tom-stance-text');
  }
  function teardownRaceCasterPanels() {
    if (typeof Spells !== 'undefined' && typeof Spells.removeCaster === 'function') {
      // Query the DOM (not just the in-memory array) so panels restored from a
      // SAVE — which aren't in raceCasterPanels — also tear down on a race switch.
      document.querySelectorAll('#spells-content [data-caster-type][data-from-race]')
        .forEach((panel) => Spells.removeCaster(panel.id.replace(/^caster-/, '')));
    }
    raceCasterPanels.length = 0;
  }

  // Reset everything race-picker auto-writes: the 6 Race ability columns
  // and the special-ability rows it tagged (data-from-race). Exposed via
  // window.RacePicker so race-unify's shared teardown can wipe race
  // writes before a creature-race applies on the unified Race field (and
  // vice versa) — without it, switching would leave stale ability mods on
  // the abilities the new pick doesn't touch.
  function resetWrites() {
    ['str', 'dex', 'con', 'int', 'wis', 'cha'].forEach((a) => {
      const el = document.getElementById(`${a}-race`);
      if (el && String(el.value) !== '') {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    // Natural armor we applied for a monster race (race-owned only — a
    // manual / equipment / monster-class value has no RACE_OWN marker and
    // survives). 0 is the unset default for #ac-natural.
    raceClearOwned('ac-natural', '0', 'input');
    // Structured defenses we applied (race-owned only — manual SR/DR survives).
    raceClearOwned('spell-resistance', '', 'input');
    raceClearOwned('damage-reduction', '', 'input');
    raceClearDefenseNotes();
    // Structured riders we applied. clearSource is keyed by source, so a
    // hand-added rider — or one the player edited, which drops the marker —
    // survives a race change. Sweeps ANY race:* key rather than just the
    // current race's, so a mid-session rename can't strand rows.
    if (typeof DefenseRiders !== 'undefined') {
      for (const key of DefenseRiders.sourceKeys()) {
        if (key.startsWith('race:')) DefenseRiders.clearSource(key);
      }
    }
    // Auto-spawned racial caster panels (Valkyrie maneuvers etc.).
    teardownRaceCasterPanels();
    const c = document.getElementById('special-abilities-container');
    if (c) {
      c.querySelectorAll('[data-from-race="1"]').forEach((node) => {
        const row = node.closest('.feat-row');
        if (row) row.remove();
      });
    }
    // Drop any race-injected Spell-Like Ability rows (covers race→creature /
    // race→other teardown; race→race is also handled in onRaceChosen).
    if (typeof SLA !== 'undefined' && SLA.clearSourcePrefix) {
      SLA.clearSourcePrefix('Race:');
    }
    // Race cleared / switched away — drop its skill bonuses on the next recalc.
    _skillBonusCache = null;
    document.dispatchEvent(new CustomEvent('race-changed'));
  }

  // ============================================================
  // Racial skill bonuses (consumed by skills.js recalc)
  // ============================================================
  // Parse the variant-only "No racial bonus on X" negation traits into a
  // list of lower-cased skill fragments. Free-text → best-effort. A
  // fragment that matches no inherited bonus is a no-op (the base never
  // granted it), so we don't fabricate notes for those.
  function parseSkillNegations(traits) {
    const out = [];
    if (!Array.isArray(traits)) return out;
    const re = /no\s+(?:\+?\d+\s+)?racial bonus on\s+([^.;]+?)(?:\s+checks?)?\s*(?:[.;]|$)/gi;
    for (const t of traits) {
      const text = (((t && t.name) || '') + '. ' + ((t && t.description) || ''));
      let m;
      while ((m = re.exec(text)) !== null) {
        m[1].split(/\s*(?:,|\bor\b|\band\b)\s*/i).forEach((part) => {
          const s = part.trim().toLowerCase().replace(/\s+checks?$/, '').trim();
          // Drop non-skill negations (attacks / saves / etc.); they can't
          // match a skill bonus anyway, and excluding them keeps intent clear.
          if (s && !/\b(attack|damage|saving|save|initiative|will|fort|ref|armor)\b/.test(s)) {
            out.push(s);
          }
        });
      }
    }
    return out;
  }

  // Remove negated skills from a categorized result. Matches by full name,
  // or — for a subtyped negation like "Profession (mining)" vs an inherited
  // "Profession (miner)" — by base skill name, so the book's wording
  // mismatch doesn't leak a bonus the variant explicitly drops.
  function applySkillNegations(cat, negations) {
    if (!negations || !negations.length) return cat;
    const baseOf = (s) => s.replace(/\s*\(.*\)\s*$/, '').trim();
    for (const neg of negations) {
      const negBase = baseOf(neg);
      if (neg in cat.direct) {
        delete cat.direct[neg];
      } else {
        Object.keys(cat.direct).forEach((k) => {
          if (k === negBase || baseOf(k) === negBase) delete cat.direct[k];
        });
      }
      cat.situational = cat.situational.filter((s) => {
        const sl = s.skill.toLowerCase();
        return !(sl === neg || sl === negBase || baseOf(sl) === negBase);
      });
    }
    return cat;
  }

  function computeRaceSkillBonuses(typedName) {
    const empty = { direct: {}, global: 0, situational: [] };
    const name = (typedName || '').trim()
      .replace(/\s*\(3\.0\)\s*$/, '').replace(/\s*\(3\.5\)\s*$/, '');
    if (!name) return empty;
    const raceId = raceIndex.get(name.toLowerCase());
    if (raceId === undefined) return empty;
    const row = DB.queryOne('SELECT data FROM entry WHERE id = ?', [raceId]);
    if (!row) return empty;
    let parsed = {};
    try { parsed = JSON.parse(row.data || '{}'); } catch (e) { return empty; }
    // Variant races inherit the base's skill bonuses (delta model), then
    // negate some via free text — mirror the natural-armor merge.
    const baseParsed = resolveVariantBase(parsed);
    let merged = mergeBonuses(parsed.bonuses, baseParsed && baseParsed.data.bonuses);
    // A stripping template (Wild / wilderness-dweller) removes the base
    // race's RACIAL-category skill modifiers. Filter at the source, where
    // bonus_category is still present (the categorizer drops it). Size-based
    // skill bonuses (small-race Hide etc.) are NOT racial and persist.
    if (Array.isArray(merged) && typeof TemplatePicker !== 'undefined'
        && typeof TemplatePicker.stripsRacialSkillBonuses === 'function'
        && TemplatePicker.stripsRacialSkillBonuses()) {
      merged = merged.filter(b =>
        !(b && b.bonus_type === 'skill' && b.bonus_category === 'racial'));
    }
    const cat = DND35.categorizeSkillBonuses(merged);
    if (baseParsed) applySkillNegations(cat, parseSkillNegations(parsed.traits));
    // Name the source so situational notes read "… (Aquatic Elf)" (mirrors
    // the save path's source tag).
    cat.situational.forEach(s => { s.source = name; });
    return cat;
  }

  // Public: current racial skill bonuses for #char-race. Pull-based (reads
  // the live field) so a save/reload picks it up on the post-load recalc
  // with no persisted state. Cached by race name to keep per-keystroke
  // recalc cheap; the cache is dropped in populate() (DB-ready + book
  // filter) and on apply/clear. Returns the empty shape UNCACHED until the
  // DB is ready, so it self-heals once the catalog exists.
  function getActiveSkillBonuses() {
    if (typeof DB === 'undefined' || !DB.isLoaded || !DB.isLoaded()) {
      return { direct: {}, global: 0, situational: [] };
    }
    const input = document.getElementById('char-race');
    const name = ((input && input.value) || '').trim();
    // Cache key folds in the template strip-state so applying/removing a
    // stripping template (Wild) busts the cache for the same race name.
    const strip = (typeof TemplatePicker !== 'undefined'
      && typeof TemplatePicker.stripsRacialSkillBonuses === 'function')
      ? TemplatePicker.stripsRacialSkillBonuses() : false;
    const key = `${name}|strip:${strip}`;
    if (_skillBonusCache && _skillBonusCache.key === key) return _skillBonusCache.result;
    const result = computeRaceSkillBonuses(name);
    _skillBonusCache = { key, result };
    return result;
  }

  // Public: current racial SAVE bonuses for #char-race, same pull-based
  // model as getActiveSkillBonuses. Returns {fort, ref, will, situational}
  // — unconditional bonuses stacked into fort/ref/will, conditional ones in
  // `situational` (each tagged with the save it applies to).
  function computeRaceSaveBonuses(typedName) {
    const empty = { direct: { fort: [], ref: [], will: [] }, situational: [] };
    const name = (typedName || '').trim()
      .replace(/\s*\(3\.0\)\s*$/, '').replace(/\s*\(3\.5\)\s*$/, '');
    if (!name) return empty;
    const raceId = raceIndex.get(name.toLowerCase());
    if (raceId === undefined) return empty;
    const row = DB.queryOne('SELECT data FROM entry WHERE id = ?', [raceId]);
    if (!row) return empty;
    let parsed = {};
    try { parsed = JSON.parse(row.data || '{}'); } catch (e) { return empty; }
    const baseParsed = resolveVariantBase(parsed);
    const merged = mergeBonuses(parsed.bonuses, baseParsed && baseParsed.data.bonuses);
    if (typeof DND35 === 'undefined' || !DND35.categorizeSaveBonuses) return empty;
    const cat = DND35.categorizeSaveBonuses(merged);
    cat.situational.forEach(s => { s.source = name; });
    return cat;
  }
  function getActiveSaveBonuses() {
    if (typeof DB === 'undefined' || !DB.isLoaded || !DB.isLoaded()) {
      return { direct: { fort: [], ref: [], will: [] }, situational: [] };
    }
    const input = document.getElementById('char-race');
    return computeRaceSaveBonuses(((input && input.value) || '').trim());
  }

  // Public: current racial AC bonuses for #char-race (dodge/deflection/luck/
  // …; natural + size are excluded — handled by #ac-natural / #char-size).
  // Returns {items, situational} in the AC-onion's protItem shape.
  function getActiveACBonuses() {
    const empty = { items: [], situational: [] };
    if (typeof DB === 'undefined' || !DB.isLoaded || !DB.isLoaded()) return empty;
    if (typeof DND35 === 'undefined' || !DND35.categorizeACBonuses) return empty;
    const input = document.getElementById('char-race');
    const name = ((input && input.value) || '').trim()
      .replace(/\s*\(3\.0\)\s*$/, '').replace(/\s*\(3\.5\)\s*$/, '');
    if (!name) return empty;
    const raceId = raceIndex.get(name.toLowerCase());
    if (raceId === undefined) return empty;
    const row = DB.queryOne('SELECT data FROM entry WHERE id = ?', [raceId]);
    if (!row) return empty;
    let parsed = {};
    try { parsed = JSON.parse(row.data || '{}'); } catch (e) { return empty; }
    const baseParsed = resolveVariantBase(parsed);
    const merged = mergeBonuses(parsed.bonuses, baseParsed && baseParsed.data.bonuses);
    const cat = DND35.categorizeACBonuses(merged);
    cat.items.forEach(i => { i.source = name; });
    cat.situational.forEach(s => { s.source = name; });
    return cat;
  }

  // Racial movement-speed bonuses (effects-aggregator P2). Returns the RAW
  // speed-typed bonus entries for the applied race; app.js concats them with
  // the other sources and categorizes once. Covers both the canonical
  // `bonus_type:'speed'` shape and the ad-hoc racial `*_speed` shapes
  // (Air/Earth/Water Mephling, Lillend, …) whose value sits in `condition`.
  const SPEED_BONUS_TYPES = new Set(["speed", "land_speed", "fly_speed",
    "swim_speed", "burrow_speed", "climb_speed", "fly_while_encumbered"]);
  function getActiveSpeedBonuses() {
    if (typeof DB === 'undefined' || !DB.isLoaded || !DB.isLoaded()) return [];
    const name = ((document.getElementById('char-race') || {}).value || '').trim()
      .replace(/\s*\(3\.0\)\s*$/, '').replace(/\s*\(3\.5\)\s*$/, '');
    if (!name) return [];
    const raceId = raceIndex.get(name.toLowerCase());
    if (raceId === undefined) return [];
    const row = DB.queryOne('SELECT data FROM entry WHERE id = ?', [raceId]);
    if (!row) return [];
    let parsed = {};
    try { parsed = JSON.parse(row.data || '{}'); } catch (e) { return []; }
    const baseParsed = resolveVariantBase(parsed);
    const merged = mergeBonuses(parsed.bonuses, baseParsed && baseParsed.data.bonuses);
    return (Array.isArray(merged) ? merged : [])
      .filter(b => b && SPEED_BONUS_TYPES.has(String(b.bonus_type || '').toLowerCase()))
      .map(b => Object.assign({ source: name }, b));
  }

  // ============================================================
  // Racial Spell-Like Abilities (structured `spell_likes` → SLA tab rows)
  // ============================================================
  function raceCharLevel() {
    const v = parseInt(document.getElementById('char-level')?.value, 10);
    return (isNaN(v) || v < 1) ? 0 : v;
  }
  // Resolve a caster_level_formula to a row value. "character_level" → blank
  // (the row's CL defaults to character level, and stays correct as the PC
  // levels up); a fixed integer → itself; "max(3, 2*HD)" → computed at the
  // current level; anything else → blank.
  function resolveSLACasterLevel(formula) {
    if (formula == null) return '';
    const f = String(formula).trim();
    if (f === 'character_level') return '';
    if (/^\d+$/.test(f)) return f;
    const m = f.match(/^max\(\s*(\d+)\s*,\s*2\s*\*\s*HD\s*\)$/i);
    if (m) return String(Math.max(parseInt(m[1], 10), 2 * (raceCharLevel() || 1)));
    return '';
  }
  // Pull the key ability out of a save_dc_formula ("10 + spell_level + Wis"),
  // defaulting to Cha (the SLA default) when unspecified.
  function resolveSLAAbility(dcFormula) {
    if (!dcFormula) return 'CHA';
    const m = String(dcFormula).match(/\b(Str|Dex|Con|Int|Wis|Cha)\b/i);
    return m ? m[1].toUpperCase() : 'CHA';
  }
  function resolveSLAFreq(frequency) {
    if (!frequency) return '1';
    const f = String(frequency).toLowerCase();
    if (/at\s*will/.test(f)) return 'at will';
    const m = f.match(/(\d+)\s*\/?\s*day/);
    if (m) return m[1];
    if (/^\d+$/.test(f.trim())) return f.trim();
    return '1';
  }
  // Return the first non-empty structured `spell_likes` among ALL same-name
  // race printings (3.5 first). The structured-SLA extraction only covered
  // some books, so the newest printing the picker resolves (e.g. Drow of the
  // Underdark, Planar Handbook) may lack the SLAs that an older one (FRCS)
  // carries. Borrowing keeps the iconic SLA races (Aasimar/Drow/Tiefling)
  // auto-populating until the DB reshape structures every printing; self-heals
  // once they all carry it.
  function siblingSpellLikes(raceName) {
    if (!raceName || typeof DB === 'undefined' || !DB.isLoaded || !DB.isLoaded()) return null;
    let rows;
    try {
      rows = DB.query(
        "SELECT data FROM entry WHERE type='race' AND LOWER(name)=? "
        + "ORDER BY CASE version WHEN '3.5' THEN 0 ELSE 1 END",
        [String(raceName).trim().toLowerCase()]);
    } catch (e) { return null; }
    for (const r of (rows || [])) {
      try {
        const d = JSON.parse(r.data || '{}');
        if (Array.isArray(d.spell_likes) && d.spell_likes.length) return d.spell_likes;
      } catch (e) { /* skip bad row */ }
    }
    return null;
  }

  // Build SLA-tab row entries from a race's structured `spell_likes`. A variant
  // race with no spell_likes of its own inherits the base's (delta model, like
  // natural armor); failing that, borrow from a same-name printing that has
  // them (sibling-fallback). Returns [] when there's no structured SLA data.
  function buildRaceSLAEntries(parsed, baseParsed, raceName) {
    let sl = (parsed && Array.isArray(parsed.spell_likes) && parsed.spell_likes.length)
      ? parsed.spell_likes : null;
    if (!sl && baseParsed && baseParsed.data && Array.isArray(baseParsed.data.spell_likes)
        && baseParsed.data.spell_likes.length) {
      sl = baseParsed.data.spell_likes;
    }
    if (!sl) sl = siblingSpellLikes(raceName);
    if (!Array.isArray(sl) || !sl.length) return [];
    return sl.map((e) => ({
      spell: e.spell_name || '',
      freq: resolveSLAFreq(e.frequency),
      casterLevel: resolveSLACasterLevel(e.caster_level_formula),
      ability: resolveSLAAbility(e.save_dc_formula),
      source: 'Race',
    })).filter((e) => e.spell);
  }

  window.RacePicker = {
    resetWrites, applyByName: onRaceChosen, variantBaseName, getActiveSkillBonuses,
    getActiveSaveBonuses, getActiveACBonuses, getActiveSpeedBonuses,
  };

  // Wait for DB to load, then init.
  DB.ready.then((db) => {
    if (db) init();
  });
})();
