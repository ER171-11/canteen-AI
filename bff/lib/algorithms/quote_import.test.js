'use strict';
/*
 * quote.import 回归（W2-04 / FP-PRICE-12 批量导入比价结果；ADR-013 D2）。
 * 守的五件事（纯计算，零写库）：
 *   ① 同原料不同价的报价**并存**（append 模式按 ing+src+price 去重追加，不覆盖）；
 *   ② 完全相同的行（同 ing+src+price+date）被跳过并计数；
 *   ③ 红线：conv ≠ 1 的原料默认跳过，不自动推断跨单位价格；
 *   ④ 缺 ing/src 或 price 非法的行归类为 invalid（显式报错，不静默吞）；
 *   ⑤ run 与 preview 口径一致：preview 判 append 的行，run 后实际落库条数一致（只写 data.quotes）。
 *
 * 运行：node bff/lib/algorithms/quote_import.test.js
 */
const assert = require('assert');
const qimp = require('../quote_import');

let failed = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '  ' + (e && e.message ? e.message : e)); }
}

function fixture() {
  // 原料 I1（采购单位=库存单位，conv=1，可导入）、I2（conv=2，跨单位，应跳过）
  return {
    ings: [
      { id: 'I1', name: '五花肉', conv: 1 },
      { id: 'I2', name: '冻虾', conv: 2 },
    ],
    quotes: [
      { id: 'Q200', ing: 'I1', src: '甲供应商', price: 18, per: 'buy', date: '2026-10-01' },
    ],
  };
}

/* ① 同原料不同供应商/不同价 → 并存 */
ok('同原料不同价并存（甲 18 / 乙 17.5 都落库）', () => {
  const d = fixture();
  const r = qimp.runQuoteImport(d, [
    { ing: 'I1', src: '甲供应商', price: 18 },
    { ing: 'I1', src: '乙供应商', price: 17.5 },
  ]);
  assert.strictEqual(r.appended, 2, '应追加 2 条');
  assert.strictEqual(d.quotes.length, 3);
});

/* ② 完全相同行被跳过并计数 */
ok('完全相同行（同 ing+src+price+date）跳过且计数', () => {
  const d = fixture(); // 已有 Q200: I1@甲 18
  const r = qimp.runQuoteImport(d, [{ ing: 'I1', src: '甲供应商', price: 18, date: '2026-10-01' }]);
  assert.strictEqual(r.appended, 0);
  assert.strictEqual(r.skipped, 1, '重复应计为跳过');
  assert.strictEqual(d.quotes.length, 1, '不应新增');
});

ok('本批内重复（两条完全一样）只落一条', () => {
  const d = fixture();
  const r = qimp.runQuoteImport(d, [
    { ing: 'I1', src: '丙供应商', price: 20 },
    { ing: 'I1', src: '丙供应商', price: 20 },
  ]);
  assert.strictEqual(r.appended, 1);
  assert.strictEqual(r.skipped, 1);
});

/* ③ conv ≠ 1 跳过 */
ok('conv≠1 的原料默认跳过（不自动推断跨单位价格）', () => {
  const d = fixture();
  const r = qimp.runQuoteImport(d, [{ ing: 'I2', src: '海供应商', price: 50 }]);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(r.appended, 0);
  assert.strictEqual(d.quotes.length, 1, 'I2 的报价不应入库');
});

/* ④ 非法行 → invalid */
ok('缺 ing/src → invalid', () => {
  const d = fixture();
  const r = qimp.runQuoteImport(d, [{ src: '甲供应商', price: 10 }]);
  assert.strictEqual(r.invalid, 1);
  assert.strictEqual(r.appended, 0);
});
ok('price 非法 → invalid', () => {
  const d = fixture();
  const r = qimp.runQuoteImport(d, [{ ing: 'I1', src: '甲供应商', price: 'abc' }]);
  assert.strictEqual(r.invalid, 1);
});

/* ⑤ preview 与 run 口径一致 */
ok('preview 的 append 计数 == run 后实际落库条数', () => {
  const d = fixture();
  const items = [
    { ing: 'I1', src: '乙供应商', price: 17.5 },     // append
    { ing: 'I1', src: '甲供应商', price: 18, date: '2026-10-01' }, // 重复 → skip
    { ing: 'I2', src: '海供应商', price: 50 },       // conv≠1 → skip
    { ing: 'I1', src: '丙供应商', price: 'x' },       // invalid
  ];
  const pre = qimp.previewQuoteImport(d, items);
  assert.strictEqual(pre.append, 1);
  assert.strictEqual(pre.skipped, 2);
  assert.strictEqual(pre.invalid, 1);
  const before = d.quotes.length;
  const run = qimp.runQuoteImport(d, items);
  assert.strictEqual(run.appended, pre.append, 'append 数应一致');
  assert.strictEqual(d.quotes.length, before + pre.append, '落库条数 = preview.append');
});

/* 注册表收口：quote.import 已登记（双份 registry 由 sync-assets 保证一致） */
ok('quote.import 已登记进算法注册表', () => {
  const algo = require('./index');
  require('./registry');
  assert.strictEqual(algo.has('quote.import'), true);
  const r = algo.run('quote.import', {}, fixture(), { items: [{ ing: 'I1', src: '乙供应商', price: 17.5 }] });
  assert.strictEqual(r.handled, true);
});

console.log(failed
  ? '== quote.import 测试失败 ' + failed + ' 项 =='
  : 'PASS quote.import 全部通过（W2-04 / FP-PRICE-12，ADR-013 D2）');
process.exit(failed ? 1 : 0);
