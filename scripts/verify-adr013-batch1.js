#!/usr/bin/env node
'use strict';
/*
 * scripts/verify-adr013-batch1.js — ADR-013 第 1 批（W2-03 / W3-04 / W2-02）活体验证
 *
 * 只驱动 BFF 公开 HTTP API，隔离在临时 BFF_DATA_DIR + 随机端口，不污染真实快照。
 * 覆盖：
 *   W2-03 待比价任务导出   GET /api/export/quote-task.json（panda-quote-task v1 契约 / 耗材与停用原料排除 / 只读）
 *   W3-04 原料行比价入口   POST /api/supply/quote（弹窗提交同一端点）→ 队列执行 → 原料比价表可见
 *   W2-02 删除单条报价     POST /api/supply/quote/delete → 队列执行 → 该行消失、其余报价不变；
 *                          零命中 → 动作置「已驳回」并带「未命中」错误（红线 #7 不静默降级）
 *
 * 用法：node scripts/verify-adr013-batch1.js [--verbose] [--keep]
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

const TODAY = new Date().toISOString().slice(0, 10);
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
        try { parsed = JSON.parse(raw); } catch (e) { /* 非 JSON（导出文件） */ }
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

/* ---------- 种子快照：2 在售食材 + 1 耗材 + 1 停用，报价为空 ---------- */
const SEED = {
  rev: 1,
  data: {
    rest: '熊猫五福测试餐厅',
    config: {},
    ings: [
      { id: 'I1', name: '东古一品鲜500ml', cat: '干调类', unit: '瓶', buy: '瓶', conv: 1, avg: 8.1, stock: 6, safe: 2, on: true },
      { id: 'I2', name: '海天苹果醋450ml', cat: '干调类', unit: '瓶', buy: '瓶', conv: 1, avg: 6.48, stock: 4, safe: 2, on: true },
      { id: 'I3', name: '一次性手套', cat: '耗材', unit: '盒', buy: '盒', conv: 1, avg: 20, stock: 3, safe: 1, on: true, type: 'consumable' },
      { id: 'I4', name: '停用菜', cat: '蔬菜', unit: '斤', buy: '斤', conv: 1, avg: 2, stock: 0, safe: 0, on: false }
    ],
    quotes: [],
    logs: [],
    orders: [],
    recv: [],
    sales: []
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

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canteenai-adr013b1-'));
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
    const login = await request('POST', base + '/api/auth/login', { account: 'boss', password: 'wufu123', device_fp: 'adr013-b1' });
    ok(login.status === 200 && login.body.ok && !!login.body.token, '老板登录取得 token');
    const token = login.body.token;
    const push = await request('POST', base + '/api/snapshot/push', { rev: 1, data: SEED.data, ext: SEED.ext, machine: 'ADR013-B1' }, token);
    ok(push.status === 200 && push.body.ok === true, '快照推送成功（rev=1）', push.body);

    /* ---------------- W2-03 待比价任务导出 ---------------- */
    step(2, 'W2-03 GET /api/export/quote-task.json（panda-quote-task v1）');
    const t = await request('GET', base + '/api/export/quote-task.json', undefined, token);
    ok(t.status === 200, '导出端点 200', t.status);
    ok(/application\/json/.test(t.headers['content-type'] || ''), 'Content-Type = application/json', t.headers['content-type']);
    ok(/attachment/.test(t.headers['content-disposition'] || '')
      && /filename\*=UTF-8''/.test(t.headers['content-disposition'] || ''),
      '带附件下载头（含中文 filename*）', t.headers['content-disposition']);
    let task = null;
    try { task = JSON.parse(t.raw); } catch (e) { task = null; }
    ok(task && task.type === 'panda-quote-task' && task.version === 1, '契约头 type/version 对齐旧版', task && [task.type, task.version]);
    ok(task && task.rest === '熊猫五福测试餐厅', 'rest 取 data.rest', task && task.rest);
    ok(task && /fetch_quotes\.py/.test(String(task.guide)), 'guide 指向外部比价脚本 fetch_quotes.py');
    ok(task && task.items.length === 2, 'items = 2 种在售食材（耗材 / 停用已排除）', task && task.items.map((x) => x.ingId));
    const KEYS = ['ingId', 'ingName', 'cat', 'unit', 'buy', 'conv', 'avg', 'keyword', 'taskDate'];
    ok(task.items.every((it) => Object.keys(it).sort().join(',') === KEYS.slice().sort().join(',')),
      '单条字段 = 旧版 9 键（外部脚本可直接消费）', Object.keys(task.items[0] || {}));
    ok(task.items.find((x) => x.ingId === 'I1').keyword === '东古一品鲜',
      '关键词净化去掉规格/容量（东古一品鲜500ml → 东古一品鲜）', task.items.find((x) => x.ingId === 'I1').keyword);
    ok(task.items.every((x) => x.taskDate === TODAY), 'taskDate = 今天', task.items.map((x) => x.taskDate));

    /* ---------------- W3-04 原料行比价入口（报价录入） ---------------- */
    step(3, 'W3-04 报价录入（弹窗提交的同一端点 /api/supply/quote）');
    const q1 = await request('POST', base + '/api/supply/quote',
      { ing: 'I1', name: '东古一品鲜500ml', src: '甲供应商', price: 8.0, per: 'buy', unit: '瓶' }, token);
    ok(q1.status === 200 && q1.body.ok && !!q1.body.action_id, '报价 甲供应商 → 入队 quote.upsert', q1.body);
    const q2 = await request('POST', base + '/api/supply/quote',
      { ing: 'I1', name: '东古一品鲜500ml', src: '乙供应商', price: 7.5, per: 'buy', unit: '瓶' }, token);
    ok(q2.status === 200 && q2.body.ok, '报价 乙供应商 → 入队 quote.upsert');
    const q3 = await request('POST', base + '/api/supply/quote',
      { ing: 'I2', name: '海天苹果醋450ml', src: '丙供应商', price: 6.2, per: 'buy', unit: '瓶' }, token);
    ok(q3.status === 200 && q3.body.ok, '报价 丙供应商（另一原料）→ 入队');

    for (const [id, rev] of [[q1.body.action_id, q1.body.rev], [q2.body.action_id, q2.body.rev], [q3.body.action_id, q3.body.rev]]) {
      await request('POST', base + '/api/actions/' + id + '/confirm', { operator: 'boss', rev }, token);
      const ap = await request('POST', base + '/api/actions/' + id + '/apply', {}, token);
      ok(ap.status === 200 && ap.body.ok === true, '确认+执行 quote.upsert ' + id + '（快照落库）', ap.body);
    }
    const p1 = await request('GET', base + '/api/admin/price', undefined, token);
    const rowI1 = p1.body.report.rows.find((r) => r.ingId === 'I1');
    const rowI2 = p1.body.report.rows.find((r) => r.ingId === 'I2');
    ok(!!rowI1 && rowI1.quotes.length === 2, '原料比价表：I1 有 2 条报价（供应商比价可展开）', rowI1 && rowI1.quotes.map((x) => x.src));
    ok(rowI1.best && rowI1.best.src === '乙供应商' && rowI1.best.price === 7.5, '外部最低报价 = 乙供应商 ¥7.5', rowI1 && rowI1.best);
    ok(rowI1.diff === -0.6, '与本店均价 8.1 的差价 = -0.6（外价更低）', rowI1 && rowI1.diff);
    ok(!!rowI2 && rowI2.quotes.length === 1, '原料比价表：I2 有 1 条报价', rowI2 && rowI2.quotes.length);
    ok(p1.body.plan.items.find((x) => x.ingId === 'I1').status === '已比价',
      '待比价清单状态翻为「已比价」', p1.body.plan.items);

    /* ---------------- W2-02 删除单条报价 ---------------- */
    step(4, 'W2-02 POST /api/supply/quote/delete（单条删除，其余不变）');
    const delBad = await request('POST', base + '/api/supply/quote/delete', {}, token);
    ok(delBad.status === 400, '缺 id / ing+src → 400 拒绝', delBad.body && delBad.body.error);
    const del = await request('POST', base + '/api/supply/quote/delete', { ing: 'I1', src: '甲供应商' }, token);
    ok(del.status === 200 && del.body.ok && !!del.body.action_id, '删除 甲供应商报价 → 入队 quote.delete', del.body);
    await request('POST', base + '/api/actions/' + del.body.action_id + '/confirm', { operator: 'boss', rev: del.body.rev }, token);
    const apDel = await request('POST', base + '/api/actions/' + del.body.action_id + '/apply', {}, token);
    ok(apDel.body.ok === true && /quote 删除/.test(String(apDel.body.result)), '执行器回执 = quote 删除', apDel.body);

    const p2 = await request('GET', base + '/api/admin/price', undefined, token);
    const rowI1b = p2.body.report.rows.find((r) => r.ingId === 'I1');
    const rowI2b = p2.body.report.rows.find((r) => r.ingId === 'I2');
    ok(rowI1b.quotes.length === 1 && rowI1b.quotes[0].src === '乙供应商',
      '比价表少一行：I1 只剩乙供应商', rowI1b.quotes.map((x) => x.src));
    ok(rowI2b.quotes.length === 1 && rowI2b.quotes[0].src === '丙供应商',
      '其余原料报价不受影响（I2 仍 1 条）', rowI2b.quotes.map((x) => x.src));
    ok(rowI1b.best.price === 7.5, '最低报价不变（¥7.5）', rowI1b.best);

    step(5, 'W2-02 红线：删除零命中必须显式报错（不静默降级）');
    const delMiss = await request('POST', base + '/api/supply/quote/delete', { ing: 'I1', src: '不存在的供应商' }, token);
    ok(delMiss.status === 200 && delMiss.body.ok, '入队成功（请求本身合法）', delMiss.body);
    await request('POST', base + '/api/actions/' + delMiss.body.action_id + '/confirm', { operator: 'boss', rev: delMiss.body.rev }, token);
    const apMiss = await request('POST', base + '/api/actions/' + delMiss.body.action_id + '/apply', {}, token);
    ok(apMiss.body.ok === false && apMiss.body.status === '已驳回' && /未命中/.test(String(apMiss.body.error)),
      '执行器判零命中 → 动作置「已驳回」并带未命中原因', apMiss.body);

    step(6, '收尾：快照内报价数 = 2（删 1 剩 2），导出口径同步');
    const snap = await request('GET', base + '/api/snapshot/latest', undefined, token);
    ok(snap.body.data.quotes.length === 2, 'data.quotes 共 2 条（乙 / 丙）', snap.body.data.quotes.map((q) => q.src));
    const t2 = await request('GET', base + '/api/export/quote-task.json', undefined, token);
    const task2 = JSON.parse(t2.raw);
    ok(task2.items.length === 2 && task2.items.every((x) => typeof x.avg === 'number'),
      '导出仍为 2 种在售食材（与库存口径一致）', task2.items.length);

    line('');
    line('== ADR-013 第 1 批活体验证全部通过（' + CHECKS + ' 项）==');
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
