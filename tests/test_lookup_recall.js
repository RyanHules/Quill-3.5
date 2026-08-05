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
  // index bug never indexed (fixed 2026-08-05).  It sits mid-pack among the
  // weapon-focus family that also match the phrase, so the bar is "reachable",
  // not "top": the failure mode was ABSENCE (rank MISS), now it's rank ~13.
  { query: 'selected weapon', expect: { name: 'Weapon Focus', type: 'feat' }, maxRank: 15,
    note: 'body-text match on benefit; regressed by the COALESCE index bug (2026-08-05)' },

  // --- exact / near-exact name (name match should dominate) ---
  { query: 'fireball',        expect: { name: 'Fireball', type: 'spell' },      maxRank: 1 },
  { query: 'power attack',    expect: { name: 'Power Attack', type: 'feat' },   maxRank: 1 },
  { query: 'haste',           expect: { name: 'Haste', type: 'spell' },         maxRank: 3 },
  { query: 'detect magic',    expect: { name: 'Detect Magic', type: 'spell' },  maxRank: 3 },
  { query: 'cloak of resistance', expect: { name: 'Cloak of Resistance' },      maxRank: 3 },

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

// ---- run ------------------------------------------------------------------
(async () => {
  const initSqlJs = require(SQL_JS_PATH);
  const SQL = await initSqlJs({ locateFile: () => WASM_PATH });
  const db = new SQL.Database(fs.readFileSync(DB_PATH));

  const Lookup = loadLookup(db);
  if (typeof Lookup.rankResults !== 'function') {
    console.error('FAIL: Lookup.rankResults is not exposed (lookup.js seam missing)');
    process.exit(1);
  }

  let rrSum = 0, failures = 0;
  const rows = [];
  for (const c of CASES) {
    const ranked = Lookup.rankResults(c.query);
    const rank = rankOf(ranked, c.expect);
    const rr = rank === Infinity ? 0 : 1 / rank;
    rrSum += rr;
    const pass = rank <= c.maxRank;
    if (!pass) failures++;
    rows.push({
      mark: pass ? 'ok ' : 'XX ',
      query: c.query,
      expect: c.expect.name + (c.expect.type ? ` [${c.expect.type}]` : ''),
      rank: rank === Infinity ? 'MISS' : String(rank),
      max: c.maxRank,
    });
  }

  // report
  const w = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log('Lookup usability harness');
  console.log('─'.repeat(72));
  console.log(`${w('', 3)}${w('query', 22)}${w('-> expected', 30)}${w('rank', 6)}max`);
  for (const r of rows) {
    console.log(`${r.mark}${w(r.query, 22)}${w('-> ' + r.expect, 30)}${w(r.rank, 6)}${r.max}`);
  }
  console.log('─'.repeat(72));
  const mrr = (rrSum / CASES.length).toFixed(3);
  console.log(`MRR ${mrr} over ${CASES.length} lookup cases | ${CASES.length - failures} pass, ${failures} fail (top-N gate)`);

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

  process.exit(failures > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
