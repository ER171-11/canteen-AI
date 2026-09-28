# 迁移基线 · 外接比价（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-price`「外接比价」（HTML 第 502–541 行区域）
> 目标系统：`apps/admin-web/src/pages/inventory/VendorsPage.tsx`（/inventory/vendors「供应商比价」）；BFF 无比价端点，仅 `quote.upsert` 经 `/api/actions` 入队（`bff/routes/actions.js`:217）
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/迁移颗粒度规范.md`

---

## 功能点清单

| FP ID | 功能点 | 旧版证据 | 新版现状 | 状态 | 处置 / 关联 |
|---|---|---|---|---|---|
| FP-PRICE-01 | 原料搜索 | HTML:505 `#priceSearch`、`renderPrice` :4936 | 无（VendorsPage 无搜索框） | ⬜ 待补 | 只读过滤，**成本最低** |
| FP-PRICE-02 | 按比价结果筛选（外价更低/外价更高/暂无报价） | HTML:507-512 `#priceFilter`、`renderPrice` :4940-4945 | 无 | ⬜ 待补 | 只读过滤；需本店均价参与计算 |
| FP-PRICE-03 | 比价主表（本店均价 / 外部最低报价 / 差价 / 节省或增加 % / 来源与时间） | HTML:527-535 表头、`renderPrice` :4946-4961 | 部分：`VendorsPage.tsx`:117-141（原料/来源/报价/日期/备注）、最低价 Tag :129-133；**无本店均价、无差价、无节省%** | ⬜ 待补 | 只读聚合；需快照提供 ing.avg 与 conv 换算 |
| FP-PRICE-04 | 录入外部报价（来源/金额/日期/备注） | HTML:4996-5003 表单、`openQuote` :4989-5033 | `VendorsPage.tsx`:169-226（`quote.upsert`） | ⬆️ 已移植 | 验证：点「录入报价」→ 审批中心。**缺口**：`bff/store-node/consumer.js` 无 quote 执行器，需配套落库 |
| FP-PRICE-05 | 录入时选报价口径（按采购单位/按库存单位）并实时折算「低 X 元（省 X%）」 | HTML:4998-5000 `#qPer`、`upd()` :5013-5022、`quotePerStock` :4929 | 无（VendorsPage 仅单一 price 字段，无 per/折算/实时对比） | ⬜ 待补 | 只读计算 + 写入扩展字段 per；**影响省钱判断准确性** |
| FP-PRICE-06 | 查看某原料的报价记录列表（多家对比） | HTML:4960 `data-quotelist`、`quoteListHtml` :4971 | `VendorsPage.tsx`:79-115（按原料分组展示） | ⬆️ 已移植 | 验证：比价页按原料行查看多家报价 |
| FP-PRICE-07 | 删除某条报价记录 | HTML:4979 `data-qdel`、:4982-4988 | 无（有 `quote.upsert` 无 `quote.del`） | ⬜ 待补 | 写类：`quote.delete` 走审批队列，留痕 |
| FP-PRICE-08 | 查看全部报价记录（全量表格） | HTML:514 `#btnQuoteAll`、:4928 → `openQuoteList` :5035 | `VendorsPage.tsx`:159-165 全量报价表 | ⬆️ 已移植 | 验证：/inventory/vendors 表格；缺「折库存单位 / 对比本店」列（见 FP-PRICE-03） |
| FP-PRICE-09 | 一键跳转外部平台搜索（1688/京东/拼多多，`{kw}` 占位） | `pricePop` :1178、`openQuote` :5006-5010 | 无 | ⬜ 待补 | 只读外链；依赖 FP-PRICE-10 的平台配置 |
| FP-PRICE-10 | 在设置中增改平台搜索地址模板（`{kw}`） | HTML:537 说明文案 | 无（`SystemConfigPage.tsx`:118-129 仅 SOP/安全库存） | ⬜ 待补 | 配置类：走 `config.update` 审批队列（与 FP-SET-03/04 同一缺口） |
| FP-PRICE-11 | 生成并下载「待比价任务」JSON（供外部脚本抓价） | HTML:518 `#btnPriceTask`、:5161 → `exportQuoteTask` :5069 | 无；BFF 无比价端点 | ⬜ 待补 | 只读导出（文件下载，**不写库**） |
| FP-PRICE-12 | 导入「比价结果」JSON（按 conv 折算、同 原料+来源+价格 去重追加） | HTML:519 `#fileQuoteImport`、:5163 → `importQuoteResult` :5110 | 无 | ⬜ 待补 | 写类：批量建议动作入队 |
| FP-PRICE-13 | 查看待比价清单（原料/分类/建议关键词/采购单位换算/本店均价/状态） | HTML:520 `#btnPricePlan`、:5162 → `openQuotePlan` :5091 | 无 | ⬜ 待补 | 只读聚合 |
| FP-PRICE-14 | 顶部待比价原料统计提示（在售 N 种 / 尚无报价 M 种） | HTML:522 `#priceTaskTip`、`quoteTaskText` :5082、`renderPriceTaskTip` :5088 | 无 | ⬜ 待补 | 只读聚合，随 FP-PRICE-13 |
| FP-PRICE-15 | 设为该原料默认供应商（新版新增能力） | 旧版无 | `VendorsPage.tsx`:219-221（`set_default_sup`） | ⬆️ 已移植 | 验证：录入报价时勾「设为默认供应商」 |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 15 |
| ⬆️ 已移植 | 4（其中 1 项为新版新增能力：FP-PRICE-15） |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 11 |
| ⚰️ 废弃 | 0 |

**结论**：报价「录入 + 查看」已通，但**比价页的核心价值——「本店均价 vs 外部报价」的差价与节省%——完全缺失**，
老板无法判断「换供应商能省多少钱」。一键比价（导出任务 → 外部抓价 → 导入结果）链路未移植。

## 建议补齐顺序

1. **FP-PRICE-01 / 02** 搜索 + 结果筛选（只读过滤）
2. **FP-PRICE-03** 补齐本店均价 / 差价 / 节省% 三列（**比价页核心价值**）
3. **FP-PRICE-05** 口径折算（避免省错钱）
4. **FP-PRICE-07** 报价删除 + 补 `consumer.js` 的 quote 执行器
5. **FP-PRICE-13 / 14 / 11 / 12** 一键比价链路（需先定「脚本跑本地还是云端」）
6. **FP-PRICE-09 / 10** 外链与平台模板配置

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- FP-PRICE-04 虽有 `quote.upsert` 入队，但店内消费器无对应执行器 → **入队后不会落库**，实际不可用，补齐时需一并修。
