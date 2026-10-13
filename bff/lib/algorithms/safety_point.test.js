'use strict';
/*
 * 食安点位主数据测试：lib/safety_points.js 纯函数 + safety_point.* 算法（经 executeAction）。
 * 用法：node bff/lib/algorithms/safety_point.test.js
 *
 * 守护「自定义优先、内置默认兜底」的读取口径，以及点位增删改的正确性：
 *   1) 首次空态回退内置默认（巡检 50 / 消毒 5）；
 *   2) ext.fs_points 有该 kind 有效点位时以 ext 为准（按 sort 升序）；
 *   3) upsert 按 id 幂等；seed 批量导入默认；remove 逻辑删除（enabled=0）。
 */
const assert = require('assert');
const sp = require('../safety_points');
const { executeAction } = require('./execute');
const objstore = require('../objstore');

let pass = 0;
function ok(name) {
  pass += 1;
  console.log('  PASS ' + name);
}

function snap(ext) {
  return { rev: 1, generated_at: '2026-10-10T00:00:00', data: {}, ext: ext || {} };
}

function run(action, ext) {
  return executeAction(snap(ext), action, { now: '2026-10-10T00:00:00' });
}

/* ---------- 1. 内置默认点位 ---------- */
{
  assert.strictEqual(sp.defaultPoints('inspection').length, 50, '巡检默认应为 50 个');
  assert.strictEqual(sp.defaultPoints('disinfect').length, 5, '消毒默认应为 5 个');

  const k01 = sp.defaultPoints('inspection').find((p) => p.id === 'K01');
  assert.strictEqual(k01.name, '外门锁闭');
  assert.strictEqual(k01.zone, '后厨');
  assert.strictEqual(k01.kind, 'inspection');
  assert.strictEqual(k01.enabled, 1);

  const f11 = sp.defaultPoints('inspection').find((p) => p.id === 'F11');
  assert.strictEqual(f11.every30, 1, '卫生间类节点应 every30=1');
  ok('内置默认巡检 50 / 消毒 5，字段归一正确');
}

/* ---------- 2. resolvePoints：空态回退 + 自定义优先 + 排序 ---------- */
{
  const none = sp.resolvePoints({}, 'inspection');
  assert.strictEqual(none.length, 50, '空 ext 应回退内置 50');
  assert.strictEqual(sp.usingDefaultPoints({}, 'inspection'), true);

  const custom = sp.resolvePoints({
    fs_points: [
      { id: 'U2', name: 'B点', zone: '前厅', kind: 'inspection', enabled: 1, sort: 20 },
      { id: 'U1', name: 'A点', zone: '后厨', kind: 'inspection', enabled: 1, sort: 10 },
      { id: 'X9', name: '已删', zone: '后厨', kind: 'inspection', enabled: 0, sort: 5 }
    ]
  }, 'inspection');
  assert.strictEqual(custom.length, 2, '仅返回启用中的自定义点位');
  assert.deepStrictEqual(custom.map((p) => p.id), ['U1', 'U2'], '按 sort 升序');
  assert.strictEqual(sp.usingDefaultPoints({ fs_points: custom }, 'inspection'), false);

  // kind 隔离：消毒点位不得混入巡检
  assert.strictEqual(sp.resolvePoints({
    fs_points: [{ id: 'D01', name: '前厅', zone: '前厅', kind: 'disinfect', enabled: 1, sort: 0 }]
  }, 'inspection').length, 50, '不同 kind 互不干扰');
  ok('resolvePoints 空态回退 / 自定义优先 / sort 排序 / kind 隔离');
}

/* ---------- 3. pointById ---------- */
{
  assert.strictEqual(sp.pointById({}, 'inspection', 'K01').name, '外门锁闭', '内置兜底命中');
  assert.strictEqual(sp.pointById({}, 'inspection', 'NOPE'), null);
  const hit = sp.pointById({ fs_points: [{ id: 'U1', name: '自定义点', zone: '后厨', kind: 'inspection', enabled: 1 }] }, 'inspection', 'U1');
  assert.strictEqual(hit.name, '自定义点');
  ok('pointById 内置兜底 / 自定义命中 / 未知返回 null');
}

/* ---------- 4. safety_point.upsert：幂等 ---------- */
{
  const out1 = run({ type: 'safety_point.upsert', payload: { id: 'U1', name: '验收台', zone: '后厨', kind: 'inspection', sort: 5 } });
  assert.strictEqual(out1.ok, true, out1.error);
  assert.strictEqual(out1.handled, true);
  const rows1 = out1.snapshot.ext.fs_points;
  assert.strictEqual(rows1.length, 1, '首次 upsert 应落 1 行');
  assert.strictEqual(rows1[0].id, 'U1');
  assert.strictEqual(rows1[0].name, '验收台');
  assert.strictEqual(rows1[0].enabled, 1);

  // 同 id 再 upsert（承接上一次快照）：仍 1 行（更新而非新增）
  const out2 = executeAction(out1.snapshot, { type: 'safety_point.upsert', payload: { id: 'U1', name: '验收台改', zone: '后厨', kind: 'inspection', sort: 5 } }, { now: '2026-10-10T00:00:00' });
  const rows2 = out2.snapshot.ext.fs_points;
  assert.strictEqual(rows2.length, 1, '同 id upsert 必须幂等');
  assert.strictEqual(rows2[0].name, '验收台改');

  // 缺 id：自动生成 U 前缀 id（承接上一步快照，应新增第 2 行）
  const out3 = executeAction(out2.snapshot, { type: 'safety_point.upsert', payload: { name: '新点位', zone: '前厅', kind: 'inspection' } }, { now: '2026-10-10T00:00:00' });
  const rows3 = out3.snapshot.ext.fs_points;
  assert.strictEqual(rows3.length, 2);
  assert.ok(/^U/.test(rows3[1].id), '缺 id 应自动生成 U 前缀 id: ' + rows3[1].id);
  ok('safety_point.upsert 按 id 幂等 / 缺 id 自动生成');
}

/* ---------- 5. safety_point.upsert 校验 ---------- */
{
  assert.strictEqual(run({ type: 'safety_point.upsert', payload: { name: 'x', kind: 'nope' } }).ok, false, 'kind 非法应驳回');
  assert.strictEqual(run({ type: 'safety_point.upsert', payload: { kind: 'inspection' } }).ok, false, '缺 name 应驳回');
  ok('safety_point.upsert 非法 kind / 缺 name 被驳回');
}

/* ---------- 6. safety_point.seed：批量导入默认 ---------- */
{
  const out = run({ type: 'safety_point.seed', payload: { kind: 'disinfect' } });
  assert.strictEqual(out.ok, true, out.error);
  const rows = out.snapshot.ext.fs_points;
  assert.strictEqual(rows.length, 5, '消毒 seed 应写 5 行');
  assert.ok(rows.every((r) => r.kind === 'disinfect' && r.enabled === 1));
  assert.strictEqual(sp.usingDefaultPoints(out.snapshot.ext, 'disinfect'), false, 'seed 后不再走默认');
  assert.strictEqual(sp.resolvePoints(out.snapshot.ext, 'disinfect').length, 5);
  ok('safety_point.seed 批量导入消毒默认 5 点');
}

/* ---------- 7. safety_point.remove：逻辑删除 ---------- */
{
  const seeded = run({ type: 'safety_point.seed', payload: { kind: 'inspection' } }).snapshot;
  assert.strictEqual(seeded.ext.fs_points.length, 50);

  const removed = executeAction(seeded, { type: 'safety_point.remove', payload: { id: 'K01', kind: 'inspection' } }, { now: '2026-10-10T00:00:00' });
  assert.strictEqual(removed.ok, true, removed.error);
  const k01 = removed.snapshot.ext.fs_points.find((r) => r.id === 'K01');
  assert.strictEqual(k01.enabled, 0, 'remove 应为逻辑删除');
  assert.strictEqual(sp.resolvePoints(removed.snapshot.ext, 'inspection').length, 49, '删除后不再计入');

  // 删除不存在的自定义点位 → 驳回
  const miss = executeAction(seeded, { type: 'safety_point.remove', payload: { id: 'NOPE', kind: 'inspection' } }, {});
  assert.strictEqual(miss.ok, false, '未知 id 应驳回');
  assert.strictEqual(miss.handled, true);
  ok('safety_point.remove 逻辑删除 / 未知 id 驳回');
}

/* ---------- 8. remove 兼容店内 SQLite store（update 返回 rowcount） ---------- */
{
  const rows = [{ id: 'U1', name: 'A', zone: '后厨', kind: 'inspection', enabled: 1, sort: 0 }];
  const sqliteLikeStore = {
    ext: { fs_points: rows },
    query(t) { return this.ext[t] || []; },
    upsert() { return { rowid: 1, matched: true }; },
    update(table, patch, where) {
      const list = this.ext[table] || [];
      let n = 0;
      list.forEach((r) => {
        if (Object.keys(where).every((k) => String(r[k]) === String(where[k]))) {
          Object.assign(r, patch); n += 1;
        }
      });
      return { rowcount: n };
    }
  };
  const out = executeAction(snap({}), {
    type: 'safety_point.remove', payload: { id: 'U1', kind: 'inspection' }
  }, { store: sqliteLikeStore });
  assert.strictEqual(out.ok, true, out.error);
  assert.strictEqual(rows[0].enabled, 0, '店内 store 下 remove 应生效');

  const miss = executeAction(snap({}), {
    type: 'safety_point.remove', payload: { id: 'NOPE', kind: 'inspection' }
  }, { store: sqliteLikeStore });
  assert.strictEqual(miss.ok, false, '店内 store 下未知 id 应驳回');
  ok('safety_point.remove 兼容店内 SQLite store（rowcount）');
}

/* ---------- 9. 对象键：演示图 ---------- */
{
  assert.strictEqual(objstore.configured(), false);
  const key = objstore.buildPointDemoKey({ store_id: 'ST001', kind: 'inspection', id: 'K01', date: '2026-10-10' });
  assert.ok(/^points\/ST001\/2026-10-10\/inspection-K01-\d+-[0-9a-f]{6}\.jpg$/.test(key), key);
  ok('buildPointDemoKey 生成 points/{门店}/{日期}/ 前缀对象键');
}

console.log('== safety_point 测试: ' + pass + ' 组全部通过 ==');
