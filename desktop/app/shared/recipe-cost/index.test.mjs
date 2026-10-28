import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcLineCost,
  unitToBase,
  packInBase,
  ingDim,
  ingBaseInfo,
  inferBaseUnit,
  DIM_OF_UNIT,
} from './index.mjs';

// 盐 500g/袋，均价 5 元/袋，出成率 1
const salt = { name: '雪天精制盐500g', unit: '袋', base_unit: 'g', pack_in_base: 500, avg: 5, yld: 1 };
// 生抽 1.9L/桶，均价 12 元/桶
const soy = { name: '海天金标生抽1.9L', unit: '桶', base_unit: 'ml', pack_in_base: 1900, avg: 12, yld: 1 };

test('unitToBase 维度系数', () => {
  assert.equal(unitToBase('weight', 'g'), 1);
  assert.equal(unitToBase('weight', 'kg'), 1000);
  assert.equal(unitToBase('weight', '斤'), 500);
  assert.equal(unitToBase('volume', 'l'), 1000);
  assert.equal(unitToBase('count', '个'), 1);
  assert.equal(unitToBase('weight', '不存在'), null);
});

test('ingBaseInfo / packInBase / ingDim', () => {
  assert.deepEqual(ingBaseInfo(salt), { dim: 'weight', amount: 500 });
  assert.deepEqual(ingBaseInfo(soy), { dim: 'volume', amount: 1900 });
  assert.equal(packInBase(salt), 500);
  assert.equal(ingDim(soy), 'volume');
});

test('calcLineCost 维度兼容：重量按 g 填写', () => {
  const r = calcLineCost(18, salt, 'g');
  assert.equal(r.dimMismatch, false);
  assert.equal(r.gross, 18);
  assert.ok(Math.abs(r.lineCost - 0.18) < 1e-9); // 18/500*5
});

test('calcLineCost 维度兼容：体积按 ml 填写', () => {
  const r = calcLineCost(18, soy, 'ml');
  assert.equal(r.dimMismatch, false);
  assert.ok(Math.abs(r.lineCost - 0.113684) < 1e-5); // 18/1900*12
});

test('calcLineCost 维度不兼容：体积原料按 g 填写 → 标红留空', () => {
  const r = calcLineCost(18, soy, 'g');
  assert.equal(r.lineCost, null);
  assert.equal(r.dimMismatch, true);
});

test('calcLineCost 不传 unit：旧行为零回归', () => {
  const r = calcLineCost(18, salt); // 旧口径 qty 视为基础单位量
  assert.equal(r.dimMismatch, undefined);
  assert.ok(Math.abs(r.lineCost - 0.18) < 1e-9);
});

test('calcLineCost 出成率放大毛料', () => {
  const r = calcLineCost(18, { ...salt, yld: 0.5 }, 'g');
  assert.ok(Math.abs(r.lineCost - 0.36) < 1e-9); // 18/0.5/500*5
  assert.equal(r.gross, 36);
});

test('inferBaseUnit 从名称推导（兜底旧数据）', () => {
  assert.deepEqual(inferBaseUnit({ name: '海天金标生抽1.9L' }), { base_unit: 'ml', pack_in_base: 1900 });
  assert.deepEqual(inferBaseUnit({ name: '雪天精制盐500g' }), { base_unit: 'g', pack_in_base: 500 });
  assert.deepEqual(inferBaseUnit({ name: '未知原料' }), { base_unit: undefined, pack_in_base: undefined });
});

test('DIM_OF_UNIT 覆盖常见单位', () => {
  assert.equal(DIM_OF_UNIT['kg'], 'weight');
  assert.equal(DIM_OF_UNIT['L'], 'volume');
  assert.equal(DIM_OF_UNIT['个'], 'count');
});
