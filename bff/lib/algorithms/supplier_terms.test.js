'use strict';
/*
 * Phase 2 供应商类目受控词表回归（零依赖，node 直跑）
 *
 * 守的七件事：
 *   ① 内核 scalar 选项：单选标量写 vendor.category（不写数组）、空值清字段、单值展开兼容；
 *   ② 供应商词表适配层：S 前缀 / 「供应商类目」维度 / 别名归一 / 未命中落「其他」（matched=false）；
 *   ③ supplier_term.upsert：新建 S 前缀 + pending，上架前不可被供应商选用；
 *   ④ vendor.attr_set：单选受控写标量、别名归一、未命中留痕归「其他」、清空、找不到档案抛错；
 *   ⑤ 存量归一 vendor_term.backfill：自由文本 → 词条 ID，幂等（二次执行 0 更新）；
 *   ⑥ 读侧口径：upsertVendor 落词条 ID、档案/看板回显标准名、全局检索按标准名与别名均能命中；
 *   ⑦ 三向合并：vendor_terms 按词条 id 合并，冲突路径不丢词条。
 *
 * 运行：node lib/algorithms/supplier_terms.test.js
 */
const assert = require('assert');
const core = require('../terms_core');
const supTerms = require('../supplier_terms');
const termsAlgo = require('./terms');
const inv = require('./inventory');
const supply = require('../supply');
const search = require('../search');
const merge = require('../../store-node/merge');
const { executeAction, makeExtStore } = require('./execute');

let failed = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '  ' + (e && e.message ? e.message : e)); }
}

/* ---------- ① 内核 scalar：单选标量 ---------- */
ok('applyTags(scalar:true) 写标量字符串而非数组', () => {
  const v = {};
  const terms = supTerms.seedTerms();
  const r = core.applyTags(v, ['S001'], terms, {
    mode: 'single', allowCustom: false, scalar: true, field: 'category', config: supTerms.SUP_CONFIG,
  });
  assert.strictEqual(v.category, 'S001', 'vendor.category 应为标量词条 ID');
  assert.ok(!Array.isArray(v.category), '不得写成数组');
  assert.deepStrictEqual(r.ids, ['S001']);

  core.applyTags(v, [], terms, {
    mode: 'single', allowCustom: false, scalar: true, field: 'category', config: supTerms.SUP_CONFIG,
  });
  assert.strictEqual('category' in v, false, '清空后删除字段');
});

ok('scalar 仍守单选上限 / 未上架不选 / 禁自定义', () => {
  const terms = supTerms.seedTerms();
  const opt = { mode: 'single', allowCustom: false, scalar: true, field: 'category', config: supTerms.SUP_CONFIG };
  assert.throws(() => core.applyTags({}, ['S001', 'S002'], terms, opt), /单选领域只能关联/);
  assert.throws(() => core.applyTags({}, ['S999'], terms, opt), /不存在的词条/);
  assert.throws(() => core.applyTags({}, ['夏季清仓'], terms, opt), /不允许自定义标签/);
});

ok('flattenOne / flattenTags 兼容单值入参', () => {
  const terms = supTerms.seedTerms();
  const one = core.flattenOne('S001', terms, supTerms.SUP_CONFIG);
  assert.strictEqual(one.name, '食材');
  assert.strictEqual(one.isTerm, true);
  assert.strictEqual(core.flattenOne('', terms, supTerms.SUP_CONFIG), null, '空值返回 null');
  assert.strictEqual(core.flattenTags('S003', terms, supTerms.SUP_CONFIG).length, 1, '单值也按 1 项展开');
});

/* ---------- ② 词表适配层：种子 / 别名 / 兜底 ---------- */
ok('种子词条 S001-S005 齐全且全部上架', () => {
  const seeds = supTerms.seedTerms();
  assert.deepStrictEqual(seeds.map((t) => t.id), ['S001', 'S002', 'S003', 'S004', 'S005']);
  assert.ok(seeds.every((t) => t.status === 'active'));
  assert.ok(seeds.every((t) => t.category === '供应商类目'));
  assert.deepStrictEqual(supTerms.termsOf({}), seeds, 'data.vendor_terms 缺失回退 seed');
});

ok('resolveCategory：ID / 标准名 / 别名归一，未命中落「其他」', () => {
  const terms = supTerms.seedTerms();
  assert.deepStrictEqual(supTerms.resolveCategory('S003', terms), { id: 'S003', name: '酒水', matched: true, input: 'S003' });
  assert.strictEqual(supTerms.resolveCategory('冷链', terms).id, 'S001');
  assert.strictEqual(supTerms.resolveCategory('食材', terms).id, 'S001');
  assert.strictEqual(supTerms.resolveCategory('未分类', terms).id, 'S005');
  const miss = supTerms.resolveCategory('来路不明的类目', terms);
  assert.strictEqual(miss.id, 'S005', '未命中落兜底');
  assert.strictEqual(miss.matched, false, '未命中标记 matched=false（供回执留痕）');
  assert.strictEqual(supTerms.resolveCategory('', terms).id, null, '空值表示清空，不落兜底');
  assert.strictEqual(supTerms.resolveCategory('S999', terms).id, 'S005', '已删词条 ID 同样落兜底');
});

ok('categoryLabel：词条回标准名，未命中原样回显', () => {
  const terms = supTerms.seedTerms();
  assert.strictEqual(supTerms.categoryLabel('S001', terms), '食材');
  assert.strictEqual(supTerms.categoryLabel('冷链', terms), '食材');
  assert.strictEqual(supTerms.categoryLabel('老类目', terms), '老类目');
});

/* ---------- ③ supplier_term.upsert ---------- */
ok('supplier_term.upsert：S 前缀 + 待审核 + 白名单校验', () => {
  const data = { vendors: [] };
  const msg = termsAlgo.applyVendorTermUpsert(data, { name: '半成品', aliases: ['预制菜'] });
  assert.ok(/词条新建/.test(msg), msg);
  assert.strictEqual(data.vendor_terms.length, 6, 'seed 5 条 + 新建 1 条');
  const row = data.vendor_terms.find((t) => t.name === '半成品');
  assert.strictEqual(row.id, 'S6', 'S 前缀连续递增');
  assert.strictEqual(row.status, 'pending', '新建默认待审核');
  assert.deepStrictEqual(row.aliases, ['预制菜']);
  assert.throws(() => termsAlgo.applyVendorTermUpsert(data, { name: '半成品' }), /词条已存在/);
  assert.throws(() => termsAlgo.applyVendorTermUpsert(data, { name: '产地词', category: '产地' }), /不在受控维度白名单/);
});

ok('未上架词条不可被供应商选用，审核上架后可用', () => {
  const data = { vendors: [{ vendor_id: 'V1', name: '甲', category: 'S001' }] };
  termsAlgo.applyVendorTermUpsert(data, { name: '半成品' });
  assert.throws(() => termsAlgo.applyVendorAttrSet(data, { vendor_id: 'V1', category: '半成品' }), /未上架/);
  termsAlgo.applyVendorTermUpsert(data, { id: 'S6', status: 'active' });
  const msg = termsAlgo.applyVendorAttrSet(data, { vendor_id: 'V1', category: '半成品' });
  assert.ok(/S6/.test(msg), msg);
  assert.strictEqual(data.vendors[0].category, 'S6');
});

/* ---------- ④ vendor.attr_set（旧口径 data.vendors） ---------- */
ok('vendor.attr_set：别名归一写标量 / 未命中归其他留痕 / 清空 / 找不到抛错', () => {
  const data = {
    vendors: [
      { vendor_id: 'V1', name: '甲供应商', category: '冷链' },
      { vendor_id: 'V2', name: '乙供应商' },
    ],
  };
  let msg = termsAlgo.applyVendorAttrSet(data, { vendor_id: 'V1', category: '酒水' });
  assert.strictEqual(data.vendors[0].category, 'S003', '标准名归一为词条 ID 标量');
  assert.ok(/酒水/.test(msg), msg);
  assert.ok(data.vendors[0]._u, '写 _u 供三向合并比时间戳');

  msg = termsAlgo.applyVendorAttrSet(data, { vendor_id: 'V2', category: '野生类目' });
  assert.strictEqual(data.vendors[1].category, 'S005', '未命中归入「其他」');
  assert.ok(/未匹配词条已归入「其他」/.test(msg), msg);

  msg = termsAlgo.applyVendorAttrSet(data, { vendor_id: 'V1', category: '' });
  assert.strictEqual('category' in data.vendors[0], false, '空串清空类目');
  assert.ok(/已清空/.test(msg), msg);

  assert.throws(() => termsAlgo.applyVendorAttrSet(data, { vendor_id: 'V404', category: '食材' }), /未找到供应商/);
});

/* ---------- ④b vendor.attr_set（新表口径 ext.sup_vendors，端到端） ---------- */
ok('vendor.attr_set 走 executeAction + ext.sup_vendors 就地更新并落 vendor_terms', () => {
  const snap = {
    rev: 12,
    data: { suppliers: ['金丰冷链配送'] },
    ext: { sup_vendors: [{ vendor_id: 'V673E3D26', name: '金丰冷链配送', category: '冷链' }] },
  };
  const r = executeAction(snap, {
    type: 'vendor.attr_set', trace_id: 't-vcat',
    payload: { vendor_id: 'V673E3D26', category: '食材' },
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.snapshot.ext.sup_vendors[0].category, 'S001');
  assert.strictEqual(r.snapshot.ext.sup_vendors.length, 1, '不得多出重复行');
  assert.strictEqual(r.snapshot.data.vendor_terms.length, 5, '首次写入以 seed 初始化词表');
});

ok('supplier_term.upsert / vendor_term.backfill 已登记进执行器', () => {
  const snap = { rev: 1, data: { vendors: [] }, ext: {} };
  const a = executeAction(snap, { type: 'supplier_term.upsert', payload: { name: '半成品' } });
  assert.strictEqual(a.ok, true, a.error);
  assert.strictEqual(a.snapshot.data.vendor_terms.length, 6);

  const b = executeAction(
    { rev: 2, data: { vendors: [{ vendor_id: 'V1', name: '甲', category: '冷链' }] }, ext: {} },
    { type: 'vendor_term.backfill', payload: {} },
  );
  assert.strictEqual(b.ok, true, b.error);
  assert.strictEqual(b.snapshot.data.vendors[0].category, 'S001');
});

/* ---------- ⑤ 存量归一 backfill（幂等） ---------- */
ok('vendor_term.backfill：自由文本归一为词条 ID，二次执行 0 更新', () => {
  const data = {
    vendors: [
      { vendor_id: 'V1', name: '甲', category: '冷链' },
      { vendor_id: 'V2', name: '乙', category: '说不清的类目' },
      { vendor_id: 'V3', name: '丙' },
      { vendor_id: 'V4', name: '丁', category: 'S002' },
    ],
  };
  const msg = termsAlgo.applyVendorTermBackfill(data);
  assert.strictEqual(data.vendors[0].category, 'S001');
  assert.strictEqual(data.vendors[1].category, 'S005', '未匹配归入「其他」');
  assert.strictEqual('category' in data.vendors[2], false, '空值不动');
  assert.strictEqual(data.vendors[3].category, 'S002', '已归一不动');
  assert.ok(/更新 2 家/.test(msg) && /其他」1 家/.test(msg), msg);

  const again = termsAlgo.applyVendorTermBackfill(data);
  assert.ok(/更新 0 家/.test(again), again);
  assert.strictEqual(data.vendor_terms.length, 5, '归一同时落词表 seed');
});

/* ---------- ⑥ 读侧口径 ---------- */
ok('upsertVendor 落词条 ID，档案回显标准名 + category_id', () => {
  const data = { vendors: [], suppliers: [], ings: [], orders: [], recv: [] };
  inv.upsertVendor(data, { name: '丙供应商', category: '冷链' }, { store: makeExtStore({}) });
  assert.strictEqual(data.vendors[0].category, 'S001', '写入即归一为词条 ID');

  const rep = supply.vendorsReport({}, data, null);
  assert.strictEqual(rep.rows[0].category, '食材', '展示回标准名');
  assert.strictEqual(rep.rows[0].category_id, 'S001');
  assert.strictEqual(rep.by_category['食材'], 1, '归集按标准名');

  /* 未命中的存量自由文本：原样回显，不被静默改写 */
  const legacy = { vendors: [{ vendor_id: 'V9', name: '老档案', category: '老类目' }] };
  const rep2 = supply.vendorsReport({}, legacy, null);
  assert.strictEqual(rep2.rows[0].category, '老类目');
  assert.strictEqual(rep2.rows[0].category_id, null);
});

ok('upsertVendor 空类目保持空（不误落「其他」）', () => {
  const data = { vendors: [], suppliers: [], ings: [], orders: [], recv: [] };
  inv.upsertVendor(data, { name: '丁供应商' }, { store: makeExtStore({}) });
  assert.strictEqual(data.vendors[0].category, undefined);
});

ok('全局检索按标准名与别名都能命中供应商', () => {
  const data = { vendors: [{ vendor_id: 'V1', name: '金丰冷链配送', category: 'S001' }] };
  const byName = search.searchDomain('procurement', '食材', {}, data);
  assert.ok(byName.hits.some((h) => h.title === '金丰冷链配送'), JSON.stringify(byName.hits));
  const byAlias = search.searchDomain('procurement', '冷链', {}, data);
  assert.ok(byAlias.hits.some((h) => h.title === '金丰冷链配送'), '别名仍可检索（category_kw）');
});

/* ---------- ⑦ 三向合并 ---------- */
ok('merge COLL_KEY 纳入 vendor_terms 且按词条 id 合并', () => {
  assert.strictEqual(merge.COLL_KEY.vendor_terms, 'id');
  const [out] = merge.merge(
    { vendor_terms: [{ id: 'S001', name: '食材', _u: 't1' }] },
    { vendor_terms: [{ id: 'S001', name: '食材', _u: 't1' }, { id: 'S6', name: '半成品', status: 'pending', _u: 't2' }] },
    { vendor_terms: [{ id: 'S001', name: '食材', _u: 't1' }] },
  );
  assert.strictEqual(out.vendor_terms.length, 2, '本机新增词条不被冲突路径丢弃');
  assert.ok(out.vendor_terms.some((t) => t.id === 'S6'));
});

/* ---------- 路由：只读词表端点 ---------- */
const supplyRoute = require('../../routes/supply');
function routeCtx() {
  return {
    auth: { role: '老板', account: 'u1' },
    traceId: 't-route',
    sendJSON: (res, code, obj) => { res.code = code; res.body = obj; },
  };
}

ok('GET /api/supply/vendor-terms 返回受控词表（只读）', () => {
  const res = {};
  const took = supplyRoute.handle({ method: 'GET' }, res, routeCtx(), '/api/supply/vendor-terms');
  assert.strictEqual(took, true, '本路由应接管');
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.scope, 'supplier');
  assert.deepStrictEqual(res.body.categories, ['供应商类目']);
  assert.ok(res.body.terms.length >= 5);
  assert.strictEqual(res.body.fallback_id, 'S005');
  assert.ok(['data', 'seed'].indexOf(res.body.source) >= 0, res.body.source);
});

if (failed) { console.error('\n✗ ' + failed + ' 项失败'); process.exit(1); }
console.log('\nPASS supplier_terms.test.js 全部通过');
