@echo off
REM Double-click this file to launch the D&D 3.5 Character Sheet.
REM
REM We have to serve the page over HTTP rather than open index.html
REM directly: Firefox and Chrome both refuse to fetch the 30 MB SQLite
REM blob via file:// URLs, which is what backs every picker (race,
REM class, feat, etc.). Opening from file:// = no database = manual-
REM entry mode only.
REM
REM Runs save_server.py, which is the static-file server (same as
REM `python -m http.server`) PLUS a /api/saves endpoint that persists
REM characters as JSON files in ~/.dnd-sheet/saves/. Origin-agnostic:
REM saves survive launching on a different port, switching browsers,
REM and (if you point the save dir at a synced folder) cross-device.
REM
REM Requires Python 3 on PATH (which you already have if you've run
REM the database project's tests).

setlocal
cd /d "%~dp0"

REM Pick the first free port from a small range so re-launching while
REM the previous instance is still running doesn't error out. Saves
REM are no longer port-tied (they live on disk now), so the port
REM doesn't have to be sticky.
for %%P in (3000 3001 3002 3003 3004 3005) do (
  netstat -an | findstr ":%%P " | findstr "LISTENING" >nul 2>&1
  if errorlevel 1 (
    set "PORT=%%P"
    goto :found
  )
)
echo No free port found in 3000-3005. Close other servers and retry.
pause
exit /b 1

:found
echo Starting D^&D 3.5 Character Sheet at http://localhost:%PORT%/
echo (Leave this window open. Close it to stop the server.)
echo.

REM Open the page in the default browser after a 1-sec delay so the
REM server has time to bind the socket.
start cmd /c "timeout /t 1 /nobreak >nul && start http://localhost:%PORT%/"

python save_server.py %PORT%
