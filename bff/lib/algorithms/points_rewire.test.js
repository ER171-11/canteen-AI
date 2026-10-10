'use strict';
/*
 * 点位数据源改造测试：inspection_board / foodsafety / inspection 三处聚合与校验
 * 在「已配置 ext.fs_points」时应以点位为准；空态仍回退内置默认（由既有测试覆盖）。
 * 用法：node bff/lib/algorithms/points_rewire.test.js
 */
const assert = require('assert');
const { buildBoard } = require('../inspection_board');
const foodsafety = require('../foodsafety');
const { executeAction } = require('./execute');

let pass = 0;
function ok(name) {
  pass += 1;
  console.log('  PASS ' + name);
}

/* ---------- 1. 巡检看板：板块/节点来自可配置点位 ---------- */
{
  const ext = {
    fs_points: [
      { id: 'U1', name: 'A点', zone: '前厅', kind: 'inspection', enabled: 1, sort: 0, every30: 0 },
      { id: 'U2', name: 'B点', zone: '前厅', kind: 'inspection', enabled: 1, sort: 1, every30: 1 },
      { id: 'U9', name: '停用', zone: '后厨', kind: 'inspection', enabled: 0, sort: 2, every30: 0 }
    ],
    inspection_records: [
      { node_id: 'U1', date: '2026-10-10', done: 1, photo_taken: 1, operator: '张三', ts: '2026-10-10T10:00:00' }
    ]
  };
  const board = buildBoard(ext, { date: '2026-10-10' });
  assert.strictEqual(board.summary.total, 2, '只看启用中的点位');
  assert.strictEqual(board.summary.done, 1);
  assert.deepStrictEqual(board.boards.map((b) => b.board), ['前厅'], '板块由点位 zone 动态生成');
  assert.strictEqual(board.boards[0].rate, 50);
  assert.strictEqual(board.boards[0].every30_pending, 1, 'U2 未完成且 every30');
  assert.deepStrictEqual(board.groups, ['前厅']);
  const u2 = board.nodes.find((n) => n.id === 'U2');
  assert.strictEqual(u2.name, 'B点');
  assert.strictEqual(u2.board, '前厅');
  ok('buildBoard 板块/节点来自可配置点位（含停用过滤）');
}

/* ---------- 2. 消毒达标率：应做区域来自可配置点位 ---------- */
{
  const ext = {
    fs_points: [
      { id: 'D01', name: '操作间', zone: '后厨', kind: 'disinfect', enabled: 1, sort: 0 },
      { id: 'D02', name: '洗消间', zone: '洗消', kind: 'disinfect', enabled: 1, sort: 1 }
    ],
    fs_disinfect: [{ area: '操作间', date: '2026-10-10', result: '已完成' }]
  };
  const rep = foodsafety.disinfectReport(ext, '2026-10-10', Date.parse('2026-10-10T12:00:00Z'), 1);
  assert.deepStrictEqual(rep.areas, ['操作间', '洗消间'], '应做区域取点位 name');
  assert.strictEqual(rep.today_done, 1);
  assert.deepStrictEqual(rep.today_missed, ['洗消间']);
  ok('disinfectReport 应做区域来自可配置消毒点位');
}

/* ---------- 3. 消毒达标率：无配置点位时回退历史区域（兼容） ---------- */
{
  const ext = { fs_disinfect: [{ area: '老区域', date: '2026-10-10', result: '已完成' }] };
  const rep = foodsafety.disinfectReport(ext, '2026-10-10', Date.parse('2026-10-10T12:00:00Z'), 1);
  assert.deepStrictEqual(rep.areas, ['老区域'], '无点位回退历史 fs_disinfect.area 去重');
  ok('disinfectReport 无配置点位回退历史区域');
}

/* ---------- 4. 巡检登记：接受可配置点位 id ---------- */
{
  const ext = {
    fs_points: [{ id: 'U1', name: 'A点', zone: '前厅', kind: 'inspection', enabled: 1, sort: 0, every30: 0 }]
  };
  const out = executeAction({ rev: 1, data: {}, ext: ext }, {
    type: 'inspection.record',
    payload: { node_id: 'U1', operator: '张三', photo_taken: 1, date: '2026-10-10' }
  }, { now: '2026-10-10T10:00:00' });
  assert.strictEqual(out.ok, true, out.error);
  const row = out.snapshot.ext.inspection_records[0];
  assert.strictEqual(row.node_id, 'U1');
  assert.strictEqual(row.board, '前厅');
  assert.strictEqual(row.node_name, 'A点');
  assert.strictEqual(row.done, 1);

  // 未拍照 = 未完成（红线不变）
  const out2 = executeAction({ rev: 1, data: {}, ext: ext }, {
    type: 'inspection.record',
    payload: { node_id: 'U1', operator: '张三', photo_taken: 0, done: true }
  }, { now: '2026-10-10T10:00:00' });
  assert.strictEqual(out2.snapshot.ext.inspection_records[0].done, 0, '未拍照恒判未完成');

  // 未知点位仍被驳回
  const bad = executeAction({ rev: 1, data: {}, ext: ext }, {
    type: 'inspection.record', payload: { node_id: 'NOPE', operator: '张三', photo_taken: 1 }
  }, {});
  assert.strictEqual(bad.ok, false, '未知点位应驳回');
  ok('recordInspection 接受可配置点位 / 未拍照判未完成 / 未知点位驳回');
}

console.log('== points_rewire 测试: ' + pass + ' 组全部通过 ==');
