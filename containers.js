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

  // Two names refer to the same container when one is a token-wise SUBSEQUENCE
  // of the other: the Location column gets "bag of holding" while the item row
  // says "Bag of Holding (Type II)".
  //
  // ⚠ TOKENS, NEVER RAW SUBSTRINGS (fixed 2026-09-01, report rmtd59njx).
  //
  // This used to be `a.includes(b) || b.includes(a)` on the normalised strings,
  // and roman numerals are prefixes of each other: "bag of holding type iv"
  // literally contains "bag of holding type i". So Gorrash's 500 lb of coin
  // stowed in his Type IV was attributed to his Type I — the first match won —
  // which showed the small bag 238 lb over its 250 limit (a bag of holding
  // that goes over RUPTURES) while the big one read empty.
  //
  // Comparing TOKEN LISTS fixes it without losing the loose match, because "i"
  // and "iv" are different tokens while "bag of holding" is still a subsequence
  // of "bag of holding type ii". This is the same word-boundary trap
  // item-bonuses.js already carries a comment about ("attack rolls" contains
  // the letters "ac").
  function norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function tokens(s) {
    const t = norm(s);
    return t ? t.split(' ') : [];
  }

  // Is `needle` an ordered (not necessarily contiguous) subsequence of `hay`?
  // Non-contiguous on purpose: "Bag of Holding I" must still match the item
  // row "Bag of Holding (Type I)", where "type" sits between them.
  function isSubsequence(needle, hay) {
    let i = 0;
    for (const h of hay) {
      if (i < needle.length && needle[i] === h) i++;
    }
    return i === needle.length;
  }

  function sameContainer(location, containerName) {
    return matchDistance(location, containerName) !== Infinity;
  }

  // How CLOSE a match is: the number of tokens the longer name carries that
  // the shorter does not. 0 is exact. Infinity is no match.
  //
  // Needed because a bare "bag of holding" in the Location column matches every
  // typed bag equally, and picking whichever happened to be found first is how
  // the original bug expressed itself. The caller takes the smallest distance
  // and treats a TIE as genuinely ambiguous rather than guessing.
  function matchDistance(location, containerName) {
    const a = tokens(location), b = tokens(containerName);
    if (!a.length || !b.length) return Infinity;
    // Guard kept from the original: a one- or two-character Location is not
    // enough to identify anything.
    if (norm(location).length < 3) return Infinity;
    const short = a.length <= b.length ? a : b;
    const long = a.length <= b.length ? b : a;
    if (!isSubsequence(short, long)) return Infinity;
    return long.length - short.length;
  }

  // Distribute items across several INTERCHANGEABLE containers so as much as
  // possible fits before any one of them overflows (Ryan, 2026-09-01).
  //
  // Only reached when the Location text cannot pick between them — two bags
  // written under the same name. A row that names one exactly is placed
  // directly and never comes here.
  //
  // Bin packing is NP-hard in general; the input here is a handful of items
  // into two or three identical bags, where BEST-FIT DECREASING is the
  // standard heuristic and is optimal or near-optimal at this size:
  //
  //   * Heaviest first — placing the big awkward items while every bag is
  //     still empty is exactly why this beats arrival order.
  //   * Into the FULLEST bag that still takes it, keeping the slack together
  //     in one bag rather than stranding a few pounds across all of them.
  //   * Items are NEVER split. An 8 lb item puts all 8 lb in one bag; a bag of
  //     holding is not a bucket of sand.
  //
  // ⚠ Anything that fits nowhere is held back and dumped at the END into the
  // single roomiest bag. Placing each leftover as it is met — into whichever
  // bag happened to be emptiest right then — spreads the failure across every
  // bag: five items into two 250 lb bags ruptured BOTH (280 and 320) where the
  // right answer is one bag exactly full at 250, one at 230, and one named
  // item over. A rupture destroys the contents, so two instead of one is not a
  // cosmetic difference.
  //
  // Mutates each bag's `contents` / `items` / `overflow`. A null `limit`
  // (portable hole) is unbounded.
  function pack(bags, items) {
    if (!Array.isArray(bags) || !bags.length) return;
    const cap = (c) => (c.limit == null ? Infinity : c.limit);
    const unplaced = [];
    for (const it of items.slice().sort((a, b) => b.w - a.w)) {
      let best = null;
      for (const c of bags) {
        if (c.contents + it.w > cap(c)) continue;
        if (!best || c.contents > best.contents) best = c;
      }
      if (best) {
        best.contents += it.w;
        best.items.push(it.name);
      } else {
        unplaced.push(it);
      }
    }
    if (!unplaced.length) return;
    const dump = bags.reduce((a, b) =>
      ((cap(b) - b.contents) > (cap(a) - a.contents) ? b : a));
    for (const it of unplaced) {
      dump.contents += it.w;
      dump.items.push(it.name);
      dump.overflow.push(it.name);
    }
  }

  window.Containers = { describe, sameContainer, matchDistance, norm, pack };
  return window.Containers;
})();
