# 迁移基线 · 销售收银（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-sale`「销售收银」（HTML 第 467–501 行区域）
> 目标系统：`apps/admin-web/src/pages/dinein/SalesPage.tsx`（阶段 20 起）+ `bff/routes/report.js`、`bff/routes/export.js`、`bff/lib/sales_model.js`、`bff/lib/algorithms/sale.js`；移动端 `apps/android-app/.../features/pos/PosScreen.kt` + `bff/lib/algorithms/pos.js`
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　最近更新：2026-10-13（阶段 21）　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/规范/迁移颗粒度规范.md`
>
> ✅ **阶段 20 前为整页缺失，现已补上**：admin-web 新增「销售收银」页（列表/KPI/筛选/分次收款/作废）。
>
> ✅ **前置决策已定案（2026-10-12）**：销售单录入职责边界见 `ADR-009`（销售端录销售单，统一走标准业务处理队列，与进货单状态机一致）；应收/实收/欠款口径见 `ADR-008`（应收按单日期、实收按收款日期、欠款=应收−实收）。
>
> ✅ **阶段 20（2026-10-13）落地 ADR-008/009 销售应收模型**，补齐 **FP-SALE-07 / 08 / 09 / 10 / 11** 共 5 项
> （`docs/计划与排期/关键路径-销售应收模型-推行指令.md` Phase B），本页**不再整页缺失**：
> · 只读层：`bff/lib/sales_model.js`（唯一口径源）+ `GET /api/admin/sales`（销售单列表行级）+ `report.js`（顶部 KPI 店级）；
> · 写侧：`bff/lib/algorithms/sale.js` 三个执行器 `sale.create / sale.pay / sale.void` 已在 `registry.js` 注册，
>   走 `/api/actions` 统一队列（未注册即 need-manual；rev 乐观锁 409；作废留痕不物理删除）；
> · 前端：新增 `apps/admin-web/src/pages/dinein/SalesPage.tsx`（销售单列表 + 顶部 KPI + 渠道/状态筛选）
>   与 `SalePayModal.tsx`（分次收款），菜单 `/dinein/sales`「销售收银」。
>
> ✅ **阶段 21（2026-10-13）补齐「编辑 + admin-web 录入」**：
> · 新增 `sale.update` 执行器（`sale.js` `applySaleUpdate`，已在 `registry.js` 注册），走 `/api/actions` 队列：
>   重算售价合计/折扣/应收，关键约束「应收 ≥ 累计实收」（欠款不为负），保留单号与收款记录、记编辑人/时间；
> · `GET /api/admin/sales` 行级新增 `lines` 明细（`{name,qty,price,amount}`）供编辑表单初始化；
> · 前端新增 `SaleCreateModal.tsx`（admin-web 侧录入，复用 `sale.create`）与 `SaleEditModal.tsx`（编辑），
>   `SalesPage.tsx` 加「录入销售单」按钮与行内「编辑」入口（已作废单禁编辑）。
>
> ✅ **阶段 22（2026-10-14）落地平台销售导入链路后端骨架 + 定案「作废不回补」**，补掉 **FP-SALE-03/04/05/06**：
> · 纯函数解析层 `bff/lib/sales_import.js`（零写）：`resolveSaleAmt` 金额口径 A–E 唯一出口、菜名三级匹配（别名→精确→归一化）、
>   CSV/JSON 解析、`buildSaleDocs` 聚合、幂等键（同 src 下按 srcNo/日期去重，作废单不占幂等键）、`previewSaleImport`（只读）；
> · 写侧 `bff/lib/algorithms/sale.js` 新增执行器 `sale.import / sale.batch_void / sale.amt_recalc / sale.alias_set / sale.alias_delete`，
>   已在 `registry.js` 注册、走 `/api/actions` 队列；导入提交复用原始文件重解析（`loadSaleRows`），预览/提交/重算共用同一 `buildSaleDocs + resolveSaleAmt`；
> · 只读路由 `bff/routes/sales_import.js`：`POST /api/sales/import/preview`、`GET /api/sales/import/batches`、`GET /api/sales/import/alias`；
> · 前端 `api/saleImport.ts` + `SaleImportModal.tsx`（导入预览→映射→提交）、`SaleBatchesModal.tsx`（批次撤回/重算）、`DishAliasModal.tsx`（菜名映射配置页），
>   由 `SalesPage.tsx` 三入口挂载；美团数据格式待定 → 导入端做成可扩展适配器（`SALE_SRC` 占位），POS 端/美团格式确定后直接对接；
> · 测试：`bff/lib/sales_import.test.js`（17 项）+ `bff/lib/algorithms/sale_import.test.js`（7 项）全绿。

---

## 功能点清单

| FP ID | 功能点 | 旧版证据 | 新版现状 | 状态 | 处置 / 关联 |
|---|---|---|---|---|---|
| FP-SALE-01 | 录入销售单（日期/渠道/菜品明细/数量/单价，确认） | HTML:471 `#btnNewSale`、:4337 `openSale` :4394、保存 :4454-4473 | 移动端：`PosScreen.kt`:195-204 加减菜、:984-1098 结账页、`pos.js`:620 `pos.pay … sales=`；**admin-web 侧：`SaleCreateModal.tsx` → `POST /api/actions`（`sale.create`）→ 审批 → 入 sales**（日期/渠道/明细/折扣/首付/备注） | ⬆️ 已移植 | 阶段 21 补 admin-web 录入 UI（复用 `sale.create`，应收=售价−折扣、首付>0 记首条收款、欠款派生）；移动端仍走 `pos.pay` |
| FP-SALE-02 | 销售单自动按配方扣减库存（确认并出库） | HTML:4473 `rebuildStock()`、:4428 未配配方告警 | `bff/lib/algorithms/pos.js`:3「POS/收银 + BOM 扣料」、:620 apply_pos_pay | ⬆️ 已移植 | 验证：App 结账后 /inventory/ledger 出现销售出库流水 |
| FP-SALE-03 | 导入平台销售（xlsx/csv/json，预览后写入、按单号去重） | HTML:472 `#btnSaleImport`、:4916-4917 → `previewSaleImport` :4709、`commitSaleImport` :4676、:4669 去重 | `lib/sales_import.js` 预览（`previewSaleImport` 只读）+ `sale.import` 执行器（`sale.js` `applySaleImport`，走 `/api/actions`）+ `SaleImportModal.tsx`；金额口径 A–E 唯一出口 `resolveSaleAmt`；幂等键同 src 下按 srcNo/日期去重 | ⬆️ 已移植 | 阶段 22 后端骨架；美团格式待定 → `SALE_SRC` 可扩展适配器（美团占位），POS 端/美团格式确定后直接对接 |
| FP-SALE-04 | 查看/撤回导入批次 | HTML:474 `#btnSaleBatches`、:4920 → `openSaleBatches` :4807、`delSaleBatch` :4797 | `GET /api/sales/import/batches` 只读 + `sale.batch_void` 执行器（整批作废留痕、不物理删除、不回补库存）+ `SaleBatchesModal.tsx` | ⬆️ 已移植 | 阶段 22；撤回后可重导（作废单不占幂等键） |
| FP-SALE-05 | 金额口径重算（A–E 五种口径切换后整批重算） | HTML:475 `#btnSaleRecalc`、口径定义 :4497、`openSaleAmtRecalc` :4839、`applySaleAmtRecalc` :4822、`resolveSaleAmt` :4542 | `SALE_AMT_MODES`（A–E）+ `resolveSaleAmt` 唯一出口 + `sale.amt_recalc` 执行器（只改金额不动明细）+ `SaleBatchesModal.tsx` 重算下拉 | ⬆️ 已移植 | 阶段 22；预览/提交/重算共用同一 `resolveSaleAmt` |
| FP-SALE-06 | 菜名映射（平台菜名 → 本店菜品 + 倍数） | HTML:476 `#btnAliasMap`、:4922 → `openAliasMap` :4877、`setDishAlias` :4535 | `data.dishAlias` + `sale.alias_set / sale.alias_delete` 执行器 + `DishAliasModal.tsx`（配置页）；导入时三级匹配「别名→精确→归一化」 | ⬆️ 已移植 | 阶段 22；`GET /api/sales/import/alias` 只读下发映射 + 在售菜品下拉 |
| FP-SALE-07 | 销售单列表（单号/渠道/应收/实收/欠款/食材成本/毛利率/状态） | HTML:490-497 表头、`renderSale` :4351-4374 | `GET /api/admin/sales`（`routes/admin.js` → `routes/export.js` `salesList`）+ `pages/dinein/SalesPage.tsx` 表格：单号/日期/渠道/明细/售价合计/折扣/应收/实收/欠款/毛利率/状态；状态由 `sales_model.statusOf` 派生（已作废/有欠款/已结清） | ⬆️ 已移植 | 阶段 20。营收/欠款**口径唯一出口**在 `lib/sales_model.js`，前端只渲染不复算 |
| FP-SALE-08 | 顶部 KPI 卡（本月应收/累计实收/未收欠款/累计毛利率） | HTML:469 `#saleKpi`、`renderSaleKpi` :4338-4350 | `SalesPage.tsx` 顶部 KPI 卡取 `report.js` 下发的「应收合计 / 实收合计 / 未收欠款 / 销售毛利率」四张，**复用既有聚合不另算**；周期 chips 7/30/all（默认 30），区间文字随 `range_label` | ⬆️ 已移植 | 阶段 20（ADR-008 §2.2/2.3「单日期 vs 收款日期」口径）。未收欠款 > 0 时副标标红 |
| FP-SALE-09 | 渠道筛选（堂食/外卖/美团外卖） | HTML:478-481 `#saleChFilter`、`renderSale` :4354 | `SalesPage.tsx` 渠道下拉：选项由列表 `channel` 去重生成（含真实出现的渠道），默认「全部」 | ⬆️ 已移植 | 阶段 20，随 FP-SALE-07。旧版固定三选项，新版按数据生成（更严） |
| FP-SALE-10 | 状态筛选（有欠款/已结清） | HTML:483-485 `#saleStFilter`、`renderSale` :4355 | `SalesPage.tsx` 状态下拉（全部/有欠款/已结清/已作废） | ⬆️ 已移植 | 阶段 20，随 FP-SALE-07。新增「已作废」选项（作废留痕后可查） |
| FP-SALE-11 | 分次收款（登记后续收款，应收 − 实收 = 欠款） | HTML:4371 `data-get` → `openGet('S',id)` :2055、:1313 绑定 | `SalePayModal.tsx` 登记收款 → `POST /api/actions`（`sale.pay`）→ 审批 → `bff/lib/algorithms/sale.js` `applySalePay` **只追加 `payments[]`**、不动 `receivable`；欠款 = 应收 − Σ收款 实时派生 | ⬆️ 已移植 | 阶段 20（ADR-009 统一队列）。超额/重复提交被服务端拒绝（0 < amt ≤ 欠款+0.01）；已作废单不可收款 |
| FP-SALE-12 | 编辑销售单 | HTML:4372 `data-saleedit` → `openSale` :4394 | `sale.update` 执行器（`sale.js` `applySaleUpdate`，`registry.js` 注册）+ `SaleEditModal.tsx`；`GET /api/admin/sales` 下发 `lines` 明细 | ⬆️ 已移植 | 阶段 21「编辑建议动作」入队：重算售价/折扣/应收，约束「应收 ≥ 累计实收」，保留单号与收款记录、记编辑人/时间；已作废单禁编辑 |
| FP-SALE-13 | 删除销售单（回补库存、重算台账） | HTML:4373 `data-saledel` → `delSale` :4477-4482 | 「作废留痕、禁物理删除」**已落地**：`sale.void` 执行器（`sale.js` `applySaleVoid`，记作废人/时间/rev/trace，原单保留）+ `SalesPage.tsx` 行内「作废」入口；**「回补库存」按决策废弃（作废不回补）** | ⬆️ 已移植 | 阶段 22 定案：作废不回补库存（菜品视为已消费，作废仅留痕，避免库存虚增）；`sale.batch_void` 同样只留痕不回补 |
| FP-SALE-14 | 未配配方菜品告警（确认后不扣库存、成本按估算） | `openSale` 内 `sync()` :4437-4438 | `bff/routes/snapshot.js` markRecipeStatus 标记 `has_recipe` + App `PosScreen.kt` 挂单/结账确认弹窗告警 | ⬆️ 已移植 | 只读提示，随 FP-SALE-01 一并校验 |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 14 |
| ⬆️ 已移植 | 14（FP-SALE-02/14 仅移动端；阶段 20 起 5 项 + 阶段 21 编辑/admin-web 录入 + 阶段 22 平台导入 4 项 + 作废不回补，全部落地） |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 0 |
| ⚰️ 废弃 | 0 |

**结论**：阶段 20 之前本页是**缺口最大**的一页（admin-web 无销售页、只有移动端「点菜 + 全额收款」）；
阶段 20 按 ADR-008/009 落地销售应收模型后，**应收/实收/欠款三口径与分次收款（欠款清收闭环）已打通**；
阶段 21 补齐**单据编辑 + admin-web 录入**；阶段 22 落地**平台销售导入链路后端骨架**（FP-SALE-03/04/05/06，
执行器 + 可扩展适配器 + 批次/撤回 + 金额口径 A–E + 菜名映射配置页，美团格式待定后直接对接）并定案
**作废不回补库存**（FP-SALE-13）。至此本页 14 项功能点全部落地。

## 建议补齐顺序

1. ~~**FP-SALE-08** 应收/实收/欠款 KPI（只读、无红线）~~ → ✅ 阶段 20
2. ~~**FP-SALE-07 / 09 / 10** 销售单列表与筛选（只读）~~ → ✅ 阶段 20
3. ~~**FP-SALE-11** 分次收款（欠款清收闭环）~~ → ✅ 阶段 20
4. ~~**FP-SALE-12** 编辑销售单（编辑建议动作入队）~~ → ✅ 阶段 21
5. ~~**FP-SALE-01（admin-web 侧）** 销售单录入 UI~~ → ✅ 阶段 21（`SaleCreateModal` 复用 `sale.create`）
6. ~~**FP-SALE-03 / 04 / 05 / 06** 平台导入链路~~ → ✅ 阶段 22（后端骨架：执行器 + 可扩展适配器（美团占位）+
   批次/撤回 + 金额口径 A–E + 菜名映射配置页；美团数据格式待定，POS 端/美团格式确定后直接对接）
7. ~~**FP-SALE-13** 删除/回补库存~~ → ✅ 阶段 22（作废留痕已落地；**决策「作废不回补」**，回补功能废弃）
8. ~~**FP-SALE-01/02** 移动端录入与库存扣减~~ ✅（历史，仅移动端）

> ✅ **FP-SALE-14**（未配配方告警）已于阶段 19 落地（BFF 快照标记 `has_recipe` + App 挂单/结账告警），从待补清单移除。

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/规范/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- 前置决策：~~销售单在店内 POS 录还是云端 admin-web 录？~~ **已解除**（ADR-009，批准人 William）：销售端录销售单、采购端录采购单，统一走标准业务处理队列，与进货单（ADR-004）状态机一致。应收/实收/欠款口径由 ADR-008 定案（应收按单日期、实收按收款日期）。
- 平台导入职责边界（阶段 21 定案，阶段 22 落地骨架）：**平台销售数据以店内 POS/收银端为主导入端**，admin-web 提供管理端辅助入口（导入预览→映射→提交、批次撤回/重算、菜名映射配置页）；同时预留美团收银系统数据导入接口（美团方数据格式尚不清楚，导入端做成 `SALE_SRC` 可扩展适配器，美团占位）。
- FP-SALE-13 决策（阶段 22 定案）：**作废不回补库存**——菜品视为已消费，作废仅留痕（`status='已作废'` + `void_operator/void_at/void_reason`），不物理删除、不回补 BOM 料，避免库存虚增；`sale.batch_void`（整批撤回）同样只留痕不回补。
- 平价测试全绿属另一条门禁，不能替代本页面级清单。

---

## 进销存-真实出餐销售统一走 POS 扣料 + 特性开关（阶段 23+，本页补充协议）

> 背景：扣料逻辑此前只在移动端 `pos.pay`（`lib/algorithms/pos.js` `applyPosPay` → `deductBomForSaleItems`）生效；admin-web `sale.create` 与平台导入 `sale.import` 只记销售单/应收，**不扣库存**，导致「以 admin-web 手工录入为主」的门店库存不会随出餐减少。

**方案（总闸 + 非 POS 补扣）**：
- `pos.pay` 维持必扣（已是 POS 路径，不受开关影响）。
- 新增特性开关 `data.config.saleRealDeduct`（**默认关闭**，保护现有数据）。开启后，`sale.create`（admin-web 手工录入的真实出餐单）在审批确认落库时，**复用 `pos.deductBomForSaleItems` 同一套逻辑**按配方 BOM 扣减库存——口径唯一，不另写扣料分支。
- `sale.import`（平台导入）**不扣**（平台数据来自平台自有 POS，再扣会重复）；`sale.update`/`sale.void` 不扣（编辑/作废不重扣，避免双扣与虚增，与 FP-SALE-13 作废不回补口径一致）。
- 扣料异常（如缺配方）绝不阻断销售单落库：记「跳过」回执（对齐 `pos.pay` 容错），交由人工/日志排查。

**改动点**：
- `bff/lib/algorithms/sale.js`（及桌面端 `desktop/app/bff/lib/algorithms/sale.js` 同步副本）：`applySaleCreate(data, payload, ctx)` 接入开关判定 `saleRealDeductEnabled(data)` + `pos.deductBomForSaleItems`；导出 `saleRealDeductEnabled`。
- 开关经既有 `POST /api/admin/config`（`config.update` 动作）写入 `data.config.saleRealDeduct`，**后台可切**（无新增动作类型）。
- 前端 `apps/admin-web/src/pages/dinein/SalesPage.tsx`：顶部新增开关「真实出餐扣料(POS)」+ 说明 Tooltip，经 `fetchAdminConfig`/`saveAdminConfig` 读写。

**验收（单测 `bff/lib/algorithms/sale.test.js` 新增 5 例全绿）**：
- 默认/无 config → `sale.create` 不写盘点调整流水、库存不变；
- 开关开启 + 菜品有配方 → 按 `qty/20` 缩放扣 BOM、`data.logs` 生成对应出库流水、`rebuildStock` 重算库存（如 五福饺子×2 → 面粉−50g / 猪肉−30g，期初 100/50 → 50/20）；
- 开关开启 + 菜品无配方 → 不扣料、不崩溃、销售单照常落库；
- 无明细（amount 模式）→ 不扣料；`saleRealDeductEnabled` 默认/显式判定正确。
- 红线：GET 只读不变；写仅经 `actions` 队列；未触碰 `db.js`/`merge.js`。
