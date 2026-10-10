#!/usr/bin/env node
/* 结构测算「模拟态」开箱冒烟（阶段 11 / ADR-007）—— 零依赖：
 * Node 内置 fetch/WebSocket + 本机 Edge 的 CDP 端口，不装 puppeteer。
 *
 * 覆盖：
 *  0) 接口层：POST /api/modules/analysis/sim 可推演、basis=shop_dishes、默认 real30+回落、
 *     qmode_label / qstat 回传、模拟态 KPI 与基线 KPI 口径不同；
 *  1) 页面层（CDP）：基线无徽标 / 售价框只读 → 点「进入模拟态」后徽标出现、控件可编辑、KPI 跳变；
 *  2) FP-CALC-11 行内改售价 → 该行日营收重算 + 店级 KPI 重算 + 「已改」标记；
 *  3) FP-CALC-13 批量「-10%」→ 全部行售价 = 原价 ×0.9 取整；
 *  4) FP-CALC-12 取消勾选 → 「已下架」标记 + 店级 KPI 重算；
 *  5) FP-CALC-08 口径切到「估算 q」→ 表头/数值变化；
 *  6) 退出模拟态 → 徽标消失、KPI 回到基线、行数不变；
 *  6.5) FP-CALC-14 五类角色卡片（5 卡 × 7 指标 + 旧版 CT_COLOR 卡色）+ 分类切换 chips 过滤逐菜表
 *     （基线 Σ86 道 = 静态价盘口径；进模拟态后跟随切到 Σ95 道 = 本店在售菜品口径）；
 *  7) 零写库（ADR-007 §2.2：snapshot.json / menu-baoben.json / actions_queue.json 大小与 mtime
 *     全程未变 + 快照 rev 未前进 + 审批队列未新增）+ 页面控制台 0 报错。
 *
 * 前置：BFF 已在 8787、vite dev 已在 5173（用同目录 smoke-calc-sim.ps1 一键起停）。
 * 用法：node scripts/smoke-calc-sim.js     退出码 0=通过
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

/** ADR-007 §2.2 点名的三个文件：只读推演全程不得改大小、不得改 mtime */
const WRITE_GUARD = ['snapshot.json', 'menu-baoben.json', 'actions_queue.json'];

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

/** 零写库指纹：只取 ADR-007 点名的三个文件（audit.jsonl / tokens.json / si_*.json 是运行日志，本就会变） */
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
  '  dishCard: () => __q.card("逐菜结构表"),',
  '  stat: (t) => [...document.querySelectorAll(".ant-statistic")].find((s) => {',
  '    const ti = s.querySelector(".ant-statistic-title");',
  '    return !!ti && ti.innerText.trim() === t;',
  '  }) || null,',
  '  kpi: (t) => { const el = __q.stat(t); if (!el) return null;',
  '    const m = el.innerText.replace(/[^0-9.\\-]/g, ""); if (m === "" || m === "-") return null;',
  '    const n = Number(m); return isFinite(n) ? n : null; },',
  '  statTitles: () => [...document.querySelectorAll(".ant-statistic-title")].map((x) => x.innerText.trim()),',
  '  dishHead: () => { const c = __q.dishCard(); return c ? [...c.querySelectorAll(".ant-table-thead th")].map((x) => x.innerText.trim()) : []; },',
  '  rows: () => { const c = __q.dishCard(); if (!c) return [];',
  '    return [...c.querySelectorAll(".ant-table-tbody > tr")].filter(',
  '      (tr) => !tr.classList.contains("ant-table-measure-row") && !tr.classList.contains("calc-grp-row")); },',
  '  cells: (tr) => [...tr.querySelectorAll(":scope > td")],',
  '  priceInput: (tr) => { const td = __q.cells(tr)[4]; return td ? td.querySelector("input") : null; },',
  '  qtyInput: (tr) => { const td = __q.cells(tr)[7]; return td ? td.querySelector("input") : null; },',
  '  onBox: (tr) => { const td = __q.cells(tr)[0]; return td ? td.querySelector("input[type=checkbox]") : null; },',
  '  revText: (tr) => { const td = __q.cells(tr)[8]; return td ? td.innerText.trim() : null; },',
  '  dishName: (tr) => { const td = __q.cells(tr)[1]; if (!td) return ""; const b = td.querySelector("b");',
  '    return b ? b.innerText.trim() : td.innerText.trim(); },',
  '  rowOff: (tr) => { const td = __q.cells(tr)[1]; return !!td && td.innerText.indexOf("已下架") >= 0; },',
  '  rowEdited: (tr) => { const td = __q.cells(tr)[1]; return !!td && td.innerText.indexOf("已改") >= 0; },',
  '  priceMap: () => { const m = {}; __q.rows().forEach((tr) => { const i = __q.priceInput(tr);',
  '    m[__q.dishName(tr)] = i ? Number(i.value) : NaN; }); return m; },',
  '  btn: (label) => [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === label) || null,',
  '  click: (label) => { const b = __q.btn(label); if (b) { b.click(); return true; } return false; },',
  '  setInput: (input, v) => {',
  '    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;',
  '    setter.call(input, String(v));',
  '    input.dispatchEvent(new Event("input", { bubbles: true }));',
  '    input.dispatchEvent(new Event("change", { bubbles: true }));',
  '    input.blur();',
  '  },',
  '  badges: () => [...document.querySelectorAll(".ant-tag")].map((t) => t.innerText.trim()).filter((s) => s.indexOf("模拟态") >= 0),',
  '  qmodeSelect: () => { const c = __q.dishCard(); if (!c) return null;',
  '    return [...c.querySelectorAll(".ant-select")].find((s) => /估算|真实/.test(s.innerText)) || null; },',
  '  qmodeText: () => { const s = __q.qmodeSelect(); return s ? s.innerText.trim() : null; },',
  // ---- FP-CALC-14 五类角色卡片 + 分类切换 ----
  '  typeCard: () => __q.card("菜品结构（五类角色）"),',
  '  typeCards: () => { const c = __q.typeCard(); if (!c) return [];',
  '    const b = c.querySelector(".ant-card-body"); if (!b) return [];',
  '    const wrap = b.firstElementChild; return wrap ? [...wrap.children] : []; },',
  '  typeTexts: () => __q.typeCards().map((el) => el.innerText),',
  '  typeBorderColors: () => __q.typeCards().map((el) => getComputedStyle(el).borderLeftColor),',
  '  typeChips: () => { const c = __q.dishCard(); if (!c) return [];',
  '    return [...c.querySelectorAll(".ant-tag.ant-tag-checkable")]; },',
  // 角色卡道数合计（取每卡首行「N 道」的数字，避开正则转义）
  '  typeCardN: () => __q.typeCards().reduce((a, el) => {',
  '    const s = el.innerText || ""; const i = s.indexOf("道"); let j = i - 1;',
  '    while (j >= 0 && (s.charCodeAt(j) <= 32 || (s[j] >= "0" && s[j] <= "9"))) j -= 1;',
  '    return a + (i > 0 ? (Number(s.slice(j + 1, i)) || 0) : 0); }, 0),',
  '  clickChip: (kw) => { const c = __q.typeChips().find((x) => x.innerText.indexOf(kw) >= 0);',
  '    if (!c) return false; c.click(); return true; },',
  '};',
].join('\n');

const ENSURE = '(()=>{ if(!window.__q){ ' + HELPERS + ' } return true })()';

async function main() {
  // 全局硬超时，防止任何一步静默挂死
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

  /* ---------- 1. 接口层：模拟态端点 ---------- */
  const login = await req('POST', BFF + '/api/auth/login', { account: 'boss', password: 'wufu123', device_fp: 'smoke-calc-sim' });
  const token = login.body && login.body.token;
  ok(login.status === 200 && !!token, '老板登录（boss/wufu123）', login.status);

  // 审批队列基线（可能已有历史待办，故断言「未新增」而不是「为空」）
  const queue0 = await req('GET', BFF + '/api/actions?status=queued', undefined, token);
  const queue0Count = Number((queue0.body && queue0.body.count) || 0);

  const base = await req('GET', BFF + '/api/modules/analysis', undefined, token);
  const baseKpi = (base.body && base.body.baoben_summary && base.body.baoben_summary.kpi) || {};
  ok(base.status === 200 && baseKpi.be_day != null,
    'GET /api/modules/analysis 基线可读（day_rev=' + baseKpi.day_rev + '）');

  const simFirst = await req('POST', BFF + '/api/modules/analysis/sim', {}, token);
  const simKpi = (simFirst.body && simFirst.body.baoben_summary && simFirst.body.baoben_summary.kpi) || {};
  ok(simFirst.status === 200 && !!simFirst.body.ok, 'POST /api/modules/analysis/sim 可推演', simFirst.status);
  ok(simFirst.body.basis === 'shop_dishes', 'basis = shop_dishes（本店在售菜品口径）', simFirst.body.basis);
  ok(simFirst.body.qmode === 'real30' && simFirst.body.qfallback === true,
    '默认 real30 + 回落开（照抄旧版 SC_QMODE/SC_QFALLBACK）', { qmode: simFirst.body.qmode, fb: simFirst.body.qfallback });
  ok(/30/.test(String(simFirst.body.qmode_label)), 'qmode_label 回传', simFirst.body.qmode_label);
  ok(!!simFirst.body.qstat && simFirst.body.qstat.n_total > 0, 'qstat 口径计数回传', simFirst.body.qstat);
  ok(simKpi.be_day !== baseKpi.be_day, '模拟态 KPI ≠ 基线 KPI（口径切换，非计算错误）',
    { 基线: baseKpi.be_day, 模拟态: simKpi.be_day, delta: Math.round((simKpi.be_day - baseKpi.be_day) * 100) / 100 });
  const getSim = await req('GET', BFF + '/api/modules/analysis/sim', undefined, token);
  ok(getSim.status === 404, 'GET 同路径 404（只读推演只认 POST）', getSim.status);

  /* ---------- 1b. FP-CALC-14 接口层：五类角色 types 含 qty_share ---------- */
  const typesApi = (base.body && base.body.baoben_summary && base.body.baoben_summary.types) || [];
  ok(typesApi.length === 5, 'FP-CALC-14 types 五类角色 5 组（' + typesApi.map((t) => t.k).join('/') + '）');
  ok(typesApi.every((t) => t.qty_share != null),
    'FP-CALC-14 每组回传 qty_share（销量占比，后端单一口径）',
    typesApi.map((t) => t.k + '=' + t.qty_share));
  const qtyShareSum = typesApi.reduce((a, t) => a + Number(t.qty_share || 0), 0);
  ok(Math.abs(qtyShareSum - 100) < 0.5, 'FP-CALC-14 Σ销量占比 ≈ 100%', Math.round(qtyShareSum * 100) / 100);
  ok(typesApi.every((t) => t.desc && String(t.desc).length >= 8) && typesApi.every((t) => t.name && t.n >= 0),
    'FP-CALC-14 五类均带 name/desc/n（desc 照抄旧版 CT，HTML:3810-3816）',
    typesApi.map((t) => t.k + ':' + t.desc));

  /* ---------- 2. CDP 连接 + 注入登录态 ---------- */
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
  await cdp.send('Page.navigate', { url: WEB + '/ops/weekly' }, S);

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

  const ready = await waitQ('!!__q.dishCard() && __q.rows().length > 0', 60000, '周报页 + 逐菜结构表渲染');
  ok(ready, '进入 /ops/weekly，逐菜结构表已渲染');
  if (!ready) throw new Error('页面未就绪，后续断言无意义');

  /* ---------- 3. 基线态 ---------- */
  const baseBeDayUi = await evalJs('__q.kpi("日保本")');
  const baseBadges = await evalJs('__q.badges().length');
  ok(baseBadges === 0, '基线态无「模拟态」徽标', baseBadges);
  const headBase = await evalJs('__q.dishHead()');
  const rowsLen = await evalJs('__q.rows().length');
  ok(headBase.length === 11, '表头 11 列（含「上架」「操作」）', headBase);
  ok(rowsLen > 0, '逐菜数据行 ' + rowsLen + ' 行');
  ok(await evalJs('(()=>{const i=__q.priceInput(__q.rows()[0]);return !!i && i.disabled})()') === true,
    '基线态售价输入框禁用（只读）');
  ok(typeof baseBeDayUi === 'number' && isFinite(baseBeDayUi), '基线日保本 UI 值 ' + baseBeDayUi);

  /* ---------- 3b. FP-CALC-14 五类角色卡片 + 分类切换（基线态只读） ---------- */
  const METRICS = ['日销量', '销量占比', '日营收', '营收占比', '成本率', '日毛利额', '毛利占比'];
  ok(await evalJs('!!__q.typeCard()'), 'FP-CALC-14 存在「菜品结构（五类角色）」卡片');
  ok(await evalJs('__q.typeCards().length') === 5,
    'FP-CALC-14 渲染 5 张角色卡', await evalJs('__q.typeCards().length'));
  const typeTexts = await evalJs('__q.typeTexts()');
  ok(
    Array.isArray(typeTexts) &&
      typeTexts.length === 5 &&
      typeTexts.every((t) => METRICS.every((m) => String(t).indexOf(m) >= 0)),
    'FP-CALC-14 每卡 7 项指标齐备（' + METRICS.join('/') + '）',
    (typeTexts || []).map((t) => String(t).split('\n').slice(0, 2).join(' '))
  );
  const expectTypeColors = [
    'rgb(232, 115, 74)',
    'rgb(217, 48, 37)',
    'rgb(30, 142, 90)',
    'rgb(107, 76, 154)',
    'rgb(61, 126, 166)',
  ];
  const typeColors = await evalJs('__q.typeBorderColors()');
  ok(
    JSON.stringify(typeColors) === JSON.stringify(expectTypeColors),
    'FP-CALC-14 卡色 = 旧版 CT_COLOR（引流#E8734A/爆品#D93025/利润#1E8E5A/形象#6B4C9A/常规#3D7EA6）',
    typeColors
  );
  ok(await evalJs('__q.typeChips().length') === 6, 'FP-CALC-14 分类切换 chips = 全部 + 5 类',
    await evalJs('__q.typeChips().length'));
  const rowsAll = await evalJs('__q.rows().length');
  ok(await evalJs('__q.clickChip("引流")'), 'FP-CALC-14 点击「引流」chip');
  await sleep(600);
  const rowsYinliu = await evalJs('__q.rows().length');
  const allYinliu = await evalJs(
    '__q.rows().every((tr)=>{const td=__q.cells(tr)[2];return !!td && td.innerText.indexOf("引流")>=0})'
  );
  ok(
    rowsYinliu > 0 && rowsYinliu < rowsAll && allYinliu,
    'FP-CALC-14 分类切换生效：逐菜表仅剩引流（' + rowsYinliu + '/' + rowsAll + ' 道）'
  );
  ok(await evalJs('__q.clickChip("全部")'), 'FP-CALC-14 点击「全部」chip');
  await sleep(600);
  ok(await evalJs('__q.rows().length') === rowsAll, 'FP-CALC-14 切回「全部」→ 行数复原 ' + rowsAll);
  const typeCardNBase = await evalJs('__q.typeCardN()');
  ok(typeCardNBase === 86,
    'FP-CALC-14 基线卡片道数 Σ' + typeCardNBase + ' = 保本价盘 86 道（与逐菜表 ' + rowsAll + ' 道的差为已知口径差，同阶段 10）');

  /* ---------- 4. 进入模拟态 ---------- */
  ok(await evalJs('__q.click("进入模拟态")'), '点击「进入模拟态」');
  const badgeOk = await waitQ('__q.badges().length >= 1', 20000, '模拟态徽标出现');
  ok(badgeOk, '模拟态徽标出现 ' + JSON.stringify(await evalJs('__q.badges()')));
  const editable = await waitQ(
    '(()=>{const i=__q.priceInput(__q.rows()[0]);return !!i && !i.disabled})()',
    30000, '行控件转为可编辑'
  );
  ok(editable, '进入模拟态后行控件转为可编辑');
  const kpiBack = await waitQ('__q.kpi("日保本") !== null', 30000, '模拟态 KPI 回填');
  ok(kpiBack, '进入模拟态后店级 KPI 已回填');
  const simBeDayUi = await evalJs('__q.kpi("日保本")');
  ok(simBeDayUi != null && simBeDayUi !== baseBeDayUi,
    '进入模拟态日保本跳变 ' + baseBeDayUi + ' → ' + simBeDayUi + '（口径切换）');
  const sumRev = await evalJs(
    '__q.rows().reduce((a,tr)=>a+Number((__q.cells(tr)[8].innerText||"0").replace(/[^0-9.]/g,"")),0)'
  );
  const beDaySim = await evalJs('null'); // 占位：保持变量名可读性
  void beDaySim;
  ok(Math.abs(sumRev - Number(simKpi.day_dish_rev)) < 1,
    'Σ逐菜日营收 = ' + Math.round(sumRev) + ' ≈ 店级 day_dish_rev ' + Math.round(Number(simKpi.day_dish_rev)) + '（同源）');
  ok(Math.abs(Number(simKpi.day_rev) - Number(simKpi.day_dish_rev) * 1.15) < 1,
    '店级 day_rev = day_dish_rev × (1+bevRatio 0.15) = ' + Math.round(Number(simKpi.day_rev)));
  const typeCardNSim = await evalJs('__q.typeCardN()');
  ok(typeCardNSim === (await evalJs('__q.rows().length')),
    'FP-CALC-14 模拟态卡片道数跟随口径切换 → Σ' + typeCardNSim + ' = 逐菜行数（本店在售菜品口径）');

  /* ---------- 5. FP-CALC-11 行内改售价 ---------- */
  const row0Name = await evalJs('__q.dishName(__q.rows()[0])');
  const rev0Before = await evalJs('__q.revText(__q.rows()[0])');
  const price0Before = await evalJs('__q.priceInput(__q.rows()[0]).value');
  const target = String(Number(price0Before) * 4);
  await evalJs('__q.setInput(__q.priceInput(__q.rows()[0]), ' + target + ')');
  await sleep(2500);
  const findBy = (name, expr) =>
    evalJs('(()=>{const tr=__q.rows().find(x=>__q.dishName(x)===' + JSON.stringify(name) + ');return tr?(' + expr + '):null})()');
  const price0After = await findBy(row0Name, '__q.priceInput(tr).value');
  const rev0After = await findBy(row0Name, '__q.revText(tr)');
  ok(price0After === target, 'FP-CALC-11 售价改为 ' + target + '（首行「' + row0Name + '」）');
  ok(rev0After !== rev0Before, 'FP-CALC-11 该行日营收重算 ' + rev0Before + ' → ' + rev0After);
  const beDayAfterEdit = await evalJs('__q.kpi("日保本")');
  ok(beDayAfterEdit !== simBeDayUi, '店级日保本随行内改动重算 ' + simBeDayUi + ' → ' + beDayAfterEdit);
  const editedCount = await evalJs('__q.rows().filter(tr=>__q.rowEdited(tr)).length');
  ok(editedCount >= 1, '改过的行出现「已改」标记（' + editedCount + ' 行）');

  /* ---------- 6. FP-CALC-13 批量 -10% ---------- */
  const pricesBefore = await evalJs('__q.priceMap()');
  ok(await evalJs('__q.click("-10%")'), '点击批量「-10%」');
  await sleep(3000);
  const pricesAfter = await evalJs('__q.priceMap()');
  const names = Object.keys(pricesBefore);
  const mismatched = names.filter((n) => Math.round(pricesBefore[n] * 0.9) !== pricesAfter[n]);
  ok(names.length === rowsLen && mismatched.length === 0,
    'FP-CALC-13 全部 ' + (names.length - mismatched.length) + '/' + names.length + ' 行售价 = 原价 ×0.9 取整',
    { 首行: [pricesBefore[names[0]], pricesAfter[names[0]]], 异常样例: mismatched.slice(0, 5) });

  /* ---------- 7. FP-CALC-12 取消勾选模拟下架 ---------- */
  const beDayBeforeOff = await evalJs('__q.kpi("日保本")');
  const offRowName = await evalJs('__q.dishName(__q.rows()[1])');
  await evalJs('__q.onBox(__q.rows()[1]).click()');
  await sleep(2500);
  const offOk = await findBy(offRowName, '__q.rowOff(tr)');
  ok(offOk, 'FP-CALC-12「' + offRowName + '」标记为已下架');
  const beDayAfterOff = await evalJs('__q.kpi("日保本")');
  ok(beDayAfterOff !== beDayBeforeOff, '下架该菜后店级日保本重算 ' + beDayBeforeOff + ' → ' + beDayAfterOff);

  /* ---------- 8. FP-CALC-08 口径切换 ---------- */
  const qmodeBefore = await evalJs('__q.qmodeText()');
  await evalJs('(()=>{const s=__q.qmodeSelect(); if(!s) return false; s.querySelector(".ant-select-selector").dispatchEvent(new MouseEvent("mousedown",{bubbles:true})); return true})()');
  await sleep(600);
  const picked = await evalJs(
    '(()=>{const o=[...document.querySelectorAll(".ant-select-item-option")].find(x=>x.innerText.indexOf("估算")>=0); if(o){o.click(); return o.innerText.trim()} return null})()'
  );
  await sleep(2500);
  ok(!!picked, 'FP-CALC-08 口径 ' + JSON.stringify(qmodeBefore) + ' → ' + JSON.stringify(picked));
  const headQ = await evalJs('__q.dishHead()');
  ok(headQ[7] === '日销量', 'FP-CALC-08 口径=est 时表头回到「日销量」', headQ[7]);
  ok(await evalJs('__q.kpi("日保本")') !== beDayAfterOff, 'FP-CALC-08 换口径后日保本再变');

  /* ---------- 9. 退出模拟态 ---------- */
  ok(await evalJs('__q.click("退出模拟态")'), '点击「退出模拟态」');
  await sleep(1500);
  ok(await evalJs('__q.badges().length') === 0, '徽标消失（回到基线口径）');
  ok(await evalJs('__q.kpi("日保本")') === baseBeDayUi, '日保本回到基线 ' + baseBeDayUi);
  ok(await evalJs('__q.rows().length') === rowsLen, '行数保持 ' + rowsLen + ' 道');

  /* ---------- 10. 零写库 + 控制台 ---------- */
  const digest1 = dataDigest();
  ok(JSON.stringify(digest0) === JSON.stringify(digest1),
    '零写库：' + WRITE_GUARD.join(' / ') + ' 大小与 mtime 全程未变', { before: digest0, after: digest1 });
  const after = await req('GET', BFF + '/api/modules/analysis', undefined, token);
  ok(after.body && after.body.rev === base.body.rev, '快照 rev 未前进（无写库）', after.body && after.body.rev);
  const queue = await req('GET', BFF + '/api/actions?status=queued', undefined, token);
  ok(Number((queue.body && queue.body.count) || 0) === queue0Count,
    '审批队列未新增（模拟态不入队；基线 ' + queue0Count + ' 条）', queue.body && queue.body.count);
  ok(cdp.logs.length === 0, '页面控制台 0 报错', cdp.logs);

  try { await cdp.send('Target.closeTarget', { targetId }); } catch (e) { /* ignore */ }

  const failed = results.filter((r) => !r.cond);
  console.log('\n== 开箱结果：' + (results.length - failed.length) + '/' + results.length + ' 通过 ==');
  for (const f of failed) console.log('  FAILED: ' + f.label);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('开箱脚本异常：', (e && e.stack) || e);
  process.exit(3);
});
