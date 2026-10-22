-- 员工花名册（主数据）——「人员」模块「添加员工」功能的落点
-- 与 staff_shifts / staff_clock / staff_perf / staff_train 分离：
--   花名册是员工主数据，排班/打卡/绩效/培训是行为记录，以 staff_id 关联。
-- 新增员工（staff.upsert）写本表；排班矩阵/花名册聚合优先读本表主数据。

CREATE TABLE IF NOT EXISTS staff (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id   TEXT UNIQUE,        -- 工号（如 ST01；未给时由 staff.upsert 自动生成 ST 前缀唯一号）
  staff_name TEXT NOT NULL,      -- 姓名
  role       TEXT,               -- 岗位（厨师/厨师长/店长/收银等）
  phone      TEXT,               -- 联系电话
  hire_date  TEXT,               -- 入职日期（YYYY-MM-DD）
  status     TEXT DEFAULT '在岗', -- 在岗/离职（离职留痕，不物理删除）
  remark     TEXT,
  source     TEXT,               -- 录入来源（admin.staff / queue）
  rev        INTEGER
);
