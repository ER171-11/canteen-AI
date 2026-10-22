'use strict';
/*
 * routes/search.js — W5 检索域隔离 + 搜索索引字段白名单（只读检索端点）
 *
 *   GET /api/search?q=xxx                 全局分域检索（各域独立 tab，不跨域混排）
 *   GET /api/search?domain=xxx&q=xxx      单域检索
 *   GET /api/search/domains               业务域枚举（供前端 tab 渲染）
 *
 * 红线①：GET 全为只读，零写库；敏感字段（税号/内部编码/成本价/金额/薪资等）由
 *        lib/search.js 的 SENSITIVE_FIELDS 黑名单 + 各域字段白名单双重隔离，绝不进索引。
 */
const { loadSnapshot } = require('./snapshot');
const searchLib = require('../lib/search');

function handle(req, res, ctx, pathname) {
  if (pathname.indexOf('/api/search') !== 0) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  /* 域枚举 */
  if (pathname === '/api/search/domains') {
    ctx.sendJSON(res, 200, {
      ok: true,
      domains: searchLib.DOMAINS.map((d) => ({ key: d, label: searchLib.DOMAIN_LABEL[d] }))
    });
    return true;
  }

  if (pathname === '/api/search') {
    const q = (ctx.query.get('q') || '').trim();
    const domain = (ctx.query.get('domain') || '').trim();
    const snap = loadSnapshot();
    const ext = (snap && snap.ext) || {};
    const data = (snap && snap.data) || {};
    const rev = snap ? snap.rev : null;

    if (!q) {
      ctx.sendJSON(res, 200, { ok: true, query: '', total: 0, domains: {}, domain_order: searchLib.DOMAINS, rev });
      return true;
    }

    if (domain) {
      const d = searchLib.validDomain(domain);
      if (!d) {
        ctx.sendJSON(res, 400, { ok: false, error: 'unknown domain: ' + domain, valid: searchLib.DOMAINS });
        return true;
      }
      ctx.sendJSON(res, 200, { ok: true, domain: d, result: searchLib.searchDomain(d, q, ext, data), rev });
      return true;
    }

    ctx.sendJSON(res, 200, Object.assign({ ok: true }, searchLib.searchAll(q, ext, data), { rev }));
    return true;
  }

  return false;
}

module.exports = { handle };
