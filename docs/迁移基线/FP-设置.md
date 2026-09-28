# 迁移基线 · 设置（源：旧 HTML 系统）

> 源系统：`old/store-inventory-legacy/熊猫五福餐厅进销存系统_真实数据版.html`
> 源页面：`#tab-set`「设置」（HTML 第 567–641 行区域，含结算单模板配置区约 615–633 行）
> 目标系统：`apps/admin-web/src/pages/SystemConfigPage.tsx` + `OrgPage.tsx` + `bff/routes/admin.js`
> 模式：**替代**（全部 ⬜ 视为回归缺陷，需排期补齐）
> 建立日期：2026-09-28　状态：🟡 **待人工复核**（AI 抽取，未经人工签字）　规范依据：`docs/迁移颗粒度规范.md`

---

## 功能点清单

| FP ID | 功能点 | 旧版证据 | 新版现状 | 状态 | 处置 / 关联 |
|---|---|---|---|---|---|
| FP-SET-01 | 查看各模块数据输入通道一览（模块/数据来源/输入方式/当前状态） | HTML:569-586 表格（10 行模块状态） | 无（`ModuleBrowsePage.tsx` 是模块浏览，非本页状态总览） | ⬜ 待补 | 读类：只读展示；可复用 ModuleBrowse 数据 |
| FP-SET-02 | 配置餐厅名称 | HTML:588 `#setRest`、:5273 change → `saveDB()` | 无（`/api/admin/config` 仅 safety_stock/SOP/note；`SystemConfigPage.tsx`:88-96） | ⬜ 待补 | 写类：走 `config.update` + 审批队列 |
| FP-SET-03 | 新增外接比价平台 | HTML:592 `#btnAddPlat`、:5283 `DB.platforms.push()` | 无（`api/types.ts`:564 `data.quotes` 仅有报价数据，无平台配置 UI/端点） | ⬜ 待补 | 写类：`config.update` 队列（与 FP-PRICE-10 同一缺口） |
| FP-SET-04 | 编辑/删除已配置平台（名称 + `{kw}` 搜索 URL 模板） | HTML:5230-5235 `#platTable` 渲染、:5277/5280-5282 change/删除 | 无 | ⬜ 待补 | 写类：随 FP-SET-03 |
| FP-SET-05 | 配置同步服务地址与本机标识 | HTML:595-596 `#setApiBase`/`#setMachine`、:1083-1089 | 无（新版为中心化 BFF/SaaS，无 P2P 双机同步） | ⬜ 待补 | 建议转 ⚰️ 废弃：架构变更，但**缺业务批准人**，暂留 ⬜ |
| FP-SET-06 | 立即同步（本机 ↔ 本地 SQLite） | HTML:599 `#btnSyncNow`、:1090 → `pushNow()` | 无（BFF 无对应用户触发同步端点） | ⬜ 待补 | 建议转 ⚰️（同 FP-SET-05，待批准） |
| FP-SET-07 | 手动打快照备份 | HTML:600 `#btnSnapNow`、:1091-1093 | 无用户入口。BFF 有 `/api/snapshot/push`（`bff/routes/snapshot.js`:21）但为设备端推送，非用户手动备份 | ⬜ 待补 | 写类：需「服务端快照/文件下载」形态，能力对等判定待 ADR |
| FP-SET-08 | 以数据库为准（覆盖本机） | HTML:601 `#btnPullRemote`、:1095-1103 | 无 | ⬜ 待补 | 同 FP-SET-05（单机架构已消失） |
| FP-SET-09 | 以本机为准（覆盖数据库） | HTML:602 `#btnPushLocal`、:1104-1111 | 无 | ⬜ 待补 | 同 FP-SET-05（**高危覆盖能力，不建议在新版复刻**） |
| FP-SET-10 | 快照列表查看与回滚 | HTML:606 `#snapTable`、:978 `renderSnapTable()`、:1113 点击回滚 | 无列表/回滚端点。BFF 仅 `/api/snapshot/latest` 只读最新（`bff/routes/snapshot.js`:56） | ⬜ 待补 | 写类：**回滚属高危**，须走审批队列并留痕 |
| FP-SET-11 | 导出全量数据备份 JSON | HTML:609 `#btnExport`、:5292 `download()` | 无。全仓仅 `bff/routes/app_release.js` 命中 `Content-Disposition`，无业务数据导出端点 | ⬜ 待补 | 读类：只读导出；建议服务端快照下载（非 localStorage） |
| FP-SET-12 | 导出原料库存 CSV | HTML:610 `#btnCsvIng`、:5296-5300 | 无（后端无 CSV 端点） | ⬜ 待补 | 读类 |
| FP-SET-13 | 导出菜品成本毛利 CSV | HTML:611 `#btnCsvDish`、:5301-5307 | 无 | ⬜ 待补 | 读类 |
| FP-SET-14 | 导出销售应收实收 CSV | HTML:612 `#btnCsvSale`、:5308-5316 | 无（Android `AnalysisScreen.kt`:129-158「导出经营周报」仅入队动作，非文件导出） | ⬜ 待补 | 读类 |
| FP-SET-15 | 导入 JSON 备份恢复（全覆盖） | HTML:613 `#fileImport`、:5317-5328 | 无用户导入入口（`bff/store-node/seed/migrate_from_zip.js` 为离线迁移脚本，非运行时功能） | ⬜ 待补 | 写类：**高危覆盖**，须双人确认 + 审批队列 |
| FP-SET-16 | 重置为真实数据基线（海南菜篮子采购单） | HTML:635 `#btnReseed`、:5330-5332 `seedDB()` | 无 | ⬜ 待补 | 写类：**最高危**，须走审批队列 + 强制先自动备份 |
| FP-SET-17 | 清空全部业务数据 | HTML:636 `#btnClear`、:5333-5337 | 无 | ⬜ 待补 | 写类：同上 |
| FP-SET-18 | 配置结算单模板（抬头/地址/电话/税号/用途/收款单位/开户行/账号/签字栏/页脚） | HTML:615-628 `#stTpl*`、:5239 `renderSettleTplForm()`、:5253 保存 | `SystemConfigPage.tsx`:63-131 状态与读写（`loadTpl`/`saveTpl`）、:212-286「结算单模板」卡片（13 字段表单）；后端 `bff/routes/settle.js` `GET/PUT /api/settle/template`（字段白名单 + 仅老板/店长可写 + 审计），存 `bff/data/settle_template.json` | ⬆️ 已移植 | 写类但**独立存储不写业务库**；与 FP-RECV-06 是同一实现的重复登记（非两项工作量）；存储形态变更见 `ADR-003` |
| FP-SET-19 | 恢复默认结算单模板 | HTML:631 `#btnStTplReset`、:5269-5272 | `SystemConfigPage.tsx`:274-283 `Popconfirm`「恢复默认结算单模板？（不影响采购单/库存等业务数据）」+ :116-131 `resetTpl()` | ⬆️ 已移植 | 验证：点「恢复默认」→ 二次确认 → 表单与已保存模板同时回默认；**不动任何业务数据** |

## 汇总

| 项 | 数 |
|---|---|
| FP 总数 | 19 |
| ⬆️ 已移植 | 2（FP-SET-18/19，T5 补齐；二者与 FP-RECV-06 为同一实现） |
| 🔄 等价替代 | 0 |
| ⬜ 待补 | 17 |
| ⚰️ 废弃 | 0 |

> **2026-09-28 T5 更新**：结算单模板（FP-SET-18/19）已随进货入库单据闭环一并补齐，本页不再是「零移植」。
> 剩余 17 项中，**四类导出（FP-SET-11/12/13/14）仍是老板日常要表的高频只读功能**，完全无出口。

**结论**：设置页 19 项功能中 **17 项缺失**（已移植 2 项）。
其中**四类导出（FP-SET-11/12/13/14）是老板日常要表的高频只读功能**，却完全没有出口。

### 旁注（常被误判为已迁移的相邻能力）

| 能力 | 现状 | 判定 |
|---|---|---|
| 分类管理 / 单位与换算 | `StockPage.tsx`:239-254（原料级） | ⬆️ 已移植（能力在位） |
| 供应商档案 | `VendorsPage.tsx`:170/219 仅「录入报价 + 设默认供应商」 | ⬜ 待补（无独立档案） |
| 系统参数（安全库存/SOP） | `SystemConfigPage.tsx`:118-129 + `POST /api/admin/config` | ⬆️ 已移植（新版新增口径，旧设置页无此项，故不占 FP 号） |
| 版本信息 | `AppReleasePage.tsx`:122 + `/api/app/release` | ⬆️ 已移植（新版新增） |
| 自检 | 无前端入口，仅 `/api/queue/health`（`bff/routes/si.js`:106） | ⬜ 待补 |
| 清缓存 | 无（admin-web 无业务缓存层，仅 `utils/device.ts`:5 设备指纹） | ⚰️ 可废待批 |

## 建议补齐顺序

1. **FP-SET-11 / 12 / 13 / 14** 四类导出（只读、零风险、老板日常要表）
2. ~~**FP-SET-18 / 19** 结算单模板（配合 FP-RECV-04/05/06 单据闭环）~~ ✅ 已完成（T5）
3. **FP-SET-02 / 03 / 04** 餐厅名与比价平台配置（`config.update` 链路已通，**成本最低的写类**）
4. **FP-SET-01** 模块状态总览（只读，可复用 ModuleBrowse 数据）
5. **FP-SET-07 / 10** 服务端快照与回滚（需先定「服务端快照」形态并补 ADR）
6. **FP-SET-15 / 16 / 17** 导入恢复 / 重置基线 / 清空（**高危**：双人确认 + 审批队列 + 自动前置备份）
7. **FP-SET-05 / 06 / 08 / 09** 双机同步四件套（建议走 ⚰️ 废弃，**需业务批准人签字**）

## 备注

- 本清单由 AI 从源码抽取，**未经人工复核**，按 `docs/迁移颗粒度规范.md` §2.2 复核后才可转为正式基线。
- FP-SET-09「以本机为准覆盖数据库」与 FP-SET-17「清空全部数据」属**不可逆高危**，即使补齐也必须强制前置自动备份。
- FP-SET-05/06/08/09 的 ⚰️ 废弃判定涉及业务决策，**必须有批准人签字**才能改状态，否则 CI R14 会因「无批准人」而不可放行。
