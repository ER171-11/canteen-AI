# canteenAI 交接说明

交接日期：2026-09-30
交接方：ER171-11
接收方：derekwu2022
代码基线：main 分支（相对 `217046d` 共 46 个提交），回档锚点见 `git tag`

## 0. 起点说明：你我两边的起点是同一个

你 2026-09-28 发来的 `canteenAI-clean.zip`，经比对确认 =
`217046d` 的 git 快照 + 一份未提交的共享工作区改动（相对 `217046d` 共 471 个文件）。

你包内 `.git/logs/HEAD` 最后两条为：

```
96c78325 → 217046da  commit: 真机走查优化: 老板旅程 P0/P1/P2 共17项
217046da → 217046da  reset: moving to HEAD
```

即 `217046d` 之后你没有新提交。包里那 471 个文件的改动（SI 智能经营 /
AI Agent / KMP 共享层 / Android + iOS 双端 / admin-web 应用发布页），我方已把它
作为 T1 批次提交固化，并在其上继续推进到阶段 11。因此：

**你那个 zip 不必再保留；本仓库是对它的严格超集。**

## 1. 本仓库比那个包多了什么

相对 `217046d` 共 **46 个提交**，建议直接看：`git log --oneline 217046d..main`。

阶段地图（仅作索引，细节以 CHANGELOG 为准）：

- 阶段 0 底座 → 阶段 11 结构测算 → 阶段 12（收口）→ 阶段 13 经营概览 W1 只读速补
- T1 验证体系修复 + 规范与基线（ADR-002 去 Python / 迁移颗粒度 / FP 进货入库基线）
- T2 迁移基线（8 页 FP 基线，151 项 / 115 待补）
- T3 欠账总表（113 张任务卡，脚本生成防漂移）
- T4 进货入库只读项
- T5 结算单（PDF 引擎 / 只读输出层 / recv.pay）
- T6 进货单（录入 / 编辑 / 作废 / 批量导入，走审批队列）
- T7 写回闭环端到端 + 写操作事后幂等（ADR-006）
- 现场管理四块能力（品控台账 / 桌态看板 / 巡检 / 水印相机，移动端 + 云端只读镜像）
- T11 结构测算（FP-CALC 系列，阶段 8/9/10/11/12 共 20 项，本页已闭合）
- W1 只读速补 · 经营概览（FP-DASH-01/06/07/11，阶段 13）
- W1 只读速补 · 设置「四类导出 + 模块通道一览」（FP-SET-01/11/12/13/14，阶段 14）
- W1 只读速补 · 采购「状态列/筛选/行级标记/KPI」（FP-PO-10/12/14/15，阶段 15）
- W1 只读速补 · 菜品「近30天销量/毛利额」（FP-DISH-11/12，阶段 16）
- W1 只读速补 · 外接比价「本店均价 vs 外部报价」（FP-PRICE-01/02/03/13/14，阶段 17）
- W1 第六批 · 出成率 + 配方编辑实时成本（FP-ING-04 → FP-DISH-08，阶段 18）

**不要凭本文件描述工作，以仓库内文档为准：**

```
store-inventory/docs/CHANGELOG.md        # 每个阶段做了什么、留了什么坑
docs/迁移基线/欠账总表.md                 # 113 张任务卡，⛔/⚠ 分级
docs/进度看板.html                        # 进度可视化（scripts/gen-progress-board.js 生成）
docs/                                    # PRD / 开发计划 / 决策记录(ADR-*) / 运行保障层
```

## 2. 目录结构

```
apps/admin-web      管理后台（React + Vite）
apps/android-app    Android 端（Kotlin）
apps/ios-app        iOS 端（Swift）
bff                 零依赖 Node BFF（不需要 npm install）
kmp-shared          KMP 共享层（DTO / Repository / ViewModel）
store-inventory     店内节点（Node）+ DDL + 文档
old                 历史遗留（Python 版已归档，不再维护）
ci                  红线守卫（redline_guard.ps1 / .sh）
scripts             开发 / 验证 / 演示脚本
docs                决策记录、欠账总表、进度看板、PRD
```

## 3. 怎么跑起来

环境要求：Node.js（BFF 零依赖）；跑前端需要一次 `npm install`。

### 一键（推荐，Windows）

双击 `启动测试.cmd`。它会拉起 BFF(8787) + admin-web(5173) 并自动开浏览器。

### 手动

```bash
# 后端（零依赖，直接起）
cd bff
node server.js

# 前端（首次需要装依赖）
cd apps/admin-web
npm install
npm run dev
```

登录凭据：`boss / wufu123`

### 演示

双击 `体验演示.cmd`，或：

```powershell
powershell -File scripts/demo-experience.ps1
```

Android / iOS 用自己的 IDE 打开 `apps/android-app` / `apps/ios-app`。

## 4. 测试与红线（提交前请全绿）

```bash
cd bff
npm test                  # 算法 + 店内节点 + 种子 + 路由
npm run e2e               # 写回链路端到端（走 ../scripts/e2e-writeback.js）
```

```powershell
powershell -File ci/redline_guard.ps1                 # 红线守卫，必须全绿
powershell -File scripts/gen-debt-table.ps1 -Check    # 欠账总表一致性，必须退出码 0
node scripts/gen-progress-board.js                    # 刷新进度看板
```

算法自检：`node scripts/smoke-calc-sim.js`；无头浏览器口径核对：`scripts/smoke-calc-sim.ps1`。

## 5. 交接规矩（重要）

1. **不要再通过微信 / 网盘传整包。** 这次两边互传的 zip 里带了 `bff/.env`、
   `bff/data/tokens.json`、`store-inventory/data/*.db`、`local.properties`。
   请确认这些密钥 / token 是否需要轮换。以后一律走 git。
2. **不要提交运行态数据**：`bff/data/`、`bff/.env`、`*.db`、`local.properties`
   都应在 `.gitignore` 内。提交前先 `git clean -xdn` 看一眼。
3. **一次一提交、一提交一件事**，提交信息写清「改了什么 + 验证了什么 + 怎么回档」。
4. **动了基线文件要重算基线**，然后跑 `scripts/gen-debt-table.ps1 -Check` 确认一致。
5. `old/` 目录只读参考，不要在它上面加功能。

## 6. 下一步从哪开始

读 `docs/迁移基线/欠账总表.md` 与 `docs/进度看板.html`，按优先级挑。已知收口点：

- ✅ 结构测算模块 **20/20 已闭合**（阶段 12 补齐 `FP-CALC-14` 五类角色卡片，与四象限并列、
  **未替换**；口径 = 保本价盘，随页面分界切换到本店在售菜品）
- ✅ 经营概览 **5/15**（阶段 13 补齐 `FP-DASH-01` 统计周期 / `06` 采购应付 / `07` 库存总值 /
  `11` 低库存明细；`FP-DASH-08` 折扣抹零**缺数据源**，随销售模型一起做）
- ✅ 设置 **7/19**（阶段 14 补齐 W1 只读 5 项：`FP-SET-11/12/13/14` 四类导出 +
  `FP-SET-01` 模块数据输入通道一览；新增只读端点 `bff/routes/export.js`，零写库）
- ✅ 采购管理 **9/20**（阶段 15 补齐 W1 只读 4 项：`FP-PO-10/12/14/15` 状态列/筛选/行级标记/KPI；
  纯前端 `PurchasePage.tsx` + `utils.ts` 纯函数，状态由既有数据推导，不依赖结案/作废写动作）
- ✅ 原料库存 **11/15**（阶段 18 补齐 `FP-ING-04` 出成率：`applyIngUpsert` 白名单 `yld`（0.05~1 钳制）+ 编辑弹窗字段/列表列，
  Node/Python 平价同步；`recipe_cost.js` 行成本同步做 `qty/yld` 毛料还原）
- ✅ 菜品配方 **14/18**（阶段 16 补齐 W1 只读 2 项：`FP-DISH-11/12` 近30天销量/毛利额；
  新增 `export.dishSalesAgg` 纯函数 + `/api/admin/dishes` 附 `q30/gp30`，复用 `dishCostMap`+`near30Agg` 同口径；
  阶段 18 补齐 `FP-DISH-08` 配方编辑实时成本 + 毛料还原，`calcLine()` 净料/出成率×均价 + `Form.useWatch` 实时条）
- ✅ 外接比价 **9/15**（阶段 17 补齐 W1 只读 5 项：`FP-PRICE-01/02/03/13/14` 搜索/筛选/比价主表/待比价清单/统计；
  新增 `lib/price.js` 纯聚合（`priceReport`/`pricePlan`/`bestQuote`/`quotePerStock`/`quoteKeyword`）+ `GET /api/admin/price`，
  口径对齐旧版 `renderPrice`/`openQuotePlan`/`quoteTaskText`）
- **下一批（W1 只读速补，余 3 张）**：按欠账总表 W1 顺序推进
  —— DASH 1 / PRICE 1（FP-PRICE-05 折算口径，与写路径纠缠）/ SALE 1（口径与红线分级见 `docs/迁移颗粒度规范.md`）
- ⚠️ 已知数据缺口：快照 `sales[]` 只有 `amount/qty/date/hour/channel/method`，
  **没有 `discount/receivable/payments`**，`FP-DASH-02/03/04/08` 因此全部阻塞，
  须与 FP-SALE-07/08/11 同批建销售应收模型
- 欠账总表尾部列出的其余项按 ⛔ / ⚠ 分级处理

每完成一项，先按第 4 节跑一遍验证，再按第 5 节的粒度提交。

## 7. 回档锚点

```bash
git tag                 # 查看已打的锚点
git log --oneline -1    # 当前 main HEAD
```

出问题用 `git revert <提交>` 回档，不要 `git reset --hard` 公共历史。
