#!/usr/bin/env node
'use strict';
/*
 * scripts/e2e-finance.js — M9 财务税务 模块验收（T6）
 *
 *   ① 发票：月度销项额度余量/使用率（默认 5 万），超支/临近告警；额度可配
 *   ② 税务：待申报合计 + 逾期判定（属期次月 15 日截止，可配）；申报登记入队
 *   ③ 现金流：收入/支出/净额 + 按账户归集；净额为负告警；登记入队
 *   ④ 分账：冻结期内不可划出（红线），到期方可解冻；冻结/解冻入队
 *   ⑤ 汇总 alerts + 配置持久化 + 写权限闸门
 *
 * 隔离：临时 BFF_DATA_DIR；只驱动 BFF 公开 HTTP API；写操作全部经 actions 队列。
 * 用法：node scripts/e2e-finance.js [--verbose] [--keep]
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
function addDays(n) { return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); }
function monthShift(n) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}
const CUR_MONTH = monthShift(0);
const OVERDUE_MONTH = monthShift(-2); // 属期次月 15 日已过 → 逾期

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
      path: u.pathname + u.search, headers, timeout: timeoutMs || 15000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { /* raw */ }
        resolve({ status: res.statusCode, body: parsed, raw });
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

/* ---------- 种子数据 ---------- */
const SEED_EXT = {
  // ① 发票：本月两张销项（共 40000）+ 一张进项
  fin_invoices: [
    { id: 1, invoice_no: 'INV-001', kind: '普票', direction: '销项', amount: 12000, tax: 360, ts: CUR_MONTH + '-03', status: '已开具' },
    { id: 2, invoice_no: 'INV-002', kind: '专票', direction: '销项', amount: 28000, tax: 840, ts: CUR_MONTH + '-05', status: '已开具' },
    { id: 3, invoice_no: 'INV-003', kind: '普票', direction: '进项', amount: 6000, tax: 180, ts: CUR_MONTH + '-06', status: '已认证' }
  ],
  // ② 税务：一笔逾期（2 个月前）+ 一笔本期待申报 + 一笔已申报
  fin_tax: [
    { id: 1, period: OVERDUE_MONTH, kind: '增值税', amount: 3000, status: '待申报' },
    { id: 2, period: CUR_MONTH, kind: '所得税', amount: 500, status: '待申报' },
    { id: 3, period: OVERDUE_MONTH, kind: '附加税', amount: 300, status: '已申报', filed_at: OVERDUE_MONTH + '-20' }
  ],
  // ③ 现金流：收入 8000+2000 / 支出 3000
  fin_cash: [
    { id: 1, ts: TODAY + ' 10:00', kind: '收入', amount: 8000, account: '门店现金', note: '当日营收' },
    { id: 2, ts: TODAY + ' 15:00', kind: '支出', amount: 3000, account: '门店现金', note: '采购付款' },
    { id: 3, ts: TODAY + ' 16:00', kind: '收入', amount: 2000, account: '银行账户', note: '外卖结算' }
  ],
  // ④ 分账：两笔冻结（一笔已到期可解冻）+ 一笔已结算
  fin_split: [
    { id: 1, period: CUR_MONTH, party: '合伙人A', amount: 12000, ratio: 0.3, frozen_until: addDays(18), status: '冻结中' },
    { id: 2, period: CUR_MONTH, party: '房东', amount: 8000, ratio: 0.2, frozen_until: addDays(-2), status: '冻结中' },
    { id: 3, period: CUR_MONTH, party: '平台', amount: 5000, ratio: 0.1, frozen_until: null, status: '已结算' }
  ]
};
const SEED_DATA = { config: {} };

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canteenai-fin-'));
  const bffDataDir = path.join(tmpDir, 'bff-data');
  fs.mkdirSync(bffDataDir, { recursive: true });
  let bffChild = null;

  step(0, '环境与隔离目录');
  info('临时目录: ' + tmpDir + '（Node ' + process.versions.node + '）');

  try {
    step(1, '起云端 BFF 并铺快照（含 ext.fin_*）');
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
    await waitHealthy(base + '/api/health', 30000, '云端 BFF');
    const login = await request('POST', base + '/api/auth/login', { account: 'boss', password: 'wufu123', device_fp: 'e2e-fin' });
    ok(login.status === 200 && login.body.ok && !!login.body.token, '老板登录取得 token');
    const token = login.body.token;
    const push = await request('POST', base + '/api/snapshot/push',
      { rev: 1, data: SEED_DATA, ext: SEED_EXT, machine: 'E2E-FIN' }, token);
    ok(push.status === 200 && push.body.ok === true, '快照推送成功（rev=1）', push.body);

    /* ---------- 验收① 发票额度 ---------- */
    step(2, '验收① 发票：月度销项额度余量/使用率（默认 5 万）+ 可配');
    const i1 = await request('GET', base + '/api/finance/invoices', undefined, token);
    ok(i1.status === 200 && i1.body.ok === true, 'GET /api/finance/invoices 可用');
    ok(i1.body.count === 3 && i1.body.issued_this_month === 40000, '台账 3 张 / 本月销项 40000', { c: i1.body.count, m: i1.body.issued_this_month });
    ok(i1.body.quota === 50000 && i1.body.remaining === 10000 && i1.body.usage_pct === 80,
      '默认额度 50000 → 剩余 10000 / 使用率 80%', { q: i1.body.quota, r: i1.body.remaining, u: i1.body.usage_pct });
    ok(i1.body.by_direction['销项'] === 40000 && i1.body.by_direction['进项'] === 6000, '按方向归集 销项 40000 / 进项 6000', i1.body.by_direction);
    ok(i1.body.advice.some((a) => /发票额度剩余/.test(a)), 'advice 含「发票额度剩余」（≥80% 预警）', i1.body.advice);

    const badCfg = await request('POST', base + '/api/finance/config', { finance: { tax_deadline_day: 40 } }, token);
    ok(badCfg.status === 400, '非法配置（申报日 > 28）→ 400 拒绝', badCfg.body && badCfg.body.error);
    const cfg1 = await request('POST', base + '/api/finance/config', { finance: { invoice_quota_monthly: 30000 } }, token);
    ok(cfg1.status === 200 && cfg1.body.finance.invoice_quota_monthly === 30000, '额度改为 30000', cfg1.body && cfg1.body.finance);
    const i2 = await request('GET', base + '/api/finance/invoices', undefined, token);
    ok(i2.body.remaining === -10000 && i2.body.usage_pct === 133.3, '同一批发票：额度下调 → 超支 -10000（133.3%）', { r: i2.body.remaining, u: i2.body.usage_pct });
    ok(i2.body.advice.some((a) => /超支/.test(a)), 'advice 含「已超支」', i2.body.advice);

    const iw1 = await request('POST', base + '/api/finance/invoice', { invoice_no: 'INV-004', kind: '普票', direction: '销项', amount: 5000, tax: 150 }, token);
    ok(iw1.status === 200 && iw1.body.ok && !!iw1.body.action_id, '开票登记 → 入队 finance.invoice', iw1.body);
    ok(iw1.body.rev === 1, '写回响应带 rev（乐观锁基准）', iw1.body.rev);
    const iw2 = await request('POST', base + '/api/finance/invoice', { amount: 0 }, token);
    ok(iw2.status === 400, '金额 ≤0 → 400 拒绝', iw2.body && iw2.body.error);

    /* ---------- 验收② 税务 ---------- */
    step(3, '验收② 税务：待申报合计 + 逾期判定（属期次月 15 日截止）');
    const t1 = await request('GET', base + '/api/finance/tax', undefined, token);
    ok(t1.status === 200 && t1.body.ok === true, 'GET /api/finance/tax 可用');
    ok(t1.body.pending_count === 2 && t1.body.payable === 3500, '待申报 2 项 · 合计 3500', { c: t1.body.pending_count, p: t1.body.payable });
    ok(t1.body.counts.filed === 1 && t1.body.counts.pending === 2 && t1.body.counts.overdue === 1,
      '计数：已申报 1 / 待申报 2 / 逾期 1', t1.body.counts);
    const tr = (k) => t1.body.rows.filter((r) => r.kind === k)[0];
    ok(tr('增值税') && tr('增值税').overdue === true && tr('增值税').days_left < 0, '增值税（2 个月前属期）→ 逾期', tr('增值税') && [tr('增值税').overdue, tr('增值税').days_left]);
    ok(tr('所得税') && tr('所得税').overdue === false && tr('所得税').days_left > 0, '所得税（本期属期）→ 未逾期', tr('所得税') && [tr('所得税').overdue, tr('所得税').days_left]);
    ok(tr('附加税') && tr('附加税').filed === true, '附加税 → 已申报', tr('附加税') && tr('附加税').filed);
    ok(t1.body.advice.some((a) => /逾期未申报/.test(a)), 'advice 含「逾期未申报」', t1.body.advice);
    ok(t1.body.deadline_day === 15, '申报截止日默认 15（次月，可配）', t1.body.deadline_day);

    const tw1 = await request('POST', base + '/api/finance/tax', { period: CUR_MONTH, kind: '增值税', amount: 1000 }, token);
    ok(tw1.status === 200 && tw1.body.ok && !!tw1.body.action_id, '税务申报登记 → 入队 finance.tax', tw1.body);
    const tw2 = await request('POST', base + '/api/finance/tax', { amount: 100 }, token);
    ok(tw2.status === 400, '缺 kind → 400 拒绝', tw2.body && tw2.body.error);

    /* ---------- 验收③ 现金流 ---------- */
    step(4, '验收③ 现金流：收入/支出/净额 + 按账户归集');
    const c1 = await request('GET', base + '/api/finance/cashflow', undefined, token);
    ok(c1.status === 200 && c1.body.ok === true, 'GET /api/finance/cashflow 可用');
    ok(c1.body.income === 10000 && c1.body.expense === 3000 && c1.body.net === 7000,
      '收入 10000 / 支出 3000 / 净额 7000', { i: c1.body.income, e: c1.body.expense, n: c1.body.net });
    ok(c1.body.rows.length === 3, '现金流水 3 条', c1.body.rows.length);
    ok(c1.body.by_account['门店现金'] && c1.body.by_account['门店现金'].income === 8000 && c1.body.by_account['门店现金'].expense === 3000,
      '按账户归集：门店现金 收 8000 / 支 3000', c1.body.by_account['门店现金']);
    const cw1 = await request('POST', base + '/api/finance/cash', { kind: '收入', amount: 1500, account: '门店现金' }, token);
    ok(cw1.status === 200 && cw1.body.ok && !!cw1.body.action_id, '现金流水登记 → 入队 finance.cash', cw1.body);
    const cw2 = await request('POST', base + '/api/finance/cash', { amount: 100 }, token);
    ok(cw2.status === 400, '缺 kind → 400 拒绝', cw2.body && cw2.body.error);

    /* ---------- 验收④ 分账冻结红线 ---------- */
    step(5, '验收④ 分账：冻结期内不可划出（红线）+ 到期可解冻');
    const s1 = await request('GET', base + '/api/finance/split', undefined, token);
    ok(s1.status === 200 && s1.body.ok === true, 'GET /api/finance/split 可用');
    ok(s1.body.frozen_count === 2 && s1.body.frozen_amount === 20000, '冻结 2 笔 / 合计 20000', { c: s1.body.frozen_count, a: s1.body.frozen_amount });
    ok(s1.body.counts.frozen === 2 && s1.body.counts.settled === 1 && s1.body.counts.releasable === 1,
      '计数：冻结 2 / 已结算 1 / 可解冻 1', s1.body.counts);
    const sp = (n) => s1.body.rows.filter((r) => r.party === n)[0];
    ok(sp('房东') && sp('房东').can_release === true, '房东（冻结已到期）→ 可解冻', sp('房东') && sp('房东').can_release);
    ok(sp('合伙人A') && sp('合伙人A').can_release === false && sp('合伙人A').frozen === true,
      '合伙人A（冻结未到期）→ 不可解冻（防纠纷红线）', sp('合伙人A') && [sp('合伙人A').can_release, sp('合伙人A').days_left]);
    ok(s1.body.releasable.length === 1 && s1.body.releasable[0].party === '房东', '可解冻清单仅「房东」', s1.body.releasable);
    ok(s1.body.advice.some((a) => /可解冻/.test(a)), 'advice 含「可解冻结算」', s1.body.advice);

    const sw1 = await request('POST', base + '/api/finance/split', { party: '合伙人A', amount: 5000, ratio: 0.1, frozen_until: addDays(10) }, token);
    ok(sw1.status === 200 && sw1.body.ok && !!sw1.body.action_id, '分账冻结登记 → 入队 finance.freeze', sw1.body);
    const sw2 = await request('POST', base + '/api/finance/split', { amount: 100 }, token);
    ok(sw2.status === 400, '缺 party → 400 拒绝', sw2.body && sw2.body.error);
    const sa = await request('POST', base + '/api/finance/split/approve', { id: 2, party: '房东', amount: 8000 }, token);
    ok(sa.status === 200 && sa.body.ok && !!sa.body.action_id, '分账解冻结算 → 入队 finance.approve', sa.body);
    const saBad = await request('POST', base + '/api/finance/split/approve', {}, token);
    ok(saBad.status === 400, '缺 id → 400 拒绝', saBad.body && saBad.body.error);

    /* ---------- 验收⑤ 汇总 + 收尾 ---------- */
    step(6, '验收⑤ 财务看板汇总 + alerts 联动');
    const ov = await request('GET', base + '/api/finance/overview', undefined, token);
    ok(ov.status === 200 && ov.body.ok === true, 'GET /api/finance/overview 可用');
    ok(ov.body.invoices.remaining === -10000 && ov.body.invoices.usage_pct === 133.3, '汇总：发票超支', ov.body.invoices);
    ok(ov.body.tax.overdue === 1 && ov.body.tax.pending_count === 2, '汇总：逾期 1 / 待申报 2', ov.body.tax);
    ok(ov.body.cashflow.net === 7000, '汇总：现金流净额 7000', ov.body.cashflow.net);
    ok(ov.body.split.releasable === 1, '汇总：可解冻分账 1', ov.body.split.releasable);
    ok(ov.body.alerts.some((a) => /超支/.test(a.text)) && ov.body.alerts.some((a) => /逾期未申报/.test(a.text)),
      'alerts 含发票超支 + 税务逾期', ov.body.alerts.map((a) => a.text));

    step(7, '收尾：队列与权限闸门');
    const q = await request('GET', base + '/api/actions?status=queued', undefined, token);
    const qtypes = q.body.items.map((a) => a.type).sort();
    const need = ['finance.cash', 'finance.freeze', 'finance.invoice', 'finance.tax'].every((t) => qtypes.indexOf(t) >= 0);
    ok(q.body.count === 5 && need && qtypes.indexOf('finance.approve') >= 0,
      '五类财务动作各入队 1 条（待确认台，零直写）', qtypes);
    const cfgGet = await request('GET', base + '/api/finance/config', undefined, token);
    ok(cfgGet.body.finance.invoice_quota_monthly === 30000 && cfgGet.body.finance.tax_deadline_day === 15,
      '配置持久化（GET /config 回读）', cfgGet.body.finance);
    const noAuth = await request('POST', base + '/api/finance/invoice', { amount: 100 }, null);
    ok(noAuth.status === 401 || noAuth.status === 403, '未登录写操作被拒（401/403）', noAuth.status);

    line('');
    line('M9 财务税务模块验收：全绿（' + CHECKS + ' 断言）');
    line('');
    return 0;
  } catch (e) {
    line('');
    line('验收失败：' + (e && e.message));
    if (bffLog && !VERBOSE) line('--- BFF 日志尾部 ---\n' + bffLog.split(/\r?\n/).slice(-25).join('\n'));
    return 1;
  } finally {
    if (bffChild && !bffChild.killed) {
      try { bffChild.kill(); } catch (e) { /* ignore */ }
    }
    if (!KEEP) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
    else line('保留临时目录: ' + tmpDir);
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  line('脚本异常：' + (e && e.stack));
  process.exit(1);
});
