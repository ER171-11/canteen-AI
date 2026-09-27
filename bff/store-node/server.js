'use strict';
/*
 * server.js — 本地数据库服务的 Node 移植，逐行对照
 * store-inventory/server/app.py。
 *
 * 零第三方依赖（只用 Node 内置 http / fs / path / child_process / url）。
 *
 * API
 *   GET  /api/health         服务与数据库状态
 *   GET  /api/rev            仅取版本号（轻量心跳，判断是否需要合并）
 *   GET  /api/db             取整库 {rev, data}
 *   PUT  /api/db             {rev, data, machine} 整库写入（rev 不匹配返回 409）
 *   POST /api/sync           {baseRev, data, machine} 三向合并后写入
 *   GET  /api/snapshots      快照列表（可用于回滚）
 *   POST /api/snapshot       手动打快照
 *   POST /api/rollback       {rev} 回滚到指定快照
 *   GET  /                   静态页面（可选；默认可关，旧 HTML 已退役）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { Store, Conflict, nowIso } = require('./db');
const mergeMod = require('./merge');

const BASE_DIR = __dirname;                                        // bff/store-node/
const STORE_DIR = path.resolve(BASE_DIR, '..', '..', 'store-inventory'); // 旧 Python 项目根
const CONFIG_PATH = path.join(STORE_DIR, 'server', 'config.json'); // 旧配置
const LOCAL_CONFIG_PATH = path.join(BASE_DIR, 'config.json');      // store-node 自己的覆盖配置

// 与 app.py 的 DEFAULT_CONFIG 对齐，但静态服务默认关闭（旧 HTML 已退役）
const DEFAULT_CONFIG = {
  port: 8765,
  host: '127.0.0.1',
  db_path: 'data/餐厅系统.db',
  backup_dir: 'data/backups',
  machine_id: 'SHOP',
  snapshot_keep_days: 30,
  snapshot_keep_count: 200,
  serve_static: false,
  static_root: '.',
  index_file: '熊猫五福餐厅进销存系统_真实数据版.html',
  open_browser: false,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel', '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
};

function loadJsonFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      console.log('[warn] 读取 ' + p + ' 失败，忽略: ' + e.message);
    }
    return null;
  }
}

// 对应 app.py 的 load_config()
function loadConfig() {
  const cfg = Object.assign({}, DEFAULT_CONFIG);
  const legacy = loadJsonFile(CONFIG_PATH);
  if (legacy) Object.assign(cfg, legacy);
  const local = loadJsonFile(LOCAL_CONFIG_PATH);
  if (local) {
    Object.assign(cfg, local);
  } else {
    // 旧配置里的 serve_static 属于已退役 HTML，除非本目录显式覆盖，否则关闭
    cfg.serve_static = DEFAULT_CONFIG.serve_static;
  }
  return cfg;
}

// 对应 app.py 的 abspath()：相对路径以旧项目根 store-inventory/ 为基准
function abspath(p) {
  return path.isAbsolute(p) ? p : path.resolve(STORE_DIR, p);
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// ---------- 请求处理 ----------

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let length = 0;
    req.on('data', (c) => { chunks.push(c); length += c.length; });
    req.on('end', () => {
      if (!length) return resolve({});
      try {
        return resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        return resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  cors(res);
  res.end(body);
}

function sendEmpty(res, code) {
  res.statusCode = code;
  cors(res);
  res.end();
}

function makeHandler(store, cfg, staticRoot) {
  function health() {
    const cur = store.get();
    const data = cur.data;
    const stat = data ? {
      ings: (data.ings || []).length,
      dishes: (data.dishes || []).length,
      pos: (data.pos || []).length,
      sales: (data.sales || []).length,
    } : {};
    return {
      ok: true,
      service: 'panda-inv-db',
      machine: cfg.machine_id,
      db_path: store.db_path,
      db_size: store.size(),
      rev: cur.rev,
      empty: cur.empty,
      updated_at: cur.updated_at,
      counts: stat,
      time: nowIso(),
    };
  }

  // 三向合并同步：baseRev 快照 vs 本机 data vs 服务端当前
  function sync(payload) {
    const data = payload.data;
    if (data === null || data === undefined) {
      return [{ ok: false, error: 'missing data' }, 400];
    }
    const machine = payload.machine || cfg.machine_id;
    const baseRev = toInt(payload.baseRev);

    const cur = store.get();
    if (cur.empty) {
      const res = store.put(0, data, machine, 'initial-from-client');
      return [Object.assign({ ok: true }, res, { conflicts: [], action: 'initialized' }), 200];
    }

    if (baseRev === cur.rev) {
      const res = store.put(cur.rev, data, machine, 'sync-fast');
      return [Object.assign({ ok: true }, res, { conflicts: [], action: 'fast' }), 200];
    }

    const base = store.get_snapshot(baseRev);
    if (base === null && baseRev === 0) {
      // 本机从未同步过：以空基准做并集合并，两端各自录入的数据都保留
      const [merged, conflicts] = mergeMod.merge({}, data, cur.data);
      const res = store.put(cur.rev, merged, machine, 'first-merge');
      return [{
        ok: true, action: 'first-merge', rev: res.rev,
        updated_at: res.updated_at, data: merged, conflicts,
      }, 200];
    }
    if (base === null) {
      // base 快照缺失（已被清理且本机同步过）：保命存本地版本，采用服务端版本
      const saved = store.snapshot(machine, 'orphan-local-from-' + machine + '@rev' + baseRev);
      store.cold_backup('orphan');
      return [{
        ok: true,
        action: 'need-manual',
        rev: cur.rev,
        data: cur.data,
        conflicts: [],
        message: '缺少合并基准(rev=' + baseRev + ')，本机数据已存为快照(rev=' + saved + ')，' +
                 '当前已采用服务端数据。如需恢复，到设置页回滚。',
      }, 200];
    }

    const [merged, conflicts] = mergeMod.merge(base.data, data, cur.data);
    // 云端队列消费者已在 baseRev 上应用动作；冲突时业务集合以 QUEUE 侧为准，
    // 否则入库/重算库存会被对端旧 ings 盖回（orders/recv 也曾不参与合并）。
    if (String(machine).toUpperCase() === 'QUEUE') {
      for (const coll of ['ings', 'orders', 'recv', 'logs', 'pos', 'sales', 'quotes']) {
        if (Array.isArray(data[coll])) merged[coll] = data[coll];
      }
    }
    const res = store.put(cur.rev, merged, machine, 'sync-merge');
    return [{
      ok: true,
      action: 'merged',
      rev: res.rev,
      updated_at: res.updated_at,
      data: merged,
      conflicts,
    }, 200];
  }

  // 静态文件（可选）
  function serveStatic(req, res, pathname) {
    if (pathname === '/' || pathname === '') {
      res.statusCode = 302;
      res.setHeader('Location', '/' + encodeURIComponent(cfg.index_file));
      cors(res);
      res.end();
      return;
    }
    const rel = decodeURIComponent(pathname.replace(/^\/+/, ''));
    const full = path.resolve(staticRoot, rel);
    if (!full.startsWith(staticRoot) || !isFile(full)) {
      return sendJson(res, { ok: false, error: 'not found: ' + rel }, 404);
    }
    const ext = path.extname(full).toLowerCase();
    const body = fs.readFileSync(full);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', String(body.length));
    cors(res);
    res.end(body);
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const pathname = url.pathname;
    if (pathname.includes('/api/')) {
      // 对应 app.py 的 log_message（仅记录 API 请求）
      console.error('[' + new Date().toTimeString().slice(0, 8) + '] ' +
        req.method + ' ' + pathname);
    }
    try {
      if (req.method === 'OPTIONS') {
        return sendEmpty(res, 204);
      }

      if (req.method === 'GET') {
        if (pathname === '/api/health') return sendJson(res, health());
        if (pathname === '/api/rev') {
          const cur = store.get();
          return sendJson(res, {
            ok: true, rev: cur.rev, empty: cur.empty,
            updated_at: cur.updated_at, machine: cur.machine,
          });
        }
        if (pathname === '/api/db') {
          const cur = store.get();
          return sendJson(res, {
            ok: true, rev: cur.rev, empty: cur.empty,
            updated_at: cur.updated_at, machine: cur.machine,
            data: cur.data,
          });
        }
        if (pathname === '/api/snapshots') {
          return sendJson(res, { ok: true, items: store.list_snapshots() });
        }
        if (cfg.serve_static) return serveStatic(req, res, pathname);
        return sendJson(res, { ok: false, error: 'not found' }, 404);
      }

      if (req.method === 'PUT') {
        if (pathname === '/api/db') {
          const payload = await readBody(req);
          const data = payload.data;
          if (data === null || data === undefined) {
            return sendJson(res, { ok: false, error: 'missing data' }, 400);
          }
          const machine = payload.machine || cfg.machine_id;
          try {
            const out = store.put(
              payload.rev, data, machine,
              payload.force ? 'force-push' : 'client-put',
              Boolean(payload.force)
            );
            return sendJson(res, Object.assign({ ok: true }, out));
          } catch (cf) {
            if (cf instanceof Conflict) {
              const cur = store.get();
              return sendJson(res, {
                ok: false, error: 'conflict', rev: cf.rev,
                updated_at: cf.updated_at, machine: cf.machine,
                data: cur.data,
              }, 409);
            }
            throw cf;
          }
        }
        return sendJson(res, { ok: false, error: 'not found' }, 404);
      }

      if (req.method === 'POST') {
        const payload = await readBody(req);
        if (pathname === '/api/sync') {
          const [body, code] = sync(payload);
          return sendJson(res, body, code);
        }
        if (pathname === '/api/snapshot') {
          const rev = store.snapshot(
            payload.machine || cfg.machine_id,
            payload.note || 'manual'
          );
          return sendJson(res, { ok: true, rev });
        }
        if (pathname === '/api/rollback') {
          const out = store.rollback(
            payload.rev,
            payload.machine || cfg.machine_id
          );
          if (!out) return sendJson(res, { ok: false, error: 'snapshot not found' }, 404);
          return sendJson(res, Object.assign({ ok: true }, out));
        }
        return sendJson(res, { ok: false, error: 'not found' }, 404);
      }

      return sendJson(res, { ok: false, error: 'not found' }, 404);
    } catch (exc) {
      console.error(exc && exc.stack ? exc.stack : exc);
      return sendJson(res, { ok: false, error: String(exc && exc.message || exc) }, 500);
    }
  };
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

// 按当前 cfg 重建存储对象（对应 app.py 的 build_store）
function buildStore(cfg) {
  return new Store(
    abspath(cfg.db_path),
    abspath(cfg.backup_dir),
    cfg.snapshot_keep_days,
    cfg.snapshot_keep_count
  );
}

// 启动服务；返回 { server, port, store, cfg }
function startServer(cfg) {
  cfg = cfg || loadConfig();
  const store = buildStore(cfg);
  const staticRoot = abspath(cfg.static_root);
  const handler = makeHandler(store, cfg, staticRoot);
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    const port = toInt(cfg.port);
    const host = cfg.host || '127.0.0.1';
    server.listen(port, host, () => {
      if (cfg.cold_backup_on_start !== false) {
        try { store.cold_backup('boot'); } catch (e) { /* ignore */ }
      }
      resolve({ server, port: server.address().port, store, cfg });
    });
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start ""'
      : 'xdg-open';
  exec(cmd + ' "' + url + '"', () => { /* best effort */ });
}

// 对应 app.py 的 main()
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    let key = a.slice(2);
    let val = true;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      val = argv[++i];
    }
    args[key] = val;
  }
  return args;
}

async function main() {
  const cfg = loadConfig();
  const args = parseArgs(process.argv.slice(2));
  if (args.port) cfg.port = toInt(args.port);
  if (args.host) cfg.host = args.host;
  if (args.db) cfg.db_path = args.db;
  if (args.machine) cfg.machine_id = args.machine;
  if (args['open-browser']) cfg.open_browser = true;

  const line = '='.repeat(62);
  console.log(line);
  console.log('  熊猫五福餐厅 · 本地数据库服务 (Node)');
  console.log(line);
  const { server, port, store } = await startServer(cfg);
  const cur = store.get();
  console.log('  数据库 : ' + store.db_path);
  console.log('  本机标识: ' + cfg.machine_id);
  console.log('  当前版本: rev=' + cur.rev + '  ' +
    (cur.empty ? '（空库，等待首次写入）' : cur.updated_at));
  console.log('  接口地址: http://' + cfg.host + ':' + port);
  console.log('-'.repeat(62));
  console.log('  服务已就绪。');
  console.log(line);
  if (cfg.open_browser) openBrowser('http://' + cfg.host + ':' + port + '/');
  process.on('SIGINT', () => { server.close(() => process.exit(0)); });
  return { server, port, store, cfg };
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  DEFAULT_CONFIG,
  loadConfig,
  abspath,
  buildStore,
  startServer,
  parseArgs,
  main,
};
