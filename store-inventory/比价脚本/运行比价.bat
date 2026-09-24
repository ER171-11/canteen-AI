@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==============================================================
echo   熊猫五福餐厅 - 外接比价 一键抓价
echo ==============================================================
echo.

rem ---- 1) 选择 Python 解释器（优先 py 启动器） ----
where py >nul 2>nul && (set "PY=py") || (set "PY=python")

rem ---- 2) 检查依赖 ----
%PY% -c "import requests, pandas, openpyxl" >nul 2>nul
if errorlevel 1 (
  echo [提示] 缺少依赖，正在安装 requests / pandas / openpyxl ...
  %PY% -m pip install -r requirements.txt
  if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败，请手动执行： %PY% -m pip install -r requirements.txt
    pause
    exit /b 1
  )
)

rem ---- 3) 运行抓价脚本（默认自动查找最新的 待比价任务*.json） ----
%PY% fetch_quotes.py %*

echo.
echo --------------------------------------------------------------
echo 完成。请回到系统「外接比价」页点击「导入比价结果」，
echo 选择本目录下的  比价结果.json  即可。
echo --------------------------------------------------------------
pause
endlocal
