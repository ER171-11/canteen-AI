# 迁移基线 · 设置（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-set`「设置」（HTML 第 567–641 行区域，含结算单模板配置区约 615–633 行）
> 目标系统：`apps/admin-web/src/pages/SystemConfigPage.tsx` + `OrgPage.tsx` + `bff/routes/admin.js` + `bff/routes/export.js`
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/规范/迁移颗粒度规范.md`
> **行号复核**：2026-10-12 W2 第五批（FP-SET-07）后，按 `SystemConfigPage.tsx`（**665 行**）全表复核新版行号
> （上版为 418 行快照；本批新增「快照备份」卡片，其后所有行号整体下移，已逐行重取）。

---

## 功能点清单

| FP ID | 功能点 | 旧版证据 | 新版现状 | 状态 | 处置 / 关联 |
|---|---|---|---|---|---|
| FP-SET-01 | 查看各模块数据输入通道一览（模块/数据来源/输入方式/当前状态） | HTML:569-586 表格（10 行模块状态） | `SystemConfigPage.tsx`:601-617「各模块数据输入通道一览」表 + `buildChannelRows` :648-664（10 行）；状态由 `GET /api/snapshot/latest` 实时推导 | ⬆️ 已移植 | 读类：只读展示；未接通快照时统一「未接通快照」，不编造数字 |
| FP-SET-02 | 配置餐厅名称 | HTML:588 `#setRest`、:5273 change → `saveDB()` | `SystemConfigPage.tsx`「餐厅名称」卡片（`:378-399` 展示+编辑，`saveRestName` `:130`）；`bff/routes/admin.js` `GET /api/admin/config` 返 `rest`、`POST /api/admin/rest` | ⬆️ 已移植 | 写类：**新增 `rest.update` 动作**（`inventory.applyRest` + `registry` 登记），写顶层 `data.rest`（字符串，默认「熊猫五福餐厅」）；不并入 `config.update`，避免与 `config` 语义纠缠；经审批队列，仅老板/店长 |
| FP-SET-03 | 新增外接比价平台 | HTML:592 `#btnAddPlat`、:5283 `DB.platforms.push()` | `SystemConfigPage.tsx`「外接比价平台」卡片「新增平台」；存 `config.compare_platforms`（默认 `DEF_COMPARE_PLATFORMS`，`pages/inventory/comparePlatforms.ts`） | ⬆️ 已移植 | 写类：经 `POST /api/admin/config`（config.update，仅老板/店长）。**注意**：快照 `data.platforms` 是**外卖平台**（美团/饿了么），与旧版 `DB.platforms`（比价平台）**同名不同义**，故用 `config.compare_platforms` |
| FP-SET-04 | 编辑/删除已配置平台（名称 + `{kw}` 搜索 URL 模板） | HTML:5230-5235 `#platTable` 渲染、:5277/5280-5282 change/删除 | `SystemConfigPage.tsx`「外接比价平台」表格：名称 / URL 模板逐行可编辑 + 行内「删」 | ⬆️ 已移植 | 写类：随 FP-SET-03；口径照抄旧版 `renderSet`（HTML:5228-5237 / :5277-5283） |
| FP-SET-05 | 配置同步服务地址与本机标识 | HTML:595-596 `#setApiBase`/`#setMachine`、:1083-1089 | 无（新版为中心化 BFF/SaaS，无 P2P 双机同步） | ⚰️ 废弃 | 已废弃（批准人 William，2026-10-12，ADR-009）：中心化 BFF/SaaS 下 P2P 双机同步无存在意义，不再开发维护 |
| FP-SET-06 | 立即同步（本机 ↔ 本地 SQLite） | HTML:599 `#btnSyncNow`、:1090 → `pushNow()` | 无（BFF 无对应用户触发同步端点） | ⚰️ 废弃 | 已废弃（同 FP-SET-05，批准人 William，ADR-009） |
| FP-SET-07 | 手动打快照备份 | HTML:600 `#btnSnapNow`、:1091-1093 | `POST /api/snapshot/backup`（`bff/routes/snapshot.js`:153-181，**仅老板/店长**）→ 写 `bff/data/snapshots/<id>.json`（快照全文，可直接回灌 `/api/snapshot/push`）+ `index.json`；`bff/lib/snapshot_store.js`（保留最近 20 份，超出淘汰最旧）；`SystemConfigPage.tsx`:556-599「快照备份」卡片（「立即打快照备份」`:586`、备份列表 `:588-598`） | ⬆️ 已移植 | 写类但**只写备份文件**——不写业务库、不入审批队列；形态按 `ADR-009` §2.1「服务端主存 + 历史快照」。验证：`cd bff && node routes/snapshot.test.js`（27 条断言，含「备份前后 snapshot.json 字节一致」「不产生 actions_queue.json」两条红线断言） |
| FP-SET-08 | 以数据库为准（覆盖本机） | HTML:601 `#btnPullRemote`、:1095-1103 | 无 | ⚰️ 废弃 | 已废弃（同 FP-SET-05，批准人 William，ADR-009；单机架构已消失） |
| FP-SET-09 | 以本机为准（覆盖数据库） | HTML:602 `#btnPushLocal`、:1104-1111 | 无 | ⚰️ 废弃 | 已废弃（同 FP-SET-05，批准人 William，ADR-009；**高危覆盖能力，不复刻**） |
| FP-SET-10 | 快照列表查看与回滚 | HTML:606 `#snapTable`、:978 `renderSnapTable()`、:1113 点击回滚 | **已落地**：列表查看 `GET /api/snapshot/backups`（`bff/routes/snapshot.js`）+ `GET /api/snapshot/backup?id=`（全文，供回滚取数）+ `SystemConfigPage.tsx`「快照备份」卡片列表；**回滚**经 `snapshot.rollback` 动作（执行器 `bff/lib/algorithms/snapshot.js::applySnapshotRollback`，走 `/api/actions` 队列 → 审批确认 → `StoreAdapter.casWrite` 递增 rev）+ 只读预览 `GET /api/snapshot/backup/preview?id=` | ⬆️ 已移植 | 写类高危（ADR-013 D1）：仅老板/店长可发起（`bff/routes/actions.js` `HIGH_RISK_TYPES`）；执行器先打「回滚前自动备份」（D4-3），再 `schema.migrateData` 校验/迁移后整包恢复 `data+ext`，rev 绝不回退；前端 `SystemConfigPage`「回滚」列（仅老板/店长可见）→ 确认词「确认回滚」→ 入队。**注**：ADR-013 D1 提出的独立执行器下推端点 `/api/snapshot/apply` 因当前桌面执行器与 BFF 同进程，回滚逻辑已在执行器内完成、数据从磁盘读取天然绕开 5MB 限制且只经 `/api/actions` 单一写通道，故未新增可直调 HTTP 端点（详见 ADR-013 §8.7）。 | ⬆️ 已移植
| FP-SET-11 | 导出全量数据备份 JSON | HTML:609 `#btnExport`、:5292 `download()` | `bff/routes/export.js`:`GET /api/export/backup.json`（快照 data+ext 原样，可直接回灌 `/api/snapshot/push`）+ `SystemConfigPage.tsx`:532-554「数据导出」卡片「导出全部数据(JSON)」 | ⬆️ 已移植 | 读类：只读导出；服务端下发（非 localStorage），前端走 axios blob 带 Bearer |
| FP-SET-12 | 导出原料库存 CSV | HTML:610 `#btnCsvIng`、:5296-5300 | `bff/routes/export.js`:`GET /api/export/ings.csv`（11 列照抄旧版 HTML:5297）+ 前端「导出原料CSV」 | ⬆️ 已移植 | 读类：CSV 带 UTF-8 BOM，Excel 友好 |
| FP-SET-13 | 导出菜品成本毛利 CSV | HTML:611 `#btnCsvDish`、:5301-5307 | `GET /api/export/dishes.csv`（9 列；有配方用 `lib/recipe_cost` 每份成本、无配方回落 `est`；近30天销量/营收聚合）+ 前端「导出菜品成本CSV」 | ⬆️ 已移植 | 读类：近30天 = 销售行 date ≥ today−29（旧版 `dishSalesAgg` HTML:2613） |
| FP-SET-14 | 导出销售应收实收 CSV | HTML:612 `#btnCsvSale`、:5308-5316 | `GET /api/export/sales.csv`（12 列）+ 前端「导出销售CSV」 | ⬆️ 已移植 | 只读导出；**口径受限**：优先读 `sub/discount/receivable/payments`，缺失时按「全额收款」兜底（应收=实收=售价合计、欠款 0）；待 FP-SALE-07/11 建应收模型后自动按真实口径导出 |
| FP-SET-15 | 导入 JSON 备份恢复（全覆盖） | HTML:613 `#fileImport`、:5317-5328 | **已落地**：`POST /api/snapshot/import/preview`（只读解析 + schema 校验/迁移 + 差异统计）→ `POST /api/snapshot/import`（暂存 `data/imports/<id>.json` + 入队 `snapshot.import`）；执行器 `bff/lib/algorithms/snapshot.js::applySnapshotImport` 整包恢复 `data+ext`，前端 `SystemConfigPage`「高危数据维护」卡片 | ⬆️ 已移植 | 写类高危（ADR-013 W4-01 / D4-1/2/3/7）：仅老板/店长（`HIGH_RISK_TYPES`）；执行前强制自动备份；`rev = curRev+1` 绝不回退；暂存 id = 内容 sha256（同一文件重复提交命中队列幂等）。验证：`node bff/lib/algorithms/snapshot_w4.test.js`、`node bff/routes/snapshot_w4.test.js`、`node scripts/verify-adr013-batch4.js`（78 项） |
| FP-SET-16 | 重置为真实数据基线（海南菜篮子采购单） | HTML:635 `#btnReseed`、:5330-5332 `seedDB()` | **已落地**：`scripts/gen-baseline.js` 从遗留库导出 `bff/baselines/baseline-v1.json`（原料 163 / 菜品 95 / 进货单 9 / 采购单 12，带 `baseline_version` + sha256 校验和）；`GET /api/snapshot/baselines`、`GET /api/snapshot/baseline/preview`（只读）、动作 `snapshot.reset_baseline`（执行器 `applySnapshotResetBaseline`）+ 前端「重置为真实数据基线」 | ⬆️ 已移植 | 写类最高危（ADR-013 W4-02 / D4-4）：基线制品随包发布且**一经发布不可变**（改基线须新增版本号）；校验和不符 → 拒绝执行（红线⑦）；销售/报价/流水/配方为空属正常（ADR-001 口径） |
| FP-SET-17 | 清空全部业务数据 | HTML:636 `#btnClear`、:5333-5337 | **已落地**：动作 `snapshot.clear`（执行器 `applySnapshotClear`），两档 `scope=business｜all`；`GET /api/snapshot/clear/preview` 只读预览；前端「清空业务数据」两档单选 + 确认词「确认清空」 | ⬆️ 已移植 | 写类最高危（ADR-013 W4-03 / D4-5/6）：`business` 保留 config/rest/桌台/验收标准/巡检点位/人员档案，清 ings+recv+logs 同组（否则重算会把库存算回来）；`all` 额外清 org.json / settle_template.json / tokens.json（会登出，账号回出厂默认并可重新登录） |
| FP-SET-18 | 配置结算单模板（抬头/地址/电话/税号/用途/收款单位/开户行/账号/签字栏/页脚） | HTML:615-628 `#stTpl*`、:5239 `renderSettleTplForm()`、:5253 保存 | `SystemConfigPage.tsx`:161-222 状态与读写（`loadTpl`/`saveTpl`）、:456-530「结算单模板」卡片（13 字段表单）；后端 `bff/routes/settle.js` `GET/PUT /api/settle/template`（字段白名单 + 仅老板/店长可写 + 审计），存 `bff/data/settle_template.json` | ⬆️ 已移植 | 写类但**独立存储不写业务库**；与 FP-RECV-06 是同一实现的重复登记（非两项工作量）；存储形态变更见 `ADR-003` |
| FP-SET-19 | 恢复默认结算单模板 | HTML:631 `#btnStTplReset`、:5269-5272 | `SystemConfigPage.tsx`:518-527 `Popconfirm`「恢复默认结算单模板？（不影响采购单/库存等业务数据）」+ :201-222 `resetTpl()` | ⬆️ 已移植 | 验证：点「恢复默认」→ 二次确认 → 表单与已保存模板同时回默认；**不动任何业务数据** |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 19 |
| ⬆️ 已移植 | 15（T5：FP-SET-18/19；W1：FP-SET-01/11/12/13/14；W2：FP-SET-02/03/04/07/10；ADR-013 W4：FP-SET-15/16/17） |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 0 |
| ⚰️ 废弃 | 4（FP-SET-05/06/08/09 双机同步，批准人 William，ADR-009） |

> **2026-09-28 T5 更新**：结算单模板（FP-SET-18/19）已随进货入库单据闭环一并补齐，本页不再是「零移植」。
> **2026-10-10 W1 更新**：四类导出（FP-SET-11/12/13/14）与「各模块数据输入通道一览」（FP-SET-01）已补齐
> （只读，新增 `bff/routes/export.js` 四端点 + 设置页两张新卡）。
> **2026-10-10 W2 更新**：外接比价平台配置（FP-SET-03/04）已补齐——设置页新增「外接比价平台」卡片
> **2026-10-10 W2 阶段 23 更新**：餐厅名称（FP-SET-02）已补齐——新增 `rest.update` 动作写顶层 `data.rest`，设置页新增「餐厅名称」卡片。
> **2026-10-12 W2 阶段 25 更新**：手动打快照备份（FP-SET-07）已补齐——新增 `POST /api/snapshot/backup`
> 与备份列表端点（`bff/lib/snapshot_store.js`，保留最近 20 份、超出淘汰最旧），设置页新增「快照备份」卡片；
> **只写备份文件**（不写业务库、不入审批队列），形态按 ADR-009 §2.1；同批把本表全部新版行号按 665 行版本重取。
> （名称 + `{kw}` URL 模板的增 / 删 / 改），存 `config.compare_platforms`（默认 `DEF_COMPARE_PLATFORMS`），
> 经 `POST /api/admin/config`（config.update 审批队列）；与 FP-PRICE-09/10 同一实现。

**结论**：设置页 19 项功能中 **15 项已移植、4 项废弃（双机同步，批准人 William）、0 项待补**。
> **2026-10-30 ADR-013 第 4 批更新**：高危三件套（FP-SET-15/16/17）已落地——导入备份恢复 / 重置真实数据基线 /
> 清空业务数据全部走 `/api/actions` 审批队列，仅老板/店长可发起，执行前强制自动备份；
> 基线制品 `bff/baselines/baseline-v1.json` 由 `scripts/gen-baseline.js` 从遗留库导出一次。
> 至此设置页 **15/19 收口（其余 4 项为已批准废弃）**，ADR-013 的 11 张卡全部落地。

### 旁注（常被误判为已迁移的相邻能力）

| 能力 | 现状 | 判定 |
|---|---|---|
| 分类管理 / 单位与换算 | `StockPage.tsx`:324-340（原料级：分类/库存单位/换算率；分类 chips 筛选 :265-274） | ⬆️ 已移植（能力在位） |
| 供应商档案 | `VendorsPage.tsx`「供应商登记 / 编辑 / 删除」（档案表 + 状态下拉 合作中/考察中/暂停）+ `POST /api/supply/vendor`（`vendor.upsert`，编辑带 `edit`/`old_name` 口径）+ `POST /api/supply/vendor/delete`（`vendor.delete`，有往来账禁删） | ⬆️ 已移植（能力在位） |
| 系统参数（安全库存/SOP） | `SystemConfigPage.tsx`:301-376「系统配置」卡片（工服/装盘 SOP `:358-363`、面粉安全库存 `:364-366`）+ `POST /api/admin/config` | ⬆️ 已移植（新版新增口径，旧设置页无此项，故不占 FP 号） |
| 版本信息 | `AppReleasePage.tsx`:122 + `/api/app/release` | ⬆️ 已移植（新版新增） |
| 自检 | 无前端入口，仅 `/api/queue/health`（`bff/routes/si.js`:106） | ⬜ 待补 |
| 清缓存 | 无（admin-web 无业务缓存层，仅 `utils/device.ts`:5 设备指纹） | ⚰️ 可废待批 |

## 建议补齐顺序

1. ~~**FP-SET-11 / 12 / 13 / 14** 四类导出（只读、零风险、老板日常要表）~~ ✅ 已完成（W1，2026-10-10）
2. ~~**FP-SET-18 / 19** 结算单模板（配合 FP-RECV-04/05/06 单据闭环）~~ ✅ 已完成（T5）
3. ~~**FP-SET-03 / 04** 比价平台配置（`config.update` 链路已通，成本最低的写类）~~ ✅ 已完成（W2，2026-10-10）；~~**FP-SET-02** 餐厅名落点已定（新增 `rest.update` 动作，写顶层 `data.rest`）~~ ✅ 已完成（W2 阶段 23，2026-10-10）
4. ~~**FP-SET-01** 模块状态总览（只读，可复用 ModuleBrowse 数据）~~ ✅ 已完成（W1，2026-10-10）
5. ~~**FP-SET-07** 服务端快照备份（手动打快照 + 备份列表）~~ ✅ 已完成（W2 阶段 25，2026-10-12）；
   **FP-SET-10 的回滚半**仍待补：先补「回滚 payload 下发形态」ADR（店内真源读不到云端备份，见该行处置列），再走审批队列实现
6. ~~**FP-SET-15 / 16 / 17** 导入恢复 / 重置基线 / 清空（**高危**：仅老板/店长 + 审批队列 + 自动前置备份）~~
   ✅ 已完成（ADR-013 第 4 批，2026-10-30；双人确认开关 `CANTEEN_DUAL_APPROVAL` 默认关，测试期单人确认 + 确认词）
7. ~~**FP-SET-05 / 06 / 08 / 09** 双机同步四件套~~ ✅ 已废弃（批准人 William，2026-10-12，ADR-009）

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/规范/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- FP-SET-09「以本机为准覆盖数据库」与 FP-SET-17「清空全部数据」属**不可逆高危**，即使补齐也必须强制前置自动备份。
- FP-SET-05/06/08/09 的 ⚰️ 废弃判定已由业务批准人 **William（2026-10-12）** 签字确认（ADR-009），不再开发维护。
