@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==============================================================
echo   熊猫五福餐厅 - 本地数据库服务
echo ==============================================================
echo.

rem ---- 1) 选择 Python 解释器（优先 py 启动器） ----
where py >nul 2>nul && (set "PY=py") || (set "PY=python")

rem ---- 2) 校验 Python 3.8+（本项目只用标准库，无需 pip 安装） ----
%PY% -c "import sys;sys.exit(0 if sys.version_info>=(3,8) else 1)" >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Python 3.8 及以上版本。
  echo        请先安装 Python：https://www.python.org/downloads/
  echo        安装时勾选 "Add Python to PATH"。
  pause
  exit /b 1
)

echo [提示] 服务启动后会自动打开浏览器，并请保持本窗口开启。
echo        若浏览器未自动弹出，请手动访问 http://127.0.0.1:8765/
echo        （新机器首次使用建议先双击 自检.bat 检查运行环境）
echo.
echo --------------------------------------------------------------

%PY% server\app.py

echo.
echo --------------------------------------------------------------
echo 服务已停止。页面已自动切换为离线模式（数据仍存本机浏览器）。
pause
endlocal
