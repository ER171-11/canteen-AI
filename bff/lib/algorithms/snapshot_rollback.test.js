'use strict';
/*
 * snapshot.rollback 回归（W2-01 / FP-SET-10；ADR-013 D1）。
 * 测试在临时 BFF_DATA_DIR 下进行（不污染真实快照），验证：
 *   ① 读取备份 → 整包恢复 data+ext（curRev 之后 rev 递增，绝不回退）；
 *   ② D4-3 强制前置备份：执行前自动打一份新备份（含执行后也能回滚）；
 *   ③ 备份不存在 / 缺 data 字段 → 显式抛错（红线⑦不静默降级）；
 *   ④ schema 校验：当前版本备份正常恢复；落后且无迁移函数的旧备份显式报错（绝不静默跳版本）；
 *   ⑤ 只整包替换，不掺业务语义写；result 含 safeguard_id / from_rev / to_rev 供审计；
 *   ⑥ 注册表收口：snapshot.rollback 已登记。
 *
 * 运行：node bff/lib/algorithms/snapshot_rollback.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须在 require 业务模块前设定临时数据目录（store.js 在加载时读取一次）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adr013-rollback-'));
process.env.BFF_DATA_DIR = TMP;

const snapshotStore = require('../snapshot_store');
const store = require('../store');
const { getAdapter } = require('../store-adapter');
const { SCHEMA_VERSION } = require('../schema');
const { applySnapshotRollback, countSummary } = require('./snapshot');
const algo = require('./index');
require('./registry');

let failed = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '  ' + (e && e.message ? e.message : e)); }
}

function makeSnapshot(rev, data, ext) {
  const d = Object.assign({ v: SCHEMA_VERSION }, data || {});
  return { rev, generated_at: new Date().toISOString(), size: 0, data: d, ext: ext === undefined ? null : ext };
}

/* 准备：当前快照 rev=200，含 1 条销售、ext.recipes */
store.writeJSON('snapshot.json', makeSnapshot(200, {
  ings: [{ id: 'I1', name: '五花肉' }],
  sales: [{ id: 'S1' }],
  logs: [{ id: 'L1' }],
}, { recipes: [{ id: 1 }] }));

const BAK = snapshotStore.save(makeSnapshot(100, {
  ings: [{ id: 'I2', name: '黄瓜' }],
  sales: [],
}), { operator: 'tester', note: '测试备份' });

ok('① 整包恢复到备份数据（ings 被替换，rev 递增不回退）', () => {
  const data = JSON.parse(JSON.stringify(getAdapter().readSnapshot().data));
  const ctx = { rev: 200, store: { ext: null } };
  const res = applySnapshotRollback(data, { backup_id: BAK.item.id, reason: '测试回滚' }, ctx);
  assert.strictEqual(res.from_rev, 200);
  assert.strictEqual(res.to_rev, 201, 'rev 应 = curRev+1（绝不回退到 100）');
  assert.strictEqual(res.target_rev, 100);
  assert.ok(res.safeguard_id, '应生成回滚前自动备份 id');
  assert.strictEqual(data.ings.length, 1);
  assert.strictEqual(data.ings[0].id, 'I2', 'data 应被整包替换为备份内容');
  assert.deepStrictEqual(data.sales, [], 'sales 应被整包替换为备份内容');
});

ok('①-ext 整包恢复（ext 也回写）', () => {
  const cur = getAdapter().readSnapshot();
  const data = JSON.parse(JSON.stringify(cur.data));
  const ctx = { rev: 200, store: { ext: cur.ext } };
  // 当前 ext 含 recipes；备份无 ext（null）→ 恢复后 ext 应清空
  applySnapshotRollback(data, { backup_id: BAK.item.id }, ctx);
  assert.deepStrictEqual(ctx.store.ext, {}, '备份无 ext 时恢复为空对象');
});

ok('② D4-3 强制前置备份已生成（执行后快照备份列表可见）', () => {
  const items = snapshotStore.list();
  assert.ok(items.some((x) => x.note && x.note.indexOf('回滚前自动备份') >= 0), '应有一份「回滚前自动备份」');
});

ok('③ 备份不存在 → 显式抛错', () => {
  const data = getAdapter().readSnapshot().data;
  assert.throws(() => applySnapshotRollback(data, { backup_id: 'no-such-id' }, { rev: 1, store: {} }), /备份不存在/);
});

ok('③ 备份缺 data 字段 → 显式抛错', () => {
  // data 显式为 null（能通过 save 的 undefined 校验，但执行器应判缺 data）
  const bad = snapshotStore.save({ rev: 50, generated_at: new Date().toISOString(), data: null }, { operator: 't' });
  const data = getAdapter().readSnapshot().data;
  assert.throws(() => applySnapshotRollback(data, { backup_id: bad.item.id }, { rev: 1, store: {} }), /缺少 data/);
});

ok('④ 当前版本备份：schema 校验通过并正常恢复（steps=0）', () => {
  const data = { ings: [{ id: 'X' }] };
  const ctx = { rev: 300, store: { ext: null } };
  const res = applySnapshotRollback(data, { backup_id: BAK.item.id }, ctx);
  assert.strictEqual(res.schema_steps, 0);
  assert.strictEqual(data.ings[0].id, 'I2');
});

ok('④ 落后且无迁移函数的旧备份 → 显式报错（绝不静默跳版本）', () => {
  // v=0 低于当前版本，且 MIGRATIONS 为空 → migrateData 必抛「缺少迁移函数」
  const oldBak = snapshotStore.save(
    { rev: 10, generated_at: new Date().toISOString(), data: { v: 0, ings: [{ id: 'I9' }] }, ext: null },
    { operator: 't' }
  );
  const data = { ings: [{ id: 'I1' }] };
  assert.throws(
    () => applySnapshotRollback(data, { backup_id: oldBak.item.id }, { rev: 1, store: {} }),
    /schema 迁移失败|缺少 v0/
  );
});

ok('⑤ 注册表收口：snapshot.rollback 已登记', () => {
  assert.strictEqual(algo.has('snapshot.rollback'), true);
  const r = algo.run('snapshot.rollback', { rev: 1, store: { ext: null } }, { ings: [] }, { backup_id: BAK.item.id });
  assert.strictEqual(r.handled, true);
});

ok('countSummary 正确统计快照规模（供「将丢弃 N 条」展示）', () => {
  const s = { rev: 1, data: { ings: [1, 2], recv: [1], sales: [1, 2, 3], quotes: [], logs: [1], dishes: [1] }, ext: { recipes: [1, 2] } };
  const c = countSummary(s);
  assert.strictEqual(c.ings, 2);
  assert.strictEqual(c.sales, 3);
  assert.strictEqual(c.ext_tables, 1);
});

console.log(failed
  ? '== snapshot.rollback 测试失败 ' + failed + ' 项 =='
  : 'PASS snapshot.rollback 全部通过（W2-01 / FP-SET-10，ADR-013 D1）');
process.exit(failed ? 1 : 0);
