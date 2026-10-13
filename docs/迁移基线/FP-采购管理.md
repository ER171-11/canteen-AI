# 迁移基线 · 采购管理（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-po`「采购管理」（HTML 第 260–294 行区域）
> 目标系统：`apps/admin-web/src/pages/inventory/PurchasePage.tsx` + `RestockPage.tsx` + `OrderFormModal.tsx` + `VendorsPage.tsx` + `bff/lib/algorithms/inventory.js` + `bff/routes/inventory.js`
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/迁移颗粒度规范.md`
> **行号复核**：2026-10-13 W3 录入类补齐（阶段 26）后，按 `PurchasePage.tsx`（559 行）/ `OrderFormModal.tsx`（约 380 行）/ `RestockPage.tsx`（约 620 行）/ `inventory.js` 复核新版行号。

---

## 功能点清单

| FP ID | 功能点 | 旧版证据 | 新版现状 | 状态 | 处置 / 关联 |
|---|---|---|---|---|---|
| FP-PO-01 | 新建采购单 CG（供应商/明细/应付/实付/备注） | HTML:264 `#btnNewOrder` → `openOrder()` :1670（表单 `openDocForm` :1559） | `inventory.js`:1522 `applyOrderCreate`（单号 `CG+yyyymmdd-NN`、`payable=Σqty×price`、实付封顶应付、`status='normal'`、新供应商并入 `data.suppliers`、`unitCost=price/conv`）；`registry.js`:52 注册 `po.create`；`OrderFormModal.tsx`:66-`PurchasePage.tsx`:456-465「新建采购单」 | ⬆️ 已移植 | 写类：`po.create` 走 `/api/actions` 审批队列，不得直写；**只 push `data.orders`，绝不 `rebuildStock`**（采购单不入库） |
| FP-PO-02 | 编辑采购单 | HTML:1812 `data-orderedit` → `openOrder()` :1670 | `inventory.js`:1556 `applyOrderEdit`；`registry.js`:53 注册 `po.edit`；`OrderFormModal.tsx`（编辑模式，预填原单）+ `PurchasePage.tsx`:309-318 行内「编辑」 | ⬆️ 已移植 | 写类：`po.edit` 建议动作 + 审批队列；按旧版口径把 `payments` 归并为「本次实付」单条（预填=已付合计，故应付/已付/欠款不变，仅付款笔数归并） |
| FP-PO-03 | 采购单付款/补付登记（预付、清欠款） | HTML:1813 `data-orderpay` → `openGet('O')` :2055 | `inventory.js`:1066-1083 `applyOrderPay`（校验 `0 < 金额 ≤ 欠款+0.01`，追加 `payments`）；`registry.js`:42 注册 `order.pay`；`PurchasePage.tsx`:277-281「付款」+ :420-456 付款登记 Modal | ⬆️ 已移植 | 写类：走 `/api/actions` 审批队列，本地不直改 |
| FP-PO-04 | 采购单结案 | HTML:1815 `data-orderclose` → `closeOrder()` :1751 | `inventory.js`:1086-1095 `applyOrderClose`（`status='closed'` + 行 `st='closed'`）；`registry.js`:43 注册 `order.close`；`PurchasePage.tsx`:291-301「结案」 | ⬆️ 已移植 | 写类：走审批队列；只改单据状态，不动库存/均价 |
| FP-PO-05 | 采购单作废 | HTML:1816 `data-ordervoid` → `voidOrder()` :1758 | `inventory.js`:1098-1107 `applyOrderVoid`（`status='void'` + 行 `st='canceled'`）；`registry.js`:44 注册 `order.void`；`PurchasePage.tsx`:302-312「作废」 | ⬆️ 已移植 | 写类：状态留痕，不物理删除单/行 |
| FP-PO-06 | 作废/结案单恢复为「收货中」 | HTML:1814 `data-orderrestore` → `restoreOrder()` :1765 | `inventory.js`:1110-1119 `applyOrderRestore`（`status='normal'` + 清行 `st`）；`registry.js`:45 注册 `order.restore`；`PurchasePage.tsx`:282-290「恢复」 | ⬆️ 已移植 | 随 FP-PO-04/05 |
| FP-PO-07 | 删除采购单 | HTML:1817 `data-orderdel` → `delOrder()` :1822 | `inventory.js`:1122-1128 `applyOrderDelete`（从 `data.orders` 移除）；`registry.js`:46 注册 `order.delete`；`PurchasePage.tsx`:313-321「删除」 | ⬆️ 已移植 | 写类：走审批队列；该单不参与库存计算 |
| FP-PO-08 | 采购单列表（单号/日期/供应商/内容/应付/实付/欠款/结算态） | HTML:277-285 表头、`renderOrders()` :1787、`renderOrderFilter()` :1772 | `PurchasePage.tsx`:167-263 列定义（应付 :205、已付 :212、欠款 :219、结算 Tag :254） | ⬆️ 已移植 | 验证：打开 /inventory/purchase 即见列表 |
| FP-PO-09 | 采购明细摘要（品名 数量×单价=金额） | HTML:1799-1804 行内 `detail` | `PurchasePage.tsx`:171-204 明细列 → `utils.ts`:54-66 `formatLinesSummary` | ⬆️ 已移植 | 验证：看「明细」列 |
| FP-PO-10 | 明细行级「已收 x / 未收 / 行作废」标记 | HTML:1803-1804（`orderLineSt()` :1688） | `PurchasePage.tsx`:171-204 明细列内联（已收=绿 / 未收=灰 / 行作废 Tag）+ `utils.ts`:74-80 `orderLineSt` | ⬆️ 已移植 | 只读展示；「行作废」仅显式 `st=canceled` 才显示，收齐=已收不标行作废 |
| FP-PO-11 | 整单收货进度（已收 x/y · pct%） | HTML:1810、`orderRecvProg()` :1710 | `PurchasePage.tsx`:230-244「收货进度」列 + `utils.ts`:109-119 `orderRecvProg`（g 上限封顶 qty） | ⬆️ 已移植 | 验证：列内显示 g/q · pct |
| FP-PO-12 | 采购单状态标签（收货中/已结案/已作废/草稿） | HTML:1810、`orderStTag()` :1703、`orderSt()` :1694 | `PurchasePage.tsx`:245-253 状态列 + `utils.ts`:83-92 `orderSt`、:95-106 `orderStMeta` | ⬆️ 已移植 | 只读展示；状态由既有数据推导（`status`/`recvQty`/`st`），结案/作废写类已随 FP-PO-04/05 落地 |
| FP-PO-13 | 供应商筛选 | HTML:268 `#orderSupplierFilter` → :1490 | `PurchasePage.tsx`:372-379 供应商 Select | ⬆️ 已移植 | 验证：切换供应商下拉 |
| FP-PO-14 | 状态筛选（进行中/已结案/已作废） | HTML:270-273 `#orderStatusFilter` → :1491 | `PurchasePage.tsx`:137-142 筛选逻辑 + :381-392 状态 Select（进行中=收货中+草稿） | ⬆️ 已移植 | 只读筛选；open 含 draft（对齐旧版 :1793） |
| FP-PO-15 | 采购 KPI 卡（本月下单/累计下单/已预付/待付供应商） | HTML:262 `#poKpi`、`renderOrderKpi()` :1777 | `PurchasePage.tsx`:153-164 `kpi` 聚合 + :335-366 四张汇总卡（「本月」=近30天，不随筛选变） | ⬆️ 已移植 | 只读聚合；口径对齐旧版 `renderOrderKpi()` |
| FP-PO-16 | 补货建议清单（现有/安全/缺口/建议采购量） | HTML:291 `#restockBox` → `renderRestock()` :1920、`genRestockPlan()` :1878、`autoRestockPlan()` :1870 | `RestockPage.tsx`（服务端列 + 建议单行状态列）+ 后端 `GET /api/inventory/restock-suggest`（`bff/routes/inventory.js`:54 `buildSuggestions`，并 `data.plans` 最新建议行）；`RestockPage.tsx`:150-320 列定义 | ⬆️ 已移植 | 验证：/inventory/restock；口径由「日均耗量×提前期」改为安全线/服务端 est+plans（欠账已在 FP-PO-17 补齐参数入口） |
| FP-PO-17 | 补货参数配置（统计天数/提前期/配送间隔/是否扣在途） | HTML:266 `#btnRestockCfg` → `openRestockCfg()` :2031 | `inventory.js`:398 `applyRestockConfig`（days≥1 取整、lead/gap≥0、useOnway 归一 0/1 → `data.restock`）；`registry.js`:55 注册 `restock.config`；`policy.js`:24 加入 `NEVER_AUTO`（配置类不得自动执行）；`RestockPage.tsx`:415-433 提交 + :535-`「补货参数」Modal | ⬆️ 已移植 | 写类：配置走审批队列；口径对齐旧版 `openRestockCfg`（HTML:2031-2051）；默认值 `{days:30,lead:1,gap:1,useOnway:1}`（RESTOCK_DEF） |
| FP-PO-18 | 勾选建议行 → 按供应商拆单生成正式采购单 | HTML:1939 `#rsToOrder` → `restockToOrders()` :1995 | `RestockPage.tsx`「转采购单」按钮（`onToOrders` `:325-359`）→ `order.fromRestock`；`bff/lib/algorithms/inventory.js` `applyRestockToOrders`（按 `sup` 拆单生成 CG 单，`status='normal'`）；`registry.js` 注册 `order.fromRestock` | ⬆️ 已移植 | 写类：走审批队列；**只 push `data.orders`，绝不 `rebuildStock`**（采购单不入库）；单价回落 `avg/last`、供应商回落 `sup`、新供应商并入 `data.suppliers`；行内改过的采购量/供应商随之入单 |
| FP-PO-19 | 忽略勾选的建议行 | HTML:1975 `#rsIgnore` → `restockIgnore()` :2023 | `inventory.js`:416 `applyRestockIgnore`（`st='pending'` 行置 `ignored` + `_syncPlanStatus` 推进单状态）；`registry.js`:56 注册 `restock.ignore`；`RestockPage.tsx`:361-382「忽略勾选」（无待处理建议单时禁用） | ⬆️ 已移植 | 写类：只改 `data.plans`（不删行、不生成采购单）；无建议单时执行器抛错并给出提示 |
| FP-PO-20 | 建议行内改采购量/供应商/起订量/整包并记回原料主数据 | HTML:1960-1964、`readRestockRows()` :1978 | `inventory.js`:438 `applyRestockAdjust`（建议行 `qty/supplier` + 原料主数据 `sup/moq/packQty`）；`registry.js`:57 注册 `restock.adjust`；`RestockPage.tsx`:221-320 行内可编辑（建议采购量/供应商/起订/整包）+ :384-412「保存调整」；`types.ts`:806/810 `packQty`/`sup` | ⬆️ 已移植 | 写类：记回原料主数据（等价 `ing.upsert` 白名单 `sup/moq`）；**`ing.pack`（包规字符串，结算单用）保持不动，整包规格落 `packQty`**（Node 超集：旧版写 `pack` 会覆盖包规） |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 20 |
| ⬆️ 已移植 | 20 |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 0 |
| ⚰️ 废弃 | 0 |

**结论**：采购管理页 20 项功能**全部 ⬆️ 已移植**（W1 补齐 4 项只读：状态标签 / 状态筛选 / 明细行级标记 / KPI 卡；
W2 补齐 6 项写类：付款 / 结案 / 作废 / 恢复 / 删除 / 补货建议转正式采购单；
W3 补齐 5 项录入与建议单：新建 / 编辑采购单、补货参数配置、忽略勾选建议行、行内改量记回原料主数据）。

> **2026-10-13 W3 更新（阶段 26）**：`po.create` / `po.edit` / `restock.config` / `restock.ignore` / `restock.adjust`
> 全部为**写类建议动作**，走 `/api/actions` 审批队列，本地不直改。
> 执行器只改 `data.orders` / `data.restock` / `data.plans`（+ 记回 `data.ings` 的 `sup/moq/packQty`），
> **绝不触碰库存与均价**（采购单本就不进库存；补货建议为只读测算层）。
> `restock.config` 已加入 `lib/policy.js` 的 `NEVER_AUTO`（配置类不得由 SI 自动执行）。
> 仍存缺口（非本页 FP）：建议行转单后未回写 `st='done'`/`po`（旧版 `restockToOrders` 会写），
> 故同一建议行跨幂等窗后仍可能重复转单——属 FP-PO-16 的 `syncPlanStatus` 范畴，暂缓；`_syncPlanStatus` 已就位，接上转单回写即可闭环。

## 建议补齐顺序

1. ~~**FP-PO-15** 汇总 KPI（只读、无红线）~~ ✅ 已完成（W1，2026-10-10）
2. ~~**FP-PO-12 / 14** 状态列 + 状态筛选（只读）~~ ✅ 已完成（W1，2026-10-10）
3. ~~**FP-PO-03** 采购付款/补付（欠款清收闭环）~~ ✅ 已完成（W2，2026-10-10）
4. ~~**FP-PO-18** 建议转正式采购单（业务闭环核心，注意「自动生成 ≠ 自动下单」）~~ ✅ 已完成（W2 阶段 24，2026-10-10）
5. ~~**FP-PO-01 / 02** 新建 / 编辑（需先定录入职责边界）~~ ✅ 已完成（W3 阶段 26，2026-10-13；边界见 ADR-009）
6. ~~**FP-PO-04 / 05 / 06 / 07** 结案 / 作废 / 恢复 / 删除（全部改建议动作 + 留痕）~~ ✅ 已完成（W2，2026-10-10）
7. ~~**FP-PO-17 / 19 / 20** 补货参数 / 忽略建议行 / 行内改量记回主数据~~ ✅ 已完成（W3 阶段 26，2026-10-13）

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- 平价测试（算法/数据层）全绿属**另一条门禁**，不能替代本页面级清单。
- 新建/编辑采购单为**新增动作类型**（旧版为浏览器内 JS `openDocForm`），无 Node↔Python 平价对照，仅 Node 单测覆盖。
