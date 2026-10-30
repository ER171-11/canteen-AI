'use strict';
/*
 * routes/snapshot_w4.test.js — W4 高危三件套的**路由层**回归（ADR-013 D4；FP-SET-15/16/17）。
 *
 * 守的事：
 *   ① 基线：GET /api/snapshot/baselines 列表 + /baseline/preview 差异统计；校验和坏 → 400；
 *   ② 导入预览：POST /api/snapshot/import/preview **零写**（不产生暂存文件、不入队）；
 *      非法 JSON / 缺 data / 超限 → 400/413，不静默；
 *   ③ 导入提交：仅老板/店长（收银 403）；暂存 + 入队 snapshot.import；同一文件重复提交命中队列幂等；
 *   ④ 清空预览：business/all 两档差异统计；非法 scope → 400；
 *   ⑤ 红线：预览不写业务库（snapshot.json 字节不变）、唯一写通道仍是 /api/actions 队列。
 *
 * 运行：node bff/routes/snapshot_w4.test.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bff-snap-w4-'));
process.env.BFF_DATA_DIR = dir;

const store = require('../lib/store');
const baselineStore = require('../lib/baseline_store');
const importStore = require('../lib/import_store');
const snapRoute = require('./snapshot');

const SNAP = {
  rev: 40,
  generated_at: '2026-10-30T00:00:00.000Z',
  size: 0,
  data: { v: 4, rest: '熊猫五福餐厅', ings: [{ id: 'i1' }], sales: [{ id: 's1' }], config: {} },
  ext: { recipes: [{ sku_id: 'd1' }], pos_tables: [{ table_id: 'T1' }] },
};
store.writeJSON('snapshot.json', SNAP);
const bytesBefore = fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8');

/* 打一份临时基线（模拟随包制品 bff/baselines/baseline-<ver>.json） */
const BASE_DATA = { v: 4, ings: [{ id: 'b1' }, { id: 'b2' }], dishes: [{ id: 'bd1' }], config: {} };
(function seedBaseline() {
  const bdir = path.join(dir, 'baselines');
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, 'baseline-v1.json'), JSON.stringify({
    baseline_version: 'v1',
    generated_at: '2026-10-30T00:00:00.000Z',
    source: 'fixture',
    schema_version: 4,
    note: '测试基线',
    checksum: baselineStore.checksumOf(BASE_DATA, {}),
    counts: baselineStore.countsOf({ data: BASE_DATA, ext: {} }),
    data: BASE_DATA,
    ext: {},
  }, null, 1));
})();

function mkres() {
  return {
    code: 0,
    headers: {},
    body: null,
    writeHead(code, headers) { this.code = code; this.headers = headers || {}; },
    end(buf) { this.body = buf; },
  };
}

function mkctx(opts) {
  const o = opts || {};
  return {
    auth: o.auth === false ? null : { role: o.role || '老板', account: o.account || 'u1' },
    traceId: 't-snap-w4',
    query: new URLSearchParams(o.query || ''),
    readBody: async () => (o.tooLarge
      ? { tooLarge: true, buf: null }
      : { tooLarge: false, buf: Buffer.from(o.raw != null ? o.raw : JSON.stringify(o.body || {})) }),
    sendJSON(res, status, obj) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    },
  };
}

async function call(pathname, opts) {
  const o = opts || {};
  const res = mkres();
  const took = await snapRoute.handle(
    { method: o.method || 'GET', headers: o.headers || {} }, res, mkctx(o), pathname
  );
  let json = null;
  try { json = JSON.parse(String(res.body == null ? '' : res.body)); } catch (e) { json = null; }
  return { took, code: res.code, json };
}

function queue() { return store.readJSON('actions_queue.json', []); }

let failed = 0;
async function ok(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '  ' + (e && e.message ? e.message : e)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  await ok('① GET /api/snapshot/baselines 列出基线制品', async () => {
    const r = await call('/api/snapshot/baselines');
    assert(r.took === true && r.code === 200, '应 200，实际 ' + r.code);
    assert(r.json.items.length === 1 && r.json.items[0].version === 'v1', '应列出 v1');
    assert(r.json.items[0].checksum_ok === true, '校验和应通过');
  });

  await ok('① /baseline/preview 给出「将丢弃 / 将恢复」差异', async () => {
    const r = await call('/api/snapshot/baseline/preview', { query: 'version=v1' });
    assert(r.code === 200, '应 200，实际 ' + r.code);
    assert(r.json.baseline_version === 'v1');
    assert(r.json.will_discard.sales === 1, '当前 1 条销售将被丢弃');
    assert(r.json.will_restore.ings === 2, '基线 2 种原料将被恢复');
    assert(r.json.current_rev === 40);
  });

  await ok('① 基线被改动 → preview 400（校验和自证）', async () => {
    const p = path.join(dir, 'baselines', 'baseline-v2.json');
    fs.writeFileSync(p, JSON.stringify({
      baseline_version: 'v2', data: { v: 4, ings: [] }, ext: {}, checksum: 'sha256:deadbeef',
    }));
    const r = await call('/api/snapshot/baseline/preview', { query: 'version=v2' });
    assert(r.code === 400, '应 400，实际 ' + r.code);
    assert(/校验和不匹配/.test(String(r.json.error)), '错误应说明校验和');
    fs.unlinkSync(p);
  });

  await ok('② 导入预览：合法备份 → 200 差异统计，且零写', async () => {
    const body = { snapshot: { rev: 7, data: { v: 4, ings: [{ id: 'x' }] }, ext: {} }, reason: '预览' };
    const r = await call('/api/snapshot/import/preview', { method: 'POST', body });
    assert(r.code === 200, '应 200，实际 ' + r.code + ' ' + JSON.stringify(r.json));
    assert(r.json.incoming_rev === 7);
    assert(r.json.will_restore.ings === 1);
    assert(r.json.will_discard.sales === 1);
    assert(importStore.list().length === 0, '预览不得产生暂存文件');
    assert(queue().length === 0, '预览不得入队');
    assert(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8') === bytesBefore, '预览不得改快照');
  });

  await ok('② 导入预览：缺 data / 非法 JSON → 400', async () => {
    const bad1 = await call('/api/snapshot/import/preview', { method: 'POST', body: { rev: 1 } });
    assert(bad1.code === 400 && /缺少 data/.test(String(bad1.json.error)), '缺 data 应 400');
    const bad2 = await call('/api/snapshot/import/preview', { method: 'POST', raw: 'not-json' });
    assert(bad2.code === 400 && /不是合法 JSON/.test(String(bad2.json.error)), '非法 JSON 应 400');
  });

  await ok('② 导入预览：content-length 超限 → 413', async () => {
    const r = await call('/api/snapshot/import/preview', {
      method: 'POST', body: {}, headers: { 'content-length': String(9 * 1024 * 1024) },
    });
    assert(r.code === 413, '应 413，实际 ' + r.code);
  });

  await ok('③ 导入提交：收银 → 403（高危门禁）', async () => {
    const r = await call('/api/snapshot/import', {
      method: 'POST', role: '收银', body: { snapshot: { data: { v: 4, ings: [] }, ext: {} } },
    });
    assert(r.code === 403, '应 403，实际 ' + r.code);
    assert(/仅老板\/店长/.test(String(r.json.error)), '错误应说明角色门槛');
  });

  await ok('③ 导入提交：老板 → 暂存 + 入队 snapshot.import', async () => {
    const body = { snapshot: { rev: 9, data: { v: 4, ings: [{ id: 'x' }] }, ext: {} }, reason: '端到端' };
    const r = await call('/api/snapshot/import', { method: 'POST', body });
    assert(r.code === 200, '应 200，实际 ' + r.code + ' ' + JSON.stringify(r.json));
    assert(/^imp-/.test(String(r.json.import_id)), '应返回暂存 id');
    assert(/^act_/.test(String(r.json.id)), '应立即入队并返回动作 id');
    assert(importStore.read(r.json.import_id) != null, '暂存文件应可回读');
    const act = queue().find((a) => a.id === r.json.id);
    assert(act && act.type === 'snapshot.import', '队列应有 snapshot.import 动作');
    assert(act.payload.import_id === r.json.import_id, 'payload 只带 import_id（不内联整库）');
    assert(act.payload.reason === '端到端', '原因应落进 payload');
  });

  await ok('③ 同一文件重复提交 → 队列幂等（dedup）+ 暂存复用', async () => {
    const body = { snapshot: { rev: 9, data: { v: 4, ings: [{ id: 'x' }] }, ext: {} }, reason: '端到端' };
    const r = await call('/api/snapshot/import', { method: 'POST', body });
    assert(r.code === 200 && r.json.dedup === true, '应命中队列幂等，实际 ' + JSON.stringify(r.json));
    assert(r.json.reused === true, '暂存文件应复用（同内容同 id）');
    assert(queue().length === 1, '不应新增第二条队列动作');
  });

  await ok('④ 清空预览：business / all 两档差异', async () => {
    const b = await call('/api/snapshot/clear/preview', { query: 'scope=business' });
    assert(b.code === 200 && b.json.scope === 'business', 'business 应 200');
    assert(b.json.will_discard.ings === 1 && b.json.remaining.ings === 0, '业务档应清掉原料');
    assert(b.json.kept_data.indexOf('config') >= 0, 'config 应保留');
    assert(b.json.removed_files.length === 0, 'business 档不动框架文件');
    const a = await call('/api/snapshot/clear/preview', { query: 'scope=all' });
    assert(a.code === 200 && a.json.scope === 'all', 'all 应 200');
    assert(a.json.removed_files.length === 3, 'all 档应列出 3 个框架文件');
    assert(a.json.kept_data.length === 0, 'all 档不保留任何 data 键');
  });

  await ok('④ 清空预览：非法 scope → 400（不猜默认档位）', async () => {
    const r = await call('/api/snapshot/clear/preview', { query: 'scope=everything' });
    assert(r.code === 400, '应 400，实际 ' + r.code);
    assert(/scope 只能是/.test(String(r.json.error)));
  });

  await ok('⑤ 全程未直接写快照（红线①：唯一写入口是 /api/actions 队列）', async () => {
    assert(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8') === bytesBefore, '快照字节应保持不变');
    const types = queue().map((a) => a.type);
    assert(types.length === 1 && types[0] === 'snapshot.import', '队列只应有导入动作');
  });

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log(failed
    ? '\n== snapshot W4 路由测试失败 ' + failed + ' 项 =='
    : '\nPASS snapshot W4 路由回归（W4-01/02/03 预览与提交，ADR-013 D4）');
  process.exit(failed ? 1 : 0);
}

main();
