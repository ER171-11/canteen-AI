'use strict';
/*
 * store-node/pusher.js — 整库快照推送器（逐行移植 store-inventory/snapshot_pusher.py）
 *
 * 流程：
 *   1. GET 店内服务 /api/db 取 {rev, data}
 *   2. buildExt 从本地 SQLite 新表组装 ext（JSON TEXT 列解析回对象/数组；
 *      表不存在/为空 → 对应 key 为空数组，不报错）
 *   3. 体积超过阈值 → 告警跳过；rev + ext 行数未变 → 跳过
 *   4. POST 云端 BFF /api/snapshot/push {rev, data, ext, machine}
 *   5. 成功后原子写状态 data/pusher_state.json {last_rev, last_ts, last_ext}
 *
 * 红线：只读店内服务（GET）与本地新表（SELECT），绝不写回；不碰 docs/snapshots 主数据。
 *
 * 命令行：
 *   --store-url  店内服务地址（默认 http://127.0.0.1:8765）
 *   --bff-url    云端 BFF 地址（默认 http://127.0.0.1:8787）
 *   --interval   循环间隔秒数（默认 60）
 *   --once       只执行一次后退出
 *   --max-bytes  快照体积上限（默认 5*1024*1024，含 ext）
 *   --token      BFF Bearer token（也可用环境变量 BFF_TOKEN）
 *   --db         本地 sqlite 路径（默认 store-inventory/data/餐厅系统.db）
 *
 * 仅使用 Node 内置模块（node:sqlite / http / fs ...）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const { nowIso, sleep, httpJson, withRetry } = require('./common');

const DEFAULT_STORE_URL = 'http://127.0.0.1:8765';
const DEFAULT_BFF_URL = 'http://127.0.0.1:8787';
const DEFAULT_INTERVAL = 60;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5MB

const BASE_DIR = __dirname;
const STATE_PATH = path.join(BASE_DIR, 'data', 'pusher_state.json');
// 店内库默认位置：bff/store-node → ../../store-inventory/data/餐厅系统.db
const DEFAULT_DB_PATH = process.env.STORE_DB
  || path.join(BASE_DIR, '..', '..', 'store-inventory', 'data', '餐厅系统.db');

/* ext 契约：表名 → 需要把 JSON TEXT 解析回对象/数组的列（逐字保留 Python 版 46-92 行） */
const EXT_TABLES = {
  recipes: ['main', 'aux', 'seasoning', 'steps', 'params', 'diet_tags'],
  sop_steps: ['tools', 'inputs', 'params'],
  sop_workorders: ['qc_records', 'steps_state'],
  qc_records: [],
  accept_standards: [],
  recv_accept: ['detail'],
  // Sprint 2 新增 10 模块（行直接序列化，无 JSON TEXT 列）
  staff_shifts: [],
  staff_clock: [],
  staff_perf: [],
  staff_train: [],
  fs_certs: [],
  fs_trace: [],
  fs_samples: [],
  fs_disinfect: [],
  bookings: [],
  queue: [],
  queue_serves: [],
  // 主数据补齐：会员/外卖/口碑/设备/财务/桌台
  vip_members: [],
  vip_balance: [],
  vip_coupons: [],
  vip_visits: [],
  takeout_orders: [],
  takeout_reviews: [],
  takeout_reconcile: [],
  rv_reviews: [],
  rv_improve: [],
  eq_maintain: [],
  eq_energy: [],
  eq_temp: [],
  fin_invoices: [],
  fin_tax: [],
  fin_cash: [],
  fin_split: [],
  pos_tables: [],
  loss_reports: [],
  sup_vendors: [],
  sup_prices: [],
  sup_accounts: []
};

function makeLog(name) {
  const prefix = '[' + name + ']';
  const fmt = (level, args) => [prefix, '[' + level + ']'].concat(Array.prototype.slice.call(args)).join(' ');
  return {
    info: (...a) => console.log(fmt('INFO', a)),
    warn: (...a) => console.warn(fmt('WARN', a)),
    warning: (...a) => console.warn(fmt('WARN', a)),
    error: (...a) => console.error(fmt('ERROR', a))
  };
}
const log = makeLog('snapshot_pusher');

/** 空 ext（全部表 → 空数组 + 计数 0） */
function emptyExt() {
  const ext = {};
  const counts = {};
  for (const t of Object.keys(EXT_TABLES)) { ext[t] = []; counts[t] = 0; }
  return { ext, counts };
}

/**
 * 从本地 sqlite 新表组装 ext（红线：只 SELECT 新表，绝不碰 docs/snapshots）。
 * 表不存在/为空 → 对应 key 为空数组，不报错。
 * @returns {{ext:Object, counts:Object}}
 */
function buildExt(dbPath) {
  if (!fs.existsSync(dbPath)) {
    log.warn('本地库不存在: ' + dbPath + '，ext 全部置空数组');
    return emptyExt();
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    log.warn('本地库打不开: ' + dbPath + '（' + e.message + '），ext 全部置空数组');
    return emptyExt();
  }
  const ext = {};
  const counts = {};
  try {
    for (const table of Object.keys(EXT_TABLES)) {
      const jsonCols = EXT_TABLES[table];
      try {
        const rows = db.prepare('SELECT * FROM "' + table + '"').all();
        const out = [];
        for (const row of rows) {
          const r = Object.assign({}, row);
          for (const c of jsonCols) {
            const v = r[c];
            if (typeof v === 'string' && v) {
              try { r[c] = JSON.parse(v); } catch (e) { /* 非 JSON 文本原样保留 */ }
            }
          }
          out.push(r);
        }
        ext[table] = out;
        counts[table] = out.length;
      } catch (e) {
        // 表不存在/不可读 → 空数组，不报错
        ext[table] = [];
        counts[table] = 0;
      }
    }
  } finally {
    try { db.close(); } catch (e) { /* ignore */ }
  }
  return { ext, counts };
}

/** 读状态文件；异常 → {} */
function loadState(statePath) {
  const p = statePath || STATE_PATH;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return {};
  }
}

/** 原子写状态文件（tmp + rename），返回写入对象 */
function saveState(rev, extCounts, statePath) {
  const p = statePath || STATE_PATH;
  const state = { last_rev: rev, last_ts: nowIso(), last_ext: extCounts };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return state;
}

/** 计数对象比较（键序固定，JSON 字符串相等即可对齐 Python dict 比较） */
function sameCounts(a, b) {
  return JSON.stringify(a || {}) === JSON.stringify(b || {});
}

/**
 * 单次推送。
 * @returns {Promise<boolean>} true=已推送/无需推送；false=跳过/失败（异常已吞并记日志）
 */
async function pushOnce(storeUrl, bffUrl, maxBytes, token, dbPath, opts) {
  const o = opts || {};
  const statePath = o.statePath || STATE_PATH;
  const retryOpts = {
    retries: o.retries || 3,
    baseDelayMs: o.baseDelayMs || 2000,
    sleep: o.sleep || sleep,
    log: o.log || log
  };
  const hostname = o.hostname || os.hostname();
  const maxB = (maxBytes === undefined || maxBytes === null) ? DEFAULT_MAX_BYTES : maxBytes;
  const db = dbPath || DEFAULT_DB_PATH;

  /* 1. GET 店内 /api/db（网络/5xx 指数退避重试） */
  let got;
  try {
    got = await withRetry(async () => {
      const r = await httpJson('GET', storeUrl.replace(/\/+$/, '') + '/api/db');
      if (r.status >= 500) {
        const e = new Error('http ' + r.status);
        e.status = r.status;
        throw e;
      }
      return r;
    }, 'GET /api/db', retryOpts);
  } catch (e) {
    log.error('店内服务不可达，本次跳过: ' + (e && e.message));
    return false;
  }

  const doc = (got && got.body) || {};
  if (!doc.ok) {
    log.error('/api/db 返回异常: ' + JSON.stringify(doc));
    return false;
  }
  const rev = doc.rev;
  const data = doc.data;
  if (data === null || data === undefined) {
    log.warn('店内库为空（rev=' + rev + '），跳过推送');
    return false;
  }

  /* 2. 组装 ext */
  const built = buildExt(db);
  const ext = built.ext;
  const extCounts = built.counts;

  /* 3. rev + ext 行数未变 → 跳过 */
  const state = loadState(statePath);
  if (state.last_rev === rev && sameCounts(state.last_ext, extCounts)) {
    log.info('rev=' + rev + ' 且 ext 行数未变，跳过');
    return true;
  }

  /* 4. 体积检查 */
  const size = Buffer.byteLength(JSON.stringify({ data: data, ext: ext }), 'utf8');
  if (size > maxB) {
    log.warn('快照体积 ' + size + ' 字节超过阈值 ' + maxB + ' 字节，本次跳过（可用 --max-bytes 调整）');
    return false;
  }

  /* 5. POST BFF */
  const payload = { rev: rev, data: data, ext: ext, machine: hostname };
  let post;
  try {
    post = await withRetry(async () => {
      const r = await httpJson('POST', bffUrl.replace(/\/+$/, '') + '/api/snapshot/push', payload, token);
      if (r.status >= 500) {
        const e = new Error('http ' + r.status);
        e.status = r.status;
        throw e;
      }
      return r;
    }, 'POST /api/snapshot/push', retryOpts);
  } catch (e) {
    log.error('推送 BFF 失败（rev=' + rev + ', ' + size + ' 字节）: ' + (e && e.message));
    return false;
  }

  if (post.status >= 400 || (post.body && post.body.ok === false)) {
    log.error('BFF 拒绝推送: http=' + post.status + ' resp=' + JSON.stringify(post.body));
    return false;
  }

  const saved = saveState(rev, extCounts, statePath);
  const extDesc = Object.keys(extCounts).map((k) => k + ':' + extCounts[k]).join(',');
  log.info('推送成功 rev=' + rev + ' size=' + size + 'B machine=' + hostname
    + ' last_ts=' + saved.last_ts + ' ext=' + extDesc);
  return true;
}

function buildArgOptions() {
  return {
    'store-url': { type: 'string' },
    'bff-url': { type: 'string' },
    interval: { type: 'string' },
    once: { type: 'boolean' },
    'max-bytes': { type: 'string' },
    token: { type: 'string' },
    db: { type: 'string' },
    help: { type: 'boolean' }
  };
}

function main(argv) {
  let values;
  try {
    values = parseArgs({ args: argv || process.argv.slice(2), options: buildArgOptions(), allowPositionals: true }).values;
  } catch (e) {
    console.error('参数解析失败: ' + e.message);
    return 2;
  }
  if (values.help) {
    console.log('用法: node pusher.js [--store-url URL] [--bff-url URL] [--interval 秒] [--once]'
      + ' [--max-bytes N] [--token TOKEN] [--db PATH]');
    return 0;
  }
  const storeUrl = values['store-url'] || DEFAULT_STORE_URL;
  const bffUrl = values['bff-url'] || DEFAULT_BFF_URL;
  const interval = values.interval !== undefined ? Number(values.interval) : DEFAULT_INTERVAL;
  const once = Boolean(values.once);
  const maxBytes = values['max-bytes'] !== undefined ? parseInt(values['max-bytes'], 10) : DEFAULT_MAX_BYTES;
  const token = values.token || process.env.BFF_TOKEN || '';
  const db = values.db || DEFAULT_DB_PATH;

  log.info('启动 store=' + storeUrl + ' bff=' + bffUrl + ' interval=' + interval
    + 's max_bytes=' + maxBytes + ' once=' + once + ' db=' + db);
  if (!token) log.warn('未配置 BFF token（--token 或 BFF_TOKEN），BFF 若开启鉴权将推送失败');

  if (once) {
    return pushOnce(storeUrl, bffUrl, maxBytes, token, db)
      .then((ok) => (ok ? 0 : 1));
  }

  const loop = async () => {
    for (;;) {
      try {
        await pushOnce(storeUrl, bffUrl, maxBytes, token, db);
      } catch (e) {
        log.error('本轮推送出现未捕获异常，继续循环: ' + (e && e.stack ? e.stack : e));
      }
      await sleep(interval * 1000);
    }
  };
  return loop();
}

module.exports = {
  EXT_TABLES,
  DEFAULT_STORE_URL,
  DEFAULT_BFF_URL,
  DEFAULT_INTERVAL,
  DEFAULT_MAX_BYTES,
  DEFAULT_DB_PATH,
  STATE_PATH,
  nowIso,
  buildExt,
  emptyExt,
  loadState,
  saveState,
  pushOnce,
  main
};

if (require.main === module) {
  Promise.resolve(main()).then((code) => { process.exitCode = code || 0; });
}
