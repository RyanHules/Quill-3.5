// Lookup usability harness — does a semantically-reasonable query surface the
// RIGHT entry, near the top?  This is the one dimension of ISEE (Tian et al.,
// 2026, "Interactive Semantic Enrichment for Database Fields") that transfers
// to us: Usability = downstream retrieval quality.  It exists because the
// "selected weapon -> Weapon Focus" bug (2026-08-05) shipped: nothing tested
// that a query a player would actually type returns the entry they mean.
//
// Two signals:
//   * MRR (Mean Reciprocal Rank) — 1/rank of the expected entry, averaged.  A
//     single 0-1 health number, reported (not hard-gated: ranking is sensitive).
//   * Top-N hard gate — each case declares maxRank; if the expected entry falls
//     outside it, the run FAILS.  These are the regression teeth.
//
// ...and, since 2026-08-20, the DISTANCE either side of that gate, because the
// gate alone is binary where the thing it measures is graded.  A case that
// slipped from rank 3 to 4 and one that collapsed from 3 to 40 produced the
// identical red, which destroyed the most useful diagnostic at exactly the
// moment a regression made it valuable.  The same blindness runs the other way
// and is arguably worse: a case passing AT its maxRank is one slot from failing
// and read exactly like a case passing at rank 1, so the harness could not warn
// before a break, only report after one.
//
// So every case now reports `vs gate` — slots of headroom, AT GATE, or how far
// over — and the summary calls out anything sitting on the edge.  This changes
// no pass/fail behaviour; it is strictly more information about the same runs.
//
// `--save-baseline` writes tests/_recall_baseline.json; when that file exists,
// each case also shows its rank transition since the baseline (`3→5`).  That
// half is deliberately INFORMATION AND NEVER TEETH — a missing, stale or
// hand-edited baseline can shift no verdict.  A stored expectation that can
// change an outcome is the kind of instrument that eventually lies, and the
// gate above is the one that gets to decide.
//
// Not Somers' D, which the ordinal-regression literature would suggest here:
// that measures association between a PREDICTED and a TRUE ordinal label, and
// this suite has no ordinal target — only the observed position of a known-
// correct item.  Importing the statistic would be answering a weaker question
// than it looks like.  It is the discipline that transfers, not the formula:
// instrument the graded thing gradedly.
//
// Runs headless in Node against the real DB (deterministic string-scoring, no
// embeddings/LLM), reusing lookup.js's rankResults seam via the same
// new Function sandbox tests/test_pickers.js uses.
//
// Run: node tests/test_lookup_recall.js   (exit 0 all-pass, 1 on any gate miss)
//
// Add a case for every future search gap — same discipline as the
// save-stability regressions.  Each case encodes a bit of domain knowledge:
// "a player searching X means entry Y."

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data/dnd35.db');
const SQL_JS_PATH = path.join(ROOT, 'vendor/sql-wasm.js');
const WASM_PATH = path.join(ROOT, 'vendor/sql-wasm.wasm');

// ---- the eval set ---------------------------------------------------------
// { query, expect:{name, type?, source?}, maxRank, note? }
// `expect` matches the first (best-ranked) index entry by name (case-insensitive)
// plus optional type/source to disambiguate duplicate names.  maxRank is tighter
// for exact-ish queries, looser for fuzzy semantic ones.
const CASES = [
  // --- regression anchor (the bug this harness exists for) ---
  // Weapon Focus's "selected weapon" lives in its `benefit`, which the COALESCE
  // index bug never indexed (fixed 2026-08-05).  The bar is "reachable", not
  // "top", because the failure mode it guards is ABSENCE (rank MISS) — the
  // weapon-focus family all match the phrase, so which one leads is not the
  // thing under test.
  //   Measured rank 1 as of 2026-08-20 — the comment here previously said "~13",
  //   which was true when written and is not now; the ranker has moved under it.
  //   The gate stays at 15 deliberately: tightening it would convert this from a
  //   presence check into a ranking check, which is a different test and one the
  //   `vs gate` column ("14 free") already reports without any teeth. If we DO
  //   want a ranking bar here, add a second case rather than narrowing this one.
  { query: 'selected weapon', expect: { name: 'Weapon Focus', type: 'feat' }, maxRank: 15,
    note: 'body-text match on benefit; regressed by the COALESCE index bug (2026-08-05)' },

  // --- exact / near-exact name (name match should dominate) ---
  { query: 'fireball',        expect: { name: 'Fireball', type: 'spell' },      maxRank: 1 },
  { query: 'power attack',    expect: { name: 'Power Attack', type: 'feat' },   maxRank: 1 },
  { query: 'haste',           expect: { name: 'Haste', type: 'spell' },         maxRank: 3 },
  { query: 'detect magic',    expect: { name: 'Detect Magic', type: 'spell' },  maxRank: 3 },
  { query: 'cloak of resistance', expect: { name: 'Cloak of Resistance' },      maxRank: 3 },

  // --- former names (aliases) ---
  // A later book routinely RENAMES what it reprints, and the DB records the old
  // name in `also_known_as` rather than overwriting the printed one (CLAUDE.md,
  // "A RENAME is an ALIAS"). Spell Compendium's table alone retitles 85 spells.
  // These are the teeth for that being SEARCHABLE: a reader types the name in
  // the book in their hands, which is not the name the DB entry carries.
  // Before 2026-08-30 the field existed and nothing read it, so every one of
  // these queries missed entirely.
  { query: "snilloc's snowball swarm", expect: { name: 'Snowball Swarm', type: 'spell' }, maxRank: 3,
    note: 'alias: Magic of Faerun name -> Spell Compendium name' },
  { query: 'undeniable gravity', expect: { name: 'Earthbind', type: 'spell' }, maxRank: 3,
    note: 'alias: a rename with no shared words at all' },
  { query: "mordenkainen's force missiles", expect: { name: 'Force Missiles', type: 'spell' }, maxRank: 3,
    note: 'alias: proper noun stripped on reprint' },

  // --- absorbed spells (incorporates) ---
  // Spell Compendium did not rename "great shout", it FOLDED it into Shout,
  // Greater. The old spell should still be reachable by name and should lead to
  // the survivor; the survivor is what the reader can actually cast.
  { query: 'great shout', expect: { name: 'Shout, Greater', type: 'spell' }, maxRank: 3,
    note: 'incorporation: FRCS 3.0 spell absorbed into the PHB 3.5 one' },

  // --- rules / mechanics by common phrasing ---
  { query: 'flanking',        expect: { name: 'Flanking', type: 'rule' },       maxRank: 5 },
  { query: 'grapple',         expect: { name: 'Grapple', type: 'rule' },        maxRank: 5 },
  { query: 'bull rush',       expect: { name: 'Bull Rush', type: 'rule' },      maxRank: 5 },
  { query: 'sneak attack',    expect: { name: 'Sneak Attack — Variants', type: 'rule' }, maxRank: 5,
    note: 'name match wins — a player wanting the Rogue class types "rogue"' },
];

// ---- discovery cases ------------------------------------------------------
// The character-building use case (Ryan, 2026-08-05): a MECHANIC query should
// surface everything that interacts with it, so you can research a build.  The
// body-index fix delivered the coverage ("grappl" -> 461 results); RANKING was
// the open work, now closed by the DB-side mechanic-tagging pass (2026-08-05):
// each combat maneuver has a curated `<mechanic>-core` tag that the ranker
// scores at tier 70 (above the broad exact-tag pile at 65), so the build-
// DEFINING set surfaces first.  Body text alone can't do this — Constrict is a
// grapple ability whose text says "crush", not "grapple".  These use a RECALL@N
// metric ("is the must-have canonical set inside the top N?") and are the
// regression teeth for that pass.
// { query, topN, minRecall, mustInclude:[{name,type?}], pending?, note? }
// A `pending: true` case is MEASURED + reported but NOT gated — use it for a
// target still waiting on data.  All seven maneuvers below are LIVE gates.
const DISCOVERY_CASES = [
  { query: 'grappl', topN: 20, minRecall: 0.83,
    note: 'grapple-core tag; Constrict/Improved Grab reachable only via the tag',
    mustInclude: [
      { name: 'Grapple',            type: 'rule' },
      { name: 'Improved Grapple',   type: 'feat' },
      { name: 'Improved Grab',      type: 'rule' },
      { name: 'Constrict',          type: 'rule' },
      { name: 'Clever Wrestling',   type: 'feat' },
      { name: 'Legendary Wrestler', type: 'feat' },
    ] },
  { query: 'trip', topN: 20, minRecall: 0.8,
    mustInclude: [
      { name: 'Trip',             type: 'rule' },
      { name: 'Improved Trip',    type: 'feat' },
      { name: 'Wolf Berserker',   type: 'feat' },
      { name: 'Defensive Throw',  type: 'feat' },
      { name: 'Pebble Underfoot', type: 'feat' },
    ] },
  { query: 'disarm', topN: 20, minRecall: 0.75,
    mustInclude: [
      { name: 'Disarm',           type: 'rule' },
      { name: 'Improved Disarm',  type: 'feat' },
      { name: 'Ranged Disarm',    type: 'feat' },
      { name: 'Steal and Strike', type: 'feat' },
    ] },
  { query: 'sunder', topN: 20, minRecall: 0.75,
    mustInclude: [
      { name: 'Sunder',           type: 'rule' },
      { name: 'Improved Sunder',  type: 'feat' },
      { name: 'Ranged Sunder',    type: 'feat' },
      { name: 'Epic Sunder',      type: 'feat' },
    ] },
  { query: 'bull rush', topN: 20, minRecall: 0.75,
    mustInclude: [
      { name: 'Bull Rush',          type: 'rule' },
      { name: 'Improved Bull Rush', type: 'feat' },
      { name: 'Awesome Blow',       type: 'feat' },
      { name: 'Shock Trooper',      type: 'feat' },
    ] },
  { query: 'overrun', topN: 20, minRecall: 0.75,
    mustInclude: [
      { name: 'Overrun',          type: 'rule' },
      { name: 'Improved Overrun', type: 'feat' },
      { name: 'Centaur Trample',  type: 'feat' },
      { name: 'Trample',          type: 'feat' },
    ] },
  // charge has the largest core AND the query is a HOMONYM: magic-item
  // "charges"/"charged items" rules and a Triceratops spell are legit
  // name-prefix hits that occupy ranks 2-5 (unfixable without semantics),
  // pushing the ~17 canonical charge feats down. topN=25 keeps the whole set —
  // including the alphabetically-last Spirited Charge — gated rather than
  // letting it fall out at 4/5.
  { query: 'charge', topN: 25, minRecall: 0.8,
    mustInclude: [
      { name: 'Charge',          type: 'rule' },
      { name: 'Powerful Charge', type: 'feat' },
      { name: 'Spirited Charge', type: 'feat' },
      { name: 'Ride-By Attack',  type: 'feat' },
      { name: 'Flying Kick',     type: 'feat' },
    ] },

  // --- build ARCHETYPES (item #6, 2026-08-06) — the entry-level generalization
  // of the combat-maneuver cores above. Same mechanism: a curated
  // `<archetype>-core` tag (DB-side ARCHETYPE_CORE in tag_inference.py) scored at
  // ranker tier 70, so a build-research query floats the build-DEFINING set over
  // the broad pile. Several entries are completeness fixes (the Rogue class, the
  // Turn/Familiars rules, the summoning feats/PrCs carried no broad tag).
  // topN=25: ~35 entries NAMED "Metamagic Rod (X)" / "Metamagic Component" /
  // "Metamagic Item" share the "metamagic" name-prefix. Before the item-demote
  // ranker fix (2026-08-06, Ryan-approved) they held tier 80 and buried the
  // build core at ranks ~42-53 — too deep for any topN. Now magic-item name-
  // prefix scores 68 (below curated -core at 70), so Divine Metamagic / Arcane
  // Thesis / the PHB feats float into the top ~25 above the rod SKUs.
  { query: 'metamagic', topN: 25, minRecall: 0.8,
    mustInclude: [
      { name: 'Metamagic Feats (Rules)', type: 'rule' },
      { name: 'Divine Metamagic',        type: 'feat' },
      { name: 'Arcane Thesis',           type: 'feat' },
      { name: 'Empower Spell',           type: 'feat' },
      { name: 'Quicken Spell',           type: 'feat' },
      { name: 'Persistent Spell',        type: 'feat' },
      { name: 'Incantatrix',             type: 'prc'  },
    ] },
  { query: 'sneak attack', topN: 20, minRecall: 0.8,
    mustInclude: [
      { name: 'Sneak Attack — Variants', type: 'rule'  },
      { name: 'Rogue',                   type: 'class' },
      { name: 'Staggering Strike',       type: 'feat'  },
      { name: 'Telling Blow',            type: 'feat'  },
      { name: 'Assassin',                type: 'prc'   },
      { name: 'Arcane Trickster',        type: 'prc'   },
    ] },
  { query: 'wild shape', topN: 20, minRecall: 0.8,
    mustInclude: [
      { name: 'Natural Spell',         type: 'feat'  },
      { name: 'Druid',                 type: 'class' },
      { name: 'Master of Many Forms',  type: 'prc'   },
      { name: 'Warshaper',             type: 'prc'   },
      { name: 'Aberration Wild Shape', type: 'feat'  },
      { name: 'Extra Wild Shape',      type: 'feat'  },
    ] },
  { query: 'turn undead', topN: 20, minRecall: 0.8,
    mustInclude: [
      { name: 'Turn or Rebuke Undead',      type: 'rule'  },
      { name: 'Cleric',                     type: 'class' },
      { name: 'Extra Turning',              type: 'feat'  },
      { name: 'Divine Metamagic',           type: 'feat'  },
      { name: 'Divine Might',               type: 'feat'  },
      { name: 'Radiant Servant of Pelor',   type: 'prc'   },
    ] },
  { query: 'mounted combat', topN: 20, minRecall: 0.8,
    mustInclude: [
      { name: 'Mounted Combat',  type: 'feat' },
      { name: 'Mounted Archery', type: 'feat' },
      { name: 'Ride-By Attack',  type: 'feat' },
      { name: 'Spirited Charge', type: 'feat' },
      { name: 'Cavalier',        type: 'prc'  },
    ] },
  { query: 'two weapon', topN: 20, minRecall: 0.8,
    note: 'query "two weapon" (not "twf" — the -core base is "twoweaponfighting")',
    mustInclude: [
      { name: 'Two-Weapon Fighting',          type: 'feat' },
      { name: 'Improved Two-Weapon Fighting', type: 'feat' },
      { name: 'Greater Two-Weapon Fighting',  type: 'feat' },
      { name: 'Two-Weapon Rend',              type: 'feat' },
      { name: 'Oversized Two-Weapon Fighting', type: 'feat' },
      { name: 'Tempest',                      type: 'prc'  },
    ] },
  // query "summoning" NOT "summon" — "summon" name-prefixes ~40 Summon* spells
  // (tier 80) above core. topN=25 absorbs the smaller "Summoning Stone (X)" item
  // family (~14 name-prefix entries) the way charge's topN=25 absorbs its
  // homonyms; the build core lands just below at ranks ~15-22.
  { query: 'summoning', topN: 25, minRecall: 0.8,
    mustInclude: [
      { name: 'Augment Summoning', type: 'feat'  },
      { name: 'Malconvoker',       type: 'prc'   },
      { name: 'Gate',              type: 'spell' },
      { name: 'Planar Binding',    type: 'spell' },
      { name: 'Ashbound',          type: 'feat'  },
    ] },
  { query: 'familiar', topN: 20, minRecall: 0.8,
    mustInclude: [
      { name: 'Familiars',        type: 'rule' },
      { name: 'Improved Familiar', type: 'feat' },
      { name: 'Obtain Familiar',  type: 'feat' },
      { name: 'Item Familiar',    type: 'feat' },
      { name: 'Bonded Familiar',  type: 'feat' },
    ] },
  { query: 'animal companion', topN: 20, minRecall: 0.8,
    mustInclude: [
      { name: 'Natural Bond',      type: 'feat'  },
      { name: 'Druid',             type: 'class' },
      { name: 'Ranger',            type: 'class' },
      { name: 'Beastmaster',       type: 'prc'   },
      { name: 'Companion Spellbond', type: 'feat' },
    ] },
];

// ---- sql.js plumbing (mirrors tests/test_pickers.js) ----------------------
function execAll(db, sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}
function execOne(db, sql, params) {
  const rows = execAll(db, sql, params);
  return rows.length ? rows[0] : null;
}

// Load the real Lookup module headless: readyState 'loading' defers init()
// (no DOM); window carries no BookFilter, so the ranker sees all entries.
function loadLookup(db) {
  const dbStub = {
    isLoaded: () => true,
    query: (sql, params) => execAll(db, sql, params),
    queryOne: (sql, params) => execOne(db, sql, params),
    ready: Promise.resolve(),
  };
  const win = { DB: dbStub };
  const doc = {
    readyState: 'loading',
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => null, getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add() {}, toggle() {} },
      setAttribute() {}, appendChild() {}, addEventListener() {} }),
    body: { appendChild: () => {} },
  };
  const src = fs.readFileSync(path.join(ROOT, 'lookup.js'), 'utf8');
  const fn = new Function('window', 'document', 'DB', src + '\n;return window.Lookup;');
  return fn(win, doc, dbStub);
}

// ---- rank an expected entry in a ranked list ------------------------------
function rankOf(ranked, expect) {
  const wantName = expect.name.toLowerCase();
  for (let i = 0; i < ranked.length; i++) {
    const e = ranked[i];
    if ((e.name || '').toLowerCase() !== wantName) continue;
    if (expect.type && e.type !== expect.type) continue;
    if (expect.source && e.source !== expect.source) continue;
    return i + 1;            // 1-based rank of the best-ranked match
  }
  return Infinity;           // not found anywhere
}

// For a discovery case: which must-includes land within the top-N, and the
// overall recall.  Returns { found:[{label,rank}], missed:[{label,rank}], recall }.
function recallAt(ranked, mustInclude, topN) {
  const found = [], missed = [];
  for (const m of mustInclude) {
    const rank = rankOf(ranked, m);
    const label = m.name + (m.type ? ` [${m.type}]` : '');
    (rank <= topN ? found : missed).push({ label, rank });
  }
  return { found, missed, recall: found.length / mustInclude.length };
}

// ---- run-over-run baseline (information only, never teeth) ----------------
// A stable identity for a case, so reordering or editing CASES doesn't silently
// re-pair rows against the wrong baseline entry.
function caseKey(c) {
  return `${c.query} => ${c.expect.name}${c.expect.type ? `[${c.expect.type}]` : ''}`;
}

const SAVE_BASELINE = process.argv.includes('--save-baseline');
const BASELINE_PATH = path.join(__dirname, '_recall_baseline.json');

function readBaseline() {
  // Every failure path returns null and the run proceeds ungated by it: the
  // baseline may not shift a verdict, so a corrupt one degrades to "no
  // baseline" rather than to an error or, worse, a wrong comparison.
  //
  // But it degrades OUT LOUD. An absent baseline is the normal state and says
  // nothing; an unreadable one means somebody has a file they think is working,
  // and a comparison column that quietly stops comparing looks exactly like a
  // suite where nothing moved.
  if (!fs.existsSync(BASELINE_PATH)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    if (!raw || typeof raw.cases !== 'object' || raw.cases === null) {
      throw new Error('no `cases` object');
    }
    return raw;
  } catch (e) {
    console.log(`(baseline at ${path.relative(ROOT, BASELINE_PATH)} is unreadable — ` +
      `${e.message}; comparison column disabled, verdicts unaffected. ` +
      'Re-create it with --save-baseline.)');
    return null;
  }
}

// ---- run ------------------------------------------------------------------
(async () => {
  const baseline = readBaseline();
  const initSqlJs = require(SQL_JS_PATH);
  const SQL = await initSqlJs({ locateFile: () => WASM_PATH });
  const db = new SQL.Database(fs.readFileSync(DB_PATH));

  const Lookup = loadLookup(db);
  if (typeof Lookup.rankResults !== 'function') {
    console.error('FAIL: Lookup.rankResults is not exposed (lookup.js seam missing)');
    process.exit(1);
  }

  let rrSum = 0, failures = 0, atGate = 0, worstOver = 0;
  const rows = [];
  const nextBaseline = {};
  for (const c of CASES) {
    const ranked = Lookup.rankResults(c.query);
    const rank = rankOf(ranked, c.expect);
    const rr = rank === Infinity ? 0 : 1 / rank;
    rrSum += rr;
    const pass = rank <= c.maxRank;
    if (!pass) failures++;

    // The graded reading the binary gate throws away, both directions.
    let vsGate;
    if (rank === Infinity) {
      vsGate = 'MISS';
    } else if (rank < c.maxRank) {
      vsGate = `${c.maxRank - rank} free`;
    } else if (rank === c.maxRank && c.maxRank === 1) {
      // Rank 1 against a maxRank of 1 is a PERFECT result, not a near-miss.
      // There is no headroom to have lost, so "one slot from a red" is true of
      // every passing state this case can ever be in — a warning whose output
      // cannot change, which trains the reader to ignore the ones that can.
      vsGate = 'exact';
    } else if (rank === c.maxRank) {
      vsGate = 'AT GATE';   // used every slot of the slack it was given
      atGate++;
    } else {
      vsGate = `+${rank - c.maxRank} over`;
      worstOver = Math.max(worstOver, rank - c.maxRank);
    }

    const key = caseKey(c);
    nextBaseline[key] = rank === Infinity ? null : rank;
    const was = baseline && Object.prototype.hasOwnProperty.call(baseline.cases || {}, key)
      ? baseline.cases[key] : undefined;
    const nowStr = rank === Infinity ? 'MISS' : String(rank);
    const wasStr = was === null ? 'MISS' : String(was);
    // Blank when unchanged: the column exists to make MOVEMENT visible, and a
    // wall of "=" would bury the two rows that actually moved.
    const moved = (was === undefined || wasStr === nowStr) ? '' : `${wasStr}→${nowStr}`;

    rows.push({
      mark: pass ? (vsGate === 'AT GATE' ? 'ok!' : 'ok ') : 'XX ',
      query: c.query,
      expect: c.expect.name + (c.expect.type ? ` [${c.expect.type}]` : ''),
      rank: nowStr,
      max: c.maxRank,
      vsGate,
      moved,
    });
  }

  // report
  const w = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log('Lookup usability harness');
  console.log('─'.repeat(84));
  console.log(`${w('', 3)}${w('query', 22)}${w('-> expected', 34)}${w('rank', 6)}${w('max', 5)}${w('vs gate', 10)}since base`);
  for (const r of rows) {
    console.log(`${r.mark}${w(r.query, 22)}${w('-> ' + r.expect, 34)}${w(r.rank, 6)}` +
      `${w(r.max, 5)}${w(r.vsGate, 10)}${r.moved}`);
  }
  console.log('─'.repeat(84));
  const mrr = (rrSum / CASES.length).toFixed(3);
  console.log(`MRR ${mrr} over ${CASES.length} lookup cases | ${CASES.length - failures} pass, ${failures} fail (top-N gate)`);
  // Surfaced as its own line because it is the EARLY warning: `ok!` rows pass
  // today and are one slot from failing, which the pass/fail count cannot say.
  if (atGate) {
    console.log(`⚠ ${atGate} case${atGate === 1 ? '' : 's'} sitting AT the gate (marked ok!) — ` +
      'passing, one slot from a red.');
  }
  if (worstOver) {
    console.log(`worst overshoot: +${worstOver} past its gate ` +
      '(a near-miss and a collapse are different bugs).');
  }

  // ---- discovery cases (recall@N of the canonical must-have set) ----
  if (DISCOVERY_CASES.length) {
    console.log('');
    console.log('Discovery (recall@N — mechanic search surfaces the whole set)');
    console.log('─'.repeat(72));
    for (const d of DISCOVERY_CASES) {
      const ranked = Lookup.rankResults(d.query);
      const { found, missed, recall } = recallAt(ranked, d.mustInclude, d.topN);
      const pass = recall >= d.minRecall;
      if (!pass && !d.pending) failures++;   // pending = measured, not gated
      const mark = d.pending ? '·· ' : (pass ? 'ok ' : 'XX ');
      const fmt = x => `${x.label}@${x.rank === Infinity ? 'MISS' : x.rank}`;
      console.log(`${mark}"${d.query}"  recall@${d.topN} = ` +
        `${found.length}/${d.mustInclude.length} (${recall.toFixed(2)}, gate ${d.minRecall}` +
        `${d.pending ? ', PENDING tag pass' : ''})`);
      if (found.length)  console.log('     in:  ' + found.map(fmt).join(', '));
      if (missed.length) console.log('     out: ' + missed.map(fmt).join(', '));
    }
    console.log('─'.repeat(72));
  }

  if (SAVE_BASELINE) {
    // `generated` is a note to a human reading the file, not an input: nothing
    // reads it back. The DB stamp is the useful half — ranks move when the DB
    // is rebuilt, so a baseline from a different blob explains a wall of
    // movement that would otherwise read as a ranking regression.
    fs.writeFileSync(BASELINE_PATH, JSON.stringify({
      generated: new Date().toISOString(),
      db_bytes: fs.statSync(DB_PATH).size,
      cases: nextBaseline,
    }, null, 2) + '\n', 'utf8');
    console.log(`baseline written: ${path.relative(ROOT, BASELINE_PATH)} ` +
      `(${Object.keys(nextBaseline).length} cases)`);
  } else if (baseline) {
    const moved = rows.filter(r => r.moved).length;
    console.log(`baseline: ${moved} of ${rows.length} case${rows.length === 1 ? '' : 's'} moved ` +
      `since ${baseline.generated || 'an unstamped run'}` +
      (baseline.db_bytes && baseline.db_bytes !== fs.statSync(DB_PATH).size
        ? ' — NB the DB blob has changed size since then, so movement is expected' : ''));
  }

  process.exit(failures > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
