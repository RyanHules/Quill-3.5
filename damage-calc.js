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
//   light              x1       NONE           PHB Power Attack: "You can't add
//                                              the bonus ... with a light
//                                              weapon (except unarmed strikes)"
//   off-hand           x0.5     NONE           light, wielded off-hand
//   unarmed            x1       x1             the explicit exception above
//   natural (primary)  x1       x1             see below
//   natural (secondary) x0.5    x1             see below
//
// The two natural-weapon rows are RYAN'S RULING, and flagged as such because I
// could not corroborate them from this corpus. The only statement I found is
// Weapon Finesse's "Natural weapons are always considered light weapons", which
// read generally would forbid Power Attack on them entirely. He rules that
// natural weapons are an explicit exception and CAN be Power Attacked; that is
// his table and his call. It is modelled as its own STYLE rather than as a
// branch inside "light" precisely so the ruling is visible in the dropdown
// instead of buried in a condition somebody later "simplifies".
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
        <span class="atk-calc-op dmg-spec-op" style="display:none">+</span>
        <span class="atk-calc-term dmg-spec-term" style="display:none" title="Weapon Specialization / Greater Weapon Specialization for this weapon, read from the Feats tab."><span class="atk-calc-k">Spec</span><span class="calc-field dmg-spec">+0</span></span>
        <span class="atk-calc-op">+</span>
        <span class="atk-calc-term"><span class="atk-calc-k">Other</span><input type="text" class="dmg-misc" value="${esc(data.misc || '')}" placeholder="0"></span>
        <span class="atk-calc-op">=</span>
        <span class="calc-field dmg-total atk-calc-total-big">—</span>
        <label class="atk-calc-auto" title="Auto-fill the Damage field above from this equation."><input type="checkbox" class="dmg-auto-cb"${data.auto ? ' checked' : ''}> fill damage</label>
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

  function wire(entry) {
    const row = entry.querySelector('.damage-calc-row');
    if (!row || row.dataset.wired) return;
    row.dataset.wired = '1';
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('dmg-abil-add')) {
        row.querySelector('.dmg-abil-terms')
          .insertAdjacentHTML('beforeend', abilityTermHtml({ ability: 'STR', mult: '1' }));
        recalc();
      } else if (e.target.classList.contains('dmg-abil-remove')) {
        const terms = row.querySelectorAll('.dmg-abil-term');
        // Removing the last term is legitimate — a weapon can add no ability at
        // all (a light crossbow) — so this does not guard against emptiness.
        e.target.closest('.dmg-abil-term').remove();
        recalc();
      }
    });
    row.addEventListener('input', recalc);
    row.addEventListener('change', recalc);
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

    const flat = abilTotal + enh + pa + spec + misc;
    const dice = (row.querySelector('.dmg-dice').value || '').trim();
    const text = renderDamage(dice, flat);
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
      abilityTerms: Array.from(row.querySelectorAll('.dmg-abil-term')).map(t => ({
        ability: t.querySelector('.dmg-abil').value || 'STR',
        mult: t.querySelector('.dmg-abil-mult').value || 'auto',
      })),
    };
  }

  return {
    attachRow, recalcRow, collectRow, renderDamage, styleFor,
    STYLES, ABILITIES,
  };
})();
