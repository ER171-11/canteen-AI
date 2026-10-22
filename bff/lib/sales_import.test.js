'use strict';
/*
 * lib/sales_import.test.js — 平台销售导入「解析层」口径自证。
 * 覆盖：金额口径 A-E、三级菜名匹配、表格/JSON 解析、聚合、幂等键、预览入口。
 * 用法：node bff/lib/sales_import.test.js
 */
const assert = require('assert');
const si = require('./sales_import');

let pass = 0;
function ok(name, fn) { fn(); pass++; console.log('  PASS ' + name); }
function n2(v) { return Math.round(v * 100) / 100; }

const dishes = [
  { id: 'D1', name: '五福饺子', cat: '主食', on: true },
  { id: 'D2', name: '红烧肉', cat: '热菜', on: true },
  { id: 'D3', name: '可乐', cat: '饮品', on: true },
  { id: 'D4', name: '下架菜', cat: '热菜', on: false },
];

/* ---------- 金额口径 A-E ---------- */
ok('口径 A（双全）：sub=实付、receivable=实收', () => {
  const r = si.resolveSaleAmt({ list: 50, paid: 50, net: 45 });
  assert.strictEqual(r.mode, 'A');
  assert.strictEqual(r.sub, 50);
  assert.strictEqual(r.receivable, 45);
  assert.strictEqual(r.discount, 5);
});
ok('口径 B（仅实付）：sub=原价、receivable=实付', () => {
  const r = si.resolveSaleAmt({ list: 60, paid: 50 });
  assert.strictEqual(r.mode, 'B');
  assert.strictEqual(r.sub, 60);
  assert.strictEqual(r.receivable, 50);
});
ok('口径 C（仅实收）：sub 回退实收、receivable=实收', () => {
  const r = si.resolveSaleAmt({ net: 45 });
  assert.strictEqual(r.mode, 'C');
  assert.strictEqual(r.receivable, 45);
});
ok('口径 D（原价+扣费）：sub=原价、receivable=原价-费-优惠', () => {
  const r = si.resolveSaleAmt({ list: 60, fee: 3, promo: 2 });
  assert.strictEqual(r.mode, 'D');
  assert.strictEqual(r.sub, 60);
  assert.strictEqual(r.receivable, 55);
});
ok('口径 E（兜底）：sub=list、receivable=list', () => {
  const r = si.resolveSaleAmt({ list: 60 });
  assert.strictEqual(r.mode, 'E');
  assert.strictEqual(r.receivable, 60);
});
ok('口径缺 rate 时补扣费：fee = 实付×rate%', () => {
  const r = si.resolveSaleAmt({ list: 60, paid: 50, fee: null, promo: null }, null, { rate: 10 });
  assert.strictEqual(r.mode, 'D');
  assert.strictEqual(r.receivable, n2(60 - 5));
});

/* ---------- 三级菜名匹配 ---------- */
ok('匹配①别名：dishAlias 命中（带倍数）', () => {
  const h = si.matchSaleDish('美团·五福水饺', dishes, { '美团·五福水饺': { dish: 'D1', mul: 2 } });
  assert.strictEqual(h.level, '别名');
  assert.strictEqual(h.d.id, 'D1');
  assert.strictEqual(h.mul, 2);
});
ok('匹配②精确：本店菜名一致', () => {
  const h = si.matchSaleDish('红烧肉', dishes, {});
  assert.strictEqual(h.level, '精确');
  assert.strictEqual(h.d.id, 'D2');
});
ok('匹配③归一化：去括号/符号后命中', () => {
  const h = si.matchSaleDish('可乐（听装）', dishes, {});
  assert.strictEqual(h.level, '归一化');
  assert.strictEqual(h.d.id, 'D3');
});
ok('不匹配：下架菜品（on=false）不算', () => {
  assert.strictEqual(si.matchSaleDish('下架菜', dishes, {}), null);
});

/* ---------- 表格 / JSON 解析 ---------- */
ok('parseSaleTable：CSV 解析 + 汇总模式', () => {
  const src = {
    rows: [
      ['菜品名称', '数量', '日期', '用户实付', '商家实收'],
      ['五福饺子', '2', '2026-10-12', '50', '45'],
      ['红烧肉', '1', '2026-10-12', '30', '27'],
      ['合计', '3', '', '', ''],
    ],
  };
  const r = si.parseSaleTable(src);
  assert.strictEqual(r.err, undefined);
  assert.strictEqual(r.rows.length, 2); // 合计行被 NOISE_RE 跳过
  assert.strictEqual(r.mode, 'sum');
});
ok('parseSaleJson：订单号 → 明细模式', () => {
  const r = si.parseSaleJson(JSON.stringify([
    { name: '五福饺子', qty: 2, date: '2026-10-12', orderNo: 'X001', paid: 50, net: 45 },
    { name: '红烧肉', qty: 1, date: '2026-10-12', orderNo: 'X002', paid: 30, net: 27 },
  ]));
  assert.strictEqual(r.err, undefined);
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.mode, 'detail');
});

/* ---------- 聚合 ---------- */
ok('buildSaleDocs：汇总模式按日期聚合、口径 A、金额正确', () => {
  const rows = [
    { dish: '五福饺子', qty: 2, date: '2026-10-12', price: 25, list: 50, paid: 50, net: 45 },
    { dish: '红烧肉', qty: 1, date: '2026-10-12', price: 30, list: 30, paid: 30, net: 27 },
  ];
  const b = si.buildSaleDocs(rows, 'sum', {}, { dishes, dishAlias: {} });
  assert.strictEqual(b.docs.length, 1);
  const d = b.docs[0];
  assert.strictEqual(d.sub, 80);          // 50+30
  assert.strictEqual(d.receivable, 72);   // 45+27
  assert.strictEqual(d.discount, 8);
  assert.strictEqual(d.amtMode, 'A');
});
ok('buildSaleDocs：未匹配菜名跳过并计数（不静默丢弃口径之外）', () => {
  const rows = [
    { dish: '五福饺子', qty: 1, date: '2026-10-12', price: 25, list: 25, paid: 25, net: 22 },
    { dish: '不存在菜', qty: 1, date: '2026-10-12', price: 10, list: 10, paid: 10, net: 9 },
  ];
  const b = si.buildSaleDocs(rows, 'sum', {}, { dishes, dishAlias: {} });
  assert.strictEqual(b.unmapped, 1);
  assert.strictEqual(b.docs.length, 1);
  assert.strictEqual(b.docs[0].receivable, 22);
});
ok('buildSaleDocs：sel 人工映射补齐未匹配菜名', () => {
  const rows = [{ dish: '不存在菜', qty: 2, date: '2026-10-12', price: 10, list: 20, paid: 20, net: 18 }];
  const b = si.buildSaleDocs(rows, 'sum', { '不存在菜': 'D1' }, { dishes, dishAlias: {} });
  assert.strictEqual(b.unmapped, 0);
  assert.strictEqual(b.docs.length, 1);
  assert.strictEqual(b.docs[0].lines[0].dish, 'D1');
});

/* ---------- 幂等键 ---------- */
ok('saleDupKeys：作废单不占幂等键（撤回后可重导）', () => {
  const sales = [
    { src: 'mt', srcNo: 'X001', date: '2026-10-12' },
    { src: 'mt', srcNo: 'X002', date: '2026-10-12', status: '已作废' },
  ];
  const keys = si.saleDupKeys(sales, 'mt');
  assert.ok(keys.has('mt|X001'));
  assert.ok(!keys.has('mt|X002'));
});

/* ---------- 预览入口（CSV 全链路） ---------- */
ok('previewSaleImport：CSV → 预览（含未匹配清单）', () => {
  const csv = '菜品名称,数量,日期,用户实付,商家实收\n五福饺子,2,2026-10-12,50,45\n红烧肉,1,2026-10-12,30,27\n';
  const out = si.previewSaleImport({ fileName: 's.csv', contentBase64: Buffer.from(csv).toString('base64') }, dishes, {});
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.totalDocs, 1);
  assert.strictEqual(out.totalReceivable, 72);
  assert.strictEqual(out.unmatched.length, 0);
});

console.log('\nOK ' + pass + ' sales_import tests passed');
