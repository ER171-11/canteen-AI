'use strict';
/*
 * lib/search.js — W5 检索域隔离 + 搜索索引字段白名单（竖切数据库，纯函数、零写库）
 *
 * 依据 docs/发版计划-下一版本_2026-10-19.md W5：
 *   · 业务域枚举：商品采购 / 财务税务 / 食安 / 员工 / 设备 / 销售
 *   · 只读检索端点 /api/search?domain=xxx&q=... 按域切分，不跨域混排
 *   · 索引字段白名单：仅索引名称/规格/标准属性等必要字段
 *   · 敏感字段（税号/供应商内部编码/成本价/金额/薪资/证号等）严禁进搜索索引
 *
 * 红线对齐：
 *   · 纯函数、零第三方依赖、不写库；数据只读自快照 data/ext。
 *   · 与 W2 检索契约合并：W2 = 域内词条 ID 精确匹配（ing_terms），W5 = 域间隔离 + 敏感字段管控。
 */

/* 敏感字段黑名单：无论白名单如何配置，这些字段永不进入搜索索引（双重保险）。
 * 覆盖：税号、供应商内部编码、成本价/均价、采购/应付/应收金额、薪资、身份证、银行账号、余额。 */
const SENSITIVE_FIELDS = new Set([
  'tax_no', 'tax', '税号', 'tax_id',
  'internal_code', '内部编码', 'inner_code',
  'avg', 'last', 'cost', 'cost_price', '成本', '成本价', '进价',
  'amount', 'amt', '金额', 'payable', 'receivable', 'balance', '应付', '应收', '余额',
  'salary', '薪资', '工资', 'pay',
  'id_card', '身份证', 'idcard',
  'bank_account', '银行卡', 'bank', '账户'
]);

/** 业务域枚举（稳定顺序，供前端 tab 渲染） */
const DOMAINS = ['procurement', 'finance', 'foodsafety', 'staff', 'equipment', 'sale'];

const DOMAIN_LABEL = {
  procurement: '商品采购',
  finance: '财务税务',
  foodsafety: '食安',
  staff: '员工',
  equipment: '设备',
  sale: '销售'
};

/**
 * 每个域的索引定义：sources = 数据源集合 + 白名单字段。
 *   key     集合在 data/ext 里的键名；dataKey 优先、extKey 兜底（与 supply.js 同口径）
 *   kind    结果类型标签（原料/菜谱/供应商/…）
 *   fields  白名单（仅这些字段可被检索，敏感字段不在此列）
 *   id/title/subtitle  命中结果渲染字段
 */
const DOMAIN_SOURCES = {
  procurement: [
    { dataKey: 'ings', extKey: null, kind: '原料', fields: ['name', 'cat', 'spec', 'sup', 'buy', 'pack', 'unit'], id: 'id', title: 'name', subtitle: ['cat', 'spec', 'sup'] },
    { dataKey: null, extKey: 'recipes', kind: '菜谱', fields: ['name', 'sku_id'], id: 'sku_id', title: 'name', subtitle: ['sku_id'] },
    { dataKey: 'vendors', extKey: 'sup_vendors', kind: '供应商', fields: ['name', 'category', 'contact', 'phone'], id: 'id', title: 'name', subtitle: ['category', 'contact'] },
    { dataKey: 'quotes', extKey: 'sup_prices', kind: '报价', fields: ['name', 'src', 'ing'], id: 'id', title: 'name', subtitle: ['src', 'ing'] }
  ],
  finance: [
    { dataKey: 'recv', extKey: null, kind: '进货单', fields: ['order_id', 'supplier', 'ref_no', 'status'], id: 'id', title: 'order_id', subtitle: ['supplier', 'ref_no'] },
    { dataKey: null, extKey: 'sup_accounts', kind: '往来账', fields: ['vendor_id', 'kind', 'ref_no'], id: 'id', title: 'vendor_id', subtitle: ['kind', 'ref_no'] },
    { dataKey: null, extKey: 'fin_invoices', kind: '发票', fields: ['invoice_no', 'type', 'status'], id: 'id', title: 'invoice_no', subtitle: ['type', 'status'] }
  ],
  foodsafety: [
    { dataKey: null, extKey: 'fs_certs', kind: '证照', fields: ['holder', 'type', 'cert_no'], id: 'id', title: 'holder', subtitle: ['type'] },
    { dataKey: null, extKey: 'fs_samples', kind: '留样', fields: ['dish', 'meal', 'keeper'], id: 'id', title: 'dish', subtitle: ['meal', 'keeper'] },
    { dataKey: null, extKey: 'fs_disinfect', kind: '消毒', fields: ['site', 'operator'], id: 'id', title: 'site', subtitle: ['operator'] }
  ],
  staff: [
    { dataKey: 'staff', extKey: 'staff_roster', kind: '员工', fields: ['name', 'role', 'phone', 'position'], id: 'id', title: 'name', subtitle: ['role', 'position'] }
  ],
  equipment: [
    { dataKey: null, extKey: 'eq_maintain', kind: '设备', fields: ['name', 'category', 'location', 'status'], id: 'id', title: 'name', subtitle: ['category', 'location'] }
  ],
  sale: [
    { dataKey: 'sales', extKey: 'sales', kind: '销售单', fields: ['order_no', 'dish', 'channel', 'status'], id: 'id', title: 'order_no', subtitle: ['dish', 'channel'] }
  ]
};

function arr(v) { return Array.isArray(v) ? v : []; }
function str(v) { return String(v == null ? '' : v); }
function qnorm(q) { return str(q).trim().toLowerCase(); }

/** 取 source 的集合：dataKey 优先、extKey 兜底（两者都为空则空数组） */
function collect(src, data, ext) {
  const d = (data && src.dataKey) ? arr(data[src.dataKey]) : [];
  const e = (ext && src.extKey) ? arr(ext[src.extKey]) : [];
  return d.length ? d : e;
}

/** 单条记录是否命中 query：遍历白名单字段（跳过敏感字段），返回命中字段名或 null */
function matchRow(rec, fields, q) {
  if (!rec || typeof rec !== 'object' || !q) return null;
  for (const f of fields) {
    if (SENSITIVE_FIELDS.has(f)) continue;   // 敏感字段永不进索引
    const v = rec[f];
    if (v == null || v === '') continue;
    if (str(v).toLowerCase().indexOf(q) >= 0) return f;
  }
  return null;
}

/** 检索单个域：返回 { domain, label, count, hits } */
function searchDomain(domain, q, ext, data) {
  const sources = DOMAIN_SOURCES[domain] || [];
  const qq = qnorm(q);
  const hits = [];
  for (const src of sources) {
    for (const rec of collect(src, data, ext)) {
      const matched = matchRow(rec, src.fields, qq);
      if (!matched) continue;
      hits.push({
        id: rec[src.id] != null ? str(rec[src.id]) : null,
        kind: src.kind,
        title: str(rec[src.title]),
        subtitle: (src.subtitle || []).map((f) => rec[f]).filter((x) => x != null && x !== '').join(' / '),
        matched_field: matched
      });
    }
  }
  return { domain, label: DOMAIN_LABEL[domain] || domain, count: hits.length, hits };
}

/** 全局检索：按域切分返回，不跨域混排（各 tab 独立） */
function searchAll(q, ext, data) {
  const qq = qnorm(q);
  const domains = {};
  let total = 0;
  for (const d of DOMAINS) {
    const r = searchDomain(d, qq, ext, data);
    domains[d] = r;
    total += r.count;
  }
  return { query: qq, total, domains, domain_order: DOMAINS };
}

/** 域白名单校验：请求的 domain 是否合法（非法 → null） */
function validDomain(d) {
  return DOMAINS.indexOf(d) >= 0 ? d : null;
}

module.exports = {
  DOMAINS,
  DOMAIN_LABEL,
  DOMAIN_SOURCES,
  SENSITIVE_FIELDS,
  validDomain,
  searchDomain,
  searchAll
};
