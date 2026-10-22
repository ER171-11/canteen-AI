# 熊猫五福餐厅进销存系统 架构总览

## 1. 核心定位

面向餐厅经营者的单页进销存与毛利管理工具。覆盖「采购 → 入库 → 菜品配方(BOM) → 销售出库 → 应收实收」全链路，数据主存本机 SQLite（`data/餐厅系统.db`），浏览器 localStorage 作为离线兜底，支持双机合并与 JSON 备份迁移。

## 2. 核心技术栈

- 前端: 原生 HTML + CSS + JavaScript（单文件，无构建）
- 数据持久化（主）: 本机 SQLite，经 `server/app.py` 读写，整库 JSON + `rev` 版本号，文件 `data/餐厅系统.db`
- 数据持久化（兜底）: 浏览器 localStorage（key: `panda_inv_v3`），服务不可用时独立承载全部功能
- 同步与合并: 三向合并（base 快照 / mine / theirs），记录级，见 [modules/数据同步与备份.md](./modules/数据同步与备份.md)
- 本地服务: Python 标准库 `http.server` + `sqlite3`，零第三方依赖，双击 `启动系统.bat` 运行
- 计价方式: 移动加权平均法
- 数据基线: 采购单整理_熊猫五福.xlsx（海南菜篮子实业 2026-09-12）+ 菜品保本测算 86 道

## 3. AI协作红线 (AI Guardrails)

> 规则1 - 严禁擅自覆盖: AI不得直接覆盖或重构开发者手动修改过的核心业务逻辑（计价、配方成本、库存重放）。如需大范围修改，必须先输出 [EDIT_PLAN] 等待人工确认。

> 规则2 - 严禁执行过时脚本: 在执行 seedDB/重置数据前，必须先检查 CHANGELOG.md 中的废弃说明。

> 规则3 - 先更新文档，再改代码: 任何架构级别的修改，必须先更新对应的模块文档。

> 规则4 - 强制后置对账: 每批工作完成后，必须输出 [WORK_DIFF]。

> 规则5 - 功能对等不可静默降级: 任何以新替旧的迁移，必须以**功能点（FP）**为迁移与验收单位，
> 先建《源系统功能清单》基线，逐项标注「已移植 / 等价替代 / 待补 / 废弃」，不允许有未标注项。
> **禁止以「页面存在」「接口存在」充当「功能完成」**；平价测试只证明「算得对」，
> 不证明「功能齐」，两条门禁互不替代。详见 `docs/规范/迁移颗粒度规范.md`。

## 4. 核心模块索引

- 经营概览 -> [modules/经营概览.md](./modules/经营概览.md)
- 原料库存 -> [modules/原料库存.md](./modules/原料库存.md)
- 采购管理(下单) -> [modules/采购管理.md](./modules/采购管理.md)  ※不入库
- 进货入库(收货) -> [modules/进货入库.md](./modules/进货入库.md)  ※确认即入库
- 补货建议 -> [modules/补货建议.md](./modules/补货建议.md)  ※挂采购管理内·自动生成≠自动下单
- 采购进货(历史) -> [modules/采购进货.md](./modules/采购进货.md)  ※2026-09-16 已拆分，仅留档
- 菜品配方 -> [modules/菜品配方.md](./modules/菜品配方.md)
- 结构测算 -> [modules/结构测算.md](./modules/结构测算.md)  ※只读测算层
- 销售收银 -> [modules/销售收银.md](./modules/销售收银.md)  ※含外部平台(美团)销售接入
- 外接比价 -> [modules/外接比价.md](./modules/外接比价.md)
- 库存流水 -> [modules/库存流水.md](./modules/库存流水.md)
- 结算单 -> [modules/结算单.md](./modules/结算单.md)  ※进货入库下游·只读输出层（进货付款审批单）
- 数据同步 -> [modules/数据同步与备份.md](./modules/数据同步与备份.md)  ※持久化/双机合并/快照回滚

## 5. 架构分层（对标《模块化组合式架构规范》）

当前为单 HTML 文件，按代码区域划分逻辑分层：

| 层 | 规范角色 | 当前代码位置 | 说明 |
|----|---------|------------|------|
| L1 内核层 | 工具函数+持久化 | `<script>` 顶部 `fmt/esc/r2/r3/uid/loadDB/saveDB` | 无业务逻辑 |
| L1.5 同步层 | 数据库同步客户端 | `saveDB/loadDB/stampDB/pushNow/startSync/applyRemote` | 只负责搬运与合并，**不碰业务字段**；落地后强制 `rebuildStock()` |
| L2 原子层 | 纯计算函数 | `dishRecipeCost/calcSaleCost/mkPoLine/dishCost` | 零业务上下文 |
| L3 模块层 | 8个 tab 业务 | `renderXxx` 渲染函数 + 事件绑定 | 直接读写全局 DB（待优化为契约通信） |
| L3 模块层 | 结构测算（只读测算层） | `renderCalc/calcModel/syncCalc/calcQtyOf` + `SD/CALC_P` 内存副本 | **只读 `DB.dishes`/`DB.sales`，不产生任何写回**；量本利模型；日销量口径可切（估算 q / 近30天 / 近7天） |
| L3 模块层 | 补货建议（决策层） | `restockLineOf/restockLines/autoRestockPlan/restockToOrders` + `DB.plans/DB.restock` | **只读取** ings/sales/orders，**自动生成 ≠ 自动下单**；转单只 `push DB.orders`，绝不 `rebuildStock()` |
| L3 模块层 | 结算单（只读输出层） | `buildSettleData/buildSettleHtml/printSettle/openSettle` | **只读 `DB.recv` 单条**，输出打印版式/CSV；模板存独立 localStorage `panda_settle_tpl_v1`，不写 `DB` |
| 业务数据区 | 可序列化数据 | `RAW/ING_TUPLES/PO_SEED/RECIPES` | JS 数组形式，待抽离为 JSON |

## 6. 部署与移植

- **运行环境**：仅需 Python 3.8+（`server/` 零第三方依赖）；浏览器任选现代版
- **启动链路**：`启动系统.bat` → `server/app.py` → 自动打开 `http://127.0.0.1:8765/`
- **环境自检**：根目录 `自检.bat`（Python 版本 / 核心文件 / 数据库 / 语法 / 端口）
- **换机器**：完整流程见 [移植说明.md](./移植说明.md)；关键保护见 [modules/数据同步与备份.md](./modules/数据同步与备份.md) 决策7（全新客户端以数据库为准，防种子数据污染）

## 7. AI协作与防错规范

详细 AI 交互协议、[EDIT_PLAN] 与 [WORK_DIFF] 输出格式要求，查阅: [AGENTS.md](./AGENTS.md)
