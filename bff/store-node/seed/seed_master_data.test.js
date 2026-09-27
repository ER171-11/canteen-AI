'use strict';
/*
 * seed_master_data.test.js — seed_master_data.js ↔ seed_master_data.py 平价测试
 *
 * 1) sqlite 路径差分：同一基线库分别跑 Node / Python，比较受影响表内容；
 * 2) HTTP 路径差分：mock 店内服务，两条实现分别走 GET /api/db → POST /api/sync，
 *    比较实际写出的 data.pos / data.sales / data.platforms（含午晚高峰/外卖抖动逻辑）；
 * 3) 幂等性：delete/replace 类表连续两次结果稳定；追加类表（reviews/reconcile）
 *    与 Python 原实现一致，为追加式，这里只断言其增量确定。
 *
 * 用法：node bff/store-node/seed/seed_master_data.test.js
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const util = require('./testutil');
const seed = require('./seed_master_data');

const TABLES = ['pos_tables', 'vip_members', 'vip_balance', 'takeout_orders', 'takeout_reconcile', 'rv_reviews'];
const STABLE = ['pos_tables', 'vip_members', 'vip_balance', 'takeout_orders'];

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
  });
}

function startMock() {
  return new Promise((resolve) => {
    const captures = [];
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (req.method === 'GET' && u.pathname === '/api/db') {
        return json(res, 200, { ok: true, rev: 5, data: { ings: [{ id: 'I1', name: '面粉' }], seq: 5 } });
      }
      if (req.method === 'POST' && u.pathname === '/api/sync') {
        readBody(req).then((b) => {
          captures.push(b);
          json(res, 200, { ok: true, action: 'merged', rev: 6, data: b.data, conflicts: [] });
        });
        return;
      }
      json(res, 404, { ok: false });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv: srv, port: srv.address().port, captures: captures }));
  });
}

async function main() {
  const dir = util.tmpDir('seed-master-');
  try {
    /* ---------- 1) sqlite 差分 ---------- */
    const nodeDb = path.join(dir, 'node', '餐厅系统.db');
    const pyDb = path.join(dir, 'py', '餐厅系统.db');
    util.copyBaseDb(nodeDb);
    util.copyBaseDb(pyDb);

    seed.seedSqlite(nodeDb);
    const pyCode = util.loadPyModule('m', util.PY_MASTER) + '\nm.seed_sqlite(sys.argv[1])';
    util.runPython(pyCode, [pyDb]);
    util.assertTablesEqual(nodeDb, pyDb, TABLES);
    console.log('  PASS sqlite 差分: ' + TABLES.length + ' 张表与 Python 一致');

    /* ---------- 2) HTTP 路径差分 ---------- */
    const mock = await startMock();
    try {
      const url = 'http://127.0.0.1:' + mock.port;
      await seed.seedStoreJson(url);
      await util.runPythonAsync(util.loadPyModule('m', util.PY_MASTER) + '\nm.seed_store_json(sys.argv[1])', [url]);

      assert.strictEqual(mock.captures.length, 2, '应捕获两次 /api/sync');
      const nPost = mock.captures[0];
      const pPost = mock.captures[1];
      assert.strictEqual(nPost.machine, 'SEED', 'Node machine=SEED');
      assert.strictEqual(pPost.machine, 'SEED', 'Python machine=SEED');
      assert.strictEqual(nPost.baseRev, 5, 'Node baseRev=5');
      assert.strictEqual(pPost.baseRev, 5, 'Python baseRev=5');
      assert.deepStrictEqual(nPost.data.pos, pPost.data.pos, 'pos 不一致');
      assert.deepStrictEqual(nPost.data.sales, pPost.data.sales, 'sales 不一致');
      assert.deepStrictEqual(nPost.data.platforms, pPost.data.platforms, 'platforms 不一致');
      console.log('  PASS HTTP 差分: pos=' + nPost.data.pos.length + ' sales=' + nPost.data.sales.length + ' 与 Python 一致');
    } finally {
      mock.srv.close();
    }

    /* ---------- 3) 幂等性 ---------- */
    const idemDb = path.join(dir, 'idem', '餐厅系统.db');
    util.copyBaseDb(idemDb);

    const before = {};
    for (const t of TABLES) before[t] = util.countWhere(idemDb, t);

    seed.seedSqlite(idemDb);
    const snap1 = {};
    for (const t of TABLES) snap1[t] = util.tableSnapshot(idemDb, t);
    const cnt1 = {};
    for (const t of TABLES) cnt1[t] = util.countWhere(idemDb, t);

    seed.seedSqlite(idemDb);
    const cnt2 = {};
    for (const t of TABLES) cnt2[t] = util.countWhere(idemDb, t);

    // delete/replace 表：第二次与第一次完全一致
    for (const t of STABLE) {
      assert.deepStrictEqual(util.tableSnapshot(idemDb, t), snap1[t], t + ' 第二次不稳定');
    }
    // 追加表：按 Python 原语义每次追加固定条数（reviews +3 / reconcile +1）
    assert.strictEqual(cnt1.rv_reviews - before.rv_reviews, 3, 'reviews 首次 +3');
    assert.strictEqual(cnt2.rv_reviews - cnt1.rv_reviews, 3, 'reviews 再次 +3（追加式，与原脚本一致）');
    assert.strictEqual(cnt1.takeout_reconcile - before.takeout_reconcile, 1, 'reconcile 首次 +1');
    assert.strictEqual(cnt2.takeout_reconcile - cnt1.takeout_reconcile, 1, 'reconcile 再次 +1（追加式，与原脚本一致）');

    console.log('  PASS 幂等性: delete/replace 表稳定；追加表增量与原脚本一致');
    console.log('[seed_master_data.test] PASS');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[seed_master_data.test] FAIL:', e && e.stack ? e.stack : e); process.exit(1); });
}
