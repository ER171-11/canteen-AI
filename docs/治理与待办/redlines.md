# 红线总表（唯一权威）

- 日期：2026-10-16
- 状态：**生效**
- 目的：收敛两处漂移，建立唯一权威——① 代码注释「红线①~⑥」编号语义漂移（同一个「①」在 `sale.js`=唯一写入口、在 `export.js`=只读零写库）；② 注释编号与 `ci/redline_guard.sh` 的「R3/R4/R5/R10/R13/R14/R15」两套并存无映射。
- 定位：此后各文件注释、ADR、迁移基线一律引用本文档**短名**，不再引用脆弱数字编号。

---

## 1. 定义与对象

红线是**过程约束，不是结果约束**。约束对象不是「库」，而是「**绕过队列改变账本语义的那一步写**」。

- **对象 = 账本**：当前 = 店内 SQLite（`docs.data` 整库 JSON + 60 余张 ext 业务表）；按 ADR-009 定案方向，将来 = 云端库（`snapshot.json` 降级为导出/缓存）。
- **落点跟随账本迁移**：五项约束（写入口/审批/幂等/乐观锁/可回滚）一条不松，落点随账本从店内挪到云端。
- **「写入」精确定义**：未经 `POST /api/actions`（建议 → 审批 → 消费器执行 → 快照回写）而直接改变账本语义的行为。被允许的写只有两类：① 消费器作为队列动作的**执行体**写账本；② 推快照器作为**投影同步**写云端快照。

---

## 2. 唯一权威红线清单（以短名为准）

| # | 短名 | 语义（唯一） | 落点 | 机械判定 |
|---|---|---|---|---|
| 1 | 唯一写入口 | 所有写操作一律 `POST /api/actions` → 审批 → 消费器执行 → 快照回写；BFF 不直写店内 DB；前端不直写账本字段 | 账本 | `R13` |
| 2 | 审批留痕 | 写经审批中心确认才落库，谁何时改了什么全程可审计 | 账本 | — |
| 3 | 幂等去重 | 重复提交/重试不产生重复落库（见 ADR-006） | 账本 | — |
| 4 | 乐观锁 rev | 先到先得；冲突 `confirm` 409 + 消费器 `baseRev` 三向合并，店内新变更不被盲覆盖 | 账本 | — |
| 5 | 可回滚留痕 | 高危写强制先留档；回滚须运营管理员审批并全程留痕（谁何时从哪 rev 到哪 rev） | 账本 | — |
| 6 | 作废留痕不物理删 | 作废只置 `status='已作废'` 并记作废人/时间/rev/reason，绝不 DELETE | 账本 | — |
| 7 | 不静默降级 | 失败/超付/不支持格式/非法明细一律显式报错，不截断不跳过；不支持格式须在界面写清 | 账本+体验 | — |
| 8 | 派生不落库 | 派生字段（欠款=receivable−Σpayments 等）实时算，快照不存（存下必漂移） | 快照 | — |
| 9 | 只读零写库 | 只读模块（导出/经营分析/模拟/厨房/agent）无任何写库路径：不 `saveDB`、不写 `data/*.json`、不 `postAction`、不入队 | 账本+文件 | `R15` |
| 10 | 图片不落库 | 图片仅内存/对象存储，不落盘、不入账本；请求体带 base64 一律 400 驳回 | 文件+账本 | `R10` |

> 衍生条款：ADR-004 中「`stock.js::rebuildStock` 只可调用、不可改写」归入 **#1 唯一写入口**——库存重算口径是唯一入口的延伸，执行器只可调用统一口径，不得私自改写。

---

## 3. 机械判定（`ci/redline_guard` 的 R 编号）

| R 编号 | 判什么 | 对应短名 |
|---|---|---|
| R3/R4 | `store-node/db.js`+`merge.js` 哈希零改动（店内存储核心锁定） | 账本底座 |
| R5 | 无硬编码密钥 | 安全（不在业务红线内） |
| R10 | 图片不落库（BFF 侧） | #10 |
| R13 | admin-web / admin 路由禁直连店内 `/api/sync`、`sqlite`、`餐厅系统.db`（后台禁止旁路写） | #1 |
| R14 | FP 基线每行必带四态标注 | 迁移规范（不在业务红线内） |
| R15 | 结构测算模拟态零写库 | #9 |

---

## 4. 历史编号漂移清单（待逐步修正）

| 历史编号 | 出现位置 | 历史语义 | 应改为短名 |
|---|---|---|---|
| 红线① | `lib/algorithms/sale.js` | 唯一写入口（前端不得直写 `sales[]`） | #1 |
| 红线① | `routes/export.js`、`agent.js`、`modules.js`、`kitchen.js`、`foodsafe.js`、`finance.js`、`equipment.js`、`supply.js`、`loss.js`、`staff.js`、`analysis_sim.js`、`admin.js`、`qc_media.js`、README | 只读零写库 / 图片不落库 | #9 / #10 |
| 红线① | ADR-004 §4、§7 | `rebuildStock` 只可调用不可改写 | #1（衍生条款） |
| 红线② | `routes/sync.js`、`actions.js`、`foodsafe.js`、`finance.js`、`equipment.js`、`supply.js`、`loss.js`、`staff.js`、`safety_points.js`、`qc_media.js` | 写统一进队列 | #1 |
| 红线② | `lib/sales_model.js`、`lib/algorithms/sale.js` | 派生值不落库 | #8 |
| 红线③ | `routes/actions.js`、`routes/admin.js` | BFF 不直连店内 DB（后台禁止旁路写） | #1 |
| 红线④ | `lib/algorithms/sale.js` | 作废不物理删除 | #6 |
| 红线⑤ | `routes/actions.js`、ADR-004 | 写回必经确认 + rev | #2 / #4 |
| 红线⑥ | `lib/recv_import.js`、`lib/algorithms/inventory.js`、`lib/algorithms/sale.js` 及各处 import 测试 | 不静默降级（失败/超付/不支持格式显式报错） | #7 |

---

## 5. 落点迁移（本地 → 云端）与偏离登记

- ADR-009 已定案「服务端主存为真、单一数据源在服务端、双机同步四件套废弃」。
- 现状（经代码核实）：桌面端主存为**每台终端本地 `snapshot.json`**（BFF `CANTEEN_LOCAL_APPLY=1` 直接落盘），
  `store-node` / SQLite 四件套在桌面端**休眠未运行**；偏差点是「主存分散在终端、无中心化」，非「店内 SQLite 在当主」。
  属 **ADR-009 的「有意偏离 / 迁移未完成」**，按 ADR-004 §7 第 7 项要求显式登记。
- 收敛已拍板：ADR-010 于 2026-10-28 定 D0–D3（建腾讯云中心服务 / 云端 PostgreSQL / 独立 worker / 按店迁移严禁双写），**不再处于「待拍板」**；断网降级按 ADR-010 §9 沿用 ADR-009 §2.1「只读」（localStorage 热备、过期即弃，不做离线写）。
- 收敛路径（分期）：Phase 0 接缝层（无云权限可做，本地验红线）→ Phase 1 云端建库（腾讯云 PostgreSQL）→ Phase 2 按店迁移切流（严禁双写）→ Phase 3 本地退场。**Phase 0 已于 2026-10-28 完成**（`store-adapter` / `action-runner` / 独立 `worker` / 契约测试双绿；默认仍是 json 适配器，运行时读写行为不变）。
- 收敛后红线五项**不松**，仅落点随账本从终端本地移到云端库；完整迁移任务书见 ADR-010（分期版）：`docs/decisions/ADR-010-本地SQLite退场与云端单一主存.md`。

---

## 6. 受保护文件哈希基线（R3/R4）变更记录

> 规则：`db.js` / `merge.js` / `stock.js` 属被锁定的账本底座。**任何改动必须同时重算 `ci/redline_baseline.sha256` 并在此登记理由**，
> 否则 R3/R4 必然报红——这正是该检查的用途（防止「悄悄改了底座还全绿」）。

| 日期 | 文件 | 原因 | 结论 |
|---|---|---|---|
| 2026-10-29 | `bff/store-node/merge.js` | 受控词表 Phase 2：三向合并的 `COLL_KEY` 纳入 `vendor_terms:'id'`（与 `old/store-inventory-legacy/python-runtime/merge.py` 同步；`merge.test.js` 23/23 与 Python 一致）。改动随提交 `10e1b82` 落地，但当时漏刷基线，导致 R3/R4 自 10-28 起持续报红 | **补登记并重算哈希**（新增 2 行，无其他语义变更），基线更新为 `4bd611f6…` |
| 2026-10-30 | `bff/lib/algorithms/stock.js` | ADR-004 §2.5 两段式：`rebuildStock` 里内联的「草稿/待收/作废」状态判断改为调用 `lib/recv_status.js::isEffective()`，作为进货单生效口径的**唯一出口**（原来 stock/report/modules/workbench 四处各写一份，加「待审核」必然漂移）。**算法语义未变**：新状态「待审核」按既有规则同样不进货（含「待」字样），28/28 算法层用例全绿 | **重算哈希**（基线更新为 `b2dd8ce1…`）；口径收敛后新增 `recv_pending.test.js` 覆盖 |


