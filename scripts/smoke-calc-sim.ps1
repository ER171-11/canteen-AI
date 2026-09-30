# 结构测算「模拟态」开箱冒烟（阶段 11 / ADR-007）——一键起停
#   起 BFF(8787，若未在跑) + vite dev(5173) + 无头 Edge(CDP 9222)，跑 smoke-calc-sim.js，完事全清理。
# 用法： powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-calc-sim.ps1
$ErrorActionPreference = 'Continue'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$web  = Join-Path $root 'apps\admin-web'
$bff  = Join-Path $root 'bff'
$log  = Join-Path $env:TEMP 'smoke-calc-sim-logs'
New-Item -ItemType Directory -Force -Path $log | Out-Null

$vite = $null; $edge = $null; $srv = $null; $code = 1
function Test-Up([string]$url) {
  try { return (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { return $false }
}
try {
  if (-not (Test-Up 'http://127.0.0.1:8787/api/health')) {
    Write-Host '== start BFF (8787) =='
    $srv = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $bff -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $log 'bff.out.log') -RedirectStandardError (Join-Path $log 'bff.err.log')
  } else {
    Write-Host '== BFF 已在 8787，复用 =='
  }

  Write-Host '== start vite dev (5173) =='
  $vite = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','dev' -WorkingDirectory $web -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $log 'vite.out.log') -RedirectStandardError (Join-Path $log 'vite.err.log')

  Write-Host '== start headless Edge (CDP 9222) =='
  $edgeExe = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
  if (-not (Test-Path $edgeExe)) { $edgeExe = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe' }
  $edge = Start-Process -FilePath $edgeExe -PassThru -WindowStyle Hidden -ArgumentList `
    '--headless=new','--remote-debugging-port=9222','--remote-allow-origins=*',
    ("--user-data-dir=" + (Join-Path $log 'edge-profile')),
    '--no-first-run','--no-default-browser-check','--disable-gpu','--disable-extensions','about:blank'

  $ready = $false
  for ($i = 0; $i -lt 120; $i++) {
    try {
      $c = (Invoke-WebRequest -Uri 'http://127.0.0.1:5173/' -UseBasicParsing -TimeoutSec 3).StatusCode
      $b = (Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 3).Browser
      if ($c -eq 200 -and $b) { $ready = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 1000
  }
  if (-not $ready) {
    Write-Host '!! web 或 CDP 未就绪，打印日志尾巴：'
    Get-Content (Join-Path $log 'vite.err.log') -ErrorAction SilentlyContinue | Select-Object -Last 30
    Get-Content (Join-Path $log 'bff.err.log') -ErrorAction SilentlyContinue | Select-Object -Last 30
  }

  Write-Host '== run CDP open-box asserts =='
  & node (Join-Path $PSScriptRoot 'smoke-calc-sim.js')
  $code = $LASTEXITCODE
  Write-Host ("== 开箱退出码: " + $code + " ==")
} finally {
  if ($vite) { try { Stop-Process -Id $vite.Id -Force -ErrorAction SilentlyContinue } catch { } }
  if ($edge) { try { Stop-Process -Id $edge.Id -Force -ErrorAction SilentlyContinue } catch { } }
  if ($srv)  { try { Stop-Process -Id $srv.Id  -Force -ErrorAction SilentlyContinue } catch { } }
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like '*remote-debugging-port=9222*' } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { } }
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*vite*' } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { } }
}
exit $code
