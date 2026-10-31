// tests/test_class_audit.js
//
// Per-class metadata sweep. Runs invariant checks against every
// class + PrC in dnd35.db. Designed to catch the kind of bug that
// slipped past the play-feel suite: an entry that's in the DB but
// missing one or more of the metadata fields the character sheet
// reads at apply time.
//
// Run all classes:
//   node tests/test_class_audit.js
//
// Filter to a single class (useful when adding a new entry from a
// freshly extracted book):
//   node tests/test_class_audit.js --class "Eldritch Knight"
//
// Other filters:
//   --type class     (base classes only)
//   --type prc       (PrCs only)
//   --source "Complete Warrior"
//
// Output: per-class pass/fail breakdown, then a summary at the end.
// Exits 1 when any error-severity check fails; 0 when clean.
//
// Design note: the audit does NOT suppress known failures. KNOWN_GAPS
// / ADVANCER_BACKLOG / SPELLCASTING_BLOCK_INCOMPLETE are annotation
// maps that decorate each finding with documented context (e.g.
// "tracked in DB project TODO under X"). The check still fails. The
// point of the audit is to keep pressure on fixing the issues — if
// we suppressed known cases the count would only ever grow as new
// gaps land. To "fix" a finding, the underlying DB / metadata must
// actually be corrected.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data/dnd35.db');
const SQL_JS_PATH = path.join(ROOT, 'vendor/sql-wasm.js');
const WASM_PATH = path.join(ROOT, 'vendor/sql-wasm.wasm');
const CLASS_PICKER_PATH = path.join(ROOT, 'class-picker.js');

// ---- CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const args = { class: null, type: null, source: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--class' || a === '-c') args.class = argv[++i];
    else if (a === '--type' || a === '-t') args.type = argv[++i];
    else if (a === '--source' || a === '-s') args.source = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node tests/test_class_audit.js ' +
        '[--class NAME] [--type class|prc] [--source BOOK]');
      process.exit(0);
    }
  }
  return args;
}
const ARGS = parseArgs(process.argv);

// ---- DB loader -----------------------------------------------------------

async function loadDb() {
  const initSqlJs = require(SQL_JS_PATH);
  const SQL = await initSqlJs({ locateFile: () => WASM_PATH });
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
      const v = stmt.get();
      const obj = {};
      for (let i = 0; i < cols.length; i++) obj[cols[i]] = v[i];
      rows.push(obj);
    }
    return rows;
  } finally {
    stmt.free();
  }
}

// ---- Annotation maps ----------------------------------------------------
//
// These are NOT suppression lists — they decorate failing findings
// with documented context so the audit output is more useful. Each
// entry adds an explanatory note to the failure message. The check
// still fails; the count still grows the test's exit code.
//
// To clear a finding, fix the underlying DB metadata. Once the check
// passes, the annotation becomes dead code and can be removed (the
// audit doesn't enforce that annotations match failures — they're
// pure documentation).

const KNOWN_NOTES = {
  // Cleared 2026-05-16:
  //   Eldritch Knight (now wired via ADVANCEMENT_METADATA).
  //   Sublime Chord (now has native-caster SPELLCASTING_METADATA).
  //   Ardent / Divine Mind / Erudite / Lurk (CPsi schema normalized
  //   via normalize_cpsi_classes.py — `levels` → `class_table`,
  //   `features` → `class_features`).
  //   Savant (now uses array-form key_ability + key_ability_per_list).
  //
  // Flesh Golem is a construct — Savage Species explicitly states "no
  // class skills". The empty class_skills is correct per source; the
  // data already documents this via skill_points_per_level text.
  'Flesh Golem': 'Construct — Savage Species explicitly has no class skills (documented in skill_points_per_level)',
};

// Classes/PrCs whose spellcasting block is incomplete (missing one
// or more of: key_ability / type / style / class_type). Each is
// reported as a failure; this set just adds the bulk-context note
// to the output.
//
// History of this list:
//   2026-05-16: started at 41 entries from initial audit pass.
//   2026-05-16: 11 cleared via SPELLCASTING_METADATA for the 8 base
//   classes (Beguiler/Duskblade/Favored Soul/Hexblade/Shugenja/Spirit
//   Shaman/Warmage/Wu Jen) + Assassin/Blackguard/Apostle of Peace.
//   2026-05-16: 30 cleared via Tier 2 schema cleanup — pure advancers
//   (Pale Master, Ruby Knight V, etc.) had their junk spellcasting
//   blocks force-nulled via FORCE_NULL_SPELLCASTING in
//   _class_metadata.py; native casters (Corrupt Avenger, Death
//   Delver, Sublime Chord) got proper SPELLCASTING_METADATA entries.
//
// Currently empty — all entries triaged. Future additions land here
// if new audit findings appear (e.g. a future book extraction
// surfaces another batch of incomplete blocks).
const SPELLCASTING_BLOCK_INCOMPLETE = new Set([]);

// Companion-grant false positives — class features whose text matches
// the companion-keyword regex but don't actually grant a companion.
// MUST stay in sync with the EXCLUSIONS set in tests/test_pickers.js
// and the None entries in _companion_metadata.OVERRIDES on the DB side.
//
// Two flavours of false positive land here:
//   (a) Plain English uses ("familiar to the flux adept", "familiar"
//       listed as one option in a feat-substitute menu).
//   (b) Counter-text on ex-class / loss features ("his familiar leaves").
//
// Pattern (b) is also catchable via the INCIDENTAL regex (`\bex-\w+`,
// etc.), but explicit pairs are clearer when reading the audit.
const COMPANION_KEYWORD_EXCLUSIONS = new Set([
  'Generic Warrior/Bonus Feats',
  'Guild Thief/Bonus Feat',
  'Guild Thief/Reputation',
  'Hexblade/Ex-Hexblades',
  'Mountebank/Infernal Escape (Su)',
  'Cerebremancer/Spells per Day / Powers Known',
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
  'Flux Adept/Taste of Truth (Ex)',
]);

// Incidental-keyword regex — text patterns where the companion keyword
// is used in a non-granting sense. Mirrors test_pickers.js INCIDENTAL.
const COMPANION_KEYWORD_INCIDENTAL = /leadership\s+score|feat\s+from:?\b[^.]*leadership|\bex-\w+|\bbecomes?\s+\w+|sever\s+bonded|except\s+(?:spellcasting\s+and\s+)?animal\s+companion|does\s+not\s+grant.*familiar|magical\s+materials/i;

// PrCs whose class_features text matches the broad advancer regex but
// aren't yet wired into ADVANCEMENT_METADATA / HARDCODED_ADVANCERS.
// This set just adds the bulk-context note to the audit output — it
// does NOT suppress failures. Originally 38 entries (2026-05-16
// audit); shrunk as ADVANCEMENT_METADATA was populated.
//
// Removed entries: 36 PrCs wired into _class_metadata.py's
// ADVANCEMENT_METADATA on 2026-05-16. EK and Sublime Chord also
// removed (EK now has advancement; Sublime Chord now has a native
// caster spellcasting block).
//
// Still listed below (3 entries): PrCs whose advancement pillar
// (invocations / mysteries / dual-pillar) the sheet doesn't yet
// support. Until that infrastructure lands, these PrCs' advancement
// stays dropped on the floor at apply-time.
const ADVANCER_BACKLOG = new Set([
  // 2026-05-16: all three remaining triage entries cleared.
  //   * Eldritch Disciple → invocation-advancement pillar
  //   * Master of Shadow  → mystery-advancement pillar
  //   * Noctumancer       → dual-pillar (arcane via ADVANCEMENT_METADATA
  //                         + mystery via MYSTERY_ADVANCEMENT_METADATA)
  // Set kept empty for future regressions to land in.
]);

// ---- Helpers --------------------------------------------------------------

function parseJSON(s, fallback) {
  if (s === null || s === undefined) return fallback;
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

function loadHardcodedAdvancers() {
  const src = fs.readFileSync(CLASS_PICKER_PATH, 'utf8');
  // Extract the _FALLBACK_HARDCODED_ADVANCERS object's keys.
  const m = src.match(/_FALLBACK_HARDCODED_ADVANCERS\s*=\s*\{([\s\S]*?)\n\s*\};/m);
  if (!m) return new Set();
  const body = m[1];
  const keys = new Set();
  const re = /(?:"([^"\n]+?)"|'([^'\n]+?)')\s*:\s*\{/g;
  let mm;
  while ((mm = re.exec(body)) !== null) {
    keys.add(mm[1] || mm[2]);
  }
  return keys;
}

const HARDCODED_ADVANCERS = loadHardcodedAdvancers();

// ---- Invariant checks ----------------------------------------------------
//
// Each check returns null on pass, or a short failure message on fail.
// Checks receive a `ctx` with { row, data, isPrC } so they don't have
// to re-parse.

const CHECKS = {

  'has-class-table': (ctx) => {
    const t = ctx.data.class_table;
    if (!Array.isArray(t)) return 'class_table is not a list';
    if (t.length === 0) return 'class_table is empty';
    return null;
  },

  'class-table-row-completeness': (ctx) => {
    const t = ctx.data.class_table;
    if (!Array.isArray(t) || t.length === 0) return null;  // covered above
    // Each row should have `level` set.
    const noLevel = t.filter(r => r.level === undefined || r.level === null);
    if (noLevel.length) {
      return `${noLevel.length} class_table rows missing 'level'`;
    }
    // Levels should be consecutive starting at the entry's lowest.
    const levels = t.map(r => Number(r.level)).filter(n => !isNaN(n)).sort((a, b) => a - b);
    if (levels.length === 0) return null;
    const min = levels[0];
    const max = levels[levels.length - 1];
    if (max - min + 1 !== levels.length) {
      return `class_table levels not consecutive: ${min}..${max} (${levels.length} rows)`;
    }
    return null;
  },

  'bab-progression-set': (ctx) => {
    // DB stores 'good' (full BAB, e.g. Fighter), 'average' (3/4 BAB,
    // e.g. Cleric / Monk / Rogue), 'poor' (1/2 BAB, e.g. Wizard).
    const p = ctx.data.bab_progression;
    if (!p) return 'bab_progression missing';
    if (!['good', 'average', 'poor'].includes(p)) {
      return `bab_progression has unexpected value: ${JSON.stringify(p)}`;
    }
    return null;
  },

  'saves-progression-set': (ctx) => {
    const missing = [];
    for (const ab of ['fort', 'ref', 'will']) {
      const key = `${ab}_progression`;
      const v = ctx.data[key];
      if (!v) missing.push(key);
      else if (!['good', 'poor'].includes(v)) {
        return `${key} has unexpected value: ${JSON.stringify(v)}`;
      }
    }
    if (missing.length) return `missing save progressions: ${missing.join(', ')}`;
    return null;
  },

  'hit-die-set': (ctx) => {
    // Stored as a raw integer (4, 6, 8, 10, 12, 20). Cantrip-using
    // / non-combat classes don't go below d4.
    const hd = ctx.data.hit_die;
    if (hd === undefined || hd === null) return 'hit_die missing';
    const n = Number(hd);
    if (![2, 3, 4, 6, 8, 10, 12, 20].includes(n)) {
      return `hit_die has unexpected value: ${JSON.stringify(hd)}`;
    }
    return null;
  },

  'class-skills-set': (ctx) => {
    const cs = ctx.data.class_skills;
    if (!Array.isArray(cs)) return 'class_skills is not a list';
    if (cs.length === 0) {
      // Most classes have at least one class skill. The few with
      // legitimately none would be unusual — flag for verification.
      return 'class_skills is empty (verify against source)';
    }
    return null;
  },

  'class-features-set': (ctx) => {
    const cf = ctx.data.class_features;
    if (!Array.isArray(cf)) return 'class_features is not a list';
    // Empty class_features is highly suspicious — every class in 3.5
    // has at least Weapon Proficiency / Armor Proficiency / something.
    if (cf.length === 0) return 'class_features is empty';
    const noName = cf.filter(f => !f.name).length;
    if (noName) return `${noName} class_feature entries missing 'name'`;
    return null;
  },

  'spellcasting-block-consistency': (ctx) => {
    const sc = ctx.data.spellcasting;
    if (!sc) return null;  // non-caster — not an issue
    const issues = [];
    // Allow 'varies' for psionic PrCs that inherit from the base class
    // (War Mind, Cerebremancer, etc.). Power-point manifesting can be
    // Wis (Psion) / Cha (Wilder) / Int (Erudite) depending on parent.
    //
    // Dual-list casters (Savant — INT arcane, WIS divine) use an ARRAY
    // form for key_ability with each entry in VALID_ABILITIES. The
    // explicit list→ability mapping lives in `key_ability_per_list`.
    const VALID_ABILITIES = ['Charisma', 'Wisdom', 'Intelligence', 'varies'];
    if (!sc.key_ability) {
      issues.push('spellcasting.key_ability missing');
    } else if (Array.isArray(sc.key_ability)) {
      const bad = sc.key_ability.filter(a => !VALID_ABILITIES.includes(a));
      if (bad.length) {
        issues.push(`spellcasting.key_ability has unknown entries: ${JSON.stringify(bad)}`);
      }
      if (sc.key_ability.length < 2) {
        issues.push('spellcasting.key_ability is an array but has < 2 entries — use a scalar string instead');
      }
    } else if (!VALID_ABILITIES.includes(sc.key_ability)) {
      issues.push(`spellcasting.key_ability = ${JSON.stringify(sc.key_ability)}`);
    }
    if (!sc.type) issues.push('spellcasting.type missing');
    if (!sc.style) issues.push('spellcasting.style missing');
    if (!sc.class_type) issues.push('spellcasting.class_type missing');
    return issues.length ? issues.join('; ') : null;
  },

  // PrC-advancer wired check. Strict version (catches "as if she
  // had also gained" + similar phrasings). Backlog entries (the 39
  // PrCs already triaged on 2026-05-16) are filtered out before this
  // check is reached, but new PrCs that don't match either the
  // backlog list OR HARDCODED_ADVANCERS / canonical marker get
  // flagged here.
  'prc-advancer-wired': (ctx) => {
    if (!ctx.isPrC) return null;
    const features = ctx.data.class_features || [];
    const text = features.map(f => (f.name || '') + ' ' + (f.description || '')).join(' ');

    // Stricter regex than test_pickers.js — see playfeel pass notes.
    const ADVANCE_VERB = new RegExp(
      'as if(?:\\s+(?:she|he|you|they|had|also|a))*\\s+gained?\\s+a\\s+level' +
      '|as if leveling in' +
      '|advances? (?:your |her |his )?(?:arcane|divine|psionic|spellcasting)' +
      '|\\+\\s*1\\s*level\\s+of\\s+(?:your\\s+|her\\s+|his\\s+)?existing',
      'i'
    );
    const SPELL_NOUN = new RegExp(
      'spells per day|caster level|spells known|spellcasting class' +
      '|spellcasting ability|manifester level|powers known|power points' +
      // Warlock-pillar nouns so invocation-only advancers (Demonbinder)
      // get caught.
      '|invocations? known|invocation-using class' +
      // ToM shadowcaster-pillar nouns. Master of Shadow's phrasing is
      // "new mysteries or spells per day" / "casting class to which you
      // belonged"; Noctumancer adds "mystery-using class".
      '|mysteries known|mystery-using class|casting class',
      'i'
    );
    if (!ADVANCE_VERB.test(text) || !SPELL_NOUN.test(text)) return null;

    // Canonical marker in class_table.special — Source A.
    const table = ctx.data.class_table || [];
    const CANONICAL_MARKER = new RegExp(
      '\\+\\s*1\\s*level\\s+of\\s+existing\\s+' +
      '(?:arcane|divine|manifesting|psionic)\\s+' +
      '(?:spellcasting|manifesting)?\\s*class',
      'i'
    );
    const hasCanonical = table.some(t => CANONICAL_MARKER.test(t.special || ''));
    if (hasCanonical) return null;

    // Source B — HARDCODED_ADVANCERS fallback.
    if (HARDCODED_ADVANCERS.has(ctx.row.name)) return null;

    // Source 0 — DB advancement metadata (preferred long-term). Any of
    // the three pillar fields counts as a valid wiring; a PrC can have
    // multiple set (Eldritch Theurge has both `advancement` for arcane
    // spells AND `invocation_advancement`).
    if (ctx.data.advancement) return null;
    if (ctx.data.maneuver_advancement) return null;
    if (ctx.data.invocation_advancement) return null;
    if (ctx.data.mystery_advancement) return null;

    return 'class_features describes pillar-advancement but no metadata / canonical marker / HARDCODED_ADVANCERS entry';
  },

  // Companion-grant metadata. Class features mentioning these
  // keywords should have `companion` metadata so Companion.compute-
  // CompanionLevels picks them up. Mirrors the equivalent (stricter)
  // check in tests/test_pickers.js — both use the same KEYWORDS regex,
  // the same INCIDENTAL counter-regex, and the same EXCLUSIONS pair
  // set (kept in sync with _companion_metadata.OVERRIDES on the DB
  // side).
  'companion-grant-metadata': (ctx) => {
    const features = ctx.data.class_features || [];
    const KEYWORDS = /\b(animal companion|familiar|special mount|paladin'?s?\s+mount|cohort)\b/i;
    const missing = [];
    for (const f of features) {
      const text = `${f.name || ''} ${f.description || ''}`;
      if (!KEYWORDS.test(text)) continue;
      if (COMPANION_KEYWORD_INCIDENTAL.test(text)) continue;
      if (f.companion) continue;
      const key = `${ctx.row.name}/${f.name || '(unnamed)'}`;
      if (COMPANION_KEYWORD_EXCLUSIONS.has(key)) continue;
      missing.push(f.name || '(unnamed)');
    }
    if (missing.length === 0) return null;
    return `${missing.length} companion-keyword feature(s) missing metadata: ${missing.join(', ')}`;
  },

  'min-level-set-for-prc': (ctx) => {
    if (!ctx.isPrC) return null;
    // PrCs have a min character level (entry requirement). Stored on
    // entry.data.minimum_level (or in prerequisites text). Not all
    // PrCs may have this populated; treat as info-level.
    if (ctx.data.minimum_level === undefined ||
        ctx.data.minimum_level === null) {
      // Fall back to checking class_table for a non-1 start.
      const t = ctx.data.class_table || [];
      const lvls = t.map(r => Number(r.level)).filter(n => !isNaN(n));
      if (!lvls.length) return null;
      const minLvl = Math.min(...lvls);
      // PrCs typically start at L1 (the table is the PrC's OWN levels,
      // not character levels), so this isn't always indicative.
    }
    return null;
  },

  // Fidelity check #1: detect `[ERRATA (...)]` markers that appear
  // more than once in a single class_feature's description. This was
  // the 2026-05-16 build-pipeline bug (apply_errata.py's class_features
  // branch wasn't idempotent — re-running the script appended the same
  // marker again). Fixed at the extraction layer; this check guards
  // against regression.
  'errata-marker-not-duplicated': (ctx) => {
    const features = ctx.data.class_features || [];
    const dup = [];
    for (const f of features) {
      const desc = String(f.description || '');
      const counts = {};
      for (const m of desc.match(/\[ERRATA[^\]]*\]/g) || []) {
        counts[m] = (counts[m] || 0) + 1;
      }
      for (const [marker, n] of Object.entries(counts)) {
        if (n >= 2) {
          dup.push(`${f.name || '?'}: "${marker.slice(0, 40)}…" ×${n}`);
        }
      }
    }
    if (!dup.length) return null;
    return `class_features description has duplicated errata marker(s): ${dup.join('; ')}`;
  },

  // Fidelity check #2: heuristic for class_features whose description
  // is so short it's likely a heavy summary rather than a faithful
  // extraction. Triggers only on the "Spells" feature (the highest-
  // stakes prose for sheet correctness — used to determine ability
  // keys, DC formulas, casting prerequisites). Threshold of 200 chars
  // is a heuristic: a faithful Spells-feature transcription is
  // typically 400-1000+ characters (look at Hexblade / Beguiler for
  // examples). Reported as a warning since false positives are
  // possible (rare classes with genuinely terse rules).
  'spells-feature-not-suspiciously-summarized': (ctx) => {
    const sc = ctx.data.spellcasting;
    if (!sc) return null;  // non-caster — no Spells feature expected
    const features = ctx.data.class_features || [];
    const spells = features.find(f => /^spells?$/i.test((f.name || '').trim()));
    if (!spells) {
      // Some entries genuinely have no Spells feature (e.g. PrCs that
      // only advance another caster's spells). Don't flag.
      return null;
    }
    const desc = String(spells.description || '');
    if (desc.length >= 200) return null;
    return `Spells feature description is only ${desc.length} chars — likely heavy summary. ` +
           `Hand-verify against source book to confirm key_ability / DC formula / ` +
           `bonus-spell ability / casting prereq match RAW.`;
  },
};

// Severity of each check. 'error' = test fails; 'warn' = reported but
// doesn't fail. Keeps the audit useful without being noisy.
const SEVERITY = {
  'has-class-table': 'error',
  'class-table-row-completeness': 'error',
  'bab-progression-set': 'error',
  'saves-progression-set': 'error',
  'hit-die-set': 'error',
  'class-skills-set': 'warn',
  'class-features-set': 'error',
  'spellcasting-block-consistency': 'error',
  'prc-advancer-wired': 'error',
  'companion-grant-metadata': 'warn',
  'min-level-set-for-prc': 'warn',
  'errata-marker-not-duplicated': 'error',
  'spells-feature-not-suspiciously-summarized': 'warn',
};

// ---- Runner ---------------------------------------------------------------

async function main() {
  const db = await loadDb();

  // Build filter clause.
  const conditions = ["type IN ('class','prc')"];
  const params = [];
  if (ARGS.type === 'class') {
    conditions[0] = "type = 'class'";
  } else if (ARGS.type === 'prc') {
    conditions[0] = "type = 'prc'";
  }
  if (ARGS.class) {
    conditions.push('name = :name COLLATE NOCASE');
    params.push({ ':name': ARGS.class });
  }
  if (ARGS.source) {
    conditions.push('source LIKE :source');
    params.push({ ':source': `%${ARGS.source}%` });
  }
  const sql = `SELECT name, type, source, data
               FROM entry WHERE ${conditions.join(' AND ')}
               ORDER BY type, name COLLATE NOCASE`;

  const rows = execAll(db, sql, Object.assign({}, ...params));
  if (rows.length === 0) {
    console.error(`No entries match the filter.`);
    process.exit(1);
  }

  // Run all checks per entry. NO suppression — every failing check
  // counts. KNOWN_NOTES / ADVANCER_BACKLOG / SPELLCASTING_BLOCK_INCOMPLETE
  // are used only to add explanatory notes to the failure message.
  let errors = 0, warnings = 0;
  const errorEntries = [];
  const warnEntries = [];

  for (const row of rows) {
    const data = parseJSON(row.data, {});
    const isPrC = row.type === 'prc';
    const ctx = { row, data, isPrC };

    const failures = [];
    for (const [checkName, checkFn] of Object.entries(CHECKS)) {
      const msg = checkFn(ctx);
      if (msg === null) continue;
      const severity = SEVERITY[checkName] || 'error';
      // Annotate with documented context when applicable.
      const notes = [];
      if (KNOWN_NOTES[row.name]) notes.push(KNOWN_NOTES[row.name]);
      if (checkName === 'prc-advancer-wired' && ADVANCER_BACKLOG.has(row.name)) {
        notes.push('in ADVANCER_BACKLOG (2026-05-16 triage list)');
      }
      if (checkName === 'spellcasting-block-consistency' &&
          SPELLCASTING_BLOCK_INCOMPLETE.has(row.name)) {
        notes.push('in SPELLCASTING_BLOCK_INCOMPLETE bulk-fix list');
      }
      failures.push({
        name: checkName, message: msg, severity,
        notes: notes.length ? notes.join('; ') : null,
      });
    }

    if (failures.length === 0) continue;

    let hasError = false;
    for (const f of failures) {
      if (f.severity === 'error') { errors++; hasError = true; }
      else warnings++;
    }
    if (hasError) errorEntries.push({ row, failures });
    else warnEntries.push({ row, failures });
  }

  // ---- Report -------------------------------------------------------------

  const filterLine = [
    ARGS.type   ? `type=${ARGS.type}`   : null,
    ARGS.class  ? `class=${ARGS.class}` : null,
    ARGS.source ? `source=${ARGS.source}` : null,
  ].filter(Boolean).join(' ') || '(no filter)';

  console.log(`\nClass audit — ${rows.length} entries scanned ${filterLine}\n`);

  function printFailure(f) {
    const sigil = f.severity === 'error' ? '✗' : '⚠';
    const noteSuffix = f.notes ? ` — ${f.notes}` : '';
    console.log(`    ${sigil} ${f.name}: ${f.message}${noteSuffix}`);
  }

  if (errorEntries.length) {
    console.log('--- ERRORS ---');
    for (const e of errorEntries) {
      console.log(`\n  ${e.row.name} [${e.row.type}, ${e.row.source}]`);
      for (const f of e.failures.filter(x => x.severity === 'error')) printFailure(f);
      for (const f of e.failures.filter(x => x.severity === 'warn'))  printFailure(f);
    }
    console.log('');
  }

  if (warnEntries.length && (ARGS.class || ARGS.source || ARGS.type)) {
    // Only show warning-only entries when the user is targeting a
    // narrow subset; the full-sweep noise isn't useful otherwise.
    console.log('--- WARNINGS (no errors) ---');
    for (const e of warnEntries) {
      console.log(`\n  ${e.row.name} [${e.row.type}, ${e.row.source}]`);
      for (const f of e.failures) printFailure(f);
    }
    console.log('');
  }

  console.log(`Summary: ${errors} error(s), ${warnings} warning(s)`);
  console.log(`         across ${rows.length} class entries.`);
  if (errors > 0) {
    console.log(`         (see DB project TODO for the documented findings;`);
    console.log(`         fixes flow back to the DB metadata, then this audit`);
    console.log(`         goes green class-by-class.)`);
  }

  process.exit(errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Class audit crashed:', err);
  process.exit(2);
});
