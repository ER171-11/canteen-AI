# 迁移基线 · 外接比价（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-price`「外接比价」（HTML 第 502–541 行区域）
> 目标系统：`apps/admin-web/src/pages/inventory/VendorsPage.tsx`（/inventory/vendors「供应商比价」，含「原料比价」Tab）；BFF 只读端点 `GET /api/admin/price`（`bff/routes/admin.js`）→ 纯聚合 `bff/lib/price.js`
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/规范/迁移颗粒度规范.md`
> **行号复核**：2026-10-10 W1 补齐 FP-PRICE-01/02/03/13/14 后，按 `VendorsPage.tsx`（现约 455 行）/ `bff/lib/price.js` 全表复核新版行号。

---

## 功能点清单

| FP ID | 功能点 | 旧版证据 | 新版现状 | 状态 | 处置 / 关联 |
|---|---|---|---|---|---|
| FP-PRICE-01 | 原料搜索 | HTML:505 `#priceSearch`、`renderPrice` :4936 | `VendorsPage.tsx`:370-393 搜索框 + `priceRows` :226-235（`name`/`cat` 过滤） | ⬆️ 已移植 | 只读过滤 |
| FP-PRICE-02 | 按比价结果筛选（外价更低/外价更高/暂无报价） | HTML:507-512 `#priceFilter`、`renderPrice` :4940-4945 | `VendorsPage.tsx`:370-393 筛选下拉（全部/外价更低/外价更高/暂无报价）+ `priceRows` :230-232 | ⬆️ 已移植 | 只读过滤；依赖 FP-PRICE-03 的 diff |
| FP-PRICE-03 | 比价主表（本店均价 / 外部最低报价 / 差价 / 节省或增加 % / 来源与时间） | HTML:527-535 表头、`renderPrice` :4946-4961 | `VendorsPage.tsx`:165-211 `priceCols` 主表（本店均价/外部最低报价/差价/节省%/来源时间）+ `bff/lib/price.js` `priceReport`（本店均价 `ing.avg` vs 最低折价 `bestQuote`） | ⬆️ 已移植 | 只读聚合；口径同旧版 `quotePerStock`/`bestQuote` |
| FP-PRICE-04 | 录入外部报价（来源/金额/日期/备注） | HTML:4996-5003 表单、`openQuote` :4989-5033 | `VendorsPage.tsx`「录入供应商报价」Modal（原料下拉**取原料 id**、`name` 随报价落库）+ `POST /api/supply/quote` → `quote.upsert`（执行器已登记于 `bff/lib/algorithms/registry.js:31`，实现 `bff/lib/algorithms/inventory.js::applyQuoteUpsert`） | ⬆️ 已移植 | 写类：入队 → 审批中心 → 店内消费器落快照 `data.quotes`。幂等键 `ing+src` 已归一到原料 id（历史按名录入的行就地自愈） |
| FP-PRICE-05 | 录入时选报价口径（按采购单位/按库存单位）并实时折算「低 X 元（省 X%）」 | HTML:4998-5000 `#qPer`、`upd()` :5013-5022、`quotePerStock` :4929 | `VendorsPage.tsx` 录入报价：「原料」为在售原料下拉（带本店均价）+「报价口径」下拉（按采购单位/按库存单位）+ 实时折算 `Alert`（折算 ¥/单位 + 对比本店均价「低/高 X 元（省/贵 P%）」）+ `logSupplyQuote` 透传 `per` | ⬆️ 已移植 | 折算口径同 `bff/lib/price.js` `quotePerStock`（`per='buy'` 时 ÷`conv`）；`per` 随 `quote.upsert` 落 `data.quotes[].per` |
| FP-PRICE-06 | 查看某原料的报价记录列表（多家对比） | HTML:4960 `data-quotelist`、`quoteListHtml` :4971 | `VendorsPage.tsx`：比价表与原料比价主表**按原料行展开**报价明细（日期/来源/报价/折库存单位价/对比本店/备注），数据源 `bff/lib/price.js::quotesOf`（比价表走 `bff/lib/supply.js::compareReport` 的 `quotes`） | ⬆️ 已移植 | 只读聚合；明细列逐列对齐旧版 `quoteListHtml`（删报价行 = FP-PRICE-07，未做） |
| FP-PRICE-07 | 删除某条报价记录 | HTML:4979 `data-qdel`、:4982-4988 | `VendorsPage.tsx` 报价明细（比价表 / 原料比价表 / 全部报价记录）末列「删」`Popconfirm`；`POST /api/supply/quote/delete` → `quote.delete`；执行器 `bff/lib/algorithms/inventory.js::applyQuoteDelete`（`id` 优先，否则 `ing+src`，与 `quote.upsert` 幂等键同口径） | ⬆️ 已移植 | 写类：入队 → 审批中心 → 落快照 `data.quotes`。红线 #6 只摘一行报价、不动原料/库存/进货单；红线 #7 零命中显式报错（动作置「已驳回」） |
| FP-PRICE-08 | 查看全部报价记录（全量表格） | HTML:514 `#btnQuoteAll`、:4928 → `openQuoteList` :5035 | `VendorsPage.tsx`「全部报价记录（N）」按钮 + Modal 全量表（日期/原料/来源/报价/折库存单位价/对比本店/备注），数据由 `price.report.rows[].quotes` 展平后按日期倒序——与主表**同源同口径** | ⬆️ 已移植 | 验证：列含「折库存单位价 / 对比本店」；行数与主表报价合计一致 |
| FP-PRICE-09 | 一键跳转外部平台搜索（1688/京东/拼多多，`{kw}` 占位） | `pricePop` :1178、`openQuote` :5006-5010 | `VendorsPage.tsx` 比价主表「去比价」列：`Dropdown` 展开各平台外链（`comparePlatformUrl(tpl, 原料名)`，`pages/inventory/comparePlatforms.ts`） | ⬆️ 已移植 | 只读外链；口径照抄旧版 `pricePop`（HTML:1178-1182：`{kw}` → `encodeURIComponent(原料名)`）。平台表读 `config.compare_platforms` |
| FP-PRICE-10 | 在设置中增改平台搜索地址模板（`{kw}`） | HTML:537 说明文案 | `SystemConfigPage.tsx`「外接比价平台」卡片（名称 + URL 模板的增/删/改）——与 FP-SET-03/04 **同一实现** | ⬆️ 已移植 | 配置类：`config.compare_platforms` 经 `config.update` 审批队列。**与 FP-SET-03/04 是同一实现的重复登记**（非两项工作量） |
| FP-PRICE-11 | 生成并下载「待比价任务」JSON（供外部脚本抓价） | HTML:518 `#btnPriceTask`、:5161 → `exportQuoteTask` :5069 | `GET /api/export/quote-task.json`（`bff/routes/export.js::quoteTaskJSON`，清单口径复用 `lib/price.js::pricePlan`）+ `VendorsPage.tsx` 原料比价 Tab「导出待比价任务」按钮 | ⬆️ 已移植 | 只读导出（文件下载，**不写库**）；契约 `panda-quote-task` v1（`type/version/rest/generatedAt/guide/items[9 键]`），外部 `比价脚本/fetch_quotes.py` 可直接消费 |
| FP-PRICE-12 | 导入「比价结果」JSON（按 conv 折算、同 原料+来源+价格 去重追加） | HTML:519 `#fileQuoteImport`、:5163 → `importQuoteResult` :5110 | **已落地**：`quote.import` 批量动作（执行器 `bff/lib/algorithms/inventory.js::applyQuoteImport`，整批一个动作，只写 `data.quotes`）+ 纯解析层 `bff/lib/quote_import.js`（preview/run 同口径）；只读预览 `POST /api/supply/quote/import/preview` + 写入口 `POST /api/supply/quote/import`（均入队）。`quote.upsert` 新增 `append` 模式（按 `ing+src+price(+date)` 去重追加、完全相同行跳过不覆盖） | ⬆️ 已移植 | 写类（ADR-013 D2）：同原料不同价**并存**；`conv≠1` 原料默认跳过（不自动推断跨单位价格）；缺 `ing/src`/`price` 非法归 `invalid`，显式报错不静默吞；预览即所见、提交即所得。前端 `VendorsPage`「比价」Tab「导入比价结果」→ `QuoteImportModal`（选 JSON → 预览命中/跳过/非法 → 确认入队） |
| FP-PRICE-13 | 查看待比价清单（原料/分类/建议关键词/采购单位换算/本店均价/状态） | HTML:520 `#btnPricePlan`、:5162 → `openQuotePlan` :5091 | `VendorsPage.tsx`:214-224 `planCols` + :447-451 Modal + `bff/lib/price.js` `pricePlan`（在售过滤 + 关键词净化 `quoteKeyword`） | ⬆️ 已移植 | 只读聚合 |
| FP-PRICE-14 | 顶部待比价原料统计提示（在售 N 种 / 尚无报价 M 种） | HTML:522 `#priceTaskTip`、`quoteTaskText` :5082、`renderPriceTaskTip` :5088 | `VendorsPage.tsx` 原料比价 Tab 顶部 Alert（待比价 N · 尚无报价 M · 已有报价 K，并显式标注 `M+K=N`）+ `priceReport` `tip` | ⬆️ 已移植 | 只读聚合，随 FP-PRICE-13；口径同旧版 `quoteTaskText`（N = 在售原料总数） |
| FP-PRICE-15 | 设为该原料默认供应商（新版新增能力） | 旧版无 | `VendorsPage.tsx` 录入报价 Modal「设为该原料默认供应商」`Switch` → `set_default_sup` 随 `quote.upsert` 入队；执行器 `applyQuoteUpsert::bindDefaultSup` | ⬆️ 已移植 | 验证：新建与**覆盖既有报价**两条路径均写入 `data.ings[].sup`（原实现只在新建分支生效，已修） |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 15 |
| ⬆️ 已移植 | 15（其中 1 项为新版新增能力：FP-PRICE-15） |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 0（FP-PRICE-12 导入比价结果已于 ADR-013 第 2 批落地） |
| ⚰️ 废弃 | 0 |

**结论**：比价页核心价值——「本店均价 vs 外部报价」的差价与节省%——已补齐（FP-PRICE-01/02/03/13/14），
老板现在能判断「换供应商能省多少钱」。**一键比价链路已闭环**（FP-PRICE-11 导出任务 → 外部 `fetch_quotes.py` 抓价 → FP-PRICE-12 导回结果），
报价删除（FP-PRICE-07）已按红线走审批队列；剩余缺口只有 **FP-PRICE-12 导入比价结果**（D2 append 模式）。
> **2026-10-10 W1 更新**：补齐比价主表/待比价清单/统计/搜索/筛选 5 项（FP-PRICE-01/02/03/13/14），
> 均为只读聚合；复用纯模块 `bff/lib/price.js`（`priceReport`/`pricePlan`/`bestQuote`/`quotePerStock`/`quoteKeyword`），
> 口径逐行对齐旧版 `renderPrice`/`openQuotePlan`/`quoteTaskText`。
> **2026-10-10 W1 续（阶段 20）**：补 FP-PRICE-05 录入口径 + 实时折算（`VendorsPage` 录入报价表单），
> 折算口径同 `quotePerStock`，逐行对齐旧版 `upd()`（HTML:5013-5022）。`per` 持久化随 FP-PRICE-04 的 consumer 执行器一并修复。
> **2026-10-10 W2 更新**：补 FP-PRICE-09/10 外链与平台模板——比价主表「去比价」列（`Dropdown` 展开各平台外链，
> 口径同旧版 `pricePop`）+ 设置页「外接比价平台」卡片（存 `config.compare_platforms`）；与 FP-SET-03/04 同一实现。
> **2026-10-14 修复批次（比价口径与报价记录）**：①**报价归属口径纠偏**——录入口此前把「原料名」当 `ing`
> 提交，导致 `priceReport`（按 `q.ing === g.id` 归集）全部显示「暂无报价」，而比价表（按名称归集）能看到，
> 同一份报价两表口径分叉；现改为录入取原料 id + 随报 `name`，`price.js::quoteMatches` 做「id 优先、名称回退」
> 归集（存量按名录入的报价自动纳入），执行器 `quoteIngKey` 把历史行就地归一，幂等键 `ing+src` 才真正唯一。
> ②**比价表显示修复**：候选价统一经 `quotePerStock` 折算「元/库存单位」后比较（原实现直接比原报价，跨口径会错）；
> 单家报价 `spread_pct = null` 不再误显 `0%`（最高价/价差显示 `-`）；补「本店均价 / 对比本店」列与主表对齐；
> 本店均价为 0（无采购基价）时「对比本店 / 差价 / 节省%」显示 `-`，不再得出「外价比 ¥0 贵 X 元」的失真结论；
> 「来源与时间」改取**最近两条**（原 `slice(-2).reverse()` 在倒序列表上取到了最旧两条）；汇总卡「最大价差」
> 只取真正有价差的原料。③补 **FP-PRICE-06/08** 两表行展开报价明细与「全部报价记录」全量表（含折库存单位价 /
> 对比本店），与主表同源。④**FP-PRICE-15** 「设为默认供应商」在覆盖既有报价时同样生效。⑤补 `bff/lib/supply.test.js`
> 并扩展 `bff/lib/price.test.js`；Node/Python 平价 34 例全绿。

## 建议补齐顺序

1. ~~**FP-PRICE-01 / 02** 搜索 + 结果筛选（只读过滤）~~ ✅ 已完成（W1，2026-10-10）
2. ~~**FP-PRICE-03** 补齐本店均价 / 差价 / 节省% 三列（**比价页核心价值**）~~ ✅ 已完成（W1，2026-10-10）
3. ~~**FP-PRICE-05** 口径折算（避免省错钱）~~ ✅ 已完成（W1，2026-10-10；`per` 落库随第 4 项 consumer 执行器一并修）
4. ~~**FP-PRICE-07** 报价删除 + 补 `consumer.js` 的 quote 执行器~~ ✅ 已完成（ADR-013 第 1 批，2026-10-29）
5. ~~**FP-PRICE-11** 导出待比价任务~~ ✅ 已完成（ADR-013 第 1 批，2026-10-29）；剩 **FP-PRICE-12** 导入比价结果（D2 append 模式）
6. ~~**FP-PRICE-09 / 10** 外链与平台模板配置~~ ✅ 已完成（W2，2026-10-10）

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/规范/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- FP-PRICE-04 的 `quote.upsert` 执行器**已登记**（`bff/lib/algorithms/registry.js:31` → `inv.applyQuoteUpsert`，经
  `bff/store-node/consumer.js` 按 `lib/algorithms` 注册表派发），原「消费器无 quote 执行器」的描述已过时。
