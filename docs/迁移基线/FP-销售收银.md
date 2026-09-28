# 迁移基线 · 销售收银（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-sale`「销售收银」（HTML 第 467–501 行区域）
> 目标系统：**admin-web 无对应页面**；仅移动端 `apps/android-app/.../features/pos/PosScreen.kt` 覆盖子集 + `bff/lib/algorithms/pos.js`
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/迁移颗粒度规范.md`
>
> ⚠️ **该页在新系统无对应页面，属整页缺失**（仅移动端收银覆盖了「点菜 + 全额收款」一个子集）。

---

## 功能点清单

| FP ID | 功能点 | 旧版证据 | 新版现状 | 状态 | 处置 / 关联 |
|---|---|---|---|---|---|
| FP-SALE-01 | 录入销售单（日期/渠道/菜品明细/数量/单价，确认） | HTML:471 `#btnNewSale`、:4337 `openSale` :4394、保存 :4454-4473 | `PosScreen.kt`:195-204 加减菜、:984-1098 结账页；算法 `bff/lib/algorithms/pos.js`:620 `pos.pay … sales=` | ⬆️ 已移植 | 仅移动端：App 收银 → 点菜 →「确认收款」。admin-web 无；且无应收≠实收、无折扣、无挂账、无美团渠道标记 |
| FP-SALE-02 | 销售单自动按配方扣减库存（确认并出库） | HTML:4473 `rebuildStock()`、:4428 未配配方告警 | `bff/lib/algorithms/pos.js`:3「POS/收银 + BOM 扣料」、:620 apply_pos_pay | ⬆️ 已移植 | 验证：App 结账后 /inventory/ledger 出现销售出库流水 |
| FP-SALE-03 | 导入平台销售（xlsx/csv/json，预览后写入、按单号去重） | HTML:472 `#btnSaleImport`、:4916-4917 → `previewSaleImport` :4709、`commitSaleImport` :4676、:4669 去重 | 无（BFF 无销售导入端点，仅 `POST /api/snapshot/push` 整包快照） | ⬜ 待补 | 写类：建议动作 + `/api/actions`；需先定「平台数据谁导入」 |
| FP-SALE-04 | 查看/撤回导入批次 | HTML:474 `#btnSaleBatches`、:4920 → `openSaleBatches` :4807、`delSaleBatch` :4797 | 无 | ⬜ 待补 | 随 FP-SALE-03；撤回须走审批队列并留痕 |
| FP-SALE-05 | 金额口径重算（A–E 五种口径切换后整批重算） | HTML:475 `#btnSaleRecalc`、口径定义 :4497、`openSaleAmtRecalc` :4839、`applySaleAmtRecalc` :4822、`resolveSaleAmt` :4542 | 无 | ⬜ 待补 | 写类：重算结果走建议动作入队 |
| FP-SALE-06 | 菜名映射（平台菜名 → 本店菜品 + 倍数） | HTML:476 `#btnAliasMap`、:4922 → `openAliasMap` :4877、`setDishAlias` :4535 | 无 | ⬜ 待补 | 读+写：映射表独立于 DB，建议配置化 |
| FP-SALE-07 | 销售单列表（单号/渠道/应收/实收/欠款/食材成本/毛利率/状态） | HTML:490-497 表头、`renderSale` :4351-4374 | 无（BFF `data.sales` 仅被 `/api/modules/analysis` 聚合，无销售单列表端点） | ⬜ 待补 | 只读聚合展示，**优先**（营收/欠款口径的唯一出口） |
| FP-SALE-08 | 顶部 KPI 卡（本月应收/累计实收/未收欠款/累计毛利率） | HTML:469 `#saleKpi`、`renderSaleKpi` :4338-4350 | 无（`DashboardPage.tsx`:230-283 是保本卡，非应收实收） | ⬜ 待补 | 只读聚合，**成本最低** |
| FP-SALE-09 | 渠道筛选（堂食/外卖/美团外卖） | HTML:478-481 `#saleChFilter`、`renderSale` :4354 | 无（`/dinein/orders` 外卖订单浏览 `ModuleBrowsePage.tsx`:120-150，数据源与口径不同） | ⬜ 待补 | 随 FP-SALE-07 |
| FP-SALE-10 | 状态筛选（有欠款/已结清） | HTML:483-485 `#saleStFilter`、`renderSale` :4355 | 无 | ⬜ 待补 | 随 FP-SALE-07 |
| FP-SALE-11 | 分次收款（登记后续收款，应收 − 实收 = 欠款） | HTML:4371 `data-get` → `openGet('S',id)` :2055、:1313 绑定 | 无（Android 仅一次性全额收款 `PosScreen.kt`:1089-1096） | ⬜ 待补 | **业务闭环（欠款清收），高优先**；走审批队列 |
| FP-SALE-12 | 编辑销售单 | HTML:4372 `data-saleedit` → `openSale` :4394 | 无 | ⬜ 待补 | 改为「编辑建议动作」入队 |
| FP-SALE-13 | 删除销售单（回补库存、重算台账） | HTML:4373 `data-saledel` → `delSale` :4477-4482 | 无（移动端 `pos.void` 仅退菜单品 `pos.js`:564，非整单删除） | ⬜ 待补 | 作废留痕，禁物理删除 |
| FP-SALE-14 | 未配配方菜品告警（确认后不扣库存、成本按估算） | `openSale` 内 `sync()` :4437-4438 | 无 | ⬜ 待补 | 只读提示，随 FP-SALE-01 一并校验 |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 14 |
| ⬆️ 已移植 | 2（均**仅存在于移动端**，admin-web 无入口） |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 12 |
| ⚰️ 废弃 | 0 |

**结论**：销售收银是**缺口最大**的一页。admin-web 完全没有销售页；移动端只覆盖「点菜 + 全额收款」。
**应收/实收/欠款三口径、平台销售导入、分次收款全部缺失** → 老板看不到「谁欠我多少钱」。

## 建议补齐顺序

1. **FP-SALE-08** 应收/实收/欠款 KPI（只读、无红线）
2. **FP-SALE-07 / 09 / 10** 销售单列表与筛选（只读）
3. **FP-SALE-11** 分次收款（欠款清收闭环）
4. **FP-SALE-03 / 04 / 05 / 06** 平台导入链路（需先定职责边界：平台数据谁导入）
5. **FP-SALE-12 / 13** 编辑 / 作废（走队列、留痕）
6. **FP-SALE-14** 未配配方告警（提示类，成本极低）

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- 前置决策：**销售单在店内 POS 录还是云端 admin-web 录？** 未定之前 FP-SALE-01/07/12 不宜动手。
- 平价测试全绿属另一条门禁，不能替代本页面级清单。
