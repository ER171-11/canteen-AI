'use strict';
/*
 * lib/recipe_import.test.js — 食谱卡批量导入「解析层 + 预览层」回归（零依赖，node 直跑）
 *
 * 覆盖 lib/recipe_import.js（FP-DISH-16/17/18 的只读半边）：
 *   · CSV 表头不在首行 → 自动定位；菜品名合并单元格向下补齐；按菜品分组
 *   · 无效行（原料名为空 / 净料用量非数字或 ≤0）计入 bad；噪声行（合计）跳过
 *   · 伪 .xls 网页表格 / JSON（分组式 + 扁平式）两种支路
 *   · 手动指定列 override（列名古怪时兜底）
 *   · 预览：已有菜品/原料不重复建；未匹配 → newIngs/newDishes；已有配方行数取 ext.recipes
 *   · 红线：预览零写（传入的 snap 深比较前后一致）
 *
 * 运行：node lib/recipe_import.test.js
 */
const assert = require('assert');
const ri = require('./recipe_import');

let failed = 0;
function ok(name, cond, got) {
  if (cond) { console.log('  ✓ ' + name); return; }
  failed++;
  console.error('  ✗ ' + name + '  got=' + JSON.stringify(got));
}

const buf = (s) => Buffer.from(s, 'utf8');

/* ---- 1) CSV：表头不在首行 + 菜名合并补齐 + 噪声/无效行 ---- */
const CSV = [
  '食谱卡批量导入模板（示例，导入前请删除本行）',
  '菜品名称,菜品分类,原料名称,净料用量,库存单位,原料分类',
  '白切文昌鸡,爆品,文昌鸡,0.6,斤,鲜肉类',
  ',,生姜,0.02,斤,蔬菜类',
  ',,食盐,0.015,斤,调料类',
  '酸辣蕨根粉,引流,蕨根粉,0.2,斤,干货类',
  ',,,,',
  ',,食盐,,斤,调料类',
  ',,,1,,',
  '合计,,,,,',
].join('\n');

let r = ri.parseRecFile(buf(CSV), 'recipes.csv');
ok('CSV 解析出 2 道菜', r.docs.length === 2, r.docs.map((d) => d.dish));
ok('自动定位表头（非首行）', r.headerRowIndex === 1, r.headerRowIndex);
ok('菜名合并单元格向下补齐', r.docs[0].lines.length === 3, r.docs[0].lines);
ok('菜品分类沿用首个非空值', r.docs[0].cat === '爆品', r.docs[0].cat);
ok('第二道菜独立分组', r.docs[1].dish === '酸辣蕨根粉' && r.docs[1].lines.length === 1, r.docs[1]);
ok('无效行计入 bad（缺用量 / 缺原料名）', r.bad === 2, r.bad);
ok('噪声行（合计）不计入 bad', r.skipped === 0 && r.docs.length === 2, { skip: r.skipped, bad: r.bad });
ok('原料分类列取到', r.docs[0].lines[0].cat === '鲜肉类' && r.docs[0].lines[1].cat === '蔬菜类', r.docs[0].lines);

/* ---- 2) 伪 .xls（网页表格）---- */
const HTML = '<html><body><table>'
  + '<tr><td>菜品名称</td><td>原料名称</td><td>净料用量</td></tr>'
  + '<tr><td>老虎菜</td><td>青椒</td><td>200</td></tr></table></body></html>';
r = ri.parseRecFile(buf(HTML), 'recipes.xls');
ok('网页表格(伪 .xls) 可解析', r.format === 'html' && r.docs.length === 1 && r.docs[0].lines[0].qty === 200, r);

/* ---- 3) JSON：分组式 + 扁平式 ---- */
r = ri.parseRecFile(buf(JSON.stringify({
  recipes: [{ dish: '白切文昌鸡', cat: '爆品', lines: [{ ingName: '文昌鸡', qty: 0.6, unit: '斤' }] }]
})), 'recipes.json');
ok('JSON 分组式', r.docs.length === 1 && r.docs[0].lines[0].ingName === '文昌鸡', r.docs);

r = ri.parseRecFile(buf(JSON.stringify({
  items: [{ dish: '老虎菜', ingName: '青椒', qty: 200 }, { dish: '老虎菜', ingName: '香菜', qty: 20 }]
})), 'recipes.json');
ok('JSON 扁平式按菜合并', r.docs.length === 1 && r.docs[0].lines.length === 2, r.docs);

/* ---- 4) 列名古怪 → 自动识别失败并给出可执行文案；手动指定列兜底 ---- */
const WEIRD = ['菜,料,量', '老虎菜,青椒,200', '老虎菜,香菜,20'].join('\n');
r = ri.parseRecFile(buf(WEIRD), 'weird.csv');
ok('列名古怪：自动识别失败且不静默', !r.docs.length && /未识别到食谱卡表头/.test(r.err || ''), r.err);
r = ri.parseRecFile(buf(WEIRD), 'weird.csv',
  { rowIndex: 0, map: { dish: 0, ingName: 1, qty: 2 }, rows: [['菜', '料', '量'], ['老虎菜', '青椒', '200'], ['老虎菜', '香菜', '20']] });
ok('手动指定列后解析成功', r.docs.length === 1 && r.docs[0].lines.length === 2, r.docs);

/* ---- 5) 预览：匹配 / 自动建档 / 已有配方行数 / 零写 ---- */
const SNAP = {
  data: {
    ings: [{ id: 'I1', name: '文昌鸡', unit: '斤' }, { id: 'I2', name: '蕨根粉', unit: '斤' }],
    dishes: [{ id: 'D1', name: '白切文昌鸡', cat: '爆品' }],
    rec: {}
  },
  ext: { recipes: [{ sku_id: 'SKU-X', name: '酸辣蕨根粉', main: ['蕨根粉200g', '醋10g'], aux: [], seasoning: [] }] }
};
const before = JSON.stringify(SNAP);
const pv = ri.previewRecImport({ contentBase64: buf(CSV).toString('base64'), fileName: 'recipes.csv' }, SNAP);
ok('预览 ok', pv.ok === true, pv.error);
ok('两道菜', pv.groups.length === 2, pv.groups.map((g) => g.dish));
ok('已有菜品不重复建', pv.newDishes.length === 1 && pv.newDishes[0] === '酸辣蕨根粉', pv.newDishes);
ok('未匹配原料进 newIngs', pv.newIngs.map((x) => x.name).join(',') === '生姜,食盐', pv.newIngs);
ok('已有原料不重复建（含 unit 回填）',
  pv.groups[0].lines[0].isNew === false && pv.groups[0].lines[0].unit === '斤', pv.groups[0].lines[0]);
ok('已有配方行数取 ext.recipes（2 行）', pv.groups[1].existing === 2, pv.groups[1].existing);
ok('新菜行数 0', pv.groups[0].existing === 0, pv.groups[0].existing);
ok('明细行总数 = 4', pv.totalLines === 4, pv.totalLines);
ok('head 供手动指定列（含表头行号）',
  Array.isArray(pv.head.rows) && pv.head.headerRowIndex === 1 && !!pv.head.labels.dish, pv.head && pv.head.headerRowIndex);
ok('红线：预览零写（快照深比较一致）', JSON.stringify(SNAP) === before);

/* ---- 6) 失败路径：缺文件 / 空文件 / 超大 ---- */
ok('缺文件 → 明确报错', ri.previewRecImport({}, SNAP).ok === false);
ok('空内容 → 明确报错', ri.previewRecImport({ contentBase64: '' }, SNAP).error.indexOf('缺少文件内容') >= 0);
ok('整批无有效行 → ok:false', ri.previewRecImport({
  contentBase64: buf('菜品名称,原料名称,净料用量\n老虎菜,青椒,abc').toString('base64')
}, SNAP).ok === false);

/* ---- 7) 别名表照抄旧版（防止被顺手改动） ---- */
ok('菜品名称别名含 dish', ri.IMP_REC_DEFS.dish.alts.indexOf('dish') >= 0);
ok('净料用量别名含 净用量/用量', ri.IMP_REC_DEFS.qty.alts.join(',').indexOf('净用量') >= 0);
ok('六个字段与旧版一致', ri.REC_FIELDS.join(',') === 'dish,dishCat,ingName,qty,unit,cat', ri.REC_FIELDS);

assert.ok(true);
if (failed) {
  console.error('\nrecipe_import 测试失败 ' + failed + ' 项');
  process.exit(1);
}
console.log('\nrecipe_import.test.js 全部通过');
