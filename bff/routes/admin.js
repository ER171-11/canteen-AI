'use strict';
/*
 * routes/admin.js — 管理后台（admin-web）骨架
 *   POST /api/admin/login          公开：同 auth/login，标记来源 admin-web
 *   GET  /api/admin/kimi-log?limit → kimi_log.jsonl 尾部
 *   GET  /api/admin/audit?limit    → audit.jsonl 尾部
 *   GET  /api/admin/config         → 当前配置（取自快照 data.config，无则默认），含 rest 餐厅名
 *   POST /api/admin/config         → 写配置走 actions 队列（type="config.update"），仅 老板/店长
 *   POST /api/admin/rest           → 写餐厅名走 actions 队列（type="rest.update"），仅 老板/店长
 *   GET  /api/admin/{dishes,recipes,staff,members,tables,vendors}
 *                                  → 只读，取自快照 data 对应 key，无则空数组
 */
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const { loadSnapshot } = require('./snapshot');
const { enqueue } = require('./actions');
const { dishSalesAgg, salesList } = require('./export');
const { priceReport, pricePlan } = require('../lib/price');

const READONLY_KEYS = ['dishes', 'recipes', 'staff', 'members', 'tables', 'vendors'];

const DEFAULT_CONFIG = {
  safety_stock: {},
  uniform_sop: '工服整洁 / 帽子 / 口罩 / 洗手消毒',
  plate_sop: '五色齐整，宫廷御膳点缀规范',
  note: '默认配置（快照未携带 config 模块）'
};

/* 旧版 DB.rest 默认餐厅名（抬头/结算单回落名） */
const DEFAULT_REST_NAME = '熊猫五福餐厅';

async function handle(req, res, ctx, pathname) {
  // 公开登录
  if (req.method === 'POST' && pathname === '/api/admin/login') {
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    if (!body || !String(body.account || '').trim()) {
      ctx.sendJSON(res, 400, { ok: false, error: 'missing account' });
      return true;
    }
    const r = auth.login(body.account, body.device_fp, 'admin-web', body.password);
    if (!r || r.error) {
      ctx.sendJSON(res, (r && r.status) || 401, { ok: false, error: (r && r.error) || 'login failed' });
      return true;
    }
    ctx.sendJSON(res, 200, Object.assign({ ok: true, source: 'admin-web' }, r));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/admin/kimi-log') {
    ctx.sendJSON(res, 200, { ok: true, items: audit.tail('kimi_log.jsonl', ctx.query.get('limit')) });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/admin/audit') {
    ctx.sendJSON(res, 200, { ok: true, items: audit.tail('audit.jsonl', ctx.query.get('limit')) });
    return true;
  }

  if (pathname === '/api/admin/config') {
    if (req.method === 'GET') {
      const snap = loadSnapshot();
      const fromSnap = !!(snap && snap.data && snap.data.config && typeof snap.data.config === 'object');
      const restRaw = snap && snap.data && typeof snap.data.rest === 'string' ? snap.data.rest.trim() : '';
      ctx.sendJSON(res, 200, {
        ok: true,
        config: fromSnap ? snap.data.config : DEFAULT_CONFIG,
        source: fromSnap ? 'snapshot' : 'default',
        rest: restRaw || DEFAULT_REST_NAME,
        rev: snap ? snap.rev : null
      });
      return true;
    }
    if (req.method === 'POST') {
      // RBAC：admin 写操作仅 老板/店长
      if (!ctx.auth || auth.WRITE_ROLES.indexOf(ctx.auth.role) < 0) {
        ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: 仅老板/店长可写配置', role: ctx.auth ? ctx.auth.role : null });
        return true;
      }
      const { buf } = await ctx.readBody(req);
      let body = null;
      try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
      if (!body || typeof body.config !== 'object' || body.config === null) {
        ctx.sendJSON(res, 400, { ok: false, error: 'missing config(object)' });
        return true;
      }
      const { action, dedup } = enqueue('config.update', body.config, ctx.auth.account, ctx.traceId);
      ctx.sendJSON(res, 200, {
        ok: true, queued: true, dedup,
        id: action.id, status: action.status, rev: action.rev,
        note: '配置写已进入 actions 队列，由店内消费器执行后生效'
      });
      return true;
    }
    return false;
  }

  // FP-SET-02：写餐厅名（顶层 data.rest，rest.update 动作）
  if (req.method === 'POST' && pathname === '/api/admin/rest') {
    // RBAC：admin 写操作仅 老板/店长
    if (!ctx.auth || auth.WRITE_ROLES.indexOf(ctx.auth.role) < 0) {
      ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: 仅老板/店长可写餐厅名', role: ctx.auth ? ctx.auth.role : null });
      return true;
    }
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    const name = String((body && body.name) || '').trim();
    if (!name) {
      ctx.sendJSON(res, 400, { ok: false, error: 'missing name(string)' });
      return true;
    }
    const { action, dedup } = enqueue('rest.update', { name }, ctx.auth.account, ctx.traceId);
    ctx.sendJSON(res, 200, {
      ok: true, queued: true, dedup,
      id: action.id, status: action.status, rev: action.rev,
      note: '餐厅名写已进入 actions 队列，由店内消费器执行后生效'
    });
    return true;
  }

  // FP-PRICE-01/02/03/13/14 原料比价只读聚合（本店均价 vs 外部报价，口径见 lib/price.js）
  if (req.method === 'GET' && pathname === '/api/admin/price') {
    const snap = loadSnapshot();
    ctx.sendJSON(res, 200, {
      ok: true,
      report: priceReport(snap),
      plan: pricePlan(snap),
      rev: snap ? snap.rev : null
    });
    return true;
  }

  /* FP-SALE-07 销售单列表（只读）。
   * 口径：应收/实收/欠款三数走 lib/sales_model（ADR-008 唯一口径源），
   * 与 `routes/report.js` 的店级聚合同源；本端点只做行级组装，不写库、不入队（红线①③）。 */
  if (req.method === 'GET' && pathname === '/api/admin/sales') {
    const snap = loadSnapshot();
    ctx.sendJSON(res, 200, salesList(snap));
    return true;
  }

  // 只读业务端点
  const m = pathname.match(/^\/api\/admin\/([a-z]+)$/);
  if (m && READONLY_KEYS.indexOf(m[1]) >= 0) {
    if (req.method !== 'GET') return false;
    const key = m[1];
    const snap = loadSnapshot();
    const arr = snap && snap.data && Array.isArray(snap.data[key]) ? snap.data[key] : [];
    let items = arr;
    // FP-DISH-11/12：菜品列表附带近 30 天销量/毛利额（只读聚合，口径见 export.dishSalesAgg）
    if (key === 'dishes') {
      const agg = dishSalesAgg(snap);
      items = arr.map((d) => {
        if (!d || typeof d !== 'object') return d;
        const h = (d.id != null ? agg.byId[String(d.id)] : null)
          || (d.name != null ? agg.byName[String(d.name)] : null)
          || { q30: 0, gp30: 0 };
        return Object.assign({}, d, { q30: h.q30, gp30: h.gp30 });
      });
    }
    ctx.sendJSON(res, 200, { ok: true, key, count: items.length, items, rev: snap ? snap.rev : null });
    return true;
  }

  return false;
}

module.exports = { handle };
