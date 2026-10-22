@echo off
cd /d %~dp0
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npx electron-builder --prepackaged release/win-unpacked --win nsis > build-nsis.log 2>&1
echo NSIS_DONE exit=%errorlevel% >> build-nsis.log
