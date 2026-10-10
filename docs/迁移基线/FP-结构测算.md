# 迁移基线 · 结构测算（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-calc`「结构测算」（HTML 第 350–466 行区域，本页最大，参数项最多）
> 目标系统：**无独立测算页**；测算主战场为 `apps/admin-web/src/pages/ops/WeeklyReportPage.tsx`（本轮新拆出 `ops/CalcParamsCard.tsx` 参数表单 + `ops/CalcCharts.tsx` 图表与情景）+ `DashboardPage.tsx`；算法在 `bff/lib/menu_baoben.js`（与旧版 `calc()` :4856 同公式），经 `GET /api/modules/analysis` 的 `baoben_summary` 出参（`bff/routes/modules.js`:1574-1590）
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　最近更新：2026-10-10（阶段 12）　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/迁移颗粒度规范.md`
>
> ✅ **该页在新系统无独立路由**，测算能力落在「经营周报」页；参数可调项 24 项（阶段 9 闭合）、逐菜结构表/排序（阶段 10）、模拟态只读推演（阶段 11）、五类角色卡片（阶段 12）均已落地，**本页 20/20 闭合**。

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
| FP-CALC-08 | 切换日销量口径（估算 / 近30天真实 / 近7天真实，含无销量回落估算开关） | HTML:358-364 `#scQMode`/`#scQFb`、:4324 | `CalcDishTable.tsx` 卡片头口径 `Select`（3 档）+「无销量回落估算」勾选 + 表尾口径统计与 `q` 列 tooltip；数据源 `POST /api/modules/analysis/sim` 的 `qmode`/`qfallback`（`analysis_sim.js`、`menu_baoben.js` `dishRealQty`/`calcQtyOf`/`scQDays`） | ⬆️ 已移植 | 阶段 11。默认 `real30` + 回落开（照抄旧版 `SC_QMODE='real30'`/`SC_QFALLBACK=true`）；真实销量 = 近 N 天 `sales` 求和 ÷ N，无销量按开关回落估算 q；切换口径即进入模拟态（门店级徽标） |
| FP-CALC-09 | 逐菜结构表（成本/售价/成本率/毛利率/日销量/日营收/日毛利额） | HTML:411-426、`renderCalcTable` :4043 | `CalcDishTable.tsx`（9 列同旧版列序 + 类型分组行；阶段 11 补「上架」勾选与「操作·重置」两列 → 共 11 列）；后端基线 `modules.js` 出 `calc_dishes`、`menu_baoben.js` `toCalcRows`；模拟态 `analysis_sim.js` | ⬆️ 已移植 | 行集 = 店内上架菜品（对齐旧版 `syncCalc`）；基线只读、模拟态可编辑（勾选/行内改价改量见 FP-CALC-11/12） |
| FP-CALC-10 | 表头排序（名称/类型/成本/售价/成本率/毛利率/销量/营收/毛利） | HTML:414-422 `sortable`、`calcSortedIdx` :4021 | `CalcDishTable.tsx`（9 个表头 sorter；默认「日营收」降序，换列从降序起、同列再点翻转；名称/类型按 `localeCompare('zh')`；无售价按哨兵 成本率 9 / 毛利率 −9） | ⬆️ 已移植 | 分组行插在**排序结果**的类型变化处（同旧版），故按营收排序时分组行会重复出现 |
| FP-CALC-11 | 行内改售价/成本/日销量并即时重算（本页模拟，不写库） | HTML:428 说明、`updateCalcRow` :4073、`renderCalcCharts` :4092 | `CalcDishTable.tsx` 成本/售价/日销量三列 `InputNumber`（步长 0.5/1/0.1 逐字照抄旧版）+「重置」列（按行清覆盖）；覆盖上行 `POST /api/modules/analysis/sim` 的 `rows`，后端 `menu_baoben.js` `applyRowOverrides`（纯函数、生成新对象）→ 单一公式 `computeModel` | ⬆️ 已移植 | 阶段 11。**模拟态零写库**：行覆盖只活在内存 + 请求体，不 `saveDB`/不写 `data/*.json`/不入 `actions_queue.json`；行值一律取后端回传行，**前端不持第二份公式**（避免口径漂移） |
| FP-CALC-12 | 取消勾选模拟下架该菜（SKU 精简对保本点影响） | HTML:428 说明、`updateCalcGroups` :4083 | `CalcDishTable.tsx` 首列「上架」勾选（`on` 覆盖，行线删除线 + `已下架` 标签）；模拟取消勾选 → 该行退出 `computeModel` 汇总（店级 KPI/图表联动）。真实下架仍走 `dish.set_active`（`WeeklyReportPage.tsx`:381-393） | ⬆️ 已移植 | 阶段 11。模拟态与真实动作**严格分开**：勾选只在推演层，写库仍需审批队列 |
| FP-CALC-13 | 按类型批量调价/调量/上架/恢复默认（−10%/−5%/+5%/+10%、±20%） | HTML:396-410 `data-bulk`、:4296 处理 | `CalcDishTable.tsx` 工具条：作用域 `Select`（全部菜品 / 引流·爆品·利润·形象·常规）+ 调价 4 档 + 调量 ±20% +「全部上架」+「恢复默认」；口径 `WeeklyReportPage.tsx` `simCtl.onBulk`（`Math.round(p×k)`、`q` 保留 1 位小数，照抄旧版） | ⬆️ 已移植 | 阶段 11。以「当前生效行值」为基数逐次累积覆盖（同旧版 `SD` 就地改值）；批量结果为 `rows` 覆盖，**不入审批队列** |
| FP-CALC-14 | 五类角色卡片与分类切换（引流/爆品/利润/形象/常规） | HTML:387 `#typeCards`、`renderCalcTypes` :3978、`renderCalcTabs` :4038 | `ops/CalcTypeCards.tsx`（5 张角色卡：名称/道数/描述/日销量/销量占比/日营收/营收占比/成本率/日毛利额/毛利占比，逐字照抄旧版 `CT`/`CT_COLOR` 与 `calcTypeStats` 字段序）+ 分类切换见 `CalcDishTable.tsx` 类型筛选 chips（阶段 10/11 已就位）；后端 `menu_baoben.js` `types` 补 `qty_share`（旧版 `renderCalcTypes` totQ 口径，加法式补字段） | ⬆️ 已移植 | 阶段 12。与左栏「四象限分布」（波士顿口径）**并列新增，不替换**；配色统一抽到 `calcSim.ts` 的 `CALC_TYPE_COLOR`，与逐菜表类型标签同源。口径 = **保本价盘**（同块 FP-CALC-15 表同源），故道数 Σ86 与逐菜表 95 道的**已知口径差**同阶段 10 备注 |
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
| ⬆️ 已移植 | 20（其中 1 项为新版新增能力：FP-CALC-20） |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 0 |
| ⚰️ 废弃 | 0 |

**结论**：阶段 9（2026-09-29）补齐「算得出但看不见」的参数与图表缺口，阶段 10 补齐
**逐菜结构表 + 表头排序**，阶段 11 补齐**模拟态只读推演**（08 口径切换 / 11 行内改价改量 /
12 模拟下架 / 13 批量调价调量），阶段 12（2026-10-10）补齐 **FP-CALC-14 五类角色卡片**。
本页 **20/20 全绿**。

## 建议补齐顺序

无（本页 20/20 已闭合）。

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- FP-CALC-11/12 的「模拟态」是**只读推演层**，禁止写回菜品/配方/库存（与 CHANGELOG v1.2.0「只读隔离」一致）。
- ~~FP-CALC-14 的四象限与旧版五类角色**口径不同**，不得宣称等价替代。~~ →
  **阶段 12 已按「并列新增」处理**：五类角色卡片独立成卡（`ops/CalcTypeCards.tsx`），
  左栏四象限（波士顿口径）原样保留，两口径并存、互不替换。
- 阶段 9（2026-09-29）迁移 04/05/06/07/16/17/18；验证方式为**无头浏览器开箱**：3 张图 viewBox 均渲染、
  分情景表 5 档有值（日客流/月营收/净利率）、改「目标月利润」后请求带全量 24 项 query、
  「恢复默认参数」后 query 清空、控制台 0 报错（验证脚本为临时文件，已删除）。
- 阶段 9 主动偏离 2 条：① 参数改动由「输入即重算」改为「按参数重算」按钮 + 未重算提示；
  ② 百分比字段步进按显示单位给（0.1/0.5 个百分点），旧版 pct 字段 step=100 等价于不可用步进。
- **未闭环**：仅程序化验证，未经人工目视比对（配色/字号/窄屏换行）；`#typeChart` 之外的旧版
  滚动条与 tooltip 细节未逐项比对。
- 阶段 10（2026-09-29）迁移 09/10：后端 `toCalcRows()`（`bff/lib/menu_baoben.js`）把合并后的逐菜行
  落成 `calc_dishes`，经 `GET /api/modules/analysis` 下发；前端 `CalcDishTable.tsx` 渲染 9 列 + 类型分组行。
  **未改任何既有公式**，只在合并结果上取字段。
- 阶段 10 主动偏离 1 条：类型分组取 `dish_type`（价盘类型）优先、`cat` 兜底——旧版用 `d.cat`。
  原因：本店 9 个 `SKU-WF-*` 占位菜的主数据 `cat` 存的是饺子皮颜色（红/黄/绿/紫/黑/白），
  照旧版取会多出 6 个假分组（开箱实测 95 道被切成 11 组）；改取价盘类型后为 5 组：引流 12 / 爆品 21 /
  利润 22 / 形象 10 / 常规 30，与 `matrix.dish_type` 分布完全一致。
- 阶段 10 验证（无头浏览器开箱 + 接口冒烟，脚本为临时文件已删除）：
  - 接口：`calc_dishes` 95 行（= 菜品主数据 95 道，保本价盘独有项已滤除）；`price`/`cost`/`qty` 空值 0 条；
    分组营收 引流 1,416 / 爆品 10,934 / 利润 2,574 / 形象 2,624 / 常规 3,402 元，Σ=20,950 元。
  - 开箱：卡片标题「逐菜结构表（95 道 · 静态价盘）」、9 个表头；默认按「日营收」降序（首行 1,176 元）；
    点「菜品名称」「类型」表头各自生效（`aria-sort=descending`）；按类型排序时分组行恰 5 条；
    分组行底色 `rgb(241,245,249)`、`font-weight:700`、`colspan=9`、类型标签色 = 旧版常量
    （引流 #E8734A / 爆品 #D93025 / 利润 #1E8E5A）；控制台 0 报错。
  - **开箱发现并修掉 1 个真缺陷**：antd 的 `td.ant-table-column-sort` 底色优先级高于本表分组行样式，
    导致「当前排序列」那一格盖掉分组底色（排序后首个分组行变 #fafafa）；已在 `index.css` 用
    `background: … !important` 修正，并在三种排序状态下复测通过。
- 阶段 10 **已知口径差异（非缺陷）**：Σ逐菜日营收 20,950 元 ≠ 店级 `kpi.day_rev` 20,552.8 元。
  成因：逐菜表行集 = 店内菜品（95 道）、售价以店内为准；店级汇总走保本价盘整表（含「仅价盘有」的项，
  如「五福饺子」+342 元）。两处口径本就不同，图表各按自身口径呈现，**未做强行对齐**。
- ~~阶段 10 未做：勾选列（模拟下架）、行内改价/改量、「重置」列、日销量口径 tooltip~~ → **阶段 11 已全部补齐**
  （见下）。阶段 10 当时的「纯只读」结论在阶段 11 被**模拟态**取代：只读的是**基线**，模拟态是显式进入的推演层。
- ~~**未闭环（阶段 10 续）**：日销量列固定为保本价盘估算口径，**不等于旧版默认的「近 30 天真实销量」**~~ →
  **阶段 11 已闭环**：默认口径改为 `real30`（= 旧版默认），且三档可切换。
- 阶段 11（2026-09-30）迁移 08/11/12/13，落地 ADR：
  `docs/decisions/ADR-007-结构测算模拟层只读推演.md`。
  - **口径分界（必须遵守）**：基线 = `GET /api/modules/analysis`，店级 KPI 走**保本价盘整表**；
    模拟态 = `POST /api/modules/analysis/sim`，行集切到**本店在售菜品**（= 旧版 `calcModel()` 的 `SD` 口径）。
    因此**进入模拟态首帧店级 `day_rev` 20,552.8 → 27,725.28（+7,172.48）、`be_day` 11,903.49 → 11,848.85**
    ——这是口径切换不是计算错误，
    故页面（`WeeklyReportPage.tsx` 卡头、`CalcCharts.tsx`、`CalcDishTable.tsx` 卡头）三处挂
    「模拟态 · 本店在售菜品口径」徽标；基线说明文案也显式写出「口径不同，非计算错误」。
  - **零写库**：新端点独立成文件 `bff/routes/analysis_sim.js`（不并入 `routes/modules.js`，避免破坏其
    「只读端点 · 非 GET 一律 404」契约的自证性）；只 `loadSnapshot()` 只读 + `lib/menu_baoben` 纯计算，
    不 `saveDB`、不写 `data/*.json`、不 `postAction`、不入 `actions_queue.json`。
  - **单一公式事实来源**：`computeModel(act, P)` 从 `computeBaobenSummary()` 抽出（行含 `price/cost/qty/type`），
    模拟端点与基线端点共用同一公式；`applyRowOverrides()` 为纯函数（生成新对象，绝不 mutate 快照）。
    前端不持第二份公式：成本率/日营收/毛利额一律取后端回传行。
  - 主动偏离 1 条：旧版「输入即重算」为内存即时重算，新版为**去抖 300ms 回源推演**（行值/店级 KPI/图表
    全部来自同一响应，杜绝两份公式漂移）；代价是输入后约 0.3s 才更新数值。
  - 验证：`bff/lib/algorithms/baoben_sim.test.js`（三段：`computeModel` 与 `computeBaobenSummary`
    逐字段自洽 / 三口径与回落开关 / 零写库可测断言：`data/*.json` mtime+digest 不变、请求体不 mutate、幂等）；
   BFF 全量 `npm test` 通过；红线守卫 `ci/redline_guard.ps1` 全部通过。
- 阶段 12（2026-10-10）补齐 14，**本页 20/20 闭合**：
  - 新增 `apps/admin-web/src/pages/ops/CalcTypeCards.tsx`：5 张角色卡（`Card` 头 + 左侧 `CT_COLOR` 色条），
    字段序逐字照抄旧版 `renderCalcTypes`（HTML:3978-4019）——
    名称 / `{n} 道` / `CT.desc` / 日销量 / 销量占比 / 日营收 / 营收占比 / 成本率 / 日毛利额（**字色 = 角色色**，
    照抄旧版 `${CT_COLOR[s.t]}` 而非 ok/bad）/ 毛利占比。
  - 后端 `bff/lib/menu_baoben.js` **加法式补字段**：`types[].qty_share`（分母 = 参与测算日销量合计，
    即旧版 `renderCalcTypes` 的 `totQ`，HTML:3981）；同时把 `TYPE_META[].desc` 对齐为旧版 `CT[].desc` 全文
    （HTML:3810-3816，字段此前无消费方）。
  - 分类切换**无需新增**：`CalcDishTable.tsx` 的 `Tag.CheckableTag` 类型筛选（阶段 10/11 已就位，6 个 chip
    = 全部 + 5 类）即旧版 `renderCalcTabs`（HTML:4038）的等价物，本轮仅补开箱断言。
  - 配色**收拢单一来源**：旧版 `CT_COLOR`（HTML:3817）抽到 `calcSim.ts` 的 `CALC_TYPE_COLOR`，
    由角色卡片与逐菜表类型标签共用（原先散在 `CalcDishTable.tsx` 局部常量）。
  - **口径分界（已知、非缺陷）**：本卡与同块 FP-CALC-15 表同源 **保本价盘整表**口径，
    故基线道数 Σ = 12/12/22/10/30 = **86 道**，与逐菜表（店内菜品 95 道）的差异同阶段 10 备注；
    卡头 `extra` 显式标注「静态价盘口径」，不宣称与逐菜表同口径。
    且该口径**随页面分界自动切换**：`types` 取自 `simOn ? sim.baoben_summary.types : data.baoben_summary.types`
    （`WeeklyReportPage.tsx`:147），故进入模拟态后本卡道数 Σ 由 86 → **95**
    （= 本店在售菜品口径，与逐菜表自洽）。
  - 与左栏「四象限分布」（波士顿口径，`WeeklyReportPage.tsx`:279-296）**并列并存，未替换**。
  - 验证：`scripts/smoke-calc-sim.js`（阶段 11 起的常驻开箱脚本）新增 15 条 FP-CALC-14 断言
    （接口层 5 条：5 组 / `qty_share` 齐备 / Σ销量占比 100.01% / `name·desc·n` 齐备；
    UI 层 10 条：卡片存在 / 5 张卡 / 每卡 7 指标齐备 / 卡色 = `CT_COLOR` / chips=6 /
    点「引流」→ 逐菜表仅剩 12/95 道 / 点「全部」→ 复原 95 行 / 基线 Σ86 道 / 进模拟态 Σ95 道 = 逐菜行数）。
    **开箱 56/56 通过**（`powershell -File scripts/smoke-calc-sim.ps1`，含零写库三断言）；
    算法单测 15 文件全过、`ci/redline_guard.ps1` 全过、`scripts/gen-debt-table.ps1` 与
    `scripts/gen-progress-board.js` 已刷新（漂移校验 ok、数字一致性 OK）。
  - 顺手修：开箱脚本「审批队列仍为空」改为「**未新增**」（基线 2 条历史待办），
    避免因库内既有待办而假红。
