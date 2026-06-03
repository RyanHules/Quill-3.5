// creature-race-picker.js — Pick a Monster Manual creature as a playable
// race, using the `as_character` block extracted from the book's "X as
// Characters" sidebar. Parallels race-picker.js but consumes the creature
// entry's `data.as_character` racial-ADJUSTMENT block instead of a `race`
// entry. Two coordinated parts on pick:
//
//   1. Adjustment layer (mirrors race-picker): racial ability adjustments
//      → the Race column ({abil}-race), size → #char-size, speed →
//      #char-speed, natural armor → #ac-natural, automatic languages →
//      #languages, special attacks / qualities / skill bonuses → Special
//      Abilities. All creature-race writes are tagged so re-picking or
//      clearing reverses them cleanly.
//
//   2. Racial Hit Dice (full integration): when the creature has racial
//      HD (e.g. Bugbear's 3 Humanoid HD), inject a synthetic class row via
//      ClassPicker.addRacialHD so BAB / saves / total level pool through
//      the existing multiclass aggregate exactly like a class. Ability
//      mods / NA / size are applied by part 1 (NOT via monsterExt), so
//      nothing is double-counted. A warning surfaces if a Savage Species
//      monster class for the same creature is already applied.
//
// Level adjustment is shown in the info panel for the player to add to
// their ECL manually — matching how race-picker treats LA (and how the
// multiclass aggregate leaves #char-level for the user to bump).

(function () {
  if (!window.DB) {
    console.warn('[creature-race-picker] DB module not loaded');
    return;
  }

  const ABILITY_INPUTS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const MARK = 'fromCreatureRace';        // dataset key (data-from-creature-race)
  const SA_MARK = 'data-from-creature-race';

  // name(lower) → creature entry id, for creatures that carry an
  // as_character block.
  let crIndex = new Map();
  let crResults = null;

  function init() {
    const input = document.getElementById('char-creature-race');
    if (!input) {
      console.warn('[creature-race-picker] #char-creature-race input not found');
      return;
    }

    let datalist = document.getElementById('creature-race-options');
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = 'creature-race-options';
      input.setAttribute('list', 'creature-race-options');
      input.setAttribute('autocomplete', 'off');
      input.parentElement.appendChild(datalist);
    }

    let infoPanel = document.getElementById('creature-race-info');
    if (!infoPanel) {
      infoPanel = document.createElement('div');
      infoPanel.id = 'creature-race-info';
      infoPanel.className = 'race-info';
      infoPanel.style.cssText =
        'grid-column: 1 / -1; padding: 0.5rem; margin-top: 0.25rem; ' +
        'font-size: 0.85em; color: #ccc; background: rgba(255,255,255,0.04); ' +
        'border-left: 3px solid #8a6a8a; border-radius: 3px; display: none;';
      input.parentElement.parentElement.appendChild(infoPanel);
    }

    let browseWrap = document.getElementById('creature-race-browse');
    if (!browseWrap) {
      browseWrap = document.createElement('div');
      browseWrap.id = 'creature-race-browse';
      browseWrap.style.cssText = 'grid-column: 1 / -1; margin-top: 0.25rem;';
      // Prefer the consolidated "Lookups & Pickers" disclosure; fall back
      // to the info-grid next to the input.
      const host = document.getElementById('creature-race-browse-host')
        || input.parentElement.parentElement;
      host.appendChild(browseWrap);
    }
    crResults = (typeof PickerResults !== 'undefined')
      ? PickerResults.attach(browseWrap, {
          itemNoun: 'creature race',
          // Collapsed by default — one browse open at a time (matches
          // deity + race browse).
          collapsible: true,
          collapsedByDefault: true,
          onPick: (name) => {
            input.value = name;
            onCreatureChosen(name);
            input.focus();
          },
        })
      : null;

    function populate() {
      // Only creatures that carry an `as_character` block are pickable.
      const rows = DB.query(
        "SELECT e.id AS creature_id, e.name, e.version, e.source, "
        + "       b.publication_date "
        + "FROM entry e "
        + "LEFT JOIN book b ON b.name = e.source "
        + "WHERE e.type = 'creature' "
        + "  AND json_extract(e.data, '$.as_character') IS NOT NULL "
        + "ORDER BY e.name, "
        + "         CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, "
        + "         b.publication_date DESC"
      );
      crIndex = new Map();
      datalist.innerHTML = '';
      const browseNames = [];
      let kept = 0;
      for (const r of rows) {
        if (window.BookFilter && !window.BookFilter.allowsEntry(
          { source: r.source, version: r.version, name: r.name,
            type: 'creature' })) continue;
        if (crIndex.has(r.name.toLowerCase())) continue;  // first (recency) wins
        const opt = document.createElement('option');
        opt.value = r.name;
        datalist.appendChild(opt);
        browseNames.push(r.name);
        crIndex.set(r.name.toLowerCase(), r.creature_id);
        kept++;
      }
      if (crResults) {
        crResults.render(browseNames, { typedFilter: input.value.trim() });
      }
      console.log(`[creature-race-picker] ${kept} creature races available`);
    }
    populate();
    document.addEventListener('book-filter-changed', populate);

    input.addEventListener('change', () => onCreatureChosen(input.value));
    input.addEventListener('input', () => {
      if (crResults) {
        const browseNames = Array.from(datalist.options).map(o => o.value);
        crResults.render(browseNames, { typedFilter: input.value.trim() });
      }
      const v = input.value.trim();
      if (!v) { clearCreatureRace(); return; }
      const exact = crIndex.get(v.toLowerCase());
      if (exact !== undefined) onCreatureChosen(input.value);
    });

    // If the synthetic racial-HD chip is removed from the class list
    // directly (chip ×), keep the creature-race UI in sync: when our row
    // is gone, drop the rest of the adjustment layer too.
    document.addEventListener('classes-changed', () => {
      const stillThere = window.ClassPicker && ClassPicker.getState &&
        ClassPicker.getState().some(e => e.racialHD);
      const haveRace = !!document.getElementById('char-creature-race')?.value.trim();
      if (haveRace && !stillThere && activeCreatureHadHD) {
        // The HD row vanished out from under us — clear the picker.
        const inp = document.getElementById('char-creature-race');
        if (inp) inp.value = '';
        clearCreatureRace();
      }
    });
  }

  // Tracks whether the currently-applied creature-race contributed a
  // synthetic HD row (so the classes-changed sync above only fires for
  // racial-HD creatures, not 0-HD ones like Goblin).
  let activeCreatureHadHD = false;

  function onCreatureChosen(typedName) {
    const key = (typedName || '').trim().toLowerCase();
    const id = crIndex.get(key);
    if (id === undefined) { hideInfo(); return; }

    const row = DB.queryOne(
      "SELECT id, name, source, version, creature_type, data "
      + "FROM entry WHERE id = ?", [id]);
    if (!row) return;
    let parsed = {};
    try { parsed = JSON.parse(row.data || '{}'); }
    catch (e) { console.warn('[creature-race-picker] bad data JSON', e); return; }
    const ac = parsed.as_character;
    if (!ac || ac.sourced === false) { hideInfo(); return; }

    applyCreatureRace({
      id: row.id,
      name: row.name,
      source: row.source,
      version: row.version,
      creature_type: row.creature_type || parsed.type || null,
      ac,
    });
  }

  // Reset every write the creature-race owns (also the pre-apply cleanup
  // so re-picking is idempotent). Ability race inputs are reset wholesale
  // (you only have one race); everything else is reset only when WE own it
  // (data-from-creature-race marker), so manual values survive.
  function resetCreatureRaceWrites() {
    for (const a of ABILITY_INPUTS) {
      const el = document.getElementById(`${a}-race`);
      if (el && el.dataset[MARK]) {
        el.value = '';
        delete el.dataset[MARK];
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    clearOwned('ac-natural', '0', 'input');
    clearOwned('char-speed', '', 'input');
    clearOwned('char-type', '', 'input');
    // #char-race cleared SILENTLY (see the apply path) to avoid waking
    // race-picker's autocomplete on our own teardown.
    const raceEl = document.getElementById('char-race');
    if (raceEl && raceEl.dataset[MARK]) {
      raceEl.value = '';
      delete raceEl.dataset[MARK];
    }
    const sizeSel = document.getElementById('char-size');
    if (sizeSel && sizeSel.dataset[MARK]) {
      sizeSel.value = 'Medium';
      delete sizeSel.dataset[MARK];
      sizeSel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // Special Abilities rows we added.
    const cont = document.getElementById('special-abilities-container');
    if (cont) {
      cont.querySelectorAll(`[${SA_MARK}="1"]`).forEach(node => {
        const r = node.closest('.feat-row');
        if (r) r.remove();
      });
    }
    // Synthetic racial-HD row.
    if (window.ClassPicker && typeof ClassPicker.removeRacialHD === 'function') {
      ClassPicker.removeRacialHD();
    }
    activeCreatureHadHD = false;
  }

  function clearOwned(id, val, evt) {
    const el = document.getElementById(id);
    if (el && el.dataset[MARK]) {
      el.value = val;
      delete el.dataset[MARK];
      el.dispatchEvent(new Event(evt, { bubbles: true }));
    }
  }

  // Set a shared field only when it's empty or already owned by us, then
  // mark ownership. Returns true if applied, false if a foreign manual
  // value blocked it (caller can surface a note). `treatZeroAsEmpty` is
  // for numeric fields whose unset default is "0" (e.g. #ac-natural) — a
  // zero there means "no natural armor", so a creature-race may claim it.
  function setOwnedOrEmpty(id, value, evt, treatZeroAsEmpty) {
    const el = document.getElementById(id);
    if (!el) return false;
    const owned = !!el.dataset[MARK];
    const raw = String(el.value).trim();
    const empty = !raw || (treatZeroAsEmpty && raw === '0');
    if (owned || empty) {
      el.value = value;
      el.dataset[MARK] = '1';
      el.dispatchEvent(new Event(evt, { bubbles: true }));
      return true;
    }
    return false;
  }

  function clearCreatureRace() {
    resetCreatureRaceWrites();
    hideInfo();
  }

  function applyCreatureRace(cr) {
    const ac = cr.ac;
    resetCreatureRaceWrites();                 // clean slate (reversible)
    const notApplied = [];

    // 1. Ability adjustments → Race column (reset already cleared ours).
    for (const adj of (ac.ability_adjustments || [])) {
      if (!adj || !adj.ability) continue;
      const el = document.getElementById(`${String(adj.ability).toLowerCase()}-race`);
      if (el) {
        el.value = adj.modifier;
        el.dataset[MARK] = '1';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    // 2. Size (size from a creature-race is authoritative; own it).
    if (ac.size) {
      const sizeSel = document.getElementById('char-size');
      if (sizeSel) {
        sizeSel.value = ac.size;
        sizeSel.dataset[MARK] = '1';
        sizeSel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    // 3. Speed — prefer the explicit prose string (carries fly/swim),
    //    else the base land speed int.
    const speedText = ac.speed ||
      (ac.base_speed_ft != null ? `${ac.base_speed_ft} ft.` : null);
    if (speedText && !setOwnedOrEmpty('char-speed', speedText, 'input')) {
      notApplied.push(`speed (${speedText})`);
    }

    // 4. Natural armor (default field value is "0" → treat as unset).
    if (ac.natural_armor) {
      if (!setOwnedOrEmpty('ac-natural', String(ac.natural_armor), 'input', true)) {
        notApplied.push(`+${ac.natural_armor} natural armor`);
      }
    }

    // 5. Creature type + race-name label fields.
    if (cr.creature_type) {
      setOwnedOrEmpty('char-type', cr.creature_type, 'input');
    }
    // Race label: own it so the canonical Race field reads the creature.
    // Written SILENTLY (no input/change dispatch) so race-picker.js — which
    // listens on #char-race — doesn't treat the creature name as a typed
    // race query and surface a "no matching race" browse message.
    const raceEl = document.getElementById('char-race');
    if (raceEl && (!String(raceEl.value).trim() || raceEl.dataset[MARK])) {
      raceEl.value = cr.name;
      raceEl.dataset[MARK] = '1';
    }

    // 6. Automatic languages — fill only when empty (don't clobber).
    const autoLangs = (ac.automatic_languages || []);
    if (autoLangs.length) {
      const lang = document.getElementById('languages');
      if (lang && !String(lang.value).trim()) {
        lang.value = autoLangs.join(', ');
        lang.dataset[MARK] = '1';
        lang.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    // 7. Special abilities — special attacks + qualities (+ a skill-bonus
    //    summary). Senses go in the info panel (Vision), matching
    //    race-picker. Each row tagged for clean removal.
    const specials = []
      .concat(ac.special_attacks || [])
      .concat(ac.special_qualities || []);
    const bonusSummary = (ac.bonuses || [])
      .filter(b => b && b.target && b.amount != null)
      .map(b => `${b.amount >= 0 ? '+' : ''}${b.amount} ${b.target}` +
        (b.condition ? ` (${b.condition})` : ''));
    if (bonusSummary.length) {
      specials.push(`Racial skill bonuses: ${bonusSummary.join(', ')}`);
    }
    addSpecials(specials);

    // 8. Racial HD → synthetic class row (full integration).
    const rhd = ac.racial_hd || {};
    if (rhd.count && rhd.count > 0 &&
        window.ClassPicker && typeof ClassPicker.addRacialHD === 'function') {
      const prog = (typeof DND35 !== 'undefined' && DND35.creatureTypeToProg)
        ? DND35.creatureTypeToProg(rhd.type) : null;
      if (prog) {
        ClassPicker.addRacialHD({
          creatureRace: cr.name,
          creatureType: rhd.type,
          count: rhd.count,
          prog,
        });
        activeCreatureHadHD = true;
      } else {
        notApplied.push(`${rhd.count} ${rhd.type} racial HD ` +
          `(unknown creature type — add BAB/saves manually)`);
      }
    }

    // 9. Double-count guard (warn, don't block).
    const warnings = [];
    if (window.ClassPicker && typeof ClassPicker.hasMonsterClassFor === 'function'
        && ClassPicker.hasMonsterClassFor(cr.name)) {
      warnings.push(`A Savage Species “${cr.name}” monster class is already ` +
        `applied — its Hit Dice and ability adjustments are now counted ` +
        `twice. Remove one.`);
    }

    showInfo(cr, notApplied, warnings);
  }

  function addSpecials(list) {
    const container = document.getElementById('special-abilities-container');
    if (!container || typeof Feats?.addSpecialAbility !== 'function') return;
    for (const text of list) {
      if (!text) continue;
      Feats.addSpecialAbility(String(text));
      const rows = container.querySelectorAll('.feat-row');
      const lastTa = rows[rows.length - 1]?.querySelector('.special-ability-entry');
      if (lastTa) lastTa.setAttribute(SA_MARK, '1');
    }
  }

  function liveIntMod() {
    const el = document.getElementById('int-mod');
    if (!el) return 0;
    const n = parseInt((el.textContent || el.value || '').replace('+', ''), 10);
    return isNaN(n) ? 0 : n;
  }

  function showInfo(cr, notApplied, warnings) {
    const panel = document.getElementById('creature-race-info');
    if (!panel) return;
    const ac = cr.ac;
    const bits = [];

    if ((ac.ability_adjustments || []).length) {
      const fmt = ac.ability_adjustments.map(a =>
        `${a.modifier > 0 ? '+' : ''}${a.modifier} ${a.ability}`).join(', ');
      bits.push(`<b>Ability:</b> ${fmt}`);
    }
    if (ac.size) bits.push(`<b>Size:</b> ${escapeHtml(ac.size)}`);
    const speedText = ac.speed ||
      (ac.base_speed_ft != null ? `${ac.base_speed_ft} ft.` : '');
    if (speedText) bits.push(`<b>Speed:</b> ${escapeHtml(speedText)}`);
    const vision = formatSenses(ac.senses);
    if (vision) bits.push(`<b>Vision:</b> ${vision}`);
    if (ac.natural_armor) bits.push(`<b>Natural Armor:</b> +${ac.natural_armor}`);

    // Racial HD + derived BAB/saves/feats/skill points.
    const rhd = ac.racial_hd || {};
    if (rhd.count && rhd.count > 0) {
      const type = rhd.type;
      const die = (typeof DND35 !== 'undefined' && DND35.creatureTypes[type])
        ? DND35.creatureTypes[type].hd : null;
      const hdStr = die ? `${rhd.count}d${die}` : `${rhd.count} HD`;
      let derived = '';
      if (typeof DND35 !== 'undefined' && DND35.creatureBABAtHD) {
        const bab = DND35.creatureBABAtHD(type, rhd.count);
        const f = DND35.creatureSaveAtHD(type, rhd.count, 'Fort');
        const r = DND35.creatureSaveAtHD(type, rhd.count, 'Ref');
        const w = DND35.creatureSaveAtHD(type, rhd.count, 'Will');
        const feats = DND35.creatureFeatCount(rhd.count);
        const sp = DND35.creatureSkillPoints(type, rhd.count, liveIntMod());
        derived = ` — BAB +${bab}, Fort +${f} / Ref +${r} / Will +${w}, ` +
          `${feats} feat${feats === 1 ? '' : 's'}, ${sp} skill pts`;
      }
      bits.push(`<b>Racial HD:</b> ${hdStr} (${escapeHtml(type)})${derived} ` +
        `<span style="opacity:0.7">[applied as a class row — roll HP for these HD]</span>`);
    }

    if (ac.level_adjustment != null) {
      bits.push(`<b>LA:</b> +${ac.level_adjustment} ` +
        `<span style="opacity:0.7">(add to your ECL / Total Level manually)</span>`);
    }
    if (ac.favored_class) {
      bits.push(`<b>Favored Class:</b> ${escapeHtml(ac.favored_class)}`);
    }
    const bonusLangs = ac.bonus_languages || [];
    if (bonusLangs.length) {
      bits.push(`<b>Bonus Languages:</b> ${escapeHtml(bonusLangs.join(', '))}`);
    }
    if (ac.notes) {
      bits.push(`<b>Notes:</b> ${escapeHtml(ac.notes)}`);
    }
    if (notApplied && notApplied.length) {
      bits.push(`<span style="color:#caa">⚠ not auto-applied (you have a ` +
        `manual value): ${escapeHtml(notApplied.join('; '))}</span>`);
    }
    if (warnings && warnings.length) {
      for (const w of warnings) {
        bits.push(`<span style="color:#c88">⚠ ${escapeHtml(w)}</span>`);
      }
    }

    panel.innerHTML = bits.join(' &nbsp;·&nbsp; ');
    if (window.ErrataBadge) {
      ErrataBadge.attach(panel, cr.id, { position: 'prepend', applied: false });
    }
    if (window.VersionBadge) VersionBadge.attach(panel, cr.version);
    panel.style.display = bits.length ? 'block' : 'none';
  }

  function hideInfo() {
    const panel = document.getElementById('creature-race-info');
    if (panel) panel.style.display = 'none';
  }

  function formatSenses(senses) {
    if (!Array.isArray(senses) || !senses.length) return '';
    const parts = [];
    for (const s of senses) {
      if (!s || !s.sense) continue;
      switch (s.sense) {
        case 'darkvision':
          parts.push(`darkvision${s.range_ft ? ` ${s.range_ft} ft.` : ''}`); break;
        case 'low_light_vision':
          parts.push('low-light vision' +
            (s.multiplier && s.multiplier >= 4 ? ' (×4)' : '')); break;
        case 'blindsense':
        case 'blindsight':
        case 'tremorsense':
          parts.push(`${s.sense.replace('_', '-')}` +
            (s.range_ft ? ` ${s.range_ft} ft.` : '')); break;
        case 'scent':
          parts.push('scent'); break;
        default:
          parts.push(String(s.sense).replace(/_/g, ' '));
      }
    }
    return parts.join(', ');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  DB.ready.then((db) => { if (db) init(); });
})();
