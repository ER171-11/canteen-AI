@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "ROOT=%~dp0"
set "BFF_PORT=8787"
set "WEB_PORT=5173"
set "WEB_URL=http://localhost:%WEB_PORT%/"
set "BFF_WAIT=40"

echo ==============================================
echo   canteenAI  -  local launcher (REAL DATABASE)
echo   (BFF + admin-web, for local testing only)
echo ==============================================
echo.
echo   [!] REAL DATABASE mode: writes go to
echo       store-inventory\data\餐厅系统.db
echo       For any testing, use 启动演练.cmd instead
echo       (sandbox DB, real data untouched).
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo         Install Node.js, then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "%ROOT%apps\admin-web\node_modules\vite\bin\vite.js" (
  echo [ERROR] admin-web dependencies are missing.
  echo         Run this once:  cd /d "%ROOT%apps\admin-web"  then  npm install
  echo.
  pause
  exit /b 1
)

rem The BFF must be *serving*, not merely "a window was opened": a port that
rem answers nothing shows up in the UI as "BFF offline" plus empty pages,
rem which is easily mistaken for "no data in this store".
call :port_busy %BFF_PORT%
if "%BUSY%"=="1" goto bff_reuse

echo [1/3] Starting BFF on port %BFF_PORT% ...
start "canteenAI BFF" /min /d "%ROOT%bff" cmd /k node server.js
call :bff_wait
if "%BUSY%"=="0" goto bff_dead
call :bff_health
if not "%HEALTHY%"=="1" goto bff_dead
goto bff_ok

:bff_reuse
call :bff_health
if "%HEALTHY%"=="1" (
  echo [1/3] BFF is already running on port %BFF_PORT%.
  goto bff_ok
)
echo.
echo [ERROR] Port %BFF_PORT% is occupied, but GET /api/health does not answer.
echo         Another program holds the port, or a previous BFF window is stuck.
echo         Close it (or run the drill stop script), then run this file again.
echo.
pause
exit /b 1

:bff_dead
echo.
echo [ERROR] The BFF is not serving on port %BFF_PORT% (no /api/health reply).
echo         Restore the "canteenAI BFF" window and read the error above it.
echo         Until it is fixed every page shows "BFF offline" and empty tables.
echo.
pause
exit /b 1

:bff_ok

call :port_busy %WEB_PORT%
if "%BUSY%"=="1" (
  echo [2/3] Web dev server is already running on port %WEB_PORT%.
) else (
  echo [2/3] Starting web dev server on port %WEB_PORT% ...
  start "canteenAI Web" /min /d "%ROOT%apps\admin-web" cmd /k node node_modules\vite\bin\vite.js --port %WEB_PORT% --strictPort
)

echo [3/3] Waiting for %WEB_URL% ...
set /a tries=0
:wait
set /a tries+=1
call :port_busy %WEB_PORT%
if "%BUSY%"=="1" goto ready
if %tries% GEQ 60 goto failed
ping -n 2 127.0.0.1 >nul 2>nul
goto wait

:ready
start "" "%WEB_URL%"
echo.
echo ==============================================
echo   Ready - browser opened
echo ----------------------------------------------
echo   Web page : %WEB_URL%
echo   Backend  : http://localhost:%BFF_PORT%
echo.
echo   Login    : boss / wufu123
echo.
echo   To stop  : close the two minimized windows
echo              "canteenAI BFF" and "canteenAI Web"
echo ==============================================
echo.
pause
exit /b 0

:failed
echo.
echo [ERROR] The web dev server did not come up within 60 seconds.
echo         Restore the "canteenAI Web" window and read the error above it.
echo.
pause
exit /b 1

rem ---- bff_wait: wait up to %BFF_WAIT% seconds for the BFF port to listen ----
:bff_wait
set /a bff_tries=0
:bff_wait_loop
set /a bff_tries+=1
call :port_busy %BFF_PORT%
if "%BUSY%"=="1" exit /b 0
if %bff_tries% GEQ %BFF_WAIT% exit /b 0
ping -n 2 127.0.0.1 >nul 2>nul
goto bff_wait_loop

rem ---- bff_health: HEALTHY=1 only when GET /api/health answers 200 ----
:bff_health
set "HEALTHY=0"
where powershell >nul 2>nul
if errorlevel 1 goto bff_health_nops
rem The probe prints the HTTP status code ("200") or "0"; normalise it to 0/1.
for /f "usebackq delims=" %%H in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "try { (Invoke-WebRequest -Uri 'http://127.0.0.1:%BFF_PORT%/api/health' -UseBasicParsing -TimeoutSec 3).StatusCode } catch { 0 }"`) do set "HEALTHY=%%H"
if "%HEALTHY%"=="200" set "HEALTHY=1"
if not "%HEALTHY%"=="1" set "HEALTHY=0"
exit /b 0

:bff_health_nops
rem No PowerShell available: fall back to "the port is open" as the readiness signal.
call :port_busy %BFF_PORT%
if "%BUSY%"=="1" set "HEALTHY=1"
exit /b 0

:port_busy
set "BUSY=0"
for /f "tokens=*" %%L in ('netstat -ano -p tcp ^| findstr /r /c:"LISTENING" ^| findstr /c:":%~1 "') do set "BUSY=1"
exit /b 0
