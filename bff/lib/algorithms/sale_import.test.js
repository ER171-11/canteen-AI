'use strict';
/*
 * lib/algorithms/sale_import.test.js — 平台销售导入「写侧执行器」自证。
 * 覆盖：sale.import（导入+幂等+别名写）、sale.batch_void（撤回留痕）、sale.amt_recalc（重算）、
 *        sale.alias_set/delete（映射增删）。
 * 用法：node bff/lib/algorithms/sale_import.test.js
 */
const assert = require('assert');
const sale = require('./sale');

let pass = 0;
function ok(name, fn) { fn(); pass++; console.log('  PASS ' + name); }

const ctx = { rev: 1, traceId: 't1', now: '2026-10-14T10:00:00.000Z' };

function freshData() {
  return {
    dishes: [
      { id: 'D1', name: '五福饺子', cat: '主食', on: true },
      { id: 'D2', name: '红烧肉', cat: '热菜', on: true },
    ],
    sales: [],
    dishAlias: {},
  };
}
const rows = [
  { dish: '五福饺子', qty: 2, date: '2026-10-12', price: 25, list: 50, paid: 50, net: 45 },
  { dish: '红烧肉', qty: 1, date: '2026-10-12', price: 30, list: 30, paid: 30, net: 27 },
];

ok('sale.import：整批导入，写 sales + 金额口径正确', () => {
  const data = freshData();
  const msg = sale.applySaleImport(data, { rows, mode: 'sum', src: 'mt', settled: false }, ctx);
  assert.strictEqual(data.sales.length, 1);
  const s = data.sales[0];
  assert.strictEqual(s.src, 'mt');
  assert.strictEqual(s.amount, 80);
  assert.strictEqual(s.receivable, 72);
  assert.strictEqual(s.discount, 8);
  assert.strictEqual(s.amtMode, 'A');
  assert.ok(s.batch);
  assert.strictEqual(s.settled, 0);
  assert.strictEqual(s.payments.length, 0);
  assert.ok(/已导入 1 张/.test(msg));
});

ok('sale.import：幂等拦截（同 src 同日期重导报错）', () => {
  const data = freshData();
  sale.applySaleImport(data, { rows, mode: 'sum', src: 'mt' }, ctx);
  assert.throws(() => sale.applySaleImport(data, { rows, mode: 'sum', src: 'mt' }, ctx), /幂等拦截/);
});

ok('sale.import：sel 人工映射写回 dishAlias', () => {
  const data = freshData();
  sale.applySaleImport(data, { rows: [{ dish: '未知菜', qty: 1, date: '2026-10-12', price: 10, list: 10, paid: 10, net: 9 }], mode: 'sum', src: 'mt', sel: { '未知菜': 'D1' } }, ctx);
  assert.deepStrictEqual(data.dishAlias['未知菜'], { dish: 'D1', mul: 1 });
  assert.strictEqual(data.sales.length, 1);
});

ok('sale.batch_void：整批作废留痕（不物理删除、不回补）', () => {
  const data = freshData();
  sale.applySaleImport(data, { rows, mode: 'sum', src: 'mt' }, ctx);
  const batch = data.sales[0].batch;
  const msg = sale.applySaleBatchVoid(data, { batch, reason: '重复导入' }, ctx);
  const s = data.sales[0];
  assert.strictEqual(s.status, '已作废');
  assert.strictEqual(s.void_reason, '重复导入');
  assert.ok(data.sales.length === 1); // 未删除
  assert.ok(/整批撤回 1 张/.test(msg));
});

ok('sale.batch_void 后：作废单不占幂等键，可重新导入同批数据', () => {
  const data = freshData();
  sale.applySaleImport(data, { rows, mode: 'sum', src: 'mt' }, ctx);
  const batch = data.sales[0].batch;
  sale.applySaleBatchVoid(data, { batch }, ctx);
  sale.applySaleImport(data, { rows, mode: 'sum', src: 'mt' }, ctx);
  assert.strictEqual(data.sales.length, 2); // 旧作废 + 新导入
  assert.strictEqual(data.sales.filter((s) => s.status === '已作废').length, 1);
});

ok('sale.amt_recalc：按指定口径重算金额（只改金额不改明细）', () => {
  const data = freshData();
  sale.applySaleImport(data, { rows, mode: 'sum', src: 'mt' }, ctx);
  const s = data.sales[0];
  s.srcAmt = { list: 80, paid: 80, net: null, fee: 8, promo: null };
  const msg = sale.applySaleAmtRecalc(data, { batch: s.batch, mode: 'D' }, ctx);
  assert.strictEqual(s.amount, 80);
  assert.strictEqual(s.receivable, 72); // 80 - 8 平台费
  assert.strictEqual(s.amtMode, 'D');
  assert.ok(/重算 1 张/.test(msg));
});

ok('sale.alias_set / sale.alias_delete：映射增删', () => {
  const data = freshData();
  const msg = sale.applyDishAliasSet(data, { name: '美团·水饺', dish: 'D1', mul: 2 }, ctx);
  assert.deepStrictEqual(data.dishAlias['美团·水饺'], { dish: 'D1', mul: 2 });
  assert.ok(/映射已保存/.test(msg));
  sale.applyDishAliasDelete(data, { name: '美团·水饺' }, ctx);
  assert.ok(!('美团·水饺' in data.dishAlias));
});

console.log('\nOK ' + pass + ' sale_import executor tests passed');
