@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==============================================================
echo   熊猫五福餐厅 - 外接比价（Selenium 网页抓价）
echo ==============================================================
echo.
echo   说明：
echo     · 自动选择本机浏览器内核（优先 Chrome，没装就自动用 Edge）
echo     · 首次运行请在弹出窗口里扫码登录 1688，登录信息会记住
echo     · 抓价节奏默认每次操作间隔 2.5 秒，请勿加速以免触发风控
echo.
echo   常用参数（直接加在后面即可）：
echo     --limit 3          只抓前 3 种，先试跑
echo     --keyword 东古一品鲜  只搜一个词，验证是否抓得到
echo     --browser edge     强制用 Edge
echo     --delay 3.5        放慢节奏（被拦截时用）
echo.

rem ---- 1) 选择 Python 解释器（优先 py 启动器） ----
where py >nul 2>nul && (set "PY=py") || (set "PY=python")

rem ---- 2) 检查依赖 ----
%PY% -c "import selenium, pandas, openpyxl" >nul 2>nul
if errorlevel 1 (
  echo [提示] 缺少依赖，正在安装 selenium / webdriver-manager / pandas / openpyxl ...
  %PY% -m pip install -r requirements.txt
  if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败，请手动执行： %PY% -m pip install -r requirements.txt
    pause
    exit /b 1
  )
)

rem ---- 3) 运行网页版抓价（默认自动查找最新的 待比价任务*.json） ----
%PY% fetch_quotes_selenium.py %*

echo.
echo --------------------------------------------------------------
echo 完成。请回到系统「外接比价」页点击「导入比价结果」，
echo 选择本目录下的  比价结果.json  即可。
echo --------------------------------------------------------------
pause
endlocal
