#!/usr/bin/env python
"""test_serve_bat.py — every way serve.bat can fail must stop and say so.

Zero-dependency (no pytest) assertion suite — run with
`python tests/test_serve_bat.py [--bat PATH]`. Windows only; it skips elsewhere.

Its reason for existing (2026-10-31): a friend's server "crashed immediately."
serve.bat ended at the python line with no pause, and a missing Python, the
Microsoft Store stub and an unbindable port all looked the same from outside:
the window vanished in under half a second and a browser tab opened on "can't
connect". The message that would have explained it was on screen for 0.1s.

Each case runs the real bat, byte for byte, in a throwaway folder under a PATH
shaped like someone else's machine, launched the way Explorer launches it. It
never touches the real tree's saves or data. No real browser opens: webbrowser
honours BROWSER, so a stub logs the URL instead, which also proves what the bat
could not: exactly one tab, on the port that actually bound, and none on failure.

--bat runs the suite against a different file. Pointing it at the pre-2026-10-31
bat is the negative control: the failure cases must go red.
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BAT = ROOT / "serve.bat"
if "--bat" in sys.argv:
    BAT = Path(sys.argv[sys.argv.index("--bat") + 1]).resolve()

WINDIR = os.environ.get("SystemRoot", r"C:\Windows")
SYS32 = os.path.join(WINDIR, "System32")
PY_DIR = str(Path(sys.executable).parent)
STORE_ALIAS_DIR = os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WindowsApps")
PORTS = range(3000, 3006)

_passed = 0
_failed = 0


def check(name, cond, detail=""):
    global _passed, _failed
    if cond:
        _passed += 1
    else:
        _failed += 1
        print(f"  FAIL: {name}" + (f"\n        {detail}" if detail else ""))


class Sheet:
    """A throwaway sheet folder, with a stub browser beside it."""

    def __init__(self, folder_name="sheet", server=True):
        self.tmp = Path(tempfile.mkdtemp(prefix="serve_bat_"))
        self.folder = self.tmp / folder_name
        self.folder.mkdir()
        shutil.copyfile(BAT, self.folder / "serve.bat")
        if server:
            shutil.copyfile(ROOT / "save_server.py", self.folder / "save_server.py")
            (self.folder / "index.html").write_text("<!doctype html>", encoding="utf-8")
        self.browser_log = self.tmp / "browser.log"
        self.browser_stub = self.tmp / "fake_browser.bat"
        self.browser_stub.write_bytes(b'@echo %~1>> "%~dp0browser.log"\r\n')

    def add_database(self):
        (self.folder / "data").mkdir()
        (self.folder / "data" / "dnd35.db").write_bytes(b"SQLite format 3\x00" + b"\x00" * 84)

    def bin_dir(self, **scripts):
        """A folder of .bat stand-ins for commands, for a PATH to point at."""
        d = self.tmp / "bin"
        d.mkdir(exist_ok=True)
        for name, body in scripts.items():
            (d / f"{name}.bat").write_bytes(body.encode("ascii") + b"\r\n")
        return str(d)

    def tabs_opened(self):
        if not self.browser_log.exists():
            return []
        return self.browser_log.read_text().split()

    def launch(self, path):
        return Run(self, path)

    def clean(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class Run:
    """serve.bat running, launched the way a double-click launches it."""

    def __init__(self, sheet, path):
        self.sheet = sheet
        self._raw = []
        env = dict(os.environ, PATH=path, BROWSER=str(sheet.browser_stub))
        self.proc = subprocess.Popen(
            f'cmd /d /s /c ""{sheet.folder / "serve.bat"}""',
            cwd=sheet.folder, env=env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self._reader = threading.Thread(target=self._drain, daemon=True)
        self._reader.start()

    def _drain(self):
        for raw in self.proc.stdout:
            self._raw.append(raw)

    def text(self):
        return b"".join(self._raw).decode("utf-8", "replace")

    def waits_at_the_message(self, message, timeout=25):
        """The message appears AND the window is still there to read it.

        An exited process with the message in its output is the old bug, so this
        requires the process to still be alive a moment after the text arrives.
        """
        deadline = time.time() + timeout
        while time.time() < deadline and message not in self.text():
            if self.proc.poll() is not None:
                break
            time.sleep(0.05)
        time.sleep(0.75)
        return message in self.text() and self.proc.poll() is None

    def press_key(self):
        self.proc.stdin.write(b"\r\n")
        self.proc.stdin.flush()
        return self.proc.wait(timeout=10)

    def serving_port(self, timeout=25):
        """The port serving THIS folder. 3000 may be someone's real sheet, so ask."""
        deadline = time.time() + timeout
        want = self.sheet.folder.resolve()
        while time.time() < deadline:
            if self.proc.poll() is not None:
                return None
            m = re.search(r"Listening:\s+http://127\.0\.0\.1:(\d+)/", self.text())
            if m:
                port = int(m.group(1))
                try:
                    url = f"http://127.0.0.1:{port}/api/health"
                    with urllib.request.urlopen(url, timeout=3) as r:
                        if Path(json.load(r)["save_dir"]).resolve().parent == want:
                            return port
                except OSError:
                    pass
            time.sleep(0.1)
        return None

    def stop(self):
        if self.proc.poll() is None:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(self.proc.pid)],
                           capture_output=True)
        self.proc.wait(timeout=15)
        self._reader.join(timeout=5)


def free_ports():
    out = subprocess.run("netstat -an", shell=True, capture_output=True, text=True).stdout
    return [p for p in PORTS if not re.search(rf":{p} .*LISTENING", out)]


def hold(port):
    """Make a port refuse binds while netstat shows nothing listening on it.

    Same error (WinError 10013) as a port inside a Hyper-V / WSL reserved range,
    which is the real-world case and can't be created without admin rights.
    """
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    s.bind(("127.0.0.1", port))
    return s


def expect_stops(label, sheet, path, message, kept_out=()):
    run = sheet.launch(path)
    try:
        waited = run.waits_at_the_message(message)
        check(f"{label}: says why and waits for a keypress", waited, repr(run.text()[-300:]))
        for text in kept_out:
            check(f"{label}: output has no {text!r}", text not in run.text(), repr(run.text()[-300:]))
        check(f"{label}: no browser tab opened", sheet.tabs_opened() == [], str(sheet.tabs_opened()))
        if waited:
            check(f"{label}: closes on a keypress, exit 1", run.press_key() == 1)
    finally:
        run.stop()
        sheet.clean()


def expect_serves(label, sheet, path, want_in_output=(), kept_out=("Traceback",), port_not=None):
    run = sheet.launch(path)
    try:
        port = run.serving_port()
        check(f"{label}: server comes up", port is not None, repr(run.text()[-300:]))
        if port is None:
            return None
        deadline = time.time() + 15
        while time.time() < deadline and not sheet.tabs_opened():
            time.sleep(0.1)
        check(f"{label}: exactly one tab, on the port that bound",
              sheet.tabs_opened() == [f"http://localhost:{port}/"], str(sheet.tabs_opened()))
        if port_not is not None:
            check(f"{label}: skipped the refused port", port != port_not, f"served on {port}")
        for text in want_in_output:
            check(f"{label}: output has {text!r}", text in run.text(), repr(run.text()[-300:]))
        for text in kept_out:
            check(f"{label}: output has no {text!r}", text not in run.text(), repr(run.text()[-300:]))
        return port
    finally:
        run.stop()
        sheet.clean()


def test_no_python():
    expect_stops("no Python at all", Sheet(), SYS32, "Python 3.9 or newer was not found")


def test_store_stub():
    if not (Path(STORE_ALIAS_DIR) / "python.exe").exists():
        print("  (skipped: no Store alias on this machine)")
        return
    # The alias is the Store stub only when no Store Python is installed. If it's
    # real on some machine this case can't be run there, and says so rather than
    # reporting a pass it did not earn.
    probe = subprocess.run([str(Path(STORE_ALIAS_DIR) / "python.exe"), "--version"],
                           capture_output=True)
    if probe.returncode == 0:
        print("  (skipped: this machine's Store alias is a real Python)")
        return
    expect_stops("fresh Windows, Store stub only", Sheet(), SYS32 + ";" + STORE_ALIAS_DIR,
                 "Python 3.9 or newer was not found", kept_out=("Microsoft Store",))


def test_too_old_python():
    sheet = Sheet()
    expect_stops("Python older than 3.9", sheet,
                 SYS32 + ";" + sheet.bin_dir(python="@exit /b 1"),
                 "Python 3.9 or newer was not found")


def test_crashing_python():
    # A crash is a NEGATIVE errorlevel in cmd, and `if not errorlevel 1` passes it.
    sheet = Sheet()
    expect_stops("python that crashes (negative exit code)", sheet,
                 SYS32 + ";" + sheet.bin_dir(python="@exit /b -1073741819"),
                 "Python 3.9 or newer was not found")


def test_python_on_path():
    expect_serves("python on PATH, no DB", Sheet(), SYS32 + ";" + PY_DIR,
                  want_in_output=("dnd35.db is missing", "pickers"))


def test_database_present():
    sheet = Sheet()
    sheet.add_database()
    expect_serves("python on PATH, DB present", sheet, SYS32 + ";" + PY_DIR,
                  kept_out=("Traceback", "WARNING"))


def test_py_launcher_only():
    # A python.org install with "add to PATH" left unticked. The old bat crashed here.
    if not (Path(WINDIR) / "py.exe").exists():
        print("  (skipped: no py launcher in the Windows folder)")
        return
    expect_serves("py launcher only, python not on PATH", Sheet(), SYS32 + ";" + WINDIR)


def test_python_is_a_bat_shim():
    # pyenv-win's shape. Without `call`, running it would silently end serve.bat.
    sheet = Sheet()
    shim = sheet.bin_dir(python=f'@"{sys.executable}" %*')
    expect_serves("python is a .bat shim", sheet, SYS32 + ";" + shim)


def test_refused_port_moves_on():
    free = free_ports()
    if len(free) < 2:
        print("  (skipped: needs two free ports in 3000-3005)")
        return
    held = hold(free[0])
    try:
        expect_serves("first port refused", Sheet(), SYS32 + ";" + PY_DIR,
                      want_in_output=("Could not open port",), port_not=free[0])
    finally:
        held.close()


def test_every_port_refused():
    held = [hold(p) for p in free_ports()]
    try:
        expect_stops("every port refused", Sheet(), SYS32 + ";" + PY_DIR,
                     "None of the ports", kept_out=("Traceback",))
    finally:
        for s in held:
            s.close()


def test_bat_alone():
    # What Explorer does when you double-click a .bat inside a zip.
    expect_stops("serve.bat with nothing beside it", Sheet(server=False),
                 SYS32 + ";" + PY_DIR, "extract the whole")


def test_awkward_folder_names():
    # Ryan's own folder is "D&D 3.5 Character Sheet". The ampersand splits an
    # unquoted command line, with or without spaces beside it.
    for name in ("D&D 3.5 Character Sheet", "D&D", "Bob's (new) sheet"):
        expect_serves(f"folder named {name!r}", Sheet(name), SYS32 + ";" + PY_DIR)


def test_line_endings_are_pinned():
    # Guard the guard: GitHub's zip hands out LF unless .gitattributes says otherwise.
    attrs = (ROOT / ".gitattributes").read_text(encoding="utf-8")
    check(".gitattributes pins *.bat to CRLF", "*.bat text eol=crlf" in attrs)
    raw = BAT.read_bytes()
    check("serve.bat is CRLF throughout", raw.count(b"\n") == raw.count(b"\r\n"))


if __name__ == "__main__":
    if sys.platform != "win32":
        print("skipped: serve.bat is Windows only")
        raise SystemExit(0)
    for fn in [test_no_python, test_store_stub, test_too_old_python, test_crashing_python,
               test_python_on_path, test_database_present, test_py_launcher_only,
               test_python_is_a_bat_shim, test_refused_port_moves_on, test_every_port_refused,
               test_bat_alone, test_awkward_folder_names, test_line_endings_are_pinned]:
        fn()
    total = _passed + _failed
    print(f"\n{_passed} passed, {_failed} failed ({total} total)")
    raise SystemExit(1 if _failed else 0)
