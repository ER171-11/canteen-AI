'use strict';
/*
 * lib/env-guard.js — 运行环境与库路径一致性守卫
 *
 * 背景：测试系统功能时会往库里写测试单据。为不污染真实主库，引入「演练库」：
 *   主库   <repo>/store-inventory/data/餐厅系统.db
 *   演练库 <repo>/store-inventory/data/餐厅系统_演练.db
 * 但仅靠人工设置 STORE_DB 容易配错，于是做一次强校验：
 *
 *   CANTEEN_ENV=sandbox 且库路径 == 主库  → 抛错，拒绝启动（防测试写进真实库）
 *   CANTEEN_ENV=real    且库路径 == 演练库 → 告警，并按 sandbox 处理（演练库本就安全）
 *   CANTEEN_ENV=sandbox 且库路径非标准演练库 → 告警（自定义库，放行）
 *
 * 备份目录随之隔离：sandbox → data/backups_sandbox，real → data/backups，
 * 避免演练的冷备份混进真实库的备份历史。
 *
 * 零第三方依赖：node:path / process。
 */
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(REPO_ROOT, 'store-inventory', 'data');
const MAIN_DB = path.join(DATA_DIR, '餐厅系统.db');
const SANDBOX_DB = path.join(DATA_DIR, '餐厅系统_演练.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const SANDBOX_BACKUP_DIR = path.join(DATA_DIR, 'backups_sandbox');

/** 当前声明的环境名：sandbox / real（缺省 real） */
function envName() {
  const v = String(process.env.CANTEEN_ENV || '').trim().toLowerCase();
  return v === 'sandbox' ? 'sandbox' : 'real';
}

/** 路径等价比较（Windows 忽略大小写） */
function samePath(a, b) {
  if (!a || !b) return false;
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32'
    ? na.toLowerCase() === nb.toLowerCase()
    : na === nb;
}

/**
 * 描述库路径所属环境。
 * 返回 {env, dbPath, isMain, isSandbox, backupDir}
 */
function describe(dbPath) {
  const p = path.resolve(dbPath || MAIN_DB);
  const isMain = samePath(p, MAIN_DB);
  const isSandbox = samePath(p, SANDBOX_DB);
  return {
    env: envName(),
    dbPath: p,
    isMain,
    isSandbox,
    backupDir: isSandbox ? SANDBOX_BACKUP_DIR : BACKUP_DIR,
  };
}

/**
 * 校验并归一化。抛出即表示「当前配置有写到真实库的风险」，调用方应终止启动。
 * @param {string} dbPath 实际库路径
 * @param {{warn:Function}} [log] 日志器（缺省 console）
 */
function assertEnvSafe(dbPath, log) {
  const w = log || console;
  const info = describe(dbPath);

  if (info.env === 'sandbox' && info.isMain) {
    const msg = '[env-guard] 拒绝启动：CANTEEN_ENV=sandbox 但库路径指向真实主库\n'
      + '  db  : ' + info.dbPath + '\n'
      + '  修正：STORE_DB=' + SANDBOX_DB + '\n'
      + '        或先执行 node scripts/sandbox-db.js --init';
    throw new Error(msg);
  }

  if (info.env === 'sandbox' && !info.isSandbox) {
    w.warn('[env-guard] sandbox 声明但库路径不是标准演练库（按自定义库放行）：' + info.dbPath);
  }

  if (info.env === 'real' && info.isSandbox) {
    w.warn('[env-guard] CANTEEN_ENV=real 但库路径是演练库，已按 sandbox 处理：' + info.dbPath);
    info.env = 'sandbox';
    info.backupDir = SANDBOX_BACKUP_DIR;
  }

  return info;
}

module.exports = {
  REPO_ROOT,
  DATA_DIR,
  MAIN_DB,
  SANDBOX_DB,
  BACKUP_DIR,
  SANDBOX_BACKUP_DIR,
  envName,
  samePath,
  describe,
  assertEnvSafe,
};
