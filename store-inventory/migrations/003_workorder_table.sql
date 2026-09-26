-- =============================================================
-- 003：工单挂桌号（传菜对桌）
-- 红线：只 ADD COLUMN，不改既有列/表结构语义。
-- 幂等：重复执行 duplicate column 由 ensure_tables 吞掉。
-- =============================================================

ALTER TABLE sop_workorders ADD COLUMN table_id TEXT;
ALTER TABLE sop_workorders ADD COLUMN table_no TEXT;
