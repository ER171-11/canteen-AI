'use strict';
/*
 * 通用受控词表内核（lib/terms_core.js）单测。
 * 覆盖：领域隔离、别名归一、单选/多选、allowCustom 开关、active 校验、upsert 白名单与同名校验、ID 前缀连续性。
 * 用法：node bff/lib/algorithms/terms_core.test.js
 */
const assert = require('assert');
const core = require('../terms_core');

/* ---------- 两套领域配置：原料（T 前缀） vs 供应商（S 前缀） ---------- */
const CFG_ING = {
  scope: 'ingredient',
  categories: ['产地', '部位'],
  statuses: ['pending', 'active', 'rejected'],
  idPrefix: 'T',
  customCategory: '自定义',
};
const CFG_SUP = {
  scope: 'supplier',
  categories: ['供应商类目'],
  statuses: ['pending', 'active', 'rejected'],
  idPrefix: 'S',
  customCategory: '自定义',
};

function seedIng() {
  return [
    { id: 'T001', name: '东北', category: '产地', aliases: ['东北产地'], status: 'active' },
    { id: 'T002', name: '里脊', category: '部位', aliases: [], status: 'active' },
    { id: 'T003', name: '贵州', category: '产地', aliases: [], status: 'pending' },
  ];
}
function seedSup() {
  return [
    { id: 'S001', name: '食材', category: '供应商类目', aliases: ['食材供应商'], status: 'active' },
    { id: 'S002', name: '酒水', category: '供应商类目', aliases: [], status: 'active' },
  ];
}

/* ---------- 1. listTerms：非空数组优先，缺失回退 seed ---------- */
const A = seedIng();
const B = seedSup();
assert.strictEqual(core.listTerms(A, seedIng), A, '非空数组原样返回');
assert.deepStrictEqual(core.listTerms(null, seedIng).map((t) => t.id), ['T001', 'T002', 'T003'], '缺失回退 seed');
assert.deepStrictEqual(core.listTerms([], seedSup).map((t) => t.id), ['S001', 'S002'], '空数组回退 seed');

/* ---------- 2. 领域隔离：同名词条 / 异前缀 ID 互不串味 ---------- */
assert.deepStrictEqual(core.resolveIds('东北', A, CFG_ING), ['T001'], '原料域命中');
assert.deepStrictEqual(core.resolveIds('东北产地', A, CFG_ING), ['T001'], '别名归一到同一 ID');
assert.deepStrictEqual(core.resolveIds('食材', B, CFG_SUP), ['S001'], '供应商域命中');
assert.deepStrictEqual(core.resolveIds('食材供应商', B, CFG_SUP), ['S001'], '供应商别名归一');
assert.deepStrictEqual(core.resolveIds('食材', A, CFG_ING), ['食材'], '原料域不认识供应商词条 → 原样保留');
assert.deepStrictEqual(core.resolveIds('S001', A, CFG_ING), ['S001'], '异前缀 ID 在原料域不被当作词条 ID');
assert.strictEqual(core.isTermId('S001', CFG_SUP), true, 'S 前缀在供应商域是词条 ID');
assert.strictEqual(core.isTermId('S001', CFG_ING), false, 'S 前缀在原料域不是词条 ID');

/* ---------- 3. matchTags：词条 ID 精确命中 ---------- */
assert.deepStrictEqual(core.matchTags('东北', ['T001'], A, CFG_ING), ['T001'], '按标准名命中');
assert.deepStrictEqual(core.matchTags('东北产地', ['T001'], A, CFG_ING), ['T001'], '按别名命中');
assert.deepStrictEqual(core.matchTags('食材', ['S001'], B, CFG_SUP), ['S001'], '供应商域命中');
assert.deepStrictEqual(core.matchTags('食材', ['T001'], A, CFG_ING), [], '跨域不命中（隔离）');

/* ---------- 4. flattenTags：词条 → 标准名；自定义标签归「自定义」 ---------- */
const flat = core.flattenTags(['T001', '夏季清仓'], A, CFG_ING);
assert.strictEqual(flat[0].name, '东北', '词条 ID → 标准名');
assert.strictEqual(flat[0].category, '产地', '词条 category 正确');
assert.strictEqual(flat[0].isTerm, true, '受控词条 isTerm=true');
assert.strictEqual(flat[1].category, '自定义', '自定义标签归「自定义」');
assert.strictEqual(flat[1].isTerm, false, '自定义标签 isTerm=false');

/* ---------- 5. applyTags：多选 / 去重 / 清空 ---------- */
let ing = {};
let r = core.applyTags(ing, ['T001', '夏季清仓'], A, { mode: 'multiple', config: CFG_ING });
assert.strictEqual(r.count, 2, '多值写入 2 项');
assert.deepStrictEqual(ing.tags, ['T001', '夏季清仓'], '词条 ID + 自定义标签并存');

r = core.applyTags(ing, ['T001', 'T001', 'T002'], A, { mode: 'multiple', config: CFG_ING });
assert.deepStrictEqual(ing.tags, ['T001', 'T002'], '重复标签去重');

r = core.applyTags(ing, [], A, { mode: 'multiple', config: CFG_ING });
assert.strictEqual(r.count, 0, '空数组清空');
assert.strictEqual(ing.tags, undefined, '清空后删除字段');

/* ---------- 6. applyTags：单选超限报错 ---------- */
assert.throws(
  () => core.applyTags({}, ['T001', 'T002'], A, { mode: 'single', config: CFG_ING }),
  /单选领域只能关联/, '单选超限抛错'
);
r = core.applyTags({}, ['T001'], A, { mode: 'single', config: CFG_ING });
assert.strictEqual(r.count, 1, '单选取 1 项通过');

/* ---------- 7. applyTags：allowCustom=false 拒绝自定义标签 ---------- */
assert.throws(
  () => core.applyTags({}, ['夏季清仓'], A, { allowCustom: false, config: CFG_ING }),
  /不允许自定义标签/, '关闭自定义标签时拒绝自由文本'
);
r = core.applyTags({}, ['T001'], A, { allowCustom: false, config: CFG_ING });
assert.strictEqual(r.count, 1, '关闭自定义后受控词条仍可用');

/* ---------- 8. applyTags：只接受 active 词条 / 拒绝未知词条 ---------- */
assert.throws(
  () => core.applyTags({}, ['T003'], A, { config: CFG_ING }),
  /未上架/, 'pending 词条不可选用'
);
assert.throws(
  () => core.applyTags({}, ['T999'], A, { config: CFG_ING }),
  /不存在的词条/, '未知词条 ID 被拒'
);

/* ---------- 9. upsertTerm：新建 / 审核上架 / 白名单 / 同名 / 非法状态 ---------- */
const T = seedIng();
const created = core.upsertTerm(T, { name: '云南', category: '产地', aliases: ['云南产地'] }, CFG_ING);
assert.strictEqual(created.created, true, '新建标记 created=true');
assert.strictEqual(created.status, 'pending', '新建默认待审核');
assert.strictEqual(T.length, 4, '词表新增一项');
const yn = T.find((t) => t.name === '云南');
assert.deepStrictEqual(yn.aliases, ['云南产地'], '别名已写入');

const updated = core.upsertTerm(T, { id: yn.id, status: 'active' }, CFG_ING);
assert.strictEqual(updated.created, false, '更新标记 created=false');
assert.strictEqual(updated.status, 'active', '审核上架生效');

assert.throws(() => core.upsertTerm(T, { name: '东北', category: '产地' }, CFG_ING), /词条已存在/, '同名驳回');
assert.throws(() => core.upsertTerm(T, { name: 'x', category: '随便' }, CFG_ING), /不在受控维度白名单/, '非法维度驳回');
assert.throws(() => core.upsertTerm(T, { name: 'y' }, CFG_ING), /必须指定 category/, '缺维度驳回');
assert.throws(() => core.upsertTerm(T, { id: yn.id, status: 'bad' }, CFG_ING), /status 非法/, '非法状态驳回');

/* ---------- 10. 供应商域 upsert：S 前缀 + 供应商维度白名单 ---------- */
const supCreated = core.upsertTerm(B, { name: '餐具', category: '供应商类目' }, CFG_SUP);
assert.strictEqual(supCreated.created, true, '供应商词条新建成功');
assert.strictEqual(supCreated.id.indexOf('S'), 0, '供应商词条使用 S 前缀');
assert.throws(
  () => core.upsertTerm(B, { name: '产地词', category: '产地' }, CFG_SUP),
  /不在受控维度白名单/, '供应商域拒绝原料维度'
);

/* ---------- 11. nextId：前缀 + 数值连续性（与 W2 原实现同口径，不补零） ---------- */
assert.strictEqual(core.nextId([{ id: 'S001' }, { id: 'S002' }], CFG_SUP), 'S3', 'S 前缀连续递增');
assert.strictEqual(core.nextId([{ id: 'T015' }], CFG_ING), 'T16', 'T 前缀在最大号 +1');

console.log('[terms_core.test] PASS  通用受控词表内核（领域隔离 / 单选多选 / allowCustom / upsert / ID 连续性）');
