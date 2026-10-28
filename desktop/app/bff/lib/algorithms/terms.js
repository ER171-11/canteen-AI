'use strict';
/*
 * lib/algorithms/terms.js — 受控词表写侧算法（Node 超集，无 Python 对拍）
 *
 *   term.upsert          → applyTermUpsert        词条申请 / 审核 / 上架 / 改名 / 改别名
 *   ing.attr_set         → applyIngAttrSet        给原料关联受控词条 Tag（词条 ID）+ 自定义营销 Tag
 *   supplier_term.upsert → applyVendorTermUpsert  供应商类目词条申请 / 审核 / 上架（Phase 2）
 *   vendor.attr_set      → applyVendorAttrSet     给供应商设置受控类目（单选标量，禁自定义）
 *   vendor_term.backfill → applyVendorTermBackfill 存量 vendor.category 自由文本 → 词条 ID 归一
 *
 * 重构说明：通用机制已抽到 lib/terms_core.js；本文件只保留领域知识，
 *           校验规则与返回文案保持与改造前一致（既有测试以正则断言文案片段）。
 *
 * 红线对齐（发版计划 §1）：
 *   - 纯函数优先，原地 mutate data（与 inventory.js 同手法），写库统一走 ctx.store（此处不涉及旁路表）。
 *   - 词条 / tags 存 JSON 快照（data.ing_terms / data.vendor_terms / ings[].tags / vendors[].category），
 *     补字段优先、不建 SQLite 表。
 *   - tag / 类目不进任何成本 / 库存 / 损耗 / 毛利率口径（仅检索与渲染）。
 *   - 词条 ID 精确匹配（resolveTermIds），别名归一到同一词条 ID。
 */
const { seedTerms, termsOf, ING_CONFIG } = require('../ing_terms');
const supTerms = require('../supplier_terms');
const core = require('../terms_core');
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
  const r = core.upsertTerm(terms, payload, ING_CONFIG);

  if (r.created) {
    return '词条新建 ' + r.id + ' ' + r.name + '（' + r.category + '，'
      + (r.status === 'active' ? '已上架' : '待审核') + '）';
  }
  return '词条更新 ' + r.id + ' ' + r.name + '（' + r.category + '）';
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

  const terms = termsOf(data);
  const r = core.applyTags(ing, payload.tags, terms, {
    mode: 'multiple',
    allowCustom: true,
    field: 'tags',
    config: ING_CONFIG,
  });

  ing._u = nowIso();
  return '原料属性已更新 ' + ing.id + ' ' + ing.name + '（tag ' + r.count + ' 项）';
}

/* ==================== Phase 2：供应商类目受控词表 ==================== */

/** 确保 data.vendor_terms 存在：首次写入时以 seed 初始化（写进快照成为持久化起点） */
function ensureVendorTerms(data) {
  if (!Array.isArray(data.vendor_terms)) data.vendor_terms = supTerms.seedTerms();
  return data.vendor_terms;
}

/**
 * 供应商档案并集：data.vendors（旧口径） + ext.sup_vendors / store（新表口径）。
 * 只用于定位与就地改字段；写库同步走 ctx.store.upsert（与 upsertVendor 同手法）。
 */
function vendorRowsOf(data, ctx) {
  const out = [];
  const push = (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return;
    if (out.indexOf(v) < 0) out.push(v);
  };
  for (const v of arr(data && data.vendors)) push(v);
  const ext = (ctx && ctx.store && ctx.store.ext) || null;
  for (const v of arr(ext && ext.sup_vendors)) push(v);
  return out;
}

/** 按 vendor_id / id / name 定位供应商档案（与列表口径同源并集） */
function locateVendor(data, payload, ctx) {
  const keys = [];
  for (const k of [payload && payload.vendor_id, payload && payload.id, payload && payload.name]) {
    const s = String(k == null ? '' : k).trim();
    if (s && keys.indexOf(s) < 0) keys.push(s);
  }
  if (!keys.length) return null;
  for (const v of vendorRowsOf(data, ctx)) {
    for (const k of [v.vendor_id, v.id, v.name]) {
      const s = String(k == null ? '' : k).trim();
      if (s && keys.indexOf(s) >= 0) return v;
    }
  }
  return null;
}

/**
 * supplier_term.upsert：供应商类目词条申请-审核-上架。
 *   payload: { id?, name, category?, aliases?: string[], status? }
 *   - category 缺省按供应商域唯一维度「供应商类目」补齐，前端只需传 name。
 */
function applyVendorTermUpsert(data, payload) {
  if (!payload || typeof payload !== 'object') throw new Error('缺少词条载荷');
  const terms = ensureVendorTerms(data);
  const body = Object.assign({}, payload);
  if (!body.id && !body.category) body.category = supTerms.SUP_TERM_CATEGORIES[0];
  const r = core.upsertTerm(terms, body, supTerms.SUP_CONFIG);

  if (r.created) {
    return '供应商类目词条新建 ' + r.id + ' ' + r.name + '（'
      + (r.status === 'active' ? '已上架' : '待审核') + '）';
  }
  return '供应商类目词条更新 ' + r.id + ' ' + r.name;
}

/**
 * vendor.attr_set：给供应商设置受控类目（单选标量）。
 *   payload: { vendor_id|id|name, category }
 *   - category 接受词条 ID / 标准名 / 别名（别名归一）；不允许自定义文本（落「其他」兜底）；
 *   - 空字符串 / null → 清空类目；
 *   - 只改 vendors[].category（词条 ID 标量），不动成本 / 库存 / 往来账。
 */
function applyVendorAttrSet(data, payload, ctx) {
  if (!payload || typeof payload !== 'object') throw new Error('缺少属性载荷');
  const v = locateVendor(data, payload, ctx);
  if (!v) {
    throw new Error('未找到供应商：'
      + (payload.vendor_id || payload.id || payload.name || ''));
  }

  const terms = ensureVendorTerms(data);
  const raw = payload.category != null ? payload.category
    : (payload.cat != null ? payload.cat
      : (payload.category_id != null ? payload.category_id : payload.term));
  const resolved = raw == null || String(raw).trim() === ''
    ? { id: null, name: null, matched: false }
    : supTerms.resolveCategory(raw, terms);

  const r = core.applyTags(v, resolved.id ? [resolved.id] : [], terms, {
    mode: 'single',
    allowCustom: false,
    scalar: true,       // vendor.category 是标量字段（不是数组）
    field: 'category',
    config: supTerms.SUP_CONFIG,
  });

  const vid = String(v.vendor_id || v.id || '').trim();
  v._u = nowIso();
  /* 新表口径同步（ext 源时同一数组引用已改；sqlite 源需 upsert 落库） */
  if (vid && ctx && ctx.store && typeof ctx.store.upsert === 'function') {
    ctx.store.upsert('sup_vendors', {
      vendor_id: vid,
      category: r.ids.length ? r.ids[0] : null,
      updated_at: v._u,
    }, ['vendor_id']);
  }

  if (!r.ids.length) return '供应商类目已清空 ' + (vid || v.name);
  const label = supTerms.resolveCategory(r.ids[0], terms);
  /* 未命中词条的自由文本落「其他」：回执里留原文，避免脏数据被静默吞掉 */
  const note = resolved.matched === false
    ? '，原文「' + resolved.input + '」未匹配词条已归入「其他」'
    : '';
  return '供应商类目已更新 ' + (vid || v.name) + '（' + r.ids[0] + ' '
    + (label.name || r.ids[0]) + note + '）';
}

/**
 * vendor_term.backfill：存量 vendor.category 自由文本 → 词条 ID 归一（幂等）。
 *   - 已归一（值即词条 ID）→ 跳过，可反复执行；
 *   - 命中标准名 / 别名 → 写词条 ID；
 *   - 未命中 → 落兜底词条「其他」并在回执里计数（不静默吞掉脏数据）。
 * 只改档案类目字段，不动价格 / 库存 / 往来账。
 */
function applyVendorTermBackfill(data, ctx) {
  const terms = ensureVendorTerms(data);
  let changed = 0;
  let fallback = 0;
  let skipped = 0;

  for (const v of vendorRowsOf(data, ctx)) {
    const raw = String(v.category == null ? '' : v.category).trim();
    if (!raw) { skipped += 1; continue; }
    const r = supTerms.resolveCategory(raw, terms);
    if (!r.id) { skipped += 1; continue; }
    if (raw === r.id) { skipped += 1; continue; }

    v.category = r.id;
    v._u = nowIso();
    changed += 1;
    if (!r.matched) fallback += 1;

    const vid = String(v.vendor_id || v.id || '').trim();
    if (vid && ctx && ctx.store && typeof ctx.store.upsert === 'function') {
      ctx.store.upsert('sup_vendors', { vendor_id: vid, category: r.id, updated_at: v._u }, ['vendor_id']);
    }
  }

  return '供应商类目归一完成：更新 ' + changed + ' 家（其中未匹配归入「其他」'
    + fallback + ' 家，已归一/空值跳过 ' + skipped + ' 家）';
}

module.exports = {
  applyTermUpsert,
  applyIngAttrSet,
  ensureTerms,
  locateIng,
  /* Phase 2：供应商类目受控词表 */
  ensureVendorTerms,
  vendorRowsOf,
  locateVendor,
  applyVendorTermUpsert,
  applyVendorAttrSet,
  applyVendorTermBackfill,
};
