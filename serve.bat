@echo off
REM Double-click this file to launch the D&D 3.5 Character Sheet.
REM
REM We have to serve the page over HTTP rather than open index.html
REM directly: Firefox and Chrome both refuse to fetch the SQLite blob
REM via file:// URLs, which is what backs every picker (race, class,
REM feat, etc.). Opening from file:// = no database = manual-entry
REM mode only.
REM
REM Runs save_server.py, which is the static-file server (same as
REM `python -m http.server`) PLUS a /api/saves endpoint that persists
REM characters as JSON files in saves/. Origin-agnostic: saves survive
REM launching on a different port or switching browsers.
REM
REM REQUIRES Python 3.9 or newer, standard library only. No pip packages
REM and no Node. 3.9 is measured: the server suites pass on it, and
REM save_server.py uses Path.is_relative_to, which is new in 3.9.
REM
REM EVERY FAILURE HERE STOPS AND WAITS (:wait_and_fail). This file used to
REM end at the python line with no pause, so a missing Python, the Microsoft
REM Store stub and an unbindable port all looked identical from outside: the
REM window vanished in under half a second and a browser tab opened on "can't
REM connect". A launcher's error message is worthless if nobody gets to read
REM it. tests/test_serve_bat.py drives each of these paths.

setlocal
cd /d "%~dp0"

REM Explorer runs a .bat from inside a zip by extracting ONLY that file to a
REM temp folder, so nothing else is next to it. A network path lands here too,
REM because cd cannot enter one.
if not exist "save_server.py" goto :not_extracted

echo Checking for Python...
set "PY="
REM py first: python.org installs it even when "add to PATH" was left unticked,
REM which is exactly when plain `python` resolves to the Store stub.
call :try_python py -3
if not defined PY call :try_python python
if not defined PY call :try_python python3
if not defined PY goto :no_python

REM Walk a small range so re-launching while the previous instance is still
REM running doesn't error out. Saves are not port-tied (they live on disk), so
REM the port doesn't have to be sticky.
set /a PORT=3000

:next_port
if %PORT% GTR 3005 goto :no_port
netstat -an | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if "%ERRORLEVEL%"=="0" goto :port_unavailable

echo Starting D^&D 3.5 Character Sheet on port %PORT%...
echo (Leave this window open. Close it to stop the server.)
echo.

REM The server opens the browser itself, once the port is really bound, so a
REM failed start never opens a dead tab. `call` because python can be a .bat
REM shim (pyenv-win), and running a .bat without call ends this file silently.
REM Port first: an older save_server.py ignores anything after it.
call %PY% save_server.py %PORT% --open-browser
set "RESULT=%ERRORLEVEL%"
if "%RESULT%"=="0" exit /b 0

REM 3 is save_server.py's "could not open this port". netstat cannot see every
REM refusal: Hyper-V, WSL and Docker reserve port ranges that show nothing
REM listening and still fail the bind.
if "%RESULT%"=="3" goto :port_unavailable
goto :server_died

:port_unavailable
set /a PORT+=1
goto :next_port

REM ---- Failures. No parentheses blocks below: an echo with a ")" would end one.

:not_extracted
echo.
echo ================================================================
echo  save_server.py is not next to serve.bat, so the sheet cannot start.
echo.
echo  If you opened this from inside a zip file, extract the whole
echo  folder first (right-click the zip, Extract All), then run
echo  serve.bat from the extracted folder.
echo ================================================================
goto :wait_and_fail

:no_python
echo.
echo ================================================================
echo  Python 3.9 or newer was not found. The character sheet needs it.
echo.
echo    1. Install Python from https://www.python.org/downloads/
echo    2. Double-click serve.bat again.
echo.
echo  If you just installed it and still see this, open a Command
echo  Prompt, run:  py install   and then try again.
echo ================================================================
goto :wait_and_fail

:no_port
echo.
echo ================================================================
echo  None of the ports 3000-3005 could be opened.
echo.
echo  Close any other copies of the sheet and try again. If that does
echo  not help, restart Windows.
echo ================================================================
goto :wait_and_fail

:server_died
echo.
echo ================================================================
echo  The server stopped unexpectedly (exit code %RESULT%).
echo  The lines above say why. A screenshot of this window is the most
echo  useful thing to send to whoever is helping you.
echo ================================================================
goto :wait_and_fail

:wait_and_fail
echo.
echo Press any key to close this window.
pause >nul
exit /b 1

REM ---- Subroutines

REM Sets PY if the command is a real Python, new enough. Output is hidden because
REM the Store stub prints a confusing "run without arguments to install" line and
REM exits 9009. Compared with == because `if not errorlevel 1` also passes on
REM negative codes, which is what a crash (0xC0000005) looks like in cmd. Stdin is
REM closed so a prompt from the install manager cannot hang behind the hidden output.
:try_python
call %* -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1 <nul
if "%ERRORLEVEL%"=="0" set "PY=%*"
exit /b 0
