-- =============================================================
-- 熊猫五福餐厅进销存系统 · 增量迁移 003（品控拍照识别 / 水印追溯）
-- 用途：为 A 块「AI 品控识别」补充落库结构。
--   1) qc_records 扩展：缺陷项 / 工序环节 / 责任人 / 照片引用 / 判定依据
--   2) qc_force_pass：不合格工单强制放行留痕（原因 + 操作人 + 时刻）
-- 红线：不修改/删除任何既有列与表；图片本体不入库，
--   仅存对象存储引用 URL 与对象键（照片落在 OSS/S3/MinIO，服务器不落盘）。
-- 幂等说明：sqlite 不支持 ADD COLUMN IF NOT EXISTS，重复执行会报 duplicate column；
--   bff/store-node/consumer.js 的 ensureTables() 逐文件捕获并忽略该错误（属预期，
--   与 002_seed_align.sql 同一约定）。全新库由 PRAGMA 前检查后的调用方保证只执行一次。
-- =============================================================

-- 质检记录：缺陷项与识别依据
ALTER TABLE qc_records ADD COLUMN defect_items  TEXT;             -- JSON 数组：裂纹/开口/花纹不符/褶纹/色泽/形态/重量偏差…
ALTER TABLE qc_records ADD COLUMN stage         TEXT;             -- 所属工序环节
ALTER TABLE qc_records ADD COLUMN operator      TEXT;             -- 责任人
ALTER TABLE qc_records ADD COLUMN photo_url     TEXT;             -- 对象存储引用（图片本体不入库）
ALTER TABLE qc_records ADD COLUMN photo_key     TEXT;             -- 对象存储对象键，便于按需重新签发访问 URL
ALTER TABLE qc_records ADD COLUMN conf          REAL;             -- 识别置信度 0-100
ALTER TABLE qc_records ADD COLUMN manual_review INTEGER DEFAULT 0; -- 1=置信度不足，须人工复核
ALTER TABLE qc_records ADD COLUMN station       TEXT;             -- 门店点位/工位
ALTER TABLE qc_records ADD COLUMN store_id      TEXT;             -- 门店标识

-- 强制放行留痕：不合格工单被厨师长放行时必须填写原因，留痕操作人与时刻
CREATE TABLE IF NOT EXISTS qc_force_pass (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workorder_id INTEGER,
  reason       TEXT,
  operator     TEXT,
  ts           TEXT,
  source       TEXT DEFAULT 'manual'
);
