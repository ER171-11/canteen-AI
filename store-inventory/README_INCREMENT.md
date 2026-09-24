# 增量组件说明（核心零改动）

本文件记录三个新增组件的用法与红线边界。三个组件均为**纯新增文件**，
不修改 `server/app.py`、`server/db.py`、`server/merge.py` 及两个受保护 HTML
（`rebuildStock` / `dishRecipeCost` / `seedDB` 所在）。仅使用 Python 标准库。

## 1. migrations/001_new_tables.sql —— 新增表 DDL

45 张新业务表（配方/SOP/工单/质检/动作队列/快照登记/Kimi 日志/预测/POS/
员工/会员/预订排队/食品安全/设备/财务/供应商/评价/损耗/外卖），
全部 `CREATE TABLE IF NOT EXISTS`，幂等可重复执行。

```bash
sqlite3 data/餐厅系统.db < migrations/001_new_tables.sql
```

红线标注（SQL 注释中亦有）：
- `recipes.face_main`：**色源字段锁定**，改色须走变更流程。
- `forecast`：**预测≠下单**，任何自动补货单必须人工确认后生成。
- `eq_temp`：**不进 rev 体系**，高频时序数据只落本地 sqlite，不参与整库 JSON 合并。
- `vip_coupons.code`：券码 UNIQUE，防重核销。
- `fin_split.frozen_until`：分账冻结期，期内禁止划出。
- `loss_inventory_diff`：只做差异登记，**库存以 HTML rebuildStock 重放为准**。

## 2. snapshot_pusher.py —— 整库快照推送器（店内 → 云端 BFF）

流程：`GET /api/db` → 体积检查（超阈值告警跳过）→ `POST BFF /api/snapshot/push`
→ 成功后写 `data/pusher_state.json`（last_rev/last_ts）。只读店内服务，绝不写回。

```bash
python3 snapshot_pusher.py                      # 常驻循环（默认 900s/轮）
python3 snapshot_pusher.py --once               # 单次执行（rev 未变则跳过）
python3 snapshot_pusher.py --interval 300 \
    --store-url http://127.0.0.1:8765 \
    --bff-url http://127.0.0.1:8787 \
    --max-bytes 5242880
```

- 网络/HTTP 异常指数退避重试 3 次（2s/4s/8s），最终失败记日志、不退出循环。
- 体积默认上限 5MB，可用 `--max-bytes` 调整。
- 删除 `data/pusher_state.json` 可强制下一轮全量重推。

## 3. queue_consumer.py —— 云端动作队列消费者（BFF → 店内库）

每 30 秒一轮（或 `--once`）：拉 BFF `GET /api/actions?status=待执行`
（Bearer token：`--token` 或环境变量 `BFF_TOKEN`）→ 逐条应用到店内库 →
回调执行结果。

```bash
export BFF_TOKEN=xxxx
python3 queue_consumer.py                       # 常驻循环
python3 queue_consumer.py --once --token xxxx   # 单次执行
python3 queue_consumer.py --db data/餐厅系统.db  # 指定本地 sqlite（qc/actions 落库处）
```

已实现动作类型（`queue_consumer.py` 顶部 `KNOWN_TYPES`）：

| type | 行为 |
| --- | --- |
| `restock.create` | 向 `data.recv` 追加**草稿**采购单（`status=草稿`、`payments=[]` 未付款、`note` 带【草稿·云端补货】前缀；原料未匹配时 `ing=null` 保留品名，`rebuildStock` 对未知 ing 有跳过兜底，不污染库存重放） |
| `config.update` | 合并写入 `data.config`（新增顶层键，不改既有字段） |
| `qc.record` | 插入本地 sqlite `qc_records` 表（整库 data 不变，仍走 sync 登记新 rev） |

执行链路：`GET /api/db` 取 baseRev → 应用 payload →
`POST /api/sync {baseRev, data, machine:"QUEUE"}` 三向合并 →
成功回调 `POST /api/actions/{id}/execute {result:{new_rev}}`，失败回调 `{error}`。

- **未知 type**：直接回调驳回，不动数据。
- **冲突**（sync 返回非 ok 或 `action=need-manual`）：回调标记「需人工确认」，
  本地 `actions_queue` 表同步登记；人工确认走 BFF
  `POST /api/actions/{id}/confirm`，不在本组件职责内。
- **trace_id**：动作自带则沿用，缺失则生成，贯穿日志与回调。
- 每条动作登记到本地 `actions_queue` 表（done/failed/rejected/需人工确认）。
- 启动时幂等执行 `migrations/001_new_tables.sql` 确保新表存在；本地 sqlite
  只写新增表，**绝不触碰 docs/snapshots 核心表**。
- 新增动作类型：扩展 `KNOWN_TYPES` 并在 `process_action` 中加分支即可。

## 验证记录（2026-09-24）

- DDL 在 `data/餐厅系统.db` 副本上连续执行两遍无错误（幂等），
  `sqlite_master` 新增 44 张表（加既有 docs/snapshots/sqlite_sequence 共 47）；
  `vip_coupons.code` UNIQUE、`fin_split.frozen_until`、`forecast` 复合主键均确认。
- `python3 -m py_compile snapshot_pusher.py queue_consumer.py` 通过。
- 端到端干跑（副本库 + Mock BFF）：4 条动作（restock/config/qc/未知类型）
  分别 executed×3 / rejected×1，rev 19→22，`actions_queue`/`qc_records`
  落库正确；pusher 推送成功、rev 去重跳过、状态文件写入均验证通过。
- 店内服务/BFF 未启动时两组件均优雅报错、不崩溃。
- `sha256sum -c ../ci/redline_baseline.sha256`：5 个受保护文件全部「成功」。
