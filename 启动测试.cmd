@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "ROOT=%~dp0"
set "BFF_PORT=8787"
set "WEB_PORT=5173"
set "WEB_URL=http://localhost:%WEB_PORT%/"

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

call :port_busy %BFF_PORT%
if "%BUSY%"=="1" (
  echo [1/3] BFF is already running on port %BFF_PORT%.
) else (
  echo [1/3] Starting BFF on port %BFF_PORT% ...
  start "canteenAI BFF" /min /d "%ROOT%bff" cmd /k node server.js
)

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

:port_busy
set "BUSY=0"
for /f "tokens=*" %%L in ('netstat -ano -p tcp ^| findstr /r /c:"LISTENING" ^| findstr /c:":%~1 "') do set "BUSY=1"
exit /b 0
