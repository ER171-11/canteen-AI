'use strict';
/*
 * seed/testlib.js — seed 迁移脚本差分测试共用工具
 *
 * 提供：
 *   - 复制真实库到临时目录
 *   - 启动一个最小「店内服务」mock（GET/PUT /api/db、POST /api/sync），后端包 Store
 *   - 读取 docs.data / 全表
 *   - 归一化易变字段（时间戳、随机 id）后再深比较
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('../db');
const { runPython: execPy, pick: pickPy } = require('../../lib/_python');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
// 真实基座库不入 VCS（store-inventory/.gitignore 的 *.db），CI 全新检出时必然缺失。
// copyDb() 对缺失场景回退为「按 migrations 全量重建」（与 testutil.copyBaseDb 同一口径），
// 保证差分测试在 CI 上仍真实执行而非空跑。可用 SEED_BASE_DB 覆盖（模拟 CI 条件 / 指定其他库）。
// 历史缺陷（2026-09-29 首次 CI 修复）：这里原本无条件 copyFileSync，基座库缺失直接 ENOENT，
// 且与 testutil.copyBaseDb 的回退口径不一致 —— 4 个测试在 CI 整体失败。
const SRC_DB = process.env.SEED_BASE_DB || path.join(REPO_ROOT, 'store-inventory', 'data', '餐厅系统.db');
const SRC_ZIP = [
  path.join(REPO_ROOT, '餐厅系统.zip'),
  path.join(REPO_ROOT, 'old', 'root-assets', '餐厅系统.zip'),
].find((p) => fs.existsSync(p));

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'seed-test-'));
}

function copyDb(destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(SRC_DB)) {
    fs.copyFileSync(SRC_DB, destPath);
  } else {
    // 基座库缺失（CI）：按 migrations 全量重建。懒加载避免与 testutil 形成环。
    require('./testutil').buildFreshDb(destPath);
  }
  return destPath;
}

function loadDocData(dbPath) {
  const conn = new DatabaseSync(dbPath);
  try {
    const row = conn.prepare('SELECT data FROM docs WHERE id=1').get();
    return JSON.parse(row.data);
  } finally {
    conn.close();
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

/** 最小店内服务：行为对齐 server.js 的 /api/db GET|PUT、/api/sync POST。 */
function startMockStore(dbPath) {
  const store = new Store(dbPath);
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      if (req.method === 'GET' && u.pathname === '/api/db') {
        const cur = store.get();
        return sendJson(res, 200, { ok: true, rev: cur.rev, data: cur.data });
      }
      if (req.method === 'PUT' && u.pathname === '/api/db') {
        const body = await readBody(req);
        try {
          const info = store.put(body.rev, body.data, body.machine || 'TEST');
          return sendJson(res, 200, { ok: true, rev: info.rev });
        } catch (e) {
          if (e && e.name === 'Conflict') {
            return sendJson(res, 409, { ok: false, rev: e.rev, error: 'conflict' });
          }
          return sendJson(res, 500, { ok: false, error: String(e && e.message) });
        }
      }
      if (req.method === 'POST' && u.pathname === '/api/sync') {
        const body = await readBody(req);
        try {
          const cur = store.get();
          const info = store.put(cur.rev, body.data, body.machine || 'SYNC');
          return sendJson(res, 200, { ok: true, action: 'merged', rev: info.rev, conflicts: [] });
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: String(e && e.message) });
        }
      }
      if (req.method === 'GET' && u.pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, rev: store.rev() });
      }
      return sendJson(res, 404, { ok: false });
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        url: 'http://127.0.0.1:' + srv.address().port,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

/** 递归归一化易变字段。opts: {dropKeys:Set, placeholderKeys:Set} */
function normalize(v, opts) {
  opts = opts || {};
  const drop = opts.dropKeys || new Set();
  const ph = opts.placeholderKeys || new Set();
  if (Array.isArray(v)) return v.map((x) => normalize(x, opts));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      if (drop.has(k)) continue;
      if (ph.has(k)) {
        out[k] = '<X>';
        continue;
      }
      if (k === '_recU' && v[k] && typeof v[k] === 'object') {
        const m = {};
        for (const kk of Object.keys(v[k])) m[kk] = '<T>';
        out[k] = m;
        continue;
      }
      if (k === 'id' && typeof v[k] === 'string' && /^BYseed/.test(v[k])) {
        out[k] = '<PLANID>';
        continue;
      }
      out[k] = normalize(v[k], opts);
    }
    return out;
  }
  return v;
}

function pyJson(cmd, input, extraArgs) {
  const res = execPy(cmd, { input: JSON.stringify(input), args: extraArgs || [] });
  return JSON.parse(res);
}

/** 异步跑 python（不阻塞事件循环，供同进程 mock server 用）。 */
function runPython(args, input) {
  const { execFile } = require('child_process');
  const c = pickPy() || { cmd: 'python3', pre: [] };
  return new Promise((resolve, reject) => {
    const child = execFile(c.cmd, c.pre.concat(args), {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
    }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
    if (input !== undefined) {
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    }
  });
}

module.exports = {
  assert,
  REPO_ROOT,
  SRC_DB,
  SRC_ZIP,
  tmpdir,
  copyDb,
  loadDocData,
  startMockStore,
  normalize,
  pyJson,
  runPython,
};
