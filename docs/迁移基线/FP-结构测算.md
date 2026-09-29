# 迁移基线 · 结构测算（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-calc`「结构测算」（HTML 第 350–466 行区域，本页最大，参数项最多）
> 目标系统：**无独立测算页**；测算主战场为 `apps/admin-web/src/pages/ops/WeeklyReportPage.tsx`（本轮新拆出 `ops/CalcParamsCard.tsx` 参数表单 + `ops/CalcCharts.tsx` 图表与情景）+ `DashboardPage.tsx`；算法在 `bff/lib/menu_baoben.js`（与旧版 `calc()` :4856 同公式），经 `GET /api/modules/analysis` 的 `baoben_summary` 出参（`bff/routes/modules.js`:1574-1590）
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　最近更新：2026-09-29（阶段 9）　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/迁移颗粒度规范.md`
>
> ⚠️ **该页在新系统无独立路由**，测算能力落在「经营周报」页；**参数可调项 24 项已全部开放（阶段 9 闭合）**，剩余缺口集中在「逐菜结构表 / 模拟态推演」。

---

## 功能点清单

| FP ID | 功能点 | 旧版证据 | 新版现状 | 状态 | 处置 / 关联 |
|---|---|---|---|---|---|
| FP-CALC-01 | 查看保本日营收（保本线） | HTML:433 公式、`renderCalcKpi` :3954 | `WeeklyReportPage.tsx`:228-232（kpi.be_day）、`DashboardPage.tsx`:246-252 | ⬆️ 已移植 | 验证：/ops/weekly 日保本卡、/dashboard 保本经营卡。仅静态价盘口径（`DashboardPage`:237-238 标「静态价盘」） |
| FP-CALC-02 | 查看保本达成率与月利润预测 | HTML:352 `#calcKpi`、`renderCalc` :4247 | `DashboardPage.tsx`:260-283、`WeeklyReportPage.tsx`:236-243 | ⬆️ 已移植 | 验证：看板保本卡 |
| FP-CALC-03 | 查看安全边际与边际贡献率 | HTML:374 `#vCM`、:441 图例「安全边际」 | `DashboardPage.tsx`:275-281 安全边际；边际贡献率 `CalcParamsCard.tsx`:153-161（参数卡合计回显，阶段 9 补） | ⬆️ 已移植 | 安全边际 + 边际贡献率均已出；原「建议补边际贡献率」项已闭合 |
| FP-CALC-04 | 调整固定成本参数（房租/物业/人工/装修设备摊销/水电/其他） | HTML:370 `#pFix`、`buildCalcParams` :3905、`calcModel` :3923 | `CalcParamsCard.tsx`:26-45（11 项：面积/租金单价/物业费/人员编制/人均成本/装修/设备/能耗固定/其他固定）、:193-228（表单渲染）；透传 `modules.js`:1574-1590、回显 `menu_baoben.js`:179-196、:315 | ⬆️ 已移植 | 只读模拟层：仅产生 query 覆盖并即时回显，**不写库**（不碰配方/库存/菜品主数据） |
| FP-CALC-05 | 调整变动成本率参数（酒水占比/酒水成本/包装/外卖佣金/营销/变动水电/杂费/手续费） | HTML:371 `#pVar`、:373 合计 | `CalcParamsCard.tsx`:46-61（9 项，按 % 录入、提交时 ÷100）、:153-161（变动成本率合计/边际贡献率/月固定成本合计）；后端 `menu_baoben.js`:239 `varOtherRate`、:214 varRate | ⬆️ 已移植 | 合计一律取后端 kpi，不在前端复算公式（避免双份口径漂移） |
| FP-CALC-06 | 调整运营口径（人均点菜份数/营业天数/餐位数/目标利润）与「恢复默认参数」 | HTML:355 `#calcResetParam`、:4314、:377 `#pOp` | `CalcParamsCard.tsx`:62-96（4 项全部可调）、:183-185「恢复默认参数」（→ `WeeklyReportPage.tsx`:59-71 不带 query 回源 = 后端 DEFAULT_PARAMS）、:162-170（点菜份数/日均客流/人均消费/保本综合翻台回显） | ⬆️ 已移植 | **主动偏离**：旧版「输入即重算」，新版改「按参数重算」按钮 +「参数已改，尚未重算」提示（`CalcParamsCard.tsx`:121-132、:186-188），避免每次按键打一次回源 |
| FP-CALC-07 | 同步菜品主数据（按最新菜品/配方重置测算输入） | HTML:356 `#calcSync`、:4320、`syncCalc` :3870 | `CalcCharts.tsx`:313-318「同步菜品主数据」→ `WeeklyReportPage.tsx`:405-408（重拉菜品主数据 + 店参归零回源）；后端合并 `menu_baoben.js`:412 `mergeDishesWithBaoben` | ⬆️ 已移植 | 口径说明：新版无「模拟态」输入可重置，故同步 = 重拉快照菜品 + 店参回默认，等价于「按最新数据重置测算输入」 |
| FP-CALC-08 | 切换日销量口径（估算 / 近30天真实 / 近7天真实，含无销量回落估算开关） | HTML:358-364 `#scQMode`/`#scQFb`、:4324 | 无（新版用静态价盘 daily_qty） | ⬜ 待补 | 只读聚合；真实销量需 `/api/modules/analysis` realAnalysis 的 sales 聚合支撑 |
| FP-CALC-09 | 逐菜结构表（成本/售价/成本率/毛利率/日销量/日营收/日毛利额） | HTML:411-426、`renderCalcTable` :4043 | 无（周报仅类型级汇总表 `WeeklyReportPage.tsx`:300-336） | ⬜ 待补 | 只读展示，**优先**（老板看单菜毛利） |
| FP-CALC-10 | 表头排序（名称/类型/成本/售价/成本率/毛利率/销量/营收/毛利） | HTML:414-422 `sortable`、`calcSortedIdx` :4021 | 无（周报表格无 sorter） | ⬜ 待补 | 随 FP-CALC-09 |
| FP-CALC-11 | 行内改售价/成本/日销量并即时重算（本页模拟，不写库） | HTML:428 说明、`updateCalcRow` :4073、`renderCalcCharts` :4092 | 无（新版调价走审批队列**落库**，无模拟态） | ⬜ 待补 | **模拟层缺失**：需独立「推演态」参数集，不写配方/库存 |
| FP-CALC-12 | 取消勾选模拟下架该菜（SKU 精简对保本点影响） | HTML:428 说明、`updateCalcGroups` :4083 | 无模拟；真实下架走 `dish.set_active`（`WeeklyReportPage.tsx`:381-393） | ⬜ 待补 | 模拟态 + 真实动作分开，二者都要 |
| FP-CALC-13 | 按类型批量调价/调量/上架/恢复默认（−10%/−5%/+5%/+10%、±20%） | HTML:396-410 `data-bulk`、:4296 处理 | 无 | ⬜ 待补 | 批量走建议动作入队（写类） |
| FP-CALC-14 | 五类角色卡片与分类切换（引流/爆品/利润/形象/常规） | HTML:387 `#typeCards`、`renderCalcTypes` :3978、`renderCalcTabs` :4038 | 近似：四象限分布（波士顿口径）`WeeklyReportPage.tsx`:279-296，非五类角色 | ⬜ 待补 | 口径不同，**不构成等价**；建议保留五类角色视图 |
| FP-CALC-15 | 查看各类型「营收占比 vs 毛利占比」对比 | HTML:389-391 `#typeChart` | `WeeklyReportPage.tsx`:300-336（rev_share/gp_share 进度条表） | ⬆️ 已移植 | 验证：/ops/weekly 菜品类型表 |
| FP-CALC-16 | 日营收 vs 保本线图（含保本线、安全边际） | HTML:436-442 `#beChart`、`renderCalcCharts` :4092 | `CalcCharts.tsx`:60-110（同尺寸 SVG viewBox 560×150，含保本虚线、缺口/安全边际大字与两行脚注） | ⬆️ 已移植 | 同尺寸同配色重绘（旧 `#beChart`），零图表依赖；近 7 日柱状趋势仍保留在 `WeeklyReportPage.tsx`:249-278 |
| FP-CALC-17 | 月营收成本结构图（占营收 %） | HTML:445-447 `#costChart` | `CalcCharts.tsx`:111-175（8 段堆叠 + 净利润/亏损段 + 图例标占营收 %）；后端补明细 `menu_baoben.js`:336-338（prop/util_fix/other）、:340-344（cost_bev_month/var_other_month/dish_qty） | ⬆️ 已移植 | 明细均为既有公式的月额拆分（加法式补字段，未改算法）；段色/文案对齐旧版 9 段图例 |
| FP-CALC-18 | 客流情景模拟（爬坡/培育/当前/稳定/成熟 五档 × 分情景经营结果表） | HTML:450-459 `#sceneChart`/`#sceneTable`、`renderCalcScene` :4144 | `CalcCharts.tsx`:176-275（五档曲线 + 保本系数点 + 目标利润线 + 坐标轴）、:342-400（分情景表 7 列 + 保本系数/目标客流结论 + 线性模型提示）；后端 `menu_baoben.js`:282-296（scenes 补 guests/month_rev） | ⬆️ 已移植 | 后端 scenes 原仅出 day_rev/month_profit/above_be，本次补 guests/month_rev 以还原旧表「日客流/月营收/净利率」列（加法式） |
| FP-CALC-19 | 查看结论与经营建议 | HTML:462-463 `#advice`、`renderCalcAdvice` :4212 | `WeeklyReportPage.tsx`:408-422（baoben advice）+ :339-407 建议清单 | ⬆️ 已移植 | 验证：/ops/weekly「保本价盘建议」。旧版建议维度更多（压固定成本/提量），建议扩充 |
| FP-CALC-20 | 逐菜调价/下架入审批队列（新版新增，替代旧版「模拟」） | 旧版无 | `WeeklyReportPage.tsx`:427-457（`dish.price`）、:381-393（`dish.set_active`） | ⬆️ 已移植 | 验证：点「执行·调价」→ /platform/actions 可见 |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 20 |
| ⬆️ 已移植 | 13（其中 1 项为新版新增能力：FP-CALC-20） |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 7 |
| ⚰️ 废弃 | 0 |

**结论**：阶段 9（2026-09-29）已把「算得出但看不见」的缺口补齐——参数表单 24 项全开放、
保本图/成本结构图/客流情景（含分情景结果表）均已渲染。剩余 7 项集中在
**逐菜结构表（09/10）** 与 **模拟态推演（11/12/13）**，以及销量口径（08）、五类角色（14）。

## 建议补齐顺序

1. **FP-CALC-09 / 10** 逐菜结构表 + 表头排序（只读，老板看单菜毛利，剩余最高价值项）
2. **FP-CALC-11 / 12** 模拟态推演（行内改价/改量、模拟下架，需先定「模拟层不写库」隔离设计）
3. **FP-CALC-13** 按类型批量调价/调量（模拟态之上，或直接走建议动作入队）
4. **FP-CALC-08** 日销量口径切换（估算 / 近 30 天 / 近 7 天，依赖 realAnalysis 销量聚合）
5. **FP-CALC-14** 五类角色卡片（与现有四象限口径不同，需并列新增，不得替换）

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- FP-CALC-11/12 的「模拟态」是**只读推演层**，禁止写回菜品/配方/库存（与 CHANGELOG v1.2.0「只读隔离」一致）。
- FP-CALC-14 的四象限与旧版五类角色**口径不同**，不得宣称等价替代。
- 阶段 9（2026-09-29）迁移 04/05/06/07/16/17/18；验证方式为**无头浏览器开箱**：3 张图 viewBox 均渲染、
  分情景表 5 档有值（日客流/月营收/净利率）、改「目标月利润」后请求带全量 24 项 query、
  「恢复默认参数」后 query 清空、控制台 0 报错（验证脚本为临时文件，已删除）。
- 阶段 9 主动偏离 2 条：① 参数改动由「输入即重算」改为「按参数重算」按钮 + 未重算提示；
  ② 百分比字段步进按显示单位给（0.1/0.5 个百分点），旧版 pct 字段 step=100 等价于不可用步进。
- **未闭环**：仅程序化验证，未经人工目视比对（配色/字号/窄屏换行）；`#typeChart` 之外的旧版
  滚动条与 tooltip 细节未逐项比对。
