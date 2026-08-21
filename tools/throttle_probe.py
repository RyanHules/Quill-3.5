"""Measure whether Firefox throttles the live-bus heartbeat in background tabs.

Read-only: it polls the SERVER's /api/live index, never touches the tabs. The
publisher's own heartbeat is 20s and the change-watcher is 1.5s, so the age of
the newest publish per character is a direct read on whether that tab's timers
are still firing on schedule.

What the numbers mean:
    max age <~25s     the 20s heartbeat is firing normally — no throttling
    max age ~60s+     timers clamped to about 1/minute (Chrome's intensive mode)
    max age >90s      the tab has crossed the stale window and reads as ABSENT

Chrome's intensive throttling starts ~5 minutes after a tab is hidden, so the
window has to be longer than that to mean anything.
"""
import json
import sys
import time
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
MINUTES = float(sys.argv[2]) if len(sys.argv) > 2 else 11.0
EVERY = 15.0

seen = {}
start = time.monotonic()
samples = 0
print("probing %s for %.0f min, sampling every %.0fs" % (BASE, MINUTES, EVERY))
print("(publisher heartbeat is 20s; stale window is 90s)")
sys.stdout.flush()

while time.monotonic() - start < MINUTES * 60:
    try:
        with urllib.request.urlopen(BASE + "/api/live", timeout=8) as r:
            d = json.loads(r.read())
    except Exception as e:                       # server restarted, tab closed
        print("  [%5.1f min] poll failed: %s" % ((time.monotonic()-start)/60, e))
        sys.stdout.flush()
        time.sleep(EVERY)
        continue
    samples += 1
    for it in (d.get("live") or d.get("items") or []):
        q = it.get("qualified")
        age = it.get("age_seconds")
        if age is None:
            continue
        rec = seen.setdefault(q, {"max": 0.0, "n": 0, "stale_hits": 0})
        rec["max"] = max(rec["max"], age)
        rec["n"] += 1
        if it.get("stale"):
            rec["stale_hits"] += 1
    if samples % 8 == 1:
        mins = (time.monotonic() - start) / 60
        worst = max((v["max"] for v in seen.values()), default=0)
        print("  [%5.1f min] %d chars, worst age so far %.1fs" % (mins, len(seen), worst))
        sys.stdout.flush()
    time.sleep(EVERY)

print()
print("RESULT after %.1f min, %d samples" % ((time.monotonic()-start)/60, samples))
verdict_ok = True
for q, v in sorted(seen.items()):
    flag = ""
    if v["max"] > 90:
        flag = "  <-- CROSSED THE STALE WINDOW"
        verdict_ok = False
    elif v["max"] > 30:
        flag = "  <-- throttled (heartbeat is 20s)"
        verdict_ok = False
    print("  %-30s max age %6.1fs   seen %3d   stale %d%s"
          % (q, v["max"], v["n"], v["stale_hits"], flag))
print()
print("VERDICT:", "no throttling — every heartbeat landed inside the window"
      if verdict_ok else "THROTTLING OBSERVED — see the flagged rows above")
