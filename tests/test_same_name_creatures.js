// Same-name creatures that are NOT reprints of each other must both be
// reachable: in the lookup, and in the companion picker.
//
// The bug (2026-10-27): the sheet treats every same-named creature as a
// reprint and keeps the newest printing. Fiendish Codex II prints an Aspect of
// Bel at CR 20; a 2007 web enhancement prints a different Aspect of Bel at CR 9.
// The lookup showed only the web one, the companion datalist listed the name
// once, and the companion auto-fill took whichever row SQLite returned first.
//
// "Different creature" is Lookup.creatureIdentity: CR span + Hit Dice count.
// The split/collapse sets below are DERIVED from the DB with that function, so
// a new book that adds a same-name pair is covered without editing this file;
// the anchors pin known cases so a derivation that comes back empty (a broken
// parser, a renamed column) fails instead of passing vacuously.
//
// Run: node tests/test_same_name_creatures.js   (exit 0 pass, 1 fail)
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const initSqlJs = require(path.join(ROOT, 'vendor/sql-wasm.js'));

let failures = 0, passes = 0;
function check(cond, msg) {
  if (cond) { passes++; return; }
  failures++;
  console.log('FAIL: ' + msg);
}

function fakeDocument(appended) {
  const el = () => ({ style: {}, children: [], value: '', id: '',
    classList: { add() {}, toggle() {} }, setAttribute() {}, addEventListener() {},
    appendChild(c) { this.children.push(c); } });
  return { readyState: 'loading', addEventListener() {}, removeEventListener() {},
    querySelector: () => null, getElementById: () => null, createElement: el,
    body: { appendChild: (c) => appended.push(c) } };
}

(async () => {
  const SQL = await initSqlJs({ locateFile: () => path.join(ROOT, 'vendor/sql-wasm.wasm') });
  const db = new SQL.Database(fs.readFileSync(path.join(ROOT, 'data/dnd35.db')));
  const all = (sql, params) => {
    const st = db.prepare(sql); if (params) st.bind(params);
    const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out;
  };
  const DB = { isLoaded: () => true, query: all, queryOne: (s, p) => all(s, p)[0] || null,
               ready: Promise.resolve(true) };
  const appended = [];
  const document = fakeDocument(appended);
  const window = { DB };
  const load = (file, global) => new Function('window', 'document', 'DB',
    fs.readFileSync(path.join(ROOT, file), 'utf8') + `\n;return ${global};`)(window, document, DB);
  const Lookup = load('lookup.js', 'window.Lookup');
  window.Lookup = Lookup;
  const Companion = load('companion.js', 'Companion');
  await new Promise(r => setTimeout(r, 0));          // let DB.ready build the datalist

  // ---- the identity function itself ----------------------------------------
  const id = Lookup.creatureIdentity;
  check(id('20', '22 HD') !== id('9', '11 HD (104 hp)'), 'FC2 vs web Aspect of Bel read as one creature');
  check(id('13', '12 HD (174 hp)') !== id('13', '14 HD (175 hp)'),
        'Aspect of Tiamat (Dragon Magic 12 HD vs web 14 HD, both CR 13) read as one creature');
  check(id('8', '12d12+48 (126 hp)') === id('8', '12d12+36'),
        'Salt Mummy reprint (hp corrected) read as two creatures');
  check(id('22 HD', null) === '' && id(null, '2d10') === '', 'an unknown CR or HD must give no identity');
  check(id('20', '22 HD') !== '', '"22 HD" (no dice notation) must parse to a Hit Dice count');

  // ---- derive the split / collapse sets from the DB --------------------------
  const groups = new Map();
  for (const r of all("SELECT name, source, version, cr, json_extract(data,'$.hit_dice') AS hd " +
                      "FROM entry WHERE type = 'creature'")) {
    const k = r.version + '\u0000' + r.name.toLowerCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const split = [], collapse = [];
  for (const [k, rows] of groups) {
    if (rows.length < 2) continue;
    const ids = new Set(rows.map(r => id(r.cr, r.hd)).filter(Boolean));
    (ids.size >= 2 ? split : collapse).push({ name: rows[0].name, version: rows[0].version, n: ids.size });
  }
  check(split.some(g => g.name === 'Aspect of Bel'), 'anchor: Aspect of Bel is not in the derived split set');
  check(split.some(g => g.name === 'Aspect of Tiamat'), 'anchor: Aspect of Tiamat is not in the derived split set');
  check(collapse.some(g => g.name === 'Salt Mummy'), 'anchor: Salt Mummy is not in the derived reprint set');

  // ---- lookup: one row per distinct creature, one row per reprint group ------
  const rows = (name, version) => Lookup.rankResults(name).filter(e =>
    e.type === 'creature' && e.version === version && e.name.toLowerCase() === name.toLowerCase());
  for (const g of split) {
    const got = rows(g.name, g.version);
    check(got.length === g.n, `lookup "${g.name}": ${got.length} creature row(s), want ${g.n} ` +
          `[${got.map(e => e.source).join(' | ')}]`);
  }
  for (const g of collapse) {
    const got = rows(g.name, g.version);
    check(got.length === 1, `lookup "${g.name}" (a reprint): ${got.length} rows, want 1`);
  }

  // ---- companion: the options, and what a typed name resolves to -------------
  const dl = appended.find(x => x.id === 'creature-options');
  check(!!dl, 'companion did not build #creature-options');
  const opts = new Set((dl ? dl.children : []).map(o => o.value));
  for (const v of ['Aspect of Bel', 'Aspect of Bel (FC2)', 'Aspect of Bel (FC2FA2)',
                   'Aspect of Tiamat (DrM)', 'Aspect of Tiamat (FC2FA2)'])
    check(opts.has(v), `companion datalist lacks "${v}"`);
  check(![...opts].some(v => /^Salt Mummy \(/.test(v)), 'companion datalist qualifies a reprint (Salt Mummy)');
  const cr = (name) => {
    const r = Companion.findBaseCreatureRow(name);
    return r ? JSON.parse(r.data).challenge_rating : null;
  };
  check(cr('Aspect of Bel (FC2)') === '20', `"Aspect of Bel (FC2)" resolved to CR ${cr('Aspect of Bel (FC2)')}, want 20`);
  check(cr('aspect of bel (fc2fa2)') === '9', 'the qualified web aspect did not resolve, case-insensitively, to CR 9');
  check(cr('Aspect of Bel') === '9', 'a bare shared name must resolve to the newest printing (the 2007 web one)');
  const paren = all("SELECT name FROM entry WHERE type='creature' AND name LIKE '%(%)' LIMIT 1")[0];
  check(!paren || Companion.findBaseCreatureRow(paren.name),
        `a creature whose printed name ends in a parenthetical (${paren && paren.name}) no longer resolves`);

  console.log(`same-name creatures: ${passes} passed, ${failures} failed ` +
              `(${split.length} split groups, ${collapse.length} reprint groups)`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
