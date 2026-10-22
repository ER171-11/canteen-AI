'use strict';
/*
 * lib/algorithms/terms.js — W2 受控词表写侧算法（Node 超集，无 Python 对拍）
 *
 *   term.upsert → applyTermUpsert   词条申请 / 审核 / 上架 / 改名 / 改别名
 *   ing.attr_set → applyIngAttrSet  给原料关联受控词条 Tag（词条 ID）+ 自定义营销 Tag
 *
 * 红线对齐（发版计划 §1）：
 *   - 纯函数优先，原地 mutate data（与 inventory.js 同手法），写库统一走 ctx.store（此处不涉及旁路表）。
 *   - 词条 / tags 存 JSON 快照（data.ing_terms / ings[].tags），补字段优先、不建 SQLite 表。
 *   - tag 不进任何成本 / 库存 / 损耗 / 毛利率口径（仅检索与渲染）。
 *   - 词条 ID 精确匹配（resolveTermIds），别名归一到同一词条 ID。
 */
const {
  TERM_CATEGORIES,
  TERM_STATUSES,
  seedTerms,
  isTermId,
  isCustomTag,
  termsOf,
  nextTermId,
  resolveTermIds,
} = require('../ing_terms');
const { nowIso, arr } = require('./util');

/** 确保 data.ing_terms 存在：首次写入时以 seed 初始化（写进快照成为持久化起点） */
function ensureTerms(data) {
  if (!Array.isArray(data.ing_terms)) data.ing_terms = seedTerms();
  return data.ing_terms;
}

/** 按 id / ing_id / name 定位原料（精确；不参与 resolveIngId 的别名/包含模糊，保持简单可控） */
function locateIng(data, payload) {
  const ings = arr(data && data.ings);
  const id = String((payload && (payload.id != null ? payload.id : payload.ing_id)) || '').trim();
  const name = String((payload && payload.name) || '').trim();
  if (!id && !name) return null;
  for (const g of ings) {
    if (id && String(g && g.id) === id) return g;
  }
  for (const g of ings) {
    if (!id && name && String(g && g.name) === name) return g;
  }
  return null;
}

/**
 * term.upsert：受控词条申请-审核-上架。
 *   payload: { id?, name, category, aliases?: string[], status? }
 *   - 无 id → 新建（name 在词表内唯一；status 缺省 pending = 待审核）
 *   - 有 id → 更新（仅显式传入的字段才改，缺省不动）
 */
function applyTermUpsert(data, payload) {
  if (!payload || typeof payload !== 'object') throw new Error('缺少词条载荷');
  const terms = ensureTerms(data);

  const name = String(payload.name || '').trim();
  const category = String(payload.category || '').trim();
  const id = String(payload.id || '').trim();

  if (!id && !name) throw new Error('缺少词条 id 或 name');
  if (!id && !category) throw new Error('新建词条必须指定 category（受控维度）');
  if (category && TERM_CATEGORIES.indexOf(category) < 0) {
    throw new Error('category 不在受控维度白名单内：' + category + '（允许：' + TERM_CATEGORIES.join('/') + '）');
  }
  if (payload.status != null && TERM_STATUSES.indexOf(payload.status) < 0) {
    throw new Error('status 非法：' + payload.status + '（允许：' + TERM_STATUSES.join('/') + '）');
  }

  // 别名归一化：去空、去重、剔除与标准名重复项
  let aliases = null;
  if (payload.aliases != null) {
    const set = new Set();
    for (const a of arr(payload.aliases)) {
      const s = String(a == null ? '' : a).trim();
      if (s && s !== name) set.add(s);
    }
    aliases = Array.from(set);
  }

  if (id) {
    const t = terms.find((x) => x && String(x.id) === id);
    if (!t) throw new Error('词条不存在：' + id);
    if (name) t.name = name;
    if (category) t.category = category;
    if (aliases) t.aliases = aliases;
    if (payload.status != null) t.status = payload.status;
    t._u = nowIso();
    return '词条更新 ' + t.id + ' ' + t.name + '（' + t.category + '）';
  }

  // 新建：name 唯一（归一后比较，避免「新疆」与「新疆产地」并存）
  const nk = String(name);
  const dup = terms.find((x) => x && String(x.name || '') === nk);
  if (dup) throw new Error('词条已存在：' + nk + '（' + dup.id + '）');

  const row = {
    id: nextTermId(terms),
    name: nk,
    category,
    aliases: aliases || [],
    status: payload.status || 'pending',
    _u: nowIso(),
  };
  terms.push(row);
  return '词条新建 ' + row.id + ' ' + row.name + '（' + row.category + '，' + (row.status === 'active' ? '已上架' : '待审核') + '）';
}

/**
 * ing.attr_set：给原料关联受控词条 Tag + 自定义营销 Tag。
 *   payload: { id|ing_id|name, tags: string[] }
 *   - tags 元素：受控词条 ID（T\d+，必须已存在于词表）或自定义字符串（营销 Tag，如「夏季清仓」）。
 *   - 空数组 / null → 清空 tags。
 *   - 只改 ings[].tags，不碰成本/库存/均价，不影响 recipe_cost 与 ing_alias。
 */
function applyIngAttrSet(data, payload) {
  if (!payload || typeof payload !== 'object') throw new Error('缺少属性载荷');
  const ing = locateIng(data, payload);
  if (!ing) throw new Error('未找到原料：' + (payload.id || payload.ing_id || payload.name || ''));

  const raw = payload.tags == null ? [] : (Array.isArray(payload.tags) ? payload.tags : [payload.tags]);
  const terms = termsOf(data);
  const allIds = new Set(terms.map((t) => t && String(t.id)));
  const activeIds = new Set(terms.filter((t) => t && String(t.status || 'active') === 'active').map((t) => String(t.id)));
  const out = [];
  for (const rawTag of raw) {
    const s = String(rawTag == null ? '' : rawTag).trim();
    if (!s) continue;
    if (isTermId(s)) {
      if (!allIds.has(s)) throw new Error('引用了不存在的词条 ID：' + s + '（请先在词条库申请）');
      if (!activeIds.has(s)) throw new Error('词条未上架，不能选用：' + s + '（请先在词条库审核上架）');
      out.push(s);
    } else if (isCustomTag(s)) {
      out.push(s);
    }
  }

  const uniq = Array.from(new Set(out));
  if (uniq.length) ing.tags = uniq;
  else delete ing.tags;
  ing._u = nowIso();
  return '原料属性已更新 ' + ing.id + ' ' + ing.name + '（tag ' + uniq.length + ' 项）';
}

module.exports = { applyTermUpsert, applyIngAttrSet, ensureTerms, locateIng };
