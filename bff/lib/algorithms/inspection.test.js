'use strict';
/*
 * 闭店巡检（C 块）算法测试：inspection.record / inspection.assign。
 * 用法：node bff/lib/algorithms/inspection.test.js
 *
 * 本文件守护三条硬规则（用户已确认，改动即视为破坏需求）：
 *   1) 50 个标准节点是后端内置主数据，App 只读，节点 id 必须稳定；
 *   2) **未拍照 = 未完成**，即使上层传 done=true 也不认（照片是唯一完成凭据）；
 *   3) 巡检照片只存手机本地 —— 算法层收到任何图片字段都必须丢弃，不透传入库行。
 */
const assert = require('assert');
const inspection = require('./inspection');
const nodes = require('../inspection_nodes');

function makeStore() {
  return {
    tables: {},
    _rowid: {},
    insert(table, row) {
      if (!this.tables[table]) this.tables[table] = [];
      const rid = (this._rowid[table] || 0) + 1;
      this._rowid[table] = rid;
      this.tables[table].push(Object.assign({ id: rid }, row));
      return rid;
    }
  };
}

function firstRow(store, table) {
  const rows = store.tables[table] || [];
  assert.strictEqual(rows.length, 1, table + ' 应有且仅有 1 行');
  return rows[0];
}

let pass = 0;
function ok(name) {
  pass += 1;
  console.log('  PASS ' + name);
}

/* ---------- 1. 50 个标准节点主数据 ---------- */
{
  assert.strictEqual(nodes.TOTAL, 50, '标准节点必须是 50 个，当前: ' + nodes.TOTAL);
  assert.deepStrictEqual(nodes.BOARDS, ['后厨', '前厅', '仓库']);
  assert.strictEqual(nodes.byBoard('后厨').length, 20);
  assert.strictEqual(nodes.byBoard('前厅').length, 18);
  assert.strictEqual(nodes.byBoard('仓库').length, 12);
  assert.strictEqual(nodes.byBoard('不存在的板块').length, 0);

  const ids = nodes.NODES.map((n) => n.id);
  assert.strictEqual(new Set(ids).size, ids.length, '节点 id 必须唯一');
  const groups = nodes.groups();
  ['门窗', '煤气', '冰箱柜门', '电源开关', '水龙头', '卫生间'].forEach((g) => {
    assert.ok(groups.indexOf(g) >= 0, '缺少节点分组: ' + g);
  });

  const e30 = nodes.every30Nodes();
  assert.ok(e30.length >= 6, '卫生间类节点过少: ' + e30.length);
  // every30 的判定依据是现场是否需要「每 30 分钟一次」，而不是分组名：
  // 卫生间洗手池水龙头既属「水龙头」分组也属卫生间区域，同样需要频次拍照。
  e30.forEach((n) => assert.strictEqual(n.board, '前厅', 'every30 节点应在前厅卫生间区域: ' + n.id));
  nodes.byBoard('前厅').filter((n) => n.node_group === '卫生间')
    .forEach((n) => assert.strictEqual(n.every30, true, '卫生间分组节点必须 every30: ' + n.id));

  assert.deepStrictEqual(Object.keys(nodes.byId('K01')).sort(),
    ['board', 'every30', 'id', 'name', 'node_group']);
  assert.strictEqual(nodes.byId('NOPE'), null);
  assert.strictEqual(nodes.fullName(nodes.byId('F11')), '前厅-马桶冲水正常');
  ok('50 个标准节点主数据与分组');
}

/* ---------- 2. 主数据只读：外部改写不影响内置 ---------- */
{
  const a = nodes.all();
  a[0].name = '被篡改';
  assert.notStrictEqual(nodes.byId('K01').name, '被篡改', '外部改写污染了内置主数据');
  const b = nodes.byId('K01');
  b.board = '被篡改';
  assert.strictEqual(nodes.byId('K01').board, '后厨', 'byId 返回副本失败');
  ok('内置节点主数据不可被外部污染');
}

/* ---------- 3. 拍照完成：正常登记 ---------- */
{
  const store = makeStore();
  const msg = inspection.recordInspection({ store: store }, {}, {
    node_id: 'K04', operator: '王师傅', date: '2026-09-29',
    photo_taken: 1, station: '后厨燃气房', ts: '2026-09-29T21:05:00'
  });
  assert.ok(/^inspection_records rowid=\d+$/.test(msg), 'msg: ' + msg);
  const row = firstRow(store, 'inspection_records');
  assert.strictEqual(row.node_id, 'K04');
  assert.strictEqual(row.node_name, '燃气总阀关闭');
  assert.strictEqual(row.board, '后厨');
  assert.strictEqual(row.node_group, '煤气');
  assert.strictEqual(row.done, 1);
  assert.strictEqual(row.photo_taken, 1);
  assert.strictEqual(row.every30, 0);
  assert.strictEqual(row.photo_local_only, 0);
  assert.strictEqual(row.operator, '王师傅');
  assert.strictEqual(row.station, '后厨燃气房');
  assert.strictEqual(row.date, '2026-09-29');
  ok('inspection.record 拍照后登记完成');
}

/* ---------- 4. 未拍照：必须自动标记未完成 ---------- */
{
  const cases = [
    { name: 'photo_taken 缺省', payload: { node_id: 'K01', operator: '王师傅' } },
    { name: 'photo_taken=false', payload: { node_id: 'K01', operator: '王师傅', photo_taken: 0 } },
    { name: 'photo_taken=false 但上层硬传 done=true',
      payload: { node_id: 'K01', operator: '王师傅', photo_taken: false, done: true } }
  ];
  for (const c of cases) {
    const store = makeStore();
    inspection.recordInspection({ store: store }, {}, c.payload);
    const row = firstRow(store, 'inspection_records');
    assert.strictEqual(row.photo_taken, 0, '[' + c.name + '] photo_taken 应为 0');
    assert.strictEqual(row.done, 0, '[' + c.name + '] 未拍照必须标记未完成');
    ok('inspection.record 未拍照 → 未完成（' + c.name + '）');
  }
}

/* ---------- 5. photo_taken=true 但显式 done=false ⇒ 仍算未完成 ---------- */
{
  const store = makeStore();
  inspection.recordInspection({ store: store }, {}, { node_id: 'K01', operator: '王师傅', photo_taken: 1, done: false });
  const row = firstRow(store, 'inspection_records');
  assert.strictEqual(row.photo_taken, 1);
  assert.strictEqual(row.done, 0, 'done=false 时不应算完成');
  ok('inspection.record 显式 done=false 保持未完成');
}

/* ---------- 6. 卫生间类节点自动补 30 分钟轮次 ---------- */
{
  assert.strictEqual(inspection.roundOf30('2026-09-29T21:05:00'), 42);
  assert.strictEqual(inspection.roundOf30('2026-09-29T00:29:00'), 0);
  assert.strictEqual(inspection.roundOf30('2026-09-29T23:59:00'), 47);
  assert.strictEqual(inspection.roundOf30('bad'), null);

  const store = makeStore();
  inspection.recordInspection({ store: store }, {}, {
    node_id: 'F11', operator: '小刘', photo_taken: 1, date: '2026-09-29', ts: '2026-09-29T21:05:00'
  });
  const row = firstRow(store, 'inspection_records');
  assert.strictEqual(row.every30, 1);
  assert.strictEqual(row.round, 42);
  ok('inspection.record 卫生间节点补 30 分钟轮次');

  const store2 = makeStore();
  inspection.recordInspection({ store: store2 }, {}, { node_id: 'K01', operator: '小刘', photo_taken: 1 });
  assert.strictEqual(firstRow(store2, 'inspection_records').round, null, '非卫生间节点不应带轮次');
  ok('inspection.record 非卫生间节点不带轮次');
}

/* ---------- 7. 未知节点 / 缺责任人必须驳回 ---------- */
{
  const cases = [
    { name: '未知节点', payload: { node_id: 'X99', operator: '王师傅' }, kw: '未知巡检节点' },
    { name: '缺节点', payload: { operator: '王师傅' }, kw: '未知巡检节点' },
    { name: '缺责任人', payload: { node_id: 'K01' }, kw: '责任人' },
    { name: '空白责任人', payload: { node_id: 'K01', operator: '  ' }, kw: '责任人' }
  ];
  for (const c of cases) {
    const store = makeStore();
    let err = null;
    try { inspection.recordInspection({ store: store }, {}, c.payload); } catch (e) { err = e.message; }
    assert.ok(err !== null, '[' + c.name + '] 未抛错');
    assert.ok(err.indexOf(c.kw) >= 0, '[' + c.name + '] 错误文案: ' + err);
    assert.strictEqual((store.tables.inspection_records || []).length, 0, '[' + c.name + '] 不应落库');
    ok('inspection.record 驳回：' + c.name);
  }
}

/* ---------- 8. 图片载荷一律丢弃（红线：巡检照片只存手机本地） ---------- */
{
  const store = makeStore();
  inspection.recordInspection({ store: store }, {}, {
    node_id: 'F13', operator: '小刘', photo_taken: 1,
    photo_base64: 'data:image/jpeg;base64,AAAA', photo_url: 'https://oss.example.com/local.jpg',
    local_uri: 'file:///data/user/0/com.pandawufu.app/files/photos/f13.jpg'
  });
  const row = firstRow(store, 'inspection_records');
  assert.strictEqual(row.photo_local_only, 1, '收到图片载荷应留痕 photo_local_only=1');
  const keys = Object.keys(row);
  ['photo_url', 'photo_base64', 'local_uri', 'file_url', 'image'].forEach((k) => {
    assert.strictEqual(keys.indexOf(k) < 0, true, '入库行不得包含图片字段: ' + k);
  });
  assert.strictEqual(JSON.stringify(row).indexOf('base64'), -1, '入库行不得含 base64 残留');
  ok('inspection.record 丢弃图片载荷且不留图片列');
}

/* ---------- 9. 板块分工（负责到人） ---------- */
{
  const store = makeStore();
  const msg = inspection.assignInspection({ store: store }, {}, { board: '后厨', operator: '王师傅', store_id: 'ST001' });
  assert.ok(/^inspection_assignments rowid=\d+$/.test(msg), 'msg: ' + msg);
  const row = firstRow(store, 'inspection_assignments');
  assert.strictEqual(row.board, '后厨');
  assert.strictEqual(row.operator, '王师傅');
  assert.strictEqual(row.store_id, 'ST001');

  const store2 = makeStore();
  let err = null;
  try { inspection.assignInspection({ store: store2 }, {}, { board: '天台', operator: '王师傅' }); } catch (e) { err = e.message; }
  assert.ok(err !== null && err.indexOf('未知巡检板块') >= 0, 'err: ' + err);

  const store3 = makeStore();
  err = null;
  try { inspection.assignInspection({ store: store3 }, {}, { board: '后厨' }); } catch (e) { err = e.message; }
  assert.ok(err !== null && err.indexOf('责任人') >= 0, 'err: ' + err);
  ok('inspection.assign 分工到人 + 非法板块/缺人驳回');
}

/* ---------- 10. 无 ctx.store 优雅降级 ---------- */
{
  const data = {};
  const msg = inspection.recordInspection({}, data, { node_id: 'K01', operator: '王师傅', photo_taken: 1 });
  assert.ok(msg.indexOf('rowid=-') >= 0, 'degrade msg: ' + msg);
  assert.ok(Array.isArray(data.ext && data.ext.inspection_records), 'degrade ext');
  assert.strictEqual(data.ext.inspection_records[0].done, 1);
  ok('inspection.record degrade.noStore');
}

/* ---------- 11. 注册表可达 ---------- */
{
  require('./registry');
  const { has } = require('./index');
  assert.ok(has('inspection.record'), 'inspection.record 未注册');
  assert.ok(has('inspection.assign'), 'inspection.assign 未注册');
  assert.ok(has('qc.force_pass'), 'qc.force_pass 未注册');
  ok('registry 已注册 inspection.record / inspection.assign');
}

/* ---------- 12. 看板聚合：板块完成率 + 漏项清单 ---------- */
{
  const { buildBoard } = require('../inspection_board');
  const ext = {
    inspection_records: [
      { node_id: 'K01', board: '后厨', node_name: '外门锁闭', date: '2026-09-29', done: 1, photo_taken: 1, operator: '王师傅', ts: '2026-09-29T21:00:00' },
      { node_id: 'K02', board: '后厨', node_name: '通后巷门插销', date: '2026-09-29', done: 0, photo_taken: 0, operator: '王师傅', ts: '2026-09-29T21:01:00' },
      { node_id: 'K02', board: '后厨', node_name: '通后巷门插销', date: '2026-09-29', done: 1, photo_taken: 1, operator: '王师傅', ts: '2026-09-29T21:30:00' },
      { node_id: 'K01', board: '后厨', node_name: '外门锁闭', date: '2026-09-28', done: 0, photo_taken: 0, ts: '2026-09-28T21:00:00' },
      { node_id: 'F11', board: '前厅', node_name: '马桶冲水正常', date: '2026-09-29', done: 1, photo_taken: 1, every30: 1, round: 42, operator: '小刘', ts: '2026-09-29T21:05:00' }
    ],
    inspection_assignments: [
      { board: '后厨', operator: '王师傅' },
      { board: '前厅', operator: '小刘' },
      { board: '仓库', operator: '老周' }
    ]
  };
  const b = buildBoard(ext, { date: '2026-09-29', now: '2026-09-29T23:59:00' });

  assert.strictEqual(b.date, '2026-09-29');
  assert.strictEqual(b.summary.total, 50);
  // 每节点只认最新一条：K01 完成、K02 取 21:30 那条（完成）、F11 完成 → 3
  assert.strictEqual(b.summary.done, 3, '同节点多轮记录应只认最新一条: ' + b.summary.done);
  assert.strictEqual(b.summary.missing, 47);
  assert.strictEqual(b.summary.rate, 6);

  const kitchen = b.boards.filter((x) => x.board === '后厨')[0];
  assert.strictEqual(kitchen.total, 20);
  assert.strictEqual(kitchen.done, 2, 'K02 应取最新一条（21:30 完成），K01 完成 → 2');
  assert.strictEqual(kitchen.missing_count, 18);
  assert.strictEqual(kitchen.operator, '王师傅');
  assert.strictEqual(kitchen.rate, 10);

  const hall = b.boards.filter((x) => x.board === '前厅')[0];
  assert.strictEqual(hall.every30_pending, 7, '前厅 8 个 every30 节点中 F11 已完成');

  assert.strictEqual(hall.missing.length, 17);
  assert.ok(hall.missing.some((m) => m.node_id === 'F13' && m.every30 === true), '漏项应含未拍照的卫生间节点');
  assert.strictEqual(hall.last_ts, '2026-09-29T21:05:00');

  // 漏项里绝不能出现图片字段
  assert.strictEqual(JSON.stringify(b).indexOf('photo_url'), -1, '看板输出不得含图片字段');
  assert.strictEqual(b.every30.node_total, 8);
  assert.strictEqual(b.every30.rounds_per_day, 48);
  assert.deepStrictEqual(b.every30.rounds_recorded, [42]);
  assert.strictEqual(b.every30.rounds_missing.length, 47);
  assert.strictEqual(b.records.length, 4, '2026-09-29 共 4 条记录');
  assert.strictEqual(b.records[0].ts, '2026-09-29T21:30:00', '台账应按时间倒序');
  ok('buildBoard 板块完成率/漏项/轮次/台账');
}

/* ---------- 13. 看板筛选与跨日隔离 ---------- */
{
  const { buildBoard, dayOf, missingRounds } = require('../inspection_board');
  const ext = {
    inspection_records: [
      { node_id: 'K01', board: '后厨', date: '2026-09-29', done: 1, photo_taken: 1, operator: '王师傅', ts: '2026-09-29T21:00:00' },
      { node_id: 'C01', board: '仓库', date: '2026-09-29', done: 1, photo_taken: 1, operator: '老周', ts: '2026-09-29T21:10:00' }
    ]
  };
  const byBoard = buildBoard(ext, { date: '2026-09-29', board: '仓库' });
  assert.strictEqual(byBoard.summary.done, 1, '按板块筛选后只应统计该板块');
  assert.strictEqual(byBoard.records.length, 1);
  assert.strictEqual(byBoard.boards.filter((x) => x.board === '仓库')[0].done, 1);
  assert.strictEqual(byBoard.boards.filter((x) => x.board === '后厨')[0].done, 0, '被筛掉的板块只统计筛选后的记录');

  const byOperator = buildBoard(ext, { date: '2026-09-29', operator: '老周' });
  assert.strictEqual(byOperator.summary.done, 1);

  const byNode = buildBoard(ext, { date: '2026-09-29', node_id: 'C01' });
  assert.strictEqual(byNode.records.length, 1);
  assert.strictEqual(byNode.records[0].node_id, 'C01');

  const otherDay = buildBoard(ext, { date: '2026-09-27' });
  assert.strictEqual(otherDay.summary.done, 0, '跨日不得串数据');

  assert.strictEqual(dayOf({ date: '2026-09-29' }), '2026-09-29');
  assert.strictEqual(dayOf({ ts: '2026-09-29T21:00:00' }), '2026-09-29');
  assert.strictEqual(dayOf({}), '');
  assert.deepStrictEqual(missingRounds([0, 1], '2026-01-01T01:00:00'), [2], '当前轮次也应算入缺口');
  assert.deepStrictEqual(missingRounds([], '2026-01-01T00:10:00'), [0]);
  assert.strictEqual(buildBoard(ext, { date: '2026-09-29', limit: 5000 }).records.length, 2);
  ok('buildBoard 筛选/跨日隔离/时间工具');
}

console.log('PASS inspection ' + pass + '/' + pass);
