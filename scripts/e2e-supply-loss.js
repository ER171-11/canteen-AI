#!/usr/bin/env node
'use strict';
/*
 * scripts/e2e-supply-loss.js — M10 供应链 + M12 损耗报损 模块验收（T6）
 *
 *   M10 ① 供应商档案（品类/状态/账期/评级，低评级清单）
 *       ② 比价（同原料多供应商 + 价差），价差阈值可配
 *       ③ 往来账龄（0-30/31-60/>60/逾期），分档可配
 *       ④ 写操作入队 vendor.upsert / quote.upsert / supply.po
 *   M12 ⑤ 损耗归因（损耗率/原因/原料集中度），损耗率阈值可配
 *       ⑥ 报损单（待审批/已审批/已驳回 + 大额二次确认）
 *       ⑦ 盘点差异（盘亏/盘盈，仅登记）
 *       ⑧ 写操作入队 loss.report / loss.approve / loss.reject
 *   + 汇总 alerts + 配置持久化 + 写权限闸门
 *
 * 隔离：临时 BFF_DATA_DIR；只驱动 BFF 公开 HTTP API；写操作全部经 actions 队列。
 * 用法：node scripts/e2e-supply-loss.js [--verbose] [--keep]
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
  // M10 供应商档案：肉类 2 / 蔬菜 1，其中「菜篮子」2 星 < 低评级线 3
  sup_vendors: [
    { vendor_id: 'V-001', name: '张记肉联', category: '肉类', status: '合作中', level: '4', period: '月结30天' },
    { vendor_id: 'V-002', name: '菜篮子', category: '蔬菜', status: '合作中', level: '2', period: '现结' },
    { vendor_id: 'V-003', name: '雨润', category: '肉类', status: '考察中', level: '5', period: '月结60天' }
  ],
  // M10 报价：猪肉 张记 22 / 雨润 26（价差 18.2%）；白菜单家
  sup_prices: [
    { name: '猪肉', src: '张记肉联', price: 22 },
    { name: '猪肉', src: '雨润', price: 26 },
    { name: '白菜', src: '菜篮子', price: 3.5 }
  ],
  // M10 往来账：应付款 18000，含 >60 天 5000、31-60 天 3000、逾期 2000
  sup_accounts: [
    { id: 1, supplier: '张记肉联', kind: '应付', amount: 8000, due: addDays(10), status: '待付' },
    { id: 2, supplier: '菜篮子', kind: '应付', amount: 5000, due: addDays(-70), status: '待付' },
    { id: 3, supplier: '雨润', kind: '应付', amount: 3000, due: addDays(-40), status: '待付' },
    { id: 4, supplier: '某供应商', kind: '应付', amount: 2000, due: addDays(5), status: '逾期' }
  ],
  // M12 报损单：2 待审（含 1 大额 620）+ 1 已审批 + 1 已驳回
  loss_reports: [
    { id: 1, date: TODAY, ing_name: '猪肉', qty: 3, amount: 180, reason: '过期', reporter: '张三', status: '待审核' },
    { id: 2, date: TODAY, ing_name: '冻虾', qty: 5, amount: 620, reason: '解冻变质', reporter: '李四', status: '待审核' },
    { id: 3, date: TODAY, ing_name: '白菜', qty: 2, amount: 40, reason: '破损', reporter: '王五', status: '已审批' },
    { id: 4, date: TODAY, ing_name: '豆腐', qty: 1, amount: 20, reason: '操作失误', reporter: '赵六', status: '已驳回' }
  ],
  // M12 盘点差异：盘亏 2 / 盘盈 2
  loss_inventory_diff: [
    { id: 1, date: TODAY, ing_name: '猪肉', book_qty: 20, actual_qty: 18, diff: -2 },
    { id: 2, date: TODAY, ing_name: '白菜', book_qty: 10, actual_qty: 12, diff: 2 }
  ]
};
const SEED_DATA = {
  config: {},
  // M12 损耗流水：合计 240 元（猪肉 180 / 白菜 60），营收 20000 → 损耗率 1.2%
  logs: [
    { kind: 'loss', name: '猪肉', qty: 3, amount: 180, reason: '过期', date: TODAY },
    { kind: 'loss', name: '白菜', qty: 5, amount: 60, reason: '破损', date: TODAY }
  ],
  sales: [{ dish: '白菜猪肉饺', qty: 500, amount: 20000 }]
};

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canteenai-sl-'));
  const bffDataDir = path.join(tmpDir, 'bff-data');
  fs.mkdirSync(bffDataDir, { recursive: true });
  let bffChild = null;

  step(0, '环境与隔离目录');
  info('临时目录: ' + tmpDir + '（Node ' + process.versions.node + '）');

  try {
    step(1, '起云端 BFF 并铺快照（含 ext.sup_* / loss_*）');
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
    const login = await request('POST', base + '/api/auth/login', { account: 'boss', password: 'wufu123', device_fp: 'e2e-sl' });
    ok(login.status === 200 && login.body.ok && !!login.body.token, '老板登录取得 token');
    const token = login.body.token;
    const push = await request('POST', base + '/api/snapshot/push',
      { rev: 1, data: SEED_DATA, ext: SEED_EXT, machine: 'E2E-SL' }, token);
    ok(push.status === 200 && push.body.ok === true, '快照推送成功（rev=1）', push.body);

    /* ---------- M10 ① 供应商档案 ---------- */
    step(2, 'M10 ① 供应商档案（品类/状态/账期/评级）');
    const v1 = await request('GET', base + '/api/supply/vendors', undefined, token);
    ok(v1.status === 200 && v1.body.ok === true, 'GET /api/supply/vendors 可用');
    ok(v1.body.count === 3, '供应商 3 家', v1.body.count);
    ok(v1.body.by_category['肉类'] === 2 && v1.body.by_category['蔬菜'] === 1, '按品类归集 肉类2 / 蔬菜1', v1.body.by_category);
    ok(v1.body.by_status['合作中'] === 2 && v1.body.by_status['考察中'] === 1, '按状态归集 合作中2 / 考察中1', v1.body.by_status);
    ok(v1.body.low_rated.length === 1 && v1.body.low_rated[0] === '菜篮子', '评级 <3 星 → 低评级清单（菜篮子）', v1.body.low_rated);
    ok(v1.body.advice.some((a) => /低于 3 星/.test(a)), 'advice 含「低于 3 星」', v1.body.advice);

    /* ---------- M10 ② 比价 ---------- */
    step(3, 'M10 ② 比价（同原料多供应商 + 价差）');
    const c1 = await request('GET', base + '/api/supply/compare', undefined, token);
    ok(c1.status === 200 && c1.body.ok === true, 'GET /api/supply/compare 可用');
    ok(c1.body.available === 2, '可比价原料 2 项（猪肉 / 白菜）', c1.body.available);
    const pork = c1.body.rows.filter((r) => r.name === '猪肉')[0];
    ok(pork && pork.candidates === 2 && pork.best.src === '张记肉联' && pork.best.price === 22,
      '猪肉最优候选 张记肉联 ¥22', pork && pork.best);
    ok(pork && pork.worst.src === '雨润' && pork.worst.price === 26 && pork.spread_pct === 18.2,
      '猪肉价差 = (26-22)/22 = 18.2%', pork && [pork.worst, pork.spread_pct]);
    ok(c1.body.rows[0].name === '猪肉', '按价差降序：猪肉居首', c1.body.rows.map((r) => r.name));
    ok(c1.body.advice.some((a) => /价差 18.2%/.test(a)), 'advice 含价差提示', c1.body.advice);

    /* ---------- M10 ③ 往来账龄 ---------- */
    step(4, 'M10 ③ 往来账龄（0-30/31-60/>60/逾期）');
    const a1 = await request('GET', base + '/api/supply/accounts', undefined, token);
    ok(a1.status === 200 && a1.body.ok === true, 'GET /api/supply/accounts 可用');
    ok(a1.body.payable === 18000, '应付合计 18000', a1.body.payable);
    ok(a1.body.aging.current === 8000 && a1.body.aging.over30 === 3000 && a1.body.aging.over60 === 5000 && a1.body.aging.overdue === 2000,
      '账龄分桶 当前8000 / 31-60天3000 / >60天5000 / 逾期2000', a1.body.aging);
    ok(a1.body.need_settle === 7000, '需结算（>60天+逾期）= 7000', a1.body.need_settle);
    ok(a1.body.overdue_list.length === 2, '逾期清单 2 条（菜篮子 / 某供应商）', a1.body.overdue_list.map((x) => x.supplier));
    ok(a1.body.advice.some((a) => /需安排结算/.test(a)), 'advice 含「需安排结算」', a1.body.advice);

    /* ---------- 汇总（基线） ---------- */
    step(5, '汇总：供应链 / 损耗 看板 alerts（基线）');
    const so = await request('GET', base + '/api/supply/overview', undefined, token);
    ok(so.status === 200 && so.body.vendors.count === 3 && so.body.accounts.need_settle === 7000,
      '供应链汇总：供应商 3 / 需结算 7000', so.body.accounts);
    ok(so.body.alerts.some((a) => /价差 18.2%/.test(a.text)) && so.body.alerts.some((a) => /超 60 天/.test(a.text)),
      '供应链 alerts 含价差 + 超 60 天', so.body.alerts.map((a) => a.text));
    const lo = await request('GET', base + '/api/loss/overview', undefined, token);
    ok(lo.status === 200 && lo.body.loss.loss_rate_pct === 1.2, '损耗汇总：损耗率 1.2%', lo.body.loss);
    ok(lo.body.reports.pending === 2 && lo.body.reports.big_pending === 1, '损耗汇总：待审 2 / 大额 1', lo.body.reports);
    ok(lo.body.alerts.some((a) => /损耗率 1.2%/.test(a.text)), '损耗 alerts 含损耗率偏高', lo.body.alerts.map((a) => a.text));

    /* ---------- M10 ④ 配置可配 + 写操作 ---------- */
    step(6, 'M10 ④ 阈值可配（价差/账龄）+ 写操作入队');
    const badCfg = await request('POST', base + '/api/supply/config', { supply: { aging_over30_d: 60, aging_over60_d: 30 } }, token);
    ok(badCfg.status === 400, '非法配置（30 天档 ≥ 60 天档）→ 400 拒绝', badCfg.body && badCfg.body.error);
    const cfg1 = await request('POST', base + '/api/supply/config', { supply: { spread_warn_pct: 20, aging_over30_d: 10, aging_over60_d: 20 } }, token);
    ok(cfg1.status === 200 && cfg1.body.supply.spread_warn_pct === 20, '价差阈值改 20% / 账龄档 10-20 天', cfg1.body && cfg1.body.supply);
    const c2 = await request('GET', base + '/api/supply/compare', undefined, token);
    ok(!c2.body.advice.some((a) => /价差 18.2%/.test(a)) && c2.body.advice.some((a) => /比价平稳/.test(a)),
      '价差 18.2% < 20% → 不再告警', c2.body.advice);
    const a2 = await request('GET', base + '/api/supply/accounts', undefined, token);
    ok(a2.body.aging.over30 === 0 && a2.body.aging.over60 === 8000 && a2.body.need_settle === 10000,
      '账龄档收窄后：31-60天档归零、>60天 8000、需结算 10000', a2.body.aging);

    const vw1 = await request('POST', base + '/api/supply/vendor', { name: '新粮油行', category: '粮油', level: 4, period: '月结30天' }, token);
    ok(vw1.status === 200 && vw1.body.ok && !!vw1.body.action_id, '供应商档案 → 入队 vendor.upsert', vw1.body);
    ok(vw1.body.rev === 1, '写回响应带 rev（乐观锁基准）', vw1.body.rev);
    const vw2 = await request('POST', base + '/api/supply/vendor', {}, token);
    ok(vw2.status === 400, '缺 name/vendor_id → 400 拒绝', vw2.body && vw2.body.error);
    const qw1 = await request('POST', base + '/api/supply/quote', { ing: '猪肉', src: '张记肉联', price: 23, note: '调价' }, token);
    ok(qw1.status === 200 && qw1.body.ok && !!qw1.body.action_id, '报价 → 入队 quote.upsert', qw1.body);
    const qw2 = await request('POST', base + '/api/supply/quote', { src: 'x', price: 1 }, token);
    ok(qw2.status === 400, '缺 ing → 400 拒绝', qw2.body && qw2.body.error);
    const pw1 = await request('POST', base + '/api/supply/po', { vendor_id: '张记肉联', amount: 1000, ref_no: 'PO-TEST' }, token);
    ok(pw1.status === 200 && pw1.body.ok && !!pw1.body.action_id, '采购应付 → 入队 supply.po', pw1.body);
    const pw2 = await request('POST', base + '/api/supply/po', { amount: 100 }, token);
    ok(pw2.status === 400, '缺 vendor → 400 拒绝', pw2.body && pw2.body.error);

    /* ---------- M12 ⑤ 损耗归因 ---------- */
    step(7, 'M12 ⑤ 损耗归因（损耗率 / 原因 / 原料集中度）');
    const r1 = await request('GET', base + '/api/loss/records', undefined, token);
    ok(r1.status === 200 && r1.body.ok === true, 'GET /api/loss/records 可用');
    ok(r1.body.total_amount === 240 && r1.body.revenue === 20000 && r1.body.loss_rate_pct === 1.2,
      '损耗 240 / 营收 20000 / 损耗率 1.2%', { a: r1.body.total_amount, r: r1.body.loss_rate_pct });
    ok(r1.body.by_reason_amount['过期'] === 180 && r1.body.by_reason_amount['破损'] === 60, '按原因归集 过期180 / 破损60', r1.body.by_reason_amount);
    ok(r1.body.top_ingredients[0].name === '猪肉' && r1.body.top_share_pct === 75, '原料集中度：猪肉占 75%', [r1.body.top_ingredients[0], r1.body.top_share_pct]);
    ok(r1.body.advice.some((a) => /注意压降/.test(a)), 'advice 含「注意压降」（>1% 预警）', r1.body.advice);

    /* ---------- M12 ⑥ 报损单 ---------- */
    step(8, 'M12 ⑥ 报损单（待审批/已审批/已驳回 + 大额）');
    const rp1 = await request('GET', base + '/api/loss/reports', undefined, token);
    ok(rp1.status === 200 && rp1.body.ok === true, 'GET /api/loss/reports 可用');
    ok(rp1.body.counts.pending === 2 && rp1.body.counts.approved === 1 && rp1.body.counts.rejected === 1,
      '计数：待审 2 / 已审批 1 / 已驳回 1', rp1.body.counts);
    ok(rp1.body.counts.big_pending === 1, '大额待审 1 张（冻虾 ¥620 ≥¥500）', rp1.body.counts.big_pending);
    ok(rp1.body.advice.some((a) => /待审批/.test(a)) && rp1.body.advice.some((a) => /二次确认/.test(a)),
      'advice 含待审批 + 大额二次确认', rp1.body.advice);

    /* ---------- M12 ⑦ 盘点差异 ---------- */
    step(9, 'M12 ⑦ 盘点差异（盘亏/盘盈，仅登记）');
    const inv1 = await request('GET', base + '/api/loss/inventory', undefined, token);
    ok(inv1.status === 200 && inv1.body.diff_count === 2, '盘点差异 2 项', inv1.body.diff_count);
    ok(inv1.body.loss_qty === 2 && inv1.body.over_qty === 2, '盘亏 2 / 盘盈 2', { l: inv1.body.loss_qty, o: inv1.body.over_qty });

    /* ---------- M12 ⑧ 配置可配 + 写操作 ---------- */
    step(10, 'M12 ⑧ 损耗率阈值可配 + 报损/审批/驳回入队');
    const badLoss = await request('POST', base + '/api/loss/config', { loss: { loss_rate_warn: 5, loss_rate_redline: 1 } }, token);
    ok(badLoss.status === 400, '非法配置（预警 > 红线）→ 400 拒绝', badLoss.body && badLoss.body.error);
    const cfg2 = await request('POST', base + '/api/loss/config', { loss: { loss_rate_warn: 2, loss_rate_redline: 3 } }, token);
    ok(cfg2.status === 200 && cfg2.body.loss.loss_rate_redline === 3, '损耗率红线改 3%', cfg2.body && cfg2.body.loss);
    const r2 = await request('GET', base + '/api/loss/records', undefined, token);
    ok(!r2.body.advice.some((a) => /注意压降/.test(a)), '损耗率 1.2% < 2% → 不再提示压降', r2.body.advice);

    const lw1 = await request('POST', base + '/api/loss/report', { ing_name: '猪肉', qty: 3, reason: '过期', amount: 180 }, token);
    ok(lw1.status === 200 && lw1.body.ok && !!lw1.body.action_id, '报损登记 → 入队 loss.report（待审核）', lw1.body);
    const lw2 = await request('POST', base + '/api/loss/report', { qty: 3 }, token);
    ok(lw2.status === 400, '缺 ing_name → 400 拒绝', lw2.body && lw2.body.error);
    const la = await request('POST', base + '/api/loss/approve', { id: 1 }, token);
    ok(la.status === 200 && la.body.ok && !!la.body.action_id, '报损审批 → 入队 loss.approve（扣库存）', la.body);
    const laBad = await request('POST', base + '/api/loss/approve', {}, token);
    ok(laBad.status === 400, '缺 id → 400 拒绝', laBad.body && laBad.body.error);
    const lr = await request('POST', base + '/api/loss/reject', { id: 2, reason: '误报' }, token);
    ok(lr.status === 200 && lr.body.ok && !!lr.body.action_id, '报损驳回 → 入队 loss.reject', lr.body);
    const lrBad = await request('POST', base + '/api/loss/reject', {}, token);
    ok(lrBad.status === 400, '缺 id → 400 拒绝', lrBad.body && lrBad.body.error);

    /* ---------- 收尾 ---------- */
    step(11, '收尾：队列与权限闸门 + 配置持久化');
    const q = await request('GET', base + '/api/actions?status=queued', undefined, token);
    const qtypes = q.body.items.map((a) => a.type).sort();
    const need = ['vendor.upsert', 'quote.upsert', 'supply.po', 'loss.report', 'loss.approve', 'loss.reject'];
    ok(q.body.count === 6 && need.every((t) => qtypes.indexOf(t) >= 0),
      '六类动作各入队 1 条（待确认台，零直写）', qtypes);
    const sc = await request('GET', base + '/api/supply/config', undefined, token);
    ok(sc.body.supply.spread_warn_pct === 20 && sc.body.supply.aging_over60_d === 20, '供应链配置持久化（回读）', sc.body.supply);
    const lc = await request('GET', base + '/api/loss/config', undefined, token);
    ok(lc.body.loss.loss_rate_redline === 3 && lc.body.loss.big_amount === 500, '损耗配置持久化（回读）', lc.body.loss);
    const noAuth = await request('POST', base + '/api/supply/vendor', { name: 'x' }, null);
    ok(noAuth.status === 401 || noAuth.status === 403, '未登录写操作被拒（401/403）', noAuth.status);

    line('');
    line('M10 供应链 + M12 损耗报损模块验收：全绿（' + CHECKS + ' 断言）');
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
