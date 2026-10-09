#!/usr/bin/env node
'use strict';
/*
 * scripts/e2e-foodsafe.js — M4 食安证照模块验收（T6，验收五项）
 *
 *   ① 证照临期分级 >30绿 / 14-30黄 / 7-14橙 / <7红 / 逾期禁营，且阈值可配
 *   ② 健康证 逾期或 <7 天 → 联动 M2 staff 禁岗；店铺证照逾期 → 「停业风险」推老板
 *   ③ 留样 48h 状态机 + 克重拦截（饺子 ≥125g / 热菜 ≥200g）+ 销毁登记
 *   ④ 消毒 7 日达标率 + 待执行/超时状态机
 *   ⑤ Kimi 留样识别 ≥91% 入档 / <91% 转人工待复核（不入档、不写回）
 *   + 溯源批次下钻（批次 → 进货/销售），无检验报告标「待补」
 *
 * 隔离：临时 BFF_DATA_DIR；只驱动 BFF 公开 HTTP API；写操作全部经 actions 队列。
 * 用法：node scripts/e2e-foodsafe.js [--verbose] [--keep]
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
const YESTERDAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
function addDays(n) { return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); }
function agoIso(h) { return new Date(Date.now() - h * 3600000).toISOString(); }

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
  // ① 证照：覆盖 绿 / 黄 / 橙 / 红 / 逾期 五档，含店铺证照逾期
  fs_certs: [
    { cert_type: '健康证', holder: '张三', cert_no: 'H-001', issued_at: addDays(-360), expire_at: addDays(3) },
    { cert_type: '健康证', holder: '李四', cert_no: 'H-002', issued_at: addDays(-360), expire_at: addDays(20) },
    { cert_type: '健康证', holder: '王五', cert_no: 'H-003', issued_at: addDays(-360), expire_at: addDays(120) },
    { cert_type: '健康证', holder: '赵六', cert_no: 'H-004', issued_at: addDays(-360), expire_at: addDays(-2) },
    { cert_type: '食品经营许可', holder: '本店', cert_no: 'S-001', issued_at: addDays(-360), expire_at: addDays(10) },
    { cert_type: '消防安全检查', holder: '本店', cert_no: 'F-001', issued_at: addDays(-360), expire_at: addDays(-1) }
  ],
  // ③ 留样：待销毁 / 2h 内到期 / 已超期 / 克重不足 / 已销毁
  fs_samples: [
    { id: 1, date: TODAY, meal: '午市', dish: '白菜猪肉饺', weight_g: 140, keeper: '张三', kept_at: agoIso(40) },
    { id: 2, date: TODAY, meal: '午市', dish: '酸辣汤', weight_g: 210, keeper: '李四', kept_at: agoIso(47) },
    { id: 3, date: YESTERDAY, meal: '晚市', dish: '红烧肉', weight_g: 220, keeper: '王五', kept_at: agoIso(50) },
    { id: 4, date: TODAY, meal: '早市', dish: '韭菜鸡蛋饺', weight_g: 120, keeper: '赵六', kept_at: agoIso(1) },
    { id: 5, date: TODAY, meal: '早市', dish: '醋溜白菜', weight_g: 80, keeper: '孙七', kept_at: agoIso(2) },
    { id: 6, date: YESTERDAY, meal: '早市', dish: '小米粥', weight_g: 200, keeper: '周八', kept_at: agoIso(30), cleared_at: '2026-10-08T12:00:00.000Z' }
  ],
  // ④ 消毒：今日 2/3 完成（就餐区待执行 → 超时），昨日 1/3
  fs_disinfect: [
    { date: TODAY, area: '后厨操作台', method: '84消毒液', operator: '张三', ts: TODAY + ' 10:00', result: '已完成' },
    { date: TODAY, area: '冷藏库', method: '酒精', operator: '李四', ts: TODAY + ' 11:00', result: '已完成' },
    { date: TODAY, area: '就餐区', method: '84消毒液', operator: '王五', ts: TODAY + ' 12:00', result: '待执行' },
    { date: YESTERDAY, area: '后厨操作台', method: '84消毒液', operator: '张三', ts: YESTERDAY + ' 10:00', result: '已完成' }
  ],
  // 溯源：一条齐备、一条待补检验报告
  fs_trace: [
    { id: 1, batch_no: 'B20261007-01', ing_name: '猪肉', supplier: '雨润', recv_date: '2026-10-07', cert_no: 'QC-8891', check_result: '合格' },
    { id: 2, batch_no: 'B20261008-02', ing_name: '白菜', supplier: '绿源', recv_date: '2026-10-08', cert_no: null, check_result: null }
  ],
  staff_shifts: [
    { staff_id: 'E1', staff_name: '张三', date: TODAY, shift: '早班', start_time: '09:00', end_time: '17:00', role: '后厨' },
    { staff_id: 'E4', staff_name: '赵六', date: TODAY, shift: '中班', start_time: '11:00', end_time: '21:00', role: '后厨' }
  ]
};
const SEED_DATA = {
  config: {},
  recv: [{ recv_no: 'B20261007-01', ing_name: '猪肉', supplier: '雨润', qty: 20 }],
  sales: [{ dish: '猪肉白菜饺', qty: 120, amount: 2400 }]
};

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canteenai-fs-'));
  const bffDataDir = path.join(tmpDir, 'bff-data');
  fs.mkdirSync(bffDataDir, { recursive: true });
  let bffChild = null;

  step(0, '环境与隔离目录');
  info('临时目录: ' + tmpDir + '（Node ' + process.versions.node + '）');

  try {
    step(1, '起云端 BFF 并铺快照（含 ext.fs_*）');
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
    const login = await request('POST', base + '/api/auth/login', { account: 'boss', password: 'wufu123', device_fp: 'e2e-fs' });
    ok(login.status === 200 && login.body.ok && !!login.body.token, '老板登录取得 token');
    const token = login.body.token;
    const push = await request('POST', base + '/api/snapshot/push',
      { rev: 1, data: SEED_DATA, ext: SEED_EXT, machine: 'E2E-FS' }, token);
    ok(push.status === 200 && push.body.ok === true, '快照推送成功（rev=1）', push.body);

    /* ---------- 验收① 证照临期分级 + 可配 ---------- */
    step(2, '验收① 证照临期分级（>30绿 / 14-30黄 / 7-14橙 / <7红 / 逾期禁营）');
    const c1 = await request('GET', base + '/api/foodsafe/certs', undefined, token);
    ok(c1.status === 200 && c1.body.ok === true, 'GET /api/foodsafe/certs 可用');
    ok(c1.body.thresholds.block === 0 && c1.body.thresholds.red === 7
      && c1.body.thresholds.orange === 14 && c1.body.thresholds.yellow === 30,
      '默认阈值 block=0 / red=7 / orange=14 / yellow=30', c1.body.thresholds);
    const pick = (h, t) => c1.body.rows.filter((r) => r.holder === h && (!t || r.type === t))[0];
    const zhang = pick('张三');
    const li = pick('李四');
    const wang = pick('王五');
    const zhao = pick('赵六');
    const lic = pick('本店', '食品经营许可');
    ok(zhang && zhang.days === 3 && zhang.level === 'red', '剩余 3 天 → red（<7）', zhang && [zhang.days, zhang.level]);
    ok(li && li.days === 20 && li.level === 'yellow', '剩余 20 天 → yellow（14-30）', li && [li.days, li.level]);
    ok(wang && wang.days === 120 && wang.level === 'green', '剩余 120 天 → green（>30）', wang && [wang.days, wang.level]);
    ok(zhao && zhao.days === -2 && zhao.level === 'expired', '已逾期 2 天 → expired（禁营）', zhao && [zhao.days, zhao.level]);
    ok(lic && lic.days === 10 && lic.level === 'orange', '剩余 10 天 → orange（7-14）', lic && [lic.days, lic.level]);
    ok(c1.body.rows[0].holder === '赵六', '台账按剩余天数升序（最紧急在前）', c1.body.rows.map((r) => r.holder));
    const ct = c1.body.counts;
    ok(ct.red === 1 && ct.orange === 1 && ct.yellow === 1 && ct.green === 1 && ct.expired === 2, '五档计数正确', ct);
    ok(zhang.blocked === true && zhao.blocked === true && wang.blocked === false,
      '健康证 红/逾期 → blocked=true；绿 → false', { z: zhang.blocked, zh: zhao.blocked, w: wang.blocked });

    step(3, '验收① 续：阈值可配（改后同一批证照分级随之变化）');
    const badCfg = await request('POST', base + '/api/foodsafe/config', { cert: { red: 20, orange: 5 } }, token);
    ok(badCfg.status === 400, '非法阈值（红 > 橙）→ 400 拒绝', badCfg.body && badCfg.body.error);
    const cfg = await request('POST', base + '/api/foodsafe/config', { cert: { red: 3, orange: 10, yellow: 60 } }, token);
    ok(cfg.status === 200 && cfg.body.cert.red === 3 && cfg.body.cert.yellow === 60,
      '阈值改为 red=3 / orange=10 / yellow=60', cfg.body && cfg.body.cert);
    const c2 = await request('GET', base + '/api/foodsafe/certs', undefined, token);
    const p2 = (h, t) => c2.body.rows.filter((r) => r.holder === h && (!t || r.type === t))[0];
    ok(p2('张三').level === 'orange', '同一「3 天」证照：red → orange（阈值放宽后）', p2('张三').level);
    ok(p2('本店', '食品经营许可').level === 'yellow', '同一「10 天」证照：orange → yellow', p2('本店', '食品经营许可').level);
    ok(p2('李四').level === 'yellow', '「20 天」证照仍为 yellow', p2('李四').level);
    ok(c2.body.health_blocked.length === 1 && c2.body.health_blocked[0] === '赵六',
      '禁岗名单随阈值收敛为仅「赵六」', c2.body.health_blocked);

    /* ---------- 验收② 禁岗 + 停业风险联动 ---------- */
    step(4, '验收② 健康证逾期/<7 天联动 M2 staff 禁岗；店铺证照逾期 → 停业风险');
    const c3 = await request('GET', base + '/api/foodsafe/certs', undefined, token);
    ok(c3.body.store_stop_risk === true && c3.body.store_risks.length === 1
      && c3.body.store_risks[0].type === '消防安全检查',
      '店铺证照（消防安全检查）逾期 → store_stop_risk=true', c3.body.store_risks);
    ok(c3.body.advice.some((a) => /停业风险/.test(a)), 'advice 含「停业风险」告警', c3.body.advice);
    ok(c3.body.advice.some((a) => /健康证禁岗/.test(a)), 'advice 含「健康证禁岗」告警', c3.body.advice);
    const tr = await request('GET', base + '/api/staff/train', undefined, token);
    const blockedNames = (tr.body.certs || []).filter((x) => x.blocked).map((x) => x.staff_name);
    ok(blockedNames.indexOf('赵六') >= 0,
      'M2 培训页读到「赵六」健康证逾期 → 禁岗（跨模块同源 fs_certs）', blockedNames);
    const ov = await request('GET', base + '/api/foodsafe/overview', undefined, token);
    ok(ov.status === 200 && ov.body.certs.store_stop_risk === true, '食安看板汇总透出 store_stop_risk', ov.body && ov.body.certs);
    ok(ov.body.alerts.some((a) => /停业风险/.test(a.text)), '看板 alerts 含停业风险（推老板）', ov.body.alerts.map((a) => a.text));

    /* ---------- 验收③ 留样 48h + 克重拦截 + 销毁 ---------- */
    step(5, '验收③ 留样 48h 状态机 + 克重拦截（饺子≥125g / 热菜≥200g）+ 销毁登记');
    const s1 = await request('GET', base + '/api/foodsafe/samples', undefined, token);
    ok(s1.status === 200 && s1.body.ok === true, 'GET /api/foodsafe/samples 可用');
    ok(s1.body.hold_hours === 48 && s1.body.warn_hours === 2, '留样口径：保留 48h / 到期前 2h 转黄', { h: s1.body.hold_hours });
    const sm = (id) => s1.body.rows.filter((r) => r.id === id)[0];
    ok(sm(1) && sm(1).status === '待销毁' && sm(1).level === 'green', '留样 40h → 待销毁（绿）', sm(1) && [sm(1).status, sm(1).hours_left]);
    ok(sm(2) && sm(2).status === '2h 内到期' && sm(2).level === 'yellow', '留样 47h（剩 1h）→ 2h 内到期（黄）', sm(2) && [sm(2).status, sm(2).hours_left]);
    ok(sm(3) && sm(3).status === '已超期' && sm(3).level === 'red', '留样 50h → 已超期（红）', sm(3) && [sm(3).status, sm(3).hours_left]);
    ok(sm(6) && sm(6).status === '已销毁' && sm(6).level === 'done', '已登记销毁 → 已销毁', sm(6) && [sm(6).status, sm(6).cleared_at]);
    ok(sm(1) && sm(1).weight_ok === true && sm(1).need_g === 125, '饺子类留样 140g ≥125g → 合规', sm(1) && [sm(1).weight_g, sm(1).need_g]);
    ok(sm(2) && sm(2).need_g === 200 && sm(2).weight_ok === true, '非饺子（汤类）下限按热菜 200g', sm(2) && [sm(2).weight_g, sm(2).need_g]);
    ok(sm(4) && sm(4).weight_level === 'fail' && sm(4).short_g === 5, '韭菜鸡蛋饺 120g < 125g → fail（差 5g）', sm(4) && [sm(4).weight_g, sm(4).short_g]);
    ok(sm(5) && sm(5).weight_level === 'fail' && sm(5).short_g === 120, '醋溜白菜 80g < 200g → fail（差 120g）', sm(5) && [sm(5).weight_g, sm(5).need_g]);
    ok(s1.body.summary.under_weight === 2 && s1.body.summary.cleared === 1 && s1.body.summary.expired === 1,
      '汇总：克重不足 2 / 已销毁 1 / 超期 1', s1.body.summary);
    ok(s1.body.reminders.some((r) => r.level === 'red' && /销毁登记/.test(r.text)), '到期提醒含「超期需销毁登记」', s1.body.reminders);

    const w1 = await request('POST', base + '/api/foodsafe/samples', { dish: '韭菜鸡蛋饺', weight_g: 120, meal: '午市' }, token);
    ok(w1.status === 422 && w1.body.need_g === 125, '登记饺子 120g → 422 拦截（克重不足）', w1.body && w1.body.error);
    const w2 = await request('POST', base + '/api/foodsafe/samples', { dish: '红烧肉', weight_g: 180, meal: '午市' }, token);
    ok(w2.status === 422 && w2.body.need_g === 200, '登记热菜 180g → 422 拦截（按 200g 口径）', w2.body && w2.body.error);
    const q0 = await request('GET', base + '/api/actions?status=queued', undefined, token);
    ok(q0.body.count === 0, '被拦截的登记零写回（队列为空）', q0.body.count);

    const w3 = await request('POST', base + '/api/foodsafe/samples', { dish: '白菜猪肉饺', weight_g: 140, meal: '午市', keeper: '张三' }, token);
    ok(w3.status === 200 && w3.body.ok && !!w3.body.action_id, '登记合规留样 → 入队 sample.log', w3.body);
    ok(w3.body.rev === 1, '写回响应带 rev（乐观锁基准）', w3.body.rev);
    const cl = await request('POST', base + '/api/foodsafe/samples/clear', { id: 3, dish: '红烧肉' }, token);
    ok(cl.status === 200 && !!cl.body.action_id, '销毁登记 → 入队 fs.sample_clear', cl.body);
    const q1 = await request('GET', base + '/api/actions?status=queued', undefined, token);
    const qtypes = q1.body.items.map((a) => a.type).sort();
    ok(q1.body.count === 2 && qtypes.indexOf('sample.log') >= 0 && qtypes.indexOf('fs.sample_clear') >= 0,
      '队列内 sample.log + fs.sample_clear 各 1 条（待确认台）', qtypes);

    /* ---------- 验收④ 消毒 7 日达标率 + 状态机 ---------- */
    step(6, '验收④ 消毒 7 日达标率 + 待执行/超时状态机');
    const d1 = await request('GET', base + '/api/foodsafe/disinfect', undefined, token);
    ok(d1.status === 200 && d1.body.ok === true, 'GET /api/foodsafe/disinfect 可用');
    ok(d1.body.span.length === 7 && d1.body.span[6] === TODAY, '默认窗口 7 日且以今日收尾', d1.body.span);
    ok(d1.body.areas.length === 3, '应做区域 = 窗口内出现过的 3 个区域', d1.body.areas);
    const todayRow = d1.body.days[6];
    ok(todayRow.rate === 66.7 && todayRow.done_areas.length === 2, '今日达标率 2/3 = 66.7%', todayRow && [todayRow.rate, todayRow.done_areas]);
    ok(d1.body.days[5].rate === 33.3, '昨日达标率 1/3 = 33.3%', d1.body.days[5].rate);
    ok(d1.body.days[0].rate === 0, '无记录日达标率 0%（口径可见）', d1.body.days[0].rate);
    ok(d1.body.avg_rate != null && d1.body.avg_rate > 0, '7 日平均达标率已计算', d1.body.avg_rate);
    ok(d1.body.overdue.length === 1 && d1.body.overdue[0].area === '就餐区' && d1.body.overdue[0].overdue === true,
      '就餐区有记录但「待执行」→ 超时标红', d1.body.overdue);
    ok(d1.body.pending.length === 0, '无「零记录」区域 → 待执行清单为空', d1.body.pending);
    ok(d1.body.today_missed.indexOf('就餐区') >= 0, 'today_missed 透出就餐区', d1.body.today_missed);
    const dPost = await request('POST', base + '/api/foodsafe/disinfect', { area: '就餐区', method: '84消毒液' }, token);
    ok(dPost.status === 200 && !!dPost.body.action_id, '消毒登记 → 入队 fs.disinfect', dPost.body);
    const dBad = await request('POST', base + '/api/foodsafe/disinfect', { method: '酒精' }, token);
    ok(dBad.status === 400, '缺 area → 400 拒绝', dBad.body && dBad.body.error);

    /* ---------- 验收⑤ Kimi 留样识别入档门槛 ---------- */
    step(7, '验收⑤ Kimi sample 识别：≥91% 入档 / <91% 转人工待复核');
    const qBefore = await request('GET', base + '/api/actions?status=queued', undefined, token);
    const before = qBefore.body.count;
    const kOk = await request('POST', base + '/api/foodsafe/samples/ingest',
      { dish: '白菜猪肉饺', weight_g: 140, meal: '午市', conf: 95, source: 'kimi' }, token);
    ok(kOk.status === 200 && kOk.body.archived === true && !!kOk.body.action_id,
      'Kimi 识别 conf=95% ≥91% → 入档并写回入队', kOk.body);
    ok(kOk.body.rev === 1, '入档写回带 rev（乐观锁基准）', kOk.body.rev);
    const kLow = await request('POST', base + '/api/foodsafe/samples/ingest',
      { dish: '白菜猪肉饺', weight_g: 140, meal: '午市', conf: 88, source: 'kimi' }, token);
    ok(kLow.status === 200 && kLow.body.archived === false && kLow.body.review === true && kLow.body.threshold === 91,
      'Kimi 识别 conf=88% <91% → 待复核（archived=false）', kLow.body);
    ok(/待复核/.test(kLow.body.reason || ''), '待复核给出原因', kLow.body.reason);
    const qAfter = await request('GET', base + '/api/actions?status=queued', undefined, token);
    ok(qAfter.body.count === before + 1, '低置信度不写回（队列仅 +1，来自入档那条）', { before, after: qAfter.body.count });
    const kWeight = await request('POST', base + '/api/foodsafe/samples/ingest',
      { dish: '红烧肉', weight_g: 150, conf: 99 }, token);
    ok(kWeight.status === 422 && kWeight.body.need_g === 200, '克重拦截优先于置信度判定 → 422', kWeight.body && kWeight.body.error);

    /* ---------- 溯源下钻 ---------- */
    step(8, '溯源批次下钻（批次 → 进货/销售）；无检验报告标「待补」');
    const t1 = await request('GET', base + '/api/foodsafe/trace', undefined, token);
    ok(t1.status === 200 && t1.body.batches === 2, '溯源批次台账 2 条', t1.body.batches);
    ok(t1.body.missing_cert === 1, '其中 1 条无检验报告 → 待补', t1.body.missing_cert);
    const t2 = await request('GET', base + '/api/foodsafe/trace?batch=B20261007-01', undefined, token);
    ok(t2.body.batch && t2.body.batch.ing_name === '猪肉', '按批号命中批次详情（猪肉 / 雨润）', t2.body.batch);
    ok(t2.body.drill.recv.length === 1, '下钻到进货记录 1 条', t2.body.drill.recv);
    ok(t2.body.drill.sales.length >= 1, '下钻到销售记录（同源 best-effort 匹配）', t2.body.drill.sales);
    ok(t2.body.drill.need_cert === false, '该批次检验报告齐备 → need_cert=false', t2.body.drill.need_cert);
    const t3 = await request('GET', base + '/api/foodsafe/trace?batch=B20261008-02', undefined, token);
    ok(t3.body.drill.need_cert === true, '缺报告批次 → need_cert=true（前端标黄「待补」）', t3.body.drill.need_cert);
    const t4 = await request('GET', base + '/api/foodsafe/trace?batch=NOT-EXIST', undefined, token);
    ok(t4.body.batch === null && /未匹配/.test(t4.body.drill.note), '不存在的批号 → 不臆造，给出未匹配说明', t4.body.drill.note);

    /* ---------- 收尾 ---------- */
    step(9, '收尾：阈值持久化与写权限闸门');
    const cfgGet = await request('GET', base + '/api/foodsafe/config', undefined, token);
    ok(cfgGet.body.cert.red === 3 && cfgGet.body.cert.yellow === 60, '阈值持久化（GET /config 回读）', cfgGet.body.cert);
    const noAuth = await request('POST', base + '/api/foodsafe/disinfect', { area: '就餐区' }, null);
    ok(noAuth.status === 401 || noAuth.status === 403, '未登录写操作被拒（401/403）', noAuth.status);

    line('');
    line('M4 食安证照模块验收：全绿（' + CHECKS + ' 断言）');
    line('');
    return 0;

    line('');
    line('M4 食安证照模块验收：全绿（' + CHECKS + ' 断言）');
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
