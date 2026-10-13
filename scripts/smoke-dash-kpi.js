#!/usr/bin/env node
/* 经营概览开箱冒烟（W1-01/02/03/05 + 阶段 27 FP-DASH-10/12/13/14）——零依赖：
 * Node 内置 http/WebSocket + 本机 Edge 的 CDP 端口，不装 puppeteer。
 *
 * 覆盖：
 *  1) 接口层 FP-DASH-01：?range=7|30|all → range/range_label/range_from/range_to 正确，
 *     非法值回落 30，不传 range 保持既有「当日」口径（range='1'）；
 *  2) 接口层 FP-DASH-06 采购应付（本期）：与快照独立重算一致，随周期变化；
 *  3) 接口层 FP-DASH-07 库存总值：与快照独立重算一致，且为时点值（不随周期变化）；
 *  4) 接口层 FP-DASH-11 低库存明细：total/items 与快照独立重算一致，含 name/cat/unit/qty/safe；
 *  5) 接口层 FP-DASH-10 逐日序列：14 天、末位=截止日、每日应收/实收与快照独立重算一致；
 *  6) 接口层 FP-DASH-13 挂账清单：每行 debt>0.01 且与「未收欠款」卡合计一致、按单日期倒序；
 *  7) 页面层：3 个周期 chips（默认近30天）+ 区间文字 + KPI 卡 + 低库存明细卡（含行内「去采购」）
 *     + 「每日应收 vs 实收（近14天）」卡（14 根日期轴）+「未收账款（客户挂账）」卡；
 *     点「近7天」→ chips 选中态与区间文字跟随、营收 KPI 变化；点「全部」→ 文字「全部时间（截至 …）」；
 *  8) 只读：GET-only（不点收款/去采购），snapshot.json / actions_queue.json 指纹全程未变 + 页面控制台 0 报错。
 *
 * 前置：BFF 已在 8787、vite dev 已在 5173（用同目录 smoke-dash-kpi.ps1 一键起停）。
 * 用法：node scripts/smoke-dash-kpi.js     退出码 0=通过
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');

const BFF = process.env.SMOKE_BFF || 'http://127.0.0.1:8787';
const WEB = process.env.SMOKE_WEB || 'http://127.0.0.1:5173';
const CDP_PORT = Number(process.env.SMOKE_CDP_PORT || 9222);
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'bff', 'data');

/** 只读冒烟：这两个文件全程不得改大小、不得改 mtime */
const WRITE_GUARD = ['snapshot.json', 'actions_queue.json'];

const results = [];
const ok = (cond, label, extra) => {
  results.push({ cond: !!cond, label });
  console.log((cond ? 'ok   ' : 'FAIL ') + label + (extra === undefined ? '' : '  | ' + JSON.stringify(extra)));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers, timeout: 30000 },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d.toString('utf8')));
        res.on('end', () => {
          let parsed = null;
          try { parsed = buf ? JSON.parse(buf) : null; } catch (e) { parsed = { raw: buf }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout ' + url)));
    if (payload) r.write(payload);
    r.end();
  });
}

function dataDigest() {
  const out = {};
  for (const f of WRITE_GUARD) {
    const p = path.join(DATA_DIR, f);
    if (!fs.existsSync(p)) { out[f] = 'absent'; continue; }
    const st = fs.statSync(p);
    out[f] = st.size + ':' + Math.round(st.mtimeMs);
  }
  return out;
}

/* --------------------------------------------------- 独立重算（不复用 BFF 代码） */
const snapRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'snapshot.json'), 'utf8'));
const SNAP_INGS = Array.isArray(snapRaw.data && snapRaw.data.ings) ? snapRaw.data.ings : [];
const SNAP_RECV = Array.isArray(snapRaw.data && snapRaw.data.recv) ? snapRaw.data.recv : [];
const SNAP_SALES = Array.isArray(snapRaw.data && snapRaw.data.sales) ? snapRaw.data.sales : [];

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
function todayStr() { return iso(new Date()); }
function minusDays(baseIso, n) { const d = new Date(baseIso + 'T00:00:00'); d.setDate(d.getDate() - n); return iso(d); }
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const statusEffective = (r) => {
  const st = String((r && r.status) || '已入库');
  if (/草稿|待验|取消|作废/i.test(st)) return false;
  return /已入库|done|入库/i.test(st);
};
const recDate = (r) => String((r && (r.date || r.ts || r.time)) || '').slice(0, 10);

/** 库存总值（旧版口径 Σ 库存 × 均价） */
const expStockValue = Math.round(SNAP_INGS.reduce((a, g) => a + num(g.stock) * num(g.avg), 0) * 100) / 100;
/** 低库存：现存 < 安全线（在售） */
const expLowItems = SNAP_INGS.filter(
  (g) => g.on !== false && num(g.qty != null ? g.qty : g.stock) < num(g.safe != null ? g.safe : g.safety)
);
const expLow = expLowItems;
/** 采购应付（本期） */
function expPayable(range) {
  const to = todayStr();
  const from = range === 'all' ? null : minusDays(to, (Number(range) || 30) - 1);
  return Math.round(
    SNAP_RECV.filter((r) => statusEffective(r) && recDate(r) && (!from || recDate(r) >= from) && recDate(r) <= to)
      .reduce((a, r) => a + num(r.payable != null ? r.payable : r.amount), 0) * 100
  ) / 100;
}
/** 营收（区间内销售记录金额合计） */
function expRevenue(range) {
  const to = todayStr();
  const from = range === 'all' ? null : minusDays(to, (Number(range) || 30) - 1);
  return Math.round(
    SNAP_SALES.filter((r) => recDate(r) && (!from || recDate(r) >= from) && recDate(r) <= to)
      .reduce((a, r) => a + num(r.amount), 0) * 100
  ) / 100;
}

/* 应收模型（照抄 ADR-008 口径，独立于 BFF 实现重算） */
const isVoid = (s) => /作废|void/i.test(String((s && s.status) || ''));
const recvOf = (s) => (s && s.receivable != null ? num(s.receivable) : num(s && s.amount));
const paysOf = (s) => {
  if (s && Array.isArray(s.payments)) return s.payments;
  const amt = num(s && s.amount);
  return amt > 0 ? [{ date: recDate(s), amount: amt }] : [];
};
const paidOf = (s) => Math.round(paysOf(s).reduce((a, p) => a + num(p && p.amount), 0) * 100) / 100;
const debtOf = (s) => Math.round(Math.max(0, recvOf(s) - paidOf(s)) * 100) / 100;

/** FP-DASH-10 逐日应收/实收（旧版 recvMap/gotMap，HTML:1258-1263） */
function expDailySeries(to, days) {
  const rows = [];
  for (let i = days - 1; i >= 0; i--) rows.push({ date: minusDays(to, i), receivable: 0, received: 0 });
  const at = {};
  for (const r of rows) at[r.date] = r;
  for (const s of SNAP_SALES) {
    if (isVoid(s)) continue;
    const on = at[recDate(s)];
    if (on) on.receivable += recvOf(s);
    for (const p of paysOf(s)) {
      const hit = at[String((p && p.date) || '').slice(0, 10)];
      if (hit) hit.received += num(p && p.amount);
    }
  }
  return rows.map((r) => {
    const receivable = Math.round(r.receivable * 100) / 100;
    const received = Math.round(r.received * 100) / 100;
    return { date: r.date, receivable, received, new_debt: Math.round((receivable - received) * 100) / 100 };
  });
}

/** FP-DASH-13 挂账清单（debt>0.01，按单日期倒序） */
function expDebtSales() {
  return SNAP_SALES.filter((s) => !isVoid(s) && debtOf(s) > 0.01)
    .map((s) => ({ no: s.no != null ? String(s.no) : null, date: recDate(s), debt: debtOf(s) }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/* ------------------------------------------------------------ CDP 极简客户端 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.logs.push('console.error: ' + msg.params.args.map((a) => a.value || a.description || '').join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.logs.push('exception: ' + String(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
      }
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('cdp closed'));
      this.pending.clear();
    });
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout ' + method)); }
      }, 30000);
    });
  }
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('ws open timeout ' + wsUrl)), 15000);
    ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(timer); rej(new Error('ws error ' + (e.message || e.type || ''))); }, { once: true });
    ws.addEventListener('close', () => { clearTimeout(timer); rej(new Error('ws closed before open')); }, { once: true });
  });
  return new Cdp(ws);
}

/* --------------------------------------------------------------- 页面断言助手 */
const HELPERS = [
  'window.__q = {',
  '  has: (s) => document.body.innerText.indexOf(s) >= 0,',
  '  card: (t) => [...document.querySelectorAll(".ant-card")].find((c) => {',
  '    const h = c.querySelector(".ant-card-head-title");',
  '    return !!h && h.innerText.indexOf(t) >= 0;',
  '  }) || null,',
  '  stat: (t) => [...document.querySelectorAll(".ant-statistic")].find((s) => {',
  '    const ti = s.querySelector(".ant-statistic-title");',
  '    return !!ti && ti.innerText.trim() === t;',
  '  }) || null,',
  '  kpiNum: (t) => { const el = __q.stat(t); if (!el) return null;',
  '    const m = el.innerText.replace(/[^0-9.\\-]/g, ""); if (m === "" || m === "-") return null;',
  '    const n = Number(m); return isFinite(n) ? n : null; },',
  '  kpiTitles: () => [...document.querySelectorAll(".ant-statistic-title")].map((x) => x.innerText.trim()),',
  '  chips: () => [...document.querySelectorAll(".ant-tag-checkable")],',
  '  chipTexts: () => __q.chips().map((c) => c.innerText.trim()),',
  '  chipChecked: (kw) => { const c = __q.chips().find((x) => x.innerText.indexOf(kw) >= 0);',
  '    return !!c && c.className.indexOf("ant-tag-checkable-checked") >= 0; },',
  '  clickChip: (kw) => { const c = __q.chips().find((x) => x.innerText.indexOf(kw) >= 0);',
  '    if (!c) return false; c.click(); return true; },',
  '  rangeLabel: () => { const el = document.querySelector("[data-range-label]");',
  '    return el ? el.innerText.trim() : ""; },',
  '  lowCard: () => __q.card("库存预警"),',
  '  lowRows: () => { const c = __q.lowCard(); if (!c) return [];',
  '    return [...c.querySelectorAll(".ant-list-item")]; },',
  '  lowTexts: () => __q.lowRows().map((r) => r.innerText.replace(/\\s+/g, " ").trim()),',
  '  lowPoLinks: () => __q.lowRows().filter((r) => r.innerText.indexOf("去采购") >= 0).length,',
  '  chartCard: () => __q.card("每日应收 vs 实收（近14天）"),',
  '  chartLabels: () => { const c = __q.chartCard(); if (!c) return [];',
  '    return [...c.querySelectorAll("svg text[text-anchor=middle]")].map((t) => t.textContent.trim()); },',
  '  chartBars: () => { const c = __q.chartCard(); if (!c) return 0;',
  '    return c.querySelectorAll("svg rect").length; },',
  '  chartDots: () => { const c = __q.chartCard(); if (!c) return 0;',
  '    return c.querySelectorAll("svg circle").length; },',
  '  debtCard: () => __q.card("未收账款（客户挂账）"),',
  '  debtRows: () => { const c = __q.debtCard(); if (!c) return [];',
  '    return [...c.querySelectorAll(".ant-table-tbody tr.ant-table-row")]; },',
  '  debtTexts: () => __q.debtRows().map((r) => r.innerText.replace(/\\s+/g, " ").trim()),',
  '};',
].join('\n');

const ENSURE = '(()=>{ if(!window.__q){ ' + HELPERS + ' } return true })()';

const kpiOf = (r, label) => {
  const hit = ((r && r.kpi) || []).find((k) => k.label === label);
  return hit ? Number(String(hit.value).replace(/[^0-9.\-]/g, '')) : null;
};

async function main() {
  setTimeout(() => { console.error('GLOBAL TIMEOUT (300s)'); process.exit(2); }, 300000);

  /* ---------- 0. 等待前后端就绪 ---------- */
  let bffUp = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await req('GET', BFF + '/api/health'); if (r.status === 200) { bffUp = true; break; } } catch (e) { /* retry */ }
    await sleep(500);
  }
  if (!bffUp) { console.error('FATAL: BFF ' + BFF + ' 未就绪'); process.exit(3); }
  let webUp = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await req('GET', WEB + '/'); if (r.status === 200) { webUp = true; break; } } catch (e) { /* retry */ }
    await sleep(500);
  }
  if (!webUp) { console.error('FATAL: web ' + WEB + ' 未就绪'); process.exit(3); }

  const digest0 = dataDigest();

  /* ---------- 1. 登录 ---------- */
  const login = await req('POST', BFF + '/api/auth/login', { account: 'boss', password: 'wufu123', device_fp: 'smoke-dash-kpi' });
  const token = login.body && login.body.token;
  ok(login.status === 200 && !!token, '老板登录（boss/wufu123）', login.status);

  /* ---------- 2. FP-DASH-01 周期 + FP-DASH-06/07 KPI ---------- */
  const r30 = await req('GET', BFF + '/api/report/daily?range=30', undefined, token);
  ok(r30.status === 200 && r30.body && !r30.body.mock, 'GET /api/report/daily?range=30 返回真实快照', r30.body && r30.body.rev);
  ok(r30.body.range === '30', 'range=30 回传', r30.body.range);
  const to = todayStr();
  ok(
    r30.body.range_from === minusDays(to, 29) && r30.body.range_to === to,
    '近30天区间 = [to-29, to]（旧版 inRange 下界 daysAgo(r-1)，HTML:1222）',
    { from: r30.body.range_from, to: r30.body.range_to }
  );
  ok(r30.body.range_label === '近30天（' + minusDays(to, 29) + ' 至 ' + to + '）',
    '区间文字 = 旧版 rangeLabel 口径（HTML:1223）', r30.body.range_label);

  const r7 = await req('GET', BFF + '/api/report/daily?range=7', undefined, token);
  ok(r7.body.range === '7' && r7.body.range_from === minusDays(to, 6), 'range=7 区间下界 = to-6',
    { from: r7.body.range_from, to: r7.body.range_to });
  const rAll = await req('GET', BFF + '/api/report/daily?range=all', undefined, token);
  ok(rAll.body.range === 'all' && rAll.body.range_from === null && /^全部时间（截至 \d{4}-\d{2}-\d{2}）$/.test(rAll.body.range_label),
    'range=all：无下界 + 「全部时间（截至 …）」', { from: rAll.body.range_from, label: rAll.body.range_label });
  const rBad = await req('GET', BFF + '/api/report/daily?range=999', undefined, token);
  ok(rBad.body.range === '30', '非法 range 回落 30（旧版默认近30天）', rBad.body.range);
  const rNone = await req('GET', BFF + '/api/report/daily', undefined, token);
  ok(rNone.body.range === '30', '不传 range 时接口默认 30（UI 默认 chip）', rNone.body.range);

  const rev30 = kpiOf(r30.body, '营收'), rev7 = kpiOf(r7.body, '营收'), revAll = kpiOf(rAll.body, '营收');
  ok(rev30 === expRevenue('30'), '营收（近30天）= 快照独立重算', { api: rev30, expect: expRevenue('30') });
  ok(rev7 === expRevenue('7'), '营收（近7天）= 快照独立重算', { api: rev7, expect: expRevenue('7') });
  ok(revAll === expRevenue('all'), '营收（全部）= 快照独立重算', { api: revAll, expect: expRevenue('all') });
  ok(revAll >= rev30 && rev30 >= rev7, '周期越长营收越大（7 ≤ 30 ≤ 全部）', { r7: rev7, r30: rev30, all: revAll });

  const pay30 = kpiOf(r30.body, '采购应付（本期）');
  const pay7 = kpiOf(r7.body, '采购应付（本期）');
  ok(pay30 === expPayable('30'), 'FP-DASH-06 采购应付（本期）= 快照独立重算', { api: pay30, expect: expPayable('30') });
  ok(pay7 === expPayable('7'), 'FP-DASH-06 采购应付随周期变化', { 近7天: pay7, 近30天: pay30 });

  const sv30 = kpiOf(r30.body, '库存总值');
  const sv7 = kpiOf(r7.body, '库存总值');
  ok(sv30 === expStockValue, 'FP-DASH-07 库存总值 = Σ 库存×均价（旧版 stockValue()，HTML:1244/1251）',
    { api: sv30, expect: expStockValue });
  ok(sv30 === sv7, 'FP-DASH-07 库存总值为时点值，不随周期变化', { 近7天: sv7, 近30天: sv30 });
  const kpiLabels = (r30.body.kpi || []).map((k) => k.label);
  ok(
    ['营收', '订单数', '客单价', '销售毛利率', '应收合计', '实收合计', '未收欠款', '折扣/抹零',
      '采购应付（本期）', '库存总值', '菜品SKU', '原料SKU', '会员数', '快照rev', '销售记录总数']
      .every((l) => kpiLabels.indexOf(l) >= 0),
    'KPI 含经营概览全部必要卡（含 FP-DASH-02/03/04/05/06/07/08）', kpiLabels
  );

  /* ---------- 3. FP-DASH-11 低库存明细 ---------- */
  const ls = r30.body.low_stock || {};
  ok(Number(ls.total) === expLow.length, 'FP-DASH-11 low_stock.total = 快照独立重算',
    { api: ls.total, expect: expLow.length });
  ok(Array.isArray(ls.items) && ls.items.length === expLow.length, 'FP-DASH-11 items 全量回传', ls.items && ls.items.length);
  ok(
    (ls.items || []).every((it) => it.name && it.unit && it.qty != null && it.safe != null),
    'FP-DASH-11 每行含 名称/分类/单位/现存/安全线（旧版 #lowStockBox，HTML:1281-1282）',
    (ls.items || []).map((it) => it.name + '[' + it.cat + '] ' + it.qty + it.unit + '/安全' + it.safe)
  );
  ok(
    (ls.items || []).every((it) => it.qty < it.safe),
    'FP-DASH-11 每行确实「现存 < 安全线」'
  );

  /* ---------- 3b. FP-DASH-10 逐日序列 / FP-DASH-13 挂账清单（接口层） ---------- */
  const expSeries = expDailySeries(to, 14);
  const apiSeries = r30.body.daily_series || [];
  ok(Array.isArray(apiSeries) && apiSeries.length === 14, 'FP-DASH-10 daily_series = 14 天',
    apiSeries.length);
  ok(apiSeries.length === 14 && apiSeries[13].date === to && apiSeries[0].date === minusDays(to, 13),
    'FP-DASH-10 序列窗 = [to-13, to]（旧版 daysAgo(13) 起，HTML:1259）',
    apiSeries.length ? { from: apiSeries[0].date, to: apiSeries[13].date } : null);
  ok(
    JSON.stringify(apiSeries.map((d) => [d.date, d.receivable, d.received])) ===
      JSON.stringify(expSeries.map((d) => [d.date, d.receivable, d.received])),
    'FP-DASH-10 逐日应收/实收 = 快照独立重算（应收按单日期、实收按收款日期）',
    { api: apiSeries.slice(-2), expect: expSeries.slice(-2) }
  );
  ok(apiSeries.every((d) => Math.abs((d.receivable - d.received) - d.new_debt) < 0.02),
    'FP-DASH-10 new_debt = 当日应收 − 当日实收（旧版红点口径，HTML:1275）');

  const expDebt = expDebtSales();
  const apiDebt = r30.body.debt_sales || [];
  ok(Array.isArray(apiDebt) && apiDebt.length === expDebt.length,
    'FP-DASH-13 debt_sales 行数 = 快照独立重算（欠款 > 0.01）', { api: apiDebt.length, expect: expDebt.length });
  ok(apiDebt.every((r) => r.debt > 0.01 && r.date && (r.no || r.id)),
    'FP-DASH-13 每行含 单号/日期/欠款，且欠款 > 0.01');
  ok(
    Math.abs(apiDebt.reduce((a, r) => a + num(r.debt), 0) - kpiOf(r30.body, '未收欠款')) < 0.02,
    'FP-DASH-13 挂账清单合计 = 「未收欠款」卡（同源 lib/sales_model.js）',
    { list: apiDebt.reduce((a, r) => a + num(r.debt), 0), kpi: kpiOf(r30.body, '未收欠款') }
  );
  ok(
    apiDebt.every((r, i) => i === 0 || String(apiDebt[i - 1].date) >= String(r.date)),
    'FP-DASH-13 按单日期倒序（旧版 HTML:1287）'
  );

  /* ---------- 4. CDP 连接 + 注入登录态 ---------- */
  const ver = await req('GET', 'http://127.0.0.1:' + CDP_PORT + '/json/version');
  console.log('phase: cdp version=' + ver.body.Browser);
  const cdp = await connectCdp(ver.body.webSocketDebuggerUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, S);
  await cdp.send('Page.enable', {}, S);

  const auth = {
    state: {
      token,
      role: login.body.role,
      account: 'boss',
      expiresAt: login.body.expires_at,
      storeId: login.body.store_id ?? null,
      storeName: login.body.store_name ?? null,
      permissions: login.body.permissions ?? [],
      canWrite: !!login.body.can_write,
    },
    version: 0,
  };
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'try{localStorage.setItem("panda_admin_auth", ' + JSON.stringify(JSON.stringify(auth)) + ')}catch(e){}',
  }, S);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false }, S);
  await cdp.send('Page.navigate', { url: WEB + '/dashboard' }, S);

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, S);
    if (r.exceptionDetails) {
      throw new Error('page error: ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };
  const waitQ = async (cond, ms, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await evalJs('(()=>{ ' + ENSURE + '; return (' + cond + ') })()')) return true; } catch (e) { /* retry */ }
      await sleep(250);
    }
    console.error('  (超时 ' + ms + 'ms: ' + label + ')');
    return false;
  };

  const ready = await waitQ('__q.kpiTitles().indexOf("营收") >= 0', 60000, '看板页渲染');
  ok(ready, '进入 /dashboard，KPI 已渲染');
  if (!ready) throw new Error('页面未就绪，后续断言无意义');

  /* ---------- 5. 页面层：周期 chips + 区间文字 + KPI + 低库存明细 ---------- */
  const chipTexts = await evalJs('__q.chipTexts()');
  ok(
    JSON.stringify(chipTexts) === JSON.stringify(['近7天', '近30天', '全部']),
    'FP-DASH-01 周期 chips = 近7天/近30天/全部（旧版 #dashRange，HTML:194-198）',
    chipTexts
  );
  ok(await evalJs('__q.chipChecked("近30天")') === true, 'FP-DASH-01 默认选中「近30天」（旧版 DASH_R=30，HTML:1221）');
  const label30 = await evalJs('__q.rangeLabel()');
  ok(label30 === r30.body.range_label, 'FP-DASH-01 区间文字与接口一致（旧版 dashDateTip，HTML:1235）',
    { ui: label30, api: r30.body.range_label });

  const uiTitles = await evalJs('__q.kpiTitles()');
  ok(uiTitles.indexOf('采购应付（本期）') >= 0 && uiTitles.indexOf('库存总值') >= 0,
    'FP-DASH-06/07 两张 KPI 卡已上屏', uiTitles);
  const uiSv = await evalJs('__q.kpiNum("库存总值")');
  ok(Math.abs((uiSv || 0) - expStockValue) < 0.02, 'FP-DASH-07 页面库存总值 = ' + expStockValue, uiSv);
  const uiPay = await evalJs('__q.kpiNum("采购应付（本期）")');
  ok(Math.abs((uiPay || 0) - expPayable('30')) < 0.02, 'FP-DASH-06 页面采购应付 = ' + expPayable('30'), uiPay);

  ok(await evalJs('!!__q.lowCard()'), 'FP-DASH-11 「库存预警」卡存在');
  const lowTitle = await evalJs('(()=>{const c=__q.lowCard();return c?c.querySelector(".ant-card-head-title").innerText.trim():""})()');
  ok(lowTitle.indexOf('库存预警（低于安全线 · ' + expLow.length + ' 种）') >= 0,
    'FP-DASH-11 卡标题带种数（旧版「库存预警（低于安全库存的原料）」HTML:214）', lowTitle);
  const lowTexts = await evalJs('__q.lowTexts()');
  ok(lowTexts.length === Math.min(expLow.length, 12), 'FP-DASH-11 明细行数 = min(种数, 12)', lowTexts.length);
  ok(lowTexts.every((t) => t.indexOf('现存') >= 0 && t.indexOf('安全') >= 0),
    'FP-DASH-11 每行「现存 X 单位」+「安全 Y 单位」（旧版 HTML:1282）', lowTexts);
  ok(expLow.length <= 12 || (await evalJs('__q.has("等 ' + expLow.length + ' 种，详见「原料库存」")')),
    'FP-DASH-11 超 12 条才出现「等 N 种」截断提示（旧版 HTML:1284；当前 ' + expLow.length + ' 种不应显示）');
  const poLinks = await evalJs('__q.lowPoLinks()');
  ok(expLow.length === 0 || poLinks === Math.min(expLow.length, 12),
    'FP-DASH-12 低库存每行都有「去采购」（旧版 data-poing，HTML:1283）', poLinks);

  /* ---------- 5b. FP-DASH-10/13 两张卡上屏 ---------- */
  ok(await evalJs('!!__q.chartCard()'), 'FP-DASH-10 「每日应收 vs 实收（近14天）」卡存在');
  const chartLabels = await evalJs('__q.chartLabels()');
  ok(JSON.stringify(chartLabels) === JSON.stringify(expSeries.map((d) => d.date.slice(5))),
    'FP-DASH-10 横轴 = 14 天 MM-DD（旧版 HTML:1276）', chartLabels);
  ok((await evalJs('__q.chartBars()')) === 28, 'FP-DASH-10 双柱 = 14 天 × 2 根（旧版 HTML:1273-1274）',
    await evalJs('__q.chartBars()'));
  const expDots = expSeries.filter((d) => d.receivable - d.received > 1).length;
  ok((await evalJs('__q.chartDots()')) === expDots,
    'FP-DASH-10 当日新增欠款红点数 = 独立重算（旧版 >1 元才画，HTML:1275）',
    { ui: await evalJs('__q.chartDots()'), expect: expDots });
  ok(await evalJs('__q.has("应收（挂账前）") && __q.has("当日新增欠款")'),
    'FP-DASH-10 图例含 应收（挂账前）/实收/当日新增欠款（旧版 HTML:207-211）');

  ok(await evalJs('!!__q.debtCard()'), 'FP-DASH-13 「未收账款（客户挂账）」卡存在');
  const debtTexts = await evalJs('__q.debtTexts()');
  ok(debtTexts.length === expDebt.length, 'FP-DASH-13 挂账行数 = 接口行数',
    { ui: debtTexts.length, api: expDebt.length });
  ok(debtTexts.every((t) => t.indexOf('应收') >= 0 && t.indexOf('欠款') >= 0 && t.indexOf('收款') >= 0),
    'FP-DASH-13/14 每行「应收 … 欠款 … 收款」（旧版 HTML:1290-1292）', debtTexts.slice(0, 3));
  if (expDebt.length === 0) {
    ok(await evalJs('__q.has("暂无挂账欠款")'), 'FP-DASH-13 无挂账时给空态文案（旧版 HTML:1293）');
  } else {
    /* FP-DASH-14 行内「收款」：只点开弹窗、不提交（写类动作不点，保持只读） */
    const opened = await evalJs(
      '(()=>{ const r=__q.debtRows()[0]; if(!r) return false;' +
      ' const a=[...r.querySelectorAll("a,.ant-typography")].find((x)=>x.innerText.replace(/\\s/g,"")==="收款");' +
      ' if(!a) return false; a.click(); return true; })()'
    );
    ok(opened, 'FP-DASH-14 点挂账行「收款」（旧版 data-get，HTML:1292/1313）');
    await sleep(600);
    const payTitle = await evalJs('(()=>{const m=document.querySelector(".ant-modal-title");return m?m.innerText.trim():""})()');
    ok(payTitle.indexOf('登记收款') >= 0, 'FP-DASH-14 打开登记收款弹窗（复用销售收银页 SalePayModal）', payTitle);
    await evalJs(
      '(()=>{ const m=document.querySelector(".ant-modal-wrap");' +
      ' const b=[...(m?m.querySelectorAll("button"):[])].find((x)=>x.innerText.replace(/\\s/g,"")==="取消");' +
      ' if (b) b.click(); return true; })()'
    );
    await sleep(400);
    ok(!(await evalJs('!!document.querySelector(".ant-modal-title")')),
      'FP-DASH-14 关闭弹窗，未提交任何动作（只读冒烟）');
  }

  /* ---------- 6. 切换周期 ---------- */
  const uiRev30 = await evalJs('__q.kpiNum("营收")');
  ok(await evalJs('__q.clickChip("近7天")'), 'FP-DASH-01 点「近7天」chip');
  await sleep(900);
  ok(await evalJs('__q.chipChecked("近7天")') === true && await evalJs('__q.chipChecked("近30天")') === false,
    'FP-DASH-01 选中态切到「近7天」');
  const label7 = await evalJs('__q.rangeLabel()');
  ok(label7 === r7.body.range_label, 'FP-DASH-01 区间文字跟随切到近7天', { ui: label7, api: r7.body.range_label });
  const uiRev7 = await evalJs('__q.kpiNum("营收")');
  ok(Math.abs((uiRev7 || 0) - rev7) < 0.02, 'FP-DASH-01 营收 KPI 随周期变化（' + uiRev30 + ' → ' + uiRev7 + '）',
    { 近30天: uiRev30, 近7天: uiRev7, api近7天: rev7 });
  const uiSv7 = await evalJs('__q.kpiNum("库存总值")');
  ok(Math.abs((uiSv7 || 0) - expStockValue) < 0.02, 'FP-DASH-07 切周期后库存总值不变（时点值）', uiSv7);

  ok(await evalJs('__q.clickChip("全部")'), 'FP-DASH-01 点「全部」chip');
  await sleep(900);
  const labelAll = await evalJs('__q.rangeLabel()');
  ok(/^全部时间（截至 \d{4}-\d{2}-\d{2}）$/.test(labelAll), 'FP-DASH-01「全部」→ 区间文字「全部时间（截至 …）」', labelAll);
  const uiRevAll = await evalJs('__q.kpiNum("营收")');
  ok(Math.abs((uiRevAll || 0) - revAll) < 0.02, 'FP-DASH-01 营收（全部）= 接口值 ' + revAll, uiRevAll);
  ok(await evalJs('__q.clickChip("近30天")'), 'FP-DASH-01 切回「近30天」');
  await sleep(900);
  ok(Math.abs((await evalJs('__q.kpiNum("营收")') || 0) - rev30) < 0.02, 'FP-DASH-01 切回近30天 → 营收复原 ' + rev30);

  /* ---------- 6b. FP-DASH-12 去采购 → 采购页带原料草稿（只点开、不提交，零写库） ---------- */
  if (expLowItems.length && expLowItems[0].id) {
    const firstLow = expLowItems[0];
    const clicked = await evalJs(
      '(()=>{ const r = __q.lowRows().find((x) => x.innerText.indexOf("去采购") >= 0);' +
      ' if (!r) return false; const a = r.querySelector("[data-poing]"); if (!a) return false; a.click(); return true; })()'
    );
    ok(clicked, 'FP-DASH-12 点低库存行「去采购」（旧版 data-poing，HTML:1312）');
    await sleep(900);
    ok(await evalJs('location.pathname === "/inventory/purchase"'),
      'FP-DASH-12 跳转到 /inventory/purchase（旧版 go(\'po\')）', await evalJs('location.pathname'));
    const modalTitle = await evalJs(
      '(()=>{ const m=document.querySelector(".ant-modal-title"); return m?m.innerText.trim():"" })()'
    );
    ok(modalTitle.indexOf('新建 CG 采购单') >= 0, 'FP-DASH-12 自动打开新建采购单弹窗', modalTitle);
    const picked = await evalJs(
      '(()=>{ const s=document.querySelector(".ant-modal .ant-select-selection-item");' +
      ' return s?s.innerHTML.trim():"" })()'
    );
    ok(picked.indexOf(String(firstLow.name)) >= 0,
      'FP-DASH-12 草稿首行已带该原料（旧版 presetIng，HTML:1560）',
      { ui: picked, expect: firstLow.name });
    const filledQty = await evalJs(
      '(()=>{ const i=document.querySelectorAll(".ant-modal .ant-input-number-input");' +
      ' return i.length ? String(i[0].value) : "" })()'
    );
    ok(Math.abs(num(filledQty) - (num(firstLow.conv) || 1)) < 1e-6,
      'FP-DASH-12 数量预填 = 该原料 conv（旧版 presetIng.qty=conv||1）',
      { ui: filledQty, expect: num(firstLow.conv) || 1 });
    /* 关掉弹窗（取消，不提交）——写类动作不点，保持只读 */
    await evalJs(
      '(()=>{ const m=document.querySelector(".ant-modal-wrap");' +
      ' const b=[...(m?m.querySelectorAll("button"):[])]' +
      '   .find((x)=>x.innerText.replace(/\\s/g,"")==="取消");' +
      ' if (b) b.click(); return true; })()'
    );
    await sleep(500);
    ok(!(await evalJs('!!document.querySelector(".ant-modal-title")')),
      'FP-DASH-12 关闭弹窗，未提交任何动作（只读冒烟）');
  }

  /* ---------- 7. 只读 + 控制台 ---------- */
  const digest1 = dataDigest();
  ok(JSON.stringify(digest0) === JSON.stringify(digest1), '只读冒烟：snapshot.json / actions_queue.json 指纹未变',
    { before: digest0, after: digest1 });
  ok(cdp.logs.length === 0, '页面控制台 0 报错', cdp.logs.slice(0, 4));

  const failed = results.filter((r) => !r.cond);
  console.log('\n== 结果：' + (results.length - failed.length) + '/' + results.length + ' 通过 ==');
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log('  - ' + f.label);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL: ' + (e && e.message ? e.message : String(e)));
  process.exit(4);
});
