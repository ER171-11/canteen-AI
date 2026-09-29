# 迁移基线 · 进货入库（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-buy`「进货入库」（HTML 第 294–330 行区域，脚本区块 1481 起）
> 目标系统：`apps/admin-web/src/pages/inventory/InboundPage.tsx`（**T6 收尾后 832 行**）+ `bff/routes/inventory.js` + `bff/routes/settle.js`
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　更新日期：2026-09-29（**T6 收尾**：翻转 FP-RECV-01/08/09 并**全表重取新版行号**；上一版为 T6-C 批量导入 + 模板）
> 状态：🟡 进行中　规范依据：`docs/迁移颗粒度规范.md`
>
> **行号时效**：表中**旧版**行号指向只读的旧 HTML（永不变）；**新版**行号是**当前源码快照**，
> 任何改动 `InboundPage.tsx` 的任务都必须复核并同步本表行号（T5 后曾发生整体漂移，
> 已按 721 行版本全表复核）。行号是证据，漂移的行号等于没有证据。
>
> **已复核（2026-09-29 T6 收尾）**：全 15 行新版行号已按 **832 行版本**逐条重取，上一版（721 行快照）行号全部作废；
> 同批更正 T6-C 记错的文件行数（`bff/lib/recv_import.js` 791 → **832**、`RecvImportModal.tsx` 314 → **336**）。

---

## 功能点清单

| FP ID | 功能点 | 旧版证据 | 新版现状 | 状态 | 处置 / 关联 |
|---|---|---|---|---|---|
| FP-RECV-01 | 新建进货单（手工录入：供应商/明细/实付/欠款/关联采购单） | HTML:299 `#btnNewRecv`、:1488 → `openRecv()` :1663 | `RecvFormModal.tsx`（418 行，字段逐一对齐旧版 `openRecv`：供应商 / 日期 / 明细（原料·订购量·实收量·单价·金额）/ 实付 / 付款方式 / 欠款 / 关联采购单 / 备注；提交**只投 `recv.inbound`**）；入口 `InboundPage.tsx`:595-604 工具栏「新建进货单」、:803-811 弹窗挂载、:128 状态、:109-110 关联采购单数据源；空态文案 :617；执行器 `applyRecvInbound`（`bff/lib/algorithms/inventory.js`:436，T6-A 补 `paid/method/po/recvQty` 可选超集）、`registry.js`:30 注册 `recv.inbound`；`recv_inbound.test.js` 11 例 | ⬆️ 已移植 | 走「`recv.inbound` 建议动作 → `/api/actions` 队列 → 审批 → 消费器」，**不直写库**；录入边界（云端唯一入口）由 `ADR-004` 定案；5 处已知差异与遗留项见 `ADR-004` §7 与任务清单 §8.2.2 |
| FP-RECV-02 | 进货单批量导入（.xlsx / 伪 .xls(网页表格) / .csv / .tsv / .json） | 说明 HTML:318、`#fileRecvImport` :327 → `readImportFile` :3547 → `previewRecvImport` :3591 → `commitRecImport` :3650（注：`previewRecImport` :3709 / `commitRecImport` :3754 是**食谱卡**导入，不是采购单，见备注 3） | 预览端点 `POST /api/inventory/recv/import/preview`（`bff/routes/inventory.js`:226-261 `handleRecvImportPreview`、:262-264 挂载）；解析层 `bff/lib/recv_import.js`（832 行，**零依赖纯计算**：`parseImportFile` :656 → `buildPreview` :683 → `previewImport` :748）；执行器 `bff/lib/algorithms/inventory.js` `applyRecvImport` :820（批末统一 `rebuildStock` 一次），`registry.js`:36 注册 `recv.import`；前端 `RecvImportModal.tsx`（336 行：选文件 → 预览 → 只投一个动作）、`InboundPage.tsx`:589-594 工具条「批量导入」、:824-829 弹窗挂载、:132-133 状态 | ⬆️ 已移植 | 分两阶段：**预览零写**（反复点预览也不落库，已由路由测试逐字节断言）→ **提交只入队一个 `recv.import`**（批内原子）；4 项校验说明见备注 4 |
| FP-RECV-03 | 下载导入模板 | `#btnRecvTpl` HTML:301 → :3791 实际绑定到 **`downloadPoTemplate` :3778**（不是 `downloadRecTemplate` :3784——后者是食谱卡模板，见备注 3） | `apps/admin-web/src/pages/inventory/recvTemplate.ts`（33 行，`downloadRecvTemplate()` 逐字段照抄旧版：6 列表头 + BOM + 示例行「海南菜篮子实业有限公司」）；入口 `InboundPage.tsx`:587-588 工具条「下载导入模板」 | ⬆️ 已移植 | **只读**：客户端生成 CSV 直接下载，零请求零写库；文件名沿用旧版语义 `进货单批量导入模板_<日期>.csv` |
| FP-RECV-04 | 行内结算单（打印 / CSV / 电子版 HTML / PDF） | HTML:1528 `data-recvsettle` → `openSettle` :2486、`printSettle` :2229、PDF :2440 | `InboundPage.tsx`:381-384 行内「结算单」按钮、:777-785 弹窗挂载；`settle/SettleModal.tsx`（142 行）四按钮 = 打印 `html.ts` 开窗打印 / 导出 PDF / 电子版 HTML / CSV；`settle/export.ts`（107 行）、`settle/pdf.ts`（520 行，零依赖 Canvas→JPEG→PDF 字节流）、`settle/data.ts`（131 行，`numToCn` 大写金额、CSV 含 BOM） | ⬆️ 已移植 | 只读输出层，**零写库**；验证：点行内「结算单」→ 四种输出均可生成且与旧版版面一致 |
| FP-RECV-05 | 批量生成结算单（N 张 → 连续 PDF / 合并 CSV） | HTML:302 `#btnSettleBatch` → `openSettleBatch` :2548 | `InboundPage.tsx`:584-586 工具条「批量结算单」、:786-793 弹窗挂载；`settle/SettleBatchModal.tsx`（230 行，勾选/全选/仅选有欠款 + 实时合计） | ⬆️ 已移植 | 验证：批量导出 PDF 为**单一文件**（每张首页，内容超页自动续页），CSV 为合并表 |
| FP-RECV-06 | 结算单模板配置（抬头/地址/税号/收款单位/签字栏） | HTML:615 设置区 | `SystemConfigPage.tsx`:63-131 状态与读写、:212-286「结算单模板」卡片；后端 `bff/routes/settle.js` `GET/PUT /api/settle/template`（字段白名单清洗、仅老板/店长可写、审计留痕），存 `bff/data/settle_template.json` | ⬆️ 已移植 | **与 FP-SET-18 为同一功能的重复登记**（旧版同一表单既服务结算单又列在设置页）；存储形态变更见 `ADR-003`；只读输出层，**不写业务库** |
| FP-RECV-07 | 补付（欠款清收，登记后续付款） | HTML:1529 `data-pay`、:2054「补付/收款通用」 | `InboundPage.tsx`:386-390 行内「补付」（仅欠款单 + 有写权限可见）、:795-801 弹窗挂载；`PayModal.tsx`（145 行，入队）；`bff/lib/algorithms/inventory.js` `applyRecvPay`；`registry.js` 注册 `recv.pay`（未注册会被消费器判 `need-manual` 驳回）；`recv_pay.test.js` 用例 | ⬆️ 已移植 | **走确认队列**（`/api/actions` + rev），不直写库；服务端强制校验 `0 < amount ≤ 欠款 + 0.01`；验证：确认后欠款归零、状态回写 |
| FP-RECV-08 | 编辑进货单 | HTML:1530 `data-recvedit` | `InboundPage.tsx`:396-401 行内「编辑」（已作废单不显示）、:813-822 弹窗挂载（复用 `RecvFormModal` 的 `editDoc` 编辑模式）、:129-131 状态；执行器 `applyRecvUpdate`（`bff/lib/algorithms/inventory.js`:685：只改有传字段、保留补付记录、超付拒绝、已作废单拒改）、`registry.js`:33 注册 `recv.update`；`recv_update.test.js` 7 例 | ⬆️ 已移植 | 走「编辑建议动作 → `/api/actions` 队列 → 审批 → 消费器」，**不直写库**（红线③）；旧版直改内存数组，新版不可照搬 |
| FP-RECV-09 | 删除 / 作废进货单 | HTML:1531 `data-recvdel` | `InboundPage.tsx`:402-416 行内「作废」`Popconfirm` 二次确认、:264-279 `voidRecv`（**只投 `recv.void`**）、:363-364「已作废」`Tag`、:68-71 `isVoided`；执行器 `applyRecvVoid`（`bff/lib/algorithms/inventory.js`:770：**只置 `status='已作废'`**，记 `void_operator/void_at/void_rev/void_reason/void_trace`；`stock.js` 的 `rebuildStock` 跳过作废单 → 库存自动回退）、`registry.js`:34 注册 `recv.void`；`recv_void.test.js` 6 例 | ⬆️ 已移植 | 走确认队列；**只留痕、不物理删除**（旧版 `delRecv` 的物理删除不得照搬）；作废后原单仍在列表且标「已作废」；⚠️ 为回退库存对 `stock.js::rebuildStock` 加的跳过规则**触碰红线①，待人工裁定**，见备注 5 |
| FP-RECV-10 | 顶部汇总卡（本月进货应付 / 累计应付 / 累计实付 / 欠供应商） | `renderRecvKpi()` :1502-1511（口径：本月 = `daysAgo(29)` 起**近 30 天**，非自然月） | `InboundPage.tsx`:228-239 `kpi` useMemo 计算 + :531-563 四张 `Statistic` 卡（用**全部 docs**，不随供应商筛选变化，与旧版一致） | ⬆️ 已移植 | 验证：打开 /inventory/inbound，顶部四卡显示数值；欠供应商 = 累计应付 − 累计实付，>0 标红 |
| FP-RECV-11 | 明细行内展开（逐项 名称/数量/单价/金额） | `renderRecv` :1519-1521（逐项 `名称 数量×单价=金额` 全量渲染） | `InboundPage.tsx`:465-496 `lineCols`、:498-526 `expandedRowRender`、Table `expandable` :627-631（含合计行） | ⬆️ 已移植 | 验证：点行首展开箭头 → 显示逐项 原料/订购量/实收量/单价/金额 + 合计 |
| FP-RECV-12 | 供应商筛选 | 界面工具条 | `InboundPage.tsx`:575-582 供应商 `Select`（`filtered` 由 `supplier` 派生） | ⬆️ 已移植 | 验证：打开入库单页筛选供应商 |
| FP-RECV-13 | 验收明细（逐项验收结论：pass/warn/fail 聚合） | 旧版无（新版新增能力） | `InboundPage.tsx`:378-380 行内「验收明细」按钮、:241-251 `drawerAccepts` 聚合、:636-687 `Drawer` | ⬆️ 已移植 | 验证：点「验收明细」查看逐项结论 |
| FP-RECV-14 | 补录验收（走 `recv.accept` 审批队列） | 旧版无（新版新增能力） | `InboundPage.tsx`:391-395 行内「补录」按钮、:689-775 `Modal`（:699-718 构造 `recv.accept` 入队体） | ⬆️ 已移植 | 验证：补录后到审批中心可见该动作 |
| FP-RECV-15 | 付款状态展示（已结清 / 有欠款） | `renderRecv` 列表列 | `InboundPage.tsx`:358-370「结算」列（`docDebt` 分支渲染 `Tag` :363-368） | ⬆️ 已移植 | 验证：欠款单显示黄色「有欠款」 |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 15 |
| ⬆️ 已移植 | 15（其中 2 项为新版**新增**能力：逐项验收、补录验收；13 项为从旧版平移：供应商筛选、付款状态展示、汇总卡、明细展开、结算单、批量结算单、结算单模板、补付、批量导入、下载模板、**新建、编辑、作废**） |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 0 |
| ⚰️ 废弃 | 0 |

> **2026-09-28 更正**：本表汇总原记「⬆️ 3 / ⬜ 12」，与上方 15 行的实际标注（⬆️ 4 / ⬜ 11）不符，
> 已按**行标注为准**更正（行是证据，汇总是派生）。
> 同日 T4 补齐 FP-RECV-10/11 后为 **⬆️ 6 / ⬜ 9**；T5 补齐 FP-RECV-04/05/06/07 后为 **⬆️ 10 / ⬜ 5**。
> **2026-09-29**：T6-C 补齐 FP-RECV-02/03（批量导入 + 模板）后为 **⬆️ 12 / ⬜ 3**。
> **2026-09-29（T6 收尾 / 阶段 5）**：FP-RECV-01/08/09 翻转为 ⬆️ → 本页 **⬆️ 15 / ⬜ 0**，进货入库页欠账清零。
> 翻转依据：三项代码已由阶段 2/3/4 落地并提交，且已跑真实 HTTP 链路（`/api/actions` → 消费器 → 落库）实证；
> 同批复核全表行号与 `gen-debt-table.ps1 -Check` 无漂移。

**结论**：旧版「进货入库」页 15 项功能中，**13 项是真正从旧版平移过来的**（供应商筛选、付款状态展示、汇总卡、明细展开、结算单、批量结算单、结算单模板、补付、批量导入、下载模板、新建、编辑、作废），
其余 2 项已移植项是新版自身的新增能力（逐项验收、补录验收）。**页面级 ⬜ 已清零，但「清零」≠「已验收」**：
人工开箱复核（`§7` 验收判据）与结算单 PDF 版面比对（备注「视觉校验欠账」）仍未做，见 `docs/下一步任务清单_2026-09-28.md` §7.1。

## 建议补齐顺序

1. ~~**FP-RECV-10** 汇总卡（只读、无红线障碍、老板每天看）— 成本最低~~ ✅ 已完成（T4）
2. ~~**FP-RECV-11** 明细展开（只读）~~ ✅ 已完成（T4）
3. ~~**FP-RECV-04/05/06** 结算单全家桶（老板付款要用的单据，业务闭环）~~ ✅ 已完成（T5-P1/P2）
4. ~~**FP-RECV-07** 补付（欠款清收闭环）~~ ✅ 已完成（T5-P3）
5. ~~**FP-RECV-02/03** 批量导入 + 下载模板~~ ✅ 已完成（T6-C 阶段 4，2026-09-29）
6. ~~**FP-RECV-01/08/09** 新建 / 编辑 / 作废（必须做成建议动作走队列，不得直写）~~ ✅ 已完成（阶段 2/3 落地，T6 收尾阶段 5 翻转基线，2026-09-29）

## 备注

- 本清单为**首个试点**，用于验证 `docs/迁移颗粒度规范.md` 的可执行性；后续页面照此建立。
- 平价测试（算法/数据层）已全绿，属**另一条门禁**，不能替代本页面级清单。
- **重复登记**：FP-RECV-06 与 FP-SET-18（结算单模板配置）是同一份实现的两个入口，非两项工作量；
  统计口径上两处各记 1 项，汇总时不要再重复计工作量。
- **视觉校验欠账**：T5 的 PDF 引擎为零依赖手写实现（Canvas 光栅化 → JPEG → PDF 字节流），
  单元/类型/构建门禁均通过，但**未做人工开箱比对**（旧版与新版 PDF 逐页目视），需按 T2 同样方式人工复核后再转正式基线。
- **⚠️ 待人工裁定（红线①）：`rebuildStock` 被改写**。T6-B（提交 `7367c1a`）为让作废单回退库存，
  在 `bff/lib/algorithms/stock.js` 的 `rebuildStock` 里加了一条「`status` 含 `作废`/`void` 则跳过」的分支，
  而 Python 原实现 `old/store-inventory-legacy/python-runtime/queue_consumer.py` 的重放循环（:220-224）
  只有「草稿/待」两个跳过条件 —— 两端**不再逐字段一致**（差异只在新版独有的「已作废」状态下出现，
  旧版是物理删除，该状态不存在于 Python 输入域，故 `stock.test.js` 的 fixture 盖不到它）。
  红线①原文是「`rebuildStock` 只可调用，不可改写」，且 `ci/redline_baseline.sha256` 的哈希范围只含
  `bff/store-node/db.js`/`merge.js`，`stock.js` 不在其中，因此门禁查不出这次改写。
  **处置建议**：或在下一阶段正式登记为「有意偏离」并把 `stock.js` 纳入哈希基线，
  或改回原实现另寻回退路径。本阶段**只记录、不改代码**（`docs/Python到Node忠实性映射表.md` §1/§3 已同步标注）。
- **旧版证据更正（2026-09-29，T6-C 实施时发现）**：本表原先把 FP-RECV-02 的证据写成
  `previewRecImport :3709` / `commitRecImport :3754`、FP-RECV-03 写成 `downloadRecTemplate :3784` ——
  这三项实为**菜品配方页的「食谱卡」导入**（`#fileRecImport` :327 → `readImportFile(f,'rec')` :3797、
  `#btnRecTpl` :3793）。进货入库真正的链路是 `#fileRecvImport` :327 → `readImportFile(f,'po')` :3794 →
  `parseRecvTable` :3388 → `previewRecvImport` :3591 → `commitRecvImport` :3650，
  模板按钮 `#btnRecvTpl` :3791 绑定到的是 **`downloadPoTemplate` :3778**。证据已按行更正，实现本来就是照「进货入库」这条做的，不涉及代码改动。
- **T6-C 的 4 项校验说明（FP-RECV-02）**：
  1. **预览零写**：`bff/routes/recv_import.test.js` 断言「预览前后 `snapshot.json` 字节一致、数据目录无新文件」；
     真实 HTTP 链路也已复跑（详见 `docs/下一步任务清单_2026-09-28.md` §8.2.4）。
  2. **整批一个动作**：`RecvImportModal` 只投 1 条 `recv.import`，执行器 `applyRecvImport` 批末统一 `rebuildStock` 一次
     （`recv_import.test.js` 用例 3 断言 `rebuild_stock` 在返回摘要里只出现 1 次）。
  3. **明确不支持必须可见**：旧版二进制 .xls（OLE2/BIFF8）**不支持**，解析层直接返回「另存为 .xlsx 或 CSV」；
     界面「支持格式」清单同时写清 xlsx / 伪 .xls(html) / csv / tsv / json（红线⑥ 不静默降级）。
  4. **与旧版的已知差异**（界面已明示）：① 未匹配原料**不自动建档**（旧版 `createIngFromImport` 会新建）；
     ② 无「手动指定列」（旧版 `openColMap` :3465），表头靠别名自动识别；③ 数量非数字的行计 `bad` 并剔除，
     与此区分的是「实收数为 ×/未收」的业务性跳过（计 `skipped`，旧版两者混为一谈）；④ 不回写采购单收货进度。
