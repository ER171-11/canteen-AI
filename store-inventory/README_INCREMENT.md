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

流程：`GET /api/db` → 从本地 sqlite 新表（recipes/sop_steps/sop_workorders/qc_records）
只读组装 `ext`（JSON TEXT 列解析回对象/数组；表不存在/为空 → 空数组不报错）→
体积检查（data+ext 超阈值告警跳过）→ `POST BFF /api/snapshot/push {rev, data, ext, machine}`
→ 成功后写 `data/pusher_state.json`（last_rev/last_ts/last_ext）。只读店内服务与新表，绝不写回。

```bash
python3 snapshot_pusher.py                      # 常驻循环（默认 900s/轮）
python3 snapshot_pusher.py --once               # 单次执行（rev 与 ext 行数均未变则跳过）
python3 snapshot_pusher.py --interval 300 \
    --store-url http://127.0.0.1:8765 \
    --bff-url http://127.0.0.1:8787 \
    --max-bytes 5242880 \
    --db data/餐厅系统.db \
    --token "$BFF_TOKEN"
```

- 网络/HTTP 异常指数退避重试 3 次（2s/4s/8s），最终失败记日志、不退出循环。
- 体积默认上限 5MB，可用 `--max-bytes` 调整。
- rev 未变但 ext 行数变化（如重新 seed 配方）也会触发重推。
- 删除 `data/pusher_state.json` 可强制下一轮全量重推。
- 推送日志含 ext 各模块行数，如 `ext=recipes:9,sop_steps:182,sop_workorders:1,qc_records:0`。

## 2.1 seed_recipes.py —— 五福饺子配方种子（docx → recipes/sop_steps）

从 `../金丰御字牌五福饺子(2).docx` 解析（zipfile + 正则，纯标准库），按
PRD v1.0 附录 A 的 9 SKU 对齐命名（SKU-WF-HONG/HUANG/LV/ZI/HEI/BAI-SUANCAI/
BAI-NIUROU/BAI-XIHULU/BAI-SHANYAO），INSERT OR REPLACE 幂等写入 `recipes` 与
`sop_steps`（docx 每步分类到 和面/醒发/备馅/拌馅/剂子/包制/煮制/装盘 八阶段，
附带 QC 点与风险），并生成 1 条今日示范工单进 `sop_workorders`（同日同 SKU 已存在则跳过）。

```bash
python3 seed_recipes.py --dry-run   # 只打印 SKU 清单摘要，不落库
python3 seed_recipes.py             # 解析 + 落库（可重复执行）
python3 seed_recipes.py --db 路径 --docx 路径
```

红线保护：
- `face_main`（色源）从 docx 面主料扣除面粉/食盐基料得出；**红色 SKU 强制校验
  必须含「火龙果」，否则中止写入**（PRD：红色必须火龙果，色源不可替换）。
- 时长仅「醒发 30 分钟」有 docx 出处，其余 duration_min 留空不编造；
  剂子 10-11g、成品 25-27g（白色部分 25-28g 按 docx 原文）、点水 3 次等取自
  docx 步骤与 PRD 通用工艺参数；褶纹 12-14 道来自任务书给定标准。
- docx 另有 5 个白色变体（牛肉白萝卜/胡萝卜木耳粉丝鸡蛋/茴香鸡蛋/猪肉香菇/
  韭菜鸡蛋）及冰花煎饺/蒸饺/鲜肉包等衍生品，因不在 PRD 9 SKU 内未入库，
  需要时在 `SKU_DEFS` 追加一行即可。

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

## 4. migrate_from_zip.py —— 从「餐厅系统.zip」灌入真实进销存

把打包机上的 `餐厅系统.zip` 内 `data/餐厅系统.db`（v3：`pos`+`logs`+有库存）
合并进本仓店内库（v4：`recv`/`orders`/补货壳），再由 `snapshot_pusher` 推到 BFF，
供 boss-app / Android / admin-web 只读消费。

```bash
python3 migrate_from_zip.py --dry-run          # 只看差异
python3 migrate_from_zip.py                    # 写库（自动冷备份）
# 登录拿 token 后推快照
TOKEN=$(curl -s -X POST http://127.0.0.1:8787/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"account":"boss","device_fp":"migrate"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
python3 snapshot_pusher.py --once --token "$TOKEN"
```

迁移策略：
- `pos` → `recv`，单号 `CG`→`JH`（对齐 HTML `migrateV4`）
- 覆盖：`ings`（含 stock/avg）、`logs`、`recv`、`quotes`、`sales`、`seq`
- 保留本仓：`orders`/`plans`/`restock`/`dishAlias`/`config` 与全部 ext 增量表
- **不**改 `rebuildStock`/`seedDB`/`dishRecipeCost` 源码

已验证（2026-09-24）：rev 28→29；BFF `stock>0=163`、`recv=9`、`logs=193`、应付 ¥8392.22。

## 5. import_orders_excel.py —— 批量导入 订单/ 配送单 Excel

解析 `.xlsx` 与伪 `.xls`(HTML)，写入 `DB.recv` 并 `rebuildStock`（Python 端口，口径对齐 HTML）。

```bash
python3 import_orders_excel.py --dry-run
python3 import_orders_excel.py --push   # 写库 + 推 BFF
```

- 跳过：`采购单整理_熊猫五福.xlsx`（已是 84 行基线）、`采购物品与施工备用金汇总表0924.xlsx`
- 去重：精确明细指纹 + `(日期,金额,行数)` 软键 + 拆分明细子集命中
- 已导入：9/17 鸿源五福、9/20、9/23；其余 9/13–9/16 已在库中跳过
