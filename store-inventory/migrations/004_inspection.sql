-- =============================================================
-- 熊猫五福餐厅进销存系统 · 增量迁移 004（闭店巡检 / 水印追溯）
-- 用途：为 C / D 块「巡检节点拍照验证 + 水印相机追溯」补充落库结构。
--   1) inspection_records     巡检记录：只存状态与元数据
--   2) inspection_assignments 板块分工：后厨/前厅/仓库负责到人
-- 红线（用户已确认）：巡检照片**只存在手机本地**，服务器仅存
--   「节点 + 责任人 + 时刻 + 是否拍照」状态。因此本表**没有**任何图片列；
--   若上层误传 base64，算法层会丢弃并把 photo_local_only 置 1 以留痕。
-- 全部语句均为 CREATE ... IF NOT EXISTS，可重复执行（CI 有幂等检查）。
-- =============================================================

CREATE TABLE IF NOT EXISTS inspection_records (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  date             TEXT,            -- 巡检归属日 YYYY-MM-DD
  node_id          TEXT,            -- 标准节点 id（见 bff/lib/inspection_nodes.js）
  node_name        TEXT,            -- 节点名快照，避免主数据调整后历史失真
  board            TEXT,            -- 板块：后厨 / 前厅 / 仓库
  node_group       TEXT,            -- 节点分组：门窗/煤气/冰箱柜门/电源开关/水龙头/卫生间…
  every30          INTEGER DEFAULT 0, -- 1=卫生间类，需每 30 分钟一次
  round            INTEGER,         -- 30 分钟轮次序号（非每 30 分钟节点为空）
  photo_taken      INTEGER DEFAULT 0, -- 1=本次已拍照（未拍照自动标记未完成）
  done             INTEGER DEFAULT 0, -- 1=完成（photo_taken 为 0 时恒为 0）
  photo_local_only INTEGER DEFAULT 0, -- 1=上层曾传入图片载荷，已被丢弃（照片只在手机本地）
  operator         TEXT,            -- 责任人
  store_id         TEXT,
  station          TEXT,            -- 水印点位：门店 + 点位名
  note             TEXT,
  ts               TEXT,
  source           TEXT DEFAULT 'app'
);

CREATE INDEX IF NOT EXISTS idx_inspection_records_date ON inspection_records(date);
CREATE INDEX IF NOT EXISTS idx_inspection_records_node ON inspection_records(node_id);

CREATE TABLE IF NOT EXISTS inspection_assignments (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  board    TEXT,                    -- 后厨 / 前厅 / 仓库
  operator TEXT,                    -- 板块负责人
  store_id TEXT,
  ts       TEXT,
  source   TEXT DEFAULT 'manual'
);
