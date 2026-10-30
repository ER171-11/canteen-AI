'use strict';
/*
 * lib/store-adapter/pg.js — 腾讯云 PostgreSQL 适配器（ADR-010 Phase 1，当前占位）
 *
 * 状态：**UNVERIFIED / 未接入**。Phase 0 不依赖它，故意不实现，避免：
 *   1) 在没云权限时凭空写一堆跑不了的代码；
 *   2) 给零依赖 BFF 引入 `pg` 依赖、破坏桌面端打包（desktop/app/bff 不带 node_modules）。
 *
 * Phase 1 落地步骤（拿到腾讯云权限后）：
 *   1) 选型：TencentDB for PostgreSQL，或 TDSQL-C PostgreSQL（Serverless，按量）。
 *   2) 依赖：在「云端部署包」而非桌面 BFF 中 `npm i pg`；本项目 BFF 仍保持零依赖。
 *   3) 建立表（与 sqlite 适配器对齐）：
 *        CREATE TABLE snapshots (
 *          store_id TEXT PRIMARY KEY,
 *          rev      BIGINT NOT NULL DEFAULT 0,
 *          data     JSONB  NOT NULL,
 *          ext      JSONB,
 *          meta     JSONB,
 *          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
 *        );
 *        CREATE TABLE action_queue (
 *          id TEXT PRIMARY KEY, status TEXT, created_at TIMESTAMPTZ, data JSONB
 *        );
 *        CREATE TABLE audit (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ, data JSONB);
 *   4) 乐观锁（红线 #4）：
 *        UPDATE snapshots SET rev = rev + 1, data = $1, ext = $2, meta = $3, updated_at = now()
 *         WHERE store_id = $4 AND rev = $5;   -- rowCount = 0 → 409
 *   5) 原子认领（多 worker）：
 *        UPDATE action_queue SET status = '执行中', data = jsonb_set(...)
 *         WHERE id IN (
 *           SELECT id FROM action_queue WHERE status = '待执行'
 *            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1
 *         ) RETURNING data;
 *   6) 补齐契约测试（lib/store-adapter/contract.test.js）对真库跑通，再标 VERIFIED。
 *
 * 注意：接口在 Phase 0 是同步的，PG 客户端是异步的。Phase 1 需把
 *   StoreAdapter 改为 async，并同步调整 lib/storage 调用方（届时本就是改云路径）。
 */
function create() {
  throw new Error('PG 适配器尚未接入（ADR-010 Phase 1 · UNVERIFIED）。'
    + '需先拿到腾讯云数据库权限、在云端部署包安装 pg，并让契约测试对真库跑通后再启用。');
}

module.exports = { create };
