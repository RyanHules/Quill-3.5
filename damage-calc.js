// damage-calc.js — a per-weapon damage equation, mirroring the attack-bonus
// calculator that already sits on every attack row (2026-08-20, phase A).
//
// WHY. `.atk-damage` was free text, and a survey of the saved characters showed
// what free text does to a field carrying structure: 517 attack rows, 204
// distinct damage strings, and the same concept written five ways — `S` / `Str`
// / `STR`, `.5*S` AND `S*1.5` (both operand orders), `d6` / `1d6` / `D10`,
// spaced or not. 78.5% carried an ability token and 13.9% a multiplier, which
// is exactly the structure a consumer needs and cannot reliably recover. The
// integration bug that started this was a consumer substituting `S` with full
// Strength on `3d6+.5*S` — a secondary natural attack at HALF.
//
// THE FIGHTING STYLE IS THE LOAD-BEARING CONTROL, because in 3.5 one choice
// drives two different multipliers, and the second one is the one people forget:
//
//   style              Str      Power Attack   source
//   one-handed         x1       x1             PHB
//   two-handed / 1H-in-2H  x1.5 x2             PHB Power Attack: "instead add
//                                              twice the number subtracted"
//   light              x1       NONE           PHB Power Attack, below
//   off-hand           x0.5     NONE           light, wielded off-hand
//   unarmed            x1       x1             explicit exception, below
//   natural (primary)  x1       x1             explicit exception, below
//   natural (secondary) x0.5    x1             explicit exception, below
//
// The carve-out is RAW and worth quoting in full, because it has two clauses
// and the second one is easy to miss:
//
//   "You can't add the bonus from Power Attack to the damage dealt with a light
//    weapon (except with unarmed strikes or natural weapon attacks), EVEN
//    THOUGH THE PENALTY ON ATTACK ROLLS STILL APPLIES."
//
// So a light weapon pays for Power Attack and gets nothing: the to-hit penalty
// lands anyway. That falls out correctly here because CombatOptions.attackPenalty()
// is style-blind by design — do not "fix" it by making the penalty conditional
// on the style, which is the shape of the mistake this comment exists to stop.
//
// (An earlier version of this comment claimed the natural-weapon exception was
// an uncorroborated house ruling. It is not; I had read a truncated excerpt
// that cut off mid-parenthesis at "except with unarmed stri" and concluded the
// text did not cover it. Read to the end of the sentence.)
//
// ABILITY TERMS ARE A LIST, not a single select, because a damage figure can
// draw on several abilities at once and can drop Strength entirely (Shadow
// Blade adding Dex, an Int-to-damage build). Dropping Strength is expressed by
// removing its term, so "instead of" needs no special case.
//
// OPT-IN, exactly like the attack calculator: the equation drives `.atk-damage`
// only while `fill damage` is ticked. Unticked, the field stays the player's
// free text and nothing here touches it. That is what makes this safe to ship
// against 517 existing rows.
const DamageCalc = (function () {
  'use strict';

  // [value, label, strMultiplier, powerAttackMultiplier]
  const STYLES = [
    ['one-hand', 'One-handed', 1, 1],
    ['two-hand', 'Two-handed', 1.5, 2],
    ['light', 'Light weapon', 1, 0],
    ['off-hand', 'Off-hand', 0.5, 0],
    ['unarmed', 'Unarmed strike', 1, 1],
    ['natural', 'Natural (primary)', 1, 1],
    ['natural-secondary', 'Natural (secondary)', 0.5, 1],
    ['none', 'No ability to damage', 0, 1],
  ];

  const ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
  // The multipliers that actually appear in the saved data, plus x2 which a
  // handful of rows use. Not a free-text box: an arbitrary multiplier is not a
  // thing 3.5 produces, and a select keeps the published value clean.
  const MULTS = [
    ['0.5', '×½'], ['1', '×1'], ['1.5', '×1½'], ['2', '×2'],
  ];

  function styleFor(key) {
    return STYLES.find(s => s[0] === key) || STYLES[0];
  }

  function num(v) {
    const n = parseInt(String(v ?? '').trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- markup -------------------------------------------------------------

  function abilityTermHtml(term) {
    const ability = ABILITIES.includes((term.ability || '').toUpperCase())
      ? term.ability.toUpperCase() : 'STR';
    const mult = MULTS.some(m => m[0] === String(term.mult)) ? String(term.mult) : '1';
    const abilOpts = ABILITIES.map(a =>
      `<option value="${a}"${a === ability ? ' selected' : ''}>${a}</option>`).join('');
    // The multiplier select shows "auto" when the term is following the
    // fighting style, which is the overwhelmingly common case — a Strength term
    // on a two-handed weapon should track the style, not be re-set by hand
    // every time the player switches grip.
    const multOpts = `<option value="auto"${term.mult == null || term.mult === 'auto' ? ' selected' : ''}>auto</option>` +
      MULTS.map(([v, label]) =>
        `<option value="${v}"${v === mult && term.mult != null && term.mult !== 'auto' ? ' selected' : ''}>${label}</option>`).join('');
    return `<span class="dmg-abil-term">` +
      `<select class="dmg-abil">${abilOpts}</select>` +
      `<select class="dmg-abil-mult" title="How much of this ability&#39;s modifier applies. ` +
        `&quot;auto&quot; follows the fighting style (two-handed = ×1½, off-hand and secondary naturals = ×½).">${multOpts}</select>` +
      `<span class="calc-field dmg-abil-val">+0</span>` +
      `<button type="button" class="dmg-abil-remove" title="Remove this ability term">&times;</button>` +
      `</span>`;
  }

  // ---- riders (phase B) ---------------------------------------------------
  //
  // A rider is extra damage that is not part of the weapon's own equation: a
  // flaming weapon's +1d6 fire, a holy weapon's +2d6 against evil, an energy
  // enhancement, a class feature that adds dice to one weapon.
  //
  // Two things keep this honest. Riders carry their own DICE rather than being
  // folded into the flat total, because "+1d6 fire" and "+3" are different
  // facts and a consumer rolling damage needs them apart. And a rider with a
  // CONDITION is never added to the base total — it is listed after it, because
  // a holy weapon's 2d6 against evil is not damage this weapon deals, it is
  // damage it deals sometimes, and quietly summing it would overstate every
  // swing against everything else.
  function riderHtml(r) {
    r = r || {};
    return `<span class="dmg-rider">` +
      `<input type="text" class="dmg-rider-amount" placeholder="1d6" value="${esc(r.amount || '')}" title="Dice or a flat number — 1d6, 2d6, +2.">` +
      `<input type="text" class="dmg-rider-label" placeholder="fire" value="${esc(r.label || '')}" title="What kind of damage it is: fire, cold, sonic, unholy…">` +
      `<input type="text" class="dmg-rider-cond" placeholder="always" value="${esc(r.condition || '')}" title="When it applies. Leave blank for always. A rider WITH a condition is listed separately and never folded into the base total — &quot;2d6 vs evil&quot; is not damage this weapon deals, it is damage it sometimes deals.">` +
      `<button type="button" class="dmg-rider-remove" title="Remove this rider">&times;</button>` +
      `</span>`;
  }

  function rowHtml(data) {
    const style = STYLES.some(s => s[0] === data.style) ? data.style : 'one-hand';
    const styleOpts = STYLES.map(([v, label]) =>
      `<option value="${v}"${v === style ? ' selected' : ''}>${label}</option>`).join('');
    const terms = Array.isArray(data.abilityTerms) && data.abilityTerms.length
      ? data.abilityTerms : [{ ability: 'STR', mult: 'auto' }];
    return `
      <div class="attack-row damage-calc-row" title="Damage equation: dice + ability modifiers + weapon enhancement + Power Attack + Weapon Specialization + other.">
        <span class="atk-calc-label">Dmg</span>
        <span class="atk-calc-term"><input type="text" class="dmg-dice" placeholder="1d8" value="${esc(data.dice || '')}"></span>
        <span class="atk-calc-term" title="How this weapon is being wielded. Drives BOTH the Strength multiplier and whether Power Attack applies — a light weapon gets no Power Attack damage at all."><select class="dmg-style">${styleOpts}</select></span>
        <span class="dmg-abil-terms">${terms.map(abilityTermHtml).join('')}</span>
        <button type="button" class="dmg-abil-add" title="Add another ability to damage">+ ability</button>
        <span class="atk-calc-op">+</span>
        <span class="atk-calc-term" title="Weapon enhancement bonus. Feeds BOTH this equation and the attack bonus above."><span class="atk-calc-k">Enh</span><input type="text" class="dmg-enh" value="${esc(data.enh || '')}" placeholder="0"></span>
        <span class="atk-calc-op dmg-pa-op" style="display:none">+</span>
        <span class="atk-calc-term dmg-pa-term" style="display:none" title="Power Attack, declared once in Combat Options and multiplied by this weapon's fighting style (×2 two-handed, none for a light or off-hand weapon)."><span class="atk-calc-k">PA</span><span class="calc-field dmg-pa">+0</span></span>
        <span class="atk-calc-op dmg-meld-op" style="display:none">+</span>
        <span class="atk-calc-term dmg-meld-term" style="display:none" title="Soulmeld effects that apply to this weapon, computed from the essentia invested in them. Set them up in a soulmeld's ⓘ panel on the Equipment tab."><span class="atk-calc-k">Meld</span><span class="calc-field dmg-meld">+0</span></span>
        <span class="atk-calc-op dmg-spec-op" style="display:none">+</span>
        <span class="atk-calc-term dmg-spec-term" style="display:none" title="Weapon Specialization / Greater Weapon Specialization for this weapon, read from the Feats tab."><span class="atk-calc-k">Spec</span><span class="calc-field dmg-spec">+0</span></span>
        <span class="atk-calc-op">+</span>
        <span class="atk-calc-term"><span class="atk-calc-k">Other</span><input type="text" class="dmg-misc" value="${esc(data.misc || '')}" placeholder="0"></span>
        <span class="atk-calc-op">=</span>
        <span class="calc-field dmg-total atk-calc-total-big">—</span>
        <label class="atk-calc-auto" title="Auto-fill the Damage field above from this equation."><input type="checkbox" class="dmg-auto-cb"${data.auto ? ' checked' : ''}> fill damage</label>
      </div>
      <div class="attack-row damage-riders-row" title="Extra damage that is not part of the weapon's own equation — a flaming weapon's +1d6 fire, a holy weapon's +2d6 against evil.">
        <span class="atk-calc-label">Riders</span>
        <span class="dmg-riders">${(Array.isArray(data.riders) ? data.riders : []).map(riderHtml).join('')}</span>
        <button type="button" class="dmg-rider-add" title="Add a damage rider">+ rider</button>
        <span class="dmg-riders-readout"></span>
      </div>`;
  }

  // Attach the damage row to an attack entry. Called by character.js#addAttack.
  function attachRow(entry, data) {
    if (!entry || entry.querySelector('.damage-calc-row')) return;
    const calcRow = entry.querySelector('.attack-calc-row');
    const html = rowHtml(data || {});
    if (calcRow) calcRow.insertAdjacentHTML('afterend', html);
    else entry.insertAdjacentHTML('beforeend', html);
    wire(entry);
  }

  // Refresh a MANAGED row's equation in place — a soulmeld's granted attack,
  // whose dice and riders both move when the player shifts an essentia pip
  // (Kruthik Claws' claws carry 1d4 acid PER POINT, so three pips is 3d4).
  //
  // Every write is guarded on actually changing, and the ability terms and
  // riders are rebuilt only when their signature differs. That matters because
  // this runs on every recalc: rewriting the DOM unconditionally would eat a
  // keystroke mid-edit and drop focus out of a half-typed field.
  //
  // The caller decides whether a row is still managed. Once the player edits
  // one it is theirs, character.js drops the marker, and this is never called
  // for it again.
  function updateRow(entry, data) {
    const row = entry && entry.querySelector('.damage-calc-row');
    if (!row || !data) return;
    const set = (sel, v) => {
      const el = row.querySelector(sel);
      if (el && v != null && el.value !== String(v)) el.value = String(v);
    };
    set('.dmg-dice', data.dice);
    set('.dmg-style', data.style);

    const terms = Array.isArray(data.abilityTerms) ? data.abilityTerms : [];
    const termSig = terms.map(t => `${t.ability}:${t.mult}`).join(',');
    const termHolder = row.querySelector('.dmg-abil-terms');
    if (termHolder && termHolder.dataset.sig !== termSig) {
      termHolder.dataset.sig = termSig;
      termHolder.innerHTML = terms.map(abilityTermHtml).join('');
    }

    // `entry`, not `row` — the riders strip lives in the SIBLING riders row.
    const riders = Array.isArray(data.riders) ? data.riders : [];
    const riderSig = riders.map(r => `${r.amount}|${r.label}|${r.condition}`)
      .join(',');
    const riderHolder = entry.querySelector('.dmg-riders');
    if (riderHolder && riderHolder.dataset.sig !== riderSig) {
      riderHolder.dataset.sig = riderSig;
      riderHolder.innerHTML = riders.map(riderHtml).join('');
    }
  }

  // Listeners go on the ENTRY, not on the damage row: the riders live in a
  // SIBLING row, so a listener bound to the damage row never sees the "+ rider"
  // button at all. (It rendered fine and did nothing, which is the failure mode
  // that looks like a styling problem.)
  function wire(entry) {
    const row = entry.querySelector('.damage-calc-row');
    if (!row || entry.dataset.dmgWired) return;
    entry.dataset.dmgWired = '1';
    entry.addEventListener('click', (e) => {
      if (e.target.classList.contains('dmg-abil-add')) {
        row.querySelector('.dmg-abil-terms')
          .insertAdjacentHTML('beforeend', abilityTermHtml({ ability: 'STR', mult: '1' }));
        recalc();
      } else if (e.target.classList.contains('dmg-rider-add')) {
        // `entry`, not `row`: the riders strip is in the SIBLING riders row, so
        // querying from the damage row returns null. Same trap as the listener
        // binding above, one level down.
        entry.querySelector('.dmg-riders').insertAdjacentHTML('beforeend', riderHtml({}));
        recalc();
      } else if (e.target.classList.contains('dmg-rider-remove')) {
        e.target.closest('.dmg-rider').remove();
        recalc();
      } else if (e.target.classList.contains('dmg-abil-remove')) {
        const terms = row.querySelectorAll('.dmg-abil-term');
        // Removing the last term is legitimate — a weapon can add no ability at
        // all (a light crossbow) — so this does not guard against emptiness.
        e.target.closest('.dmg-abil-term').remove();
        recalc();
      }
    });
    entry.addEventListener('input', (e) => {
      if (e.target.closest('.damage-calc-row, .damage-riders-row')) recalc();
    });
    entry.addEventListener('change', (e) => {
      if (e.target.closest('.damage-calc-row, .damage-riders-row')) recalc();
    });
  }

  function recalc() {
    try { if (typeof window.recalcAll === 'function') window.recalcAll(); }
    catch (e) { /* never break an edit */ }
  }

  // ---- computation --------------------------------------------------------

  // `ctx` supplies what only character.js knows: getAbilityMod (bonus-aware)
  // and the Weapon Specialization map. Passing them in rather than reaching for
  // globals keeps this callable from a test without a whole sheet.
  function recalcRow(entry, ctx) {
    const row = entry.querySelector('.damage-calc-row');
    if (!row) return;
    const style = styleFor(row.querySelector('.dmg-style').value);
    const [, , strMultDefault, paMult] = style;

    // Ability terms.
    let abilTotal = 0;
    for (const term of row.querySelectorAll('.dmg-abil-term')) {
      const ability = term.querySelector('.dmg-abil').value || 'STR';
      const multSel = term.querySelector('.dmg-abil-mult').value;
      const mult = (multSel === 'auto') ? strMultDefault : parseFloat(multSel);
      const mod = ctx.getAbilityMod(ability);
      // 3.5 rounds a fractional ability bonus to damage DOWN, and does it after
      // multiplying — x1.5 of a +3 is +4, not +4.5 and not +3 doubled-then-
      // halved. Math.floor rather than Math.round for the same reason: 1.5 x 1
      // is +1, not +2.
      const value = Math.floor(mod * mult);
      term.querySelector('.dmg-abil-val').textContent = fmt(value);
      abilTotal += value;
    }

    const enh = num(row.querySelector('.dmg-enh').value);
    const misc = ctx.expr ? ctx.expr(row.querySelector('.dmg-misc').value || '')
                          : num(row.querySelector('.dmg-misc').value);

    // Power Attack, multiplied by the style. A light or off-hand weapon gets
    // nothing, which is the rule people forget.
    const pa = (typeof CombatOptions !== 'undefined')
      ? CombatOptions.damageBonus(paMult) : 0;
    setTerm(row, '.dmg-pa', '.dmg-pa-term', '.dmg-pa-op', pa);

    // Weapon Specialization, matched to this row's weapon name by the same
    // helper the attack calculator uses for Weapon Focus.
    const weaponName = (entry.querySelector('.atk-name')?.value || '').trim().toLowerCase();
    let spec = 0;
    if (weaponName && ctx.weaponSpec) {
      for (const [k, v] of Object.entries(ctx.weaponSpec)) {
        if (ctx.matches(weaponName, k)) spec += v;
      }
    }
    setTerm(row, '.dmg-spec', '.dmg-spec-term', '.dmg-spec-op', spec);

    // Soulmeld effects, filtered by what this weapon IS — Dread Carapace's
    // damage applies to natural weapons and to nothing else, so the style has
    // to be consulted before the number is allowed anywhere near the total.
    let meld = 0;
    if (typeof SoulmeldEffects !== 'undefined' && SoulmeldEffects.getWeaponMods) {
      try { meld = SoulmeldEffects.getWeaponMods(style[0]).damage || 0; }
      catch (e) { meld = 0; }
    }
    setTerm(row, '.dmg-meld', '.dmg-meld-term', '.dmg-meld-op', meld);

    const flat = abilTotal + enh + pa + spec + meld + misc;
    const dice = (row.querySelector('.dmg-dice').value || '').trim();
    let text = renderDamage(dice, flat);

    // Riders. Unconditional ones join the line ("plus 1d6 fire"); conditional
    // ones are listed after it and are NEVER summed in, because a holy weapon's
    // 2d6 against evil is not damage this weapon deals — it is damage it deals
    // sometimes, and folding it in would overstate every other swing.
    const riders = readRiders(entry);
    const always = riders.filter(r => !r.condition);
    const sometimes = riders.filter(r => r.condition);
    if (always.length) text += ' plus ' + always.map(riderText).join(', ');
    const readout = row.parentElement.querySelector('.dmg-riders-readout');
    if (readout) {
      readout.textContent = sometimes.length
        ? 'situational: ' + sometimes.map(riderText).join(', ') : '';
    }
    row.querySelector('.dmg-total').textContent = text || '—';

    const dmgInput = entry.querySelector('.atk-damage');
    if (row.querySelector('.dmg-auto-cb')?.checked) {
      dmgInput.value = text;
      dmgInput.readOnly = true;
      dmgInput.classList.add('atk-bonus-auto');
    } else {
      dmgInput.readOnly = false;
      dmgInput.classList.remove('atk-bonus-auto');
    }
  }

  // A rider is only real once it has an amount; a blank row is someone
  // mid-typing, not a fact about the weapon.
  function readRiders(entry) {
    const row = entry.querySelector('.damage-calc-row');
    const strip = entry.querySelector('.dmg-riders');
    if (!row || !strip) return [];
    return Array.from(strip.querySelectorAll('.dmg-rider')).map(r => ({
      amount: (r.querySelector('.dmg-rider-amount').value || '').trim(),
      label: (r.querySelector('.dmg-rider-label').value || '').trim(),
      condition: (r.querySelector('.dmg-rider-cond').value || '').trim(),
    })).filter(r => r.amount);
  }

  // "1d6 fire" for an unconditional rider, "2d6 unholy vs good" for a
  // conditional one. Used for the readout and the fill text.
  function riderText(r) {
    const head = r.amount + (r.label ? ' ' + r.label : '');
    return r.condition ? `${head} ${r.condition}` : head;
  }

  function setTerm(row, valSel, termSel, opSel, value) {
    const el = row.querySelector(valSel);
    if (el) el.textContent = fmt(value);
    const term = row.querySelector(termSel);
    const op = row.querySelector(opSel);
    if (term) term.style.display = value ? '' : 'none';
    if (op) op.style.display = value ? '' : 'none';
  }

  function fmt(n) { return (n >= 0 ? '+' : '') + n; }

  // "1d8" + 7 -> "1d8+7"; no dice -> just the number; flat 0 -> just the dice.
  function renderDamage(dice, flat) {
    if (!dice) return flat ? String(flat) : (flat === 0 ? '0' : '');
    if (!flat) return dice;
    return dice + (flat > 0 ? '+' : '') + flat;
  }

  // ---- save / load --------------------------------------------------------

  function collectRow(entry) {
    const row = entry.querySelector('.damage-calc-row');
    if (!row) return null;
    return {
      dice: row.querySelector('.dmg-dice').value || '',
      style: row.querySelector('.dmg-style').value || 'one-hand',
      enh: row.querySelector('.dmg-enh').value || '',
      misc: row.querySelector('.dmg-misc').value || '',
      auto: !!row.querySelector('.dmg-auto-cb')?.checked,
      riders: readRiders(entry),
      abilityTerms: Array.from(row.querySelectorAll('.dmg-abil-term')).map(t => ({
        ability: t.querySelector('.dmg-abil').value || 'STR',
        mult: t.querySelector('.dmg-abil-mult').value || 'auto',
      })),
    };
  }

  // ---- publishing to the live bus -----------------------------------------
  //
  // The structured damage field Vaire asked for (2026-08-20 mail). The bus
  // publishes `.atk-damage` verbatim, and a consumer cannot reliably recover
  // structure from it: the live party writes `3d6+.5*S` and `d4+.5*S`, and a
  // consumer substituting `S` with full Strength gets secondary naturals wrong.
  // He removed his substitution and multiplies by hand; this is what stops him
  // having to.
  //
  // READS WHAT THE SHEET ALREADY COMPUTED rather than recomputing it. Every
  // value below is lifted from the span recalcRow just wrote. That is the whole
  // premise of the bus — two implementations of 3.5 damage math would diverge,
  // which is the bug that started this — and it means the multiplier arrives
  // RESOLVED. `mult: "auto"` is a UI convenience meaning "follow the fighting
  // style"; publishing that string would hand the consumer the same problem in
  // a new costume, so the resolved number goes out alongside it.
  //
  // Published ALONGSIDE the verbatim string, never instead of it: the string is
  // what the player typed and stays authoritative.
  function publishRow(entry) {
    const row = entry.querySelector('.damage-calc-row');
    if (!row) return null;
    const styleKey = row.querySelector('.dmg-style').value || 'one-hand';
    const [, styleLabel, strMultDefault, paMult] = styleFor(styleKey);
    const readTerm = (sel) => {
      const el = row.querySelector(sel);
      if (!el) return 0;
      const n = parseInt(String(el.textContent || '').trim(), 10);
      return Number.isFinite(n) ? n : 0;
    };
    const abilityTerms = Array.from(row.querySelectorAll('.dmg-abil-term')).map((t) => {
      const declared = t.querySelector('.dmg-abil-mult').value || 'auto';
      const valEl = t.querySelector('.dmg-abil-val');
      const v = parseInt(String((valEl && valEl.textContent) || '').trim(), 10);
      return {
        ability: t.querySelector('.dmg-abil').value || 'STR',
        // The number that actually applied, and what the player chose.
        multiplier: (declared === 'auto') ? strMultDefault : parseFloat(declared),
        multiplier_follows_style: declared === 'auto',
        // Already floored — 3.5 rounds a fractional ability bonus to damage
        // DOWN, and does it AFTER multiplying.
        value: Number.isFinite(v) ? v : 0,
      };
    });
    const enh = num(row.querySelector('.dmg-enh').value);
    const misc = num(row.querySelector('.dmg-misc').value);
    const abilityTotal = abilityTerms.reduce((a, t) => a + (t.value || 0), 0);
    const powerAttack = readTerm('.dmg-pa');
    const weaponSpec = readTerm('.dmg-spec');
    const soulmeld = readTerm('.dmg-meld');
    return {
      dice: (row.querySelector('.dmg-dice').value || '').trim() || null,
      style: styleKey,
      style_label: styleLabel,
      // Both multipliers the style implies, because the second one is the one
      // people forget: a light weapon gets NO Power Attack damage at all.
      strength_multiplier: strMultDefault,
      power_attack_multiplier: paMult,
      ability_terms: abilityTerms,
      enhancement: enh,
      power_attack: powerAttack,
      weapon_specialization: weaponSpec,
      soulmeld: soulmeld,
      misc: misc,
      // Everything that is not dice, summed the way the sheet sums it.
      flat_total: abilityTotal + enh + powerAttack + weaponSpec + soulmeld + misc,
      // What the sheet renders, for a consumer that just wants the line.
      rendered: (row.querySelector('.dmg-total') || {}).textContent || null,
      // Whether the equation is DRIVING the free-text box. Unticked, the string
      // is the player's own and this structure describes an equation they are
      // not using — which a consumer needs to know before trusting it over the
      // string.
      drives_damage_field: !!row.querySelector('.dmg-auto-cb')?.checked,
    };
  }

  return {
    attachRow, updateRow, recalcRow, collectRow, renderDamage, styleFor,
    readRiders, riderText, publishRow,
    STYLES, ABILITIES,
  };
})();
