// audit.js — Floating Character Audit widget.
//
// A header-bar button (next to the universal-lookup ❔ button) whose
// icon reflects the worst-severity issue currently present on the
// sheet: green ✓ when clean, cyan ⓘ when info-only, amber ⚠ when
// warnings exist, red ✗ when errors exist. Click to open a popover
// listing every active issue grouped by severity, with a "Dismiss"
// button on each one so the user can acknowledge known oddities
// (custom races, DM rulings, homebrew not yet in the DB) without
// retraining themselves to ignore the panel.
//
// Updates via a global `audit-refresh` event dispatched from
// `recalcAll()` so checks reflect the current state across all
// tabs (skills, equipment, spells, conditions).
//
// Severity buckets:
//   error   — rule-illegal: HP > max, spell slots over-prepared,
//             skill ranks above absolute cap (char_level + 3),
//             known spells over per-level cap.
//   warning — suspect-but-legal: encumbrance over light, base
//             ability score above 18 (a high *base* almost always
//             indicates a build choice worth flagging; total can
//             legitimately exceed 18 via racial mods, so we check
//             base specifically per the player's note).
//   info    — advisory: spells prepared == max (no flex room).
//
// Dismissed issues — and muted issue FAMILIES — persist via
// `Audit.collectData/loadData` (`{ auditDismissed: [id, …],
// auditMuted: [family, …] }`).

const Audit = (function () {
  // Dismissed issue IDs survive across recalc but are wiped on
  // new-character / load. Sealed as a Set for cheap membership tests.
  const dismissed = new Set();

  // Muted issue FAMILIES — "stop telling me this KIND of thing about this
  // character" (report rmszxyryb-l93o, filed against the every-slot-filled
  // advisory). Dismissing by id only silences one caster at one level, so a
  // wizard who deliberately preps to the brim has to dismiss it nine times,
  // and again for every new caster. A family mute is the toggle that asks
  // for. Persisted alongside the dismissals.
  const muted = new Set();

  // An issue id is `family:instance…` — "caster:prepared-full:Wizard:3"
  // mutes as "caster:prepared-full". Ids of only two segments
  // ("m7:hp-not-set") are already whole families.
  function familyOf(issue) {
    if (issue.family) return issue.family;
    const parts = String(issue.id || '').split(':');
    return parts.length > 2 ? parts.slice(0, 2).join(':') : String(issue.id || '');
  }

  // Human-readable names for the mute bar. Unlisted families fall back to
  // their id fragment, which is ugly but never wrong.
  const FAMILY_LABELS = {
    'caster:prepared-full': 'prepared list fills every slot',
    'caster:over-prepared': 'over-prepared',
    'caster:over-used': 'more slots used than available',
    'caster:over-known': 'over the spells-known cap',
  };

  let triggerBtn = null;
  let popoverEl = null;

  // ---- Check implementations -----------------------------------------

  function int(v) { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
  function flt(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

  // Helper: read all input values needed across checks once, so we
  // don't re-query the DOM 20 times.
  function snapshot() {
    const s = {};
    s.charLevel    = int(document.getElementById('char-level')?.value) || 1;
    // The character's OWN max-rank cap, as the Skills tab computes and
    // displays it. That figure already folds in anything that raises the
    // ceiling beyond the textbook charLevel + 3 — today UA bloodline
    // levels (K1), and whatever lands there next. Auditing against the
    // generic formula instead flagged legal ranks as illegal on every
    // bloodline character. Falls back to the formula when the field
    // hasn't rendered yet.
    s.maxClassRanks =
      int(document.getElementById('max-class-ranks')?.textContent) ||
      (s.charLevel + 3);
    s.hpMax        = int(document.getElementById('hp-total')?.value);
    s.hpCurrent    = int(document.getElementById('hp-current')?.value);
    s.loadCategory = document.getElementById('load-category')?.textContent?.toLowerCase() || '';
    s.totalWeight  = flt(document.getElementById('total-weight')?.textContent);
    // Base ability scores (manually entered, before racial / template mods).
    s.baseAbilities = {};
    for (const ab of ['str','dex','con','int','wis','cha']) {
      s.baseAbilities[ab.toUpperCase()] = int(document.getElementById(`${ab}-score`)?.value);
    }
    // Skills snapshot: every .skill-ranks input.
    s.skills = [];
    s.totalSkillRanks = 0;
    for (const inp of document.querySelectorAll('.skill-ranks')) {
      const ranks = flt(inp.value);
      s.totalSkillRanks += ranks;
      if (ranks <= 0) continue;
      const row = inp.closest('tr');
      const name = row?.querySelector('.skill-name')?.textContent?.trim() || '?';
      s.skills.push({ name, ranks });
    }
    // Feat count: non-empty .feat-entry textareas on the Feats tab.
    // We scope to #feats-container to avoid matching the companion
    // tab's reused .feat-entry styling class (the collector-scoping
    // trap from CLAUDE.md).
    s.featCount = 0;
    const featTab = document.getElementById('feats-container');
    if (featTab) {
      for (const ta of featTab.querySelectorAll('.feat-entry')) {
        if ((ta.value || '').trim()) s.featCount++;
      }
    }
    // Applied classes (cheap to read; both new and history checks use).
    s.appliedClasses = (typeof ClassPicker !== 'undefined' &&
                        typeof ClassPicker.getState === 'function')
      ? ClassPicker.getState() : [];
    s.hasAnyClass = s.appliedClasses.length > 0;
    // Spell slots / prepared / known per caster panel.
    s.casters = [];
    // Item Familiar bonus slots (UA p.171): collect once per audit
    // pass since the same global pool applies to all panels.
    const ifamBonuses = (typeof ItemFamiliar !== 'undefined'
      && ItemFamiliar.getAllSpellSlotBonuses)
      ? ItemFamiliar.getAllSpellSlotBonuses() : [];
    for (const panel of document.querySelectorAll('[data-caster-type="spellcasting"]')) {
      const notes = panel.querySelector('.caster-notes')?.value?.trim() || '(unnamed)';
      // Combine tab label + notes for class identification (matches
      // the pattern in spells.js's metamagic-reference lookup).
      const idx = (panel.id || '').replace(/^caster-/, '');
      const tabBtn = document.querySelector(`.inner-tab[data-caster-idx="${idx}"]`);
      const label = (tabBtn ? tabBtn.textContent.replace('×', '').trim() : '');
      const identity = (label + ' ' + notes).toLowerCase();
      // Per-level item-familiar bonuses for this panel — same liberal
      // substring match spells.js uses for slot display.
      const ifamBonusesByLevel = {};
      for (const b of ifamBonuses) {
        if (identity.includes(b.class.toLowerCase())) {
          ifamBonusesByLevel[b.bonusLevel] =
            (ifamBonusesByLevel[b.bonusLevel] || 0) + 1;
        }
      }
      const c = { name: notes, identity, levels: [] };
      const table = panel.querySelector('.spell-slots-table');
      const maxLvl = int(table?.dataset.maxLevel || 9);
      for (let i = 0; i <= maxLvl; i++) {
        const perDay   = int(panel.querySelector(`.sc-per-day[data-lvl="${i}"]`)?.value);
        const bonus    = int(panel.querySelector(`.sc-bonus[data-lvl="${i}"]`)?.value);
        const domain   = int(panel.querySelector(`.sc-domain-slots[data-lvl="${i}"]`)?.value);
        const spec     = int(panel.querySelector(`.sc-specialist-slots[data-lvl="${i}"]`)?.value);
        const ifam     = ifamBonusesByLevel[i] || 0;
        const total    = perDay + bonus + domain + spec + ifam;
        const used     = int(panel.querySelector(`.sc-used[data-lvl="${i}"]`)?.value);
        const cap      = int(panel.querySelector(`.sc-known[data-lvl="${i}"]`)?.value);
        // Count Known-list rows but EXCLUDE freebies — class-granted
        // spells like Sand Shaper's Desert Insight are visible in the
        // list but explicitly don't count toward the known-spells cap.
        // The same exclusion logic lives in spells.js::updateKnownCount
        // for the in-panel counter display.
        const knownRows = panel.querySelectorAll(
          `.sc-known-list[data-lvl="${i}"] .sc-known-row`);
        let knownCount = 0, freebieCount = 0;
        for (const r of knownRows) {
          const name = r.querySelector('.sc-known-name')?.value || '';
          if (!name.trim()) continue;
          if (r.dataset.freebie === '1') freebieCount++;
          else knownCount++;
        }
        // v2 Phase C structural-restructure (2026-05-19): Prepared
        // is a list of structured rows now, not a textarea. Count
        // rows whose name input is non-empty.
        const prepRows = panel.querySelectorAll(
          `.sc-prepared-list[data-lvl="${i}"] .sc-prepared-row`);
        let preparedCount = 0;
        for (const r of prepRows) {
          if ((r.querySelector('.sc-prep-name')?.value || '').trim()) {
            preparedCount++;
          }
        }
        c.levels.push({ level: i, total, used, cap, knownCount, preparedCount });
      }
      s.casters.push(c);
    }
    return s;
  }

  function collect() {
    const s = snapshot();
    const issues = [];

    // ---- HP overflow / underflow ----
    if (s.hpMax > 0 && s.hpCurrent > s.hpMax) {
      issues.push({
        id: 'hp:current-over-max',
        severity: 'error',
        message: `HP current (${s.hpCurrent}) exceeds HP max (${s.hpMax}). ` +
                 `If this is intentional (e.g. Bear's Endurance), dismiss.`,
      });
    }

    // ---- Skill ranks over absolute cap ----
    // Anything above that is illegal regardless of class-skill status.
    // Uses the character's own cap (see snapshot) rather than the generic
    // formula, so bloodline levels and kin don't produce false errors.
    // (Half-cap cross-class check waits for history.)
    const absCap = s.maxClassRanks;
    const capNote = absCap === s.charLevel + 3
      ? `character level + 3 = ${absCap}`
      : `this character's max ranks = ${absCap}`;
    for (const sk of s.skills) {
      if (sk.ranks > absCap) {
        issues.push({
          id: `skill:over-cap:${sk.name}`,
          severity: 'error',
          message: `${sk.name}: ${sk.ranks} ranks exceeds the cap (${capNote}).`,
        });
      }
    }

    // ---- Encumbrance ----
    if (s.loadCategory === 'medium') {
      issues.push({
        id: 'load:medium',
        severity: 'warning',
        message: `Medium load (${s.totalWeight.toFixed(1)} lb): max Dex to ` +
                 `AC capped at +3, armor check penalty -3, speed reduced.`,
      });
    } else if (s.loadCategory === 'heavy') {
      issues.push({
        id: 'load:heavy',
        severity: 'warning',
        message: `Heavy load (${s.totalWeight.toFixed(1)} lb): max Dex to ` +
                 `AC capped at +1, armor check penalty -6, speed reduced.`,
      });
    }

    // ---- Base ability score bounds ----
    // Flag BASE score (manually entered), not total. Monstrous races
    // legitimately push totals high via racial mods, but a base
    // outside the expected window is almost always a build hint
    // worth checking once (then dismiss).
    //
    // Upper bound: 18 (max roll on 4d6-drop-lowest) plus the number
    // of ability score increases granted by the character's level
    // (one per 4 levels at L4/8/12/16/20, all assignable to the
    // same ability). So 18+1 at L4, 18+2 at L8, ..., 18+5 at L20.
    // Higher than that suggests wish/inherent bonuses or homebrew.
    //
    // Lower bound: 3 — the minimum roll on 3d6. PC base scores of
    // 2 or lower are illegal at character creation (drained/damaged
    // in play is a different mechanic and shouldn't be reflected in
    // the manually-entered base).
    const baseCeiling = 18 + Math.floor(s.charLevel / 4);
    for (const [ab, val] of Object.entries(s.baseAbilities)) {
      if (val > baseCeiling) {
        issues.push({
          id: `ability:base-over-ceiling:${ab}`,
          severity: 'warning',
          message: `Base ${ab} = ${val} (above ${baseCeiling}, the L${s.charLevel} ` +
                   `ceiling of 18 + floor(level / 4) level-up boosts). Dismiss if ` +
                   `this is intentional (wish/inherent bonuses, homebrew, etc.).`,
        });
      } else if (val > 0 && val < 3) {
        // val > 0 because empty / 0 means "not yet entered" — only
        // flag when the user has explicitly typed in 1 or 2.
        issues.push({
          id: `ability:base-under-3:${ab}`,
          severity: 'error',
          message: `Base ${ab} = ${val} (below 3, the minimum legal base). ` +
                   `PC base scores can't drop below 3 at character creation; ` +
                   `temporary ability damage / drain goes in the Temp Score ` +
                   `column instead.`,
        });
      }
    }

    // ---- Spell-slot overpreparation + known overage ----
    for (const caster of s.casters) {
      for (const { level, total, used, cap, knownCount, preparedCount } of caster.levels) {
        // Prepared overage: a wizard prepping 5 spells in a 4-slot
        // level. (Used count is independent — we don't compare against
        // it; this is about the static prep list size.)
        if (total > 0 && preparedCount > total) {
          issues.push({
            id: `caster:over-prepared:${caster.name}:${level}`,
            severity: 'error',
            message: `${caster.name} L${level}: prepared ${preparedCount} ` +
                     `spell(s) into ${total} slot(s).`,
          });
        } else if (total > 0 && preparedCount === total && preparedCount > 0
                   && !/sha'?ir/.test(caster.identity || '')) {
          // Sha'ir gens retrieve any spell on demand, so a "full prep
          // list" doesn't constrain flexibility the way it does for
          // wizards/clerics — suppress the info noise for them.
          issues.push({
            id: `caster:prepared-full:${caster.name}:${level}`,
            severity: 'info',
            message: `${caster.name} L${level}: prepared list fills every ` +
                     `slot (no flex room for spontaneous metamagic, ` +
                     `swapped prep, etc.).`,
          });
        }
        // Used over total: can't use more slots than you have.
        if (total > 0 && used > total) {
          issues.push({
            id: `caster:over-used:${caster.name}:${level}`,
            severity: 'error',
            message: `${caster.name} L${level}: marked ${used} slot(s) ` +
                     `used but only ${total} available.`,
          });
        }
        // Known overage (sorcerer-style; uses sc-known cap field).
        if (cap > 0 && knownCount > cap) {
          issues.push({
            id: `caster:over-known:${caster.name}:${level}`,
            severity: 'error',
            message: `${caster.name} L${level}: ${knownCount} spell(s) ` +
                     `known but cap is ${cap}.`,
          });
        }
        // NO "known list is full" advisory. A spontaneous caster knowing
        // exactly `spells known` spells per level isn't an oddity — it's
        // what the rules say the character HAS, so every correctly-built
        // sorcerer/bard/favored soul tripped it at every level. Removed
        // 2026-07-31 per report rms3yqqo2-bxri. (The prepared-list-full
        // advisory above is kept: a full prep list is a real tactical
        // note about flex room, and it's a choice rather than a given.)
      }
    }

    // ---- M7 (2026-05-16 play-feel pass): "you might have forgotten
    //       something" checks. Deliberately loose — flag only when
    //       the gap is glaring (zero feats / zero skill ranks / zero
    //       HP on a character that HAS applied classes). Exact-count
    //       checks need race + class-bonus-feat math that's beyond
    //       Phase 1; these are the obvious "did you start building"
    //       prompts, all `info` severity so they're easy to dismiss.
    if (s.hasAnyClass) {
      if (s.hpMax === 0) {
        issues.push({
          id: 'm7:hp-not-set',
          severity: 'info',
          message: `HP Max is blank. Roll or take the average HP for ` +
                   `each class level (Wizard d4, Cleric d8, etc.) and ` +
                   `enter the total here.`,
        });
      }
      if (s.featCount === 0) {
        issues.push({
          id: 'm7:no-feats',
          severity: 'info',
          message: `No feats taken. Every character gets at least one ` +
                   `feat at L1 (plus a Human bonus + class bonus feats). ` +
                   `Use the Feat Lookup to add them.`,
        });
      }
      if (s.totalSkillRanks === 0) {
        issues.push({
          id: 'm7:no-skill-ranks',
          severity: 'info',
          message: `No skill ranks purchased. Each class gets ` +
                   `(skill_pts + INT mod) ranks per level (×4 at L1). ` +
                   `Fill out the Skills tab.`,
        });
      }
    }

    // ---- History-derived checks ----
    // Only run when CharacterHistory has data — these are the per-
    // level validations from #3 Session 4. Each check is independent
    // and emits 0+ issues into the same list. Phase 1 covers the
    // checks that work with the fields the history already captures
    // (class_taken, hp_rolled, ability_boost, feats_taken). Skills,
    // spells, and class-specific choices are deferred until those
    // editors land in the Timeline.
    if (typeof CharacterHistory !== 'undefined') {
      const history = CharacterHistory.get();
      if (Array.isArray(history) && history.length > 0) {
        checkHistoryClassMatch(history, issues);
        checkAbilityBoostLevels(history, issues);
        checkAbilityBoostCount(history, issues);
        checkFeatScheduleLevels(history, issues);
        checkFeatPrereqOrder(history, issues);
      }
    }

    // Filter out dismissed instances and muted families.
    return issues.filter(i => !dismissed.has(i.id) && !muted.has(familyOf(i)));
  }

  // ---- History-derived checks ---------------------------------------

  // Compare history's class composition to ClassPicker.getState().
  // Mismatches usually mean the user edited Timeline without
  // updating the applied classes (or vice versa).
  function checkHistoryClassMatch(history, issues) {
    if (typeof ClassPicker === 'undefined' ||
        typeof ClassPicker.getState !== 'function') return;
    const applied = ClassPicker.getState();
    const appliedTotalLvl = applied.reduce((s, c) => s + (c.level || 0), 0);
    if (appliedTotalLvl > 0 && history.length !== appliedTotalLvl) {
      issues.push({
        id: 'history:total-mismatch',
        severity: 'warning',
        message: `Build Timeline has ${history.length} level(s) but ` +
                 `applied classes sum to ${appliedTotalLvl}. The two ` +
                 `should agree — edit the Timeline (or re-apply classes) ` +
                 `to reconcile.`,
      });
    }
    // Per-class counts.
    const histCounts = new Map();
    for (const e of history) {
      const c = e.class_taken || '(unknown)';
      histCounts.set(c, (histCounts.get(c) || 0) + 1);
    }
    const appliedCounts = new Map();
    for (const c of applied) {
      appliedCounts.set(c.className, (appliedCounts.get(c.className) || 0) + (c.level || 0));
    }
    for (const [cls, n] of histCounts) {
      const a = appliedCounts.get(cls) || 0;
      if (a !== n) {
        issues.push({
          id: `history:class-mismatch:${cls}`,
          severity: 'warning',
          message: `Build Timeline has ${n} ${cls} level(s) but applied ` +
                   `classes show ${a}. Reconcile via Timeline edits or ` +
                   `re-apply ${cls} via Class Lookup.`,
        });
      }
    }
    for (const [cls] of appliedCounts) {
      if (!histCounts.has(cls)) {
        issues.push({
          id: `history:class-missing:${cls}`,
          severity: 'warning',
          message: `Applied class ${cls} has no levels in the Build ` +
                   `Timeline. Add Timeline entries (or re-trigger ` +
                   `reconstruction by clearing history).`,
        });
      }
    }
  }

  // Ability boosts can only be assigned at L4/8/12/16/20.
  function checkAbilityBoostLevels(history, issues) {
    for (const e of history) {
      if (e.ability_boost &&
          typeof CharacterHistory.isAbilityBoostLevel === 'function' &&
          !CharacterHistory.isAbilityBoostLevel(e.level)) {
        issues.push({
          id: `history:boost-wrong-level:${e.level}`,
          severity: 'error',
          message: `L${e.level} has an ability boost (${e.ability_boost}), ` +
                   `but boosts only happen at L4 / 8 / 12 / 16 / 20.`,
        });
      }
    }
  }

  // Boost count should equal floor(charLevel / 4) at L20.
  // If too many boosts assigned, flag.
  function checkAbilityBoostCount(history, issues) {
    const charLevel = history.length;
    const expected = Math.floor(charLevel / 4);
    const actual = history.filter(e => !!e.ability_boost).length;
    if (actual > expected) {
      issues.push({
        id: 'history:too-many-boosts',
        severity: 'error',
        message: `${actual} ability score increase(s) assigned across ` +
                 `${charLevel} level(s), but only ${expected} permitted ` +
                 `(one per 4 levels at L4 / 8 / 12 / 16 / 20).`,
      });
    }
  }

  // Feats should generally land on the RAW schedule (L1/3/6/9/12/15/18).
  // We surface this as INFO not error — class bonus feats legitimately
  // appear at other levels (Fighter L1/2/4/6/8/.., Wizard L5/10/15/20,
  // monk bonuses, etc.) and a Pathfinder-style table has odd-level
  // feats. The note is a "did you mean to put a feat here?" reminder.
  function checkFeatScheduleLevels(history, issues) {
    if (typeof CharacterHistory === 'undefined' ||
        typeof CharacterHistory.featLevels !== 'function') return;
    const rawSet = new Set(CharacterHistory.featLevels(false));
    const pfSet  = new Set(CharacterHistory.featLevels(true));
    for (const e of history) {
      if (!(e.feats_taken || []).length) continue;
      if (rawSet.has(e.level)) continue;
      // Not on the RAW schedule — could be a class bonus feat, a
      // Pathfinder-style table, or a mis-placed entry. Info only.
      const onPF = pfSet.has(e.level);
      issues.push({
        id: `history:feat-off-schedule:${e.level}`,
        severity: 'info',
        message: `L${e.level} has ${e.feats_taken.length} feat(s) but ` +
                 `RAW schedule grants feats at L1/3/6/9/12/15/18 ` +
                 (onPF
                   ? `(Pathfinder schedule includes L${e.level}). `
                   : `(not in Pathfinder either). `) +
                 `If these are class bonus feats (Fighter / Wizard / ` +
                 `Monk / etc.), dismiss this.`,
      });
    }
  }

  // For each feat taken in history, replay the prereq check against
  // the character's state AT the moment the feat was acquired (Phase
  // B). Covers every atom kind — feat / BAB / ability / class level /
  // caster level / skill / alignment — not just the "took Cleave
  // before Power Attack" case.
  //
  // Same-level feat prereqs are still handled specially: RAW lets you
  // list multiple feats acquired at one level (class bonus + standard
  // slot) in any order, so we downgrade those to info rather than
  // error.
  function checkFeatPrereqOrder(history, issues) {
    if (typeof FeatPrereqs === 'undefined' ||
        typeof FeatPrereqs.evaluateAtLevel !== 'function') return;
    if (typeof DB === 'undefined' || !DB.isLoaded()) return;
    // Walk each acquired feat.
    for (const e of history) {
      for (const featName of (e.feats_taken || [])) {
        const name = String(featName || '').trim();
        if (!name) continue;
        const row = DB.queryOne(
          "SELECT json_extract(data, '$.prerequisites') AS p " +
          "FROM entry WHERE type='feat' AND name = :n COLLATE NOCASE LIMIT 1",
          { ':n': name });
        if (!row || !row.p) continue;  // homebrew / unknown
        // History-aware evaluation: snapshot rewound to the moment
        // BEFORE level e.level's feats are picked.
        const result = FeatPrereqs.evaluateAtLevel(row.p, e.level,
          { history });
        const sameLevelFeats = (e.feats_taken || [])
          .map(s => String(s).trim().toLowerCase());
        for (const a of result.atoms) {
          if (a.status === 'satisfied') continue;
          if (a.status === 'unknown') continue;  // warn-only; skip
          // Special case: same-level feat prereq.
          if (a.kind === 'feat') {
            const need = a.name.toLowerCase();
            if (sameLevelFeats.includes(need)) {
              issues.push({
                id: `history:prereq-same-level:${e.level}:${name}:${a.name}`,
                severity: 'info',
                message: `L${e.level}: ${name} requires ${a.name}, which ` +
                         `was taken on the SAME level. Order on the same ` +
                         `level is irrelevant by RAW, but worth confirming ` +
                         `your DM accepts it.`,
              });
              continue;
            }
            issues.push({
              id: `history:prereq-not-taken:${e.level}:${name}:${a.name}`,
              severity: 'error',
              message: `L${e.level}: ${name} requires ${a.name} as a feat ` +
                       `prereq, but ${a.name} was not taken in any prior ` +
                       `level. Re-order via the Build Timeline, or dismiss ` +
                       `if a DM ruling allows it.`,
            });
            continue;
          }
          // Non-feat unmet prereq — emit a descriptive issue based
          // on the atom kind. severity = error, since at the time
          // the feat was taken, the character didn't meet RAW.
          const detail = a.detail || '';
          let summary = a.raw;
          if (a.kind === 'ability') {
            summary = `${a.ability} ${a.value}`;
          } else if (a.kind === 'bab') {
            summary = `BAB +${a.value}`;
          } else if (a.kind === 'skill') {
            summary = `${a.skill} ${a.ranks} ranks`;
          } else if (a.kind === 'classLevel') {
            summary = `${a.className} level ${a.level}`;
          } else if (a.kind === 'casterLevel') {
            summary = `${a.flavor === 'any' ? '' : a.flavor + ' '}caster level ${a.level}`;
          } else if (a.kind === 'castSpells') {
            summary = `able to cast L${a.level} ${a.flavor === 'any' ? '' : a.flavor + ' '}spells`;
          } else if (a.kind === 'alignment') {
            summary = `${a.parts.join(' ')} alignment`;
          }
          issues.push({
            id: `history:prereq-unmet:${e.level}:${name}:${a.kind}:${summary}`,
            severity: 'error',
            message: `L${e.level}: ${name} requires ${summary}` +
                     (detail ? ` (${detail})` : '') +
                     `, but the character didn't meet that at the time. ` +
                     `Re-order via the Build Timeline, or dismiss if a DM ` +
                     `ruling allows it.`,
          });
        }
      }
    }
  }

  // ---- UI: trigger button -------------------------------------------

  // Severity priority: error > warning > info > clean.
  function worstSeverity(issues) {
    if (issues.some(i => i.severity === 'error')) return 'error';
    if (issues.some(i => i.severity === 'warning')) return 'warning';
    if (issues.some(i => i.severity === 'info')) return 'info';
    return 'clean';
  }

  const SEVERITY_ICONS = {
    clean:   '✓',
    info:    'ⓘ',
    warning: '⚠',
    error:   '✗',
  };
  const SEVERITY_LABELS = {
    clean:   'No issues',
    info:    'Info',
    warning: 'Warnings',
    error:   'Errors',
  };

  function ensureTriggerButton() {
    if (triggerBtn) return triggerBtn;
    triggerBtn = document.createElement('button');
    triggerBtn.id = 'audit-trigger-btn';
    triggerBtn.type = 'button';
    triggerBtn.className = 'audit-trigger';
    triggerBtn.title = 'Character audit';
    triggerBtn.addEventListener('click', togglePopover);
    // Place next to the lookup button if it exists, otherwise in the
    // header. Both live in the same header bar so the audit chip
    // ends up sitting alongside the lookup ❔ button.
    const lookupBtn = document.getElementById('lookup-trigger-btn');
    if (lookupBtn && lookupBtn.parentElement) {
      lookupBtn.parentElement.insertBefore(triggerBtn, lookupBtn);
    } else {
      const header = document.querySelector('header');
      if (header) header.appendChild(triggerBtn);
      else document.body.appendChild(triggerBtn);
    }
    return triggerBtn;
  }

  function updateButton(issues) {
    if (!triggerBtn) return;
    const sev = worstSeverity(issues);
    triggerBtn.dataset.severity = sev;
    const count = issues.length;
    const countLabel = count > 0 ? ` (${count})` : '';
    triggerBtn.title = `${SEVERITY_LABELS[sev]}${countLabel} — click for details`;
    triggerBtn.innerHTML = `<span class="audit-icon">${SEVERITY_ICONS[sev]}</span>` +
      (count > 0 ? `<span class="audit-count">${count}</span>` : '');
  }

  // ---- UI: popover ---------------------------------------------------

  function togglePopover() {
    if (popoverEl) { closePopover(); return; }
    openPopover();
  }

  function openPopover() {
    const issues = collect();
    popoverEl = document.createElement('div');
    popoverEl.className = 'audit-popover';
    renderPopover(issues);
    document.body.appendChild(popoverEl);
    positionPopover();
    // Close on outside click (next tick so the trigger click doesn't
    // immediately re-close us).
    setTimeout(() => {
      document.addEventListener('click', onOutsideClick, true);
    }, 0);
  }

  function closePopover() {
    if (!popoverEl) return;
    popoverEl.remove();
    popoverEl = null;
    document.removeEventListener('click', onOutsideClick, true);
  }

  function onOutsideClick(ev) {
    if (popoverEl && !popoverEl.contains(ev.target) &&
        ev.target !== triggerBtn && !triggerBtn?.contains(ev.target)) {
      closePopover();
    }
  }

  function positionPopover() {
    if (!popoverEl || !triggerBtn) return;
    const r = triggerBtn.getBoundingClientRect();
    popoverEl.style.position = 'fixed';
    popoverEl.style.top = `${r.bottom + 6}px`;
    // Right-align under the trigger; clamp to viewport.
    const popW = 340;
    let left = r.right - popW;
    if (left < 8) left = 8;
    popoverEl.style.left = `${left}px`;
    popoverEl.style.width = `${popW}px`;
  }

  function renderPopover(issues) {
    if (!popoverEl) return;
    if (!issues.length) {
      popoverEl.innerHTML =
        `<div class="audit-header"><b>Character Audit</b></div>` +
        `<div class="audit-empty">✓ No active issues.</div>` +
        renderDismissedToggle();
      bindDismissedToggle();
      return;
    }
    const byBucket = { error: [], warning: [], info: [] };
    for (const i of issues) byBucket[i.severity]?.push(i);
    const sections = [];
    for (const sev of ['error', 'warning', 'info']) {
      const list = byBucket[sev];
      if (!list.length) continue;
      const heading = `${SEVERITY_ICONS[sev]} ${SEVERITY_LABELS[sev]} ` +
                      `(${list.length})`;
      const items = list.map(i =>
        `<li class="audit-item audit-item-${sev}">` +
        `<span class="audit-msg">${escapeHtml(i.message)}</span>` +
        `<button class="audit-mute" data-family="${escapeHtml(familyOf(i))}" ` +
        `title="Stop showing this KIND of issue for this character">🔕</button>` +
        `<button class="audit-dismiss" data-id="${escapeHtml(i.id)}" ` +
        `title="Dismiss this issue for this character">×</button>` +
        `</li>`).join('');
      sections.push(
        `<div class="audit-section audit-section-${sev}">` +
        `<div class="audit-section-head">${escapeHtml(heading)}</div>` +
        `<ul class="audit-list">${items}</ul></div>`
      );
    }
    popoverEl.innerHTML =
      `<div class="audit-header"><b>Character Audit</b></div>` +
      sections.join('') +
      renderDismissedToggle();
    popoverEl.querySelectorAll('.audit-dismiss').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        dismiss(btn.dataset.id);
      });
    });
    popoverEl.querySelectorAll('.audit-mute').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        mute(btn.dataset.family);
      });
    });
    bindDismissedToggle();
  }

  function renderDismissedToggle() {
    const bars = [];
    if (dismissed.size) {
      bars.push(`<button class="audit-show-dismissed" type="button">` +
        `${dismissed.size} dismissed — re-enable</button>`);
    }
    // Muted families are listed by NAME, not just counted: a silenced check
    // the user can't see the name of is a check they can't decide to turn
    // back on.
    for (const fam of muted) {
      bars.push(`<button class="audit-unmute" type="button" ` +
        `data-family="${escapeHtml(fam)}">` +
        `muted: ${escapeHtml(FAMILY_LABELS[fam] || fam)} — unmute</button>`);
    }
    if (!bars.length) return '';
    return `<div class="audit-dismissed-bar">${bars.join('')}</div>`;
  }

  function bindDismissedToggle() {
    const btn = popoverEl?.querySelector('.audit-show-dismissed');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        dismissed.clear();
        refresh();
      });
    }
    popoverEl?.querySelectorAll('.audit-unmute').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        muted.delete(b.dataset.family);
        refresh();
      });
    });
  }

  // ---- Dismiss / refresh --------------------------------------------

  function dismiss(id) {
    dismissed.add(id);
    refresh();
  }

  function mute(family) {
    if (!family) return;
    muted.add(family);
    refresh();
  }

  function refresh() {
    const issues = collect();
    updateButton(issues);
    if (popoverEl) renderPopover(issues);
  }

  // ---- Save / Load --------------------------------------------------

  function collectData() {
    return { auditDismissed: [...dismissed], auditMuted: [...muted] };
  }

  function loadData(d) {
    dismissed.clear();
    for (const id of (d?.auditDismissed || [])) dismissed.add(id);
    // Defensive default: a save written before mutes existed simply has
    // none, and every check stays on.
    muted.clear();
    for (const fam of (d?.auditMuted || [])) muted.add(fam);
    refresh();
  }

  // ---- Public API ---------------------------------------------------

  function build() {
    ensureTriggerButton();
    refresh();
    document.addEventListener('audit-refresh', refresh);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // familyOf is exported for the regression suite: the mute is only as good
  // as the family the id derives to, and that derivation is the part a
  // future id-format change would silently break.
  return { build, refresh, collect, dismiss, mute, familyOf,
           collectData, loadData };
})();
