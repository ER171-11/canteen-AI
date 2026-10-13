@echo off
setlocal EnableExtensions
rem Switch the console to UTF-8 (65001). This file is saved as UTF-8, but the
rem default console code page on zh-CN is 936 (GBK), which would mis-decode the
rem Chinese DB path below and make "if exist" fail on an existing sandbox DB.
chcp 65001 >nul
cd /d "%~dp0"

set "ROOT=%~dp0"
set "BFF_PORT=8787"
set "STORE_PORT=8765"
set "WEB_PORT=5173"
set "WEB_URL=http://localhost:%WEB_PORT%/"
set "SANDBOX_DB=%ROOT%store-inventory\data\餐厅系统_演练.db"

echo ==============================================================
echo   canteenAI  -  SANDBOX launcher
echo   Test writes go to the SANDBOX DB, the real DB stays untouched.
echo ==============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
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

rem ---- Safety guard: sandbox ports must be free.
rem      A running store-node / BFF is probably bound to the REAL database,
rem      so reusing it would silently write real data.
call :port_busy %STORE_PORT%
if "%BUSY%"=="1" (
  echo [ERROR] Port %STORE_PORT% is already in use.
  echo         A store-node is probably serving the REAL database.
  echo         Run 停止演练.cmd  or close the related windows first.
  echo.
  pause
  exit /b 1
)
call :port_busy %BFF_PORT%
if "%BUSY%"=="1" (
  echo [ERROR] Port %BFF_PORT% is already in use.
  echo         Close the running BFF first so the sandbox env can take over.
  echo.
  pause
  exit /b 1
)

rem ---- [1/6] sandbox DB
if not exist "%SANDBOX_DB%" (
  echo [1/6] Sandbox DB not found, creating it from the main DB ...
  node "%ROOT%scripts\sandbox-db.js" --init
  if errorlevel 1 (
    echo [ERROR] Failed to create the sandbox DB.
    echo.
    pause
    exit /b 1
  )
) else (
  echo [1/6] Sandbox DB ready.
)
echo       %SANDBOX_DB%
echo.

set "CANTEEN_ENV=sandbox"
set "STORE_DB=%SANDBOX_DB%"

rem ---- [2/6] store-node
echo [2/6] Starting store-node on %STORE_PORT% (sandbox DB) ...
start "canteenAI-sandbox-store" /min /d "%ROOT%" cmd /k node bff\store-node\server.js --port %STORE_PORT% --db "%SANDBOX_DB%"

rem ---- [3/6] BFF
echo [3/6] Starting BFF on %BFF_PORT% (CANTEEN_ENV=sandbox) ...
start "canteenAI-sandbox-bff" /min /d "%ROOT%bff" cmd /k node server.js

set /a tries=0
:bffwait
set /a tries+=1
call :port_busy %BFF_PORT%
if "%BUSY%"=="1" goto bffok
if %tries% GEQ 40 goto bfffail
ping -n 2 127.0.0.1 >nul 2>nul
goto bffwait

:bfffail
echo.
echo [ERROR] BFF did not come up within 40 seconds.
echo         Check the "canteenAI-sandbox-bff" window for details.
echo.
pause
exit /b 1

:bffok
rem ---- [4/6] token
echo [4/6] Logging in to get a BFF token ...
set "TOKEN="
for /f "usebackq delims=" %%T in (`node "%ROOT%scripts\login-token.js"`) do set "TOKEN=%%T"
if "%TOKEN%"=="" (
  echo       [WARN] No token obtained. consumer/pusher may not work.
) else (
  echo       token ok
)

rem ---- [5/6] consumer + pusher
echo [5/6] Starting consumer (5s) and pusher (60s) ...
start "canteenAI-sandbox-consumer" /min /d "%ROOT%" cmd /k node bff\store-node\consumer.js --interval 5 --store-url http://127.0.0.1:%STORE_PORT% --bff-url http://127.0.0.1:%BFF_PORT% --token %TOKEN% --account boss --password wufu123 --db "%SANDBOX_DB%"
start "canteenAI-sandbox-pusher" /min /d "%ROOT%" cmd /k node bff\store-node\pusher.js --interval 60 --store-url http://127.0.0.1:%STORE_PORT% --bff-url http://127.0.0.1:%BFF_PORT% --token %TOKEN% --db "%SANDBOX_DB%"

rem ---- [6/6] admin-web
echo [6/6] Starting web dev server on %WEB_PORT% ...
start "canteenAI-sandbox-web" /min /d "%ROOT%apps\admin-web" cmd /k node node_modules\vite\bin\vite.js --port %WEB_PORT% --strictPort

set /a tries=0
:webwait
set /a tries+=1
call :port_busy %WEB_PORT%
if "%BUSY%"=="1" goto ready
if %tries% GEQ 60 goto webfail
ping -n 2 127.0.0.1 >nul 2>nul
goto webwait

:webfail
echo.
echo [ERROR] The web dev server did not come up within 60 seconds.
echo.
pause
exit /b 1

:ready
rem Open the URL via explorer: explorer hands the address to the system
rem default browser. The old start "" "URL" form depends on the shell file
rem association and can silently do nothing on some machines.
explorer "%WEB_URL%"
echo.
echo ==============================================================
echo   SANDBOX READY  (real DB is NOT touched)
echo --------------------------------------------------------------
echo   Sandbox DB : store-inventory\data\餐厅系统_演练.db
echo   Web page   : %WEB_URL%
echo   BFF        : http://localhost:%BFF_PORT%
echo   Store node : http://localhost:%STORE_PORT%
echo.
echo   Login      : boss / wufu123
echo   Reset DB   : node scripts\sandbox-db.js --reset
echo   Stop all   : 停止演练.cmd
echo ==============================================================
echo.
pause
exit /b 0

:port_busy
set "BUSY=0"
for /f "tokens=*" %%L in ('netstat -ano -p tcp ^| findstr /r /c:"LISTENING" ^| findstr /c:":%~1 "') do set "BUSY=1"
exit /b 0
