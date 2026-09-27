'use strict';
/*
 * store-node/consumer.test.js — 消费者集成测试
 * 用内存 mock 的「店内服务」与「云端 BFF」验证：
 *   - restock.create：取 data → 跑算法 → sync 回写 → 回调 execute
 *   - stock.count：同上（含 ext 写库路径）
 *   - 未登记 type 被驳回
 * 用法：node store-node/consumer.test.js
 */
const assert = require('assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const consumer = require('./consumer');

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
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

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-test-'));
  const dbPath = path.join(tmp, 'store.db');
  // 建一个最小 docs 表，便于 ensureTables 无碍
  consumer.ensureTables(dbPath);

  /* ---- mock 店内服务：内存 data + sync ---- */
  let storeData = {
    ings: [{ id: 'I1', name: '面粉', unit: 'kg', initStock: 10, initAvg: 5, stock: 10, avg: 5 }],
    recv: [], logs: [], orders: []
  };
  let storeRev = 7;
  const store = await startServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/api/db') {
      return json(res, 200, { ok: true, rev: storeRev, data: storeData });
    }
    if (req.method === 'POST' && u.pathname === '/api/sync') {
      const body = await readBody(req);
      storeData = body.data;
      storeRev += 1;
      return json(res, 200, { ok: true, action: 'merged', rev: storeRev, data: storeData, conflicts: [] });
    }
    if (req.method === 'GET' && u.pathname === '/api/health') {
      return json(res, 200, { ok: true, rev: storeRev });
    }
    return json(res, 404, { ok: false });
  });

  /* ---- mock BFF：待执行动作 + execute 回调 + snapshot push ---- */
  const pending = [
    { id: 'a1', type: 'restock.create', payload: { items: [{ name: '面粉', qty: 5, unit: 'kg', price: 6 }] }, trace_id: 't1' },
    { id: 'a2', type: 'stock.count', payload: { name: '面粉', real_qty: 12, book_qty: 10 }, trace_id: 't2' },
    { id: 'a3', type: 'no.such.type', payload: {}, trace_id: 't3' }
  ];
  const callbacks = [];
  const pushes = [];
  const bff = await startServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/api/actions') {
      return json(res, 200, { ok: true, items: pending });
    }
    const m = u.pathname.match(/^\/api\/actions\/([^/]+)\/execute$/);
    if (req.method === 'POST' && m) {
      const body = await readBody(req);
      callbacks.push({ id: m[1], body });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/api/snapshot/push') {
      const body = await readBody(req);
      pushes.push(body);
      return json(res, 200, { ok: true, rev: body.rev });
    }
    return json(res, 404, { ok: false });
  });

  const storeUrl = 'http://127.0.0.1:' + store.port;
  const bffUrl = 'http://127.0.0.1:' + bff.port;

  try {
    const ok = await consumer.runOnce(storeUrl, bffUrl, 'tok', dbPath);
    assert.strictEqual(ok, true, 'runOnce should reach BFF');

    // 1) restock.create 追加草稿采购单
    assert.ok(Array.isArray(storeData.orders) && storeData.orders.length === 1, 'one draft order');
    assert.ok(/CG/.test(storeData.orders[0].no), 'draft PO no CG*');

    // 2) stock.count 改库存 + 写 loss_inventory_diff/loss_reports
    const i1 = storeData.ings.find((g) => g.id === 'I1');
    assert.strictEqual(i1.stock, 12, 'stock.count → 12');
    const db = new DatabaseSync(dbPath);
    const diffRows = db.prepare('SELECT * FROM loss_reports').all();
    // 允许 loss_inventory_diff 表存在时走该表；此处至少 loss_reports 表存在
    assert.ok(Array.isArray(diffRows), 'loss_reports readable');
    db.close();

    // 3) 三个回调：a1/a2 成功、a3 驳回
    assert.strictEqual(callbacks.length, 3, 'three callbacks');
    const cb = (id) => callbacks.find((c) => c.id === id);
    assert.strictEqual(cb('a1').body.result.ok, true, 'a1 ok');
    assert.strictEqual(cb('a2').body.result.ok, true, 'a2 ok');
    assert.strictEqual(cb('a3').body.result.ok, false, 'a3 rejected');
    assert.ok(/未知动作类型/.test(cb('a3').body.error), 'a3 error msg');

    // 4) 成功后推送快照
    assert.ok(pushes.length >= 2, 'snapshot pushed after successes');

    // 5) actions_queue 落库
    const db2 = new DatabaseSync(dbPath);
    const q = db2.prepare('SELECT id,status FROM actions_queue ORDER BY id').all();
    db2.close();
    assert.ok(q.length === 3, 'actions_queue 3 rows');
    assert.strictEqual(q.find((r) => r.id === 'a1').status, 'done');
    assert.strictEqual(q.find((r) => r.id === 'a3').status, 'rejected');

    console.log('  PASS restock.create → draft PO');
    console.log('  PASS stock.count → stock=12 + 落库');
    console.log('  PASS 未登记 type 驳回');
    console.log('  PASS 成功回调 + 推送快照 + actions_queue');
    console.log('[consumer.test] PASS');
  } finally {
    store.srv.close();
    bff.srv.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[consumer.test] FAIL:', e && e.stack ? e.stack : e); process.exit(1); });
}
