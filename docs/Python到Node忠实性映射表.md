# Python 计划 → Node 实现 忠实性映射表

> 用途：回答「Node 侧有没有忠实延续 Python 计划」。
> 判定口径分三层——**意图层**（业务口径/红线/状态机）、**形态层**（技术栈/文件路径/端点）、**范围层**（做没做完）。
> 只有意图层的偏差才算「不忠实」；形态层变化是架构演进的合理结果；范围层需单独决策。
>
> 校准日期：2026-09-28　校准人：接手者　校验方式：实跑平价（差分）测试，非人工比对

---

## 0. 结论速览

| 层 | 判定 | 依据 |
|---|---|---|
| **意图层（算法数值/业务口径）** | ✅ **忠实延续** | 6 个算法域平价测试 `6/6 PASS`（Node vs Python 原实现深比较） |
| **意图层（存储/合并/同步）** | ✅ **忠实延续** | `store-node` 平价测试 `4/4 PASS`（db/merge/consumer/server） |
| **意图层（种子数据迁移）** | ✅ **忠实延续** | `seed` 平价测试 `9/9 PASS` |
| **意图层（红线）** | ✅ **延续且强化** | `db.js`/`merge.js` 哈希基线校验通过；`ci/redline_guard.sh` 查旁路写/硬编码 Key/图片落盘 |
| **功能层（页面功能点）** | ❌ **残缺** | 抽样「进货入库」页：15 项 FP 仅 3 项已移植（2 项为新版新增），**12 项缺失**，后端亦无对应端点 → 见 §7 |
| **形态层** | 🔄 **已变，方向合理** | Python 运行时 → Node `store-node`；单文件 HTML → `admin-web`；端点反而超出计划 |
| **范围层** | ⬜/➕ **有缺口也有漂移** | 6 个模块在 Android/admin-web 无对应实现；计划外新增 si/workbench/inbox/policies/org/app_release 等 |

**一句话**：核心口径没被改坏，且留有可自动验证的证据；欠的是「做没做完」和「做了计划外的」。

---

## 1. 意图层：算法与业务口径（有自动化证据）

平价测试机制：同一份 fixture 分别跑 Node 新实现与 Python 原实现，归一化易变字段后**深比较**。
Python 原实现完整保留在 `old/store-inventory-legacy/`，未被删除。

| 域 | Python 原实现 | Node 实现 | 平价测试 | 实测结果 |
|---|---|---|---|---|
| 库存重放（移动加权平均） | `python-runtime/queue_consumer.py::rebuild_stock` | `bff/lib/algorithms/stock.js::rebuildStock` | `stock.test.js` | ✅ PASS（`moves=6` 两端一致） |
| 菜品/配方/成本 | `queue_consumer.py`（dish/recipe 算法） | `bff/lib/algorithms/dish.js` | `dish.test.js` | ✅ PASS（59 cases） |
| 进销存 | `queue_consumer.py`（apply_*/insert_*） | `bff/lib/algorithms/inventory.js` | `inventory.test.js` | ✅ PASS |
| 运营/人员/食安/会员/财务/设备 | `queue_consumer.py` | `bff/lib/algorithms/ops.js` | `ops.test.js` | ✅ PASS |
| POS/桌台/收银/BOM 扣料 | `queue_consumer.py` | `bff/lib/algorithms/pos.js` | `pos.test.js` | ✅ PASS（38 cases） |
| 动作分发/执行 | `queue_consumer.py::execute` | `bff/lib/algorithms/execute.js` | `execute.test.js` | ✅ PASS |
| **汇总** | | | `node bff/lib/algorithms/run-tests.js` | **6/6** |

> 迁移时每个算法文件头注释均标注来源，例如
> `bff/lib/algorithms/stock.js`：「迁移自 queue_consumer.py rebuild_stock / resolve_ing_id」；
> `bff/lib/algorithms/pos.js`：「忠实迁移自 store-inventory/queue_consumer.py」。

## 2. 意图层：存储、合并、同步、种子

| 能力（Python 计划） | Python 原实现 | Node 实现 | 平价测试 | 实测 |
|---|---|---|---|---|
| Store / rev / 快照 / 冷备份 | `python-runtime/db.py` | `bff/store-node/db.js` | `db.test.js` | ✅ PASS |
| 三向合并（base/mine/theirs） | `python-runtime/merge.py` | `bff/store-node/merge.js` | `merge.test.js` | ✅ PASS |
| 队列消费器 | `python-runtime/queue_consumer.py` | `bff/store-node/consumer.js` | `consumer.test.js` | ✅ PASS |
| 店内 HTTP 服务 | `python-runtime/app.py` | `bff/store-node/server.js` | `server.test.js` | ✅ PASS |
| 快照推送器 | `python-runtime/snapshot_pusher.py` | `bff/store-node/pusher.js` | — | 🔄 文件存在，无独立平价测试 |
| 种子迁移脚本 ×9 | `python-seed/*.py` | `bff/store-node/seed/*.js` | `seed/*.test.js` | ✅ 9/9 PASS |
| **汇总** | | | `node bff/store-node/run-tests.js` | **4/4** |

## 3. 意图层：红线

| 红线条款（计划 §9 / AGENTS.md） | 工程化落地 | 校验方式 | 实测 |
|---|---|---|---|
| `rebuildStock`/`dishRecipeCost`/`seedDB` 零改动 | 算法层受平价测试保护；`db.js`/`merge.js` 进哈希基线 | `ci/redline_baseline.sha256` | ✅ 哈希一致 |
| 后台无旁路写（禁止直连 `/api/sync`、sqlite、`.db`） | `ci/redline_guard.sh` grep `api/sync\|sqlite3\|餐厅系统.db` | CI `redline-guard` | ✅ 无命中 |
| Key 仅 env，不硬编码 | guard 扫 `sk-[A-Za-z0-9]{20,}` | 同上 | ✅ 无命中 |
| 图片不落库 | guard 扫 `writeFileSync.*imageBase64` | 同上 | ✅ 无命中 |
| 写回必经确认队列 | `bff/routes/actions.js` + KMP `redline/ConfirmGateway` | 契约测试 | 🔄 见第 6 节待验证项 |

## 4. 形态层：组件对照（改计划，不改代码）

| Python 时代（计划 v1.0） | Node 现状（v2.0） | 说明 |
|---|---|---|
| `store-inventory/server/app.py`（HTTP + 静态） | `bff/store-node/server.js` | 同职责 |
| `store-inventory/server/db.py` | `bff/store-node/db.js` | 同名继承 |
| `store-inventory/server/merge.py` | `bff/store-node/merge.js` | 同名继承 |
| `store-inventory/queue_consumer.py`（144KB） | `bff/lib/algorithms/*` + `bff/store-node/consumer.js` | 按域拆分，算法上提 BFF |
| `store-inventory/snapshot_pusher.py` | `bff/store-node/pusher.js` | 同职责 |
| `比价脚本/*.py` | 归档 `old/store-inventory-legacy/比价脚本/` | 未迁移（离线工具） |
| 单文件 `熊猫五福…HTML` | `old/apps/boss-app`（归档）+ `apps/admin-web`（新前台） | 形态升级 |
| 计划端点 A1–A15 | `bff/routes/*.js`（16 个路由文件） | **超出**，见第 5 节 |

## 5. 范围层：缺口与漂移（需决策，非「不忠实」）

### 5.1 计划外新增（➕，需决定保留/砍掉）

`si/*`（经营模拟：goals/team/pipeline/cockpit/simulate）、`workbench/*`（采购/厨房工作台）、`inbox`、`policies`（自动策略开关）、`org`（组织）、`app_release`（发布）、`agent/stream`（SSE 对话流）、`report/briefing`、`modules/*`、`queue/health`。

→ 这些不在 A1–A15 端点表与 82 张任务卡内。**该不该留是业务判断**，不要混进「忠实性」评价。

### 5.2 计划内缺口（⬜，需排期）

| 模块 | iOS（Swift View） | Android feature | admin-web 页面 |
|---|---|---|---|
| M1 analysis | ✅ AnalysisView | ⬜（聚合在 `modules`） | 🟡 Dashboard/WeeklyReport 部分 |
| M2 staff | ✅ | ⬜ | ✅ hr/*（3 页） |
| M3 vip | ✅ | ⬜ | ⬜ |
| M4 pos | ✅ | ✅ `features/pos` | ✅ dinein/Tables |
| M5 takeout | ✅ | ⬜ | ⬜ |
| M6 booking | ✅ | ⬜ | ✅ dinein/Booking |
| M7 foodsafe | ✅ | ⬜ | 🟡 safety/*（2 页，缺留样/消毒） |
| M8 equipment | ✅ | ⬜ | ⬜ |
| M9 finance | ✅ | ⬜ | ⬜ |
| M10 supply | ✅ | ⬜ | 🟡 Vendors 部分 |
| M11 review | ✅ | ⬜ | ⬜ |
| M12 loss | ✅ | ⬜ | ⬜ |

> 注：iOS 12 个模块 View **文件齐全**（33 个 Swift），但 `apps/ios-app` **不含 .xcodeproj**，从未编译验证——
> 「有文件」不等于「可运行」，这是当前最大的认知偏差来源。

---

## 7. 功能层（本次新增，重要修正）

> 修正说明：本表第 1–3 节证明的是**算法/数据/存储层忠实**，**不覆盖页面功能层**。
> 2026-09-28 经旧系统截图比对发现：`进货入库` 页 15 项功能点中仅 3 项已移植（其中 2 项是新版新增能力），
> **12 项缺失**（结算单全家桶、补付、批量导入、汇总卡、明细展开、编辑/作废等），
> 且后端 `bff/routes/` 内 `settle|结算|补付|导入` **零命中**——属全栈性缺失。
> 根因：迁移以「页面/模块」为单位，页面级功能从未清单化，故无人对"功能在不在"负责。

- 整改规范：`docs/迁移颗粒度规范.md`（迁移单位 = FP，四态标注，两条门禁互不替代）
- 首份基线：`docs/迁移基线/FP-进货入库.md`（⬆️3 / 🔄0 / ⬜12 / ⚰️0）
- 模式：**替代**，故 12 项 ⬜ 全部视为回归缺陷
- 已在 `AGENTS.md` §7、`ARCHITECTURE.md` 规则 5、`ci/redline_guard.sh` R14 落为硬约束

> 结论修正为：**引擎忠实，功能残缺**。后续引用本表时须区分这两层。

## 8. 待验证项（本表尚未覆盖，建议下一步做）

1. **写回闭环端到端**：确认 → 云端队列 → 店内消费器 → `/api/sync`（带 rev） → 快照回写。需一条可复跑的脚本。
2. **快照推送链路**：`pusher.js` 无独立平价测试。
3. **iOS 可编译性**：补 `.xcodeproj` 或明确降级为「源码储备」。
4. **契约测试**：`bff/test_contract.sh` 需起服务 + `KIMI_API_KEY`，本机未跑。

---

## 7. 附录：本次恢复验证体系所做的改动

| # | 问题 | 处置 |
|---|---|---|
| 1 | 平价测试硬编码 `python3`；Windows 的 `python3.exe` 是 Microsoft Store 别名存根，一带 stdin 即静默失败 | 新增 `bff/lib/_python.js`：依次尝试 `PARITY_PYTHON`/`python3`/`python`/`py -3`，用**带 stdin 的探针**验证后再选用 |
| 2 | 中文 Windows 下 Python stdin/stdout 默认 GBK，中文（如「已入库」「手工调整」）跨端变乱码 → **假失败**（曾致 `rebuild_stock` moves 5 vs 6） | 调用时强制 `PYTHONIOENCODING=utf-8` |
| 3 | `old/.../python-seed/migrations` 与 `data` 是 Git 符号链接（mode 120000），Windows `core.symlinks=false` 落成文本文件 → `FileNotFoundError` | 在 `queue_consumer.py`/`seed_recipes.py`/`seed_modules.py` 增加 `_resolve_sql()` 回退到真身 `store-inventory/migrations`（不复制副本，避免漂移） |
| 4 | `stock.test.js` 残留 `sys.path.insert(...store-inventory)` 死代码 | 移除 |

涉及文件：`bff/lib/_python.js`（新增）、`bff/lib/algorithms/_python.js`（转为转发）、6 个算法测试、4 个 store-node/seed 测试、3 个 Python 原实现（仅路径解析）。
**未改动任何业务算法逻辑**，平价测试全绿即证明。
