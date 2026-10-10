# 迁移基线 · 经营概览（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-dash`「经营概览」（HTML 第 190–230 行区域）
> 目标系统：`apps/admin-web/src/pages/DashboardPage.tsx` + `ops/WeeklyReportPage.tsx` + `bff/routes/report.js`
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　最近更新：2026-10-10（阶段 13）　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/迁移颗粒度规范.md`
>
> ✅ 阶段 13（2026-10-10）按 W1 只读速补补齐 **FP-DASH-01 / 06 / 07 / 11** 共 4 项；
> **FP-DASH-08 因缺数据源保留 ⬜**（快照销售记录无 discount 字段，见下表处置列）。

---

## 功能点清单

| FP ID | 功能点 | 旧版证据 | 新版现状 | 状态 | 处置 / 关联 |
|---|---|---|---|---|---|
| FP-DASH-01 | 切换统计周期（近7天/近30天/全部）并显示区间文字 | HTML:194-198 `#dashRange` chips、:1224 点击处理、:1235 `dashDateTip` | `DashboardPage.tsx` 周期 chips 3 个（默认「近30天」= 旧版 `DASH_R=30` :1221）+ 区间文字（旧版 `dashDateTip`）；`bff/routes/report.js` `?range=7\|30\|all`，区间 = [date-(r-1), date]，营收/订单数/客单价/采购应付按区间聚合 | ⬆️ 已移植 | 阶段 13。热度/晨报/打烊/保本达成**仍按当日**（旧版同样不随 `DASH_R` 变）；程序化调用（agent/inbox）不传 range 时保持既有当日口径（`range='1'`） |
| FP-DASH-02 | 查看「应收合计（按单日期）」KPI | HTML:1246、`renderDash()` :1234 | 无。BFF 真实 kpis 仅 营收/订单数/客单价/菜品SKU/原料SKU/会员数/快照rev/销售记录总数（`bff/routes/report.js`:338-345），无应收口径 | ⬜ 待补 | 读类；依赖销售单实收/应收口径，**先定口径再补** |
| FP-DASH-03 | 查看「实收合计（按收款日期）」KPI | HTML:1247、`paymentsIn()` :1231 | 无（同上，report.js 无收款日期聚合） | ⬜ 待补 | 读类；随 FP-DASH-02 |
| FP-DASH-04 | 查看「未收欠款（累计）」KPI | HTML:1248、`saleDebt()` 汇总 | 无。admin-web 仅进货单侧「有欠款」标签（`InboundPage.tsx`:260），无客户挂账维度 | ⬜ 待补 | 读类；与 FP-DASH-13/14 同批 |
| FP-DASH-05 | 查看「销售毛利率」KPI（含成本副标） | HTML:1249 `gm=(recv-cost)/recv` | 无实际数据：仅前端 MOCK 有 `gross_margin`（`DashboardPage.tsx`:30）；BFF 真实 kpis 无该字段（report.js:338-345） | ⬜ 待补 | 读类；**MOCK 掩盖缺口**，需在 BFF 侧出真实毛利率 |
| FP-DASH-06 | 查看「采购应付（本期）」KPI | HTML:1243/1250 `DB.recv` 本期 payable 汇总 | KPI 卡「采购应付（本期）」：`bff/routes/report.js` `payableIn`（Σ 区间内有效进货单 `payable ?? amount`） | ⬆️ 已移植 | 阶段 13。口径**比旧版更严**：新增排除草稿/待验/取消/作废（旧版不过滤状态）；打烊入库统计同步复用同一 `isInboundEffective()`，两处口径同源 |
| FP-DASH-07 | 查看「库存总值」KPI | HTML:1244/1251 `stockValue()` | KPI 卡「库存总值」：`bff/routes/report.js` `stockValueOf()`（Σ 库存 × 均价，与 `pages/inventory/utils.ts`:36 同口径，已落地于 `StockPage.tsx`/`LedgerPage.tsx`） | ⬆️ 已移植 | 阶段 13。**时点值，不随统计周期变化**（旧版 `stockValue()` 同样不进 `inRange`）；含停用原料（照抄旧版不加 `on` 过滤） |
| FP-DASH-08 | 查看「折扣/抹零（本期）」KPI | HTML:1241/1252 | 无（report.js 无 discount 聚合） | ⬜ 待补 | 读类。**阶段 13 复核：缺数据源，非前端工作量**——快照 `sales[]` 仅 `amount/qty/date/hour/channel/method`，无 `discount`/`receivable`/`payments`（这些是旧版 sales 才有的字段）；须与 FP-SALE-07/08/11、FP-DASH-02/03/04 同批建模。**不先上 ¥0 假卡**（会被读成「本期无折扣」） |
| FP-DASH-09 | 查看「低库存预警」KPI（种数） | HTML:1253 `lowStocks()`、空态文案 :1285 | `DashboardPage.tsx`:388-425 预警卡 + `bff/routes/report.js`:257 真实生成「库存告急 N 项」 | ⬆️ 已移植 | 验证：打开经营看板 → 预警卡出现「库存告急 N 项：…」 |
| FP-DASH-10 | 每日应收 vs 实收 14 天双柱图（含当日新增欠款红点） | HTML:1258-1278 `#chartDaily` SVG、:207-211 图例 | 无。新版仅有「时段热力（迷你）」今日分时段订单（`DashboardPage.tsx`:311-340），口径不同 | ⬜ 待补 | 读类；需 14 天应收/实收双序列数据 |
| FP-DASH-11 | 低库存预警明细列表（原料/现存/安全线对比，>12 条截断提示） | HTML:1280-1285 `#lowStockBox` | 「库存预警（低于安全线 · N 种）」卡（`DashboardPage.tsx`）：`名称 [分类]` / `现存 X 单位` / `安全 Y 单位`，超 12 条截断并提示「等 N 种，详见「原料库存」」；`report.js` `lowStockItems()` 补 `id/cat/unit` 与 `on===false` 过滤，下发 `low_stock:{total,items}` | ⬆️ 已移植 | 阶段 13。行内「去采购」跳转属 FP-DASH-12（写类，未做） |
| FP-DASH-12 | 低库存行「去采购」跳转并带该原料进采购单草稿 | HTML:1283 `data-poing`、:1312 → `openOrder()` | 无。补货建议独立在 `RestockPage.tsx`，概览页无跳转入口 | ⬜ 待补 | 写类：生成采购草稿须走 `/api/actions` 审批队列 |
| FP-DASH-13 | 未收账款（客户挂账）列表 | HTML:1288-1293 `#recvBox` | 无（admin-web 无挂账/应收账款对象） | ⬜ 待补 | 读类 |
| FP-DASH-14 | 未收账款行内「收款」登记 | HTML:1313 `data-get` → `openGet('S',…)` | 无 | ⬜ 待补 | 写类：走 `/api/actions` 审批队列 |
| FP-DASH-15 | 菜品毛利排行（近30天 Top12：份数/营收/毛利/毛利率） | HTML:1294-1307 `#topDish` | 无。仅有「菜品类型营收/毛利占比（静态价盘）」`WeeklyReportPage.tsx`:300，非单菜近30天排行 | ⬜ 待补 | 读类 |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 15 |
| ⬆️ 已移植 | 5 |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 10 |
| ⚰️ 废弃 | 0 |

**结论**：阶段 13（2026-10-10）按 W1 只读速补补齐 4 项（周期切换 / 采购应付 / 库存总值 /
低库存明细），15 项中 **5 项已移植**；老板开屏一屏仍缺应收 / 实收 / 欠款 / 毛利率 / 折扣抹零
——其中应收类（02/03/04）与折扣类（08）**卡在同一个数据缺口**：快照销售记录只有
`amount/qty`，没有 `discount/receivable/payments`，须与 FP-SALE 同批建模。

> ⚠️ **特别风险**：FP-DASH-05 毛利率在前端 **MOCK** 里有值，但 BFF 真实 kpis 无该字段。
> 这属于「假数据掩盖缺口」——页面看着有，实际是编的。**禁止**以「页面显示正常」判定已迁移。

## 建议补齐顺序

1. ~~**FP-DASH-07** 库存总值（只读聚合、无写风险）~~ → 阶段 13 ✅
2. ~~**FP-DASH-06 / 08** 采购应付、折扣（同批只读）~~ → 06 ✅（阶段 13）；
   **08 缺数据源**，须随第 4 项的销售模型一起做
3. ~~**FP-DASH-01** 周期切换（后面所有区间口径的**前置**）~~ → 阶段 13 ✅
4. **FP-DASH-02 / 03 / 04 / 08** 应收 / 实收 / 欠款 / 折扣（**先建销售应收模型**：
   快照 `sales[]` 需补 `discount/receivable/payments`，与 FP-SALE-07/08/11 同批）
5. **FP-DASH-10 / 15** 14 天双柱图与毛利排行（图表工作量最大；需第 4 项的应收/实收序列）
6. ~~**FP-DASH-11**~~ ✅（阶段 13）→ 剩 **FP-DASH-12** 去采购跳转（写类，走审批队列）
7. **FP-DASH-13 / 14** 挂账与收款（依赖第 4 项模型，**最重**）
8. **FP-DASH-05** 真实毛利率（同时清掉 MOCK）

> 口径提示：阶段 13 已定「统计周期 = [截止日-(r-1), 截止日]」，上界取 `date` 是相对旧版
> （`inRange` 无上界）的**有意收敛**，避免未来日期混入；后续所有区间口径沿用此定义。

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- 与 FP-SALE（销售收银）强耦合：应收/实收/欠款三口径是同一套数据模型，建议**与 FP-SALE-07/08/11 同批设计**。
- 清理前端 MOCK 假数据属**独立任务**，应与 FP-DASH-05 一并排期（否则看板持续假绿）。
