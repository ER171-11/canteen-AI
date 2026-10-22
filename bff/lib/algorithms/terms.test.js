'use strict';
/*
 * W2 受控词表 + 属性 Tag 写侧单测（Node 超集，无 Python 对拍）。
 * 覆盖：别名归一、词条 ID 精确命中、term.upsert 申请/审核、ing.attr_set 打标/清空/非法引用。
 * 用法：node bff/lib/algorithms/terms.test.js
 */
const assert = require('assert');
const { seedTerms, resolveTermIds, matchIngTags, flattenTags } = require('../ing_terms');
const { applyTermUpsert, applyIngAttrSet } = require('./terms');

const SEED = seedTerms();

/* ---------- 1. 别名归一：「新疆 / 新疆产地 / 产自新疆」→ 同一词条 ID ---------- */
assert.deepStrictEqual(resolveTermIds('新疆', SEED), ['T002'], '新疆 → T002');
assert.deepStrictEqual(resolveTermIds('新疆产地', SEED), ['T002'], '新疆产地 → T002');
assert.deepStrictEqual(resolveTermIds('产自新疆', SEED), ['T002'], '产自新疆 → T002');
assert.deepStrictEqual(resolveTermIds(['新疆', '里脊'], SEED), ['T002', 'T005'], '数组归一');

/* ---------- 2. 词条 ID 精确命中：搜「东北/里脊/墨鱼」命中对应维度词条 ---------- */
assert.deepStrictEqual(matchIngTags('东北', { tags: ['T001'] }, SEED), ['T001'], '东北 → 产地');
assert.deepStrictEqual(matchIngTags('里脊', { tags: ['T005', 'T014'] }, SEED), ['T005'], '里脊 → 部位');
assert.deepStrictEqual(matchIngTags('墨鱼', { tags: ['T009'] }, SEED), ['T009'], '墨鱼 → 颜色');

/* ---------- 3. term.upsert：新建（默认 pending）→ 审核上架 ---------- */
const data = { ings: [], ing_terms: null };
let msg = applyTermUpsert(data, { name: '云南', category: '产地', aliases: ['云南产地'] });
assert.strictEqual(msg.indexOf('词条新建') === 0, true, '新建返回消息');
assert.strictEqual(data.ing_terms.length, SEED.length + 1, '词表新增一项');
const yn = data.ing_terms.find((t) => t.name === '云南');
assert.strictEqual(yn.status, 'pending', '新词条默认待审核');
assert.deepStrictEqual(yn.aliases, ['云南产地'], '别名已写入');

applyTermUpsert(data, { id: yn.id, status: 'active' });
assert.strictEqual(yn.status, 'active', '审核上架生效');

/* ---------- 4. 重复词条 / 非法 category / 非法 status 一律驳回 ---------- */
assert.throws(() => applyTermUpsert(data, { name: '新疆', category: '产地' }), /词条已存在/);
assert.throws(() => applyTermUpsert(data, { name: 'x', category: '随便' }), /不在受控维度白名单/);
assert.throws(() => applyTermUpsert(data, { id: yn.id, status: 'bad' }), /status 非法/);

/* ---------- 5. ing.attr_set：打标（词条 ID + 自定义营销 Tag）、清空、非法引用 ---------- */
data.ings.push({ id: 'I1', name: '东北酸菜' });
applyIngAttrSet(data, { id: 'I1', tags: ['T001', '夏季清仓'] });
assert.deepStrictEqual(data.ings[0].tags, ['T001', '夏季清仓'], '词条 ID + 自定义 Tag 并存');

assert.throws(() => applyIngAttrSet(data, { id: 'I1', tags: ['T999'] }), /不存在的词条/);

// 未上架词条（pending）不能选用：先申请一个「贵州」不审核，再尝试引用应被拒绝
applyTermUpsert(data, { name: '贵州', category: '产地' });
const gz = data.ing_terms.find((t) => t.name === '贵州');
assert.strictEqual(gz.status, 'pending', '新词条默认待审核');
assert.throws(() => applyIngAttrSet(data, { id: 'I1', tags: [gz.id] }), /未上架/);

applyIngAttrSet(data, { id: 'I1', tags: [] });
assert.strictEqual(data.ings[0].tags, undefined, '空 tags 清空字段');

/* ---------- 6. 按 name 定位 + 去重 ---------- */
data.ings.push({ id: 'I2', name: '黑猪前肩肉' });
applyIngAttrSet(data, { name: '黑猪前肩肉', tags: ['T007', 'T007', 'T014'] });
assert.deepStrictEqual(data.ings[1].tags, ['T007', 'T014'], 'name 定位 + 去重');

/* ---------- 7. flattenTags 渲染 ---------- */
const flat = flattenTags(['T002', '直播间主推'], SEED);
assert.strictEqual(flat[0].name, '新疆', '词条 ID → 标准名');
assert.strictEqual(flat[0].category, '产地', '词条 category 正确');
assert.strictEqual(flat[1].category, '自定义', '自定义 Tag 归「自定义」');
assert.strictEqual(flat[1].isTerm, false, '自定义 Tag 非词条');

console.log('[terms.test] PASS  受控词表 + 属性 Tag 写侧 + 词条 ID 精确命中');
