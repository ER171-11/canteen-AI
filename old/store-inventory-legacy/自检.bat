@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ==============================================================
echo   熊猫五福餐厅 - 运行环境自检
echo ==============================================================
echo.

set "ERR=0"
where py >nul 2>nul && (set "PY=py") || (set "PY=python")

echo [1/5] Python 环境
where %PY% >nul 2>nul
if errorlevel 1 (
  echo   [错误] 未检测到 Python。请先安装 Python 3.8+ 并勾选 "Add Python to PATH"。
  echo          下载地址：https://www.python.org/downloads/
  set "ERR=1"
) else (
  %PY% -V
  %PY% -c "import sys;sys.exit(0 if sys.version_info>=(3,8) else 1)" >nul 2>nul
  if errorlevel 1 (
    echo   [错误] Python 版本过低，需要 3.8 及以上。
    set "ERR=1"
  ) else (
    echo   OK  版本满足要求（3.8+）
  )
)
echo.

echo [2/5] 核心文件
call :chk "server\app.py"
call :chk "server\db.py"
call :chk "server\merge.py"
call :chk "server\config.json"
call :chk "启动系统.bat"
call :chk "熊猫五福餐厅进销存系统_真实数据版.html"
echo.

echo [3/5] 数据库
if exist "data\餐厅系统.db" (
  for %%A in ("data\餐厅系统.db") do echo   OK  data\餐厅系统.db  %%~zA 字节  最后修改 %%~tA
) else (
  echo   [提示] data\餐厅系统.db 不存在。
  echo          新装：首次启动会自动创建空库，届时在页面里录入或导入备份即可。
  echo          迁移自旧电脑：请先把 data\餐厅系统.db 放回本目录再启动服务。
)
set "BK="
if exist "data\backups" (
  for /f "delims=" %%F in ('dir /b /o-d "data\backups\*.db" 2^>nul') do if not defined BK set "BK=%%F"
)
if defined BK (echo   最近冷备份：!BK!) else (echo   [提示] 尚无冷备份，首次启动服务时会自动生成。)
echo.

echo [4/5] 服务端脚本语法
where %PY% >nul 2>nul
if errorlevel 1 (
  echo   跳过（无 Python）
) else (
  %PY% -m py_compile server\app.py server\db.py server\merge.py >nul 2>nul
  if errorlevel 1 (
    echo   [错误] 语法校验未通过，请到 Python 里单独运行查看报错。
    set "ERR=1"
  ) else (
    echo   OK  server 脚本语法正常
  )
)
echo.

echo [5/5] 服务端口 8765
netstat -ano | findstr ":8765" | findstr "LISTENING" >nul 2>nul
if errorlevel 1 (
  echo   OK  端口空闲，可直接启动服务
) else (
  echo   [提示] 端口 8765 正在被监听，服务可能已在运行。
  echo          若启动报端口冲突，请改 server\config.json 的 port，或用：
  echo          %PY% server\app.py --port 8766
)
echo.

echo --------------------------------------------------------------
if "%ERR%"=="1" (
  echo 自检发现问题，请先解决上方标记为 [错误] / [缺失] 的项目。
) else (
  echo 自检通过。双击  启动系统.bat  启动服务并自动打开浏览器。
)
echo --------------------------------------------------------------
pause
endlocal
exit /b 0

:chk
if exist "%~1" (echo   OK  %~1) else (echo   [缺失] %~1& set "ERR=1")
exit /b 0
