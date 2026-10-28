'use strict';
/*
 * routes/supply.js — M10 供应链 模块 API
 *   数据源：店内快照 data.vendors | ext.sup_vendors / data.quotes | ext.sup_prices / ext.sup_accounts
 *
 *   GET  /api/supply/vendors            供应商档案（品类/状态/账期/评级）
 *   GET  /api/supply/vendor-terms       供应商类目受控词表（Phase 2，data.vendor_terms 优先）
 *   GET  /api/supply/compare            比价（同原料多供应商 + 价差）
 *   GET  /api/supply/accounts           往来账龄（0-30/31-60/>60/逾期）
 *   GET  /api/supply/overview           供应链看板汇总
 *   GET  /api/supply/config / POST      价差阈值/账龄分档/低评级线（BFF 本地配置，可配）
 *   POST /api/supply/vendor             供应商档案 upsert → vendor.upsert 入队
 *   POST /api/supply/vendor/delete      供应商档案删除 → vendor.delete 入队（有往来账禁删）
 *   POST /api/supply/vendor/term        类目词条申请/审核 → supplier_term.upsert 入队
 *   POST /api/supply/vendor/category    供应商类目设置 → vendor.attr_set 入队（受控单选）
 *   POST /api/supply/quote              供应商报价 → quote.upsert 入队
 *   POST /api/supply/po                 采购应付登记 → supply.po 入队
 *
 * 红线①：GET 全为只读；红线②：所有写操作一律 enqueue 进 actions 队列（经审批中心确认才落库）。
 */
const store = require('../lib/store');
const { enqueue } = require('./actions');
const { mayWriteActions } = require('../lib/auth');
const { loadSnapshot } = require('./snapshot');
const supply = require('../lib/supply');
const supTerms = require('../lib/supplier_terms');

const CONFIG_FILE = 'supply_config.json';

function trim(v) { return String(v == null ? '' : v).trim(); }

function loadExt() {
  const snap = loadSnapshot();
  return { snap, ext: (snap && snap.ext) || {}, data: (snap && snap.data) || {} };
}

/** 生效配置：BFF 本地配置 > 快照 data.config.supply > 默认 */
function effectiveConfig() {
  const local = store.readJSON(CONFIG_FILE, null);
  const snap = loadSnapshot();
  const snapCfg = (snap && snap.data && snap.data.config) || {};
  const patch = local ? { supply: local } : {};
  return Object.assign({}, snapCfg, patch);
}
function config() { return supply.configOf(effectiveConfig()); }

/* ---------------- 只读聚合 ---------------- */

function vendorsPayload() {
  const { ext, data, snap } = loadExt();
  const rep = supply.vendorsReport(ext, data, effectiveConfig());
  rep.ok = true; rep.rev = snap ? snap.rev : null;
  return rep;
}
function comparePayload() {
  const { ext, data, snap } = loadExt();
  const rep = supply.compareReport(ext, data, effectiveConfig());
  rep.ok = true; rep.rev = snap ? snap.rev : null;
  return rep;
}
function accountsPayload() {
  const { ext, snap } = loadExt();
  const rep = supply.accountsReport(ext, effectiveConfig(), Date.now());
  rep.ok = true; rep.rev = snap ? snap.rev : null;
  return rep;
}
function overviewPayload() {
  const { ext, data, snap } = loadExt();
  const rep = supply.overviewReport(ext, data, effectiveConfig(), Date.now());
  rep.ok = true; rep.rev = snap ? snap.rev : null;
  return rep;
}

/** 供应商类目词表（Phase 2）：data.vendor_terms 优先，缺失回退 seed；只读 */
function vendorTermsPayload() {
  const { data, snap } = loadExt();
  const terms = supTerms.termsOf(data);
  return {
    ok: true,
    scope: supTerms.SUP_CONFIG.scope,
    categories: supTerms.SUP_TERM_CATEGORIES,
    count: terms.length,
    terms: terms.map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category,
      aliases: Array.isArray(t.aliases) ? t.aliases : [],
      status: t.status || 'active',
    })),
    fallback_id: supTerms.SUP_FALLBACK_ID,
    source: (data && Array.isArray(data.vendor_terms) && data.vendor_terms.length) ? 'data' : 'seed',
    rev: snap ? snap.rev : null,
  };
}

/* ---------------- 写操作 ---------------- */

async function readJson(ctx, req) {
  try {
    const { buf } = await ctx.readBody(req);
    const b = JSON.parse(buf.toString('utf8'));
    return b && typeof b === 'object' ? b : {};
  } catch (e) { return {}; }
}
function operatorOf(ctx, body) {
  return (body && body.operator) || (ctx.auth && (ctx.auth.account || ctx.auth.role)) || null;
}
function doEnqueue(type, payload, operator, traceId) {
  const { action } = enqueue(type, payload, operator, traceId, {});
  return action && action.id;
}
function pickNum(v, d, min) {
  if (v == null || v === '' || isNaN(parseFloat(v))) return d;
  return Math.max(min == null ? -Infinity : min, parseFloat(v));
}

function handle(req, res, ctx, pathname) {
  if (pathname.indexOf('/api/supply') !== 0) return false;
  const m = req.method;

  /* ---------- 只读 ---------- */
  if (m === 'GET' || m === 'HEAD') {
    if (pathname === '/api/supply/vendors') { ctx.sendJSON(res, 200, vendorsPayload()); return true; }
    if (pathname === '/api/supply/vendor-terms') { ctx.sendJSON(res, 200, vendorTermsPayload()); return true; }
    if (pathname === '/api/supply/compare') { ctx.sendJSON(res, 200, comparePayload()); return true; }
    if (pathname === '/api/supply/accounts') { ctx.sendJSON(res, 200, accountsPayload()); return true; }
    if (pathname === '/api/supply/overview') { ctx.sendJSON(res, 200, overviewPayload()); return true; }
    if (pathname === '/api/supply/config') {
      const snap = loadSnapshot();
      ctx.sendJSON(res, 200, {
        ok: true,
        supply: config(),
        defaults: supply.DEFAULT_CONFIG,
        rev: snap ? snap.rev : null
      });
      return true;
    }
    return false;
  }

  if (m !== 'POST') return false;

  const write = [
    '/api/supply/config', '/api/supply/vendor', '/api/supply/vendor/delete',
    '/api/supply/vendor/term', '/api/supply/vendor/category',
    '/api/supply/quote', '/api/supply/po',
  ];
  if (write.indexOf(pathname) < 0) return false;
  if (!ctx.auth || !mayWriteActions(ctx.auth)) {
    ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' });
    return true;
  }

  (async () => {
    const body = await readJson(ctx, req);
    const snap = loadSnapshot();
    const rev = snap ? snap.rev : null;

    /* 配置可配 */
    if (pathname === '/api/supply/config') {
      const src = (body && (body.supply || body)) || {};
      const cur = config();
      const next = {
        spread_warn_pct: pickNum(src.spread_warn_pct, cur.spread_warn_pct, 0),
        aging_over30_d: Math.round(pickNum(src.aging_over30_d, cur.aging_over30_d, 1)),
        aging_over60_d: Math.round(pickNum(src.aging_over60_d, cur.aging_over60_d, 1)),
        low_level: pickNum(src.low_level, cur.low_level, 0)
      };
      if (!(next.aging_over30_d < next.aging_over60_d)) {
        ctx.sendJSON(res, 400, { ok: false, error: '账龄分档需满足 30 天档 < 60 天档', given: next });
        return;
      }
      store.writeJSON(CONFIG_FILE, Object.assign({}, next, { updated_at: new Date().toISOString(), by: operatorOf(ctx, body) }));
      ctx.sendJSON(res, 200, { ok: true, supply: next, rev });
      return;
    }

    /* 供应商档案 */
    if (pathname === '/api/supply/vendor') {
      const name = trim(body.name);
      const vid = trim(body.vendor_id || body.id);
      if (!name && !vid) { ctx.sendJSON(res, 400, { ok: false, error: 'name 或 vendor_id 至少一项必填' }); return; }
      const id = doEnqueue('vendor.upsert', {
        name: name || undefined,
        vendor_id: vid || undefined,
        contact: trim(body.contact) || undefined,
        phone: trim(body.phone) || undefined,
        category: trim(body.category) || undefined,
        level: body.level == null ? undefined : body.level,
        status: trim(body.status) || undefined,
        period: trim(body.period) || undefined,
        note: trim(body.note) || undefined,
        /* W3 产品超链接：资质证照（数组或 {类型:{...}} 映射，执行器 normalizeCerts 归一） */
        certs: body.certs != null ? body.certs : undefined,
        /* 编辑口径：显式空值也写回（清空联系人/电话/评级/备注）；old_name 供无编号档案改名时定位 */
        edit: body.edit === true,
        old_name: body.edit === true ? (trim(body.old_name) || undefined) : undefined
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: id, rev, note: '供应商档案已入队 → 审批中心确认' });
      return;
    }

    /* 供应商档案删除（有往来账禁删，执行器 vendor.delete 二次校验） */
    if (pathname === '/api/supply/vendor/delete') {
      const vid = trim(body.vendor_id || body.id);
      const name = trim(body.name);
      if (!vid && !name) { ctx.sendJSON(res, 400, { ok: false, error: 'vendor_id 或 name 至少一项必填' }); return; }
      const id = doEnqueue('vendor.delete', {
        vendor_id: vid || undefined,
        name: name || undefined
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: id, rev, note: '供应商删除已入队 → 审批中心确认' });
      return;
    }

    /* 供应商类目词条申请/审核/上架（Phase 2，→ supplier_term.upsert 入队） */
    if (pathname === '/api/supply/vendor/term') {
      const name = trim(body.name);
      const id = trim(body.id);
      if (!name && !id) { ctx.sendJSON(res, 400, { ok: false, error: 'name 或 id 至少一项必填' }); return; }
      const aliases = body.aliases == null
        ? undefined
        : (Array.isArray(body.aliases) ? body.aliases : String(body.aliases).split(/[,，/]/));
      const aid = doEnqueue('supplier_term.upsert', {
        id: id || undefined,
        name: name || undefined,
        category: trim(body.category) || undefined,
        aliases: aliases ? aliases.map(trim).filter(Boolean) : undefined,
        status: trim(body.status) || undefined,
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: aid, rev, note: '供应商类目词条已入队 → 审批中心确认' });
      return;
    }

    /* 供应商类目设置（受控单选：词条 ID / 标准名 / 别名 → vendor.attr_set 入队） */
    if (pathname === '/api/supply/vendor/category') {
      const vid = trim(body.vendor_id || body.id);
      const name = trim(body.name);
      if (!vid && !name) { ctx.sendJSON(res, 400, { ok: false, error: 'vendor_id 或 name 至少一项必填' }); return; }
      const aid = doEnqueue('vendor.attr_set', {
        vendor_id: vid || undefined,
        name: vid ? undefined : name,
        category: body.category == null ? '' : trim(body.category),
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: aid, rev, note: '供应商类目已入队 → 审批中心确认' });
      return;
    }

    /* 供应商报价 */
    if (pathname === '/api/supply/quote') {
      const ing = trim(body.ing || body.ing_id);
      const src = trim(body.src || body.supplier);
      if (!ing) { ctx.sendJSON(res, 400, { ok: false, error: 'ing 必填' }); return; }
      if (!src) { ctx.sendJSON(res, 400, { ok: false, error: 'src（供应商）必填' }); return; }
      if (body.price == null || isNaN(parseFloat(body.price))) { ctx.sendJSON(res, 400, { ok: false, error: 'price 必填且为数值' }); return; }
      const id = doEnqueue('quote.upsert', {
        ing,
        /* 原料名一并落快照：报价归属以 ing(原料 id) 为准，name 供「比价 / 原料比价」两表显示 */
        name: trim(body.name || body.ing_name) || undefined,
        src,
        price: parseFloat(body.price),
        per: trim(body.per) || undefined,
        unit: trim(body.unit) || undefined,
        note: trim(body.note) || undefined,
        set_default_sup: body.set_default_sup === true
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: id, rev, note: '报价已入队 → 审批中心确认' });
      return;
    }

    /* 采购应付登记 */
    if (pathname === '/api/supply/po') {
      const vendor = trim(body.vendor_id || body.supplier);
      if (!vendor) { ctx.sendJSON(res, 400, { ok: false, error: 'vendor_id/supplier 必填' }); return; }
      const amount = body.amount == null ? body.payable : body.amount;
      if (amount == null || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        ctx.sendJSON(res, 400, { ok: false, error: 'amount 必填且 > 0' });
        return;
      }
      const id = doEnqueue('supply.po', {
        vendor_id: vendor,
        amount: parseFloat(amount),
        ref_no: trim(body.ref_no || body.po_no) || undefined,
        ts: trim(body.ts) || undefined
      }, operatorOf(ctx, body), ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, action_id: id, rev, note: '采购应付登记已入队 → 审批中心确认' });
      return;
    }

    ctx.sendJSON(res, 404, { ok: false, error: 'not found' });
  })();

  return true;
}

module.exports = { handle };
