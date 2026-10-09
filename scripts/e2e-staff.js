#!/usr/bin/env node
'use strict';
/*
 * scripts/e2e-staff.js — M2 排班员工模块验收（T6，验收四项）
 *
 *   ① 迟到阈值可配     POST /api/staff/config 后，同一打卡的判定随之变化
 *   ② 健康证 <7 天红   GET /api/staff/train → certs 中 <7 天 level=red 且 blocked=true
 *   ③ 换班双确认带 rev request → accept(rev) → approve(rev) → 2 条 staff.shift_upsert 入队；
 *                      rev 不符 / 重复审批 → 409，且不产生写回
 *   ④ 培训未通过禁接单 训未满 5/5 的员工 → blocked_skus 命中；skill_matrix.checkSkill → ok:false
 *
 * 隔离：临时 BFF_DATA_DIR（不依赖真实经营数据），BFF 子进程，SI_SCHEDULER=0。
 * 红线：只驱动 BFF 公开 HTTP API；写操作全部经 actions 队列，脚本不直连 sqlite。
 * 用法：node scripts/e2e-staff.js [--verbose] [--keep]
 * 退出码：0 全绿 / 1 断言失败
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
function addDays(n) {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
}

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
    if (body !== undefined && body !== null) {
      payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    }
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
        try { parsed = JSON.parse(raw); } catch (e) { /* 保留 raw */ }
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

/* ---------- 种子数据（快照 ext.staff_*） ---------- */
const SOP_ROWS = [];
for (let i = 1; i <= 5; i += 1) {
  SOP_ROWS.push({ staff_id: 'E1', staff_name: '张三', course: '红饺 SOP', passed: 1, remark: '通过 ' + i + '/5', ts: TODAY + ' 1' + i + ':00' });
}
const SEED_DATA = { config: {} };
const SEED_EXT = {
  staff_shifts: [
    { staff_id: 'E1', staff_name: '张三', date: TODAY, shift: '早班', start_time: '09:00', end_time: '17:00', role: '后厨' },
    { staff_id: 'E2', staff_name: '李四', date: TODAY, shift: '早班', start_time: '09:00', end_time: '17:00', role: '后厨' },
    { staff_id: 'E3', staff_name: '王五', date: TODAY, shift: '中班', start_time: '11:00', end_time: '21:00', role: '后厨' }
  ],
  staff_clock: [
    { staff_id: 'E1', staff_name: '张三', ts: TODAY + ' 09:08', kind: '上班', status: '' },
    { staff_id: 'E2', staff_name: '李四', ts: TODAY + ' 09:45', kind: '上班', status: '' }
  ],
  staff_perf: [
    { staff_id: 'E1', staff_name: '张三', score: 98.5, hours: 45, remark: '出品 412 份' },
    { staff_id: 'E2', staff_name: '李四', score: 88, hours: 40, remark: '出品 350 份' }
  ],
  staff_train: SOP_ROWS.concat([
    { staff_id: 'E2', staff_name: '李四', course: '黑饺 SOP', passed: 1, remark: '进行中 1/5', ts: TODAY + ' 09:00' },
    { staff_id: 'E3', staff_name: '王五', course: '黑饺 SOP', passed: 0, remark: '未开始 0/5', ts: TODAY + ' 09:00' }
  ]),
  fs_certs: [
    { type: '健康证', name: '张三', expire_at: addDays(3) },
    { type: '健康证', name: '李四', expire_at: addDays(20) },
    { type: '健康证', name: '王五', expire_at: addDays(200) }
  ]
};

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canteenai-staff-'));
  const bffDataDir = path.join(tmpDir, 'bff-data');
  fs.mkdirSync(bffDataDir, { recursive: true });
  let bffChild = null;

  step(0, '环境与隔离目录');
  info('临时目录: ' + tmpDir + '（Node ' + process.versions.node + '）');

  try {
    step(1, '起云端 BFF（隔离 BFF_DATA_DIR，关后台 tick）');
    const bffPort = await freePort();
    const bffUrl = 'http://127.0.0.1:' + bffPort;
    bffChild = spawn(process.execPath, [path.join(BFF_DIR, 'server.js')], {
      cwd: BFF_DIR,
      env: Object.assign({}, process.env, {
        BFF_PORT: String(bffPort), BFF_HOST: '127.0.0.1',
        BFF_DATA_DIR: bffDataDir, SI_SCHEDULER: '0'
      }),
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    bffChild.stdout.on('data', (d) => { bffLog += d.toString(); if (VERBOSE) line('[bff] ' + d.toString().trimEnd()); });
    bffChild.stderr.on('data', (d) => { bffLog += d.toString(); if (VERBOSE) line('[bff!] ' + d.toString().trimEnd()); });
    await waitHealthy(bffUrl + '/api/health', 30000, '云端 BFF');
    info('BFF: ' + bffUrl);

    step(2, '老板登录 + 铺快照（含 ext.staff_* 与健康证）');
    const login = await request('POST', bffUrl + '/api/auth/login',
      { account: 'boss', password: 'wufu123', device_fp: 'e2e-staff' });
    ok(login.status === 200 && login.body && login.body.ok && !!login.body.token, '登录成功取得 token');
    const token = login.body.token;
    const push = await request('POST', bffUrl + '/api/snapshot/push',
      { rev: 1, data: SEED_DATA, ext: SEED_EXT, machine: 'E2E-STAFF' }, token);
    ok(push.status === 200 && push.body.ok === true, '快照推送成功（rev=1）', push.body);

    /* ---------- 验收① 迟到阈值可配 ---------- */
    step(3, '验收① 迟到阈值可配（同一打卡，判定随阈值变化）');
    const c1 = await request('GET', bffUrl + '/api/staff/clock?date=' + TODAY, undefined, token);
    ok(c1.status === 200 && c1.body.ok === true, 'GET /api/staff/clock 可用');
    ok(c1.body.thresholds.late_min === 10 && c1.body.thresholds.absent_min === 30,
      '默认阈值 late=10 / absent=30', c1.body.thresholds);
    const e1a = c1.body.rows.find((r) => r.staff_id === 'E1');
    const e2a = c1.body.rows.find((r) => r.staff_id === 'E2');
    const e3a = c1.body.rows.find((r) => r.staff_id === 'E3');
    ok(e1a && e1a.status === '准点', '09:00 班 / 09:08 打卡 → 准点（默认阈值下）', e1a && e1a.status);
    ok(e2a && e2a.status === '缺勤', '09:00 班 / 09:45 打卡 → 缺勤（>30 分）', e2a && e2a.status);
    ok(e3a && e3a.status === '缺勤' && e3a.clock_ts === null, '无打卡 → 缺勤', e3a && e3a.status);
    ok(c1.body.expected === 3 && c1.body.clocked === 2 && c1.body.absent === 2,
      '应到 3 / 实到 2 / 缺勤 2 汇总正确', { e: c1.body.expected, c: c1.body.clocked, a: c1.body.absent });

    const cfgsave = await request('POST', bffUrl + '/api/staff/config', { attendance: { late_min: 5, absent_min: 60 } }, token);
    ok(cfgsave.status === 200 && cfgsave.body.attendance.late_min === 5, 'POST /api/staff/config 阈值改为 late=5 / absent=60', cfgsave.body);
    const c2 = await request('GET', bffUrl + '/api/staff/clock?date=' + TODAY, undefined, token);
    const e1b = c2.body.rows.find((r) => r.staff_id === 'E1');
    const e2b = c2.body.rows.find((r) => r.staff_id === 'E2');
    ok(c2.body.thresholds.late_min === 5, '阈值生效（GET 回读到 5）', c2.body.thresholds);
    ok(e1b && e1b.status === '迟到 8 分', '同一 09:08 打卡 → 迟到 8 分（阈值收紧后）', e1b && e1b.status);
    ok(e2b && e2b.status === '迟到 45 分', '同一 09:45 打卡 → 由缺勤变迟到 45 分（absent 放宽到 60）', e2b && e2b.status);

    /* ---------- 验收② 健康证 <7 天红 ---------- */
    step(4, '验收② 健康证到期预警（<7 天红并禁岗）');
    const tr = await request('GET', bffUrl + '/api/staff/train', undefined, token);
    ok(tr.status === 200 && tr.body.ok === true, 'GET /api/staff/train 可用');
    const red = tr.body.certs.filter((c) => c.level === 'red');
    const warn = tr.body.certs.filter((c) => c.level === 'warn');
    ok(red.length === 1 && red[0].staff_name === '张三' && red[0].blocked === true,
      '张三（3 天后到期）→ level=red 且 blocked=true', red);
    ok(warn.length === 1 && warn[0].staff_name === '李四',
      '李四（20 天后到期）→ level=warn（不阻断）', warn);
    ok(tr.body.certs[0].staff_name === '张三', 'certs 按剩余天数升序（最紧急在前）', tr.body.certs.map((c) => c.staff_name));
    const zhang = tr.body.progress.find((p) => p.staff_id === 'E1');
    ok(zhang && zhang.blocked === true, '禁岗联动到培训视图（张三 blocked=true）', zhang && zhang.blocked);

    /* ---------- 验收③ 换班双确认带 rev ---------- */
    step(5, '验收③ 换班双确认（request → accept → approve），全程带 rev');
    const req1 = await request('POST', bffUrl + '/api/staff/swaps/request', {
      date: TODAY, shift: '早班', from_staff: 'E2', from_name: '李四',
      to_staff: 'E3', to_name: '王五', start_time: '09:00', end_time: '17:00', role: '后厨', reason: '家中有事'
    }, token);
    ok(req1.status === 200 && req1.body.ok && req1.body.swap.status === 'pending_peer',
      'A 发起换班 → pending_peer', req1.body);
    const sid = req1.body.swap.id;

    const badAccept = await request('POST', bffUrl + '/api/staff/swaps/' + sid + '/accept', { rev: 999 }, token);
    ok(badAccept.status === 409 && badAccept.body.error === 'rev mismatch',
      'B 同意带过期 rev → 409 rev mismatch', badAccept.body);
    const badApproveEarly = await request('POST', bffUrl + '/api/staff/swaps/' + sid + '/approve', { rev: 1 }, token);
    ok(badApproveEarly.status === 409, '未同意即审批 → 409（状态机不跳级）', badApproveEarly.body);

    const acc = await request('POST', bffUrl + '/api/staff/swaps/' + sid + '/accept', { rev: 1 }, token);
    ok(acc.status === 200 && acc.body.swap.status === 'pending_manager',
      'B 同意（rev=1）→ pending_manager', acc.body && acc.body.swap && acc.body.swap.status);

    const badApprove = await request('POST', bffUrl + '/api/staff/swaps/' + sid + '/approve', { rev: 999 }, token);
    ok(badApprove.status === 409 && badApprove.body.error === 'rev mismatch',
      '店长审批带过期 rev → 409，且不写回', badApprove.body);

    const q0 = await request('GET', bffUrl + '/api/actions?status=queued', undefined, token);
    ok(q0.body.count === 0, '未审批前队列为空（无写回）', q0.body.count);

    const appr = await request('POST', bffUrl + '/api/staff/swaps/' + sid + '/approve', { rev: 1 }, token);
    ok(appr.status === 200 && appr.body.swap.status === 'applied',
      '店长审批（rev=1）→ applied', appr.body && appr.body.swap && appr.body.swap.status);
    ok(Array.isArray(appr.body.write_actions) && appr.body.write_actions.length === 2,
      '写回入队 2 条（接手人 + 原值班人转休）', appr.body.write_actions);

    const q1 = await request('GET', bffUrl + '/api/actions?status=queued', undefined, token);
    const types = q1.body.items.map((a) => a.type);
    ok(q1.body.count === 2 && types.every((t) => t === 'staff.shift_upsert'),
      '队列内 2 条 staff.shift_upsert（queued，待确认台）', types);
    const toPayload = q1.body.items.map((a) => a.payload).find((p) => p.staff_id === 'E3');
    const fromPayload = q1.body.items.map((a) => a.payload).find((p) => p.staff_id === 'E2');
    ok(toPayload && toPayload.shift === '早班', '接手人 E3 获得早班', toPayload);
    ok(fromPayload && fromPayload.shift === '休', '原值班人 E2 转「休」', fromPayload);

    const again = await request('POST', bffUrl + '/api/staff/swaps/' + sid + '/approve', { rev: 1 }, token);
    ok(again.status === 409, '重复审批 → 409（幂等，不重复写回）', again.body);

    /* ---------- 验收④ 培训未通过禁接单 ---------- */
    step(6, '验收④ 培训未通过禁接单（培训 ↔ SKU）');
    const tr2 = await request('GET', bffUrl + '/api/staff/train', undefined, token);
    const li = tr2.body.progress.find((p) => p.staff_id === 'E2');
    const zhang2 = tr2.body.progress.find((p) => p.staff_id === 'E1');
    ok(li && li.blocked_skus.indexOf('SKU-WF-HEI') >= 0,
      '李四（黑饺 SOP 1/5 未通过）→ blocked_skus 命中 SKU-WF-HEI', li && li.blocked_skus);
    ok(zhang2 && zhang2.blocked_skus.length === 0,
      '张三（红饺 SOP 5/5 已通过）→ 无 blocked_skus', zhang2 && zhang2.blocked_skus);
    const zhangCourse = zhang2.courses.find((c) => c.course === '红饺 SOP');
    ok(zhangCourse && zhangCourse.done === 5 && zhangCourse.total === 5 && zhangCourse.passed === true,
      'SOP 进度 n/5 读作 5/5 且 passed', zhangCourse);

    const skill = require(path.join(BFF_DIR, 'lib', 'skill_matrix.js'));
    const deny = skill.checkSkill(SEED_EXT.staff_train, {}, { sku_id: 'SKU-WF-HEI', staff_id: 'E3' });
    ok(deny.ok === false && deny.gated === true, 'checkSkill(E3, 黑饺 SKU) → 拒绝', deny);
    const allow = skill.checkSkill(SEED_EXT.staff_train, {}, { sku_id: 'SKU-WF-HONG', staff_id: 'E1' });
    ok(allow.ok === true, 'checkSkill(E1, 红饺 SKU) → 放行', allow);
    const free = skill.checkSkill(SEED_EXT.staff_train, {}, { sku_id: 'SKU-NO-MAP', staff_id: 'E3' });
    ok(free.ok === true && free.gated === false, '无映射 SKU → 不拦（避免误伤历史链路）', free);

    /* ---------- 收尾 ---------- */
    step(7, '收尾');
    const cfgGet = await request('GET', bffUrl + '/api/staff/config', undefined, token);
    ok(cfgGet.body.attendance.late_min === 5, '配置持久化（GET /api/staff/config 回读 late=5）', cfgGet.body.attendance);
    ok(CHECKS > 0, '累计断言 ' + CHECKS + ' 条全绿');

    line('');
    line('M2 排班员工模块验收：全绿（' + CHECKS + ' 断言）');
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
