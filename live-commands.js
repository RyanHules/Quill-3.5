// live-commands.js — apply INBOUND writes from a consumer (phase 2, 2026-08-20).
//
// WHY. Phase 1 made the sheet's resolved numbers readable (see live-publish.js).
// Phase 2 makes the volatile half of them WRITABLE, so the megadungeon rig can
// apply combat damage, spend a slot, or set a condition without Ryan retyping
// it into four browser tabs mid-fight — and so the rig immediately sees what
// that did to every derived number, because the write returns the post-recalc
// snapshot.
//
// THE OWNERSHIP SPLIT IS THE SAFETY PROPERTY, and it is enforced on the SERVER
// (save_server.py's LIVE_WRITABLE), not here. That split is the contract with
// the consumer, so it lives where the consumer can read it — `GET
// /api/live-writable`. This file answers a different question: given a field
// the server has already blessed, WHERE does it live in the DOM. Two different
// questions, deliberately in two places.
//
//   The seam between them is gated, not trusted: tests/test_pickers.js parses
//   the pattern list out of BOTH files and fails when they diverge. A field the
//   server allows and this tab cannot place is not a silent no-op — it comes
//   back as `unknown-field`, which is the drift saying so out loud.
//
// ABSOLUTE VALUES, NEVER DELTAS. The writer owns the number and sends the
// number. A lost or duplicated delta corrupts silently and nothing can tell
// afterwards; an absolute value is idempotent, which is also what makes two
// tabs holding the same character harmless — they apply the same value.
//
// THE PLAYER OUTRANKS THE RIG. A field the player currently has FOCUS in is
// refused, with a reason, rather than overwritten mid-keystroke. That is the
// one collision this design cannot make impossible, so it is made visible: the
// write comes back `partial` and the rig can say so or retry. Everything
// written flashes briefly, because a number changing by itself on a sheet
// somebody is looking at should never be silent.
//
// DELIVERY IS A LONG POLL, NOT A TIMER. The tab parks a request on the server
// and the server answers the instant a write arrives. That matters more than it
// looks: Ryan runs four tabs and at most one is on screen, and Chrome throttles
// background timers to roughly one fire a minute — which already slows phase
// 1's change-watcher in the three hidden tabs. A parked fetch resolves on a
// network event, so an inbound write lands immediately in a tab that has been
// buried behind three others all session.
(function () {
  'use strict';

  var POLL_WAIT_SEC = 25;     // server parks up to this long; must stay < its socket timeout
  var IDLE_MS = 2000;         // no character loaded yet — re-check for one
  var RETRY_MS = 30000;       // no API (plain `python -m http.server`) or server down
  var MIN_SPACING_MS = 1000;  // floor on re-poll, so a misbehaving 200 can't hot-loop
  var SWAP_CHECK_MS = 2000;   // notice a character swap and re-target the poll
  var FLASH_MS = 1200;

  var stopped = false;
  var pollingFor = null;
  var controller = null;
  var stats = { polls: 0, commands: 0, applied: 0, rejected: 0,
                failed: 0, lastAt: null, lastError: null, lastCommand: null };

  function qualified() {
    try { return (window.AppState && window.AppState.currentQualifiedName) || null; }
    catch (e) { return null; }
  }

  // ---- DOM targets --------------------------------------------------------
  //
  // One target per writable field: where it lives, how to write it, how to read
  // it back. `read` runs AFTER the recalc, so the echo reports what the sheet
  // actually holds — a clamp (`min="0"` on nonlethal damage) or a coercion
  // shows up as itself instead of being reported as a clean success.

  function fire(el) {
    // Both events: some modules listen on `input` for live recalc, others on
    // `change`. Bubbling so delegated listeners see them too.
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function numOrText(v) {
    if (v == null) return null;
    var s = String(v).trim();
    if (s === '') return null;
    return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : s;
  }

  function focusRefusal(el) {
    return (document.activeElement === el)
      ? 'field-focused — the player is editing it right now'
      : null;
  }

  function inputTarget(id) {
    return {
      el: function () { return document.getElementById(id); },
      write: function (value) {
        var el = this.el();
        if (!el) return { ok: false, reason: 'no such field on this sheet' };
        var busy = focusRefusal(el);
        if (busy) return { ok: false, reason: busy };
        el.value = String(value);
        fire(el);
        return { ok: true };
      },
      read: function () { var el = this.el(); return el ? numOrText(el.value) : null; }
    };
  }

  function checkboxTarget(id) {
    return {
      el: function () { return document.getElementById(id); },
      write: function (value) {
        var el = this.el();
        if (!el) return { ok: false, reason: 'no such field on this sheet' };
        var busy = focusRefusal(el);
        if (busy) return { ok: false, reason: busy };
        el.checked = !!value;
        fire(el);
        return { ok: true };
      },
      read: function () { var el = this.el(); return el ? !!el.checked : null; }
    };
  }

  // A field inside one caster panel, addressed by the panel id phase 1
  // publishes (`caster-0`). getElementById rather than a selector so a panel id
  // can never be read as CSS syntax.
  function casterTarget(casterId, selector) {
    return {
      el: function () {
        var panel = document.getElementById(casterId);
        if (!panel || !panel.getAttribute('data-caster-type')) return null;
        return panel.querySelector(selector);
      },
      write: function (value) {
        var el = this.el();
        if (!el) {
          return { ok: false,
                   reason: 'no such caster field on this sheet (' + casterId + ' ' + selector + ')' };
        }
        var busy = focusRefusal(el);
        if (busy) return { ok: false, reason: busy };
        el.value = String(value);
        fire(el);
        return { ok: true };
      },
      read: function () { var el = this.el(); return el ? numOrText(el.value) : null; }
    };
  }

  // Conditions are ONE field carrying the COMPLETE active set, so an unknown
  // name refuses the whole write instead of applying the recognised half: a
  // partial apply would leave a state matching neither what was asked for nor
  // what was there, and nothing downstream could tell. The rejection names the
  // offending condition so the caller can fix its spelling.
  function conditionsTarget() {
    function boxes() { return document.querySelectorAll('.condition-toggle'); }
    return {
      el: function () { return document.getElementById('conditions-summary'); },
      write: function (list) {
        var all = boxes();
        if (!all.length) return { ok: false, reason: 'the conditions panel is not built yet' };
        var active = document.activeElement;
        if (active && active.classList && active.classList.contains('condition-toggle')) {
          return { ok: false, reason: 'field-focused — the player is toggling conditions' };
        }
        var known = {}, unknown = [];
        Array.prototype.forEach.call(all, function (b) {
          known[String(b.dataset.condition).toLowerCase()] = true;
        });
        var want = {};
        list.forEach(function (n) {
          var k = String(n).toLowerCase();
          if (!known[k]) unknown.push(n); else want[k] = true;
        });
        if (unknown.length) {
          return { ok: false,
                   reason: 'unrecognised condition: ' + unknown.join(', ') +
                           ' — nothing was changed' };
        }
        // Go through the module's own loader rather than ticking its
        // checkboxes: it also refreshes the summary line under them. Setting
        // `.checked` directly left the boxes right and the summary blank —
        // found in the browser, not by reading, because from outside the DOM a
        // half-updated panel looks exactly like a working one.
        if (typeof Conditions === 'undefined' || !Conditions.loadData) {
          return { ok: false, reason: 'the conditions module is not loaded' };
        }
        Conditions.loadData({ activeConditions: list });
        // conditions.js fires this on a manual toggle and app.js recalcs on it;
        // going through the same event keeps the bonus layer's one entry point.
        document.dispatchEvent(new Event('conditions-changed'));
        return { ok: true };
      },
      read: function () {
        try {
          if (typeof Conditions !== 'undefined' && Conditions.getActive) return Conditions.getActive();
        } catch (e) { /* module absent or mid-load */ }
        return null;
      }
    };
  }

  // The field paths this tab can place, in the same order and with the same
  // pattern SOURCES as save_server.py's LIVE_WRITABLE. Character-for-character
  // identical on purpose: tests/test_pickers.js compares the two lists as text,
  // so a field added on one side and forgotten on the other fails the suite
  // instead of failing silently at 2am mid-combat.
  var FIELDS = [
    { pattern: /^hp\.current$/,     target: function () { return inputTarget('hp-current'); } },
    { pattern: /^hp\.temp$/,        target: function () { return inputTarget('hp-temp'); } },
    { pattern: /^hp\.nonlethal$/,   target: function () { return inputTarget('hp-nonlethal'); } },
    { pattern: /^conditions$/,      target: function () { return conditionsTarget(); } },
    { pattern: /^rage_active$/,     target: function () { return checkboxTarget('rage-active'); } },
    { pattern: /^uses_per_day\.rage\.used$/,
      target: function () { return inputTarget('rage-used'); } },
    { pattern: /^xp$/,              target: function () { return inputTarget('char-xp'); } },
    { pattern: /^money\.(cp|sp|gp|pp)$/,
      target: function (m) { return inputTarget('money-' + m[1]); } },
    { pattern: /^pools\.power_points\.([^.]+)\.spent$/,
      target: function (m) { return casterTarget(m[1], '.psi-pp-spent'); } },
    { pattern: /^pools\.spell_slots\.([^.]+)\.(\d+)\.used$/,
      target: function (m) { return casterTarget(m[1], '.sc-used[data-lvl="' + m[2] + '"]'); } }
  ];

  function resolve(field) {
    for (var i = 0; i < FIELDS.length; i++) {
      var m = FIELDS[i].pattern.exec(field);
      if (m) return FIELDS[i].target(m);
    }
    return null;
  }

  function flash(el) {
    if (!el || !el.classList) return;
    el.classList.add('live-written');
    setTimeout(function () { try { el.classList.remove('live-written'); } catch (e) {} }, FLASH_MS);
  }

  // ---- applying -----------------------------------------------------------

  function applyCommand(cmd) {
    var applied = [], rejected = [], echo = {}, touched = [];
    var fields = (cmd && cmd.fields) || {};
    Object.keys(fields).forEach(function (field) {
      var target;
      try { target = resolve(field); } catch (e) { target = null; }
      if (!target) {
        // The server allowed a field this tab cannot place. That is a genuine
        // divergence between the two halves, not a caller error, and it says so.
        rejected.push({ field: field, reason: 'unknown-field — this tab has no mapping for it' });
        return;
      }
      var r;
      try { r = target.write(fields[field]); }
      catch (e) { r = { ok: false, reason: 'write threw: ' + e }; }
      if (!r || !r.ok) {
        rejected.push({ field: field, reason: (r && r.reason) || 'refused' });
        return;
      }
      applied.push(field);
      touched.push({ field: field, target: target });
    });

    // ONE recalc for the whole batch, after every field has landed. Per-field
    // recalcs would publish intermediate states — a character at -3 HP for a
    // frame because damage arrived before temp HP did.
    if (applied.length) {
      try {
        if (typeof window.recalcAll === 'function') window.recalcAll();
      } catch (e) { stats.lastError = 'recalc: ' + e; }
    }
    touched.forEach(function (t) {
      try { echo[t.field] = t.target.read(); } catch (e) { echo[t.field] = null; }
      try { flash(t.target.el()); } catch (e) { /* cosmetic only */ }
    });

    stats.applied += applied.length;
    stats.rejected += rejected.length;
    return { id: cmd.id, applied: applied, rejected: rejected, echo: echo };
  }

  // The ack carries the post-recalc snapshot and the server stores it exactly
  // as a publish, so what the writer gets back is byte-for-byte what a reader
  // would get. Telling live-publish.js about it keeps its change-watcher from
  // immediately re-publishing identical content.
  function ack(q, results) {
    var snap = null;
    try {
      if (window.LivePublish && window.LivePublish.snapshot) {
        snap = window.LivePublish.snapshot();
        if (window.LivePublish.notePublished) window.LivePublish.notePublished(snap);
        snap.published_at = new Date().toISOString();
      }
    } catch (e) { stats.lastError = 'snapshot: ' + e; }

    return fetch('/api/live-ack/' + encodeURIComponent(q), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results: results, snapshot: snap })
    }).catch(function (e) { stats.failed++; stats.lastError = 'ack: ' + e; });
  }

  function handleBatch(q, commands) {
    var results = [];
    commands.forEach(function (cmd) {
      stats.commands++;
      stats.lastCommand = { id: cmd.id, source: cmd.source || null,
                            reason: cmd.reason || null, at: new Date().toISOString() };
      var r;
      try { r = applyCommand(cmd); }
      catch (e) {
        r = { id: cmd.id, applied: [], echo: {},
              rejected: [{ field: '*', reason: 'apply threw: ' + e }] };
      }
      results.push(r);
    });
    return ack(q, results);
  }

  // ---- the long poll ------------------------------------------------------

  function schedule(ms) {
    if (stopped) return;
    setTimeout(poll, ms);
  }

  function poll() {
    if (stopped) return;
    var q = qualified();
    // Nothing to poll for: an unsaved character has no address, so no consumer
    // could name it. Same reasoning as live-publish.js skipping the publish.
    if (!q) { pollingFor = null; return schedule(IDLE_MS); }

    pollingFor = q;
    controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var startedAt = Date.now();
    stats.polls++;

    fetch('/api/live-commands/' + encodeURIComponent(q) + '?wait=' + POLL_WAIT_SEC,
          controller ? { signal: controller.signal } : {})
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var cmds = (data && data.commands) || [];
        stats.lastAt = new Date().toISOString();
        var next = (Date.now() - startedAt) < MIN_SPACING_MS ? MIN_SPACING_MS : 0;
        if (!cmds.length) return schedule(next);
        handleBatch(q, cmds).then(function () { schedule(0); },
                                  function () { schedule(next); });
      })
      .catch(function (e) {
        // Aborted on a character swap is normal and immediate; anything else is
        // "no API here" (plain `python -m http.server`) or the server going
        // away, and backs off hard. A tight retry against a 404 would turn a
        // perfectly usable standalone sheet into a request storm.
        if (e && e.name === 'AbortError') return schedule(0);
        stats.failed++; stats.lastError = String(e);
        schedule(RETRY_MS);
      });
  }

  // WATCH FOR THE SWAP, DON'T WAIT TO BE TOLD. Loading a character assigns
  // app.js's closure variable directly, so the AppState setter never fires —
  // the same trap that made phase 1's notification hooks useless (see
  // live-publish.js). Without this, a tab that switched characters keeps a poll
  // parked on the OLD name for up to 25 seconds, and a write to the new one
  // finds no listener and correctly but needlessly reports not-applied.
  function watchForSwap() {
    setInterval(function () {
      try {
        var q = qualified();
        if (controller && pollingFor && q !== pollingFor) controller.abort();
      } catch (e) { /* never break the page */ }
    }, SWAP_CHECK_MS);
  }

  function start() {
    watchForSwap();
    poll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  window.LiveCommands = {
    status: function () {
      return {
        qualified: qualified(),
        pollingFor: pollingFor,
        polls: stats.polls,
        commands: stats.commands,
        applied: stats.applied,
        rejected: stats.rejected,
        failed: stats.failed,
        lastAt: stats.lastAt,
        lastError: stats.lastError,
        lastCommand: stats.lastCommand
      };
    },
    // Exposed for tests and for hand-driving one write from the console
    // without a server round trip.
    applyCommand: applyCommand,
    fields: function () { return FIELDS.map(function (f) { return f.pattern.source; }); },
    stop: function () { stopped = true; if (controller) controller.abort(); }
  };
})();
