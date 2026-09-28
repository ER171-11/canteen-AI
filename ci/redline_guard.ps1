#Requires -Version 5.1
<#
红线守卫（PowerShell 版）——与 ci/redline_guard.sh 等价，供本机（Windows 无 bash）使用。

用法: powershell -NoProfile -ExecutionPolicy Bypass -File ci/redline_guard.ps1

背景：CI 在 ubuntu 上跑 ci/redline_guard.sh；本项目开发机为 Windows 且无 bash，
      导致「红线守卫」在本地长期不可执行 —— 红线只能靠 CI 事后发现。
      本脚本以同样的检查项、同样的判定（任一失败即退出码 1）补齐本机可执行性。

检查项与 bash 版一一对应：
  R3/R4 受保护文件哈希基线（bff/store-node/{db,merge}.js 零改动）
  R13   后台无旁路写（admin-web / bff admin 路由不得直连 /api/sync 或 sqlite）
  R5    无硬编码 Key
  R10   图片不落库（BFF 侧）
  R14   迁移功能清单逐项标注状态

注意：本文件必须保存为「UTF-8 with BOM」，否则 Windows PowerShell 5.1 会按 ANSI 解码导致中文乱码。
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root

$script:fail = 0
function Say([string]$m) { Write-Host $m }
function Ok([string]$m) { Write-Host "OK: $m" -ForegroundColor Green }
function Fail([string]$m) { Write-Host "FAIL: $m" -ForegroundColor Red; $script:fail = 1 }

$SkipDirRx = '\\(node_modules|\.git|build|dist|\.gradle|\.idea)\\'
$SrcExt = @('.js', '.ts', '.tsx', '.py', '.kt', '.swift')

function Get-SrcFiles([string[]]$dirs) {
  $res = New-Object System.Collections.ArrayList
  foreach ($d in $dirs) {
    if (-not (Test-Path -LiteralPath $d)) { continue }
    Get-ChildItem -LiteralPath $d -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.FullName -match $SkipDirRx) { return }
      if ($SrcExt -notcontains $_.Extension.ToLower()) { return }
      [void]$res.Add($_)
    }
  }
  return $res
}

# 以 UTF-8 读行后正则匹配：避免 PowerShell 5.1 默认 ANSI 解码把中文/正则需要的内容读错
function Search-Utf8([string[]]$dirs, [string]$pattern, [string]$excludePattern) {
  $rx = [regex]$pattern
  $ex = $null
  if ($excludePattern) { $ex = [regex]$excludePattern }
  $res = New-Object System.Collections.ArrayList
  foreach ($f in (Get-SrcFiles $dirs)) {
    $ln = 0
    foreach ($line in [System.IO.File]::ReadAllLines($f.FullName, [System.Text.Encoding]::UTF8)) {
      $ln++
      if (-not $rx.IsMatch($line)) { continue }
      if ($ex -and $ex.IsMatch($line)) { continue }
      $rel = $f.FullName.Substring($Root.Length + 1).Replace('\', '/')
      [void]$res.Add(("{0}:{1}: {2}" -f $rel, $ln, $line.Trim()))
    }
  }
  return $res
}

# ---------------------------------------------------------------- R3/R4
Say '== R3/R4 受保护文件哈希基线 =='
$hashFail = 0
$baseFile = 'ci/redline_baseline.sha256'
if (-not (Test-Path -LiteralPath $baseFile)) {
  Fail "缺少哈希基线文件：$baseFile"
} else {
  foreach ($line in [System.IO.File]::ReadAllLines((Resolve-Path -LiteralPath $baseFile).Path, [System.Text.Encoding]::UTF8)) {
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) { continue }
    $parts = $line -split '\s+', 2
    if ($parts.Count -lt 2) { continue }
    $expect = $parts[0].Trim().ToLower()
    $path = $parts[1].Trim()
    if (-not (Test-Path -LiteralPath $path)) { Fail "受保护文件缺失：$path"; $hashFail = 1; continue }
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expect) { Fail "受保护文件被修改：$path"; $hashFail = 1 }
  }
  if ($hashFail -eq 0) { Ok '受保护文件零改动' }
}

# ---------------------------------------------------------------- R13
Say '== R13 后台无旁路写 =='
$hits = Search-Utf8 @('apps/admin-web/src', 'bff/routes/admin') 'api/sync|sqlite3|餐厅系统\.db' '禁止|红线|bypass'
if ($hits.Count -gt 0) {
  Fail '发现疑似旁路写路径:'
  $hits | ForEach-Object { Write-Host "  $_" }
} else {
  Ok '后台写操作均指向 /api/actions 队列'
}

# ---------------------------------------------------------------- R5
Say '== R5 无硬编码密钥 =='
$keys = Search-Utf8 @('bff', 'apps', 'kmp-shared', 'store-inventory') 'sk-[A-Za-z0-9]{20,}' ''
if ($keys.Count -gt 0) {
  Fail '发现疑似硬编码 Key:'
  $keys | ForEach-Object { Write-Host "  $_" }
} else {
  Ok '无硬编码 Key'
}

# ---------------------------------------------------------------- R10
Say '== R10 图片不落库（BFF 侧）=='
$imgHits = Search-Utf8 @('bff') 'writeFileSync.*imageBase64|imageBase64.*writeFile' ''
if ($imgHits.Count -gt 0) {
  Fail '图片疑似落盘'
  $imgHits | ForEach-Object { Write-Host "  $_" }
} else {
  Ok '图片仅内存传递'
}

# ---------------------------------------------------------------- R14
Say '== R14 迁移功能清单（替代式迁移必须逐项标注状态）=='
if (Test-Path -LiteralPath 'docs/迁移基线') {
  $bfs = @(Get-ChildItem -LiteralPath 'docs/迁移基线' -Filter '*.md' -File)
  if ($bfs.Count -eq 0) {
    Ok '尚未建立迁移基线（未启动替代式迁移）'
  } else {
    foreach ($bf in $bfs) {
      $total = 0
      $marked = 0
      foreach ($l in [System.IO.File]::ReadAllLines($bf.FullName, [System.Text.Encoding]::UTF8)) {
        if ($l -match '^\|\s*FP-') {
          $total++
          if ($l -match '已移植|等价替代|待补|废弃') { $marked++ }
        }
      }
      if ($total -ne $marked) {
        Fail "$($bf.Name) 存在未标注状态的功能点（已标注 $marked/$total）"
      } else {
        Ok "$($bf.Name) 全部 $total 项已标注状态"
      }
    }
  }
} else {
  Ok '无迁移基线目录'
}

# ---------------------------------------------------------------- 汇总
if ($script:fail -eq 0) {
  Write-Host '== 红线守卫全部通过 ==' -ForegroundColor Green
} else {
  Write-Host '== 红线守卫未通过 ==' -ForegroundColor Red
}
exit $script:fail
