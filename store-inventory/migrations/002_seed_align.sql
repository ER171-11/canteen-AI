-- =============================================================
-- 熊猫五福餐厅进销存系统 · 增量迁移 002（种子字段对齐）
-- 用途：为 Sprint 2 原型种子数据补充缺失列（仅增不改，ADD COLUMN）。
-- 红线：不修改/删除任何既有列与表；docs/snapshots 核心表零触碰。
-- 幂等说明：sqlite 不支持 ADD COLUMN IF NOT EXISTS，
--   由 seed_modules.py 逐条解析本文件并在列缺失时才执行（PRAGMA 检查），
--   因此重复执行安全。手工执行第二遍会报 duplicate column，属预期。
-- =============================================================

-- 打卡：准点/迟到/待打卡 状态 + 来源标记
ALTER TABLE staff_clock   ADD COLUMN status TEXT;
ALTER TABLE staff_clock   ADD COLUMN source TEXT;

-- 绩效：工时（小时）+ 来源标记
ALTER TABLE staff_perf    ADD COLUMN hours  REAL;
ALTER TABLE staff_perf    ADD COLUMN source TEXT;

-- 溯源：检验结果 + 来源标记
ALTER TABLE fs_trace      ADD COLUMN check_result TEXT;
ALTER TABLE fs_trace      ADD COLUMN source TEXT;

-- 消毒：执行结果（已完成/待执行）+ 来源标记
ALTER TABLE fs_disinfect  ADD COLUMN result TEXT;
ALTER TABLE fs_disinfect  ADD COLUMN source TEXT;

-- 其余 6 表：仅加来源标记（字段已够用）
ALTER TABLE staff_shifts  ADD COLUMN source TEXT;
ALTER TABLE staff_train   ADD COLUMN source TEXT;
ALTER TABLE fs_certs      ADD COLUMN source TEXT;
ALTER TABLE fs_samples    ADD COLUMN source TEXT;
ALTER TABLE bookings      ADD COLUMN source TEXT;
ALTER TABLE queue         ADD COLUMN source TEXT;
