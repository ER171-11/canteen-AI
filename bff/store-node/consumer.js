'use strict';
/*
 * store-node/consumer.js — 云端动作队列消费者（逐行移植 store-inventory/queue_consumer.py 的 IO 外壳）
 *
 * 业务算法已迁至 bff/lib/algorithms/，本文件只负责调度与 IO：
 *   1. GET BFF /api/actions?status=待执行（含 429/5xx 重试）
 *   2. 逐条：GET 店内 /api/db 取 baseRev 与 data → algorithms.run(type, ctx, data, payload)
 *      - ctx.store 为 node:sqlite 适配器（写 ext 新表），对齐 Python 各 insert_*
 *      - 未登记 type → 驳回（need-manual，不静默丢动作）
 *   3. POST 店内 /api/sync {baseRev, data, machine:"QUEUE"} 三向合并写回
 *   4. 回调 BFF /api/actions/{id}/execute（429/5xx 重试）
 *   5. 成功后立即推快照（老板刷新即见变化）
 *
 * 红线：只读/调用店内 server 公开 API，本地 sqlite 只写新增表（actions_queue 等），不触碰 docs/snapshots。
 *
 * 命令行：--store-url --bff-url --interval --once --token --db
 * 仅 Node 内置模块（node:sqlite / http / fs ...）。
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const { nowIso, sleep, httpJson, withRetry } = require('./common');

/* 触发全部算法登记 */
require('../lib/algorithms/registry');
const algorithms = require('../lib/algorithms/index');
const pusher = require('./pusher');
const provider = require('../lib/provider');
const envGuard = require('../lib/env-guard');

const DEFAULT_STORE_URL = 'http://127.0.0.1:8765';
const DEFAULT_BFF_URL = 'http://127.0.0.1:8787';
const DEFAULT_INTERVAL = 30;
const DEFAULT_DB_PATH = process.env.STORE_DB
  || path.join(__dirname, '..', '..', 'store-inventory', 'data', '餐厅系统.db');
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'store-inventory', 'migrations');

function makeLog(name) {
  const prefix = '[' + name + ']';
  const fmt = (level, args) => [prefix, '[' + level + ']']
    .concat(Array.prototype.slice.call(args)).join(' ');
  return {
    info: (...a) => console.log(fmt('INFO', a)),
    warn: (...a) => console.warn(fmt('WARN', a)),
    warning: (...a) => console.warn(fmt('WARN', a)),
    error: (...a) => console.error(fmt('ERROR', a))
  };
}
const log = makeLog('queue_consumer');

/* ------------------------------------------------------------------ */
/* SQLite 适配器（供算法 ctx.store 使用）                                */
/* ------------------------------------------------------------------ */

/** 值序列化：对象/数组 → JSON 文本（对齐 Python 的 json.dumps 列）；标量原样 */
function ser(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/** 判断 query 首个参数是原始 SQL 还是表名 */
function looksLikeSql(s) {
  return /[\s(]/.test(s) || /^(select|pragma|with|insert|update|delete)\b/i.test(String(s).trim());
}

/**
 * 打开 sqlite 并返回 ctx.store 适配器。
 * 契约（与算法层一致）：
 *   query(tableOrSql, params) → 行数组
 *   get(table, id) → 行或 null
 *   insert(table, row) → rowid 或 null（失败返回 null，供算法回落）
 *   upsert(table, row, keys) → {rowid, matched}
 *   update(table, sets, where) → {rowcount}
 *   remove(table, where) → {rowcount}（where 为空拒绝执行，防全表删）
 */
function makeSqliteStore(dbPath) {
  const db = new DatabaseSync(dbPath, { timeout: 15000 });

  function safeRun(sql, params) {
    try { return db.prepare(sql).run(...(params || [])); }
    catch (e) { return null; }
  }

  return {
    _db: db,
    close() { try { db.close(); } catch (e) { /* ignore */ } },

    query(tableOrSql, params) {
      const sql = looksLikeSql(tableOrSql)
        ? tableOrSql
        : 'SELECT * FROM "' + tableOrSql + '"';
      try { return db.prepare(sql).all(...(params || [])); }
      catch (e) { return []; }
    },

    /**
     * 按主键取行：新表主键并不统一（sup_vendors = vendor_id，多数表 = id）。
     * 写死 `WHERE id=?` 会让没有 id 列的表查询报错 → 被 catch 吞成 null → 误判「行不存在」。
     * 故先探测表列，再按 id / vendor_id / name 顺序选主键列。
     */
    get(table, id) {
      try {
        const cols = db.prepare('PRAGMA table_info("' + table + '")').all().map((c) => c.name);
        if (!cols.length) return null;
        let key = null;
        for (const k of ['id', 'vendor_id', 'name']) {
          if (cols.indexOf(k) >= 0) { key = k; break; }
        }
        if (!key) key = cols[0];
        const rows = db.prepare('SELECT * FROM "' + table + '" WHERE "' + key + '"=? LIMIT 1').all(id);
        return rows[0] || null;
      } catch (e) { return null; }
    },

    insert(table, row) {
      const cols = Object.keys(row || {});
      if (!cols.length) return null;
      const sql = 'INSERT INTO "' + table + '" ('
        + cols.map((c) => '"' + c + '"').join(',') + ') VALUES ('
        + cols.map(() => '?').join(',') + ')';
      const info = safeRun(sql, cols.map((c) => ser(row[c])));
      if (!info) return null;
      return Number(info.lastInsertRowid);
    },

    upsert(table, row, keys) {
      const ks = (Array.isArray(keys) && keys.length) ? keys : ['id'];
      const whereKeys = ks.filter((k) => row && row[k] !== undefined && row[k] !== null);
      let existing = null;
      if (whereKeys.length) {
        const whereSql = whereKeys.map((k) => '"' + k + '"=?').join(' AND ');
        try {
          /* 参数必须展开传（.all(array) 绑定失败 → 异常被吞 → existing=null → 每次编辑都 INSERT 撞主键） */
          existing = db.prepare('SELECT rowid AS _rid FROM "' + table + '" WHERE ' + whereSql + ' LIMIT 1')
            .all(...whereKeys.map((k) => ser(row[k])))[0] || null;
        } catch (e) { existing = null; }
      }
      if (existing) {
        const setCols = Object.keys(row).filter((c) => whereKeys.indexOf(c) < 0);
        if (setCols.length) {
          const sql = 'UPDATE "' + table + '" SET '
            + setCols.map((c) => '"' + c + '"=?').join(',')
            + ' WHERE ' + whereKeys.map((k) => '"' + k + '"=?').join(' AND ');
          safeRun(sql, setCols.map((c) => ser(row[c])).concat(whereKeys.map((k) => ser(row[k]))));
        }
        return { rowid: Number(existing._rid), matched: true };
      }
      const rid = this.insert(table, row);
      return { rowid: rid, matched: false };
    },

    /** DELETE：where 为空对象时拒绝执行（防全表删），返回 {rowcount} */
    remove(table, where) {
      const w = Object.assign({}, where || {});
      const wKeys = Object.keys(w).filter((k) => w[k] !== undefined && w[k] !== null);
      if (!wKeys.length) return { rowcount: 0 };
      const sql = 'DELETE FROM "' + table + '" WHERE ' + wKeys.map((k) => '"' + k + '"=?').join(' AND ');
      const info = safeRun(sql, wKeys.map((k) => ser(w[k])));
      return { rowcount: info ? Number(info.changes) : 0 };
    },

    update(table, sets, where) {
      const cols = Object.keys(sets || {});
      if (!cols.length) return { rowcount: 0 };
      const w = Object.assign({}, where || {});
      const op = w._op === 'OR' ? ' OR ' : ' AND ';
      delete w._op;
      // status_not_in: 数组 → "status" NOT IN (...)
      const notIn = Array.isArray(w.status_not_in) ? w.status_not_in : null;
      delete w.status_not_in;
      const wKeys = Object.keys(w);
      const parts = wKeys.map((k) => '"' + k + '"=?');
      const whereParams = wKeys.map((k) => ser(w[k]));
      if (notIn && notIn.length) {
        parts.push('"status" NOT IN (' + notIn.map(() => '?').join(',') + ')');
        for (const v of notIn) whereParams.push(ser(v));
      }
      const whereSql = parts.length ? ' WHERE ' + parts.join(op) : '';
      const sql = 'UPDATE "' + table + '" SET '
        + cols.map((c) => '"' + c + '"=?').join(',') + whereSql;
      const params = cols.map((c) => ser(sets[c])).concat(whereParams);
      const info = safeRun(sql, params);
      return { rowcount: info ? Number(info.changes) : 0 };
    }
  };
}

/** 建表：执行 migrations/*.sql（幂等），确保 ext 新表存在；失败不致命 */
function ensureTables(dbPath) {
  try {
    const db = new DatabaseSync(dbPath, { timeout: 15000 });
    let files = [];
    try { files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort(); }
    catch (e) { files = []; }
    for (const f of files) {
      try { db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')); }
      catch (e) { log.warn('迁移 ' + f + ' 执行失败（忽略）: ' + e.message); }
    }
    db.close();
    return true;
  } catch (e) {
    log.warn('建表检查失败（不影响主流程）: ' + e.message);
    return false;
  }
}

/** 登记动作处理结果到本地 actions_queue（供审计与人工确认） */
function recordAction(dbPath, action, status, rev, traceId) {
  try {
    const db = new DatabaseSync(dbPath, { timeout: 15000 });
    const payload = typeof action.payload === 'string'
      ? action.payload : JSON.stringify(action.payload || {});
    db.prepare(
      'INSERT INTO actions_queue(id,type,payload,status,rev,created_at,executed_at,operator,trace_id)'
      + ' VALUES(?,?,?,?,?,?,?,?,?)'
      + ' ON CONFLICT(id) DO UPDATE SET status=excluded.status, rev=excluded.rev,'
      + ' executed_at=excluded.executed_at'
    ).run(
      String(action.id), String(action.type || ''), payload, String(status),
      rev === undefined || rev === null ? null : Number(rev),
      action.created_at || nowIso(), nowIso(),
      action.operator || null, traceId || action.trace_id || null
    );
    db.close();
  } catch (e) {
    log.warn('recordAction 失败: ' + e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 动作处理                                                            */
/* ------------------------------------------------------------------ */

function descOf(result) {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && result.message) return String(result.message);
  return JSON.stringify(result);
}

/**
 * 处理一条动作，返回 {outcome, detail}。
 * outcome ∈ executed/failed/rejected/conflict（对齐 Python）。
 */
async function processAction(action, storeUrl, bffUrl, token, dbPath, opts) {
  const o = opts || {};
  const store = o.store || makeSqliteStore(dbPath);
  const closeStore = !o.store;
  const aid = action.id;
  const atype = action.type;
  let payload = action.payload || {};
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (e) { payload = {}; }
  }
  const traceId = action.trace_id || require('crypto').randomBytes(8).toString('hex');

  /* 前厅动作预留：美团承接模式下绝不写库（防御性兜底；confirm 已在 BFF 拦截，
     此处防止 provider 中途切换导致已进入待执行的动作落库） */
  if (action.front_house && provider.frontHouseProvider() !== 'self') {
    log.info('前厅动作 pending_provider，跳过写库 id=' + aid + ' type=' + atype + ' trace=' + traceId);
    await callback(undefined, 'pending_provider=' + provider.frontHouseProvider()
      + '，前厅动作暂不写库，置 FRONT_OF_HOUSE_PROVIDER=self 后启用');
    recordAction(dbPath, action, 'pending_provider', undefined, traceId);
    return { outcome: 'rejected', detail: 'pending_provider' };
  }

  const callback = async (result, error) => {
    const body = {};
    if (error !== undefined && error !== null) {
      body.result = { ok: false, error: String(error) };
      body.error = String(error);
    } else if (result !== undefined && result !== null) {
      let r = result;
      if (typeof r === 'object' && r.ok === undefined) r = Object.assign({}, r, { ok: true });
      body.result = r;
    }
    body.trace_id = traceId;
    let status = 0; let resp = {};
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const out = await httpJson('POST',
          bffUrl.replace(/\/+$/, '') + '/api/actions/' + aid + '/execute', body, token);
        status = out.status; resp = out.body;
      } catch (e) {
        status = 0; resp = { error: e.message };
      }
      if (status !== 429 && !(status >= 500)) break;
      await sleep(1000 * attempt);
    }
    return { status, resp };
  };

  try {
    /* 未登记 type → 驳回 */
    if (!algorithms.has(atype)) {
      log.warn('未知动作类型，驳回 id=' + aid + ' type=' + atype + ' trace=' + traceId);
      await callback(undefined, '未知动作类型: ' + atype + '（未在 BFF 算法层登记）');
      recordAction(dbPath, action, 'rejected', undefined, traceId);
      return { outcome: 'rejected', detail: atype };
    }

    /* 1) 取 baseRev 与当前 data */
    let got;
    try {
      got = await httpJson('GET', storeUrl.replace(/\/+$/, '') + '/api/db');
    } catch (e) {
      const err = '店内 /api/db 不可达: ' + e.message;
      await callback(undefined, err);
      recordAction(dbPath, action, 'failed', undefined, traceId);
      return { outcome: 'failed', detail: err };
    }
    const doc = (got && got.body) || {};
    if (got.status !== 200 || !doc.ok) {
      const err = '店内 /api/db 异常: http=' + got.status + ' ' + JSON.stringify(doc);
      await callback(undefined, err);
      recordAction(dbPath, action, 'failed', undefined, traceId);
      return { outcome: 'failed', detail: err };
    }
    // baseRev = 店内实时 rev（现取，非 confirm 阶段校验的云端快照 rev）。
    // 这才是落库乐观锁的基准：/api/sync 用它做三方合并，冲突时服务端胜出、本机新增不丢，
    // 保证 confirm 的「准入提示锁」放行后，落库仍不会被店内新变更盲覆盖。
    const baseRev = doc.rev;
    let data = doc.data;
    if (!data || typeof data !== 'object') data = {};

    /* 2) 应用算法 */
    let result;
    try {
      const ctx = { store: store, rev: baseRev, traceId: traceId, now: nowIso() };
      result = algorithms.run(atype, ctx, data, payload).result;
    } catch (e) {
      const err = '应用 payload 失败: ' + (e && e.message ? e.message : e);
      await callback(undefined, err);
      recordAction(dbPath, action, 'failed', undefined, traceId);
      return { outcome: 'failed', detail: err };
    }
    const desc = descOf(result);
    log.info('已应用: ' + desc + ' trace=' + traceId);

    /* 3) 三向合并写回 */
    let syncOut;
    try {
      syncOut = await httpJson('POST', storeUrl.replace(/\/+$/, '') + '/api/sync',
        { baseRev: baseRev, data: data, machine: 'QUEUE' });
    } catch (e) {
      syncOut = { status: 0, body: { error: e.message } };
    }
    const sbody = (syncOut && syncOut.body) || {};
    const ok = syncOut.status === 200 && sbody.ok && sbody.action !== 'need-manual';
    if (!ok) {
      const err = 'sync 冲突/异常: http=' + syncOut.status;
      log.warn('标记「需人工确认」id=' + aid + ' ' + err + ' trace=' + traceId);
      await callback(undefined, '需人工确认: ' + err);
      recordAction(dbPath, action, '需人工确认', baseRev, traceId);
      return { outcome: 'conflict', detail: err };
    }

    /* 4) 回调成功 */
    const newRev = sbody.rev;
    await callback({ new_rev: newRev, desc: desc }, undefined);
    recordAction(dbPath, action, 'done', newRev, traceId);
    log.info('执行成功 id=' + aid + ' new_rev=' + newRev + ' action=' + sbody.action + ' trace=' + traceId);

    /* 5) 立即推快照（老板刷新即见变化） */
    try {
      await pusher.pushOnce(storeUrl, bffUrl, pusher.DEFAULT_MAX_BYTES, token, dbPath);
    } catch (e) { /* 推送失败不影响本动作 */ }

    return { outcome: 'executed', detail: newRev };
  } finally {
    if (closeStore && store && typeof store.close === 'function') store.close();
  }
}

/** 从 BFF 拉取待执行动作（对齐 Python fetch_pending） */
async function fetchPending(bffUrl, token) {
  const url = bffUrl.replace(/\/+$/, '') + '/api/actions?status=' + encodeURIComponent('待执行');
  let out = { status: 0, body: {} };
  for (let attempt = 1; attempt <= 4; attempt++) {
    out = await httpJson('GET', url, undefined, token);
    if (out.status !== 429 && !(out.status >= 500)) break;
    await sleep(1000 * attempt);
  }
  if (out.status !== 200) {
    throw new Error('拉取动作失败: http=' + out.status + ' ' + JSON.stringify(out.body));
  }
  const b = out.body;
  if (Array.isArray(b)) return b;
  if (b && typeof b === 'object') {
    for (const k of ['items', 'actions', 'data']) {
      if (Array.isArray(b[k])) return b[k];
    }
  }
  return [];
}

/** 登录换取新 token（401 自动续期用） */
async function loginToken(bffUrl, account, password) {
  const url = bffUrl.replace(/\/+$/, '') + '/api/auth/login';
  const out = await httpJson('POST', url, {
    account: account,
    password: password,
    device_fp: 'store-consumer'
  }, '');
  const body = out && out.body;
  if (out.status === 200 && body && body.ok && body.token) return body.token;
  throw new Error('登录失败: http=' + (out && out.status) + ' ' + JSON.stringify(body));
}

/** 一轮消费；返回 bool（BFF 是否可达）。401 会抛出以便上层续期 token。 */
async function runOnce(storeUrl, bffUrl, token, dbPath, opts) {
  const o = opts || {};
  let actions;
  try {
    actions = await fetchPending(bffUrl, token);
  } catch (e) {
    const msg = String(e && e.message || '');
    if (/http=401/.test(msg)) throw e; // token 失效：交给 main 续期
    log.error('BFF 不可达，本轮跳过: ' + msg);
    return false;
  }
  log.info('拉到待执行动作 ' + actions.length + ' 条');
  const store = o.store || makeSqliteStore(dbPath);
  try {
    for (const action of actions) {
      try {
        const r = await processAction(action, storeUrl, bffUrl, token, dbPath,
          { store: store, now: o.now });
        log.info('动作 id=' + action.id + ' 结果=' + r.outcome + ' detail=' + r.detail);
      } catch (e) {
        log.error('动作 id=' + action.id + ' 处理出现未捕获异常: ' + (e && e.stack ? e.stack : e));
      }
    }
  } finally {
    if (!o.store && store && typeof store.close === 'function') store.close();
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 命令行                                                              */
/* ------------------------------------------------------------------ */

function buildArgOptions() {
  return {
    'store-url': { type: 'string' },
    'bff-url': { type: 'string' },
    interval: { type: 'string' },
    once: { type: 'boolean' },
    token: { type: 'string' },
    account: { type: 'string' },
    password: { type: 'string' },
    db: { type: 'string' },
    help: { type: 'boolean' }
  };
}

async function main(argv) {
  let values;
  try {
    values = parseArgs({ args: argv || process.argv.slice(2), options: buildArgOptions(), allowPositionals: true }).values;
  } catch (e) {
    console.error('参数解析失败: ' + e.message);
    return 2;
  }
  if (values.help) {
    console.log('用法: node consumer.js [--store-url URL] [--bff-url URL] [--interval 秒]'
      + ' [--once] [--token TOKEN] [--account 账号] [--password 密码] [--db PATH]');
    return 0;
  }
  const storeUrl = values['store-url'] || DEFAULT_STORE_URL;
  const bffUrl = values['bff-url'] || DEFAULT_BFF_URL;
  const interval = values.interval !== undefined ? Number(values.interval) : DEFAULT_INTERVAL;
  const once = Boolean(values.once);
  let token = values.token || process.env.BFF_TOKEN || '';
  const account = values.account || process.env.BFF_ACCOUNT || 'boss';
  const password = values.password || process.env.BFF_PASSWORD || process.env.BFF_DEFAULT_PASSWORD || 'wufu123';
  /* 环境守卫：声明 sandbox 却指向真实主库时直接退出，避免测试数据写进真实库 */
  let envInfo;
  try {
    envInfo = envGuard.assertEnvSafe(values.db || DEFAULT_DB_PATH, log);
  } catch (e) {
    log.error(e.message);
    return 1;
  }
  const dbPath = envInfo.dbPath;

  log.info('启动 env=' + envInfo.env + ' store=' + storeUrl + ' bff=' + bffUrl + ' interval=' + interval
    + 's once=' + once + ' db=' + dbPath + ' account=' + account);
  if (envInfo.env === 'sandbox') {
    log.info('演练模式：写入 ' + dbPath + '（真实主库不受影响）');
  }
  if (!token) {
    log.warn('未提供 BFF token，尝试用账号登录: ' + account);
    try { token = await loginToken(bffUrl, account, password); log.info('已登录获取 token'); }
    catch (e) { log.warn('登录失败（将以无鉴权运行）: ' + e.message); }
  }

  ensureTables(dbPath);

  if (once) {
    const ok = await runOnce(storeUrl, bffUrl, token, dbPath);
    return ok ? 0 : 1;
  }
  for (;;) {
    try {
      await runOnce(storeUrl, bffUrl, token, dbPath);
    } catch (e) {
      const msg = String(e && e.message || '');
      if (/http=401/.test(msg)) {
        try {
          token = await loginToken(bffUrl, account, password);
          log.info('token 已自动续期');
        } catch (le) {
          log.error('token 续期失败: ' + le.message);
        }
      } else {
        log.error('本轮消费出现未捕获异常，继续循环: ' + (e && e.stack ? e.stack : e));
      }
    }
    await sleep(interval * 1000);
  }
}

module.exports = {
  DEFAULT_STORE_URL,
  DEFAULT_BFF_URL,
  DEFAULT_INTERVAL,
  DEFAULT_DB_PATH,
  makeSqliteStore,
  ensureTables,
  recordAction,
  descOf,
  processAction,
  fetchPending,
  loginToken,
  runOnce,
  main
};

if (require.main === module) {
  Promise.resolve(main()).then((code) => { process.exitCode = code || 0; });
}
