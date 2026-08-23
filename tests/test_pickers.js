// Smoke test: runs the EXACT SQL each *-picker.js issues against
// dnd35.db via the same sql.js library the browser uses.
//
// Run: node tests/test_pickers.js
// Exits 0 on all-pass, 1 on any failure.
//
// Methodology: the queries below are pulled verbatim from the picker
// .js files. If you change a picker query, update the matching test.
// `grep -nE "DB\\.(query|queryOne)\\(" *-picker.js` lists them all.
//
// IMPORTANT: as of the 2026-05-14 schema cleanup, ALL pickers query
// the unified `entry` table directly (with json_extract for per-type
// fields). The old per-type compatibility views (spell, feat, item,
// race, monster, class_pc, class_table, class_level, race_*,
// template_*) are gone.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data/dnd35.db');
const SQL_JS_PATH = path.join(ROOT, 'vendor/sql-wasm.js');
const WASM_PATH = path.join(ROOT, 'vendor/sql-wasm.wasm');

// ---- tiny test framework --------------------------------------------------

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertGE(actual, expected, msg) {
  assert(actual >= expected,
    msg || `expected >= ${expected}, got ${actual}`);
}
function assertNotEmpty(arr, msg) {
  assert(Array.isArray(arr) && arr.length > 0,
    msg || `expected non-empty array, got ${arr && arr.length}`);
}
function assertEq(actual, expected, msg) {
  assert(actual === expected,
    (msg || 'values differ') + ` (expected ${expected}, got ${actual})`);
}

// ---- DB loader ------------------------------------------------------------

async function loadDb() {
  const initSqlJs = require(SQL_JS_PATH);
  const SQL = await initSqlJs({
    locateFile: () => WASM_PATH,
  });
  const buf = fs.readFileSync(DB_PATH);
  return new SQL.Database(new Uint8Array(buf));
}

function execAll(db, sql, params) {
  const stmt = db.prepare(sql);
  try {
    if (params) stmt.bind(params);
    const cols = stmt.getColumnNames();
    const rows = [];
    while (stmt.step()) {
      const vs = stmt.get();
      const r = {};
      for (let i = 0; i < cols.length; i++) r[cols[i]] = vs[i];
      rows.push(r);
    }
    return rows;
  } finally {
    stmt.free();
  }
}

function execOne(db, sql, params) {
  const r = execAll(db, sql, params);
  return r.length ? r[0] : null;
}

// ---- tests: database.js load-time queries ---------------------------------

test('count of races > 80', (db) => {
  const r = execOne(db,
    "SELECT COUNT(*) AS n FROM entry WHERE type = 'race'");
  assertGE(r.n, 80);
});

test('RotD web enhancement: kobold optional_features + standalone entries', (db) => {
  // The 4 variant kobold traits are folded onto the RotD Kobold race as
  // `optional_features` (additive, combinable, inherited by the UA kobold
  // variants). A rebuild dropping the field or clearing the rotd_we_* emit
  // dirs would silently regress the web enhancement — guard both here.
  // (2026-07-09)
  const of = execOne(db,
    "SELECT json_array_length(json_extract(data,'$.optional_features')) AS n "
    + "FROM entry WHERE type='race' AND name='Kobold' "
    + "AND source='Races of the Dragon'");
  assertEq(of.n, 4, 'RotD Kobold should carry 4 optional_features');
  // 9 standalone web-enh entries (4 weapon, 1 domain, 3 rule, 1 feat).
  const we = execOne(db,
    "SELECT COUNT(*) AS n FROM entry "
    + "WHERE source='Races of the Dragon Web Enhancement'");
  assertEq(we.n, 9, 'expected 9 standalone web-enhancement entries');
});

test('count of spells > 2500', (db) => {
  const r = execOne(db,
    "SELECT COUNT(*) AS n FROM entry WHERE type = 'spell'");
  assertGE(r.n, 2500);
});

test('count of feats > 1000', (db) => {
  // feat-picker covers type='feat' only now — ACFs relocated to
  // class-variants and skill_tricks to special-ability-picker
  // (2026-05-17 / 2026-06-16).
  const r = execOne(db, "SELECT COUNT(*) AS n FROM entry "
    + "WHERE type = 'feat'");
  assertGE(r.n, 1000);
});

test('count of skill_tricks >= 40', (db) => {
  // Skill tricks are now their own pickable scope (Special Abilities).
  const r = execOne(db,
    "SELECT COUNT(*) AS n FROM entry WHERE type = 'skill_trick'");
  assertGE(r.n, 40);
});

test('count of items > 1500', (db) => {
  const r = execOne(db, "SELECT COUNT(*) AS n FROM entry "
    + "WHERE type IN ('item','weapon','armor','gear')");
  assertGE(r.n, 1500);
});

test('count of templates >= 12 (post-cleanup)', (db) => {
  const r = execOne(db,
    "SELECT COUNT(*) AS n FROM entry WHERE type = 'template'");
  assertGE(r.n, 12);
});

test('no per-type compat views remain', (db) => {
  const rows = execAll(db,
    "SELECT name FROM sqlite_master WHERE type = 'view'");
  assert(rows.length === 0,
    `unexpected views: ${rows.map(r => r.name).join(',')}`);
});

// ---- tests: feat-picker.js ------------------------------------------------

test('feat-picker: list query (init)', (db) => {
  // Mirrors feat-picker.js buildIndex: player-selectable feats only —
  // no ACFs (those live in class-variants), no Monstrous Variant sidebars.
  const rows = execAll(db,
    "SELECT id AS feat_id, name, version, types_csv FROM entry "
    + "WHERE type = 'feat' "
    + "AND (types_csv IS NULL OR types_csv NOT LIKE '%Monstrous Variant%') "
    + "ORDER BY CASE version WHEN '3.5' THEN 0 ELSE 1 END, "
    + "name COLLATE NOCASE");
  assertGE(rows.length, 1000);
  assert(rows[0].name && rows[0].feat_id != null);
});

test('feat-picker: excludes ACFs + Monstrous Variant sets (2026-06-16)', (db) => {
  // Regression for the 2026-06-16 narrowing (Ryan): the Feats list shows
  // ONLY player-selectable feats. ACFs belong to class-variants; the
  // Dungeonscape "Alternative Feats: <monster>" sidebars (types_csv
  // 'Monstrous Variant') are monster-customization SETS, not feats. Real
  // monster feats ('Monstrous' / 'Monster') deliberately stay.
  const src = readSource('feat-picker.js');
  assert(!/IN \(\s*'feat'\s*,\s*'acf'\s*\)/.test(src),
    "feat-picker still queries type IN ('feat','acf') — ACFs leak in.");
  assert(/NOT LIKE '%Monstrous Variant%'/.test(src),
    'feat-picker is missing the Monstrous Variant exclusion.');
  // The excluded rows still EXIST (in their proper homes)...
  assertGE(execOne(db, "SELECT COUNT(*) AS n FROM entry WHERE type='acf'").n, 1);
  assertGE(execOne(db,
    "SELECT COUNT(*) AS n FROM entry WHERE type='feat' "
    + "AND types_csv LIKE '%Monstrous Variant%'").n, 1);
  // ...but the mirrored picker query returns none of them.
  const picked = execAll(db,
    "SELECT type, types_csv FROM entry "
    + "WHERE type = 'feat' "
    + "AND (types_csv IS NULL OR types_csv NOT LIKE '%Monstrous Variant%')");
  assert(picked.every(r => r.type === 'feat'), 'picker leaked a non-feat type');
  assert(picked.every(r => !/Monstrous Variant/.test(r.types_csv || '')),
    'picker leaked a Monstrous Variant set');
});

test('feat-picker: detail query (onSelect)', (db) => {
  const list = execAll(db,
    "SELECT id AS feat_id FROM entry "
    + "WHERE type = 'feat' "
    + "AND (types_csv IS NULL OR types_csv NOT LIKE '%Monstrous Variant%') LIMIT 1");
  const detail = execOne(db,
    "SELECT id AS feat_id, name, source, version, types_csv, "
    + "json_extract(data, '$.prerequisites') AS prerequisites, "
    + "json_extract(data, '$.benefit')       AS benefit, "
    + "json_extract(data, '$.normal')        AS normal, "
    + "json_extract(data, '$.special')       AS special, "
    + "json_extract(data, '$.description')   AS description "
    + "FROM entry WHERE id = ?", [list[0].feat_id]);
  assert(detail && detail.name);
});

// ---- tests: item-picker.js ------------------------------------------------

test('item-picker: list query (init)', (db) => {
  const rows = execAll(db,
    "SELECT id AS item_id, name, version, item_type AS type FROM entry "
    + "WHERE type IN ('item', 'weapon', 'armor', 'gear') "
    + "ORDER BY CASE version WHEN '3.5' THEN 0 ELSE 1 END, "
    + "name COLLATE NOCASE");
  assertGE(rows.length, 1500);
});

test('item-picker: detail query', (db) => {
  const list = execAll(db,
    "SELECT id AS item_id FROM entry "
    + "WHERE type IN ('item','weapon','armor','gear') LIMIT 1");
  const detail = execOne(db,
    "SELECT id AS item_id, name, source, version, "
    + "item_type AS type, body_slot, aura, caster_level, price, weight, "
    + "json_extract(data, '$.prerequisites') AS prerequisites, "
    + "json_extract(data, '$.cost')          AS cost, "
    + "json_extract(data, '$.description')   AS description "
    + "FROM entry WHERE id = ?", [list[0].item_id]);
  assert(detail && detail.name);
});

// ---- tests: spell-picker.js -----------------------------------------------

test('spell-picker: distinct class names (init)', (db) => {
  const rows = execAll(db,
    'SELECT DISTINCT class_name FROM spell_class_level');
  assertGE(rows.length, 25);
  const classes = new Set(rows.map(r => r.class_name));
  assert(classes.has('Sorcerer'));
  assert(classes.has('Cleric'));
  assert(classes.has('Spellthief'));
});

test('spell-picker: spell list join via entry table', (db) => {
  const rows = execAll(db,
    "SELECT DISTINCT e.id AS spell_id, e.name, e.school, e.version "
    + "FROM entry e JOIN spell_class_level scl ON e.id = scl.entry_id "
    + "WHERE e.type = 'spell' "
    + "AND scl.class_name IN (?) AND scl.level = ? "
    + "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, "
    + "e.name COLLATE NOCASE",
    ['Sorcerer', 3]);
  assertGE(rows.length, 30, 'Sor 3 spell list looks thin');
});

test('spell-picker: spell detail by name', (db) => {
  const r = execOne(db,
    "SELECT id AS spell_id, name, source, version, school, subschool, "
    + "descriptor, "
    + "json_extract(data, '$.components')        AS components, "
    + "json_extract(data, '$.casting_time')      AS casting_time, "
    + "json_extract(data, '$.range')             AS range, "
    + "json_extract(data, '$.target')            AS target, "
    + "json_extract(data, '$.area')              AS area, "
    + "json_extract(data, '$.effect')            AS effect, "
    + "json_extract(data, '$.duration')          AS duration, "
    + "json_extract(data, '$.saving_throw')      AS saving_throw, "
    + "json_extract(data, '$.spell_resistance')  AS spell_resistance, "
    + "json_extract(data, '$.description')       AS description "
    + "FROM entry "
    + "WHERE type = 'spell' AND name = ? COLLATE NOCASE "
    + "ORDER BY CASE version WHEN '3.5' THEN 0 ELSE 1 END LIMIT 1",
    ['Fireball']);
  assert(r && r.name === 'Fireball');
  assert(r.school === 'Evocation');
});

// ---- tests: race-picker.js ------------------------------------------------

test('race-picker: list query (init)', (db) => {
  const rows = execAll(db,
    "SELECT e.id AS race_id, e.name, e.version, e.source, "
    + "       b.publication_date "
    + "FROM entry e "
    + "LEFT JOIN book b ON b.name = e.source "
    + "WHERE e.type = 'race' "
    + "ORDER BY e.name, "
    + "         CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, "
    + "         b.publication_date DESC");
  assertGE(rows.length, 80);
  // Every row should have a publication_date (book table coverage).
  const missing = rows.filter(r => !r.publication_date).map(r => r.source);
  const missingSet = new Set(missing);
  assert(missingSet.size === 0,
    `race rows missing book metadata: ${[...missingSet].slice(0, 5)}`);
});

test('race-picker: Aasimar tiebreak prefers Planar Handbook (2004) over FRCS (2001)', (db) => {
  const rows = execAll(db,
    "SELECT e.id, e.source, b.publication_date "
    + "FROM entry e LEFT JOIN book b ON b.name = e.source "
    + "WHERE e.type = 'race' AND e.name = 'Aasimar' "
    + "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, "
    + "         b.publication_date DESC");
  if (rows.length < 2) return; // skip if only one Aasimar
  assert(rows[0].source.includes('Planar'),
    `expected Planar Handbook first, got ${rows[0].source}`);
});

test('book table: every entry.source has a matching book row', (db) => {
  const orphans = execAll(db,
    "SELECT DISTINCT source FROM entry "
    + "WHERE source NOT IN (SELECT name FROM book)");
  assert(orphans.length === 0,
    `${orphans.length} sources without book metadata: `
    + orphans.slice(0, 5).map(r => r.source).join(', '));
});

test('book table: 29+ rows seeded, all with valid ISO publication_date', (db) => {
  const rows = execAll(db, "SELECT name, publication_date FROM book");
  assertGE(rows.length, 29);
  for (const r of rows) {
    assert(/^\d{4}-\d{2}-\d{2}$/.test(r.publication_date || ''),
      `bad date for ${r.name}: ${r.publication_date}`);
  }
});

test('race-picker: detail query (entry + JSON.parse-able data)', (db) => {
  const list = execAll(db,
    "SELECT id AS race_id FROM entry WHERE type = 'race' LIMIT 1");
  const r = execOne(db,
    "SELECT id AS race_id, name, source, version, "
    + "creature_size, creature_type, data "
    + "FROM entry WHERE id = ?", [list[0].race_id]);
  assert(r && r.name);
  // data must be parseable JSON
  const parsed = JSON.parse(r.data);
  assert(typeof parsed === 'object', 'data is a JSON object');
});

test('race-picker: ability_mods canonical shape', (db) => {
  const r = execOne(db,
    "SELECT data FROM entry WHERE type = 'race' AND name = 'Dwarf'");
  if (!r) return;
  const d = JSON.parse(r.data);
  assert(Array.isArray(d.ability_mods), 'ability_mods is a list');
  assert(d.ability_mods.length > 0);
  const first = d.ability_mods[0];
  assert(first && 'ability' in first && 'modifier' in first,
    'ability_mods rows are {ability, modifier}');
});

test('race-picker: languages canonical shape', (db) => {
  const r = execOne(db,
    "SELECT data FROM entry WHERE type = 'race' AND name = 'Dwarf'");
  if (!r) return;
  const d = JSON.parse(r.data);
  assert(Array.isArray(d.languages), 'languages is a list');
  const first = d.languages[0];
  assert(first && 'language' in first && 'is_automatic' in first,
    'languages rows are {language, is_automatic}');
});

// ---- tests: template-picker.js --------------------------------------------

test('template-picker: list query (init)', (db) => {
  const rows = execAll(db,
    "SELECT id AS template_id, name, source, version, "
    + "json_extract(data, '$.template_type')      AS template_type, "
    + "json_extract(data, '$.level_adjustment')   AS level_adjustment, "
    + "COALESCE(json_extract(data, '$.new_creature_type'), "
    + "         json_extract(data, '$.type_change')) AS new_creature_type, "
    + "json_extract(data, '$.description')        AS description "
    + "FROM entry WHERE type = 'template' "
    + "ORDER BY name COLLATE NOCASE, "
    + "CASE version WHEN '3.5' THEN 0 ELSE 1 END");
  assertGE(rows.length, 12);
});

test('template-picker: detail query loads parseable data', (db) => {
  const list = execAll(db,
    "SELECT id AS template_id FROM entry WHERE type = 'template' LIMIT 1");
  const r = execOne(db,
    "SELECT id AS template_id, name, source, version, data "
    + "FROM entry WHERE id = ?", [list[0].template_id]);
  assert(r && r.name);
  const parsed = JSON.parse(r.data);
  assert(typeof parsed === 'object');
});

// ---- tests: class-picker.js -----------------------------------------------

test('class-picker: list query (init)', (db) => {
  const rows = execAll(db,
    "SELECT id AS class_id, name AS class, version, source, "
    + "json_extract(data, '$.bab_progression')  AS bab_progression, "
    + "json_extract(data, '$.fort_progression') AS fort_progression, "
    + "json_extract(data, '$.ref_progression')  AS ref_progression, "
    + "json_extract(data, '$.will_progression') AS will_progression, "
    + "json_extract(data, '$.table_caption')    AS table_caption "
    + "FROM entry WHERE type IN ('class', 'prc') "
    + "ORDER BY name, CASE version WHEN '3.5' THEN 0 ELSE 1 END");
  assertGE(rows.length, 200);
  assert(rows[0].class, 'class column populated');
});

test('class-picker: detail by id (multiclass load)', (db) => {
  const list = execAll(db,
    "SELECT id FROM entry WHERE type IN ('class','prc') LIMIT 1");
  const r = execOne(db,
    "SELECT id AS class_id, name AS class, version, "
    + "json_extract(data, '$.bab_progression')  AS bab_progression, "
    + "json_extract(data, '$.fort_progression') AS fort_progression, "
    + "json_extract(data, '$.ref_progression')  AS ref_progression, "
    + "json_extract(data, '$.will_progression') AS will_progression "
    + "FROM entry WHERE id = ? AND type IN ('class','prc')",
    [list[0].id]);
  assert(r && r.class);
});

test('class-picker: class_table JSON parses to list-of-rows', (db) => {
  // Wizard should have a 20-row class_table after normalization.
  const r = execOne(db,
    "SELECT json_extract(data, '$.class_table') AS ct "
    + "FROM entry WHERE type = 'class' AND name = 'Wizard'");
  assert(r && r.ct, 'wizard.class_table exists');
  const arr = JSON.parse(r.ct);
  assert(Array.isArray(arr), 'class_table is a list');
  assert(arr.length === 20, `expected 20 rows, got ${arr.length}`);
  const row0 = arr[0];
  assert(row0.level === 1);
  assert('bab' in row0 && 'special' in row0);
  // Wizards have spells_per_day merged in.
  assert(Array.isArray(row0.spells_per_day),
    'spells_per_day merged into row');
});

test('class-picker: spell_class_level MIN level (caster offset)', (db) => {
  const r = execOne(db,
    "SELECT MIN(level) AS mn FROM spell_class_level "
    + "WHERE class_name IN (?)", ['Wizard']);
  assert(r && r.mn !== null);
});

// ---- tests: domain-picker.js ----------------------------------------------

test('domain-picker: list query (init)', (db) => {
  const rows = execAll(db,
    "SELECT id AS domain_id, name, source, version, "
    + "json_extract(data, '$.granted_power') AS granted_power, "
    + "json_extract(data, '$.spells')        AS spells_json, "
    + "json_extract(data, '$.deities')       AS deities_json "
    + "FROM entry WHERE type = 'domain' "
    + "ORDER BY name COLLATE NOCASE, "
    + "CASE version WHEN '3.5' THEN 0 ELSE 1 END");
  assertGE(rows.length, 65);
  // Every row must have a name. The majority should have a
  // granted_power (some PGtF entries are deity-list-only refs back
  // to PHB and have null granted_power — those rely on the
  // picker's name-based fallback to find the canonical version).
  assert(rows.every(r => r.name), 'every domain has a name');
  const withPower = rows.filter(r => r.granted_power).length;
  assertGE(withPower, rows.length * 0.5,
    `at least half of domains should have a granted_power; only ` +
    `${withPower}/${rows.length} do — picker fallback may not work`);
});

test('domain-picker: Celerity domain has spell list and granted power', (db) => {
  // Celerity is the Complete Divine speed domain — we use it instead of
  // Travel because PHB1 hasn't been re-extracted into the new DB yet.
  const r = execOne(db,
    "SELECT name, "
    + "json_extract(data, '$.granted_power') AS granted_power, "
    + "json_extract(data, '$.spells')        AS spells_json "
    + "FROM entry WHERE type = 'domain' AND name = 'Celerity'");
  assert(r && r.granted_power, 'Celerity domain has granted_power');
  const spells = JSON.parse(r.spells_json);
  assert(spells && typeof spells === 'object',
    'Celerity.spells is a dict');
  assertGE(Object.keys(spells).length, 5);
});

// ---- tests: mantle-picker.js ----------------------------------------------

test('mantle-picker: list query (init)', (db) => {
  const rows = execAll(db,
    "SELECT id AS mantle_id, name, source, version, "
    + "json_extract(data, '$.granted_power')    AS granted_power, "
    + "json_extract(data, '$.powers')           AS powers_json, "
    + "json_extract(data, '$.divine_mind_aura') AS aura, "
    + "json_extract(data, '$.deities')          AS deities_json "
    + "FROM entry WHERE type = 'mantle' "
    + "ORDER BY name COLLATE NOCASE, "
    + "CASE version WHEN '3.5' THEN 0 ELSE 1 END");
  assertGE(rows.length, 30);
  const withPower = rows.filter(r => r.granted_power).length;
  assertGE(withPower, 30);
});

test('mantle-picker: Chaos mantle has powers list, granted power, aura, deities', (db) => {
  const r = execOne(db,
    "SELECT name, "
    + "json_extract(data, '$.granted_power')    AS granted_power, "
    + "json_extract(data, '$.powers')           AS powers_json, "
    + "json_extract(data, '$.divine_mind_aura') AS aura, "
    + "json_extract(data, '$.deities')          AS deities_json "
    + "FROM entry WHERE type = 'mantle' AND name = 'Chaos'");
  assert(r && r.granted_power, 'Chaos mantle has granted_power');
  const powers = JSON.parse(r.powers_json);
  assert(Array.isArray(powers) && powers.length >= 1,
    'Chaos.powers is a non-empty list (not domain\'s dict)');
  assert(powers[0].level != null && powers[0].name,
    'mantle powers rows are {level, name}');
  assert(r.aura, 'Chaos has divine_mind_aura');
  const deities = JSON.parse(r.deities_json);
  assert(Array.isArray(deities) && deities.length >= 1,
    'Chaos.deities is a non-empty list');
});

// ---- tests: maneuver-picker.js --------------------------------------------

test('maneuver-picker: list query (init)', (db) => {
  const rows = execAll(db,
    "SELECT id AS maneuver_id, name, source, version, discipline, "
    + "json_extract(data, '$.type')              AS type, "
    + "json_extract(data, '$.level')             AS level, "
    + "json_extract(data, '$.initiation_action') AS initiation_action, "
    + "json_extract(data, '$.range')             AS range, "
    + "json_extract(data, '$.target')            AS target, "
    + "json_extract(data, '$.duration')          AS duration, "
    + "json_extract(data, '$.saving_throw')      AS saving_throw, "
    + "json_extract(data, '$.prerequisite')      AS prerequisite, "
    + "json_extract(data, '$.classes')           AS classes_json, "
    + "json_extract(data, '$.description')       AS description "
    + "FROM entry WHERE type = 'maneuver' "
    + "ORDER BY name COLLATE NOCASE, "
    + "CASE version WHEN '3.5' THEN 0 ELSE 1 END");
  assertGE(rows.length, 200);
  // Disciplines present
  const disciplines = new Set(rows.map(r => r.discipline).filter(Boolean));
  assertGE(disciplines.size, 6, '6+ disciplines present');
  assert(disciplines.has('Iron Heart'));
  assert(disciplines.has('Stone Dragon'));
});

test('maneuver-picker: filter by discipline + level (Diamond Mind L2)', (db) => {
  const rows = execAll(db,
    "SELECT name, "
    + "json_extract(data, '$.level') AS level "
    + "FROM entry WHERE type = 'maneuver' "
    + "AND discipline = 'Diamond Mind' "
    + "AND CAST(json_extract(data, '$.level') AS INTEGER) = 2");
  assertGE(rows.length, 1);
});

// ---- tests: class-picker class-features auto-populate ---------------------

test('class-picker: Cleric class_features include Turn Undead', (db) => {
  const r = execOne(db,
    "SELECT json_extract(data, '$.class_features') AS cf "
    + "FROM entry WHERE type = 'class' AND name = 'Cleric'");
  assert(r && r.cf);
  const features = JSON.parse(r.cf);
  const names = features.map(f => f.name || '');
  assert(names.some(n => /turn|rebuke/i.test(n)),
    'Cleric should have Turn/Rebuke Undead');
});

test('class-picker: Barbarian class_features include Rage', (db) => {
  const r = execOne(db,
    "SELECT json_extract(data, '$.class_features') AS cf "
    + "FROM entry WHERE type = 'class' AND name = 'Barbarian'");
  assert(r && r.cf);
  const features = JSON.parse(r.cf);
  const names = features.map(f => f.name || '');
  assert(names.some(n => /^rage$/i.test(n)),
    'Barbarian should have Rage at L1');
});

// ---- tests: power-picker.js -----------------------------------------------

test('power-picker: list query (init)', (db) => {
  const rows = execAll(db,
    "SELECT id AS power_id, name, source, version, discipline, "
    + "json_extract(data, '$.level')              AS level_json, "
    + "json_extract(data, '$.power_points')       AS power_points, "
    + "json_extract(data, '$.description')        AS description "
    + "FROM entry WHERE type = 'power' "
    + "ORDER BY name COLLATE NOCASE, "
    + "CASE version WHEN '3.5' THEN 0 ELSE 1 END");
  assertGE(rows.length, 100);
  // Disciplines present
  const disciplines = new Set(rows.map(r => r.discipline).filter(Boolean));
  assertGE(disciplines.size, 5, '5+ disciplines (the 6 psionic ones)');
});

test('power-picker: level dict shape', (db) => {
  const r = execOne(db,
    "SELECT json_extract(data, '$.level') AS lvl "
    + "FROM entry WHERE type = 'power' AND name = 'Adrenaline Boost'");
  assert(r && r.lvl);
  const lvl = JSON.parse(r.lvl);
  assert(typeof lvl === 'object' && !Array.isArray(lvl),
    'power.level is a {className: level} dict');
  assert(Object.keys(lvl).length >= 1);
});

// ---- tests: mystery-picker.js ---------------------------------------------

test('mystery-picker: list query (init)', (db) => {
  const rows = execAll(db,
    "SELECT id AS mystery_id, name, source, version, "
    + "json_extract(data, '$.path')                 AS path, "
    + "json_extract(data, '$.mystery_level')        AS mystery_level, "
    + "json_extract(data, '$.level_in_progression') AS progression, "
    + "json_extract(data, '$.school')               AS school "
    + "FROM entry WHERE type = 'mystery' "
    + "ORDER BY name COLLATE NOCASE");
  assertGE(rows.length, 65);
  // Progressions present
  const progs = new Set(rows.map(r => r.progression).filter(Boolean));
  assert(progs.has('Fundamental'));
  assert(progs.has('Apprentice'));
  assert(progs.has('Initiate'));
  assert(progs.has('Master'));
});

test('mystery-picker: filter by path + progression', (db) => {
  const rows = execAll(db,
    "SELECT name FROM entry WHERE type = 'mystery' "
    + "AND json_extract(data, '$.level_in_progression') = 'Fundamental'");
  assertGE(rows.length, 5, 'Fundamentals exist');
});

// ---- tests: soulmeld-picker.js --------------------------------------------

test('soulmeld-picker: list query (init)', (db) => {
  const rows = execAll(db,
    "SELECT id AS soulmeld_id, name, source, version, "
    + "json_extract(data, '$.chakra')       AS chakra, "
    + "json_extract(data, '$.classes_csv')  AS classes_csv, "
    + "json_extract(data, '$.description')  AS description "
    + "FROM entry WHERE type = 'soulmeld' "
    + "ORDER BY name COLLATE NOCASE");
  assertGE(rows.length, 80);
  // Chakras present
  const chakras = new Set(rows.map(r => (r.chakra || '').split(/\s*\(/)[0].trim()).filter(Boolean));
  assert(chakras.size >= 8, `expected 8+ distinct chakras, got ${chakras.size}`);
});

// The DB canonized the structured soulmeld shape on 2026-08-03: `description`
// is the base effect ALONE, with `essentia` and `chakra_binds` as their own
// fields (canonical_fields.SOULMELD_SHAPE_CANON). This test used to assert the
// opposite — that description still carried "Base:" / "Essentia:" / "Chakra
// Bind" headers — because the picker reconstructed the structure with a regex.
// It now asserts the canon, and asserts the retired headers are GONE, so the
// consumer side fails if the old prose shape ever comes back.
test('soulmeld-picker: structured base / essentia / chakra_binds', (db) => {
  const r = execOne(db,
    "SELECT json_extract(data, '$.description')  AS d, "
    + "json_extract(data, '$.essentia')     AS e, "
    + "json_extract(data, '$.chakra_binds') AS b "
    + "FROM entry WHERE type = 'soulmeld' AND name = 'Acrobat Boots'");
  assert(r && r.d, 'has a description');
  assert(!/Base:|Essentia:|Chakra Bind\s*\(/i.test(r.d),
    'description must NOT still carry the retired prose headers');
  assert(r.e && r.e.length > 10, 'has an essentia field');
  const binds = JSON.parse(r.b || '[]');
  assert(Array.isArray(binds) && binds.length >= 1, 'has chakra_binds');
  assert(binds.every(x => x.chakra && x.description),
    'each bind has chakra + description');
});

// Every soulmeld, both books — the whole point of the canon is that Dragon
// Magic's 5 and Magic of Incarnum's 89 now read identically.
test('soulmeld-picker: canon holds for all soulmelds, both sources', (db) => {
  const rows = execAll(db,
    "SELECT name, source, json_extract(data, '$.description') AS d, "
    + "json_extract(data, '$.chakra_binds') AS b "
    + "FROM entry WHERE type = 'soulmeld'");
  assertGE(rows.length, 90);
  const prose = rows.filter(r => /Base:|Chakra Bind\s*\(/i.test(r.d || ''));
  assert(prose.length === 0,
    `still in prose shape: ${prose.slice(0, 3).map(r => r.name).join(', ')}`);
  const noBinds = rows.filter(r => {
    try { return !JSON.parse(r.b || '[]').length; } catch (e) { return true; }
  });
  assert(noBinds.length === 0,
    `missing chakra_binds: ${noBinds.slice(0, 3).map(r => r.name).join(', ')}`);
  const sources = new Set(rows.map(r => r.source));
  assertGE(sources.size, 2, 'covers both soulmeld books');
});

// ---- tests: vestige-picker.js ---------------------------------------------

test('vestige-picker: list query (init)', (db) => {
  const rows = execAll(db,
    "SELECT id AS vestige_id, name, source, version, "
    + "json_extract(data, '$.vestige_level') AS vestige_level, "
    + "json_extract(data, '$.binding_dc')    AS binding_dc, "
    + "json_extract(data, '$.granted_abilities') AS granted_abilities_json "
    + "FROM entry WHERE type = 'vestige' "
    + "ORDER BY CAST(json_extract(data, '$.vestige_level') AS INTEGER), "
    + "         name COLLATE NOCASE");
  assertGE(rows.length, 30);
  // Levels span 1-8.
  const levels = new Set(rows.map(r => r.vestige_level));
  assertGE(levels.size, 6, '6+ distinct vestige levels');
});

test('vestige-picker: Acererak has granted_abilities as a list of records', (db) => {
  const r = execOne(db,
    "SELECT json_extract(data, '$.granted_abilities') AS abil "
    + "FROM entry WHERE type = 'vestige' AND name = 'Acererak, the Devourer'");
  assert(r && r.abil);
  const abilities = JSON.parse(r.abil);
  assert(Array.isArray(abilities), 'granted_abilities is a list');
  assertGE(abilities.length, 2);
  assert('name' in abilities[0] && 'description' in abilities[0],
    'ability rows have {name, description}');
});

// ---- tests: invocation-picker.js ------------------------------------------

test('invocation-picker: list query (init)', (db) => {
  const rows = execAll(db,
    "SELECT id AS invocation_id, name, source, version, "
    + "json_extract(data, '$.grade')                  AS grade, "
    + "json_extract(data, '$.spell_level_equivalent') AS spell_level_equivalent, "
    + "json_extract(data, '$.subcategory')            AS subcategory, "
    + "json_extract(data, '$.description')            AS description "
    + "FROM entry WHERE type = 'invocation' "
    + "ORDER BY name COLLATE NOCASE");
  assertGE(rows.length, 45);
  const grades = new Set(rows.map(r => r.grade).filter(Boolean));
  // Canonical four grades present.
  assert(grades.has('Least'));
  assert(grades.has('Lesser'));
  assert(grades.has('Greater'));
  assert(grades.has('Dark'));
});

test('invocation-picker: filter by grade (Lesser invocations >= 8)', (db) => {
  const rows = execAll(db,
    "SELECT COUNT(*) AS n FROM entry "
    + "WHERE type = 'invocation' "
    + "AND json_extract(data, '$.grade') = 'Lesser'");
  assertGE(rows[0].n, 8);
});

// ---- tests: tag filtering -------------------------------------------------

test('feat-picker: tag filter (combat-maneuver feats >= 60)', (db) => {
  const rows = execAll(db,
    "SELECT COUNT(*) AS n FROM entry e "
    + "JOIN tag t ON t.entry_id = e.id "
    + "WHERE e.type = 'feat' "
    + "AND t.tag = 'combat-maneuver'");
  assertGE(rows[0].n, 60);
});

// ---- tests: class-variants (ACFs + sub levels) ----------------------------

test('class-variants: ACF query returns matches for common classes', (db) => {
  // The picker queries all ACFs and tokenizes the class field in JS.
  // Here we just confirm the underlying data: each common class has
  // at least one ACF whose class field mentions it.
  const rows = execAll(db,
    "SELECT name, json_extract(data, '$.class') AS class_field "
    + "FROM entry WHERE type = 'acf'");
  function tokenize(raw) {
    if (!raw) return [];
    return String(raw)
      .replace(/\([^)]*\)/g, '')
      .split(/\s*(?:\/|,|\bor\b)\s*/i)
      .map(s => s.trim()).filter(Boolean);
  }
  for (const expected of ['Wizard', 'Cleric', 'Fighter', 'Barbarian',
                          'Monk', 'Druid', 'Paladin', 'Rogue']) {
    const matched = rows.filter(r => tokenize(r.class_field)
      .some(t => t.toLowerCase() === expected.toLowerCase()));
    assert(matched.length > 0,
      `class-variants: no ACFs match class "${expected}" — picker ` +
      `would render an empty section for it.`);
  }
});

test('class-variants: sub-level query returns matches via class or base_class', (db) => {
  // Sub levels use `class` (PlH-style) or `base_class` (MoI-style).
  // Confirm at least a handful of common classes resolve at least one.
  const rows = execAll(db,
    "SELECT name, "
    + "  json_extract(data, '$.class')      AS class_field, "
    + "  json_extract(data, '$.base_class') AS base_class_field "
    + "FROM entry WHERE type = 'subst_level'");
  for (const expected of ['Wizard', 'Fighter', 'Cleric', 'Paladin']) {
    const matched = rows.filter(r =>
      r.class_field === expected || r.base_class_field === expected);
    assert(matched.length > 0,
      `class-variants: no sub levels for class "${expected}".`);
  }
});

test('cache buster: single CACHE_VERSION drives all script + stylesheet tags', () => {
  // Regression guard for the 2026-05-19 unification. We don't want to
  // drift back to ~42 hand-edited `?v=20260519f` strings sprinkled
  // across index.html. The contract:
  //   - index.html defines `window.CACHE_VERSION` in exactly ONE place
  //   - The stylesheet + script tags are emitted via document.write()
  //     reading from that constant
  //   - No literal `?v=<string>` outside the CACHE_VERSION assignment
  const html = readSource('index.html');

  const versionAssigns = (html.match(/window\.CACHE_VERSION\s*=/g) || []).length;
  assert(versionAssigns === 1,
    `index.html must define window.CACHE_VERSION exactly once (found ${versionAssigns}).`);

  // The loader uses document.write to emit each module's <script>.
  assert(/document\.write\s*\([^)]*<script/i.test(html),
    'index.html: module-loader document.write() emission is missing.');
  assert(/document\.write\s*\([^)]*<link/i.test(html),
    'index.html: stylesheet document.write() emission is missing.');

  // Reject lingering manually-versioned tags. The new pattern
  // computes ?v= at runtime from CACHE_VERSION; any literal
  // `?v=<datestring>` in the file is a regression.
  const literalVersionTags = html.match(/\?v=20\d{6}[a-z]?/g) || [];
  assert(literalVersionTags.length === 0,
    `index.html still contains ${literalVersionTags.length} hand-edited ?v= literals ` +
    `(${literalVersionTags.slice(0, 3).join(', ')}…). Use CACHE_VERSION + document.write() instead.`);

  // The module list should include the canonical core modules so
  // the loader doesn't silently drop one. Spot-check three.
  for (const m of ["'spells.js'", "'metamagic-preparer.js'", "'database.js'"]) {
    assert(html.includes(m),
      `index.html: module loader missing entry ${m}.`);
  }
});

test('class-variants: appendToCustomizations integrates with ClassFeatures API', () => {
  // The "+ To Customizations" button targets the structured list on
  // the Class Features tab. Guard the wiring contract:
  //   - index.html hosts the list container + empty-state element
  //   - class-features.js exposes addCustomization()
  //   - class-features.js collectData emits `customizations`
  //   - class-features.js loadData accepts both the new shape AND
  //     the legacy textarea field via migrateLegacyTextarea
  //   - class-variants.js invokes ClassFeatures.addCustomization
  const html = readSource('index.html');
  assert(/id="class-customizations-list"/.test(html),
    'index.html: #class-customizations-list container is missing — ' +
    'class-features.js cannot render customization rows.');
  assert(/id="class-customizations-empty"/.test(html),
    'index.html: #class-customizations-empty placeholder is missing.');

  const cf = readSource('class-features.js');
  assert(/function addCustomization\s*\(/.test(cf),
    'class-features.js: addCustomization API is missing — ' +
    'class-variants.js has no programmatic insert path.');
  assert(/function migrateLegacyTextarea\s*\(/.test(cf),
    'class-features.js: migrateLegacyTextarea is missing — pre-' +
    'structured-list saves with `class-customizations: <string>` ' +
    'would silently drop the user\'s customization list on load.');
  const collectBody = extractFunctionBody(cf, 'collectData');
  assert(/data\.customizations\s*=/.test(collectBody),
    'class-features.js: collectData does not emit `customizations` ' +
    '— the structured list would not survive save/load.');

  const cv = readSource('class-variants.js');
  assert(/ClassFeatures\.addCustomization\s*\(/.test(cv),
    'class-variants.js: "+ To Customizations" does not call ' +
    'ClassFeatures.addCustomization — clicks would no-op silently.');
});

test('class-variants: chips tagged with customizations + auto-strip on remove', () => {
  // Two contracts:
  //   (1) class-picker chip rendering injects a .mc-chip-tag badge
  //       per customization matching the chip's class.
  //   (2) removeClass strips customizations whose `class` matched the
  //       removed class via ClassFeatures.removeCustomizationsForClass.
  const cp = readSource('class-picker.js');
  assert(/mc-chip-tag/.test(cp),
    'class-picker.js: renderClassList does not render .mc-chip-tag ' +
    'badges — applied chips would not show their customizations.');
  assert(/ClassFeatures\.removeCustomizationsForClass\s*\(/.test(cp),
    'class-picker.js: removeClass does not call ' +
    'ClassFeatures.removeCustomizationsForClass — customizations ' +
    'for a removed class would persist as orphans.');

  const cf = readSource('class-features.js');
  assert(/function removeCustomizationsForClass\s*\(/.test(cf),
    'class-features.js: removeCustomizationsForClass API is missing.');
});

test('class-variants: class-picker strikes through replaced features', () => {
  // The whole point of customizations "doing something" is that
  // replaced class features get visually marked in the class-picker
  // info panel. Guard that the wiring is present (the runtime
  // assertion lives in playfeel-suite SS4).
  const src = readSource('class-picker.js');
  assert(/function buildReplacedMap\s*\(/.test(src),
    'class-picker.js: buildReplacedMap helper is missing.');
  assert(/function findReplacement\s*\(/.test(src),
    'class-picker.js: findReplacement helper is missing.');
  assert(/cf-replaced/.test(src),
    'class-picker.js: cumulative-features rendering does not apply ' +
    'the cf-replaced class — ACFs would have no visible effect.');
  assert(/class-customizations-changed/.test(src),
    'class-picker.js: info panel does not listen for ' +
    'class-customizations-changed — adding/removing a customization ' +
    'would not refresh the strike-through preview.');
});

// Load class-variants.js as a real module with a stubbed window + DB
// (backed by the live sql.js db) so the inheritance matching can be
// exercised end-to-end, not just grep-checked.
function loadClassVariants(db) {
  const src = readSource('class-variants.js');
  const stubDB = {
    isLoaded: () => true,
    query: (sql, params) => execAll(db, sql, params),
  };
  const win = { DB: stubDB };  // BookFilter intentionally absent → allow all
  const factory = new Function('window', 'DB', 'console', 'document',
    src + '\nreturn ClassVariants;');
  return factory(win, stubDB, console, undefined);
}

test('class-variants: variant class inherits valid parent ACFs at the variant\'s level', (db) => {
  const CV = loadClassVariants(db);

  // Feature→level map is derived correctly from the variant's table.
  const mr = CV.getClassData('Mystic Ranger');
  assert(mr && mr.variant_of === 'Ranger', 'Mystic Ranger missing variant_of=Ranger');
  const fmap = CV.buildFeatureLevelMap(mr);
  assertEq(fmap.get('combat style'), 3, 'combat style should map to Mystic Ranger L3');
  assertEq(fmap.get('swift tracker'), 8, 'swift tracker should map to L8');
  assertEq(fmap.get('3 favored enemy'), 14, '3rd favored enemy should map to L14');
  assert(fmap.has('spells') || fmap.has('spell'), 'spells feature should be present');

  const acfs = CV.getACFs('Mystic Ranger');
  const byName = Object.fromEntries(acfs.map(a => [a.name, a]));

  // INHERIT: combat-style ACF, surfaced at the VARIANT's level (L3, not L2).
  const ocv = byName['Other Class Variant: Ranger'];
  assert(ocv, 'Mystic Ranger should inherit "Other Class Variant: Ranger"');
  assertEq(Number(ocv._effLevel), 3, 'combat-style ACF should come in at Mystic Ranger L3');
  assertEq(ocv._inheritedFrom, 'Ranger', 'inherited ACF should be tagged from Ranger');

  // INHERIT: favored-enemy ACF at L2.
  assert(byName['Favored Enemy Variant: Favored Environment'],
    'Mystic Ranger should inherit the favored-enemy ACF');

  // STRICT EXCLUDE: anything replacing animal companion (traded away).
  assert(!byName['Distracting Attack'],
    'Mystic Ranger must NOT inherit an ACF that replaces its missing Animal Companion');
  assert(!byName['Ranger Variant: Planar Ranger'],
    'strict ACF rule: Planar Ranger replaces Animal Companion (absent) — must be excluded');
});

test('class-variants: Chaos Monk excludes flurry ACFs, keeps bonus-feat styles', (db) => {
  const CV = loadClassVariants(db);
  const acfs = CV.getACFs('Chaos Monk');
  const byName = Object.fromEntries(acfs.map(a => [a.name, a]));

  // EXCLUDE: Decisive Strike replaces Flurry of Blows, which the Chaos
  // Monk does not have (it has flailing strike instead).
  assert(!byName['Decisive Strike'],
    'Chaos Monk must NOT inherit Decisive Strike (replaces flurry of blows, which it lacks)');

  // INHERIT: the style ACFs replace monk bonus feats, which Chaos Monk has at L1.
  const style = byName['Sleeping Tiger Style'] || byName['Cobra Strike Style'];
  assert(style, 'Chaos Monk should inherit the bonus-feat style ACFs');
  assertEq(Number(style._effLevel), 1, 'bonus-feat style ACF should come in at L1');
  assertEq(style._inheritedFrom, 'Monk', 'inherited style ACF should be tagged from Monk');
});

test('class-picker: variant ⇄ base mutual exclusion (can\'t hold both)', (db) => {
  // DB carries the variant_of pointers the mutex keys on.
  const vrows = execAll(db,
    "SELECT name, json_extract(data,'$.variant_of') AS vof FROM entry " +
    "WHERE type IN ('class','prc') AND json_extract(data,'$.variant_of') IS NOT NULL");
  const vmap = Object.fromEntries(vrows.map(r => [r.name, r.vof]));
  assertEq(vmap['Chaos Monk'], 'Monk', 'Chaos Monk variant_of Monk');
  assertEq(vmap['Mystic Ranger'], 'Ranger', 'Mystic Ranger variant_of Ranger');

  // class-picker reads variant_of into its index + enforces the mutex.
  const cp = readSource('class-picker.js');
  assert(/AS variant_of/.test(cp),
    'class index query must select variant_of');
  assert(/function variantBaseOf/.test(cp) && /function findVariantConflict/.test(cp),
    'class-picker must expose variantBaseOf + findVariantConflict');
  // applyToSheet must consult the conflict finder and bail before pushing.
  assert(/findVariantConflict\(cls\.class\)/.test(cp),
    'applyToSheet must check findVariantConflict(cls.class)');
  assert(/const conflict = findVariantConflict[\s\S]{0,900}?flashPanel[\s\S]{0,80}?return;/.test(cp),
    'a detected conflict must flash a message and return early (block the apply)');
  // All three clash directions are covered: variant-over-base,
  // base-under-variant, sibling-variant.
  for (const kind of ["'base'", "'variant'", "'sibling'"]) {
    assert(cp.includes(`kind: ${kind}`),
      `findVariantConflict must report the ${kind} clash`);
  }
  // Self (re-apply at a new level) must be skipped, not flagged as a clash.
  assert(/eq\(e\.className,\s*applyingName\)\)\s*continue/.test(cp),
    're-applying the same variant (level bump) must not self-conflict');
});

test('class-variants: substitution-level inheritance is per-feature + level-adjusted', (db) => {
  const CV = loadClassVariants(db);
  const subs = CV.getSubLevels('Mystic Ranger');
  const byName = Object.fromEntries(subs.map(s => [s.name, s]));

  // Portal Intuition replaces Swift Tracker → Mystic Ranger L8.
  const pi = byName['Portal Intuition (Ranger Planar Substitution Level 8)'];
  assert(pi, 'Mystic Ranger should inherit Portal Intuition (replaces swift tracker, which it has)');
  assertEq(Number(pi._effLevel), 8, 'swift-tracker sub level should come in at Mystic Ranger L8');

  // A sub level replacing animal companion is excluded (no matched feature).
  assert(!byName['Planar Animal Companion (Ranger Planar Substitution Level 4)'],
    'sub level replacing the absent Animal Companion must be excluded');
});

test('class-variants: non-variant class ACFs are unchanged (no inheritance tags)', (db) => {
  const CV = loadClassVariants(db);
  const acfs = CV.getACFs('Ranger');
  assert(acfs.length > 0, 'Ranger should still have its own ACFs');
  assert(acfs.every(a => !a._inheritedFrom),
    'a base (non-variant) class must not carry inherited-ACF tags');
});

test('class-variants: matchFeatureLevel prefers exact over subset (variant feature levels)', (db) => {
  const CV = loadClassVariants(db);
  const fmap = CV.buildFeatureLevelMap(CV.getClassData('Mystic Ranger'));
  // Exact match wins over the generic it's a superset of.
  assertEq(CV.matchFeatureLevel('Combat Style', fmap), 3, 'Combat Style → L3');
  assertEq(CV.matchFeatureLevel('Improved Combat Style', fmap), 7,
    'Improved Combat Style must resolve to L7, not the L3 generic');
  assertEq(CV.matchFeatureLevel('Combat Style Mastery', fmap), 12,
    'Combat Style Mastery → L12');
  // Generic name with no exact key falls back to the earliest subset match.
  assertEq(CV.matchFeatureLevel('Favored Enemy', fmap), 2,
    'Favored Enemy → L2 (first favored enemy) via subset fallback');
  // A feature the variant doesn't get → no match.
  assertEq(CV.matchFeatureLevel('Animal Companion', fmap), null,
    'Mystic Ranger does not get Animal Companion → null');

  const fmap2 = CV.buildFeatureLevelMap(CV.getClassData('Chaos Monk'));
  assertEq(CV.matchFeatureLevel('Improved Evasion', fmap2), 9,
    'Improved Evasion → L9, not the L2 generic Evasion');
  assertEq(CV.matchFeatureLevel('Flurry of Blows', fmap2), null,
    'Chaos Monk has flailing strike, not flurry of blows → null');
});

test('class-picker: fetchClassFeatures applies variant class-feature inheritance', (db) => {
  // The variant inherits parent features it actually gets, at its level.
  const src = readSource('class-picker.js');
  assert(/function getEffectiveClassFeatures\s*\(/.test(src),
    'class-picker.js: getEffectiveClassFeatures helper is missing');
  assert(/getEffectiveClassFeatures\(classData\)/.test(src),
    'fetchClassFeatures must route through getEffectiveClassFeatures');
});

test('class-picker: class bonus-feat auto-apply data path (Ranger Track/Endurance)', (db) => {
  // syncClassBonusFeats keys on: feature name matches a feat AND its
  // description says "bonus feat". Mystic Ranger inherits Ranger's Track/
  // Endurance features, so the parent data must carry both signals.
  const cf = JSON.parse(execOne(db,
    "SELECT data FROM entry WHERE name='Ranger' AND type='class'").data).class_features;
  for (const fn of ['Track', 'Endurance']) {
    const f = cf.find(x => x.name === fn);
    assert(f && /bonus feat/i.test(f.description || ''),
      `Ranger's ${fn} feature must describe a bonus-feat grant`);
    assert(execOne(db, "SELECT 1 AS x FROM entry WHERE type='feat' AND name=?", [fn]),
      `${fn} must exist as a feat for the auto-apply to recognize it`);
  }
  assert(/function syncClassBonusFeats\s*\(/.test(readSource('class-picker.js')),
    'class-picker.js: syncClassBonusFeats is missing');
  assert(/dataset\.fromClassFeat\s*===\s*["']1["']/.test(readSource('feats.js')),
    'feats.js collectData must skip data-from-class-feat (derived) rows');
});

test('feats (phase 3): core flat-bonus feats carry structured bonuses + the sheet consumes them', (db) => {
  // DB: the ~19 core PHB feats are structured.
  const n = execOne(db, "SELECT COUNT(*) AS n FROM entry WHERE type='feat' " +
    "AND json_extract(data,'$.bonuses') IS NOT NULL").n;
  assertGE(n, 18, 'the core flat-bonus PHB feats must carry structured bonuses');
  const iw = JSON.parse(execOne(db,
    "SELECT data FROM entry WHERE type='feat' AND name='Iron Will'").data);
  assertEq(iw.bonuses[0].bonus_type, 'save');
  assertEq(iw.bonuses[0].target, 'Will');
  assertEq(iw.bonuses[0].amount, 2);
  assertEq(iw.bonuses[0].bonus_category, 'untyped',
    'feat bonuses are untyped (they stack)');
  const sf = JSON.parse(execOne(db,
    "SELECT data FROM entry WHERE type='feat' AND name='Skill Focus'").data);
  assertEq(sf.bonuses[0].target, '@choice', 'Skill Focus uses a @choice target');
  assertEq(sf.specialization, 'skill', 'Skill Focus is a skill-specialization feat');
  const al = JSON.parse(execOne(db,
    "SELECT data FROM entry WHERE type='feat' AND name='Alertness'").data);
  assertEq(al.bonuses.length, 2, 'Alertness grants two skill bonuses (Listen + Spot)');

  // Sheet wiring: Feats exposes the accessors; skills.js + app.js consume them.
  const feats = readSource('feats.js');
  for (const fn of ['getResolvedFeatBonuses', 'getActiveSkillBonuses',
                    'getActiveSaveBonuses', 'getActiveACBonuses']) {
    assert(new RegExp(fn).test(feats), `feats.js must expose ${fn}`);
  }
  assert(/@choice/.test(feats),
    'feats.js must resolve the @choice target from the parenthetical');
  const sk = readSource('skills.js');
  assert(/Feats\.getActiveSkillBonuses/.test(sk) && /featBonus/.test(sk),
    'skills.js must add feat skill bonuses to the total');
  const app = readSource('app.js');
  assert(/Feats\.getActiveSaveBonuses/.test(app) && /Feats\.getActiveACBonuses/.test(app),
    'app.js must collect feat save + AC bonuses');
  assert(/#tab-feats/.test(app),
    'app.js must recalc when a feat changes (feats now feed the aggregator)');
});

test('feats (phase 3 expansion): verified walked-book feats carry flat skill/save bonuses', (db) => {
  // Hand-verified unconditional bonuses stamped by-name in normalize_schema.
  const get = (n) => {
    const r = execOne(db,
      "SELECT data FROM entry WHERE type='feat' AND name=:n " +
      "AND json_extract(data,'$.bonuses') IS NOT NULL LIMIT 1", { ':n': n });
    return r ? JSON.parse(r.data).bonuses : null;
  };
  // Epic save feats — flat +4 to one save, untyped.
  const ew = get('Epic Will');
  assert(ew && ew.length === 1 && ew[0].bonus_type === 'save' &&
    ew[0].target === 'Will' && ew[0].amount === 4, 'Epic Will = +4 Will save');
  // Typed bonus is preserved (luck), not flattened to untyped.
  const seer = get('Seer');
  assert(seer && seer.length === 4 && seer.every(b => b.bonus_category === 'luck'),
    'Seer = +1 luck on Listen/Search/Sense Motive/Spot');
  // UA character TRAITS are a separate subsystem (benefit+drawback, stored
  // as type='feat' with a drawback field) — they must NOT be in the feat
  // bonus pipeline.
  for (const trait of ['Abrasive (Trait)', 'Hardy (Trait)', 'Detached (Trait)']) {
    const r = execOne(db, "SELECT json_extract(data,'$.bonuses') AS b FROM entry " +
      "WHERE type='feat' AND name=:n", { ':n': trait });
    assert(!r || r.b == null, `${trait} is a trait, not a feat — no feat bonuses`);
  }
  // A known conditional/activated feat must NOT be stamped FLAT (always-on).
  // Since 2026-07-01 the routable ones DO carry conditional bonuses — every
  // such bonus must keep a non-null condition so it routes to a situational
  // note, never the always-on total.
  for (const cond of ['Combat Focus', 'Inquisitor', 'True Believer', 'Run']) {
    const r = execOne(db, "SELECT json_extract(data,'$.bonuses') AS b FROM entry " +
      "WHERE type='feat' AND name=:n", { ':n': cond });
    const rows = r && r.b ? JSON.parse(r.b) : [];
    assert(rows.length > 0 && rows.every(x => x.condition != null),
      `${cond} must carry ONLY conditional bonuses (non-null condition), not flat`);
  }
});

test('feats: conditional skill bonuses route to situational (not the flat total)', () => {
  // feats.js getActiveSkillBonuses must push condition-bearing skill bonuses
  // to `situational` (mirroring the trait path) and keep summing the
  // unconditional ones into `direct`. skills.js must include
  // featSkill.situational in its per-skill note concat.
  const fsrc = readSource('feats.js');
  const body = extractFunctionBody(fsrc, 'getActiveSkillBonuses');
  assert(body, 'getActiveSkillBonuses not found');
  assert(/situational\.push\(\s*\{\s*skill:/.test(body),
    'getActiveSkillBonuses must route conditional skill bonuses to situational.');
  assert(/direct\[k\]\s*=\s*\(direct\[k\]\s*\|\|\s*0\)\s*\+\s*b\.amount/.test(body),
    'unconditional feat skill bonuses must still SUM into direct.');
  const ssrc = readSource('skills.js');
  assert(/featSkill\.situational/.test(ssrc),
    'skills.js must concat featSkill.situational into the per-skill notes.');
});

test('situational notes surface bonus TYPE + SOURCE', () => {
  // The type (what stacks) + source (which feat/race/…) must reach the note.
  // Categorizers carry category+source on situational; feats tag each bonus
  // with its feat name; the render sites show both.
  const dsrc = readSource('data.js');
  assert(/situational\.push\(\{\s*skill, amount, condition: cond,\s*\n?\s*category: b\.bonus_category, source: b\.source/.test(dsrc),
    'categorizeSkillBonuses situational must carry category + source.');
  assert(/source: b\.source, appliesAll/.test(dsrc),
    'categorizeSaveBonuses situational must pass source through.');
  const fsrc = readSource('feats.js');
  assert(/bonus\.source = featName/.test(fsrc),
    'getResolvedFeatBonuses must tag each bonus with its granting feat name.');
  const csrc = readSource('character.js');
  assert(/function _typeLabel/.test(csrc) && /_typeLabel\(s\.category\)/.test(csrc),
    'character.js save/AC render must show the bonus type via _typeLabel.');
  const sksrc = readSource('skills.js');
  assert(/sit\.source \|\| "conditional"/.test(sksrc) && /sit\.category/.test(sksrc),
    'skills.js situational render must show sit.category + sit.source.');
});

test('traits/flaws: own entry types, not feats (future picker can query type)', (db) => {
  // UA character traits + flaws were re-typed out of `feat` into their own
  // `trait` / `flaw` types (benefit+drawback / penalty-for-bonus-feat are a
  // separate creation-time subsystem).
  const traits = execOne(db, "SELECT COUNT(*) AS n FROM entry WHERE type='trait'").n;
  const flaws  = execOne(db, "SELECT COUNT(*) AS n FROM entry WHERE type='flaw'").n;
  assertGE(traits, 30, 'UA character traits are type=trait');
  assertGE(flaws, 12, 'UA flaws (all 13, incl. the unsuffixed ones) are type=flaw');
  // None left masquerading as feats.
  const leak = execOne(db, "SELECT COUNT(*) AS n FROM entry WHERE type='feat' " +
    "AND (name LIKE '%(Trait)%' OR name LIKE '%(Flaw)%' " +
    "OR json_extract(data,'$.drawback') IS NOT NULL)").n;
  assertEq(leak, 0, 'no trait/flaw still typed as feat');
  // A trait keeps its benefit AND drawback; a flaw keeps its effect.
  const ab = JSON.parse(execOne(db,
    "SELECT data FROM entry WHERE type='trait' AND name='Abrasive (Trait)'").data);
  assert(ab.benefit && ab.drawback, 'trait carries benefit + drawback');
  const shaky = execOne(db,
    "SELECT json_extract(data,'$.effect') AS e FROM entry WHERE type='flaw' AND name='Shaky'");
  assert(shaky && shaky.e, 'flaw carries its effect penalty');
  // The feat picker must NOT surface traits/flaws (it filters type = 'feat').
  const fp = readSource('feat-picker.js');
  assert(/type\s*=\s*'feat'/.test(fp) && !/['"]trait['"]/.test(fp) &&
    !/['"]flaw['"]/.test(fp), 'feat-picker query excludes trait/flaw');
  // The lookup modal renders the new types.
  const lk = readSource('lookup.js');
  assert(/trait:\s*'Trait'/.test(lk) && /flaw:\s*'Flaw'/.test(lk),
    'lookup TYPE_LABELS include trait + flaw');
  assert(/function renderTraitExtra/.test(lk) && /function renderFlawExtra/.test(lk) &&
    /type === 'trait'/.test(lk) && /type === 'flaw'/.test(lk),
    'lookup renders trait (benefit+drawback) + flaw (effect)');
});

test('feats: structured feat-entry (info box) preserves the canonical .feat-entry round-trip', () => {
  const feats = readSource('feats.js');
  // The structured row keeps a (hidden) .feat-entry as the canonical value,
  // so collectData / getResolvedFeatBonuses / the ⓘ + prereq tooling read it
  // unchanged and the save format is untouched.
  assert(/feat-structured/.test(feats) && /feat-namebox/.test(feats),
    'feats.js must render a structured info box (feat-namebox)');
  assert(/function parseFeatText/.test(feats) && /function lookupFeatInfo/.test(feats),
    'feats.js must parse the feat text + look up the DB feat (auto-detect)');
  // The structured row hides — but keeps — the canonical .feat-entry.
  assert(/ta\.style\.display\s*=\s*["']none["']/.test(feats),
    'structured rows must HIDE (not remove) the canonical .feat-entry');
  // The specialization control writes back to the canonical .feat-entry.
  assert(/feat-spec/.test(feats) &&
         /ta\.value\s*=\s*s\s*\?/.test(feats),
    'the specialization control must write the chosen value back into .feat-entry');
  // collectData + getResolvedFeatBonuses still read .feat-entry (unchanged).
  assert(/\.feat-entry/.test(feats),
    'collectData / resolver still read .feat-entry');

  // Derived bonus-feat rows (bloodline / class grants) ALSO render read-only
  // info boxes, for consistency with picker-added feats — but show the
  // granting source as a tag (feat-source-tag) instead of an editable spec
  // control. addFeat takes opts.sourceLabel and stays structured even off a
  // DB miss (`dbInfo || sourceLabel`).
  assert(/sourceLabel/.test(feats) && /feat-source-tag/.test(feats),
    'addFeat must render derived rows as read-only info boxes with a source tag');
  assert(/dbInfo\s*\|\|\s*sourceLabel/.test(feats),
    'derived rows must render structured even when the feat is not a DB match');
  assert(/sourceLabel:/.test(readSource('bloodline.js')),
    'bloodline.js derived bonus feats must pass opts.sourceLabel (read-only info box)');
  assert(/sourceLabel:/.test(readSource('class-picker.js')),
    'class-picker.js derived bonus feats must pass opts.sourceLabel (read-only info box)');
  // The source label must NOT flow through the spec-control path (it isn't a
  // specialization): the tag branch is gated on sourceLabel, spec on else.
  assert(/if\s*\(sourceLabel\)\s*\{[\s\S]*?feat-source-tag[\s\S]*?\}\s*else\s*\{/.test(feats),
    'sourceLabel must take the tag branch, not the specialization branch');
});

test('feats: choice feats carry a specialization marker (so the read-only box can record the pick)', (db) => {
  const feats = readSource('feats.js');
  // DB side — the by-name stamp in normalize_schema marks the choice feats.
  // Tracking field only (no mechanical wiring): a read-only info box needs a
  // place to record "Weapon Focus (Longsword)".
  const expect = {
    'Weapon Focus': 'weapon', 'Greater Weapon Focus': 'weapon',
    'Weapon Specialization': 'weapon', 'Improved Critical': 'weapon',
    'Exotic Weapon Proficiency': 'weapon', 'Martial Weapon Proficiency': 'weapon',
    'Spell Focus': 'school', 'Greater Spell Focus': 'school',
    'Energy Substitution': 'energy', 'Skill Focus': 'skill',
  };
  for (const [name, kind] of Object.entries(expect)) {
    const row = execOne(db,
      "SELECT data FROM entry WHERE type='feat' AND name=:n", { ':n': name });
    assert(row, `${name} present in DB`);
    assertEq(JSON.parse(row.data).specialization, kind,
      `${name} marked specialization='${kind}'`);
  }
  // At least one printing of each is marked. Printings can diverge — a feat
  // in the bare `feats/` folder is skipped by normalize_schema's by-name
  // stamp (folder isn't mapped to 'feat') — so the JS map COALESCES, below.
  const gsf = execAll(db,
    "SELECT json_extract(data,'$.specialization') AS s FROM entry " +
    "WHERE type='feat' AND name='Greater Spell Focus'");
  assert(gsf.some(r => r.s === 'school'),
    'at least one Greater Spell Focus printing carries the marker');
  // feats.js featInfoMap must prefer a marked printing when a name has
  // several (so the unmarked one can't suppress the spec control).
  assert(/existing\s*&&\s*existing\.specialization\)\s*continue/.test(feats),
    'featInfoMap must coalesce — keep the printing that carries a specialization');
  // Reference-via-prereq feats are NOT marked (they inherit the weapon from
  // a prerequisite Weapon Focus rather than taking their own selection).
  for (const name of ['Disemboweling Strike', 'Head Shot', 'Improved Weapon Familiarity']) {
    const r = execOne(db,
      "SELECT json_extract(data,'$.specialization') AS s FROM entry " +
      "WHERE type='feat' AND name=:n", { ':n': name });
    if (r) assert(r.s == null, `${name} must NOT be marked (inherits weapon from prereq)`);
  }

  // JS side — the spec control handles weapon (free text) + school/energy/skill
  // (closed-list datalists), and renders for unmarked-but-parenthetical feats.
  assert(/function ensureSpecDatalist/.test(feats) &&
         /function specDatalistOptions/.test(feats),
    'feats.js must build per-kind specialization datalists');
  assert(/SPEC_SCHOOLS/.test(feats) && /SPEC_ENERGY/.test(feats),
    'school + energy closed lists must exist');
  assert(/dbInfo\.specialization\s*\|\|\s*\(parsed\.spec\s*\?/.test(feats),
    'spec control must render for unmarked feats that already carry a parenthetical (no read-only dead-end)');
});

test('data: stackBonuses applies 3.5 typed-stacking rules', () => {
  const DND35 = new Function(readSource('data.js') + '\nreturn DND35;')();
  const total = (l) => DND35.stackBonuses(l).total;
  // Same-type bonuses don't stack — highest wins.
  assertEq(total([{ amount: 2, bonus_category: 'racial' },
                  { amount: 1, bonus_category: 'racial' }]), 2,
    'two racial bonuses → only the +2 counts');
  // Dodge / circumstance / untyped stack.
  assertEq(total([{ amount: 1, bonus_category: 'dodge' },
                  { amount: 1, bonus_category: 'dodge' }]), 2, 'dodge stacks');
  assertEq(total([{ amount: 1, bonus_category: null },
                  { amount: 1, bonus_category: null }]), 2, 'untyped stacks');
  // Best bonus + worst penalty of a type both apply.
  assertEq(total([{ amount: 2, bonus_category: 'racial' },
                  { amount: -2, bonus_category: 'racial' }]), 0,
    'a same-type bonus and penalty both apply');
  // natural_armor is aliased to natural (one type).
  assertEq(total([{ amount: 2, bonus_category: 'natural' },
                  { amount: 3, bonus_category: 'natural_armor' }]), 3,
    'natural and natural_armor are the same non-stacking type');
  // Different types sum.
  assertEq(total([{ amount: 1, bonus_category: 'size' },
                  { amount: 2, bonus_category: 'morale' },
                  { amount: 1, bonus_category: 'luck' }]), 4, 'different types sum');
  // Suppressed losers are reported for legibility.
  const r = DND35.stackBonuses([{ amount: 2, bonus_category: 'racial' },
                                { amount: 1, bonus_category: 'racial' }]);
  assertEq(r.suppressed.length, 1, 'the overridden same-type bonus is reported as suppressed');
  assertEq(r.applied.length, 1, 'only the winning bonus is applied');

  // Bonuses and penalties are resolved SEPARATELY per type — a morale bonus
  // does NOT grant immunity to a morale penalty (rage +2 morale alongside
  // fear -2 morale → both apply, net 0).
  assertEq(DND35.stackBonuses([{ amount: 2, bonus_category: 'morale' },
                               { amount: -2, bonus_category: 'morale' }]).total, 0,
    'a morale bonus and morale penalty both apply (no overlap/immunity)');
  // Full typed save stack (the refactor): race racial +2, rage morale +2,
  // fear morale -2, cloak resistance +1, misc untyped +1 → +4.
  assertEq(DND35.stackBonuses([
    { amount: 2, bonus_category: 'racial' },
    { amount: 2, bonus_category: 'morale' },
    { amount: -2, bonus_category: 'morale' },
    { amount: 1, bonus_category: 'resistance' },
    { amount: 1, bonus_category: 'untyped' }]).total, 4,
    'full typed save stack resolves to +4');
});

test('full save stacking: all programmatic save sources emit a typed saveBonuses list', () => {
  // The cross-source save stacking depends on every source handing the
  // aggregator TYPED entries, not pre-summed numbers.
  const cf = readSource('class-features.js');
  assert(/saveBonuses:\s*\[\]/.test(cf) && /bonus_category:\s*"morale"/.test(cf),
    'class-features.js getActiveBonuses must emit typed saveBonuses (rage = morale)');
  const cn = readSource('conditions.js');
  assert(/saveBonuses/.test(cn) && /saveType:\s*'morale'/.test(cn),
    'conditions.js must emit typed saveBonuses with fear = morale');
  const app = readSource('app.js');
  assert(/saveTyped/.test(app) && /saveBonuses/.test(app),
    'app.js collectActiveBonuses must collect typed saveBonuses into saveTyped');
  // character.js stacks the whole typed set (incl. the manual fields typed).
  const ch = readSource('character.js');
  assert(/saveTyped/.test(ch) && /bonus_category:\s*"resistance"/.test(ch),
    'character.js must stack saveTyped + the manual magic field as resistance');
  assert(!/bonuses\.saves\b/.test(ch),
    'character.js must no longer read the old untyped bonuses.saves');
});

test('data: categorizeACBonuses feeds the AC onion (excludes size/natural, splits situational)', () => {
  const DND35 = new Function(readSource('data.js') + '\nreturn DND35;')();
  // Dodge → protItem with touch=true, flatfooted=false.
  const dodge = DND35.categorizeACBonuses([
    { bonus_type: 'ac', amount: 4, bonus_category: 'dodge', condition: null }]);
  assertEq(dodge.items.length, 1, 'unconditional dodge → one AC item');
  assertEq(dodge.items[0].type, 'Dodge');
  assertEq(dodge.items[0].touch, true, 'dodge applies vs touch');
  assertEq(dodge.items[0].flatfooted, false, 'dodge is lost flat-footed');
  // size + natural are excluded (handled by #char-size / #ac-natural).
  const excl = DND35.categorizeACBonuses([
    { bonus_type: 'ac', amount: 3, bonus_category: 'natural', condition: null },
    { bonus_type: 'ac', amount: -1, bonus_category: 'size', condition: null }]);
  assertEq(excl.items.length, 0, 'natural + size are not re-fed (no double-count)');
  // Deflection touch/flat-footed.
  const def = DND35.categorizeACBonuses([
    { bonus_type: 'ac', amount: 1, bonus_category: 'deflection', condition: null }]);
  assertEq(def.items[0].touch, true, 'deflection applies vs touch');
  assertEq(def.items[0].flatfooted, true, 'deflection is kept flat-footed');
  // Conditional → situational, not an item.
  const cond = DND35.categorizeACBonuses([
    { bonus_type: 'ac', amount: 4, bonus_category: 'dodge', condition: 'against dragons' }]);
  assertEq(cond.items.length, 0, 'conditional AC is not auto-applied');
  assertEq(cond.situational.length, 1, 'conditional AC → situational list');
});

test('data: marker guard — scaling / non-self target_scope rows never feed flat consumers', () => {
  const DND35 = new Function(readSource('data.js') + '\nreturn DND35;')();
  // The walk (2026-07-02+) tags non-flat bonus rows with `scaling` (amount
  // grows with level; stored amount is null or just the STARTING value) and
  // `target_scope` (ally/enemy-directed). The first marked book (CAdv,
  // 20260704-3fb53dfb) is deployed — every flat consumer must skip these so
  // a null amount can't NaN a total, a starting amount can't understate a
  // scaled bonus, and an ally-only bonus can't land on the character's own
  // sheet. Self-including scopes (self_and_allies / self_or_ally) DO apply
  // to the character and must survive.
  const ok = DND35.flatBonusRowOk.bind(DND35);
  assert(ok({ amount: 2 }), 'unmarked row passes');
  assert(ok({ amount: 2, target_scope: 'self' }), 'explicit self passes');
  assert(ok({ amount: 1, target_scope: 'self_and_allies' }), 'self_and_allies passes');
  assert(ok({ amount: 4, target_scope: 'self_or_ally' }), 'self_or_ally passes');
  assert(!ok({ amount: 2, target_scope: 'allies' }), 'allies-only is skipped');
  assert(!ok({ amount: -4, target_scope: 'enemies' }), 'enemy-directed is skipped');
  assert(!ok({ amount: 4, target_scope: 'single_ally' }), 'single_ally is skipped');
  assert(!ok({ amount: null, target_scope: 'touched animal' }), 'other-creature scope is skipped');
  assert(!ok({ amount: null, scaling: { kind: 'per_level', per: 1, step: 1 } }),
    'scaling row (null amount) is skipped');
  assert(!ok({ amount: 1, scaling: { kind: 'stepped' } }),
    'scaling row with a numeric STARTING amount is skipped too');

  // Skill: Nightsong Enforcer Skill Teamwork shape (allies + scaling + a real
  // starting amount + a condition) — must produce NEITHER a direct bonus NOR
  // a situational note; a plain flat row alongside it still lands.
  const sk = DND35.categorizeSkillBonuses([
    { bonus_type: 'skill', target: 'Hide', amount: 2, bonus_category: 'competence',
      condition: 'allies within 30 feet who can see the enforcer',
      target_scope: 'allies', scaling: { kind: 'stepped' } },
    { bonus_type: 'skill', target: 'Ride', amount: null, bonus_category: 'competence',
      condition: null, scaling: { kind: 'per_level', per: 1, step: 1 } },
    { bonus_type: 'skill', target: 'Spot', amount: 2, bonus_category: 'racial', condition: null }]);
  assertEq(sk.direct['spot'], 2, 'plain flat skill row still lands');
  assertEq(Object.keys(sk.direct).length, 1, 'marked rows add no direct skill bonus');
  assertEq(sk.situational.length, 0, 'marked rows add no situational skill note');

  // Save: the future-shape hazard — an ally-scoped row WITHOUT a condition
  // would previously have summed straight into the character's own saves.
  const sv = DND35.categorizeSaveBonuses([
    { bonus_type: 'save', target: 'all', amount: 1, bonus_category: 'morale',
      condition: null, target_scope: 'allies' }]);
  assertEq(sv.direct.fort.length + sv.direct.ref.length + sv.direct.will.length, 0,
    'unconditional ally-scoped save bonus does not sum into own saves');
  assertEq(sv.situational.length, 0, 'and produces no note');
  // Self-including scope stays (Nightsong Infiltrator Teamwork Trap Sense).
  const svSelf = DND35.categorizeSaveBonuses([
    { bonus_type: 'save', target: 'Reflex', amount: 1, bonus_category: null,
      condition: 'saves made to avoid traps', target_scope: 'self_and_allies' }]);
  assertEq(svSelf.situational.length, 1,
    'self_and_allies save row survives (situational via its condition)');

  // AC + speed categorizers consult the same guard.
  const ac = DND35.categorizeACBonuses([
    { bonus_type: 'ac', amount: 1, bonus_category: 'dodge', condition: null,
      scaling: { kind: 'stepped' } }]);
  assertEq(ac.items.length + ac.situational.length, 0, 'scaling AC row is fully skipped');
  const sp = DND35.categorizeSpeedBonuses([
    { bonus_type: 'speed', mode: 'land', amount: 10, bonus_category: 'untyped',
      scaling: { kind: 'per_level', per: 4, step: 10 } }]);
  assertEq(sp.land.addTotal, 0, 'scaling speed row is skipped');

  // feats.js getResolvedFeatBonuses routes skill rows around the categorizer
  // (its own untyped-sum path), so it must apply the guard at the source.
  assert(/flatBonusRowOk/.test(readSource('feats.js')),
    'feats.js getResolvedFeatBonuses must consult DND35.flatBonusRowOk');
});

test('data: resolveAbilityLinkedBonus turns scaling:ability rows into flat rows', () => {
  const DND35 = new Function(readSource('data.js') + '\nreturn DND35;')();
  const mods = { Wis: 3, Cha: 2, Int: -1, Dex: 4 };
  const fn = (ab) => mods[ab];
  const resolve = (b) => DND35.resolveAbilityLinkedBonus(b, fn);
  // Additive ("adds her X bonus (if any)") — amount = the mod, clamped at 0.
  const ninja = resolve({ bonus_type: 'ac', amount: null, bonus_category: 'untyped',
    condition: 'unarmored and unencumbered', scaling: { kind: 'ability', ability: 'Wis' } });
  assertEq(ninja.amount, 3, 'Ninja Wis-to-AC resolves to the Wis mod');
  assert(!('scaling' in ninja), 'resolved row strips the scaling marker');
  assert(DND35.flatBonusRowOk(ninja), 'resolved row passes the marker guard');
  const negAdd = resolve({ bonus_type: 'save', amount: null, condition: null,
    scaling: { kind: 'ability', ability: 'Int' } });
  assertEq(negAdd.amount, 0, 'additive with a negative mod grants nothing (bonus "if any")');
  // Substitution ("substitutes X modifier for Y") — raw mod, may be negative.
  const subst = resolve({ bonus_type: 'save', target: 'Reflex', amount: null,
    condition: 'substitutes Int modifier for Dex modifier',
    scaling: { kind: 'ability', ability: 'Int' } });
  assertEq(subst.amount, -1, 'substitution keeps the raw (negative) mod — the swap is mandatory');
  // Non-ability rows and missing accessors return null (caller keeps the raw row).
  assertEq(resolve({ amount: 2 }), null, 'plain flat row → null (not ability-linked)');
  assertEq(resolve({ amount: null, scaling: { kind: 'per_level', per: 1 } }), null,
    'per-level scaling row → null');
  assertEq(DND35.resolveAbilityLinkedBonus(
    { amount: null, scaling: { kind: 'ability', ability: 'Wis' } }, () => NaN), null,
    'unresolvable mod → null');
  // Both collectors resolve ability-linked rows before the guard drops them.
  assert(/resolveAbilityLinkedBonus/.test(readSource('feats.js')),
    'feats.js getResolvedFeatBonuses must try resolveAbilityLinkedBonus');
  assert(/resolveAbilityLinkedBonus/.test(readSource('class-picker.js')),
    'class-picker.js collectAcquiredFeatureBonuses must try resolveAbilityLinkedBonus');
});

test('data: categorizeInitiativeBonuses + the initiative onion wiring', () => {
  const DND35 = new Function(readSource('data.js') + '\nreturn DND35;')();
  const cat = DND35.categorizeInitiativeBonuses([
    { bonus_type: 'initiative', amount: 2, bonus_category: 'untyped', condition: null },      // Quick Reconnoiter
    { bonus_type: 'initiative', amount: -6, bonus_category: 'untyped', condition: null },     // Unreactive
    { bonus_type: 'initiative', amount: 1, bonus_category: 'competence',
      condition: 'in light or no armor' },                                                    // Scout Battle Fortitude
    { bonus_type: 'initiative', amount: null, bonus_category: 'competence', condition: null,
      scaling: { kind: 'table', rows: [{ level: 1, amount: 1 }] } },                          // marked → skipped
    { bonus_type: 'save', amount: 2, condition: null },                                       // wrong type
  ]);
  assertEq(cat.direct.length, 2, 'two unconditional flat init rows → direct');
  assertEq(cat.direct[0].amount + cat.direct[1].amount, -4, 'direct keeps signed amounts');
  assertEq(cat.situational.length, 1, 'conditional init row → situational note');
  assertEq(DND35.stackBonuses(cat.direct).total, -4, 'untyped bonus + penalty both apply');
  // Consumers: the three sources expose the feed; app.js aggregates; the
  // Character tab stacks + renders the situational note.
  for (const [f, label] of [['feats.js', 'Feats'], ['class-picker.js', 'ClassPicker'],
                            ['trait-picker.js', 'TraitPicker']]) {
    assert(/getActiveInitiativeBonuses/.test(readSource(f)),
      `${label} must expose getActiveInitiativeBonuses`);
  }
  const app = readSource('app.js');
  assert(/initiativeTyped/.test(app) && /initiativeSituational/.test(app),
    'app.js collectActiveBonuses must gather initiativeTyped + initiativeSituational');
  const chr = readSource('character.js');
  assert(/stackBonuses\(initTyped\)/.test(chr),
    'character.js must stack the typed initiative list');
  assert(/renderSituationalInit/.test(chr) && /init-situational-auto/.test(chr),
    'character.js must render situational initiative notes');
  assert(/init-situational-auto/.test(readSource('index.html')),
    'index.html must carry the #init-situational-auto container');
  // The scaling map supplies the init halves the marker guard skips.
  const cp = readSource('class-picker.js');
  assert(/"Streetfighter":[\s\S]{0,120}_init\(/.test(cp),
    'Streetfighter Always Ready must emit init rows from the scaling map');
  assert(/_init\(a, "competence", cond\)/.test(cp),
    'Scout Battle Fortitude must emit its init half alongside the Fort half');
});

test('movement: parseSpeedString structures per-mode feet + fly maneuverability', () => {
  const DND35 = new Function(readSource('data.js') + '\nreturn DND35;')();
  const p = DND35.parseSpeedString.bind(DND35);
  assertEq(p('30 ft.').land, 30, 'bare "N ft." → land');
  assertEq(p('30 ft. (6 squares)').land, 30, '"(N squares)" annotation ignored');
  const pixie = p('20 ft. (4 squares), fly 60 ft. (good)');
  assertEq(pixie.land, 20, 'land parsed alongside fly');
  assertEq(pixie.fly, 60, 'fly speed parsed');
  assertEq(pixie.flyManeuver, 'good', 'fly maneuverability parsed');
  const rap = p('30 ft.; glide 40 ft. (average); fly 40 ft. (average) at 5 HD');
  assertEq(rap.land, 30, 'semicolon-separated land');
  assertEq(rap.fly, 40, 'real fly supersedes glide; "at 5 HD" caveat ignored');
  const dig = p('40 ft., burrow 20 ft., climb 20 ft.');
  assertEq(dig.burrow, 20, 'burrow parsed');
  assertEq(dig.climb, 20, 'climb parsed');
  assertEq(p('10 ft., swim 60 ft.').swim, 60, 'swim parsed');
  assertEq(p('fly 90 ft. (perfect)').land, null, 'pure-fly creature has null land');
});

test('movement: sheet wires per-mode boxes + save migration', () => {
  const isrc = readSource('index.html');
  for (const id of ['speed-land', 'speed-fly', 'speed-fly-maneuver',
                    'speed-swim', 'speed-burrow', 'speed-climb',
                    'fly-encumbered-ok']) {
    assert(isrc.includes(`id="${id}"`), `index.html missing #${id}`);
  }
  const csrc = readSource('character.js');
  // Old single char-speed field is gone from the collect/load field LISTS
  // (a trailing-comma list item); the migration's data["char-speed"] read is
  // the only remaining reference.
  assert(!/"char-speed",/.test(csrc),
    'character.js should no longer collect/load the single char-speed field.');
  assert(/data\["char-speed"\][\s\S]{0,120}parseSpeedString/.test(csrc),
    'loadData must migrate a legacy char-speed via parseSpeedString.');
  // Fly-block rule: encumbered OR medium/heavy armor, unless flyOk (manual
  // checkbox OR an aggregator-granted flyEncumberedOk).
  assert(/fly-encumbered-ok[\s\S]{0,80}flyEncumberedOk/.test(csrc) &&
         /flyBlocked\s*=\s*\(encumbered\s*\|\|\s*armorRank\s*>=\s*2\)\s*&&\s*!flyOk/.test(csrc),
    'character.js must gate the fly-block (medium+ armor via armorRank, or encumbered) on the flyOk exception.');
});

test('movement P2: categorizeSpeedBonuses (add typed-stacked, set highest, legacy shapes)', () => {
  const DND35 = new Function(readSource('data.js') + '\nreturn DND35;')();
  const cat = DND35.categorizeSpeedBonuses.bind(DND35);
  // Typed add: two enhancement don't stack (best=30), untyped sums.
  const land = cat([
    { bonus_type: 'speed', mode: 'land', amount: 10, bonus_category: 'enhancement' },
    { bonus_type: 'speed', mode: 'land', amount: 30, bonus_category: 'enhancement' },
    { bonus_type: 'speed', mode: 'land', amount: 10, bonus_category: 'untyped' }]).land;
  assertEq(land.addTotal, 40, 'enhancement (best 30) + untyped 10 = 40');
  // Canonical set + maneuver, highest wins.
  const fly = cat([
    { bonus_type: 'speed', mode: 'fly', set: 40, maneuver: 'average' },
    { bonus_type: 'speed', mode: 'fly', set: 60, maneuver: 'good' }]).fly;
  assertEq(fly.set, 60, 'highest set wins');
  assertEq(fly.maneuver, 'good', 'maneuver follows the winning set');
  // Legacy racial *_speed (value in condition) → set.
  const leg = cat([{ bonus_type: 'fly_speed', condition: '10 ft. (perfect)' }]);
  assertEq(leg.fly.set, 10, 'legacy fly_speed → fly set');
  assertEq(leg.fly.maneuver, 'perfect', 'legacy maneuver parsed from condition');
  assertEq(cat([{ bonus_type: 'speed', fly_encumbered_ok: true }]).flyEncumberedOk,
    true, 'fly_encumbered_ok flag surfaces');
});

test('class-feature bonuses: DB-stamped + ClassPicker consumer + aggregator wiring', (db) => {
  // DB carries the verified feature bonuses (Druid Nature Sense flat; Monk
  // Still Mind conditional).
  const druid = execOne(db,
    "SELECT json_extract(data,'$.class_features') AS cf FROM entry " +
    "WHERE type='class' AND name='Druid' LIMIT 1");
  const ns = JSON.parse(druid.cf).find(f => f.name === 'Nature Sense');
  assert(ns && Array.isArray(ns.bonuses) && ns.bonuses.some(b =>
    b.bonus_type === 'skill' && /Knowledge \(nature\)/.test(b.target) &&
    b.amount === 2 && b.condition == null),
    'Druid Nature Sense must carry a flat +2 Knowledge(nature) skill bonus.');
  const monk = execOne(db,
    "SELECT json_extract(data,'$.class_features') AS cf FROM entry " +
    "WHERE type='class' AND name='Monk' LIMIT 1");
  const sm = JSON.parse(monk.cf).find(f => f.name === 'Still Mind');
  assert(sm && sm.bonuses.some(b => b.bonus_type === 'save' && b.amount === 2 &&
    /enchantment/i.test(b.condition || '')),
    'Monk Still Mind must carry a conditional +2 save vs enchantment.');
  // ClassPicker exposes the three consumers; app + skills wire them in.
  const cp = readSource('class-picker.js');
  for (const fn of ['getActiveSkillBonuses', 'getActiveSaveBonuses',
                    'getActiveACBonuses', 'collectAcquiredFeatureBonuses']) {
    assert(cp.includes(fn), `class-picker must define ${fn}.`);
  }
  assert(/level_acquired[\s\S]{0,40}>\s*lvl[\s\S]{0,20}continue/.test(cp),
    'consumer must skip features not yet acquired (level_acquired > class level).');
  const app = readSource('app.js');
  assert(/ClassPicker[\s\S]{0,40}getActiveSaveBonuses/.test(app) &&
         /ClassPicker[\s\S]{0,40}getActiveACBonuses/.test(app),
    'app.js must gather ClassPicker save + AC bonuses.');
  assert(/classSkill\s*=\s*\([\s\S]{0,60}ClassPicker\.getActiveSkillBonuses/.test(readSource('skills.js')),
    'skills.js must pull ClassPicker skill bonuses.');
});

test('class-feature scaling: level-aware map emits scaled bonuses', () => {
  const cp = readSource('class-picker.js');
  assert(/CLASS_FEATURE_SCALING/.test(cp),
    'class-picker must define CLASS_FEATURE_SCALING.');
  // Barbarian Trap Sense = floor(level/3) on Reflex + dodge AC, vs traps.
  assert(/"Barbarian":\s*\[\{\s*feature:\s*"Trap Sense"[\s\S]{0,120}Math\.floor\(l\s*\/\s*3\)/.test(cp),
    'Barbarian Trap Sense must scale as floor(level/3).');
  // Duelist Elaborate Parry = +1 dodge per level (l) at 7th+.
  assert(/"Duelist":[\s\S]{0,140}_ac\(l,\s*"dodge"/.test(cp),
    'Duelist Elaborate Parry must be +1 dodge per duelist level.');
  // The consumer emits from the scaling map (fn gates on class level).
  assert(/CLASS_FEATURE_SCALING\[c\.className\][\s\S]{0,120}def\.fn\(lvl\)/.test(cp),
    'collectAcquiredFeatureBonuses must emit the level-scaled rows.');
});

test('class-feature scaling: CAdv batch restores the marker-guard-skipped features', () => {
  const cp = readSource('class-picker.js');
  // The marker guard skips the CAdv walk's scaling-tagged DB rows, so every
  // SELF-applying scaling feature must be re-emitted by the level map.
  for (const cls of ['Dungeon Delver', 'Highland Stalker', 'Nightsong Infiltrator',
                     'Ninja', 'Scout', 'Shadowbane Stalker', 'Spymaster', 'Tempest',
                     'Thief-Acrobat', 'Vigilante', 'Wild Plains Outrider']) {
    assert(new RegExp('"' + cls + '":\\s*\\[').test(cp),
      cls + ' must be in CLASS_FEATURE_SCALING');
  }
  // Spot-check curves against the printed text.
  assert(/"Ninja":[\s\S]{0,260}Math\.floor\(l \/ 5\)/.test(cp),
    'Ninja AC Bonus scales floor(level/5) from 5th (+1/5/10/15/20 pattern)');
  assert(/"Wild Plains Outrider":[\s\S]{0,160}_sk\("Ride", l, "competence"/.test(cp),
    'WPO Ride Bonus = +class level competence on Ride');
  assert(/"Scout":[\s\S]{0,300}l >= 19 \? 5 : l >= 15 \? 4 : l >= 11 \? 3 : l >= 7 \? 2 : 1/.test(cp),
    'Scout Skirmish AC = +1@3 +2@7 +3@11 +4@15 +5@19');
  // Allies-only features must NOT be re-emitted as self bonuses.
  const mapRegion = cp.slice(cp.indexOf('CLASS_FEATURE_SCALING'),
                             cp.indexOf('function collectAcquiredFeatureBonuses'));
  assert(!/"Nightsong Enforcer":\s*\[/.test(mapRegion),
    'Nightsong Enforcer Skill Teamwork (allies-only) stays out of the scaling map');
});

test('movement P4: class fast movement + independent armor/load caps', () => {
  const DND35 = new Function(readSource('data.js') + '\nreturn DND35;')();
  // armorCategory classifier.
  assertEq(DND35.armorCategory(''), 'none', 'blank → none');
  assertEq(DND35.armorCategory('Heavy Plate'), 'heavy', 'heavy keyword');
  assertEq(DND35.armorCategory('Medium'), 'medium', 'medium keyword');
  assertEq(DND35.armorCategory('Chain Shirt (Light)'), 'light', 'light keyword');
  assertEq(DND35.armorCategory('Breastplate'), 'light', 'bare armor name → light default');
  const csrc = readSource('class-picker.js');
  assert(/CLASS_FAST_MOVEMENT/.test(csrc) && /getActiveSpeedBonuses/.test(csrc),
    'class-picker must expose getActiveSpeedBonuses from a CLASS_FAST_MOVEMENT map.');
  // Each class declares its two caps independently.
  assert(/"Barbarian":[\s\S]{0,160}max_armor:\s*"medium"[\s\S]{0,40}max_load:\s*"medium"/.test(csrc),
    'Barbarian = {max_armor medium, max_load medium}.');
  assert(/"Monk":[\s\S]{0,240}max_armor:\s*"none"[\s\S]{0,40}max_load:\s*"light"/.test(csrc),
    'Monk = {max_armor none, max_load light}.');
  assert(/"Scout":[\s\S]{0,200}max_armor:\s*"light"[\s\S]{0,40}max_load:\s*"light"/.test(csrc),
    'Scout = {max_armor light, max_load light}.');
  // app wires ClassPicker into the speed sources.
  assert(/ClassPicker[\s\S]{0,60}getActiveSpeedBonuses/.test(readSource('app.js')) ||
         /getActiveSpeedBonuses[\s\S]*ClassPicker/.test(readSource('app.js')),
    'app.js must gather ClassPicker.getActiveSpeedBonuses.');
  // character.js gates each axis independently via ranks — two conditionals.
  const chr = readSource('character.js');
  assert(/armorRank\s*<=\s*\(DND35\.armorRank\[a\.max_armor\]/.test(chr) &&
         /loadRankNow\s*<=\s*\(DND35\.loadRank\[a\.max_load\]/.test(chr),
    'character.js gatePasses must compare armorRank vs max_armor AND loadRank vs max_load.');
});

test('movement P3: structured movement field + consumers prefer it', (db) => {
  const DND35 = new Function(readSource('data.js') + '\nreturn DND35;')();
  // movementListToModes maps the canonical list → the flat box shape.
  const modes = DND35.movementListToModes([
    { mode: 'land', speed_ft: 20, maneuverability: null },
    { mode: 'fly', speed_ft: 60, maneuverability: 'good' },
    { mode: 'swim', speed_ft: 30, maneuverability: null }]);
  assertEq(modes.land, 20, 'land mapped');
  assertEq(modes.fly, 60, 'fly mapped');
  assertEq(modes.flyManeuver, 'good', 'fly maneuverability mapped');
  assertEq(modes.swim, 30, 'swim mapped');
  // Live DB: a creature carries the canonical movement list.
  const row = execOne(db,
    "SELECT json_extract(data,'$.movement') AS m FROM entry " +
    "WHERE type='creature' AND name='Aboleth'");
  assert(row && row.m, 'Aboleth must carry a movement field');
  const mv = JSON.parse(row.m);
  assert(Array.isArray(mv) && mv.every(r =>
    r && 'mode' in r && 'speed_ft' in r && 'maneuverability' in r),
    'movement must be the canonical [{mode,speed_ft,maneuverability}] list');
  // Consumers prefer the field over prose.
  assert(/movementListToModes\(parsed\.movement\)/.test(readSource('race-picker.js')),
    'race-picker must prefer parsed.movement over the prose parse.');
  assert(/movementListToModes\(ac\.movement\)/.test(readSource('creature-race-picker.js')),
    'creature-race-picker must prefer ac.movement over the prose parse.');
});

test('movement P2: aggregator wired (app collects, character consumes, sources expose)', () => {
  assert(/bonuses\.speed\s*=\s*DND35\.categorizeSpeedBonuses/.test(readSource('app.js')),
    'app.js collectActiveBonuses must build bonuses.speed via categorizeSpeedBonuses.');
  assert(/getActiveSpeedBonuses/.test(readSource('app.js')),
    'app.js must gather getActiveSpeedBonuses from the sources.');
  const csrc = readSource('character.js');
  assert(/bonuses\s*&&\s*bonuses\.speed/.test(csrc) && /modeEff/.test(csrc),
    'character.js must consume bonuses.speed (modeEff = max(box+add, set)).');
  for (const f of ['race-picker.js', 'feats.js']) {
    assert(/getActiveSpeedBonuses/.test(readSource(f)),
      `${f} must expose getActiveSpeedBonuses.`);
  }
});

test('data: categorizeSaveBonuses splits unconditional vs situational + tags the save', () => {
  const DND35 = new Function(readSource('data.js') + '\nreturn DND35;')();
  // Unconditional all-saves bonus → a TYPED entry in each save's direct list.
  const u = DND35.categorizeSaveBonuses([
    { bonus_type: 'save', target: 'all', amount: 1, bonus_category: 'luck', condition: null }]);
  assertEq(u.direct.fort.length, 1, 'unconditional all-save bonus appears in Fort list');
  assertEq(u.direct.fort[0].amount, 1, 'amount carried');
  assertEq(u.direct.fort[0].bonus_category, 'luck', 'TYPE carried for cross-source stacking');
  assertEq(u.situational.length, 0, 'no condition → not situational');
  // Cross-source stacking: two same-type unconditional bonuses (e.g. race +
  // template) don't stack — the engine collapses them.
  const combined = u.direct.fort.concat([{ amount: 1, bonus_category: 'luck' }]);
  assertEq(DND35.stackBonuses(combined).total, 1,
    'two same-type (luck) unconditional save bonuses → only +1 (cross-source)');
  // Conditional ones → situational, tagged to the inferred save.
  const c = DND35.categorizeSaveBonuses([
    { bonus_type: 'save', target: 'all', amount: 2, bonus_category: 'racial', condition: 'vs enchantment spells or effects' },
    { bonus_type: 'save', target: 'all', amount: 2, bonus_category: 'racial', condition: 'vs poison' },
    { bonus_type: 'save', target: 'Fortitude', amount: 4, bonus_category: 'racial', condition: 'to resist cold weather' }]);
  assertEq(c.direct.fort.length, 0, 'conditional bonuses do not land in the direct list');
  const bySave = {};
  for (const s of c.situational) (bySave[s.save] = bySave[s.save] || []).push(s.condition);
  assert(bySave.will && /enchant/.test(bySave.will[0]), 'enchantment → Will');
  assert(bySave.fort && bySave.fort.some(x => /poison/.test(x)), 'poison → Fort');
  assert(bySave.fort && bySave.fort.some(x => /cold/.test(x)),
    'explicit Fortitude target keeps its save even when the condition is unmappable');
  // Save inference keyword table.
  assertEq(DND35.inferSaveFromCondition('vs fear effects'), 'will', 'fear → Will');
  assertEq(DND35.inferSaveFromCondition('breath weapons'), 'ref', 'breath → Reflex');
  assertEq(DND35.inferSaveFromCondition('vs disease'), 'fort', 'disease → Fort');
  assertEq(DND35.inferSaveFromCondition('vs spells'), null, 'generic spells → no specific save');
});

test('template-picker: cleanCreatureType returns null for no-change templates', (db) => {
  // Regression: a template that doesn't change type ("Same as the base
  // creature (unchanged)") must NOT stamp its prose into #char-type — it
  // returns null so recomputeCreatureType keeps the base creature's type.
  let body = extractFunctionBody(readSource('template-picker.js'), 'cleanCreatureType');
  assert(body, 'cleanCreatureType not found');
  // The Augmented/title-case branches call helpers we don't load; the
  // no-change cases return before reaching them, so stub the helper names.
  const cleanCreatureType = new Function('typeChange',
    body.replace(/titleCaseSubtype|titleCaseHead/g, 'String'));
  for (const s of ['None', 'none',  // canonical no-change sentinel
                   'Same as the base creature (unchanged).',
                   'Same as the base race (unchanged).', 'Unchanged',
                   "The base creature's type is unchanged."]) {
    assertEq(cleanCreatureType(s), null, `"${s}" must be treated as no type change`);
  }
  // My templates now use the canonical "None" sentinel.
  for (const nm of ['Proto-creature', 'Wild']) {
    const tc = execOne(db,
      "SELECT json_extract(data,'$.type_change') AS tc FROM entry " +
      "WHERE type='template' AND name=?", [nm]);
    assertEq(tc && tc.tc, 'None', `${nm} type_change must be the canonical "None"`);
  }
  // A real type change still passes through.
  assert(cleanCreatureType('Undead (augmented dragon).'),
    'a real type change must NOT be nulled out');
});

test('template/race: Wild strips racial skills + carries structured bonuses; Silverbrow Disguise is unconditional', (db) => {
  // Wild template: structured skill bonuses (so template skills are added)
  // + strip flag (so base racial skills are removed).
  const w = JSON.parse(execOne(db,
    "SELECT data FROM entry WHERE type='template' AND name='Wild'").data);
  assertEq(w.strips_racial_skill_bonuses, true,
    'Wild must flag strips_racial_skill_bonuses');
  const skillBonuses = (w.bonuses || []).filter(b => b.bonus_type === 'skill');
  assertGE(skillBonuses.length, 6, 'Wild must carry structured skill bonuses');
  assert(skillBonuses.some(b => b.target === 'Survival' && b.amount === 4),
    'Wild +4 (Wilderness Lore) must target Survival so it applies on a 3.5 sheet');

  // Silverbrow's +2 Disguise must be UNCONDITIONAL now (a non-null condition
  // routed it to situational notes instead of the total).
  const s = JSON.parse(execOne(db,
    "SELECT data FROM entry WHERE type='race' AND name LIKE '%Silverbrow%'").data);
  const dis = (s.bonuses || []).find(b => b.target === 'Disguise');
  assert(dis && (dis.condition === null || dis.condition === undefined),
    "Silverbrow's +2 Disguise must be unconditional");
  assert((s.subtypes || []).includes('dragonblood'),
    'Silverbrow must carry the dragonblood subtype');

  // Sheet wiring: the strip helper + the race-picker filter + subtype→type.
  assert(/stripsRacialSkillBonuses/.test(readSource('template-picker.js')),
    'TemplatePicker.stripsRacialSkillBonuses must exist');
  assert(/stripsRacialSkillBonuses\(\)/.test(readSource('race-picker.js')),
    'race-picker must consult the strip flag when computing race skill bonuses');
  assert(/subtypes/.test(readSource('race-picker.js')) &&
         /\(\$\{subs\.join/.test(readSource('race-picker.js')),
    'race-picker must write subtypes into #char-type');
});

test('template-picker: reads structured NA fields (change additive, set overlap-max), no prose derive', (db) => {
  // The picker must consume the DB's structured template-NA fields, NOT
  // re-derive from prose. natural_armor_change is an additive delta;
  // natural_armor_set is use-higher overlap → applied as max(0, set−cur) so
  // #ac-natural becomes max(cur, set) and the delta reverses on removal.
  const src = readSource('template-picker.js');
  assert(/natural_armor_change:\s*\n?\s*\(typeof parsed\.natural_armor_change/.test(src),
    'template-picker record must carry structured natural_armor_change.');
  assert(/natural_armor_set:\s*\n?\s*\(typeof parsed\.natural_armor_set/.test(src),
    'template-picker record must carry structured natural_armor_set.');
  assert(/Math\.max\(0,\s*full\.natural_armor_set\s*-\s*cur\)/.test(src),
    'apply must add max(0, set − cur) so #ac-natural becomes max(cur, set).');
  assert(!/function deriveNaturalArmor\s*\(/.test(src),
    'template-picker must no longer derive NA from prose.');
  // Live DB: additive Half-Dragon carries change, overlap Lich carries set.
  const hd = execOne(db,
    "SELECT json_extract(data,'$.natural_armor_change') AS v FROM entry " +
    "WHERE type='template' AND name='Half-Dragon' AND source='Monster Manual'");
  assertEq(hd && hd.v, 4, 'Half-Dragon must carry natural_armor_change=4');
  const lich = execOne(db,
    "SELECT json_extract(data,'$.natural_armor_set') AS v FROM entry " +
    "WHERE type='template' AND name='Lich' AND source='Monster Manual'");
  assertEq(lich && lich.v, 5, 'Lich must carry natural_armor_set=5 (overlap)');
});

test('class-picker: spells_per_day normalized to 10 absolute-level columns (offset always 0)', (db) => {
  // The DB now emits spells_per_day as a full 10-column array indexed by
  // ABSOLUTE spell level (0..9), dead levels = "-" (DB normalize_schema), so
  // the char-sheet offset is a constant 0 — the old SPELL_CLASS_VARIANTS
  // MIN(level) lookup + length heuristic are retired. Verify the max-level
  // shape for the three cases that used to break: a length-6 CANTRIP caster
  // (index 0 must be a real value), a 1st-start caster (index 0 dash), and a
  // no-cantrip full caster (index 0 dash).
  assert(/function getSpellLevelOffset[\s\S]{0,600}?return 0;/.test(readSource('class-picker.js')),
    'getSpellLevelOffset must be a constant 0 now that the DB is normalized.');
  const isDash = (v) => v === '-' || v === '—' || v === '–';
  const maxSpd = (name) => {
    const row = execOne(db,
      "SELECT data FROM entry WHERE name = ? AND type IN ('class','prc') LIMIT 1",
      [name]);
    if (!row) return null;
    const ct = (JSON.parse(row.data).class_table) || [];
    const withSpd = ct.filter(
      (r) => Array.isArray(r.spells_per_day) && r.spells_per_day.length);
    if (!withSpd.length) return null;
    return withSpd.reduce((a, b) => ((b.level || 0) > (a.level || 0) ? b : a)).spells_per_day;
  };
  // [name, index-0 must be a dash?]  — cantrip casters: false; no-cantrip: true.
  for (const [name, idx0Dash] of [
    ['Mystic Ranger', false], ['Magewright', false], ['Duskblade', false],
    ['Paladin', true], ['Dread Necromancer', true], ['Death Delver', true],
  ]) {
    const spd = maxSpd(name);
    assert(spd && spd.length === 10,
      `${name}: spells_per_day must be exactly 10 columns (got ${spd && spd.length})`);
    assertEq(isDash(spd[0]), idx0Dash,
      `${name}: index 0 ${idx0Dash ? 'must be a dash (no cantrips)' : 'must be a real cantrip value'}`);
  }
});

// ---- tests: special-ability-picker (skill tricks) -------------------------

test('special-ability-picker: list query (init)', (db) => {
  const rows = execAll(db,
    "SELECT id AS trick_id, name, source, version, "
    + "json_extract(data, '$.category')      AS category, "
    + "json_extract(data, '$.prerequisites') AS prerequisites, "
    + "json_extract(data, '$.benefit')       AS benefit, "
    + "json_extract(data, '$.description')   AS description "
    + "FROM entry WHERE type = 'skill_trick' "
    + "ORDER BY name COLLATE NOCASE, "
    + "         CASE version WHEN '3.5' THEN 0 ELSE 1 END");
  assertGE(rows.length, 40);
  assert(rows[0].name && rows[0].trick_id != null);
  // Category should be one of the four CScoundrel buckets.
  const cats = new Set(rows.map(r => r.category).filter(Boolean));
  for (const expected of ['Interaction', 'Manipulation', 'Mental', 'Movement']) {
    assert(cats.has(expected),
      `skill_trick.category set should include "${expected}"`);
  }
});

test('item-picker: tag filter (slotless items >= 500)', (db) => {
  const rows = execAll(db,
    "SELECT COUNT(*) AS n FROM entry e "
    + "JOIN tag t ON t.entry_id = e.id "
    + "WHERE e.type IN ('item','weapon','armor','gear') "
    + "AND t.tag = 'slotless'");
  assertGE(rows[0].n, 500);
});

test('spell-picker: tag filter (mind-affecting spells >= 100)', (db) => {
  const rows = execAll(db,
    "SELECT COUNT(*) AS n FROM entry e "
    + "JOIN tag t ON t.entry_id = e.id "
    + "WHERE e.type = 'spell' AND t.tag = 'mind-affecting'");
  assertGE(rows[0].n, 100);
});

test('spell-picker: component filter (data + wiring, 2026-06-16)', (db) => {
  // Component data is present, and the picker wires a component <select> +
  // an index + a has/lacks test.
  const withComp = execOne(db,
    "SELECT COUNT(*) AS n FROM entry WHERE type='spell' "
    + "AND json_extract(data,'$.components') IS NOT NULL");
  assertGE(withComp.n, 2000);
  const noVerbal = execOne(db,
    "SELECT COUNT(*) AS n FROM entry WHERE type='spell' "
    + "AND json_extract(data,'$.components') IS NOT NULL "
    + "AND json_extract(data,'$.components') NOT LIKE '%V%'");
  assertGE(noVerbal.n, 50);  // there ARE spells castable without Verbal
  const src = readSource('spell-picker.js');
  assert(/class="sp-component"/.test(src),
    'spell-picker.js: no component <select> in the filter bar.');
  assert(/function buildSpellComponentIndex/.test(src),
    'spell-picker.js: buildSpellComponentIndex missing.');
  assert(/spellPassesComponentFilter/.test(src),
    'spell-picker.js: component has/lacks test missing.');
});

test('power-picker: display filter (data + wiring, 2026-06-16)', (db) => {
  const withDisp = execOne(db,
    "SELECT COUNT(*) AS n FROM entry WHERE type='power' "
    + "AND json_extract(data,'$.display') IS NOT NULL");
  assertGE(withDisp.n, 300);
  const visual = execOne(db,
    "SELECT COUNT(*) AS n FROM entry WHERE type='power' "
    + "AND LOWER(json_extract(data,'$.display')) LIKE '%visual%'");
  assertGE(visual.n, 100);
  const src = readSource('power-picker.js');
  assert(/class="pp-display"/.test(src),
    'power-picker.js: no display <select> in the filter bar.');
  assert(/rec\.display/.test(src),
    'power-picker.js: refresh() does not filter on rec.display.');
});

// ---- tests: NEW capabilities (tags, errata, spell-access provenance) ------

test('tags: query feats by combat-maneuver tag', (db) => {
  const rows = execAll(db,
    'SELECT e.name, e.source FROM entry e '
    + 'JOIN tag t ON t.entry_id = e.id '
    + 'WHERE t.tag = ? AND e.type = ?',
    ['combat-maneuver', 'feat']);
  assertGE(rows.length, 60);
});

test('tags: spells by school via tag mirror', (db) => {
  const rows = execAll(db,
    'SELECT e.name FROM entry e JOIN tag t ON t.entry_id = e.id '
    + "WHERE t.tag = 'evocation' AND e.type = 'spell'");
  assertGE(rows.length, 200);
});

test('errata: applied errata count', (db) => {
  const r = execOne(db,
    'SELECT COUNT(*) AS n FROM errata WHERE applied = 1');
  assertGE(r.n, 100);
});

test('errata: lookup errata for polymorph chain', (db) => {
  const rows = execAll(db,
    'SELECT e.name, er.kind, er.field FROM entry e '
    + 'JOIN errata er ON er.entry_id = e.id '
    + 'WHERE e.name LIKE ?', ['%olymorph%']);
  assertGE(rows.length, 1);
});

test('spell-access: Spellthief derived spells', (db) => {
  const rows = execAll(db,
    'SELECT e.name, scl.level, scl.provenance '
    + 'FROM entry e JOIN spell_class_level scl ON scl.entry_id = e.id '
    + "WHERE scl.class_name = 'Spellthief' "
    + 'ORDER BY e.name LIMIT 5');
  assertNotEmpty(rows);
  for (const r of rows) {
    assert(r.provenance.startsWith('derived'));
  }
});

test('spell-access: Beguiler has both native + derived', (db) => {
  const rows = execAll(db,
    'SELECT scl.provenance, COUNT(*) AS n '
    + 'FROM entry e JOIN spell_class_level scl ON scl.entry_id = e.id '
    + "WHERE scl.class_name = 'Beguiler' "
    + 'GROUP BY scl.provenance');
  assertGE(rows.length, 1);
  const total = rows.reduce((s, r) => s + r.n, 0);
  assertGE(total, 80);
});

// ---- tests: universal lookup modal ---------------------------------------

// The lookup modal builds its index from two queries at DB.ready.
// Both are verbatim from lookup.js#buildIndex.
test('lookup: cross-type index covers all major types', (db) => {
  const rows = execAll(db,
    "SELECT id, name, type, source FROM entry WHERE name IS NOT NULL");
  // Every entry in the DB should be searchable — the modal lists
  // ~10,500 today and we expect that to keep growing.
  assertGE(rows.length, 10000);
  // At least one row for each primary type the modal shows chips for.
  const seen = new Set(rows.map(r => r.type));
  for (const t of ['spell', 'feat', 'item', 'creature', 'rule',
                   'class', 'prc', 'race']) {
    assert(seen.has(t), `expected at least one '${t}' entry in lookup index`);
  }
});

test('lookup: type counts populated for chip strip', (db) => {
  const rows = execAll(db,
    "SELECT type, COUNT(*) AS n FROM entry " +
    "WHERE name IS NOT NULL GROUP BY type");
  // Sanity-check the chip-strip primary types: each should have a
  // user-visible number of rows (spells/feats/items dominate).
  const map = new Map(rows.map(r => [r.type, r.n]));
  assertGE(map.get('spell') || 0, 1000);
  assertGE(map.get('feat')  || 0, 500);
  assertGE(map.get('rule')  || 0, 100);
});

test('lookup: tag fanout query returns rows per entry', (db) => {
  // lookup.js#buildIndex does `SELECT entry_id, tag FROM tag` to build
  // a Map<entry_id, Set<tag>>. Verify the table has columns the code
  // expects and that the join distribution is plausible.
  const rows = execAll(db,
    "SELECT entry_id, tag FROM tag LIMIT 100");
  assertNotEmpty(rows);
  for (const r of rows) {
    assert(typeof r.entry_id === 'number',
      'tag.entry_id should be an integer');
    assert(r.tag && typeof r.tag === 'string',
      'tag.tag should be a non-empty string');
  }
  // At least 200 distinct entries are tagged — this powers the
  // `tag:mind-affecting` prefix syntax.
  const distinct = execOne(db,
    "SELECT COUNT(DISTINCT entry_id) AS n FROM tag");
  assertGE(distinct.n, 200);
});

test('lookup: errata badge index covers known applied entries', (db) => {
  // The badge module's buildIndex JOINs errata to entry (it needs
  // type/version/name for the cross-printing family map). Run the
  // verbatim query, and keep the table-health + orphan-FK checks.
  const idx = execAll(db,
    "SELECT er.entry_id, er.applied, e.type, e.version, e.name "
    + "FROM errata er JOIN entry e ON e.id = er.entry_id");
  assertGE(idx.length, 100);
  const counts = execOne(db,
    "SELECT " +
    "  COUNT(*) AS total, " +
    "  SUM(CASE WHEN applied = 1 THEN 1 ELSE 0 END) AS n_applied, " +
    "  COUNT(DISTINCT entry_id) AS n_entries " +
    "FROM errata");
  assertGE(counts.total, 100);
  assertGE(counts.n_applied, 50);
  assertGE(counts.n_entries, 100);
  const orphans = execOne(db,
    "SELECT COUNT(*) AS n FROM errata " +
    "WHERE entry_id NOT IN (SELECT id FROM entry)");
  assert(orphans.n === 0,
    `errata has ${orphans.n} orphan entry_id references`);
});

test('lookup: errata popover query returns ordered records', (db) => {
  // openPopover() runs this query with a dynamic IN over the
  // same-(type, version, name) family ids. The ORDER BY puts
  // applied rows first, then groups by kind+field for readability.
  const firstEntryWithErrata = execOne(db,
    "SELECT entry_id FROM errata WHERE applied = 1 LIMIT 1");
  assert(firstEntryWithErrata, 'expected at least one applied errata');
  const records = execAll(db,
    "SELECT source, kind, field, from_text, to_text, applied, note " +
    "FROM errata WHERE entry_id IN (?) " +
    "ORDER BY applied DESC, kind, field",
    [firstEntryWithErrata.entry_id]);
  assertNotEmpty(records);
  // Applied rows must come before advisory.
  let seenAdvisory = false;
  for (const r of records) {
    if (!r.applied) seenAdvisory = true;
    if (seenAdvisory && r.applied) {
      throw new Error('applied row appeared after advisory in popover order');
    }
  }
});

// Load the REAL lookup.js render functions in Node. The module is an
// IIFE that defers init() when document.readyState === 'loading', so a
// stub document with that readyState lets us pull window.Lookup without
// a DOM. Pill resolution (renderPrereqWithPills → resolveSeeAlsoEntry)
// hits DB, so we back the stub with the real sql.js handle.
let _lookupReqCache = null;
function loadLookupReqRenderer(db) {
  if (_lookupReqCache) return _lookupReqCache;
  const dbStub = {
    isLoaded: () => true,
    query: (sql, params) => execAll(db, sql, params),
    queryOne: (sql, params) => execOne(db, sql, params),
    ready: Promise.resolve(),
  };
  const win = { DB: dbStub };
  const doc = {
    readyState: 'loading',          // defers init() — no DOM needed
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => null, getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add() {}, toggle() {} },
      setAttribute() {}, appendChild() {}, addEventListener() {} }),
    body: { appendChild: () => {} },
  };
  const src = fs.readFileSync(path.join(ROOT, 'lookup.js'), 'utf8');
  const fn = new Function('window', 'document', 'DB',
    src + '\n;return window.Lookup;');
  _lookupReqCache = fn(win, doc, dbStub);
  return _lookupReqCache;
}

// PrC/class entry requirements ship in several shapes (Capitalized
// dict, lowercase/snake walked dict, labeled string, a `prerequisites`
// fallback). The string shapes used to render NOTHING in both the
// lookup modal and the class-picker info panel — the "walked-book PrC
// requirements don't show up" bug (2026-06-24).
//
// The CURE was build-side: normalize_schema.py now canonicalizes
// requirements to a Cap-keyed dict DB-wide, so string/snake shapes no
// longer exist in shipped data. The read-side renderer KEEPS its shape
// tolerance as defense-in-depth (homebrew / post-build entries can
// still be strings). This test verifies BOTH: every DB requirements
// renders, AND the renderer still tolerates a synthetic string input.
test('lookup: renderEntryRequirements renders every shape', (db) => {
  const L = loadLookupReqRenderer(db);
  assert(typeof L.renderEntryRequirements === 'function',
    'Lookup.renderEntryRequirements must be exported');
  // 1. Every prc/class entry that has requirements renders a block,
  //    with no raw-object leak. (Filter in JS — SQLite json1 is
  //    stricter than JS JSON.parse and throws on a few blobs.)
  const rows = execAll(db,
    "SELECT name, data FROM entry WHERE type IN ('prc','class')");
  let nReq = 0;
  for (const r of rows) {
    let d; try { d = JSON.parse(r.data || '{}'); } catch { continue; }
    const hasReq = (d.requirements && typeof d.requirements === 'object'
        && Object.keys(d.requirements).some(k => k[0] !== '_'
            && d.requirements[k] != null && d.requirements[k] !== ''))
      || (typeof d.requirements === 'string' && d.requirements.trim())
      || (typeof d.prerequisites === 'string' && d.prerequisites.trim());
    if (!hasReq) continue;
    nReq++;
    const html = L.renderEntryRequirements(d) || '';
    assert(html.includes('lookup-class-requirements'),
      `${r.name}: requirements should render a block`);
    assert(!html.includes('[object Object]'), `${r.name}: no raw object leak`);
  }
  assertGE(nReq, 300);
  // 2. Read-side tolerance is still in place: a synthetic string and a
  //    snake-keyed dict both render (defense-in-depth for homebrew /
  //    post-build entries the build-side canon never touched).
  const fromStr = L.renderEntryRequirements(
    { requirements: 'Alignment: Any lawful. Skills: Tumble 5 ranks. '
      + 'Feats: Dodge, Mobility.' }) || '';
  assert(/<b>Skills:<\/b>/.test(fromStr) && /lookup-see-also-pill/.test(fromStr),
    'renderer must still parse a labeled string into a pilled block');
  const fromSnake = L.renderEntryRequirements(
    { requirements: { base_attack_bonus: '+5', feats: 'Iron Will' } }) || '';
  assert(/<b>Base Attack Bonus:<\/b>/.test(fromSnake),
    'renderer must still pretty-label a snake-keyed dict');
});

test('lookup: requirements never leak snake_case labels', (db) => {
  const L = loadLookupReqRenderer(db);
  const rows = execAll(db,
    "SELECT name, data FROM entry WHERE type IN ('prc','class')");
  for (const r of rows) {
    let d; try { d = JSON.parse(r.data || '{}'); } catch { continue; }
    const html = L.renderEntryRequirements(d) || '';
    assert(!/<b>[a-z_]+_[a-z_]+:<\/b>/.test(html),
      `${r.name}: snake_case label leaked into output`);
  }
});

test('lookup: walked lowercase-dict requirements pretty-label + pillify feats', (db) => {
  const L = loadLookupReqRenderer(db);
  const r = execOne(db,
    "SELECT data FROM entry WHERE name='Leviathan Hunter' "
    + "AND type='prc' LIMIT 1");
  assert(r, 'Leviathan Hunter (Stormwrack walked PrC) should exist');
  const html = L.renderEntryRequirements(JSON.parse(r.data)) || '';
  assert(/<b>Base Attack Bonus:<\/b>/.test(html),
    'base_attack_bonus should render as "Base Attack Bonus:"');
  assert(/lookup-see-also-pill/.test(html), 'lowercase feats should pillify');
});

test('lookup: requirements falls back to prerequisites string field', (db) => {
  const L = loadLookupReqRenderer(db);
  const r = execOne(db,
    "SELECT data FROM entry WHERE name='Cerebrex' LIMIT 1");
  assert(r, 'Cerebrex (Dragon Compendium, prerequisites-only) should exist');
  const html = L.renderEntryRequirements(JSON.parse(r.data)) || '';
  assert(html.includes('lookup-class-requirements'),
    'prerequisites string should render when requirements is absent');
});

test('lookup: empty requirements dict renders nothing (no bare header)', (db) => {
  const L = loadLookupReqRenderer(db);
  const r = execOne(db,
    "SELECT data FROM entry WHERE name='Warlock' AND type='class' LIMIT 1");
  assert(r, 'Warlock base class should exist');
  const html = L.renderEntryRequirements(JSON.parse(r.data)) || '';
  assert(html.trim() === '',
    'base class with {} requirements must render no Requirements block');
});

// creature.spell_like_abilities canon is a structured list (2026-06-25),
// but two row shapes exist (per-ability + frequency-grouped) and a couple
// of misfiled entries are still strings. formatSLAs must render all three
// without leaking "[object Object]" (the bug the old formatValue path had).
test('lookup: formatSLAs renders both row shapes + string', (db) => {
  const L = loadLookupReqRenderer(db);
  assert(typeof L.formatSLAs === 'function', 'Lookup.formatSLAs exported');
  const perAbility = L.formatSLAs([
    { ability: 'aid', frequency: '3/day' },
    { ability: 'poison', frequency: '1/day', dc: 18 },
  ]);
  assert(/aid \(3\/day\)/.test(perAbility) && /poison \(1\/day, DC 18\)/.test(perAbility),
    'per-ability rows render ability (freq, DC)');
  const grouped = L.formatSLAs([
    { frequency: '1/day (CL 20th)', abilities: ['blasphemy (DC 23)', 'desecrate'] },
  ]);
  assert(/1\/day \(CL 20th\): blasphemy/.test(grouped),
    'grouped rows render freq: abilities');
  assert(L.formatSLAs('At will: obscuring mist') === 'At will: obscuring mist',
    'string passes through');
  // Canonical structured spell_likes keys (spell_name / save_dc_formula).
  const spellLikes = L.formatSLAs([
    { spell_name: 'confusion', frequency: '1/day', save_dc_formula: 'DC 16',
      caster_level_formula: 10 },
  ]);
  assert(/confusion \(1\/day, DC 16\)/.test(spellLikes),
    'spell_likes-shape rows render (spell_name + save_dc_formula)');
  assert(!/\[object Object\]/.test(perAbility + grouped + spellLikes),
    'no [object Object] leak');
});

// DB-wide: every structured spell_like_abilities renders cleanly.
test('lookup: DB spell_like_abilities all render without object leak', (db) => {
  const L = loadLookupReqRenderer(db);
  const rows = execAll(db, "SELECT name, data FROM entry WHERE type='creature'");
  let nStruct = 0;
  for (const r of rows) {
    let d; try { d = JSON.parse(r.data || '{}'); } catch { continue; }
    if (!d.spell_like_abilities) continue;
    const out = L.formatSLAs(d.spell_like_abilities);
    assert(!/\[object Object\]/.test(out), `${r.name}: SLA render leaked object`);
    if (Array.isArray(d.spell_like_abilities)) nStruct++;
  }
  assertGE(nStruct, 150);  // 200 structured today
});

// ---- tests: class-picker multiclass advancement metadata -----------------
//
// Failure modes these tests guard against (real bugs we hit in May 2026):
//
//   1. Sha'ir wasn't in SPELLCASTING_TYPE. A PrC that advances arcane
//      casting (e.g. Durthan) couldn't pick Sha'ir as a target, so the
//      Sha'ir's effective caster level was never bumped.
//   2. Durthan + Sand Shaper class_features describe casting advancement
//      in prose ("at each X level, gain spells per day as if leveling
//      in a previous arcane class") without the canonical "+1 level of
//      existing X spellcasting class" marker in class_table.special.
//      Source A regex in class-picker missed them, HARDCODED_ADVANCERS
//      didn't list them, so advancement was silently lost.

const CLASS_PICKER_SRC = fs.readFileSync(
  path.join(ROOT, 'class-picker.js'), 'utf8'
);
const LIVE_PUBLISH_SRC = fs.readFileSync(
  path.join(ROOT, 'live-publish.js'), 'utf8'
);

// ---- tests: schema-7 blast-rider discrimination --------------------------
//
// The one place the schema-7 publish GUESSES is BLAST_DICE_RE, which decides
// whether a special-abilities row is an additive rider on the eldritch blast.
// Everything else in that block reads the DOM.
//
// The first version of this regex accepted UNSIGNED dice, and running it over
// all 400 saved characters (rather than a fixture built from the one row that
// motivated it) showed it matching `[Warlock 9] Eldritch blast 5d6` — the
// character's BASE blast, stated in the special-abilities list. Publishing
// that as a rider means a consumer folding riders into damage computes
// 5d6 + 5d6 + 4d6 for a blast that is 9d6. Wrong, silently, mid-combat.
//
// The cases below are the real strings that broke it, kept as the guard.
test('live-publish: BLAST_DICE_RE separates additive riders from totals', () => {
  const m = /var BLAST_DICE_RE = (\/.*\/i);/.exec(LIVE_PUBLISH_SRC);
  assert(m, 'BLAST_DICE_RE not found in live-publish.js — did it get renamed?');
  const RE = eval(m[1]);

  // Must parse: a rider that ADDS, written the way the books write it.
  for (const [text, dice] of [
    ['[Hellfire Warlock 2] Hellfire blast +4d6', '+4d6'],
    ['[Hellfire Warlock 3] Hellfire blast +6d6', '+6d6'],
    ['Hellfire blast +2d6', '+2d6'],
  ]) {
    const r = RE.exec(text);
    assert(r, `expected a rider match for ${JSON.stringify(text)}`);
    assert(r[2].replace(/\s+/g, '') === dice,
      `expected dice ${dice} from ${JSON.stringify(text)}, got ${r[2]}`);
  }

  // Must NOT parse. The first four are TOTALS, not additions — the base blast
  // and unrelated "<x> blast" abilities on real saved characters.
  for (const text of [
    '[Warlock 9] Eldritch blast 5d6',
    'Eldritch Blast (1d6)',
    'Ice Blast (2d6 cold, DC 17)',
    'Mind Blast (DC 22)',
    'Sneak attack +2d6',
    '[Scout 1] Skirmish (+1d6)',
    'Hellrime Blast',
    '[Warlock 3] DR 1/cold iron',
  ]) {
    assert(!RE.exec(text),
      `${JSON.stringify(text)} must NOT parse as a blast rider, but it did`);
  }
});

// ---- tests: weapon → damage-calculator die seeding ------------------------
//
// report rmt4j1oxc-a89y. The item picker now seeds the damage calculator's die
// box when it adds a weapon. The only judgement in that path is calcDieFor,
// which decides when the DB's damage string IS a single die expression — so
// it is checked against the shapes the DB really holds, and against the DB
// itself, rather than against invented strings.
const ITEM_PICKER_SRC = fs.readFileSync(path.join(ROOT, 'item-picker.js'), 'utf8');

function loadCalcDieFor() {
  const m = /function calcDieFor\(damage\) \{[\s\S]*?\n    \}/.exec(ITEM_PICKER_SRC);
  assert(m, 'calcDieFor not found in item-picker.js — did it get renamed?');
  // Declare it inside the eval scope, then hand back the binding.
  return eval(`${m[0]}\ncalcDieFor;`);
}

test('item-picker: calcDieFor fills only unambiguous die expressions', () => {
  const calcDieFor = loadCalcDieFor();
  for (const [input, expected] of [
    ['1d8', '1d8'], ['2d4', '2d4'], ['d6', 'd6'],
    // Double weapon, both ends alike — one answer, so give it.
    ['1d6/1d6', '1d6'], ['1d8/1d8', '1d8'],
    // Double weapon, ends differ — WHICH end? Refuse rather than pick.
    ['1d8/1d6', null], ['1d6/1d4', null],
    // Not a die at all.
    ['1', null], ['', null], ['Smoke (see text)', null],
    ['2d6 (single stick; +1d6 per additional bound stick, max 10d6)', null],
  ]) {
    const got = calcDieFor(input);
    assert(got === expected,
      `calcDieFor(${JSON.stringify(input)}) = ${JSON.stringify(got)}, ` +
      `expected ${JSON.stringify(expected)}`);
  }
});

test('item-picker: calcDieFor never returns a non-die for any real weapon', (db) => {
  const calcDieFor = loadCalcDieFor();
  const rows = execAll(db,
    "SELECT name, json_extract(data, '$.damage_medium') AS dmg FROM entry " +
    "WHERE json_extract(data, '$.damage_medium') IS NOT NULL");
  assertGE(rows.length, 100, `expected 100+ weapons with damage, got ${rows.length}`);
  const bad = [];
  let filled = 0;
  for (const r of rows) {
    const got = calcDieFor(r.dmg);
    if (got == null) continue;
    filled++;
    // Whatever it returns must be a bare die expression — this is the
    // property that keeps a prose string out of a numeric box.
    if (!/^\d*d\d+$/i.test(got)) bad.push(`${r.name}: ${JSON.stringify(r.dmg)} -> ${JSON.stringify(got)}`);
  }
  assert(bad.length === 0,
    `calcDieFor returned a non-die for ${bad.length} weapon(s):\n  ` +
    bad.join('\n  '));
  assertGE(filled, rows.length * 0.8,
    `expected calcDieFor to fill 80%+ of real weapons, filled ${filled}/${rows.length}`);
});

// Pull the keys from HARDCODED_ADVANCERS and SPELLCASTING_TYPE without
// requiring class-picker.js as a module (it's an IIFE).
function extractObjectKeys(src, varName) {
  const re = new RegExp(
    `const\\s+${varName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\};`, 'm'
  );
  const m = src.match(re);
  if (!m) return new Set();
  // Capture every `"Name":` or `'Name':` key. Use alternation so keys
  // containing the opposite quote character (e.g. `"Sha'ir"`) match
  // correctly — a single character class can't handle both quote
  // styles simultaneously.
  const body = m[1];
  const keys = new Set();
  const keyRe = /(?:"([^"\n]+?)"|'([^'\n]+?)')\s*:/g;
  let km;
  while ((km = keyRe.exec(body)) !== null) keys.add(km[1] || km[2]);
  return keys;
}

const HARDCODED_ADVANCERS_KEYS = extractObjectKeys(
  CLASS_PICKER_SRC, '_FALLBACK_HARDCODED_ADVANCERS'
);
const SPELLCASTING_TYPE_KEYS = extractObjectKeys(
  CLASS_PICKER_SRC, '_FALLBACK_SPELLCASTING_TYPE'
);
const CASTER_STYLE_KEYS = extractObjectKeys(
  CLASS_PICKER_SRC, '_FALLBACK_CASTER_STYLE'
);
// The non-spell advancement pillars. The wiring audit below covers these
// too — it used to check the spell pillar only, which is how Hellfire
// Warlock stayed unwired while the suite ran green (2026-08-22).
const INVOCATION_ADVANCERS_KEYS = extractObjectKeys(
  CLASS_PICKER_SRC, '_FALLBACK_INVOCATION_ADVANCERS'
);
const MYSTERY_ADVANCERS_KEYS = extractObjectKeys(
  CLASS_PICKER_SRC, '_FALLBACK_MYSTERY_ADVANCERS'
);

// Extract `KEY: 'value'` pairs from an object literal in source. Returns
// a Map<keyName, valueString>. Used to verify CASTER_STYLE values
// against the DB descriptions.
function extractObjectMap(src, varName) {
  const re = new RegExp(
    `const\\s+${varName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\};`, 'm'
  );
  const m = src.match(re);
  if (!m) return new Map();
  const body = m[1];
  const map = new Map();
  // Match `"KEY": 'VALUE'` or `'KEY': "VALUE"` (single string value).
  const re2 = /(?:"([^"\n]+?)"|'([^'\n]+?)')\s*:\s*(?:"([^"\n]+?)"|'([^'\n]+?)')/g;
  let km;
  while ((km = re2.exec(body)) !== null) {
    const key = km[1] || km[2];
    const val = km[3] || km[4];
    map.set(key, val);
  }
  return map;
}

const CASTER_STYLE_MAP = extractObjectMap(CLASS_PICKER_SRC, '_FALLBACK_CASTER_STYLE');

test('class-picker: HARDCODED_ADVANCERS keys extracted from source', () => {
  // Sanity-check the extractor itself — if this fails the rest of the
  // class-picker tests are bogus.
  assertGE(HARDCODED_ADVANCERS_KEYS.size, 15,
    `expected >= 15 hardcoded advancers, got ${HARDCODED_ADVANCERS_KEYS.size}`);
  for (const known of ['Mystic Theurge', 'Archmage', 'Loremaster',
                       'Arcane Trickster', 'Durthan', 'Sand Shaper']) {
    assert(HARDCODED_ADVANCERS_KEYS.has(known),
      `HARDCODED_ADVANCERS should contain '${known}'`);
  }
});

test('class-picker: SPELLCASTING_TYPE keys extracted from source', () => {
  assertGE(SPELLCASTING_TYPE_KEYS.size, 20);
  for (const known of ['Wizard', 'Cleric', 'Psion', "Sha'ir"]) {
    assert(SPELLCASTING_TYPE_KEYS.has(known),
      `SPELLCASTING_TYPE should contain '${known}'`);
  }
});

// Test A: every PrC whose class_features prose mentions casting
// advancement language must be catchable by either the Source A regex
// (canonical marker in class_table.special) OR the HARDCODED_ADVANCERS
// list. Otherwise the picker silently drops the advancement when the
// PrC is applied alongside a spellcasting base class.
test('class-picker: every advancer PrC is wired (Source A regex or HARDCODED_ADVANCERS)', (db) => {
  const rows = execAll(db,
    "SELECT name, " +
    "json_extract(data, '$.class_features') AS features_json, " +
    "json_extract(data, '$.class_table')    AS table_json " +
    "FROM entry WHERE type = 'prc'");

  // Match "as if [pronoun] gained a level" — historical pattern that
  // misses "as if she HAD also gained a level" (the canonical PHB
  // phrasing used by Eldritch Knight + 38 others). The stricter
  // version of this regex lives in test_class_audit.js as a separate
  // audit that REPORTS the misses without failing this smoke test;
  // wiring all 39 is a multi-commit triage effort.
  const ADVANCE_VERB = new RegExp(
    'as if (?:had |she |he |you |they )?(?:also )?gained? a level' +
    '|as if leveling in' +
    '|advances? (?:your |her |his )?(?:arcane|divine|psionic|spellcasting)' +
    '|\\+\\s*1\\s*level\\s+of\\s+(?:your\\s+|her\\s+|his\\s+)?existing',
    'i'
  );
  const SPELL_NOUN = new RegExp(
    'spells per day|caster level|spells known|spellcasting class' +
    '|spellcasting ability|manifester level|powers known|power points',
    'i'
  );
  // The canonical marker the class-picker's Source A scans for.
  const CANONICAL_MARKER = new RegExp(
    '\\+\\s*1\\s*level\\s+of\\s+existing\\s+' +
    '(?:arcane|divine|manifesting|psionic)\\s+' +
    '(?:spellcasting|manifesting)?\\s*class',
    'i'
  );

  const missed = [];
  for (const r of rows) {
    let features = [];
    try { features = JSON.parse(r.features_json || '[]'); } catch (e) {}
    const text = features.map(f =>
      (f.name || '') + ' ' + (f.description || '')
    ).join(' ');
    const looksLikeAdvancer = ADVANCE_VERB.test(text) && SPELL_NOUN.test(text);
    if (!looksLikeAdvancer) continue;

    let table = [];
    try { table = JSON.parse(r.table_json || '[]'); } catch (e) {}
    const tableSpecials = table.map(t => t.special || '').join(' ');
    const hasCanonical = CANONICAL_MARKER.test(tableSpecials);

    if (hasCanonical) continue;                            // Source A catches it
    if (HARDCODED_ADVANCERS_KEYS.has(r.name)) continue;    // Source B catches it
    missed.push(r.name);
  }

  assert(missed.length === 0,
    `${missed.length} PrC(s) describe spell-advancement in their ` +
    `class_features prose but aren't wired into class-picker:\n  ` +
    missed.sort().join('\n  ') +
    `\nFix: either add the canonical "+1 level of existing X spellcasting ` +
    `class" marker to that PrC's class_table.special at the DB level ` +
    `(preferred), or register the PrC in HARDCODED_ADVANCERS in ` +
    `class-picker.js.`);
});

// The same audit for the INVOCATION and MYSTERY pillars, which the one
// above cannot see. Added 2026-08-22, after Hellfire Warlock turned out to
// be unwired while the suite ran 348-green.
//
// It needed to be a separate test rather than a widening, because the audit
// above misses this class of PrC in FOUR independent ways and each fix would
// have collateral:
//
//   1. it reads `class_table.special`; Hellfire Warlock's advancement text
//      lives in `class_table.spells_per_day`
//   2. CANONICAL_MARKER's vocabulary is arcane|divine|manifesting|psionic;
//      the text says "existing INVOKING class"
//   3. SPELL_NOUN has "spells known" but not "invocations known" /
//      "invoker level"
//   4. ADVANCE_VERB allows exactly ONE token after "as if" — so it matches
//      "as if she gained a level" but NOT "as if you HAD also gained a
//      level", which is what the Invoking feature actually says
//
// Loosening (4) in place would surface the 39-PrC spell-pillar backlog the
// test above deliberately defers, turning one real bug into a red suite
// nobody can land. So: narrow scope, correct vocabulary, real assertion.
test('class-picker: every invocation/mystery advancer PrC is wired', (db) => {
  const rows = execAll(db,
    "SELECT name, " +
    "json_extract(data, '$.class_table')            AS table_json, " +
    "json_extract(data, '$.class_features')         AS features_json, " +
    "json_extract(data, '$.invocation_advancement') AS inv_adv, " +
    "json_extract(data, '$.mystery_advancement')    AS myst_adv " +
    "FROM entry WHERE type = 'prc'");

  // Deliberately permissive about what follows "as if" — this is the
  // fix for miss (4), scoped to the two pillars so it cannot resurface
  // the spell-pillar backlog.
  const ADVANCE_VERB = new RegExp(
    'as if (?:(?:you|she|he|they|it) )?(?:had )?(?:also )?gained? a level' +
    '|as if leveling in' +
    '|\\+\\s*1\\s*level\\s+of\\s+(?:your\\s+|her\\s+|his\\s+)?existing' +
    '|advances? (?:your |her |his )?(?:invocation|mystery|shadowcast)',
    'i'
  );
  const INVOCATION_NOUN =
    /existing invoking|invoking class|invocations? known|invoker level/i;
  const MYSTERY_NOUN =
    /existing (?:shadowcasting|mystery)|mysteries known|mystery level/i;

  const missed = [];
  for (const r of rows) {
    let features = [], table = [];
    try { features = JSON.parse(r.features_json || '[]'); } catch (e) {}
    try { table = JSON.parse(r.table_json || '[]'); } catch (e) {}
    // The WHOLE table, every column — not `.special` alone. That single
    // choice is miss (1), and it is the one that would silently recur.
    const text = features.map(f => (f.name || '') + ' ' + (f.description || ''))
      .join(' ') + ' ' + JSON.stringify(table);

    if (!ADVANCE_VERB.test(text)) continue;

    if (INVOCATION_NOUN.test(text) &&
        r.inv_adv == null && !INVOCATION_ADVANCERS_KEYS.has(r.name)) {
      missed.push(`${r.name} (invocation pillar)`);
    }
    if (MYSTERY_NOUN.test(text) &&
        r.myst_adv == null && !MYSTERY_ADVANCERS_KEYS.has(r.name)) {
      missed.push(`${r.name} (mystery pillar)`);
    }
  }

  assert(missed.length === 0,
    `${missed.length} PrC(s) advance the invocation/mystery pillar but ` +
    `aren't wired:\n  ` + missed.sort().join('\n  ') +
    `\nFix: add the PrC to INVOCATION_ADVANCEMENT_METADATA / ` +
    `MYSTERY_ADVANCEMENT_METADATA in the DB project's _class_metadata.py ` +
    `and rebuild (preferred), or register it in ` +
    `_FALLBACK_INVOCATION_ADVANCERS / _FALLBACK_MYSTERY_ADVANCERS in ` +
    `class-picker.js.`);
});

// Test 2b: every arcane/divine class in SPELLCASTING_TYPE must also have
// a CASTER_STYLE classification. Ultimate Magus (and any future PrC
// that requires specific styles) keys on this. Psionic classes are
// excluded — UM doesn't advance psionics and "prepared/spontaneous"
// doesn't map cleanly onto power-point manifesting.
test('class-picker: every arcane/divine caster in SPELLCASTING_TYPE has a CASTER_STYLE', () => {
  // SPELLCASTING_TYPE values can be 'arcane' / 'divine' / 'psionic' or
  // an array. Re-extract value text from source so we can filter.
  const typeMap = extractObjectMap(CLASS_PICKER_SRC, '_FALLBACK_SPELLCASTING_TYPE');
  // Plus array-valued entries (Sha'ir = ['arcane','divine']).
  const arrRe = /(?:"([^"\n]+?)"|'([^'\n]+?)')\s*:\s*\[([^\]]*)\]/g;
  const typeMatch = CLASS_PICKER_SRC.match(
    /const\s+SPELLCASTING_TYPE\s*=\s*\{([\s\S]*?)\n\s*\};/m
  );
  const typeBody = typeMatch ? typeMatch[1] : '';
  let am;
  while ((am = arrRe.exec(typeBody)) !== null) {
    const key = am[1] || am[2];
    const arrText = am[3].toLowerCase();
    // Any of arcane/divine in the array → key is arcane/divine.
    if (/arcane|divine/.test(arrText)) typeMap.set(key, 'arcane');
  }

  const missing = [];
  for (const [className, type] of typeMap.entries()) {
    if (type === 'psionic') continue;
    if (!CASTER_STYLE_KEYS.has(className)) missing.push(className);
  }
  assert(missing.length === 0,
    `${missing.length} arcane/divine class(es) in SPELLCASTING_TYPE ` +
    `lack a CASTER_STYLE classification:\n  ` +
    missing.sort().join('\n  ') +
    `\nFix: add each to CASTER_STYLE in class-picker.js as either ` +
    `'prepared' or 'spontaneous'. Ultimate Magus (and any future PrC ` +
    `requiring specific casting styles) keys on this map to pick ` +
    `eligible targets.`);
});

// Test 2c: hand-coded CASTER_STYLE values must match what each class's
// own class_features description says. Catches drift if the DB updates
// or if a hand-edit got the wrong style. Heuristic — checks the
// "Spells" / "Spellcasting" feature text for prep/spont markers.
test('class-picker: CASTER_STYLE values match DB class_features descriptions', (db) => {
  // Some classes are intentionally hand-overridden — list here.
  const OVERRIDES = new Set([
    "Sha'ir",        // gen-fetched; rules-ambiguous, hand-pinned to prepared
    "Shugenja",      // corpus-confirmed SPONTANEOUS ("cast any spell he knows without
                     // preparing it"); the "the way a wizard or a cleric must" contrast
                     // phrasing trips the prepared-regex. CDiv walk 2026-07-11.
  ]);
  const mismatches = [];
  for (const [className, style] of CASTER_STYLE_MAP.entries()) {
    if (OVERRIDES.has(className)) continue;
    const row = execOne(db,
      "SELECT json_extract(data, '$.class_features') AS f " +
      "FROM entry WHERE name = ? AND type = 'class' LIMIT 1",
      [className]);
    if (!row || !row.f) continue;  // Class not in DB — skip
    let features = [];
    try { features = JSON.parse(row.f); } catch (e) { continue; }
    const spellFeat = features.find(f =>
      /^Spell(s|casting|book|s and )/i.test(f.name || ''));
    if (!spellFeat) continue;
    const desc = (spellFeat.description || '').toLowerCase();
    if (!desc) continue;
    // Decision tree mirroring how a player would read the rules:
    let dbStyle = null;
    if (/cast(s|ing)?\s+(\w+\s+)*spell(s)?\s+spontaneously|spontaneous(ly)?\s+(arcane|divine)/i.test(desc)) {
      dbStyle = 'spontaneous';
    } else if (/prepared|spellbook|prayerbook|prepare(d)?\s+in\s+advance/i.test(desc)) {
      dbStyle = 'prepared';
    } else if (/cast\s+any\s+spell\s+(she|he|they)\s+know(s)?\s+without\s+preparation/i.test(desc)) {
      dbStyle = 'spontaneous';
    }
    if (!dbStyle) continue;  // Description ambiguous — skip
    if (dbStyle !== style) {
      mismatches.push(`${className}: hand-coded '${style}' but DB says '${dbStyle}'`);
    }
  }
  assert(mismatches.length === 0,
    `CASTER_STYLE values disagree with DB descriptions:\n  ` +
    mismatches.join('\n  ') +
    `\nFix: either correct the hand-coded value in class-picker.js, ` +
    `or add the class to the OVERRIDES set in this test if the ` +
    `mismatch is intentional.`);
});

// Test B: every base class that looks like a spellcaster — by any of
// the data-shape heuristics — must be in SPELLCASTING_TYPE. Otherwise
// an advancing PrC applied alongside it can't pick it as a target.
test('class-picker: every base spellcaster class is in SPELLCASTING_TYPE', (db) => {
  const rows = execAll(db,
    "SELECT name, " +
    "json_extract(data, '$.class_table') AS table_json, " +
    "data AS data_json " +
    "FROM entry WHERE type = 'class'");

  // Heuristics: a class "looks like a spellcaster" if its data shape
  // shows any spell-progression evidence. Heterogeneous because the
  // manual-extraction schema isn't fully normalized — different books
  // encode it differently.
  // A "non-trivial" value: not null, not empty string / array / object,
  // not a placeholder dash. Many non-caster classes (Knight, Thug,
  // Swashbuckler, Generic Warrior) carry the schema keys with `null`
  // values — those should NOT count as evidence of spellcasting.
  function nonTrivial(v) {
    if (v == null) return false;
    if (typeof v === 'string') {
      const s = v.trim();
      return s !== '' && s !== '—' && s !== '-';
    }
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true;
  }
  function looksLikeSpellcaster(row) {
    let table = [];
    try { table = JSON.parse(row.table_json || '[]'); } catch (e) {}
    for (const t of table) {
      for (const k of ['spells_per_day', 'spells_known',
                       'power_points', 'powers_known', 'max_power_level']) {
        if (nonTrivial(t[k])) return true;
      }
    }
    let data = {};
    try { data = JSON.parse(row.data_json || '{}'); } catch (e) {}
    for (const [k, v] of Object.entries(data)) {
      if (!nonTrivial(v)) continue;
      if (/^(spell|spells)_(per_day|known)(_table)?$/i.test(k)) return true;
      if (/^(.+_)?spell_list$/i.test(k)) return true;
      if (/^power_list$|^power_points$|^manifesting/i.test(k)) return true;
      if (/^spell_access_rules$/i.test(k)) return true;
    }
    return false;
  }

  // Classes we DELIBERATELY exclude from the check — they have
  // spell-related data but aren't valid advancement targets:
  //   - "Generic Spellcaster": UA placeholder, not a real class.
  //   - "Kobold Paragon" (Races of the Dragon): its "Spells Per Day"
  //     column reads "+1 sorcerer level" — sorcerer-casting ADVANCEMENT
  //     notation, not a native spell progression. KP is an advancer, not
  //     a native caster, so it's correctly absent from SPELLCASTING_TYPE
  //     (no native panel: ensureCasterTab keys on the numeric table,
  //     which the string value doesn't produce).
  const EXCLUDE = new Set(['Generic Spellcaster', 'Kobold Paragon']);

  const missing = [];
  for (const r of rows) {
    if (EXCLUDE.has(r.name)) continue;
    if (!looksLikeSpellcaster(r)) continue;
    if (SPELLCASTING_TYPE_KEYS.has(r.name)) continue;
    missing.push(r.name);
  }

  assert(missing.length === 0,
    `${missing.length} base class(es) look like spellcasters but ` +
    `aren't in SPELLCASTING_TYPE:\n  ` +
    missing.sort().join('\n  ') +
    `\nFix: add each to SPELLCASTING_TYPE in class-picker.js with the ` +
    `right type ('arcane' / 'divine' / 'psionic'). PrCs that advance ` +
    `that type can then target the class.`);
});

// ---- tests: spell-adjacent subsystem sub-tab wiring ----------------------
//
// Beyond native spellcasting, the Spells tab hosts sub-tabs for the
// spell-adjacent subsystems: psionics, maneuvers, invocations (Warlock),
// vestige binding (Binder), and shadowcasting (Shadowcaster).
// ensureCasterTab auto-creates the right sub-tab when a class that uses
// one of these is applied; removeClass tears it down. These guards keep
// every such base class wired and the create/teardown sets in sync — a
// future book that adds a new invocation/vestige/mystery base class must
// register it, or this fails.

// Extract the string items of a `const NAME = new Set([ '…', '…' ])`
// literal from source. Parallels extractObjectKeys (which handles object
// literals); the subsystem class lists are Sets, not objects.
function extractSetItems(src, varName) {
  const re = new RegExp(
    `const\\s+${varName}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`, 'm');
  const m = src.match(re);
  if (!m) return new Set();
  const items = new Set();
  const itemRe = /(?:"([^"\n]+?)"|'([^'\n]+?)')/g;
  let im;
  while ((im = itemRe.exec(m[1])) !== null) items.add(im[1] || im[2]);
  return items;
}

const INVOCATION_USING_KEYS = extractSetItems(CLASS_PICKER_SRC, 'INVOCATION_USING_CLASSES');
const VESTIGE_USING_KEYS    = extractSetItems(CLASS_PICKER_SRC, 'VESTIGE_USING_CLASSES');
const MYSTERY_USING_KEYS    = extractSetItems(CLASS_PICKER_SRC, 'MYSTERY_USING_CLASSES');

test('class-picker: subsystem class sets contain the canonical base classes', () => {
  assert(INVOCATION_USING_KEYS.has('Warlock'),
    'INVOCATION_USING_CLASSES should contain Warlock');
  assert(VESTIGE_USING_KEYS.has('Binder'),
    'VESTIGE_USING_CLASSES should contain Binder');
  assert(MYSTERY_USING_KEYS.has('Shadowcaster'),
    'MYSTERY_USING_CLASSES should contain Shadowcaster');
});

test('class-picker: ensureCasterTab wires every spell-adjacent subsystem', () => {
  const src = CLASS_PICKER_SRC;
  // The three subsystems added 2026-06-07. Each must map its class-set
  // guard to an ensureSimpleCasterTab call of the right sub-tab type.
  for (const [set, type] of [
    ['INVOCATION_USING_CLASSES', 'invocations'],
    ['VESTIGE_USING_CLASSES',    'binding'],
    ['MYSTERY_USING_CLASSES',    'shadowcaster'],
  ]) {
    const re = new RegExp(
      `${set}\\.has\\(className\\)[\\s\\S]{0,260}?ensureSimpleCasterTab\\(\\s*'${type}'`);
    assert(re.test(src),
      `ensureCasterTab must route ${set} → ensureSimpleCasterTab('${type}', …)`);
  }
});

test('class-picker: removeClass tears down every auto-created sub-tab type', () => {
  // The teardown loop must list every type ensureCasterTab can create,
  // or removing the class orphans its tab (stray Invocations/Binding/
  // Shadowcasting tab). Pull the array literal that drives the teardown.
  const m = CLASS_PICKER_SRC.match(
    /Remove this class's spells tab[\s\S]*?for \(const type of \[([\s\S]*?)\]\)/);
  assert(m, 'removeClass teardown loop not found');
  const listed = new Set();
  const itemRe = /'([^']+)'/g;
  let im;
  while ((im = itemRe.exec(m[1])) !== null) listed.add(im[1]);
  for (const type of ['spellcasting', 'psionics', 'maneuvers',
                      'invocations', 'binding', 'shadowcaster']) {
    assert(listed.has(type),
      `removeClass teardown list missing '${type}' — removing such a ` +
      `class would orphan its Spells sub-tab.`);
  }
});

// DB-driven: every base class whose data signals a spell-adjacent
// subsystem must be registered in the corresponding class set. Mirrors
// the "every base spellcaster is in SPELLCASTING_TYPE" audit — catches a
// future book adding e.g. a second invocation-using base class that's
// left unwired (it would silently get no Spells sub-tab on apply).
test('class-picker: every invocation/vestige/mystery base class is wired', (db) => {
  const rows = execAll(db,
    "SELECT name, data FROM entry WHERE type = 'class'");
  const signals = [
    { set: INVOCATION_USING_KEYS, label: 'INVOCATION_USING_CLASSES',
      test: (l) => /eldritch blast|least invocation|invocations known/.test(l) },
    { set: VESTIGE_USING_KEYS, label: 'VESTIGE_USING_CLASSES',
      test: (l) => /bind a vestige|vestiges bound|max_vestige_level|soul binding/.test(l) },
    { set: MYSTERY_USING_KEYS, label: 'MYSTERY_USING_CLASSES',
      test: (l) => /mysteries known|apprentice mysteries|fundamental of shadow/.test(l) },
  ];
  const missing = [];
  for (const r of rows) {
    const low = (r.data || '').toLowerCase();
    for (const sig of signals) {
      if (sig.test(low) && !sig.set.has(r.name)) {
        missing.push(`${r.name} → ${sig.label}`);
      }
    }
  }
  assert(missing.length === 0,
    `${missing.length} base class(es) signal a spell-adjacent subsystem ` +
    `but aren't registered in the matching set:\n  ` +
    missing.sort().join('\n  ') +
    `\nFix: add each to the named Set in class-picker.js so ensureCasterTab ` +
    `creates its Spells sub-tab on apply (and removeClass tears it down).`);
});

// ---- tests: incarnum soulmeld-count auto-fill ----------------------------
//
// Incarnum meldshapers (Totemist/Incarnate/Soulborn) have no Spells
// sub-tab — soulmelds live on the Equipment tab — but applyClass copies
// their per-level {soulmelds, essentia, chakra_binds} into the Equipment
// counter fields. Guard the set + the wiring + completeness.

const INCARNUM_KEYS = extractSetItems(CLASS_PICKER_SRC, 'INCARNUM_CLASSES');

test('class-picker: INCARNUM_CLASSES contains the meldshaper base classes', () => {
  for (const known of ['Totemist', 'Incarnate', 'Soulborn']) {
    assert(INCARNUM_KEYS.has(known),
      `INCARNUM_CLASSES should contain '${known}'`);
  }
});

test('class-picker: applyClass copies incarnum counts to the Equipment tab', () => {
  const src = CLASS_PICKER_SRC;
  // applyClass must invoke populateIncarnumCounts for incarnum classes,
  // and the populator must target the three Equipment soulmeld inputs.
  assert(/INCARNUM_CLASSES\.has\([^)]*\)[\s\S]{0,120}?populateIncarnumCounts\(/.test(src),
    'applyClass must call populateIncarnumCounts for INCARNUM_CLASSES');
  for (const id of ['#sm-max-soulmelds', '#sm-max-essentia', '#sm-max-binds']) {
    assert(src.includes(id),
      `populateIncarnumCounts must write the Equipment field ${id}`);
  }
});

// DB-driven completeness: every base class whose class_table carries a
// `soulmelds` column is a meldshaper and must be registered, or its
// soulmeld numbers silently won't reach the Equipment tab on apply.
test('class-picker: every meldshaper base class is in INCARNUM_CLASSES', (db) => {
  const rows = execAll(db, "SELECT name, data FROM entry WHERE type = 'class'");
  const missing = [];
  for (const r of rows) {
    // The incarnum column key, unambiguous in the class_table JSON.
    if (/"soulmelds"\s*:/.test(r.data || '') && !INCARNUM_KEYS.has(r.name)) {
      missing.push(r.name);
    }
  }
  assert(missing.length === 0,
    `${missing.length} class(es) carry a soulmelds column but aren't in ` +
    `INCARNUM_CLASSES:\n  ` + missing.sort().join('\n  ') +
    `\nFix: add each to INCARNUM_CLASSES in class-picker.js.`);
});

// ---- tests: soulmeld granted effects + granted attacks ------------------
//
// The half of incarnum that is NOT a number (2026-08-21). Roughly half of
// every soulmeld's printed text grants an ABILITY rather than a bonus, and for
// a day those 198 authored notes were stamped onto nothing — they reached
// neither the DB nor the sheet, while every soulmeld test stayed green. These
// guard both halves of that: the data is in the blob, and the sheet routes it.

test('soulmeld granted: the data reached the deployed blob', (db) => {
  const rows = execAll(db,
    "SELECT name, json_extract(data, '$.granted_effects') AS g "
    + "FROM entry WHERE type = 'soulmeld' "
    + "AND json_extract(data, '$.granted_effects') IS NOT NULL");
  assertGE(rows.length, 85, 'granted_effects stamped on the soulmelds');
  let attacks = 0;
  for (const r of rows) {
    const items = JSON.parse(r.g || '[]');
    for (const it of items) {
      assert(it.text && it.kind,
        `${r.name}: granted item missing text/kind — ${JSON.stringify(it)}`);
      assert(it.when === 'shaped' || it.when === 'bound',
        `${r.name}: bad when ${it.when}`);
      // A bound item must name the bind it came from, or the sheet cannot
      // tell a Throat bind's breath weapon from a Totem bind's bite.
      if (it.when === 'bound') {
        assert(it.chakra, `${r.name}: bound granted item with no chakra`);
      }
      if (it.kind === 'attack') attacks++;
    }
  }
  assertGE(attacks, 30, 'granted ATTACKS are the headline case');
});

test('soulmeld granted: every attack can fill an attack row', (db) => {
  const rows = execAll(db,
    "SELECT name, json_extract(data, '$.granted_effects') AS g "
    + "FROM entry WHERE type = 'soulmeld' "
    + "AND json_extract(data, '$.granted_effects') IS NOT NULL");
  const bad = [];
  for (const r of rows) {
    for (const it of JSON.parse(r.g || '[]')) {
      if (it.kind !== 'attack') continue;
      const a = it.attack || {};
      if (!a.name) { bad.push(`${r.name}: unnamed attack`); continue; }
      // Damage in SOME form, or an explicit statement of why there is none.
      // A row the sheet cannot put a number in is worse than no row, because
      // it looks like it worked.
      const hasDamage = a.dice || a.dice_by_size || a.dice_per_essentia
        || a.damage_as || a.damage_kind;
      if (!hasDamage) bad.push(`${r.name}/${a.name}: states no damage`);
      // primary_or_secondary is the book's own either/or and its Strength
      // multiplier is not knowable until the player picks, so it must not
      // carry one.
      if (a.role === 'primary_or_secondary' && a.ability_mult != null) {
        bad.push(`${r.name}/${a.name}: either-or attack fixes ability_mult`);
      }
    }
  }
  assert(bad.length === 0, bad.slice(0, 4).join('; '));
});

test('soulmeld granted: Kruthik Claws is wired end to end', (db) => {
  // The worked example. Its totem bind grants two 1d6 claws plus Strength,
  // with 1d4 acid PER POINT of essentia on each — which exercises the count,
  // the ability term, and a per-essentia rider in one entry.
  const row = execOne(db,
    "SELECT json_extract(data, '$.granted_effects') AS g "
    + "FROM entry WHERE type = 'soulmeld' AND name = 'Kruthik Claws'");
  const items = JSON.parse(row.g || '[]');
  const claw = items.find(i => i.kind === 'attack');
  assert(claw, 'Kruthik Claws grants an attack');
  assertEq(claw.chakra, 'Totem');
  assertEq(claw.attack.dice, '1d6');
  assertEq(claw.attack.count, 2);
  assertEq(claw.attack.ability, 'Str');
  const rider = (claw.attack.riders || [])[0];
  assert(rider && rider.dice === '1d4' && rider.per_essentia === true
         && rider.damage_type === 'acid',
    `expected a per-essentia 1d4 acid rider, got ${JSON.stringify(rider)}`);
  // ...and its hands bind grants a real feat, by a name the DB resolves.
  const feat = items.find(i => i.kind === 'feat');
  assert(feat && feat.feat === 'Weapon Finesse', 'hands bind grants Weapon Finesse');
  const f = execOne(db,
    "SELECT name FROM entry WHERE type='feat' AND name = 'Weapon Finesse'");
  assert(f, 'the granted feat name resolves to a real feat');
});

test('soulmeld granted: the sheet routes each kind somewhere', () => {
  const src = readSource('soulmeld-effects.js');
  assert(/granted_effects/.test(src),
    'soulmeld-effects must read granted_effects from the DB');
  // The bind gate is SHARED with the bonus rows. Two copies would drift the
  // moment one of them learned something the other did not.
  assert(/function inForce\(/.test(src)
    && (src.match(/inForce\(/g) || []).length >= 3,
    'the shaped/bound gate must be one shared helper, used by both paths');
  for (const fn of ['grantedAttacks', 'grantedFeats', 'grantedSpecials',
                    'grantedSenses', 'grantedMovement']) {
    assert(new RegExp(`function ${fn}\\(`).test(src),
      `soulmeld-effects must expose ${fn}`);
  }
  // Each destination is actually wired, not merely computed.
  assert(/syncGrantedAttacks\(\)/.test(src) && /syncGrantedFeats\(\)/.test(src),
    'granted attacks and feats must be pushed from refreshAll');
  assert(/grantedSenses/.test(readSource('senses.js')),
    'senses.js must consume the non-numeric granted senses');
  assert(/grantedMovement\(\)/.test(src),
    'granted movement must reach getActiveSpeedBonuses');
  assert(/grantedEffects/.test(readSource('live-publish.js')),
    'the live bus must publish granted abilities');
});

test('soulmeld granted: attack rows are namespaced and never overwrite', () => {
  const src = readSource('soulmeld-effects.js');
  // The key must be namespaced, or a soulmeld row and a class row (the
  // Warlock's eldritch blast) could collide over the same managed row.
  assert(/ATTACK_PREFIX\s*=\s*'soulmeld:'/.test(src),
    'granted attack rows must use a namespaced key');
  const csrc = readSource('character.js');
  // The hand-edit handover is what makes this safe against the attack rows
  // already sitting in saved characters: one trusted edit and the row is the
  // player's forever. It MARKS the row rather than erasing its key — erasing
  // made the row unrecognisable, so the next sync saw the attack as missing
  // and created a second identical one (reported on Gorrash 2026-08-21).
  assert(/ev\.isTrusted[\s\S]{0,80}dataset\.playerOwned\s*=/.test(csrc),
    'a hand-edit must MARK a managed attack row as owned by the player');
  assert(!/ev\.isTrusted[\s\S]{0,80}delete\s+div\.dataset\.fromClass/.test(csrc),
    'the handover must not erase the key — that is what caused duplicates');
  // ...and an owned row is neither overwritten nor removed.
  assert(/if \(row\.dataset\.playerOwned\) return row;/.test(csrc),
    'an owned attack row must never have its fields rewritten');
  assert(/if \(row && !row\.dataset\.playerOwned\) row\.remove\(\);/.test(csrc),
    'losing the source must not delete a row the player has taken over');
  // The marker has to survive a reload, or the handover expires every time
  // the sheet is opened.
  assert(/playerOwned:\s*entry\.dataset\.playerOwned/.test(csrc),
    'the ownership marker must round-trip through save/load');
});

test('soulmeld: conditional attack/damage rows never reach a weapon total', () => {
  // resolve() has always marked a conditional row routed:false ("in no
  // total"), but getWeaponMods summed them anyway — so Rageclaws' "+2 morale
  // while your hit point total is below 0" was in the character's ordinary
  // attack bonus at full health, and Bloodtalons' "+1 per essentia WITH THE
  // BLOODTALONS CLAW ATTACKS" landed on every other natural weapon.
  const src = readSource('soulmeld-effects.js');
  const fn = src.slice(src.indexOf('function getWeaponMods'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert(/if \(e\.condition\)/.test(body),
    'getWeaponMods must skip conditional rows rather than summing them');
  assert(/situational/.test(body),
    'a skipped conditional must be surfaced, not silently dropped');
});

test('save: soulmeld-granted feat rows are derived, never persisted', () => {
  // Same contract as bloodline bonus feats. Persisting them would freeze a
  // bind the player may since have moved, and the row would outlive unshaping
  // the soulmeld entirely.
  const src = readSource('feats.js');
  const collect = src.slice(src.indexOf('data.feats = []'),
                            src.indexOf('data.languages'));
  assertEq((collect.match(/fromSoulmeld/g) || []).length, 2,
    'both the feat and special-ability collectors must skip derived '
    + 'soulmeld rows');
});

// ---- tests: DB-side class metadata merge ---------------------------------
//
// Centralized 2026-05-15 from class-picker.js hand-coded maps into
// `_class_metadata.py` (DB project), merged into `entry.data` at build
// time. These tests assert the merge actually fired on the rebuilt DB
// — the JS picker reads these fields via getClassType / getCasterStyle
// / getAdvancementSpec and falls back to the in-source maps only if
// the merge is missing.

test('class metadata: spellcasting.class_type populated for spellcaster classes', (db) => {
  // Every base class that's in the JS fallback must also have
  // spellcasting.class_type set in the DB, because the build merge
  // should have stamped it.
  const fallbackKeys = SPELLCASTING_TYPE_KEYS;
  const placeholders = [...fallbackKeys].map(() => '?').join(',');
  const rows = execAll(db,
    `SELECT name, ` +
    `json_extract(data, '$.spellcasting.class_type') AS ct ` +
    `FROM entry WHERE type = 'class' AND name IN (${placeholders})`,
    [...fallbackKeys]);
  const missing = rows.filter(r => r.ct == null).map(r => r.name);
  assert(missing.length === 0,
    `${missing.length} class(es) listed in the JS fallback have no ` +
    `spellcasting.class_type in the DB:\n  ${missing.join('\n  ')}\n` +
    `This means the build merge in _class_metadata.py didn't fire ` +
    `for those names. Check the canonical entry name in the DB ` +
    `matches the SPELLCASTING_METADATA dict key (case-sensitive).`);
});

test('class metadata: advancement spec populated for parser-missed advancer PrCs', (db) => {
  // Every PrC in the JS fallback that needs explicit advancement
  // metadata (i.e. its class_table.special doesn't contain the
  // canonical marker) should have entry.data.advancement set in the
  // DB. This catches the case where _class_metadata.ADVANCEMENT_METADATA
  // is missing an entry that the JS fallback still carries.
  const placeholders = [...HARDCODED_ADVANCERS_KEYS]
    .map(() => '?').join(',');
  const rows = execAll(db,
    `SELECT name, ` +
    `json_extract(data, '$.advancement') AS adv ` +
    `FROM entry WHERE type = 'prc' AND name IN (${placeholders})`,
    [...HARDCODED_ADVANCERS_KEYS]);
  const missing = rows.filter(r => r.adv == null).map(r => r.name);
  assert(missing.length === 0,
    `${missing.length} PrC(s) in the JS fallback have no advancement ` +
    `spec in the DB:\n  ${missing.join('\n  ')}\n` +
    `Add them to ADVANCEMENT_METADATA in _class_metadata.py and ` +
    `rebuild the DB.`);
});

// The inverse guard: advancement metadata (spell / maneuver / invocation /
// mystery pillars) describes a PRESTIGE class advancing some base class's
// progression — it is PrC-only by definition. A BASE class (type='class')
// advances no one, so it must never be consumed as an advancer. The DB
// metadata generator mis-tagged three base classes with an arcane
// `advancement` block (Dragonfire Adept / Prestige Bard / Prestige Paladin),
// which made the picker warn "no <type> class to advance" the moment one was
// selected. loadDbMetadata() neutralizes this by dropping the advancement
// pillars for type='class' rows. This guards both halves: the source fix is
// wired, and no NEW base class has quietly acquired an advancement block.
test('class-picker: base-class spell advancement is an explicit allowlist (else PrC-only)', (db) => {
  const src = CLASS_PICKER_SRC;
  // (1) loadDbMetadata must pull the entry type so it can tell base from PrC.
  assert(/SELECT name,\s*type AS entry_type/.test(src),
    'loadDbMetadata must SELECT `type AS entry_type` to distinguish base ' +
    'classes from PrCs');
  // (2) Base classes never advance maneuvers/invocations/mysteries, and never
  // advance SPELLS either — EXCEPT an explicit allowlist (the UA caster-race
  // racial paragons genuinely advance the character's casting at their 2nd/3rd
  // levels, book-verified). Everything else mis-tagged onto a base class is dropped.
  assert(src.includes("r.entry_type === 'class'"),
    'loadDbMetadata must branch on a base-class check (r.entry_type === "class")');
  assert(/madv\s*=\s*iadv\s*=\s*mystadv\s*=\s*null/.test(src),
    'base classes must null the maneuver/invocation/mystery pillars');
  assert(/BASE_CLASS_SPELL_ADVANCERS/.test(src) &&
         /!BASE_CLASS_SPELL_ADVANCERS\.has\(r\.name\)\)\s*adv\s*=\s*null/.test(src),
    'the base-class SPELL pillar must be nulled UNLESS the class is in the ' +
    'BASE_CLASS_SPELL_ADVANCERS allowlist');
  // (3) Every base class carrying an advancement block must be either HONORED
  // (legitimately advances casting — kept by the allowlist) or a STALE mis-tag
  // to remove from _class_metadata.py. Anything else is a NEW mis-tag to triage.
  const HONORED = new Set([   // MIRROR of BASE_CLASS_SPELL_ADVANCERS in class-picker.js
    'Drow Paragon', 'Elf Paragon', 'Gnome Paragon',
    'Half-Elf Paragon', 'Human Paragon',
  ]);
  const STALE = new Set(['Dragonfire Adept']);  // mis-tagged; neutralized, remove at source
  const offenders = execAll(db,
    "SELECT name FROM entry WHERE type = 'class' " +
    "AND json_extract(data, '$.advancement') IS NOT NULL").map(r => r.name);
  const unexpected = offenders.filter(n => !HONORED.has(n) && !STALE.has(n));
  assert(unexpected.length === 0,
    `New base class(es) with an advancement block: ${unexpected.join(', ')}. ` +
    `If it legitimately advances casting, add it to BASE_CLASS_SPELL_ADVANCERS ` +
    `in class-picker.js AND the HONORED set here; if it's a mis-tag, remove the ` +
    `advancement entry in _class_metadata.py.`);
});

// ---- tests: class progression fields are always populated ----------------
//
// Mirror of the Python TestClassMetadata test_every_class_has_progression_fields.
// We also assert here because the character sheet IS what queries these
// fields — and we want the test to fire on the loaded DB blob the picker
// actually uses, not just the source build. If a DB ships with null
// progressions, the multiclass aggregator silently contributes 0 BAB/save
// for that class (Sand Shaper / Durthan / 257 other entries did this
// before the 2026-05-16 build-time backfill in _class_metadata.py).
test('class-picker: every class/prc has non-null bab/fort/ref/will progressions', (db) => {
  const rows = execAll(db,
    "SELECT name, type, source FROM entry " +
    "WHERE type IN ('class','prc') AND (" +
    "json_extract(data, '$.bab_progression')  IS NULL OR " +
    "json_extract(data, '$.fort_progression') IS NULL OR " +
    "json_extract(data, '$.ref_progression')  IS NULL OR " +
    "json_extract(data, '$.will_progression') IS NULL)");
  assert(rows.length === 0,
    `${rows.length} class/prc entries have null progression fields. ` +
    `Sample: ${JSON.stringify(rows.slice(0, 5))}. ` +
    `Rebuild the DB — _class_metadata._infer_progressions_if_missing ` +
    `should fill these in at build time.`);
});

// ---- tests: spontaneous-caster spells_known is populated ----------------
//
// The Sorcerer/Bard/Hexblade/Favored Soul/Spirit Shaman et al. all have
// per-level Spells Known progressions in their source rules. These need
// to make it into class_table rows so class-picker.js can auto-fill the
// "Known" column on the Spellcasting panel. Before 2026-05-17 the build
// pipeline only merged spells_per_day; spells_known fell on the floor.
//
// "Knows-whole-list" casters (Beguiler / Warmage / Dread Necromancer /
// Sha'ir / Healer / Duskblade) genuinely have no per-level table — they
// know every spell on their list — and are excluded.
test('class-picker: every per-level spontaneous caster has spells_known on every row that has spells_per_day', (db) => {
  // "Knows whole list" casters — no per-level Spells Known table in source.
  // Sha'ir IS NOT in this set: Dragon Compendium Table 2-12 gives Sha'ir
  // a normal per-level Spells Known progression; the gen-retrieval
  // mechanic is just a preparation-speed bonus, not a "know everything"
  // pass like Beguiler / Warmage / etc.
  const WHOLE_LIST = new Set([
    'Beguiler', 'Warmage', 'Dread Necromancer',
    'Healer', 'Duskblade',
  ]);
  const rows = execAll(db,
    "SELECT name, data FROM entry " +
    "WHERE type = 'class' AND " +
    "json_extract(data, '$.spellcasting.style') = 'spontaneous'");
  const broken = [];
  for (const r of rows) {
    if (WHOLE_LIST.has(r.name)) continue;
    const d = JSON.parse(r.data);
    const tbl = d.class_table;
    if (!Array.isArray(tbl) || !tbl.length) continue;
    // Find the highest-level row that has spells_per_day populated.
    const lastCasting = [...tbl].reverse().find(row =>
      Array.isArray(row.spells_per_day) &&
      row.spells_per_day.some(v => v !== null && v !== undefined));
    if (!lastCasting) continue;  // never gets to cast (shouldn't happen)
    if (!Array.isArray(lastCasting.spells_known) ||
        !lastCasting.spells_known.some(v => v !== null && v !== undefined &&
          v !== '-' && v !== '—')) {
      broken.push(r.name);
    }
  }
  assert(broken.length === 0,
    `${broken.length} spontaneous caster(s) have no per-level spells_known ` +
    `merged into class_table:\n  ${broken.join('\n  ')}\n` +
    `Either add the Spells Known data to the upstream Python data file ` +
    `and re-run emit_*.py + normalize_schema.py, or — if the class is a ` +
    `"knows-whole-list" caster — add its name to the WHOLE_LIST set ` +
    `here and the KNOWS_WHOLE_LIST_NOTES map in class-picker.js.`);
});

// ---- tests: companion metadata coverage ----------------------------------
//
// Every class feature whose description mentions an animal companion,
// familiar, special mount, or cohort should EITHER have a structured
// `companion` block populated by _companion_metadata.py OR be an
// explicitly-excluded entry in the override map (signified by a None
// value — those don't get a `companion` field but ARE listed in the
// keyed overrides). When neither is true, the audit fails and the
// new class feature needs an override added.
test('companion: every relevant class feature has metadata or explicit exclusion', (db) => {
  // Mirror the keyword set from _companion_metadata.py.
  // Intentionally not the same regex — we want to catch mentions
  // the Python regex might have missed, so this is broader.
  const KEYWORDS = /\b(animal\s+companion|familiar|special\s+mount|paladin'?s?\s+mount|divine\s+mount|bonded\s+mount|telthor\s+companion|cohort|leadership)\b/i;
  // Phrases that indicate an incidental mention — Leadership listed as
  // a feat option, anti-companion abilities, transformation rules, etc.
  const INCIDENTAL = /leadership\s+score|feat\s+from:?\b[^.]*leadership|\bex-\w+|\bbecomes?\s+\w+|sever\s+bonded|except\s+(?:spellcasting\s+and\s+)?animal\s+companion|does\s+not\s+grant.*familiar|magical\s+materials/i;
  // Hand-curated set of (class, feature) pairs we explicitly excluded
  // — must match the None entries in _companion_metadata.OVERRIDES.
  // (We could DB-query for the OVERRIDES set but a Python-vs-JS mirror
  // is simpler and self-documents the intentional exclusions here.)
  const EXCLUSIONS = new Set([
    // 2026-07-09 Races of the Wild walk: Arcane Hierophant's "Channel Animal"
    // lets you channel touch spells THROUGH your existing animal companion —
    // it names the keyword but grants no companion (the advanced druid levels
    // do). No progression to model.
    'Arcane Hierophant/Channel Animal (Sp)',
    // 2026-06-29 Dragon #336 Mystic Ranger variant class: its "Animal
    // Companion" feature explicitly TRADES AWAY the companion (for earlier/
    // deeper spellcasting) — names the keyword, grants nothing. Mirrors the
    // None entry ("Mystic Ranger", "Animal Companion") in _companion_metadata.
    'Mystic Ranger/Animal Companion',
    // 2026-07-07 Dragon #312 Despot: "Code of Conduct" names "henchmen,
    // followers, or cohorts" as an associates RESTRICTION — the cohort is
    // granted by the Leadership feat, not this feature. Mirrors the None
    // entry ("Despot", "Code of Conduct") in _companion_metadata.
    'Despot/Code of Conduct',
    // 2026-07-04 CAdv walk-v3: per-level Ride/Handle Animal skill bonus that
    // mentions the companion but grants no progression (that's the PrC's
    // Animal Companion/Special Mount feature). Mirrors the None entry.
    'Wild Plains Outrider/Ride Bonus',
    'Generic Warrior/Bonus Feats',
    'Guild Thief/Bonus Feat',
    'Guild Thief/Reputation',
    'Hexblade/Ex-Hexblades',
    'Mountebank/Infernal Escape (Su)',
    'Cerebremancer/Spells per Day/Powers Known',  // walk feature name (no spaces around slash; was "Day / Powers" pre-2026-06-02)
    'Hierophant/Power of Nature (Su)',
    'Hierophant/Power of Nature [druid-only special ability]',
    'Blighter/Unbond (Sp)',             // Sp attack that severs OTHERS' bonds, not a companion (CDiv walk 2026-07-11)
    'Spirit Shaman/Spirit Guide',       // ability-granting nature spirit, not a stat-blocked companion
    "Sha'ir/Spells",
    'Prestige Paladin/Class Features',
    'Aglarondan Griffonrider/Flyby Attack',
    'Aglarondan Griffonrider/Aerial Evasion (Ex)',
    'Aglarondan Griffonrider/Hover (Ex)',
    'Aglarondan Griffonrider/Power Dive (Ex)',
    'Aglarondan Griffonrider/Superior Flight (Ex)',
    // 2026-05-16 DComp fidelity-fix added: Flux Adept's Taste of
    // Truth uses "familiar" as a plain English adjective ("now so
    // familiar to the flux adept") — false positive on the
    // KEYWORDS regex.
    'Flux Adept/Taste of Truth (Ex)',
    // 2026-06-13 Complete Warrior v3 walk: Justiciar's "Exotic Weapon
    // Proficiency (Manacles)" opens "Intimately familiar with the capture
    // of criminals" — "familiar" as a plain adjective, not a familiar pet.
    'Justiciar/Exotic Weapon Proficiency (Manacles)',
    // 2026-06-14 Tome of Magic v3 walk: Child of Night's "Mysteries/
    // Spellcasting" is the standard PrC caster-advancement clause whose
    // boilerplate mentions "improved familiar for wizard or sorcerer" in
    // the NEGATIVE ("you do not, however, gain any other benefit...") —
    // it grants no familiar. Explicit non-grant (None in _companion_metadata).
    'Child of Night/Mysteries/Spellcasting',
    // 2026-07-25 Book of Exalted Deeds v3 walk: three caster-PrC spell-
    // advancement features whose standard boilerplate ("does not, however,
    // gain any other benefit... improved familiar/special mount, and so on")
    // names the keyword only in the NEGATIVE. Explicit non-grants (None in
    // _companion_metadata). Same shape as Child of Night above.
    'Exalted Arcanist/Spells per Day/Spells Known',
    'Fist of Raziel/Spells per Day',
    'Troubadour of Stars/Spells per Day/Spells Known',
    // 2026-05-22 Dscape Dungeon Lord re-extraction (corpus-first
    // audit fix): "Dungeon Dependency" describes the PrC's
    // requirement to remain in a specific dungeon — "you can be
    // familiar with only one dungeon at a time" — uses "familiar"
    // as an adjective ("well-acquainted with"), not as the noun
    // for a familiar pet.
    'Dungeon Lord/Dungeon Dependency',
    // 2026-05-18 FaP extraction. Arachne/Familiar (Su) and
    // Arachne/Spider Mount (Sp) ARE companion-granting and have
    // metadata; the two listed below mention companion keywords but
    // don't grant or advance one.
    'Arachne/Spidereyes (Su)',           // perception through familiar's eyes
    'Dweomerkeeper/Bonus Feats',         // metamagic/item-creation picks
    // 2026-05-18 MoF extraction: Mystic Wanderer's "Familiar" is a
    // flavor reference to the wanderer's bonded animal — does not
    // grant or advance a wizard/sorcerer familiar mechanically.
    'Mystic Wanderer/Familiar',
    // 2026-05-18 HoB extraction: Legendary Leader's "To Hell and Back"
    // grants fear immunity to existing cohorts/followers — modifies,
    // doesn't grant/advance, nothing for the companion engine to do.
    'Legendary Leader/To Hell and Back (Ex)',
    // 2026-06-20 Stormwrack v3-walk REPLACE: Legendary Captain's L10
    // "Fleet Admiral" feature aids the crews of allies' ships ("crews"/
    // "fleet" trip the keyword) but grants/advances no companion. None
    // in _companion_metadata. (Legacy emitted "Leadership" here instead.)
    'Legendary Captain/Fleet Admiral',
    'Legendary Captain/Leadership',
    // 2026-05-19 Dungeonscape extraction: Beast Heart Adept's
    // "Alternative Monstrous Companion" just adds higher-HD
    // creature options to the existing bond, doesn't grant a new
    // one. "Bound to a Dungeon" is the Dungeon Lord's
    // restriction clause (PrC powers turn off outside the bound
    // dungeon), not a companion-granting feature.
    'Beast Heart Adept/Alternative Monstrous Companion',
    'Dungeon Lord/Bound to a Dungeon',
    // 2026-05-22 Diamond Soul (Homebrew): Tidecaller's "Ride the
    // Tide" lets a manifested elemental shark deliver the
    // Tidecaller's touch-range spells "as a familiar delivers a
    // touch spell" — comparative reference to the familiar
    // mechanic, not a new familiar/companion grant. The four
    // elemental sharks are bound via the "Bind Elemental Shark"
    // feature; Ride the Tide is just a delivery option for them.
    'Tidecaller/Ride the Tide (Su)',
    // 2026-06-04 Epic Level Handbook v3-walk REPLACE: two epic PrC
    // bonus-feat features mention a companion keyword only as an
    // item in the selectable epic-feat list — Cosmic Descryer's
    // "Bonus Feat (Ex)" lists a Familiar-related feat option, and
    // Divine Emissary's "Bonus Feats" lists Leadership as an option.
    // Neither grants/advances a companion. (Divine Emissary's actual
    // mount-advancer is the separate "Special Mount" feature, which
    // DOES carry companion metadata.)
    'Cosmic Descryer/Bonus Feat (Ex)',
    'Divine Emissary/Bonus Feats',
    // 2026-06-06 Eberron CS v3-walk: the Magewright NPC class's "Spell Mastery"
    // is wizard-style spell preparation without a spellbook — not a companion
    // grant. Incidental keyword match (it references the Spell Mastery feat).
    'Magewright/Spell Mastery',
    // 2026-06-07 Dragon Magic v3-walk: the Dragon Lord PrC's "Reckless Devotion"
    // is a party buff that merely mentions a "cohort or follower (as per the
    // Leadership feat)" gets double benefit — it does not grant or advance a
    // companion. (Its "Dragon Leadership" feature only modifies the Leadership
    // SCORE, also not a companion grant; the keyword filter already passes it.)
    'Dragon Lord/Reckless Devotion',
  ]);

  const rows = execAll(db,
    "SELECT name, json_extract(data, '$.class_features') AS cf " +
    "FROM entry WHERE type IN ('class','prc') " +
    "AND json_extract(data, '$.class_features') IS NOT NULL");
  const missing = [];
  for (const r of rows) {
    let cf;
    try { cf = JSON.parse(r.cf); } catch { continue; }
    if (!Array.isArray(cf)) continue;
    for (const f of cf) {
      const text = (f.name || '') + ' ' + (f.description || '');
      if (!KEYWORDS.test(text)) continue;
      if (INCIDENTAL.test(text)) continue;
      if (f.companion) continue;          // metadata present → ok
      const key = `${r.name}/${f.name}`;
      if (EXCLUSIONS.has(key)) continue;  // explicit exclusion → ok
      missing.push(key);
    }
  }
  assert(missing.length === 0,
    `${missing.length} class feature(s) mention companion keywords ` +
    `but have no companion metadata and no explicit exclusion:\n  ` +
    missing.join('\n  ') + '\n' +
    `Add an entry to _companion_metadata.py::OVERRIDES (with a ` +
    `companion dict, or None to explicitly exclude) and update the ` +
    `EXCLUSIONS set in this test.`);
});

// ---- tests: metamagic metadata coverage ----------------------------------
//
// Every feat tagged Metamagic in types_csv should have populated
// metamagic.level_adjustment after the DB build. Backstop against
// regressions in the regex extractor or manual-override map in
// _metamagic_metadata.py.
test('metamagic: every Metamagic feat has level_adjustment', (db) => {
  const rows = execAll(db,
    "SELECT name, source FROM entry " +
    "WHERE type='feat' AND types_csv LIKE '%Metamagic%' " +
    "AND json_extract(data, '$.metamagic.level_adjustment') IS NULL");
  assert(rows.length === 0,
    `${rows.length} metamagic feat(s) have no level_adjustment.\n` +
    `Sample: ${JSON.stringify(rows.slice(0, 5))}\n` +
    `Add to MANUAL_OVERRIDES in _metamagic_metadata.py or check that ` +
    `the regex extractor in extract_level_adjustment() picks them up.`);
});

test('metamagic-preparer: module exposes expected public API', () => {
  // Static smoke test — verifies the v1-followup metamagic-preparer
  // module loads, declares its window assignment, and provides the
  // expected helpers. The runtime UI behavior (popover render,
  // checkbox->level math, prepared-textarea write) is exercised by
  // the playfeel suite, not here.
  const src = readSource('metamagic-preparer.js');
  assert(/window\.MetamagicPreparer\s*=/.test(src),
    'metamagic-preparer.js must assign to window.MetamagicPreparer.');
  for (const fn of ['open', 'characterHasAnyMetamagic',
                    'readCharacterMetamagicFeats', 'adjectiveFor']) {
    assert(src.includes(`${fn}`),
      `metamagic-preparer.js missing ${fn} in public API.`);
  }
  // Sanity-check the past-participle map: every PHB metamagic feat
  // (the 8 base + Heighten) must have an adjective.
  for (const feat of ['Empower Spell', 'Maximize Spell', 'Quicken Spell',
                      'Extend Spell', 'Silent Spell', 'Still Spell',
                      'Enlarge Spell', 'Widen Spell', 'Heighten Spell']) {
    assert(src.includes(`"${feat}":`),
      `metamagic-preparer.js ADJECTIVE map missing "${feat}".`);
  }
  // Spells.js must export lookupMetamagicFromDB so the preparer can
  // share the DB-first / catalog-fallback lookup.
  const spellsSrc = readSource('spells.js');
  assert(/lookupMetamagicFromDB[\s,}]/.test(spellsSrc.split('return {').pop() || ''),
    'spells.js public API must export lookupMetamagicFromDB.');
});

test('spells: prepared-used checkboxes sync the expended-slot count + reset clears both', () => {
  const sp = readSource('spells.js');
  // Checkbox change delta-syncs the level's .sc-used input (+1/-1, not a
  // recount, so manual slot adjustments survive), floored at 0.
  const cbRegion = sp.slice(sp.indexOf('usedCb.addEventListener'),
                            sp.indexOf('usedCb.addEventListener') + 700);
  assert(/\.sc-used\[data-lvl="\$\{lvl\}"\]/.test(cbRegion),
    'sc-prep-used change must target the matching level\'s .sc-used input');
  assert(/Math\.max\(0,[\s\S]{0,80}usedCb\.checked \? 1 : -1/.test(cbRegion),
    'used-count must delta by ±1 and floor at 0');
  // Reset Expended Slots clears the per-spell used checkmarks too.
  const resetRegion = sp.slice(sp.indexOf('.sc-reset-slots'),
                               sp.indexOf('.sc-reset-slots') + 700);
  assert(/\.sc-prep-used:checked/.test(resetRegion),
    'Reset Expended Slots must uncheck every sc-prep-used checkbox');
  // Removing a still-checked row walks its expenditure back (Ryan
  // 2026-07-05: walkbacks are common; no phantom used slots).
  const rmRegion = sp.slice(sp.indexOf('rmBtn.addEventListener'),
                            sp.indexOf('rmBtn.addEventListener') + 700);
  assert(/usedCb\.checked/.test(rmRegion) && /Math\.max\(0,/.test(rmRegion),
    'removing a checked prepared row must decrement the used count (floor 0)');
});

test('metamagic-preparer: spells.js wires the ✨ button on Known rows', () => {
  // Regression guard for the v1 follow-up wiring. The button must:
  //   - exist in createKnownRow's row.innerHTML
  //   - have a click listener that calls MetamagicPreparer.open
  //   - be conditionally shown via refreshKnownRowMetamagicVis
  const src = readSource('spells.js');
  assert(src.includes('sc-known-mm'),
    'spells.js missing sc-known-mm button class.');
  assert(src.includes('MetamagicPreparer.open'),
    'spells.js must invoke MetamagicPreparer.open from the ✨ click handler.');
  assert(src.includes('refreshKnownRowMetamagicVis'),
    'spells.js missing the per-row ✨ visibility refresh helper.');
});

test('metamagic-preparer v2 Phase A: reduction-feat helpers exposed', () => {
  // computeAdjustments + readReductionFeats handle Improved Metamagic
  // (ELH), Arcane Thesis (PHB2), Easy Metamagic (PHB2/CMagic), and the
  // Sanctum Spell contextual ±1 toggle.
  const src = readSource('metamagic-preparer.js');
  for (const fn of ['readReductionFeats', 'computeAdjustments']) {
    assert(src.includes(fn),
      `metamagic-preparer.js must export ${fn} for v2 Phase A.`);
  }
  // The Sanctum-context dropdown must exist in the rendered HTML.
  assert(src.includes('sc-mm-sanctum-ctx'),
    'metamagic-preparer.js missing the Sanctum-context dropdown markup.');
  // Per-feat min of +1 (RAW for IM/Arcane Thesis/Easy MM).
  assert(/Math\.max\(1,/.test(src),
    'metamagic-preparer.js must clamp reduced cost to min +1 per RAW.');
});

test('item-familiar: module loads + exposes Companion-integration API', () => {
  // Item Familiar (UA pp.170-173) — companion-tab Type option that
  // swaps to a different panel layout. Guard the integration contract:
  //   - item-familiar.js exists + assigns window.ItemFamiliar
  //   - exposes the integration helpers (buildHTML, wirePanel,
  //     collectData, loadData) + the auto-apply hooks
  //     (getAllSkillBonuses, getAllSpellSlotBonuses, getXpMultiplier)
  //   - companion.js branches on ItemFamiliar.isItemFamiliarType()
  //   - module-loader includes item-familiar.js BEFORE companion.js
  const src = readSource('item-familiar.js');
  assert(/window\.ItemFamiliar\s*=/.test(src),
    'item-familiar.js must assign to window.ItemFamiliar.');
  for (const fn of ['isItemFamiliarType', 'buildHTML', 'wirePanel',
                    'collectData', 'loadData', 'recalc',
                    'getAllSkillBonuses', 'getAllSpellSlotBonuses',
                    'getXpMultiplier']) {
    assert(src.includes(fn),
      `item-familiar.js missing ${fn} in public API.`);
  }
  // Rules constants from UA must be present.
  assert(src.includes('SAPIENCE_LEVEL'),
    'item-familiar.js must expose SAPIENCE_LEVEL.');
  assert(src.includes('SKILL_BONUS_PER_RANKS'),
    'item-familiar.js must expose SKILL_BONUS_PER_RANKS.');

  // companion.js must branch on ItemFamiliar.isItemFamiliarType.
  const comp = readSource('companion.js');
  assert(comp.includes('ItemFamiliar.isItemFamiliarType'),
    'companion.js must branch on ItemFamiliar.isItemFamiliarType.');
  assert(/['"]item_familiar['"]/.test(comp),
    'companion.js must include the item_familiar Type option.');
  assert(comp.includes('ItemFamiliar.buildHTML'),
    'companion.js must delegate rendering to ItemFamiliar.buildHTML.');
  assert(comp.includes('ItemFamiliar.collectData'),
    'companion.js must delegate collectData to ItemFamiliar.');

  // Auto-apply hooks: skills.js, spells.js, character.js must read
  // from the item-familiar getters.
  const skills = readSource('skills.js');
  assert(skills.includes('ItemFamiliar.getAllSkillBonuses'),
    'skills.js must apply item-familiar skill bonuses.');
  const spells = readSource('spells.js');
  assert(spells.includes('ItemFamiliar.getAllSpellSlotBonuses'),
    'spells.js must apply item-familiar bonus spell slots.');
  const character = readSource('character.js');
  assert(character.includes('ItemFamiliar.getXpMultiplier'),
    'character.js must apply item-familiar XP multiplier.');
  // Weight contribution: equipment.js must include item-familiar
  // weight in carry-weight aggregation. The bonded item is still
  // a physical object the character has to carry.
  const equip = readSource('equipment.js');
  assert(equip.includes('ItemFamiliar.getTotalWeight'),
    'equipment.js recalcWeight must include item-familiar weight.');
  assert(src.includes('ifam-item-weight'),
    'item-familiar.js panel must include a weight input field.');
  assert(src.includes('getTotalWeight'),
    'item-familiar.js must expose getTotalWeight.');
  // UA p.171: invested slot must be of highest castable level. The
  // module must expose getHighestCastableLevel + auto-sync the
  // invested field on recalc.
  assert(src.includes('getHighestCastableLevel'),
    'item-familiar.js must expose getHighestCastableLevel.');
  assert(src.includes('autoHighest'),
    'item-familiar.js must track the auto-fill cookie for invested-slot rows.');
  assert(src.includes('ifam-slot-auto'),
    'item-familiar.js panel must include the ↻ re-sync button on slot rows.');

  // Regression guard for the 2026-05-19 bug: changing classes (e.g.
  // adding/removing a class level via class-picker) was silently
  // bumping the comp-type away from item_familiar back to the
  // class-default (animal/familiar/cohort) because companion.js's
  // classes-changed handler auto-defaults the dropdown when
  // `dataset.userSet` isn't stamped. The item-familiar wire path
  // must stamp `userSet="1"` to lock the choice.
  assert(/ItemFamiliar\.isItemFamiliarType[\s\S]{0,800}userSet/.test(comp),
    'companion.js item-familiar branch must stamp dataset.userSet on the comp-type select ' +
    '(otherwise classes-changed silently bumps it back to a creature companion).');

  // Module-loader order: item-familiar.js must load before companion.js
  // since companion.js's render branches on ItemFamiliar.
  const html = readSource('index.html');
  const ifIdx = html.indexOf("'item-familiar.js'");
  const compIdx = html.indexOf("'companion.js'");
  assert(ifIdx > 0 && compIdx > 0,
    'index.html module loader missing item-familiar.js or companion.js.');
  assert(ifIdx < compIdx,
    'item-familiar.js must load BEFORE companion.js in the module loader.');
});

test('metamagic-preparer v2 Phase C-a: per-class reductions table exposed', () => {
  // CLASS_REDUCTIONS table covers every PrC with a -1-to-all metamagic
  // reducer feature. The DB-driven audit below verifies completeness
  // against the live class data; this test just sanity-checks the
  // wiring exists.
  const src = readSource('metamagic-preparer.js');
  assert(src.includes('CLASS_REDUCTIONS'),
    'metamagic-preparer.js must define CLASS_REDUCTIONS table for Phase C-a.');
  for (const expected of ['Incantatrix', 'Dweomerkeeper']) {
    assert(new RegExp(`"${expected}"`).test(src),
      `metamagic-preparer.js CLASS_REDUCTIONS must include ${expected}.`);
  }
  // readReductionFeats must consult ClassPicker.getState() for the
  // applied class list — this is the canonical source.
  assert(/ClassPicker.*getState/.test(src),
    'metamagic-preparer.js readReductionFeats must read class state from ClassPicker.');
  // computeAdjustments must apply the classReductions to the per-feat
  // reduction counter (stacking with feat reductions).
  assert(src.includes('classReductions'),
    'metamagic-preparer.js computeAdjustments must apply class reductions.');
  // Dweomerkeeper exempts Heighten Spell — the schema must support
  // excludeFeats and the compute path must honor it.
  assert(/excludeFeats/.test(src),
    'metamagic-preparer.js must support per-rule excludeFeats lists ' +
    '(Dweomerkeeper exempts Heighten Spell from Cloak of Mysteries).');
});

// -- Future-proofing audit -------------------------------------------
//
// Scan the DB for PrC / class features whose description matches the
// canonical "all metamagic reduced by 1" pattern (Incantatrix-style).
// Every match must either be present in metamagic-preparer.js's
// CLASS_REDUCTIONS table OR explicitly listed in the IGNORE set below
// with a one-line justification. The audit catches NEW classes added
// by future DB extractions — if you re-run the DB build and add a PrC
// with this feature, this test will fail until you wire it up.
//
// To extract CLASS_REDUCTIONS keys, we re-use the same object-literal
// key extractor used for HARDCODED_ADVANCERS above.
const MM_REDUCER_SRC = fs.readFileSync(
  path.join(ROOT, 'metamagic-preparer.js'), 'utf8'
);
const CLASS_REDUCTIONS_KEYS = extractObjectKeys(
  MM_REDUCER_SRC, 'CLASS_REDUCTIONS'
);

// Classes whose description matches the pattern but should NOT be in
// CLASS_REDUCTIONS — usually because they require user opt-in (per-day
// counters, per-school limits, etc.) that don't fit the
// "applies to every metamagic, always" shape. Keep this list small and
// commented — each entry needs a justification.
const MM_REDUCER_IGNORE = new Set([
  // No current ignores. If a future PrC has a limited-use reducer
  // (e.g. N/day, per-school, single-spell), add it here with a
  // justification and surface it as a FEAT-side reduction config
  // instead (see Easy Metamagic / Arcane Thesis pattern).
]);

test('metamagic-preparer: CLASS_REDUCTIONS covers every DB -1-to-all reducer', (db) => {
  // Regex patterns matching the canonical RAW wording for a -1-to-all
  // metamagic reducer. Keep these tight — too loose and we false-flag
  // features that mention metamagic in unrelated context (Quickening
  // Strike, Domain Wizard bonus-slot prose, etc.).
  const REDUCER_PATTERNS = [
    // "level increase ... reduced by one/two/N" (Incantatrix shape)
    /level (?:adjustment|increase)\s+(?:upon a spell\s+)?(?:is\s+)?reduced by (?:one|two|three|\d+)/i,
    // "spell-slot adjustment by one/N" (Dweomerkeeper shape)
    /spell-?slot adjustment by (?:one|two|three|\d+)/i,
    // "metamagic feats ... cost one/N less spell-slot level" (ELH IM)
    /metamagic feat[s]?\b[^.]{0,80}cost\s+(?:one|two|three|\d+)\s+less\s+spell-?slot level/i,
  ];

  const rows = execAll(db,
    "SELECT e.name AS name, e.source AS source, " +
    "       json_extract(e.data, '$.class_features') AS feats " +
    "FROM entry e LEFT JOIN book b ON b.name = e.source " +
    "WHERE e.type IN ('class','prc') " +
    // Source-recency tiebreak: 3.5 over 3.0, then newest pub date.
    // For the canonical class level we want the same printing the
    // class-picker would pick.
    "ORDER BY e.name, CASE b.edition WHEN '3.5' THEN 0 ELSE 1 END, " +
    "b.publication_date DESC");

  // Keep only the source-recency winner per class name (the first row
  // after the ORDER BY).
  const winners = new Map();
  for (const r of rows) if (!winners.has(r.name)) winners.set(r.name, r);

  const missing = [];
  for (const [className, row] of winners) {
    const features = JSON.parse(row.feats || '[]');
    for (const f of features) {
      const desc = (f.description || f.benefit || '').toString();
      const matched = REDUCER_PATTERNS.some(re => re.test(desc));
      if (!matched) continue;
      if (CLASS_REDUCTIONS_KEYS.has(className)) continue;
      if (MM_REDUCER_IGNORE.has(className)) continue;
      missing.push({
        className,
        source: row.source,
        feature: f.name,
        level: f.level_acquired ?? f.level ?? '?',
        snippet: desc.slice(0, 180),
      });
    }
  }

  assert(missing.length === 0,
    `${missing.length} DB class feature(s) match the -1-to-all metamagic\n` +
    `reducer pattern but aren't in metamagic-preparer.js's CLASS_REDUCTIONS:\n` +
    missing.slice(0, 8).map(m =>
      `  ${m.className} ${m.feature} (L${m.level}, ${m.source})\n    "${m.snippet}"`
    ).join('\n') + '\n\nAdd each one to the CLASS_REDUCTIONS table in metamagic-preparer.js, or\n' +
    'list it in MM_REDUCER_IGNORE here with a one-line justification (e.g.\n' +
    'limited-use reducers that need feat-side config instead).');
});

test('metamagic-preparer v2 Phase C: prepared-line parse + render helpers', () => {
  // parsePreparedLine + renderPreparedLine survive from C-b — they
  // power the legacy `prepared-${i}` string migration in loadData
  // (textarea-format saves → structured rows on load).
  const src = readSource('metamagic-preparer.js');
  for (const fn of ['parsePreparedLine', 'renderPreparedLine']) {
    assert(src.includes(fn),
      `metamagic-preparer.js must export ${fn} for v2 Phase C.`);
  }
  // The preparer must accept prepopulate + onPrepare opts (the Edit
  // affordance reopens the picker pre-populated from the row's data).
  assert(/prepopulate/.test(src) && /onPrepare/.test(src),
    'metamagic-preparer.js open() must accept prepopulate + onPrepare opts.');
});

test('metamagic v2 Phase C structural restructure: Prepared is a structured row list', () => {
  // v2 Phase C (2026-05-19) replaced the per-level Prepared textarea
  // with a structured row list (mirroring the Known column). Each row
  // carries its metamagic state in data-* attributes so the ✏ button
  // can reopen the preparer pre-populated.
  const spellsSrc = readSource('spells.js');
  // No more .sc-spell-prepared textarea references.
  assert(!/\.sc-spell-prepared/.test(spellsSrc),
    'spells.js must not reference the obsolete .sc-spell-prepared ' +
    'textarea — Prepared is now a structured row list.');
  // Structured-row scaffold: list container + add button + per-row
  // builder + public addPreparedSpell API.
  for (const needle of ['sc-prepared-list', 'sc-add-prepared',
                        'sc-prepared-row', 'createPreparedRow',
                        'addPreparedSpell', 'openEditMetamagicOnRow']) {
    assert(spellsSrc.includes(needle),
      `spells.js missing v2 Phase C symbol: ${needle}`);
  }
  // Row state lives in data-* attributes — verify the names match
  // what the preparer's edit path reads back.
  for (const needle of ['data-metamagic', 'dataset.base',
                        'dataset.metamagic', 'dataset.sanctumIn',
                        'dataset.heightenTarget']) {
    assert(spellsSrc.includes(needle),
      `spells.js Prepared row missing data attribute: ${needle}`);
  }
  // Save round-trip uses preparedList-${i} arrays (new) with legacy
  // prepared-${i} string fallback in loadData.
  assert(/preparedList-\$\{i\}/.test(spellsSrc),
    'spells.js must persist Prepared as a `preparedList-${i}` array.');
  assert(/prepared-\$\{i\}/.test(spellsSrc),
    'spells.js loadData must still accept the legacy `prepared-${i}` ' +
    'string for one-shot migration.');
  // The MetamagicPreparer must call Spells.addPreparedSpell on save
  // so the structured row keeps its picker state.
  const prepSrc = readSource('metamagic-preparer.js');
  assert(/Spells\.addPreparedSpell/.test(prepSrc),
    'metamagic-preparer.js must call Spells.addPreparedSpell to ' +
    'write structured rows (not textarea lines).');
  // The dead refreshEditPreparedMMVisibility / openPreparedEditPicker
  // helpers must be gone — the ✏ button is per-row now.
  assert(!/refreshEditPreparedMMVisibility/.test(spellsSrc),
    'spells.js must drop refreshEditPreparedMMVisibility — the ' +
    '✏ Edit button now lives directly on each .sc-prepared-row.');
  assert(!/openPreparedEditPicker/.test(spellsSrc),
    'spells.js must drop openPreparedEditPicker — use ' +
    'openEditMetamagicOnRow on the structured row instead.');
});

test('metamagic-preparer v2 Phase B: Sudden* daily tracking exposed', () => {
  // resetAllDailyUses + markFeatUsed + isFeatUsedToday + the
  // [Used today] marker convention.
  const src = readSource('metamagic-preparer.js');
  for (const fn of ['isFeatUsedToday', 'markFeatUsed',
                    'unmarkFeatUsed', 'resetAllDailyUses']) {
    assert(src.includes(fn),
      `metamagic-preparer.js must export ${fn} for v2 Phase B.`);
  }
  // The [Used today] marker convention must be regex-detected
  // (not a plain string match — case-insensitive).
  assert(/\[\s*used\s+today\s*\]/i.test(src) || src.includes('used\\s+today'),
    'metamagic-preparer.js must recognize the [Used today] marker.');
  // spells.js must wire the trackers section (Quickened-this-round +
  // daily-reset button) into the Metamagic Reference details.
  const spellsSrc = readSource('spells.js');
  assert(spellsSrc.includes('sc-quickened-this-round'),
    'spells.js missing the Quickened-this-round counter element.');
  assert(spellsSrc.includes('sc-mm-reset-daily'),
    'spells.js missing the Reset Sudden* Daily Uses button.');
  assert(spellsSrc.includes('quickenedThisRound'),
    'spells.js must persist quickenedThisRound via collectData.');
});

test('metamagic: level_adjustment values are integer 0-9 or "variable"', (db) => {
  const rows = execAll(db,
    "SELECT name, " +
    "json_extract(data, '$.metamagic.level_adjustment') AS adj " +
    "FROM entry WHERE type='feat' AND types_csv LIKE '%Metamagic%' " +
    "AND json_extract(data, '$.metamagic.level_adjustment') IS NOT NULL");
  const bad = rows.filter(r => {
    const a = r.adj;
    if (a === 'variable') return false;
    if (typeof a === 'number' && a >= 0 && a <= 9 && Number.isInteger(a)) return false;
    return true;
  });
  assert(bad.length === 0,
    `${bad.length} feat(s) have non-canonical level_adjustment:\n  ` +
    bad.slice(0, 8).map(r => `${r.name}: ${JSON.stringify(r.adj)}`).join('\n  '));
});

test('class-picker: progression values are in canonical set', (db) => {
  const VALID_BAB = new Set(['good', 'average', 'poor']);
  const VALID_SAVE = new Set(['good', 'poor']);
  const rows = execAll(db,
    "SELECT name, " +
    "json_extract(data, '$.bab_progression')  AS bab, " +
    "json_extract(data, '$.fort_progression') AS fort, " +
    "json_extract(data, '$.ref_progression')  AS ref, " +
    "json_extract(data, '$.will_progression') AS will " +
    "FROM entry WHERE type IN ('class','prc')");
  // UA Generic Classes (Warrior/Expert/Spellcaster) have PLAYER-DESIGNATED saves
  // (one good + two poor, assigned at creation), which _class_metadata.py emits as
  // a "varies (player-designated; ...)" progression — legitimately outside the
  // fixed good/poor model.
  const okBab  = (v) => !v || VALID_BAB.has(v)  || /^varies/i.test(v);
  const okSave = (v) => !v || VALID_SAVE.has(v) || /^varies/i.test(v);
  const bad = [];
  for (const r of rows) {
    if (!okBab(r.bab))   bad.push(`${r.name}: bab=${r.bab}`);
    if (!okSave(r.fort)) bad.push(`${r.name}: fort=${r.fort}`);
    if (!okSave(r.ref))  bad.push(`${r.name}: ref=${r.ref}`);
    if (!okSave(r.will)) bad.push(`${r.name}: will=${r.will}`);
  }
  assert(bad.length === 0,
    `${bad.length} class/prc entries have non-canonical progression ` +
    `values:\n  ${bad.slice(0, 10).join('\n  ')}\n` +
    `BAB must be one of ${[...VALID_BAB]}; saves must be one of ${[...VALID_SAVE]}.`);
});

// ---- tests: save/load collector scoping ----------------------------------
//
// Real bug from 2026-05-15: `Feats.collectData()` was using a global
// `$$('.feat-entry')` selector, which also matched <div>s in the
// Companion tab that reuse the `feat-entry` styling class. Those <div>s
// have no `.value`, so the saved `feats` array gained `null` entries
// for every companion list — round-trip lost data and exports were
// polluted. The fix scopes the selector to `#feats-container`. These
// tests guard against the bug recurring, and against similar bugs
// being introduced in other collectors that share styling classes
// across unrelated panels.

function readSource(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

// Helper: extract a function body by name from a source string.
function extractFunctionBody(src, name) {
  // Match `function NAME(...args) {` … balanced braces … `}`.
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const brace = src.indexOf('{', start);
  if (brace < 0) return null;
  let depth = 1, i = brace + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    // Skip strings/comments crudely — adequate for current sources.
    else if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
    }
    i++;
  }
  return src.slice(brace + 1, i - 1);
}

// ---- tests: CharacterHistory substrate -----------------------------------
//
// Phase 1 of #3 — pure-data module. We test it in Node by evaluating
// character-history.js directly (it has no DOM / DB dependencies in
// the public API surface tested here).

function loadCharacterHistory() {
  const src = fs.readFileSync(path.join(ROOT, 'character-history.js'), 'utf8');
  // Eval in a sandbox so the module's top-level `const` binds locally
  // and we can return the public API to the caller.
  const fn = new Function(src + '\nreturn CharacterHistory;');
  return fn();
}

test('CharacterHistory: round-trip preserves the history array', () => {
  const CH = loadCharacterHistory();
  const hist = [
    { level: 1, class_taken: 'Wizard', hp_rolled: 4,
      feats_taken: ['Combat Casting'], skills_purchased: { Concentration: 4 },
      spells_learned: ['Magic Missile'], notes: '' },
    { level: 2, class_taken: 'Wizard', hp_rolled: 3,
      feats_taken: [], skills_purchased: { Concentration: 1 },
      spells_learned: ['Fly'], notes: '' },
  ];
  CH.set(hist, { reconstructed: false });
  const dumped = CH.collectData();
  assert(Array.isArray(dumped.history), 'collectData returns .history array');
  assert(dumped.history.length === 2, 'two entries round-tripped');
  assert(dumped.history[0].class_taken === 'Wizard', 'class preserved');
  assert(!dumped.history_reconstructed, 'reconstructed flag false');

  // Load on a fresh module instance
  const CH2 = loadCharacterHistory();
  CH2.loadData(dumped);
  assert(CH2.get().length === 2, 'loaded back 2 entries');
  assert(CH2.get()[1].spells_learned[0] === 'Fly', 'nested data preserved');
});

test('CharacterHistory: missing history triggers reconstruction with opts', () => {
  const CH = loadCharacterHistory();
  CH.loadData({}, {
    classes: [{ className: 'Druid', level: 5 }, { className: 'Beastmaster', level: 3 }],
    feats: ['Power Attack', 'Cleave', 'Improved Bull Rush'],
    options: { pathfinderFeats: false },
  });
  const h = CH.get();
  assert(h.length === 8, '8 levels reconstructed (Druid 5 + Beastmaster 3)');
  assert(h[0].class_taken === 'Druid', 'L1 is Druid');
  assert(h[5].class_taken === 'Beastmaster', 'L6 is Beastmaster');
  assert(h[7].class_taken === 'Beastmaster', 'L8 is Beastmaster');
  // Feats land at L1, L3, L6 (RAW schedule).
  assert(h[0].feats_taken.includes('Power Attack'), 'L1 feat slot');
  assert(h[2].feats_taken.includes('Cleave'), 'L3 feat slot');
  assert(h[5].feats_taken.includes('Improved Bull Rush'), 'L6 feat slot');
  assert(h.every(e => e._reconstructed === true),
    'all entries flagged _reconstructed');
  assert(CH.isReconstructed(), 'top-level reconstructed flag set');
});

test('CharacterHistory: reconstructFromTotals returns empty for unbuilt characters', () => {
  const CH = loadCharacterHistory();
  const h = CH.reconstructFromTotals([], []);
  assert(Array.isArray(h) && h.length === 0,
    'no classes = empty history (no fabricated L1)');
});

test('CharacterHistory: gestalt reconstruction records class_taken_b per level', () => {
  // Phase 2: with options.classesB, each level carries a second class and
  // the gestalt level count is max(SigmaA, SigmaB). HP uses the larger die.
  const CH = loadCharacterHistory();
  const h = CH.reconstructFromTotals(
    [{ className: 'Fighter', level: 6 }, { className: 'Rogue', level: 4 }],
    [],
    { classesB: [{ className: 'Wizard', level: 10 }],
      hitDieByClass: { Fighter: 10, Rogue: 6, Wizard: 4 } });
  assert(h.length === 10, 'gestalt level count = 10');
  assert(h[0].class_taken === 'Fighter' && h[0].class_taken_b === 'Wizard',
    'L1 = Fighter // Wizard');
  assert(h[6].class_taken === 'Rogue' && h[6].class_taken_b === 'Wizard',
    'L7 = Rogue // Wizard (Side A switched, Side B continues)');
  // L1 HP = larger die maxed: max(Fighter d10, Wizard d4) = 10.
  assert(h[0].hp_rolled === 10, 'L1 gestalt HP uses the larger die (d10)');
  // L7 HP average of larger die: max(Rogue d6, Wizard d4)=6 → ceil(7/2)=4.
  assert(h[6].hp_rolled === 4, 'L7 gestalt HP averages the larger die (d6)');
});

test('CharacterHistory: non-gestalt reconstruction omits class_taken_b', () => {
  // Byte-shape guard: without classesB, no entry gains the field, so
  // single-class saves keep their exact pre-gestalt shape.
  const CH = loadCharacterHistory();
  const h = CH.reconstructFromTotals([{ className: 'Wizard', level: 3 }], []);
  assert(h.length === 3, '3 levels');
  assert(h.every(e => !('class_taken_b' in e)),
    'no class_taken_b key on any non-gestalt entry');
});

test('feat-prereqs: gestalt snapshot maxes BAB across sides (not sum)', () => {
  // Phase 2c: a gestalt history with a martial Side A and caster Side B must
  // report BAB = max(SideA, SideB), NOT the sum. Fighter 5 // Wizard 5 →
  // BAB max(5, 2) = 5, and the class set includes both for class prereqs.
  // Inject a fake DB so getClassMetadata returns real BAB progressions.
  const fakeDB = {
    isLoaded: () => true,
    queryOne: (_sql, params) => {
      const n = String((params && params[0]) || '').toLowerCase();
      const bab = { fighter: 'good', wizard: 'poor', rogue: 'average' }[n] || null;
      return { bab, flavor: n === 'wizard' ? 'arcane' : null };
    },
  };
  const FP = loadFeatPrereqs({ DB: fakeDB });
  const hist = [];
  for (let i = 1; i <= 5; i++) {
    hist.push({ level: i, class_taken: 'Fighter', class_taken_b: 'Wizard',
      feats_taken: [], skills_purchased: {}, ability_boost: null });
  }
  const snap = FP.snapshotAtLevel(6, { history: hist,
    currentAbilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
    currentAlignment: 'true neutral' });
  assert(snap.bab === 5,
    `gestalt BAB should be max(Fighter5=+5, Wizard5=+2)=5, got ${snap.bab}`);
  const names = snap.classes.map(c => c.name).sort();
  assert(names.join(',') === 'Fighter,Wizard',
    `class set should include both sides, got ${names.join(',')}`);
  const wiz = snap.classes.find(c => c.name === 'Wizard');
  assert(wiz && wiz.level === 5, 'Wizard recorded at level 5 (Side B)');
});

test('CharacterHistory: get() normalizes empty to [] and hasLoaded() distinguishes', () => {
  // L3 (2026-05-17 play-feel): the previous get() returned null when
  // empty, forcing every caller to write `|| []`. Now empty always
  // reads as [] and hasLoaded() returns the never-loaded signal.
  const CH = loadCharacterHistory();
  assert(Array.isArray(CH.get()), 'get() returns an array even when empty');
  assert(CH.get().length === 0, 'initial get() is []');
  assert(CH.hasLoaded() === false, 'hasLoaded() is false before any set/load');
  CH.set([{ level: 1, class_taken: 'Wizard' }]);
  assert(CH.hasLoaded() === true, 'hasLoaded() is true after set');
  assert(CH.get().length === 1, 'get() returns the set entries');
  CH.clear();
  assert(CH.hasLoaded() === false, 'hasLoaded() reset by clear()');
  assert(CH.get().length === 0 && Array.isArray(CH.get()),
    'cleared get() is still [], not null');
});

test('CharacterHistory: pathfinder feat schedule covers odd levels', () => {
  const CH = loadCharacterHistory();
  const raw = CH.featLevels(false);
  const pf  = CH.featLevels(true);
  assert(JSON.stringify(raw) === JSON.stringify([1,3,6,9,12,15,18]),
    'RAW = L1, 3, 6, 9, 12, 15, 18');
  assert(JSON.stringify(pf) === JSON.stringify([1,3,5,7,9,11,13,15,17,19]),
    'Pathfinder = every odd level');
});

test('CharacterHistory: ability boost levels are L4/8/12/16/20', () => {
  const CH = loadCharacterHistory();
  for (let lvl = 1; lvl <= 20; lvl++) {
    const expected = (lvl % 4 === 0);
    assert(CH.isAbilityBoostLevel(lvl) === expected,
      `L${lvl}: expected boost=${expected}`);
  }
});

test('CharacterHistory: explicit history wins over reconstruction', () => {
  const CH = loadCharacterHistory();
  const hist = [{ level: 1, class_taken: 'Sorcerer', hp_rolled: 4,
                  feats_taken: [], skills_purchased: {},
                  spells_learned: [], notes: '' }];
  CH.loadData({ history: hist, history_reconstructed: false }, {
    // Even with reconstruction opts available, explicit history
    // should win and NOT trigger reconstruction.
    classes: [{ className: 'Wizard', level: 5 }],
    feats: ['Power Attack'],
  });
  assert(CH.get().length === 1, 'explicit history kept (not reconstructed)');
  assert(CH.get()[0].class_taken === 'Sorcerer', 'explicit class preserved');
  assert(!CH.isReconstructed(), 'reconstructed flag stays false');
});

// ---- tests: FeatPrereqs Phase B (history-aware) --------------------------
//
// Phase A checked feat prereqs against the current sheet state (post-
// build totals). Phase B rewinds to the state AT the level the feat
// was acquired, using CharacterHistory data, so the audit can flag
// "took Cleave before Power Attack" style ordering violations on
// *every* atom kind (BAB, ability, skill, classLevel, casterLevel,
// alignment, feat) — not just feat→feat.
//
// We load feat-prereqs.js in a Node sandbox with the bare-minimum
// DOM stubs so the IIFE evaluates cleanly; the helpers we exercise
// here (parse, snapshotAtLevel, evaluateAtLevel) don't touch the DOM
// when given an explicit `history` opt.

function loadFeatPrereqs(opts) {
  opts = opts || {};
  const src = fs.readFileSync(path.join(ROOT, 'feat-prereqs.js'), 'utf8');
  // The module references `window`, `document`, `DB`. We stub all of
  // them. `getClassMetadata` is the only DB-touching helper used by
  // snapshotAtLevel, and we let tests supply a fake meta map.
  const fakeWindow = { DB: opts.DB || null };
  const fakeDocument = {
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const fn = new Function('window', 'document', 'DB',
    src + '\nreturn FeatPrereqs;');
  return fn(fakeWindow, fakeDocument, opts.DB || undefined);
}

test('FeatPrereqs: parse extracts canonical atom kinds', () => {
  const FP = loadFeatPrereqs();
  const atoms = FP.parse('Str 13, BAB +1, Wizard level 5, Concentration 4 ranks, Chaotic alignment, Power Attack');
  const kinds = atoms.map(a => a.kind);
  assert(kinds.includes('ability'),     `missing ability atom: ${kinds.join(',')}`);
  assert(kinds.includes('bab'),         `missing bab atom: ${kinds.join(',')}`);
  assert(kinds.includes('classLevel'),  `missing classLevel atom: ${kinds.join(',')}`);
  assert(kinds.includes('skill'),       `missing skill atom: ${kinds.join(',')}`);
  assert(kinds.includes('alignment'),   `missing alignment atom: ${kinds.join(',')}`);
  assert(kinds.includes('feat'),        `missing feat atom: ${kinds.join(',')}`);
});

// ---- tests: FeatPrereqs parser-overreach family (2026-07-23) -------------
//
// A DB-wide audit of all 1912 feats with prereqs found the generic
// "<Name> level N" pattern swallowing 86 fragments that were never class
// levels, across 6 distinct families. Each rendered a confident, WRONG ✗
// ("no levels in Constitution"). The reported symptom was only the first
// family. These lock the whole set.

// ---- tests: class-level stacking feats (Swift Ambusher and kin) ----------
//
// Complete Scoundrel prints a worked example for each of these, which is
// real ground truth rather than my arithmetic — so the tests assert the
// book's own numbers.
function loadLevelStacking() {
  const src = readSource('class-level-stacking.js');
  return new Function(src + '\nreturn ClassLevelStacking;')();
}

test('ClassLevelStacking: reproduces the books\' worked examples', () => {
  const CLS = loadLevelStacking();
  const has = (...names) => (n) => names.includes(n);

  // Swift Ambusher — "a 4th-level scout / 7th-level rogue … as if she were
  // an 11th-level scout".
  let g = CLS.resolve([{ className: 'Scout', level: 4 }, { className: 'Rogue', level: 7 }],
                      has('Swift Ambusher'));
  assertEq(g.length, 1, 'Swift Ambusher grants exactly one boost');
  assertEq(g[0].target, 'Scout', 'targets Scout');
  assertEq(g[0].effectiveLevel, 11, 'scout 4 + rogue 7 = 11');
  assertEq(g[0].baseLevel, 4, 'base scout level is 4');

  // Swift Hunter — "a 4th-level scout / 1st-level ranger … as if she were a
  // 5th-level scout", AND favored enemies as a 5th-level ranger.
  g = CLS.resolve([{ className: 'Scout', level: 4 }, { className: 'Ranger', level: 1 }],
                  has('Swift Hunter'));
  assertEq(g.length, 2, 'Swift Hunter boosts two progressions');
  const scout = g.find(x => x.target === 'Scout');
  const ranger = g.find(x => x.target === 'Ranger');
  assertEq(scout.effectiveLevel, 5, 'skirmish as a 5th-level scout');
  assertEq(ranger.effectiveLevel, 5, 'favored enemy as a 5th-level ranger');

  // Daring Outlaw — "a 7th-level rogue / 4th-level swashbuckler … as if she
  // were an 11th-level swashbuckler", and sneak attack as an 11th-level rogue.
  g = CLS.resolve([{ className: 'Rogue', level: 7 }, { className: 'Swashbuckler', level: 4 }],
                  has('Daring Outlaw'));
  assertEq(g.length, 2, 'Daring Outlaw boosts swashbuckler AND rogue progressions');
  assertEq(g.find(x => x.target === 'Swashbuckler').effectiveLevel, 11, 'grace/dodge at 11');
  assertEq(g.find(x => x.target === 'Rogue').effectiveLevel, 11, 'sneak attack at 11');

  // Daring Warrior — "a 6th-level fighter / 5th-level swashbuckler".
  g = CLS.resolve([{ className: 'Fighter', level: 6 }, { className: 'Swashbuckler', level: 5 }],
                  has('Daring Warrior'));
  assertEq(g.length, 1, 'one boost (the fighter-prereq half isn\'t a feature tier)');
  assertEq(g[0].effectiveLevel, 11, 'as an 11th-level swashbuckler');
});

test('ClassLevelStacking: does nothing without the feat, the pair, or a gain', () => {
  const CLS = loadLevelStacking();
  const yes = () => true, no = () => false;
  const pair = [{ className: 'Scout', level: 4 }, { className: 'Rogue', level: 7 }];
  assertEq(CLS.resolve(pair, no).length, 0, 'no feat -> no boost');
  // Feat but only ONE of the two classes.
  assertEq(CLS.resolve([{ className: 'Scout', level: 4 }], yes).length, 0,
    'needs BOTH classes');
  // Level cap: class tables stop at 20.
  const capped = CLS.resolve(
    [{ className: 'Scout', level: 14 }, { className: 'Rogue', level: 14 }], yes);
  assertEq(capped.find(x => x.target === 'Scout').effectiveLevel, 20,
    'effective level is capped at 20');
  // Gestalt: the same class on both sides must not double.
  const gestalt = CLS.resolve(
    [{ className: 'Scout', level: 5 }, { className: 'Scout', level: 5 },
     { className: 'Rogue', level: 3 }], has => true);
  assertEq(gestalt.find(x => x.target === 'Scout').effectiveLevel, 8,
    'scout 5 (not 10) + rogue 3 = 8');
});

test('ClassLevelStacking: labelMatches is prefix-aligned, not substring', () => {
  const CLS = loadLevelStacking();
  assert(CLS.labelMatches('Sneak attack +6d6', ['sneak attack']), 'scaling suffix matches');
  assert(CLS.labelMatches('Skirmish (+3d6, +3 AC)', ['skirmish']), 'parenthetical matches');
  assert(CLS.labelMatches('Grace +2', ['grace']), 'grace matches');
  // The same trap the ACF matcher had: a different feature that merely
  // CONTAINS the stem must not match.
  assert(!CLS.labelMatches('Psionic sneak attack +2d6', ['sneak attack']),
    'psionic sneak attack is a DIFFERENT feature');
  assert(!CLS.labelMatches('Impromptu sneak attack 1/day', ['sneak attack']),
    'impromptu sneak attack is a different feature');
});

test('ClassLevelStacking: smite-evil feats are deliberately NOT modelled', () => {
  const CLS = loadLevelStacking();
  // The paladin class_table's `special` tracks smite evil USES/DAY, but every
  // feat that stacks levels for smite does so for the DAMAGE and explicitly
  // grants no extra uses. Substituting a higher paladin row would hand out
  // free daily smites, so these are listed as unmodelled instead.
  const names = CLS.CATALOG.map(c => c.name);
  for (const n of ['Ascetic Knight', 'Devoted Performer', 'Devoted Tracker',
                   'Initiate of Bahamut']) {
    assert(!names.includes(n), `${n} must NOT be in the substitution catalog`);
    assert(CLS.UNMODELLED.some(u => u.name === n), `${n} should be listed as unmodelled`);
  }
  // And the player is told about them rather than left guessing.
  const surfaced = CLS.unmodelledFor((n) => n === 'Devoted Tracker');
  assertEq(surfaced.length, 1, 'unmodelledFor surfaces a held feat');
  assert(/smite/i.test(surfaced[0].why), 'and explains why');
});

test('class-picker: level-stacking pairs base and boosted on the SAME feature', () => {
  // Regression: Daring Outlaw boosts grace AND the dodge bonus, and the
  // first implementation looked up the boosted row against the grant's whole
  // feature list — so "Grace +1" got paired with "Dodge bonus +2", showing
  // the right number attached to the wrong feature. The substitution must
  // resolve one stem at a time.
  const src = readSource('class-picker.js');
  const fn = src.match(/function applyLevelStacking[\s\S]*?\n  \}/);
  assert(fn, 'applyLevelStacking not found in class-picker.js');
  const body = fn[0];
  assert(/for \(const stem of g\.features\)/.test(body),
    'applyLevelStacking must iterate feature stems individually');
  // The lookups must both be scoped to the single stem, never the whole list.
  const matchCalls = body.match(/labelMatches\([^)]*\)/g) || [];
  assert(matchCalls.length >= 2, 'expected base and boosted lookups');
  for (const c of matchCalls) {
    assert(!/g\.features/.test(c),
      `labelMatches must not be called with the whole feature list: ${c}`);
  }
});

test('ClassLevelStacking: catalogued classes and features exist in the DB', (db) => {
  const CLS = loadLevelStacking();
  const problems = [];
  for (const entry of CLS.CATALOG) {
    // The feat itself must be a real feat.
    const feat = execAll(db,
      "SELECT 1 AS x FROM entry WHERE type='feat' AND name=? COLLATE NOCASE LIMIT 1",
      [entry.name]);
    if (!feat.length) problems.push(`feat "${entry.name}" not in DB`);
    for (const g of entry.grants) {
      const rows = execAll(db,
        "SELECT data FROM entry WHERE type IN ('class','prc') AND name=? " +
        "COLLATE NOCASE LIMIT 1", [g.target]);
      if (!rows.length) { problems.push(`class "${g.target}" not in DB`); continue; }
      let d; try { d = JSON.parse(rows[0].data); } catch (e) { continue; }
      const specials = (d.class_table || []).map(r => String(r.special || '').toLowerCase());
      for (const f of g.features) {
        // The feature must appear in `special` on MORE THAN ONE row —
        // a single row can't scale, so there'd be nothing to advance to.
        const n = specials.filter(s => s.includes(f)).length;
        if (n < 2) {
          problems.push(`${entry.name}: "${f}" appears on ${n} row(s) of ` +
                        `${g.target}'s table — nothing to advance`);
        }
      }
    }
  }
  assert(problems.length === 0, 'catalog / DB mismatches:\n  ' + problems.join('\n  '));
});

// ---- tests: spell-addition catalogs resolve to REAL spells ---------------
//
// The catalog is hand-typed from book text, and its own header says the
// names must match exactly or the picker datalist and the ⓘ rules lookup
// both silently miss. A typo produces a Known row that looks right and
// resolves to nothing, so check every name against the DB.
function loadSpellAdditions() {
  const src = readSource('class-spell-additions.js');
  return new Function(src + '\nreturn ClassSpellAdditions;')();
}

test('ClassSpellAdditions: Mother Cyst grants the necrotic cyst spells 1-9', () => {
  const CSA = loadSpellAdditions();
  const feats = CSA.getFeatFeatures('Mother Cyst');
  assert(feats.length === 1, `expected 1 feature, got ${feats.length}`);
  const byLevel = feats[0].spellsByLevel;
  // Libris Mortis p.26: one spell per level except 2nd, which has two.
  for (let l = 1; l <= 9; l++) {
    assert(Array.isArray(byLevel[l]) && byLevel[l].length,
      `Mother Cyst should grant a spell at level ${l}`);
  }
  assertEq(byLevel[2].length, 2, '2nd level grants two spells (cyst + scrying)');
  assertEq(byLevel[1][0], 'Necrotic Awareness', '1st is Necrotic Awareness');
  assertEq(byLevel[9][0], 'Necrotic Termination', '9th is Necrotic Termination');
  assert(CSA.featNames().includes('Mother Cyst'), 'featNames lists Mother Cyst');
});

test('ClassSpellAdditions: every catalogued spell name exists in the DB', (db) => {
  const CSA = loadSpellAdditions();
  const known = new Set(
    execAll(db, "SELECT DISTINCT LOWER(name) AS n FROM entry WHERE type='spell'")
      .map(r => r.n));
  const missing = [];
  const checkFeature = (owner, f) => {
    for (const [lvl, spells] of Object.entries(f.spellsByLevel || {})) {
      for (const s of spells) {
        if (!known.has(String(s).toLowerCase())) {
          missing.push(`${owner} L${lvl}: "${s}"`);
        }
      }
    }
  };
  // Feat catalog (new) AND the pre-existing class catalog — same failure
  // mode, so cover both rather than only the code I just added.
  for (const fn of CSA.featNames()) {
    for (const f of CSA.getFeatFeatures(fn)) checkFeature(fn, f);
  }
  for (const cls of ['Sand Shaper']) {
    for (const f of CSA.getFeatures(cls)) checkFeature(cls, f);
  }
  assert(missing.length === 0,
    `catalogued spells with no DB entry (typo?):\n  ${missing.join('\n  ')}`);
});

// ---- tests: ItemBonuses — always-on bonuses read off an item name --------
//
// The feature's value is entirely in what it DECLINES to fill. A DB-wide
// survey found 680 of 4475 items carrying a "+N <type> bonus" phrase, but
// most are situational ("+6 circumstance bonus on Escape Artist checks made
// when the wearer is bound"). Filling those silently inflates the sheet, so
// most of these tests assert null.
function loadItemBonuses(db) {
  const src = readSource('item-bonuses.js');
  const stubDB = db ? {
    isLoaded: () => true,
    queryOne: (sql, params) => {
      const rows = execAll(db, sql, params);
      return rows.length ? rows[0] : null;
    },
  } : undefined;
  const factory = new Function('window', 'DB',
    src + '\nreturn ItemBonuses;');
  return factory({}, stubDB);
}

test('ItemBonuses: name-scaled families fill the right boxes', () => {
  const IB = loadItemBonuses();
  const cloak = IB.forItem('Cloak of Resistance +2');
  assert(cloak && cloak.saves, 'Cloak of Resistance +2 should yield save bonuses');
  assertEq(cloak.saves.fort, 2, 'fort +2');
  assertEq(cloak.saves.will, 2, 'will +2');
  assertEq(cloak.saves.type, 'resistance', 'typed as resistance');

  const ring = IB.forItem('Ring of Protection +1');
  assertEq(ring.ac[0].type, 'Deflection', 'ring of protection is deflection');
  assertEq(ring.ac[0].ac, 1, '+1');
  assert(ring.ac[0].touch === true, 'deflection applies against touch attacks');

  // Natural armor must beat the bare "armor" test.
  const amulet = IB.forItem('Amulet of Natural Armor +3');
  assertEq(amulet.ac[0].type, 'Natural Armor', 'amulet is natural armor');
  assert(amulet.ac[0].touch === false, 'natural armor does NOT apply to touch AC');

  const bracers = IB.forItem('Bracers of Armor +4');
  assertEq(bracers.ac[0].type, 'Armor', 'bracers grant an armor bonus');

  // Abilities, including the flavour synonyms books/homebrew actually use.
  assertEq(IB.forItem('Headband of Intellect +4').abilities.INT, 4, 'INT +4');
  assertEq(IB.forItem('Circlet of Intelligence +2').abilities.INT, 2,
    'the synonym spelling should work too');
  assertEq(IB.forItem('Belt of Giant Strength +6').abilities.STR, 6, 'STR +6');
  assertEq(IB.forItem('Periapt of Wisdom +2').abilities.WIS, 2, 'WIS +2');
  assertEq(IB.forItem('Cloak of Charisma +4').abilities.CHA, 4, 'CHA +4');
  assertEq(IB.forItem('Amulet of Health +2').abilities.CON, 2, 'CON +2');
  assertEq(IB.forItem('Gloves of Dexterity +2').abilities.DEX, 2, 'DEX +2');
  // Fixed-magnitude item: the name carries no +N.
  assertEq(IB.forItem('Gauntlets of Ogre Power').abilities.STR, 2,
    'gauntlets of ogre power are a flat +2 STR');
});

test('ItemBonuses: declines anything it cannot read as always-on', () => {
  const IB = loadItemBonuses();
  const shouldBeNull = [
    '',                              // empty
    'Rope, silk (50 ft.)',           // mundane gear
    'Sharkskin Armor',               // real item, but its bonus is situational
    'Boots of Elvenkind',            // skill bonus, but conditional in text
    'Cloak of Resistance',           // family match with NO magnitude given
    'Ring of Protection',            // ditto
    'Sword of Wounding +2',          // weapon enhancement, not a worn bonus
    'Bag of Holding',
    'Ioun Stone (Dark Blue)',        // grants a FEAT, not a numeric bonus
  ];
  for (const n of shouldBeNull) {
    assertEq(IB.forItem(n), null, `"${n}" should not auto-fill`);
  }
});

test('ItemBonuses: splitPlus handles the ways players write a magnitude', () => {
  const IB = loadItemBonuses();
  assertEq(IB.splitPlus('Cloak of Resistance +2').plus, 2, 'trailing +2');
  assertEq(IB.splitPlus('Cloak of Resistance +2').base, 'Cloak of Resistance', 'base name');
  assertEq(IB.splitPlus('+1 Ring of Protection').plus, 1, 'leading +1');
  assertEq(IB.splitPlus('Cloak of Resistance, +5').plus, 5, 'comma before the +N');
  assertEq(IB.splitPlus('Bag of Holding').plus, null, 'no magnitude -> null');
});

test('ItemBonuses: parses the DMG Ioun Stone table (Pale Green)', (db) => {
  const IB = loadItemBonuses(db);
  // "+1 competence bonus on attack rolls, saves, skill checks, and ability
  // checks" — read from the structured table, not restated in the module.
  const pg = IB.forItem('Pale Green Ioun Stone');
  assert(pg, 'Pale Green Ioun Stone should resolve');
  assertEq(pg.attack, 1, '+1 to attack rolls');
  assert(pg.saves && pg.saves.fort === 1, '+1 on saves');
  assertEq(pg.saves.type, 'competence', 'competence-typed');
  assert(pg.skills.length === 1 && pg.skills[0].amount === 1, '+1 on skill checks');
  assert(/ability check/i.test(pg.notes), 'ability checks surface as a note');
  // NEGATIVE assertions — the first pass wrote a phantom "+1 Competence AC"
  // because "attack rolls" contains the letters "ac" and the target test was
  // a bare substring match. Asserting only what SHOULD be filled misses that
  // entirely, so pin what must NOT be.
  assertEq(pg.ac.length, 0, 'the pale green stone grants NO AC bonus');
  assertEq(pg.abilities, null, 'and no ability bonus');
  assert(!/\band\b/.test(pg.notes),
    `the note should not carry a leading conjunction, got "${pg.notes}"`);
  // Colour matching must prefer the LONGEST colour, so "pale green" never
  // resolves as a bare "green"-ish row, and the ability stones still work.
  assertEq(IB.forItem('Ioun Stone (Deep Red)').abilities.DEX, 2, 'deep red = +2 DEX');
  assertEq(IB.forItem('Dusty Rose Ioun Stone').ac[0].type, 'Insight',
    'dusty rose = +1 insight AC');
});

test('ItemBonuses: parseEffectPhrase reads the DMG phrasing', () => {
  const IB = loadItemBonuses();
  const e = IB.parseEffectPhrase(
    '+1 competence bonus on attack rolls, saves, skill checks, and ability checks');
  assertEq(e.amount, 1, 'amount');
  assertEq(e.type, 'competence', 'type');
  assert(e.targets.length === 4, `4 targets, got ${e.targets.length}`);
  assertEq(IB.parseEffectPhrase('Alertness (as the feat)'), null,
    'a non-numeric effect yields null');
});

// ---- tests: class-feature replacement matching (2026-07-23) --------------
//
// Two reports, two opposite failures in the same pair of functions:
//   * Scout's Dungeon Specialist replaces "fast movement", which dedups to
//     its L11 tier, sorts past the 8-item display cap, and was never checked.
//   * Kobold Rogue replaces "improved uncanny dodge" and struck the base
//     "uncanny dodge" too, because the old matcher accepted a token that
//     merely CONTAINED the label anywhere.
//
// class-picker.js is a 5k-line module that wires DOM listeners at load, so
// rather than sandbox the whole thing we lift the matcher out of the real
// source text and exercise that. It's the shipped code, not a copy.
function loadFindReplacement() {
  const src = readSource('class-picker.js');
  const grab = (re, what) => {
    const m = src.match(re);
    if (!m) throw new Error(`could not lift ${what} out of class-picker.js`);
    return m[0];
  };
  const parts = [
    grab(/function alignsAsPrefix\s*\([\s\S]*?\n  \}/, 'alignsAsPrefix'),
    grab(/const TIER_QUALIFIER\s*=[\s\S]*?;/, 'TIER_QUALIFIER'),
    grab(/function isTierUpgradeOf\s*\([\s\S]*?\n  \}/, 'isTierUpgradeOf'),
    grab(/function findReplacement\s*\([\s\S]*?\n  \}/, 'findReplacement'),
  ];
  return new Function(parts.join('\n') + '\nreturn findReplacement;')();
}

test('class-picker: a replaced feature matches its scaling tier label', () => {
  const findReplacement = loadFindReplacement();
  const map = new Map([['fast movement', { kind: 'ACF', name: 'Dungeon Specialist' }]]);
  // The cumulative list renders the DEDUPED highest tier, so the label
  // carries a numeric suffix the ACF's `replaces` text never mentions.
  for (const label of ['fast movement', 'fast movement +10 ft.', 'fast movement +20 ft.']) {
    const hit = findReplacement(label, map);
    assert(hit && hit.name === 'Dungeon Specialist',
      `"${label}" should match the "fast movement" token, got ${JSON.stringify(hit)}`);
  }
  // "Bonus feat ×2" is the other shape the dedup produces.
  const bf = new Map([['bonus feat', { kind: 'ACF', name: 'X' }]]);
  assert(findReplacement('Bonus feat ×2'.toLowerCase(), bf), 'bonus feat ×2 should match');
});

test('class-picker: an "improved X" token does NOT strike the base "X"', () => {
  const findReplacement = loadFindReplacement();
  // Kobold Rogue replaces Improved Uncanny Dodge only. The rogue KEEPS
  // plain Uncanny Dodge — striking both was the reported bug.
  const map = new Map([['improved uncanny dodge', { kind: 'Sub Level', name: 'Kobold Rogue' }]]);
  assert(findReplacement('improved uncanny dodge', map),
    'the replaced feature itself must still match');
  assert(!findReplacement('uncanny dodge', map),
    'base "uncanny dodge" must NOT be struck by an "improved uncanny dodge" token');
  assert(!findReplacement('dodge', map),
    'bare "dodge" must NOT be struck either');
});

test('class-picker: replacing a base feature DOES strike its tier upgrades', () => {
  const findReplacement = loadFindReplacement();
  // Lose Rage and you lose Greater/Mighty/Tireless Rage; lose Favored Enemy
  // and you lose the 2nd/3rd picks. A closed qualifier list, because the
  // leading word is usually what makes a feature distinct.
  const rage = new Map([['rage', { kind: 'ACF', name: 'Berserker Strength' }]]);
  for (const l of ['rage', 'greater rage', 'mighty rage', 'tireless rage']) {
    assert(findReplacement(l, rage), `"${l}" should be struck when rage is replaced`);
  }
  const fe = new Map([['favored enemy', { kind: 'ACF', name: 'Urban Ranger' }]]);
  for (const l of ['1st favored enemy', '2nd favored enemy', '5th favored enemy']) {
    assert(findReplacement(l, fe), `"${l}" should be struck when favored enemy is replaced`);
  }
});

test('class-picker: accidental substrings never count as a replacement', () => {
  const findReplacement = loadFindReplacement();
  // Every one of these was a real DB-wide false positive under the old
  // bidirectional-substring matcher.
  const cases = [
    ['rage',         'fly 50 ft. (average)'],   // "ave-RAGE-"
    ['rage',         'inspire courage +1'],     // "cou-RAGE"
    ['turn',         'returning attacks'],      // "re-TURN-ing"
    ['armor',        '+3 natural armor'],       // natural armor ≠ armor prof.
    ['weapon',       'breath weapon (4d6)'],
    ['familiar',     'weapon familiarity'],
    ['sneak attack', 'psionic sneak attack +1d6'],
    ['wild shape',   'undead wild shape 1/day'],
    ['trap sense',   'teamwork trap sense +1'],
    ['suggestion',   'mass suggestion'],
    ['uncanny dodge','armored uncanny dodge'],
  ];
  for (const [token, label] of cases) {
    const map = new Map([[token, { kind: 'ACF', name: 'T' }]]);
    assert(!findReplacement(label, map),
      `token "${token}" must NOT strike "${label}"`);
  }
});

test('class-picker: the longest matching token wins', () => {
  const findReplacement = loadFindReplacement();
  // Both tokens are live; "improved uncanny dodge" must claim its own label
  // rather than losing it to the shorter, also-present "uncanny dodge".
  const map = new Map([
    ['uncanny dodge',          { kind: 'ACF', name: 'Short' }],
    ['improved uncanny dodge', { kind: 'ACF', name: 'Long' }],
  ]);
  assertEq(findReplacement('improved uncanny dodge', map).name, 'Long',
    'the more specific token should win');
  assertEq(findReplacement('uncanny dodge', map).name, 'Short',
    'the base label still resolves to the base token');
});

test('FeatPrereqs: "Character level 6th" is a characterLevel atom, not a class', () => {
  const FP = loadFeatPrereqs();
  for (const text of ['Character level 6th', 'character level 3rd']) {
    const atoms = FP.parse(text);
    assert(atoms.length === 1 && atoms[0].kind === 'characterLevel',
      `"${text}" should parse as characterLevel, got ` +
      atoms.map(a => a.kind).join(','));
  }
  assert(FP.parse('Character level 6th')[0].level === 6, 'level should be 6');
  // ...and it must still evaluate against the character level, not a class.
  const st = { characterLevel: 7, classes: [], abilities: {}, featNames: new Set(),
               skillRanks: new Map(), bab: 0, alignment: '',
               casterLevels: { arcane: 0, divine: 0, psionic: 0, any: 0 } };
  assert(FP.check(FP.parse('Character level 6th'), st).atoms[0].status === 'satisfied',
    'character level 7 should satisfy "Character level 6th"');
});

test('FeatPrereqs: a parenthesised prereq checks the SPECIALIZATION', () => {
  const FP = loadFeatPrereqs();
  // 51 DB feats name a parenthesised Focus as a prerequisite. Every one
  // reported "?" before, because "Spell Focus (conjuration)" is not a feat
  // name in the DB — the feat is "Spell Focus" with a specialization.
  const state = (...feats) => {
    const s = { abilities: {}, classes: [], featNames: new Set(),
                featSpecs: new Map(), skillRanks: new Map(), bab: 0,
                alignment: '', characterLevel: 5,
                casterLevels: { arcane: 0, divine: 0, psionic: 0, any: 0 } };
    for (const f of feats) FP.recordFeat(s, f);
    return s;
  };
  const check = (prereq, st) => FP.check(FP.parse(prereq), st).atoms[0];

  const right = check('Spell Focus (conjuration)', state('Spell Focus (Conjuration)'));
  assertEq(right.status, 'satisfied', 'the matching specialization satisfies it');

  // The crux: having the feat in a DIFFERENT school must NOT satisfy it.
  const wrong = check('Spell Focus (conjuration)', state('Spell Focus (Evocation)'));
  assertEq(wrong.status, 'unmet', 'a different school does not satisfy it');
  assert(/evocation/i.test(wrong.detail),
    `detail should say what they actually have, got "${wrong.detail}"`);

  // Not taken at all — reported against the real feat name, not "unknown".
  const none = check('Spell Focus (conjuration)', state('Power Attack'));
  assertEq(none.status, 'unmet', 'not taken at all is unmet');
  assert(/Spell Focus/i.test(none.detail), 'names the base feat');

  // A choice list is satisfied by ANY of its options.
  const choice = check('Weapon Focus (warhammer or light hammer)',
                       state('Weapon Focus (light hammer)'));
  assertEq(choice.status, 'satisfied', 'either option counts');

  // An unspecialized entry doesn't silently satisfy a specialized prereq.
  const bare = check('Spell Focus (conjuration)', state('Spell Focus'));
  assertEq(bare.status, 'unmet', 'no specialization chosen is not satisfied');

  // Plain (non-parenthesised) prereqs still behave as before.
  assertEq(check('Power Attack', state('Power Attack')).status, 'satisfied',
    'unspecialized prereqs unaffected');
});

test('FeatPrereqs: spelled-out ability names normalize to the 3-letter key', () => {
  const FP = loadFeatPrereqs();
  const want = { Strength: 'STR', Dexterity: 'DEX', Constitution: 'CON',
                 Intelligence: 'INT', Wisdom: 'WIS', Charisma: 'CHA' };
  for (const [long, short] of Object.entries(want)) {
    const atoms = FP.parse(`${long} 13`);
    assert(atoms.length === 1 && atoms[0].kind === 'ability',
      `"${long} 13" should be an ability atom, got ${atoms.map(a => a.kind)}`);
    assert(atoms[0].ability === short,
      `"${long}" should normalize to ${short}, got ${atoms[0].ability}`);
  }
  // The abbreviation must keep working (alternation is left-biased, so the
  // long forms are listed first — "Str" must not strand "ength 13").
  assert(FP.parse('Str 13')[0].ability === 'STR', 'Str 13 still parses');
});

test('FeatPrereqs: "spellcaster level N" routes to casterLevel', () => {
  const FP = loadFeatPrereqs();
  const cases = [
    ['Caster level 5th',            'any'],
    ['Spellcaster level 11th+',     'any'],
    ['arcane spellcaster level 7th','arcane'],
    ['divine spellcaster level 3+', 'divine'],
    ['manifester level 3rd',        'any'],
  ];
  for (const [text, flavor] of cases) {
    const atoms = FP.parse(text);
    assert(atoms.length === 1 && atoms[0].kind === 'casterLevel',
      `"${text}" should be casterLevel, got ${atoms.map(a => a.kind)}`);
    assert(atoms[0].flavor === flavor,
      `"${text}" flavor should be ${flavor}, got ${atoms[0].flavor}`);
  }
});

test('FeatPrereqs: cast/manifest-spells phrasing variants all parse', () => {
  const FP = loadFeatPrereqs();
  const cases = [
    ['ability to cast 3rd-level arcane spells',              3, 'arcane'],
    ['ability to spontaneously cast 2nd-level arcane spells',2, 'arcane'],
    ['able to cast 9th-level divine spells',                 9, 'divine'],
    ['Able to cast 1st-level spells',                        1, 'any'],
    ['ability to cast 9th-level arcane or divine spells',    9, 'arcane'],
    ['ability to cast 2nd-level or higher arcane spells',    2, 'arcane'],
    ['ability to manifest 9th-level powers',                 9, 'psionic'],
    ['ability to manifest at least one 9th-level power',     9, 'psionic'],
    ['ability to manifest 2nd-level psionic powers',         2, 'psionic'],
  ];
  for (const [text, level, flavor] of cases) {
    const atoms = FP.parse(text);
    assert(atoms.length === 1 && atoms[0].kind === 'castSpells',
      `"${text}" should be castSpells, got ${atoms.map(a => a.kind)}`);
    assert(atoms[0].level === level && atoms[0].flavor === flavor,
      `"${text}" → L${atoms[0].level} ${atoms[0].flavor}, want L${level} ${flavor}`);
  }
});

test('FeatPrereqs: "A or B" alternation becomes an anyOf atom', () => {
  const FP = loadFeatPrereqs();
  const atoms = FP.parse('Spell Focus (evocation) or evoker level 1st');
  assert(atoms.length === 1 && atoms[0].kind === 'anyOf',
    `should be one anyOf atom, got ${atoms.map(a => a.kind)}`);
  assert(atoms[0].options.map(o => o.kind).join('|') === 'feat|classLevel',
    `branches should be feat|classLevel, got ` +
    atoms[0].options.map(o => o.kind).join('|'));
  // Satisfied if EITHER branch is.
  const st = { characterLevel: 1, classes: [{ name: 'Evoker', level: 1 }],
               abilities: {}, featNames: new Set(), skillRanks: new Map(),
               bab: 0, alignment: '',
               casterLevels: { arcane: 0, divine: 0, psionic: 0, any: 0 } };
  assert(FP.check(atoms, st).atoms[0].status === 'satisfied',
    'evoker 1 should satisfy the alternation via the classLevel branch');
});

test('FeatPrereqs: alternation never splits inside a parenthetical', () => {
  const FP = loadFeatPrereqs();
  // "Weapon Focus (warhammer or light hammer)" is ONE feat with a choice
  // inside it. A naive split yields the mangled pair
  // ["Weapon Focus (warhammer", "light hammer)"] — data destruction.
  const atoms = FP.parse('Weapon Focus (warhammer or light hammer)');
  assert(atoms.length === 1, `should stay one atom, got ${atoms.length}`);
  assert(atoms[0].kind === 'feat', `should be a feat atom, got ${atoms[0].kind}`);
  assert(atoms[0].raw === 'Weapon Focus (warhammer or light hammer)',
    `raw text must survive intact, got "${atoms[0].raw}"`);
});

test('FeatPrereqs: alternation is declined when a branch does not parse', () => {
  const FP = loadFeatPrereqs();
  // These "or"s are inside one requirement, not between two. Splitting
  // just doubles the "?" chips (or invents a feat name).
  for (const text of ['sneak attack +2d6 or sudden strike +2d6',
                      'size Large or larger',
                      'lay on hands or wholeness of body class feature']) {
    const atoms = FP.parse(text);
    assert(atoms.length === 1 && atoms[0].kind !== 'anyOf',
      `"${text}" should NOT split, got ${atoms.map(a => a.kind).join(',')}`);
  }
});

test('FeatPrereqs: a leading "or " is stripped from a comma-split fragment', () => {
  const FP = loadFeatPrereqs();
  // "Crusader, Swordsage, or Warblade level 1+" splits on commas, leaving
  // a third fragment that parsed as a class literally named "or Warblade".
  const atoms = FP.parse('Crusader, Swordsage, or Warblade level 1+');
  const cl = atoms.find(a => a.kind === 'classLevel');
  assert(cl, `expected a classLevel atom, got ${atoms.map(a => a.kind).join(',')}`);
  assert(cl.className === 'Warblade',
    `className should be "Warblade", got "${cl.className}"`);
});

test('FeatPrereqs: an unknown class name degrades to "?" not a wrong "✗"', () => {
  // The generic "<Name> level N" pattern also swallows "Fly speed 90",
  // "Leadership score 25", "essentia pool 2", "Meldshaper level 9th".
  // Reporting ✗ "no levels in Fly speed" is confidently wrong.
  const fakeDB = {
    isLoaded: () => true,
    query: () => [{ n: 'fighter' }, { n: 'wizard' }],
    queryOne: () => null,
  };
  const FP = loadFeatPrereqs({ DB: fakeDB });
  const st = { characterLevel: 5, classes: [], abilities: {},
               featNames: new Set(), skillRanks: new Map(), bab: 0,
               alignment: '',
               casterLevels: { arcane: 0, divine: 0, psionic: 0, any: 0 } };
  const bogus = FP.check(FP.parse('Fly speed 90'), st).atoms[0];
  assert(bogus.status === 'unknown',
    `unknown "class" should be unknown, got ${bogus.status}`);
  // A REAL class the character lacks must still report unmet.
  const real = FP.check(FP.parse('Fighter level 6th'), st).atoms[0];
  assert(real.status === 'unmet',
    `a real class with no levels should stay unmet, got ${real.status}`);
});

test('FeatPrereqs: snapshotAtLevel falls back to live snapshot when history is empty', () => {
  // Phase B contract: if no history is supplied (or it's empty),
  // snapshotAtLevel returns the present-tense snapshot — so existing
  // callers without history still work in legacy / unreconstructed
  // characters.
  const FP = loadFeatPrereqs();
  const s = FP.snapshotAtLevel(5, { history: [] });
  // Live snapshot uses our stub document → everything defaults to 0/empty.
  assert(s && typeof s === 'object', 'snapshotAtLevel returned an object');
  assert(s.abilities && typeof s.abilities === 'object',
    'has abilities map');
  assert(s.classes && Array.isArray(s.classes), 'has classes array');
  assert(s.featNames instanceof Set, 'has featNames Set');
  assert(s.skillRanks instanceof Map, 'has skillRanks Map');
  // No DOM = no caster panels = no caster levels.
  assert(s.casterLevels.any === 0, 'casterLevels.any is 0 (no DOM)');
});

test('FeatPrereqs: snapshotAtLevel cumulates classes through the target level (inclusive)', () => {
  const FP = loadFeatPrereqs();
  const history = [
    { level: 1, class_taken: 'Fighter', feats_taken: [], skills_purchased: {} },
    { level: 2, class_taken: 'Fighter', feats_taken: [], skills_purchased: {} },
    { level: 3, class_taken: 'Wizard',  feats_taken: [], skills_purchased: {} },
    { level: 4, class_taken: 'Wizard',  feats_taken: [], skills_purchased: {} },
  ];
  // At L3 the character has Fighter 2 + Wizard 1 — the Wizard taken
  // AT this level COUNTS, because class is locked in before feats.
  const s3 = FP.snapshotAtLevel(3, { history, currentAbilities: {
    STR:10,DEX:10,CON:10,INT:10,WIS:10,CHA:10 } });
  const fighter3 = s3.classes.find(c => c.name === 'Fighter');
  const wizard3  = s3.classes.find(c => c.name === 'Wizard');
  assert(fighter3 && fighter3.level === 2, `Fighter L2 expected, got ${fighter3 && fighter3.level}`);
  assert(wizard3 && wizard3.level === 1,   `Wizard L1 expected, got ${wizard3 && wizard3.level}`);
});

test('FeatPrereqs: snapshotAtLevel excludes feats taken AT or AFTER the target level', () => {
  // The whole point: a level-3 feat must not be able to satisfy its
  // own prereq, and we must miss future feats too.
  const FP = loadFeatPrereqs();
  const history = [
    { level: 1, class_taken: 'Fighter', feats_taken: ['Power Attack'],
      skills_purchased: {} },
    { level: 3, class_taken: 'Fighter', feats_taken: ['Cleave', 'Improved Bull Rush'],
      skills_purchased: {} },
    { level: 6, class_taken: 'Fighter', feats_taken: ['Great Cleave'],
      skills_purchased: {} },
  ];
  const s3 = FP.snapshotAtLevel(3, { history, currentAbilities: {
    STR:14,DEX:10,CON:10,INT:10,WIS:10,CHA:10 } });
  assert(s3.featNames.has('power attack'),
    'L1 Power Attack should be visible at L3');
  assert(!s3.featNames.has('cleave'),
    'L3 Cleave must NOT be visible at L3 (we check BEFORE this-level feats)');
  assert(!s3.featNames.has('improved bull rush'),
    'L3 Improved Bull Rush must NOT be visible at L3');
  assert(!s3.featNames.has('great cleave'),
    'L6 Great Cleave must NOT be visible at L3');
});

test('FeatPrereqs: snapshotAtLevel cumulates skills from prior levels only', () => {
  const FP = loadFeatPrereqs();
  const history = [
    { level: 1, class_taken: 'Rogue', feats_taken: [],
      skills_purchased: { Tumble: 4, Hide: 4 } },
    { level: 2, class_taken: 'Rogue', feats_taken: [],
      skills_purchased: { Tumble: 1, Hide: 1 } },
    { level: 3, class_taken: 'Rogue', feats_taken: ['Combat Reflexes'],
      skills_purchased: { Tumble: 1 } },
  ];
  const s3 = FP.snapshotAtLevel(3, { history, currentAbilities: {
    STR:10,DEX:14,CON:10,INT:10,WIS:10,CHA:10 } });
  // At L3 we see L1+L2 ranks (5 in Tumble, 5 in Hide). The L3 rank
  // (purchased AFTER feats) doesn't count.
  assert(s3.skillRanks.get('tumble') === 5,
    `Tumble should be 5 (L1=4 + L2=1), got ${s3.skillRanks.get('tumble')}`);
  assert(s3.skillRanks.get('hide') === 5,
    `Hide should be 5, got ${s3.skillRanks.get('hide')}`);
});

test('FeatPrereqs: snapshotAtLevel subtracts ability boosts at level >= N', () => {
  const FP = loadFeatPrereqs();
  // Build: STR boost at L4 + L8. Current totals reflect both.
  const history = [
    { level: 1, class_taken: 'Fighter', feats_taken: [], skills_purchased: {} },
    { level: 4, class_taken: 'Fighter', feats_taken: [], skills_purchased: {},
      ability_boost: 'STR' },
    { level: 8, class_taken: 'Fighter', feats_taken: [], skills_purchased: {},
      ability_boost: 'STR' },
  ];
  const current = { STR: 16, DEX: 10, CON: 12, INT: 10, WIS: 10, CHA: 10 };
  // At L4 (the boost-feat-? whatever — feat is picked BEFORE boost on
  // the same level), STR should be 16 - 2 (both boosts subtracted) = 14.
  const s4 = FP.snapshotAtLevel(4, { history, currentAbilities: current });
  assert(s4.abilities.STR === 14,
    `STR at L4 (pre-L4-boost): expected 14, got ${s4.abilities.STR}`);
  // At L5, we're past the L4 boost but before the L8 one — STR = 16 - 1 = 15.
  const s5 = FP.snapshotAtLevel(5, { history, currentAbilities: current });
  assert(s5.abilities.STR === 15,
    `STR at L5 (post-L4, pre-L8): expected 15, got ${s5.abilities.STR}`);
  // At L9, both boosts have been applied — STR = current = 16.
  const s9 = FP.snapshotAtLevel(9, { history, currentAbilities: current });
  assert(s9.abilities.STR === 16,
    `STR at L9 (post-both-boosts): expected 16, got ${s9.abilities.STR}`);
});

test('FeatPrereqs: snapshotAtLevel derives BAB from cumulative class levels', () => {
  // Without DB, getClassMetadata returns nulls and BAB comes out as 0.
  // With DB stubbed, we can drive the formula directly.
  const fakeDB = {
    isLoaded: () => true,
    queryOne: (sql, params) => {
      // The query asks for $.bab_progression and $.spellcasting.class_type.
      const name = params[0];
      const META = {
        'Fighter': { bab: 'good',    flavor: null },
        'Wizard':  { bab: 'poor',    flavor: 'arcane' },
        'Cleric':  { bab: 'average', flavor: 'divine' },
      };
      const m = META[name];
      if (!m) return null;
      return { bab: m.bab, flavor: m.flavor };
    },
  };
  const FP = loadFeatPrereqs({ DB: fakeDB });
  const history = [
    { level: 1, class_taken: 'Fighter', feats_taken: [], skills_purchased: {} },
    { level: 2, class_taken: 'Fighter', feats_taken: [], skills_purchased: {} },
    { level: 3, class_taken: 'Fighter', feats_taken: [], skills_purchased: {} },
    { level: 4, class_taken: 'Wizard',  feats_taken: [], skills_purchased: {} },
  ];
  // At L4 cumulative is Fighter 3 / Wizard 1 → BAB = 3 (full) + 0 (poor L1) = 3.
  const s4 = FP.snapshotAtLevel(4, { history, currentAbilities: {
    STR:10,DEX:10,CON:10,INT:10,WIS:10,CHA:10 } });
  assert(s4.bab === 3, `BAB at L4 expected 3, got ${s4.bab}`);
  assert(s4.casterLevels.arcane === 1,
    `arcane CL at L4 expected 1, got ${s4.casterLevels.arcane}`);
  assert(s4.casterLevels.any === 1,
    `any-flavor CL at L4 expected 1, got ${s4.casterLevels.any}`);
});

test('FeatPrereqs: evaluateAtLevel flags an unmet feat-order violation', () => {
  // End-to-end: parse + history-aware snapshot + check. Models the
  // classic "took Cleave at L1, but Power Attack wasn't taken until
  // L3" mistake.
  const FP = loadFeatPrereqs();
  const history = [
    { level: 1, class_taken: 'Fighter', feats_taken: ['Cleave', 'Weapon Focus'],
      skills_purchased: {} },
    { level: 3, class_taken: 'Fighter', feats_taken: ['Power Attack'],
      skills_purchased: {} },
  ];
  const result = FP.evaluateAtLevel('Power Attack', 1,
    { history, currentAbilities: {
      STR:13,DEX:10,CON:10,INT:10,WIS:10,CHA:10 } });
  const featAtom = result.atoms.find(a => a.kind === 'feat');
  assert(featAtom, 'parse extracted a feat atom');
  assert(featAtom.status === 'unmet',
    `expected feat prereq unmet at L1, got ${featAtom.status}`);
});

test('FeatPrereqs: evaluateAtLevel flags an ability-boost-order violation', () => {
  // STR 13 prereq, current STR = 14, but L4 boost is what got us
  // there. At L4 the boost hasn't applied yet → STR is 13 (which
  // satisfies). At L1 (no boosts subtracted from 14 = 14)... wait,
  // both should pass. Let me test a stricter case: STR 15 prereq at
  // L4, current = 14 + L4 boost = 15. At L4, pre-boost STR is 14.
  const FP = loadFeatPrereqs();
  const history = [
    { level: 1, class_taken: 'Fighter', feats_taken: [], skills_purchased: {} },
    { level: 3, class_taken: 'Fighter', feats_taken: ['Power Attack'],
      skills_purchased: {} },
    { level: 4, class_taken: 'Fighter',
      feats_taken: ['Improved Sunder'],  // prereq Str 15
      skills_purchased: {}, ability_boost: 'STR' },
  ];
  // Current STR = 15 (after L4 boost).
  const result = FP.evaluateAtLevel('Str 15, Power Attack', 4,
    { history, currentAbilities: {
      STR:15,DEX:10,CON:10,INT:10,WIS:10,CHA:10 } });
  const strAtom = result.atoms.find(a => a.kind === 'ability');
  assert(strAtom, 'parse extracted ability atom');
  assert(strAtom.status === 'unmet',
    `expected STR 15 unmet at L4 (pre-boost STR=14), got ${strAtom.status}`);
  // Power Attack atom should be SATISFIED — taken at L3, before L4.
  const featAtom = result.atoms.find(a => a.kind === 'feat');
  assert(featAtom && featAtom.status === 'satisfied',
    `Power Attack should be satisfied at L4 (taken L3), got ${featAtom && featAtom.status}`);
});

test('audit.js: checkFeatPrereqOrder uses FeatPrereqs.evaluateAtLevel + emits all-atom violations', () => {
  // Structural guard. The new audit code path must:
  //   (a) Call FeatPrereqs.evaluateAtLevel (not the legacy iteration).
  //   (b) Emit issues for non-feat atom kinds — ability, bab, skill,
  //       classLevel, casterLevel, castSpells, alignment.
  //   (c) Preserve the same-level feat-prereq downgrade to 'info'.
  const src = readSource('audit.js');
  // The old path was `if (taken_at[need] > e.level)` — pure feat-only.
  // The new path delegates to FeatPrereqs.evaluateAtLevel.
  assert(/FeatPrereqs\.evaluateAtLevel/.test(src),
    'audit.js: checkFeatPrereqOrder does not call ' +
    'FeatPrereqs.evaluateAtLevel — Phase B (history-aware checking) ' +
    'is not wired.');
  // We should look at every atom kind, not just feat.
  const KINDS = ['ability', 'bab', 'skill', 'classLevel',
                 'casterLevel', 'castSpells', 'alignment'];
  for (const k of KINDS) {
    assert(new RegExp(`['"]${k}['"]`).test(src),
      `audit.js: no mention of atom kind '${k}' — non-feat prereq ` +
      `violations won't surface in the audit panel.`);
  }
  // Same-level feat-prereq downgrade — confirm we still emit info.
  assert(/prereq-same-level/.test(src),
    "audit.js: same-level feat-prereq downgrade ID 'prereq-same-level' " +
    "missing — same-level Power Attack + Cleave would error spuriously.");
});

// ---- tests: window.X guard pattern ---------------------------------------
//
// Top-level `const Foo = (function(){...})()` creates a script-scope
// binding, NOT a property of `window`. Cross-module guards that use
// `if (window.Foo)` silently early-return because Foo is undefined on
// window — same bug fixed three separate times in feats.js,
// feat-picker.js, and companion.js. The audit walks every JS file and
// flags any `window.X` reference where X is a known top-level module
// that doesn't explicitly assign to window.
test('audit: no window.X guards on top-level const modules', () => {
  // Modules confirmed to assign to window (these are safe to reference
  // as window.X). Add any new explicit-window-assignment modules here.
  const ON_WINDOW = new Set([
    'DB', 'ClassPicker', 'ErrataBadge', 'Lookup', 'MetamagicCatalog',
    'MetamagicPreparer', 'ItemFamiliar',
    // Built-in / non-module references that should never trigger:
    'document', 'requestAnimationFrame', 'localStorage', 'location',
  ]);
  // Top-level `const` modules that are NOT on window — referencing
  // these via window.X is the bug we're guarding against.
  const TOP_LEVEL_CONSTS = [
    'DND35', 'Skills', 'Character', 'Equipment', 'Spells', 'Feats',
    'Companion', 'ClassFeatures', 'Conditions', 'Audit', 'FeatPrereqs',
    'Shadowcaster',
  ];
  const rx = new RegExp(`\\bwindow\\.(${TOP_LEVEL_CONSTS.join('|')})\\b`, 'g');
  const offenders = [];
  for (const file of fs.readdirSync(ROOT)) {
    if (!file.endsWith('.js')) continue;
    if (file.startsWith('.')) continue;
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    let m;
    while ((m = rx.exec(src)) !== null) {
      // Skip explicit `window.X = ...` assignments (we already vetted
      // the assignment list above).
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const lineEnd = src.indexOf('\n', m.index);
      const line = src.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
      if (/window\.\w+\s*=\s*[^=]/.test(line)) continue;
      offenders.push(`${file}: ${line.trim()}`);
    }
  }
  assert(offenders.length === 0,
    `${offenders.length} window.<topLevelConst> reference(s) found ` +
    `(these always evaluate to undefined and silently fail):\n  ` +
    offenders.join('\n  ') + '\n' +
    `Replace with \`typeof X !== 'undefined'\` guard or move the ` +
    `module to explicit window assignment (and add to ON_WINDOW set).`);
});

test('save: Feats.collectData scopes .feat-entry to its container', () => {
  const src = readSource('feats.js');
  const body = extractFunctionBody(src, 'collectData');
  assert(body, "Couldn't extract Feats.collectData body");
  // Disallow the unscoped global pattern.
  assert(!/\$\$\(\s*['"]\.feat-entry['"]\s*\)/.test(body),
    "Feats.collectData uses a global `$$('.feat-entry')` selector. " +
    "That accidentally matches the companion tab's `.feat-entry` " +
    "styling <div>s and pollutes the saved `feats` array with nulls. " +
    "Scope to #feats-container instead.");
  // Disallow the same for special abilities.
  assert(!/\$\$\(\s*['"]\.special-ability-entry['"]\s*\)/.test(body),
    "Feats.collectData uses a global `$$('.special-ability-entry')` " +
    "selector. Scope to #special-abilities-container.");
  // Require evidence of scoping — either a container query or the
  // querySelector('#feats-container') pattern.
  assert(
    /#feats-container/.test(body) || /featsRoot/.test(body),
    "Feats.collectData should reference #feats-container to scope its " +
    "`.feat-entry` query."
  );
});

test('save: Character ability-to-AC list is scoped, RAW-typed, and migrates legacy keys', () => {
  const src = readSource('character.js');

  // --- collectData: new array key, scoped to its container -------------
  const collect = extractFunctionBody(src, 'collectData');
  assert(collect, "Couldn't extract Character.collectData body");
  assert(/ability-ac-bonuses/.test(collect),
    "Character.collectData must persist ability-to-AC rows under the " +
    "'ability-ac-bonuses' array key.");
  assert(/#ability-ac-list\s+\.ability-ac-row/.test(collect),
    "Character.collectData must scope its ability-ac row query to " +
    "#ability-ac-list (an unscoped global `.ability-ac-row` is brittle).");

  // --- loadData: forward-migrate the pre-2026-06-20 fixed toggle keys ---
  // Old saves stored con/int/wis/cha-to-ac booleans + -to-ac-type strings
  // (e.g. bean_uisce's cha-to-ac:true / Deflection). Dropping the
  // migration would silently wipe an in-play character's bonus.
  const load = extractFunctionBody(src, 'loadData');
  assert(load, "Couldn't extract Character.loadData body");
  assert(/ability-ac-bonuses/.test(load) && /-to-ac-type/.test(load) &&
         /-to-ac\b/.test(load),
    "Character.loadData must migrate the legacy con/int/wis/cha-to-ac " +
    "toggle keys into the dynamic ability-ac list.");

  // --- recalc: reads the list, gives Natural Armor RAW touch semantics -
  // (recalc has a `bonuses = {}` default param, which defeats the brace-
  // matched body extractor, so these patterns are asserted against the
  // full source — they're unique to the recalc area regardless.)
  assert(/#ability-ac-list\s+\.ability-ac-row/.test(src),
    "Character.recalc must read ability-to-AC bonuses from the dynamic " +
    "#ability-ac-list rows (not the removed con/int/wis/cha-to-ac checkboxes).");
  assert(/touch:\s*!isNatural/.test(src),
    "Character.recalc must treat 'Natural Armor' ability-to-AC bonuses as " +
    "touch:false (natural armor never applies against touch attacks).");
  // The removed per-ability checkbox read must be gone.
  assert(!/-to-ac['"`]\s*\)\s*\?\.checked/.test(src),
    "Character.recalc still reads the removed `#<ab>-to-ac` checkboxes.");
  // Natural-armor ability bonuses set to STACK must route through the
  // additive accumulators (an "increase to natural armor"), not just the
  // highest-applies bucket. Guards the stack toggle's whole point.
  assert(/STACKING_TYPES\.includes\(item\.type\)\s*\|\|\s*item\.stacks/.test(src),
    "Character.recalc must sum `item.stacks` natural-armor bonuses (the " +
    "stack toggle) alongside the always-stacking dodge/circumstance/untyped types.");
  assert(/stacks\s*=\s*isNatural\s*&&/.test(src),
    "Character.recalc must only let Natural Armor rows stack (stacks flag " +
    "gated on isNatural).");
});

test('save: Spells invocation collector saves invoList rows + migrates legacy', () => {
  const src = readSource('spells.js');
  const collect = extractFunctionBody(src, 'collectData');
  assert(collect, "Couldn't extract Spells.collectData body");
  // Known invocations are structured rows now (mirroring Spells Known):
  // the collector must read .invo-known-list rows into invoList-<grade>
  // arrays + persist invoClass. A stale .invo-text textarea collector
  // would silently drop every known invocation (the textareas are gone).
  assert(/invoList-/.test(collect) && /invo-known-list/.test(collect),
    "Spells.collectData must save invocation rows as invoList-<grade> arrays.");
  assert(!/invo-text/.test(collect),
    "Spells.collectData still references the removed .invo-text textareas.");
  assert(/invoClass/.test(collect),
    "Spells.collectData must persist invoClass (per-class picker filter).");
  // Pre-Phase-3 saves: buildInvocationLists must migrate the legacy
  // invo-<grade> textarea string (split per line) when no invoList array.
  const build = extractFunctionBody(src, 'buildInvocationLists');
  assert(build && /invoList-/.test(build) && /split\(/.test(build),
    "buildInvocationLists must migrate the legacy invo-<grade> textarea string.");
});

test('save: companion.js still uses .feat-entry as a styling class', () => {
  // Sanity check that this collision still exists — the companion
  // module reuses the styling. If someone renames it the test above
  // becomes less interesting (and we can simplify); flag the rename.
  const src = readSource('companion.js');
  assert(
    /feat-entry/.test(src),
    "companion.js no longer references `feat-entry` — the Feats " +
    "collector scoping is no longer needed for the documented reason. " +
    "Update the comment in feats.js#collectData."
  );
});

test('save: Equipment gear readers scope to .gear-row (skip rules panels)', () => {
  // The Possessions ⓘ button inserts a collapsible item-rules panel as
  // a sibling <tr class="gear-rules-row"> that carries NO .gear-* inputs.
  // If the gear collector iterates an unscoped `#gear-body tr`, an open
  // panel row matches and `row.querySelector('.gear-name').value` throws
  // mid-save — crashing collectData and losing the character. The
  // collector must scope to `tr.gear-row`.
  const eq = readSource('equipment.js');
  const body = extractFunctionBody(eq, 'collectData');
  assert(body, "Couldn't extract Equipment.collectData body");
  assert(!/\$\$\(\s*['"]#gear-body tr['"]\s*\)/.test(body),
    "Equipment.collectData iterates an unscoped `$$('#gear-body tr')`. " +
    "An open item-rules panel row (tr.gear-rules-row) has no .gear-name " +
    "input, so `.gear-name.value` throws during save. Scope to " +
    "`#gear-body tr.gear-row`.");
  assert(/#gear-body tr\.gear-row/.test(body),
    "Equipment.collectData should iterate `#gear-body tr.gear-row` so " +
    "the collapsible rules-panel rows are skipped.");
  // The weight readers (equipment.js recalcWeight + character.js
  // encumbrance) use optional chaining so they're crash-safe, but are
  // also scoped to .gear-row for clarity + future-proofing.
  assert(/#gear-body tr\.gear-row/.test(eq),
    "equipment.js recalcWeight should scope its gear-weight scan to " +
    "`#gear-body tr.gear-row`.");
  // character.js no longer scans gear at all (2026-08-22): encumbrance reads
  // Equipment.carriedWeight(), so the scoping requirement applies to the one
  // scan that remains. Asserted as an ABSENCE here, and as a positive in
  // 'rebuild-killer: the load category and the displayed total are ONE calc'.
  const ch = readSource('character.js');
  assert(!/\$\$\(\s*['"]#gear-body tr['"]\s*\)/.test(ch),
    "character.js must not iterate gear rows — an unscoped scan would " +
    "match the rules-panel rows, and it should not be scanning at all.");
});

test('feats: Special Abilities ⓘ resolves creature abilities (renderCreatureAbilityRules)', () => {
  // The Special Abilities ⓘ dispatcher must include the creature
  // resolver. The creature-race-picker writes the creature's name into
  // #char-race (its canonical Race field, which persists), so both the
  // racial and creature resolvers key off #char-race. Racial runs FIRST
  // (real races are the common case); pure monsters aren't in the `race`
  // table, so racial returns null and the creature resolver takes over.
  const f = readSource('feats.js');
  assert(/function renderCreatureAbilityRules/.test(f),
    "feats.js must define renderCreatureAbilityRules.");
  const creatureBody = extractFunctionBody(f, 'renderCreatureAbilityRules');
  assert(creatureBody && /char-race/.test(creatureBody) &&
      !/char-creature-race/.test(creatureBody),
    "renderCreatureAbilityRules must key off #char-race (not the transient " +
    "#char-creature-race input, which the picker clears after apply).");
  assert(/type='creature'/.test(creatureBody) &&
      /special_abilities/.test(creatureBody),
    "renderCreatureAbilityRules must query the creature's special_abilities.");
  const dispatch = extractFunctionBody(f, 'renderAbilityRules');
  assert(dispatch, "Couldn't extract renderAbilityRules body");
  const creatureAt = dispatch.indexOf('renderCreatureAbilityRules');
  const racialAt = dispatch.indexOf('renderRacialTraitRules');
  assert(creatureAt !== -1 && racialAt !== -1,
    "renderAbilityRules must call both the creature and racial resolvers.");
  assert(racialAt < creatureAt,
    "renderAbilityRules must try the racial resolver BEFORE the creature " +
    "resolver (real races are the common case; pure-monster names fall " +
    "through to the creature resolver).");
});

test('save: every UI module exposes collectData + loadData', () => {
  // DERIVED from app.js, not hand-listed. The previous version carried a
  // literal array of seven filenames and a comment promising to "catch the case
  // where a new module is added without persistence" — which it could not do,
  // because catching a NEW module required somebody to remember to add it to
  // the list. conditions.js, bloodline.js and defense-riders.js were all wired
  // into app.js and none of them were ever covered.
  //
  // Same failure shape as a schema field that is required and read by nothing:
  // the check exists, it passes, and it is not looking at the thing it names.
  // Deriving the list from app.js's own collectData/loadData bodies makes it
  // self-maintaining — wiring a module in is what puts it under the guard.
  const src = readSource('app.js');
  const collectBody = extractFunctionBody(src, 'collectData');
  const loadBody = extractFunctionBody(src, 'loadData');
  assert(collectBody && loadBody, "Couldn't extract app.js collectData/loadData");

  // PascalCase module global -> kebab-case filename (ClassFeatures ->
  // class-features.js). Holds for every module in the project.
  const fileFor = (name) =>
    name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase() + '.js';

  const wired = new Set();
  for (const body of [collectBody, loadBody]) {
    for (const m of body.matchAll(/\b([A-Z][A-Za-z0-9]+)\.(?:collect|load)[A-Za-z]*\s*\(/g)) {
      wired.add(m[1]);
    }
  }
  assertGE(wired.size, 10, `expected app.js to wire 10+ modules, found ${wired.size}`);

  const missing = [];
  for (const mod of wired) {
    const file = fileFor(mod);
    if (!fs.existsSync(path.join(ROOT, file))) {
      missing.push(`${mod}: no ${file} (naming convention broken?)`);
      continue;
    }
    const modSrc = readSource(file);
    if (!/function collectData\s*\(/.test(modSrc)) missing.push(`${file}: collectData`);
    if (!/function loadData\s*\(/.test(modSrc)) missing.push(`${file}: loadData`);
  }
  assert(missing.length === 0,
    `Missing persistence functions:\n  ${missing.join('\n  ')}`);
});

test('save: companion compType options have explicit value= attrs', () => {
  // Regression guard for the 2026-05-17 round-trip bug. Pre-fix,
  // the <option>s had no `value` attribute, so `.value` returned the
  // option's display text ("Animal Companion"), while the build
  // template compared against lowercase keys ("animal"). Saved
  // Familiars/Cohorts/Psicrystals reloaded silently as Animal
  // Companion. The fix: explicit `value="animal"` etc. on each
  // option. This test guards against accidental removal.
  const src = readSource('companion.js');
  for (const key of ['animal', 'familiar', 'cohort', 'psicrystal', 'other']) {
    assert(
      new RegExp(`<option value="${key}"`).test(src),
      `companion.js: <option value="${key}"...> is missing. Without ` +
      `explicit value attrs, saved companion types reload as the ` +
      `first option (silent data loss). See normalizeCompType for ` +
      `the migration path.`
    );
  }
  // Also guard that the migration helper exists — old saves with
  // display-text compType need normalization.
  assert(/function normalizeCompType\s*\(/.test(src),
    'companion.js: normalizeCompType migration helper is missing. ' +
    'Without it, old saves with display-text compType silently ' +
    'reload as Animal Companion.');
});

test('save: character attack calculator persists calc fields', () => {
  // Regression guard for the 2026-06-27 weapon attack-bonus calculator.
  // Each attack row's BAB+size+ability+other calculator stores three
  // fields (calcAbility / calcMisc / calcAuto). They must round-trip via
  // collectData, and the build template (addAttack) must read them back —
  // else a saved auto-filled attack reloads with the wrong ability or
  // silently loses its fill-bonus toggle (regressing to a free-text bonus).
  const src = readSource('character.js');
  for (const f of ['calcAbility', 'calcMisc', 'calcAuto']) {
    assert(new RegExp(`${f}:\\s*entry\\.querySelector`).test(src),
      `character.js: collectData does not persist attack ${f} ` +
      `(expected "${f}: entry.querySelector(...)").`);
  }
  assert(/data\.calcAbility/.test(src) && /data\.calcMisc/.test(src) &&
         /data\.calcAuto/.test(src),
    'character.js: addAttack template does not restore ' +
    'calcAbility/calcMisc/calcAuto from the saved blob — collected ' +
    'fields would be silently dropped on load.');
});

test('save: skills load by name with a frozen legacy-index fallback', () => {
  // 2026-07-01: DND35.skills was alphabetized + 9 supplemental skills added.
  // Saves historically key skills by ARRAY INDEX, so the load path switched
  // to NAME-based resolution with LEGACY_SKILL_ORDER as an index fallback for
  // pre-existing (nameless) saves. A regression here silently corrupts every
  // saved character's skill ranks.
  const sk = readSource('skills.js');
  const dat = readSource('data.js');

  // collectData must emit name (regular) + baseName (subtype) so NEW saves
  // are order-independent.
  assert(/entry\.name\s*=\s*getRowSkillName/.test(sk),
    'skills.js collectData no longer emits `name` on skill entries — new ' +
    'saves would fall back to brittle index resolution.');
  assert(/entry\.baseName\s*=\s*row\.dataset\.subtypeOf/.test(sk),
    'skills.js collectData no longer emits `baseName` on subtype entries — ' +
    'Craft/Perform/Profession subtypes would misgroup after a reorder.');

  // loadData must fall back to LEGACY_SKILL_ORDER[index] for old saves.
  assert(/LEGACY_SKILL_ORDER\[[^\]]*index[^\]]*\]/.test(sk),
    'skills.js loadData no longer falls back to LEGACY_SKILL_ORDER[index] — ' +
    'old index-only saves would not migrate onto the reordered array.');

  // LEGACY_SKILL_ORDER must stay FROZEN in the OLD index order (supplements
  // at the END), NOT re-sorted to match the now-alphabetical live array. If
  // someone regenerates it from DND35.skills, every legacy save corrupts.
  const legMatch = sk.match(/const\s+LEGACY_SKILL_ORDER\s*=\s*\[([\s\S]*?)\]/);
  assert(legMatch, 'skills.js: LEGACY_SKILL_ORDER constant not found.');
  const legNames = legMatch[1].match(/"([^"]+)"/g).map(s => s.slice(1, -1));
  assert(legNames.length === 54,
    `LEGACY_SKILL_ORDER has ${legNames.length} entries, expected 54 ` +
    '(45 original + 9 supplemental). Do not shrink or re-sort it.');
  const iUseRope = legNames.indexOf('Use Rope');
  const iAuto = legNames.indexOf('Autohypnosis');
  assert(iUseRope > -1 && iAuto > iUseRope,
    'LEGACY_SKILL_ORDER must stay in ORIGINAL index order (Use Rope before ' +
    'the appended Autohypnosis). It appears re-sorted to the alphabetical ' +
    'live order — this silently corrupts every legacy save. It is a frozen ' +
    'historical key, never the live order.');

  // Sanity: the live array IS alphabetical (Autohypnosis precedes Use Rope) —
  // i.e. genuinely distinct from the frozen legacy order.
  assert(dat.indexOf('name: "Autohypnosis"') < dat.indexOf('name: "Use Rope"'),
    'data.js DND35.skills is no longer alphabetical (Autohypnosis should ' +
    'precede Use Rope).');
});

test('skills: structured bonuses auto-create Craft/Perform/Profession subtypes', () => {
  // 2026-07-01: a race/feat/template bonus to a SPECIFIC Craft/Perform/
  // Profession subtype (Gnome "+2 Craft (alchemy)") only lands if a matching
  // subtype row exists. skills.js.recalc calls syncBonusSubtypes to create the
  // row on demand and reconcile it away when the source is gone; class-picker
  // ticks a matching specific subtype as a class skill. Guard both hooks.
  const sk = readSource('skills.js');
  assert(/function syncBonusSubtypes\s*\(/.test(sk),
    'skills.js: syncBonusSubtypes helper missing — specific Craft/Perform/' +
    'Profession bonuses would have no row to land on.');
  assert(/function ensureBonusSubtypeRow\s*\(/.test(sk),
    'skills.js: ensureBonusSubtypeRow helper missing.');
  assert(/syncBonusSubtypes\(directBonusKeys\)/.test(sk),
    'skills.js: recalc no longer calls syncBonusSubtypes(directBonusKeys) — ' +
    'auto subtype rows would never be created/reconciled.');
  assert(/data-auto-bonus-subtype|autoBonusSubtype/.test(sk),
    'skills.js: auto-created subtype rows are no longer tagged, so reconcile ' +
    'cannot distinguish them from user rows (would delete user data or leak).');

  const cp = readSource('class-picker.js');
  assert(/\^\(Craft\|Perform\|Profession\)\\s\*\\\(/.test(cp),
    'class-picker.js: findSkillCheckboxesForSpec lost its specific ' +
    'Craft/Perform/Profession subtype branch — a class granting ' +
    '"Craft (alchemy)" would not tick the matching subtype row.');
});

test('traits: DB carries structured bonuses + the sheet consumes them', (db) => {
  // 2026-07-01: UA traits/flaws gained hand-verified structured `bonuses`
  // (skill/save/ac/initiative) in the DB; trait-picker.js applies them via the
  // shared categorizers, wired into skills/app/character. Guard all layers.
  // (a) DB: trait/flaw rows carry bonuses.
  const r = execOne(db,
    "SELECT COUNT(*) AS n FROM entry WHERE type IN ('trait','flaw') "
    + "AND json_extract(data,'$.bonuses') IS NOT NULL");
  assert(r.n >= 30, `expected >=30 trait/flaw entries with structured bonuses, got ${r.n}`);
  // (b) picker exposes the four aggregator feeds.
  const tp = readSource('trait-picker.js');
  for (const m of ['getActiveSkillBonuses', 'getActiveSaveBonuses',
                   'getActiveACBonuses', 'getActiveInitiativeBonuses']) {
    assert(new RegExp(m).test(tp), `trait-picker.js missing ${m}`);
  }
  assert(/return api/.test(tp) && /window\.TraitPicker = api/.test(tp),
    'trait-picker.js: the IIFE must RETURN its api (const TraitPicker = IIFE) — '
    + 'otherwise the const shadows window.TraitPicker as undefined and every '
    + 'consumer silently skips it.');
  // (c) consumers wire TraitPicker in.
  assert(/traitSkill/.test(readSource('skills.js')),
    'skills.js no longer folds in TraitPicker.getActiveSkillBonuses (traitSkill).');
  const app = readSource('app.js');
  assert(/TraitPicker.*getActiveSaveBonuses/.test(app) && /TraitPicker.*getActiveACBonuses/.test(app),
    'app.js collectActiveBonuses no longer aggregates TraitPicker save/AC bonuses.');
  assert(/window\.recalcAll = recalcAll/.test(app),
    'app.js no longer exposes window.recalcAll — external pickers (trait/template) '
    + 'call it to trigger a recalc; without it their apply() does nothing.');
  // 2026-07-05: the trait init scalar was upgraded to the typed initiative
  // onion — app.js aggregates TraitPicker.getActiveInitiativeBonuses into
  // bonuses.initiativeTyped and character.js stacks the whole list.
  assert(/TraitPicker.*getActiveInitiativeBonuses/.test(app),
    'app.js collectActiveBonuses no longer aggregates TraitPicker initiative bonuses.');
  assert(/initiativeTyped/.test(readSource('character.js')),
    'character.js initiative no longer stacks bonuses.initiativeTyped.');
});

test('item-picker: base armors classify as equip-able under the canonical category', (db) => {
  // 2026-06-23 category canonicalization collapsed "Light/Medium/Heavy
  // Armor" to plain "Armor" (weight class moved to tags) — classifyItem's
  // old regex stopped matching, so every base armor lost its + Equip Armor
  // button (H3 playfeel red, found 2026-07-05). Pin both layers.
  const r = execOne(db,
    "SELECT json_extract(data,'$.category') AS cat, "
    + "type AS kind "
    + "FROM entry WHERE name='Chainmail' AND type='armor'");
  assertEq(r.kind, 'armor', 'Chainmail routes off the type column (entry_kind retired 2026-08-05)');
  assertEq(r.cat, 'Armor', 'canonical category is plain "Armor"');
  const ip = readSource('item-picker.js');
  assert(/cat === 'armor'\s*\|\|\s*\/light armor\|medium armor\|heavy armor\//.test(ip),
    "classifyItem must accept the canonical 'Armor' category alongside the legacy spellings");
});

test('class-picker: Binder max-vestige seeds from the walk-reshaped special column', (db) => {
  // The ToM re-walk dropped the legacy top-level `max_vestige_level` row
  // field — the ordinal now lives verbatim inside `special` ("…; Maximum
  // Vestige Level 3rd"). SA2 playfeel red (found 2026-07-05). Pin the DB
  // shape + the parser fallback.
  const r = execOne(db,
    "SELECT json_extract(data,'$.class_table[4].special') AS sp, "
    + "json_extract(data,'$.class_table[4].max_vestige_level') AS legacy "
    + "FROM entry WHERE name='Binder' AND type='class'");
  assert(/maximum vestige level\s+3/i.test(r.sp),
    'Binder L5 special must carry "Maximum Vestige Level 3rd"');
  assertEq(r.legacy, null, 'legacy top-level field is gone (walk reshape)');
  const cp = readSource('class-picker.js');
  assert(/maximum vestige level\\s\+\(\\d\+\)/.test(cp),
    'populateBinderPanelCounts must parse the special-column fallback');
});

test('pickers: spell-adjacent tag-filter parity', () => {
  // 2026-06-27 parity pass: the spell-adjacent pickers gain the spell-picker's
  // multi-tag chip filter (via the shared PickerTagFilter helper) + a
  // VersionBadge in their info panel. The shared helper must be registered in
  // the load order (before the pickers) and export attach + parseLevel.
  const idx = readSource('index.html');
  assert(/picker-tag-filter\.js/.test(idx),
    'index.html: picker-tag-filter.js is not in the script load list.');
  const helper = readSource('picker-tag-filter.js');
  assert(/window\.PickerTagFilter\s*=\s*\{[\s\S]*attach[\s\S]*parseLevel/.test(helper),
    'picker-tag-filter.js: must export { attach, parseLevel }.');
  // Each picker that has reached parity wires the tag filter + VersionBadge.
  // Extend this list as each picker is upgraded.
  const DONE = ['vestige-picker.js', 'invocation-picker.js', 'mystery-picker.js',
                'maneuver-picker.js', 'power-picker.js'];
  for (const f of DONE) {
    const src = readSource(f);
    assert(/PickerTagFilter\.attach\(/.test(src),
      `${f}: no PickerTagFilter.attach call — tag filter missing.`);
    assert(/VersionBadge/.test(src),
      `${f}: info panel does not render a VersionBadge.`);
  }
  // Regression for the silent-injection bug found 2026-06-27: mystery groups
  // are nested in .shadowcaster-2col (NOT direct panel children), so
  // `panel.insertBefore(wrap, firstGroup)` threw NotFoundError and the
  // MutationObserver swallowed it — the picker never appeared. It must insert
  // relative to the group's actual parent.
  const myp = readSource('mystery-picker.js');
  assert(!/panel\.insertBefore\(\s*wrap\s*,\s*firstGroup\s*\)/.test(myp),
    'mystery-picker.js: reverted to panel.insertBefore(wrap, firstGroup) — '
    + 'firstGroup is inside .shadowcaster-2col, not a panel child, so this '
    + 'throws and the picker silently never injects.');
  assert(/anchorParent\.insertBefore/.test(myp),
    'mystery-picker.js: lost the anchorParent-relative insert.');
});

test('sla: ⓘ panel renders spell rules via Spells.renderSpellRules', () => {
  // The SLA sub-tab's per-row ⓘ panel reuses the Spells-Known rules formatter
  // so the two stay identical. No persisted state (the panel is transient) so
  // no save guard — but the cross-module contract is fragile: if spells.js
  // stops exporting renderSpellRules the panel silently degrades to
  // "unavailable". Guard the export + the call + the wiring.
  const spells = readSource('spells.js');
  assert(/^\s*renderSpellRules,\s*$/m.test(spells),
    'spells.js: renderSpellRules is no longer in the exports object — the ' +
    'SLA ⓘ panel falls back to "Spell rules unavailable".');
  const sla = readSource('sla.js');
  assert(/Spells\.renderSpellRules\(/.test(sla),
    'sla.js: the ⓘ panel no longer calls Spells.renderSpellRules.');
  assert(/sla-info/.test(sla) && /toggleSlaRules/.test(sla),
    'sla.js: the ⓘ button (.sla-info) or its toggle (toggleSlaRules) is gone.');
});

test('save: feats special-ability class-origin marker round-trips', () => {
  // Regression guard for the 2026-06-27 "applying a class re-adds ALL its
  // features" duplication bug. class-picker stamps auto-added class features
  // with data-from-class so a later level-up dedupes its own entries; but
  // Feats.collectData saved only input.value, dropping the marker — so loaded
  // class features lost the tag and the next apply re-added the cumulative set
  // on top. Fix: persist { text, fromClass } + restore the marker, plus a
  // text-prefix dedup backstop in class-picker for pre-fix saves.
  const feats = readSource('feats.js');
  assert(/dataset\.fromClass/.test(feats) && /fromClass\s*\?\s*\{\s*text/.test(feats),
    'feats.js: collectData no longer persists the special-ability fromClass ' +
    'marker ({ text, fromClass }) — class features will duplicate on re-apply ' +
    'after a save/load.');
  assert(/addSpecialAbility\(\s*a\.text[^)]*a\.fromClass/.test(feats),
    'feats.js: loadData does not pass fromClass back into addSpecialAbility.');
  assert(/function addSpecialAbility\(\s*text\s*=\s*""\s*,\s*fromClass/.test(feats),
    'feats.js: addSpecialAbility no longer accepts a fromClass argument.');
  const cp = readSource('class-picker.js');
  assert(/startsWith\(prefix\)/.test(cp) &&
         /const prefix = `\[\$\{className\} `/.test(cp),
    'class-picker.js: populateSpecialAbilities lost the "[<Class> " text-' +
    'prefix dedup backstop — legacy saves (no marker) will still duplicate.');
});

test('save: class-picker persists data-from-class markers', () => {
  // Regression guard for the 2026-05-17 fix. setIfEmpty stamps a
  // `data-from-class="<className>"` marker on auto-filled fields
  // (turn-per-day, rage-rounds, etc.). Pre-fix, the marker was
  // dropped on save, so a class removed after a save/load cycle
  // couldn't clean its auto-fills. The fix: collectData emits
  // `_fromClassMarkers: {fieldId: className}`; loadData restores.
  const src = readSource('class-picker.js');
  assert(/_fromClassMarkers/.test(src),
    'class-picker.js: _fromClassMarkers field is missing from the ' +
    'Character.collectData/loadData hook. Without it, fields ' +
    'auto-filled by class-picker survive save/load but lose their ' +
    'origin tag, so a future class-remove leaves them as stale data.');
  // Specifically check both directions.
  const hook = src.slice(src.indexOf('installPersistenceHooks'));
  assert(/markers\s*\[\s*el\.id\s*\]\s*=\s*el\.dataset\.fromClass/.test(hook),
    'class-picker.js: collectData hook does not iterate ' +
    '[data-from-class] elements to populate _fromClassMarkers.');
  assert(/el\.dataset\.fromClass\s*=\s*className/.test(hook),
    'class-picker.js: loadData hook does not restore _fromClassMarkers ' +
    'onto the matching elements after class-state rehydration.');
});

test('save: class-picker resolves _multiclass by name (not brittle id)', () => {
  // Regression guard for the 2026-05-18 fix. entry.id renumbers on
  // every full DB rebuild (auto-increment shifts when new entries
  // land), so saves done before a rebuild had classId values that
  // either resolved to the WRONG class (silent prog swap, e.g.
  // id 2404 was Sha'ir before the Gen+template rebuild, became
  // Mountebank after) OR failed the type filter and silently
  // dropped the entry entirely (PrCs vanishing from the chip list
  // while remaining in the Build Timeline). The fix: collectData
  // also saves `source`, and loadData looks up by name+source FIRST,
  // falling back to id only when name-based resolution fails.
  const src = readSource('class-picker.js');
  // collectData side: the stub is built by the shared mapEntryToStub helper
  // (refactored 2026-06-28 for gestalt so both sides reuse it). The helper
  // must write `source: e.source`.
  const collectIdx = src.indexOf('out._multiclass = pickedClasses.map(mapEntryToStub)');
  assert(collectIdx > 0,
    'class-picker.js: `out._multiclass = pickedClasses.map(mapEntryToStub)` ' +
    'site is missing; collectData refactored without updating this test.');
  const mapIdx = src.indexOf('function mapEntryToStub');
  assert(mapIdx > 0, 'class-picker.js: mapEntryToStub helper is missing.');
  const mapBlock = src.slice(mapIdx, mapIdx + 1500);
  assert(/source:\s*e\.source/.test(mapBlock),
    'class-picker.js: mapEntryToStub does not write `source: e.source` ' +
    'into the stub. Without source, name lookup on load cannot ' +
    'disambiguate same-name classes across books, and a DB rebuild that ' +
    'shifts entry.id will silently swap or drop classes.');
  // Gestalt Side B persists through the SAME helper, so it inherits the
  // name+source resolution. Guard the parallel _multiclassB emit.
  assert(/out\._multiclassB\s*=\s*pickedClassesB\.map\(mapEntryToStub\)/.test(src),
    'class-picker.js: Side B (_multiclassB) is not emitted via mapEntryToStub ' +
    '— gestalt Side B would lose the name+source save-stability guarantee.');
  // applyToSheet side: the in-memory entry must carry source for
  // collectData to spread.
  assert(/source:\s*cls\.source/.test(src),
    'class-picker.js: applyToSheet does not stash cls.source on the ' +
    'pickedClasses entry. Without it, e.source is undefined and ' +
    'collectData writes a useless null source field.');
  // loadData side: a name-based resolver must run BEFORE the id-only
  // path. Look for the resolver function + a name+source+version query.
  assert(/function resolveMulticlassStub\s*\(/.test(src),
    'class-picker.js: resolveMulticlassStub helper is missing — the ' +
    'name-first resolution path was reverted.');
  assert(/WHERE name = \?\s*COLLATE NOCASE\s+AND source = \?/.test(src),
    'class-picker.js: resolveMulticlassStub does not query by ' +
    'name+source. Brittle-id-only resolution would re-introduce the ' +
    'silent class drop / wrong-class swap bug.');
  // Stub preservation: when resolution fails entirely (DB not ready
  // OR unknown homebrew name), the entry must still be pushed so a
  // subsequent save round-trips the data forward. Without this, the
  // PrC silently vanishes on first load and is gone forever once the
  // user re-saves.
  assert(/_unhydrated:\s*true/.test(src),
    'class-picker.js: loadData does not preserve unresolved stubs as ' +
    '_unhydrated entries. Without this, race-loading before DB.ready ' +
    'OR a stale id permanently wipes the class on the next save.');
  // Re-hydration: a DB.ready handler must retry resolution.
  assert(/function rehydrateUnhydratedClasses\s*\(/.test(src),
    'class-picker.js: rehydrateUnhydratedClasses is missing — the ' +
    'DB.ready re-resolution path is not wired, so race-loaded ' +
    'classes never get their prog filled in.');
  assert(/rehydrateUnhydratedClasses\(\)/.test(src.slice(src.indexOf('DB.ready'))),
    'class-picker.js: DB.ready handler does not call ' +
    'rehydrateUnhydratedClasses — race-loaded classes never recover.');
});

test("save: resolveMulticlassStub LEFT-JOIN queries qualify `e.` columns", (db) => {
  // Regression guard for the 2026-05-18 bug. The name+version and
  // name-only fallback queries in resolveMulticlassStub use
  // `FROM entry e LEFT JOIN book b ON b.name = e.source`. Both
  // tables have a `name` column; the original brittle-id fix wrote
  // a bare `WHERE name = ?` which is ambiguous and throws
  // "ambiguous column name: name" at the SQL layer. The exception
  // propagated through Character.loadData and aborted the rest of
  // the load mid-iteration — the user sees "most of the sheet is
  // blank" after loading any character that has a `_multiclass`
  // stub. This guard asserts the queries qualify both `name` AND
  // `version` with the `e.` table alias.
  const src = readSource('class-picker.js');
  // Pull out the resolveMulticlassStub function body.
  const body = extractFunctionBody(src, 'resolveMulticlassStub');
  assert(body, "Couldn't extract resolveMulticlassStub body");
  // For each LEFT JOIN block, the WHERE / ORDER BY must qualify
  // `name` and `version` with `e.` — bare references throw at the
  // SQL layer.
  const leftJoinSegments = [];
  let idx = 0;
  while ((idx = body.indexOf('LEFT JOIN book', idx)) !== -1) {
    // Capture the next ~400 chars after this LEFT JOIN as one query.
    leftJoinSegments.push(body.slice(idx, idx + 500));
    idx += 1;
  }
  assert(leftJoinSegments.length >= 2,
    'resolveMulticlassStub should have AT LEAST 2 LEFT JOIN queries ' +
    '(name+version and name-only fallbacks); found ' +
    leftJoinSegments.length);
  for (let i = 0; i < leftJoinSegments.length; i++) {
    const seg = leftJoinSegments[i];
    // Disallow bare `WHERE name` (the bug).
    assert(!/WHERE\s+name\s+=/.test(seg),
      `LEFT JOIN query #${i+1} in resolveMulticlassStub has a bare ` +
      "`WHERE name = ?` which is ambiguous (both entry and book " +
      "tables have a `name` column). Qualify as `e.name = ?` to " +
      "avoid the 2026-05-18 \"ambiguous column name: name\" " +
      "exception that blanks out the rest of the load. " +
      "Segment: " + seg.replace(/\s+/g, ' ').slice(0, 200));
    // Also disallow bare `AND version` for symmetry (book has no
    // version column today, but if it ever does we'd hit the same
    // class of bug).
    assert(!/AND\s+version\s+=/.test(seg),
      `LEFT JOIN query #${i+1}: bare \`AND version = ?\` should be ` +
      "qualified `e.version = ?` for future-proofing against book-" +
      "table schema additions.");
  }

  // Live SQL exec: actually run an analogous query against the DB
  // and verify it doesn't throw. Uses a known class name + version.
  // This catches the failure mode even if the regex above misses
  // some clever new ambiguity.
  const liveRows = execAll(db,
    "SELECT e.id AS class_id, e.name AS class, e.version, e.source, " +
    "json_extract(e.data, '$.bab_progression') AS bab_progression " +
    "FROM entry e LEFT JOIN book b ON b.name = e.source " +
    "WHERE e.name = ? COLLATE NOCASE AND e.version = ? " +
    "AND e.type IN ('class','prc') " +
    "ORDER BY b.publication_date DESC LIMIT 1",
    ['Wizard', '3.5']);
  assert(liveRows.length >= 1,
    "Live SQL exec of the resolveMulticlassStub name+version query " +
    "shape should return at least the PHB Wizard row");
});

test('save: template-picker resolves _templates by name (not brittle id)', (db) => {
  // Regression guard for the 2026-08-13 template bleed. entry.id
  // renumbers on every full DB rebuild, so a saved
  // `_templates[*].templateId` can resolve to a DIFFERENT template
  // after a rebuild. The real hit: a character saved with Unseelie Fey
  // (Intimidate +4) whose stored id (3593) later pointed at Seelie
  // Court Fey (Diplomacy +4, Listen -4, Spot -4), its sibling in the
  // same book — so the sheet showed the WRONG template's skill bonuses
  // "from a template" on a character that never had it. The bonus/query
  // functions used to query `WHERE id = ?` FIRST; because the stale id
  // still hit a valid template row, the name fallback never fired. Fix:
  // resolve by name (+ source + version) first via resolveTemplateRow,
  // with the stored id only as a last-resort fallback; persist `source`
  // for cross-book disambiguation.
  const src = readSource('template-picker.js');

  // 1. The name-first resolver exists.
  assert(/function resolveTemplateRow\s*\(/.test(src),
    'template-picker.js: resolveTemplateRow helper is missing — the ' +
    'name-first resolution path was reverted, re-introducing the ' +
    'stale-id template bleed.');
  const body = extractFunctionBody(src, 'resolveTemplateRow');
  assert(body, "Couldn't extract resolveTemplateRow body");
  // Flatten string-concatenation + quotes so the split SQL literals
  // match as one string.
  const flat = body.replace(/"\s*\+\s*"/g, '').replace(/"/g, '').replace(/\s+/g, ' ');

  // 2. It resolves by name+source+version, and the brittle id lookup is
  //    the LAST resort (the name query must appear BEFORE `WHERE id`).
  assert(/name=\? AND source=\? AND version=\?/.test(flat),
    'template-picker.js: resolveTemplateRow does not query by ' +
    'name+source+version first. Brittle-id-first resolution would ' +
    're-introduce the wrong-template bleed.');
  const nameIdx = flat.indexOf('name=?');
  const idIdx = flat.indexOf('WHERE id = ?');
  assert(nameIdx !== -1 && idIdx !== -1 && nameIdx < idIdx,
    'template-picker.js: resolveTemplateRow must resolve by name ' +
    'BEFORE falling back to the stored id (id-first is exactly the bug).');

  // 3. Every bonus/query function routes through the resolver — no
  //    lingering id-first block in getActiveSkill/Save/ACBonuses or
  //    stripsRacialSkillBonuses.
  const uses = (src.match(/resolveTemplateRow\(t\)/g) || []).length;
  assert(uses >= 4,
    'template-picker.js: expected >=4 resolveTemplateRow(t) call sites ' +
    '(getActiveSkillBonuses / getActiveSaveBonuses / getActiveACBonuses ' +
    '/ stripsRacialSkillBonuses); found ' + uses + '. A bonus function ' +
    'still resolves the template by brittle id.');

  // 4. `source` is persisted (apply + collectData + loadData) so name
  //    resolution can disambiguate a template reprinted across books.
  assert(/source:\s*t\.source/.test(src),
    'template-picker.js: collectData/loadData no longer persist ' +
    '`source` — cross-book same-name templates can mis-resolve.');
  assert(/source:\s*full\.source/.test(src),
    'template-picker.js: apply-time reversal no longer captures ' +
    '`source`, so freshly-applied templates save without it.');

  // 5. Live SQL: the sibling collision the bug rode on is real, and
  //    name-based resolution returns the RIGHT one. Unseelie Fey's
  //    skill bonus targets Intimidate; if a rebuild ever makes name
  //    resolution return Seelie Court Fey instead, this trips.
  const uf = execAll(db,
    "SELECT data FROM entry WHERE type='template' AND name='Unseelie Fey' " +
    "ORDER BY CASE version WHEN '3.5' THEN 0 ELSE 1 END LIMIT 1", []);
  if (uf.length) {
    const bonuses = JSON.parse(uf[0].data || '{}').bonuses || [];
    const skill = bonuses.find(b => b.bonus_type === 'skill');
    assert(skill && /intimidate/i.test(skill.target || ''),
      'DB: Unseelie Fey should carry an Intimidate skill bonus; the ' +
      'name-resolution guard depends on it. Got: ' + JSON.stringify(bonuses));
  }
});

test('save: power-picker class filter (pp-class) round-trips (rmsnd87u6)', () => {
  // The power-picker Class dropdown is injected async into psionics panels and
  // isn't a native panel field, so it needs an explicit persist + restore path.
  // spells.js saves caster.ppClass and stamps panel.dataset.ppClass on build;
  // power-picker restores from that dataset when it wires the bar (the restore
  // has to live in power-picker because injection races spells.js's build).
  const sp = readSource('spells.js');
  const pp = readSource('power-picker.js');
  assert(/caster\.ppClass\s*=\s*panel\.querySelector\(["']\.power-picker \.pp-class["']\)/.test(sp),
    'spells.js: psionics collectData does not save caster.ppClass from the ' +
    'power-picker bar — the chosen class filter would reset on reload.');
  assert(/data\.ppClass[\s\S]{0,80}panel\.dataset\.ppClass\s*=\s*data\.ppClass/.test(sp),
    'spells.js: psionics build does not stamp panel.dataset.ppClass — the ' +
    'async power-picker injector has nothing to restore from.');
  assert(/panel\.dataset\.ppClass/.test(pp) && /matchPickerClass\(\s*classSel/.test(pp),
    'power-picker.js: wirePicker does not restore the saved class from ' +
    'panel.dataset.ppClass — the persisted filter is ignored on load.');
});

test('item-picker: magic items auto-fill the body slot (rmsnu5814)', () => {
  // The + Magic Item path infers a worn slot from the DB body_slot (mostly
  // NULL) or the item name, and passes it to Equipment.addMagicItem (which
  // pre-selects the .mi-slot dropdown). Unworn items resolve to '' (None).
  const src = readSource('item-picker.js');
  assert(/function inferItemSlot\s*\(/.test(src),
    'item-picker.js: inferItemSlot helper is missing — magic items no longer ' +
    'auto-slot on pick.');
  assert(/slot:\s*inferItemSlot\(/.test(src),
    'item-picker.js: resolveTyped no longer computes a slot via inferItemSlot.');
  assert(/addMagicItem\(\{[\s\S]{0,140}slot:\s*it\.slot/.test(src),
    'item-picker.js: the + Magic Item handler no longer passes slot to ' +
    'Equipment.addMagicItem.');
});

test('skills: 📌 pin keeps a skill a class skill through class churn (rmsny857o)', () => {
  // The pin lives as dataset.pinned on the .skill-class-check checkbox; skills.js
  // renders the toggle + persists the flag, and class-picker's untick/re-point
  // reconciliation must skip pinned boxes so a pin survives class add/remove.
  const sk = readSource('skills.js');
  const cp = readSource('class-picker.js');
  assert(/function setSkillPin\s*\(/.test(sk),
    'skills.js: setSkillPin helper is missing.');
  assert(/class="skill-pin"/.test(sk),
    'skills.js: the 📌 .skill-pin toggle is not rendered in the skill rows.');
  assert(/pinned:[\s\S]{0,90}dataset\.pinned === "1"/.test(sk),
    'skills.js: collectData no longer persists the pin (`pinned`).');
  assert(/data\.pinned\)?\s*setSkillPin/.test(sk) || /if \(data\.pinned\) setSkillPin/.test(sk),
    'skills.js: the load path no longer restores pinned skills via setSkillPin.');
  assert(/cb\.checked && cb\.dataset\.pinned !== '1'/.test(cp),
    "class-picker.js: removeClassSkills no longer guards pinned boxes — a pin " +
    "would untick when the granting class is removed.");
  assert(/cb\.dataset\.pinned === '1'[\s\S]{0,240}return;/.test(cp),
    'class-picker.js: reconcileCurrentClassSkills no longer skips pinned boxes.');
});

test('build-timeline: feats-taken is a list, not a textarea (rmso7nk4t)', () => {
  const src = readSource('build-timeline.js');
  assert(/function featRowHtml\s*\(/.test(src),
    'build-timeline.js: featRowHtml helper is missing — the feats list was reverted.');
  assert(/class="bt-feats-list"/.test(src) && /class="bt-feat-input"/.test(src),
    'build-timeline.js: the feats-taken list markup (.bt-feats-list / .bt-feat-input) is missing.');
  assert(!/class="bt-edit-feats"/.test(src),
    'build-timeline.js: the old one-per-line textarea (.bt-edit-feats) is back — ' +
    'feats-taken should be an add/remove list.');
  assert(/updateEntry\([^)]*feats_taken:\s*feats/.test(src),
    'build-timeline.js: the list no longer syncs feats_taken to the history entry.');
});

test('build-timeline: bonus feats land at their granting level (rmso7oje3)', () => {
  // Each auto-added bonus feat carries data-feat-level (stamped by the granting
  // module via addFeat); the timeline collector splits regular vs bonus feats,
  // and reconstructFromTotals places bonus feats at their level.
  const ch = readSource('character-history.js');
  const ap = readSource('app.js');
  const cp = readSource('class-picker.js');
  const bl = readSource('bloodline.js');
  const ft = readSource('feats.js');
  assert(/options\.bonusFeats/.test(ch),
    'character-history.js: reconstructFromTotals no longer honors options.bonusFeats.');
  assert(/function collectFeatsForTimeline\s*\(/.test(ap) && /bonusFeats:\s*tlFeats\.bonus/.test(ap),
    'app.js: collectFeatsForTimeline / bonusFeats wiring is missing.');
  assert(/dataset\.featLevel/.test(ap),
    'app.js: the timeline collector no longer reads data-feat-level.');
  assert(/dataset\.featLevel = String\(opts\.featLevel\)/.test(ft),
    'feats.js: addFeat no longer stamps data-feat-level from opts.featLevel.');
  assert(/featLevel:\s*w\.level/.test(cp),
    'class-picker.js: class bonus feats no longer pass featLevel to addFeat.');
  assert(/featLevel:\s*w\.level/.test(bl),
    'bloodline.js: bloodline bonus feats no longer pass featLevel to addFeat.');
  assert(/addEventListener\("bloodline-changed",\s*reconstructTimelineFromState\)/.test(ap),
    'app.js: the timeline no longer reconstructs on bloodline-changed — bloodline ' +
    'bonus feats would not reach an auto timeline.');
});

test('save: class-picker installs persistence hooks at module load', () => {
  // Regression guard for the 2026-05-18 race-condition fix. Pre-fix,
  // installPersistenceHooks() was called from inside init(), which
  // ran on DB.ready. A user clicking Load BEFORE DB.ready resolved
  // would hit the ORIGINAL Character.loadData (no monkey-patch),
  // which ignores _multiclass entirely. The next save would then
  // permanently wipe the saved multiclass array.
  //
  // The fix moves the install OUT of init() to module-load time
  // (character.js is loaded before class-picker.js in index.html,
  // so `Character` is defined when this IIFE runs).
  const src = readSource('class-picker.js');
  // The bottom-of-file installPersistenceHooks() call (after the IIFE
  // body, alongside the DB.ready handler) must exist.
  const dbReadyIdx = src.lastIndexOf('DB.ready.then');
  assert(dbReadyIdx > 0, 'class-picker.js: DB.ready handler missing');
  const tail = src.slice(0, dbReadyIdx);
  // installPersistenceHooks must appear outside any function definition
  // — i.e., as a bare call at module scope. The simplest check is
  // that the SECOND-TO-LAST installPersistenceHooks() invocation
  // (skipping the init-internal "already-installed safe call")
  // appears at module level above the IIFE close.
  const installCount = (tail.match(/installPersistenceHooks\(\)/g) || []).length;
  // Definitions don't count — `function installPersistenceHooks(`.
  // We expect AT LEAST 2 invocations: the early-install at module
  // scope + the (safe re-call) inside init(). Used to be just 1
  // (only inside init).
  assert(installCount >= 2,
    `class-picker.js: installPersistenceHooks() must be called at ` +
    `module load (not only inside init() after DB.ready) so the ` +
    `Character.loadData monkey-patch is in place even if the user ` +
    `loads a character before DB.ready resolves. Found only ` +
    `${installCount} invocation(s).`);
});

test('save: class-skill checkbox tracks current class + prior markers (2026-06-16)', () => {
  // Regression guard for the current-vs-prior class-skill split (Ryan's
  // Option B). The class-skill checkbox reflects the CURRENT (last-in-
  // timeline) class; skills that are class skills only via a PRIOR class get
  // a separate marker (so they still count toward max ranks). Derived from
  // classSkillSources + the build timeline — wired on apply/remove/load and
  // on build-timeline-changed.
  const cp = readSource('class-picker.js');
  assert(/function reconcileCurrentClassSkills\b/.test(cp),
    'class-picker.js: reconcileCurrentClassSkills missing.');
  assert(/function getCurrentClassName\b/.test(cp),
    'class-picker.js: getCurrentClassName missing.');
  // current class is sourced from the build timeline (CharacterHistory).
  assert(/CharacterHistory\.get/.test(cp),
    'class-picker.js: getCurrentClassName must read the build timeline.');
  // reconcile must run after apply, remove, load, and on timeline change.
  assert(/addEventListener\(\s*'build-timeline-changed'\s*,\s*reconcileCurrentClassSkills/.test(cp),
    'class-picker.js: reconcile not wired to build-timeline-changed.');
  // the prior marker is stamped, not persisted as its own field.
  assert(/priorClassSkill/.test(cp),
    'class-picker.js: prior-class marker (priorClassSkill) missing.');
  // the timeline broadcasts the change.
  const bt = readSource('build-timeline.js');
  assert(/build-timeline-changed/.test(bt),
    'build-timeline.js: does not dispatch build-timeline-changed.');
});

test('rebuild-killer: the load category and the displayed total are ONE calc', () => {
  // Pre-2026-05-17 character.js summed gear + armor + shield but skipped
  // money: equipment.js wrote the money-inclusive total to #total-weight and
  // character.js computed the load tier from a money-less one. Pre-2026-05-18
  // neither counted magic items. Both were patched in two places at once,
  // which is not a fix — it is a coincidence with an expiry date, and
  // extradimensional containers (2026-08-22) were about to be the third
  // divergence. There is now ONE implementation and character.js calls it.
  const ch = readSource('character.js');
  assert(/Equipment\.carriedWeight\(\)/.test(ch),
    'character.js: the load category must read Equipment.carriedWeight(), ' +
    'not re-sum the rows.');
  assert(!/coinCount\s*\/\s*50/.test(ch),
    'character.js: a second coin-weight term is back — that is the ' +
    'duplicate this guard exists to keep out.');
  assert(!/#gear-body tr\.gear-row[^]{0,200}gear-weight/.test(ch),
    'character.js: a second gear-weight sum is back.');
  // …and the one implementation still counts everything it used to.
  const eq = readSource('equipment.js');
  assert(/function carriedWeight\(\)/.test(eq),
    'equipment.js must expose the single carriedWeight() calculation');
  assert(/money-cp/.test(eq) && /coinCount\s*\/\s*50/.test(eq),
    'equipment.js: coin weight missing — PHB, 50 coins of any type = 1 lb.');
  assert(/armor-weight/.test(eq) && /shield-weight/.test(eq),
    'equipment.js: armor / shield weight missing from the one calc.');
  assert(/carriedWeight,/.test(eq),
    'equipment.js: carriedWeight must be exported for character.js to call.');
});

test('containers: a stowed row leaves the carried total, and only that', () => {
  const eq = readSource('equipment.js');
  const co = readSource('containers.js');
  // "Regardless of what is put into the bag, it weighs a fixed amount" — the
  // contents leave the character's load, the BAG does not.
  assert(/holder\.contents \+= w;/.test(eq) && /return;/.test(eq),
    'equipment.js: a stowed row must add to the container and skip the total');
  assert(/!Containers\.sameContainer\(name, c\.name\)/.test(eq),
    'a container listed as being inside itself would zero its own weight — ' +
    'that guard must stay');
  // The type matters: an unlabelled bag must read as the SMALLEST, so it
  // warns early rather than silently permitting a Type IV load.
  assert(/c\.types\[0\]/.test(co),
    'containers.js: an untyped bag of holding must fall back to Type I');
  // Capacity comes from the DB's own table, not from memory.
  assert(/bag of holding types/i.test(co) && /json_extract\(data, '\$\.tables'\)/.test(co),
    'containers.js: bag capacities must be read from the DMG table in the DB');
  // Volume is NOT modelled and must say so rather than implying it is fine.
  assert(/not tracked/.test(eq),
    'the readout must say the volume limit is not tracked');
});

test('containers: the DB still carries the Bag of Holding capacity table', (db) => {
  const row = execOne(db,
    "SELECT json_extract(data, '$.tables') AS t FROM entry "
    + "WHERE type IN ('item','gear') AND name = 'Bag of Holding' LIMIT 1");
  assert(row && row.t, 'Bag of Holding must carry its types table');
  const tbl = (JSON.parse(row.t) || []).find(
    x => /bag of holding types/i.test(x.caption || ''));
  assert(tbl, 'the "Bag of Holding Types" table is what containers.js reads');
  assert(tbl.rows.length === 4, `expected 4 bag types, got ${tbl.rows.length}`);
  // The columns containers.js keys off, by the names it matches on.
  for (const want of ['bag type', 'bag weight', 'contents weight', 'contents volume']) {
    assert(tbl.columns.some(c => new RegExp(want, 'i').test(c)),
      `column matching "${want}" missing — containers.js reads it by name`);
  }
  // Type I is the fallback for an unlabelled bag; its limit is the one a
  // player is most likely to be warned against.
  assert(/250/.test(tbl.rows[0].join(' ')),
    'Type I should carry a 250 lb. contents limit');
});

test('rebuild-killer: magic-item weight counted in both weight calcs', () => {
  // Pre-2026-05-18, equipment.js#recalcWeight + character.js's
  // mirror summed gear + armor + shield + coins but skipped the
  // .mi-weight inputs on .magic-item-entry rows. A +5 plate cloak
  // (5 lb) or other worn magic items silently dropped off the load
  // — the displayed Total Weight + the load-category penalty BOTH
  // ignored them. Both calcs must scan #magic-items-container.
  // Since 2026-08-22 there is ONE calc (equipment.js#carriedWeight) and
  // character.js calls it — so the magic-item term only has to exist once,
  // and the guard above proves character.js does not sum anything itself.
  {
    const src = readSource('equipment.js');
    assert(/#magic-items-container.*\.magic-item-entry/.test(src) ||
           /magic-items-container[^]*magic-item-entry/.test(src),
      `equipment.js: weight calc does not sum .mi-weight inputs from ` +
      `#magic-items-container — magic-item weight silently drops off ` +
      `encumbrance.`);
    assert(/\.mi-weight/.test(src),
      `equipment.js: no .mi-weight selector in source — magic-item ` +
      `weight column is not consulted by the weight calc.`);
  }
  // Live recalc trigger on edit: the .mi-weight input listener must
  // be wired so editing weight live-updates Total Weight (matches
  // the .gear-weight pattern).
  const eq = readSource('equipment.js');
  assert(/\.mi-weight[^]{0,80}addEventListener\(['"]input['"]\s*,\s*recalcWeight/
         .test(eq),
    'equipment.js: .mi-weight input is not wired to recalcWeight — ' +
    'editing weight requires a manual recalc to update Total Weight.');
  // Remove path: removeMagicItem AND removeGearRow must call
  // recalcWeightAndCascade — a weight recalc for the display PLUS the global
  // recalcAll that recomputes the load tier (Light/Medium/Heavy). A bare
  // recalcWeight() updates the total but leaves the load category (and the
  // max-Dex / check-penalty / speed it drives) stale until a weight field is
  // edited (reported rmsnu3gdx, 2026-08-13). Runtime guard: playfeel
  // "LOAD: removing an item recomputes the load tier".
  assert(/entry\.remove\(\);[\s\S]{0,200}recalcWeightAndCascade\(\)/.test(eq),
    'equipment.js: removeMagicItem must call recalcWeightAndCascade after ' +
    'removing the entry — bare recalcWeight leaves the deleted weight on the ' +
    'total AND the load tier stale.');
  assert(/tr\.remove\(\);[\s\S]{0,120}recalcWeightAndCascade\(\)/.test(eq),
    'equipment.js: removeGearRow must call recalcWeightAndCascade after ' +
    'removing the row — otherwise the load tier goes stale on gear removal.');
  // The cascade helper itself must trigger the global recalcAll (which owns the
  // load-category math), not just the weight display.
  assert(/function recalcWeightAndCascade\s*\([\s\S]{0,220}recalcAll/.test(eq),
    'equipment.js: recalcWeightAndCascade must call window.recalcAll so the ' +
    'load category / max-Dex / check-penalty recompute, not just the total.');
});

test('rebuild-killer: spellcasting panel has Extra Slots column', () => {
  // Editable per-level column for slots granted by feats / items /
  // irregular PrCs. Distinct from `bonus` (auto-filled from ability
  // mod). Must be in the slot-table SELECT, the dynamic-add row,
  // collectData, and recalc's totalSlots sum.
  const src = readSource('spells.js');
  assert(/<th[^>]*>Extra<\/th>/.test(src),
    'spells.js: slot table is missing the Extra column header.');
  assert(/class="sc-extra"/.test(src),
    'spells.js: per-level row is missing the .sc-extra input.');
  assert(/extra-\$\{i\}/.test(src),
    'spells.js: collectData / loadData does not key the extra slot ' +
    'value by `extra-${i}` — value would not survive save/load.');
  assert(/\+\s*extra\b/.test(src) || /\+\s*specialist\s*\+\s*extra\b/.test(src),
    'spells.js: recalc does not add `extra` into totalSlots.');
});

test('rebuild-killer: class-picker auto-fills XP on apply', () => {
  // After applying a class for total level N, char-xp should hold
  // the minimum XP for level N (PHB Table 3-2: L*(L-1)/2 * 1000).
  // Only when XP is currently blank — never overwrite an explicit
  // entry. Guard the formula + the empty-check.
  const src = readSource('class-picker.js');
  const body = extractFunctionBody(src, 'applyAggregatesToSheet');
  assert(body, "Couldn't extract applyAggregatesToSheet body");
  assert(/char-xp/.test(body),
    'class-picker.js: applyAggregatesToSheet does not touch #char-xp.');
  assert(/lvl\s*\*\s*\(\s*totals\.lvl\s*-\s*1\s*\)|totals\.lvl\s*\*\s*\(\s*totals\.lvl\s*-\s*1\s*\)/.test(body),
    'class-picker.js: XP fill formula does not match L*(L-1)/2 * 1000.');
});

// ---- tests: companion HD scaling (Session B) ------------------------------

function loadData() {
  // data.js declares `const DND35 = {...}` at top level — eval and
  // return the binding.
  const src = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');
  return (new Function(src + '\nreturn DND35;'))();
}

test('companion HD scaling: creatureBABAtHD matches SRD progressions', () => {
  const D = loadData();
  // Animal (3/4 BAB): Wolf at 2 HD → +1; at 4 HD → +3; at 8 HD → +6
  assert(D.creatureBABAtHD('Animal', 2) === 1, 'Animal 2HD = +1');
  assert(D.creatureBABAtHD('Animal', 4) === 3, 'Animal 4HD = +3');
  assert(D.creatureBABAtHD('Animal', 8) === 6, 'Animal 8HD = +6');
  // Magical Beast (full BAB): 4 HD → +4
  assert(D.creatureBABAtHD('Magical Beast', 4) === 4, 'Magical Beast 4HD = +4');
  // Undead (1/2 BAB): 6 HD → +3
  assert(D.creatureBABAtHD('Undead', 6) === 3, 'Undead 6HD = +3');
  // Dragon (full BAB): 10 HD → +10
  assert(D.creatureBABAtHD('Dragon', 10) === 10, 'Dragon 10HD = +10');
});

test('companion HD scaling: creatureSaveAtHD applies good/poor formulas', () => {
  const D = loadData();
  // Animal has good Fort + Ref, poor Will. At 4 HD:
  //   good = floor(4/2)+2 = 4; poor = floor(4/3) = 1
  assert(D.creatureSaveAtHD('Animal', 4, 'Fort') === 4, 'Animal 4HD Fort = +4 (good)');
  assert(D.creatureSaveAtHD('Animal', 4, 'Ref') === 4, 'Animal 4HD Ref = +4 (good)');
  assert(D.creatureSaveAtHD('Animal', 4, 'Will') === 1, 'Animal 4HD Will = +1 (poor)');
  // Dragon — all three good. 10 HD: floor(10/2)+2 = 7
  assert(D.creatureSaveAtHD('Dragon', 10, 'Fort') === 7);
  assert(D.creatureSaveAtHD('Dragon', 10, 'Ref') === 7);
  assert(D.creatureSaveAtHD('Dragon', 10, 'Will') === 7);
  // Construct — no good saves. 6 HD: all = floor(6/3) = 2
  assert(D.creatureSaveAtHD('Construct', 6, 'Fort') === 2);
});

test('companion HD scaling: skill points + feat count match MM advancement', () => {
  const D = loadData();
  // Animal (skillBase 2), Wolf base INT 2 → mod -4 → max(1, 2 + -4) = 1
  // perHd. 1 HD: 1*4 = 4. 4 HD: 4 (first) + 3*1 = 7.
  assert(D.creatureSkillPoints('Animal', 1, -4) === 4, 'Wolf 1HD skill pts = 4');
  assert(D.creatureSkillPoints('Animal', 4, -4) === 7, 'Wolf+2bonus skill pts = 7');
  // Outsider (skillBase 8) at INT 12 mod +1: perHd = 9. 4 HD: 9*4 + 9*3 = 63.
  assert(D.creatureSkillPoints('Outsider', 4, 1) === 63, 'Outsider 4HD INT 12');
  // Feat count: HD 1 → 1; HD 3 → 2; HD 6 → 3; HD 8 → 3; HD 9 → 4
  assert(D.creatureFeatCount(1) === 1);
  assert(D.creatureFeatCount(3) === 2);
  assert(D.creatureFeatCount(6) === 3);
  assert(D.creatureFeatCount(8) === 3);
  assert(D.creatureFeatCount(9) === 4);
});

test('companion HD scaling: parseCreatureType normalizes subtype parentheticals', () => {
  const D = loadData();
  assert(D.parseCreatureType('Animal') === 'Animal');
  assert(D.parseCreatureType('Animal (Aquatic)') === 'Animal',
    'subtype list stripped');
  assert(D.parseCreatureType('Magical Beast (Shapechanger)') === 'Magical Beast');
  // Unrecognized → null (e.g. weird MM3 compound types)
  assert(D.parseCreatureType('unique celestial paragon') === null);
  assert(D.parseCreatureType(null) === null);
  assert(D.parseCreatureType('') === null);
});

test('companion HD scaling: parseHitDieCount handles common shapes', () => {
  const D = loadData();
  assert(D.parseHitDieCount('2d8+4 (13 hp)') === 2);
  assert(D.parseHitDieCount('1d10') === 1);
  assert(D.parseHitDieCount('1/2 d8') === 1, 'half-HD clamped to 1');
  assert(D.parseHitDieCount('12d12+24') === 12);
  assert(D.parseHitDieCount('') === null);
  assert(D.parseHitDieCount(null) === null);
  assert(D.parseHitDieCount('garbage') === null);
});

test('companion HD scaling: parseCreatureSkills handles compound clauses', () => {
  const D = loadData();
  // Plain skills.
  const wolf = D.parseCreatureSkills(
    'Hide +2, Listen +3, Move Silently +3, Spot +3, Survival +1*');
  assert(wolf.length === 5, 'Wolf has 5 skills');
  assert(wolf[0].name === 'Hide' && wolf[0].modifier === '+2');
  assert(wolf[4].name === 'Survival' && wolf[4].notes === '*',
    'Asterisk preserved as notes');
  // Compound clauses with parens.
  const mage = D.parseCreatureSkills('Disguise +2 (+4 acting), Listen +5');
  assert(mage.length === 2, 'paren-aware split: 2 skills');
  assert(mage[0].name === 'Disguise' && mage[0].notes === '(+4 acting)',
    'paren clause preserved as notes');
  // Edge cases.
  assert(D.parseCreatureSkills('').length === 0);
  assert(D.parseCreatureSkills(null).length === 0);
});

test('companion HD scaling: parseCreatureFeats marks bonus feats', () => {
  const D = loadData();
  // (B) marker variants.
  const a = D.parseCreatureFeats('Track(B), Weapon Focus (bite)');
  assert(a.length === 2, 'two feats');
  assert(a[0].name === 'Track' && a[0].bonus === true, 'Track is bonus');
  assert(a[1].name === 'Weapon Focus (bite)' && a[1].bonus === false,
    'parenthetical kept on Weapon Focus; not bonus');
  // Spaced "(B)" suffix.
  const b = D.parseCreatureFeats('Improved Initiative (B), Weapon Finesse (B)');
  assert(b.length === 2);
  assert(b[0].bonus === true && b[1].bonus === true);
  // Plain comma list.
  const c = D.parseCreatureFeats('Dodge, Mobility, Spring Attack');
  assert(c.length === 3 && c.every(f => !f.bonus));
});

test('companion HD scaling: creatureAbilityBoostsEarned subtracts base HD boosts', () => {
  const D = loadData();
  // Base creature already has its own boosts baked in for ITS base HD;
  // the player only allocates boosts EARNED above that.
  // Wolf (2 base) → 4 total HD: earned 1, baked 0 → user 1.
  assert(D.creatureAbilityBoostsEarned(2, 4) === 1, 'Wolf at 4HD: 1');
  // Wolf (2 base) → 8 total HD: earned 2, baked 0 → user 2.
  assert(D.creatureAbilityBoostsEarned(2, 8) === 2, 'Wolf at 8HD: 2');
  // 4 HD base creature at total 4 HD: boost already in stat block.
  assert(D.creatureAbilityBoostsEarned(4, 4) === 0,
    'a 4-HD base creature at total 4 HD allocates 0 (boost baked in)');
  // 4 HD base at total 8 HD: HD 8 boost is new.
  assert(D.creatureAbilityBoostsEarned(4, 8) === 1, '4HD base at 8HD: 1');
  // 6 HD base at total 12 HD: HD 8 + HD 12 are new (2 boosts above base).
  assert(D.creatureAbilityBoostsEarned(6, 12) === 2, '6HD base at 12HD: 2');
  // Pre-threshold cases.
  assert(D.creatureAbilityBoostsEarned(2, 3) === 0, 'no boost before HD 4');
  assert(D.creatureAbilityBoostsEarned(2, 7) === 1, '2HD base at 7HD: 1');
  // Negative / nonsense → 0 (never negative).
  assert(D.creatureAbilityBoostsEarned(8, 4) === 0, 'shrinking is 0, not negative');
  assert(D.creatureAbilityBoostsEarned(0, 0) === 0);
});

test('companion HD scaling: cumulativeSizeDelta sums per-step MM Table 4-2', () => {
  const D = loadData();
  // Same size → all zeros.
  const same = D.cumulativeSizeDelta('Medium', 'Medium');
  assert(same.str === 0 && same.dex === 0 && same.con === 0 && same.na === 0,
    'same size returns zero deltas');
  // M → L: single step, MM row "Medium → Large".
  //   Str +8, Dex -2, Con +4, NA +2
  const ml = D.cumulativeSizeDelta('Medium', 'Large');
  assert(ml.str === 8 && ml.dex === -2 && ml.con === 4 && ml.na === 2,
    `M→L expected +8/-2/+4/+2 got ${JSON.stringify(ml)}`);
  // M → H: two steps (M→L + L→H).
  //   Str +8+8 = +16, Dex -2+0 = -2, Con +4+4 = +8, NA +2+3 = +5
  const mh = D.cumulativeSizeDelta('Medium', 'Huge');
  assert(mh.str === 16 && mh.dex === -2 && mh.con === 8 && mh.na === 5,
    `M→H expected +16/-2/+8/+5 got ${JSON.stringify(mh)}`);
  // S → H: three steps.
  //   Str +4+8+8 = +20, Dex -2-2+0 = -4, Con +2+4+4 = +10, NA 0+2+3 = +5
  const sh = D.cumulativeSizeDelta('Small', 'Huge');
  assert(sh.str === 20 && sh.dex === -4 && sh.con === 10 && sh.na === 5,
    `S→H expected +20/-4/+10/+5 got ${JSON.stringify(sh)}`);
  // Shrinking: L → M is the negation of M → L.
  const lm = D.cumulativeSizeDelta('Large', 'Medium');
  assert(lm.str === -8 && lm.dex === 2 && lm.con === -4 && lm.na === -2,
    `L→M expected -8/+2/-4/-2 got ${JSON.stringify(lm)}`);
  // Unknown size returns null.
  assert(D.cumulativeSizeDelta('Bogus', 'Medium') === null);
});

test('companion HD scaling: parseCreatureAdvancement reads HD bands', () => {
  const D = loadData();
  // Multi-band semicolon-separated.
  const aboleth = D.parseCreatureAdvancement('9-16 HD (Huge); 17-24 HD (Gargantuan)');
  assert(Array.isArray(aboleth) && aboleth.length === 2);
  assert(aboleth[0].minHD === 9 && aboleth[0].maxHD === 16 && aboleth[0].size === 'Huge');
  assert(aboleth[1].minHD === 17 && aboleth[1].maxHD === 24);
  // Single-step (minHD == maxHD).
  const adam = D.parseCreatureAdvancement('5 HD (Small); 6-8 HD (Medium)');
  assert(adam.length === 2 && adam[0].minHD === 5 && adam[0].maxHD === 5);
  // "By character class" → null (not a stat-block advancement).
  assert(D.parseCreatureAdvancement('By character class') === null);
  assert(D.parseCreatureAdvancement('') === null);
  // advancementSizeAtHD: pick the right band.
  assert(D.advancementSizeAtHD(aboleth, 10) === 'Huge', '10 HD → Huge');
  assert(D.advancementSizeAtHD(aboleth, 20) === 'Gargantuan');
  // Below lowest → null (clamp to base size in the caller).
  assert(D.advancementSizeAtHD(aboleth, 4) === null);
  // Above highest → clamp to last band per MM rules.
  assert(D.advancementSizeAtHD(aboleth, 99) === 'Gargantuan');
});

test('companion HD scaling: AUTO mode wired into autoFillFromBaseCreature', () => {
  // Guard the wiring so the companion AUTO path actually invokes the
  // new HD-derived calculation. Without this hook the BAB/save fields
  // stay blank even after a base creature is picked.
  const src = readSource('companion.js');
  assert(/autoFillHDDerivedStats\s*\(/.test(src),
    'companion.js: autoFillFromBaseCreature does not call ' +
    'autoFillHDDerivedStats — bonus HD never becomes BAB/saves.');
  assert(/DND35\.creatureBABAtHD/.test(src),
    'companion.js: no reference to DND35.creatureBABAtHD — ' +
    'BAB recomputation is not wired.');
  assert(/comp-hd-summary/.test(src),
    'companion.js: HD summary line is not rendered — players have ' +
    'no visibility into the computed skill / feat budget.');
  // Familiar special-case (inherits from master) should explicitly
  // be carved out so we don't write wrong numbers to it.
  assert(/matchType\s*===\s*['"]familiar['"]/.test(src),
    'companion.js: familiar case is not carved out of HD recompute.');
  // Familiar inherit: must read master's BAB + saves from main sheet.
  assert(/bab-1/.test(src) && /fort-base/.test(src) && /ref-base/.test(src) && /will-base/.test(src),
    'companion.js: familiar inherit does not read master BAB + saves ' +
    'from the main sheet (#bab-1 / #fort-base / etc.).');
  // Auto-populate hooks should call into the data.js parsers.
  assert(/DND35\.parseCreatureSkills/.test(src),
    'companion.js: AUTO mode does not call parseCreatureSkills — ' +
    'skill rows would stay blank after picking a creature.');
  assert(/DND35\.parseCreatureFeats/.test(src),
    'companion.js: AUTO mode does not call parseCreatureFeats.');
  assert(/DND35\.parseCreatureAdvancement/.test(src),
    'companion.js: AUTO mode does not call parseCreatureAdvancement ' +
    '— size escalation has no source.');
  assert(/comp-size/.test(src),
    'companion.js: no .comp-size selector references — size field ' +
    'either missing from the panel or not auto-filled.');
  // Ability boosts (every 4 total HD over base) must be wired into
  // AUTO recompute and round-trip via collectData.
  assert(/comp-ability-boost/.test(src),
    'companion.js: no .comp-ability-boost references — user-allocated ' +
    'ability boosts have no UI.');
  assert(/DND35\.creatureAbilityBoostsEarned/.test(src),
    'companion.js: AUTO recompute does not call ' +
    'creatureAbilityBoostsEarned — the HD summary would not show the ' +
    'earned-vs-allocated count.');
  assert(/comp-\$\{ab\.toLowerCase\(\)\}-boost/.test(src),
    'companion.js: collectData does not round-trip the per-ability ' +
    'boost values — user allocations would be lost on save/load.');
});

// ---- tests: companion Session C (template apply in AUTO mode) -----------
//
// Session C layers "apply template T to base creature C" on top of
// the existing AUTO-mode pipeline (Session B). When AUTO has BOTH a
// base creature AND a template selected, the template's deltas
// (ability changes, NA bonus, type/size/speed override, SA/SQ
// concatenation) layer in BEFORE the existing companion-progression
// math runs against the mutated blob. Round-trips compTemplate via
// collectData/loadData. A type-restricted template narrows the Base
// Creature autocomplete via a lazily-built per-type datalist.

test('companion Session C: template input wired into panel + listeners', () => {
  const src = readSource('companion.js');
  // UI: template input lives next to the base-creature input.
  assert(/class="comp-template"/.test(src),
    'companion.js: panel template has no .comp-template input. ' +
    'Without it, users have no way to apply a template via AUTO mode.');
  assert(/list="template-options"/.test(src),
    'companion.js: .comp-template input is not wired to the ' +
    '#template-options datalist (autocomplete will be empty).');
  // The global template datalist must actually be built somewhere.
  assert(/function buildGlobalTemplateDatalist\s*\(/.test(src),
    'companion.js: buildGlobalTemplateDatalist is missing — the ' +
    '#template-options datalist will never be populated.');
  // The DB.ready handler must invoke both creature + template builds.
  assert(/buildGlobalCreatureDatalist\(\);\s*\n\s*buildGlobalTemplateDatalist\(\)/
         .test(src),
    'companion.js: _scheduleCreatureDatalistBuild does not also call ' +
    'buildGlobalTemplateDatalist on DB ready — template autocomplete ' +
    'will be empty until a manual reload.');
});

test('companion Session C: autoFillFromBaseCreature applies template before progression', () => {
  const src = readSource('companion.js');
  // applyTemplateToCreature is the apply engine; must run inside
  // autoFillFromBaseCreature and BEFORE the progression / stats math.
  assert(/function applyTemplateToCreature\s*\(/.test(src),
    'companion.js: applyTemplateToCreature helper is missing.');
  // Verify call ordering *inside* autoFillFromBaseCreature's body
  // (extractFunctionBody scopes us to the right function — a naive
  // file-wide search would catch the helper definitions / unrelated
  // computeCompanionLevels callers further down the file).
  const body = extractFunctionBody(src, 'autoFillFromBaseCreature');
  assert(body, "Couldn't extract autoFillFromBaseCreature body");
  const applyIdx = body.search(/creature\s*=\s*applyTemplateToCreature\(/);
  const progIdx  = body.search(/computeCompanionLevels\(\)/);
  assert(applyIdx >= 0 && progIdx >= 0 && applyIdx < progIdx,
    'companion.js: applyTemplateToCreature call must precede the ' +
    'progression math (so template deltas are folded in before ' +
    'companion-class adjustments). Found order inside ' +
    'autoFillFromBaseCreature: applyIdx=' + applyIdx +
    ', progIdx=' + progIdx);
});

test('companion Session C: applyTemplateToCreature handles dict + free-text ability_changes', () => {
  const src = readSource('companion.js');
  // Both shapes are real DB occurrences: Bodak Creature → dict,
  // Anarchic/Blightspawned/etc. → free-text.
  const body = extractFunctionBody(src, 'parseTemplateAbilityChanges');
  assert(body, "Couldn't extract parseTemplateAbilityChanges body");
  assert(/typeof\s+raw\s*===\s*['"]object['"]/.test(body),
    'companion.js: parseTemplateAbilityChanges does not handle the ' +
    'dict shape ({Str:"+4", Dex:"+2"}) — Bodak Creature and friends ' +
    'would silently no-op.');
  assert(/typeof\s+raw\s*===\s*['"]string['"]/.test(body),
    'companion.js: parseTemplateAbilityChanges does not handle the ' +
    'free-text shape ("Str +2, Con +4, Int -2") — Anarchic / ' +
    'Blightspawned / Blooded One etc. would silently no-op.');
  // Em-dash ("—") for ability loss must map to null (not 0).
  assert(/===\s*['"]—['"]/.test(body),
    'companion.js: parseTemplateAbilityChanges does not map em-dash ' +
    '("—") to null — templates that strip an ability (e.g. Telthor ' +
    'incorporeal: Str —) would treat the loss as a no-op.');
});

test('companion Session C: template NA from STRUCTURED fields (change/set), not prose', () => {
  const src = readSource('companion.js');
  // The sheet must read the template's structured natural-armor fields, NOT
  // re-derive from prose (the DB owns derivation). natural_armor_change is
  // additive; natural_armor_set is use-higher overlap → max(setVal, base).
  assert(src.includes('tpl.natural_armor_change'),
    'companion.js must consume the structured natural_armor_change delta.');
  assert(src.includes('tpl.natural_armor_set') &&
         /Math\.max\(baseFieldNa,\s*tpl\.natural_armor_set\)/.test(src),
    'companion.js must apply natural_armor_set as max(setVal, base NA).');
  // The prose deriver is gone — the AC text is only kept in sync (absolute).
  assert(!/function deriveTemplateNaturalArmor\s*\(/.test(src),
    'companion.js should no longer derive template NA from prose.');
  assert(/function setAcNaturalToken\s*\(/.test(src),
    'companion.js: setAcNaturalToken (absolute token rewrite) is missing.');
});

test('companion Session C: SA/SQ concatenation preserves base creature trait list', () => {
  const src = readSource('companion.js');
  const body = extractFunctionBody(src, 'appendTraits');
  assert(body, "Couldn't extract appendTraits body");
  // Both shapes appear in the DB: string ("Bound to Land: ...") and
  // {name, description} objects (older templates).
  assert(/typeof\s+raw\s*===\s*['"]string['"]/.test(body) &&
         /raw\.name/.test(body),
    'companion.js: appendTraits does not handle both string and ' +
    'object trait shapes — half of templates will silently drop ' +
    'their special_qualities_added entries.');
  // Must not blow away the existing string.
  assert(/return\s+existing/.test(body),
    'companion.js: appendTraits has no early-return path that keeps ' +
    'the existing string when the template adds nothing.');
});

test('companion Session C: type_change cleans down to a bare type string', () => {
  const src = readSource('companion.js');
  const body = extractFunctionBody(src, 'cleanTemplateTypeChange');
  assert(body, "Couldn't extract cleanTemplateTypeChange body");
  // We need at least two patterns: "Augmented (X)" + "type changes to X".
  assert(/Augmented/.test(body),
    'companion.js: cleanTemplateTypeChange does not handle the ' +
    'Augmented (X) form — half-celestials / half-dragons would ' +
    'fail to clean down.');
  assert(/type\\s\+changes/i.test(body) || /type\s+changes/i.test(body) ||
         /changes\?\s\+to/.test(body),
    'companion.js: cleanTemplateTypeChange does not handle the ' +
    '"type changes to X" form — verbose SRD type_change strings ' +
    'will leak into the displayed type field.');
});

test('companion Session C: source-type mismatch warns instead of blocking', () => {
  const src = readSource('companion.js');
  // The warning span exists in the panel template AND the apply
  // function writes to it when source_creature_type doesn't match.
  assert(/comp-template-warning/.test(src),
    'companion.js: panel has no .comp-template-warning span — ' +
    'users get no signal when applying a Fey-only template to a ' +
    'Construct base.');
  assert(/source_creature_type/.test(src),
    'companion.js: applyTemplateToCreature does not read ' +
    'source_creature_type — it cannot warn about base-type mismatch.');
  // The warning must be advisory, not blocking — the apply still runs.
  assert(/warnEl\.style\.display\s*=\s*['"]['"]/.test(src) ||
         /warnEl\.style\.display\s*=\s*['"]block['"]/.test(src),
    'companion.js: applyTemplateToCreature does not display the ' +
    'warning span. Mismatch goes silently — defeats the purpose of ' +
    'the per-panel warning.');
});

test('companion Session C: template-restricted base autocomplete narrows by type', () => {
  const src = readSource('companion.js');
  // Per-type datalists are built lazily and the input is swapped via
  // syncBaseCreatureDatalist. The list= attribute swap is the key
  // mechanic — without it the picker would still show every creature.
  assert(/function buildTypedCreatureDatalist\s*\(/.test(src),
    'companion.js: buildTypedCreatureDatalist is missing — ' +
    'template-aware filtering of the base-creature autocomplete is ' +
    'not wired.');
  assert(/function syncBaseCreatureDatalist\s*\(/.test(src),
    'companion.js: syncBaseCreatureDatalist is missing — the ' +
    'list= attribute on .comp-base-creature is never swapped to a ' +
    'type-narrowed datalist.');
  // The SQL must filter by creature_type LIKE 'Animal%' (prefix
  // match) so subtypes like "Animal (Aquatic)" still match.
  assert(/creature_type\s+LIKE\s+:pfx/.test(src),
    'companion.js: buildTypedCreatureDatalist does not filter by ' +
    'creature_type with a LIKE prefix — subtyped creatures would ' +
    'fall out of the narrowed list.');
  // Wired to both input + change events on the template input AND
  // to a deferred initial sync (for loadData round-trips).
  const idx = src.indexOf('tplInput.addEventListener');
  assert(idx > 0 && src.substring(idx, idx + 500).includes('syncBaseCreatureDatalist'),
    'companion.js: template input listeners do not call ' +
    'syncBaseCreatureDatalist — user typing a template name will ' +
    'not narrow the picker.');
});

test('companion Session C: compTemplate round-trips through collectData/loadData', () => {
  const src = readSource('companion.js');
  // collectData must persist the template name.
  const collectBody = extractFunctionBody(src, 'collectData');
  assert(collectBody, "Couldn't extract collectData body");
  assert(/compTemplate/.test(collectBody),
    'companion.js: collectData does not persist .comp-template — ' +
    'saved characters would lose their template selection on reload.');
  // And the panel template (build) must read d.compTemplate back.
  assert(/d\.compTemplate/.test(src),
    'companion.js: panel template build does not read d.compTemplate ' +
    '— round-trip is broken even if collect writes it.');
});

// ---- tests: deity-picker --------------------------------------------------

test('deity-picker: list query (init)', (db) => {
  // Same source-recency ORDER BY as the other pickers. 121 deities
  // in the DB today, all from FRCS.
  const rows = execAll(db,
    "SELECT e.id AS deity_id, e.name, e.version, e.source "
    + "FROM entry e "
    + "LEFT JOIN book b ON b.name = e.source "
    + "WHERE e.type = 'deity' "
    + "ORDER BY e.name COLLATE NOCASE, "
    + "         CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, "
    + "         b.publication_date DESC");
  assertGE(rows.length, 100);
  assert(rows[0].name && rows[0].deity_id != null);
});

test('deity-picker: detail query returns full record with domains', (db) => {
  // Pick any deity and verify the JSON shape has the fields the
  // info panel consumes.
  const list = execAll(db,
    "SELECT id AS deity_id FROM entry WHERE type='deity' LIMIT 1");
  const detail = execOne(db,
    "SELECT name, source, version, data FROM entry WHERE id = ?",
    [list[0].deity_id]);
  assert(detail && detail.data);
  const d = JSON.parse(detail.data);
  // Required fields the info panel renders.
  assert(d.name, 'deity has name');
  assert(d.alignment, 'deity has alignment');
  assert(Array.isArray(d.domains), 'deity domains is an array');
  assert(d.favored_weapon, 'deity has favored_weapon');
});

test('deity-picker: book-filter + alignment-auto-fill wiring present', () => {
  // Structural guards for the picker. Tested via static grep because
  // the runtime behavior depends on the Character tab DOM + DB.
  const src = readSource('deity-picker.js');
  assert(/BookFilter\.(allowsSource|allowsEntry)/.test(src),
    'deity-picker.js: not BookFilter-aware.');
  assert(/['"]book-filter-changed['"]/.test(src),
    'deity-picker.js: does not listen for book-filter-changed.');
  assert(/ALIGNMENT_BY_CODE/.test(src),
    'deity-picker.js: alignment-code → dropdown-value map missing.');
  assert(/data-from-deity|fromDeity/.test(src),
    'deity-picker.js: no data-from-deity marker on auto-filled ' +
    'alignment — user edits could be overwritten on re-render.');
});

test('deity-picker: domain chips wire into Spells-tab .sc-domain-name', () => {
  // The clickable-chip flow: chip click → find an empty
  // .sc-domain-name in a Domain-Access panel → fill via dispatch
  // (or click +Add Domain when no empty slot). Static grep:
  const src = readSource('deity-picker.js');
  assert(/deity-domain-chip/.test(src),
    'deity-picker.js: domain chips not rendered as ' +
    '.deity-domain-chip elements.');
  assert(/insertDomainIntoSpellsTab/.test(src),
    'deity-picker.js: missing insertDomainIntoSpellsTab handler.');
  assert(/sc-domain-toggle/.test(src),
    'deity-picker.js: chip handler does not filter to panels with ' +
    'Domain Access enabled (would no-op on Wizard-only sheets).');
  assert(/sc-add-domain/.test(src),
    'deity-picker.js: chip handler has no fallback to create a row ' +
    'via the panel\'s "+ Add Domain" button when all slots are full.');
});

// ---- tests: monster-class extensions (SS) -----------------------------

test('monster-class: SS monster classes have the extended class_table fields', (db) => {
  // The class-picker treats a class as "monster" when its class_table
  // rows carry size / natural_armor / racial_hd / ability_changes
  // fields. SS classes all have these. Guard at the DB layer.
  const rows = execAll(db,
    "SELECT name, json_extract(data, '$.class_table') AS ct "
    + "FROM entry WHERE type='class' AND name LIKE '%(Monster Class)' LIMIT 5");
  assertGE(rows.length, 5,
    'expected at least 5 monster classes in the DB');
  for (const row of rows) {
    const table = JSON.parse(row.ct || '[]');
    assert(table.length > 0, `${row.name} has empty class_table`);
    const hasExtensions = table.some(r =>
      r.natural_armor != null || r.size != null ||
      r.racial_hd != null ||
      (Array.isArray(r.ability_changes) && r.ability_changes.length));
    assert(hasExtensions,
      `${row.name} class_table lacks SS extension fields — picker ` +
      `would treat it as non-monster.`);
  }
});

test('monster-class: Ogre L3 aggregates the right ability bumps', (db) => {
  // The picker aggregates ability_changes from L1 to applied level.
  // Per the DB: Ogre L2 grants +2 Str / +2 Con; L1 and L3 grant 0.
  // So at L3 the aggregate is STR +2, CON +2.
  const row = execOne(db,
    "SELECT json_extract(data, '$.class_table') AS ct FROM entry "
    + "WHERE type='class' AND name='Ogre (Monster Class)'");
  const table = JSON.parse(row.ct || '[]');
  const acc = {};
  for (const r of table) {
    if (Number(r.level) > 3) continue;
    for (const ch of (r.ability_changes || [])) {
      const ab = String(ch.ability).toUpperCase().slice(0, 3);
      acc[ab] = (acc[ab] || 0) + (ch.modifier || 0);
    }
  }
  assert(acc.STR === 2, `Ogre L3 STR aggregate expected +2, got ${acc.STR}`);
  assert(acc.CON === 2, `Ogre L3 CON aggregate expected +2, got ${acc.CON}`);
});

test('monster-class: class-picker wiring is present + persists monsterExt', () => {
  // Static guard for the apply/remove path and the save-stability
  // round-trip via the _multiclass stub.
  const src = readSource('class-picker.js');
  assert(/function getMonsterClassExtensions\s*\(/.test(src),
    'class-picker.js: getMonsterClassExtensions aggregator missing.');
  assert(/function applyMonsterClassExtensions\s*\(/.test(src),
    'class-picker.js: applyMonsterClassExtensions hook missing.');
  assert(/function removeMonsterClassExtensions\s*\(/.test(src),
    'class-picker.js: removeMonsterClassExtensions hook missing.');
  // applyToSheet must capture the previous ext BEFORE the entry is
  // replaced — otherwise re-apply would diff against the new (not
  // the old) extensions and apply zero delta.
  assert(/prevMonsterExt/.test(src),
    'class-picker.js: applyToSheet does not capture prevMonsterExt; ' +
    're-apply of monster classes would double-add ability bumps.');
  // _multiclass save shape must include monsterExt so removeClass
  // after a save/load can subtract the right delta.
  assert(/monsterExt:\s*e\.monsterExt/.test(src),
    'class-picker.js: collectData does not persist monsterExt on the ' +
    '_multiclass stub. After save/load, removeClass would not subtract ' +
    'the racial bumps that AUTO mode applied.');
  assert(/monsterExt:\s*stub\.monsterExt/.test(src),
    'class-picker.js: loadData does not restore monsterExt onto ' +
    'pickedClasses entries.');
});

test('monster-class: overlap NA stacking (DFA) uses max, not add (2026-06-16)', (db) => {
  // Regression for the kobold-DFA bug: an `overlap`-stacking class NA (DFA
  // "Scales") must take max(base NA, class value), not add. Kobold base NA 1 +
  // DFA Scales 2 should be max(1,2)=2, not 3.
  // DB: DFA is overlap, Dragon Shaman is additive (no flag).
  const dfa = execOne(db, "SELECT json_extract(data,'$.natural_armor_stacking') AS s "
    + "FROM entry WHERE name='Dragonfire Adept' AND type IN ('class','prc') LIMIT 1");
  assert(dfa && dfa.s === 'overlap',
    `Dragonfire Adept should be natural_armor_stacking='overlap', got ${dfa && dfa.s}`);
  const ds = execOne(db, "SELECT json_extract(data,'$.natural_armor_stacking') AS s "
    + "FROM entry WHERE name='Dragon Shaman' AND type IN ('class','prc') LIMIT 1");
  assert(!ds || ds.s == null,
    `Dragon Shaman should be additive (no overlap flag), got ${ds && ds.s}`);
  // Source: the apply path reads the flag + applies max(), tracking appliedNA.
  const src = readSource('class-picker.js');
  assert(/fetchNaStacking\s*\(/.test(src),
    'class-picker.js: fetchNaStacking helper missing.');
  assert(/naStacking\s*===\s*'overlap'/.test(src),
    'class-picker.js: applyMonsterClassExtensions does not branch on overlap.');
  assert(/Math\.max\(0,\s*ext\.naturalArmor\s*-\s*preClassNA\)/.test(src),
    'class-picker.js: overlap NA is not computed as max(0, value - preClassNA).');
  assert(/appliedNA/.test(src),
    'class-picker.js: net applied NA not tracked (removal would be wrong).');
});

test('rebuild-killer: textarea auto-expand has details/visibility fallback', () => {
  // The pre-2026-05-17 autoExpand wrote scrollHeight unconditionally;
  // textareas in closed <details> or inactive tabs report 0 → showed
  // as a single line on load. Guard:
  //   1. autoExpand has a requestAnimationFrame retry when h <= 0
  //   2. document listens for `toggle` events to re-expand textareas
  //      inside the opened <details>
  const src = readSource('app.js');
  assert(/requestAnimationFrame/.test(src),
    'app.js: autoExpand has no requestAnimationFrame fallback — ' +
    'textareas in hidden tabs / closed <details> would collapse to ' +
    '1 line on load.');
  assert(/['"]toggle['"]/.test(src),
    'app.js: no toggle listener — textareas in <details> stay ' +
    'collapsed when the user opens the section.');
});

test('save: app.js#collectData wires every UI module', () => {
  // Catch the case where collectData/loadData is added to a module but
  // not plumbed through app.js.
  const src = readSource('app.js');
  const body = extractFunctionBody(src, 'collectData');
  assert(body, "Couldn't extract app.js#collectData body");
  for (const mod of ['Character', 'Equipment', 'Spells', 'Feats',
                     'Companion', 'ClassFeatures', 'Skills']) {
    assert(
      new RegExp(`${mod}\\.collect(Data|CustomSkills)?\\s*\\(`).test(body),
      `app.js#collectData does not call ${mod}.collectData() — saves ` +
      `will silently drop this module's state.`
    );
  }
  const loadBody = extractFunctionBody(src, 'loadData');
  assert(loadBody, "Couldn't extract app.js#loadData body");
  for (const mod of ['Character', 'Equipment', 'Spells', 'Feats',
                     'Companion', 'ClassFeatures', 'Skills']) {
    assert(
      new RegExp(`${mod}\\.load(Data|CustomSkills)?\\s*\\(`).test(loadBody),
      `app.js#loadData does not call ${mod}.loadData() — imports ` +
      `will silently drop this module's state.`
    );
  }
});

// ---- tests: creature-race-picker.js (creature as playable race) ----------
//
// A creature with an `as_character` block can be picked as a playable race.
// Two parts: a racial-adjustment layer (mirrors race-picker) + a synthetic
// racial-HD class row injected into class-picker's multiclass aggregate.
// These guards cover the DB query shape, the data.js type→progression mapping
// (load-bearing: wrong labels mean wrong BAB/saves on every monster PC), the
// synthetic-row save round-trip, and the double-count guard.
//
// MIGRATION NOTE (2026-06-03): the v3 walk emits a book's "X as Characters"
// sidebars as standalone type=race entries (which the MAIN race-picker
// surfaces) rather than as_character blocks on the creature. The MM I REPLACE
// migrated all of Monster Manual I this way, so the legacy as_character path
// below now serves only NOT-yet-walked books (MM III/IV/V, Frostburn,
// Sandstorm, Draconomicon, Drow of the Underdark — 24 creatures). Ryan's
// call: race-shaped entries go in the main picker now; the creature-race-
// picker is reserved for the full derived stat blocks later. The two shape
// tests below assert the INVARIANT contract, not specific (migratable) names.

// Eval data.js (a bare `const DND35 = {...}` with no exports) so the pure
// helpers can be exercised in Node.
function loadDND35() {
  const src = readSource('data.js');
  return new Function(src + '\nreturn DND35;')();
}

test('creature-race-picker: the as_character migration to type=race is COMPLETE', (db) => {
  // 2026-06-27: every creature "[X] as Characters" writeup is now a standalone
  // type=race entry (the last 24 — MM III + the legacy structured ones — were
  // promoted; the block is stripped from the creature by
  // apply_monster_aschar_races.py). The creature-race picker is now reserved for
  // the harder stat-block INFERENCE. So NO creature should still carry an
  // as_character / as_characters block.
  const rows = execAll(db,
    "SELECT e.name, e.source FROM entry e "
    + "WHERE e.type = 'creature' "
    + "  AND (json_extract(e.data, '$.as_character')  IS NOT NULL "
    + "    OR json_extract(e.data, '$.as_characters') IS NOT NULL) "
    + "ORDER BY e.name");
  assert(rows.length === 0,
    `${rows.length} creature(s) still carry an as_character/as_characters block — `
    + `they should be migrated to type=race (see _monster_aschar_races_data.py): `
    + rows.slice(0, 8).map(r => `${r.name} [${r.source}]`).join(', '));
});

test('race-picker: migrated monster-as-characters races carry the picker shape', (db) => {
  // Shape-CONTRACT test for the promoted "[X] as Characters" race entries
  // (2026-06-27). These are now stable type=race rows, so naming them is fine.
  // Contract: ability_mods [{ability,modifier}], int level_adjustment, int
  // racial_hd (+ racial_hd_type when HD>0) — the shape the race-picker consumes.
  for (const nm of ['Sand Giant', 'Crystalline Troll', 'Kenku', 'Windscythe', 'Crucian']) {
    const r = execOne(db,
      "SELECT json_extract(data,'$.ability_mods')     AS am, "
      + "json_extract(data,'$.level_adjustment') AS la, "
      + "json_extract(data,'$.racial_hd')        AS hd, "
      + "json_extract(data,'$.racial_hd_type')   AS hdt "
      + "FROM entry WHERE type='race' AND name=? LIMIT 1", [nm]);
    assert(r, `migrated race "${nm}" should exist as type=race`);
    const am = r.am ? JSON.parse(r.am) : null;
    assert(Array.isArray(am) && am.length && 'ability' in am[0] && 'modifier' in am[0],
      `${nm}: ability_mods [{ability,modifier}] present`);
    assert(typeof r.la === 'number', `${nm}: level_adjustment int`);
    assert(typeof r.hd === 'number', `${nm}: racial_hd int`);
    if (r.hd > 0) assert(typeof r.hdt === 'string' && r.hdt,
      `${nm}: racial_hd_type present when HD>0`);
  }
});

test('race-picker: MM "as characters" sidebars surface as type=race with LA', (db) => {
  // The v3 walk emits the MM "X as Characters" sidebars as standalone
  // type=race entries; the main race-picker's `WHERE type='race'` query picks
  // them up automatically and shows "LA: +N". Guard that the migrated set is
  // present, includes the races that USED to be creature-as_character blocks
  // (Bugbear/Goblin/Gnoll/Kobold/Ogre), and carries a picker-usable shape.
  const rows = execAll(db,
    "SELECT name, data FROM entry "
    + "WHERE type='race' AND source='Monster Manual' ORDER BY name");
  assertGE(rows.length, 26);
  const names = rows.map(r => r.name);
  for (const n of ['Bugbear', 'Goblin', 'Gnoll', 'Kobold', 'Ogre']) {
    assert(names.includes(n),
      `MM "as characters" race "${n}" should surface in the main race-picker`);
  }
  // Every MM race carries a picker-usable shape: ability_mods list + an
  // integer level_adjustment (the picker renders "LA: +N" from it).
  for (const r of rows) {
    const d = JSON.parse(r.data);
    assert(Array.isArray(d.ability_mods),
      `${r.name}: ability_mods must be a list`);
    assert(typeof d.level_adjustment === 'number',
      `${r.name}: level_adjustment must be an int`);
  }
});

test('race-picker: MM monster races carry racial_hd (int); 1-HD races are 0', (db) => {
  // racial_hd is a canonical race field (2026-06-03). A monster race's racial HD =
  // its creature stat block's base HD, EXCEPT a 1-HD creature has that HD replaced by
  // its first class level (racial_hd 0) — validated against the "X as Characters"
  // sidebars (multi-HD = "—Racial Hit Dice: Nd8"; 1-HD = "feats per class level", incl.
  // the non-humanoid Aasimar/Tiefling/Pixie). racial_hd>0 carries type+die for the
  // char sheet's BAB/save/HP derivation.
  const rows = execAll(db,
    "SELECT name, data FROM entry WHERE type='race' AND source='Monster Manual'");
  const byName = {};
  let withHd = 0;
  for (const r of rows) {
    const d = JSON.parse(r.data);
    byName[r.name] = d;
    assert(typeof d.racial_hd === 'number',
      `${r.name}: racial_hd must be an int (canonical race field, default 0)`);
    if (d.racial_hd > 0) {
      withHd++;
      assert(typeof d.racial_hd_die === 'number',
        `${r.name}: racial_hd>0 must carry racial_hd_die`);
      assert(typeof d.racial_hd_type === 'string' && d.racial_hd_type,
        `${r.name}: racial_hd>0 must carry racial_hd_type`);
    } else {
      assert(d.racial_hd_die === null || d.racial_hd_die === undefined,
        `${r.name}: racial_hd 0 must have null racial_hd_die`);
    }
  }
  assertGE(withHd, 18);  // ~21 of 31 MM races are monster races with racial HD
  assert(byName['Ogre'] && byName['Ogre'].racial_hd === 4 &&
         byName['Ogre'].racial_hd_die === 8 &&
         byName['Ogre'].racial_hd_type === 'Giant', 'Ogre = 4d8 Giant racial HD');
  for (const n of ['Aasimar', 'Tiefling', 'Pixie', 'Goblin', 'Kobold']) {
    assert(byName[n] && byName[n].racial_hd === 0,
      `${n} racial_hd = 0 (1-HD race: racial HD replaced by class per the sidebar)`);
  }
});

test('data.js: creatureTypeToProg maps creature types to BAB/save labels', () => {
  const D = loadDND35();
  assert(typeof D.creatureTypeToProg === 'function',
    'data.js missing creatureTypeToProg');
  // Humanoid: 3/4 BAB (average), good Ref only.
  const h = D.creatureTypeToProg('Humanoid (Goblinoid)');
  assert(h.bab === 'average', 'Humanoid BAB should be average (3/4)');
  assert(h.fort === 'poor' && h.ref === 'good' && h.will === 'poor',
    'Humanoid good save = Ref only');
  // Monstrous Humanoid: full BAB, good Ref + Will.
  const mh = D.creatureTypeToProg('Monstrous Humanoid');
  assert(mh.bab === 'good' && mh.ref === 'good' && mh.will === 'good' &&
         mh.fort === 'poor', 'Monstrous Humanoid: full BAB, good Ref+Will');
  // Outsider: full BAB, all three good.
  const o = D.creatureTypeToProg('Outsider');
  assert(o.bab === 'good' && o.fort === 'good' && o.ref === 'good' &&
         o.will === 'good', 'Outsider: full BAB, all good saves');
  // Fey: 1/2 BAB (poor), good Ref + Will.
  const f = D.creatureTypeToProg('Fey');
  assert(f.bab === 'poor' && f.ref === 'good' && f.will === 'good' &&
         f.fort === 'poor', 'Fey: poor BAB, good Ref+Will');
  assert(D.creatureTypeToProg('Bogusoid') === null,
    'unknown type returns null');
});

test('data.js: creatureTypeToProg labels reproduce creatureBABAtHD/SaveAtHD', () => {
  // The synthetic racial-HD row uses the prog LABELS; for a single block
  // of N HD the pooled aggregate must reproduce the direct per-type
  // formulas (creatureBABAtHD / creatureSaveAtHD) exactly, else a
  // monster PC's BAB/saves drift from RAW.
  const D = loadDND35();
  // Bugbear: 3 Humanoid HD → BAB +2 (avg), Fort +1 (poor), Ref +3 (good).
  assert(D.creatureBABAtHD('Humanoid', 3) === 2, 'Humanoid 3HD BAB = 2');
  assert(D.creatureSaveAtHD('Humanoid', 3, 'Fort') === 1, 'poor Fort = 1');
  assert(D.creatureSaveAtHD('Humanoid', 3, 'Ref') === 3, 'good Ref = 3');
  const prog = D.creatureTypeToProg('Humanoid');
  assert(prog.bab === 'average' && prog.fort === 'poor' && prog.ref === 'good',
    'prog labels encode the same progressions');
});

test('creature-race-picker: queries creatures filtered by as_character', () => {
  const src = readSource('creature-race-picker.js');
  assert(/type\s*=\s*'creature'/.test(src),
    'creature-race-picker.js does not query type=creature');
  assert(/json_extract\([^)]*'\$\.as_character'\)\s+IS NOT NULL/.test(src),
    'creature-race-picker.js does not filter on as_character presence');
});

test('creature-race-picker: injects synthetic HD + uses creatureTypeToProg', () => {
  const src = readSource('creature-race-picker.js');
  assert(/ClassPicker\.addRacialHD\s*\(/.test(src),
    'creature-race-picker.js does not call ClassPicker.addRacialHD — ' +
    'racial Hit Dice would not reach BAB/saves.');
  assert(/creatureTypeToProg\s*\(/.test(src),
    'creature-race-picker.js does not derive prog via creatureTypeToProg.');
  assert(/ClassPicker\.removeRacialHD\s*\(/.test(src),
    'creature-race-picker.js does not call removeRacialHD — clearing / ' +
    're-picking would leave a stale synthetic HD row.');
});

test('creature-race-picker: double-count guard against Savage Species class', () => {
  const src = readSource('creature-race-picker.js');
  assert(/ClassPicker\.hasMonsterClassFor\s*\(/.test(src),
    'creature-race-picker.js does not consult hasMonsterClassFor — a ' +
    'creature-race layered on its own Savage Species monster class would ' +
    'double-count HD/abilities with no warning.');
});

test('save: class-picker round-trips synthetic racialHD rows', () => {
  // Synthetic racial-HD rows (creature-as-race) are NOT DB classes, so
  // their prog can't be rehydrated from the class table. collectData must
  // persist racialHD + creatureRace + prog directly, and loadData must
  // reconstruct from the stub BEFORE attempting a DB class lookup.
  const src = readSource('class-picker.js');
  assert(/addRacialHD/.test(src) && /removeRacialHD/.test(src) &&
         /hasMonsterClassFor/.test(src),
    'class-picker.js does not expose the racial-HD API.');
  // collectData persists the synthetic-row fields.
  assert(/racialHD:\s*e\.racialHD/.test(src),
    'class-picker.js collectData does not persist e.racialHD.');
  assert(/creatureRace:\s*e\.creatureRace/.test(src),
    'class-picker.js collectData does not persist e.creatureRace.');
  assert(/prog:\s*e\.racialHD\s*\?\s*e\.prog/.test(src),
    'class-picker.js collectData does not persist prog for synthetic rows ' +
    '(it would be lost — synthetic rows have no DB class to rehydrate from).');
  // loadData reconstructs synthetic rows directly.
  assert(/if\s*\(\s*stub\.racialHD\s*\)/.test(src),
    'class-picker.js loadData has no `if (stub.racialHD)` branch — ' +
    'synthetic rows would fail DB resolution and lose their prog.');
  // The window export includes the new API.
  assert(/window\.ClassPicker\s*=\s*\{[^}]*addRacialHD[^}]*\}/.test(src),
    'window.ClassPicker does not export addRacialHD.');
});

test('save: gestalt flag + Side B emit/omit and hydrate symmetrically', () => {
  // Gestalt persists Side B as `_multiclassB` + a `_gestalt: true` flag,
  // omitting both when they'd be empty/false so non-gestalt saves are
  // byte-identical to the pre-gestalt format. Both sides hydrate through
  // the shared hydrateStub helper.
  const src = readSource('class-picker.js');
  // Emit: flag only when gestalt; Side B only when non-empty.
  assert(/if\s*\(\s*gestalt\s*\)\s*out\._gestalt\s*=\s*true/.test(src),
    'collectData does not emit `_gestalt` only when gestalt is on.');
  assert(/if\s*\(\s*pickedClassesB\.length\s*\)\s*\{[\s\S]{0,120}out\._multiclassB/.test(src),
    'collectData does not gate `_multiclassB` on pickedClassesB.length ' +
    '(a non-gestalt save would gain an empty key, breaking byte-identity).');
  // Load: gestalt flag restored; Side B hydrated via hydrateStub.
  assert(/gestalt\s*=\s*!!\(\s*data\s*&&\s*data\._gestalt\s*\)/.test(src),
    'loadData does not restore the gestalt flag from data._gestalt.');
  assert(/data\._multiclassB[\s\S]{0,160}hydrateStub\(stub\)/.test(src),
    'loadData does not hydrate _multiclassB through hydrateStub.');
});

test('gestalt: synthesis ranks none below poor (monster dead-level safety)', () => {
  // The per-level synthesizer must treat a no-progression category (null,
  // e.g. a Savage-Species monster class dead level) as ranking BELOW poor,
  // so max(present, null) = present and max(null, null) = 0-contribution.
  // This is what lets Phase 3 monster classes slot in without an engine
  // rewrite (Ryan's max(N, null) = N).
  const src = readSource('class-picker.js');
  assert(/BAB_RANK\s*=\s*\{\s*good:\s*3,\s*avg:\s*2,\s*poor:\s*1\s*\}/.test(src),
    'BAB_RANK is missing or not good>avg>poor (none implicitly 0).');
  assert(/SAVE_RANK\s*=\s*\{\s*good:\s*2,\s*poor:\s*1\s*\}/.test(src),
    'SAVE_RANK is missing or not good>poor (none implicitly 0).');
  assert(/function\s+betterCat[\s\S]{0,200}if\s*\(\s*ra\s*===\s*0\s*&&\s*rb\s*===\s*0\s*\)\s*return\s+null/.test(src),
    'betterCat does not return null when both categories are absent — a ' +
    'dead level on both sides would wrongly contribute.');
  // gestaltTotals takes lvl = max(ΣA, ΣB), never the sum.
  assert(/lvl:\s*Math\.max\(ea\.length,\s*eb\.length\)/.test(src),
    'gestaltTotals does not set lvl = max(ΣA, ΣB) — gestalt level must not ' +
    'be the sum of the two sides.');
});

// ---- tests: book filter --------------------------------------------------
//
// The book filter is a global picker scope. These tests assert the
// infrastructure exists (state + persistence + wiring) and verify that
// each picker's row loop consults BookFilter so a filter actually
// reaches the autocomplete suggestions.

// ---- tests: bloodline.js (UA Bloodlines subsystem) ------------------------

test('bloodline: DB has the Fireclaw bloodline with parseable strengths', (db) => {
  const r = execOne(db,
    "SELECT name, source, data FROM entry WHERE type='bloodline' "
    + "AND name='Fireclaw'");
  assert(r, 'Fireclaw bloodline missing from DB (type=bloodline)');
  assert(/Diamond Soul/.test(r.source),
    `Fireclaw should be sourced from Diamond Soul homebrew, got ${r.source}`);
  const d = JSON.parse(r.data);
  assert(d.strengths && d.strengths.major,
    'Fireclaw should carry a strengths.major column');
  const traits = d.strengths.major.traits;
  assertNotEmpty(traits, 'Fireclaw Major column has no traits');
  // The ability bumps are the ONLY field bloodline.js auto-applies.
  const bumps = {};
  for (const t of traits) {
    if (t.ability && typeof t.ability === 'object') bumps[t.level] = t.ability;
  }
  assert(JSON.stringify(bumps[3]) === '{"CHA":1}', 'L3 should bump CHA +1');
  assert(JSON.stringify(bumps[6]) === '{"DEX":1}', 'L6 should bump DEX +1');
  assert(JSON.stringify(bumps[8]) === '{"CON":1}', 'L8 should bump CON +1');
  assert(JSON.stringify(d.strengths.major.bloodline_levels_required)
    === '[3,6,12]', 'Major slot schedule should be [3,6,12]');
});

test('bloodline: catalog query is filter-shape compatible', (db) => {
  // The exact SELECT bloodline.js#buildCatalog issues (LEFT JOIN book
  // for the source-recency tiebreak; e.source surfaced for the filter).
  const rows = execAll(db,
    "SELECT e.id AS bl_id, e.name, e.version, e.source, "
    + "       b.publication_date "
    + "FROM entry e LEFT JOIN book b ON b.name = e.source "
    + "WHERE e.type = 'bloodline' "
    + "ORDER BY e.name COLLATE NOCASE, "
    + "         CASE e.version WHEN '3.5' THEN 0 ELSE 1 END, "
    + "         b.publication_date DESC");
  assertNotEmpty(rows, 'bloodline catalog query returned no rows');
  assert(rows.every(r => 'source' in r && 'name' in r && 'bl_id' in r),
    'catalog rows must expose name/source/bl_id for the BookFilter gate');
});

test('bloodline: module exposes the persistence + bonus API', () => {
  const src = readSource('bloodline.js');
  for (const sym of ['getActiveBonuses', 'getClassLevelLabel',
                     'collectData', 'loadData']) {
    assert(new RegExp(`\\b${sym}\\b`).test(src),
      `bloodline.js does not export ${sym}`);
  }
  assert(/window\.Bloodline\s*=/.test(src),
    'bloodline.js does not assign window.Bloodline');
});

test('bloodline: consults BookFilter + listens for both filter events', () => {
  // BookFilter.allowsEntry delegates to HomebrewFilter, so the single
  // gate covers both campaign-scope and the per-entry homebrew toggle.
  // The module must also re-run on BOTH filter events so toggling
  // Diamond Soul homebrew surfaces/hides the catalog live.
  const src = readSource('bloodline.js');
  assert(/BookFilter\.allowsEntry\s*\(/.test(src),
    'bloodline.js does not consult BookFilter.allowsEntry — homebrew ' +
    'bloodlines would show even when their source is filtered out.');
  assert(/['"]book-filter-changed['"]/.test(src),
    'bloodline.js does not listen for book-filter-changed.');
  assert(/['"]homebrew-filter-changed['"]/.test(src),
    'bloodline.js does not listen for homebrew-filter-changed — ' +
    'enabling Diamond Soul homebrew would not surface Fireclaw until reload.');
});

test('bloodline: app.js wires save/load + the ability-bump bonus layer', () => {
  const src = readSource('app.js');
  const collectBody = extractFunctionBody(src, 'collectData');
  const loadBody = extractFunctionBody(src, 'loadData');
  const bonusBody = extractFunctionBody(src, 'collectActiveBonuses');
  assert(/Bloodline\.collectData\s*\(/.test(collectBody),
    'app.js#collectData does not call Bloodline.collectData — saved ' +
    'sheets silently drop the bloodline selection.');
  assert(/Bloodline\.loadData\s*\(/.test(loadBody),
    'app.js#loadData does not call Bloodline.loadData.');
  assert(/Bloodline\.getActiveBonuses\s*\(/.test(bonusBody),
    'app.js#collectActiveBonuses does not fold in Bloodline.getActiveBonuses ' +
    '— bloodline ability bumps would never reach the ability modifiers.');
});

test('bloodline: _bloodlines persists name+source per entry, not a brittle DB id', () => {
  // Save-stability rule #7: entry ids renumber on every DB rebuild, so
  // the save must resolve by a human-meaningful identifier. (Multi-bloodline
  // 2026-06-09: collectData now maps over a stack, so the per-entry loop var
  // is the subject — assert the invariant shape-agnostically, not pinned to
  // the old single `state.*`.)
  const src = readSource('bloodline.js');
  const collectBody = extractFunctionBody(src, 'collectData');
  assert(/name:\s*\w+\.name/.test(collectBody)
      && /source:\s*\w+\.source/.test(collectBody),
    'bloodline.js#collectData must persist name + source per bloodline.');
  assert(!/\bid:\s*\w+\.id\b/.test(collectBody),
    'bloodline.js#collectData must NOT persist a DB id (renumbers on rebuild).');
  assert(/resolveSelection/.test(src),
    'bloodline.js must resolve the saved selection against the catalog ' +
    'by name/source (resolveSelection).');
});

test('bloodline: multi-stack save shape — _bloodlines array + legacy _bloodline migration', () => {
  // Multi-bloodline (2026-06-09): the canonical save key is the `_bloodlines`
  // ARRAY; loadData must still accept a legacy single `_bloodline` object and
  // migrate it forward to a one-element stack so pre-existing saves survive.
  const src = readSource('bloodline.js');
  const collectBody = extractFunctionBody(src, 'collectData');
  const loadBody = extractFunctionBody(src, 'loadData');
  assert(/_bloodlines/.test(collectBody),
    'bloodline.js#collectData must emit the _bloodlines array.');
  assert(/_bloodlines/.test(loadBody) && /_bloodline\b/.test(loadBody),
    'bloodline.js#loadData must read _bloodlines AND migrate legacy _bloodline.');
});

test('save: bloodline.js syncSlots preserves slotsPaid when unresolved (load-before-DB-ready)', () => {
  // Save-stability rule #4: a saved character can load BEFORE DB.ready has
  // built the bloodline catalog. If syncSlots() unconditionally rewrites
  // state.slotsPaid from the (empty) resolved threshold list, the saved
  // bloodline-level checkboxes are wiped for good — the DB.ready re-render
  // has nothing left to restore. The guard must early-return when the
  // strength can't resolve, leaving the saved flags intact. (Bug fixed
  // 2026-06-05: checked bloodline-level slots vanished on reload.)
  const src = readSource('bloodline.js');
  const body = extractFunctionBody(src, 'syncSlots');
  assert(body, 'syncSlots not found in bloodline.js');
  const retIdx = body.search(/\breturn\b/);
  // Multi-bloodline: syncSlots now operates on a per-bloodline state arg, so
  // the subject is `<var>.slotsPaid =` rather than the old single `state.`.
  const assignIdx = body.search(/\w+\.slotsPaid\s*=/);
  assert(retIdx !== -1,
    'bloodline.js#syncSlots has no early-return guard — a load-before-DB-' +
    'ready wipes slotsPaid (bloodline-level checkboxes do not survive reload).');
  assert(assignIdx !== -1 && retIdx < assignIdx,
    'bloodline.js#syncSlots must guard (return) BEFORE overwriting ' +
    'slotsPaid, so an unresolved strength preserves the saved flags.');
});

test('bloodline: skill bonuses — direct folds into total, affinity is a note', () => {
  // UA bloodlines grant two kinds of skill bonus: unconditional "+N on
  // <Skill> checks" (direct → skill TOTAL) and situational "<X> affinity
  // +2/+4/+6" (the 5 social skills vs creatures of the bloodline → a NOTE,
  // never the total). bloodline.js parses its own regular trait names;
  // skills.js#recalc consumes them.
  const bl = readSource('bloodline.js');
  assert(/\bgetActiveSkillBonuses\b/.test(bl),
    'bloodline.js does not expose getActiveSkillBonuses.');
  assert(/window\.Bloodline\s*=[\s\S]*getActiveSkillBonuses/.test(bl)
      || /getActiveSkillBonuses,/.test(bl),
    'getActiveSkillBonuses is not exported on window.Bloodline.');
  assert(/\bdirect\b/.test(bl) && /\baffinities\b/.test(bl),
    'getActiveSkillBonuses must return a {direct, affinities[]} split ' +
    '(one affinity per bloodline — every UA bloodline grants one).');
  const sk = readSource('skills.js');
  assert(/Bloodline\.getActiveSkillBonuses\s*\(/.test(sk),
    'skills.js#recalc does not consult Bloodline.getActiveSkillBonuses — ' +
    'bloodline skill bonuses never reach the skills tab.');
  assert(/\+\s*bloodlineBonus\b/.test(sk),
    'skills.js must add the DIRECT bloodline bonus to the skill total.');
  assert(/bloodline affinity/.test(sk),
    'skills.js must surface the AFFINITY bonus as a situational note ' +
    '(never added to the total).');
});

test('bloodline: ability bumps render in the Template/Bloodline column, not Item', () => {
  // Bloodline ability bumps must surface in the read-only Template /
  // Bloodline column (which hides when empty), not lumped into Item Bonus.
  const html = readSource('index.html');
  assert(/type="hidden"\s+id="str-template"/.test(html),
    'index.html: #str-template should be a hidden backing input (picker-' +
    'written + persisted), with the visible value in the Template/Bloodline span.');
  assert(/id="str-tplbl"/.test(html) && /id="cha-tplbl"/.test(html),
    'index.html: missing the per-ability Template/Bloodline display spans (#x-tplbl).');
  assert(/Template\s*\/\s*Bloodline/.test(html),
    'index.html: the ability column header should read "Template / Bloodline".');
  assert(/ability-table hide-tplbl-col/.test(html),
    'index.html: ability table should start with hide-tplbl-col (hidden when empty).');

  const app = readSource('app.js');
  assert(/bloodlineAbilities/.test(app),
    'app.js#collectActiveBonuses must expose the bloodline portion separately ' +
    '(bloodlineAbilities) so it can show in its own column, not Item Bonus.');

  const ch = readSource('character.js');
  assert(/bloodlineBonus(es)?\b/.test(ch) && /\bmiscBonus\b/.test(ch),
    'character.js#recalc must split the merged active bonus into misc vs bloodline.');
  assert(/-tplbl`?\)/.test(ch) || /-tplbl"/.test(ch) || /\$\(`#\$\{lower\}-tplbl`\)/.test(ch),
    'character.js must write the Template/Bloodline span (#x-tplbl).');
  assert(/hide-tplbl-col/.test(ch),
    'character.js must toggle hide-tplbl-col when the column is empty.');
});

test('ability table: Misc (catch-all, hides empty) + Temp delta column; no Temp Score/Mod', () => {
  // Item Bonus → Misc (read-only catch-all of items/rage/conditions, hides
  // when empty). The two redundant Temp Score / Temp Mod columns are replaced
  // by a single writable Temp ADJUSTMENT (delta) right before Modifier.
  const html = readSource('index.html');
  assert(/<th class="ability-col-misc">Misc<\/th>/.test(html),
    'index.html: the catch-all column header should be "Misc".');
  assert(/id="str-misc"/.test(html) && /id="cha-misc"/.test(html),
    'index.html: per-ability Misc spans (#x-misc) missing.');
  assert(/hide-misc-col/.test(html),
    'index.html: ability table should start with hide-misc-col (hidden when empty).');
  assert(/<th>Temp<\/th>/.test(html) && /class="ability-score ability-temp"/.test(html),
    'index.html: a writable Temp column should exist.');
  // The ability-table Temp Score / Temp Mod columns are gone (the saves
  // table keeps its own "Temp Mod" column, so check the ability-specific ids).
  assert(!/id="str-tempmod"/.test(html) && !/id="cha-tempmod"/.test(html),
    'index.html: the old ability Temp Mod spans (#x-tempmod) must be removed.');

  const app = readSource('app.js');
  const body = extractFunctionBody(app, 'getAbilityMod');
  assert(/-temp`?\)?\.value|#\$\{ab\}-temp/.test(body) && /score\s*\+=/.test(body),
    'app.js#getAbilityMod must add the Temp value to the score as a delta ' +
    '(not replace the base score).');
  assert(!/active\s*=\s*temp/.test(body),
    'app.js#getAbilityMod must NOT use the old temp-replaces-base logic.');

  const ch = readSource('character.js');
  assert(/-temp-adj/.test(ch),
    'character.js must persist Temp under the new `-temp-adj` key (the meaning ' +
    'changed from a full alternate score to a delta).');
  assert(/hide-misc-col/.test(ch),
    'character.js must toggle hide-misc-col when the Misc column is empty.');
});

test('bloodline: registered in the index.html module load order', () => {
  const html = readSource('index.html');
  assert(/['"]bloodline\.js['"]/.test(html),
    'index.html does not load bloodline.js in the document.write module list.');
});

test('bloodline: picker on Character tab, panel on Feats & Abilities tab', () => {
  // Relocation (2026-06-03): the picker (#bloodline-picker) sits with the
  // Template Lookup on the Character tab; the trait panel
  // (#bloodline-section) moved into #tab-feats. Assert both anchors
  // exist and the panel is inside the feats tab, not class-features.
  const html = readSource('index.html');
  assert(/id="bloodline-picker"/.test(html),
    'index.html missing the #bloodline-picker (Character-tab Bloodline Lookup).');
  assert(/id="bloodline-name"/.test(html) && /id="bloodline-options"/.test(html),
    'index.html missing the bloodline name input / datalist.');
  const featsTab = html.slice(html.indexOf('id="tab-feats"'),
    html.indexOf('id="tab-equipment"'));
  assert(/id="bloodline-section"/.test(featsTab),
    'bloodline panel (#bloodline-section) is not inside the Feats & Abilities tab.');
  const cfTab = html.slice(html.indexOf('id="tab-class-features"'),
    html.indexOf('id="tab-notes"'));
  assert(!/id="bloodline-section"/.test(cfTab),
    'bloodline panel should have moved OUT of the Class Features tab.');
});

test('bloodline: class-picker appends the bloodline level to Class & Level', () => {
  // (b) The Class & Level box rebuild includes the bloodline segment via
  // Bloodline.getClassLevelLabel, and class-picker re-runs on
  // bloodline-changed so the count refreshes.
  const src = readSource('class-picker.js');
  assert(/Bloodline\.getClassLevelLabel\s*\(/.test(src),
    'class-picker does not append Bloodline.getClassLevelLabel to #char-class.');
  assert(/['"]bloodline-changed['"]/.test(src),
    'class-picker does not listen for bloodline-changed (Class & Level box ' +
    'would not refresh when the bloodline / its slot count changes).');
});

test('bloodline: injected bonus-feat rows are excluded from Feats save', () => {
  // (c) Bloodline-injected feat rows are DERIVED (data-from-bloodline),
  // re-synced from the selection — Feats.collectData must skip them so
  // they do not double-persist + duplicate on reload.
  const feats = readSource('feats.js');
  const collectBody = extractFunctionBody(feats, 'collectData');
  assert(/fromBloodline/.test(collectBody),
    'feats.js#collectData does not skip data-from-bloodline rows — injected ' +
    'bonus feats would persist as user feats and duplicate on reload.');
  const bl = readSource('bloodline.js');
  assert(/syncBonusFeats/.test(bl) && /Feats\.addFeat\s*\(/.test(bl),
    'bloodline.js does not inject bonus feats via Feats.addFeat (syncBonusFeats).');
  assert(/data-from-bloodline|fromBloodline/.test(bl),
    'bloodline.js does not mark its injected feat rows as data-from-bloodline.');
});

test('layout: rarely-used pickers consolidated into #character-lookups', () => {
  // 2026-06-03 UX pass: the browse walls + Template/Bloodline/Class
  // lookups + Build Timeline fold into one collapsed disclosure to free
  // vertical space. Each picker injects into a host div (with a fallback
  // to its old in-grid placement). The Class & Level box stays visible.
  const html = readSource('index.html');
  assert(/id="character-lookups"/.test(html),
    'missing the consolidated #character-lookups disclosure');
  for (const host of ['race-browse-host', 'creature-race-browse-host',
                      'deity-browse-host', 'template-lookup-host']) {
    assert(new RegExp(`id="${host}"`).test(html),
      `missing host div #${host} in the consolidated area`);
  }
  // Class & Level box stays OUTSIDE / above the consolidated area.
  assert(html.indexOf('id="char-class"') < html.indexOf('id="character-lookups"'),
    'Class & Level box (#char-class) should stay above the consolidated lookups.');
  // Each picker reroutes into its host div.
  assert(/race-browse-host/.test(readSource('race-picker.js')),
    'race-picker not rerouted to #race-browse-host.');
  assert(/creature-race-browse-host/.test(readSource('creature-race-picker.js')),
    'creature-race-picker not rerouted.');
  assert(/deity-browse-host/.test(readSource('deity-picker.js')),
    'deity-picker not rerouted.');
  assert(/template-lookup-host/.test(readSource('template-picker.js')),
    'template-picker not rerouted.');
  // Feat Lookup is now a collapsible <details>.
  assert(/createElement\(['"]details['"]\)/.test(readSource('feat-picker.js')),
    'feat-picker Feat Lookup is not a collapsible <details>.');
});

test('race-unify: single Race field + coordinator + picker hooks', () => {
  // 2026-06-03: "Creature as Race" merged into #char-race. race-unify.js
  // routes a typed name to the right picker (collision chooser for
  // Centaur/Gnoll) and runs a shared teardown so switching race<->monster
  // starts from a clean slate (else stale ability mods / racial HD linger).
  const html = readSource('index.html');
  assert(!/id="char-creature-race"/.test(html),
    'the separate #char-creature-race input should be gone (unified into #char-race).');
  assert(/['"]race-unify\.js['"]/.test(html),
    'index.html does not load race-unify.js.');
  const ru = readSource('race-unify.js');
  for (const sym of ['claim', 'resolve', 'teardownAll', 'reset']) {
    assert(new RegExp(`\\b${sym}\\b`).test(ru), `race-unify.js missing ${sym}`);
  }
  assert(/window\.RaceUnify\s*=/.test(ru), 'race-unify.js does not assign window.RaceUnify');
  const rp = readSource('race-picker.js');
  const cp = readSource('creature-race-picker.js');
  assert(/window\.RacePicker\s*=/.test(rp) && /resetWrites/.test(rp) && /applyByName/.test(rp),
    'race-picker.js must expose window.RacePicker { resetWrites, applyByName }.');
  assert(/window\.CreatureRacePicker\s*=/.test(cp) && /resetWrites/.test(cp) && /applyByName/.test(cp),
    'creature-race-picker.js must expose window.CreatureRacePicker { resetWrites, applyByName }.');
  assert(/getElementById\(['"]char-race['"]\)/.test(cp),
    'creature-race-picker.js should bind to the unified #char-race input.');
  assert(/RaceUnify\.claim/.test(rp) && /RaceUnify\.claim/.test(cp),
    'both pickers must gate auto-apply through RaceUnify.claim (collision routing).');
  assert(/RaceUnify\.teardownAll/.test(rp) && /RaceUnify\.teardownAll/.test(cp),
    'both pickers must call RaceUnify.teardownAll for clean race<->monster switching.');
});

test('book-filter: module exposes the expected public API', () => {
  const src = readSource('book-filter.js');
  for (const sym of ['getActiveAbbrevs', 'setActiveAbbrevs',
                     'allowsSource', 'allowsAbbrev', 'collectData',
                     'loadData', 'isActive', 'getBooks']) {
    assert(new RegExp(`\\b${sym}\\b`).test(src),
      `book-filter.js does not export ${sym}`);
  }
  // window.BookFilter is the global handle used by every picker.
  assert(/window\.BookFilter\s*=/.test(src),
    'book-filter.js does not assign window.BookFilter');
});

test('book-filter: app.js wires collectData + loadData', () => {
  const src = readSource('app.js');
  const collectBody = extractFunctionBody(src, 'collectData');
  const loadBody = extractFunctionBody(src, 'loadData');
  assert(/BookFilter\.collectData\s*\(/.test(collectBody),
    'app.js#collectData does not call BookFilter.collectData — saved ' +
    'sheets will silently drop the campaign book filter.');
  assert(/BookFilter\.loadData\s*\(/.test(loadBody),
    'app.js#loadData does not call BookFilter.loadData — imports will ' +
    'silently drop the campaign book filter.');
});

test('book-filter: every picker consults BookFilter in its row loop', () => {
  // The picker-integration contract: each picker queries `entry` with
  // `e.source` (or just `source`) in the SELECT and skips rows that
  // the BookFilter rejects. Catches the common regression of adding a
  // new picker without wiring the global filter. Accepts either
  // `allowsSource` (legacy, source-only) or `allowsEntry` (preferred,
  // entry-aware with name+type+version — supports the counterpart
  // hide-3.0 mode added 2026-05-20).
  const pickers = [
    'feat-picker.js', 'item-picker.js', 'spell-picker.js',
    'race-picker.js', 'template-picker.js', 'class-picker.js',
    'domain-picker.js', 'maneuver-picker.js', 'power-picker.js',
    'mystery-picker.js', 'soulmeld-picker.js', 'vestige-picker.js',
    'invocation-picker.js', 'special-ability-picker.js',
    'creature-race-picker.js',
  ];
  const missing = [];
  for (const p of pickers) {
    const src = readSource(p);
    if (!/BookFilter\.(allowsSource|allowsEntry)\s*\(/.test(src)) {
      missing.push(p);
    }
  }
  assert(missing.length === 0,
    `${missing.length} pickers do not consult BookFilter:\n  ` +
    missing.join('\n  '));
});

test('book-filter: every picker re-runs on book-filter-changed', () => {
  // Without the event listener, changing the filter would only take
  // effect on next page reload.
  const pickers = [
    'feat-picker.js', 'item-picker.js', 'spell-picker.js',
    'race-picker.js', 'template-picker.js', 'class-picker.js',
    'domain-picker.js', 'maneuver-picker.js', 'power-picker.js',
    'mystery-picker.js', 'soulmeld-picker.js', 'vestige-picker.js',
    'invocation-picker.js', 'special-ability-picker.js',
    'creature-race-picker.js',
  ];
  const missing = [];
  for (const p of pickers) {
    const src = readSource(p);
    if (!/['"]book-filter-changed['"]/.test(src)) missing.push(p);
  }
  assert(missing.length === 0,
    `${missing.length} pickers do not listen for book-filter-changed:\n  ` +
    missing.join('\n  '));
});

test('book-filter: lookup modal also consults BookFilter', () => {
  const src = readSource('lookup.js');
  assert(/BookFilter\.(allowsSource|allowsEntry)\s*\(/.test(src),
    'lookup.js does not consult BookFilter — the universal search ' +
    'returns out-of-scope entries.');
  assert(/['"]book-filter-changed['"]/.test(src),
    'lookup.js does not listen for book-filter-changed — type chip ' +
    'counts go stale after a filter change.');
});

test('book-filter: state round-trips through collectData/loadData', () => {
  // Eval book-filter.js in a sandbox (it has no DOM dependencies for
  // the persistence path — DB.ready resolves to null and getBooks
  // returns []).
  const src = readSource('book-filter.js');
  const sandbox = {
    DB: { ready: Promise.resolve(null), isLoaded: () => false },
    document: {
      dispatchEvent: () => {},
      addEventListener: () => {},
      readyState: 'complete',
    },
    console: { log: () => {}, warn: () => {} },
  };
  // Provide a window stand-in shared with sandbox.
  sandbox.window = sandbox;
  const fn = new Function('window', 'document', 'console', 'DB',
    src + '\nreturn window.BookFilter;');
  const BF = fn(sandbox, sandbox.document, sandbox.console, sandbox.DB);

  // Default: no filter, isActive false, collectData stores null.
  assert(!BF.isActive(), 'default filter should be inactive');
  assert(BF.collectData()._book_filter === null,
    `default collectData should be null, got ${JSON.stringify(BF.collectData())}`);
  assert(BF.allowsSource('Player\'s Handbook') === true,
    'with no filter, all sources are allowed');

  // Set a filter, verify allowsSource (sourceToAbbrev is empty since
  // there's no DB — unknown sources always allowed per design).
  BF.setActiveAbbrevs(new Set(['PHB', 'DMG']));
  assert(BF.isActive(), 'should be active after set');
  const saved = BF.collectData();
  assert(Array.isArray(saved._book_filter)
    && saved._book_filter.length === 2
    && saved._book_filter.includes('PHB')
    && saved._book_filter.includes('DMG'),
    `expected ['PHB','DMG'] in collected data, got ${JSON.stringify(saved)}`);
  // Unknown sources are always allowed (homebrew / future additions).
  assert(BF.allowsSource('Player\'s Handbook') === true,
    'unknown source (no abbrev map) must still be allowed');
  // allowsAbbrev consults the active set directly.
  assert(BF.allowsAbbrev('PHB') === true, 'PHB should be allowed');
  assert(BF.allowsAbbrev('FRCS') === false, 'FRCS should be filtered out');

  // loadData with empty filter clears the active set.
  BF.loadData({ _book_filter: [] });
  assert(!BF.isActive(), 'empty filter should clear the active set');

  // loadData with absent field is a no-op (old saves keep current state).
  BF.setActiveAbbrevs(new Set(['MIC']));
  BF.loadData({});  // no _book_filter key — should leave MIC intact
  assert(BF.getActiveAbbrevs().has('MIC'),
    'loadData on an object without _book_filter must not wipe state');

  // Hide-3.0 3-state migration (added 2026-05-20). The legacy
  // `_hide_30: true` boolean maps forward to mode='all'; the new
  // `_hide_30_mode` field overrides the legacy boolean when both
  // are present.
  BF.setHide30Mode('off');
  assert(BF.getHide30Mode() === 'off', 'default hide-30 mode is off');
  BF.loadData({ _hide_30: true });
  assert(BF.getHide30Mode() === 'all',
    'legacy _hide_30: true must migrate to mode=all, ' +
    `got ${BF.getHide30Mode()}`);
  BF.loadData({ _hide_30_mode: 'counterpart' });
  assert(BF.getHide30Mode() === 'counterpart',
    'mode=counterpart should round-trip');
  // Save format: mode-aware, omits when off.
  BF.setHide30Mode('off');
  const off = BF.collectData();
  assert(!('_hide_30_mode' in off),
    `mode=off should not write _hide_30_mode, got ${JSON.stringify(off)}`);
  BF.setHide30Mode('counterpart');
  const cp = BF.collectData();
  assert(cp._hide_30_mode === 'counterpart',
    `mode=counterpart should serialize, got ${JSON.stringify(cp)}`);
  // Legacy boolean accessors continue to work — false ↔ 'off', true ↔ 'all'.
  BF.setHide30(true);
  assert(BF.getHide30Mode() === 'all',
    'setHide30(true) must map to mode=all (legacy boolean compat)');
  BF.setHide30(false);
  assert(BF.getHide30Mode() === 'off',
    'setHide30(false) must map to mode=off');

  // Counterpart-aware allowsEntry. Without a DB the counterpart index
  // is empty, so 'counterpart' mode never filters anything out (fails
  // open — same posture as unknown-source handling). Only 'all' mode
  // and the explicit source-edition check can drop rows here.
  BF.setHide30Mode('counterpart');
  assert(BF.allowsEntry({ source: 'Magic of Faerun', version: '3.0',
    name: 'Dimensional Lock', type: 'spell' }) === true,
    'with no counterpart index loaded, counterpart mode must fail open');
  // In 'all' mode, an entry with version='3.0' is dropped regardless
  // of counterpart status.
  BF.setHide30Mode('all');
  assert(BF.allowsEntry({ source: 'Magic of Faerun', version: '3.0',
    name: 'Dimensional Lock', type: 'spell' }) === false,
    'mode=all must drop a 3.0 entry');
  // A 3.5 entry is never dropped by hide-3.0 regardless of mode.
  assert(BF.allowsEntry({ source: 'Player\'s Handbook', version: '3.5',
    name: 'Magic Missile', type: 'spell' }) === true,
    'mode=all must not drop a 3.5 entry');
});

test('book-filter: SQL query against entry table is filter-shape compatible', (db) => {
  // Smoke test: the kind of SQL each picker now runs (`SELECT ... e.source
  // FROM entry e WHERE type = ...`) still returns rows of the right
  // shape, with source values that match the book table.
  const rows = execAll(db,
    "SELECT e.id, e.name, e.source FROM entry e "
    + "LEFT JOIN book b ON b.name = e.source "
    + "WHERE e.type = 'race' LIMIT 5");
  assertNotEmpty(rows);
  for (const r of rows) {
    assert(typeof r.source === 'string' && r.source.length > 0,
      `race row ${r.id} has empty source`);
  }
});

// ---- tests: racial / template skill bonuses (2026-06-09) ------------------
// Races (and, once the DB reshape lands, templates) auto-apply their
// structured `bonuses` skill rows to the Skills tab. The categorizer lives
// in data.js (DND35.categorizeSkillBonuses); RacePicker.getActiveSkillBonuses
// layers variant-base inheritance + free-text negation on top; skills.js
// folds the result into per-skill totals + situational notes.

test('skillbonus: categorizeSkillBonuses sorts direct / global / situational', () => {
  const D = loadData();
  const cat = D.categorizeSkillBonuses([
    { bonus_type: 'skill', target: 'Listen', amount: 2, condition: null },
    { bonus_type: 'skill', target: 'Listen', amount: 2, condition: null },            // dup → first-wins
    { bonus_type: 'skill', target: 'Knowledge (nature)', amount: 2, condition: null },// subtype → direct
    { bonus_type: 'skill', target: 'Hide (sandy area)', amount: 4, condition: null }, // cond-in-target
    { bonus_type: 'skill', target: 'Craft', amount: 2, condition: 'related to stone or metal' },
    { bonus_type: 'skill', target: 'all skill checks', amount: 10, condition: null }, // global
    { bonus_type: 'ac', target: 'natural armor', amount: 3, condition: null },        // not a skill → ignored
  ]);
  assert(cat.direct['listen'] === 2, 'plain skill → direct');
  assert(cat.direct['knowledge (nature)'] === 2, 'subtype target → direct (full key)');
  assert(!('hide (sandy area)' in cat.direct), 'condition-in-target is NOT a direct key');
  assert(cat.global === 10, 'all-skills → global');
  assert(Object.keys(cat.direct).length === 2, 'only the 2 unconditional non-global rows are direct');
  const hideSit = cat.situational.find(s => s.skill === 'Hide');
  assert(hideSit && hideSit.amount === 4 && /sandy area/.test(hideSit.condition),
    'Hide (sandy area) → situational keyed to skill "Hide"');
  const craftSit = cat.situational.find(s => s.skill === 'Craft');
  assert(craftSit && /stone or metal/.test(craftSit.condition), 'conditioned Craft → situational');
});

test('skillbonus: categorizeSkillBonuses tolerates junk / non-arrays', () => {
  const D = loadData();
  const empty = D.categorizeSkillBonuses(null);
  assert(empty && empty.direct && empty.global === 0 && Array.isArray(empty.situational),
    'null input → empty shape');
  const c = D.categorizeSkillBonuses([
    { bonus_type: 'skill', target: '', amount: 2 },      // no target → skip
    { bonus_type: 'skill', target: 'Spot', amount: 0 },  // 0 amount → skip
    { bonus_type: 'skill', target: 'Spot' },             // no amount → skip
  ]);
  assert(Object.keys(c.direct).length === 0 && c.situational.length === 0, 'junk rows skipped');
});

test('skillbonus: DB — Elf carries structured Listen/Search/Spot skill bonuses', (db) => {
  const row = execAll(db,
    "SELECT data FROM entry WHERE type='race' AND name='Elf' "
    + "ORDER BY CASE version WHEN '3.5' THEN 0 ELSE 1 END LIMIT 1")[0];
  assert(row, 'Elf race entry exists');
  const skills = (JSON.parse(row.data).bonuses || [])
    .filter(b => b.bonus_type === 'skill').map(b => String(b.target).toLowerCase());
  for (const s of ['listen', 'search', 'spot']) {
    assert(skills.includes(s), `Elf has a structured ${s} skill bonus (got: ${skills.join(', ')})`);
  }
});

test('skillbonus: DB — a UA variant still carries a "No racial bonus" negation trait', (db) => {
  // Arctic Elf negates Elf's inherited Search bonus via free text. If that
  // negation phrasing changes, RacePicker.parseSkillNegations needs a look.
  const row = execAll(db,
    "SELECT data FROM entry WHERE type='race' AND name='Arctic Elf' LIMIT 1")[0];
  assert(row, 'Arctic Elf entry exists');
  const blob = JSON.stringify(JSON.parse(row.data).traits || []);
  assert(/no\s+racial bonus on/i.test(blob),
    'Arctic Elf still has a "No racial bonus on …" negation trait');
});

test('skillbonus: data.js exposes categorizeSkillBonuses', () => {
  assert(/categorizeSkillBonuses\s*\(/.test(readSource('data.js')),
    'DND35.categorizeSkillBonuses defined');
});

test('skillbonus: race-picker exposes getActiveSkillBonuses + dispatches race-changed', () => {
  const src = readSource('race-picker.js');
  assert(/window\.RacePicker\s*=\s*\{[\s\S]*getActiveSkillBonuses/.test(src),
    'race-picker exports getActiveSkillBonuses');
  assert(/new CustomEvent\(['"]race-changed['"]\)/.test(src),
    'race-picker dispatches race-changed');
  assert(/parseSkillNegations/.test(src) && /applySkillNegations/.test(src),
    'race-picker has variant negation parse + apply');
});

test('skillbonus: template-picker exposes a (generic) getActiveSkillBonuses', () => {
  const src = readSource('template-picker.js');
  assert(/getActiveSkillBonuses/.test(src), 'template-picker defines getActiveSkillBonuses');
  assert(/categorizeSkillBonuses/.test(src),
    'template consumer uses the shared categorizer (no bespoke prose parser)');
});

test('skillbonus: skills.js recalc consumes race + template skill bonuses', () => {
  const src = readSource('skills.js');
  assert(/RacePicker\.getActiveSkillBonuses/.test(src), 'skills.js reads RacePicker bonuses');
  assert(/TemplatePicker\.getActiveSkillBonuses/.test(src), 'skills.js reads TemplatePicker bonuses');
});

test('skillbonus: app.js wires race-changed → recalc', () => {
  assert(/addEventListener\(["']race-changed["']/.test(readSource('app.js')),
    'app.js listens for race-changed');
});

// ---- tests: Spell-Like Abilities sub-tab (2026-06-09) ---------------------
// A Spells-tab sub-tab (type "sla") delegating to the SLA module
// (sla.js), mirroring the shadowcaster pattern. Per-entry caster level /
// key ability / save DC (sources differ); usage tracking via checkboxes;
// DC auto-computes from the mimicked spell's level (Sorcerer/Wizard →
// Cleric → Druid) + ability mod, with manual override.

test('sla: module exposes its public API', () => {
  const src = readSource('sla.js');
  assert(/function buildHTML/.test(src), 'sla.js defines buildHTML');
  assert(/function wire/.test(src), 'sla.js defines wire');
  assert(/function collect/.test(src), 'sla.js defines collect');
  assert(/function refreshDCs/.test(src), 'sla.js defines refreshDCs');
  assert(/return \{[\s\S]*buildHTML[\s\S]*wire[\s\S]*collect[\s\S]*refreshDCs/.test(src),
    'sla.js exports the public API');
});

test('sla: spells.js wires the sla caster type (build + collect + default name + DC refresh)', () => {
  const src = readSource('spells.js');
  assert(/type === "sla"/.test(src), 'addCaster + collectData branch on "sla"');
  assert(/SLA\.buildHTML/.test(src) && /SLA\.wire/.test(src), 'addCaster delegates to SLA');
  assert(/SLA\.collect/.test(src), 'collectData delegates to SLA.collect');
  assert(/sla:\s*"Spell-Like Abilities"/.test(src), 'DEFAULT_NAMES includes sla');
  assert(/SLA\.refreshDCs/.test(src), 'recalc refreshes SLA DCs');
});

test('sla: app.js + index.html wire the add button + register the module', () => {
  assert(/btn-add-sla/.test(readSource('app.js')), 'app.js wires btn-add-sla');
  const html = readSource('index.html');
  assert(/id="btn-add-sla"/.test(html), 'index.html has the + SLA button');
  assert(/'sla\.js'/.test(html), 'index.html registers sla.js in the module list');
});

test('sla: DC spell-level lookup resolves via Sorcerer/Wizard -> Cleric -> Druid', (db) => {
  // Mirrors SLA.lookupSpellLevel's query + class priority.
  const resolve = (name) => {
    const rows = execAll(db,
      "SELECT scl.class_name AS cls, scl.level AS lvl FROM entry e "
      + "JOIN spell_class_level scl ON scl.entry_id = e.id "
      + "WHERE e.type='spell' AND LOWER(e.name)=?", [name]);
    const byClass = {};
    for (const r of rows) if (!(r.cls in byClass) || r.lvl < byClass[r.cls]) byClass[r.cls] = r.lvl;
    for (const cls of ['Sorcerer', 'Wizard', 'Cleric', 'Druid']) if (cls in byClass) return byClass[cls];
    return rows.length ? Math.min.apply(null, rows.map(r => r.lvl)) : null;
  };
  assert(resolve('darkness') === 2, 'Darkness → arcane level 2');
  assert(resolve('faerie fire') === 1, 'Faerie Fire → Druid level 1 (no arcane/cleric)');
});

test('sla: sla.js exposes the source-injection API', () => {
  const src = readSource('sla.js');
  assert(/return \{[\s\S]*syncSource[\s\S]*clearSourcePrefix/.test(src),
    'sla.js exports syncSource + clearSourcePrefix');
  assert(/data-from-source/.test(src), 'rows are source-tagged for reconciliation');
});

test('sla: race-picker auto-populates the SLA tab from structured spell_likes', () => {
  const src = readSource('race-picker.js');
  assert(/buildRaceSLAEntries/.test(src), 'race-picker builds SLA entries from spell_likes');
  assert(/SLA\.syncSource/.test(src), 'race-picker injects via SLA.syncSource');
  assert(/SLA\.clearSourcePrefix\(['"]Race:['"]\)/.test(src), 'race-picker reconciles Race: SLA rows');
  assert(src.includes('spell-?like'), 'race-picker filters the SLA trait out of Special Abilities');
  assert(/resolveSLACasterLevel/.test(src) && /resolveSLAAbility/.test(src) && /resolveSLAFreq/.test(src),
    'race-picker resolves caster-level / ability / frequency formulas');
});

test('sla: DB — structured spell_likes races carry consumable SLA data', (db) => {
  // Phase 1b auto-pops races with a non-empty structured spell_likes array.
  // Guard the contract on a known one (Drow); a future rebuild that drops or
  // reshapes it should fail here, not silently stop auto-populating.
  // Drow has multiple source entries (Drow of the Underdark has no
  // spell_likes; FRCS carries the 3 SLAs the picker resolves). Assert that
  // at least one Drow entry carries the structured data the feature consumes.
  const rows = execAll(db, "SELECT data FROM entry WHERE type='race' AND name='Drow'");
  assertNotEmpty(rows, 'Drow race entries exist');
  const withSL = rows
    .map((r) => JSON.parse(r.data).spell_likes)
    .filter((sl) => Array.isArray(sl) && sl.length);
  assert(withSL.length, 'at least one Drow entry has a non-empty structured spell_likes');
  const sl = withSL[0];
  assert(sl.some((e) => (e.spell_name || '').toLowerCase() === 'darkness'),
    'Drow spell_likes includes darkness');
  assert(sl.every((e) => 'frequency' in e && 'caster_level_formula' in e),
    'spell_likes rows carry frequency + caster_level_formula');
});

test('race-picker: raceIndex resolution is newest-source-wins (first-wins)', () => {
  // The populate loop orders rows newest-first (3.5 before 3.0, then
  // publication_date DESC), so it must set raceIndex only on the FIRST
  // occurrence per name. Setting it every iteration is last-set-wins, which
  // silently inverts the tiebreak to oldest-source-wins (the bug fixed
  // 2026-06-10 that made Drow resolve FRCS over Drow of the Underdark).
  const src = readSource('race-picker.js');
  assert(
    /if \(!raceIndex\.has\(r\.name\.toLowerCase\(\)\)\) \{[\s\S]*?raceIndex\.set\(r\.name\.toLowerCase\(\), r\.race_id\);[\s\S]*?\}/.test(src),
    'raceIndex.set is guarded by !raceIndex.has (first/newest wins)');
});

test('sla: race auto-pop borrows spell_likes from a sibling printing when the winner lacks them', () => {
  // Newest-wins resolves the most recent printing, which may lack the
  // structured spell_likes an older one carries (Drow of the Underdark /
  // Planar Handbook). The sibling-fallback keeps Aasimar/Drow/Tiefling
  // auto-populating until the DB reshape structures every printing.
  const src = readSource('race-picker.js');
  assert(/function siblingSpellLikes/.test(src), 'race-picker defines siblingSpellLikes');
  assert(/sl = siblingSpellLikes\(raceName\)/.test(src),
    'buildRaceSLAEntries falls back to a sibling printing');
});

// ---- tests: Shadowcaster mystery DC fix (2026-06-09) ----------------------
// Mystery save DC = 10 + mystery level + ability mod. The ability mod must
// come from the bonus-aware mod fn Spells.recalc hands in via
// Shadowcaster.refreshDCs (the same getModWithBonuses the rest of the Spells
// tab uses) — NOT window.getAbilityMod, which app.js never exposes, so the
// old code silently computed every DC with mod = 0 (a 1st-level mystery
// always showed DC 11 regardless of Cha). Mirrors the SLA fix above.

test('shadowcaster: module exposes refreshDCs in its public API', () => {
  const src = readSource('shadowcaster.js');
  assert(/function refreshDCs/.test(src), 'shadowcaster.js defines refreshDCs');
  assert(/return \{[\s\S]*buildHTML[\s\S]*wire[\s\S]*collect[\s\S]*refreshDCs/.test(src),
    'shadowcaster.js exports refreshDCs alongside buildHTML/wire/collect');
});

test('shadowcaster: recalcDC reads the seeded mod fn, not window.getAbilityMod', () => {
  const src = readSource('shadowcaster.js');
  // Guard against *using* it (call or typeof/=== compare) — a mention in the
  // explanatory comment is fine, so match window.getAbilityMod followed by
  // '(' or '=' (after optional whitespace), not a bare reference.
  assert(!/window\.getAbilityMod\s*[(=]/.test(src),
    'shadowcaster.js must NOT call/compare window.getAbilityMod (app.js never sets it → DC mod silently 0)');
  assert(/typeof _getMod === "function"/.test(src),
    'recalcDC gates on the module-level _getMod fn seeded by refreshDCs');
});

test('shadowcaster: spells.js recalc refreshes shadowcaster DCs with the bonus-aware mod fn', () => {
  const src = readSource('spells.js');
  assert(/Shadowcaster\.refreshDCs/.test(src), 'recalc refreshes Shadowcaster DCs');
  assert(/\[data-caster-type='shadowcaster'\][\s\S]*Shadowcaster\.refreshDCs\(panel, _getAbilityMod\)/.test(src),
    'shadowcaster panels are refreshed with _getAbilityMod (the bonus-aware mod fn), not a bare getAbilityMod');
});

// ---- tests: rich-text.js (shared tables renderer + long-text formatter) ----
//
// Added 2026-06-09 with the readability pass (structured-tables
// rendering everywhere + long class-feature auto-collapse). The DB
// carries TWO table dialects — {caption, columns, rows} (439 tables)
// and {name, headers, rows} (16) — and the pre-RichText lookup
// renderer only understood the second, so the first rendered as a
// raw JSON <pre> dump. These tests run the REAL renderer over EVERY
// table in the DB so a future extraction that introduces a third
// dialect goes red here instead of silently JSON-dumping in the UI.

function loadRichText() {
  const src = fs.readFileSync(path.join(ROOT, 'rich-text.js'), 'utf8');
  const fn = new Function('window', src + '\nreturn window.RichText;');
  return fn({});
}

test('richtext: module evaluates in Node and exposes the API', () => {
  const RT = loadRichText();
  assert(typeof RT.renderTable === 'function', 'renderTable missing');
  assert(typeof RT.renderTables === 'function', 'renderTables missing');
  assert(typeof RT.formatFeatureText === 'function', 'formatFeatureText missing');
  assert(typeof RT.escapeHtml === 'function', 'escapeHtml missing');
});

test('richtext: DB-wide — every structured table renders as a real <table>', (db) => {
  // Both dialects, all 17 types. A table falling through to the
  // freeform <pre> fallback (the old JSON-dump failure mode) fails
  // this test; so does a table shape with no rows/columns at all.
  const RT = loadRichText();
  const rows = execAll(db,
    "SELECT name, type, data FROM entry " +
    "WHERE json_extract(data, '$.tables') IS NOT NULL");
  let entries = 0, tables = 0;
  for (const r of rows) {
    const tb = JSON.parse(r.data).tables;
    if (!Array.isArray(tb) || !tb.length) continue;
    entries++;
    for (const t of tb) {
      tables++;
      const html = RT.renderTable(t);
      // null-safe shape descriptor: a null/scalar table element (which is
      // itself the defect) must not make Object.keys() throw and mask WHICH
      // entry failed — report its value instead of its keys.
      const shape = (t && typeof t === 'object')
        ? `keys=${Object.keys(t).join(',')}`
        : `value=${JSON.stringify(t)}`;
      assert(html.includes('<table'),
        `${r.type}:${r.name} — table did not render as <table>: ${shape}`);
      assert(!html.includes('rt-table-freeform'),
        `${r.type}:${r.name} — table hit the freeform JSON fallback`);
    }
  }
  // Audited 2026-06-09: 320 entries / 498 tables. Floor well below
  // that so DB content shifts don't false-fail, but high enough that
  // a broken json_extract or shape change is obvious.
  assertGE(entries, 250, `only ${entries} entries with non-empty tables`);
  assertGE(tables, 400, `only ${tables} tables rendered`);
});

test('richtext: both caption dialects + notes variants normalize', () => {
  const RT = loadRichText();
  // Walk dialect: caption / columns / rows + footnotes list.
  const a = RT.renderTable({
    caption: 'Cap A', columns: ['X', 'Y'], rows: [['1', '2']],
    footnotes: ['note one', 'note two'],
  });
  assert(a.includes('Cap A') && a.includes('<th>X</th>')
    && a.includes('<td>1</td>'), 'walk dialect broken');
  assert(a.includes('note one') && a.includes('note two'),
    'footnotes list dropped');
  // Core-rules dialect: name / headers / rows + notes string.
  const b = RT.renderTable({
    name: 'Cap B', headers: ['H1'], rows: [['v']], notes: 'a note',
  });
  assert(b.includes('Cap B') && b.includes('<th>H1</th>')
    && b.includes('a note'), 'core-rules dialect broken');
  // Spanning group-header line (rare `header` key).
  const c = RT.renderTable({
    caption: 'Cap C', header: 'Span | Group', columns: ['A', 'B'],
    rows: [['1', '2']],
  });
  assert(c.includes('colspan="2"') && c.includes('Span | Group'),
    'spanning header line dropped');
  // Null cells render as empty, not "null".
  const d = RT.renderTable({ columns: ['A'], rows: [[null]] });
  assert(!d.includes('null'), 'null cell rendered as "null"');
});

test('richtext: formatFeatureText collapses 3000+ chars into <details>', () => {
  const RT = loadRichText();
  const sentence = 'This is a reasonably long sentence about drift. ';
  const long = sentence.repeat(80); // ~3900 chars, no newlines
  const html = RT.formatFeatureText(long);
  assert(html.includes('<details class="rt-collapse">'),
    'long text did not collapse');
  assert(html.includes('rt-collapse-lead') && html.includes('rt-collapse-rest'),
    'collapse structure missing lead/rest');
  assert(html.includes('show full text'), 'collapse hint missing');
  // Short text renders inline with no details wrapper.
  const short = RT.formatFeatureText('Just a short feature.');
  assert(!short.includes('<details'), 'short text wrongly collapsed');
  // Nothing of the original text may be lost: lead + rest together
  // must cover the input (whitespace-insensitive).
  const squash = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
  const inputSquashed = squash(RT.escapeHtml(long));
  const outputSquashed = squash(html).replace(/…showfulltext▾/, '');
  assert(outputSquashed.includes(inputSquashed.slice(0, 200)),
    'collapsed output lost leading text');
  assert(outputSquashed.endsWith(inputSquashed.slice(-200)),
    'collapsed output lost trailing text');
});

test('richtext: sub-heading bolding fires on newline texts only', () => {
  const RT = loadRichText();
  const structured = 'Intro line.\nCalling a Spell: do the thing.\n' +
    'Spellpool Debt: pay it back.';
  const html = RT.formatFeatureText(structured);
  assert(html.includes('<b>Calling a Spell:</b>'),
    'line-start heading not bolded');
  assert(html.includes('<b>Spellpool Debt:</b>'),
    'second heading not bolded');
  // Flat blob (no newlines): NO heading heuristics, even with a
  // colon-terminated phrase present mid-text.
  const flat = 'A flat blob where Stage One: appears inline mid-sentence.';
  assert(!RT.formatFeatureText(flat).includes('<b>'),
    'flat blob wrongly got heading bolding');
});

test('richtext: all rendered output is HTML-escaped', () => {
  const RT = loadRichText();
  const t = RT.renderTable({
    caption: '<script>x</script>', columns: ['<b>'], rows: [['<i>']],
    notes: '<u>',
  });
  assert(!t.includes('<script>') && !t.includes('<b>')
    && !t.includes('<i>') && !t.includes('<u>'),
    'table renderer emitted unescaped input HTML');
  const f = RT.formatFeatureText('<script>alert(1)</script>');
  assert(!f.includes('<script>'), 'formatter emitted unescaped input HTML');
});

test('richtext: lookup.js delegates renderRuleTable to RichText', () => {
  // The local pre-RichText renderer only understood the `headers`
  // dialect — the `columns` dialect (42 rule tables) JSON-dumped.
  // Guard the delegation so the bug can't quietly come back.
  const src = readSource('lookup.js');
  const body = extractFunctionBody(src, 'renderRuleTable');
  assert(body && body.includes('RichText.renderTable'),
    'lookup.js renderRuleTable no longer delegates to RichText');
  const detail = extractFunctionBody(src, 'renderDetailHtml');
  assert(detail && detail.includes('renderEntryTables'),
    'lookup.js renderDetailHtml no longer renders non-rule entry tables');
});

test('richtext: feats.js class-feature ⓘ prefers raw_text over description', () => {
  // The Wilder Wild Surge divergence (2026-05-25): description is a
  // summary; raw_text is the full verbatim mechanics. The ⓘ panel
  // must read raw_text first or players see truncated rules.
  // NB: extractFunctionBody can't parse this function — its parameter
  // list is a destructuring pattern (`({ className, abilityName })`),
  // so the brace-matcher grabs the params as the "body". Source-level
  // regex instead.
  const src = readSource('feats.js');
  assert(/feat\.raw_text\s*\|\|\s*feat\.description/.test(src),
    'feats.js renderClassFeatureRules must prefer feat.raw_text');
});

test('richtext: picker detail queries pull $.tables', () => {
  // Every picker whose entry types carry structured tables today.
  // template-picker parses the whole data blob instead of a
  // json_extract column, so it's checked for the parsed-field read.
  for (const file of ['feat-picker.js', 'item-picker.js',
                      'spell-picker.js', 'power-picker.js',
                      'class-picker.js', 'feats.js']) {
    const src = readSource(file);
    assert(src.includes("'$.tables'"),
      `${file} detail query no longer selects $.tables`);
    assert(src.includes('RichText.renderTables'),
      `${file} no longer renders tables via RichText`);
  }
  const tpl = readSource('template-picker.js');
  assert(tpl.includes('parsed.tables') &&
         tpl.includes('RichText.renderTables'),
    'template-picker.js no longer surfaces parsed.tables via RichText');
});

test('richtext: index.html loads rich-text.js with the shared picker aids', () => {
  const html = readSource('index.html');
  const rtIdx = html.indexOf("'rich-text.js'");
  assert(rtIdx > 0, 'rich-text.js missing from the module loader list');
  const firstPicker = html.indexOf("'race-picker.js'");
  assert(firstPicker > rtIdx,
    'rich-text.js must load before the pickers that consume it');
});

// ---- tests: power-picker errata badge (2026-06-10) -------------------------
//
// The index query aliases `id AS power_id`, but rebuildIndex builds
// rec objects with `id:` — so `ErrataBadge.attach(info, rec.power_id)`
// passed undefined and the badge NEVER rendered in the power-picker
// info panel. The bug hid behind a wrong assumption ("no power errata
// records exist" — read off a stale coverage summary instead of the
// table); in fact 26 powers carry errata. Two guards: the data-level
// one kills the assumption, the static one pins the field name to
// the one the rec actually defines.

test('errata: powers DO carry errata records (>= 10)', (db) => {
  const r = execOne(db,
    "SELECT COUNT(DISTINCT e.id) AS n FROM errata er " +
    "JOIN entry e ON e.id = er.entry_id WHERE e.type = 'power'");
  assertGE(r.n, 10,
    `only ${r.n} powers with errata — if a DB rebuild really removed ` +
    `them, update this floor deliberately, don't assume`);
});

test('errata: power-picker attaches the badge with rec.id (not rec.power_id)', () => {
  const src = readSource('power-picker.js');
  assert(src.includes('ErrataBadge.attach(info, rec.id)'),
    'power-picker must attach the errata badge with rec.id — the ' +
    'rebuildIndex rec defines `id`, not `power_id`');
  assert(!/ErrataBadge\.attach\(info,\s*rec\.power_id\)/.test(src),
    'power-picker regressed to rec.power_id (undefined on the rec)');
});

// ---- tests: errata-badge advisory default + cross-printing (2026-06-10) ----
//
// Ryan's policy: advisory errata must surface everywhere — there is
// no way to know whether the information is relevant to the user, so
// it has to be AVAILABLE. Two behaviors carry it:
//   1. hasErrata defaults to advisory-INCLUSIVE (opts.applied===true
//      is the explicit applied-only filter; nobody uses it today).
//   2. Cross-printing fallback: records attach to one entry row, but
//      the same item can be printed in several books — Astral
//      Construct's errata hangs on the XPH row while the power-
//      picker's name-dedupe resolves the Complete Psionic row. The
//      family key includes VERSION deliberately (3.0/3.5 same-name
//      union would be the Dimensional Lock edition-conflation trap).
// These evaluate the REAL module in Node against the REAL DB.

function loadErrataBadge(db) {
  const src = fs.readFileSync(path.join(ROOT, 'errata-badge.js'), 'utf8');
  const dbStub = {
    isLoaded: () => true,
    query: (sql, params) => execAll(db, sql, params),
    queryOne: (sql, params) => execOne(db, sql, params),
  };
  const windowStub = { DB: dbStub };
  const documentStub = { addEventListener: () => {} };
  const fn = new Function('window', 'document', 'DB',
    src + '\nreturn window.ErrataBadge;');
  return fn(windowStub, documentStub, dbStub);
}

test('errata: hasErrata defaults advisory-inclusive', (db) => {
  const EB = loadErrataBadge(db);
  // XPH Astral Construct carries ONLY advisory records (applied=0).
  const xph = execOne(db,
    "SELECT id FROM entry WHERE type='power' AND name='Astral Construct' " +
    "AND source='Expanded Psionics Handbook'");
  assert(xph, 'XPH Astral Construct missing — revisit this test, do not assume');
  assert(EB.hasErrata(xph.id) === true,
    'advisory-only entry must report hasErrata under the default');
  assert(EB.hasErrata(xph.id, { applied: true }) === false,
    'opts.applied=true must still filter to applied-only records');
});

test('errata: cross-printing fallback unites same-(type,version,name) rows', (db) => {
  const EB = loadErrataBadge(db);
  const cpsi = execOne(db,
    "SELECT id FROM entry WHERE type='power' AND name='Astral Construct' " +
    "AND source='Complete Psionic'");
  assert(cpsi, 'CPsi Astral Construct missing — revisit this test, do not assume');
  // No errata attach to the CPsi row directly…
  const direct = execOne(db,
    "SELECT COUNT(*) AS n FROM errata WHERE entry_id = ?", [cpsi.id]);
  assert(direct.n === 0,
    'precondition shifted: CPsi row now has direct errata — update test');
  // …but the XPH printing's records must surface through the family.
  assert(EB.hasErrata(cpsi.id) === true,
    'same-version sibling printing must surface the XPH errata');
  // Family with zero applied records stays false under applied-only.
  assert(EB.hasErrata(cpsi.id, { applied: true }) === false,
    'applied-only filter must apply at the family level too');
});

test('errata: popover aggregates the printing family (static)', () => {
  const src = readSource('errata-badge.js');
  assert(src.includes('errataIdsFor(entryId)') &&
         /entry_id IN \(/.test(src),
    'openPopover must query the cross-printing id family via errataIdsFor');
});

test('natural-armor: race-picker prefers the structured field', () => {
  // race-picker projects data.natural_armor and prefers it over the legacy
  // bonuses-row / trait-text parse (recovers NA on the 44 monster races that
  // carry the field but no structured bonuses natural-armor row). Fallback to
  // naturalArmorFromBonuses must survive for old blobs.
  const src = readSource('race-picker.js');
  assert(/natural_armor:\s*\(typeof parsed\.natural_armor/.test(src),
    'race-picker must fold parsed.natural_armor into the race projection.');
  assert(/typeof race\.natural_armor === 'number'[\s\S]{0,120}naturalArmorFromBonuses/.test(src),
    'race-picker NA-apply must prefer race.natural_armor, fall back to the bonuses parse.');
});

test('natural-armor: field-only monster races have a positive natural_armor', (db) => {
  // The value the field-preference relies on: monster races carry the field.
  const rows = db.exec(
    "SELECT COUNT(*) AS n FROM entry WHERE type='race' " +
    "AND CAST(json_extract(data,'$.natural_armor') AS INTEGER) > 0");
  const n = rows[0].values[0][0];
  assert(n >= 40, `expected >=40 races with natural_armor > 0, got ${n}`);
});

test('natural-armor: companion AUTO prefers the field + keeps it authoritative through templates', () => {
  const src = readSource('companion.js');
  assert(/typeof creature\.natural_armor === 'number'/.test(src),
    'companion autoFill must prefer creature.natural_armor for baseNA.');
  // applyTemplateToCreature must write template NA onto the FIELD (not just
  // the ac text) so preferring the field can't drop a template contribution —
  // now from the structured natural_armor_change / natural_armor_set fields.
  assert(/out\.natural_armor\s*=\s*newNa/.test(src),
    'applyTemplateToCreature must write the new NA total onto out.natural_armor.');
});

test('focus-aggregator: feats.js exposes Weapon/Spell Focus detectors', () => {
  const src = readSource('feats.js');
  for (const fn of ['getWeaponFocusBonuses', 'getSpellFocusBonuses']) {
    assert(src.includes(fn), `feats.js must export ${fn}.`);
  }
  // Greater variants stack on base (the (?:greater\s+)? prefix is optional).
  assert(src.includes('(?:greater\\s+)?weapon\\s+focus'),
    'getWeaponFocusBonuses must match both Weapon Focus and Greater Weapon Focus.');
  assert(src.includes('(?:greater\\s+)?spell\\s+focus'),
    'getSpellFocusBonuses must match both Spell Focus and Greater Spell Focus.');
});

test('focus-aggregator: app.js collects weaponFocus + spellFocus into bonuses', () => {
  const src = readSource('app.js');
  assert(/bonuses\.weaponFocus\s*=/.test(src) && /bonuses\.spellFocus\s*=/.test(src),
    'collectActiveBonuses must populate bonuses.weaponFocus and bonuses.spellFocus.');
  assert(/Spells\.recalc\(getModWithBonuses,\s*bonuses\)/.test(src),
    'recalcAll must pass bonuses to Spells.recalc so the DC note can render.');
});

test('focus-aggregator: character.js consumes weaponFocus with whole-word match', () => {
  const src = readSource('character.js');
  assert(src.includes('bonuses.weaponFocus'),
    'character.js attack calc must read bonuses.weaponFocus.');
  assert(src.includes('weaponFocusMatches'),
    'character.js must gate the +1 through weaponFocusMatches.');
  // Whole-word boundary so "sword" can't leak into "longsword".
  assert(src.includes('"\\\\b" + esc + "\\\\b"'),
    'weaponFocusMatches must use \\b word boundaries around the feat weapon.');
});

test('focus-aggregator: spells.js surfaces Spell Focus as a per-panel note', () => {
  const src = readSource('spells.js');
  assert(/function recalc\(getAbilityMod, bonuses\)/.test(src),
    'Spells.recalc must accept the bonuses arg.');
  for (const fn of ['formatSpellFocusNote', 'applySpellFocusNote']) {
    assert(src.includes(fn), `spells.js must define ${fn}.`);
  }
  assert(src.includes('sc-focus-note'),
    'spells.js must inject the .sc-focus-note element.');
});

test('source: no stray control bytes in any module (heredoc escape corruption)', () => {
  // CLAUDE.md forbids writing file CONTENT through a bash heredoc because the
  // escaping layers (shell -> Python -> regex) silently mangle backslashes.
  // On 2026-08-21 I did it anyway and every `\b` word boundary in
  // soulmeld-effects.js became a literal BACKSPACE byte: Python reads `\b` as
  // the backspace escape. The file still PARSED — a control character inside a
  // regex literal is just a character — the module loaded, no error appeared,
  // and every word boundary silently stopped matching. Parse-checking cannot
  // see it and neither can review.
  //
  // So: a byte-level guard. NOTHING below 0x20 belongs in source but tab, LF
  // and CR.
  //
  // NUL used to be allowed here, because lookup.js used a raw one as a
  // composite-key separator. That allowance was load-bearing in the wrong
  // direction: on 2026-08-21 a raw NUL got into soulmeld-effects.js as a
  // sentinel and this guard waved it through, because it could not tell a
  // deliberate separator from a mangled escape. They are the same byte. The
  // fix was to stop writing the byte at all — lookup.js and live-publish.js
  // both spell it as a unicode escape now, which is identical at runtime and
  // a reader — so the allowance is gone and the guard can be absolute.
  const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.js'))
    .concat(fs.readdirSync(path.join(ROOT, 'tests'))
      .filter(f => f.endsWith('.js')).map(f => path.join('tests', f)));
  const offenders = [];
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      const allowed = b === 0x09 || b === 0x0a || b === 0x0d;
      if (b < 0x20 && !allowed) {
        offenders.push(`${rel}: 0x${b.toString(16)} at byte ${i} — ` +
          JSON.stringify(buf.slice(Math.max(0, i - 30), i + 15).toString('utf8')));
        break;
      }
    }
  }
  assert(offenders.length === 0,
    'Control bytes in source — almost certainly a mangled backslash escape ' +
    'from a scripted edit:\n  ' + offenders.join('\n  '));
});

// ---- live bus (phase 2 — inbound writes) ---------------------------------
//
// The writable-field list necessarily exists twice: the SERVER owns the
// ownership split (what a consumer may write, and why the rest is refused) and
// the TAB owns the DOM mapping (where a blessed field actually lives). Those
// are two different questions, but they are indexed by the same set of field
// paths — so the duplication is real and the only honest answer is to gate it.
// Both lists are written with character-identical pattern sources; this test
// parses them out of the two files and fails on any divergence. Without it,
// adding a field on one side lands as a silent no-op at 2am mid-combat.

// Both readers tolerate either line ending: save_server.py sits in a CRLF
// working tree on Windows while the JS modules are LF, and a test that only
// passes under one of them is a test that fails for the wrong reason later.
function liveServerPatterns() {
  const src = readSource('save_server.py');
  const block = src.match(/^LIVE_WRITABLE = \[\r?\n([\s\S]*?)^\]/m);
  assert(block, 'save_server.py must define a LIVE_WRITABLE list.');
  return (block[1].match(/r"([^"]+)"/g) || []).map((s) => s.slice(2, -1));
}

function liveTabPatterns() {
  const src = readSource('live-commands.js');
  const block = src.match(/^  var FIELDS = \[\r?\n([\s\S]*?)^  \];/m);
  assert(block, 'live-commands.js must define a FIELDS list.');
  return (block[1].match(/pattern: \/([^/]+)\//g) || [])
    .map((s) => s.replace(/^pattern: \//, '').replace(/\/$/, ''));
}

test('live: the writable-field list is identical on both halves of the bus', () => {
  const server = liveServerPatterns();
  const tab = liveTabPatterns();
  assertGE(server.length, 8, 'expected the server allowlist to be populated');
  assertEq(tab.length, server.length,
    'live-commands.js FIELDS and save_server.py LIVE_WRITABLE have different ' +
    `lengths — server [${server.join(', ')}] vs tab [${tab.join(', ')}]`);
  server.forEach((pattern, i) => {
    assertEq(tab[i], pattern,
      `live bus field #${i} diverges: the server allows \`${pattern}\` and the ` +
      `tab maps \`${tab[i]}\`. Both lists must carry the same pattern sources ` +
      'in the same order.');
  });
});

test('live: structural fields are refused with a reason, not merely unknown', () => {
  const src = readSource('save_server.py');
  const block = src.match(/^LIVE_NOT_WRITABLE = \[\r?\n([\s\S]*?)^\]/m);
  assert(block, 'save_server.py must define LIVE_NOT_WRITABLE.');
  // The ownership split's sheet-owned side. A consumer reaching for one of
  // these must get told WHY, or the refusal reads as a typo and invites a retry.
  for (const owned of ['hp\\.total', 'abilities', 'identity', 'capacity']) {
    assert(new RegExp(owned).test(block[1]),
      `LIVE_NOT_WRITABLE must explain refusals for ${owned}.`);
  }
  assert(/live_field_check/.test(src) && /LIVE_WRITABLE/.test(src),
    'live_field_check must consult the allowlist before the refusal hints.');
});

test('live: a write fails fast when no fresh tab is publishing', () => {
  const src = readSource('save_server.py');
  const body = src.slice(src.indexOf('def _api_live_write'));
  // Mirror of the read side's staleness contract: queueing a write for a tab
  // that may never return is worse than refusing it, because the writer is
  // told nothing happened and moves on.
  assert(/no-live-tab/.test(body) && /stale-tab/.test(body),
    '_api_live_write must distinguish "never open" from "went stale" and ' +
    'refuse both with 409 rather than queueing.');
  assert(/"unknown"/.test(body) && /claimed-but-no-ack/.test(body),
    'the outcome must be three-state — a tab that claimed a write and went ' +
    'quiet is neither applied nor not-applied, and folding it into either ' +
    'is inventing a fact.');
  assert(/expires_at/.test(src),
    'commands must carry a deadline so a stale one is dropped at dispatch ' +
    'rather than applied late.');
});

test('live: defensive riders publish structured, and absence is not "none"', () => {
  const pub = readSource('live-publish.js');
  const mod = readSource('defense-riders.js');

  // The rider block must carry the DB's OWN field names. Aliasing them here
  // would put a second vocabulary between the book and the bus, which is the
  // drift the DB project's canon rule exists to prevent.
  for (const field of ['resistances', 'immunities', 'vulnerabilities',
                       'fast_healing', 'regeneration']) {
    assert(new RegExp(`\\b${field}\\b`).test(mod),
      `defense-riders.js must use the DB's field name \`${field}\`.`);
    assert(new RegExp(`\\b${field}\\b`).test(pub),
      `live-publish.js must publish \`${field}\`.`);
  }

  // THE migration guard. Every character built before this module has an empty
  // rider list AND rider prose in its notes; publishing a bare [] for them
  // would read as "takes full damage" and get narrated out loud.
  assert(/notes_may_contain_riders/.test(pub) && /notes_may_contain_riders/.test(mod),
    'live-publish.js must emit `notes_may_contain_riders` so an empty rider ' +
    'list cannot be read as a clean "none" during the migration window.');

  // With the module absent the publisher must omit the keys entirely, not
  // emit empty arrays — "not modelled" and "none" are different statements.
  const ridersFn = extractFunctionBody(pub, 'riders');
  assert(ridersFn, "Couldn't extract live-publish.js#riders");
  assert(/return\s*\{\s*\}/.test(ridersFn),
    'live-publish.js#riders must return {} (omitting the keys) when the ' +
    'module is unavailable — empty arrays would claim "none".');

  // DR is structured with a per-entry `stacks` flag, and the sheet must NOT
  // resolve it to a single number: RAW is "best DR the attack fails to bypass",
  // which depends on what the attack is made of — something only the consumer
  // knows. A resolved figure would be wrong for most attacks.
  assert(/damage_reduction:\s*s\.damage_reduction/.test(pub),
    'live-publish must publish the structured DR entries.');
  assert(/damage_reduction_text/.test(pub),
    'live-publish must also ship the books\' own notation for anything that ' +
    'just wants to print it.');
  assert(/\bstacks\b/.test(mod),
    'DR entries must carry a `stacks` flag — the default is non-stacking ' +
    '(DMG p.292) but eight DB sources explicitly override it.');

  // The legacy free-text migration must refuse rather than half-parse, and
  // must never overwrite rows the player already has.
  const drFn = extractFunctionBody(mod, 'parseDRText');
  assert(drFn && /return null/.test(drFn),
    'parseDRText must return null rather than a partial structure on anything ' +
    'it cannot fully account for.');
  const migFn = extractFunctionBody(mod, 'migrateLegacyDR');
  assert(migFn && /drRows\(\)\.length/.test(migFn),
    'migrateLegacyDR must bail when structured rows already exist — it must ' +
    'never overwrite something the player entered.');

  // LOAD ORDER. character.js owns #damage-reduction, and migrateLegacyDR reads
  // that field's live value — so Character.loadData must have populated it
  // before DefenseRiders.loadData runs. Reverse them and the migration
  // silently does nothing on every load: no error, no rows, and the DR quietly
  // stays free text forever.
  const appSrc = readSource('app.js');
  const loadBody = extractFunctionBody(appSrc, 'loadData');
  const iChar = loadBody.indexOf('Character.loadData');
  const iRiders = loadBody.indexOf('DefenseRiders.loadData');
  assert(iChar >= 0 && iRiders >= 0, 'both loaders must be wired in app.js#loadData');
  assert(iChar < iRiders,
    'Character.loadData must run BEFORE DefenseRiders.loadData — the legacy ' +
    'DR migration reads #damage-reduction, which character.js populates.');
});

test('live: the tab refuses a field the player is editing', () => {
  const src = readSource('live-commands.js');
  assert(/field-focused/.test(src),
    'live-commands.js must refuse a focused field instead of overwriting it ' +
    'mid-keystroke.');
  assert(/live-written/.test(src) && /live-written/.test(readSource('styles.css')),
    'a rig-written field must flash — a number moving by itself on a sheet ' +
    'somebody is watching should never be silent.');
  assert(/notePublished/.test(src) && /notePublished/.test(readSource('live-publish.js')),
    'the ack doubles as a publish, so live-publish.js must be told or its ' +
    'watcher re-publishes identical content.');
});

// ---- tests: special-ability rows reach rules + borrowed creatures ---------
// (report rmszywe3s-92a6)

test('specials: the glossary rules a stat-block quality resolves to exist', (db) => {
  // The resolver matches the stripped label EXACTLY, either as printed or
  // with the MM's Ex/Su qualifier. Both spellings are represented in the DB,
  // so both paths need a fixture.
  for (const name of ['Tremorsense', 'Scent', 'Darkvision', 'Improved Grab',
                      'Fast Healing', 'Regeneration', 'Frightful Presence',
                      'Turn Resistance', 'Swallow Whole', 'Trample']) {
    const row = execOne(db,
      "SELECT name FROM entry WHERE type='rule' AND name = ? COLLATE NOCASE "
      + "LIMIT 1", [name]);
    assert(row, `no rule entry named "${name}" — the ⓘ panel on a special ` +
      `quality would fall through to "custom or homebrew"`);
  }
  // Rake is printed WITH its qualifier and only resolves via that path.
  const rake = execOne(db,
    "SELECT name FROM entry WHERE type='rule' AND name LIKE 'Rake (%' LIMIT 1");
  assert(rake && /^Rake \((?:Ex|Su|Sp)\)$/i.test(rake.name),
    `expected a "Rake (Ex)"-shaped rule, got ${rake && rake.name}`);
});

test('specials: a borrowed creature ability has structure to show', (db) => {
  // Ryan's own case: an Illithid Savant with "[Umber Hulk] Confusing Gaze".
  const row = execOne(db,
    "SELECT json_extract(data, '$.special_abilities') AS sa FROM entry "
    + "WHERE type='creature' AND name='Umber Hulk' LIMIT 1");
  assert(row && row.sa, 'Umber Hulk must carry special_abilities');
  const sa = JSON.parse(row.sa);
  const gaze = sa.find(a => /confusing gaze/i.test(a.name || ''));
  assert(gaze, 'Umber Hulk must have Confusing Gaze');
  assert(gaze.kind, 'the ability must carry its Ex/Su/Sp kind — that tag is ' +
    'half of what a DM needs at the table');
  assert((gaze.description || '').length > 20,
    'and its rules text, not just the name');
});

test('specials: the rule resolver is exact, not a prefix match', () => {
  const src = fs.readFileSync(path.join(ROOT, 'feats.js'), 'utf8');
  assert(/renderBorrowedCreatureRules/.test(src) &&
         /renderRuleAbilityRules/.test(src),
    'both new resolvers must be wired into renderAbilityRules');
  // A bare `name LIKE 'X (%'` handed "Spell-like abilities" the 3.0
  // "Spell-Like Abilities (Divine)" rule — a different rule about deities.
  assert(/\(\?:Ex\|Su\|Sp\|Ps\)/.test(src),
    'the qualifier fallback must be anchored to Ex/Su/Sp/Ps, or it matches ' +
    'any parenthesised rule that happens to start with the same words');
  // Chopping trailing WORDS until something matches would hand "Rage of the
  // Ancients" the Rage rule.
  assert(/\/\\d\/\.test\(last\)/.test(src),
    'only numeric / unit tokens may be stripped from the label');
});

// ---- tests: a trait that extends a sense (report rmt3eud3k-612c) ----------

test('senses: Nightsighted carries a structured darkvision extension', (db) => {
  const row = execOne(db,
    "SELECT json_extract(data, '$.senses') AS senses FROM entry "
    + "WHERE type = 'trait' AND name = 'Nightsighted (Trait)'");
  assert(row && row.senses, 'Nightsighted must carry a senses row — the ' +
    'sheet reads the structure, not the benefit prose');
  const senses = JSON.parse(row.senses);
  assertEq(senses.length, 1);
  assertEq(senses[0].sense, 'darkvision');
  // plus_ft, NOT range_ft: the trait's own text requires you to already have
  // darkvision, so it EXTENDS. As a range it would be a 10-foot darkvision
  // that always loses the best-of and shows up as nothing.
  assertEq(senses[0].plus_ft, 10);
  assert(senses[0].range_ft === undefined,
    'a range_ft here would resolve best-of and silently do nothing');
});

test('senses: the trait picker feeds the Senses block', () => {
  const tp = fs.readFileSync(path.join(ROOT, 'trait-picker.js'), 'utf8');
  const sn = fs.readFileSync(path.join(ROOT, 'senses.js'), 'utf8');
  assert(/function getActiveSenses\(\)/.test(tp) &&
         /getActiveSenses,/.test(tp),
    'TraitPicker must expose getActiveSenses');
  assert(/Array\.isArray\(d\.senses\)/.test(tp),
    'it must read the entry\'s senses field, not match trait names — a ' +
    'hand-kept list of sense-granting traits is the registry that rots');
  assert(/TraitPicker\.getActiveSenses/.test(sn),
    'senses.js must collect from the trait picker');
  // The extender has to appear in the chip's provenance, or the chip reads
  // "darkvision 70 (Dwarf)" and a dwarf has 60.
  assert(/extendFrom/.test(sn),
    'the source of a plus_ft extension must reach the rendered row');
});

// ---- tests: audit family mutes (report rmszxyryb-l93o) --------------------

test('save: audit mutes round-trip and survive an older save', () => {
  const src = fs.readFileSync(path.join(ROOT, 'audit.js'), 'utf8');
  assert(/auditMuted:\s*\[\.\.\.muted\]/.test(src),
    'collectData must emit auditMuted or the toggle dies on reload');
  assert(/d\?\.auditMuted\s*\|\|\s*\[\]/.test(src),
    'loadData must default auditMuted — a save written before mutes ' +
    'existed must load with every check on, not throw');
  assert(/!muted\.has\(familyOf\(i\)\)/.test(src),
    'collect() must actually consult the mute set');
});

test('audit: a muted family covers every caster and level of that check', () => {
  const src = fs.readFileSync(path.join(ROOT, 'audit.js'), 'utf8');
  const fakeDocument = {
    getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], addEventListener: () => {},
    createElement: () => ({ style: {}, classList: { add() {} },
      setAttribute() {}, appendChild() {}, addEventListener() {} }),
    body: { appendChild: () => {} },
  };
  const A = new Function('window', 'document',
    src + '\nreturn Audit;')({}, fakeDocument);
  // Mute is per-FAMILY on purpose: dismissing by id silences ONE caster at
  // ONE level, which is what made the every-slot-filled advisory feel
  // untoggleable — a wizard would have dismissed it nine times.
  assertEq(A.familyOf({ id: "caster:prepared-full:Wizard:1" }),
    'caster:prepared-full');
  assertEq(A.familyOf({ id: "caster:prepared-full:Cleric:9" }),
    'caster:prepared-full');
  // Two-segment ids are already whole families.
  assertEq(A.familyOf({ id: 'm7:hp-not-set' }), 'm7:hp-not-set');
  // Different checks must NOT collapse into one family.
  assert(A.familyOf({ id: 'caster:over-prepared:Wizard:1' }) !==
         A.familyOf({ id: 'caster:prepared-full:Wizard:1' }),
    'muting the advisory must not also silence the real over-prep error');
  // The check the report was filed against emits exactly this id shape.
  assert(/id: `caster:prepared-full:\$\{caster\.name\}:\$\{level\}`/.test(src),
    'the prepared-full id shape changed — familyOf and its label need to ' +
    'change with it');
});

// ---- tests: vestige rows as chips (report rmszworfj-3ehb) -----------------

test('save: a vestige chip HIDES its inputs, never removes them', () => {
  const sp = readSource('spells.js');
  // The whole safety of this change is that collectData still finds the same
  // six fields — a chip that REPLACED the inputs would silently empty every
  // bound vestige on the next save.
  assert(/style\.display = structured \? "none" : ""/.test(sp),
    'spells.js: the DB-derived fields must be hidden by display, not removed');
  for (const cls of ['vestige-name', 'vestige-level', 'vestige-dc',
                     'vestige-abilities', 'vestige-sign', 'vestige-good-pact']) {
    assert(new RegExp(`class="${cls}"`).test(sp),
      `spells.js: the ${cls} input must still be rendered into every row`);
  }
  // Good Pact is the player's choice, not the book's — it stays live even on
  // a chip (Ryan, 2026-08-23).
  assert(!/vestige-good-pact[^]{0,400}structured \? "none"/.test(sp),
    'the Good Pact checkbox must not be hidden by the chip');
  // Save-stability #4: the index arrives with the DB, which can be after a
  // character loads, so the decision has to be re-made when it does.
  assert(/vestige-index-ready/.test(sp) &&
         /vestige-index-ready/.test(readSource('vestige-picker.js')),
    'a load before DB.ready would leave every chip stuck as a form unless ' +
    'the picker announces its index and spells.js re-syncs');
});

// ---- tests: creature criteria in the lookup (report rmsur3jhq-gtgo) -------
//
// "filter creatures by various criteria (HD, CR, etc) … helpful for spells
// like planar ally". The criteria are query syntax (`cr:<=6 type:outsider`),
// so they run through the same rankResults seam the recall harness uses.

function loadLookupModule(db) {
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
  const fn = new Function('window', 'document', 'DB',
    src + '\n;return window.Lookup;');
  return fn(win, doc, dbStub);
}

test('lookup: cr: + type: filters to creatures that actually match', (db) => {
  const L = loadLookupModule(db);
  const out = L.rankResults('cr:<=6 type:outsider');
  assertNotEmpty(out, 'cr:<=6 type:outsider returned nothing');
  // Match on (name, source), not name alone: Githyanki is printed twice —
  // Humanoid in the MM, Outsider in Manual of the Planes — so a name-only
  // re-query reads back the wrong printing and accuses the filter of a bug
  // it didn't commit.
  const crOf = (name, source) => execOne(db,
    "SELECT cr, creature_type FROM entry "
    + "WHERE type='creature' AND name = ? AND source = ? LIMIT 1",
    [name, source]);
  for (const e of out.slice(0, 40)) {
    assertEq(e.type, 'creature', `${e.name} is not a creature`);
    const row = crOf(e.name, e.source);
    if (!row) continue;
    assert(/outsider/i.test(row.creature_type || ''),
      `${e.name} is not an outsider (${row.creature_type})`);
  }
  // The case that motivated it: a CR-4 outsider you could call with planar ally.
  assert(out.some(e => e.name === 'Hound Archon'),
    'Hound Archon (CR 4, Outsider) should be reachable via cr:<=6 type:outsider');
});

test('lookup: a dragon with a per-age CR ladder is NOT lost by cr:', (db) => {
  const L = loadLookupModule(db);
  // Black Dragon prints "Wyrmling 3; … great wyrm 22" — one entry, twelve
  // CRs. Treating that as a span is what keeps it findable; a parse that
  // gives up on it would silently drop every dragon out of a CR search.
  const low = L.rankResults('cr:<=4 black dragon');
  assert(low.some(e => e.name === 'Black Dragon'),
    'Black Dragon should match cr:<=4 (its wyrmling is CR 3)');
  const high = L.rankResults('cr:>=20 black dragon');
  assert(high.some(e => e.name === 'Black Dragon'),
    'Black Dragon should match cr:>=20 (its great wyrm is CR 22)');
  const between = L.rankResults('cr:23-24 black dragon');
  assert(!between.some(e => e.name === 'Black Dragon'),
    'Black Dragon tops out at CR 22 — cr:23-24 must not match it');
});

test('lookup: hd: and size: read the printed values', (db) => {
  const L = loadLookupModule(db);
  const hd = L.rankResults('hd:<=2 type:animal');
  assertNotEmpty(hd, 'hd:<=2 type:animal returned nothing');
  for (const e of hd.slice(0, 25)) assertEq(e.type, 'creature', `${e.name}`);
  // "Medium" must reach the 46 rows printed as "Medium-size" too — the
  // hyphenated spelling is a printing variant, not a different size.
  const med = L.rankResults('size:medium banshee');
  assert(med.some(e => e.name === 'Banshee'),
    'Banshee is "Medium-size" and must match size:medium');
});

test('lookup: a creature criterion restricts the search to creatures', (db) => {
  const L = loadLookupModule(db);
  // "fire" hits spells, feats, items, creatures. With a criterion attached
  // it must be creatures only — otherwise the filter reads as advisory.
  const out = L.rankResults('fire cr:<=10');
  assertNotEmpty(out, 'fire cr:<=10 returned nothing');
  for (const e of out) assertEq(e.type, 'creature', `${e.name} leaked through`);
});

// ---- tests: the lookup picks the same printing the pickers do -------------
// (report fmsuwe0gw-c0rh)

test('lookup: a reprint tie goes to the NEWEST printing', (db) => {
  const L = loadLookupModule(db);
  // Draconomicon 2003 vs Spell Compendium 2005 — same spell, same edition.
  // Every picker applies the source-recency tiebreak; the lookup kept
  // whichever came first in DB id order, which is neither rule.
  const out = L.rankResults('Fell the Greatest Foe')
    .filter(e => /^fell the greatest foe$/i.test(e.name));
  assertEq(out.length, 1, 'the two printings must still dedupe to one row');
  assertEq(out[0].source, 'Spell Compendium',
    'the 2005 Spell Compendium printing should win over the 2003 Draconomicon one');
  // Both printings really are in the DB, or the test proves nothing.
  const rows = execAll(db,
    "SELECT source FROM entry WHERE type='spell' AND name='Fell the Greatest Foe'");
  assertEq(rows.length, 2, 'fixture: expected exactly two printings');
});

test('lookup: 3.0 and 3.5 counterparts do NOT collapse into one row', (db) => {
  const L = loadLookupModule(db);
  // The canonical edition-conflation case (Dimensional Lock, 2026-05-19).
  // The dedupe key has always CLAIMED to keep editions apart — but `version`
  // was missing from the index SELECT, so the key's version component was
  // undefined for every entry and the two printings collapsed. A 3.0 spell
  // wearing a 3.5 spell's mechanics is the exact confusion the VersionBadge
  // work exists to prevent.
  const out = L.rankResults('dimensional lock')
    .filter(e => e.type === 'spell' && /^dimensional lock$/i.test(e.name));
  assertEq(out.length, 2, 'the 3.0 and the 3.5 Dimensional Lock are different spells');
  const versions = out.map(e => e.version).sort();
  assertEq(versions.join(','), '3.0,3.5', `got versions ${versions.join(',')}`);
});

test('lookup: the search index carries version', (db) => {
  const L = loadLookupModule(db);
  const e = L.rankResults('fireball')[0];
  assert(e && e.version,
    'entries must carry `version` — the dedupe key, the row edition badge ' +
    'and BookFilter\'s hide-3.0 counterpart mode all read it, and all three ' +
    'failed silently when it was absent from the SELECT');
  const src = fs.readFileSync(path.join(ROOT, 'lookup.js'), 'utf8');
  assert(/SELECT id, name, type, source, version,/.test(src),
    'version must stay in the index SELECT');
});

test('lookup: type: still means ENTRY type for real entry types', (db) => {
  const L = loadLookupModule(db);
  const spells = L.rankResults('type:spell fireball');
  assertNotEmpty(spells, 'type:spell fireball returned nothing');
  assert(spells.every(e => e.type === 'spell'),
    'type:spell must keep filtering by entry type, not creature type');
});

// ---- tests: repeatable feats (report rmszyon9j-b34a) ----------------------
//
// The picker refused to add a feat whose name was already in the Feats list,
// which made the second Toughness / Skill Focus / Weapon Focus unreachable.
// There is no `repeatable` flag in the DB — the fact is in the book's prose —
// so feat-picker reads the prose, and this is the guard on that reading.
//
// Both directions are checked against the REAL corpus, because the failure
// mode is not "the regex doesn't match" but "it matches something else":
// Twin Spell's "the spell takes effect twice", Dauntless's "you may NOT
// select this feat more than once", Stunning Fist's "no more than once per
// round". A one-directional test sails through all three.

function loadFeatPickerRepeat() {
  const src = fs.readFileSync(path.join(ROOT, 'feat-picker.js'), 'utf8');
  const fakeWindow = { DB: { ready: { then: () => {} } } };
  const fakeDocument = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const fn = new Function('window', 'document', 'DB',
    src + '\nreturn window.FeatPicker;');
  return fn(fakeWindow, fakeDocument, fakeWindow.DB);
}

// Pull a feat's prose the same way fullFeatRow does, so the test reads what
// the picker reads.
function featProse(db, name) {
  return execOne(db,
    "SELECT name, "
    + "json_extract(data, '$.benefit')     AS benefit, "
    + "json_extract(data, '$.special')     AS special, "
    + "json_extract(data, '$.description') AS description "
    + "FROM entry WHERE type = 'feat' AND name = ? "
    + "ORDER BY CASE version WHEN '3.5' THEN 0 ELSE 1 END LIMIT 1", [name]);
}

test('feat-picker: repeatable feats are recognised from the book prose', (db) => {
  const FP = loadFeatPickerRepeat();
  assert(FP && typeof FP.isRepeatableFeat === 'function',
    'feat-picker must expose isRepeatableFeat');
  // Every one of these says so in print, in a different way: "gain this feat
  // multiple times", "gain <Name> multiple times", "take this feat more than
  // once", "take the <Name> feat multiple times", "can be taken twice",
  // "up to four times".
  for (const name of ['Toughness', 'Skill Focus', 'Weapon Focus', 'Spell Focus',
                      'Extra Turning', 'Extra Contacts', 'Arcane Disciple',
                      'Shield Specialization', 'Martial Study', 'Sandskimmer',
                      'Illithid Grapple', 'Aberration Blood',
                      'Planar Touchstone', 'Melee Weapon Mastery']) {
    const row = featProse(db, name);
    assert(row, `${name} missing from the DB — test fixture is stale`);
    assert(FP.isRepeatableFeat(row, name),
      `${name} should read as repeatable`);
  }
});

test('feat-picker: one-shot feats are NOT repeatable (the traps)', (db) => {
  const FP = loadFeatPickerRepeat();
  const traps = {
    'Improved Initiative': 'plain one-shot feat',
    'Power Attack': 'plain one-shot feat',
    'Dodge': 'plain one-shot feat',
    'Dauntless': 'says you may NOT select it more than once',
    'Greater Resiliency': 'says you may not take it more than once',
    'Primary Contact': 'says it cannot be taken more than once',
    'Twin Spell': 'the SPELL takes effect twice, not the feat',
    'Twin Power': 'the POWER takes effect twice',
    'Hibernate': 'heals twice your level',
    'Azure Talent': 'points equal to twice the essentia',
    'Stunning Fist': 'no more than once per round — a rate limit',
    'Combat Reflexes': 'opportunist not more than once per round',
    'Great Cleave': 'strike multiple times when you fell a foe',
  };
  for (const [name, why] of Object.entries(traps)) {
    const row = featProse(db, name);
    assert(row, `${name} missing from the DB — test fixture is stale`);
    assert(!FP.isRepeatableFeat(row, name),
      `${name} must NOT read as repeatable (${why})`);
  }
});

test('feat-picker: the repeatable set is a minority of the corpus', (db) => {
  const FP = loadFeatPickerRepeat();
  const rows = execAll(db,
    "SELECT DISTINCT name, "
    + "json_extract(data, '$.benefit')     AS benefit, "
    + "json_extract(data, '$.special')     AS special, "
    + "json_extract(data, '$.description') AS description "
    + "FROM entry WHERE type = 'feat'");
  const hits = rows.filter(r => FP.isRepeatableFeat(r, r.name));
  // ~266 of 2,316 rows today. The band is wide enough to absorb new books
  // and narrow enough that a regex that starts matching everything (or
  // nothing) turns this red instead of silently changing the picker.
  assert(hits.length >= 180 && hits.length <= 400,
    `expected ~266 repeatable feat rows, got ${hits.length} of ${rows.length}`);
});

test('feat-picker: the dedupe refusal is now conditional on repeatability', () => {
  const src = fs.readFileSync(path.join(ROOT, 'feat-picker.js'), 'utf8');
  assert(/already in Feats list/.test(src),
    'the refusal must still exist for genuinely one-shot feats');
  assert(/if \(copies\) \{[\s\S]{0,200}isRepeatableFeat/.test(src),
    'the refusal must be gated on isRepeatableFeat — otherwise the second ' +
    'Toughness is unreachable from the picker again');
});

// ---- runner ---------------------------------------------------------------

(async function main() {
  let db;
  try {
    db = await loadDb();
  } catch (err) {
    console.error('FATAL: could not load DB:', err.message);
    process.exit(2);
  }

  let passed = 0, failed = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn(db);
      passed++;
      process.stdout.write('.');
    } catch (err) {
      failed++;
      failures.push({ name: t.name, error: err.message });
      process.stdout.write('F');
    }
  }
  console.log();
  console.log();
  if (failed) {
    console.log('FAILURES:');
    for (const f of failures) {
      console.log(`  ✗ ${f.name}`);
      console.log(`      ${f.error}`);
    }
    console.log();
  }
  console.log(`${passed} passed, ${failed} failed (${tests.length} total)`);
  process.exit(failed ? 1 : 0);
})();
