#Requires -Version 5.1
<#
.SYNOPSIS
  从 docs/迁移基线/FP-*.md 自动派生《欠账总表》，避免人工维护汇总表产生漂移。

.DESCRIPTION
  背景：2026-09-28 建立 8 页 FP 基线时，人工写的「汇总」数与行标注不符
  （进货入库写成 3/12 实为 4/11、菜品配方写成 10/8 实为 11/7）。
  教训：汇总表是**派生数据**，必须以行为准。本脚本即该教训的产物——
  欠账总表一律由脚本从基线文件重新解析生成，不手工编辑。

  波次与建议角色在本脚本顶部维护（属判断，不属派生数据）；
  FP ID / 功能点 / 所属页 一律从基线文件解析（属事实，禁止手抄）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/gen-debt-table.ps1
#>
[CmdletBinding()]
param(
  [switch]$Check   # 只校验不写文件：比对现有总表与重新生成的是否一致
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir  = Join-Path $root 'docs/迁移基线'
$out  = Join-Path $dir '欠账总表.md'

# ---------------------------------------------------------------- 波次定义
$waves = [ordered]@{
  W1 = '只读速补：零写库、无红线障碍、成本最低（读类优先）'
  W2 = '业务闭环：老板要用的单据输出与欠款清收（含少量写类）'
  W3 = '录入类：写操作，需先定职责边界 + 走审批队列'
  W4 = '高危与待决策：不可逆或架构已变，需业务批准人签字'
}
# 波次内页面排序（老板每日必用靠前）
$wavePageOrder = @{
  W1 = @('DASH','RECV','SET','ING','PO','DISH','CALC','PRICE','SALE')
  W2 = @('RECV','SET','PO','SALE','DASH','PRICE')
  W3 = @('RECV','PO','ING','SALE','DISH','CALC')
  W4 = @('SET')
}
$pageName = @{
  RECV='进货入库'; PO='采购管理'; ING='原料库存'; DISH='菜品配方'
  SALE='销售收银'; CALC='结构测算'; PRICE='外接比价'; DASH='经营概览'; SET='设置'
}
# 同页内排序覆盖（默认按 FP 序号升序）
$numOverride = @{ 'FP-SET-01' = 99 }   # 模块状态总览属锦上添花，排本页末位

# ------------------------------------------------- FP → (波次, 建议角色, 阻塞/依赖)
$m = @{}
function M { param($id,$w,$r,$d='') $script:m[$id] = @{ w=$w; r=$r; d=$d } }

# --- W1 只读速补 ---
M 'FP-DASH-07' 'W1' '前端'    ''
M 'FP-DASH-06' 'W1' 'BFF+前端' ''
M 'FP-DASH-08' 'W1' 'BFF+前端' ''
M 'FP-DASH-01' 'W1' '前端'    '后面所有区间口径的前置'
M 'FP-DASH-11' 'W1' '前端'    '随 FP-DASH-09 预警卡'
M 'FP-RECV-10' 'W1' 'BFF+前端' ''
M 'FP-RECV-11' 'W1' '前端'    ''
M 'FP-SET-11'  'W1' 'BFF+前端' '后端需新增业务数据导出端点'
M 'FP-SET-12'  'W1' 'BFF+前端' 'CSV 端点'
M 'FP-SET-13'  'W1' 'BFF+前端' 'CSV 端点'
M 'FP-SET-14'  'W1' 'BFF+前端' 'CSV 端点；依赖 FP-SALE-07 口径'
M 'FP-ING-07'  'W1' '前端'    ''
M 'FP-ING-08'  'W1' '前端'    ''
M 'FP-ING-15'  'W1' 'BFF+前端' ''
M 'FP-ING-09'  'W1' 'BFF+前端' ''
M 'FP-PO-15'   'W1' 'BFF+前端' ''
M 'FP-PO-12'   'W1' '前端'    '依赖 FP-PO-04/05 的状态字段'
M 'FP-PO-14'   'W1' '前端'    '随 FP-PO-12'
M 'FP-PO-10'   'W1' '前端'    ''
M 'FP-DISH-11' 'W1' 'BFF+前端' '需明确「近30天」口径'
M 'FP-DISH-12' 'W1' 'BFF+前端' '随 FP-DISH-11'
M 'FP-DISH-08' 'W1' '前端'    '依赖 FP-ING-04 出成率'
M 'FP-CALC-18' 'W1' '前端'    '后端已算 scenes，仅差渲染（性价比最高）'
M 'FP-CALC-04' 'W1' '前端'    '后端 DEFAULT_PARAMS 已备，开放为表单，不写库'
M 'FP-CALC-05' 'W1' '前端'    '后端 varRate 已算'
M 'FP-CALC-06' 'W1' '前端'    'modules.js 已支持 area/staff/days/target_profit 透传'
M 'FP-CALC-09' 'W1' 'BFF+前端' ''
M 'FP-CALC-10' 'W1' '前端'    '随 FP-CALC-09'
M 'FP-CALC-16' 'W1' '前端'    '后端 be_day 已出'
M 'FP-CALC-17' 'W1' '前端'    '后端 var_rate/fixed_month 已有'
M 'FP-CALC-07' 'W1' '前端'    '后端自动合并已实现，补手动刷新按钮'
M 'FP-CALC-08' 'W1' 'BFF+前端' '需 realAnalysis 的 sales 聚合支撑'
M 'FP-CALC-14' 'W1' '前端'    '四象限口径不同，不构成等价替代'
M 'FP-PRICE-01' 'W1' '前端'   ''
M 'FP-PRICE-02' 'W1' '前端'   '需本店均价参与计算'
M 'FP-PRICE-03' 'W1' 'BFF+前端' '比价页核心价值；需快照提供 ing.avg 与 conv'
M 'FP-PRICE-05' 'W1' '前端'   '折算口径，避免省错钱'
M 'FP-PRICE-13' 'W1' 'BFF+前端' ''
M 'FP-PRICE-14' 'W1' '前端'   '随 FP-PRICE-13'
M 'FP-SALE-14'  'W1' '前端'   '提示类，成本极低'
M 'FP-SET-01'   'W1' '前端'   '可复用 ModuleBrowse 数据（排本页末位）'

# --- W2 业务闭环 ---
M 'FP-RECV-04' 'W2' 'BFF+前端' '结算单是只读输出层，不写 DB'
M 'FP-RECV-05' 'W2' 'BFF+前端' '随 FP-RECV-04'
M 'FP-RECV-06' 'W2' 'BFF+前端' '与 FP-SET-18 同一缺口'
M 'FP-RECV-07' 'W2' 'BFF+前端' '欠款清收；走确认队列带 rev'
M 'FP-SET-18'  'W2' 'BFF+前端' '独立存储不写业务库'
M 'FP-SET-19'  'W2' 'BFF+前端' '随 FP-SET-18'
M 'FP-PO-03'   'W2' 'BFF+前端' '欠款清收闭环'
M 'FP-PO-18'   'W2' 'BFF+前端' '建议≠下单，须经确认'
M 'FP-PO-04'   'W2' 'BFF(动作)+前端' ''
M 'FP-PO-05'   'W2' 'BFF(动作)+前端' '作废留痕，禁物理删除'
M 'FP-PO-06'   'W2' 'BFF(动作)+前端' '随 FP-PO-04/05'
M 'FP-PO-07'   'W2' 'BFF(动作)+前端' '建议只留作废不留删除'
M 'FP-SALE-07' 'W2' 'BFF+前端' '营收/欠款口径唯一出口'
M 'FP-SALE-08' 'W2' 'BFF+前端' '依赖「单日期 vs 收款日期」口径'
M 'FP-SALE-09' 'W2' '前端'    '随 FP-SALE-07'
M 'FP-SALE-10' 'W2' '前端'    '随 FP-SALE-07'
M 'FP-SALE-11' 'W2' 'BFF(动作)+前端' '欠款清收闭环'
M 'FP-DASH-02' 'W2' 'BFF+前端' '先定应收口径'
M 'FP-DASH-03' 'W2' 'BFF+前端' '先定实收口径'
M 'FP-DASH-04' 'W2' 'BFF+前端' '随 FP-DASH-02/03'
M 'FP-DASH-05' 'W2' 'BFF+前端' '同时清掉前端 MOCK 假数据'
M 'FP-DASH-10' 'W2' '前端'    '需 14 天应收/实收双序列'
M 'FP-DASH-12' 'W2' 'BFF(动作)+前端' '生成采购草稿须走审批队列'
M 'FP-DASH-13' 'W2' 'BFF+前端' '需先建销售应收模型'
M 'FP-DASH-14' 'W2' 'BFF(动作)+前端' '随 FP-DASH-13'
M 'FP-DASH-15' 'W2' 'BFF+前端' '近30天单菜排行'
M 'FP-PRICE-07' 'W2' 'BFF(动作)+前端' '另需补 consumer.js 的 quote 执行器'
M 'FP-PRICE-09' 'W2' '前端'    '依赖 FP-PRICE-10'
M 'FP-PRICE-10' 'W2' 'BFF(动作)+前端' '与 FP-SET-03/04 同一缺口'
M 'FP-PRICE-11' 'W2' 'BFF+前端' '只读导出，不写库'
M 'FP-PRICE-12' 'W2' 'BFF(动作)+前端' '批量建议动作入队'
M 'FP-SET-02'  'W2' 'BFF(动作)+前端' 'config.update 链路已通'
M 'FP-SET-03'  'W2' 'BFF(动作)+前端' '随 FP-SET-02'
M 'FP-SET-04'  'W2' 'BFF(动作)+前端' '随 FP-SET-03'
M 'FP-SET-07'  'W2' 'BFF+前端' '需先定「服务端快照」形态并补 ADR'
M 'FP-SET-10'  'W2' 'BFF(动作)+前端' '回滚高危，须留痕'

# --- W3 录入类（需先定职责边界） ---
M 'FP-RECV-01' 'W3' 'BFF(动作)+前端' '需先定：进货单在店内录还是云端录'
M 'FP-RECV-02' 'W3' 'BFF(动作)+前端' '复用既有解析链路 + 唯一写入口'
M 'FP-RECV-03' 'W3' 'BFF+前端'      '随 FP-RECV-02'
M 'FP-RECV-08' 'W3' 'BFF(动作)+前端' '改为「编辑建议动作」入队'
M 'FP-RECV-09' 'W3' 'BFF(动作)+前端' '作废留痕，禁物理删除'
M 'FP-PO-01'   'W3' 'BFF(动作)+前端' '需先定职责边界'
M 'FP-PO-02'   'W3' 'BFF(动作)+前端' ''
M 'FP-PO-17'   'W3' 'BFF(动作)+前端' ''
M 'FP-PO-19'   'W3' 'BFF(动作)+前端' ''
M 'FP-PO-20'   'W3' 'BFF(动作)+前端' '记回 ing.upsert'
M 'FP-ING-04'  'W3' 'BFF(动作)+前端' '影响配方毛料还原，与 FP-DISH-08 联动'
M 'FP-ING-05'  'W3' 'BFF(动作)+前端' '手工调整须留痕'
M 'FP-ING-06'  'W3' 'BFF(动作)+前端' ''
M 'FP-ING-11'  'W3' 'BFF(动作)+前端' '须带引用校验'
M 'FP-ING-12'  'W3' 'BFF(动作)+前端' ''
M 'FP-ING-13'  'W3' 'BFF(动作)+前端' '行内入口 + 外部平台外链'
M 'FP-SALE-03' 'W3' 'BFF(动作)+前端' '需先定：平台数据谁导入'
M 'FP-SALE-04' 'W3' 'BFF(动作)+前端' '撤回须留痕'
M 'FP-SALE-05' 'W3' 'BFF(动作)+前端' 'A–E 五种金额口径'
M 'FP-SALE-06' 'W3' 'BFF(动作)+前端' '映射表独立于 DB，建议配置化'
M 'FP-SALE-12' 'W3' 'BFF(动作)+前端' ''
M 'FP-SALE-13' 'W3' 'BFF(动作)+前端' '回补库存、重算台账'
M 'FP-DISH-06' 'W3' 'BFF(动作)+前端' '须带引用校验；可先用停售替代'
M 'FP-DISH-16' 'W3' 'BFF(动作)+前端' '唯一批量录入通道'
M 'FP-DISH-17' 'W3' 'BFF+前端'      '随 FP-DISH-16'
M 'FP-DISH-18' 'W3' 'BFF(动作)+前端' '随 FP-DISH-16 打通'
M 'FP-CALC-11' 'W3' '前端'          '模拟态是只读推演层，禁写库'
M 'FP-CALC-12' 'W3' '前端'          '模拟态与真实下架动作分开'
M 'FP-CALC-13' 'W3' 'BFF(动作)+前端' '批量走建议动作入队'

# --- W4 高危与待决策 ---
M 'FP-SET-05' 'W4' '业务批准人' '架构已变（无 P2P 双机同步），建议 ⚰️ 废弃，待签字'
M 'FP-SET-06' 'W4' '业务批准人' '同 FP-SET-05'
M 'FP-SET-08' 'W4' '业务批准人' '同 FP-SET-05'
M 'FP-SET-09' 'W4' '业务批准人' '高危覆盖能力，不建议复刻'
M 'FP-SET-15' 'W4' 'BFF(动作)+前端' '高危覆盖：双人确认 + 审批队列'
M 'FP-SET-16' 'W4' 'BFF(动作)+前端' '最高危：强制先自动备份'
M 'FP-SET-17' 'W4' 'BFF(动作)+前端' '最高危：强制先自动备份'

# ---------------------------------------------------------------- 解析基线
$items = @()
$statTot = @{ total=0; up=0; eq=0; todo=0; dead=0 }

Get-ChildItem (Join-Path $dir 'FP-*.md') | Sort-Object Name | ForEach-Object {
  $rows = Get-Content $_.FullName -Encoding UTF8 | Where-Object { $_ -match '^\|\s*FP-' }
  foreach ($r in $rows) {
    $cells = ($r -split '(?<!\\)\|')
    if ($cells.Count -lt 7) { Write-Warning "列数异常，跳过：$($_.Name) → $($cells[1])"; continue }
    $id   = $cells[1].Trim()
    $name = $cells[2].Trim()
    $st   = $cells[5].Trim()
    $statTot.total++
    $isTodo = $false
    if    ($st -match '⬆️') { $statTot.up++ }
    elseif($st -match '🔄') { $statTot.eq++ }
    elseif($st -match '⚰️') { $statTot.dead++ }
    elseif($st -match '⬜') { $statTot.todo++; $isTodo = $true }
    else { Write-Warning "无四态标注：$id" }
    if (-not $isTodo) { continue }

    $page = ($id -replace '^FP-([A-Z]+)-\d+$','$1')
    if (-not $m.ContainsKey($id)) { Write-Warning "未分配波次：$id"; continue }
    $items += [pscustomobject]@{
      Id=$id; Name=$name; Page=$page; Num=[int]($id -replace '^FP-[A-Z]+-','')
      W=$m[$id].w; Role=$m[$id].r; Dep=$m[$id].d
    }
  }
}

# ---------------------------------------------------------------- 排序与卡号
$ordered = @()
foreach ($w in $waves.Keys) {
  $order = $wavePageOrder[$w]
  $grp = $items | Where-Object { $_.W -eq $w } | Sort-Object `
           @{e={ $i = $order.IndexOf($_.Page); if ($i -lt 0) { 99 } else { $i } }}, `
           @{e={ if ($numOverride.ContainsKey($_.Id)) { $numOverride[$_.Id] } else { $_.Num } }}
  $n = 0
  foreach ($it in $grp) { $n++; $it | Add-Member -NotePropertyName Card -NotePropertyValue ("{0}-{1:D2}" -f $w,$n) -Force }
  $ordered += $grp
}

# ---------------------------------------------------------------- 渲染
$utf8 = New-Object System.Text.UTF8Encoding($false)
$L = New-Object System.Collections.Generic.List[string]
function Add([string]$s='') { $L.Add($s) }

Add '# 欠账总表（替代模式 · 回归缺陷清单）'
Add ''
Add '> **本文件由脚本生成，不要手工编辑**：`powershell -File scripts/gen-debt-table.ps1`'
Add '> 数据源：`docs/迁移基线/FP-*.md`（9 页基线）。汇总数是**派生数据**，必须以行为准。'
Add '> 生成日期：2026-09-28　依据：`docs/迁移颗粒度规范.md`　任务来源：`docs/下一步任务清单_2026-09-28.md` §2 T3'
Add '> 排序原则：业务闭环 > 只读展示；老板每日必用 > 偶尔使用；只读（无红线障碍）> 写操作（需走审批队列）'
Add ''
Add '## 汇总'
Add ''
Add '| 波次 | 定位 | 卡数 | 说明 |'
Add '|---|---|---|---|'
foreach ($w in $waves.Keys) {
  $c = ($ordered | Where-Object { $_.W -eq $w }).Count
  Add ("| **{0}** | {1} | **{2}** | {3} |" -f $w, (($waves[$w] -split '：')[0]), $c, (($waves[$w] -split '：')[1]))
}
Add ("| — | **合计** | **{0}** | 基线 {1} 项中 ⬆️ {2} 已移植，⬜ {3} 待补 |" -f $ordered.Count, $statTot.total, $statTot.up, $statTot.todo)
Add ''
Add '| 按页 | ⬜ 欠账数 |'
Add '|---|---|'
foreach ($p in @('RECV','PO','ING','DISH','SALE','CALC','PRICE','DASH','SET')) {
  $c = ($ordered | Where-Object { $_.Page -eq $p }).Count
  Add ("| {0} {1} | {2} |" -f $p, $pageName[$p], $c)
}
Add ''
Add '> **负责人**列统一为「待指派 + 建议角色」：本项目当前无具名责任人，'
Add '> 按规范 §3，`⬜ 待补` 必须有**已批准的任务卡与负责人**才能放行——落地时须把「待指派」替换为真人。'
Add ''

foreach ($w in $waves.Keys) {
  $grp = $ordered | Where-Object { $_.W -eq $w }
  Add ("## {0} · {1}（{2} 项）" -f $w, (($waves[$w] -split '：')[0]), $grp.Count)
  Add ''
  Add '| 卡号 | FP ID | 所属页 | 功能点 | 负责人 | 建议角色 | 阻塞 / 依赖 |'
  Add '|---|---|---|---|---|---|---|'
  foreach ($it in $grp) {
    $dep = if ($it.Dep) { $it.Dep } else { '—' }
    Add ("| `{0}` | {1} | {2} {3} | {4} | 待指派 | {5} | {6} |" -f $it.Card, $it.Id, $it.Page, $pageName[$it.Page], $it.Name, $it.Role, $dep)
  }
  Add ''
}

Add '## 执行前置依赖'
Add ''
Add '| 前置决策 | 阻塞的卡 | 结论存放处 |'
Add '|---|---|---|'
Add '| 进货单/采购单/销售单「在店内录还是云端录」的职责边界 | W3 全部 29 张 | 待写入 ADR（T6 前置） |'
Add '| 应收/实收按「单日期」还是「收款日期」统计 | `FP-DASH-02/03`、`FP-SALE-08` | 待写入 ADR |'
Add '| 「服务端快照」形态（替代旧 localStorage 备份） | `FP-SET-07/10/11` | 待写入 ADR |'
Add '| 双机同步四件套是否废弃 | `FP-SET-05/06/08/09` | 需业务批准人签字后方可标 ⚰️ |'
Add '| 结构测算「模拟层」设计（只读推演、禁写库） | `FP-CALC-11/12/13` | 设计说明 + ADR |'
Add ''
Add '## 备注'
Add ''
Add '- 本表卡号 `{波次}-{序号}`（如 `W1-01`）即规范 §3 要求的**关联任务卡 ID**；补齐一个 FP 后，'
Add '  须同步把 `docs/迁移基线/FP-*.md` 中该行状态改为 ⬆️，并重新生成本表（该卡自动消失）。'
Add '- 113 张卡中 **W1 的 41 张是零红线只读项**，可与任何任务并行，建议最先清空。'
Add '- 平价测试全绿属另一条门禁，不能替代本表。'

$text = $L -join "`n"

if ($Check) {
  if (Test-Path $out) {
    $cur = (Get-Content $out -Raw -Encoding UTF8) -replace "`r`n","`n"
    if ($cur.Trim() -eq $text.Trim()) { Write-Host 'CHECK OK: 欠账总表与基线一致' -ForegroundColor Green; exit 0 }
    else { Write-Host 'CHECK FAIL: 欠账总表已过期，请重新生成' -ForegroundColor Red; exit 1 }
  } else { Write-Host 'CHECK FAIL: 欠账总表不存在' -ForegroundColor Red; exit 1 }
}

[System.IO.File]::WriteAllText($out, ($text + "`n"), $utf8)
Write-Host ("已生成：{0}" -f $out)
Write-Host ("基线 {0} 项 → ⬆️ {1} / ⬜ {2}；欠账卡 {3} 张" -f $statTot.total, $statTot.up, $statTot.todo, $ordered.Count)
foreach ($w in $waves.Keys) { Write-Host ("  {0}: {1}" -f $w, ($ordered | Where-Object { $_.W -eq $w }).Count) }
