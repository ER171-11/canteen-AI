-- =============================================================
-- 食安点位主数据（巡检点 / 消毒点 统一事实来源）
-- 用途：把「巡检统筹」与「消毒记录」的区域划分从后端硬编码/历史反推，
--       改为可维护的点位主数据；巡检看板与消毒达标率均以此计算。
-- kind: inspection | disinfect；enabled=0 为逻辑删除（保留历史台账引用）。
-- 演示图只存对象键与公开读地址引用，图片本体在对象存储，不落库（红线）。
-- 全部语句均为 CREATE ... IF NOT EXISTS，可重复执行（CI 有幂等检查）。
-- =============================================================

CREATE TABLE IF NOT EXISTS fs_points (
  id              TEXT PRIMARY KEY,    -- K01..K50 / D01..D05 / 自定义 U*
  name            TEXT NOT NULL,       -- 点位名
  zone            TEXT,                -- 巡检=板块(后厨/前厅/仓库)；消毒=区域分组
  kind            TEXT NOT NULL,       -- inspection | disinfect
  every30         INTEGER DEFAULT 0,   -- 1=需每 30 分钟记录（仅巡检卫生间类）
  demo_image_key  TEXT,               -- 规范演示图 OSS 对象键
  demo_image_url  TEXT,               -- 演示图公开读地址（OSS_PUBLIC_BASE 配置时）
  enabled         INTEGER DEFAULT 1,   -- 0=逻辑删除
  sort            INTEGER DEFAULT 0,   -- 排序权重（升序）
  note            TEXT,
  ts              TEXT                 -- 最近更新时刻 ISO
);

CREATE INDEX IF NOT EXISTS idx_fs_points_kind ON fs_points(kind);
CREATE INDEX IF NOT EXISTS idx_fs_points_enabled ON fs_points(enabled);
