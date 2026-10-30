'use strict';
/*
 * lib/recipe_cost.test.js — W6 中间材料（半成品）递归展开回归（零依赖，node 直跑）
 *
 * 覆盖 lib/recipe_cost.js：
 *   · 配方引用「料水」等中间材料（type='semi'）→ 递归展开到原料、成本正确
 *   · 引用量缩放：料水 200g / 100g 按「一批出成_g」等比缩放到香料克重
 *   · 防环：料水 BOM 里再引「料水」不无限递归、不报 missing
 *   · 嵌套中间材料：半成品引半成品逐层展开
 *   · 兼容：无中间材料库时「料水/清水」仍按旧口径跳过（SKIP_NAMES 可选中间材料语义）
 *
 * 运行：node lib/recipe_cost.test.js
 */
const assert = require('assert');
const { buildCostCard, collectSemiIndex, semiBaseGrams } = require('./recipe_cost');
const core = require('../../shared/recipe-cost/index.cjs');

let failed = 0;
function ok(name, cond, got) {
  if (cond) { console.log('  ✓ ' + name); return; }
  failed++;
  console.error('  ✗ ' + name + '  got=' + JSON.stringify(got));
}

/* 桌面端兼容闸门：Electron 31 内置 Node 20.18 不支持 require(ESM)。
   shared/recipe-cost/index.cjs 必须是 scripts/gen-shared-cjs.js 生成的真正 CJS，
   不能是 `module.exports = require('./index.mjs')` 薄壳，否则桌面包 BFF 启动即 ERR_REQUIRE_ESM。 */
const fs = require('fs');
const pathMod = require('path');
const SHARED_DIR = pathMod.join(__dirname, '../../shared/recipe-cost');
const cjsSrc = fs.readFileSync(pathMod.join(SHARED_DIR, 'index.cjs'), 'utf8');
ok('index.cjs 不是 require(ESM) 薄壳', !/require\(\s*['"]\.\/index\.mjs['"]\s*\)/.test(cjsSrc));
const mjsExports = Array.from(
  fs.readFileSync(pathMod.join(SHARED_DIR, 'index.mjs'), 'utf8')
    .matchAll(/^export\s+(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm)
).map((m) => m[1]).sort();
ok('index.cjs 导出与 index.mjs 一致（需重跑 node scripts/gen-shared-cjs.js）',
  JSON.stringify(Object.keys(core).sort()) === JSON.stringify(mjsExports),
  { cjs: Object.keys(core).sort(), mjs: mjsExports });

// 原料定价：avg 为「元/斤」，unit='斤' → 500g/斤
const INGS = [
  { id: 'I-PORK', name: '猪肉', unit: '斤', avg: 20, yld: 1 },
  { id: 'I-SALT', name: '食盐', unit: '斤', avg: 3, yld: 1 },
  { id: 'I-HJ', name: '花椒', unit: '斤', avg: 30, yld: 1 },
  { id: 'I-DL', name: '大料', unit: '斤', avg: 40, yld: 1 },
  { id: 'I-XX', name: '小茴香', unit: '斤', avg: 20, yld: 1 },
  { id: 'I-XY', name: '香叶', unit: '斤', avg: 25, yld: 1 }
];
const DATA = { ings: INGS, config: {} };

// 中间材料库：料水（type='semi'，一批出成 200g，BOM 香料 23g）
const LIAOSHUI = {
  type: 'semi',
  name: '料水',
  sku_id: 'SEMI-LIAOSHUI',
  params: { '一批出成_g': 200 },
  seasoning: ['花椒10g', '大料5g', '小茴香5g', '香叶3g']
};

function lineQty(card, name) {
  const l = (card.bom_lines || []).find((x) => x.name === name);
  return l ? l.qty_g : null;
}

/* ---- 索引与基准量 ---- */
const idx = collectSemiIndex([LIAOSHUI, { sku_id: 'SKU-X', name: '五福饺子', main: [] }]);
ok('collectSemiIndex 只收 type=semi', idx['料水'] === LIAOSHUI && idx['五福饺子'] === undefined, Object.keys(idx));
ok('semiBaseGrams 优先 一批出成_g', semiBaseGrams(LIAOSHUI) === 200, semiBaseGrams(LIAOSHUI));

/* ---- ① 中间材料递归展开到原料 + 成本正确 ---- */
{
  const recipe = { sku_id: 'SKU-T1', name: '测试饺', params: { '一批出成_个': 100 }, main: ['猪肉200g'], seasoning: ['料水200g', '食盐3g'] };
  const card = buildCostCard(recipe, DATA, [LIAOSHUI]);
  ok('料水展开出 4 种香料', lineQty(card, '花椒') === 10 && lineQty(card, '大料') === 5 && lineQty(card, '小茴香') === 5 && lineQty(card, '香叶') === 3, card.bom_lines.map((x) => x.name + ':' + x.qty_g));
  ok('料水本身不残留为原料行', card.bom_lines.every((x) => x.name !== '料水'), card.bom_lines.map((x) => x.name));
  ok('猪肉/食盐仍正常计价', lineQty(card, '猪肉') === 200 && lineQty(card, '食盐') === 3);
  // 猪肉 200g*20/500=8；花椒 10g*30/500=0.6；大料 5g*40/500=0.4；小茴香 5g*20/500=0.2；香叶 3g*25/500=0.15；食盐 3g*3/500=0.018
  ok('batch_cost = 9.37', card.batch_cost === 9.37, card.batch_cost);
  ok('missing 为空', card.missing_ings.length === 0, card.missing_ings);
}

/* ---- ② 引用量缩放：料水 100g → 香料等比减半 ---- */
{
  const recipe = { sku_id: 'SKU-T2', name: '半料水', params: { '一批出成_个': 100 }, seasoning: ['料水100g'] };
  const card = buildCostCard(recipe, DATA, [LIAOSHUI]);
  ok('100g 料水 → 花椒 5g', lineQty(card, '花椒') === 5, lineQty(card, '花椒'));
  ok('100g 料水 → 大料 2.5g', lineQty(card, '大料') === 2.5, lineQty(card, '大料'));
  ok('100g 料水成本 = 0.675', card.batch_cost === 0.68, card.batch_cost); // 0.6+0.4+0.2+0.15 折半 = 0.675 → r2=0.68
}

/* ---- ③ 防环：料水 BOM 再引「料水」不无限递归 ---- */
{
  const loopSemi = {
    type: 'semi', name: '料水', sku_id: 'SEMI-LOOP',
    params: { '一批出成_g': 200 },
    seasoning: ['花椒10g', '料水50g']
  };
  const recipe = { sku_id: 'SKU-T3', name: '环引用', params: { '一批出成_个': 100 }, seasoning: ['料水200g'] };
  const card = buildCostCard(recipe, DATA, [loopSemi]);
  ok('防环后只展开一次花椒 10g', lineQty(card, '花椒') === 10, lineQty(card, '花椒'));
  ok('环引用不报 missing', card.missing_ings.length === 0, card.missing_ings);
}

/* ---- ④ 嵌套中间材料：半成品引半成品 ---- */
{
  const base = { type: 'semi', name: '料水', sku_id: 'SEMI-LIAOSHUI', params: { '一批出成_g': 200 }, seasoning: ['花椒10g', '大料5g'] };
  const top = { type: 'semi', name: '馅料预拌', sku_id: 'SEMI-MIX', params: { '一批出成_g': 500 }, seasoning: ['料水200g', '食盐10g'] };
  const recipe = { sku_id: 'SKU-T4', name: '嵌套', params: { '一批出成_个': 100 }, main: ['馅料预拌500g'] };
  const card = buildCostCard(recipe, DATA, [base, top]);
  ok('嵌套展开到花椒 10g', lineQty(card, '花椒') === 10, lineQty(card, '花椒'));
  ok('嵌套展开到食盐 10g', lineQty(card, '食盐') === 10, lineQty(card, '食盐'));
  ok('中间材料名不残留', card.bom_lines.every((x) => x.name !== '料水' && x.name !== '馅料预拌'), card.bom_lines.map((x) => x.name));
}

/* ---- ⑤ 兼容：无中间材料库 → 料水/清水仍跳过（旧口径） ---- */
{
  const recipe = { sku_id: 'SKU-T5', name: '旧配方', params: { '一批出成_个': 100 }, seasoning: ['料水200g', '食盐3g'] };
  const card = buildCostCard(recipe, DATA);
  ok('无库时料水被跳过（不进 BOM）', card.bom_lines.every((x) => x.name !== '料水' && x.name !== '花椒'), card.bom_lines.map((x) => x.name));
  ok('无库时只有食盐入 BOM', card.bom_lines.length === 1 && lineQty(card, '食盐') === 3, card.bom_lines.length);
  ok('无库时 missing 不含料水', card.missing_ings.indexOf('料水') < 0, card.missing_ings);
}

/* ---- ⑥ 复合行兼容：料水200g（花椒…）括号展开仍走旧路径 ---- */
{
  const recipe = { sku_id: 'SKU-T6', name: '复合行', params: { '一批出成_个': 100 }, seasoning: ['料水200g（花椒10g、大料5g）'] };
  const card = buildCostCard(recipe, DATA, [LIAOSHUI]);
  // 括号复合行由 parseBomLine 直接展开为香料子项，不进入「料水」整行 → 花椒 10g 正常计价
  ok('复合行展开花椒 10g', lineQty(card, '花椒') === 10, lineQty(card, '花椒'));
  ok('复合行展开大料 5g', lineQty(card, '大料') === 5, lineQty(card, '大料'));
}

/* ---- ⑦ 别名回退（ING_ALIAS_FALLBACK：荸荠→去皮马蹄、五得利雪花粉八星→五得利雪花面粉） ---- */
{
  const aliasIngs = [
    { id: 'I-MT', name: '去皮马蹄', unit: '斤', avg: 5, yld: 1 },
    { id: 'I-MF', name: '五得利雪花面粉', unit: '斤', avg: 2.5, yld: 1 }
  ];
  const recipe = { sku_id: 'SKU-T7', name: '别名回退', params: { '一批出成_个': 100 }, main: ['五得利雪花粉八星500g'], aux: ['荸荠100g'] };
  const card = buildCostCard(recipe, { ings: aliasIngs, config: {} });
  const biq = card.bom_lines.find((x) => x.name === '荸荠');
  const bmf = card.bom_lines.find((x) => x.name === '五得利雪花粉八星');
  ok('荸荠 → 去皮马蹄（ing_name）', biq && biq.ing_name === '去皮马蹄' && biq.ing === 'I-MT', biq && [biq.ing_name, biq.ing]);
  ok('五得利雪花粉八星 → 五得利雪花面粉（ing_name）', bmf && bmf.ing_name === '五得利雪花面粉' && bmf.ing === 'I-MF', bmf && [bmf.ing_name, bmf.ing]);
  ok('别名回退后 missing 清空', card.missing_ings.length === 0, card.missing_ings);
}

/* ---- ⑧ 单位换算（共享核心 gramsPerUnit / calcLineCost，修复「克×元/斤」量纲） ---- */
{
  ok('gramsPerUnit 斤=500', core.gramsPerUnit({ unit: '斤' }) === 500, core.gramsPerUnit({ unit: '斤' }));
  ok('gramsPerUnit kg=1000', core.gramsPerUnit({ unit: 'kg' }) === 1000, core.gramsPerUnit({ unit: 'kg' }));
  ok('gramsPerUnit g=1', core.gramsPerUnit({ unit: 'g' }) === 1, core.gramsPerUnit({ unit: 'g' }));
  ok('gramsPerUnit 名称规格 1.9L→1900', core.gramsPerUnit({ unit: '', name: '酱油1.9L' }) === 1900, core.gramsPerUnit({ unit: '', name: '酱油1.9L' }));
  const c1 = core.calcLineCost(200, { unit: '斤', avg: 20, yld: 1 });
  ok('calcLineCost 斤：200g×20元/斤 = 8', c1 && c1.gross === 200 && c1.lineCost === 8, c1);
  const c2 = core.calcLineCost(2000, { unit: 'kg', avg: 8, yld: 1 });
  ok('calcLineCost kg：2000g×8元/kg = 16', c2 && c2.gross === 2000 && c2.lineCost === 16, c2);
  const c3 = core.calcLineCost(200, { unit: '斤', avg: 20, yld: 0.8 });
  ok('calcLineCost 出成率：gross=250 lineCost=10', c3 && c3.gross === 250 && c3.lineCost === 10, c3);
  const c4 = core.calcLineCost(200, { unit: '斤', avg: 0, yld: 1 });
  ok('calcLineCost 无均价：gross=200 lineCost=null', c4 && c4.gross === 200 && c4.lineCost === null, c4);
  ok('calcLineCost qty=0 → null', core.calcLineCost(0, { unit: '斤', avg: 20 }) === null, core.calcLineCost(0, { unit: '斤', avg: 20 }));
  ok('calcLineCost 无 ing → null', core.calcLineCost(200, null) === null, core.calcLineCost(200, null));
}

/* ---- ⑨ 红/黄饺 missing 清空（别名回退 + 占位价齐备后） ---- */
{
  const wfIngs = [
    { id: 'I-MT', name: '去皮马蹄', unit: '斤', avg: 5, yld: 1 },
    { id: 'I-XG', name: '香菇', unit: '斤', avg: 8, yld: 1 },
    { id: 'I-HLG', name: '火龙果汁', unit: 'kg', avg: 8, yld: 1 },
    { id: 'I-MF', name: '五得利雪花面粉', unit: '斤', avg: 2.5, yld: 1 },
    { id: 'I-SALT', name: '食盐', unit: '斤', avg: 3, yld: 1 },
    { id: 'I-QT', name: '前腿半肥肉', unit: '斤', avg: 15, yld: 1 },
    { id: 'I-NG', name: '南瓜', unit: '斤', avg: 2, yld: 1 },
    { id: 'I-HX', name: '茴香', unit: '斤', avg: 6, yld: 1 },
    { id: 'I-DC', name: '大葱', unit: '斤', avg: 3, yld: 1 }
  ];
  const wfAlias = { 冬菇: '香菇', 猪前肩肉: '前腿半肥肉', 南瓜泥: '南瓜' };
  const wfData = { ings: wfIngs, config: { ing_alias: wfAlias } };

  const hong = {
    sku_id: 'SKU-WF-HONG', name: '红饺',
    face_main: ['火龙果汁220g'],
    main: ['猪前肩肉500g'],
    aux: ['冬菇100g', '荸荠100g'],
    params: { '面主料': ['五得利雪花粉八星500g', '火龙果汁220g', '食盐3g'], '一批出成_个': 67 }
  };
  const cardH = buildCostCard(hong, wfData);
  ok('红饺 missing 清空', cardH.missing_ings.length === 0, cardH.missing_ings);
  const hq = cardH.bom_lines.find((x) => x.name === '荸荠');
  ok('红饺 荸荠 → 去皮马蹄', hq && hq.ing_name === '去皮马蹄', hq && hq.ing_name);
  const hmf = cardH.bom_lines.find((x) => x.name === '五得利雪花粉八星');
  ok('红饺 五得利雪花粉八星 → 五得利雪花面粉', hmf && hmf.ing_name === '五得利雪花面粉', hmf && hmf.ing_name);

  const huang = {
    sku_id: 'SKU-WF-HUANG', name: '黄饺',
    face_main: ['南瓜泥220g'],
    main: ['猪前肩肉500g'],
    aux: ['茴香200g', '大葱50g'],
    params: { '面主料': ['五得利雪花粉八星500g', '南瓜泥220g', '食盐3g'], '一批出成_个': 67 }
  };
  const cardY = buildCostCard(huang, wfData);
  ok('黄饺 missing 清空', cardY.missing_ings.length === 0, cardY.missing_ings);
  const ymf = cardY.bom_lines.find((x) => x.name === '五得利雪花粉八星');
  ok('黄饺 五得利雪花粉八星 → 五得利雪花面粉', ymf && ymf.ing_name === '五得利雪花面粉', ymf && ymf.ing_name);
}

/* ---- ⑩ 前后端一致性：共享核心 calcLineCost/resolveIngName 与后端 buildCostCard 同口径 ---- */
{
  const pork = { id: 'I-PORK', name: '猪肉', unit: '斤', avg: 20, yld: 1 };
  const c = core.calcLineCost(200, pork);
  const card = buildCostCard({ sku_id: 'SKU-T8', name: '一致', params: { '一批出成_个': 100 }, main: ['猪肉200g'] }, DATA);
  const row = card.bom_lines.find((x) => x.name === '猪肉');
  ok('共享 core.lineCost == 后端行成本 line_cost', c.lineCost === row.line_cost, { core: c.lineCost, backend: row.line_cost });
  ok('共享 core.gross == 后端 gross_g', c.gross === row.gross_g, { core: c.gross, backend: row.gross_g });

  const mt = { id: 'I-MT', name: '去皮马蹄', unit: '斤', avg: 5, yld: 1 };
  const r2 = core.resolveIngName('荸荠', {}, { 去皮马蹄: mt });
  const card2 = buildCostCard({ sku_id: 'SKU-T9', name: '一致2', params: { '一批出成_个': 100 }, aux: ['荸荠100g'] }, { ings: [mt], config: {} });
  const row2 = card2.bom_lines.find((x) => x.name === '荸荠');
  ok('resolveIngName 与后端命中同一 ing', r2 && r2.id === 'I-MT' && row2 && row2.ing === 'I-MT', { core: r2 && r2.id, backend: row2 && row2.ing });
}

if (failed) {
  console.error('\nrecipe_cost 测试失败 ' + failed + ' 项');
  process.exit(1);
}
console.log('\nrecipe_cost.test.js 全部通过');
