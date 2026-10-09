#!/usr/bin/env node
'use strict';
/*
 * scripts/e2e-equipment.js — M8 设备温度/维保/能耗 模块验收（T6）
 *
 *   ① 冷柜温度分级：冷冻 ≤-15 / 蔬菜 ≤8 / 冷藏 ≤5；超限→over，超温持续≥N 分钟→critical，临近上限→warn；阈值可配
 *   ② 维保计划：next_due = 上次 + 周期（或显式 next_due）→ 逾期 overdue / 临期 due_soon / ok；登记入队
 *   ③ 能耗汇总：燃气/水/电成本 + 占总营收比 + 月度预算超支告警；抄表入队
 *   ④ 设备看板汇总 + alerts 联动 + 配置持久化 + 写权限闸门
 *
 * 隔离：临时 BFF_DATA_DIR；只驱动 BFF 公开 HTTP API；写操作全部经 actions 队列。
 * 用法：node scripts/e2e-equipment.js [--verbose] [--keep]
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
  // ① 温度：ok / critical（超温且持续≥15min）/ warn（临近上限）/ over（未达持续阈值）/ over（无 max，走配置）
  eq_temps: [
    { device: '冷柜 A', kind: '冷藏', temp: 4.2, max: 5 },
    { device: '冷柜 B', kind: '冷冻', temp: -10.5, max: -15, minutes: 18 },
    { device: '冷柜 C', kind: '蔬菜', temp: 7.9, max: 8 },
    { device: '冷柜 D', kind: '冷冻', temp: -14.0, max: -15, minutes: 5 },
    { device: '冷柜 E', kind: '蔬菜', temp: 9.5 }
  ],
  // ② 维保：A 正常 / B 逾期（-40 天 + 30 周期）/ C 显式临期（+3 天）
  eq_maintain: [
    { id: 1, device: '冷柜 A', kind: '保养', ts: addDays(-5), operator: '张三', cost: 200 },
    { id: 2, device: '冷柜 B', kind: '维修', ts: addDays(-40), operator: '李四', cost: 800 },
    { id: 3, device: '冷柜 C', kind: '保养', ts: addDays(-27), operator: '王五', cost: 150, next_due: addDays(3) }
  ],
  // ③ 能耗：电 2100×0.8=1680 / 燃气 680×3.2=2176 / 水 80×4=320 → 合计 4176
  eq_energy: [
    { id: 1, date: addDays(-1), device: '总表', kind: '电', reading: 12000, usage: 2100 },
    { id: 2, date: addDays(-1), device: '燃气表', kind: '燃气', reading: 5200, usage: 680 },
    { id: 3, date: addDays(-1), device: '水表', kind: '水', reading: 880, usage: 80 }
  ]
};
const SEED_DATA = {
  config: {},
  sales: [{ dish: '白菜猪肉饺', qty: 500, amount: 50000 }]
};

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canteenai-eq-'));
  const bffDataDir = path.join(tmpDir, 'bff-data');
  fs.mkdirSync(bffDataDir, { recursive: true });
  let bffChild = null;

  step(0, '环境与隔离目录');
  info('临时目录: ' + tmpDir + '（Node ' + process.versions.node + '）');

  try {
    step(1, '起云端 BFF 并铺快照（含 ext.eq_*）');
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
    const login = await request('POST', base + '/api/auth/login', { account: 'boss', password: 'wufu123', device_fp: 'e2e-eq' });
    ok(login.status === 200 && login.body.ok && !!login.body.token, '老板登录取得 token');
    const token = login.body.token;
    const push = await request('POST', base + '/api/snapshot/push',
      { rev: 1, data: SEED_DATA, ext: SEED_EXT, machine: 'E2E-EQ' }, token);
    ok(push.status === 200 && push.body.ok === true, '快照推送成功（rev=1）', push.body);

    /* ---------- 验收① 温度分级 + 超温告警 + 阈值可配 ---------- */
    step(2, '验收① 冷柜温度分级（冷冻 ≤-15 / 蔬菜 ≤8 / 冷藏 ≤5）+ over/critical/warn');
    const t1 = await request('GET', base + '/api/equipment/temps', undefined, token);
    ok(t1.status === 200 && t1.body.ok === true, 'GET /api/equipment/temps 可用');
    ok(t1.body.limits['冷冻'] === -15 && t1.body.limits['冷藏'] === 5 && t1.body.limits['蔬菜'] === 8,
      '默认上限：冷冻 -15 / 冷藏 5 / 蔬菜 8', t1.body.limits);
    const dev = (n) => t1.body.rows.filter((r) => r.device === n)[0];
    ok(dev('冷柜 A') && dev('冷柜 A').level === 'ok' && dev('冷柜 A').over === false, '4.2℃ ≤5 → ok', dev('冷柜 A') && [dev('冷柜 A').temp, dev('冷柜 A').level]);
    ok(dev('冷柜 B') && dev('冷柜 B').level === 'critical' && dev('冷柜 B').over === true,
      '-10.5℃ >-15 且持续 18 分钟 ≥15 → critical', dev('冷柜 B') && [dev('冷柜 B').temp, dev('冷柜 B').level, dev('冷柜 B').minutes]);
    ok(dev('冷柜 C') && dev('冷柜 C').level === 'warn' && dev('冷柜 C').over === false, '7.9℃ 距上限 8 仅 0.1 → warn（未超限）', dev('冷柜 C') && [dev('冷柜 C').temp, dev('冷柜 C').level]);
    ok(dev('冷柜 D') && dev('冷柜 D').level === 'over' && dev('冷柜 D').over === true,
      '-14.0℃ >-15 但仅 5 分钟 → over（未升级 critical）', dev('冷柜 D') && [dev('冷柜 D').temp, dev('冷柜 D').level]);
    ok(dev('冷柜 E') && dev('冷柜 E').level === 'over', '无 max 的行按品类配置（蔬菜 8）判级 → over', dev('冷柜 E') && [dev('冷柜 E').temp, dev('冷柜 E').level]);
    ok(t1.body.counts.ok === 1 && t1.body.counts.warn === 1 && t1.body.counts.over === 2 && t1.body.counts.critical === 1,
      '五档计数：ok1 / warn1 / over2 / critical1', t1.body.counts);
    ok(t1.body.over === 3 && t1.body.alerts.length === 3, '超温设备 3 台 + 3 条告警', { over: t1.body.over, alerts: t1.body.alerts.length });
    ok(t1.body.alerts.some((a) => a.device === '冷柜 B' && a.level === 'red'), '冷柜 B critical → 红色告警', t1.body.alerts.map((a) => a.level));

    step(3, '验收① 续：温度上限可配（改配置后同一数据分级随之变化）');
    const badCfg = await request('POST', base + '/api/equipment/config', { equipment: { maintain_interval_d: 7, maintain_due_soon_d: 10 } }, token);
    ok(badCfg.status === 400, '非法配置（临期窗口 > 周期）→ 400 拒绝', badCfg.body && badCfg.body.error);
    const cfg1 = await request('POST', base + '/api/equipment/config', { equipment: { temps: { 蔬菜: 10 } } }, token);
    ok(cfg1.status === 200 && cfg1.body.equipment.temps['蔬菜'] === 10, '蔬菜上限改为 10℃', cfg1.body && cfg1.body.equipment.temps);
    const t2 = await request('GET', base + '/api/equipment/temps', undefined, token);
    const dev2 = (n) => t2.body.rows.filter((r) => r.device === n)[0];
    ok(dev2('冷柜 E').level === 'ok', '同一「9.5℃」设备：over → ok（上限放宽后）', dev2('冷柜 E').level);
    ok(dev2('冷柜 C').level === 'warn', '有显式 max 的「冷柜 C」不受配置影响，仍 warn', dev2('冷柜 C').level);
    ok(t2.body.over === 2, '超温设备随配置收敛为 2 台', t2.body.over);

    const tw1 = await request('POST', base + '/api/equipment/temp', { device: '冷柜 A', temp: 9.9 }, token);
    ok(tw1.status === 200 && tw1.body.ok && tw1.body.over === true && !!tw1.body.action_id,
      '温度登记 9.9℃（>冷藏 5）→ 入队 equipment.temp_log 并给超温标记', tw1.body);
    const tw2 = await request('POST', base + '/api/equipment/temp', { device: '冷柜 A' }, token);
    ok(tw2.status === 400, '缺 temp → 400 拒绝', tw2.body && tw2.body.error);

    /* ---------- 验收② 维保计划 ---------- */
    step(4, '验收② 维保计划：逾期 / 临期 / 正常 + 登记入队');
    const m1 = await request('GET', base + '/api/equipment/maintain', undefined, token);
    ok(m1.status === 200 && m1.body.ok === true, 'GET /api/equipment/maintain 可用');
    ok(m1.body.interval_d === 30 && m1.body.due_soon_d === 7, '默认维保周期 30 天 / 临期窗口 7 天', { i: m1.body.interval_d, d: m1.body.due_soon_d });
    const md = (n) => m1.body.devices.filter((d) => d.device === n)[0];
    ok(md('冷柜 B') && md('冷柜 B').level === 'overdue' && md('冷柜 B').days_left < 0,
      '冷柜 B（40 天前维保 + 30 周期）→ 逾期', md('冷柜 B') && [md('冷柜 B').level, md('冷柜 B').days_left]);
    ok(md('冷柜 C') && md('冷柜 C').level === 'due_soon' && md('冷柜 C').days_left >= 1 && md('冷柜 C').days_left <= 3,
      '冷柜 C（显式 next_due=+3 天）→ 临期', md('冷柜 C') && [md('冷柜 C').level, md('冷柜 C').days_left]);
    ok(md('冷柜 A') && md('冷柜 A').level === 'ok' && md('冷柜 A').days_left >= 24,
      '冷柜 A（5 天前维保）→ 正常（约 25 天后到期）', md('冷柜 A') && [md('冷柜 A').level, md('冷柜 A').days_left]);
    ok(m1.body.counts.overdue === 1 && m1.body.counts.due_soon === 1 && m1.body.counts.ok === 1,
      '计划计数：逾期 1 / 临期 1 / 正常 1', m1.body.counts);
    ok(m1.body.advice.some((a) => /维保逾期/.test(a)), 'advice 含「维保逾期」', m1.body.advice);
    ok(m1.body.rows.length === 3, '维保历史记录 3 条', m1.body.rows.length);

    const mw1 = await request('POST', base + '/api/equipment/maintain', { device: '冷柜 B', kind: '维修', cost: 500, note: '压缩机检修' }, token);
    ok(mw1.status === 200 && mw1.body.ok && !!mw1.body.action_id, '维保登记 → 入队 equipment.maintain', mw1.body);
    ok(mw1.body.rev === 1, '写回响应带 rev（乐观锁基准）', mw1.body.rev);
    const mw2 = await request('POST', base + '/api/equipment/maintain', { kind: '保养' }, token);
    ok(mw2.status === 400, '缺 device → 400 拒绝', mw2.body && mw2.body.error);

    /* ---------- 验收③ 能耗汇总 ---------- */
    step(5, '验收③ 能耗汇总：燃气/水/电 + 营收占比 + 预算超支');
    const e1 = await request('GET', base + '/api/equipment/energy', undefined, token);
    ok(e1.status === 200 && e1.body.ok === true, 'GET /api/equipment/energy 可用');
    const item = (k) => (e1.body.items || []).filter((i) => i.kind === k)[0];
    ok(e1.body.total === 4176 && e1.body.revenue === 50000 && e1.body.ratio === 8.4,
      '合计 4176 元 / 营收 50000 / 占比 8.4%', { total: e1.body.total, rev: e1.body.revenue, ratio: e1.body.ratio });
    ok(item('燃气') && item('燃气').amount === 2176, '燃气 680×3.2 = 2176', item('燃气'));
    ok(item('电') && item('电').amount === 1680, '电 2100×0.8 = 1680', item('电'));
    ok(item('水') && item('水').amount === 320, '水 80×4 = 320', item('水'));
    ok(item('燃气').pct === 100 && item('电').pct === 77 && item('水').pct === 15, '相对最高项占比 100/77/15', [item('燃气').pct, item('电').pct, item('水').pct]);
    ok(e1.body.budget === 5000 && e1.body.over_budget === false, '默认预算 5000 → 未超支', { b: e1.body.budget, o: e1.body.over_budget });
    const cfg2 = await request('POST', base + '/api/equipment/config', { equipment: { energy_budget: 3000 } }, token);
    ok(cfg2.status === 200 && cfg2.body.equipment.energy_budget === 3000, '预算改为 3000', cfg2.body && cfg2.body.equipment.energy_budget);
    const e2 = await request('GET', base + '/api/equipment/energy', undefined, token);
    ok(e2.body.over_budget === true, '4176 > 3000 → 超支告警', e2.body.over_budget);
    const ew1 = await request('POST', base + '/api/equipment/energy', { device: '总表', kind: '电', reading: 12500, usage: 500 }, token);
    ok(ew1.status === 200 && ew1.body.ok && !!ew1.body.action_id, '能耗抄表 → 入队 equipment.energy_log', ew1.body);
    const ew2 = await request('POST', base + '/api/equipment/energy', { device: '总表' }, token);
    ok(ew2.status === 400, '缺 kind → 400 拒绝', ew2.body && ew2.body.error);

    /* ---------- 验收④ 汇总 + 联动 + 收尾 ---------- */
    step(6, '验收④ 设备看板汇总 + alerts 联动');
    const ov = await request('GET', base + '/api/equipment/overview', undefined, token);
    ok(ov.status === 200 && ov.body.ok === true, 'GET /api/equipment/overview 可用');
    ok(ov.body.temps.over === 2 && ov.body.temps.total === 5, '汇总：超温 2 / 设备 5（配置放宽后）', ov.body.temps);
    ok(ov.body.maintain.counts.overdue === 1 && ov.body.maintain.interval_d === 30, '汇总透出维保逾期与周期', ov.body.maintain);
    ok(ov.body.energy.over_budget === true && ov.body.energy.budget === 3000, '汇总透出能耗超支与预算', ov.body.energy);
    ok(ov.body.alerts.some((a) => /维保逾期/.test(a.text)), '看板 alerts 含维保逾期', ov.body.alerts.map((a) => a.text));
    ok(ov.body.alerts.some((a) => /超预算/.test(a.text)), '看板 alerts 含能耗超预算', ov.body.alerts.map((a) => a.text));

    step(7, '收尾：队列与权限闸门');
    const q = await request('GET', base + '/api/actions?status=queued', undefined, token);
    const qtypes = q.body.items.map((a) => a.type).sort();
    ok(q.body.count === 3 && qtypes.indexOf('equipment.temp_log') >= 0
      && qtypes.indexOf('equipment.maintain') >= 0 && qtypes.indexOf('equipment.energy_log') >= 0,
      '三类设备动作各入队 1 条（待确认台，零直写）', qtypes);
    const cfgGet = await request('GET', base + '/api/equipment/config', undefined, token);
    ok(cfgGet.body.equipment.temps['蔬菜'] === 10 && cfgGet.body.equipment.energy_budget === 3000,
      '配置持久化（GET /config 回读）', cfgGet.body.equipment);
    const noAuth = await request('POST', base + '/api/equipment/maintain', { device: '冷柜 A' }, null);
    ok(noAuth.status === 401 || noAuth.status === 403, '未登录写操作被拒（401/403）', noAuth.status);

    line('');
    line('M8 设备温度/维保/能耗模块验收：全绿（' + CHECKS + ' 断言）');
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
