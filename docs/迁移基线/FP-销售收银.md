# 迁移基线 · 销售收银（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-sale`「销售收银」（HTML 第 467–501 行区域）
> 目标系统：`apps/admin-web/src/pages/dinein/SalesPage.tsx`（阶段 20 起）+ `bff/routes/report.js`、`bff/routes/export.js`、`bff/lib/sales_model.js`、`bff/lib/algorithms/sale.js`；移动端 `apps/android-app/.../features/pos/PosScreen.kt` + `bff/lib/algorithms/pos.js`
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　最近更新：2026-10-13（阶段 20）　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/迁移颗粒度规范.md`
>
> ✅ **阶段 20 前为整页缺失，现已补上**：admin-web 新增「销售收银」页（列表/KPI/筛选/分次收款/作废）。
>
> ✅ **前置决策已定案（2026-10-12）**：销售单录入职责边界见 `ADR-009`（销售端录销售单，统一走标准业务处理队列，与进货单状态机一致）；应收/实收/欠款口径见 `ADR-008`（应收按单日期、实收按收款日期、欠款=应收−实收）。
>
> ✅ **阶段 20（2026-10-13）落地 ADR-008/009 销售应收模型**，补齐 **FP-SALE-07 / 08 / 09 / 10 / 11** 共 5 项
> （`docs/关键路径-销售应收模型-推行指令.md` Phase B），本页**不再整页缺失**：
> · 只读层：`bff/lib/sales_model.js`（唯一口径源）+ `GET /api/admin/sales`（销售单列表行级）+ `report.js`（顶部 KPI 店级）；
> · 写侧：`bff/lib/algorithms/sale.js` 三个执行器 `sale.create / sale.pay / sale.void` 已在 `registry.js` 注册，
>   走 `/api/actions` 统一队列（未注册即 need-manual；rev 乐观锁 409；作废留痕不物理删除）；
> · 前端：新增 `apps/admin-web/src/pages/dinein/SalesPage.tsx`（销售单列表 + 顶部 KPI + 渠道/状态筛选）
>   与 `SalePayModal.tsx`（分次收款），菜单 `/dinein/sales`「销售收银」。

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
| FP-SALE-07 | 销售单列表（单号/渠道/应收/实收/欠款/食材成本/毛利率/状态） | HTML:490-497 表头、`renderSale` :4351-4374 | `GET /api/admin/sales`（`routes/admin.js` → `routes/export.js` `salesList`）+ `pages/dinein/SalesPage.tsx` 表格：单号/日期/渠道/明细/售价合计/折扣/应收/实收/欠款/毛利率/状态；状态由 `sales_model.statusOf` 派生（已作废/有欠款/已结清） | ⬆️ 已移植 | 阶段 20。营收/欠款**口径唯一出口**在 `lib/sales_model.js`，前端只渲染不复算 |
| FP-SALE-08 | 顶部 KPI 卡（本月应收/累计实收/未收欠款/累计毛利率） | HTML:469 `#saleKpi`、`renderSaleKpi` :4338-4350 | `SalesPage.tsx` 顶部 KPI 卡取 `report.js` 下发的「应收合计 / 实收合计 / 未收欠款 / 销售毛利率」四张，**复用既有聚合不另算**；周期 chips 7/30/all（默认 30），区间文字随 `range_label` | ⬆️ 已移植 | 阶段 20（ADR-008 §2.2/2.3「单日期 vs 收款日期」口径）。未收欠款 > 0 时副标标红 |
| FP-SALE-09 | 渠道筛选（堂食/外卖/美团外卖） | HTML:478-481 `#saleChFilter`、`renderSale` :4354 | `SalesPage.tsx` 渠道下拉：选项由列表 `channel` 去重生成（含真实出现的渠道），默认「全部」 | ⬆️ 已移植 | 阶段 20，随 FP-SALE-07。旧版固定三选项，新版按数据生成（更严） |
| FP-SALE-10 | 状态筛选（有欠款/已结清） | HTML:483-485 `#saleStFilter`、`renderSale` :4355 | `SalesPage.tsx` 状态下拉（全部/有欠款/已结清/已作废） | ⬆️ 已移植 | 阶段 20，随 FP-SALE-07。新增「已作废」选项（作废留痕后可查） |
| FP-SALE-11 | 分次收款（登记后续收款，应收 − 实收 = 欠款） | HTML:4371 `data-get` → `openGet('S',id)` :2055、:1313 绑定 | `SalePayModal.tsx` 登记收款 → `POST /api/actions`（`sale.pay`）→ 审批 → `bff/lib/algorithms/sale.js` `applySalePay` **只追加 `payments[]`**、不动 `receivable`；欠款 = 应收 − Σ收款 实时派生 | ⬆️ 已移植 | 阶段 20（ADR-009 统一队列）。超额/重复提交被服务端拒绝（0 < amt ≤ 欠款+0.01）；已作废单不可收款 |
| FP-SALE-12 | 编辑销售单 | HTML:4372 `data-saleedit` → `openSale` :4394 | 无 | ⬜ 待补 | 改为「编辑建议动作」入队 |
| FP-SALE-13 | 删除销售单（回补库存、重算台账） | HTML:4373 `data-saledel` → `delSale` :4477-4482 | 「作废留痕、禁物理删除」**已落地**：`sale.void` 执行器（`sale.js` `applySaleVoid`，记作废人/时间/rev/trace，原单保留）+ `SalesPage.tsx` 行内「作废」入口；**「回补库存、重算台账」仍缺**（admin-web 侧销售单不扣料，回补只对移动端 POS 结账单有意义） | ⬜ 待补 | 作废半程已可用；库存回补须与移动端 POS BOM 扣料（`pos.js`）对齐后补，避免只回补不扣料一边倒 |
| FP-SALE-14 | 未配配方菜品告警（确认后不扣库存、成本按估算） | `openSale` 内 `sync()` :4437-4438 | `bff/routes/snapshot.js` markRecipeStatus 标记 `has_recipe` + App `PosScreen.kt` 挂单/结账确认弹窗告警 | ⬆️ 已移植 | 只读提示，随 FP-SALE-01 一并校验 |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 14 |
| ⬆️ 已移植 | 8（3 项仅移动端；阶段 20 起 5 项落在 admin-web 销售收银页） |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 6 |
| ⚰️ 废弃 | 0 |

**结论**：阶段 20 之前本页是**缺口最大**的一页（admin-web 无销售页、只有移动端「点菜 + 全额收款」）；
阶段 20 按 ADR-008/009 落地销售应收模型后，**应收/实收/欠款三口径与分次收款（欠款清收闭环）已打通**，
老板可以看到「谁欠我多少钱」。剩余 6 项集中两类：**平台销售导入链路**（FP-SALE-03/04/05/06，需先定
「平台数据谁导入」）与**单据编辑/删除**（FP-SALE-12/13，走队列 + 库存回补对齐）。

## 建议补齐顺序

1. ~~**FP-SALE-08** 应收/实收/欠款 KPI（只读、无红线）~~ → ✅ 阶段 20
2. ~~**FP-SALE-07 / 09 / 10** 销售单列表与筛选（只读）~~ → ✅ 阶段 20
3. ~~**FP-SALE-11** 分次收款（欠款清收闭环）~~ → ✅ 阶段 20
4. **FP-SALE-03 / 04 / 05 / 06** 平台导入链路（需先定职责边界：平台数据谁导入）
5. **FP-SALE-12 / 13** 编辑 / 作废（走队列、留痕；13 的「回补库存」须与 POS BOM 扣料对齐）
6. ~~**FP-SALE-01/02** 移动端录入与库存扣减~~ ✅（历史，仅移动端）
7. **FP-SALE-01（admin-web 侧）** 销售单录入 UI：执行器 `sale.create` 已注册可用，仅缺页面表单
   （旧版 `#btnNewSale`；随 FP-SALE-12 一并做，可复用 `sale.create` 的校验）

> ✅ **FP-SALE-14**（未配配方告警）已于阶段 19 落地（BFF 快照标记 `has_recipe` + App 挂单/结账告警），从待补清单移除。

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- 前置决策：~~销售单在店内 POS 录还是云端 admin-web 录？~~ **已解除**（ADR-009，批准人 William）：销售端录销售单、采购端录采购单，统一走标准业务处理队列，与进货单（ADR-004）状态机一致。应收/实收/欠款口径由 ADR-008 定案（应收按单日期、实收按收款日期）。
- 平价测试全绿属另一条门禁，不能替代本页面级清单。
