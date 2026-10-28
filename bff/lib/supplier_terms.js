'use strict';
/*
 * lib/supplier_terms.js — 供应商域受控词表适配层（Phase 2 最小侵入试点）
 *
 * 定位：与 lib/ing_terms.js 同型——通用机制在 lib/terms_core.js，本文件只保留供应商领域知识：
 *   1) 供应商域配置 SUP_CONFIG（受控维度 = 供应商类目，ID 前缀 S，禁止自定义标签）；
 *   2) 数据取值 data.vendor_terms 缺失时回退 seedTerms()（开箱即用，不写库）；
 *   3) 存量 vendor.category 自由文本 → 词条 ID 的归一（未命中落「其他」）。
 *
 * 存储约定（方案 A：最小侵入，不升 schema）：
 *   - 词表存快照 JSON 字段 data.vendor_terms，与 data.ing_terms 平行，不建 SQLite 表；
 *   - vendor.category 由自由文本标量改为**词条 ID 标量**（单选、受控），
 *     展示层统一经 categoryLabel() 还原标准名，前端契约不变；
 *   - 三向合并已把 vendor_terms 纳入 merge.js COLL_KEY（按词条 id），避免冲突路径丢词条。
 *
 * 红线（沿用 W2）：
 *   - 纯函数、零第三方依赖、不写库；类目只进档案展示 / 归集 / 检索，不进任何成本 / 库存口径。
 *   - 词条 ID 精确匹配，别名归一到同一词条 ID。
 */
const core = require('./terms_core');

/** 受控维度白名单（供应商域只有一个维度：类目） */
const SUP_TERM_CATEGORIES = ['供应商类目'];

/** 词条状态机：申请 → 上架 / 驳回 */
const SUP_TERM_STATUSES = ['pending', 'active', 'rejected'];

/** 词条 ID 形态：S + 数字（与原料 T 前缀区分） */
const SUP_TERM_ID_RE = /^S\d+$/;

/** 兜底词条：存量/新增自由文本未命中任何词条时归入「其他」 */
const SUP_FALLBACK_ID = 'S005';

/** 供应商域配置：传给内核的唯一领域知识 */
const SUP_CONFIG = {
  scope: 'supplier',
  categories: SUP_TERM_CATEGORIES,
  statuses: SUP_TERM_STATUSES,
  idPrefix: 'S',
  customCategory: '自定义',
};

/**
 * 初始种子词条（开箱即用）。
 * 别名刻意覆盖存量自由文本（冷链 / 蔬菜 / 粮油 / 调料…），让老档案首次编辑即可归一，
 * 不必先做数据清洗；未覆盖的一律落 S005「其他」。
 */
function seedTerms() {
  return [
    {
      id: 'S001', name: '食材', category: '供应商类目', status: 'active',
      aliases: ['食材供应商', '蔬菜', '肉类', '冻品', '冷链', '粮油', '调料', '干货', '水产', '水果', '禽蛋', '米面'],
    },
    {
      id: 'S002', name: '餐具', category: '供应商类目', status: 'active',
      aliases: ['餐具用品', '餐盒', '一次性用品', '包装', '纸品'],
    },
    {
      id: 'S003', name: '酒水', category: '供应商类目', status: 'active',
      aliases: ['酒水饮料', '饮料', '酒类', '啤酒', '白酒'],
    },
    {
      id: 'S004', name: '设备工程商', category: '供应商类目', status: 'active',
      aliases: ['设备', '工程', '维修', '厨具', '设备供应商'],
    },
    {
      id: 'S005', name: '其他', category: '供应商类目', status: 'active',
      aliases: ['其他类', '未分类', '综合'],
    },
  ];
}

/** 取词表（data.vendor_terms 缺失/非数组时回退 seed，只读兜底不写库） */
function termsOf(data) {
  return core.listTerms(data && data.vendor_terms, seedTerms);
}

/** 是否为供应商词条 ID 形态（S + 数字） */
function isTermId(v) {
  return core.isTermId(v, SUP_CONFIG);
}

/** 下一个词条 ID：现有最大 S 数字 + 1 */
function nextTermId(terms) {
  return core.nextId(terms, SUP_CONFIG);
}

/** 构建 name / alias → id 索引（类目内精确匹配，别名归一到同一词条 ID） */
function buildTermIndex(terms) {
  return core.buildIndex(terms);
}

/**
 * 类目归一：字符串（词条 ID / 标准名 / 别名）→ { id, name, matched, input }。
 *   - 命中受控词条（含别名）→ { id: 'S001', name: '食材', matched: true }；
 *   - 未命中（存量自由文本 / 已删词条 ID）→ 落兜底词条「其他」，matched: false（供上层留痕 / 统计）；
 *   - 入参为空 → { id: null, ... }（表示清空，不落兜底）。
 */
function resolveCategory(raw, terms) {
  const input = String(raw == null ? '' : raw).trim();
  if (!input) return { id: null, name: null, matched: false, input };
  const list = Array.isArray(terms) ? terms : [];

  if (isTermId(input)) {
    const t = list.filter((x) => x && String(x.id) === input)[0];
    if (t) return { id: input, name: String(t.name || input), matched: true, input };
  }

  const hit = core.buildIndex(list).get(core.normalizeName(input));
  if (hit) {
    const t = list.filter((x) => x && String(x.id) === String(hit))[0];
    return { id: String(hit), name: String((t && t.name) || input), matched: true, input };
  }

  const fb = list.filter((x) => x && String(x.id) === SUP_FALLBACK_ID)[0];
  return fb
    ? { id: SUP_FALLBACK_ID, name: String(fb.name || '其他'), matched: false, input }
    : { id: null, name: null, matched: false, input };
}

/**
 * 类目展示名：词条 ID / 已归一自由文本 → 标准名；未命中的存量自由文本**原样回显**
 * （不静默改写展示值，等下次编辑或 vendor_term.backfill 收口）。
 */
function categoryLabel(raw, terms) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  const r = resolveCategory(s, terms);
  return r.matched ? r.name : s;
}

/** 单值展开（词条 ID → { id, name, category, isTerm }），供前端渲染 */
function flattenCategory(raw, terms) {
  return core.flattenOne(raw, terms, SUP_CONFIG);
}

module.exports = {
  SUP_TERM_CATEGORIES,
  SUP_TERM_STATUSES,
  SUP_TERM_ID_RE,
  SUP_FALLBACK_ID,
  SUP_CONFIG,
  seedTerms,
  termsOf,
  isTermId,
  nextTermId,
  buildTermIndex,
  resolveCategory,
  categoryLabel,
  flattenCategory,
};
