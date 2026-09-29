<#
  scripts/demo-experience.ps1 —— 在电脑上体验「现场管理四块能力」的服务端效果

  作用：不碰手机、不碰店内 SQLite，只在云端 BFF 的快照副本上，按真实链路
        （POST /api/actions → confirm → apply）造出 A 块品控与 C 块闭店巡检的数据，
        然后你打开管理后台就能看到效果。

  红线说明：
    * 只调用 BFF 公开端点，BFF 侧会自行落 snapshot.json（rev 自增）；
    * 巡检只上报「有没有拍、谁拍的、几点拍的」，脚本不会传任何图片；
    * 运行前会先备份 bff/data/snapshot.json 为 snapshot.json.bak-demo（可用 -NoBackup 关闭）。

  注意：BFF 有令牌桶限流（普通接口 60 次/分钟），脚本已内置 429 退避重试，
        但请勿连点多次运行。

  用法（先启动 BFF，再执行本脚本）：
    powershell -ExecutionPolicy Bypass -File scripts\demo-experience.ps1
    或直接双击根目录「体验演示.cmd」

  常用参数：
    -Base http://127.0.0.1:8788    # 换端口（默认端口被占用时）
    -NoBackup                      # 不备份快照
#>
[CmdletBinding()]
param(
  [string]$Base = 'http://127.0.0.1:8787',
  [string]$Account = 'boss',
  [string]$Password = 'wufu123',
  [string[]]$DoneNodes = @('K01', 'K04', 'K08', 'K15', 'F01', 'F05', 'F10', 'C01', 'C03'),
  [string]$SkipShootNode = 'K06',
  [string]$ToiletNode = 'F11',
  [switch]$NoBackup
)

$ErrorActionPreference = 'Stop'
$base = $Base.TrimEnd('/')

function Write-Say {
  param([string]$Msg, [string]$Color = 'Gray')
  Write-Host $Msg -ForegroundColor $Color
}

# 统一请求：请求体一律 UTF-8 字节，避免中文在 Windows PowerShell 下被转成乱码；
# BFF 有令牌桶限流（std 档 60 次/分钟），命中 429 时按 Retry-After 退避重试。
function Invoke-Json {
  param([string]$Method, [string]$Path, $Body, [hashtable]$Headers)
  $p = @{ Uri = $base + $Path; Method = $Method; TimeoutSec = 30 }
  if ($Headers) { $p.Headers = $Headers }
  if ($null -ne $Body) {
    $json = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 12 -Compress }
    $p.ContentType = 'application/json; charset=utf-8'
    $p.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
  }
  for ($i = 1; $i -le 10; $i++) {
    try {
      return Invoke-RestMethod @p
    } catch {
      $resp = $_.Exception.Response
      $code = 0
      if ($resp -and $resp.StatusCode) { $code = [int]$resp.StatusCode }
      if ($code -eq 429 -and $i -lt 10) {
        $wait = 1
        try { if ($resp.Headers['Retry-After']) { $wait = [int]$resp.Headers['Retry-After'] } } catch { }
        if ($wait -lt 1) { $wait = 1 }
        Write-Say ('   · 命中限流（60 次/分钟），等待 ' + $wait + ' 秒后重试 (' + $i + '/10)') 'DarkYellow'
        Start-Sleep -Seconds $wait
        continue
      }
      throw
    }
  }
}

# 一个动作的完整真实链路：入队 → 确认（带快照 rev）→ BFF 侧 apply 落快照
function New-Action {
  param([string]$Type, $Payload, [string]$Operator)
  $created = Invoke-Json -Method Post -Path '/api/actions' -Headers $H -Body @{ type = $Type; payload = $Payload; operator = $Operator }
  $null = Invoke-Json -Method Post -Path ('/api/actions/' + $created.id + '/confirm') -Headers $H -Body @{ operator = $Operator; rev = $created.rev }
  $applied = Invoke-Json -Method Post -Path ('/api/actions/' + $created.id + '/apply') -Headers $H -Body '{}'
  if ($applied.ok -eq $false) {
    Write-Say ('   ! ' + $Type + ' 被驳回：' + $applied.error) 'Yellow'
  } else {
    Write-Say ('   + ' + $Type + ' → ' + $applied.status) 'DarkGray'
  }
  return $applied
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$snapPath = Join-Path $repoRoot 'bff\data\snapshot.json'

# ---------- 0. 连通性 ----------
try {
  $null = Invoke-Json -Method Get -Path '/api/health'
} catch {
  Write-Say ('[X] 连不上 BFF（' + $base + '）。请先双击根目录「启动测试.cmd」，等它把网页打开后再跑本脚本。') 'Red'
  exit 1
}

# ---------- 1. 备份快照 ----------
if (-not $NoBackup -and (Test-Path $snapPath)) {
  Copy-Item $snapPath ($snapPath + '.bak-demo') -Force
  Write-Say ('[1/5] 已备份快照 → ' + $snapPath + '.bak-demo') 'DarkGray'
} else {
  Write-Say '[1/5] 跳过备份' 'DarkGray'
}

# ---------- 2. 登录 ----------
try {
  $login = Invoke-Json -Method Post -Path '/api/admin/login' -Body @{ account = $Account; password = $Password; device_fp = 'pc-demo' }
} catch {
  Write-Say ('[X] 登录失败：' + $_.Exception.Message + '（需要 actions.write 权限，请用 boss / manager）') 'Red'
  exit 1
}
if (-not $login.token) { Write-Say '[X] 登录未返回 token' 'Red'; exit 1 }
$H = @{ Authorization = 'Bearer ' + $login.token }
Write-Say ('[2/5] 已登录：' + $login.account + ' / ' + $login.role) 'DarkGray'

$today = (Get-Date).ToString('yyyy-MM-dd')
$tsNow = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')

# ---------- 3. C 块：闭店巡检 ----------
Write-Say ''
Write-Say '[3/5] C 块 · 闭店巡检（照片只存手机本地，这里只上报状态）' 'Cyan'

$board0 = Invoke-Json -Method Get -Path ('/api/modules/inspection?date=' + $today) -Headers $H
$nodesById = @{}
foreach ($n in $board0.nodes) { $nodesById[[string]$n.id] = $n }

# 3.1 板块分工（负责到人）
$boardNames = @()
foreach ($b in $board0.boards) { $boardNames += [string]$b.board }
$assignee = @{}
$i = 0
foreach ($bn in $boardNames) {
  $assignee[$bn] = @('王大厨', '李前厅', '赵库管')[$i % 3]
  $i = $i + 1
  $null = New-Action -Type 'inspection.assign' -Payload @{ board = $bn; operator = $assignee[$bn]; store_id = 'ST001' } -Operator '店长'
}

# 3.2 正常拍照完成（photo_taken=1 → done=1）
foreach ($id in $DoneNodes) {
  $n = $nodesById[$id]
  if ($null -eq $n) { Write-Say ('   - 跳过未知节点 ' + $id) 'DarkGray'; continue }
  $null = New-Action -Type 'inspection.record' -Payload @{
    node_id     = $id
    date        = $today
    photo_taken = 1
    operator    = $assignee[[string]$n.board]
    station     = 'ST001·' + [string]$n.board + '-' + [string]$n.name
    store_id    = 'ST001'
    ts          = $tsNow
    source      = 'app'
  } -Operator $assignee[[string]$n.board]
}

# 3.3 卫生间类：每 30 分钟一轮（round 由服务端按 ts 自动推算）
$tn = $nodesById[$ToiletNode]
if ($null -ne $tn) {
  $null = New-Action -Type 'inspection.record' -Payload @{
    node_id     = $ToiletNode
    date        = $today
    photo_taken = 1
    operator    = '李前厅'
    station     = 'ST001·卫生间-' + [string]$tn.name
    store_id    = 'ST001'
    ts          = $tsNow
  } -Operator '李前厅'
}

# 3.4 反例：上层说"做完了"但没拍照 → 服务端仍判未完成（照片是唯一完成凭据）
$null = New-Action -Type 'inspection.record' -Payload @{
  node_id     = $SkipShootNode
  date        = $today
  photo_taken = 0
  done        = $true
  operator    = '王大厨'
  store_id    = 'ST001'
  ts          = $tsNow
} -Operator '王大厨'

# ---------- 4. A 块：品控 ----------
Write-Say ''
Write-Say '[4/5] A 块 · 品控记录（含一条不合格 + 一次强制放行留痕）' 'Cyan'

$qcWo = '1'
$qcSku = 'SKU-WF-HONG'

# 4.1 不合格（AI 低置信 → manual_review=1；图片只在对象存储，这里只落引用与键）
$null = New-Action -Type 'qc.record' -Payload @{
  workorder_id  = $qcWo
  sku_id        = $qcSku
  pass          = 0
  defect_items  = @('花纹不符', '褶纹不足')
  stage         = '包制'
  operator      = '张师傅'
  conf          = 62
  manual_review = $true
  station       = 'ST001·品控台'
  store_id      = 'ST001'
  photo_key     = ('qc/ST001/' + $today + '/demo-bxg.jpg')
  sample_weight = 23.5
  ts            = $tsNow
} -Operator '张师傅'

# 4.2 合格
$null = New-Action -Type 'qc.record' -Payload @{
  workorder_id  = $qcWo
  sku_id        = $qcSku
  pass          = 1
  stage         = '蒸制'
  operator      = '李师傅'
  conf          = 96
  manual_review = $false
  station       = 'ST001·品控台'
  store_id      = 'ST001'
  sample_weight = 26.1
  ts            = $tsNow
} -Operator '李师傅'

# 4.3 不合格工单强制放行：必须填原因，否则会被驳回
$null = New-Action -Type 'qc.force_pass' -Payload @{
  workorder_id = $qcWo
  reason       = '宴会加急，厨师长确认外观差异不影响口感'
  operator     = '厨师长'
  ts           = $tsNow
} -Operator '厨师长'

# ---------- 5. 回读校验 ----------
Write-Say ''
Write-Say '[5/5] 回读校验（这些数字就是后台页面看到的）' 'Cyan'

$board = Invoke-Json -Method Get -Path ('/api/modules/inspection?date=' + $today) -Headers $H
Write-Say ('   巡检 ' + $board.date + '：已完成 ' + $board.summary.done + ' / 总节点 ' + $board.summary.total + '，完成率 ' + $board.summary.rate + '%，漏项 ' + $board.summary.missing + ' 个') 'Green'
foreach ($b in $board.boards) {
  Write-Say ('     · ' + [string]$b.board + ' ' + $b.done + '/' + $b.total + '（' + $b.rate + '%） 负责人 ' + [string]$b.operator) 'Gray'
}
Write-Say ('   卫生间 30 分钟轮次：已记录 ' + @($board.every30.rounds_recorded).Count + ' 轮 / 应记 48 轮，缺口 ' + @($board.every30.rounds_missing).Count + ' 轮') 'Gray'

$qc = Invoke-Json -Method Get -Path ('/api/kitchen/qc?date=' + $today) -Headers $H
$bad = @($qc.items | Where-Object { [int]$_.pass -ne 1 }).Count
Write-Say ('   品控 ' + $qc.date + '：共 ' + $qc.count + ' 条，其中不合格 ' + $bad + ' 条') 'Green'

$media = Invoke-Json -Method Get -Path '/api/qc/media/status' -Headers $H
Write-Say ('   对象存储：configured=' + $media.configured + '（false = 后台显示「品控图片暂不可用」，属预期降级）') 'Gray'

# 图片不出现在任何巡检输出里（红线自检）
$raw = ($board | ConvertTo-Json -Depth 6 -Compress)
if ($raw -match 'base64|data:image|photo_url|photo_base64') {
  Write-Say '   [!] 巡检输出里出现疑似图片字段，请检查红线' 'Red'
} else {
  Write-Say '   红线自检：巡检输出不含任何图片字段 OK' 'Green'
}

# ---------- 下一步 ----------
Write-Say ''
Write-Say '================ 现在去页面看效果 ================' 'White'
Write-Say '  网页      http://localhost:5173/'
Write-Say '  登录      boss / wufu123'
Write-Say ('  C 块      「食安设备 → 闭店巡检」，日期选 ' + $today)
Write-Say ('  A 块      「菜品厨房 → 品控」，日期选 ' + $today)
Write-Say '  历史数据  日期切到 2026-09-25 可看 9 个演示工单与 4 条品控记录'
Write-Say ''
Write-Say ('  想恢复演示前的快照：先关掉 BFF，再把 ' + $snapPath + '.bak-demo 覆盖回 snapshot.json') 'DarkGray'
Write-Say '  B 块（桌态）与 D 块（水印相机）是手机端功能，电脑上只能用安卓模拟器/真机体验' 'DarkGray'
Write-Say ''
