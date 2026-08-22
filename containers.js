// containers.js — extradimensional containers (2026-08-22).
//
// Report rmstjnqxs-ectk: "Bag of Holding support".
//
// WHAT THE BAG ACTUALLY DOES. "Regardless of what is put into the bag, it
// weighs a fixed amount." That is the whole item: a bag of holding is not a
// discount on encumbrance, it is a hole that its contents fall out of the
// weight calculation entirely, while the bag itself keeps weighing its 15 /
// 25 / 35 / 60 lb. So the sheet does not need a new inventory model — it needs
// to know WHICH rows are inside one, and to stop counting those.
//
// The Possessions table has had a free-text `Location` column since the start,
// and "bag of holding" is exactly what a player types in it. So that column IS
// the model: a row whose Location names one of the character's own
// extradimensional containers is inside it. Everything else — "backpack",
// "belt pouch", "left boot" — keeps behaving exactly as before, which matters,
// because 400 saved characters have that column filled in already.
//
// WHAT IT DOES NOT MODEL. Volume. The bag's limits are weight AND cubic feet,
// and the DB has no volume for a torch or a bedroll, so a cu.-ft. reading
// would be invented rather than computed. The weight limit is real and is
// enforced; the volume limit is quoted in the readout for the player to
// adjudicate. Also not modelled, deliberately: the bag-inside-a-portable-hole
// rift (that is a DM event, not a number), and the move-vs-full-round action
// to retrieve an item.
const Containers = (function () {
  'use strict';

  // The extradimensional containers a 3.5 character actually carries. `limit`
  // is the CONTENTS weight limit in pounds; null means the item states no
  // weight limit at all (a portable hole is a hole — the DMG gives it a
  // volume, 6 ft. across and 10 ft. deep, and no poundage).
  //
  // Bag of holding is the one whose limit depends on which one you have, so
  // its four rows are read from the DB's own "Bag of Holding Types" table
  // (DMG) rather than typed here — see loadBagTypes().
  const CATALOGUE = [
    {
      key: 'bag-of-holding',
      match: /\bbag\s+of\s+holding\b/i,
      // filled from the DB at load; the fallback is the DMG's own table, kept
      // so the feature still works if the blob fails to load.
      types: [
        { name: 'Type I', match: /\b(type\s*)?(i|1)\b/i, limit: 250, volume: '30 cu. ft.', self: 15 },
        { name: 'Type II', match: /\b(type\s*)?(ii|2)\b/i, limit: 500, volume: '70 cu. ft.', self: 25 },
        { name: 'Type III', match: /\b(type\s*)?(iii|3)\b/i, limit: 1000, volume: '150 cu. ft.', self: 35 },
        { name: 'Type IV', match: /\b(type\s*)?(iv|4)\b/i, limit: 1500, volume: '250 cu. ft.', self: 60 },
      ],
      rupture: true,
    },
    {
      key: 'handy-haversack',
      match: /\bhandy\s+haversack\b/i,
      // "each is like a bag of holding and can actually hold … 20 pounds …
      // The large central portion … up to 8 cubic feet or 80 pounds" — two
      // side pouches plus the centre, so 120 lb across three compartments.
      // The sheet totals them, since the Location column has no notion of
      // which pouch something is in.
      limit: 120,
      volume: '12 cu. ft. (2 + 2 + 8 across three compartments)',
    },
    {
      key: 'portable-hole',
      match: /\bportable\s+hole\b/i,
      limit: null,
      volume: '6 ft. across, 10 ft. deep',
    },
    {
      key: 'efficient-quiver',
      match: /\befficient\s+quiver\b/i,
      // 60 arrows / 18 javelins / 6 bows-or-staffs — a COUNT limit, not a
      // weight one, so there is no poundage to enforce.
      limit: null,
      volume: '60 arrows, 18 javelins, 6 bows or staffs',
    },
  ];

  // DB-read bag-of-holding rows, once.
  let bagTypesLoaded = false;

  function loadBagTypes() {
    if (bagTypesLoaded) return;
    bagTypesLoaded = true;
    if (typeof DB === 'undefined' || !DB.isLoaded || !DB.isLoaded()) return;
    try {
      const row = DB.queryOne(
        "SELECT json_extract(data, '$.tables') AS t FROM entry "
        + "WHERE type IN ('item','gear') AND name = 'Bag of Holding' LIMIT 1");
      if (!row || !row.t) return;
      const tables = JSON.parse(row.t) || [];
      const tbl = tables.find(x => /bag of holding types/i.test(x.caption || ''));
      if (!tbl || !Array.isArray(tbl.rows)) return;
      const col = (name) => (tbl.columns || []).findIndex(
        c => new RegExp(name, 'i').test(c));
      const iType = col('bag type'), iSelf = col('bag weight');
      const iLimit = col('contents weight'), iVol = col('contents volume');
      const parsed = [];
      for (const r of tbl.rows) {
        const label = String(r[iType] || '').trim();
        if (!label) continue;
        const num = (s) => {
          const m = String(s || '').replace(/,/g, '').match(/[\d.]+/);
          return m ? parseFloat(m[0]) : null;
        };
        const roman = label.replace(/^type\s*/i, '').trim();
        parsed.push({
          name: label,
          match: new RegExp('\\b(type\\s*)?(' + roman + '|'
            + ({ I: '1', II: '2', III: '3', IV: '4' }[roman.toUpperCase()] || roman)
            + ')\\b', 'i'),
          limit: num(r[iLimit]),
          volume: String(r[iVol] || '').trim(),
          self: num(r[iSelf]),
        });
      }
      if (parsed.length) CATALOGUE[0].types = parsed;
    } catch (e) { /* fall back to the printed values above */ }
  }

  // Does this item NAME describe an extradimensional container? Returns a
  // resolved descriptor {key, name, limit, volume} or null.
  //
  // The bag's TYPE is read out of the name the player typed ("Bag of Holding
  // (Type III)"). A bag with no type named is assumed Type I — the smallest,
  // so an unlabelled bag warns EARLY rather than silently permitting 1,500 lb.
  function describe(name) {
    const n = String(name || '').trim();
    if (!n) return null;
    loadBagTypes();
    for (const c of CATALOGUE) {
      if (!c.match.test(n)) continue;
      if (!c.types) {
        return { key: c.key, name: n, limit: c.limit, volume: c.volume,
                 rupture: !!c.rupture };
      }
      const after = n.replace(c.match, ' ');
      const t = c.types.find(x => x.match.test(after)) || c.types[0];
      const assumed = !c.types.some(x => x.match.test(after));
      return { key: c.key, name: n, limit: t.limit, volume: t.volume,
               typeName: t.name, assumedType: assumed, rupture: !!c.rupture };
    }
    return null;
  }

  // Two names refer to the same container when either contains the other,
  // case- and punctuation-insensitively: the Location column gets "bag of
  // holding" while the item row says "Bag of Holding (Type II)".
  function norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function sameContainer(location, containerName) {
    const a = norm(location), b = norm(containerName);
    if (!a || !b || a.length < 3) return false;
    return a === b || a.includes(b) || b.includes(a);
  }

  window.Containers = { describe, sameContainer, norm };
  return window.Containers;
})();
