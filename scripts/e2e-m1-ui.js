#!/usr/bin/env node
'use strict';
/**
 * M1 经营分析 · UI 层冒烟（Playwright + 真实 BFF/vite）
 * 覆盖 TST-M1-01~04 的「页面渲染 + 时段切换」：
 *   - an-trend：折线 svg[aria-label=营收趋势] 的 path/circle、周柱卡、5 段时段选择器
 *   - an-heat ：7×24 热力表格、双峰标注、点击下钻
 *   - an-mx   ：气泡 svg[aria-label=波士顿矩阵]、2 条中位基准虚线、点击下钻（成本待测算）
 *   - an-eff  ：3 个 dashboard 仪表
 *   - M1-04   ：时段切换成功刷新 / 失败红字 / 命中缓存回退不白屏
 * 前置：apps/admin-web 已 `npm i -D playwright` 且 `npx playwright install chromium`。
 * 用法：node scripts/e2e-m1-ui.js   （自动起 BFF:8787 隔离数据 + vite:5173，跑完自清理）
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BFF_DIR = path.join(ROOT, 'bff');
const WEB_DIR = path.join(ROOT, 'apps', 'admin-web');
const BFF_PORT = 8787;
const WEB_PORT = 5173;
const BASE = 'http://127.0.0.1:' + BFF_PORT;
const WEB = 'http://127.0.0.1:' + WEB_PORT;
let CHECKS = 0;
const procs = [];

function line(m) { process.stdout.write(m + '\n'); }
function ok(cond, msg, extra) {
  if (!cond) throw new Error('断言失败: ' + msg + (extra === undefined ? '' : ' | 实际: ' + JSON.stringify(extra)));
  CHECKS++; line('  ✓ ' + msg);
}
function request(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let payload = null;
    if (body !== undefined && body !== null) payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
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
async function waitHttp(url, tries) {
  for (let i = 0; i < (tries || 80); i++) { try { const r = await request('GET', url); if (r.status >= 200 && r.status < 500) return true; } catch (e) {} await sleep(400); }
  return false;
}
const pad = (n) => String(n).padStart(2, '0');
function ymd(off) { const d = new Date(Date.now() - off * 86400000); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

const DUMPLINGS = ['韭菜鸡蛋饺', '猪肉白菜饺', '虾仁三鲜饺', '牛肉芹菜饺', '酸菜猪肉饺', '玉米鲜虾饺', '香菇鸡肉饺', '羊肉胡萝卜饺', '素三鲜饺'];
const PRICE = [28, 26, 32, 30, 24, 29, 27, 33, 22];
const HOURS = [11, 12, 12, 12, 18, 18, 18, 19, 20];
const DAYS = 28;
function buildFixture() {
  const dishes = DUMPLINGS.map((n, i) => ({ id: 'D' + (i + 1), name: n, sku_id: 'SKU-' + (i + 1), price: PRICE[i], gross_margin: 0.6 }));
  const sales = [];
  for (let off = DAYS - 1; off >= 0; off--) {
    const date = ymd(off);
    DUMPLINGS.forEach((n, i) => { const q = 2 + (i % 3); sales.push({ ts: date + ' ' + pad(HOURS[i]) + ':00:00', dish: n, qty: q, amount: PRICE[i] * q }); });
  }
  return { dishes, sales };
}

function killTree(pid) { try { execSync('taskkill /PID ' + pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { /* 已退出 */ } }

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1ui-'));
  const fixture = buildFixture();
  let browser = null;
  try {
    /* ---- 起 BFF（8787，隔离数据） ---- */
    const bff = spawn(process.execPath, [path.join(BFF_DIR, 'server.js')], {
      cwd: BFF_DIR,
      env: Object.assign({}, process.env, { BFF_PORT: String(BFF_PORT), BFF_HOST: '127.0.0.1', BFF_DATA_DIR: dataDir, SI_SCHEDULER: '0' }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    procs.push(bff.pid);
    let bffLog = ''; bff.stdout.on('data', (d) => (bffLog += d)); bff.stderr.on('data', (d) => (bffLog += d));
    ok(await waitHttp(BASE + '/api/health'), 'BFF 启动（127.0.0.1:' + BFF_PORT + '，隔离 BFF_DATA_DIR）');

    const login = await request('POST', BASE + '/api/admin/login', { account: 'boss', password: 'wufu123' });
    ok(login.status === 200 && login.body && login.body.token, 'admin-web 登录 /api/admin/login 取得 token', login.status);
    const auth = login.body;
    await request('POST', BASE + '/api/snapshot/push', { rev: 401, data: { dishes: fixture.dishes, sales: fixture.sales } }, auth.token);

    /* ---- 起 vite dev（5173，proxy /api → 8787） ---- */
    const web = spawn('npm run dev', { cwd: WEB_DIR, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(web.pid);
    let webLog = ''; web.stdout.on('data', (d) => (webLog += d)); web.stderr.on('data', (d) => (webLog += d));
    ok(await waitHttp(WEB + '/', 150), 'vite dev 启动（' + WEB + '）');

    /* ---- 启动 Chromium 并注入登录态（zustand persist: panda_admin_auth） ---- */
    const { chromium } = require(require.resolve('playwright', { paths: [WEB_DIR] }));
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const persisted = {
      state: {
        token: auth.token, role: auth.role, account: 'boss', expiresAt: auth.expires_at,
        storeId: auth.store_id || null, storeName: auth.store_name || null,
        permissions: auth.permissions || [], canWrite: !!auth.can_write
      }, version: 0
    };
    await ctx.addInitScript((data) => { try { window.localStorage.setItem('panda_admin_auth', JSON.stringify(data)); } catch (e) {} }, persisted);
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message)));

    /* ============ M1-01 数据源：页面能取到真实数据（非空态） ============ */
    line('\n== M1-01 数据源（页面取真实聚合） ==');
    await page.goto(WEB + '/ops/an-trend', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('svg[aria-label="营收趋势"]', { timeout: 20000 });
    ok(true, 'an-trend 渲染出「营收趋势」折线（有数据，未落空态）');
    const noMockBadge = await page.locator('text=暂无销售流水').count();
    ok(noMockBadge === 0, '页面未出现「暂无销售流水」空态提示', noMockBadge);

    /* ============ M1-02 趋势 + 热力 ============ */
    line('\n== M1-02 趋势(an-trend) + 热力(an-heat) ==');
    const tCircles = await page.locator('svg[aria-label="营收趋势"] circle').count();
    const tPaths = await page.locator('svg[aria-label="营收趋势"] path').count();
    ok(tCircles === DAYS, '折线数据点 = ' + DAYS + ' 天（circle 数）', tCircles);
    ok(tPaths >= 2, '折线含面积+线两条 path', tPaths);
    ok(await page.locator('.ant-segmented-item').count() === 5, '时段选择器 5 段（今日/昨日/本周/上周/本月）');
    ok(await page.locator('text=各色周表现').count() >= 1, '周柱对比卡「各色周表现」存在');

    await page.goto(WEB + '/ops/an-heat', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('table tbody td[title]', { timeout: 20000 });
    const rows = await page.locator('table tbody tr').count();
    const cells = await page.locator('table tbody td').count();
    ok(rows === 7, '热力表 7 行（周日~周六）', rows);
    ok(cells === 7 * 25, '热力表 7×(1 标签+24 时) = ' + (7 * 25) + ' 格', cells);
    const dataCells = await page.locator('table tbody td[title]').count();
    ok(dataCells >= 1, '有营收数据的格子 ≥1（' + dataCells + '）');
    ok(await page.locator('text=双峰').count() >= 1, '双峰红字标注存在');
    ok(await page.locator('text=低').count() >= 1, '色阶图例存在');
    await page.locator('table tbody td[title]').first().click();
    await page.waitForSelector('text=下钻', { timeout: 5000 });
    ok(true, '点击热力格 → 弹出「下钻」卡片');

    /* ============ M1-03 矩阵 + 效率 ============ */
    line('\n== M1-03 矩阵(an-mx) + 效率(an-eff) ==');
    await page.goto(WEB + '/ops/an-mx', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('svg[aria-label="波士顿矩阵"]', { timeout: 20000 });
    const bCircles = await page.locator('svg[aria-label="波士顿矩阵"] circle').count();
    const bLines = await page.locator('svg[aria-label="波士顿矩阵"] line').count();
    ok(bCircles >= 9, '矩阵气泡数 ≥9（实测 ' + bCircles + '，含保本价盘）', bCircles);
    ok(bLines === 2, '2 条中位基准虚线（销量/毛利）', bLines);
    ok(await page.locator('text=毛利中位数基准').count() >= 1, '中位基准标注「毛利中位数基准」存在');
    await page.locator('svg[aria-label="波士顿矩阵"] circle').first().click({ force: true });
    await page.waitForSelector('text=成本待测算', { timeout: 5000 });
    ok(true, '点击气泡 → 下钻显示「成本待测算」');

    await page.goto(WEB + '/ops/an-eff', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ant-progress', { timeout: 20000 });
    const gauges = await page.locator('.ant-progress-inner').count();
    ok(gauges === 3, '效率页 3 个仪表（翻台/坪效/人效）', gauges);
    ok(await page.locator('text=翻台率').count() >= 1 && await page.locator('text=坪效').count() >= 1 && await page.locator('text=人效').count() >= 1,
      '三仪表标题「翻台率/坪效/人效」齐全');

    /* ============ M1-04 时段切换状态机 ============ */
    line('\n== M1-04 时段切换(usePeriodSwitch) ==');
    await page.goto(WEB + '/ops/an-trend', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('svg[aria-label="营收趋势"]', { timeout: 20000 });
    const seg = (label) => page.locator('.ant-segmented-item-label', { hasText: label });
    // 1) 正常切换成功
    await seg('今日').click();
    await sleep(1200);
    ok(await page.locator('svg[aria-label="营收趋势"]').count() === 1, '切换「今日」后图表仍在（成功刷新）');
    ok(await page.locator('text=数据异常').count() === 0, '正常切换无错误告警');
    // 2) 接口失败 + 无缓存周期 → 红字告警
    await page.route('**/api/analysis/trend*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    await seg('本月').click();
    await page.waitForSelector('text=数据异常', { timeout: 8000 });
    ok(true, '拦截接口 500 + 切到无缓存周期「本月」→ 红字「数据异常」');
    // 3) 命中 localStorage 缓存周期 → 回退不白屏
    await seg('本周').click();
    await sleep(1200);
    const backAlerts = await page.locator('.ant-alert-error').count();
    ok(backAlerts === 0 && await page.locator('svg[aria-label="营收趋势"]').count() === 1,
      '切回已缓存周期「本周」→ 命中缓存回退旧数据，不白屏（无错误告警）', backAlerts);
    await page.unroute('**/api/analysis/trend*');

    /* ---- 收尾 ---- */
    ok(pageErrors.length === 0, '全程无页面级 JS 异常', pageErrors);
    line('\n===== M1 UI 层：' + CHECKS + ' 条断言全绿 =====');
    line('提示：M1 为前端可视化，视觉美观/色阶观感/双峰业务合理性仍建议人工走查确认。');
  } catch (e) {
    line('\n✗ ' + (e && e.message));
    process.exitCode = 1;
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    for (const pid of procs) killTree(pid);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }
})();
