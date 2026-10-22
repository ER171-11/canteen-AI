'use strict';
/*
 * lib/ing_terms.js — 受控词表（W2 商品库结构化字段 + 受控词表 Tag 双轨制）
 *
 * 依据 docs/发版计划-下一版本_2026-10-19.md W2「固定词条 Tag（受控词表，灵活层）」：
 *   term{ id, name, category, aliases[], status }
 *   - name      词条标准名（唯一）
 *   - category  受控维度：产地 / 颜色 / 部位 / 等级 / 品种 / 规格 / 包装 / 口味
 *   - aliases[] 别名归一（「新疆 / 新疆产地 / 产自新疆」→ 同一词条 ID）
 *   - status    pending（申请）→ active（上架）/ rejected（驳回）
 *
 * 红线对齐：
 *   - 纯函数、零第三方依赖、不写库；词条本体存 data.ing_terms（JSON 快照，补字段优先慎建表）。
 *   - 检索基于**词条 ID 精确匹配**（resolveTermIds 把用户输入归一为标准词条 ID），
 *     不靠 name/spec 模糊碰运气（发版计划 W2 方案 4）。
 *   - tag 不影响 recipe_cost 成本与 ing_alias 匹配：tags 只读渲染 / 检索，不进任何成本口径。
 */

/** 受控维度白名单（词条 category 只能取这些值，防自由文本污染） */
const TERM_CATEGORIES = ['产地', '颜色', '部位', '等级', '品种', '规格', '包装', '口味'];

/** 词条状态机：申请 → 上架 / 驳回 */
const TERM_STATUSES = ['pending', 'active', 'rejected'];

/** 词条 ID 形态：T + 数字（与原料 I 前缀区分） */
const TERM_ID_RE = /^T\d+$/;

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
  return String(s == null ? '' : s).replace(/\s+/g, '').trim();
}

/** 是否为词条 ID 形态（T + 数字） */
function isTermId(v) {
  return typeof v === 'string' && TERM_ID_RE.test(v.trim());
}

/** 是否自定义营销 Tag（非词条 ID 的普通字符串，如「夏季清仓」） */
function isCustomTag(v) {
  return typeof v === 'string' && v.trim() !== '' && !TERM_ID_RE.test(v.trim());
}

/** 取词表（data.ing_terms 缺失/非数组时回退 seed，只读兜底不写库） */
function termsOf(data) {
  const t = (data && Array.isArray(data.ing_terms)) ? data.ing_terms : [];
  return t.length ? t : seedTerms();
}

/** 下一个词条 ID：现有最大 T 数字 + 1，无则 T001 起 */
function nextTermId(terms) {
  const nums = [];
  for (const t of Array.isArray(terms) ? terms : []) {
    const s = String((t && t.id) || '');
    if (TERM_ID_RE.test(s)) nums.push(parseInt(s.slice(1), 10));
  }
  return 'T' + (nums.length ? Math.max(...nums) + 1 : 1);
}

/** 构建 name / alias → id 索引（受控维度内精确匹配，别名归一到同一词条 ID） */
function buildTermIndex(terms) {
  const idx = new Map();
  for (const t of Array.isArray(terms) ? terms : []) {
    if (!t || !t.id) continue;
    const keys = [String(t.name || '')];
    if (Array.isArray(t.aliases)) for (const a of t.aliases) keys.push(String(a));
    for (const k of keys) {
      const nk = normalizeTermName(k);
      if (nk) idx.set(nk, String(t.id));
    }
  }
  return idx;
}

/**
 * 把用户输入（字符串或数组）归一为标准词条 ID 数组（去重、丢弃未命中项）。
 * 精确匹配顺序：词条 ID → 标准名 → 别名（均先 normalizeTermName）。
 * 未命中（普通营销 Tag / 不存在的词）返回原样字符串，交由调用方按「自定义 Tag」处理。
 */
function resolveTermIds(input, terms) {
  const list = Array.isArray(input) ? input : [input];
  const idx = buildTermIndex(terms);
  const out = [];
  for (const raw of list) {
    const s = String(raw == null ? '' : raw);
    if (!s) continue;
    const t = s.trim();
    if (TERM_ID_RE.test(t)) {
      out.push(t);
      continue;
    }
    const hit = idx.get(normalizeTermName(t));
    if (hit) out.push(hit);
    else out.push(t); // 未命中 → 视为自定义 Tag 原样保留
  }
  return Array.from(new Set(out));
}

/** 词条 ID 精确命中：query 归一出的词条 ID 是否落在 ing.tags 里（含别名归一） */
function matchIngTags(query, ing, terms) {
  const tags = Array.isArray(ing && ing.tags) ? ing.tags : [];
  const wanted = resolveTermIds(query, terms).filter(isTermId);
  if (!wanted.length) return [];
  const hitIds = new Set();
  for (const tag of tags) {
    const id = resolveTermIds(tag, terms)[0];
    if (wanted.indexOf(id) >= 0) hitIds.add(id);
  }
  return Array.from(hitIds);
}

/** 把 tags 数组（词条 ID + 自定义 Tag）展开为可展示对象（供前端渲染 / 高亮） */
function flattenTags(tags, terms) {
  const idx = new Map();
  for (const t of Array.isArray(terms) ? terms : []) {
    if (t && t.id) idx.set(String(t.id), t);
  }
  return (Array.isArray(tags) ? tags : []).map((raw) => {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    const term = TERM_ID_RE.test(s) ? idx.get(s) : null;
    return term
      ? { id: term.id, name: term.name, category: term.category, aliases: term.aliases || [], isTerm: true }
      : { id: s, name: s, category: '自定义', aliases: [], isTerm: false };
  }).filter(Boolean);
}

module.exports = {
  TERM_CATEGORIES,
  TERM_STATUSES,
  TERM_ID_RE,
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
