'use strict';
/*
 * lib/algorithms/dish_import_delete.test.js — 菜品/配方域两个新写动作的回归
 *
 * 覆盖 lib/algorithms/dish.js：
 *   applyDishDelete（FP-DISH-06）：有销售记录禁删（id/菜名/sku_id 三选一命中）
 *   applyRecipeImport（FP-DISH-16/18）：整批导入，逐道菜复用唯一写入口 upsertRecipe
 *     → 自动建菜品壳（sync_dish）/ 自动建原料（ensure_ings）
 *     → mode=replace 覆盖主料并清空辅料/调味；mode=merge 按原料名合并、未出现的旧行保留
 *
 * 注：本文件不再走 dish.test.js 的 Node↔Python 平价对照——这两个动作是 Node 侧新增能力，
 *     旧 Python runtime 无对应实现，故按「行为断言」验证。
 *
 * 运行：node lib/algorithms/dish_import_delete.test.js
 */
const dish = require('./dish');

let failed = 0;
let passed = 0;
function ok(name, cond, got) {
  if (cond) { passed++; console.log('  ✓ ' + name); return; }
  failed++;
  console.error('  ✗ ' + name + '  got=' + JSON.stringify(got));
}
function throws(name, fn, needle) {
  try {
    fn();
    ok(name, false, '未抛错');
  } catch (e) {
    ok(name + (needle ? '（' + needle + '）' : ''), String(e.message).indexOf(needle) >= 0, e.message);
  }
}

/* ================= FP-DISH-06 删除菜品 ================= */

function fixDelete() {
  return {
    dishes: [
      { id: 'D1', name: '老虎菜', cat: '引流', on: true },
      { id: 'D2', name: '长寿饺', cat: '爆品', sku_id: 'SKU-WF-HONG', on: true }
    ],
    rec: { D1: [{ ing: 'I1', qty: 1 }], 'SKU-WF-HONG': [{ ing: 'I2', qty: 2 }] },
    sales: [{ id: 'S1', lines: [{ dish: 'SKU-WF-HONG', qty: 5 }] }]
  };
}

let data = fixDelete();
let msg = dish.applyDishDelete(data, { id: 'D1' });
ok('无销售的菜可删', data.dishes.length === 1 && data.dishes[0].id === 'D2', data.dishes.map((d) => d.id));
ok('删除菜同时解除配方绑定', data.rec.D1 === undefined && data.rec['SKU-WF-HONG'] !== undefined, Object.keys(data.rec));
ok('返回消息含菜名', /老虎菜/.test(msg), msg);

data = fixDelete();
throws('有销售记录的菜禁删', () => dish.applyDishDelete(data, { id: 'D2' }), '不能删除');
ok('禁删时菜品与配方均未被改动', data.dishes.length === 2 && !!data.rec['SKU-WF-HONG'], data);

data = fixDelete();
throws('找不到的菜报错', () => dish.applyDishDelete(data, { name: '不存在的菜' }), '找不到菜品');
throws('缺 id/name 报错', () => dish.applyDishDelete(fixDelete(), {}), '缺 id/name');

/* 按 sku_id 命中：菜名与 id 都不匹配时也能定位 */
data = fixDelete();
data.sales = [];
dish.applyDishDelete(data, { id: 'SKU-WF-HONG' });
ok('按 sku_id 可定位并删除', data.dishes.length === 1 && data.rec['SKU-WF-HONG'] === undefined, data.dishes);

/* ================= FP-DISH-16/18 食谱卡导入 ================= */

/** 记录写入的假 store：query 回一行（模拟库中已有配方），upsert 只记录不落库 */
function fixStore(row) {
  const written = [];
  return {
    written: written,
    query(table, where) {
      if (table !== 'recipes' || !row) return [];
      if (where && where.name && String(row.name) !== String(where.name)) return [];
      if (where && where.sku_id && String(row.sku_id) !== String(where.sku_id)) return [];
      return [row];
    },
    get() { return null; },
    insert() { return 1; },
    upsert(table, r) { written.push({ table: table, row: r }); return { rowid: 1, matched: true }; },
    update() { return { rowcount: 0 }; }
  };
}

const GROUPS = [{
  dish: '白切文昌鸡',
  cat: '爆品',
  rows: [
    { name: '文昌鸡', qty: 600, unit: 'g', cat: '鲜肉类' },
    { name: '生姜', qty: 20, unit: 'g', cat: '蔬菜类' }
  ]
}];

/* --- 无 store（降级写 data.ext.recipes）：自动建菜品壳；原料须已建档（单向原则） --- */
data = {
  ings: [{ id: 'I1', name: '文昌鸡', unit: '斤' }, { id: 'I2', name: '生姜', cat: '蔬菜类', unit: 'g' }],
  dishes: [], ext: { recipes: [] }
};
msg = dish.applyRecipeImport(null, data, { groups: GROUPS });
ok('降级路径：配方写入 ext.recipes', data.ext.recipes.length === 1
  && data.ext.recipes[0].name === '白切文昌鸡', data.ext.recipes);
ok('主料按「名+用量+单位」落库', JSON.parse(data.ext.recipes[0].main).join(',') === '文昌鸡600g,生姜20g',
  data.ext.recipes[0].main);
ok('自动建菜品壳（sync_dish）', data.dishes.some((d) => d.name === '白切文昌鸡'), data.dishes);
ok('已建档原料不被反向改写',
  (data.ings.find((g) => g.name === '生姜') || {}).cat === '蔬菜类'
  && (data.ings.find((g) => g.name === '生姜') || {}).unit === 'g',
  data.ings.find((g) => g.name === '生姜'));
ok('返回消息含道数与模式', /1 道菜/.test(msg) && /覆盖/.test(msg), msg);

/* --- 有 store：replace 覆盖主料并清空辅料/调味 --- */
const existing = {
  sku_id: 'SKU-APP-X', name: '白切文昌鸡', color: null, filling: null, face_main: null,
  main: '["文昌鸡500g", "食盐5g"]', aux: '["姜10g"]', seasoning: '["香油5g"]',
  steps: '[]', params: '{}', blessing: null, diet_tags: '[]', version: 1
};
let store = fixStore(existing);
data = {
  ings: [{ id: 'I1', name: '文昌鸡', unit: '斤' }, { id: 'I2', name: '生姜', unit: 'g' }],
  dishes: []
};
msg = dish.applyRecipeImport({ store: store }, data, { groups: GROUPS, mode: 'replace' });
let row = store.written[0].row;
ok('replace：写入 recipes 表', store.written[0].table === 'recipes', store.written[0].table);
ok('replace：主料被整批替换', JSON.parse(row.main).join(',') === '文昌鸡600g,生姜20g', row.main);
ok('replace：辅料/调味被清空（旧版覆盖语义）',
  JSON.parse(row.aux || '[]').length === 0 && JSON.parse(row.seasoning || '[]').length === 0, row.aux);
ok('版本号自增', row.version === 2, row.version);
ok('消息标注覆盖', /覆盖/.test(msg), msg);

/* --- 有 store：merge 按原料名合并，未出现的旧行保留（旧行原料同样须已建档） --- */
store = fixStore(existing);
data = {
  ings: [
    { id: 'I1', name: '文昌鸡', unit: '斤' },
    { id: 'I2', name: '食盐', unit: 'g' },
    { id: 'I3', name: '生姜', unit: 'g' },
    { id: 'I4', name: '姜', unit: 'g' },
    { id: 'I5', name: '香油', unit: 'g' }
  ],
  dishes: []
};
msg = dish.applyRecipeImport({ store: store }, data, { groups: GROUPS, mode: 'merge' });
row = store.written[0].row;
ok('merge：命中原料覆盖用量、新原料追加、旧行保留',
  JSON.parse(row.main).join(',') === '文昌鸡600g,食盐5g,生姜20g', row.main);
ok('merge：辅料不动', JSON.parse(row.aux || '[]').join(',') === '姜10g', row.aux);
ok('消息标注合并', /按原料合并/.test(msg), msg);

/* --- 参数与守卫 --- */
throws('缺 groups 报错', () => dish.applyRecipeImport(null, { ext: {} }, {}), '缺 groups');
throws('整批无有效行报错', () => dish.applyRecipeImport(null, { ext: {} }, {
  groups: [{ dish: '老虎菜', rows: [{ name: '青椒', qty: 0, unit: 'g' }] }]
}), '没有可导入的菜');

/* 单向原则：缺料拦截——ensure_ings 已废弃，任何取值都不再反向建档 */
store = fixStore(existing);
data = { ings: [{ id: 'I1', name: '文昌鸡', unit: '斤' }], dishes: [] };
throws('缺料未建档 → 拦截不写库', () => dish.applyRecipeImport({ store: store }, data, {
  groups: GROUPS, ensure_ings: true
}), '缺料未建档');
ok('缺料拦截：原料未被反向建档', !data.ings.some((g) => g.name === '生姜'), data.ings.map((g) => g.name));
ok('缺料拦截：配方未落库', store.written.length === 0, store.written.length);
throws('ensure_ings=false 同样拦截（参数已废弃）', () => dish.applyRecipeImport({ store: store }, data, {
  groups: GROUPS, ensure_ings: false
}), '缺料未建档');

if (failed) {
  console.error('\ndish_import_delete 测试失败 ' + failed + ' 项');
  process.exit(1);
}
/* 末尾必须带 PASS 标记：lib/algorithms/run-tests.js 以此判定本域是否全绿 */
console.log('\n[dish_import_delete.test] PASS ' + passed + ' cases');
