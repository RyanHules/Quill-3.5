// staff-use.js — use a staff's spells from the Equipment tab.
//
// Reads `item.staff_spells`, which the DB derives at build time from each
// staff's printed spell list (`_staff_metadata.py`, 2026-10-27):
//   {spell, charges | per_day, expends?, dc?, note?, ref?}
// For every Possessions row whose name resolves to such a staff, it lists the
// spells with the DC and caster level the WIELDER casts them at, and tracks
// what has been spent. Exposed as the global `StaffUse`.
//
// The two staff rules it implements, and where they come from:
//   * Charged staffs (DMG p.243, "Staff Descriptions"): spell trigger, so the
//     spell must be on one of the wielder's class lists; the save DC uses the
//     wielder's ability and feats; the wielder may use his own caster level
//     when it is higher than the staff's. 50 charges when made.
//   * Runestaffs (MIC p.224): expend a prepared arcane spell or arcane slot of
//     the spell's level or higher; the spell must be on the wielder's class
//     list; it is "treated exactly as if the wielder cast the spell herself,
//     including caster level, save DC"; three uses per day per spell unless
//     the entry says otherwise; attuned to one runestaff at a time.
// A row whose book PRINTS a DC (3.0 staffs: BoVD, ELH, Magic of Faerun) shows
// the printed DC, with the wielder's 3.5 DC beside it when they differ. Which
// one applies is the DM's call, so the sheet shows both and picks neither.
//
// The DC is read from the Spells tab's own per-level DC cell (`.sc-dc`), so it
// carries the ability and item bonuses the player already sees: one DC
// computation, not two. Domain spells are not counted as class-list spells.
//
// Saved as `_staff_use: {"<name lower>|<source>": {charges, used, attuned}}`,
// keyed by name + source and never by entry id (save-stability rule 7).

const StaffUse = (function () {
  const FULL_CHARGES = 50;                  // DMG p.243: "50 charges when created"
  let state = {};
  const levelCache = new Map();             // spell name lower -> Map(class lower -> {cls, level})
  const arcaneCache = new Map();            // class name lower -> true | false | null
  let renderTimer = null;

  const hasDB = () => typeof DB !== 'undefined' && !!DB && !!DB.isLoaded && DB.isLoaded();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (v) => {
    const n = parseInt(String(v == null ? '' : v), 10);
    return Number.isFinite(n) ? n : null;
  };
  const ord = (n) => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  // "mass suggestion" and "Suggestion, Mass": books print both, the DB holds one.
  function nameForms(name) {
    const n = String(name || '').trim();
    const out = [n];
    let m = n.match(/^(mass|greater|lesser|improved)\s+(.+)$/i);
    if (m) out.push(`${m[2]}, ${m[1]}`);
    m = n.match(/^(.+?),\s*(mass|greater|lesser|improved)$/i);
    if (m) out.push(`${m[2]} ${m[1]}`);
    return out;
  }

  function stateFor(key) {
    if (!state[key]) state[key] = { charges: FULL_CHARGES, used: {}, attuned: false };
    if (!state[key].used) state[key].used = {};
    return state[key];
  }

  // ---- DB reads --------------------------------------------------------

  // The staff a Possessions name refers to, or null. Same resolution as the
  // gear row's rules panel: exact name, then without a trailing "(...)" or
  // "+N"; 3.5 first, then the newest printing.
  function resolveStaff(name) {
    const typed = String(name || '').trim();
    if (!hasDB() || !typed) return null;
    const sql =
      "SELECT e.name, e.source, e.version, e.caster_level, " +
      "  json_extract(e.data, '$.staff_spells') AS rows " +
      "FROM entry e LEFT JOIN book b ON b.name = e.source " +
      "WHERE e.type = 'item' AND LOWER(e.name) = LOWER(?) " +
      "  AND json_extract(e.data, '$.staff_spells') IS NOT NULL " +
      "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, b.publication_date DESC LIMIT 1";
    let row = DB.queryOne(sql, [typed]);
    if (!row) {
      const stripped = typed.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s*\+\d+\s*$/, '').trim();
      if (stripped && stripped !== typed) row = DB.queryOne(sql, [stripped]);
    }
    if (!row) return null;
    let rows;
    try { rows = JSON.parse(row.rows); } catch (e) { return null; }
    if (!Array.isArray(rows) || !rows.length) return null;
    return {
      name: row.name, source: row.source, version: row.version,
      cl: num(row.caster_level), rows,
      kind: rows.some((r) => r.per_day != null) ? 'rune' : 'charged',
    };
  }

  // Which classes have this spell on their list, at what level.
  function spellLevels(spell) {
    const key = String(spell || '').toLowerCase();
    if (levelCache.has(key)) return levelCache.get(key);
    const out = new Map();
    if (hasDB()) {
      const forms = nameForms(spell);
      const ents = DB.query(
        "SELECT id, version FROM entry WHERE type = 'spell' AND LOWER(name) IN (" +
        forms.map(() => 'LOWER(?)').join(',') + ")", forms);
      // A spell reprinted across books: per CLASS, a 3.5 printing's level wins
      // when one lists that class, else an older printing's. Not "3.5 printings
      // only": Wither Limb's 3.5 entries (Libris Mortis, Spell Compendium)
      // list only the Deathbound domain, which dropped BoVD's Sor/Wiz 2.
      const best = new Map();                  // class lower -> {cls, level, v35}
      for (const e of ents) {
        const v35 = e.version === '3.5';
        for (const r of DB.query("SELECT class_name, level FROM spell_class_level WHERE entry_id = ?", [e.id])) {
          const k = String(r.class_name).toLowerCase();
          const cur = best.get(k);
          if (!cur || (v35 && !cur.v35) || (v35 === cur.v35 && r.level < cur.level)) {
            best.set(k, { cls: r.class_name, level: r.level, v35 });
          }
        }
      }
      for (const [k, v] of best) out.set(k, { cls: v.cls, level: v.level });
      levelCache.set(key, out);
    }
    return out;
  }

  // true / false from the class's own `spellcasting.class_type`; null when
  // the DB does not say (homebrew, or a class it does not hold).
  function isArcane(className) {
    const key = String(className || '').toLowerCase();
    if (arcaneCache.has(key)) return arcaneCache.get(key);
    let v = null;
    if (hasDB()) {
      const r = DB.queryOne(
        "SELECT json_extract(data, '$.spellcasting.class_type') AS t FROM entry " +
        "WHERE type IN ('class','prc') AND LOWER(name) = LOWER(?) LIMIT 1", [className]);
      if (r && r.t) v = /arcane/i.test(String(r.t));
      arcaneCache.set(key, v);
    }
    return v;
  }

  // ---- The wielder -----------------------------------------------------

  // The character's spellcasting panels on the Spells tab.
  function casters() {
    if (typeof document === 'undefined') return [];
    return Array.from(document.querySelectorAll("[data-caster-type='spellcasting']")).map((panel) => {
      const idx = (panel.id || '').replace(/^caster-/, '');
      const tab = document.querySelector(`.inner-tab[data-caster-idx="${idx}"]`);
      const name = panel.dataset.casterName || (tab ? tab.textContent.replace('×', '').trim() : '');
      return {
        name,
        cl: num(panel.querySelector('.sc-caster-level') && panel.querySelector('.sc-caster-level').value),
        dc: (lvl) => {
          const el = panel.querySelector(`.sc-dc[data-lvl="${lvl}"]`);
          return el ? num(el.textContent) : null;
        },
        arcane: isArcane(name),
      };
    }).filter((c) => c.name);
  }

  // How this wielder casts `row`: the best of its caster panels whose class
  // list holds the spell (highest DC, then highest caster level). Runestaffs
  // take arcane classes only. Pure: everything it needs is passed in.
  // A printed "heightened to 6th level" (DMG staff of power, BoVD, ELH's
  // "improved heightened to 16th") casts at that level, and the DC follows it.
  function heightenedLevel(row) {
    const m = String(row.note || '').match(/heightened to (\d+)(?:st|nd|rd|th)?/i);
    return m ? parseInt(m[1], 10) : null;
  }

  function castInfo(row, kind, casterList, levels, staffCL) {
    let best = null;
    const raised = heightenedLevel(row);
    for (const c of casterList) {
      const hit = levels.get(String(c.name).toLowerCase());
      if (!hit) continue;
      if (kind === 'rune' && c.arcane === false) continue;
      // The panel's cell is 10 + base level + the caster's modifiers; move it
      // to the cast level. Works past 9th, where no cell exists.
      const castLevel = raised != null ? raised : hit.level;
      const base = c.dc(hit.level);
      const dc = base == null ? null : base - hit.level + castLevel;
      const cl = kind === 'rune' ? c.cl : (Math.max(staffCL || 0, c.cl || 0) || null);
      const cand = { caster: c.name, level: hit.level, castLevel, dc, cl,
                     arcaneUnknown: kind === 'rune' && c.arcane == null };
      const better = !best || (dc == null ? -1 : dc) > (best.dc == null ? -1 : best.dc) ||
        ((dc == null ? -1 : dc) === (best.dc == null ? -1 : best.dc) &&
         (cl == null ? -1 : cl) > (best.cl == null ? -1 : best.cl));
      if (better) best = cand;
    }
    return best;
  }

  // ---- Rendering -------------------------------------------------------

  function staffsInGear() {
    if (typeof document === 'undefined') return [];
    const seen = new Map();
    document.querySelectorAll('#gear-body tr.gear-row .gear-name').forEach((input) => {
      const s = resolveStaff(input.value);
      if (s) seen.set(`${s.name.toLowerCase()}|${s.source}`, s);
    });
    return Array.from(seen.entries());
  }

  function rowHTML(staff, key, row, i, list) {
    const st = stateFor(key);
    const info = castInfo(row, staff.kind, list, spellLevels(row.spell), staff.cl);
    const note = row.note ? ` <span class="staff-use-note">(${esc(row.note)})</span>` : '';
    const ref = row.ref ? ` <span class="staff-use-note">${esc(row.ref)}</span>` : '';
    const spell = `<a href="#" class="staff-use-spell" data-spell="${esc(row.spell)}">${esc(row.spell)}</a>${note}${ref}`;
    let cost, action;
    if (staff.kind === 'rune') {
      const used = Math.min(st.used[row.spell] || 0, row.per_day);
      cost = `${row.per_day}/day`;
      let pips = '';
      for (let p = 0; p < row.per_day; p++) {
        pips += `<button type="button" class="staff-use-pip${p < used ? ' used' : ''}" data-i="${i}" ` +
          `data-p="${p}" title="${p < used ? 'Used' : 'Unused'} - click to set">●</button>`;
      }
      action = pips;
    } else {
      cost = `${row.charges} charge${row.charges === 1 ? '' : 's'}`;
      const short = st.charges < row.charges;
      action = `<button type="button" class="staff-use-btn" data-i="${i}"${short ? ' disabled' : ''} ` +
        `title="${short ? 'Not enough charges' : `Spend ${cost}`}">Use</button>`;
    }
    let dc;
    if (row.dc != null) {
      dc = `<span title="The DC this book prints (a 3.0 staff rule). The 3.5 DMG has the wielder set it.">${row.dc}*</span>`;
      if (info && info.dc != null && info.dc !== row.dc) {
        dc += ` <span class="staff-use-note" title="The wielder's DC under the 3.5 DMG staff rule">(wielder ${info.dc})</span>`;
      }
    } else {
      dc = info && info.dc != null ? String(info.dc) : '—';
    }
    let cl;
    if (staff.kind === 'rune') cl = info && info.cl != null ? String(info.cl) : '—';
    else if (info && info.cl != null) {
      cl = info.cl > (staff.cl || 0)
        ? `<span title="The wielder's caster level, higher than the staff's ${staff.cl}">${info.cl}</span>`
        : String(info.cl);
    } else cl = staff.cl != null ? String(staff.cl) : '—';
    let as;
    if (info) {
      as = `${esc(info.caster)} ${ord(info.level)}`;
      if (info.castLevel !== info.level) as += ` <span class="staff-use-note">(cast as ${ord(info.castLevel)})</span>`;
      if (info.arcaneUnknown) as += ' <span class="staff-use-note">(arcane? not in the DB)</span>';
    } else if (staff.kind === 'rune') {
      as = '<span class="staff-use-warn">no arcane class of yours has it on its list</span>';
    } else {
      as = '<span class="staff-use-warn">not on your class lists: Use Magic Device</span>';
    }
    return `<tr><td>${spell}</td><td>${cost}</td><td>${dc}</td><td>${cl}</td><td>${as}</td>` +
      `<td class="staff-use-act">${action}</td></tr>`;
  }

  function staffHTML(key, staff, list) {
    const st = stateFor(key);
    let head = `<b>${esc(staff.name)}</b> <span class="staff-use-note">(${esc(staff.source)})</span>`;
    if (staff.cl != null) head += ` · CL ${staff.cl}`;
    if (staff.kind === 'rune') {
      head += ` · <label><input type="checkbox" class="staff-use-attuned"${st.attuned ? ' checked' : ''}> attuned</label>` +
        ` <span class="staff-use-note">one runestaff at a time; each use expends a prepared arcane spell ` +
        `or arcane slot of the spell's level or higher (MIC p.224)</span>`;
    } else {
      head += ` · Charges <input type="number" class="staff-use-charges" min="0" value="${st.charges}">`;
    }
    const rows = staff.rows.map((r, i) => rowHTML(staff, key, r, i, list)).join('');
    return `<div class="staff-use-staff" data-key="${esc(key)}"><div class="staff-use-title">${head}</div>` +
      `<table class="staff-use-table"><thead><tr><th>Spell</th><th>Cost</th><th>DC</th><th>CL</th>` +
      `<th>Cast as</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  let current = [];                          // [[key, staff], ...] last rendered
  function render() {
    const host = typeof document !== 'undefined' && document.getElementById('staff-use');
    if (!host) return;
    current = hasDB() ? staffsInGear() : [];
    if (!current.length) {
      host.innerHTML = '';
      host.style.display = 'none';
      return;
    }
    const list = casters();
    host.style.display = '';
    host.innerHTML = `<div class="staff-use-head">Staffs <span class="staff-use-note">` +
      `spell trigger (DMG p.243); * = DC printed by a 3.0 book</span></div>` +
      current.map(([key, staff]) => staffHTML(key, staff, list)).join('');
  }

  function scheduleRender() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => { renderTimer = null; render(); }, 120);
  }

  function staffAt(el) {
    const block = el.closest('.staff-use-staff');
    if (!block) return null;
    const hit = current.find(([k]) => k === block.dataset.key);
    return hit ? { key: hit[0], staff: hit[1], st: stateFor(hit[0]) } : null;
  }

  function onClick(ev) {
    const link = ev.target.closest('.staff-use-spell');
    if (link) {
      ev.preventDefault();
      if (window.Lookup && Lookup.search) Lookup.search(link.dataset.spell);
      return;
    }
    const btn = ev.target.closest('.staff-use-btn, .staff-use-pip');
    const at = btn && staffAt(btn);
    if (!at) return;
    const row = at.staff.rows[num(btn.dataset.i)];
    if (!row) return;
    if (btn.classList.contains('staff-use-btn')) {
      if (at.st.charges >= row.charges) at.st.charges -= row.charges;
    } else {
      // Clicking a pip sets the used count through it; clicking the last used
      // pip again clears it, so a misclick is one click to undo.
      const p = num(btn.dataset.p);
      const used = at.st.used[row.spell] || 0;
      at.st.used[row.spell] = used === p + 1 ? p : p + 1;
    }
    render();
  }

  function onChange(ev) {
    const at = staffAt(ev.target);
    if (!at) return;
    if (ev.target.classList.contains('staff-use-charges')) {
      at.st.charges = Math.max(0, num(ev.target.value) || 0);
    } else if (ev.target.classList.contains('staff-use-attuned')) {
      if (ev.target.checked) {
        for (const [k, s] of current) if (s.kind === 'rune' && k !== at.key) stateFor(k).attuned = false;
      }
      at.st.attuned = ev.target.checked;
    }
    render();
  }

  // A night's rest restores every runestaff's daily uses. Charges never come back.
  function restDailyUses() {
    for (const k of Object.keys(state)) state[k].used = {};
    render();
  }

  // ---- Save / load -----------------------------------------------------

  function collectData() {
    const out = {};
    for (const [k, v] of Object.entries(state)) {
      const used = Object.fromEntries(Object.entries(v.used || {}).filter(([, n]) => n > 0));
      if (v.charges !== FULL_CHARGES || v.attuned || Object.keys(used).length) {
        out[k] = { charges: v.charges, used, attuned: !!v.attuned };
      }
    }
    return Object.keys(out).length ? { _staff_use: out } : {};
  }

  function loadData(data) {
    state = {};
    const saved = (data && data._staff_use) || {};
    for (const [k, v] of Object.entries(saved)) {
      if (!v || typeof v !== 'object') continue;
      state[k] = { charges: num(v.charges) == null ? FULL_CHARGES : num(v.charges),
                   used: (v.used && typeof v.used === 'object') ? v.used : {},
                   attuned: !!v.attuned };
    }
    scheduleRender();
  }

  function init() {
    const host = document.getElementById('staff-use');
    if (host) {
      host.addEventListener('click', onClick);
      host.addEventListener('change', onChange);
    }
    // Re-render when anything the panel reads changes: gear names, caster
    // panels, ability scores. Its own inputs re-render themselves.
    const elsewhere = (ev) => { if (!(host && host.contains(ev.target))) scheduleRender(); };
    document.addEventListener('input', elsewhere);
    document.addEventListener('change', elsewhere);
    document.addEventListener('click', (ev) => {
      if (ev.target.closest && ev.target.closest('#btn-rest, #btn-rest-longterm')) restDailyUses();
      else if (ev.target.closest && ev.target.closest('#btn-add-gear, .gear-remove-btn')) scheduleRender();
    });
    if (typeof DB !== 'undefined' && DB && DB.ready) DB.ready.then(render, () => {});
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }

  return {
    render, collectData, loadData, restDailyUses,
    // Exposed for the test suite:
    nameForms, castInfo, resolveStaff, spellLevels,
  };
})();

if (typeof window !== 'undefined') window.StaffUse = StaffUse;
