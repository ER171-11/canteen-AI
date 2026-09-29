@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ==============================================
echo   canteenAI - demo data for the four on-site
echo   capabilities (QC + closing inspection)
echo ----------------------------------------------
echo   Requires: BFF already running (run
echo   "启动测试.cmd" first, or the login in it).
echo   Target  : http://127.0.0.1:8787
echo ==============================================
echo.

where powershell >nul 2>nul
if errorlevel 1 (
  echo [ERROR] powershell not found in PATH.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\demo-experience.ps1" %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" echo [WARN] script exited with code %RC%
pause
exit /b %RC%
