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

test('count of spells > 2500', (db) => {
  const r = execOne(db,
    "SELECT COUNT(*) AS n FROM entry WHERE type = 'spell'");
  assertGE(r.n, 2500);
});

test('count of feats > 1000', (db) => {
  // feat-picker covers feat + acf; skill_trick moved to
  // special-ability-picker (2026-05-17).
  const r = execOne(db, "SELECT COUNT(*) AS n FROM entry "
    + "WHERE type IN ('feat','acf')");
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
  const rows = execAll(db,
    "SELECT id AS feat_id, name, version, types_csv FROM entry "
    + "WHERE type IN ('feat', 'acf') "
    + "ORDER BY CASE version WHEN '3.5' THEN 0 ELSE 1 END, "
    + "name COLLATE NOCASE");
  assertGE(rows.length, 1000);
  assert(rows[0].name && rows[0].feat_id != null);
});

test('feat-picker: detail query (onSelect)', (db) => {
  const list = execAll(db,
    "SELECT id AS feat_id FROM entry "
    + "WHERE type IN ('feat','acf') LIMIT 1");
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

test('soulmeld-picker: description has Base / Chakra Bind structure', (db) => {
  const r = execOne(db,
    "SELECT json_extract(data, '$.description') AS d "
    + "FROM entry WHERE type = 'soulmeld' AND name = 'Acrobat Boots'");
  assert(r && r.d);
  assert(/Base:/i.test(r.d), 'has Base: section');
  assert(/Essentia:/i.test(r.d), 'has Essentia: section');
  assert(/Chakra Bind/i.test(r.d), 'has Chakra Bind section');
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
    + "WHERE e.type IN ('feat','acf') "
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
  // The badge module queries `SELECT entry_id, applied FROM errata`
  // at first use and builds two Sets. Make sure the table has both
  // applied + advisory records, and no orphan FKs.
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
  // openPopover() runs this query — verbatim. The ORDER BY puts
  // applied rows first, then groups by kind+field for readability.
  const firstEntryWithErrata = execOne(db,
    "SELECT entry_id FROM errata WHERE applied = 1 LIMIT 1");
  assert(firstEntryWithErrata, 'expected at least one applied errata');
  const records = execAll(db,
    "SELECT source, kind, field, from_text, to_text, applied, note " +
    "FROM errata WHERE entry_id = ? " +
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
  const EXCLUDE = new Set(['Generic Spellcaster']);

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
    'Generic Warrior/Bonus Feats',
    'Guild Thief/Bonus Feat',
    'Guild Thief/Reputation',
    'Hexblade/Ex-Hexblades',
    'Mountebank/Infernal Escape (Su)',
    'Cerebremancer/Spells per Day/Powers Known',  // walk feature name (no spaces around slash; was "Day / Powers" pre-2026-06-02)
    'Hierophant/Power of Nature (Su)',
    'Hierophant/Power of Nature [druid-only special ability]',
    'Blighter/Unbond (Sp)',
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
    // 2026-05-18 Stormwrack extraction: Legendary Captain's
    // "Leadership" feature buffs the Leadership feat's LCL bonus —
    // doesn't grant/advance a companion/mount/familiar itself.
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
  const bad = [];
  for (const r of rows) {
    if (r.bab  && !VALID_BAB.has(r.bab))   bad.push(`${r.name}: bab=${r.bab}`);
    if (r.fort && !VALID_SAVE.has(r.fort)) bad.push(`${r.name}: fort=${r.fort}`);
    if (r.ref  && !VALID_SAVE.has(r.ref))  bad.push(`${r.name}: ref=${r.ref}`);
    if (r.will && !VALID_SAVE.has(r.will)) bad.push(`${r.name}: will=${r.will}`);
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
  const ch = readSource('character.js');
  assert(/#gear-body tr\.gear-row/.test(ch),
    "character.js encumbrance scan should scope to " +
    "`#gear-body tr.gear-row`.");
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
  // Catch the case where a new module is added without persistence.
  const modules = [
    'character.js', 'equipment.js', 'spells.js', 'feats.js',
    'companion.js', 'class-features.js', 'skills.js',
  ];
  const missing = [];
  for (const m of modules) {
    const src = readSource(m);
    if (!/function collectData\s*\(/.test(src)) missing.push(`${m}: collectData`);
    if (!/function loadData\s*\(/.test(src))     missing.push(`${m}: loadData`);
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
  // collectData side: source field must be in the _multiclass stub.
  const collectIdx = src.indexOf('out._multiclass = pickedClasses.map');
  assert(collectIdx > 0,
    'class-picker.js: out._multiclass = pickedClasses.map(...) site ' +
    'is missing; collectData refactored without updating this test.');
  const collectBlock = src.slice(collectIdx, collectIdx + 1500);
  assert(/source:\s*e\.source/.test(collectBlock),
    'class-picker.js: collectData does not write `source: e.source` ' +
    'into the _multiclass stub. Without source, name lookup on load ' +
    'cannot disambiguate same-name classes across books, and a DB ' +
    'rebuild that shifts entry.id will silently swap or drop classes.');
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

test('rebuild-killer: money weight counted in character.js load calc', () => {
  // Pre-2026-05-17 character.js summed gear + armor + shield but
  // skipped money. equipment.js wrote the (money-inclusive) total to
  // #total-weight, then character.js overwrote it with a money-less
  // number — and the load category itself was money-less. Guard the
  // coinCount addition so the load penalty actually reflects coins.
  // (Static grep rather than function-body extract — the recalc
  // signature has a default param object literal that confuses the
  // brace-matching helper.)
  const src = readSource('character.js');
  assert(/money-cp/.test(src),
    'character.js: no reference to #money-cp / coin fields — ' +
    'coin weight is not folded into the load-category calculation.');
  assert(/coinCount\s*\/\s*50/.test(src),
    'character.js: coin-to-weight conversion (coinCount / 50) ' +
    'missing — PHB says 50 coins of any type weigh 1 lb.');
});

test('rebuild-killer: magic-item weight counted in both weight calcs', () => {
  // Pre-2026-05-18, equipment.js#recalcWeight + character.js's
  // mirror summed gear + armor + shield + coins but skipped the
  // .mi-weight inputs on .magic-item-entry rows. A +5 plate cloak
  // (5 lb) or other worn magic items silently dropped off the load
  // — the displayed Total Weight + the load-category penalty BOTH
  // ignored them. Both calcs must scan #magic-items-container.
  for (const file of ['equipment.js', 'character.js']) {
    const src = readSource(file);
    assert(/#magic-items-container.*\.magic-item-entry/.test(src) ||
           /magic-items-container[^]*magic-item-entry/.test(src),
      `${file}: weight calc does not sum .mi-weight inputs from ` +
      `#magic-items-container — magic-item weight silently drops off ` +
      `encumbrance.`);
    assert(/\.mi-weight/.test(src),
      `${file}: no .mi-weight selector in source — magic-item ` +
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
  // Remove path: removeMagicItem must also trigger recalc, otherwise
  // deleting a magic item leaves its weight in the displayed total.
  assert(/entry\.remove\(\);\s*\n[^\n]*recalcWeight\(\)/.test(eq) ||
         /entry\.remove\(\);[\s\S]{0,200}recalcWeight\(\)/.test(eq),
    'equipment.js: removeMagicItem does not call recalcWeight after ' +
    'removing the entry — the deleted item\'s weight stays on the ' +
    'displayed total.');
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

test('companion Session C: template natural armor folded into base AC text', () => {
  const src = readSource('companion.js');
  // The base creature's `armor_class` is a free-text string the
  // existing AUTO parser extracts "+N natural" from. The template
  // apply must REWRITE that token (or append one) so the existing
  // parser picks up the new total without needing a second NA field.
  assert(/function appendTemplateNaToAcText\s*\(/.test(src),
    'companion.js: appendTemplateNaToAcText helper is missing — ' +
    'template natural-armor bonuses will not reach the AC field.');
  assert(/function deriveTemplateNaturalArmor\s*\(/.test(src),
    'companion.js: deriveTemplateNaturalArmor helper is missing — ' +
    'template NA bonus is not read from bonuses[] or armor_class text.');
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
// A Monster Manual creature with an `as_character` block can be picked as
// a playable race. Two parts: a racial-adjustment layer (mirrors
// race-picker) + a synthetic racial-HD class row injected into
// class-picker's multiclass aggregate. These guards cover the DB query
// shape, the data.js type→progression mapping (load-bearing: wrong labels
// mean wrong BAB/saves on every monster PC), the synthetic-row save
// round-trip, and the double-count guard.

// Eval data.js (a bare `const DND35 = {...}` with no exports) so the pure
// helpers can be exercised in Node.
function loadDND35() {
  const src = readSource('data.js');
  return new Function(src + '\nreturn DND35;')();
}

test('creature-race-picker: list query returns creatures with as_character', (db) => {
  const rows = execAll(db,
    "SELECT e.name FROM entry e "
    + "WHERE e.type = 'creature' "
    + "  AND json_extract(e.data, '$.as_character') IS NOT NULL "
    + "ORDER BY e.name");
  const names = rows.map(r => r.name);
  assertGE(names.length, 26);
  assert(names.includes('Bugbear'),
    'Bugbear (3 racial HD) should be a pickable creature-race');
  assert(names.includes('Goblin'),
    'Goblin (0 racial HD) should be a pickable creature-race');
});

test('creature-race-picker: as_character block carries the required fields', (db) => {
  const r = execOne(db,
    "SELECT json_extract(data, '$.as_character') AS ac FROM entry "
    + "WHERE type = 'creature' AND name = 'Bugbear' LIMIT 1");
  assert(r && r.ac, 'Bugbear as_character block not found');
  const ac = JSON.parse(r.ac);
  assert(ac.sourced === true, 'as_character.sourced should be true');
  assert(Array.isArray(ac.ability_adjustments) && ac.ability_adjustments.length,
    'ability_adjustments present');
  assert('ability' in ac.ability_adjustments[0] &&
         'modifier' in ac.ability_adjustments[0],
    'ability_adjustments shape is {ability, modifier}');
  assert(ac.size === 'Medium', 'Bugbear size Medium');
  assert(ac.racial_hd && ac.racial_hd.count === 3 &&
         ac.racial_hd.type === 'Humanoid',
    'Bugbear racial_hd {count:3, type:Humanoid}');
  assert(ac.level_adjustment === 1, 'Bugbear LA 1 (int, post-normalize)');
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

test('bloodline: _bloodline persists name+source, not a brittle DB id', () => {
  // Save-stability rule #7: entry ids renumber on every DB rebuild, so
  // the save must resolve by a human-meaningful identifier.
  const src = readSource('bloodline.js');
  const collectBody = extractFunctionBody(src, 'collectData');
  assert(/name:\s*state\.name/.test(collectBody)
      && /source:\s*state\.source/.test(collectBody),
    'bloodline.js#collectData must persist name + source.');
  assert(!/\bid:\s*/.test(collectBody),
    'bloodline.js#collectData must NOT persist a DB id (renumbers on rebuild).');
  assert(/resolveSelection/.test(src),
    'bloodline.js must resolve the saved selection against the catalog ' +
    'by name/source (resolveSelection).');
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
