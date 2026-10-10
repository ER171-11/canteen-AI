'use strict';
/*
 * lib/price.test.js — 原料比价只读聚合的纯函数回归（零依赖，node 直跑）
 *
 * 覆盖 lib/price.js（FP-PRICE-01/02/03/13/14）：
 *   · quotePerStock：per='buy' 按 conv 折算 / per='stock' 原样
 *   · bestQuote：按折后单位价取最小
 *   · quoteKeyword：去规格/容量后缀
 *   · priceReport：在售过滤、本店均价、最低折价、差价、节省%、统计
 *   · pricePlan：待比价清单（关键词/换算/均价/状态）
 *
 * 运行：node lib/price.test.js
 */
const assert = require('assert');
const price = require('./price');

let failed = 0;
function ok(name, cond, got) {
  if (cond) { console.log('  ✓ ' + name); return; }
  failed++;
  console.error('  ✗ ' + name + '  got=' + JSON.stringify(got));
}

const ings = [
  { id: 'i1', name: '五花肉', cat: '鲜肉', buy: '斤', spec: '', conv: 1, unit: '斤', avg: 18.5, on: true },
  { id: 'i2', name: '黄瓜（本地）500g', cat: '蔬菜', buy: '份', spec: '500g/份', conv: 2, unit: '斤', avg: 3, on: true },
  { id: 'i3', name: '停售香料', cat: '调料', buy: '袋', conv: 1, unit: '袋', avg: 5, on: false },
  { id: 'i4', name: '酱油', cat: '调料', buy: '瓶', conv: 1, unit: '瓶', avg: 8, on: true },
];
const quotes = [
  { id: 'Q1', ing: 'i1', src: '1688', price: 17, per: 'buy', date: '2026-10-08', note: '' },
  { id: 'Q2', ing: 'i1', src: '京东', price: 19, per: 'buy', date: '2026-10-09', note: '含运' },
  { id: 'Q3', ing: 'i2', src: '批发商', price: 4, per: 'buy', date: '2026-10-09', note: '' },
];
const SNAP = { data: { ings, quotes } };

/* ---- quotePerStock 折算 ---- */
ok('quotePerStock per=buy conv=1 → 原价', price.quotePerStock({ price: 17, per: 'buy' }, { conv: 1 }) === 17, price.quotePerStock({ price: 17, per: 'buy' }, { conv: 1 }));
ok('quotePerStock per=buy conv=2 → 4/2=2', price.quotePerStock({ price: 4, per: 'buy' }, { conv: 2 }) === 2, price.quotePerStock({ price: 4, per: 'buy' }, { conv: 2 }));
ok('quotePerStock per=stock → 原价不折算', price.quotePerStock({ price: 2.5, per: 'stock' }, { conv: 2 }) === 2.5, price.quotePerStock({ price: 2.5, per: 'stock' }, { conv: 2 }));

/* ---- bestQuote 最低价 ---- */
const b1 = price.bestQuote(ings[0], quotes);
ok('bestQuote i1 取最低 17（1688）', b1 && b1.unit === 17 && b1.q.src === '1688', b1);
ok('bestQuote i4 无报价 → null', price.bestQuote(ings[3], quotes) === null, price.bestQuote(ings[3], quotes));

/* ---- quoteKeyword 关键词净化 ---- */
ok('quoteKeyword 去括号+容量后缀', price.quoteKeyword(ings[1]) === '黄瓜', price.quoteKeyword(ings[1]));
ok('quoteKeyword 无后缀原样', price.quoteKeyword(ings[0]) === '五花肉', price.quoteKeyword(ings[0]));

/* ---- priceReport 比价主表 + 统计 ---- */
const rep = price.priceReport(SNAP);
ok('priceReport 在售 3 / 尚无报价 1 / 已有 2', rep.tip.onSale === 3 && rep.tip.noQuote === 1 && rep.tip.hasQuote === 2, rep.tip);
const r1 = rep.rows.find((r) => r.ingId === 'i1');
const r2 = rep.rows.find((r) => r.ingId === 'i2');
const r4 = rep.rows.find((r) => r.ingId === 'i4');
ok('priceReport i1 差价 -1.5（17−18.5）', r1.diff === -1.5, r1.diff);
ok('priceReport i1 节省% = 1.5/18.5', r1.savePct === Math.round(1.5 / 18.5 * 10000) / 100, r1.savePct);
ok('priceReport i2 折价 2（4/conv2），差价 -1', r2.best.unit === 2 && r2.diff === -1, { best: r2.best, diff: r2.diff });
ok('priceReport i4 无报价 diff/savePct 为 null', r4.best === null && r4.diff === null && r4.savePct === null, { best: r4.best, diff: r4.diff });
ok('priceReport 停售 i3 被过滤', !rep.rows.some((r) => r.ingId === 'i3'), rep.rows.map((r) => r.ingId));

/* ---- pricePlan 待比价清单 ---- */
const plan = price.pricePlan(SNAP);
ok('pricePlan 在售 3 项', plan.items.length === 3, plan.items.length);
const p1 = plan.items.find((x) => x.ingId === 'i1');
const p4 = plan.items.find((x) => x.ingId === 'i4');
ok('pricePlan i1 已比价 / 关键词=五花肉', p1.status === '已比价' && p1.keyword === '五花肉', p1);
ok('pricePlan i4 待比价', p4.status === '待比价', p4.status);

/* ---- 空快照安全回退 ---- */
const empty = price.priceReport(null);
ok('priceReport 空快照 → 空 rows / 0 统计', empty.rows.length === 0 && empty.tip.onSale === 0, empty.tip);

if (failed) { console.error('\n✗ ' + failed + ' 项失败'); process.exit(1); }
console.log('\n✓ price.test.js 全部通过');
