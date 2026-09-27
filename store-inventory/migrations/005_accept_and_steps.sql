-- =============================================================
-- 005 · 工单逐步打卡 + 食材按标准验收
-- 红线：只 ADD COLUMN / CREATE TABLE IF NOT EXISTS，幂等可重复执行。
-- =============================================================

-- 工单：逐步打卡状态 JSON {"1":{"done_at":"...","operator":"..."}}
ALTER TABLE sop_workorders ADD COLUMN steps_state TEXT;
-- 工单：实际出成（份），完成时录入
ALTER TABLE sop_workorders ADD COLUMN actual_yield REAL;

-- 验收标准库（可被快照推送；BFF 也有 JSON 种子兜底）
CREATE TABLE IF NOT EXISTS accept_standards (
  ing_name        TEXT PRIMARY KEY,
  brand           TEXT,
  spec_req        TEXT,
  sensory         TEXT,
  weight_tol_pct  REAL,
  temp_req        TEXT,
  shelf_life_req  TEXT,
  cert_req        TEXT
);

-- 逐项验收记录（recv.accept 动作写入）
CREATE TABLE IF NOT EXISTS recv_accept (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  recv_id       TEXT,
  ing_name      TEXT,
  qty_ordered   REAL,
  qty_received  REAL,
  qty_rejected  REAL,
  verdict       TEXT,          -- pass / warn / fail 或 合格/让步/拒收
  detail        TEXT,          -- JSON
  batch_no      TEXT,
  cert_no       TEXT,
  ts            TEXT,
  source        TEXT DEFAULT 'manual'
);
