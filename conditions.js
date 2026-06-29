// conditions.js — D&D 3.5 condition tracker.
//
// Renders a small panel of toggle chips for common combat-relevant
// conditions (Fatigued, Shaken, Prone, Blinded, etc.) on the
// Character tab. Active conditions contribute aggregated modifiers
// through the existing bonus layer (`Conditions.getActiveBonuses()`)
// alongside ClassFeatures and Equipment, plus a summary line
// underneath the chips listing each active condition's effect.
//
// What's auto-applied via the bonus layer:
//   abilities (Str / Dex penalties from Fatigued / Exhausted)
//   ac (penalties from Blinded / Cowering / Stunned / Pinned / Squeezing)
//   saves (Shaken / Frightened / Panicked / Sickened all give -2)
//   loseDexToAC flag (Flat-footed / Blinded / Helpless / Stunned /
//                     Cowering / Pinned / Paralyzed)
//
// What's surfaced but not yet auto-applied (manual at the table):
//   attack roll penalties (-1 Dazzled, -2 Shaken/Frightened/Panicked/
//                          Sickened, -4 Squeezing, -4 melee from Prone)
//   skill check penalties (-2 Shaken/Sickened, -4 Blinded for Spot etc.)
//   speed multipliers, action restrictions (Nauseated, Dazed, etc.),
//   damage roll penalties, energy drain (variable input)
//
// Phase 2 will plumb attack/skill penalties through the bonus layer.
// For v1 they're displayed in the summary so the player can apply
// manually.

const Conditions = (function () {
  // Catalog: condition name → mechanical effects + description.
  // Numeric keys are NEGATIVE numbers for penalties (e.g. attack:-2).
  // Boolean flags: loseDexToAC, noActions, helpless, dropItems, noRun.
  // speedMultiplier: 1 (normal), 0.5 (half), 0 (immobile).
  const CATALOG = {
    'Flat-footed': {
      loseDexToAC: true,
      description: 'Lose Dex bonus to AC (and dodge bonuses) until your first action.',
    },
    'Prone': {
      attackMelee: -4,
      acVsRanged: 4,
      acVsMelee: -4,
      description: '+4 AC vs ranged, -4 AC vs melee. -4 attack on melee attacks. Standing up = move action that provokes.',
    },
    'Shaken': {
      attack: -2, save: -2, saveType: 'morale', skill: -2, abilityCheck: -2,
      description: 'Fear effect (stacks → Frightened). -2 attack / saves / skill checks / ability checks.',
    },
    'Frightened': {
      attack: -2, save: -2, saveType: 'morale', skill: -2, abilityCheck: -2,
      description: 'As Shaken, plus must flee at top speed if able. Stacks → Panicked.',
    },
    'Panicked': {
      attack: -2, save: -2, saveType: 'morale', skill: -2, abilityCheck: -2,
      dropItems: true,
      description: 'Drop everything held, flee top speed, cannot make attacks or take other actions.',
    },
    'Sickened': {
      attack: -2, damage: -2, save: -2, skill: -2, abilityCheck: -2,
      description: '-2 attack / weapon damage / saves / skill checks / ability checks.',
    },
    'Nauseated': {
      onlyMove: true,
      description: 'Only a single move action per round. No spells, attacks, or concentration.',
    },
    'Dazed': {
      noActions: true,
      description: 'No actions for 1 round. Retains Dex bonus to AC.',
    },
    'Dazzled': {
      attack: -1, spot: -1, search: -1,
      description: '-1 attack rolls. -1 Spot and Search checks.',
    },
    'Blinded': {
      ac: -2,
      loseDexToAC: true,
      speedMultiplier: 0.5,
      skillSpot: -1000, // "automatically fail"
      description: '-2 AC, lose Dex bonus to AC, half speed (or full with DC 10 Balance, fail = prone), 50% miss chance, no Spot/Search/most Dex-based skills.',
    },
    'Deafened': {
      initiative: -4,
      description: '-4 initiative. 20% arcane spell failure on verbal-component spells. Automatically fail Listen checks.',
    },
    'Stunned': {
      ac: -2,
      loseDexToAC: true,
      dropItems: true,
      noActions: true,
      description: '-2 AC, lose Dex to AC, drop everything held, no actions for 1 round.',
    },
    'Fatigued': {
      strPenalty: -2, dexPenalty: -2,
      noRun: true,
      description: '-2 Str, -2 Dex. Cannot run or charge. 8 hours rest = removed.',
    },
    'Exhausted': {
      strPenalty: -6, dexPenalty: -6,
      speedMultiplier: 0.5,
      noRun: true,
      description: '-6 Str, -6 Dex, half speed, no run/charge. 1 hour rest = Fatigued.',
    },
    'Paralyzed': {
      dexToZero: true,
      strToZero: true,
      helpless: true,
      description: 'Dex 0 (and Str 0 for paralyzed limbs). Helpless. Cannot move.',
    },
    'Helpless': {
      dexToZero: true,
      description: 'Dex 0. Adjacent opponents can deliver coup-de-grace (auto-crit, save vs death DC 10 + damage).',
    },
    'Cowering': {
      ac: -2,
      loseDexToAC: true,
      noActions: true,
      description: '-2 AC, lose Dex to AC, no actions.',
    },
    'Pinned': {
      ac: -4,
      loseDexToAC: true,
      description: 'Lose Dex to AC; -4 AC. Cannot move or attack with anything but a light weapon at -4.',
    },
    'Grappling': {
      description: 'Lose Dex bonus to AC against opponents you are NOT grappling. Restricted to one-handed light weapons. Limited spells.',
    },
    'Squeezing': {
      attack: -4,
      ac: -4,
      speedMultiplier: 0.5,
      description: '-4 attack, -4 AC, half speed (squeezing through a tight space).',
    },
    'Entangled': {
      attack: -2,
      dexPenalty: -4,
      speedMultiplier: 0.5,
      description: '-2 attack, effective -4 Dex (applies to AC and Dex-based rolls), half speed, no run/charge.',
    },
    'Confused': {
      description: 'Random behavior each round (d% table: 01-10 attack caster, 11-20 act normally, 21-50 nothing but babble, 51-70 flee at top speed, 71-100 attack nearest creature).',
    },
    'Energy drained': {
      description: 'Per negative level: -1 attack / saves / skill checks / ability checks / effective level. After 24h, Fort save (DC 10 + ½ HD + Cha mod) vs each to remove; failed = permanent.',
    },
  };

  // Render chips into the host container.
  function build() {
    const host = document.getElementById('conditions-container');
    if (!host) return;
    host.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'conditions-grid';
    for (const name of Object.keys(CATALOG)) {
      const label = document.createElement('label');
      label.className = 'condition-chip';
      label.title = CATALOG[name].description;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'condition-toggle';
      cb.dataset.condition = name;
      cb.addEventListener('change', onChange);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + name));
      grid.appendChild(label);
    }
    host.appendChild(grid);
    const summary = document.createElement('div');
    summary.id = 'conditions-summary';
    summary.className = 'conditions-summary';
    host.appendChild(summary);
    refreshSummary();
  }

  function onChange() {
    refreshSummary();
    // Trigger main recalc to apply bonus-layer effects (abilities,
    // saves, AC). Attack/skill penalties stay display-only for v1.
    if (window.requestAnimationFrame) {
      requestAnimationFrame(() => {
        document.dispatchEvent(new Event('conditions-changed'));
      });
    }
  }

  function getActive() {
    const out = [];
    for (const el of document.querySelectorAll('.condition-toggle')) {
      if (el.checked) out.push(el.dataset.condition);
    }
    return out;
  }

  function refreshSummary() {
    const el = document.getElementById('conditions-summary');
    if (!el) return;
    const active = getActive();
    if (!active.length) {
      el.innerHTML = '';
      return;
    }
    const lines = active.map(name => {
      const c = CATALOG[name];
      return `<div class="condition-line"><b>${escapeHtml(name)}:</b> ` +
             `${escapeHtml(c.description)}</div>`;
    });
    // Aggregate manual-apply notes (attack / skill / damage etc.)
    const totals = aggregateManualNotes();
    if (totals.length) {
      lines.push(
        `<div class="condition-line condition-totals">` +
        `<b>Apply manually:</b> ${escapeHtml(totals.join(', '))}</div>`
      );
    }
    el.innerHTML = lines.join('');
  }

  // Return human-readable notes for effects that aren't yet plumbed
  // through the bonus layer — the user applies these at the table.
  function aggregateManualNotes() {
    const out = [];
    let attack = 0, damage = 0, skill = 0, initiative = 0;
    let speedMul = 1;
    for (const name of getActive()) {
      const c = CATALOG[name];
      if (c.attack)      attack += c.attack;
      if (c.damage)      damage += c.damage;
      if (c.skill)       skill += c.skill;
      if (c.initiative)  initiative += c.initiative;
      if (c.speedMultiplier !== undefined)
        speedMul = Math.min(speedMul, c.speedMultiplier);
    }
    if (attack)     out.push(`attack ${signed(attack)}`);
    if (damage)     out.push(`weapon damage ${signed(damage)}`);
    if (skill)      out.push(`all skill checks ${signed(skill)}`);
    if (initiative) out.push(`initiative ${signed(initiative)}`);
    if (speedMul !== 1)
      out.push(`speed ${speedMul === 0 ? 'immobile' : `×${speedMul}`}`);
    return out;
  }

  function signed(n) { return (n >= 0 ? '+' : '') + n; }

  // ---- Bonus-layer integration ----
  // Returns { abilities: { STR, DEX }, saves: { fort, ref, will }, ac,
  //           loseDexToAC } in the same shape as ClassFeatures /
  // Equipment getActiveBonuses().
  function getActiveBonuses() {
    const out = {
      abilities: {},
      // Typed save modifiers — fear conditions are MORALE penalties (they
      // don't stack with each other / a morale bonus resolves separately),
      // the rest are untyped (stack). Consumed by collectActiveBonuses into
      // the cross-source save stacking list.
      saveBonuses: [],
      ac: 0,
      loseDexToAC: false,
    };
    for (const name of getActive()) {
      const c = CATALOG[name];
      if (c.strPenalty) out.abilities.STR = (out.abilities.STR || 0) + c.strPenalty;
      if (c.dexPenalty) out.abilities.DEX = (out.abilities.DEX || 0) + c.dexPenalty;
      // dexToZero / strToZero — paralyzed/helpless. Modeled as a
      // very large negative bonus that the recalc clamps at the
      // resulting ability mod, effectively reducing Dex/Str to 0.
      // Cleaner than restructuring the bonus layer to support a
      // "set to value" operation.
      if (c.dexToZero) out.dexToZero = true;
      if (c.strToZero) out.strToZero = true;
      if (c.ac)        out.ac += c.ac;
      if (c.save) {
        for (const s of ['fort', 'ref', 'will']) {
          out.saveBonuses.push({ save: s, amount: c.save,
                                 bonus_category: c.saveType || 'untyped' });
        }
      }
      if (c.loseDexToAC) out.loseDexToAC = true;
    }
    return out;
  }

  // ---- Save / Load ----
  function collectData() {
    return { activeConditions: getActive() };
  }

  function loadData(data) {
    const active = new Set(data?.activeConditions || []);
    for (const el of document.querySelectorAll('.condition-toggle')) {
      el.checked = active.has(el.dataset.condition);
    }
    refreshSummary();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  return { build, getActive, getActiveBonuses, collectData, loadData };
})();
