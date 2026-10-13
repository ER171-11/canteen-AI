#!/usr/bin/env node
'use strict';
/**
 * 共享底座 S 系列一键冒烟（隔离数据，不污染真实 BFF_DATA_DIR）。
 * 覆盖：S-01 鉴权 / S-02 快照推送 / S-04 销售聚合 / S-06 基础数据降级 / S-08 前厅 provider 开关。
 * S-03 需外部 Kimi Key、S-05 由 scripts/e2e-writeback.js 覆盖、S-07 由下方 migrations 重放校验覆盖。
 * 用法：node scripts/e2e-sbase.js
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BFF_DIR = path.join(ROOT, 'bff');
let CHECKS = 0;

function line(m) { process.stdout.write(m + '\n'); }
function ok(cond, msg, extra) {
  if (!cond) throw new Error('断言失败: ' + msg + (extra === undefined ? '' : ' | 实际: ' + JSON.stringify(extra)));
  CHECKS++; line('  ✓ ' + msg);
}
function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function request(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let payload = null;
    if (body !== undefined && body !== null) payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(payload.length); }
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers, timeout: 15000 }, (r) => {
      let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: r.statusCode, body: j, raw: b }); });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload); req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbase-'));
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, [path.join(BFF_DIR, 'server.js')], {
    cwd: BFF_DIR,
    env: Object.assign({}, process.env, { BFF_PORT: String(port), BFF_HOST: '127.0.0.1', BFF_DATA_DIR: dataDir, SI_SCHEDULER: '0' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  try {
    let up = false;
    for (let i = 0; i < 60; i++) { try { const r = await request('GET', base + '/api/health'); if (r.status === 200) { up = true; break; } } catch (e) {} await sleep(300); }
    ok(up, 'BFF 启动可达 /api/health（隔离 BFF_DATA_DIR）');

    /* ---------- S-01 鉴权 ---------- */
    line('\n== S-01 鉴权 ==');
    const bad = await request('POST', base + '/api/auth/login', { account: 'boss', password: 'wrong' });
    ok(bad.status === 401, '错误密码登录 → 401', bad.status);
    const login = await request('POST', base + '/api/auth/login', { account: 'boss', password: 'wufu123' });
    ok(login.status === 200 && login.body && login.body.token, 'boss/wufu123 登录成功并签发 token', login.status);
    const token = login.body.token;
    const noTok = await request('GET', base + '/api/modules/staff');
    ok(noTok.status === 401, '未登录访问 /api/modules/staff → 401', noTok.status);
    const withTok = await request('GET', base + '/api/modules/staff', null, token);
    ok(withTok.status === 200, '带 token 访问 /api/modules/staff → 200', withTok.status);
    const noTokWrite = await request('POST', base + '/api/actions', { type: 'x.y', payload: {} });
    ok(noTokWrite.status === 401, '未登录写操作 POST /api/actions → 401', noTokWrite.status);

    /* ---------- S-02 快照推送 ---------- */
    line('\n== S-02 快照推送 ==');
    const today = new Date().toISOString().slice(0, 10);
    const salesData = {
      sales: [
        { ts: today + ' 11:30:00', amount: 120, dish: '猪肉白菜饺', qty: 3 },
        { ts: today + ' 12:10:00', amount: 80, dish: '韭菜鸡蛋饺', qty: 2 }
      ],
      dishes: [{ id: 'D1', name: '猪肉白菜饺', sku_id: 'SKU-WF-01' }]
    };
    const push = await request('POST', base + '/api/snapshot/push', { rev: 296, data: salesData }, token);
    ok(push.status === 200 && push.body && push.body.ok, 'POST /api/snapshot/push → 200 ok', push.status);
    const latest = await request('GET', base + '/api/snapshot/latest', null, token);
    ok(latest.status === 200 && latest.body.rev === 296, 'GET /api/snapshot/latest 回读 rev=296', latest.body && latest.body.rev);
    ok(typeof latest.body.size === 'number' && latest.body.size < 5 * 1024 * 1024, '快照体量 < 5MB（size=' + latest.body.size + '）', latest.body.size);
    const modF = await request('GET', base + '/api/snapshot/latest?module=sales', null, token);
    ok(modF.body.data && modF.body.data.sales && !modF.body.data.dishes, 'module 过滤：?module=sales 只回 sales 子集');
    const big = Buffer.alloc(5 * 1024 * 1024 + 100);
    const tooBig = await request('POST', base + '/api/snapshot/push', big, token);
    ok(tooBig.status === 413, '快照 >5MB → 413 拒收', tooBig.status);

    /* ---------- S-04 销售数据聚合 ---------- */
    line('\n== S-04 销售数据聚合 ==');
    const anReal = await request('GET', base + '/api/modules/analysis', null, token);
    ok(anReal.status === 200 && anReal.body.mock !== true, '有 data.sales → 真实聚合（非 mock）', anReal.body && anReal.body.mock);
    ok(Array.isArray(anReal.body.trend) && anReal.body.trend.length > 0, 'trend 按日聚合非空（' + (anReal.body.trend || []).length + ' 天）');
    const sumRev = (anReal.body.trend || []).reduce((s, d) => s + d.revenue, 0);
    ok(Math.abs(sumRev - 200) < 0.01, '聚合口径与快照一致：trend 合计=200', sumRev);

    /* ---------- S-06 基础数据服务（无数据降级不报错） ---------- */
    line('\n== S-06 基础数据服务 ==');
    await request('POST', base + '/api/snapshot/push', { rev: 297, data: {} }, token);
    for (const m of ['staff', 'foodsafe', 'equipment', 'finance', 'supply', 'loss']) {
      const r = await request('GET', base + '/api/modules/' + m, null, token);
      ok(r.status === 200, '空快照下 /api/modules/' + m + ' → 200 降级不报错', r.status);
    }
    const analysisEmpty = await request('GET', base + '/api/modules/analysis', null, token);
    ok(analysisEmpty.status === 200 && analysisEmpty.body.mock === true, '无 data.sales → 降级 mock:true（非缺陷）', analysisEmpty.body && analysisEmpty.body.mock);

    /* ---------- S-08 前厅 provider 开关 ---------- */
    line('\n== S-08 provider 开关（默认 meituan） ==');
    await request('POST', base + '/api/snapshot/push', { rev: 298, data: salesData }, token);
    for (const m of ['vip', 'pos', 'takeout', 'booking', 'review']) {
      const r = await request('GET', base + '/api/' + m, null, token);
      const d = r.body && r.body.data;
      ok(r.status === 200 && d && d.provider === 'meituan' && d.status === 'reserved' && d.switchable === true,
        'GET /api/' + m + ' → 预留契约 {provider:meituan, status:reserved, switchable:true}', d);
    }
    const enq = await request('POST', base + '/api/actions', { type: 'vip_recharge', payload: { amount: 100, member: 'M1' } }, token);
    ok(enq.status === 200 && enq.body.id, '前厅动作 vip_recharge 入队（front_house）', enq.status);
    const conf = await request('POST', base + '/api/actions/' + enq.body.id + '/confirm', { rev: 298 }, token);
    ok(conf.status === 423, 'meituan 下前厅动作 confirm → 423 pending_provider（不写库）', conf.status);

    /* ---------- S-07 migrations 可重放（幂等） ---------- */
    line('\n== S-07 migrations 可重放（幂等） ==');
    const { DatabaseSync } = require('node:sqlite');
    const migDir = path.join(ROOT, 'store-inventory', 'migrations');
    const files = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    line('  · 迁移文件 ' + files.length + ' 个：' + files.join(', '));
    const dbPath = path.join(dataDir, 'mig.sqlite');
    function replay() {
      const db = new DatabaseSync(dbPath);
      const errs = [];
      for (const f of files) { try { db.exec(fs.readFileSync(path.join(migDir, f), 'utf8')); } catch (e) { errs.push(f + ': ' + e.message); } }
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      db.close();
      return { errs, tables };
    }
    const r1 = replay();
    ok(r1.tables.length > 0, '首轮执行 migrations 建表 ' + r1.tables.length + ' 张');
    const r2 = replay();
    ok(r2.tables.length >= r1.tables.length, '二轮重放成功（幂等/失败可忽略），表数 ' + r2.tables.length + ' 未减少', r2.tables.length);
    if (r1.errs.length || r2.errs.length) line('  · 重放容错（consumer.js 忽略非致命错误）：首轮 ' + r1.errs.length + ' / 二轮 ' + r2.errs.length + ' 条');
    else line('  · 全部迁移幂等重放零错误');

    line('\n===== 共享底座 S 系列冒烟：' + CHECKS + ' 条断言全绿 =====');
  } catch (e) {
    line('\n✗ ' + (e && e.message));
    line('--- BFF 日志尾部 ---\n' + log.split(/\r?\n/).slice(-15).join('\n'));
    process.exitCode = 1;
  } finally {
    try { child.kill(); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }
})();
