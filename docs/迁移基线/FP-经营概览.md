# 迁移基线 · 经营概览（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-dash`「经营概览」（HTML 第 190–230 行区域）
> 目标系统：`apps/admin-web/src/pages/DashboardPage.tsx` + `ops/WeeklyReportPage.tsx` + `bff/routes/report.js`
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　最近更新：2026-10-13（阶段 27，15/15 收官）　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/迁移颗粒度规范.md`
>
> ✅ 阶段 13（2026-10-10）按 W1 只读速补补齐 **FP-DASH-01 / 06 / 07 / 11** 共 4 项；
> **FP-DASH-08 因缺数据源保留 ⬜**（快照销售记录无 discount 字段，见下表处置列）。
>
> ✅ 阶段 19（2026-10-13）按「未阻塞只读项」补齐 **FP-DASH-05 / FP-DASH-15** 共 2 项：
> FP-DASH-05 真实销售毛利率（BFF `report.js` 复用 `export.js` 的 `dishCostMap`/`dishResolver`/`costOfDish`
> 算区间食材成本，`(营收−成本)/营收`，前端 `kpis` 动态渲染并带「食材成本 ¥X（区间）」副标；
> 经核查当前前端无该 MOCK 假值，KPI 全部由后端下发）；
> FP-DASH-15 近30天菜品毛利排行 Top12（份数/营收/毛利额/毛利率，`report.js` `top_dishes`，复用 `near30Agg`+`dishCostMap`）。
> 注：`near30Agg` 同步修正——真实快照销售行内无 `amount`（金额在记录级），原实现取行级 `amount` 致 `rev` 恒为 0，
> 现已回落记录级 `amount`，FP-DISH-11/12 真实数据毛利额一并修好（fixture 不受影响）。
>
> ✅ 阶段 20（2026-10-13）落地 ADR-008 销售应收模型，补齐 **FP-DASH-02 / 03 / 04 / 08** 共 4 项
> （`docs/关键路径-销售应收模型-推行指令.md` Phase A）：
> 新增 `bff/lib/sales_model.js` 为**唯一口径源**（防御性取值 + 派生欠款，不造 MOCK、不落派生值），
> `bff/routes/report.js` 店级聚合四张卡（应收按单日期 / 实收按收款日期 / 欠款累计 / 折扣按单日期），
> 前端 `DashboardPage.tsx` KPI 卡自动出现且「未收欠款 > 0」副标标红；作废单不计入四个口径。
>
> ✅ 阶段 27（2026-10-13）补齐最后 4 项（**本页 15/15 收官**）：
> **FP-DASH-10** 近14天应收/实收双柱图（`sales_model.dailySeries()` + 前端 `DailyBars` 手绘 SVG，几何/配色逐式照抄旧版）；
> **FP-DASH-12** 低库存行「去采购」→ 采购管理页并带原料进采购单草稿（路由 state + `OrderFormModal.prefillIngId`）；
> **FP-DASH-13** 未收账款（客户挂账）列表（`sales_model.unpaidSales()`）；
> **FP-DASH-14** 行内「收款」→ 复用销售收银页 `SalePayModal`（`sale.pay` 队列）。
> 验证：`scripts/smoke-dash-kpi.js` 真机冒烟 **70/70 通过**（含两张新卡的接口层独立重算 + 页面层 DOM 断言 +
> 「去采购」端到端跳转/预填/未提交零写库）。

---

## 功能点清单

| FP ID | 功能点 | 旧版证据 | 新版现状 | 状态 | 处置 / 关联 |
|---|---|---|---|---|---|
| FP-DASH-01 | 切换统计周期（近7天/近30天/全部）并显示区间文字 | HTML:194-198 `#dashRange` chips、:1224 点击处理、:1235 `dashDateTip` | `DashboardPage.tsx` 周期 chips 3 个（默认「近30天」= 旧版 `DASH_R=30` :1221）+ 区间文字（旧版 `dashDateTip`）；`bff/routes/report.js` `?range=7\|30\|all`，区间 = [date-(r-1), date]，营收/订单数/客单价/采购应付按区间聚合 | ⬆️ 已移植 | 阶段 13。热度/晨报/打烊/保本达成**仍按当日**（旧版同样不随 `DASH_R` 变）；程序化调用（agent/inbox）不传 range 时保持既有当日口径（`range='1'`） |
| FP-DASH-02 | 查看「应收合计（按单日期）」KPI | HTML:1246、`renderDash()` :1234 | KPI 卡「应收合计（按单日期（本期））」：`bff/routes/report.js` `deriveReport` 调 `lib/sales_model.js` `summarize({from:区间下界,to:截止日})`，Σ 区间内 `sales[].receivable`（缺字段回退 `amount`） | ⬆️ 已移植 | 阶段 20（ADR-008 §2.2）。口径唯一出口在 BFF；前端只渲染，`DashboardPage.tsx` `kpis[]` 动态出现 |
| FP-DASH-03 | 查看「实收合计（按收款日期）」KPI | HTML:1247、`paymentsIn()` :1231 | KPI 卡「实收合计（按收款日期（本期））」：Σ 区间内 `payments[].date ∈ [下界, 截止日]` 的 `amount`（字段缺失回退「全额即收、收款日=单日期」） | ⬆️ 已移植 | 阶段 20（ADR-008 §2.3）。分次收款（FP-SALE-11）的多条 payments 各自按收款日归属 |
| FP-DASH-04 | 查看「未收欠款（累计）」KPI | HTML:1248、`saleDebt()` 汇总 | KPI 卡「未收欠款」：Σ 全部单 `max(0, receivable − Σpayments)`，**不设区间上界**（累计口径），副标「累计未收 / 已全部收讫」 | ⬆️ 已移植 | 阶段 20（ADR-008 §2.4）。欠款是**派生值，不落快照**；>0 时前端副标标红 |
| FP-DASH-05 | 查看「销售毛利率」KPI（含成本副标） | HTML:1249 `gm=(recv-cost)/recv` | 无实际数据：仅前端 MOCK 有 `gross_margin`（`DashboardPage.tsx`:30）；BFF 真实 kpis 无该字段（report.js:338-345） | ⬆️ 已移植 | 阶段 19。BFF `report.js` `deriveReport` 复用 `export.js` 的 `dishCostMap`/`dishResolver`/`costOfDish` 算区间食材成本，`毛利率=(营收−成本)/营收`，前端 `kpis` 动态渲染并带「食材成本 ¥X（区间）」副标；经核查当前前端无该 MOCK 假值（KPI 由后端下发） |
| FP-DASH-06 | 查看「采购应付（本期）」KPI | HTML:1243/1250 `DB.recv` 本期 payable 汇总 | KPI 卡「采购应付（本期）」：`bff/routes/report.js` `payableIn`（Σ 区间内有效进货单 `payable ?? amount`） | ⬆️ 已移植 | 阶段 13。口径**比旧版更严**：新增排除草稿/待验/取消/作废（旧版不过滤状态）；打烊入库统计同步复用同一 `isInboundEffective()`，两处口径同源 |
| FP-DASH-07 | 查看「库存总值」KPI | HTML:1244/1251 `stockValue()` | KPI 卡「库存总值」：`bff/routes/report.js` `stockValueOf()`（Σ 库存 × 均价，与 `pages/inventory/utils.ts`:36 同口径，已落地于 `StockPage.tsx`/`LedgerPage.tsx`） | ⬆️ 已移植 | 阶段 13。**时点值，不随统计周期变化**（旧版 `stockValue()` 同样不进 `inRange`）；含停用原料（照抄旧版不加 `on` 过滤） |
| FP-DASH-08 | 查看「折扣/抹零（本期）」KPI | HTML:1241/1252 | KPI 卡「折扣/抹零（本期（按单））」：Σ 区间内 `sales[].discount`（缺字段回退 0） | ⬆️ 已移植 | 阶段 20（ADR-008 §2.5）。**折扣为 0 是「按数据算出来为 0」，不是写死 ¥0 假卡**（阶段 13「不先上假卡」结论仍成立）；真实 `discount` 进来后同一聚合自动生效 |
| FP-DASH-09 | 查看「低库存预警」KPI（种数） | HTML:1253 `lowStocks()`、空态文案 :1285 | `DashboardPage.tsx`:388-425 预警卡 + `bff/routes/report.js`:257 真实生成「库存告急 N 项」 | ⬆️ 已移植 | 验证：打开经营看板 → 预警卡出现「库存告急 N 项：…」 |
| FP-DASH-10 | 每日应收 vs 实收 14 天双柱图（含当日新增欠款红点） | HTML:1258-1278 `#chartDaily` SVG、:207-211 图例 | 「每日应收 vs 实收（近14天）」卡（`DashboardPage.tsx` `DailyBars`）：14 天双柱 + 4 等分网格线/千元刻度 + 图例（应收 `#3D7EA6` / 实收 `#1E8E5A` / 当日新增欠款红点 `#D93025`，逐式照抄旧版几何 `W620 H210 PL44 PB38 PT16`）；`daily_series` 由 `bff/lib/sales_model.js` `dailySeries(sales,date,14)` 下发（末位=看板所选截止日，旧版为今天） | ⬆️ 已移植 | 阶段 27。逐日口径与四张卡同源（应收按单日期 / 实收按收款日期），作废单不计入；红点判据照抄旧版「当日应收 − 当日实收 > 1 元」（HTML:1275）；不随统计周期 chips 变化（旧版同为固定 14 天） |
| FP-DASH-11 | 低库存预警明细列表（原料/现存/安全线对比，>12 条截断提示） | HTML:1280-1285 `#lowStockBox` | 「库存预警（低于安全线 · N 种）」卡（`DashboardPage.tsx`）：`名称 [分类]` / `现存 X 单位` / `安全 Y 单位`，超 12 条截断并提示「等 N 种，详见「原料库存」」；`report.js` `lowStockItems()` 补 `id/cat/unit` 与 `on===false` 过滤，下发 `low_stock:{total,items}` | ⬆️ 已移植 | 阶段 13。行内「去采购」跳转由阶段 27 补齐（FP-DASH-12） |
| FP-DASH-12 | 低库存行「去采购」跳转并带该原料进采购单草稿 | HTML:1283 `data-poing`、:1312 → `openOrder()` | 低库存行内「去采购」链接（`data-poing`）→ `navigate('/inventory/purchase',{state:{poIng}})`；`PurchasePage` 读路由 state 自动打开新建采购单（`OrderFormModal` `prefillIngId`），首行 = 该原料（`qty=conv\\|\\|1`、`price=last\\|\\|avg`，照抄旧版 presetIng HTML:1560）；提交仍走 `po.create` 审批队列（不改账面） | ⬆️ 已移植 | 阶段 27。用完即 `replace` 清掉路由 state，避免刷新/回退重复弹窗；原料无 id 时按钮禁用 |
| FP-DASH-13 | 未收账款（客户挂账）列表 | HTML:1288-1293 `#recvBox` | 「未收账款（客户挂账 · N 单 · 欠款合计）」卡：单据（单号后 8 位 · 日期 + 备注/渠道）/ 应收 / 欠款 / 收款；`debt_sales` 由 `sales_model.unpaidSales()` 下发（`debt>0.01`、按单日期倒序、作废单排除），空态「暂无挂账欠款 ✅」 | ⬆️ 已移植 | 阶段 27。三数派生自 `lib/sales_model.js`，与「未收欠款」KPI 同源；前端只渲染不复算 |
| FP-DASH-14 | 未收账款行内「收款」登记 | HTML:1313 `data-get` → `openGet('S',…)` | 行内「收款」→ 复用销售收银页同一 `SalePayModal`（`sale.pay` 审批队列）：只追加 `payments[]`，欠款实时派生 | ⬆️ 已移植 | 阶段 27。收款执行器与弹窗为阶段 20 既有实现，本次只接概览页入口，不另写收款逻辑 |
| FP-DASH-15 | 菜品毛利排行（近30天 Top12：份数/营收/毛利/毛利率） | HTML:1294-1307 `#topDish` | 无。仅有「菜品类型营收/毛利占比（静态价盘）」`WeeklyReportPage.tsx`:300，非单菜近30天排行 | ⬆️ 已移植 | 阶段 19。`report.js` `deriveReport` 下发 `top_dishes`（Top12，复用 `near30Agg`+`dishCostMap`，按毛利额降序）；前端 `DashboardPage.tsx` 新增表格卡 |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 15 |
| ⬆️ 已移植 | 15 |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 0 |
| ⚰️ 废弃 | 0 |

**结论**：阶段 13（2026-10-10）按 W1 只读速补补齐 4 项（周期切换 / 采购应付 / 库存总值 /
低库存明细），阶段 19（2026-10-13）补齐 **FP-DASH-05 真实毛利率 / FP-DASH-15 菜品毛利排行** 2 项，
阶段 20（2026-10-13）按 ADR-008 销售应收模型补齐 **FP-DASH-02 / 03 / 04 / 08** 4 项
（应收按单日期、实收按收款日期、欠款累计派生、折扣按单日期），阶段 27（2026-10-13）补齐最后 4 项
**FP-DASH-10 / 12 / 13 / 14**（14 天应收实收双柱图、低库存「去采购」带原料进采购单草稿、
未收账款挂账列表、行内收款登记），**15 项全部 ⬆️ 已移植**。
老板开屏「应收 / 实收 / 欠款 / 折扣抹零」四张卡已全部出数（真实快照缺字段时按
「应收=amount、折扣=0、全额即收」的回退口径算出来，非 MOCK）；14 天双柱图与挂账清收同源
`lib/sales_model.js`。

> ⚠️ **已解除的旧风险**：FP-DASH-05 毛利率曾标注「前端 MOCK 假值掩盖缺口」。经核查当前
> `DashboardPage.tsx` 的 KPI 全部由后端 `kpis[]` 动态下发、无硬编码毛利率，阶段 19 已由 BFF 出真实值
> （区间食材成本来自 `dishCostMap`+`dishResolver`，`毛利率=(营收−成本)/营收`），该「假数据」风险已消除。

## 建议补齐顺序

1. ~~**FP-DASH-07** 库存总值（只读聚合、无写风险）~~ → 阶段 13 ✅
2. ~~**FP-DASH-06 / 08** 采购应付、折扣（同批只读）~~ → 06 ✅（阶段 13）；08 ✅（阶段 20，随第 4 项的销售应收模型）
3. ~~**FP-DASH-01** 周期切换（后面所有区间口径的**前置**）~~ → 阶段 13 ✅
4. ~~**FP-DASH-02 / 03 / 04 / 08** 应收 / 实收 / 欠款 / 折扣~~ → ✅ **阶段 20**
   （先落地 ADR-008 销售应收模型：新增 `bff/lib/sales_model.js` 唯一口径源，
   `report.js` 防御性取值出数；`sales[]` 的 `discount/receivable/payments` 由
   FP-SALE-07/11 的写侧执行器（`bff/lib/algorithms/sale.js`）写入，真实数据进来后同一聚合自动生效）
5. ~~**FP-DASH-10 / 15** 14 天双柱图与毛利排行~~ → **15 ✅（阶段 19，纯只读）**；
   **10 ✅（阶段 27，纯只读）**：`sales_model.dailySeries(sales,date,14)` 逐日切区间，前端手绘 SVG
6. ~~**FP-DASH-11**~~ ✅（阶段 13）→ ~~剩 **FP-DASH-12** 去采购跳转~~ ✅ 阶段 27
7. ~~**FP-DASH-13 / 14** 挂账与收款~~ → ✅ **阶段 27**（列表由 `sales_model.unpaidSales()` 派生，
   14 的「收款」入口直接复用销售收银页 `SalePayModal` + `sale.pay` 执行器）
8. ~~**FP-DASH-05** 真实毛利率（同时清掉 MOCK）~~ → ✅ 阶段 19（经核查前端本无 MOCK，BFF 已出真实值）

**本页已全部闭合（15/15）。**

> 口径提示：阶段 13 已定「统计周期 = [截止日-(r-1), 截止日]」，上界取 `date` 是相对旧版
> （`inRange` 无上界）的**有意收敛**，避免未来日期混入；后续所有区间口径沿用此定义。

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- 与 FP-SALE（销售收银）强耦合：应收/实收/欠款三口径是同一套数据模型，**阶段 20 已与 FP-SALE-07/08/11 同批落地**（唯一口径源 `bff/lib/sales_model.js`）。
- 清理前端 MOCK 假数据：阶段 19 已核查 `DashboardPage.tsx` KPI 全部由后端下发、无硬编码毛利率，BFF 已出真实值，看板不再假绿（原备注已失效）。
