# 迁移基线 · 采购管理（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-po`「采购管理」（HTML 第 260–294 行区域）
> 目标系统：`apps/admin-web/src/pages/inventory/PurchasePage.tsx` + `RestockPage.tsx` + `VendorsPage.tsx` + `bff/routes/inventory.js`
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/迁移颗粒度规范.md`
> **行号复核**：2026-10-10 W1 只读补齐 + W2 写类补齐后，按 `PurchasePage.tsx`（454 行）/ `utils.ts`（119 行）复核新版行号。

---

## 功能点清单

| FP ID | 功能点 | 旧版证据 | 新版现状 | 状态 | 处置 / 关联 |
|---|---|---|---|---|---|
| FP-PO-01 | 新建采购单 CG（供应商/明细/应付/实付/备注） | HTML:264 `#btnNewOrder` → `openOrder()` :1670（表单 `openDocForm` :1559） | 无。`PurchasePage.tsx`:396-404 空态仅引导去补货建议；`bff/lib/algorithms/registry.js`:24-46 无 `po.create` | ⬜ 待补 | 写类：建议动作 `po.create` 走 `/api/actions`，不得直写 |
| FP-PO-02 | 编辑采购单 | HTML:1812 `data-orderedit` → `openOrder()` :1670 | 无（行操作列已随 FP-PO-03~07 落地于 `PurchasePage.tsx`:264-325，但**不含编辑**） | ⬜ 待补 | 写类：`po.edit` 建议动作 + 审批队列 |
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
| FP-PO-16 | 补货建议清单（现有/安全/缺口/建议采购量） | HTML:291 `#restockBox` → `renderRestock()` :1920、`genRestockPlan()` :1878、`autoRestockPlan()` :1870 | `RestockPage.tsx`:200-231（列 :97-147）+ 后端 `GET /api/inventory/restock-suggest`（`bff/routes/inventory.js`:4） | ⬆️ 已移植 | 验证：/inventory/restock；口径由「日均耗量×提前期」改为安全线/服务端 est+plans |
| FP-PO-17 | 补货参数配置（统计天数/提前期/配送间隔/是否扣在途） | HTML:266 `#btnRestockCfg` → `openRestockCfg()` :2031 | 无（RestockPage 无参数入口） | ⬜ 待补 | 写类：配置走审批队列 |
| FP-PO-18 | 勾选建议行 → 按供应商拆单生成正式采购单 | HTML:1939 `#rsToOrder` → `restockToOrders()` :1995 | `RestockPage.tsx`「转采购单」按钮（`onToOrders` `:148`）→ `order.fromRestock`；`bff/lib/algorithms/inventory.js` `applyRestockToOrders`（按 `sup` 拆单生成 CG 单，`status='normal'`）；`registry.js` 注册 `order.fromRestock` | ⬆️ 已移植 | 写类：走审批队列；**只 push `data.orders`，绝不 `rebuildStock`**（采购单不入库）；单价回落 `avg/last`、供应商回落 `sup`、新供应商并入 `data.suppliers` |
| FP-PO-19 | 忽略勾选的建议行 | HTML:1975 `#rsIgnore` → `restockIgnore()` :2023 | 无 | ⬜ 待补 | 写类：随 FP-PO-16 |
| FP-PO-20 | 建议行内改采购量/供应商/起订量/整包并记回原料主数据 | HTML:1960-1964、`readRestockRows()` :1978 | 无（`RestockPage.tsx` 行不可编辑） | ⬜ 待补 | 写类：记回 `ing.upsert` 建议动作 |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 20 |
| ⬆️ 已移植 | 15 |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 5 |
| ⚰️ 废弃 | 0 |

**结论**：采购管理页 20 项功能中 **15 项已移植**（W1 补齐 4 项只读：状态标签 / 状态筛选 / 明细行级标记 / KPI 卡；
W2 补齐 6 项写类：付款 / 结案 / 作废 / 恢复 / 删除 / 补货建议转正式采购单）。
剩余 5 项集中在**新建/编辑采购单、补货参数配置、忽略建议行、行内改量**（`FP-PO-01/02/17/19/20`），采购录单与「建议行状态回收」链路尚未闭环。
> **2026-10-10 W2 更新**：付款/结案/作废/恢复/删除全部为**写类建议动作**，走 `/api/actions` 审批队列，本地不直改；
> 执行器只改 `data.orders`（`status`/`lines`/`payments`），**绝不触碰库存与均价**（采购单本就不进库存）。
> 作废/删除的区别：作废=状态留痕（可恢复），删除=物理移除（旧版 `delOrder` 口径），两者均经 Popconfirm 二次确认。

## 建议补齐顺序

1. ~~**FP-PO-15** 汇总 KPI（只读、无红线）~~ ✅ 已完成（W1，2026-10-10）
2. ~~**FP-PO-12 / 14** 状态列 + 状态筛选（只读）~~ ✅ 已完成（W1，2026-10-10）
3. ~~**FP-PO-03** 采购付款/补付（欠款清收闭环）~~ ✅ 已完成（W2，2026-10-10）
4. ~~**FP-PO-18** 建议转正式采购单（业务闭环核心，注意「自动生成 ≠ 自动下单」）~~ ✅ 已完成（W2 阶段 24，2026-10-10）
5. **FP-PO-01 / 02** 新建 / 编辑（需先定录入职责边界）
6. ~~**FP-PO-04 / 05 / 06 / 07** 结案 / 作废 / 恢复 / 删除（全部改建议动作 + 留痕）~~ ✅ 已完成（W2，2026-10-10）

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- 平价测试（算法/数据层）全绿属**另一条门禁**，不能替代本页面级清单。
