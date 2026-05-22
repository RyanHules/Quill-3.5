// homebrew/item_familiar.js — Diamond Soul campaign homebrew for
// the Item Familiar feat (Unearthed Arcana p.170).
//
// Three independently-togglable rules:
//
//   if_free_for_jianghu          — feat slot waived for Jianghu wanderers
//   if_progressive_bond_track    — replaces UA Table 5-12 with a continuous
//                                   every-other-level progression
//   if_augmentation_budget       — L5/L9/L13/L17 picks are gp budgets via
//                                   DMG p.285 custom-item pricing
//
// All three default to OFF so the sheet behaves RAW out of the box.
// When enabled, the rules are surfaced inside the Item Familiar
// feat's rules panel (the ⓘ toggle on the feat row in the Feats
// tab) — `appendRulesHtml(featName)` is called by feats.js and
// returns HTML to append below the standard rules text.
//
// Source: `for_ryan_item_familiar_rules.md` in the Diamond Soul
// campaign repo (current as of May 19 2026).

(function () {
  if (!window.HomebrewFilter) {
    console.warn('[homebrew/item_familiar] HomebrewFilter not loaded; ' +
      'rules will not appear in the toggle UI.');
    return;
  }

  // parentKey='book_DS' nests these three rules under the Diamond
  // Soul (Homebrew) parent in the UI, so all Diamond Soul homebrew
  // (content + rules) lives in one collapsible bundle instead of
  // being scattered across two top-level categories. The Diamond
  // Soul parent is registered by homebrew/book_content.js when the
  // DB loads. If that registration hasn't happened yet (DB still
  // loading), the parentKey simply points at a key that will exist
  // shortly — the UI re-renders on each modal open, so by the time
  // the user sees the modal, both registrations have completed.
  HomebrewFilter.registerRule({
    key: 'if_free_for_jianghu',
    name: 'Item Familiar — free for Jianghu wanderers',
    category: 'Item Familiar',
    parentKey: 'book_DS',
    description:
      'Item Familiar (UA p.170) costs no feat slot for Jianghu wanderer ' +
      'PCs and NPCs. Loss penalty, investment mechanics, L7 sapience, ' +
      'and special-ability progressions all remain full RAW — only the ' +
      'feat-slot tax is waived.',
    source: 'Diamond Soul campaign',
    defaultEnabled: false,
  });
  HomebrewFilter.registerRule({
    key: 'if_progressive_bond_track',
    name: 'Item Familiar — Progressive Bond Track',
    category: 'Item Familiar',
    parentKey: 'book_DS',
    description:
      'Replaces UA Table 5-12 with a continuous progression every other ' +
      'level: L3 bond + Alertness, L5/L9/L13/L17 augmentation budgets, ' +
      'L7 sapience (RAW), L9 hardness/HP, L11 Lesser Power, L13 Spell ' +
      'Use / Maneuver Use, L15 Greater Power, L19 Increased Sapience or ' +
      'Special Purpose. Eliminates the L1–L9 dead zone and adds ' +
      'Maneuver Use as the martial parallel to Spell Use.',
    source: 'Diamond Soul campaign',
    defaultEnabled: false,
  });
  HomebrewFilter.registerRule({
    key: 'if_augmentation_budget',
    name: 'Item Familiar — Augmentation Budget',
    category: 'Item Familiar',
    parentKey: 'book_DS',
    description:
      'The L5/L9/L13/L17 picks from the Progressive Bond Track operate ' +
      'as gp budgets spent via DMG p.285 custom-item pricing: 2,000 / ' +
      '6,000 / 10,000 / 14,000 gp. Tier-discrete (no rollover); picks ' +
      'are permanent. Universal across item types (weapons, armor, ' +
      'amulets, wondrous, etc.). Requires Progressive Bond Track also ' +
      'enabled to be meaningful.',
    source: 'Diamond Soul campaign',
    defaultEnabled: false,
  });

  // ---- Rules-panel rendering ---------------------------------------------

  function appendRulesHtml(featName) {
    if (!featName) return '';
    // Strip a trailing parenthetical the user may have typed (e.g.
    // "Item Familiar (Jar of Eternal Haboob)") so the comparison
    // matches the canonical name.
    const norm = featName.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();
    if (norm !== 'item familiar') return '';

    const HBF = window.HomebrewFilter;
    const blocks = [];
    if (HBF.isEnabled('if_free_for_jianghu')) {
      blocks.push(renderFreeFeatBlock());
    }
    if (HBF.isEnabled('if_progressive_bond_track')) {
      blocks.push(renderBondTrackBlock());
    }
    if (HBF.isEnabled('if_augmentation_budget')) {
      blocks.push(renderBudgetBlock());
    }
    return blocks.length ? blocks.join('') : '';
  }

  function renderFreeFeatBlock() {
    return `
<div class="hb-block">
  <div class="hb-block-head">
    <span class="hb-tag">Homebrew</span>
    <span class="hb-block-title">Free feat for Jianghu wanderers</span>
    <span class="hb-src">Diamond Soul</span>
  </div>
  <div class="hb-block-body">
    Item Familiar costs no feat slot for any wandering martial cultivator
    (Jianghu wanderers — PCs and NPCs, allies and enemies). Everything else
    is full RAW.
    <div class="hb-detail">
      <b>Qualifies:</b> wandering martial cultivators (martial subculture
      PCs and NPCs, past masters whose relics persist).<br>
      <b>Does not qualify by default:</b> non-Jianghu characters; school-
      attached institutional members who aren't wanderers (Beregost
      merchants, civilian scholars). DM may grant per-character exceptions
      (Sneez received this for his Spellsight Spectacles).<br>
      <b>Mechanics that stay live:</b> the loss penalty (item destroyed or
      separated &gt;1 day/level → lose all invested XP + 200 XP/level + bond
      benefits + invested ranks/slots), inheritance rules, and the L7
      sapience awakening, all per UA.
    </div>
  </div>
</div>`;
  }

  function renderBondTrackBlock() {
    return `
<div class="hb-block">
  <div class="hb-block-head">
    <span class="hb-tag">Homebrew</span>
    <span class="hb-block-title">Progressive Bond Track (replaces UA Table 5-12)</span>
    <span class="hb-src">Diamond Soul</span>
  </div>
  <div class="hb-block-body">
    Continuous progression every other level, with budgets for non-caster
    bonds so the early-mid game has real presence.
    <table class="hb-table">
      <thead><tr><th>Tier</th><th>Benefit</th></tr></thead>
      <tbody>
        <tr><td>L3</td><td>Bond exists. +10% XP gain (UA). Skill rank
          investment (UA). <b>Alertness while wielded</b> (moved from UA L7).</td></tr>
        <tr><td>L5</td><td><b>Free augmentation pick, 2,000 gp budget.</b>
          Spent per DMG p.285 custom-item pricing.</td></tr>
        <tr><td>L7</td><td>UA RAW: Sapience (Int/Wis/Cha 10/10/12), Senses
          (60 ft sight + hearing), Communication (emotions/feelings).</td></tr>
        <tr><td>L9</td><td>Item hardness = ½ character level, +1 hp per
          character level. Still sunderable.
          <b>Free augmentation pick, 6,000 gp budget.</b></td></tr>
        <tr><td>L11</td><td><b>Free Lesser Power</b> from DMG p.269
          intelligent-item Lesser Powers list — no gp cost.</td></tr>
        <tr><td>L13</td><td><b>Spell Use / Maneuver Use baseline.</b>
          The item acts on the master's turn once per round as its own
          standard action: casts one invested spell (caster) or initiates
          one invested maneuver (initiator), on the master's order.
          <b>Free augmentation pick, 10,000 gp budget.</b></td></tr>
        <tr><td>L15</td><td><b>Free Greater Power</b> from DMG p.270 list —
          no gp cost.</td></tr>
        <tr><td>L17</td><td><b>Free augmentation pick, 14,000 gp budget.</b></td></tr>
        <tr><td>L19</td><td><b>Increased Sapience</b> (+4 to one mental
          score, +2 others; telepathy at 120 ft; speaks Common audibly)
          <b>OR Special Purpose / Dedicated Power</b> (DMG p.270).</td></tr>
      </tbody>
    </table>
    <div class="hb-detail">
      <b>Spell Use (casters):</b> at L13 the item itself casts one invested
      spell on the master's turn as its own standard action. The invested
      spell is one the master invested per UA spell-slot rules.<br>
      <b>Maneuver Use (martial initiators):</b> the master invests one
      maneuver known at their highest available maneuver level. The
      investment auto-shifts up as IL grows. The master also gains a bonus
      maneuver known at (highest invested −2) levels lower, held in the
      item, usable while wielding. At L13 the item itself can initiate the
      invested maneuver as its own standard action per round on master's
      order. Recovery follows master's normal initiator rules.
    </div>
  </div>
</div>`;
  }

  function renderBudgetBlock() {
    return `
<div class="hb-block">
  <div class="hb-block-head">
    <span class="hb-tag">Homebrew</span>
    <span class="hb-block-title">Augmentation Budget rule</span>
    <span class="hb-src">Diamond Soul</span>
  </div>
  <div class="hb-block-body">
    The L5/L9/L13/L17 picks are gp budgets spent via the DMG p.285
    custom-magic-item pricing system. Universal across item types.
    <table class="hb-table">
      <thead><tr><th>Tier</th><th>Budget</th></tr></thead>
      <tbody>
        <tr><td>L5</td><td>2,000 gp</td></tr>
        <tr><td>L9</td><td>6,000 gp</td></tr>
        <tr><td>L13</td><td>10,000 gp</td></tr>
        <tr><td>L17</td><td>14,000 gp</td></tr>
      </tbody>
    </table>
    <div class="hb-detail">
      <b>Tier-discrete.</b> Unspent gp does not roll over. A pick cannot
      exceed its tier's budget. No saving for one late capstone.<br>
      <b>Picks are permanent</b> (hard-lock ruling, May 19 2026). Once
      chosen for a tier, an augmentation cannot be swapped or modified at
      a later tier. The escape valve is rebonding a new Item Familiar
      entirely (per UA Inheritance) — full progression-restart cost. Same
      ruling applies to Kensai Signature Weapon imbuements.<br>
      <b>Spend via DMG p.285.</b> Base spell-effect formulas, the
      "Estimating Magic Item Gold Piece Values" table, and standard
      multipliers (limitations on use, single-charge-per-day, etc.).<br>
      <b>Attaches to the bonded item.</b> Must enchant the bonded item
      itself, not produce a separate effect. Continuous effect radiates
      from the item when worn/wielded; active effect activates via
      command-word or use-activation.<br>
      <b>Stacks with paid enchantments.</b> A +1 weapon's L5 free pick can
      add a +1-equivalent special ability (going to +2-equivalent total).<br>
      <b>DM sanity check on absurd combinations.</b>
    </div>
    <div class="hb-detail">
      <b>Worked examples:</b><br>
      <b>Weapon:</b> L5 → +1 (2,000). L9 → +2 (6,000). L13 → +3 (10,000).
      L17 → +4 (14,000). Or keep at +1 and spend later budgets on special
      abilities (keen, flaming, etc.).<br>
      <b>Amulet of Natural Armor:</b> L5 → +1. L9 → +2. L13 → +3. L17 → +4.<br>
      <b>Wondrous spell-effect item (e.g. Jar of Eternal Haboob):</b>
      L5 → +1 CL. L9 → CL bump + rider. L13 → +1 save DC or bolted-on
      related spell-effect. L17 → capstone (extended duration, permanent-
      but-suppressible aura, etc.).
    </div>
  </div>
</div>`;
  }

  // Expose for feats.js (and any other consumer that needs to inject
  // homebrew rules text into a panel).
  window.HomebrewItemFamiliar = { appendRulesHtml };
})();
