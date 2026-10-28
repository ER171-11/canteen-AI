'use strict';
/*
 * maint.row_delete 回归（零依赖，node 直跑）
 *
 * 守的五件事：
 *   ① 正常删行：executeAction 删 ext.fs_samples 指定 id 行，快照同步生效；
 *   ② where 为空拒绝（防全表删）；
 *   ③ 非白名单表拒绝（账务/往来账/审计不可删）；
 *   ④ 零命中抛错（动作置已驳回，不静默成功）；
 *   ⑤ data.ext 兜底副本同步清理（无 store 场景）。
 *
 * 运行：node lib/algorithms/maint.test.js
 */
const assert = require('assert');
const { executeAction } = require('./execute');
const { applyRowDelete, ALLOWED_TABLES } = require('./maint');
require('./registry');

let failed = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '  ' + (e && e.message ? e.message : e)); }
}

console.log('== maint.row_delete ==');

ok('executeAction 删 ext.fs_samples 指定行，快照同步生效', () => {
  const snap = {
    rev: 7,
    data: {},
    ext: { fs_samples: [{ id: 1, dish: '真菜' }, { id: 2, dish: '演示假菜' }] },
  };
  const out = executeAction(snap, {
    type: 'maint.row_delete',
    payload: { table: 'fs_samples', where: { id: 2 } },
  });
  assert.strictEqual(out.ok, true, '应执行成功: ' + (out.error || ''));
  const rows = out.snapshot.ext.fs_samples;
  assert.strictEqual(rows.length, 1, '应剩 1 行');
  assert.strictEqual(rows[0].dish, '真菜', '留下的应是真数据');
  assert.ok(/删除 1 行/.test(String(out.result)), '回执应含删除行数');
});

ok('where 为空拒绝（防全表删）', () => {
  const snap = { rev: 1, data: {}, ext: { fs_samples: [{ id: 1 }] } };
  const out = executeAction(snap, {
    type: 'maint.row_delete',
    payload: { table: 'fs_samples', where: {} },
  });
  assert.strictEqual(out.ok, false, '应执行失败');
  assert.ok(/where 不能为空/.test(String(out.error)), '错误应提示 where 为空');
});

ok('非白名单表拒绝：sup_accounts / app_audit / fin_cash 禁删', () => {
  for (const t of ['sup_accounts', 'app_audit', 'fin_cash', 'recv_accept', '']) {
    const out = executeAction(
      { rev: 1, data: {}, ext: {} },
      { type: 'maint.row_delete', payload: { table: t, where: { id: 1 } } }
    );
    assert.strictEqual(out.ok, false, t + ' 应被拒绝');
    assert.ok(/白名单/.test(String(out.error)), '错误应提示白名单: ' + t);
  }
  assert.ok(!ALLOWED_TABLES.has('app_audit'), '审计表不得进白名单');
  assert.ok(ALLOWED_TABLES.has('fs_samples'), '留样表应在白名单');
});

ok('零命中抛错（不静默成功）', () => {
  const snap = { rev: 1, data: {}, ext: { fs_samples: [{ id: 1 }] } };
  const out = executeAction(snap, {
    type: 'maint.row_delete',
    payload: { table: 'fs_samples', where: { id: 999 } },
  });
  assert.strictEqual(out.ok, false, '应执行失败');
  assert.ok(/未命中任何行/.test(String(out.error)), '错误应提示未命中');
  /* 未命中时快照不得被误写 */
  assert.strictEqual(out.snapshot, undefined, '失败不应产出新快照');
});

ok('data.ext 兜底副本同步清理（无 store 场景）', () => {
  const data = { ext: { qc_records: [{ id: 'a', ok: 1 }, { id: 'b', ok: 0 }] } };
  const msg = applyRowDelete({}, data, { table: 'qc_records', where: { id: 'b' } });
  assert.strictEqual(data.ext.qc_records.length, 1, '应剩 1 行');
  assert.strictEqual(data.ext.qc_records[0].id, 'a', '留下的应是真数据');
  assert.ok(/删除 1 行/.test(msg), '回执应含删除行数');
});

console.log(failed ? 'FAIL' : 'PASS');
process.exit(failed ? 1 : 0);
