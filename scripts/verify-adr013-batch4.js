#!/usr/bin/env node
'use strict';
/*
 * scripts/verify-adr013-batch4.js — ADR-013 第 4 批（W4-01 / W4-02 / W4-03）活体验证
 *
 * 只驱动 BFF 公开 HTTP API，隔离在临时 BFF_DATA_DIR + 随机端口，不污染真实快照。
 * 覆盖（逐项单独验收，见 ADR-013 §7「用户可感知」）：
 *
 *   W4-01 导入 JSON 备份恢复
 *     · 预览只读零写（快照 rev/内容不变）
 *     · 收银越权 403（高危门禁）
 *     · 老板提交 → 暂存 data/imports/ + 入队 → 确认 → 执行：整包 data+ext 被导入内容替换、rev 递增
 *     · 执行前自动生成新备份（「导入恢复前自动备份」）
 *     · 同一文件重复提交命中队列幂等
 *
 *   W4-02 重置为真实数据基线
 *     · GET /api/snapshot/baselines 列出随包制品（bff/baselines/baseline-v1.json）+ 校验和通过
 *     · 预览：将丢弃当前 / 将恢复基线（销售 0）
 *     · 执行：销售/报价/流水归零、原料与菜品回到基线、ext 清空
 *
 *   W4-03 清空业务数据
 *     · 预览两档差异
 *     · business：ings/dishes/recv/orders/sales/quotes/logs/rec 同组清，config/rest 保留，
 *       ext 业务表清空但主数据表（桌台）保留，账号文件不动
 *     · all：只剩 data.v、ext 清空、org.json/settle_template.json/tokens.json 被删；
 *       之后用 boss/wufu123 重新登录成功（org 自动重播种 → 「回到首次安装」而非「锁死」）
 *
 * 用法：node scripts/verify-adr013-batch4.js [--verbose] [--keep]
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
      path: u.pathname + u.search, headers, timeout: timeoutMs || 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
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

/* 种子：有销售/流水/配方/主数据，便于「导入 / 重置 / 清空」三种覆盖都看得出差异 */
const SEED = {
  rev: 1,
  data: {
    rest: '熊猫五福测试餐厅',
    config: { safety_stock: { 面粉: 5 } },
    ings: [
      { id: 'I1', name: '面粉', cat: '粮油', unit: '斤', buy: '斤', conv: 1, avg: 5, stock: 10, qty: 10, safe: 1, yld: 1, on: true },
      { id: 'I2', name: '猪肉', cat: '肉类', unit: '斤', buy: '斤', conv: 1, avg: 20, stock: 6, qty: 6, safe: 1, yld: 1, on: true },
    ],
    dishes: [{ id: 'D1', name: '长寿饺', price: 32 }],
    logs: [{ type: '手工调整', ing: 'I1', date: '2026-10-01', qty: 10, inCost: 5, ref: '期初' }],
    recv: [],
    orders: [],
    quotes: [],
    sales: [
      { id: 'S1', date: '2026-10-02', amount: 32, dish: '长寿饺', qty: 1 },
      { id: 'S2', date: '2026-10-03', amount: 64, dish: '长寿饺', qty: 2 },
    ],
  },
  ext: {
    recipes: [{ sku_id: 'D1', name: '长寿饺', main: ['面粉100g'] }],
    pos_tables: [{ table_id: 'T1', name: 'A1' }],
    accept_standards: [{ ing_name: '面粉' }],
    fin_cash: [{ id: 1, amount: 100 }],
  },
};

/* 导入文件：与当前现场完全不同（1 种原料 / 2 条销售 / 自带 ext） */
const IMPORT_SNAP = {
  rev: 7,
  generated_at: '2026-10-30T00:00:00.000Z',
  data: {
    v: 4,
    rest: '导入餐厅',
    config: {},
    ings: [{ id: 'X1', name: '导入原料', unit: '斤', buy: '斤', conv: 1, avg: 3, stock: 4, qty: 4, on: true }],
    dishes: [],
    recv: [],
    orders: [],
    quotes: [],
    logs: [],
    sales: [{ id: 'IS1', date: '2026-10-20', amount: 10 }, { id: 'IS2', date: '2026-10-21', amount: 20 }],
  },
  ext: { recipes: [], pos_tables: [{ table_id: 'IT1' }] },
};

/** 入队 → 确认 → 执行（BFF 侧 apply） */
async function runAction(base, token, type, payload) {
  const enq = await request('POST', base + '/api/actions', { type, payload, operator: 'boss' }, token);
  ok(enq.status === 200 && enq.body && enq.body.ok && !!enq.body.id, '入队 ' + type, enq.body);
  const id = enq.body.id;
  const cf = await request('POST', base + '/api/actions/' + id + '/confirm', { operator: 'boss', rev: enq.body.rev }, token);
  ok(cf.status === 200 && cf.body && cf.body.ok, '确认 ' + type + '（rev 乐观锁通过）', cf.body);
  const ap = await request('POST', base + '/api/actions/' + id + '/apply', {}, token);
  ok(ap.status === 200, '执行 ' + type + ' 返回 200', ap.body);
  return { id, apply: ap.body };
}

async function latest(base, token) {
  const r = await request('GET', base + '/api/snapshot/latest', undefined, token);
  ok(r.status === 200 && r.body && r.body.data, '读取快照 /api/snapshot/latest', r.status);
  return { rev: r.body.rev, data: r.body.data, ext: r.body.ext || {} };
}

async function backups(base, token) {
  const r = await request('GET', base + '/api/snapshot/backups', undefined, token);
  ok(r.status === 200 && Array.isArray(r.body.items), '读取备份列表', r.status);
  return r.body.items;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canteenai-adr013b4-'));
  const bffDataDir = path.join(tmpDir, 'bff-data');
  fs.mkdirSync(bffDataDir, { recursive: true });
  let bffChild = null;

  /* 直读落盘快照（不用 /api/snapshot/latest：它会把「保本价盘」dishes 合并进读视图，
   * 用来看「库里到底存了什么」会被读侧合并干扰） */
  const rawSnap = () => {
    const s = JSON.parse(fs.readFileSync(path.join(bffDataDir, 'snapshot.json'), 'utf8'));
    return { rev: s.rev, data: s.data || {}, ext: s.ext || {} };
  };

  step(0, '环境与隔离目录');
  info('临时目录: ' + tmpDir + '（Node ' + process.versions.node + '）');

  try {
    step(1, '起 BFF（隔离数据目录）并铺种子快照');
    const port = await freePort();
    const base = 'http://127.0.0.1:' + port;
    bffChild = spawn(process.execPath, [path.join(BFF_DIR, 'server.js')], {
      cwd: BFF_DIR,
      env: Object.assign({}, process.env, {
        BFF_PORT: String(port), BFF_HOST: '127.0.0.1', BFF_DATA_DIR: bffDataDir, SI_SCHEDULER: '0',
      }),
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    bffChild.stdout.on('data', (d) => { bffLog += d.toString(); if (VERBOSE) line('[bff] ' + d.toString().trimEnd()); });
    bffChild.stderr.on('data', (d) => { bffLog += d.toString(); if (VERBOSE) line('[bff!] ' + d.toString().trimEnd()); });
    await waitHealthy(base + '/api/health', 30000, 'BFF');

    const login = await request('POST', base + '/api/auth/login', { account: 'boss', password: 'wufu123', device_fp: 'adr013-b4' });
    ok(login.status === 200 && login.body.ok && !!login.body.token, '老板登录取得 token');
    const token = login.body.token;

    const cashier = await request('POST', base + '/api/auth/login', { account: 'cashier', password: 'wufu123', device_fp: 'adr013-b4-c' });
    const cashierToken = cashier.status === 200 && cashier.body ? cashier.body.token : null;
    ok(!!cashierToken, '收银登录取得 token（用于越权验证）');

    const push = await request('POST', base + '/api/snapshot/push', { rev: 1, data: SEED.data, ext: SEED.ext, machine: 'ADR013-B4' }, token);
    ok(push.status === 200 && push.body.ok === true, '快照推送成功（rev=1）', push.body);
    const rev0 = (await latest(base, token)).rev;
    info('种子快照 rev = ' + rev0);

    /* ---------------- W4-01 导入备份恢复 ---------------- */
    step(2, 'W4-01 导入预览只读零写');
    const prev = await request('POST', base + '/api/snapshot/import/preview', { snapshot: IMPORT_SNAP }, token);
    ok(prev.status === 200 && prev.body.ok === true, '导入预览 200', prev.body);
    ok(prev.body.incoming_rev === 7, '预览回读导入文件 rev=7', prev.body.incoming_rev);
    ok(prev.body.will_discard.sales === 2 && prev.body.will_restore.sales === 2, '预览差异：销售 2 → 2', prev.body.changed);
    ok(prev.body.will_discard.ings === 2 && prev.body.will_restore.ings === 1, '预览差异：原料 2 → 1', prev.body.changed);
    const afterPrev = await latest(base, token);
    ok(afterPrev.rev === rev0, '预览不改快照 rev（零写）', { before: rev0, after: afterPrev.rev });
    ok(afterPrev.data.ings.length === 2, '预览不改快照内容', afterPrev.data.ings.length);

    step(3, 'W4-01 高危门禁：收银越权 403');
    const deny = await request('POST', base + '/api/snapshot/import', { snapshot: IMPORT_SNAP }, cashierToken);
    ok(deny.status === 403, '收银提交导入恢复 403', deny.status);
    ok(/仅老板\/店长/.test(String((deny.body && deny.body.error) || '')), '错误信息说明角色门槛', deny.body && deny.body.error);

    step(4, 'W4-01 老板提交 → 确认 → 执行（整包覆盖 data+ext）');
    const sub = await request('POST', base + '/api/snapshot/import', { snapshot: IMPORT_SNAP, reason: '活体验证' }, token);
    ok(sub.status === 200 && sub.body.ok === true && !!sub.body.import_id, '提交导入：暂存 + 入队', sub.body);
    const importId = sub.body.id;
    const stagingId = sub.body.import_id;
    ok(/^imp-/.test(String(stagingId)), '返回暂存 id（imp-…）', stagingId);
    ok(fs.existsSync(path.join(bffDataDir, 'imports', stagingId + '.json')), '暂存文件已落盘（data/imports/）');

    const dup = await request('POST', base + '/api/snapshot/import', { snapshot: IMPORT_SNAP, reason: '活体验证' }, token);
    ok(dup.status === 200 && dup.body.dedup === true, '同一文件重复提交命中队列幂等', dup.body);

    const cf = await request('POST', base + '/api/actions/' + importId + '/confirm', { operator: 'boss', rev: sub.body.rev }, token);
    ok(cf.status === 200 && cf.body.ok, '确认导入动作', cf.body);
    const ap = await request('POST', base + '/api/actions/' + importId + '/apply', {}, token);
    ok(ap.status === 200 && ap.body.ok === true, '执行导入动作成功', ap.body);
    ok(ap.body.result && /^[0-9]{8}-/.test(String(ap.body.result.safeguard_id || '')), '回执含前置备份 id', ap.body.result);

    const after = rawSnap();
    ok(after.rev === ap.body.rev && after.rev > rev0, 'rev 递增且不回退（' + rev0 + ' → ' + after.rev + '）', after.rev);
    ok(after.data.ings.length === 1 && after.data.ings[0].id === 'X1', 'data 已被导入内容整包替换', after.data.ings);
    ok(after.data.sales.length === 2 && after.data.sales[0].id === 'IS1', '销售换成导入文件的 2 条', after.data.sales);
    ok(after.ext && Array.isArray(after.ext.pos_tables) && after.ext.pos_tables[0].table_id === 'IT1', 'ext 也整包替换（D4-7）', after.ext);

    const baks = await backups(base, token);
    ok(baks.some((b) => b.note && b.note.indexOf('导入恢复前自动备份') >= 0), '执行前自动生成了新备份', baks.map((b) => b.note));

    /* ---------------- W4-02 重置为真实数据基线 ---------------- */
    step(5, 'W4-02 基线制品列表与预览');
    const bl = await request('GET', base + '/api/snapshot/baselines', undefined, token);
    ok(bl.status === 200 && bl.body.items.length >= 1, '存在基线制品', bl.body.count);
    const baseVer = bl.body.items[0].version;
    ok(bl.body.items[0].checksum_ok === true, '基线校验和通过（' + baseVer + '）', bl.body.items[0].checksum_ok);
    info('基线 ' + baseVer + '：原料 ' + bl.body.items[0].counts.ings + ' / 菜品 ' + bl.body.items[0].counts.dishes
      + ' / 进货单 ' + bl.body.items[0].counts.recv);

    const bp = await request('GET', base + '/api/snapshot/baseline/preview?version=' + encodeURIComponent(baseVer), undefined, token);
    ok(bp.status === 200 && bp.body.ok, '重置预览 200', bp.body);
    ok(bp.body.will_discard.sales === 2, '预览：当前 2 条销售将被丢弃', bp.body.will_discard);
    ok(bp.body.will_restore.ings === bl.body.items[0].counts.ings, '预览：将恢复基线原料数', bp.body.will_restore);

    step(6, 'W4-02 高危门禁 + 执行重置');
    const deny2 = await request('POST', base + '/api/actions', { type: 'snapshot.reset_baseline', payload: { baseline_version: baseVer } }, cashierToken);
    ok(deny2.status === 403, '收银发起重置基线 403', deny2.status);

    const reset = await runAction(base, token, 'snapshot.reset_baseline', { baseline_version: baseVer, reason: '活体验证' });
    ok(reset.apply.ok === true, '重置基线执行成功', reset.apply);
    const afterReset = rawSnap();
    ok((afterReset.data.sales || []).length === 0, '销售归零', (afterReset.data.sales || []).length);
    ok((afterReset.data.quotes || []).length === 0, '报价归零', (afterReset.data.quotes || []).length);
    ok((afterReset.data.logs || []).length === 0, '库存流水归零', (afterReset.data.logs || []).length);
    ok(afterReset.data.ings.length === bl.body.items[0].counts.ings, '原料回到基线（' + bl.body.items[0].counts.ings + ' 种）', afterReset.data.ings.length);
    ok(afterReset.data.dishes.length === bl.body.items[0].counts.dishes, '菜品回到基线（' + bl.body.items[0].counts.dishes + ' 道）', afterReset.data.dishes.length);
    ok(Object.keys(afterReset.ext || {}).length === 0, 'ext 清空（配方为空属正常）', Object.keys(afterReset.ext || {}));

    /* ---------------- W4-03 清空业务数据 ---------------- */
    step(7, 'W4-03 清空预览（business / all）');
    const cpB = await request('GET', base + '/api/snapshot/clear/preview?scope=business', undefined, token);
    ok(cpB.status === 200 && cpB.body.scope === 'business', 'business 预览 200', cpB.body && cpB.body.scope);
    ok(cpB.body.will_discard.ings > 0 && cpB.body.remaining.ings === 0, '预览：原料将被清空', cpB.body.remaining);
    ok(cpB.body.kept_data.indexOf('config') >= 0, 'business 档保留 config', cpB.body.kept_data);
    const cpA = await request('GET', base + '/api/snapshot/clear/preview?scope=all', undefined, token);
    ok(cpA.status === 200 && cpA.body.removed_files.length === 3, 'all 档列出 3 个框架文件', cpA.body.removed_files);

    step(8, 'W4-03 business：只清业务，配置/账号/主数据保留');
    /* 为「清空时保留主数据表」这条断言铺一份 ext（上一步重置已把 ext 清空） */
    const cur8 = rawSnap();
    const seedExt = {
      recipes: [{ sku_id: 'D1', name: '长寿饺', main: ['面粉100g'] }],
      pos_tables: [{ table_id: 'T1', name: 'A1' }],
      accept_standards: [{ ing_name: '面粉' }],
      fin_cash: [{ id: 1, amount: 100 }],
    };
    const push2 = await request('POST', base + '/api/snapshot/push',
      { rev: cur8.rev, data: cur8.data, ext: seedExt, machine: 'ADR013-B4-SEED2' }, token);
    ok(push2.status === 200 && push2.body.ok === true, '铺 ext（桌台/配方/验收标准/财务流水）用于清空断言', push2.body);

    const deny3 = await request('POST', base + '/api/actions', { type: 'snapshot.clear', payload: { scope: 'business' } }, cashierToken);
    ok(deny3.status === 403, '收银发起清空 403', deny3.status);
    const clr = await runAction(base, token, 'snapshot.clear', { scope: 'business', reason: '活体验证' });
    ok(clr.apply.ok === true, '清空业务数据执行成功', clr.apply);
    const afterClear = rawSnap();
    for (const k of ['ings', 'dishes', 'recv', 'orders', 'sales', 'quotes', 'logs', 'rec']) {
      ok(afterClear.data[k] === undefined, '已清空 data.' + k, afterClear.data[k]);
    }
    ok(afterClear.data.config && typeof afterClear.data.rest === 'string' && afterClear.data.rest.length > 0,
      '配置与店名保留（不被业务清空波及）', { rest: afterClear.data.rest });
    ok(afterClear.ext && afterClear.ext.pos_tables, 'ext 主数据表（桌台）保留', Object.keys(afterClear.ext || {}));
    ok(afterClear.ext && afterClear.ext.recipes === undefined, 'ext 业务表（配方）已清空', Object.keys(afterClear.ext || {}));
    ok(fs.existsSync(path.join(bffDataDir, 'org.json')), 'business 档不动账号文件（org.json 仍在）');

    step(9, 'W4-03 all：回到首次安装状态（会登出、账号回出厂默认）');
    const clrAll = await runAction(base, token, 'snapshot.clear', { scope: 'all', reason: '活体验证' });
    ok(clrAll.apply.ok === true, '清空全部执行成功', clrAll.apply);
    const afterAll = rawSnap();
    ok(Object.keys(afterAll.data).length === 1 && afterAll.data.v === 4, 'data 只剩 schema 版本 v=4', afterAll.data);
    ok(Object.keys(afterAll.ext || {}).length === 0, 'ext 清空', Object.keys(afterAll.ext || {}));
    for (const f of ['org.json', 'settle_template.json', 'tokens.json']) {
      ok(!fs.existsSync(path.join(bffDataDir, f)), '框架文件已删除：' + f, fs.existsSync(path.join(bffDataDir, f)));
    }
    const relogin = await request('POST', base + '/api/auth/login', { account: 'boss', password: 'wufu123', device_fp: 'adr013-b4-re' });
    ok(relogin.status === 200 && relogin.body.ok && !!relogin.body.token, '清空后仍可用出厂账号重新登录（org 自动重播种，不锁死）', relogin.status);

    step(10, '收尾：备份链完整（每次高危写都留了备份）');
    const allBaks = await backups(base, relogin.body.token);
    info('备份份数: ' + allBaks.length + '（' + allBaks.map((b) => b.note || '-').join(' | ') + '）');
    ok(allBaks.some((b) => /导入恢复前自动备份/.test(String(b.note))), '有「导入恢复前自动备份」');
    ok(allBaks.some((b) => /重置基线前自动备份/.test(String(b.note))), '有「重置基线前自动备份」');
    ok(allBaks.filter((b) => /清空数据前自动备份/.test(String(b.note))).length >= 2, '有「清空数据前自动备份」（两档各一份）');

    line('');
    line('== PASS ADR-013 第 4 批活体验证（' + CHECKS + ' 项） ==');
  } catch (e) {
    line('');
    line('== FAIL ' + (e && e.message ? e.message : e) + ' ==');
    if (bffLog) line('---- BFF 日志尾部 ----\n' + bffLog.split('\n').slice(-40).join('\n'));
    process.exitCode = 1;
  } finally {
    if (bffChild) {
      try { bffChild.kill(); } catch (e) { /* ignore */ }
      await sleep(300);
    }
    if (!KEEP) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    } else {
      line('（--keep）临时目录保留: ' + tmpDir);
    }
  }
}

main();
