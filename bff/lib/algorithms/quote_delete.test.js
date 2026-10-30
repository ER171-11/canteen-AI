'use strict';
/*
 * quote.delete 回归（W2-02 / FP-PRICE-07 删除单条报价；零依赖，node 直跑）
 *
 * 守的五件事：
 *   ① 按 id 命中：只摘该行，其余报价（同原料不同供应商）原样保留；
 *   ② 按 ing+src 命中：与 quote.upsert 幂等键同口径，历史「按原料名录入」的行也能删（就地归一）；
 *   ③ 红线 #6 不物理删别的东西：ings / logs / recv / orders 一律不动；
 *   ④ 红线 #7 不静默降级：零命中、缺参、data.quotes 非数组一律显式抛错；
 *   ⑤ 注册表收口：quote.delete 已登记（双份 registry 由 sync-assets 保证一致）。
 *
 * 运行：node bff/lib/algorithms/quote_delete.test.js
 */
const assert = require('assert');
const inv = require('./inventory');
const algo = require('./index');
require('./registry');

let failed = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '  ' + (e && e.message ? e.message : e)); }
}

function fixture() {
  return {
    ings: [
      { id: 'I1', name: '五花肉', stock: 8, avg: 18.5, on: true },
      { id: 'I2', name: '黄瓜', stock: 3, avg: 3, on: true },
    ],
    quotes: [
      { id: 'Q200', ing: 'I1', name: '五花肉', src: '甲供应商', price: 18, per: 'buy', date: '2026-10-01' },
      { id: 'Q201', ing: 'I1', name: '五花肉', src: '乙供应商', price: 17.5, per: 'buy', date: '2026-10-02' },
      /* 历史「按名录入」：q.ing 存的是原料名而非 id */
      { id: 'Q202', ing: '黄瓜', name: '黄瓜', src: '丙供应商', price: 2.8, per: 'buy', date: '2026-10-03' },
    ],
    logs: [{ id: 'L1', ing: 'I1', qty: 1 }],
    recv: [{ id: 'R1', supplier: '甲供应商', amount: 100 }],
    orders: [{ id: 'PO1', sup: '甲供应商', lines: [{ ing: 'I1', qty: 5 }] }],
  };
}

/* ① 按 id 删：只摘一行，同原料他供应商保留 */
ok('按 id 删除：只摘目标行，同原料其他供应商报价保留', () => {
  const d = fixture();
  const msg = inv.applyQuoteDelete(d, { id: 'Q200' });
  assert.strictEqual(d.quotes.length, 2);
  assert.deepStrictEqual(d.quotes.map((q) => q.id), ['Q201', 'Q202']);
  assert.ok(/Q200/.test(msg) && /甲供应商/.test(msg), msg);
});

/* ② 按 ing+src 删：幂等键同口径 */
ok('按 ing+src 删除命中', () => {
  const d = fixture();
  inv.applyQuoteDelete(d, { ing: 'I1', src: '乙供应商' });
  assert.deepStrictEqual(d.quotes.map((q) => q.id), ['Q200', 'Q202']);
});

ok('按 ing+src 删除：原料名进来也能删（历史按名录入的行）', () => {
  const d = fixture();
  const before = d.quotes.length;
  inv.applyQuoteDelete(d, { ing: '黄瓜', src: '丙供应商' });
  assert.strictEqual(d.quotes.length, before - 1);
  assert.deepStrictEqual(d.quotes.map((q) => q.id), ['Q200', 'Q201']);
});

ok('ing_id / supplier 别名入参同样生效', () => {
  const d = fixture();
  inv.applyQuoteDelete(d, { ing_id: 'I1', supplier: '甲供应商' });
  assert.deepStrictEqual(d.quotes.map((q) => q.id), ['Q201', 'Q202']);
});

/* ③ 红线 #6：不动物料主数据与流水/单据 */
ok('红线：只删报价行，ings / logs / recv / orders 原样', () => {
  const d = fixture();
  const keep = {
    ings: JSON.stringify(d.ings),
    logs: JSON.stringify(d.logs),
    recv: JSON.stringify(d.recv),
    orders: JSON.stringify(d.orders),
  };
  inv.applyQuoteDelete(d, { id: 'Q201' });
  assert.strictEqual(JSON.stringify(d.ings), keep.ings);
  assert.strictEqual(JSON.stringify(d.logs), keep.logs);
  assert.strictEqual(JSON.stringify(d.recv), keep.recv);
  assert.strictEqual(JSON.stringify(d.orders), keep.orders);
});

/* ④ 红线 #7：显式报错，不静默成功 */
ok('零命中（id 不存在）抛错', () => {
  assert.throws(() => inv.applyQuoteDelete(fixture(), { id: 'Q999' }), /未命中/);
});

ok('零命中（ing+src 不存在）抛错', () => {
  assert.throws(() => inv.applyQuoteDelete(fixture(), { ing: 'I1', src: '不存在供应商' }), /未命中/);
});

ok('缺参（既无 id 也无 ing+src）抛错', () => {
  assert.throws(() => inv.applyQuoteDelete(fixture(), {}), /需要 id，或 ing \+ src/);
  assert.throws(() => inv.applyQuoteDelete(fixture(), { ing: 'I1' }), /需要 id，或 ing \+ src/);
});

ok('data.quotes 非数组抛错', () => {
  assert.throws(() => inv.applyQuoteDelete({ quotes: {} }, { id: 'Q1' }), /不是数组/);
});

ok('删除后同一 ing+src 可再录入（幂等键不被残留占用）', () => {
  const d = fixture();
  inv.applyQuoteDelete(d, { ing: 'I1', src: '甲供应商' });
  inv.applyQuoteUpsert(d, { ing: 'I1', name: '五花肉', src: '甲供应商', price: 19.2, per: 'buy' });
  const hit = d.quotes.filter((q) => q.ing === 'I1' && q.src === '甲供应商');
  assert.strictEqual(hit.length, 1, '应只有一条（新增而非替换别人的行）');
  assert.strictEqual(hit[0].price, 19.2);
});

/* ⑤ 注册表 */
ok('quote.delete 已登记进算法注册表', () => {
  assert.strictEqual(algo.has('quote.delete'), true);
  const r = algo.run('quote.delete', {}, fixture(), { id: 'Q200' });
  assert.strictEqual(r.handled, true);
});

console.log(failed
  ? '== quote.delete 测试失败 ' + failed + ' 项 =='
  : 'PASS quote.delete 全部通过（W2-02 / FP-PRICE-07）');
process.exit(failed ? 1 : 0);
