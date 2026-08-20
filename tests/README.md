# Tests

Smoke tests for the character sheet's database integration.

## Lookup usability harness

`test_lookup_recall.js` — does a query a player would actually type surface
the RIGHT entry, near the top? Runs the real `lookup.js` ranker headless
against `data/dnd35.db` (via the same sql.js sandbox as `test_pickers.js`)
over a curated set of `query -> expected-entry` cases.

```bash
node tests/test_lookup_recall.js
```

Reports an MRR health number and hard-gates a per-case top-N threshold
(exit 1 on any miss). Exists because the "selected weapon -> Weapon Focus"
search bug (2026-08-05) shipped with nothing testing retrieval quality. Add
a case for every future search gap — same discipline as the save-stability
regressions. The metric is ISEE's (Tian et al., 2026) Usability dimension —
the one that maps to a game DB. See the header comment for the discovery-mode
roadmap (mechanic search -> all interacting entries).

## Layer 2: picker query smoke test

`test_pickers.js` — Node.js script that runs the EXACT SQL each
`*-picker.js` issues against `data/dnd35.db` via the same sql.js
library the browser uses. No npm install needed (uses vendored
`vendor/sql-wasm.js`).

```bash
node tests/test_pickers.js
```

Exits 0 on all-pass, 1 on any failure.

### What it covers (22 tests)

| Group | Tests | What it verifies |
|---|---|---|
| `database.js` load-time queries | 4 | Counts of races / spells / feats / items > 0 |
| `feat-picker.js` | 2 | List query + detail-by-id query work |
| `item-picker.js` | 2 | List + detail |
| `spell-picker.js` | 3 | Distinct class names; spell list join (Sor 3); detail by name |
| `race-picker.js` | 2 | Base list + detail (sub-table queries are flagged as needing adaptation) |
| `template-picker.js` | 1 | List query (sub-table queries flagged) |
| `class-picker.js` | 2 | View query works; class_table is in entry.data JSON (path forward documented) |
| Tags | 2 | combat-maneuver feats; evocation school via tag mirror |
| Errata | 2 | Applied count; lookup by entry name |
| Spell access | 2 | Spellthief derived spells; Beguiler native + derived |

### Adding tests

Each test is registered with `test('name', (db) => {...})`. Use:

- `assert(cond, msg)` — boolean assertion
- `assertGE(actual, expected, msg)` — numeric ≥
- `assertNotEmpty(arr, msg)` — array length > 0
- `execAll(db, sql, params)` — returns array of row objects
- `execOne(db, sql, params)` — returns first row or null

When a picker is adapted, add tests covering the new query patterns.
When a new picker is added (deity, domain, plane, etc.), add a section
of tests for it.

## Layer 1: DB regression suite (Database project)

The sibling [D&D 3.5 Database](../../D&D%203.5%20Database/) project
has a comprehensive Python test suite at
`databases/manual/test_db.py` (61 tests) covering schema integrity,
referential integrity, tag taxonomy, errata kinds, spell access
provenance, etc. Run after every DB rebuild:

```bash
cd "../../D&D 3.5 Database/databases/manual"
python test_db.py
```

## Server suites (no DB, no browser)

`test_save_server.py` — the review-flag / sheet-report store's atomic
add/resolve/remove, including the multi-tab concurrency guard that is the
actual thing that once regressed.

`test_live_bus.py` — the live resolved-state bus's inbound half. Boots a real
server on an ephemeral port and drives `/api/live-write` over HTTP with a fake
"tab" thread doing poll → apply → ack. Integration rather than unit on purpose:
every property worth testing here is a property of the HANDOFF, and none of them
survive being tested against a mock of the thing doing the handing off. Several
checks are pure negative controls — a stale tab must NOT accept a write, an
unrecognised field must NOT be applied, a command past its deadline must NOT be
dispatched.

```bash
python tests/test_save_server.py
python tests/test_live_bus.py
```

Both are zero-dependency (no pytest) and exit 1 on any failure.

## When to run which

| Event | Run |
|---|---|
| Pulled a new `data/dnd35.db` | `node tests/test_pickers.js` |
| Adapted a picker module | `node tests/test_pickers.js` |
| About to add a new picker | Both layers |
| Rebuilt the DB upstream | Both layers |
| Touched `save_server.py` or the live bus | `python tests/test_live_bus.py` + `python tests/test_save_server.py` |

## Why two layers?

- **Layer 1 (Python)** — comprehensive DB-level regression coverage.
  Lives in the Database project; fires on every rebuild before the
  DB is even copied here.
- **Layer 2 (Node)** — picker integration smoke test. Lives here.
  Verifies the JS code path (sql.js, query syntax, expected schema)
  works against the actual DB file shipped with the character sheet.

A failure in Layer 1 means the DB is bad. A failure in Layer 2 means
the picker code expectations don't match the DB shape — most often
during schema migrations like the one currently underway for race,
template, and class pickers.
