# 迁移基线 · 设置（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-set`「设置」（HTML 第 567–641 行区域，含结算单模板配置区约 615–633 行）
> 目标系统：`apps/admin-web/src/pages/SystemConfigPage.tsx` + `OrgPage.tsx` + `bff/routes/admin.js` + `bff/routes/export.js`
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/迁移颗粒度规范.md`
> **行号复核**：2026-10-10 W1 只读速补后，按 `SystemConfigPage.tsx`（418 行）全表复核新版行号（旧行号已整体漂移）。

---

## 功能点清单

| FP ID | 功能点 | 旧版证据 | 新版现状 | 状态 | 处置 / 关联 |
|---|---|---|---|---|---|
| FP-SET-01 | 查看各模块数据输入通道一览（模块/数据来源/输入方式/当前状态） | HTML:569-586 表格（10 行模块状态） | `SystemConfigPage.tsx`:367-383「各模块数据输入通道一览」表 + `buildChannelRows` :395-417（10 行）；状态由 `GET /api/snapshot/latest` 实时推导 | ⬆️ 已移植 | 读类：只读展示；未接通快照时统一「未接通快照」，不编造数字 |
| FP-SET-02 | 配置餐厅名称 | HTML:588 `#setRest`、:5273 change → `saveDB()` | `SystemConfigPage.tsx`「餐厅名称」卡片（`:318` 展示+编辑，`saveRestName` `:116`）；`bff/routes/admin.js` `GET /api/admin/config` 返 `rest`、`POST /api/admin/rest` | ⬆️ 已移植 | 写类：**新增 `rest.update` 动作**（`inventory.applyRest` + `registry` 登记），写顶层 `data.rest`（字符串，默认「熊猫五福餐厅」）；不并入 `config.update`，避免与 `config` 语义纠缠；经审批队列，仅老板/店长 |
| FP-SET-03 | 新增外接比价平台 | HTML:592 `#btnAddPlat`、:5283 `DB.platforms.push()` | `SystemConfigPage.tsx`「外接比价平台」卡片「新增平台」；存 `config.compare_platforms`（默认 `DEF_COMPARE_PLATFORMS`，`pages/inventory/comparePlatforms.ts`） | ⬆️ 已移植 | 写类：经 `POST /api/admin/config`（config.update，仅老板/店长）。**注意**：快照 `data.platforms` 是**外卖平台**（美团/饿了么），与旧版 `DB.platforms`（比价平台）**同名不同义**，故用 `config.compare_platforms` |
| FP-SET-04 | 编辑/删除已配置平台（名称 + `{kw}` 搜索 URL 模板） | HTML:5230-5235 `#platTable` 渲染、:5277/5280-5282 change/删除 | `SystemConfigPage.tsx`「外接比价平台」表格：名称 / URL 模板逐行可编辑 + 行内「删」 | ⬆️ 已移植 | 写类：随 FP-SET-03；口径照抄旧版 `renderSet`（HTML:5228-5237 / :5277-5283） |
| FP-SET-05 | 配置同步服务地址与本机标识 | HTML:595-596 `#setApiBase`/`#setMachine`、:1083-1089 | 无（新版为中心化 BFF/SaaS，无 P2P 双机同步） | ⬜ 待补 | 建议转 ⚰️ 废弃：架构变更，但**缺业务批准人**，暂留 ⬜ |
| FP-SET-06 | 立即同步（本机 ↔ 本地 SQLite） | HTML:599 `#btnSyncNow`、:1090 → `pushNow()` | 无（BFF 无对应用户触发同步端点） | ⬜ 待补 | 建议转 ⚰️（同 FP-SET-05，待批准） |
| FP-SET-07 | 手动打快照备份 | HTML:600 `#btnSnapNow`、:1091-1093 | 无用户入口。BFF 有 `/api/snapshot/push`（`bff/routes/snapshot.js`:21）但为设备端推送，非用户手动备份 | ⬜ 待补 | 写类：需「服务端快照/文件下载」形态，能力对等判定待 ADR |
| FP-SET-08 | 以数据库为准（覆盖本机） | HTML:601 `#btnPullRemote`、:1095-1103 | 无 | ⬜ 待补 | 同 FP-SET-05（单机架构已消失） |
| FP-SET-09 | 以本机为准（覆盖数据库） | HTML:602 `#btnPushLocal`、:1104-1111 | 无 | ⬜ 待补 | 同 FP-SET-05（**高危覆盖能力，不建议在新版复刻**） |
| FP-SET-10 | 快照列表查看与回滚 | HTML:606 `#snapTable`、:978 `renderSnapTable()`、:1113 点击回滚 | 无列表/回滚端点。BFF 仅 `/api/snapshot/latest` 只读最新（`bff/routes/snapshot.js`:56） | ⬜ 待补 | 写类：**回滚属高危**，须走审批队列并留痕 |
| FP-SET-11 | 导出全量数据备份 JSON | HTML:609 `#btnExport`、:5292 `download()` | `bff/routes/export.js`:`GET /api/export/backup.json`（快照 data+ext 原样，可直接回灌 `/api/snapshot/push`）+ `SystemConfigPage.tsx`:343-365「导出全部数据(JSON)」 | ⬆️ 已移植 | 读类：只读导出；服务端下发（非 localStorage），前端走 axios blob 带 Bearer |
| FP-SET-12 | 导出原料库存 CSV | HTML:610 `#btnCsvIng`、:5296-5300 | `bff/routes/export.js`:`GET /api/export/ings.csv`（11 列照抄旧版 HTML:5297）+ 前端「导出原料CSV」 | ⬆️ 已移植 | 读类：CSV 带 UTF-8 BOM，Excel 友好 |
| FP-SET-13 | 导出菜品成本毛利 CSV | HTML:611 `#btnCsvDish`、:5301-5307 | `GET /api/export/dishes.csv`（9 列；有配方用 `lib/recipe_cost` 每份成本、无配方回落 `est`；近30天销量/营收聚合）+ 前端「导出菜品成本CSV」 | ⬆️ 已移植 | 读类：近30天 = 销售行 date ≥ today−29（旧版 `dishSalesAgg` HTML:2613） |
| FP-SET-14 | 导出销售应收实收 CSV | HTML:612 `#btnCsvSale`、:5308-5316 | `GET /api/export/sales.csv`（12 列）+ 前端「导出销售CSV」 | ⬆️ 已移植 | 只读导出；**口径受限**：优先读 `sub/discount/receivable/payments`，缺失时按「全额收款」兜底（应收=实收=售价合计、欠款 0）；待 FP-SALE-07/11 建应收模型后自动按真实口径导出 |
| FP-SET-15 | 导入 JSON 备份恢复（全覆盖） | HTML:613 `#fileImport`、:5317-5328 | 无用户导入入口（`bff/store-node/seed/migrate_from_zip.js` 为离线迁移脚本，非运行时功能） | ⬜ 待补 | 写类：**高危覆盖**，须双人确认 + 审批队列 |
| FP-SET-16 | 重置为真实数据基线（海南菜篮子采购单） | HTML:635 `#btnReseed`、:5330-5332 `seedDB()` | 无 | ⬜ 待补 | 写类：**最高危**，须走审批队列 + 强制先自动备份 |
| FP-SET-17 | 清空全部业务数据 | HTML:636 `#btnClear`、:5333-5337 | 无 | ⬜ 待补 | 写类：同上 |
| FP-SET-18 | 配置结算单模板（抬头/地址/电话/税号/用途/收款单位/开户行/账号/签字栏/页脚） | HTML:615-628 `#stTpl*`、:5239 `renderSettleTplForm()`、:5253 保存 | `SystemConfigPage.tsx`:83-151 状态与读写（`loadTpl`/`saveTpl`）、:267-341「结算单模板」卡片（13 字段表单）；后端 `bff/routes/settle.js` `GET/PUT /api/settle/template`（字段白名单 + 仅老板/店长可写 + 审计），存 `bff/data/settle_template.json` | ⬆️ 已移植 | 写类但**独立存储不写业务库**；与 FP-RECV-06 是同一实现的重复登记（非两项工作量）；存储形态变更见 `ADR-003` |
| FP-SET-19 | 恢复默认结算单模板 | HTML:631 `#btnStTplReset`、:5269-5272 | `SystemConfigPage.tsx`:329-338 `Popconfirm`「恢复默认结算单模板？（不影响采购单/库存等业务数据）」+ :136-151 `resetTpl()` | ⬆️ 已移植 | 验证：点「恢复默认」→ 二次确认 → 表单与已保存模板同时回默认；**不动任何业务数据** |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 19 |
| ⬆️ 已移植 | 10（T5：FP-SET-18/19；W1：FP-SET-01/11/12/13/14；W2：FP-SET-02/03/04） |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 9 |
| ⚰️ 废弃 | 0 |

> **2026-09-28 T5 更新**：结算单模板（FP-SET-18/19）已随进货入库单据闭环一并补齐，本页不再是「零移植」。
> **2026-10-10 W1 更新**：四类导出（FP-SET-11/12/13/14）与「各模块数据输入通道一览」（FP-SET-01）已补齐
> （只读，新增 `bff/routes/export.js` 四端点 + 设置页两张新卡）。
> **2026-10-10 W2 更新**：外接比价平台配置（FP-SET-03/04）已补齐——设置页新增「外接比价平台」卡片
> **2026-10-10 W2 阶段 23 更新**：餐厅名称（FP-SET-02）已补齐——新增 `rest.update` 动作写顶层 `data.rest`，设置页新增「餐厅名称」卡片。
> （名称 + `{kw}` URL 模板的增 / 删 / 改），存 `config.compare_platforms`（默认 `DEF_COMPARE_PLATFORMS`），
> 经 `POST /api/admin/config`（config.update 审批队列）；与 FP-PRICE-09/10 同一实现。

**结论**：设置页 19 项功能中 **10 项缺失**（已移植 9 项）。
W1 只读速补 5 项 + W2 比价平台配置 2 项（FP-SET-03/04）已完成；剩余缺口集中在**写类配置**（餐厅名/服务端快照）
与**高危数据操作**（导入恢复/重置基线/清空）。

### 旁注（常被误判为已迁移的相邻能力）

| 能力 | 现状 | 判定 |
|---|---|---|
| 分类管理 / 单位与换算 | `StockPage.tsx`:324-340（原料级：分类/库存单位/换算率；分类 chips 筛选 :265-274） | ⬆️ 已移植（能力在位） |
| 供应商档案 | `VendorsPage.tsx`:170/219 仅「录入报价 + 设默认供应商」 | ⬜ 待补（无独立档案） |
| 系统参数（安全库存/SOP） | `SystemConfigPage.tsx`:118-129 + `POST /api/admin/config` | ⬆️ 已移植（新版新增口径，旧设置页无此项，故不占 FP 号） |
| 版本信息 | `AppReleasePage.tsx`:122 + `/api/app/release` | ⬆️ 已移植（新版新增） |
| 自检 | 无前端入口，仅 `/api/queue/health`（`bff/routes/si.js`:106） | ⬜ 待补 |
| 清缓存 | 无（admin-web 无业务缓存层，仅 `utils/device.ts`:5 设备指纹） | ⚰️ 可废待批 |

## 建议补齐顺序

1. ~~**FP-SET-11 / 12 / 13 / 14** 四类导出（只读、零风险、老板日常要表）~~ ✅ 已完成（W1，2026-10-10）
2. ~~**FP-SET-18 / 19** 结算单模板（配合 FP-RECV-04/05/06 单据闭环）~~ ✅ 已完成（T5）
3. ~~**FP-SET-03 / 04** 比价平台配置（`config.update` 链路已通，成本最低的写类）~~ ✅ 已完成（W2，2026-10-10）；~~**FP-SET-02** 餐厅名落点已定（新增 `rest.update` 动作，写顶层 `data.rest`）~~ ✅ 已完成（W2 阶段 23，2026-10-10）
4. ~~**FP-SET-01** 模块状态总览（只读，可复用 ModuleBrowse 数据）~~ ✅ 已完成（W1，2026-10-10）
5. **FP-SET-07 / 10** 服务端快照与回滚（需先定「服务端快照」形态并补 ADR）
6. **FP-SET-15 / 16 / 17** 导入恢复 / 重置基线 / 清空（**高危**：双人确认 + 审批队列 + 自动前置备份）
7. **FP-SET-05 / 06 / 08 / 09** 双机同步四件套（建议走 ⚰️ 废弃，**需业务批准人签字**）

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- FP-SET-09「以本机为准覆盖数据库」与 FP-SET-17「清空全部数据」属**不可逆高危**，即使补齐也必须强制前置自动备份。
- FP-SET-05/06/08/09 的 ⚰️ 废弃判定涉及业务决策，**必须有批准人签字**才能改状态，否则 CI R14 会因「无批准人」而不可放行。
