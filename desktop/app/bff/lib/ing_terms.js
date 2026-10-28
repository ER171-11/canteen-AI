'use strict';
/*
 * lib/ing_terms.js — 原料域受控词表适配层（薄壳）
 *
 * 历史：本文件是 W2「受控词表 Tag（两轨制）」的原始实现。现已把与领域无关的纯函数
 *       抽到 lib/terms_core.js；本文件只保留两点领域知识：
 *         1) 原料域配置 ING_CONFIG（受控维度白名单 = 产地/颜色/部位/等级/品种/规格/包装/口味，
 *            ID 前缀 T，允许自定义标签）；
 *         2) 数据取值 data.ing_terms 缺失时回退 seedTerms()。
 *
 * 兼容契约：下列导出名与签名保持不变，供 routes/inventory.js、lib/algorithms/terms.js、
 *           lib/algorithms/terms.test.js 直接调用，原料域行为零变化。
 *
 * 红线（沿用 W2）：
 *   - 纯函数、零第三方依赖、不写库；tags 只读渲染 / 检索，不进任何成本 / 库存 / 损耗 / 毛利率口径。
 *   - 词条 ID 精确匹配，别名归一到同一词条 ID。
 */
const core = require('./terms_core');

/** 受控维度白名单（词条 category 只能取这些值，防自由文本污染） */
const TERM_CATEGORIES = ['产地', '颜色', '部位', '等级', '品种', '规格', '包装', '口味'];

/** 词条状态机：申请 → 上架 / 驳回 */
const TERM_STATUSES = ['pending', 'active', 'rejected'];

/** 词条 ID 形态：T + 数字（与原料 I 前缀区分） */
const TERM_ID_RE = /^T\d+$/;

/** 原料域配置：传给内核的唯一领域知识 */
const ING_CONFIG = {
  scope: 'ingredient',
  categories: TERM_CATEGORIES,
  statuses: TERM_STATUSES,
  idPrefix: 'T',
  customCategory: '自定义',
};

/** 初始种子词条（开箱即用；运营可经 term.upsert 增删改，或重新申请新词条） */
function seedTerms() {
  return [
    { id: 'T001', name: '东北', category: '产地', aliases: ['东北产地', '产自东北'], status: 'active' },
    { id: 'T002', name: '新疆', category: '产地', aliases: ['新疆产地', '产自新疆'], status: 'active' },
    { id: 'T003', name: '山东', category: '产地', aliases: ['山东产地', '产自山东'], status: 'active' },
    { id: 'T004', name: '四川', category: '产地', aliases: ['四川产地', '川产'], status: 'active' },
    { id: 'T005', name: '里脊', category: '部位', aliases: ['里脊肉', '里脊条'], status: 'active' },
    { id: 'T006', name: '五花', category: '部位', aliases: ['五花肉', '三层肉'], status: 'active' },
    { id: 'T007', name: '前肩', category: '部位', aliases: ['前肩肉', '梅花肉'], status: 'active' },
    { id: 'T008', name: '后腿', category: '部位', aliases: ['后腿肉'], status: 'active' },
    { id: 'T009', name: '墨鱼色', category: '颜色', aliases: ['墨鱼', '墨色', '乌黑'], status: 'active' },
    { id: 'T010', name: '红色', category: '颜色', aliases: ['红', '大红', '赤色'], status: 'active' },
    { id: 'T011', name: '黑色', category: '颜色', aliases: ['黑', '深黑'], status: 'active' },
    { id: 'T012', name: 'A级', category: '等级', aliases: ['A', '一级'], status: 'active' },
    { id: 'T013', name: 'B级', category: '等级', aliases: ['B', '二级'], status: 'active' },
    { id: 'T014', name: '黑猪', category: '品种', aliases: ['黑毛猪'], status: 'active' },
    { id: 'T015', name: '土鸡', category: '品种', aliases: ['走地鸡'], status: 'active' },
  ];
}

/** 归一词条名 / 别名：去首尾空白 + 折叠内部连续空白（不自动变换语义，别名靠受控 aliases 维护） */
function normalizeTermName(s) {
  return core.normalizeName(s);
}

/** 是否为词条 ID 形态（T + 数字） */
function isTermId(v) {
  return core.isTermId(v, ING_CONFIG);
}

/** 是否自定义营销 Tag（非词条 ID 的普通字符串，如「夏季清仓」） */
function isCustomTag(v) {
  return core.isCustomTag(v, ING_CONFIG);
}

/** 取词表（data.ing_terms 缺失/非数组时回退 seed，只读兜底不写库） */
function termsOf(data) {
  return core.listTerms(data && data.ing_terms, seedTerms);
}

/** 下一个词条 ID：现有最大 T 数字 + 1，无则 T001 起 */
function nextTermId(terms) {
  return core.nextId(terms, ING_CONFIG);
}

/** 构建 name / alias → id 索引（受控维度内精确匹配，别名归一到同一词条 ID） */
function buildTermIndex(terms) {
  return core.buildIndex(terms);
}

/** 把用户输入（字符串或数组）归一为标准词条 ID 数组（去重、丢弃未命中项） */
function resolveTermIds(input, terms) {
  return core.resolveIds(input, terms, ING_CONFIG);
}

/** 词条 ID 精确命中：query 归一出的词条 ID 是否落在 ing.tags 里（含别名归一） */
function matchIngTags(query, ing, terms) {
  return core.matchTags(query, ing && ing.tags, terms, ING_CONFIG);
}

/** 把 tags 数组（词条 ID + 自定义 Tag）展开为可展示对象（供前端渲染 / 高亮） */
function flattenTags(tags, terms) {
  return core.flattenTags(tags, terms, ING_CONFIG);
}

module.exports = {
  TERM_CATEGORIES,
  TERM_STATUSES,
  TERM_ID_RE,
  ING_CONFIG,
  seedTerms,
  normalizeTermName,
  isTermId,
  isCustomTag,
  termsOf,
  nextTermId,
  buildTermIndex,
  resolveTermIds,
  matchIngTags,
  flattenTags,
};
