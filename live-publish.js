// live-publish.js — publish this tab's RESOLVED character state (2026-08-20).
//
// WHY. `saves/*.json` holds raw form fields (`cha-score`, `armor-ac-bonus`,
// `bab-1`). Everything the sheet computes — final initiative, AC/touch/
// flat-footed, saves with every bonus folded in, attack routines — is derived
// here in JS at display time and has never existed on disk. Anything that
// reads the save files to learn a character's real numbers gets them WRONG.
// That is the bug the megadungeon rig hit: stale initiative, missing Strength
// from Gorrash's gauntlets, narrated mid-combat and corrected out loud.
//
// The fix is NOT to re-derive elsewhere. Two implementations of D&D 3.5 math
// diverge, guaranteed, and then we are debugging which one lied. Instead this
// tab publishes what it already computed, and consumers read that. One
// implementation, and it is the one the player is looking at.
//
// SCHEMA 2 (2026-08-20) added, at the consuming rig's request and in its stated
// priority order: resolved SKILLS (final integers — the place it was drifting
// worst, since it rolls PC social skills against NPCs), defensive RIDERS
// (damage_reduction / spell_resistance / free-text notes), and daily-pool
// CAPACITIES. Capacities only, never current values: per the field-ownership
// split the consumer tracks depletion and the sheet hands it the ceiling, so
// `.sc-used` / `.sc-remain` / `.psi-pp-spent` are deliberately not published.
// One owner per number.
//
// SCOPE — phase 1 is PUBLISH ONLY. No inbound commands, no writes into the
// sheet. A consumer can read; it cannot yet change anything. Phase 2 (a
// command queue) is deliberately a separate change, because it needs a
// field-ownership split before it is safe to let anything else drive a sheet
// a player is editing live.
//
// DESIGN NOTES
//
//   * Reads the DOM, not the model. The resolved numbers live in the display
//     elements (`#ac-total`.textContent and friends) — that is the only place
//     the fully-folded values exist, and reading them is what guarantees we
//     publish what the player SEES rather than a parallel recomputation.
//   * Wraps `window.recalcAll` rather than asking every caller to notify us.
//     class-picker and others already call it directly; wrapping catches all
//     of them and needs no edits anywhere else.
//   * Heartbeats even when nothing changes, so a consumer can distinguish
//     "idle" from "tab closed". Staleness is the whole safety property on the
//     read side — see save_server.py's _LIVE comment.
//   * Silent by design. A publish failure must never interrupt play, so
//     everything is wrapped and failures are counted, not thrown. `LivePublish
//     .status()` exposes the counters for when you need to know if it's alive.
(function () {
  'use strict';

  var SCHEMA = 2;   // 2: + skills, defensive riders, pool capacities (rig ask)
  var DEBOUNCE_MS = 400;      // recalcAll can fire in bursts; publish the tail
  var WATCH_MS = 1500;        // change-detection poll (the reliable path)
  var HEARTBEAT_MS = 20000;   // well inside the server's 90s stale window

  var timer = null;
  var beat = null;
  var watch = null;
  var lastFingerprint = null;
  var installed = false;
  var stats = { published: 0, failed: 0, skipped: 0, lastAt: null, lastError: null };

  function $(sel) { return document.querySelector(sel); }

  // textContent for computed display elements, value for inputs. Returns null
  // rather than "" so a missing element is distinguishable from an empty one.
  function txt(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    var v = ('value' in el && el.tagName !== 'SPAN') ? el.value : el.textContent;
    if (v == null) return null;
    v = String(v).trim();
    return v === '' ? null : v;
  }

  // Numbers are published as numbers where they cleanly are one, so a consumer
  // never has to parse "+7" itself and never has to guess about a leading plus.
  function num(id) {
    var v = txt(id);
    if (v == null) return null;
    var m = /^[+-]?\d+$/.exec(v.replace(/\s+/g, ''));
    return m ? parseInt(m[0], 10) : v;
  }

  function abilities() {
    var out = {};
    ['str', 'dex', 'con', 'int', 'wis', 'cha'].forEach(function (a) {
      out[a] = { score: num(a + '-total'), mod: num(a + '-mod') };
    });
    return out;
  }

  function attacks() {
    var rows = document.querySelectorAll('.attack-entry');
    var out = [];
    Array.prototype.forEach.call(rows, function (row) {
      function f(sel) {
        var el = row.querySelector(sel);
        if (!el) return null;
        var v = ('value' in el ? el.value : el.textContent);
        v = (v == null ? '' : String(v)).trim();
        return v === '' ? null : v;
      }
      var name = f('.atk-name');
      var bonus = f('.atk-bonus');
      if (name == null && bonus == null) return;   // blank template row
      var bonusEl = row.querySelector('.atk-bonus');
      out.push({
        name: name,
        bonus: bonus,
        damage: f('.atk-damage'),
        crit: f('.atk-crit'),
        range: f('.atk-range'),
        type: f('.atk-type'),
        notes: f('.atk-notes'),
        // true when the sheet filled the bonus itself; false means the player
        // typed it and it is NOT guaranteed to reflect current modifiers.
        auto: !!(bonusEl && bonusEl.classList.contains('atk-bonus-auto'))
      });
    });
    return out;
  }

  // --- schema 2 ------------------------------------------------------------
  // Added 2026-08-20 at the rig's request, in its stated priority order:
  // resolved skills, defensive riders, pool CAPACITIES.

  function cell(row, sel) {
    var el = row.querySelector(sel);
    if (!el) return null;
    var v = ('value' in el ? el.value : el.textContent);
    v = (v == null ? '' : String(v)).trim();
    return v === '' ? null : v;
  }

  function intOf(v) {
    if (v == null) return null;
    var m = /^[+-]?\d+$/.exec(String(v).replace(/\s+/g, ''));
    return m ? parseInt(m[0], 10) : null;
  }

  // Resolved skill modifiers. `.skill-total` is a calc-field — the sheet always
  // computes it — so unlike an attack bonus there is no hand-typed variant and
  // no `auto` flag is needed. Ranks/misc ride along because a consumer that
  // wants to explain a number ("+14 = 9 ranks +3 Cha +2 synergy") otherwise has
  // to re-derive it, which is the whole thing we are avoiding.
  function skills() {
    var rows = document.querySelectorAll('#skills-body-left tr, #skills-body-right tr');
    var out = [];
    Array.prototype.forEach.call(rows, function (row) {
      var name = cell(row, '.skill-name');
      if (!name) return;                       // subtype group header
      out.push({
        name: name,
        ability: cell(row, '.skill-ability-col'),
        total: intOf(cell(row, '.skill-total')),
        ability_mod: intOf(cell(row, '.skill-ability-mod')),
        ranks: cell(row, '.skill-ranks'),
        misc: cell(row, '.skill-misc'),
        class_skill: !!(row.querySelector('.skill-class-check') || {}).checked
      });
    });
    return out;
  }

  // Daily pools: CAPACITY ONLY, deliberately.
  //
  // The ownership split says current/spent values belong to the consumer that
  // narrates the change — it tracks depletion, the sheet hands it the ceiling.
  // So `.sc-used`, `.sc-remain` and `.psi-pp-spent` are NOT published even
  // though they sit in the same rows. One owner per number; publishing them
  // would invite two writers for the same quantity, which is the collision the
  // split exists to prevent.
  function pools() {
    var out = { power_points: [], spell_slots: [], uses_per_day: {} };

    document.querySelectorAll('[data-caster-type="psionics"]').forEach(function (p, i) {
      var maxPP = intOf(cell(p, '.psi-pp-day'));
      if (maxPP == null) return;
      var pid = casterIdentity(p, i);
      out.power_points.push({ id: pid.id, label: pid.label, max: maxPP });
    });

    document.querySelectorAll('[data-caster-type="spellcasting"]').forEach(function (p, i) {
      var levels = [];
      p.querySelectorAll('.spell-slots-table tbody tr').forEach(function (row) {
        var perDay = intOf(cell(row, '.sc-per-day')) || 0;
        var bonus = intOf(cell(row, '.sc-bonus')) || 0;
        var domain = intOf(cell(row, '.sc-domain-slots')) || 0;
        var spec = intOf(cell(row, '.sc-specialist-slots')) || 0;
        var extra = intOf(cell(row, '.sc-extra')) || 0;
        var total = perDay + bonus + domain + spec + extra;
        var known = intOf(cell(row, '.sc-known'));
        var dc = intOf(cell(row, '.sc-dc'));
        if (!total && known == null && dc == null) return;   // unused level
        var lvlEl = row.querySelector('[data-lvl]');
        levels.push({
          level: lvlEl ? intOf(lvlEl.getAttribute('data-lvl')) : null,
          known: known, dc: dc,
          per_day: perDay, bonus: bonus, domain: domain,
          specialist: spec, extra: extra,
          capacity: total
        });
      });
      if (levels.length) {
        var cid = casterIdentity(p, i);
        out.spell_slots.push({ id: cid.id, label: cid.label, levels: levels });
      }
    });

    // Class daily uses that live as plain top-level fields.
    var rage = num('rage-per-day'), turn = num('turn-per-day');
    if (rage != null) out.uses_per_day.rage = rage;
    if (turn != null) out.uses_per_day.turn_undead = turn;

    return out;
  }

  // Caster blocks have NO class-name field of their own, which matters when a
  // character has several: Kell carries three spellcasting blocks whose only
  // distinguishing signal is the spell PICKER's class filter (.sp-class), and
  // that is a user-editable search box, not an identity.
  //
  // So publish both, honestly separated:
  //   id    — the panel's DOM id (caster-0, caster-1, ...). STABLE. Address by this.
  //   label — best-effort class name. May be blank or wrong if the player
  //           retyped the picker filter. Display it; do not key off it.
  //
  // Found by testing Kell rather than by reading: my first cut emitted only a
  // label and returned "Spellcasting" three times, which is useless to a
  // consumer that needs to tell a 7th-level caster from two 3rd-level ones.
  function casterIdentity(panel, i) {
    var label = null;
    var pp = panel.getAttribute('data-pp-class');           // psionics blocks carry this
    if (pp && pp.trim()) label = pp.trim();
    if (!label) {
      var follow = panel.querySelector('.caster-follow-class');
      if (follow && follow.value && follow.value.trim()) label = follow.value.trim();
    }
    if (!label) {
      var sp = panel.querySelector('.sp-class');
      if (sp && sp.value && sp.value.trim()) label = sp.value.trim();
    }
    return { id: panel.id || ('#' + i), label: label };
  }

  function conditions() {
    try {
      if (typeof Conditions !== 'undefined' && Conditions.getActive) {
        return Conditions.getActive();
      }
    } catch (e) { /* conditions module absent or mid-load */ }
    return null;
  }

  // NOTE: deliberately carries NO timestamp. `published_at` is stamped on in
  // publish() instead, because this object doubles as the change-detection
  // fingerprint — embedding a clock here would make every comparison differ
  // and turn the watcher into an unconditional 1.5s publisher.
  function snapshot(qualified) {
    return {
      schema: SCHEMA,
      qualified: qualified,
      identity: {
        name: txt('char-name'),
        race: txt('char-race'),
        classes: txt('char-class'),
        level: num('char-level'),
        alignment: txt('char-alignment')
      },
      abilities: abilities(),
      defense: {
        ac: num('ac-total'),
        touch: num('ac-touch'),
        flat_footed: num('ac-flatfooted'),
        // Riders. DR and SR are their own fields; energy resistances and
        // immunities are NOT separately modelled by the sheet — whatever the
        // player wrote lands in `notes` as free text. Said plainly rather than
        // emitted as a structured field we cannot actually fill, because a
        // consumer parsing an empty `resistances: []` would read "none" where
        // the truth is "not modelled".
        damage_reduction: txt('damage-reduction'),
        spell_resistance: txt('spell-resistance'),
        notes: txt('ac-defense-notes')
      },
      saves: { fort: num('fort-total'), ref: num('ref-total'), will: num('will-total') },
      initiative: num('init-total'),
      grapple: num('grapple-total'),
      bab: num('bab-1'),
      hp: {
        total: num('hp-total'),
        current: num('hp-current'),
        temp: num('hp-temp'),
        nonlethal: num('hp-nonlethal')
      },
      speed: { land: txt('speed-land'), fly: txt('speed-fly') },
      attacks: attacks(),
      skills: skills(),
      pools: pools(),
      conditions: conditions()
    };
  }

  // `isHeartbeat` republishes identical content on purpose: the server's
  // freshness clock is what tells a consumer this tab still exists, so a quiet
  // tab must keep saying so.
  function publish(isHeartbeat) {
    var qualified = null;
    try {
      qualified = window.AppState && window.AppState.currentQualifiedName;
    } catch (e) { /* AppState not ready */ }
    // An unsaved / brand-new character has no stable address, so there is
    // nothing a consumer could ask for. Skipping is correct; publishing it
    // under a guessed key would be worse than silence.
    if (!qualified) { stats.skipped++; return; }

    var snap, fingerprint, body;
    try {
      snap = snapshot(qualified);
      fingerprint = JSON.stringify(snap);
      if (!isHeartbeat && fingerprint === lastFingerprint) return;  // no change
      snap.published_at = new Date().toISOString();
      body = JSON.stringify(snap);
    } catch (e) {
      stats.failed++; stats.lastError = 'serialize: ' + e; return;
    }
    lastFingerprint = fingerprint;

    fetch('/api/live/' + encodeURIComponent(qualified), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: body
    }).then(function (r) {
      if (r.ok) { stats.published++; stats.lastAt = new Date().toISOString(); }
      else { stats.failed++; stats.lastError = 'HTTP ' + r.status; }
    }).catch(function (e) {
      // Served by plain `python -m http.server` (no API), or the server went
      // away. Not an error worth surfacing — the sheet is fully usable
      // standalone and this is purely additive.
      stats.failed++; stats.lastError = String(e);
    });
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; publish(); }, DEBOUNCE_MS);
  }

  function install() {
    if (installed) return;
    var orig = window.recalcAll;
    if (typeof orig !== 'function') return;   // app.js not loaded yet
    window.recalcAll = function () {
      var r = orig.apply(this, arguments);
      try { schedule(); } catch (e) { /* never break a recalc */ }
      return r;
    };
    installed = true;

    // WATCH THE STATE, DON'T TRUST A NOTIFICATION. This is the load-bearing
    // mechanism, and it exists because the two obvious hooks both turned out
    // to be partial — found by testing, not by reading:
    //
    //   * wrapping `window.recalcAll` only catches EXTERNAL callers. app.js's
    //     own recalcs go through its module-local binding and never touch the
    //     global, so most in-sheet edits never reach the wrapper.
    //   * wrapping the AppState setter only catches external writes too:
    //     loadCharacter assigns the closure variable `currentQualifiedName`
    //     directly, so a character LOAD never fires the setter either.
    //
    // Both hooks are still installed because when they do fire they are
    // instant. But correctness rests on this poll: diff the snapshot we would
    // publish against the one we last published, and publish on any change.
    // It cannot be bypassed by a code path that forgets to notify us, which
    // is precisely the failure the two hooks above each had.
    watch = setInterval(function () {
      try {
        var q = (window.AppState && window.AppState.currentQualifiedName) || null;
        if (!q) return;
        var fp = JSON.stringify(snapshot(q));
        if (fp !== lastFingerprint) publish();
      } catch (e) { /* never break the page */ }
    }, WATCH_MS);

    // Heartbeat so a consumer can tell a quiet tab from a closed one. The
    // watcher publishes on CHANGE; this publishes on SILENCE, and the two
    // together are what let a reader distinguish "nothing happened" from
    // "this tab is gone".
    beat = setInterval(function () { try { publish(true); } catch (e) {} }, HEARTBEAT_MS);
    // Publish once on load so a consumer sees the character without waiting
    // for the player to touch something.
    setTimeout(function () { try { publish(); } catch (e) {} }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }

  window.LivePublish = {
    publish: publish,
    status: function () {
      return {
        installed: installed,
        qualified: (window.AppState && window.AppState.currentQualifiedName) || null,
        published: stats.published,
        failed: stats.failed,
        skipped: stats.skipped,
        lastAt: stats.lastAt,
        lastError: stats.lastError
      };
    },
    snapshot: function () {
      var q = (window.AppState && window.AppState.currentQualifiedName) || null;
      return snapshot(q);
    }
  };
})();
