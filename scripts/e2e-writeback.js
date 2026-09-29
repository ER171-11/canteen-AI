#!/usr/bin/env node
'use strict';
/*
 * scripts/e2e-writeback.js — 写回闭环端到端脚本（T7 / 阶段 6，2026-09-29）
 *
 * 一条命令走通阶段 2–4 引入的写类链路：
 *   铺快照 → 入队 → rev 冲突确认(409) → 正确 rev 确认(待执行) → 店内消费器
 *   → 读 /api/db(baseRev) → 应用算法 → POST /api/sync(machine=QUEUE)
 *   → 回调 /api/actions/{id}/execute(已执行) → 立即推快照回写
 *
 * 断言（§8.2.6 要求硬覆盖）：
 *   · 主链路：待执行可见 → 消费器落库 → 状态已执行 → 店内/云端 rev 对齐
 *   · rev 冲突①：确认层过期 rev → 409 rev mismatch，动作不得离开 queued
 *   · rev 冲突②：/api/sync 层过期 baseRev 且两端同刻改同一记录 → action=merged，
 *                conflicts 报 both-changed-same-time（服务端版本胜出、本机新增不丢）
 *   · 幂等：同一动作不可重复执行（confirm/execute/apply 均 409；消费器重跑零写入）
 *
 * 为什么用 Node 而不是 scripts/e2e-*.sh：本机（Windows）无 bash（任务清单 §5）。
 * 隔离：店内节点进程内起（临时 sqlite）、BFF 子进程（隔离 BFF_DATA_DIR + SI_SCHEDULER=0），
 *      不依赖真实经营数据；pusher 去重状态是 gitignore 的运行时缓存，跑前挪开跑后还原。
 * 红线：只驱动店内**公开 HTTP API**（与消费器同路径），不直连 sqlite、不改 db.js/merge.js。
 *
 * 用法：node scripts/e2e-writeback.js [--verbose] [--keep]
 * 退出码：0 全绿 / 1 断言失败 / 2 环境不满足（Node < 22）
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BFF_DIR = path.join(ROOT, 'bff');
const STORE_NODE_DIR = path.join(BFF_DIR, 'store-node');
const PUSHER_STATE = path.join(STORE_NODE_DIR, 'data', 'pusher_state.json');
const PUSHER_STATE_BAK = PUSHER_STATE + '.e2e-bak';

const ARGV = process.argv.slice(2);
const VERBOSE = ARGV.includes('--verbose');
const KEEP = ARGV.includes('--keep');

const SEED_ING_ID = 'ING-E2E-01';
const SEED_ING_NAME = 'E2E五花肉';
const SEED = {
  ings: [{ id: SEED_ING_ID, name: SEED_ING_NAME, unit: '斤', buy: '斤', initStock: 0, stock: 0, avg: 0 }],
  recv: [], logs: [], suppliers: []
};
const RECV_PAYLOAD = {
  supplier: 'E2E 供应商', date: '2026-09-29', source: 'e2e/writeback',
  po: 'PO-E2E-T7', note: 'T7 写回闭环', method: 'wechat', paid: 60,
  items: [{ ing_id: SEED_ING_ID, name: SEED_ING_NAME, qty: 2, price: 30, recvQty: 2 }]
};
const RECV_NO = 'JH20260929-01';
const CONFLICT_ING_ID = 'ING-E2E-CONF';
const NEW_ING_ID = 'ING-E2E-NEW';
const T_STAMP = '2026-09-29T09:00:00.000Z';

let CHECKS = 0;
let NOTES = 0;
let swallowed = 0;
let bffLog = '';

function line(msg) { process.stdout.write(msg + '\n'); }
function step(n, title) { line(''); line('== ' + n + '. ' + title + ' =='); }
function info(msg) { line('  · ' + msg); }
function note(msg) { NOTES++; line('  ⚠ ' + msg); }

function ok(cond, msg, extra) {
  if (!cond) {
    const tail = extra === undefined ? '' : ' | 实际: ' + JSON.stringify(extra);
    throw new Error('断言失败: ' + msg + tail);
  }
  CHECKS++;
  line('  ✓ ' + msg);
}

function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function findIng(data, id) { return ((data && data.ings) || []).find((i) => i && i.id === id) || null; }
function firstMatch(text, re) { const m = String(text).match(re); return m ? m[0] : ''; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function request(method, url, body, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let payload = null;
    if (body !== undefined && body !== null) {
      payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    }
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request({
      method: method, hostname: u.hostname, port: u.port,
      path: u.pathname + u.search, headers: headers, timeout: timeoutMs || 15000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { /* 非 JSON 保留 raw */ }
        resolve({ status: res.statusCode, body: parsed, raw: raw });
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
    } catch (e) { /* 未就绪，继续轮询 */ }
    if (Date.now() > deadline) throw new Error(label + ' 在 ' + timeoutMs + 'ms 内未就绪: ' + url);
    await sleep(200);
  }
}

/* 消费器：真实 CLI 子进程（跑一轮） */
function runConsumer(storeUrl, bffUrl, token, dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(STORE_NODE_DIR, 'consumer.js'),
      '--store-url', storeUrl, '--bff-url', bffUrl,
      '--token', token, '--db', dbPath, '--once'
    ], { cwd: STORE_NODE_DIR, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code, out: out }));
  });
}

function echoConsumer(out) {
  String(out).split(/\r?\n/).forEach((l) => { if (l.trim()) line('  | ' + l.trim()); });
}

async function main() {
  const major = Number(String(process.versions.node).split('.')[0]);
  if (!Number.isFinite(major) || major < 22) {
    line('环境不满足：本脚本依赖 node:sqlite（消费器落库），需要 Node >= 22，当前 ' + process.versions.node);
    return 2;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canteenai-e2e-'));
  const bffDataDir = path.join(tmpDir, 'bff-data');
  const storeDb = path.join(tmpDir, 'store.db');
  const storeBackupDir = path.join(tmpDir, 'store-backups');
  fs.mkdirSync(bffDataDir, { recursive: true });

  let store = null;
  let bffChild = null;
  let stateStashed = false;
  const origConsoleError = console.error;

  step(0, '环境与隔离目录');
  info('临时目录: ' + tmpDir + '（Node ' + process.versions.node + '）');

  /* 吞掉店内节点「每请求一行」的日志，但放行真正的错误输出 */
  console.error = function () {
    const text = Array.prototype.map.call(arguments, (a) => String(a)).join(' ');
    if (/^\[\d{2}:\d{2}:\d{2}\] (GET|POST|PUT|OPTIONS) \//.test(text)) {
      swallowed++;
      if (VERBOSE) origConsoleError('[store] ' + text);
      return;
    }
    origConsoleError.apply(console, arguments);
  };

  try {
    /* ---------- 1. 店内节点 ---------- */
    step(1, '起店内节点（进程内，临时 sqlite / 临时备份目录）');
    const storePort = await freePort();
    const storeUrl = 'http://127.0.0.1:' + storePort;
    const { DEFAULT_CONFIG, startServer } = require(path.join(STORE_NODE_DIR, 'server.js'));
    store = await startServer(Object.assign({}, DEFAULT_CONFIG, {
      port: storePort, host: '127.0.0.1',
      db_path: storeDb, backup_dir: storeBackupDir,
      machine_id: 'E2E-SHOP', serve_static: false, cold_backup_on_start: false
    }));
    await waitHealthy(storeUrl + '/api/health', 10000, '店内节点');
    const rev0 = await request('GET', storeUrl + '/api/rev');
    ok(rev0.status === 200 && rev0.body.empty === true, '店内节点健康且为空库（不依赖真实经营数据）', rev0.body);

    /* ---------- 2. 云端 BFF ---------- */
    step(2, '起云端 BFF（隔离 BFF_DATA_DIR，关掉后台 tick）');
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
    info('BFF: ' + bffUrl + '（数据目录已隔离，后台 tick 已关）');

    /* ---------- 3. 登录 ---------- */
    step(3, '老板登录（boss / wufu123）');
    const login = await request('POST', bffUrl + '/api/auth/login',
      { account: 'boss', password: 'wufu123', device_fp: 'e2e-writeback' });
    ok(login.status === 200 && login.body && login.body.ok === true && !!login.body.token,
      '登录成功并取得 token（写操作需 actions.write）', login.body && login.body.error);
    const token = login.body.token;

    /* ---------- 4. 铺初始快照 ---------- */
    step(4, '铺初始快照：店内首写(rev1) → 推快照到云端');
    const seedRes = await request('POST', storeUrl + '/api/sync', { baseRev: 0, data: SEED, machine: 'E2E-SEED' });
    ok(seedRes.status === 200 && seedRes.body.ok === true && seedRes.body.rev === 1,
      '店内空库首写 → rev 前进到 1（action=' + (seedRes.body && seedRes.body.action) + '）', seedRes.body);
    const push0 = await request('POST', bffUrl + '/api/snapshot/push',
      { rev: 1, data: SEED, ext: {}, machine: 'E2E-SEED' }, token);
    ok(push0.status === 200 && push0.body.ok === true, '云端接收初始快照（rev1）', push0.body);
    const snap0 = await request('GET', bffUrl + '/api/snapshot/latest', undefined, token);
    ok(snap0.status === 200 && snap0.body.rev === 1,
      '云端快照 rev=1（confirm 的 rev 校验基准）', snap0.body && snap0.body.rev);

    /* ---------- 5. 入队 + 队列内幂等 ---------- */
    step(5, '入队 recv.inbound（审批中心可见）+ 队列内幂等');
    const enqBody = JSON.stringify({ type: 'recv.inbound', payload: RECV_PAYLOAD, operator: 'boss' });
    const enq = await request('POST', bffUrl + '/api/actions', enqBody, token);
    ok(enq.status === 200 && enq.body.ok === true && enq.body.status === 'queued' && enq.body.dedup === false,
      '动作入队（queued），rev=' + (enq.body && enq.body.rev), enq.body);
    const actId = enq.body.id;
    const queued = await request('GET', bffUrl + '/api/actions?status=queued', undefined, token);
    ok(queued.body.count === 1 && queued.body.items[0].id === actId, '审批中心（queued 列表）可见且仅 1 条', queued.body.count);
    const enq2 = await request('POST', bffUrl + '/api/actions', enqBody, token);
    ok(enq2.body.id === actId && enq2.body.dedup === true,
      '同一 payload 重复入队 → dedup=true 复用同一 id（队列内幂等）', enq2.body.id);

    /* ---------- 6. rev 冲突①：确认层 ---------- */
    step(6, 'rev 冲突①（确认层）：过期 rev 确认必须被拒且动作不离开 queued');
    const badConfirm = await request('POST', bffUrl + '/api/actions/' + actId + '/confirm', { rev: 999 }, token);
    ok(badConfirm.status === 409 && badConfirm.body.error === 'rev mismatch',
      '过期 rev 确认 → 409 rev mismatch（expected_rev=' + badConfirm.body.expected_rev + '）', badConfirm.body);
    const stillQueued = await request('GET', bffUrl + '/api/actions?status=queued', undefined, token);
    ok(stillQueued.body.count === 1 && stillQueued.body.items[0].status === 'queued',
      '被拒后动作仍在 queued（未被半确认）', stillQueued.body.count);
    const pending0 = await request('GET', bffUrl + '/api/actions?status=' + encodeURIComponent('待执行'), undefined, token);
    ok(pending0.body.count === 0, '被拒后「待执行」为 0（消费器看不到它）', pending0.body.count);

    /* ---------- 7. 正确 rev 确认 ---------- */
    step(7, '正确 rev 确认（queued → 待执行）');
    const confirm = await request('POST', bffUrl + '/api/actions/' + actId + '/confirm', { rev: 1 }, token);
    ok(confirm.status === 200 && confirm.body.status === '待执行', '确认通过 → 待执行', confirm.body);
    const pending = await request('GET', bffUrl + '/api/actions?status=' + encodeURIComponent('待执行'), undefined, token);
    ok(pending.body.count === 1 && pending.body.items[0].id === actId,
      '云端队列「待执行」命中该动作（消费器的唯一输入）', pending.body.count);
    /* ---------- 8. 店内消费器 ---------- */
    step(8, '店内消费器消费（真实 CLI 子进程，只跑一轮）');
    if (fs.existsSync(PUSHER_STATE)) {
      fs.copyFileSync(PUSHER_STATE, PUSHER_STATE_BAK);
      stateStashed = true;
    }
    try { fs.unlinkSync(PUSHER_STATE); } catch (e) { /* 不存在即忽略 */ }
    info('已临时挪开 pusher 去重状态（gitignore 的运行时缓存），跑完还原');

    const run1 = await runConsumer(storeUrl, bffUrl, token, storeDb);
    echoConsumer(run1.out);
    ok(run1.code === 0, '消费器退出码 0', run1.code);
    ok(/拉到待执行动作 1 条/.test(run1.out), '消费器拉到 1 条待执行动作（队列驱动）',
      firstMatch(run1.out, /拉到待执行动作 \d+ 条/));
    ok(/执行成功 id=/.test(run1.out), '消费器应用算法 + /api/sync 写回成功',
      firstMatch(run1.out, /执行成功.*/));
    ok(!/需人工确认/.test(run1.out), '未落入「需人工确认」保命路径（rev 未冲突）');

    /* ---------- 9. 主链路断言 ---------- */
    step(9, '主链路断言：已执行 / 库存入账 / rev 前进 / 快照回写对齐');
    const st = await request('GET', bffUrl + '/api/actions/' + actId + '/status', undefined, token);
    ok(st.status === 200 && st.body.status === '已执行', '动作状态 = 已执行', st.body && st.body.status);
    ok(!!st.body.result && st.body.result.new_rev != null,
      '回执含 new_rev=' + (st.body.result && st.body.result.new_rev), st.body.result);
    const newRev = st.body.result.new_rev;

    const done = await request('GET', bffUrl + '/api/actions?status=' + encodeURIComponent('已执行'), undefined, token);
    const doneRec = done.body.items.find((a) => a.id === actId);
    ok(!!doneRec && doneRec.via === 'store', '落库方 = 店内消费器（via=store，非云端 apply）', doneRec && doneRec.via);
    ok(!!doneRec && doneRec.executed_rev === newRev,
      '执行 rev 已登记回写（executed_rev=' + (doneRec && doneRec.executed_rev) + '）', doneRec && doneRec.executed_rev);

    const db1 = await request('GET', storeUrl + '/api/db');
    ok(db1.status === 200 && db1.body.rev === newRev, '店内 rev 前进到 ' + newRev + '（1 → 2）', db1.body.rev);
    ok(db1.body.machine === 'QUEUE', '店内写入方标识 = QUEUE（走消费器 /api/sync 带 rev 路径）', db1.body.machine);
    const recv1 = db1.body.data.recv || [];
    ok(recv1.length === 1 && recv1[0].no === RECV_NO, '店内落库 1 张进货单 ' + RECV_NO, recv1.map((r) => r.no));
    ok(recv1[0].payable === 60 && recv1[0].payments.length === 1 && recv1[0].method === 'wechat',
      '单据口径正确（应付 60 / 实付 1 条 / 方式 wechat）',
      { payable: recv1[0].payable, payments: recv1[0].payments.length, method: recv1[0].method });
    const ing1 = findIng(db1.body.data, SEED_ING_ID);
    ok(!!ing1 && ing1.stock === 2 && ing1.avg === 30,
      '库存按 rebuildStock 口径入账（' + SEED_ING_NAME + ' 0→2，均价 30）', ing1);

    const snap1 = await request('GET', bffUrl + '/api/snapshot/latest', undefined, token);
    ok(snap1.body.rev === newRev, '快照已回写：云端 rev ' + snap1.body.rev + ' = 店内 rev ' + newRev, snap1.body.rev);
    ok(sameJson(snap1.body.data.recv, db1.body.data.recv), '回写快照的 recv 与店内逐字段一致');
    const snapIng = findIng(snap1.body.data, SEED_ING_ID);
    ok(!!snapIng && snapIng.stock === 2, '回写快照的库存已同步（stock=2）', snapIng && snapIng.stock);

    /* ---------- 10. 幂等：同一动作不可重复执行 ---------- */
    step(10, '幂等断言：同一动作不可重复执行');
    const c2 = await request('POST', bffUrl + '/api/actions/' + actId + '/confirm', { rev: newRev }, token);
    ok(c2.status === 409 && /invalid state/.test(String(c2.body.error || '')),
      '重复确认 → 409 ' + (c2.body && c2.body.error), c2.status);
    const e2 = await request('POST', bffUrl + '/api/actions/' + actId + '/execute', { result: { new_rev: 999 } }, token);
    ok(e2.status === 409 && /invalid state/.test(String(e2.body.error || '')),
      '重复回调 execute → 409 ' + (e2.body && e2.body.error), e2.status);
    const a2 = await request('POST', bffUrl + '/api/actions/' + actId + '/apply', {}, token);
    ok(a2.status === 409 && /invalid state/.test(String(a2.body.error || '')),
      '云端重复 apply → 409 ' + (a2.body && a2.body.error), a2.status);

    const run2 = await runConsumer(storeUrl, bffUrl, token, storeDb);
    echoConsumer(run2.out);
    ok(run2.code === 0, '消费器重跑退出码 0', run2.code);
    ok(/拉到待执行动作 0 条/.test(run2.out), '重跑时「待执行」为空（已执行动作不会被再次消费）',
      firstMatch(run2.out, /拉到待执行动作 \d+ 条/));
    const db2 = await request('GET', storeUrl + '/api/db');
    const snap2 = await request('GET', bffUrl + '/api/snapshot/latest', undefined, token);
    ok(db2.body.rev === newRev && (db2.body.data.recv || []).length === 1,
      '重复消费零写入：店内 rev 仍 ' + newRev + '、recv 仍 1 张', { rev: db2.body.rev, recv: (db2.body.data.recv || []).length });
    ok(snap2.body.rev === newRev, '重复消费未回写新快照（云端 rev 仍 ' + newRev + '）', snap2.body.rev);

    /* ---------- 11. rev 冲突②：/api/sync 层 ---------- */
    step(11, 'rev 冲突②（/api/sync 层）：过期 baseRev + 两端同刻改同一记录 → 三向合并报冲突');
    const cur = await request('GET', storeUrl + '/api/db');
    const mkIng = (stock) => ({
      id: CONFLICT_ING_ID, name: 'E2E冲突原料', unit: 'kg', buy: 'kg',
      initStock: 0, qty: stock, stock: stock, avg: 12, _u: T_STAMP
    });

    const mineA = clone(cur.body.data);
    mineA.ings = (mineA.ings || []).concat([mkIng(1)]);
    const syncA = await request('POST', storeUrl + '/api/sync', { baseRev: cur.body.rev, data: mineA, machine: 'E2E-LOCAL' });
    ok(syncA.status === 200 && syncA.body.action === 'fast',
      '基准写入：rev ' + cur.body.rev + ' → ' + syncA.body.rev + '（action=fast）', syncA.body.action);
    const baseRev = syncA.body.rev;

    const mineB = clone(mineA);
    mineB.ings = mineB.ings.map((i) => (i.id === CONFLICT_ING_ID ? mkIng(5) : i));
    const syncB = await request('POST', storeUrl + '/api/sync', { baseRev: baseRev, data: mineB, machine: 'E2E-LOCAL' });
    ok(syncB.status === 200 && syncB.body.action === 'fast',
      '对端（服务端）先改同一条记录 → rev ' + baseRev + ' → ' + syncB.body.rev, syncB.body.action);

    const mineC = clone(mineA);
    mineC.ings = mineC.ings.map((i) => (i.id === CONFLICT_ING_ID ? mkIng(9) : i))
      .concat([{ id: NEW_ING_ID, name: 'E2E本机新增', unit: 'kg', initStock: 0, stock: 1, avg: 7 }]);
    const syncC = await request('POST', storeUrl + '/api/sync', { baseRev: baseRev, data: mineC, machine: 'E2E-LOCAL' });

    ok(syncC.status === 200 && syncC.body.action === 'merged',
      '过期 baseRev（' + baseRev + ' < 当前 ' + syncB.body.rev + '）→ 走三向合并（action=merged）', syncC.body.action);
    const conflicts = syncC.body.conflicts || [];
    const hit = conflicts.find((c) => c.coll === 'ings' && c.id === CONFLICT_ING_ID);
    ok(conflicts.length >= 1 && !!hit && hit.reason === 'both-changed-same-time',
      '冲突被显式上报（ings/' + CONFLICT_ING_ID + ' → ' + (hit && hit.reason) + '），不静默覆盖',
      conflicts);
    ok(syncC.body.rev === syncB.body.rev + 1,
      '冲突合并仍以 rev+1 落库（' + syncB.body.rev + ' → ' + syncC.body.rev + '）', syncC.body.rev);
    const mergedConflict = findIng(syncC.body.data, CONFLICT_ING_ID);
    ok(!!mergedConflict && mergedConflict.stock === 5,
      '冲突时服务端版本胜出（stock=5，过期本机 stock=9 不覆盖）', mergedConflict);
    ok(!!findIng(syncC.body.data, NEW_ING_ID), '本机新增记录不因冲突丢失（stock=1 已并入）');
    const db3 = await request('GET', storeUrl + '/api/db');
    ok(db3.body.rev === syncC.body.rev && !!findIng(db3.body.data, NEW_ING_ID),
      '店内库已落到合并结果（rev=' + db3.body.rev + '）', db3.body.rev);

    /* ---------- 12. 事后幂等：连点两下不产生第二条 ---------- */
    step(12, '事后幂等：已执行后复投同一 payload 不新建动作（连点两下）');
    const enq3 = await request('POST', bffUrl + '/api/actions', enqBody, token);
    ok(enq3.status === 200 && enq3.body.dedup === true && enq3.body.dedup_of === 'executed' && enq3.body.id === actId,
      '已执行后复投 → 复用原动作 ' + actId + '（dedup=true / dedup_of=executed），不新建', enq3.body);
    ok(enq3.body.status === '已执行',
      '复投响应直接回「已执行」（连点第二次看到的不是一条新待审批）', enq3.body.status);
    const allActions = await request('GET', bffUrl + '/api/actions', undefined, token);
    ok(allActions.body.count === 1, '审批中心总条数仍为 1（连点两下只产生一条动作）', allActions.body.count);
    ok(allActions.body.items.filter((a) => a.status === 'queued').length === 0,
      '没有新增 queued 动作（审批中心不会出现重复待审批）');
    note('事后幂等窗口 = 5 分钟，且要求 payload 逐字节相同（换个单号/改个数量即视为新操作）；前端请求级幂等键仍未做。');
    const pending3 = await request('GET', bffUrl + '/api/actions?status=' + encodeURIComponent('待执行'), undefined, token);
    ok(pending3.body.count === 0, '复投后「待执行」仍为 0（复投本身不触发执行）', pending3.body.count);
    const db4 = await request('GET', storeUrl + '/api/db');
    ok(db4.body.rev === db3.body.rev && (db4.body.data.recv || []).length === 1,
      '复投零写入：店内 rev 仍 ' + db4.body.rev + '、recv 仍 1 张', { rev: db4.body.rev, recv: (db4.body.data.recv || []).length });


  } finally {
    /* ---------- 收尾 ---------- */
    console.error = origConsoleError;
    if (bffChild && !bffChild.killed) {
      try { bffChild.kill(); } catch (e) { /* best effort */ }
    }
    if (store && store.server) {
      await new Promise((res) => store.server.close(res));
    }
    if (store && store.store && typeof store.store.close === 'function') {
      try { store.store.close(); } catch (e) { /* best effort */ }
    }
    try { fs.unlinkSync(PUSHER_STATE); } catch (e) { /* 主流程已删过 */ }
    if (stateStashed) {
      try { fs.renameSync(PUSHER_STATE_BAK, PUSHER_STATE); } catch (e) { /* 还原失败不致命 */ }
    }
    try { fs.unlinkSync(PUSHER_STATE_BAK); } catch (e) { /* 忽略 */ }
    if (!KEEP) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }
  }
}

if (require.main === module) {
  const started = Date.now();
  Promise.resolve(main()).then((code) => {
    const exit = typeof code === 'number' ? code : 0;
    if (exit === 0) {
      line('');
      step('OK', '写回闭环端到端全绿');
      line('  断言 ' + CHECKS + ' 条 · 备注 ' + NOTES + ' 条 · 店内 API 请求 ' + swallowed + ' 次 · 耗时 '
        + ((Date.now() - started) / 1000).toFixed(1) + 's');
      line('WRITEBACK E2E OK');
    }
    process.exitCode = exit;
  }).catch((e) => {
    line('');
    line('WRITEBACK E2E FAIL: ' + (e && e.message ? e.message : e));
    if (bffLog) {
      line('--- BFF 日志尾部 ---');
      String(bffLog).trimEnd().split(/\r?\n/).slice(-20).forEach((l) => line('  ' + l));
    }
    if (VERBOSE && e && e.stack) line(e.stack);
    process.exitCode = 1;
  });
}

module.exports = { main: main };
