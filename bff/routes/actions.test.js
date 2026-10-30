'use strict';
/*
 * routes/actions.test.js — 写队列入口的路由层回归（零依赖，node 直跑）
 *
 * 守的事：
 *   ① **POST /api/actions 必须能入队**——这是红线①「唯一写入口」，它挂了等于全站写不了。
 *      （历史事故：高危门禁用了尚未解析的 `body`，ReferenceError 让所有入队 500；
 *        本用例用「正常动作能拿到 action id」把顺序错误钉死。）
 *   ② 高危门禁（ADR-013 D4-1）：snapshot.rollback 仅老板/店长可发起，员工 403；
 *      且门禁不能在解析前触发（否则一切动作都 500）。
 *   ③ 未登录 401、缺 type 400，不静默。
 *
 * 运行：node bff/routes/actions.test.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bff-actions-'));
process.env.BFF_DATA_DIR = dir;

const store = require('../lib/store');
const actionsRoute = require('./actions');

store.writeJSON('snapshot.json', { rev: 12, data: { ings: [] }, ext: {} });

function mkres() {
  return {
    code: 0,
    headers: {},
    body: null,
    writeHead(code, headers) { this.code = code; this.headers = headers || {}; },
    end(buf) { this.body = buf; },
  };
}
function mkctx(auth, body, role) {
  return {
    auth: auth === false ? null : { role: role || '老板', account: 'u1' },
    traceId: 't-act',
    query: new URLSearchParams(''),
    readBody: async () => ({ tooLarge: false, buf: Buffer.from(JSON.stringify(body || {})) }),
    sendJSON(res, status, obj) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    },
  };
}
async function post(body, opts) {
  const o = opts || {};
  const res = mkres();
  const took = await actionsRoute.handle(
    { method: 'POST' }, res, mkctx(o.auth, body, o.role), '/api/actions'
  );
  let json = null;
  try { json = JSON.parse(String(res.body == null ? '' : res.body)); } catch (e) { json = null; }
  return { took, code: res.code, json };
}

async function callPath(pathname, body, opts) {
  const o = opts || {};
  const res = mkres();
  const took = await actionsRoute.handle(
    { method: 'POST' }, res, mkctx(o.auth, body, o.role), pathname
  );
  let json = null;
  try { json = JSON.parse(String(res.body == null ? '' : res.body)); } catch (e) { json = null; }
  return { took, code: res.code, json };
}

let failed = 0;
async function ok(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '  ' + (e && e.message ? e.message : e)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  await ok('普通动作可入队（唯一写入口未被门禁顺序打断）', async () => {
    const r = await post({ type: 'ing.batch', payload: { ids: ['I1'], safe: 5 }, operator: 'boss' });
    assert(r.took === true, '路由应接管 /api/actions');
    assert(r.code === 200, '应返回 200，实际 ' + r.code + ' body=' + JSON.stringify(r.json));
    assert(r.json && r.json.ok === true && /^act_/.test(String(r.json.id)), '应返回 action id');
    assert(r.json.rev === 12, '入队应带上当前快照 rev');
  });

  await ok('高危动作 snapshot.rollback：老板可发起', async () => {
    const r = await post({ type: 'snapshot.rollback', payload: { backup_id: 'b1' }, operator: 'boss' });
    assert(r.code === 200 && r.json.ok === true, '老板应可入队，实际 ' + r.code + ' ' + JSON.stringify(r.json));
  });

  await ok('高危动作 snapshot.rollback：有写权限但非老板/店长（收银）→ 403 高危门禁', async () => {
    const r = await post({ type: 'snapshot.rollback', payload: { backup_id: 'b2' } }, { role: '收银' });
    assert(r.code === 403, '收银应 403，实际 ' + r.code + ' ' + JSON.stringify(r.json));
    assert(/高危动作/.test(String(r.json && r.json.error)), '错误信息应说明高危门禁');
  });

  await ok('高危清单覆盖 W4 三项：老板可入队、收银 403', async () => {
    const types = ['snapshot.import', 'snapshot.reset_baseline', 'snapshot.clear'];
    for (const type of types) {
      const a = await post({ type, payload: { k: type }, operator: 'boss' });
      assert(a.code === 200 && a.json.ok === true, type + ' 老板应可入队，实际 ' + a.code);
      const b = await post({ type, payload: { k: type + '-x' } }, { role: '收银' });
      assert(b.code === 403, type + ' 收银应 403，实际 ' + b.code);
    }
  });

  await ok('高危动作「确认」也须老板/店长：收银 403、老板可确认', async () => {
    const created = await post({ type: 'snapshot.clear', payload: { scope: 'business' }, operator: 'boss' });
    const id = created.json.id;
    assert(/^act_/.test(String(id)), '应先入队成功');
    const c1 = await callPath('/api/actions/' + id + '/confirm', { rev: 12, operator: 'cashier' }, { role: '收银' });
    assert(c1.code === 403, '收银确认高危动作应 403，实际 ' + c1.code + ' ' + JSON.stringify(c1.json));
    const c2 = await callPath('/api/actions/' + id + '/confirm', { rev: 12, operator: 'boss' }, { role: '老板' });
    assert(c2.code === 200, '老板确认应 200，实际 ' + c2.code + ' ' + JSON.stringify(c2.json));
    assert(c2.json.status === '待执行', '确认后应进入待执行');
  });

  await ok('无写权限角色 → 403（先于高危门禁，仍是 403 不是 500）', async () => {
    const r = await post({ type: 'ing.batch', payload: { ids: ['I1'], safe: 1 } }, { role: '员工' });
    assert(r.code === 403, '应 403，实际 ' + r.code + ' ' + JSON.stringify(r.json));
  });

  await ok('缺 type → 400（不静默入队）', async () => {
    const r = await post({ payload: {} });
    assert(r.code === 400, '应 400，实际 ' + r.code);
    assert(/missing type/.test(String(r.json && r.json.error)), '错误信息应含 missing type');
  });

  await ok('未登录 → 401', async () => {
    const r = await post({ type: 'ing.batch', payload: {} }, { auth: false });
    assert(r.code === 401, '应 401，实际 ' + r.code);
  });

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  if (failed) {
    console.error('\nFAILED ' + failed);
    process.exit(1);
  }
  console.log('\nPASS actions 入口回归（ADR-013 第 3 批顺带修复）');
}

main();
