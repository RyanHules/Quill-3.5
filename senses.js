// senses.js — the Senses block (2026-08-21).
//
// WHY. The sheet already HAD this data and never showed it. A race's canonical
// `senses` list — [{sense, range_ft?, multiplier?}] — has been parsed and
// variant-merged in race-picker for months, and its only destination was one
// sentence inside the race panel. Soulmelds grant darkvision. Nothing on the
// sheet could answer "how far can I see in the dark", which is a question that
// comes up every time the party walks into a cave.
//
// So this is a central place for senses, and it follows defense-riders.js
// rather than inventing a second idiom: rows carry a `from` source key, are
// pushed in by whoever grants them, and a hand-added row is the player's own.
//
// RANGES DO NOT ADD — the best applies. Darkvision 60 from your race and
// darkvision 60 from a soulmeld is darkvision 60, not 120. Dragonfire Mask
// says so explicitly ("you gain darkvision out to 60 feet, OR your existing
// darkvision extends another 30 feet"), which is the exception that proves it:
// a soulmeld has to SAY it extends, because otherwise it would overlap. The
// extend case is a `plus_ft` row, resolved after the best base is chosen.
//
// ILLUMINATION AND LIGHT SOURCES. The chip shows the radius you are actually
// lighting, which is the better of a carried light source and any soulmeld
// illumination. The light sources carry their own burn-down, because "is the
// torch out yet" is real bookkeeping nobody enjoys doing on paper: six ticks
// each, where a tick is a sixth of that source's printed duration, and a reset
// for lighting a fresh one. Every radius and duration below is the PHB's own
// text, read out of the DB rather than from memory — a torch is 1 hour and a
// 20-foot radius; a pint of oil is 6 hours in a lantern.
const Senses = (function () {
  'use strict';

  function byId(id) { return document.getElementById(id); }

  // The senses a 3.5 character can have, in the DB's own vocabulary (the
  // `sense` key of a canonical senses row), plus how each is measured.
  //   range  — feet, best-of
  //   mult   — a multiplier on normal sight (low-light vision)
  //   flag   — you either have it or you do not
  const SENSE_KINDS = [
    ['darkvision', 'darkvision', 'range'],
    ['low_light_vision', 'low-light vision', 'mult'],
    ['blindsense', 'blindsense', 'range'],
    ['blindsight', 'blindsight', 'range'],
    ['tremorsense', 'tremorsense', 'range'],
    ['scent', 'scent', 'flag'],
    ['see_invisibility', 'see invisibility', 'flag'],
    ['true_seeing', 'true seeing', 'flag'],
    ['lifesense', 'lifesense', 'range'],
    ['mindsight', 'mindsight', 'range'],
  ];
  const KIND_OF = {};
  const LABEL_OF = {};
  SENSE_KINDS.forEach(([k, label, kind]) => { KIND_OF[k] = kind; LABEL_OF[k] = label; });

  // PHB light sources. Radius / duration are the book's own values, taken from
  // the DB entries rather than recalled: a torch clearly illuminates a 20-foot
  // radius and burns 1 hour; a candle 5 feet and 1 hour; hooded lantern and
  // sunrod 30 feet, 6 hours; a bullseye lantern is a 60-foot CONE, not a
  // radius, which is why it is labelled as one.
  //   [key, label, radius_ft, minutes, note]
  const LIGHT_SOURCES = [
    ['', '— none —', 0, 0, ''],
    ['candle', 'Candle', 5, 60, 'dim light only'],
    ['torch', 'Torch', 20, 60, 'shadowy to 40 ft.'],
    ['lantern_hooded', 'Lantern, hooded', 30, 360, 'shadowy to 60 ft.; 1 pint of oil'],
    ['lantern_bullseye', 'Lantern, bullseye', 60, 360, '60-ft. CONE, not a radius; 1 pint of oil'],
    ['sunrod', 'Sunrod', 30, 360, 'shadowy to 60 ft.; burns out for good'],
    ['everburning', 'Everburning torch', 20, 0, 'continual flame — never burns out'],
  ];
  const LIGHT_BY_KEY = {};
  LIGHT_SOURCES.forEach(l => { LIGHT_BY_KEY[l[0]] = l; });

  // Soulmelds express a sense as a BONUS row rather than a senses row,
  // because that is the shape the rest of their effects use. These are the
  // bonus_types that are really senses.
  const SENSE_BONUS_TYPES = new Set(['darkvision', 'blindsense', 'blindsight',
                                     'tremorsense', 'lifesense', 'mindsight']);

  const TICKS = 6;          // always six, so a tick is duration/6 whatever it is

  // ---- state --------------------------------------------------------------
  //
  // `rows` are only the PLAYER's own additions; everything auto-derived is
  // recomputed on every render from its source, so a DB correction reaches the
  // character instead of being frozen into the save.
  let manual = [];                       // [{sense, range_ft, multiplier, note}]
  let light = { source: '', used: 0 };   // used = ticks burned

  // ---- collection ---------------------------------------------------------

  // Everything granting a sense right now, each tagged with where it came from.
  // `plus_ft` rows EXTEND rather than replace (Dragonfire Mask's brow bind).
  function collect() {
    const out = [];
    const push = (s, from) => {
      if (!s || !s.sense) return;
      out.push({ sense: s.sense, range_ft: s.range_ft || null,
                 multiplier: s.multiplier || null, plus_ft: s.plus_ft || null,
                 note: s.note || null, from });
    };
    if (typeof RacePicker !== 'undefined' && RacePicker.getActiveSenses) {
      try { for (const s of RacePicker.getActiveSenses()) push(s, s.source || 'race'); }
      catch (e) { /* a picker that is not ready must not break the block */ }
    }
    // Soulmelds express a sense as a bonus row (`bonus_type:'darkvision'`)
    // because that is the shape the rest of their effects use; translate it
    // here rather than making the DB carry a second shape for one case.
    if (typeof SoulmeldEffects !== 'undefined' && SoulmeldEffects.computeAll) {
      try {
        for (const e of SoulmeldEffects.computeAll()) {
          if (!SENSE_BONUS_TYPES.has(e.bonus_type) || !e.amount) continue;
          push({ sense: e.bonus_type, range_ft: e.amount, note: e.condition },
               e.soulmeld);
        }
      } catch (e) { /* likewise */ }
      // ...and the senses that CANNOT be a number: low-light vision and its
      // multiplier, see invisibility, true seeing, scent. Those have no range
      // to put in an `amount`, so they arrive as granted abilities instead
      // (2026-08-21). Two shapes, one destination — which is the right way
      // round: the DB says what each sense IS, and this block is the single
      // place that resolves them all against each other.
      if (SoulmeldEffects.grantedSenses) {
        try {
          for (const s of SoulmeldEffects.grantedSenses()) {
            push({ sense: s.sense, range_ft: s.range_ft,
                   multiplier: s.multiplier, note: s.note }, s.from);
          }
        } catch (e) { /* likewise */ }
      }
    }
    for (const m of manual) push(m, 'you');
    return out;
  }

  // Resolve to one row per sense: BEST range wins (they overlap, they do not
  // add), then any `plus_ft` extensions are added on top of that winner.
  function resolved() {
    const best = new Map();
    const extend = new Map();
    for (const r of collect()) {
      if (r.plus_ft) {
        extend.set(r.sense, (extend.get(r.sense) || 0) + r.plus_ft);
        continue;
      }
      const cur = best.get(r.sense);
      const kind = KIND_OF[r.sense] || 'flag';
      const val = kind === 'mult' ? (r.multiplier || 2) : (r.range_ft || 0);
      const curVal = !cur ? -1
        : (kind === 'mult' ? (cur.multiplier || 2) : (cur.range_ft || 0));
      if (!cur || val > curVal) {
        // Carry the LOSERS' names forward. The winner's number is the one that
        // applies, but "darkvision 90 (Basilisk Mask)" with the Dwarf's 60
        // silently dropped is the kind of provenance gap that sends a player
        // off to re-derive by hand where a number came from.
        const froms = (cur ? cur.froms : []).concat([r.from]);
        best.set(r.sense, Object.assign({}, r, { froms }));
      } else {
        cur.froms.push(r.from);
      }
    }
    for (const [sense, plus] of extend) {
      const row = best.get(sense);
      if (row) { row.range_ft = (row.range_ft || 0) + plus; row.extended = plus; }
      else best.set(sense, { sense, range_ft: plus, froms: ['(extension only)'] });
    }
    return Array.from(best.values());
  }

  // ---- illumination -------------------------------------------------------

  function lightSpec() { return LIGHT_BY_KEY[light.source] || LIGHT_BY_KEY['']; }

  function minutesLeft() {
    const spec = lightSpec();
    if (!spec[3]) return null;                    // no duration = everburning
    const per = spec[3] / TICKS;
    return Math.max(0, spec[3] - light.used * per);
  }

  // The radius actually being lit: the better of a live light source and any
  // soulmeld illumination. A burned-out source lights nothing.
  function illumination() {
    const spec = lightSpec();
    const burnt = spec[3] > 0 && light.used >= TICKS;
    let best = (spec[0] && !burnt) ? { radius: spec[2], from: spec[1] } : null;
    if (typeof SoulmeldEffects !== 'undefined' && SoulmeldEffects.computeAll) {
      try {
        for (const e of SoulmeldEffects.computeAll()) {
          if (e.bonus_type !== 'illumination' || !e.amount) continue;
          if (!best || e.amount > best.radius) best = { radius: e.amount, from: e.soulmeld };
        }
      } catch (e) { /* ignore */ }
    }
    return best;
  }

  // ---- rendering ----------------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  function describe(r) {
    const kind = KIND_OF[r.sense] || 'flag';
    const label = LABEL_OF[r.sense] || String(r.sense).replace(/_/g, ' ');
    if (kind === 'range') return `${label} ${r.range_ft || 0} ft.`;
    if (kind === 'mult') {
      const m = r.multiplier || 2;
      return m >= 4 ? `${label} (×${m})` : label;
    }
    return label;
  }

  function render() {
    const host = byId('senses-list');
    if (!host) return;
    const rows = resolved();
    host.innerHTML = rows.length
      ? rows.map((r) => {
          const from = r.froms.join(', ');
          const ext = r.extended ? ` (+${r.extended} extended)` : '';
          return `<span class="sense-chip" title="${esc(from)}${r.note ? ' — ' + esc(r.note) : ''}">`
            + `${esc(describe(r))}${ext}`
            + `<span class="sense-from">${esc(from)}</span></span>`;
        }).join('')
      : '<span class="senses-empty">No special senses.</span>';

    // Manual rows are editable; auto rows are not, because editing one would
    // just be overwritten on the next recalc.
    const mHost = byId('senses-manual');
    if (mHost) {
      mHost.innerHTML = manual.map((m, i) => {
        const opts = SENSE_KINDS.map(([k, label]) =>
          `<option value="${k}"${k === m.sense ? ' selected' : ''}>${esc(label)}</option>`).join('');
        const kind = KIND_OF[m.sense] || 'flag';
        return `<div class="sense-row" data-idx="${i}">`
          + `<select class="sense-kind">${opts}</select>`
          + (kind === 'flag' ? '<span class="sense-noval">—</span>'
             : `<input type="number" class="sense-val" min="0" placeholder="${kind === 'mult' ? '×' : 'ft.'}" `
               + `value="${kind === 'mult' ? (m.multiplier || '') : (m.range_ft || '')}">`)
          + `<button type="button" class="sense-remove" title="Remove">&times;</button>`
          + `</div>`;
      }).join('');
    }
    renderLight();
  }

  function renderLight() {
    const sel = byId('light-source');
    if (sel && sel.value !== light.source) sel.value = light.source;
    const spec = lightSpec();
    const ticksHost = byId('light-ticks');
    if (ticksHost) {
      if (!spec[0] || !spec[3]) {
        ticksHost.innerHTML = spec[0]
          ? '<span class="light-note">never burns out</span>' : '';
      } else {
        const per = spec[3] / TICKS;
        const perLabel = per >= 60 ? `${per / 60} hr` : `${per} min`;
        let html = '';
        for (let i = 0; i < TICKS; i++) {
          html += `<button type="button" class="light-tick${i < light.used ? ' used' : ''}" `
            + `data-tick="${i}" title="Each tick is ${perLabel}"></button>`;
        }
        const left = minutesLeft();
        const leftLabel = left >= 60
          ? `${Math.round(left / 60 * 10) / 10} hr left`
          : `${left} min left`;
        html += `<span class="light-note">${left > 0 ? leftLabel : 'burned out'}</span>`;
        ticksHost.innerHTML = html;
      }
    }
    const chip = byId('illumination-chip');
    if (chip) {
      const lit = illumination();
      if (!lit) { chip.hidden = true; chip.textContent = ''; }
      else {
        chip.hidden = false;
        chip.textContent = `lighting ${lit.radius} ft.`;
        chip.title = `${lit.from}${spec[4] ? ' — ' + spec[4] : ''}`;
      }
    }
  }

  // ---- wiring -------------------------------------------------------------

  function build() {
    const host = byId('senses-block');
    if (!host || host.dataset.wired) return;
    host.dataset.wired = '1';

    const sel = byId('light-source');
    if (sel && !sel.options.length) {
      sel.innerHTML = LIGHT_SOURCES.map(([k, label]) =>
        `<option value="${k}">${esc(label)}</option>`).join('');
    }

    host.addEventListener('click', (ev) => {
      const tick = ev.target.closest('.light-tick');
      if (tick) {
        const i = parseInt(tick.dataset.tick, 10);
        // Clicking a tick burns UP TO it, so marking "an hour gone" is one
        // click rather than six; clicking the last used one un-burns it.
        light.used = (light.used === i + 1) ? i : i + 1;
        renderLight(); return;
      }
      if (ev.target.closest('#light-reset')) {
        light.used = 0; renderLight(); return;
      }
      if (ev.target.closest('#senses-add')) {
        manual.push({ sense: 'darkvision', range_ft: 60 });
        render(); return;
      }
      const rm = ev.target.closest('.sense-remove');
      if (rm) {
        const row = rm.closest('.sense-row');
        manual.splice(parseInt(row.dataset.idx, 10), 1);
        render(); return;
      }
    });

    const onEdit = (ev) => {
      if (ev.target.id === 'light-source') {
        light.source = ev.target.value;
        light.used = 0;                 // a new source starts full
        renderLight(); return;
      }
      const row = ev.target.closest('.sense-row');
      if (!row) return;
      const m = manual[parseInt(row.dataset.idx, 10)];
      if (!m) return;
      if (ev.target.classList.contains('sense-kind')) {
        m.sense = ev.target.value;
        // Switching kind drops a value that no longer means anything.
        if (KIND_OF[m.sense] !== 'range') delete m.range_ft;
        if (KIND_OF[m.sense] !== 'mult') delete m.multiplier;
        render(); return;
      }
      if (ev.target.classList.contains('sense-val')) {
        const v = parseInt(ev.target.value, 10) || 0;
        if (KIND_OF[m.sense] === 'mult') m.multiplier = v; else m.range_ft = v;
        render();
      }
    };
    host.addEventListener('input', onEdit);
    host.addEventListener('change', onEdit);
    render();
  }

  // ---- save / load --------------------------------------------------------

  function collectData() {
    return { _senses: { manual, light } };
  }

  function loadData(data) {
    const d = (data && data._senses) || {};
    manual = Array.isArray(d.manual) ? JSON.parse(JSON.stringify(d.manual)) : [];
    light = (d.light && typeof d.light === 'object')
      ? { source: d.light.source || '', used: parseInt(d.light.used, 10) || 0 }
      : { source: '', used: 0 };
    build();
    render();
  }

  return {
    build, render, resolved, illumination, minutesLeft,
    collectData, loadData,
    SENSE_KINDS, LIGHT_SOURCES,
  };
})();
