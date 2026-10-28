'use strict';
/*
 * lib/terms_core.js — 通用受控词表 Tag 内核（两轨制，领域无关）
 *
 * 背景：W2 原实现（lib/ing_terms.js）把「受控词条 ID + 自定义营销 Tag」写死在原料域。
 *       本模块把机制抽成纯函数内核，任何领域（原料 / 供应商 / 菜品…）按同一套机制调用：
 *         term{ id, name, category, aliases[], status }
 *         - name      词条标准名（领域内唯一）
 *         - category  受控维度（按 config.categories 白名单校验；null=不限制）
 *         - aliases[] 别名归一（「新疆 / 新疆产地 / 产自新疆」→ 同一词条 ID）
 *         - status    pending（申请）→ active（上架）/ rejected（驳回）
 *       打标支持两轨：受控词条 ID（config.idPrefix + 数字）+ 自定义标签（可选开关）。
 *
 * 红线（与 W2 一致，不得违反）：
 *   - 纯函数、零第三方依赖、不写库；tags 只读渲染 / 检索，不进成本 / 库存 / 损耗 / 毛利率口径。
 *   - 不读全局、不反向依赖任何业务模块；terms 数组与 config 全部由调用方显式传入。
 *
 * 设计要点：
 *   - scope 只作标识与文案，不做持久化字段；领域隔离靠「传入哪一套 terms 数组」表达。
 *   - mode 单选/多选、allowCustom 自定义开关均为参数，默认值保持原料域现状（multiple + 允许自定义）。
 */

/** 默认配置：与原料域现状对齐，保证不传 config 时行为不变 */
const DEFAULT_CONFIG = {
  scope: 'generic',
  categories: null,            // null = 不做受控维度白名单校验
  statuses: ['pending', 'active', 'rejected'],
  idPrefix: 'T',
  customCategory: '自定义',
};

/** 归一配置：补默认值，categories / statuses 允许调用方覆盖 */
function cfgOf(config) {
  const c = config || {};
  return {
    scope: c.scope || DEFAULT_CONFIG.scope,
    categories: Array.isArray(c.categories) ? c.categories : null,
    statuses: (Array.isArray(c.statuses) && c.statuses.length)
      ? c.statuses
      : DEFAULT_CONFIG.statuses.slice(),
    idPrefix: c.idPrefix || DEFAULT_CONFIG.idPrefix,
    customCategory: c.customCategory || DEFAULT_CONFIG.customCategory,
  };
}

/** 转义正则元字符，供 idPrefix 拼 ID 正则用 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 词条 ID 正则（按 config.idPrefix 生成） */
function idRe(config) {
  const cfg = cfgOf(config);
  return new RegExp('^' + escapeRe(cfg.idPrefix) + '\\d+$');
}

/** 取词表：raw 为非空数组则用它，否则回退 seed（函数或数组；只读兜底不写库） */
function listTerms(raw, seed) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length) return list;
  if (typeof seed === 'function') return seed();
  return Array.isArray(seed) ? seed : [];
}

/** 归一词条名 / 别名：去首尾空白 + 折叠内部连续空白（不自动变换语义，别名靠受控 aliases 维护） */
function normalizeName(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '').trim();
}

/** 是否为词条 ID 形态（config.idPrefix + 数字） */
function isTermId(v, config) {
  return typeof v === 'string' && idRe(config).test(v.trim());
}

/** 是否自定义标签（非空且不是词条 ID） */
function isCustomTag(v, config) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return s !== '' && !idRe(config).test(s);
}

/** 下一个词条 ID：现有同前缀最大数字 + 1，无则前缀 + 1（与 W2 原实现同口径，不补零） */
function nextId(terms, config) {
  const cfg = cfgOf(config);
  const re = idRe(cfg);
  const nums = [];
  for (const t of Array.isArray(terms) ? terms : []) {
    const s = String((t && t.id) || '');
    if (re.test(s)) nums.push(parseInt(s.slice(cfg.idPrefix.length), 10));
  }
  return cfg.idPrefix + (nums.length ? Math.max(...nums) + 1 : 1);
}

/** 构建 name / alias → id 索引（受控维度内精确匹配，别名归一到同一词条 ID） */
function buildIndex(terms) {
  const idx = new Map();
  for (const t of Array.isArray(terms) ? terms : []) {
    if (!t || !t.id) continue;
    const keys = [String(t.name || '')];
    if (Array.isArray(t.aliases)) for (const a of t.aliases) keys.push(String(a));
    for (const k of keys) {
      const nk = normalizeName(k);
      if (nk) idx.set(nk, String(t.id));
    }
  }
  return idx;
}

/**
 * 把用户输入（字符串或数组）归一为标准词条 ID 数组（去重、丢弃未命中项）。
 * 精确匹配顺序：词条 ID → 标准名 → 别名（均先 normalizeName）。
 * 未命中（普通自定义标签 / 不存在的词）返回原样字符串，交由调用方按「自定义标签」处理。
 */
function resolveIds(input, terms, config) {
  const cfg = cfgOf(config);
  const list = Array.isArray(input) ? input : [input];
  const idx = buildIndex(terms);
  const out = [];
  for (const raw of list) {
    const s = String(raw == null ? '' : raw);
    if (!s) continue;
    const t = s.trim();
    if (idRe(cfg).test(t)) {
      out.push(t);
      continue;
    }
    const hit = idx.get(normalizeName(t));
    if (hit) out.push(hit);
    else out.push(t); // 未命中 → 视为自定义标签原样保留
  }
  return Array.from(new Set(out));
}

/** 词条 ID 精确命中：query 归一出的词条 ID 是否落在 tags 里（含别名归一） */
function matchTags(query, tags, terms, config) {
  const cfg = cfgOf(config);
  const list = Array.isArray(tags) ? tags : [];
  const wanted = resolveIds(query, terms, cfg).filter((v) => isTermId(v, cfg));
  if (!wanted.length) return [];
  const hitIds = new Set();
  for (const tag of list) {
    const id = resolveIds(tag, terms, cfg)[0];
    if (id && wanted.indexOf(id) >= 0) hitIds.add(id);
  }
  return Array.from(hitIds);
}

/**
 * 单值展开：把一个 tag（词条 ID / 自定义标签）展开为可展示对象；空值返回 null。
 * 供标量字段（如 vendor.category 单选）直接渲染，与 flattenTags 同一口径。
 */
function flattenOne(raw, terms, config) {
  const cfg = cfgOf(config);
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  let term = null;
  if (idRe(cfg).test(s)) {
    for (const t of Array.isArray(terms) ? terms : []) {
      if (t && String(t.id) === s) { term = t; break; }
    }
  }
  return term
    ? { id: term.id, name: term.name, category: term.category, aliases: term.aliases || [], isTerm: true }
    : { id: s, name: s, category: cfg.customCategory, aliases: [], isTerm: false };
}

/** 把 tags 展开为可展示对象（供前端渲染 / 高亮）；入参兼容数组与单值 */
function flattenTags(tags, terms, config) {
  const list = Array.isArray(tags) ? tags : (tags == null || tags === '' ? [] : [tags]);
  return list.map((raw) => flattenOne(raw, terms, config)).filter(Boolean);
}

/**
 * 打标：把 rawTags 校验后写回 entity[field]（默认 tags）。
 *   opts.mode         'multiple'（默认，多值）| 'single'（单值，超限抛错）
 *   opts.allowCustom  true（默认，允许自定义标签）| false（只接受受控词条 ID）
 *   opts.scalar       true → 写标量字符串（如 vendor.category）而非数组；默认 false 写数组
 *   opts.field        写入字段名，默认 'tags'
 *   opts.config       领域配置（scope/categories/statuses/idPrefix/customCategory）
 * 返回 { count, ids }；空数组 / null → 清空字段（delete entity[field]）。
 * 只改实体标签字段，不碰成本 / 库存 / 均价。
 */
function applyTags(entity, rawTags, terms, opts) {
  if (!entity || typeof entity !== 'object') throw new Error('缺少打标目标实体');
  const o = opts || {};
  const cfg = cfgOf(o.config);
  const field = o.field || 'tags';
  const mode = o.mode === 'single' ? 'single' : 'multiple';
  const allowCustom = o.allowCustom !== false;

  const raw = rawTags == null ? [] : (Array.isArray(rawTags) ? rawTags : [rawTags]);
  const list = Array.isArray(terms) ? terms : [];
  const allIds = new Set(list.map((t) => t && String(t.id)));
  const activeIds = new Set(
    list.filter((t) => t && String(t.status || 'active') === 'active').map((t) => String(t.id))
  );

  const out = [];
  for (const rawTag of raw) {
    const s = String(rawTag == null ? '' : rawTag).trim();
    if (!s) continue;
    if (isTermId(s, cfg)) {
      if (!allIds.has(s)) throw new Error('引用了不存在的词条 ID：' + s + '（请先在词条库申请）');
      if (!activeIds.has(s)) throw new Error('词条未上架，不能选用：' + s + '（请先在词条库审核上架）');
      out.push(s);
    } else if (isCustomTag(s, cfg)) {
      if (!allowCustom) throw new Error('该领域不允许自定义标签：' + s + '（请改用受控词条）');
      out.push(s);
    }
  }

  const uniq = Array.from(new Set(out));
  if (mode === 'single' && uniq.length > 1) {
    throw new Error('单选领域只能关联 1 个词条（收到 ' + uniq.length + ' 项）');
  }

  /* scalar：标量字段（如 vendor.category）只落字符串；数组字段同旧行为 */
  if (uniq.length) entity[field] = o.scalar === true ? uniq[0] : uniq;
  else delete entity[field];
  return { count: uniq.length, ids: uniq };
}

/**
 * 词条申请 / 审核 / 上架 / 改名 / 改别名（原地 mutate terms 数组）。
 *   payload: { id?, name, category, aliases?: string[], status? }
 *   - 无 id → 新建（name 在词表内唯一；status 缺省 pending = 待审核）
 *   - 有 id → 更新（仅显式传入的字段才改，缺省不动）
 * 返回 { id, name, category, status, created }。
 * 校验规则与报错文案与 W2 原实现保持一致（既有测试以正则断言文案片段）。
 */
function upsertTerm(terms, payload, config) {
  if (!Array.isArray(terms)) throw new Error('缺少词表数组');
  if (!payload || typeof payload !== 'object') throw new Error('缺少词条载荷');
  const cfg = cfgOf(config);

  const name = String(payload.name || '').trim();
  const category = String(payload.category || '').trim();
  const id = String(payload.id || '').trim();

  if (!id && !name) throw new Error('缺少词条 id 或 name');
  if (!id && !category) throw new Error('新建词条必须指定 category（受控维度）');
  if (category && cfg.categories && cfg.categories.indexOf(category) < 0) {
    throw new Error('category 不在受控维度白名单内：' + category + '（允许：' + cfg.categories.join('/') + '）');
  }
  if (payload.status != null && cfg.statuses.indexOf(payload.status) < 0) {
    throw new Error('status 非法：' + payload.status + '（允许：' + cfg.statuses.join('/') + '）');
  }

  // 别名归一化：去空、去重、剔除与标准名重复项
  let aliases = null;
  if (payload.aliases != null) {
    const set = new Set();
    const arrA = Array.isArray(payload.aliases) ? payload.aliases : [payload.aliases];
    for (const a of arrA) {
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
    return { id: t.id, name: t.name, category: t.category, status: t.status, created: false };
  }

  // 新建：name 唯一（避免「新疆」与「新疆产地」并存）
  const dup = terms.find((x) => x && String(x.name || '') === name);
  if (dup) throw new Error('词条已存在：' + name + '（' + dup.id + '）');

  const row = {
    id: nextId(terms, cfg),
    name,
    category,
    aliases: aliases || [],
    status: payload.status || 'pending',
    _u: nowIso(),
  };
  terms.push(row);
  return { id: row.id, name: row.name, category: row.category, status: row.status, created: true };
}

/** ISO 时间戳（与 lib/algorithms/util.js 的 nowIso 同格式，保持内核零依赖） */
function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  DEFAULT_CONFIG,
  cfgOf,
  idRe,
  listTerms,
  normalizeName,
  isTermId,
  isCustomTag,
  nextId,
  buildIndex,
  resolveIds,
  matchTags,
  flattenOne,
  flattenTags,
  applyTags,
  upsertTerm,
};
