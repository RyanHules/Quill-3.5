#!/usr/bin/env python
"""test_save_server.py — regression guards for save_server.py's flag store.

Zero-dependency (no pytest) assertion suite, mirroring the Node picker suite's
style — run with `python tests/test_save_server.py`. Its reason for existing is
the R0 fix (2026-07-13): the review-flag / sheet-report store used to lose
entries when several character-sheet tabs were open at once, because each tab
PUT its whole stale array and the server replaced wholesale (last-writer-wins).
The fix routes every mutation through `apply_flag_op`, an atomic add/resolve/
remove applied under a process-wide lock. These tests pin that behavior — most
importantly the concurrency guard, which is the actual thing that regressed.
"""
import importlib.util
import json
import tempfile
import threading
from pathlib import Path

# Import save_server.py from the project root (parent of tests/).
_ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("save_server", _ROOT / "save_server.py")
ss = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ss)

_passed = 0
_failed = 0


def check(name, cond):
    global _passed, _failed
    if cond:
        _passed += 1
    else:
        _failed += 1
        print(f"  FAIL: {name}")


def _tmp(initial=None):
    d = Path(tempfile.mkdtemp())
    p = d / "sheet-reports.json"
    if initial is not None:
        p.write_text(json.dumps(initial), encoding="utf-8")
    return p


def test_add_no_clobber():
    # The R0 scenario in miniature: two "tabs" starting from the same snapshot
    # each file a flag. Both must survive — the old whole-array PUT lost one.
    p = _tmp({"flags": [{"id": "f1", "status": "open"}]})
    ss.apply_flag_op(p, {"op": "add", "flag": {"id": "f2", "status": "open"}})
    ss.apply_flag_op(p, {"op": "add", "flag": {"id": "f3", "status": "open"}})
    ids = [f["id"] for f in json.loads(p.read_text())["flags"]]
    check("add: no clobber, all survive", ids == ["f1", "f2", "f3"])


def test_add_idempotent_on_id():
    p = _tmp({"flags": [{"id": "f1", "status": "open"}]})
    ss.apply_flag_op(p, {"op": "add", "flag": {"id": "f1", "status": "open"}})
    ids = [f["id"] for f in json.loads(p.read_text())["flags"]]
    check("add: idempotent on duplicate id", ids == ["f1"])


def test_resolve():
    p = _tmp({"flags": [{"id": "f1", "status": "open"}]})
    out = ss.apply_flag_op(p, {"op": "resolve", "id": "f1", "resolved": "2026-07-13T00:00:00Z"})
    f = out["flags"][0]
    check("resolve: sets status", f["status"] == "resolved")
    check("resolve: keeps explicit timestamp", f["resolved"] == "2026-07-13T00:00:00Z")


def test_resolve_auto_stamps():
    p = _tmp({"flags": [{"id": "f1", "status": "open"}]})
    out = ss.apply_flag_op(p, {"op": "resolve", "id": "f1"})
    check("resolve: auto-stamps when timestamp omitted", bool(out["flags"][0].get("resolved")))


def test_remove():
    p = _tmp({"flags": [{"id": "f1"}, {"id": "f2"}]})
    ss.apply_flag_op(p, {"op": "remove", "id": "f1"})
    ids = [f["id"] for f in json.loads(p.read_text())["flags"]]
    check("remove: drops by id", ids == ["f2"])


def test_returns_authoritative_state():
    p = _tmp({"flags": [{"id": "f1", "status": "open"}]})
    out = ss.apply_flag_op(p, {"op": "add", "flag": {"id": "f2", "status": "open"}})
    check("returns full state after op", [f["id"] for f in out["flags"]] == ["f1", "f2"])


def test_malformed_ops_raise():
    p = _tmp({"flags": []})
    for bad in [{"op": "add", "flag": {}}, {"op": "add"}, {"op": "resolve"},
                {"op": "remove"}, {"op": "nope"}, {}]:
        try:
            ss.apply_flag_op(p, bad)
            check(f"malformed op rejected: {bad}", False)
        except ValueError:
            check(f"malformed op rejected: {bad}", True)


def test_tolerates_missing_and_malformed_file():
    d = Path(tempfile.mkdtemp())
    missing = d / "sheet-reports.json"
    check("read: missing file -> empty", ss._read_flags(missing) == {"flags": []})
    # add against a missing file creates it
    ss.apply_flag_op(missing, {"op": "add", "flag": {"id": "f1"}})
    check("add: creates missing file", missing.exists())
    # malformed JSON -> treated as empty, not a crash
    bad = d / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    check("read: malformed JSON -> empty", ss._read_flags(bad) == {"flags": []})
    # wrong shape (flags not a list) -> empty
    wrong = d / "wrong.json"
    wrong.write_text(json.dumps({"flags": "nope"}), encoding="utf-8")
    check("read: wrong shape -> empty", ss._read_flags(wrong) == {"flags": []})


def test_concurrency_no_loss():
    # THE R0 guard: 20 threads (tabs) each add 10 flags to one file at once.
    # The lock must serialize the read-modify-write so all 200 survive; without
    # it, the interleaved writes drop most of them.
    p = _tmp({"flags": []})

    def worker(t):
        for i in range(10):
            ss.apply_flag_op(p, {"op": "add", "flag": {"id": f"t{t}-{i}", "status": "open"}})

    threads = [threading.Thread(target=worker, args=(t,)) for t in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    ids = {f["id"] for f in json.loads(p.read_text())["flags"]}
    check("concurrency: 20 tabs x 10 adds -> all 200 survive", len(ids) == 200)


if __name__ == "__main__":
    for fn in [test_add_no_clobber, test_add_idempotent_on_id, test_resolve,
               test_resolve_auto_stamps, test_remove, test_returns_authoritative_state,
               test_malformed_ops_raise, test_tolerates_missing_and_malformed_file,
               test_concurrency_no_loss]:
        fn()
    total = _passed + _failed
    print(f"\n{_passed} passed, {_failed} failed ({total} total)")
    raise SystemExit(1 if _failed else 0)
