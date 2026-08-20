// combat-options.js — the per-round combat declarations that affect BOTH the
// attack and the damage equations (2026-08-20).
//
// WHY THIS IS ITS OWN LAYER. Power Attack and Combat Expertise are declared
// once, on your action, and then apply to everything you do that round — and
// they land in three different places: Power Attack costs attack and buys
// damage, Combat Expertise costs attack and buys AC, and Shock Trooper moves
// Power Attack's attack penalty onto AC instead. Modelling them per-weapon
// would mean the same declaration typed into five attack rows and silently
// diverging between them. So they live here, once, and both equations read
// them.
//
// WHAT THE CORPUS ACTUALLY SAYS (checked, not remembered):
//
//   Power Attack (PHB): "subtract a number from all melee attack rolls and add
//     the same number to all melee damage rolls. This number may not exceed
//     your base attack bonus. ... If you attack with a two-handed weapon, or
//     with a one-handed weapon wielded in two hands, instead add TWICE the
//     number subtracted. You can't add the bonus from Power Attack to the
//     damage dealt with a light weapon (except with unarmed strikes or natural
//     weapon attacks), even though the penalty on attack rolls still applies."
//
//   Combat Expertise (PHB): "take a penalty of as much as -5 on your attack
//     roll and add the same number as a DODGE bonus to your Armor Class. This
//     number may not exceed your base attack bonus." — so the cap is
//     min(5, BAB), and it touches attack and AC only. NOT damage. It is here
//     because it shares this plumbing, not because it reaches the damage row.
//
//   Shock Trooper / Heedless Charge (CW): "you must charge and make the attack
//     at the end of the charge using your Power Attack feat. The penalty you
//     take on your attack roll must be -5 or worse. ... you can assign any
//     portion of the attack roll penalty from Power Attack to your Armor Class
//     instead, up to a maximum equal to your base attack bonus." — it MOVES the
//     penalty. Damage is untouched, which is worth saying out loud because it
//     is usually described as a damage feat.
//
// The light-weapon carve-out has its own carve-out, and it is RAW: the full
// sentence reads "...with a light weapon (except with unarmed strikes or
// natural weapon attacks), even though the penalty on attack rolls still
// applies." Note the second clause — a light weapon pays the to-hit penalty and
// gets no damage for it. attackPenalty() below is therefore STYLE-BLIND on
// purpose; damage-calc.js is where the style decides who gets the damage.
const CombatOptions = (function () {
  'use strict';

  function byId(id) { return document.getElementById(id); }

  function intOf(v) {
    const n = parseInt(String(v ?? '').trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }

  function bab() { return intOf((byId('bab-1') || {}).value); }

  // ---- state --------------------------------------------------------------

  function powerAttack() {
    return Math.max(0, Math.min(intOf((byId('co-power-attack') || {}).value), Math.max(0, bab())));
  }

  function combatExpertise() {
    // "as much as -5" AND "may not exceed your base attack bonus" — both caps.
    return Math.max(0, Math.min(intOf((byId('co-combat-expertise') || {}).value),
                                5, Math.max(0, bab())));
  }

  function heedlessCharge() {
    return !!(byId('co-heedless-charge') || {}).checked;
  }

  // Heedless Charge requires a Power Attack penalty of -5 or worse. Below that
  // the toggle is simply inert — surfaced in the readout rather than silently
  // ignored, because a player who ticked it is entitled to know it did nothing.
  function heedlessActive() {
    return heedlessCharge() && powerAttack() >= 5;
  }

  // ---- what the other equations read --------------------------------------

  // Attack-roll penalty (a negative number, or 0). Heedless Charge takes the
  // Power Attack half of it off the attack roll entirely.
  function attackPenalty() {
    const pa = heedlessActive() ? 0 : powerAttack();
    return -(pa + combatExpertise());
  }

  // Net AC change: Combat Expertise's dodge bonus, minus whatever Power Attack
  // penalty Heedless Charge moved onto AC. Charging's own -2 is not included —
  // that is a condition, not a combat option, and belongs to whoever is
  // tracking the round.
  function acChange() {
    return combatExpertise() - (heedlessActive() ? powerAttack() : 0);
  }

  // Power Attack's contribution to DAMAGE for one weapon, given its fighting
  // style multiplier (damage-calc.js owns the style table).
  function damageBonus(paMultiplier) {
    const m = (typeof paMultiplier === 'number') ? paMultiplier : 1;
    return Math.round(powerAttack() * m);
  }

  function getState() {
    return {
      power_attack: powerAttack(),
      combat_expertise: combatExpertise(),
      heedless_charge: heedlessCharge(),
      heedless_active: heedlessActive(),
      attack_penalty: attackPenalty(),
      ac_change: acChange(),
      bab: bab(),
    };
  }

  // Fed into app.js's collectActiveBonuses so Combat Expertise's dodge bonus
  // and Heedless Charge's AC cost reach the AC total the same way every other
  // programmatic bonus does.
  function getActiveBonuses() {
    return { ac: acChange() };
  }

  // ---- UI -----------------------------------------------------------------

  function refresh() {
    const out = byId('co-readout');
    if (!out) return;
    const pa = powerAttack(), ce = combatExpertise();
    const parts = [];
    if (pa) {
      parts.push(heedlessActive()
        ? `Power Attack ${pa}: attack penalty moved to AC (Heedless Charge)`
        : `Power Attack ${pa}: −${pa} attack`);
    }
    if (ce) parts.push(`Combat Expertise ${ce}: −${ce} attack, +${ce} dodge AC`);
    if (heedlessCharge() && !heedlessActive()) {
      parts.push('Heedless Charge needs a Power Attack of 5 or more — inert');
    }
    if (!parts.length) parts.push('No combat options declared.');
    out.textContent = parts.join(' · ');
    out.classList.toggle('co-readout-active', !!(pa || ce));

    // Clamp visibly rather than silently: a player who typed 12 into Power
    // Attack with BAB 6 should see it become 6, not have it quietly treated
    // as 6 while the box still claims 12.
    const paEl = byId('co-power-attack');
    if (paEl && paEl.value !== '' && intOf(paEl.value) !== pa) paEl.value = String(pa);
    const ceEl = byId('co-combat-expertise');
    if (ceEl && ceEl.value !== '' && intOf(ceEl.value) !== ce) ceEl.value = String(ce);
  }

  function build() {
    const host = byId('combat-options');
    if (!host || host.dataset.wired) return;
    host.dataset.wired = '1';
    for (const id of ['co-power-attack', 'co-combat-expertise', 'co-heedless-charge']) {
      const el = byId(id);
      if (!el) continue;
      el.addEventListener('input', () => { refresh(); recalc(); });
      el.addEventListener('change', () => { refresh(); recalc(); });
    }
    refresh();
  }

  function recalc() {
    try { if (typeof window.recalcAll === 'function') window.recalcAll(); }
    catch (e) { /* never break an edit */ }
  }

  // ---- save / load --------------------------------------------------------

  function collectData() {
    return {
      'co-power-attack': (byId('co-power-attack') || {}).value || '',
      'co-combat-expertise': (byId('co-combat-expertise') || {}).value || '',
      'co-heedless-charge': !!(byId('co-heedless-charge') || {}).checked,
    };
  }

  function loadData(data) {
    const d = data || {};
    const set = (id, v) => { const el = byId(id); if (el) el.value = v ?? ''; };
    set('co-power-attack', d['co-power-attack']);
    set('co-combat-expertise', d['co-combat-expertise']);
    const hc = byId('co-heedless-charge');
    if (hc) hc.checked = !!d['co-heedless-charge'];
    build();
    refresh();
  }

  return {
    build, refresh, getState, getActiveBonuses,
    powerAttack, combatExpertise, heedlessCharge, heedlessActive,
    attackPenalty, acChange, damageBonus,
    collectData, loadData,
  };
})();
