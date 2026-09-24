-- =============================================================
-- 熊猫五福餐厅进销存系统 · 增量建表迁移 001
-- 红线约束：
--   1. 本文件只新增表（CREATE TABLE IF NOT EXISTS），
--      不修改/不删除任何既有表（docs/snapshots 为核心零改动区）。
--   2. 全部语句幂等，可重复执行。
--   3. 核心计价/库存重放逻辑在 HTML 受保护函数内（rebuildStock/
--      dishRecipeCost/seedDB），本文件绝不触碰。
-- 执行方式：sqlite3 data/餐厅系统.db < migrations/001_new_tables.sql
-- =============================================================

-- ---------- 配方与 SOP（厨房生产） ----------

-- 菜品配方卡：face_main 为「色源字段锁定」——五福饺子面皮主色来源，
-- 一经录入锁定不改，改色须走变更流程（防串色/食品安全红线）。
CREATE TABLE IF NOT EXISTS recipes (
  sku_id      TEXT PRIMARY KEY,
  name        TEXT,
  color       TEXT,
  filling     TEXT,
  face_main   TEXT,            -- 色源字段锁定：面皮主色来源，禁止随意改写
  main        TEXT,            -- 主料（JSON 数组）
  aux         TEXT,            -- 辅料（JSON 数组）
  seasoning   TEXT,            -- 调料（JSON 数组）
  steps       TEXT,            -- 工艺步骤（JSON 数组）
  params      TEXT,            -- 工艺参数（JSON，如水温/醒发时间）
  blessing    TEXT,            -- 五福祝福语
  diet_tags   TEXT,            -- 膳食标签（JSON，如 清真/过敏原）
  version     INTEGER DEFAULT 1,
  updated_at  TEXT
);

-- SOP 分步工序：与 recipes 一对一多的展开
CREATE TABLE IF NOT EXISTS sop_steps (
  sku_id       TEXT,
  step_no      INTEGER,
  stage        TEXT,           -- 阶段：备料/和面/制馅/包制/煮制/出餐
  duration_min REAL,
  tools        TEXT,           -- 工具（JSON 数组）
  inputs       TEXT,           -- 本步投入（JSON）
  key_points   TEXT,           -- 关键操作要点
  qc_point     TEXT,           -- 质检点
  risk         TEXT,           -- 风险与防范
  params       TEXT,           -- 参数（JSON）
  PRIMARY KEY (sku_id, step_no)
);

-- SOP 生产工单：status 状态机 待开始→进行中→待质检→完成/作废
CREATE TABLE IF NOT EXISTS sop_workorders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          TEXT,
  sku_id        TEXT,
  qty           REAL,
  planned_start TEXT,
  status        TEXT DEFAULT '待开始',
  qc_records    TEXT           -- 关联质检记录（JSON id 列表）
);

-- 质检记录：pass 1=合格 0=不合格；source=manual/auto/kimi
CREATE TABLE IF NOT EXISTS qc_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workorder_id  INTEGER,
  sku_id        TEXT,
  sample_weight REAL,
  pass          INTEGER,
  ts            TEXT,
  source        TEXT DEFAULT 'manual'
);

-- ---------- 云端协同：动作队列与快照 ----------

-- 云端下发动作本地队列：status=queued/done/failed/需人工确认
-- trace_id 全链路透传（BFF→消费者→日志）
CREATE TABLE IF NOT EXISTS actions_queue (
  id          TEXT PRIMARY KEY,
  type        TEXT,
  payload     TEXT,            -- JSON
  status      TEXT DEFAULT 'queued',
  rev         INTEGER,         -- 执行后库 rev
  created_at  TEXT,
  executed_at TEXT,
  operator    TEXT,
  trace_id    TEXT
);

-- 推送云端的整库快照登记（data 本体存 BFF，此处只记元信息）
CREATE TABLE IF NOT EXISTS snapshot_rev (
  rev          INTEGER PRIMARY KEY,
  generated_at TEXT,
  size_bytes   INTEGER,
  module_mark  TEXT            -- 模块标记（JSON，各模块计数等）
);

-- Kimi 视觉 API 调用日志（契约见 Kimi视觉API调用契约.md）
-- degraded=1 表示降级（未走模型/走兜底），便于核算成本与质量
CREATE TABLE IF NOT EXISTS kimi_log (
  trace_id    TEXT PRIMARY KEY,
  type        TEXT,            -- 调用类型：收货单识别/菜品识别等
  user_id     TEXT,
  model       TEXT,
  http_status INTEGER,
  dt_ms       INTEGER,
  degraded    INTEGER,
  usage       TEXT,            -- token 用量（JSON）
  ts          TEXT
);

-- 销量预测：红线「预测≠下单」——预测结果仅供人工参考，
-- 任何自动补货单必须经人工确认后才生成 orders/recv 记录。
CREATE TABLE IF NOT EXISTS forecast (
  date       TEXT,
  sku_id     TEXT,
  qty_pred   REAL,
  confidence REAL,
  band_low   REAL,
  band_high  REAL,
  model_ver  TEXT,
  created_at TEXT,
  PRIMARY KEY (date, sku_id)
);

-- ---------- POS 收银（桌台/订单/支付/挂账） ----------

-- 桌台：status=空闲/占用/预订/停用；locked_until 用于开台锁定防并发
CREATE TABLE IF NOT EXISTS pos_tables (
  table_id     TEXT PRIMARY KEY,
  name         TEXT,
  capacity     INTEGER,
  status       TEXT DEFAULT '空闲',
  cur_order_id TEXT,
  locked_until TEXT
);

-- POS 订单：merged_from/split_to 支持并台与分单（JSON 数组）
CREATE TABLE IF NOT EXISTS pos_orders (
  order_id    TEXT PRIMARY KEY,
  table_id    TEXT,
  items       TEXT,            -- 明细（JSON 数组）
  merged_from TEXT,
  split_to    TEXT,
  status      TEXT,            -- 进行中/已结账/已取消
  rev         INTEGER
);

-- 支付流水：一单可多次支付（现金/扫码/储值/券组合）
CREATE TABLE IF NOT EXISTS pos_payments (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT,
  method   TEXT,
  amount   REAL,
  ts       TEXT,
  rev      INTEGER
);

-- 挂账（赊账）：status=挂账/已核销/逾期
CREATE TABLE IF NOT EXISTS pos_hanging (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT,
  creditor TEXT,               -- 挂账人/单位
  amount   REAL,
  due_date TEXT,
  status   TEXT DEFAULT '挂账',
  rev      INTEGER
);

-- ---------- 员工（排班/打卡/绩效/培训） ----------

-- 排班
CREATE TABLE IF NOT EXISTS staff_shifts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id   TEXT,
  staff_name TEXT,
  date       TEXT,
  shift      TEXT,             -- 早班/中班/晚班
  start_time TEXT,
  end_time   TEXT,
  role       TEXT,             -- 岗位
  rev        INTEGER
);

-- 打卡
CREATE TABLE IF NOT EXISTS staff_clock (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id TEXT,
  ts       TEXT,
  kind     TEXT,               -- 上班/下班
  device   TEXT,
  rev      INTEGER
);

-- 绩效
CREATE TABLE IF NOT EXISTS staff_perf (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id  TEXT,
  period    TEXT,              -- 考核周期（如 2026-09）
  metric    TEXT,              -- 指标名
  value     REAL,
  score     REAL,
  remark    TEXT,
  rev       INTEGER
);

-- 培训
CREATE TABLE IF NOT EXISTS staff_train (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id  TEXT,
  course    TEXT,
  passed    INTEGER,           -- 1=通过 0=未通过
  ts        TEXT,
  remark    TEXT,
  rev       INTEGER
);

-- ---------- 会员（档案/储值余额/券/充值流水） ----------

-- 会员档案
CREATE TABLE IF NOT EXISTS vip_members (
  member_id TEXT PRIMARY KEY,
  name      TEXT,
  phone     TEXT,
  level     TEXT,
  joined_at TEXT,
  status    TEXT DEFAULT '正常',
  rev       INTEGER
);

-- 储值余额（一会员一行，余额变动走 vip_recharge 流水）
CREATE TABLE IF NOT EXISTS vip_balance (
  member_id  TEXT PRIMARY KEY,
  balance    REAL DEFAULT 0,
  updated_at TEXT,
  rev        INTEGER
);

-- 优惠券：code 唯一约束（防重核销红线）
CREATE TABLE IF NOT EXISTS vip_coupons (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  code      TEXT UNIQUE,       -- 券码唯一，核销时校验
  member_id TEXT,
  type      TEXT,              -- 满减/折扣/兑换
  value     REAL,
  status    TEXT DEFAULT '未使用',  -- 未使用/已使用/已过期
  valid_to  TEXT,
  used_at   TEXT,
  rev       INTEGER
);

-- 充值流水
CREATE TABLE IF NOT EXISTS vip_recharge (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT,
  amount    REAL,
  gift      REAL,              -- 赠送金额
  method    TEXT,
  ts        TEXT,
  rev       INTEGER
);

-- ---------- 预订与排队 ----------

-- 预订
CREATE TABLE IF NOT EXISTS bookings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_name TEXT,
  phone      TEXT,
  date       TEXT,
  time       TEXT,
  party_size INTEGER,
  table_id   TEXT,
  status     TEXT DEFAULT '待确认',  -- 待确认/已确认/已到店/已取消/爽约
  note       TEXT,
  rev        INTEGER
);

-- 排队叫号
CREATE TABLE IF NOT EXISTS queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_no   TEXT,
  date       TEXT,
  party_size INTEGER,
  status     TEXT DEFAULT '等位',    -- 等位/已叫号/已过号/已入座
  ts         TEXT,
  rev        INTEGER
);

-- ---------- 食品安全（证照/溯源/留样/消毒） ----------

-- 证照台账：到期预警用
CREATE TABLE IF NOT EXISTS fs_certs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cert_type  TEXT,             -- 营业执照/食品经营许可/健康证等
  holder     TEXT,             -- 持证主体/人
  cert_no    TEXT,
  issued_at  TEXT,
  expire_at  TEXT,
  status     TEXT DEFAULT '有效',
  rev        INTEGER
);

-- 食材溯源：批次级
CREATE TABLE IF NOT EXISTS fs_trace (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no  TEXT,
  ing_name  TEXT,
  supplier  TEXT,
  recv_date TEXT,
  origin    TEXT,              -- 产地
  cert_no   TEXT,              -- 检疫/合格证明号
  rev       INTEGER
);

-- 留样记录（每餐每品 125g/48h 监管要求）
CREATE TABLE IF NOT EXISTS fs_samples (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  date      TEXT,
  meal      TEXT,              -- 早餐/午餐/晚餐
  dish      TEXT,
  weight_g  REAL,
  keeper    TEXT,
  kept_at   TEXT,
  cleared_at TEXT,
  rev       INTEGER
);

-- 消毒记录
CREATE TABLE IF NOT EXISTS fs_disinfect (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  date     TEXT,
  area     TEXT,               -- 区域/器具
  method   TEXT,               -- 高温/紫外/药剂
  operator TEXT,
  ts       TEXT,
  rev      INTEGER
);

-- ---------- 设备（温度/能耗/维保） ----------

-- 设备温度时间序列：红线「不进 rev 体系」——高频采集数据不参与
-- 整库 JSON 的 rev 合并，只落本地 sqlite，避免拖垮同步体积。
CREATE TABLE IF NOT EXISTS eq_temp (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT,
  device TEXT,
  temp   REAL
);

-- 能耗记录
CREATE TABLE IF NOT EXISTS eq_energy (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  date     TEXT,
  device   TEXT,
  kind     TEXT,               -- 电/水/气
  reading  REAL,               -- 表读数
  usage    REAL,               -- 用量
  rev      INTEGER
);

-- 维保记录
CREATE TABLE IF NOT EXISTS eq_maintain (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  device    TEXT,
  kind      TEXT,              -- 保养/维修/巡检
  ts        TEXT,
  operator  TEXT,
  cost      REAL,
  next_due  TEXT,              -- 下次到期
  note      TEXT,
  rev       INTEGER
);

-- ---------- 财务（发票/税务/现金/分账） ----------

-- 发票
CREATE TABLE IF NOT EXISTS fin_invoices (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT,
  kind      TEXT,              -- 普票/专票/电子票
  direction TEXT,              -- 销项/进项
  amount    REAL,
  tax       REAL,
  ts        TEXT,
  status    TEXT DEFAULT '已开具',
  rev       INTEGER
);

-- 税务申报
CREATE TABLE IF NOT EXISTS fin_tax (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  period  TEXT,                -- 所属期（如 2026-09）
  kind    TEXT,                -- 增值税/所得税/附加
  amount  REAL,
  filed_at TEXT,
  status  TEXT DEFAULT '待申报',
  rev     INTEGER
);

-- 现金流水（备用金/找零金/存款）
CREATE TABLE IF NOT EXISTS fin_cash (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT,
  kind    TEXT,                -- 收入/支出/存款/备用金
  amount  REAL,
  account TEXT,
  note    TEXT,
  rev     INTEGER
);

-- 分账（合伙人/平台/房东分成）：
-- frozen_until 冻结期——分账金额在冻结期内不可划出（防纠纷红线）
CREATE TABLE IF NOT EXISTS fin_split (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  period       TEXT,
  party        TEXT,           -- 分账方
  amount       REAL,
  ratio        REAL,
  frozen_until TEXT,           -- 冻结截止日，期内禁止划出
  status       TEXT DEFAULT '待结算',
  rev          INTEGER
);

-- ---------- 供应商（档案/比价/往来账） ----------

-- 供应商档案
CREATE TABLE IF NOT EXISTS sup_vendors (
  vendor_id TEXT PRIMARY KEY,
  name      TEXT,
  contact   TEXT,
  phone     TEXT,
  category  TEXT,              -- 供应品类
  level     TEXT,              -- 评级
  status    TEXT DEFAULT '合作中',
  rev       INTEGER
);

-- 供应商报价历史（比价用；正式比价逻辑见 比价脚本/）
CREATE TABLE IF NOT EXISTS sup_prices (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id TEXT,
  ing_name  TEXT,
  price     REAL,
  unit      TEXT,
  quoted_at TEXT,
  rev       INTEGER
);

-- 供应商往来账（应付/已付/欠款）
CREATE TABLE IF NOT EXISTS sup_accounts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id TEXT,
  kind      TEXT,              -- 应付/付款/冲抵
  amount    REAL,
  ts        TEXT,
  ref_no    TEXT,              -- 关联单据号
  rev       INTEGER
);

-- ---------- 评价与改进 ----------

-- 顾客评价
CREATE TABLE IF NOT EXISTS rv_reviews (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  source   TEXT,               -- 堂食/美团/饿了么/大众点评
  rating   REAL,
  content  TEXT,
  ts       TEXT,
  handled  INTEGER DEFAULT 0,  -- 1=已处理
  rev      INTEGER
);

-- 改进闭环：一条评价可对应多条改进措施
CREATE TABLE IF NOT EXISTS rv_improve (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER,
  action    TEXT,
  owner     TEXT,
  due       TEXT,
  status    TEXT DEFAULT '进行中',
  rev       INTEGER
);

-- 好评话术库
CREATE TABLE IF NOT EXISTS rv_good_quotes (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  scene   TEXT,                -- 场景：催好评/回差评/感谢
  content TEXT,
  enabled INTEGER DEFAULT 1,
  rev     INTEGER
);

-- ---------- 损耗 ----------

-- 损耗上报
CREATE TABLE IF NOT EXISTS loss_reports (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  date     TEXT,
  ing_name TEXT,
  qty      REAL,
  reason   TEXT,               -- 过期/破损/操作失误/被盗
  reporter TEXT,
  status   TEXT DEFAULT '待审核',
  rev      INTEGER
);

-- 盘点差异：与 rebuildStock 重放结果对账，只记录不改库存
-- （红线：库存以 HTML 重放逻辑为准，本表仅做差异登记）
CREATE TABLE IF NOT EXISTS loss_inventory_diff (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  date      TEXT,
  ing_name  TEXT,
  book_qty  REAL,              -- 账面量
  actual_qty REAL,             -- 实盘量
  diff      REAL,
  note      TEXT,
  rev       INTEGER
);

-- ---------- 外卖 ----------

-- 外卖订单（平台侧镜像，结算对账用）
CREATE TABLE IF NOT EXISTS takeout_orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  platform    TEXT,            -- 美团/饿了么
  platform_no TEXT,            -- 平台单号
  ts          TEXT,
  amount      REAL,
  commission  REAL,            -- 平台佣金
  settle      REAL,            -- 应结算
  status      TEXT,
  rev         INTEGER
);

-- 外卖评价
CREATE TABLE IF NOT EXISTS takeout_reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  platform    TEXT,
  platform_no TEXT,
  rating      REAL,
  content     TEXT,
  ts          TEXT,
  handled     INTEGER DEFAULT 0,
  rev         INTEGER
);

-- 外卖平台结算对账
CREATE TABLE IF NOT EXISTS takeout_reconcile (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  platform    TEXT,
  period      TEXT,
  expect_amt  REAL,            -- 应结
  actual_amt  REAL,            -- 实结
  diff        REAL,
  status      TEXT DEFAULT '待核对',
  rev         INTEGER
);
