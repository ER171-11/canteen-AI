@echo off
cd /d %~dp0
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set CSC_IDENTITY_AUTO_DISCOVERY=false
set "DEBUG=electron-builder:*"
call npx electron-builder --win nsis > build-debug.log 2>&1
echo DEBUG_DONE exit=%errorlevel% >> build-debug.log
