#!/usr/bin/env python
"""test_live_bus.py — end-to-end guards for the live resolved-state bus.

Zero-dependency assertion suite in the same style as test_save_server.py — run
with `python tests/test_live_bus.py`. It boots a real server on an ephemeral
port and drives the phase-2 write path over HTTP, with a fake "tab" thread
standing in for the browser: long-poll, apply, acknowledge with a snapshot.

WHY IT IS AN INTEGRATION TEST AND NOT UNIT TESTS. Every interesting property of
this bus is a property of the HANDOFF — a write blocks until a tab acks, a
command past its deadline is never dispatched, an outcome nobody can determine
is reported as unknown rather than guessed. None of those survive being tested
against a mock of the thing doing the handing off. The static half of the
guards (that the two field lists agree, that refusals explain themselves) lives
in tests/test_pickers.js; this file proves the machinery actually runs.

The negative controls are the point of several of these: a stale tab must NOT
accept a write, an expired command must NOT be dispatched, a structural field
must NOT be applied. A suite that only checks the happy path would pass just as
happily with the entire safety layer deleted.
"""
import importlib.util
import json
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("save_server", _ROOT / "save_server.py")
ss = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ss)

_passed = 0
_failed = 0
BASE = None


def check(name, cond, detail=""):
    global _passed, _failed
    if cond:
        _passed += 1
    else:
        _failed += 1
        print(f"  FAIL: {name}" + (f"\n        {detail}" if detail else ""))


def call(method, path, body=None, timeout=30):
    """(status, parsed-json-or-None). Error statuses come back, not raised —
    every refusal in this design is a documented status with a body worth
    reading, so swallowing them into an exception would hide the thing we test."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, (json.loads(raw) if raw.strip() else None)


def snapshot(name="Test Hero", hp_current=30):
    """A minimal but structurally real schema-2 snapshot."""
    return {
        "schema": 2,
        "qualified": "active/" + name,
        "identity": {"name": name, "race": "Human", "classes": "Fighter 5",
                     "level": 5, "alignment": "NG"},
        "abilities": {"str": {"score": 18, "mod": 4}},
        "defense": {"ac": 20, "touch": 12, "flat_footed": 18},
        "saves": {"fort": 7, "ref": 3, "will": 2},
        "hp": {"total": 45, "current": hp_current, "temp": 0, "nonlethal": 0},
        "conditions": [],
    }


def publish(key, snap):
    return call("PUT", "/api/live/" + urllib.request.quote(key, safe=""), snap)[0]


def age_out(key, seconds):
    """Backdate a published snapshot so it reads as stale.

    Reaches into _LIVE rather than sleeping: the stale window is 90 seconds and
    a test that waits it out is a test nobody runs.
    """
    with ss._LIVE_LOCK:
        ss._LIVE[key]["received_at"] -= seconds


class FakeTab(threading.Thread):
    """Stands in for a browser tab: long-poll, apply, ack with a new snapshot.

    `applier` decides what the tab claims to have done, so a test can make it
    refuse a field (the focused-field case) without needing a DOM.
    """

    daemon = True

    def __init__(self, key, applier=None, rounds=1):
        super().__init__()
        self.key = key
        self.applier = applier or (lambda fields: (list(fields), [], dict(fields)))
        self.rounds = rounds
        self.seen = []
        self.state = snapshot(key.split("/")[-1])

    def run(self):
        quoted = urllib.request.quote(self.key, safe="")
        for _ in range(self.rounds):
            status, data = call("GET", f"/api/live-commands/{quoted}?wait=10", timeout=30)
            if status != 200 or not data:
                return
            commands = data.get("commands") or []
            if not commands:
                continue
            results = []
            for cmd in commands:
                self.seen.append(cmd)
                applied, rejected, echo = self.applier(cmd["fields"])
                for field in applied:
                    if field == "hp.current":
                        self.state["hp"]["current"] = cmd["fields"][field]
                    if field == "conditions":
                        self.state["conditions"] = cmd["fields"][field]
                results.append({"id": cmd["id"], "applied": applied,
                                "rejected": rejected, "echo": echo})
            call("POST", f"/api/live-ack/{quoted}",
                 {"results": results, "snapshot": self.state})


# ---------------------------------------------------------------------------

def test_writable_is_introspectable():
    status, data = call("GET", "/api/live-writable")
    check("writable: endpoint answers 200", status == 200, f"got {status}")
    fields = [w["field"] for w in (data or {}).get("writable", [])]
    check("writable: lists the volatile fields the consumer owns",
          any("hp\\.current" in f for f in fields) and any("conditions" in f for f in fields),
          str(fields))
    check("writable: states values are absolute, not deltas",
          (data or {}).get("absolute_values_only") is True)
    check("writable: refusals come with reasons",
          all(r.get("reason") for r in (data or {}).get("refused", [])))


def test_write_without_a_tab_is_refused():
    status, data = call("POST", "/api/live-write/active/Nobody",
                        {"fields": {"hp.current": 10}})
    check("no tab: refused 409", status == 409, f"got {status}")
    check("no tab: reason distinguishes 'never open'",
          (data or {}).get("reason") == "no-live-tab", str(data))


def test_write_to_a_stale_tab_is_refused():
    key = "active/Staley"
    publish(key, snapshot("Staley"))
    age_out(key, ss.LIVE_STALE_AFTER_SEC + 30)
    status, data = call("POST", "/api/live-write/" + urllib.request.quote(key, safe=""),
                        {"fields": {"hp.current": 10}})
    check("stale tab: refused 409", status == 409, f"got {status}")
    check("stale tab: reason distinguishes 'went away' from 'never open'",
          (data or {}).get("reason") == "stale-tab", str(data))
    check("stale tab: reports the age it judged on",
          isinstance((data or {}).get("age_seconds"), (int, float)))


def test_structural_fields_are_refused_with_a_reason():
    key = "active/Structural"
    publish(key, snapshot("Structural"))
    status, data = call("POST", "/api/live-write/" + urllib.request.quote(key, safe=""),
                        {"fields": {"abilities.str.score": 20, "hp.total": 60,
                                    "saves.fort": 9}})
    check("split: an all-structural write is refused before queueing",
          status == 400 and (data or {}).get("reason") == "no-writable-fields",
          f"{status} {data}")
    reasons = {r["field"]: r["reason"] for r in (data or {}).get("rejected", [])}
    check("split: every refusal explains itself",
          len(reasons) == 3 and all(len(r) > 20 for r in reasons.values()), str(reasons))
    check("split: the ability refusal names ownership, not a typo",
          "structural" in reasons.get("abilities.str.score", ""), str(reasons))


def test_an_unrecognised_field_is_refused_by_default():
    """DEFAULT-DENY, tested on its own.

    The test above only uses fields that MATCH the refusal-hint list, so it
    passes with the allowlist's final `return False` flipped to allow — which
    is how this suite first ran: three structural fields refused, and an
    arbitrary path sailing straight through to a live sheet. The hint list is a
    courtesy; the fall-through is the actual gate, and it needs its own probe.
    """
    key = "active/Unknown"
    publish(key, snapshot("Unknown"))
    status, data = call("POST", "/api/live-write/" + urllib.request.quote(key, safe=""),
                        {"fields": {"totally.made.up": 1}})
    check("default-deny: a field on neither list is refused",
          status == 400 and (data or {}).get("reason") == "no-writable-fields",
          f"{status} {data}")
    reasons = [r["reason"] for r in (data or {}).get("rejected", [])]
    check("default-deny: the refusal points at the introspection endpoint",
          any("live-writable" in r for r in reasons), str(reasons))

    # A near-miss on a real field is the likeliest way a typo arrives, and it
    # must not be treated as the field it resembles.
    for typo in ["hp.currant", "hp.current.value", "conditions.0", "xp "]:
        status, _ = call("POST", "/api/live-write/" + urllib.request.quote(key, safe=""),
                         {"fields": {typo: 1}})
        check(f"default-deny: `{typo}` is not mistaken for a writable field",
              status == 400, f"got {status}")


def test_type_errors_come_back_to_the_writer():
    key = "active/Typed"
    publish(key, snapshot("Typed"))
    status, data = call("POST", "/api/live-write/" + urllib.request.quote(key, safe=""),
                        {"fields": {"hp.current": "twelve"}})
    check("types: a string in an integer field never reaches the tab",
          status == 400, f"got {status}")
    reasons = [r["reason"] for r in (data or {}).get("rejected", [])]
    check("types: the reason says what was expected",
          any("integer" in r for r in reasons), str(reasons))

    # bool is an int in Python; the check must exclude it deliberately, not
    # by luck, or `true` would sail into current HP as 1.
    status, data = call("POST", "/api/live-write/" + urllib.request.quote(key, safe=""),
                        {"fields": {"hp.current": True}})
    check("types: true is not an integer", status == 400, f"got {status} {data}")


def test_round_trip_returns_the_post_write_snapshot():
    key = "active/Gorrash"
    publish(key, snapshot("Gorrash", hp_current=41))
    tab = FakeTab(key)
    tab.start()
    time.sleep(0.2)   # let the tab park its poll
    status, data = call("POST", "/api/live-write/" + urllib.request.quote(key, safe=""),
                        {"fields": {"hp.current": 23}, "source": "megadungeon-rig",
                         "reason": "J7 round 3"})
    check("round trip: 200", status == 200, f"got {status} {data}")
    check("round trip: status is applied", (data or {}).get("status") == "applied", str(data))
    check("round trip: the applied field is named", (data or {}).get("applied") == ["hp.current"])
    # The whole reason the write blocks: the consumer must not have to poll
    # afterwards and guess whether what it reads is before or after its write.
    check("round trip: the returned snapshot is POST-write",
          (((data or {}).get("snapshot") or {}).get("hp") or {}).get("current") == 23,
          str((data or {}).get("snapshot")))
    check("round trip: the echo reports what the sheet actually holds",
          (data or {}).get("echo", {}).get("hp.current") == 23, str(data))
    check("round trip: the tab was told who asked and why",
          tab.seen and tab.seen[0].get("source") == "megadungeon-rig"
          and tab.seen[0].get("reason") == "J7 round 3", str(tab.seen))
    # The ack doubles as a publish, so a plain reader sees the same numbers.
    status, view = call("GET", "/api/live/" + urllib.request.quote(key, safe=""))
    check("round trip: a reader sees the same post-write snapshot",
          status == 200 and view["snapshot"]["hp"]["current"] == 23, str(view))
    tab.join(timeout=5)


def test_partial_write_when_the_tab_refuses_a_field():
    key = "active/Partial"
    publish(key, snapshot("Partial"))

    def applier(fields):
        # Stands in for the player having focus in the HP box.
        applied = [f for f in fields if f != "hp.current"]
        rejected = [{"field": "hp.current", "reason": "field-focused — the player is editing it"}]
        return applied, rejected, {f: fields[f] for f in applied}

    tab = FakeTab(key, applier=applier)
    tab.start()
    time.sleep(0.2)
    status, data = call("POST", "/api/live-write/" + urllib.request.quote(key, safe=""),
                        {"fields": {"hp.current": 5, "conditions": ["Fatigued"]}})
    check("partial: reported as partial, not applied",
          status == 200 and (data or {}).get("status") == "partial", f"{status} {data}")
    check("partial: the refused field comes back with the tab's reason",
          any("focused" in r["reason"] for r in (data or {}).get("rejected", [])), str(data))
    check("partial: the accepted field still landed",
          (data or {}).get("applied") == ["conditions"], str(data))
    tab.join(timeout=5)


def test_no_tab_claimed_is_certain_not_unknown():
    """A tab is publishing but nothing is polling — an OLD tab, pre-phase-2.

    This must be reported as certainly-not-applied, because it is: the command
    expired without ever being handed out. Reporting it as `unknown` would be
    just as dishonest as reporting success.
    """
    key = "active/Quiet"
    publish(key, snapshot("Quiet"))
    started = time.monotonic()
    status, data = call("POST", "/api/live-write/" + urllib.request.quote(key, safe=""),
                        {"fields": {"hp.current": 7}, "timeout_seconds": 0.5})
    elapsed = time.monotonic() - started
    check("no poller: 504", status == 504, f"got {status} {data}")
    check("no poller: certainly not applied",
          (data or {}).get("status") == "not-applied"
          and (data or {}).get("reason") == "no-tab-claimed", str(data))
    check("no poller: waited about the requested timeout, not the default",
          0.4 <= elapsed < 3.0, f"{elapsed:.2f}s")


def test_a_timed_out_writer_withdraws_its_command():
    """Half of the late-application guard: the writer cleans up after itself."""
    key = "active/Expired"
    publish(key, snapshot("Expired"))
    call("POST", "/api/live-write/" + urllib.request.quote(key, safe=""),
         {"fields": {"hp.current": 1}, "timeout_seconds": 0.3})
    status, data = call("GET",
                        "/api/live-commands/" + urllib.request.quote(key, safe="") + "?wait=1")
    check("withdrawal: a late poller is handed nothing",
          status == 200 and (data or {}).get("commands") == [], f"{status} {data}")
    with ss._LIVE_CMD_COND:
        left = ss._LIVE_CMDS.get(key) or []
    check("withdrawal: the abandoned command is gone from the queue", not left, str(left))


def test_an_expired_command_is_never_dispatched():
    """THE negative control on late application, isolated from withdrawal.

    The test above passes even with the dispatch-time deadline check DELETED,
    because the timed-out writer empties the queue on its way out — so it
    proves withdrawal, not expiry. The two are different mechanisms closing
    different windows: withdrawal handles the ordinary timeout, and this check
    handles the race where a poller reaches the dispatch loop in the instant
    between a writer's deadline passing and its withdrawal running. Narrow, but
    it is the window in which a rig that gave up and moved on gets its
    abandoned instruction applied to a live character anyway.

    So inject the command directly, with no writer at all, and prove the poller
    refuses it on the deadline alone.
    """
    key = "active/Lapsed"
    publish(key, snapshot("Lapsed"))
    with ss._LIVE_CMD_COND:
        ss._LIVE_CMDS[key] = [{
            "id": "cmd-lapsed", "fields": {"hp.current": 1},
            "source": "test", "reason": "deadline already passed",
            "expires_at": time.monotonic() - 5.0,
            "dispatched_at": None, "result": None,
        }]
    status, data = call("GET",
                        "/api/live-commands/" + urllib.request.quote(key, safe="") + "?wait=0")
    check("expiry: a command past its deadline is not dispatched",
          status == 200 and (data or {}).get("commands") == [], f"{status} {data}")
    with ss._LIVE_CMD_COND:
        cmd = (ss._LIVE_CMDS.get(key) or [{}])[0]
        still_undispatched = cmd.get("dispatched_at") is None
        ss._LIVE_CMDS.pop(key, None)
    check("expiry: it is left undispatched, not merely hidden", still_undispatched)


def test_a_claimed_but_unacked_write_is_reported_unknown():
    """The third bucket, exercised — it must not be quietly folded into one of
    the certain two. A tab that takes a command and then dies (reload, crash,
    navigation) may or may not have applied it, and the only honest answer is
    to say we cannot tell."""
    key = "active/Silent"
    publish(key, snapshot("Silent"))
    quoted = urllib.request.quote(key, safe="")

    def greedy_tab():
        call("GET", f"/api/live-commands/{quoted}?wait=10", timeout=30)   # claims, never acks

    t = threading.Thread(target=greedy_tab, daemon=True)
    t.start()
    time.sleep(0.2)
    status, data = call("POST", "/api/live-write/" + quoted,
                        {"fields": {"hp.current": 3}, "timeout_seconds": 1.0})
    check("unknown: 504", status == 504, f"got {status} {data}")
    check("unknown: reported as unknown, not as applied or not-applied",
          (data or {}).get("status") == "unknown"
          and (data or {}).get("reason") == "claimed-but-no-ack", str(data))
    t.join(timeout=5)


def test_two_writes_do_not_cross():
    """Concurrent writes to two characters each return their own result."""
    keys = ["active/Kell", "active/Kass"]
    tabs = []
    for k in keys:
        publish(k, snapshot(k.split("/")[-1]))
        t = FakeTab(k)
        t.start()
        tabs.append(t)
    time.sleep(0.2)
    out = {}

    def writer(k, hp):
        out[k] = call("POST", "/api/live-write/" + urllib.request.quote(k, safe=""),
                      {"fields": {"hp.current": hp}})

    threads = [threading.Thread(target=writer, args=(k, 10 + i))
               for i, k in enumerate(keys)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    for i, k in enumerate(keys):
        status, data = out.get(k, (None, None))
        check(f"concurrent: {k} got its own snapshot back",
              status == 200
              and data["snapshot"]["identity"]["name"] == k.split("/")[-1]
              and data["snapshot"]["hp"]["current"] == 10 + i,
              str(data))
    for t in tabs:
        t.join(timeout=5)


def test_poll_returns_empty_rather_than_hanging_forever():
    key = "active/Idle"
    publish(key, snapshot("Idle"))
    started = time.monotonic()
    status, data = call("GET",
                        "/api/live-commands/" + urllib.request.quote(key, safe="") + "?wait=1")
    elapsed = time.monotonic() - started
    check("poll: parks then returns an empty list",
          status == 200 and (data or {}).get("commands") == [], f"{status} {data}")
    check("poll: honours the requested wait", 0.9 <= elapsed < 5.0, f"{elapsed:.2f}s")


def test_qualified_names_with_slashes_survive_routing():
    """The folder-qualified name is why the phase-2 verbs are sibling
    namespaces rather than a trailing path segment. If routing ever moves the
    verb after the name, this is what breaks."""
    key = "library/Deep/Anapa"
    publish(key, snapshot("Anapa"))
    status, data = call("GET", "/api/live-commands/" + urllib.request.quote(key, safe="") + "?wait=0")
    check("routing: a nested qualified name round-trips through the poll",
          status == 200 and (data or {}).get("qualified") == key, f"{status} {data}")



# ---------------------------------------------------------------------------
# CLAIM / RELEASE (2026-08-21)
#
# Staleness catches a tab that DIED. It cannot catch one that deliberately
# moved on: swap a tab from Kell to Gorrash and Kell's snapshot sits on the
# server looking perfectly fresh for another 90 seconds, and anything reading
# it narrates numbers for a character nobody has open. Only the tab knows it
# swapped, so it says so — and the server has to believe the right tab.
# ---------------------------------------------------------------------------

def test_a_tab_releasing_its_claim_makes_the_character_absent():
    snap = snapshot("Swapper")
    snap["publisher"] = "tab-A"
    st, _ = call("PUT", "/api/live/active%2FSwapper", snap)
    check("release: publish accepted", st == 204, st)
    st, view = call("GET", "/api/live/active%2FSwapper")
    check("release: readable before release", st == 200, st)
    check("release: names its publisher",
          view.get("publisher") == "tab-A", view.get("publisher"))
    check("release: a single publisher is not contested",
          view.get("contested") is False, view.get("contested"))

    st, body = call("DELETE", "/api/live/active%2FSwapper",
                    {"publisher": "tab-A"})
    check("release: accepted", st == 200, (st, body))
    check("release: reports nobody left",
          body.get("still_published_by") == 0, body)

    # 404, not a stale-looking snapshot. "Nobody has this open" and "here are
    # some numbers" must never look the same — the same contract a never-opened
    # character gets.
    st, body = call("GET", "/api/live/active%2FSwapper")
    check("release: reads as ABSENT afterwards, not stale", st == 404, (st, body))


def test_a_release_from_the_wrong_tab_is_refused():
    # Otherwise a second tab could evict the first one's live snapshot simply by
    # navigating away from a character it also had open.
    a = snapshot("Contested"); a["publisher"] = "tab-A"
    b = snapshot("Contested"); b["publisher"] = "tab-B"
    call("PUT", "/api/live/active%2FContested", a)
    call("PUT", "/api/live/active%2FContested", b)

    st, view = call("GET", "/api/live/active%2FContested")
    check("contested: both publishers listed",
          sorted(view.get("publishers") or []) == ["tab-A", "tab-B"],
          view.get("publishers"))
    check("contested: flagged", view.get("contested") is True, view)

    # tab-A is no longer the holder (tab-B published last) and tab-B is still
    # live, so tab-A's release must not drop the key.
    st, body = call("DELETE", "/api/live/active%2FContested",
                    {"publisher": "tab-A"})
    check("contested: a non-holder release is refused", st == 409, (st, body))
    st, view = call("GET", "/api/live/active%2FContested")
    check("contested: the snapshot survives the refused release",
          st == 200, st)

    # The HOLDER may release, and the survivor keeps it open.
    st, body = call("DELETE", "/api/live/active%2FContested",
                    {"publisher": "tab-B"})
    check("contested: the holder may release", st == 200, (st, body))
    check("contested: reports the survivor",
          body.get("still_published_by") == 1, body)
    st, view = call("GET", "/api/live/active%2FContested")
    check("contested: still published by the other tab", st == 200, st)
    check("contested: no longer contested",
          view.get("contested") is False, view)


def test_release_also_works_over_the_beacon_post_route():
    # navigator.sendBeacon can only POST, and it is the only request that
    # reliably survives a page unload — which is precisely when a tab most
    # needs to release. Same handler, different verb.
    snap = snapshot("Unloader"); snap["publisher"] = "tab-Z"
    call("PUT", "/api/live/active%2FUnloader", snap)
    st, body = call("POST", "/api/live-release/active%2FUnloader",
                    {"publisher": "tab-Z"})
    check("beacon release: accepted", st == 200, (st, body))
    st, _ = call("GET", "/api/live/active%2FUnloader")
    check("beacon release: character is absent", st == 404, st)


def test_releasing_something_nobody_published_is_a_404():
    st, body = call("DELETE", "/api/live/active%2FNeverWasHere",
                    {"publisher": "tab-A"})
    check("release: unknown key is 404, not a silent success",
          st == 404, (st, body))


# ---- consumer long-poll (/api/live-wait, 2026-08-22) ----------------------
#
# The mirror of the command channel: live-commands is how a TAB waits for work,
# live-wait is how a READER waits for news. The properties worth pinning are
# the three OUTCOMES staying distinct — something changed, nothing changed, and
# you fell too far behind — because collapsing the third into the second is the
# silent-data-loss failure the sequence number exists to prevent.

def test_live_wait_without_a_baseline_asks_for_a_resync():
    status, body = call("GET", "/api/live-wait?wait=0")
    check("live-wait: no `since` returns immediately", status == 200,
          f"got {status}")
    check("live-wait: ...and says RESYNC rather than 'nothing changed'",
          body and body.get("resync") is True and body.get("changed") == [],
          f"got {body}")
    check("live-wait: ...handing back a sequence to tail from",
          body and isinstance(body.get("seq"), int), f"got {body}")


def test_live_wait_returns_immediately_when_already_behind():
    _, before = call("GET", "/api/live-wait?wait=0")
    seq = before["seq"]
    publish("active/Waiter", snapshot("Waiter"))
    status, body = call("GET", f"/api/live-wait?since={seq}&wait=0")
    check("live-wait: a publish moves the sequence", body["seq"] > seq,
          f"{seq} -> {body}")
    check("live-wait: ...and names what changed",
          body["changed"] == [{"qualified": "active/Waiter", "event": "publish"}],
          f"got {body['changed']}")
    check("live-wait: ...without asking for a resync", body["resync"] is False,
          f"got {body}")


def test_live_wait_parks_and_is_woken_by_a_publish():
    _, before = call("GET", "/api/live-wait?wait=0")
    seq = before["seq"]
    out = {}

    def reader():
        out["t0"] = time.monotonic()
        out["status"], out["body"] = call("GET", f"/api/live-wait?since={seq}&wait=10")
        out["elapsed"] = time.monotonic() - out["t0"]

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    time.sleep(0.4)                      # let it actually park
    check("live-wait: the reader is still parked, not spinning", t.is_alive())
    publish("active/Woken", snapshot("Woken"))
    t.join(timeout=10)
    check("live-wait: a publish WAKES the parked reader", not t.is_alive())
    check("live-wait: ...promptly, rather than at the timeout",
          out.get("elapsed", 99) < 5, f"took {out.get('elapsed')}s")
    check("live-wait: ...with the event that woke it",
          any(e["qualified"] == "active/Woken" and e["event"] == "publish"
              for e in out["body"]["changed"]), f"got {out.get('body')}")


def test_live_wait_reports_a_release_so_a_panel_can_go_offline():
    publish("active/Leaver", snapshot("Leaver"))
    _, before = call("GET", "/api/live-wait?wait=0")
    seq = before["seq"]
    call("DELETE", "/api/live/" + urllib.request.quote("active/Leaver", safe=""))
    _, body = call("GET", f"/api/live-wait?since={seq}&wait=0")
    check("live-wait: a tab going away is REPORTED, not just a missing read",
          body["changed"] == [{"qualified": "active/Leaver", "event": "release"}],
          f"got {body['changed']}")


def test_live_wait_timing_out_is_not_a_resync():
    _, before = call("GET", "/api/live-wait?wait=0")
    seq = before["seq"]
    status, body = call("GET", f"/api/live-wait?since={seq}&wait=1")
    check("live-wait: an idle window returns empty", body["changed"] == [],
          f"got {body}")
    check("live-wait: ...and NOT resync — nothing happened is not data loss",
          body["resync"] is False, f"got {body}")


def test_live_wait_falling_off_the_log_demands_a_resync():
    """THE GUARD THIS ENDPOINT NEEDS MOST.

    A bounded event log means a reader that blips for long enough cannot be
    told what it missed. It must be told THAT it missed, or it treats a
    truncated list as the whole story — the exact gap the sequence number is
    supposed to close. Overflows the log rather than mocking it.
    """
    for i in range(ss.LIVE_EVENT_LOG_MAX + 20):
        publish("active/Flood%d" % (i % 5), snapshot("Flood%d" % (i % 5)))
    _, now = call("GET", "/api/live-wait?wait=0")
    status, body = call("GET", "/api/live-wait?since=1&wait=0")
    check("live-wait: a reader far behind the log gets RESYNC",
          body["resync"] is True, f"got resync={body.get('resync')}")
    check("live-wait: ...and the current sequence to restart from",
          body["seq"] == now["seq"], f"got {body['seq']} vs {now['seq']}")
    # And the negative control: a reader INSIDE the log is not told to resync.
    _, fresh = call("GET", "/api/live-wait?wait=0")
    publish("active/Flood0", snapshot("Flood0"))
    _, body2 = call("GET", f"/api/live-wait?since={fresh['seq']}&wait=0")
    check("live-wait: ...but a reader still inside the log is NOT",
          body2["resync"] is False and body2["changed"], f"got {body2}")


def test_live_wait_rejects_a_nonsense_since():
    status, body = call("GET", "/api/live-wait?since=banana&wait=0")
    check("live-wait: a non-numeric `since` is a 400, not a silent 0",
          status == 400, f"got {status} {body}")


def test_live_wait_filters_by_qualified():
    publish("active/Mine", snapshot("Mine"))
    _, before = call("GET", "/api/live-wait?wait=0")
    seq = before["seq"]
    publish("active/Theirs", snapshot("Theirs"))
    status, body = call(
        "GET", f"/api/live-wait?since={seq}&qualified=active%2FMine&wait=1")
    check("live-wait: a filtered reader ignores another character's publish",
          body["changed"] == [], f"got {body['changed']}")
    publish("active/Mine", snapshot("Mine"))
    _, body2 = call(
        "GET", f"/api/live-wait?since={seq}&qualified=active%2FMine&wait=0")
    check("live-wait: ...and does see its own",
          any(e["qualified"] == "active/Mine" for e in body2["changed"]),
          f"got {body2['changed']}")


def main():
    global BASE
    server = ss.CharacterSheetServer(("127.0.0.1", 0), ss.CharacterSheetHandler)
    BASE = "http://127.0.0.1:%d" % server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        for fn in [test_writable_is_introspectable,
                   test_write_without_a_tab_is_refused,
                   test_write_to_a_stale_tab_is_refused,
                   test_structural_fields_are_refused_with_a_reason,
                   test_an_unrecognised_field_is_refused_by_default,
                   test_type_errors_come_back_to_the_writer,
                   test_round_trip_returns_the_post_write_snapshot,
                   test_partial_write_when_the_tab_refuses_a_field,
                   test_no_tab_claimed_is_certain_not_unknown,
                   test_a_timed_out_writer_withdraws_its_command,
                   test_an_expired_command_is_never_dispatched,
                   test_a_claimed_but_unacked_write_is_reported_unknown,
                   test_two_writes_do_not_cross,
                   test_poll_returns_empty_rather_than_hanging_forever,
                   test_qualified_names_with_slashes_survive_routing,
                   test_a_tab_releasing_its_claim_makes_the_character_absent,
                   test_a_release_from_the_wrong_tab_is_refused,
                   test_release_also_works_over_the_beacon_post_route,
                   test_releasing_something_nobody_published_is_a_404,
                   test_live_wait_without_a_baseline_asks_for_a_resync,
                   test_live_wait_returns_immediately_when_already_behind,
                   test_live_wait_parks_and_is_woken_by_a_publish,
                   test_live_wait_reports_a_release_so_a_panel_can_go_offline,
                   test_live_wait_timing_out_is_not_a_resync,
                   test_live_wait_rejects_a_nonsense_since,
                   test_live_wait_filters_by_qualified,
                   test_live_wait_falling_off_the_log_demands_a_resync]:
            fn()
    finally:
        server.shutdown()
        server.server_close()
    total = _passed + _failed
    print(f"\n{_passed} passed, {_failed} failed ({total} total)")
    raise SystemExit(1 if _failed else 0)


if __name__ == "__main__":
    main()
