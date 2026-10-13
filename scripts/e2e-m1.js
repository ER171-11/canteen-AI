#!/usr/bin/env node
'use strict';
/**
 * M1 经营分析 · 接口层数据契约冒烟（TST-M1-01/02/03 可自动部分）。
 * 隔离数据（BFF_DATA_DIR=临时目录，不污染真实库），验证 /api/analysis/* 的数据供给：
 *   - trend 按日聚合口径与快照 sales 一致、start/end 过滤
 *   - heat 24h×7 结构合法、双峰缺口
 *   - matrix 逐菜字段与象限枚举
 *   - efficiency 三率字段
 *   - 空态降级与 401
 * 说明：TST-M1-04（usePeriodSwitch 切换/回退）为前端状态机，属 UI 层，见文末提示。
 * 用法：node scripts/e2e-m1.js
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
const pad = (n) => String(n).padStart(2, '0');
function ymd(offsetDays) { const d = new Date(Date.now() - offsetDays * 86400000); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

/* ---- 构造夹具：9 款饺子 × 28 天，双峰在 12h/18h ---- */
const DUMPLINGS = [
  { name: '韭菜鸡蛋饺', price: 28, margin: 0.62 },
  { name: '猪肉白菜饺', price: 26, margin: 0.58 },
  { name: '虾仁三鲜饺', price: 32, margin: 0.66 },
  { name: '牛肉芹菜饺', price: 30, margin: 0.60 },
  { name: '酸菜猪肉饺', price: 24, margin: 0.55 },
  { name: '玉米鲜虾饺', price: 29, margin: 0.64 },
  { name: '香菇鸡肉饺', price: 27, margin: 0.61 },
  { name: '羊肉胡萝卜饺', price: 33, margin: 0.59 },
  { name: '素三鲜饺', price: 22, margin: 0.52 },
];
const HOURS = [11, 12, 12, 12, 18, 18, 18, 19, 20];
const DAYS = 28;
function buildFixture() {
  const dishes = DUMPLINGS.map((d, i) => ({ id: 'D' + (i + 1), name: d.name, sku_id: 'SKU-' + (i + 1), price: d.price, gross_margin: d.margin }));
  const sales = [];
  let total = 0;
  for (let off = DAYS - 1; off >= 0; off--) {
    const date = ymd(off);
    DUMPLINGS.forEach((d, i) => {
      const qty = 2 + (i % 3);
      const amount = d.price * qty;
      total += amount;
      sales.push({ ts: date + ' ' + pad(HOURS[i]) + ':00:00', dish: d.name, qty, amount });
    });
  }
  return { dishes, sales, total: +total.toFixed(2) };
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-'));
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, [path.join(BFF_DIR, 'server.js')], {
    cwd: BFF_DIR,
    env: Object.assign({}, process.env, { BFF_PORT: String(port), BFF_HOST: '127.0.0.1', BFF_DATA_DIR: dataDir, SI_SCHEDULER: '0' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  const fx = buildFixture();
  try {
    let up = false;
    for (let i = 0; i < 60; i++) { try { const r = await request('GET', base + '/api/health'); if (r.status === 200) { up = true; break; } } catch (e) {} await sleep(300); }
    ok(up, 'BFF 启动可达 /api/health');

    const unauthorized = await request('GET', base + '/api/analysis/trend');
    ok(unauthorized.status === 401, '未登录 /api/analysis/trend → 401', unauthorized.status);

    const login = await request('POST', base + '/api/auth/login', { account: 'boss', password: 'wufu123' });
    ok(login.status === 200 && login.body && login.body.token, 'boss 登录取得 token', login.status);
    const token = login.body.token;

    await request('POST', base + '/api/snapshot/push', { rev: 301, data: { dishes: fx.dishes, sales: fx.sales } }, token);

    /* ---------- M1-01 数据源：聚合正确 ---------- */
    line('\n== M1-01 数据源 data.sales 聚合 ==');
    const mod = await request('GET', base + '/api/modules/analysis', null, token);
    ok(mod.status === 200 && mod.body.mock === false, '/api/modules/analysis → 真实聚合（mock=false）', mod.body && mod.body.mock);
    const trend = await request('GET', base + '/api/analysis/trend', null, token);
    ok(trend.status === 200 && Array.isArray(trend.body.data), 'GET /api/analysis/trend → data 数组', trend.status);
    const t = trend.body.data;
    ok(t.length === DAYS, 'trend 按日聚合 = ' + DAYS + ' 天', t.length);
    ok(t.every((p) => p.date && typeof p.revenue === 'number' && typeof p.orders === 'number'), 'trend 行字段 {date,revenue,orders} 齐全');
    const sumRev = +t.reduce((s, p) => s + p.revenue, 0).toFixed(2);
    ok(Math.abs(sumRev - fx.total) < 0.01, 'trend 营收合计与快照口径一致 = ' + fx.total, sumRev);
    const sumOrders = t.reduce((s, p) => s + p.orders, 0);
    ok(sumOrders === DAYS * DUMPLINGS.length, 'trend 订单数 = 快照记录数 ' + (DAYS * DUMPLINGS.length), sumOrders);

    /* ---------- M1-02 趋势+热力 ---------- */
    line('\n== M1-02 趋势(an-trend) + 热力(an-heat) 数据 ==');
    ok(t.length >= 28, '趋势覆盖 ≥4 周（' + t.length + ' 天）供折线+周柱');
    const f = await request('GET', base + '/api/analysis/trend?start_date=' + ymd(6) + '&end_date=' + ymd(0), null, token);
    ok(Array.isArray(f.body.data) && f.body.data.length === 7, 'trend start_date/end_date 过滤 = 近 7 天', f.body.data && f.body.data.length);
    const heat = await request('GET', base + '/api/analysis/heat', null, token);
    const h = heat.body.data;
    ok(Array.isArray(h) && h.length > 0, 'GET /api/analysis/heat → 非空', h && h.length);
    ok(h.every((c) => c.hour >= 0 && c.hour <= 23 && c.weekday >= 0 && c.weekday <= 6), 'heat 单元格 hour∈[0,23] × weekday∈[0,6]');
    ok(h.length <= 24 * 7, 'heat 单元格数 ≤ 168（24h×7）', h.length);
    const peak = h.slice().sort((a, b) => b.revenue - a.revenue)[0];
    const peak2 = h.slice().sort((a, b) => b.revenue - a.revenue)[1];
    ok(peak && peak2 && (peak.hour !== peak2.hour || peak.weekday !== peak2.weekday), '热力存在可标注的 Top2 峰（双峰）', peak && [peak.hour, peak2 && peak2.hour]);
    line('  · 峰值时段：周' + peak.weekday + ' ' + peak.hour + ':00 ¥' + peak.revenue);

    /* ---------- M1-03 矩阵+效率 ---------- */
    line('\n== M1-03 矩阵(an-mx) + 效率(an-eff) 数据 ==');
    const mx = await request('GET', base + '/api/analysis/matrix', null, token);
    const rows = mx.body.data;
    ok(Array.isArray(rows) && rows.length >= DUMPLINGS.length, 'matrix 菜品数 ≥ 9 款饺子（' + (rows && rows.length) + '）', rows && rows.length);
    const QUAD = ['star', 'puzzle', 'cow', 'dog'];
    ok(rows.every((r) => r.name && typeof r.volume === 'number' && typeof r.margin === 'number' && QUAD.indexOf(r.quadrant) >= 0),
      'matrix 行字段 {name,volume,margin,quadrant∈四象限} 合法');
    const usedQ = {}; rows.forEach((r) => (usedQ[r.quadrant] = 1));
    ok(Object.keys(usedQ).every((q) => QUAD.indexOf(q) >= 0), '矩阵全部象限取自 {star,puzzle,cow,dog}', Object.keys(usedQ));
    line('  · 象限分布：' + JSON.stringify(rows.reduce((m, r) => (m[r.quadrant] = (m[r.quadrant] || 0) + 1, m), {})));
    const eff = await request('GET', base + '/api/analysis/efficiency', null, token);
    const e = eff.body.data;
    ok(e && typeof e.avg_ticket === 'number', 'efficiency.avg_ticket 数值（客单价）', e && e.avg_ticket);
    ok(e && 'turnover' in e && 'revenue_per_sqm' in e && 'revenue_per_staff' in e, 'efficiency 含翻台/坪效/人效三率字段', e && [e.turnover, e.revenue_per_sqm, e.revenue_per_staff]);
    line('  · 三率：翻台 ' + e.turnover + ' / 坪效 ' + e.revenue_per_sqm + ' / 人效 ' + e.revenue_per_staff + '（基准 area=' + e.area + ',staff=' + e.staff + ',tables=' + e.tables + '）');

    /* ---------- 空态降级 ---------- */
    line('\n== 空态降级（无 data.sales） ==');
    await request('POST', base + '/api/snapshot/push', { rev: 302, data: { dishes: fx.dishes } }, token);
    const modEmpty = await request('GET', base + '/api/modules/analysis', null, token);
    ok(modEmpty.body.mock === true, '无 sales → /api/modules/analysis mock:true 降级（非缺陷）', modEmpty.body && modEmpty.body.mock);
    const trendEmpty = await request('GET', base + '/api/analysis/trend', null, token);
    ok(trendEmpty.status === 200 && Array.isArray(trendEmpty.body.data) && trendEmpty.body.data.length === 0, '无 sales → /api/analysis/trend 返回空数组（不报错）', trendEmpty.body && trendEmpty.body.data && trendEmpty.body.data.length);
    const effEmpty = await request('GET', base + '/api/analysis/efficiency', null, token);
    ok(effEmpty.status === 200, '无 sales → /api/analysis/efficiency 仍 200 降级', effEmpty.status);

    line('\n===== M1 接口层契约：' + CHECKS + ' 条断言全绿 =====');
    line('提示：TST-M1-04（时段切换切换/回退）属前端状态机，需 UI 层（Playwright）或人工验证。');
  } catch (e) {
    line('\n✗ ' + (e && e.message));
    line('--- BFF 日志尾部 ---\n' + log.split(/\r?\n/).slice(-15).join('\n'));
    process.exitCode = 1;
  } finally {
    try { child.kill(); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }
})();
