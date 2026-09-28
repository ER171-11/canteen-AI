# 迁移基线 · 结构测算（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-calc`「结构测算」（HTML 第 350–466 行区域，本页最大，参数项最多）
> 目标系统：**无独立测算页**；散落于 `apps/admin-web/src/pages/ops/WeeklyReportPage.tsx` + `DashboardPage.tsx`；算法在 `bff/lib/menu_baoben.js`（与旧版 `calc()` :4856 同公式），经 `GET /api/modules/analysis` 的 `baoben_summary` 出参（`bff/routes/modules.js`:1556-1579）
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/迁移颗粒度规范.md`
>
> ⚠️ **该页在新系统无独立页面**，测算能力被拆进「经营周报 / 看板」，**参数可调项从 20+ 项退化为 4 项——属半页缺失**。

---

## 功能点清单

| FP ID | 功能点 | 旧版证据 | 新版现状 | 状态 | 处置 / 关联 |
|---|---|---|---|---|---|
| FP-CALC-01 | 查看保本日营收（保本线） | HTML:433 公式、`renderCalcKpi` :3954 | `WeeklyReportPage.tsx`:228-232（kpi.be_day）、`DashboardPage.tsx`:246-252 | ⬆️ 已移植 | 验证：/ops/weekly 日保本卡、/dashboard 保本经营卡。仅静态价盘口径（`DashboardPage`:237-238 标「静态价盘」） |
| FP-CALC-02 | 查看保本达成率与月利润预测 | HTML:352 `#calcKpi`、`renderCalc` :4247 | `DashboardPage.tsx`:260-283、`WeeklyReportPage.tsx`:236-243 | ⬆️ 已移植 | 验证：看板保本卡 |
| FP-CALC-03 | 查看安全边际与边际贡献率 | HTML:374 `#vCM`、:441 图例「安全边际」 | `DashboardPage.tsx`:275-281 安全边际；边际贡献率仅后端有（`menu_baoben.js`:296-297）前端未出 | ⬆️ 已移植 | 部分：安全边际已出；边际贡献率列建议补（只读） |
| FP-CALC-04 | 调整固定成本参数（房租/物业/人工/装修设备摊销/水电/其他） | HTML:370 `#pFix`、`buildCalcParams` :3905、`calcModel` :3923 | 前端仅 面积/员工数/营业天数/目标利润（`WeeklyReportPage.tsx`:189-205）；后端全参数已备（`menu_baoben.js`:163-172） | ⬜ 待补 | 只读模拟层：把后端 DEFAULT_PARAMS 开放为表单；**不写库** |
| FP-CALC-05 | 调整变动成本率参数（酒水占比/酒水成本/包装/外卖佣金/营销/变动水电/杂费/手续费） | HTML:371 `#pVar`、:373 合计 | 无 | ⬜ 待补 | 同上；后端 varRate 已算（`menu_baoben.js`:214） |
| FP-CALC-06 | 调整运营口径（人均点菜份数/营业天数/餐位数/目标利润）与「恢复默认参数」 | HTML:355 `#calcResetParam`、:4314、:377 `#pOp` | 仅 days/target_profit（`WeeklyReportPage.tsx`:195-200）；餐位数、人均点菜数不可调；无恢复默认 | ⬜ 待补 | 前端开放 query 店参透传（`modules.js`:1557-1565 已支持 area/staff/days/target_profit） |
| FP-CALC-07 | 同步菜品主数据（按最新菜品/配方重置测算输入） | HTML:356 `#calcSync`、:4320、`syncCalc` :3870 | 无手动入口（后端自动合并 `menu_baoben.js`:316 `mergeDishesWithBaoben`） | ⬜ 待补 | 只读：加「按快照刷新」按钮即可 |
| FP-CALC-08 | 切换日销量口径（估算 / 近30天真实 / 近7天真实，含无销量回落估算开关） | HTML:358-364 `#scQMode`/`#scQFb`、:4324 | 无（新版用静态价盘 daily_qty） | ⬜ 待补 | 只读聚合；真实销量需 `/api/modules/analysis` realAnalysis 的 sales 聚合支撑 |
| FP-CALC-09 | 逐菜结构表（成本/售价/成本率/毛利率/日销量/日营收/日毛利额） | HTML:411-426、`renderCalcTable` :4043 | 无（周报仅类型级汇总表 `WeeklyReportPage.tsx`:300-336） | ⬜ 待补 | 只读展示，**优先**（老板看单菜毛利） |
| FP-CALC-10 | 表头排序（名称/类型/成本/售价/成本率/毛利率/销量/营收/毛利） | HTML:414-422 `sortable`、`calcSortedIdx` :4021 | 无（周报表格无 sorter） | ⬜ 待补 | 随 FP-CALC-09 |
| FP-CALC-11 | 行内改售价/成本/日销量并即时重算（本页模拟，不写库） | HTML:428 说明、`updateCalcRow` :4073、`renderCalcCharts` :4092 | 无（新版调价走审批队列**落库**，无模拟态） | ⬜ 待补 | **模拟层缺失**：需独立「推演态」参数集，不写配方/库存 |
| FP-CALC-12 | 取消勾选模拟下架该菜（SKU 精简对保本点影响） | HTML:428 说明、`updateCalcGroups` :4083 | 无模拟；真实下架走 `dish.set_active`（`WeeklyReportPage.tsx`:381-393） | ⬜ 待补 | 模拟态 + 真实动作分开，二者都要 |
| FP-CALC-13 | 按类型批量调价/调量/上架/恢复默认（−10%/−5%/+5%/+10%、±20%） | HTML:396-410 `data-bulk`、:4296 处理 | 无 | ⬜ 待补 | 批量走建议动作入队（写类） |
| FP-CALC-14 | 五类角色卡片与分类切换（引流/爆品/利润/形象/常规） | HTML:387 `#typeCards`、`renderCalcTypes` :3978、`renderCalcTabs` :4038 | 近似：四象限分布（波士顿口径）`WeeklyReportPage.tsx`:279-296，非五类角色 | ⬜ 待补 | 口径不同，**不构成等价**；建议保留五类角色视图 |
| FP-CALC-15 | 查看各类型「营收占比 vs 毛利占比」对比 | HTML:389-391 `#typeChart` | `WeeklyReportPage.tsx`:300-336（rev_share/gp_share 进度条表） | ⬆️ 已移植 | 验证：/ops/weekly 菜品类型表 |
| FP-CALC-16 | 日营收 vs 保本线图（含保本线、安全边际） | HTML:436-442 `#beChart`、`renderCalcCharts` :4092 | 无（仅近 7 日柱状趋势 `WeeklyReportPage.tsx`:249-278，无保本线） | ⬜ 待补 | 只读图表；后端 be_day 已出 |
| FP-CALC-17 | 月营收成本结构图（占营收 %） | HTML:445-447 `#costChart` | 无 | ⬜ 待补 | 只读图表；后端 kpi.var_rate/fixed_month 已有 |
| FP-CALC-18 | 客流情景模拟（爬坡/培育/当前/稳定/成熟 五档 × 分情景经营结果表） | HTML:450-459 `#sceneChart`/`#sceneTable`、`renderCalcScene` :4144 | 后端已算 scenes（`menu_baoben.js`:257-267、出参 :311），**前端未渲染** | ⬜ 待补 | 只读：后端已有，前端补表即可，**成本最低** |
| FP-CALC-19 | 查看结论与经营建议 | HTML:462-463 `#advice`、`renderCalcAdvice` :4212 | `WeeklyReportPage.tsx`:408-422（baoben advice）+ :339-407 建议清单 | ⬆️ 已移植 | 验证：/ops/weekly「保本价盘建议」。旧版建议维度更多（压固定成本/提量），建议扩充 |
| FP-CALC-20 | 逐菜调价/下架入审批队列（新版新增，替代旧版「模拟」） | 旧版无 | `WeeklyReportPage.tsx`:427-457（`dish.price`）、:381-393（`dish.set_active`） | ⬆️ 已移植 | 验证：点「执行·调价」→ /platform/actions 可见 |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 20 |
| ⬆️ 已移植 | 6（其中 1 项为新版新增能力：FP-CALC-20） |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 14 |
| ⚰️ 废弃 | 0 |

**结论**：算法层（保本公式）已忠实平移且后端已算出 scenes/边际贡献率等结果，
但**前端只渲染了其中 6 项**——「算得出但看不见」。最典型的浪费是 FP-CALC-18（后端已算，前端没渲）。

## 建议补齐顺序

1. **FP-CALC-18** 客流情景模拟（后端 scenes 已算，仅差渲染，成本最低）
2. **FP-CALC-04 / 05 / 06** 开放参数表单（后端全支持，前端透传即可）
3. **FP-CALC-09 / 10** 逐菜结构表 + 排序（只读）
4. **FP-CALC-16 / 17** 保本图 / 成本结构图
5. **FP-CALC-11 / 12 / 13** 模拟态与批量推演（需先定「模拟层不写库」的设计）
6. **FP-CALC-07 / 08 / 14** 同步、销量口径、五类角色

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- FP-CALC-11/12 的「模拟态」是**只读推演层**，禁止写回菜品/配方/库存（与 CHANGELOG v1.2.0「只读隔离」一致）。
- FP-CALC-14 的四象限与旧版五类角色**口径不同**，不得宣称等价替代。
