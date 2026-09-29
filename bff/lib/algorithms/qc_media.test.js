'use strict';
/*
 * 品控拍照识别（A 块）算法测试：qc_records 扩展字段 + qc.force_pass 强制放行留痕。
 * 用法：node bff/lib/algorithms/qc_media.test.js
 *
 * 与 ops.test.js 的区别：这里是 Node 单边断言，不与 Python 基准对拍。
 * 原因：新增列在 Python 基准实现（old/.../queue_consumer.py）里并不存在，
 * 平价对拍只对「双方都实现的 6 字段」有意义。因此本文件承担两件事：
 *   1) 守护 legacy 兼容 —— 只传 6 字段时落库行必须逐列不变（平价对拍的前提）；
 *   2) 覆盖扩展字段与强制放行的新语义。
 */
const assert = require('assert');
const ops = require('./ops');

/* ---------- 内存 store（对齐 ctx.store.insert 契约） ---------- */
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

/* ---------- 1. legacy 兼容：6 字段落库行逐列不变 ---------- */
{
  const store = makeStore();
  const msg = ops.insertQcRecord({ store: store }, {}, {
    workorder_id: 7, sku_id: 'S1', sample_weight: 50, pass: '合格', ts: '2026-09-27T10:00:00', source: 'auto'
  });
  assert.ok(/^qc_records rowid=\d+$/.test(msg), 'msg: ' + msg);
  const row = firstRow(store, 'qc_records');
  assert.deepStrictEqual(Object.keys(row).sort(),
    ['id', 'pass', 'sample_weight', 'sku_id', 'source', 'ts', 'workorder_id'],
    'legacy 落库列发生了变化: ' + Object.keys(row).join(','));
  assert.strictEqual(row.pass, 1);
  assert.strictEqual(row.source, 'auto');
  ok('qc.record legacy 六字段落库列不变');
}

/* ---------- 2. 扩展字段全量写入 ---------- */
{
  const store = makeStore();
  ops.insertQcRecord({ store: store }, {}, {
    workorder_id: 12,
    sku_id: 'S2',
    pass: 0,
    ts: '2026-09-29T20:15:00',
    source: 'kimi',
    defect_items: ['裂纹', '开口', '花纹不符'],
    stage: '捏褶',
    operator: '张三',
    photo_url: 'https://oss.example.com/qc/12.jpg',
    photo_key: 'qc/2026-09-29/12.jpg',
    conf: 63.4,
    manual_review: true,
    station: '后厨-捏褶台',
    store_id: 'ST001'
  });
  const row = firstRow(store, 'qc_records');
  assert.strictEqual(row.pass, 0);
  assert.strictEqual(row.defect_items, JSON.stringify(['裂纹', '开口', '花纹不符']),
    'defect_items 应序列化为 JSON 数组: ' + row.defect_items);
  assert.strictEqual(row.stage, '捏褶');
  assert.strictEqual(row.operator, '张三');
  assert.strictEqual(row.photo_url, 'https://oss.example.com/qc/12.jpg');
  assert.strictEqual(row.photo_key, 'qc/2026-09-29/12.jpg');
  assert.strictEqual(row.conf, 63.4);
  assert.strictEqual(row.manual_review, 1);
  assert.strictEqual(row.station, '后厨-捏褶台');
  assert.strictEqual(row.store_id, 'ST001');
  ok('qc.record 扩展字段全量落库');
}

/* ---------- 3. 只提供部分扩展字段：不凭空补 NULL 列 ---------- */
{
  const store = makeStore();
  ops.insertQcRecord({ store: store }, {}, { workorder_id: 3, pass: 1, photo_url: 'u1' });
  const row = firstRow(store, 'qc_records');
  assert.deepStrictEqual(Object.keys(row).sort(),
    ['id', 'pass', 'photo_url', 'sample_weight', 'sku_id', 'source', 'ts', 'workorder_id'],
    '部分扩展字段落库列不符: ' + Object.keys(row).join(','));
  assert.strictEqual(row.sku_id, null, 'sku_id 未提供应为 null（沿用 legacy 行为）');
  ok('qc.record 部分扩展字段不补空列');
}

/* ---------- 4. 缺陷项容错：分隔字符串 / 空值 / 别名 ---------- */
{
  const store = makeStore();
  ops.insertQcRecord({ store: store }, {}, { workorder_id: 1, pass: 0, defect_items: '裂纹、开口, 色泽偏差' });
  assert.strictEqual(firstRow(store, 'qc_records').defect_items,
    JSON.stringify(['裂纹', '开口', '色泽偏差']), '分隔字符串应被切分');
  ok('qc.record defect_items 支持分隔字符串');

  const store2 = makeStore();
  ops.insertQcRecord({ store: store2 }, {}, { workorder_id: 2, pass: 0, defect_items: [], defects: '开口' });
  assert.strictEqual(firstRow(store2, 'qc_records').defect_items, JSON.stringify(['开口']),
    'defect_items 为空数组应回落到 defects 别名');
  ok('qc.record defect_items 空数组回落别名');

  const store3 = makeStore();
  ops.insertQcRecord({ store: store3 }, {}, { workorder_id: 4, pass: 1, defect_items: [] });
  assert.strictEqual('defect_items' in firstRow(store3, 'qc_records'), false,
    '空缺陷列表不应写入列');
  ok('qc.record 空缺陷列表不写列');
}

/* ---------- 5. 判定依据字段归一：confidence 别名 + manual_review 假值 ---------- */
{
  const store = makeStore();
  ops.insertQcRecord({ store: store }, {}, { workorder_id: 5, pass: 1, confidence: '88.5', manual_review: 0 });
  const row = firstRow(store, 'qc_records');
  assert.strictEqual(row.conf, 88.5, 'confidence 别名应归一为数值: ' + row.conf);
  assert.strictEqual(row.manual_review, 0);
  ok('qc.record confidence 别名与 manual_review 归一');
}

/* ---------- 6. 无 ctx.store 优雅降级 ---------- */
{
  const data = {};
  const msg = ops.insertQcRecord({}, data, { workorder_id: 9, pass: 0, defect_items: ['裂纹'], photo_url: 'u9' });
  assert.ok(msg.indexOf('rowid=-') >= 0, 'degrade msg: ' + msg);
  assert.ok(Array.isArray(data.ext && data.ext.qc_records) && data.ext.qc_records.length === 1, 'degrade ext');
  assert.strictEqual(data.ext.qc_records[0].photo_url, 'u9');
  ok('qc.record degrade.noStore');
}

/* ---------- 7. 强制放行：正常留痕 ---------- */
{
  const store = makeStore();
  const msg = ops.insertQcForcePass({ store: store }, {}, {
    workorder_id: 12, reason: '客人催单，褶纹轻微不影响口感', operator: '李厨师长', ts: '2026-09-29T20:31:00'
  });
  assert.ok(/^qc_force_pass rowid=\d+$/.test(msg), 'msg: ' + msg);
  const row = firstRow(store, 'qc_force_pass');
  assert.strictEqual(row.workorder_id, 12);
  assert.strictEqual(row.reason, '客人催单，褶纹轻微不影响口感');
  assert.strictEqual(row.operator, '李厨师长');
  assert.strictEqual(row.ts, '2026-09-29T20:31:00');
  assert.strictEqual(row.source, 'manual');
  ok('qc.force_pass 留痕原因/操作人/时刻');
}

/* ---------- 8. 强制放行：缺原因或缺工单必须驳回 ---------- */
{
  const cases = [
    { name: 'qc.force_pass 缺 workorder_id', payload: { reason: '有原因' }, kw: 'workorder_id' },
    { name: 'qc.force_pass 缺原因', payload: { workorder_id: 12 }, kw: '必须填写原因' },
    { name: 'qc.force_pass 空白原因', payload: { workorder_id: 12, reason: '   ' }, kw: '必须填写原因' }
  ];
  for (const c of cases) {
    const store = makeStore();
    let err = null;
    try { ops.insertQcForcePass({ store: store }, {}, c.payload); } catch (e) { err = e.message; }
    assert.ok(err !== null, '[' + c.name + '] 未抛错');
    assert.ok(err.indexOf(c.kw) >= 0, '[' + c.name + '] 错误文案: ' + err);
    assert.strictEqual((store.tables.qc_force_pass || []).length, 0, '[' + c.name + '] 不应落库');
    ok(c.name);
  }
}

/* ---------- 9. 强制放行：无 ctx.store 优雅降级 ---------- */
{
  const data = {};
  const msg = ops.insertQcForcePass({}, data, { workorder_id: 3, reason: '拍照重试后仍不合格但可食用' });
  assert.ok(msg.indexOf('rowid=-') >= 0, 'degrade msg: ' + msg);
  assert.ok(Array.isArray(data.ext && data.ext.qc_force_pass) && data.ext.qc_force_pass.length === 1, 'degrade ext');
  ok('qc.force_pass degrade.noStore');
}

/* ---------- 10. 注册表可达：type → 算法 双向绑定 ---------- */
{
  require('./registry'); // 副作用注册：registry.js 在 require 时 registerAll
  const { has } = require('./index');
  assert.ok(has('qc.record'), 'qc.record 未注册');
  assert.ok(has('qc.force_pass'), 'qc.force_pass 未注册');
  ok('registry 已注册 qc.force_pass');
}

console.log('PASS qc_media ' + pass + '/' + pass);
