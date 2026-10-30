#!/usr/bin/env node
'use strict';
/*
 * scripts/verify-adr013-batch3.js — ADR-013 第 3 批（W3-01 / W3-02 / W3-03）活体验证
 *
 * 只驱动 BFF 公开 HTTP API，隔离在临时 BFF_DATA_DIR + 随机端口，不污染真实快照。
 * 覆盖：
 *   W3-01 手工校准      POST /api/actions {type:stock.count, avg} → 队列执行
 *                       · 只改均价：数量不变、台账出现「手工调整」且 inCost=新均价、库存总值不为 0
 *                       · 普通盘点：均价不被清 0（原缺陷回归）
 *                       · 缺原因：动作置「已驳回」（红线 #7 不静默降级）
 *   W3-02 批量设置      ing.batch 一次动作改 N 个原料（队列里只有 1 条）+ 零命中驳回
 *   W3-03 删除原料      ing.delete 有引用 → 驳回并提示「改停用」；无引用 → 真删；
 *                       ing.upsert on:false 作为正解把原料停用
 *
 * 用法：node scripts/verify-adr013-batch3.js [--verbose] [--keep]
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BFF_DIR = path.join(ROOT, 'bff');
const ARGV = process.argv.slice(2);
const VERBOSE = ARGV.includes('--verbose');
const KEEP = ARGV.includes('--keep');

let CHECKS = 0;
let bffLog = '';

function line(m) { process.stdout.write(m + '\n'); }
function step(n, t) { line(''); line('== ' + n + '. ' + t + ' =='); }
function info(m) { line('  · ' + m); }
function ok(cond, msg, extra) {
  if (!cond) throw new Error('断言失败: ' + msg + (extra === undefined ? '' : ' | 实际: ' + JSON.stringify(extra)));
  CHECKS += 1;
  line('  ✓ ' + msg);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function request(method, url, body, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let payload = null;
    if (body !== undefined && body !== null) payload = Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(payload.length); }
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request({
      method, hostname: u.hostname, port: u.port,
      path: u.pathname + u.search, headers, timeout: timeoutMs || 20000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时: ' + method + ' ' + url)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitHealthy(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await request('GET', url, undefined, null, 2000);
      if (r.status === 200) return true;
    } catch (e) { /* 未就绪 */ }
    if (Date.now() > deadline) throw new Error(label + ' 在 ' + timeoutMs + 'ms 内未就绪: ' + url);
    await sleep(200);
  }
}

/* ---------- 种子：I1 有流水（禁删）/ I2 有销售 / I3 空壳 / I9 无引用（可删） ---------- */
const SEED = {
  rev: 1,
  data: {
    rest: '熊猫五福测试餐厅',
    config: {},
    ings: [
      { id: 'I1', name: '面粉', cat: '粮油', unit: '斤', buy: '斤', conv: 1, avg: 5, stock: 10, qty: 10, safe: 1, yld: 1, on: true },
      /* I2 用「期初」建账（不写流水），这样它只有销售引用、没有流水引用 */
      { id: 'I2', name: '猪肉', cat: '肉类', unit: '斤', buy: '斤', conv: 1, avg: 20, stock: 6, qty: 6, initStock: 6, initAvg: 20, safe: 1, yld: 1, on: true },
      { id: 'I3', name: '青菜', cat: '蔬菜', unit: '斤', buy: '斤', conv: 1, avg: 3, stock: 0, qty: 0, safe: 0, yld: 1, on: true },
      { id: 'I9', name: '误建测试料', cat: '其他', unit: '斤', buy: '斤', conv: 1, avg: 0, stock: 0, qty: 0, safe: 0, yld: 1, on: true }
    ],
    /* I1 的期初流水：既是均价来源，也是「有流水禁删」的引用证据 */
    logs: [{ type: '手工调整', ing: 'I1', date: '2026-10-01', qty: 10, inCost: 5, ref: '期初', source: 'seed' }],
    quotes: [],
    orders: [],
    recv: [],
    sales: [{ id: 'S1', date: '2026-10-02', amount: 20, lines: [{ ing: 'I2', qty: 0.5 }] }]
  },
  ext: {}
};

/** 队列三段式：入队 → 确认 → 执行（BFF 侧 apply） */
async function runAction(base, token, type, payload) {
  const enq = await request('POST', base + '/api/actions', { type, payload, operator: 'boss' }, token);
  ok(enq.status === 200 && enq.body && enq.body.ok && !!enq.body.id, '入队 ' + type, enq.body);
  const id = enq.body.id;
  const cf = await request('POST', base + '/api/actions/' + id + '/confirm', { operator: 'boss', rev: enq.body.rev }, token);
  ok(cf.status === 200 && cf.body && cf.body.ok, '确认 ' + type + '（rev 乐观锁通过）', cf.body);
  const ap = await request('POST', base + '/api/actions/' + id + '/apply', {}, token);
  ok(ap.status === 200, '执行 ' + type + ' 返回 200', ap.body);
  return { id, apply: ap.body };
}

/** 期望被执行器驳回（返回驳回原因） */
async function runActionExpectReject(base, token, type, payload, kw) {
  const { apply } = await runAction(base, token, type, payload);
  const err = String((apply && apply.error) || '');
  ok(apply && apply.ok === false && apply.status === '已驳回', type + ' 被执行器驳回', apply);
  ok(kw && err.indexOf(kw) >= 0, type + ' 驳回原因含「' + kw + '」', err);
  return err;
}

async function snapshotOf(base, token) {
  const r = await request('GET', base + '/api/snapshot/latest', undefined, token);
  ok(r.status === 200 && r.body && r.body.data, '读取快照 /api/snapshot/latest', r.status);
  return r.body.data;
}

function ingOf(data, id) { return (data.ings || []).find((g) => g && String(g.id) === id) || null; }

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canteenai-adr013b3-'));
  const bffDataDir = path.join(tmpDir, 'bff-data');
  fs.mkdirSync(bffDataDir, { recursive: true });
  let bffChild = null;

  step(0, '环境与隔离目录');
  info('临时目录: ' + tmpDir + '（Node ' + process.versions.node + '）');

  try {
    step(1, '起 BFF（隔离数据目录）并铺快照');
    const port = await freePort();
    const base = 'http://127.0.0.1:' + port;
    bffChild = spawn(process.execPath, [path.join(BFF_DIR, 'server.js')], {
      cwd: BFF_DIR,
      env: Object.assign({}, process.env, {
        BFF_PORT: String(port), BFF_HOST: '127.0.0.1', BFF_DATA_DIR: bffDataDir, SI_SCHEDULER: '0'
      }),
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    bffChild.stdout.on('data', (d) => { bffLog += d.toString(); if (VERBOSE) line('[bff] ' + d.toString().trimEnd()); });
    bffChild.stderr.on('data', (d) => { bffLog += d.toString(); if (VERBOSE) line('[bff!] ' + d.toString().trimEnd()); });
    await waitHealthy(base + '/api/health', 30000, 'BFF');
    const login = await request('POST', base + '/api/auth/login', { account: 'boss', password: 'wufu123', device_fp: 'adr013-b3' });
    ok(login.status === 200 && login.body.ok && !!login.body.token, '老板登录取得 token');
    const token = login.body.token;
    const push = await request('POST', base + '/api/snapshot/push', { rev: 1, data: SEED.data, ext: SEED.ext, machine: 'ADR013-B3' }, token);
    ok(push.status === 200 && push.body.ok === true, '快照推送成功（rev=1）', push.body);

    /* ---------------- W3-01 手工校准 ---------------- */
    step(2, 'W3-01 只改均价（stock.count 带 avg，不传 real_qty）');
    const calib = await runAction(base, token, 'stock.count', {
      ing_id: 'I1', name: '面粉', avg: 6.5, note: '供应商调价核对'
    });
    ok(calib.apply.ok === true, '校准动作执行成功', calib.apply);
    ok(/均价5\.0→6\.5/.test(String(calib.apply.result)), '回执写明均价 5.0→6.5', calib.apply.result);

    let data = await snapshotOf(base, token);
    let i1 = ingOf(data, 'I1');
    ok(i1.stock === 10, '数量不变（库存仍 10 斤）', i1.stock);
    ok(i1.avg === 6.5, '均价已改为 6.5', i1.avg);
    ok(i1.stock * i1.avg === 65, '库存总值不为 0（10×6.5=65）', i1.stock * i1.avg);
    const lastLog = data.logs[data.logs.length - 1];
    ok(lastLog.type === '手工调整' && lastLog.ing === 'I1', '台账新增一条「手工调整」流水', lastLog);
    ok(lastLog.inCost === 6.5 && lastLog.qty === 10, '流水 inCost=6.5 / qty=10（rebuild 据此回写均价）', lastLog);
    ok(/供应商调价核对/.test(String(lastLog.note)), '流水 note 记录了校准原因', lastLog.note);

    step(3, 'W3-01 普通盘点不再把均价清 0（原缺陷回归）');
    const count = await runAction(base, token, 'stock.count', {
      ing_id: 'I2', name: '猪肉', book_qty: 6, real_qty: 5, note: '月末盘点'
    });
    ok(count.apply.ok === true, '盘点动作执行成功', count.apply);
    data = await snapshotOf(base, token);
    const i2 = ingOf(data, 'I2');
    ok(i2.stock === 5, '实盘数落账（6 → 5）', i2.stock);
    ok(i2.avg === 20, '盘点后均价保留 20（不再清 0）', i2.avg);
    ok(i2.stock * i2.avg === 100, '库存总值 5×20=100，不为 0 元', i2.stock * i2.avg);

    step(4, 'W3-01 红线：校准缺原因一律驳回（不静默降级）');
    await runActionExpectReject(base, token, 'stock.count', { ing_id: 'I1', name: '面粉', avg: 7 }, '必须填写原因');
    data = await snapshotOf(base, token);
    ok(ingOf(data, 'I1').avg === 6.5, '被驳回后均价仍是 6.5（未被篡改）', ingOf(data, 'I1').avg);

    /* ---------------- W3-02 批量设置 ---------------- */
    step(5, 'W3-02 ing.batch：一次动作改 3 个原料');
    const beforeQueue = await request('GET', base + '/api/actions', undefined, token);
    const batchBefore = (beforeQueue.body.items || []).filter((a) => a.type === 'ing.batch').length;
    const batch = await runAction(base, token, 'ing.batch', { ids: ['I1', 'I2', 'I3'], safe: 8, yld: 0.85 });
    ok(batch.apply.ok === true, '批量动作执行成功', batch.apply);
    ok(/更新 3 个原料/.test(String(batch.apply.result)), '回执写明更新 3 个原料', batch.apply.result);

    data = await snapshotOf(base, token);
    for (const id of ['I1', 'I2', 'I3']) {
      const g = ingOf(data, id);
      ok(g.safe === 8 && g.safety === 8, id + ' 安全线批量改为 8（safe/safety 同步）', [g.safe, g.safety]);
      ok(g.yld === 0.85, id + ' 出成率批量改为 0.85', g.yld);
    }
    ok(ingOf(data, 'I1').avg === 6.5 && ingOf(data, 'I1').stock === 10,
      '批量改主数据不碰存量（I1 库存/均价不变）', [ingOf(data, 'I1').stock, ingOf(data, 'I1').avg]);

    const afterQueue = await request('GET', base + '/api/actions', undefined, token);
    const batchAfter = (afterQueue.body.items || []).filter((a) => a.type === 'ing.batch').length;
    ok(batchAfter - batchBefore === 1, '勾 3 个原料只产生 1 条队列动作（1 次审批）', [batchBefore, batchAfter]);

    step(6, 'W3-02 零命中驳回');
    await runActionExpectReject(base, token, 'ing.batch', { ids: ['GHOST'], safe: 1 }, '零命中');

    /* ---------------- W3-03 删除原料 ---------------- */
    step(7, 'W3-03 有流水引用 → 禁删并提示改「停用」');
    const errLog = await runActionExpectReject(base, token, 'ing.delete', { id: 'I1' }, '库存流水');
    ok(/停用/.test(errLog), '错误信息明确提示「改为停用」', errLog);
    data = await snapshotOf(base, token);
    ok(!!ingOf(data, 'I1'), '被拒后原料仍在（未物理删）', !!ingOf(data, 'I1'));

    step(8, 'W3-03 有销售引用 → 禁删');
    await runActionExpectReject(base, token, 'ing.delete', { id: 'I2' }, '出餐销售');

    step(9, 'W3-03 无引用原料 → 真删');
    const del = await runAction(base, token, 'ing.delete', { id: 'I9' });
    ok(del.apply.ok === true, '删除动作执行成功', del.apply);
    ok(/ing 删除 I9/.test(String(del.apply.result)), '回执写明删除了 I9', del.apply.result);
    data = await snapshotOf(base, token);
    ok(!ingOf(data, 'I9'), 'I9 已从 data.ings 移除', (data.ings || []).map((g) => g.id));

    step(10, 'W3-03 正解：改为停用（ing.upsert on:false，台账保留）');
    const off = await runAction(base, token, 'ing.upsert', { id: 'I1', on: false });
    ok(off.apply.ok === true, '停用动作执行成功', off.apply);
    data = await snapshotOf(base, token);
    ok(ingOf(data, 'I1').on === false, 'I1 已停用（on:false）', ingOf(data, 'I1').on);
    ok(data.logs.some((l) => l && l.ing === 'I1'), '历史流水仍在（红线 #6 不物理删台账）', true);

    line('');
    line('== ADR-013 第 3 批活体验证全部通过（' + CHECKS + ' 项）==');
  } catch (e) {
    line('');
    line('!! 验证失败: ' + (e && e.message ? e.message : e));
    if (VERBOSE || !bffLog) line('--- BFF 日志 ---\n' + bffLog);
    process.exitCode = 1;
  } finally {
    if (bffChild) {
      try { bffChild.kill(); } catch (e) { /* ignore */ }
      await sleep(300);
    }
    if (!KEEP) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    } else {
      line('  · 保留临时目录: ' + tmpDir);
    }
  }
}

main();
