'use strict';
/*
 * routes/settle.js — 结算单模板（只读输出层的配置），仅此一个职责
 *   GET /api/settle/template            → 当前模板（文件缺失时返回默认）
 *   PUT /api/settle/template            → 保存模板，仅 老板/店长
 *
 * 红线核对：
 *   ④ 结算单是只读输出层，不写 DB —— 本路由只写「模板」这一个独立文件，
 *      不碰 snapshot.json、不碰 data.config、不走 actions 队列（模板不是业务数据）。
 *   结算单本身的生成全部在 admin-web 客户端完成（Blob / Canvas / iframe print），
 *      本路由不生成任何单据。
 *
 * 数据文件：bff/data/settle_template.json（与业务快照物理隔离）
 *   旧版存独立 localStorage key（见 store-inventory/docs/modules/结算单.md §4 ADR），
 *   新版改为 BFF 独立文件，理由：多端（admin-web / Android / iOS）共享同一模板，
 *   localStorage 换机器即丢。该偏离已记录为 ADR-003。
 */
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const store = require('../lib/store');

const FILE = 'settle_template.json';

/** 与旧版 DEF_SETTLE_TPL（旧 HTML:2088-2095）逐字段对齐 */
const DEFAULT_TPL = {
  title: '进货付款审批单',
  restName: '',
  addr: '',
  tel: '',
  taxNo: '',
  usePurpose: '采购货款',
  payeeName: '',
  payeeBank: '',
  payeeAccount: '',
  subjects: ['经办人', '审核人', '审批人'],
  footer: '本单一式两联：一联财务留存，一联随付款凭证归档。'
};

const KEYS = Object.keys(DEFAULT_TPL);

/**
 * 白名单清洗：只保留 KEYS 里的字段（未知字段一律丢弃），缺省补默认值。
 * 显式空串要保留（用户清空「抬头单位」是合法操作），只有 undefined 才回落默认。
 * subjects 允许用 / 、 , ， 分隔传入。
 */
function normalize(t) {
  const src = t && typeof t === 'object' ? t : {};
  const out = {};
  for (const k of KEYS) {
    if (k === 'subjects') continue;
    const v = src[k];
    out[k] = typeof v === 'string' ? v : v == null ? DEFAULT_TPL[k] : String(v);
  }
  let subs = src.subjects;
  if (typeof subs === 'string') subs = subs.split(/[\/、,，]/);
  if (!Array.isArray(subs)) subs = [];
  subs = subs.map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
  if (!subs.length) subs = DEFAULT_TPL.subjects.slice();
  out.subjects = subs;
  return out;
}

async function handle(req, res, ctx, pathname) {
  if (pathname !== '/api/settle/template') return false;

  if (req.method === 'GET') {
    const raw = store.readJSON(FILE, null);
    ctx.sendJSON(res, 200, {
      ok: true,
      template: normalize(raw),
      source: raw ? 'file' : 'default'
    });
    return true;
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    const role = ctx.auth ? ctx.auth.role : null;
    if (!role || auth.WRITE_ROLES.indexOf(role) < 0 || role === '只读') {
      ctx.sendJSON(res, 403, {
        ok: false,
        error: 'forbidden: 仅老板/店长可改结算单模板',
        role
      });
      return true;
    }
    const { buf } = await ctx.readBody(req);
    let body = null;
    try {
      body = JSON.parse(buf.toString('utf8'));
    } catch (e) {
      body = null;
    }
    if (!body || typeof body.template !== 'object' || body.template === null) {
      ctx.sendJSON(res, 400, { ok: false, error: 'missing template(object)' });
      return true;
    }
    const next = normalize(body.template);
    store.writeJSON(FILE, next);
    try {
      audit.write({
        ts: new Date().toISOString(),
        trace_id: ctx.traceId || null,
        method: req.method,
        path: pathname,
        role,
        status: 200,
        note: 'settle_template.update'
      });
    } catch (e) {
      /* 审计失败不影响主流程 */
    }
    ctx.sendJSON(res, 200, { ok: true, template: next });
    return true;
  }

  ctx.sendJSON(res, 405, { ok: false, error: 'method not allowed' });
  return true;
}

module.exports = { handle, DEFAULT_TPL, normalize, FILE };
