# 迁移基线 · 外接比价（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-price`「外接比价」（HTML 第 502–541 行区域）
> 目标系统：`apps/admin-web/src/pages/inventory/VendorsPage.tsx`（/inventory/vendors「供应商比价」，含「原料比价」Tab）；BFF 只读端点 `GET /api/admin/price`（`bff/routes/admin.js`）→ 纯聚合 `bff/lib/price.js`
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/迁移颗粒度规范.md`
> **行号复核**：2026-10-10 W1 补齐 FP-PRICE-01/02/03/13/14 后，按 `VendorsPage.tsx`（现约 455 行）/ `bff/lib/price.js` 全表复核新版行号。

---

## 功能点清单

| FP ID | 功能点 | 旧版证据 | 新版现状 | 状态 | 处置 / 关联 |
|---|---|---|---|---|---|
| FP-PRICE-01 | 原料搜索 | HTML:505 `#priceSearch`、`renderPrice` :4936 | `VendorsPage.tsx`:370-393 搜索框 + `priceRows` :226-235（`name`/`cat` 过滤） | ⬆️ 已移植 | 只读过滤 |
| FP-PRICE-02 | 按比价结果筛选（外价更低/外价更高/暂无报价） | HTML:507-512 `#priceFilter`、`renderPrice` :4940-4945 | `VendorsPage.tsx`:370-393 筛选下拉（全部/外价更低/外价更高/暂无报价）+ `priceRows` :230-232 | ⬆️ 已移植 | 只读过滤；依赖 FP-PRICE-03 的 diff |
| FP-PRICE-03 | 比价主表（本店均价 / 外部最低报价 / 差价 / 节省或增加 % / 来源与时间） | HTML:527-535 表头、`renderPrice` :4946-4961 | `VendorsPage.tsx`:165-211 `priceCols` 主表（本店均价/外部最低报价/差价/节省%/来源时间）+ `bff/lib/price.js` `priceReport`（本店均价 `ing.avg` vs 最低折价 `bestQuote`） | ⬆️ 已移植 | 只读聚合；口径同旧版 `quotePerStock`/`bestQuote` |
| FP-PRICE-04 | 录入外部报价（来源/金额/日期/备注） | HTML:4996-5003 表单、`openQuote` :4989-5033 | `VendorsPage.tsx`:169-226（`quote.upsert`） | ⬆️ 已移植 | 验证：点「录入报价」→ 审批中心。**缺口**：`bff/store-node/consumer.js` 无 quote 执行器，需配套落库 |
| FP-PRICE-05 | 录入时选报价口径（按采购单位/按库存单位）并实时折算「低 X 元（省 X%）」 | HTML:4998-5000 `#qPer`、`upd()` :5013-5022、`quotePerStock` :4929 | `VendorsPage.tsx` 录入报价：「原料」改为在售原料下拉（带本店均价）+「报价口径」下拉（按采购单位/按库存单位）+ 实时折算 `Alert`（折算 ¥/单位 + 对比本店均价「低/高 X 元（省/贵 P%）」）+ `logSupplyQuote` 透传 `per` | ⬆️ 已移植 | 折算口径同 `bff/lib/price.js` `quotePerStock`（`per='buy'` 时 ÷`conv`）；**`per` 落库依赖 FP-PRICE-04 的 consumer quote 执行器**（同源缺口，见 §备注） |
| FP-PRICE-06 | 查看某原料的报价记录列表（多家对比） | HTML:4960 `data-quotelist`、`quoteListHtml` :4971 | `VendorsPage.tsx`:79-115（按原料分组展示） | ⬆️ 已移植 | 验证：比价页按原料行查看多家报价 |
| FP-PRICE-07 | 删除某条报价记录 | HTML:4979 `data-qdel`、:4982-4988 | 无（有 `quote.upsert` 无 `quote.del`） | ⬜ 待补 | 写类：`quote.delete` 走审批队列，留痕 |
| FP-PRICE-08 | 查看全部报价记录（全量表格） | HTML:514 `#btnQuoteAll`、:4928 → `openQuoteList` :5035 | `VendorsPage.tsx`:159-165 全量报价表 | ⬆️ 已移植 | 验证：/inventory/vendors 表格；缺「折库存单位 / 对比本店」列（见 FP-PRICE-03） |
| FP-PRICE-09 | 一键跳转外部平台搜索（1688/京东/拼多多，`{kw}` 占位） | `pricePop` :1178、`openQuote` :5006-5010 | `VendorsPage.tsx` 比价主表「去比价」列：`Dropdown` 展开各平台外链（`comparePlatformUrl(tpl, 原料名)`，`pages/inventory/comparePlatforms.ts`） | ⬆️ 已移植 | 只读外链；口径照抄旧版 `pricePop`（HTML:1178-1182：`{kw}` → `encodeURIComponent(原料名)`）。平台表读 `config.compare_platforms` |
| FP-PRICE-10 | 在设置中增改平台搜索地址模板（`{kw}`） | HTML:537 说明文案 | `SystemConfigPage.tsx`「外接比价平台」卡片（名称 + URL 模板的增/删/改）——与 FP-SET-03/04 **同一实现** | ⬆️ 已移植 | 配置类：`config.compare_platforms` 经 `config.update` 审批队列。**与 FP-SET-03/04 是同一实现的重复登记**（非两项工作量） |
| FP-PRICE-11 | 生成并下载「待比价任务」JSON（供外部脚本抓价） | HTML:518 `#btnPriceTask`、:5161 → `exportQuoteTask` :5069 | 无；BFF 无比价端点 | ⬜ 待补 | 只读导出（文件下载，**不写库**） |
| FP-PRICE-12 | 导入「比价结果」JSON（按 conv 折算、同 原料+来源+价格 去重追加） | HTML:519 `#fileQuoteImport`、:5163 → `importQuoteResult` :5110 | 无 | ⬜ 待补 | 写类：批量建议动作入队 |
| FP-PRICE-13 | 查看待比价清单（原料/分类/建议关键词/采购单位换算/本店均价/状态） | HTML:520 `#btnPricePlan`、:5162 → `openQuotePlan` :5091 | `VendorsPage.tsx`:214-224 `planCols` + :447-451 Modal + `bff/lib/price.js` `pricePlan`（在售过滤 + 关键词净化 `quoteKeyword`） | ⬆️ 已移植 | 只读聚合 |
| FP-PRICE-14 | 顶部待比价原料统计提示（在售 N 种 / 尚无报价 M 种） | HTML:522 `#priceTaskTip`、`quoteTaskText` :5082、`renderPriceTaskTip` :5088 | `VendorsPage.tsx`:370-393 Alert 统计（待比价 N · 尚无报价 M · 已有报价 K）+ `priceReport` `tip` | ⬆️ 已移植 | 只读聚合，随 FP-PRICE-13 |
| FP-PRICE-15 | 设为该原料默认供应商（新版新增能力） | 旧版无 | `VendorsPage.tsx`:219-221（`set_default_sup`） | ⬆️ 已移植 | 验证：录入报价时勾「设为默认供应商」 |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 15 |
| ⬆️ 已移植 | 12（其中 1 项为新版新增能力：FP-PRICE-15） |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 3 |
| ⚰️ 废弃 | 0 |

**结论**：比价页核心价值——「本店均价 vs 外部报价」的差价与节省%——已补齐（FP-PRICE-01/02/03/13/14），
老板现在能判断「换供应商能省多少钱」。剩余缺口集中在**写类与一键比价链路**（口径折算、报价删除、导出/导入任务、外链与平台配置）。
> **2026-10-10 W1 更新**：补齐比价主表/待比价清单/统计/搜索/筛选 5 项（FP-PRICE-01/02/03/13/14），
> 均为只读聚合；复用纯模块 `bff/lib/price.js`（`priceReport`/`pricePlan`/`bestQuote`/`quotePerStock`/`quoteKeyword`），
> 口径逐行对齐旧版 `renderPrice`/`openQuotePlan`/`quoteTaskText`。
> **2026-10-10 W1 续（阶段 20）**：补 FP-PRICE-05 录入口径 + 实时折算（`VendorsPage` 录入报价表单），
> 折算口径同 `quotePerStock`，逐行对齐旧版 `upd()`（HTML:5013-5022）。`per` 持久化随 FP-PRICE-04 的 consumer 执行器一并修复。
> **2026-10-10 W2 更新**：补 FP-PRICE-09/10 外链与平台模板——比价主表「去比价」列（`Dropdown` 展开各平台外链，
> 口径同旧版 `pricePop`）+ 设置页「外接比价平台」卡片（存 `config.compare_platforms`）；与 FP-SET-03/04 同一实现。

## 建议补齐顺序

1. ~~**FP-PRICE-01 / 02** 搜索 + 结果筛选（只读过滤）~~ ✅ 已完成（W1，2026-10-10）
2. ~~**FP-PRICE-03** 补齐本店均价 / 差价 / 节省% 三列（**比价页核心价值**）~~ ✅ 已完成（W1，2026-10-10）
3. ~~**FP-PRICE-05** 口径折算（避免省错钱）~~ ✅ 已完成（W1，2026-10-10；`per` 落库随第 4 项 consumer 执行器一并修）
4. **FP-PRICE-07** 报价删除 + 补 `consumer.js` 的 quote 执行器
5. **FP-PRICE-13 / 14 / 11 / 12** 一键比价链路（需先定「脚本跑本地还是云端」）——其中 13/14 已完成
6. ~~**FP-PRICE-09 / 10** 外链与平台模板配置~~ ✅ 已完成（W2，2026-10-10）

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- FP-PRICE-04 虽有 `quote.upsert` 入队，但店内消费器无对应执行器 → **入队后不会落库**，实际不可用，补齐时需一并修。
