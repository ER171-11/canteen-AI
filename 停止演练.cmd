@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ==============================================
echo   canteenAI  -  stop SANDBOX environment
echo ==============================================
echo.

set /a killed=0

for %%T in (store bff consumer pusher web) do (
  taskkill /FI "WINDOWTITLE eq canteenAI-sandbox-%%T" /F >nul 2>nul
  if not errorlevel 1 (
    echo   stopped: canteenAI-sandbox-%%T
    set /a killed+=1
  )
)

rem fallback: wildcard match (some Windows builds accept this form)
taskkill /FI "WINDOWTITLE eq canteenAI-sandbox-*" /F >nul 2>nul

echo.
if %killed% EQU 0 (
  echo   No sandbox window was found. If processes are still running,
  echo   close their console windows manually.
) else (
  echo   Done. The sandbox DB is kept (store-inventory\data, *_sandbox file).
  echo   To rebuild it from the main DB:  node scripts\sandbox-db.js --reset
)
echo.
pause
exit /b 0
