@echo off
cd /d %~dp0
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npx electron-builder > build.log 2>&1
echo BUILD_DONE exit=%errorlevel% >> build.log
