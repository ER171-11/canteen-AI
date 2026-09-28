# 迁移基线 · 采购管理（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-po`「采购管理」（HTML 第 260–294 行区域）
> 目标系统：`apps/admin-web/src/pages/inventory/PurchasePage.tsx` + `RestockPage.tsx` + `VendorsPage.tsx` + `bff/routes/inventory.js`
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/迁移颗粒度规范.md`

---

## 功能点清单

| FP ID | 功能点 | 旧版证据 | 新版现状 | 状态 | 处置 / 关联 |
|---|---|---|---|---|---|
| FP-PO-01 | 新建采购单 CG（供应商/明细/应付/实付/备注） | HTML:264 `#btnNewOrder` → `openOrder()` :1670（表单 `openDocForm` :1559） | 无。`PurchasePage.tsx`:147-155 空态仅引导去补货建议；`bff/lib/algorithms/registry.js`:24-32 无 `po.create` | ⬜ 待补 | 写类：建议动作 `po.create` 走 `/api/actions`，不得直写 |
| FP-PO-02 | 编辑采购单 | HTML:1812 `data-orderedit` → `openOrder()` :1670 | 无（`PurchasePage.tsx` 无行操作列） | ⬜ 待补 | 写类：`po.edit` 建议动作 + 审批队列 |
| FP-PO-03 | 采购单付款/补付登记（预付、清欠款） | HTML:1813 `data-orderpay` → `openGet('O')` :2055 | 无。`registry.js` 无 `order.pay`/`po.pay` | ⬜ 待补 | 写类：**业务闭环（欠款清收），优先** |
| FP-PO-04 | 采购单结案 | HTML:1815 `data-orderclose` → `closeOrder()` :1751 | 无；后端仅 `order.mark`（草稿→已发，`inventory.js`:695-701），无结案态 | ⬜ 待补 | 写类：`order.close` 建议动作 |
| FP-PO-05 | 采购单作废 | HTML:1816 `data-ordervoid` → `voidOrder()` :1758 | 无 | ⬜ 待补 | 写类：作废需留痕，不得物理删除 |
| FP-PO-06 | 作废/结案单恢复为「收货中」 | HTML:1814 `data-orderrestore` → `restoreOrder()` :1765 | 无 | ⬜ 待补 | 随 FP-PO-04/05 |
| FP-PO-07 | 删除采购单 | HTML:1817 `data-orderdel` → `delOrder()` :1822 | 无 | ⬜ 待补 | 写类；建议只留作废不留删除 |
| FP-PO-08 | 采购单列表（单号/日期/供应商/内容/应付/实付/欠款/结算态） | HTML:277-285 表头、`renderOrders()` :1787、`renderOrderFilter()` :1772 | `PurchasePage.tsx`:61-123 列定义（应付 :71、已付 :78、欠款 :85、结算 Tag :112） | ⬆️ 已移植 | 验证：打开 /inventory/purchase 即见列表 |
| FP-PO-09 | 采购明细摘要（品名 数量×单价=金额） | HTML:1799-1804 行内 `detail` | `PurchasePage.tsx`:69 → `utils.ts`:41 `formatLinesSummary` | ⬆️ 已移植 | 验证：看「明细」列 |
| FP-PO-10 | 明细行级「已收 x / 未收 / 行作废」标记 | HTML:1803-1804（`orderLineSt()` :1688） | 无（摘要里无已收量、无行状态） | ⬜ 待补 | 只读展示，随 FP-PO-09 |
| FP-PO-11 | 整单收货进度（已收 x/y · pct%） | HTML:1810、`orderRecvProg()` :1710 | `PurchasePage.tsx`:95-111「收货进度」列 | ⬆️ 已移植 | 验证：列内显示 g/q · pct |
| FP-PO-12 | 采购单状态标签（收货中/已结案/已作废/草稿） | HTML:1810、`orderStTag()` :1703、`orderSt()` :1694 | 无（表格无状态列） | ⬜ 待补 | 只读展示；依赖 FP-PO-04/05 的状态字段 |
| FP-PO-13 | 供应商筛选 | HTML:268 `#orderSupplierFilter` → :1490 | `PurchasePage.tsx`:136-143 供应商 Select | ⬆️ 已移植 | 验证：切换供应商下拉 |
| FP-PO-14 | 状态筛选（进行中/已结案/已作废） | HTML:270-273 `#orderStatusFilter` → :1491 | 无 | ⬜ 待补 | 只读筛选，随 FP-PO-12 |
| FP-PO-15 | 采购 KPI 卡（本月下单/累计下单/已预付/待付供应商） | HTML:262 `#poKpi`、`renderOrderKpi()` :1777 | 无（`PurchasePage.tsx` 无 KPI 区） | ⬜ 待补 | 只读聚合，无红线，**成本最低建议先补** |
| FP-PO-16 | 补货建议清单（现有/安全/缺口/建议采购量） | HTML:291 `#restockBox` → `renderRestock()` :1920、`genRestockPlan()` :1878、`autoRestockPlan()` :1870 | `RestockPage.tsx`:200-231（列 :97-147）+ 后端 `GET /api/inventory/restock-suggest`（`bff/routes/inventory.js`:4） | ⬆️ 已移植 | 验证：/inventory/restock；口径由「日均耗量×提前期」改为安全线/服务端 est+plans |
| FP-PO-17 | 补货参数配置（统计天数/提前期/配送间隔/是否扣在途） | HTML:266 `#btnRestockCfg` → `openRestockCfg()` :2031 | 无（RestockPage 无参数入口） | ⬜ 待补 | 写类：配置走审批队列 |
| FP-PO-18 | 勾选建议行 → 按供应商拆单生成正式采购单 | HTML:1939 `#rsToOrder` → `restockToOrders()` :1995 | 无；新版仅 `stock.replenish` 入队（`RestockPage.tsx`:157-171），不生成 CG 单 | ⬜ 待补 | 写类：**业务闭环，优先**（建议 ≠ 下单） |
| FP-PO-19 | 忽略勾选的建议行 | HTML:1975 `#rsIgnore` → `restockIgnore()` :2023 | 无 | ⬜ 待补 | 写类：随 FP-PO-16 |
| FP-PO-20 | 建议行内改采购量/供应商/起订量/整包并记回原料主数据 | HTML:1960-1964、`readRestockRows()` :1978 | 无（`RestockPage.tsx` 行不可编辑） | ⬜ 待补 | 写类：记回 `ing.upsert` 建议动作 |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 20 |
| ⬆️ 已移植 | 5 |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 15 |
| ⚰️ 废弃 | 0 |

**结论**：采购管理页 20 项功能中仅 5 项已移植，且已移植项集中在「只读列表/汇总展示」；
**写操作（新建/付款/结案/作废）与「建议转正式采购单」全线缺失**，采购业务在新系统无法闭环。

## 建议补齐顺序

1. **FP-PO-15** 汇总 KPI（只读、无红线）
2. **FP-PO-12 / 14** 状态列 + 状态筛选（只读）
3. **FP-PO-03** 采购付款/补付（欠款清收闭环）
4. **FP-PO-18 / 16** 建议转正式采购单（业务闭环核心，注意「自动生成 ≠ 自动下单」）
5. **FP-PO-01 / 02** 新建 / 编辑（需先定录入职责边界）
6. **FP-PO-04 / 05 / 06 / 07** 结案 / 作废 / 恢复 / 删除（全部改建议动作 + 留痕）

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- 平价测试（算法/数据层）全绿属**另一条门禁**，不能替代本页面级清单。
