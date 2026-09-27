'use strict';
/*
 * server.test.js — server.js HTTP 端点的冒烟测试。
 * 在随机的本地端口起 Node 服务，用 curl 风格请求 health/rev/db/PUT/sync/snapshot/rollback，
 * 断言状态码与 body 形状。
 * 用法：node bff/store-node/server.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startServer, parseArgs } = require('./server');

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length),
      } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = text; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-node-srv-'));
  const cfg = {
    port: 0,
    host: '127.0.0.1',
    db_path: path.join(dir, '餐厅系统.db'),
    backup_dir: path.join(dir, 'backups'),
    machine_id: 'TEST',
    snapshot_keep_days: 30,
    snapshot_keep_count: 200,
    serve_static: false,
    static_root: '.',
    index_file: 'x.html',
    open_browser: false,
  };
  const { server, port } = await startServer(cfg);
  const P = (m, u, b) => request(port, m, u, b);
  try {
    // 1. health / rev / db（空库）
    let r = await P('GET', '/api/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.service, 'panda-inv-db');
    assert.strictEqual(r.body.machine, 'TEST');
    assert.deepStrictEqual(r.body.counts, {});

    r = await P('GET', '/api/rev');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.rev, 0);
    assert.strictEqual(r.body.empty, true);

    r = await P('GET', '/api/db');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data, null);

    // 2. CORS 预检
    r = await P('OPTIONS', '/api/db');
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers['access-control-allow-origin'], '*');
    assert.strictEqual(r.headers['access-control-allow-methods'], 'GET, PUT, POST, OPTIONS');
    assert.strictEqual(r.headers['access-control-allow-headers'], 'Content-Type');

    // 3. PUT 首次写入
    r = await P('PUT', '/api/db', {
      rev: 0,
      data: { ings: [{ id: 'I1', name: '面粉', qty: 10 }], seq: 1 },
      machine: 'TEST',
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.rev, 1);

    r = await P('GET', '/api/db');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.rev, 1);
    assert.strictEqual(r.body.data.ings[0].name, '面粉');
    assert.strictEqual(r.headers['content-type'], 'application/json; charset=utf-8');

    // 4. PUT rev 冲突 -> 409，body 形状与 Python 一致
    r = await P('PUT', '/api/db', { rev: 0, data: { x: 1 }, machine: 'TEST' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.ok, false);
    assert.strictEqual(r.body.error, 'conflict');
    assert.strictEqual(r.body.rev, 1);
    assert.strictEqual(r.body.machine, 'TEST');
    assert.ok(r.body.data && r.body.data.ings);

    // 5. PUT 缺 data -> 400
    r = await P('PUT', '/api/db', { rev: 1, machine: 'TEST' });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(r.body, { ok: false, error: 'missing data' });

    // 6. sync 快速路径
    r = await P('POST', '/api/sync', {
      baseRev: 1, data: { ings: [{ id: 'I1', name: '面粉', qty: 20 }], seq: 2 }, machine: 'TEST',
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.action, 'fast');
    assert.strictEqual(r.body.rev, 2);
    assert.deepStrictEqual(r.body.conflicts, []);

    // 7. sync 缺 data -> 400
    r = await P('POST', '/api/sync', { baseRev: 2, machine: 'TEST' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'missing data');

    // 8. sync 合并路径（baseRev 快照存在）
    r = await P('POST', '/api/sync', {
      baseRev: 1,
      data: { ings: [{ id: 'I2', name: '猪肉', qty: 5 }], seq: 2 },
      machine: 'TEST',
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.action, 'merged');
    assert.ok(Array.isArray(r.body.conflicts));
    assert.ok(r.body.data.ings.some((x) => x.id === 'I1'));
    assert.ok(r.body.data.ings.some((x) => x.id === 'I2'));

    // 9. sync QUEUE：业务集合以 data 为准
    r = await P('POST', '/api/sync', {
      baseRev: r.body.rev - 1,
      data: { ings: [{ id: 'ONLY-QUEUE', qty: 1 }], seq: 1 },
      machine: 'QUEUE',
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.data.ings, [{ id: 'ONLY-QUEUE', qty: 1 }]);

    // 10. snapshot / snapshots / rollback
    r = await P('POST', '/api/snapshot', { machine: 'TEST', note: 'manual' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(typeof r.body.rev === 'number');

    r = await P('GET', '/api/snapshots');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body.items));
    assert.ok(r.body.items.length >= 1);

    r = await P('POST', '/api/rollback', { rev: 1, machine: 'TEST' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(r.body.rev > 1);

    r = await P('POST', '/api/rollback', { rev: 9999, machine: 'TEST' });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.error, 'snapshot not found');

    // 11. 未知路由
    r = await P('GET', '/api/nope');
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.ok, false);

    // 12. 命令行参数解析
    assert.deepStrictEqual(parseArgs(['--port', '9000', '--host=0.0.0.0', '--machine', 'HOME', '--open-browser']), {
      port: '9000', host: '0.0.0.0', machine: 'HOME', 'open-browser': true,
    });

    console.log('[server.test] PASS  health/rev/db/PUT/sync/snapshot/rollback 端点正常');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[server.test] FAIL:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}
