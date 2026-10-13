'use strict';
/*
 * routes/snapshot.test.js — 服务端快照备份端点的路由层回归测试（零依赖，node 直跑）
 *
 * 覆盖 routes/snapshot.js 的 FP-SET-07 / FP-SET-10（列表查看半）三个端点：
 *   · POST /api/snapshot/backup  手动打快照：仅老板/店长；写 data/snapshots/<id>.json + index.json
 *   · GET  /api/snapshot/backups 备份列表（只读元信息，倒序）
 *   · GET  /api/snapshot/backup?id=  备份全文（只读，供下载/后续回滚取数）
 *   · 红线：备份动作**只写 data/snapshots/**，不写业务库（snapshot.json 字节不变）、不入 actions_queue
 *   · 保留策略：超出 lib/snapshot_store.KEEP 自动淘汰最旧
 *   · 边界：非老板/店长 403；无快照 404；id 含 `..` 路径穿越 404；未知路径不接管
 *
 * 运行：node routes/snapshot.test.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bff-snapshot-'));
process.env.BFF_DATA_DIR = dir;

const store = require('../lib/store');
const snapshotStore = require('../lib/snapshot_store');
const snapRoute = require('./snapshot');

const SNAP = {
  rev: 284,
  generated_at: '2026-10-12T00:00:00.000Z',
  size: 1234,
  data: {
    rest: '熊猫五福餐厅',
    ings: [{ id: 'i1', name: '五花肉', stock: 8, avg: 18.5 }],
    dishes: [{ id: 'd1', name: '长寿饺', price: 32 }],
    sales: []
  },
  ext: { recipes: [{ sku_id: 'd1', name: '长寿饺', main: ['五花肉200g'] }] }
};
store.writeJSON('snapshot.json', SNAP);
const bytesBefore = fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8');

function mkres() {
  return {
    code: 0,
    headers: {},
    body: null,
    writeHead(code, headers) { this.code = code; this.headers = headers || {}; },
    end(buf) { this.body = buf; },
  };
}
function mkctx(role, account, query) {
  return {
    auth: role ? { role, account: account || 'u1' } : null,
    traceId: 't-snap',
    query: new URLSearchParams(query || ''),
    readBody: async () => ({ tooLarge: false, buf: Buffer.from(JSON.stringify({ note: '手动备份' })) }),
    sendJSON(res, status, obj) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    },
  };
}
async function call(pathname, method, role, query, account) {
  const res = mkres();
  const took = await snapRoute.handle({ method: method || 'GET' }, res, mkctx(role, account, query), pathname);
  let json = null;
  try { json = JSON.parse(String(res.body == null ? '' : res.body)); } catch (e) { json = null; }
  return { res, took, json };
}

async function main() {
  let fail = 0;
  const ok = (name, cond, extra) => {
    if (!cond) { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
    else console.log('ok   ' + name);
  };

  /* ---- 权限：非老板/店长 403 ---- */
  let r = await call('/api/snapshot/backup', 'POST', '收银');
  ok('收银角色打快照 → 403', r.took === true && r.res.code === 403, r.res.code);
  r = await call('/api/snapshot/backup', 'POST', null);
  ok('未登录打快照 → 403', r.res.code === 403, r.res.code);
  ok('被拒后未产生任何备份', snapshotStore.list().length === 0, snapshotStore.list().length);

  /* ---- FP-SET-07 手动打快照 ---- */
  r = await call('/api/snapshot/backup', 'POST', '老板', '', 'boss');
  ok('老板打快照 → 200', r.took === true && r.res.code === 200, r.res.code);
  const item = r.json && r.json.item;
  ok('响应带备份元信息（id/rev/size/operator）',
    !!item && !!item.id && item.rev === 284 && item.size > 0 && item.operator === 'boss', item);
  ok('备份文件已落 data/snapshots/<id>.json', !!item && fs.existsSync(path.join(dir, 'snapshots', item.id + '.json')));
  ok('备份索引已写入（1 条）', snapshotStore.list().length === 1, snapshotStore.list().length);
  ok('备份内容 = 当前快照全文（可回灌 push）', (() => {
    const s = snapshotStore.read(item.id);
    return !!s && s.rev === 284 && Array.isArray(s.data.ings) && !!s.ext && Array.isArray(s.ext.recipes);
  })());
  ok('备注被登记（note 截断 200 字以内）', item.note === '手动备份', item.note);

  /* ---- 同一秒重复点击：id 不覆盖 ---- */
  const r2 = await call('/api/snapshot/backup', 'POST', '店长', '', 'mgr');
  const item2 = r2.json && r2.json.item;
  ok('同秒第二次备份 id 不覆盖（自动加后缀）',
    !!item2 && item2.id !== item.id && fs.existsSync(path.join(dir, 'snapshots', item2.id + '.json')), item2 && item2.id);
  ok('列表按时间倒序（最新在前）', snapshotStore.list()[0].id === item2.id, snapshotStore.list().map((x) => x.id));

  /* ---- FP-SET-10（列表查看半）备份列表 ---- */
  r = await call('/api/snapshot/backups', 'GET', '收银');
  ok('备份列表读端点被接管且 200（只读，任意登录角色可看）', r.took === true && r.res.code === 200, r.res.code);
  ok('列表返回 2 条 + keep 常量', r.json.items.length === 2 && r.json.keep === snapshotStore.KEEP, [r.json.items.length, r.json.keep]);

  /* ---- FP-SET-10（列表查看半）备份全文读取 ---- */
  r = await call('/api/snapshot/backup', 'GET', '老板', 'id=' + encodeURIComponent(item.id));
  ok('备份全文端点 200 且 id/rev 对齐', r.res.code === 200 && r.json.id === item.id && r.json.rev === 284, r.res.code);
  ok('备份全文透出 data+ext', !!r.json.data && !!r.json.ext, r.json && Object.keys(r.json));
  r = await call('/api/snapshot/backup', 'GET', '老板', 'id=../snapshot');
  ok('路径穿越 id 被拒（404）', r.res.code === 404, r.res.code);
  r = await call('/api/snapshot/backup', 'GET', '老板', 'id=nope');
  ok('不存在的备份 404', r.res.code === 404, r.res.code);

  /* ---- 红线：备份只写 data/snapshots/，不写业务库、不入队 ---- */
  const bytesAfter = fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8');
  ok('红线：备份前后 snapshot.json 字节一致（不写业务库）', bytesBefore === bytesAfter);
  ok('红线：备份不产生 actions_queue.json（不入队）', !fs.existsSync(path.join(dir, 'actions_queue.json')));

  /* ---- 保留策略：超出 KEEP 淘汰最旧 ---- */
  const KEEP = snapshotStore.KEEP;
  let guard = 0;
  while (snapshotStore.list().length < KEEP + 2 && guard < KEEP + 10) {
    snapshotStore.save(SNAP, { operator: 'u1' });
    guard++;
  }
  ok('保留策略：列表长度被钳制在 KEEP 以内', snapshotStore.list().length <= KEEP, snapshotStore.list().length);
  ok('保留策略：被淘汰的备份文件已删除（不残留孤儿文件）', (() => {
    const files = fs.readdirSync(path.join(dir, 'snapshots')).filter((f) => f.endsWith('.json') && f !== 'index.json');
    return files.length === snapshotStore.list().length;
  })());

  /* ---- 无快照时打备份 404（放最后：本步会移除 snapshot.json）---- */
  fs.rmSync(path.join(dir, 'snapshot.json'), { force: true });
  r = await call('/api/snapshot/backup', 'POST', '老板', '', 'boss');
  ok('无快照时打备份 → 404', r.res.code === 404, r.res.code);

  /* ---- 纯函数边界 ---- */
  ok('id 生成格式（8+6+r<rev>）', /^\d{8}-\d{6}-r\d+$/.test(snapshotStore.newId(284, new Date(2026, 9, 12, 15, 30, 12))),
    snapshotStore.newId(284, new Date(2026, 9, 12, 15, 30, 12)));
  ok('read() 对非法 id 返回 null（防穿越）', snapshotStore.read('../snapshot') === null);

  /* ---- 路由边界 ---- */
  ok('未知路径不接管', (await call('/api/other', 'GET', '老板')).took === false);
  const noId = await call('/api/snapshot/backup', 'GET', '老板');
  ok('GET 备份全文缺 id → 被只读端点接管并 404', noId.took === true && noId.res.code === 404, noId.res.code);
  ok('PATCH 打备份不接管（写端点只认 POST）', (await call('/api/snapshot/backup', 'PATCH', '老板')).took === false);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fail ? '== snapshot 测试失败 ' + fail + ' 项 ==' : '== snapshot 测试全部通过 ==');
  process.exit(fail ? 1 : 0);
}

main();
