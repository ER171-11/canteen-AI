# ADR-002 去 Python：店内运行时 Node 化 + 算法上提 BFF

| 项 | 内容 |
|---|---|
| 编号 | ADR-002（仓库级；与 `store-inventory/docs/decisions/ADR-001` 分属不同目录，编号独立） |
| 状态 | **已实施**（2026-09「架构收敛」提交），本文为事后补录 |
| 决策日期 | 2026-09（实施）／2026-09-28（补录） |
| 影响范围 | `store-inventory/`（Python 运行时）→ `bff/store-node/` + `bff/lib/algorithms/`；`old/store-inventory-legacy/`（归档） |
| 相关 | 《Python到Node忠实性映射表.md》、《工程执行计划_v2.0_Node架构.md》 |

---

## 1. 背景

- 原架构（计划 v1.0）：店内进销存为 **Python**（`server/app.py` + `db.py` + `merge.py` + `queue_consumer.py` + `snapshot_pusher.py`），浏览器单文件 HTML 前端。
- 同时云端 BFF 已是 Node。两套语言并存导致：同一份业务算法要维护两处、排障要跨栈、部署要两套运行时。
- `queue_consumer.py` 已膨胀到 144KB，是全部业务算法的单一承载体。

## 2. 决策

1. **店内运行时 Node 化**：新建 `bff/store-node/`（`server.js`/`db.js`/`merge.js`/`consumer.js`/`pusher.js`），替代 Python 运行时。
2. **算法上提 BFF**：`queue_consumer.py` 的业务算法按域拆分到 `bff/lib/algorithms/`（stock/dish/inventory/ops/pos/execute/util/registry），成为纯函数，便于复用与单测。
3. **Python 原实现归档而非删除**：整体移入 `old/store-inventory-legacy/`（`python-runtime/` + `python-seed/`），作为平价测试的**基准实现**长期保留。
4. **以平价（差分）测试作为忠实性闸门**：Node 与 Python 同 fixture 双跑、深比较，CI 强制全绿。

## 3. 保了什么（意图层，不可让）

| 项 | 保障手段 |
|---|---|
| 移动加权平均计价（`rebuildStock`） | `stock.test.js` 平价 |
| 配方成本（`dishRecipeCost`） | `dish.test.js` 平价 |
| 三向合并 + rev 乐观锁 | `merge.test.js` 平价 + `merge.js` 进哈希基线 |
| Store/rev/快照/冷备份 | `db.test.js` 平价 + `db.js` 进哈希基线 |
| 采购单不进库存、自动生成≠自动下单、预测≠下单 | 平价测试中的回归断言 |
| 种子数据基线（真实采购单，禁演示数据） | `seed/*.test.js` 9 项平价 |
| Key 仅 env、图片不落库、后台无旁路写 | `ci/redline_guard.sh` |

## 4. 弃了什么（形态层，属合理演进）

| Python 时代 | 现状 |
|---|---|
| `server/app.py` / `db.py` / `merge.py` / `queue_consumer.py` / `snapshot_pusher.py` | 归档 `old/.../python-runtime/`，仅作平价基准 |
| `比价脚本/*.py`（1688 抓价） | 归档，未迁移（离线工具，非链路依赖） |
| 单文件 HTML 前端 | 归档 `old/apps/boss-app`；前台改 `apps/admin-web` |
| 端点清单 A1–A15 | 保留并实现，另新增 si/workbench/inbox/policies/org/app_release 等（见映射表 §5.1） |

## 5. 如何验证等价（本 ADR 的核心）

```bash
cd bff
npm test   # 算法平价 6/6 + store-node 平价 4/4 + seed 平价 9/9，全绿才退出 0
bash ci/redline_guard.sh   # 受保护文件哈希 + 旁路写 + 硬编码 Key + 图片落盘
```

**实测（2026-09-28，Windows + Python 3.14）**：

| 套件 | 修复前 | 修复后 |
|---|---|---|
| 算法层平价 | 1/6（5 项为编码假失败，1 项为同一根因导致的计数差） | **6/6** |
| store-node 平价 | 2/4 | **4/4** |
| seed 平价 | 6/9 | **9/9** |
| 红线哈希基线 | 通过 | 通过 |

> 修复前的失败**全部**是环境问题（Windows `python3` 为 Store 别名存根、GBK 编码、Git 符号链接被落成文本文件），
> **不是**逻辑不忠实。详见映射表第 7 节。

## 6. 副作用与遗留（需后续处理）

| # | 遗留 | 影响 | 建议 |
|---|---|---|---|
| 1 | `old/.../python-seed/{migrations,data}` 是 Git 符号链接（mode 120000）；Windows `core.symlinks=false` 落成文本文件 | 平价测试 `FileNotFoundError` | 已在 3 个 Python 脚本加 `_resolve_sql()` 回退；根治需开启符号链接（需管理员/开发者模式） |
| 2 | 平价测试依赖本机 Python 3；Windows 解释器名不统一 | 环境不一致 | 已用 `bff/lib/_python.js` 统一探测，支持 `PARITY_PYTHON` 覆盖 |
| 3 | seed 测试依赖基座库 `store-inventory/data/餐厅系统.db`（不入 VCS） | CI 全新检出时整体 SKIP，等于没跑 | 需提供可生成的基座或测试数据 |
| 4 | CI 无 lint、无覆盖率门禁、无 iOS 构建；`kmp-shared` 缺 gradle wrapper 导致 `kmp-build` 必挂 | 门禁不完整 | 见计划 v2.0 §5 |
| 5 | 计划文档 `docs/开发计划*` 仍按 Python 编写 | 文档失真 | 本 ADR + 计划 v2.0 处置 |

## 7. 回档方案

- 逻辑回档：以 `old/store-inventory-legacy/python-runtime/` 为基准实现，随时可比对/还原口径；平价测试即为回档校验器。
- 部署回档：`bff/store-node/` 与 Python 运行时的数据模型一致（`docs` 整库 + `rev` + `snapshots`），可切换运行时而不迁移数据。
- 本 ADR 不改变数据库结构（`migrations/` 仅增不改），不存在数据级回档成本。
