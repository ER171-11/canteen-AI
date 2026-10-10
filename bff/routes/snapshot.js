'use strict';
/*
 * routes/snapshot.js — 店内整库快照的推送与读取（云端只存快照，不写店内 DB）
 *   POST /api/snapshot/push  {rev, data, ext?, machine}（机体 >5MB 拒收 413）
 *                            → 存 data/snapshot.json {rev, generated_at, size, data, ext}
 *   GET  /api/snapshot/latest?module= → {rev, generated_at, size, data, ext}
 *        module 按顶层 key 过滤 data 子集（?module=dishes）；
 *        module=ext.* 过滤 ext 子集（?module=ext.recipes 只回 ext.recipes）；
 *        无快照 404 {ok:false,error:"no snapshot"}
 */
const store = require('../lib/store');

const MAX_BODY = 5 * 1024 * 1024; // 5MB

function loadSnapshot() {
  const s = store.readJSON('snapshot.json', null);
  return (s && typeof s === 'object' && s.data !== undefined) ? s : null;
}

/** 菜谱列（main/aux/seasoning）是否有实质内容：非空数组 / 非空字符串 */
function recipeColTruthy(col) {
  if (col == null) return false;
  if (typeof col === 'string') {
    const t = col.trim();
    return t.length > 0 && t !== '[]' && t !== '""';
  }
  if (Array.isArray(col)) return col.length > 0;
  return true;
}

/**
 * 给 dishes 标记 has_recipe（是否配了配方）：收银端据此在结账前提示
 * 「未配配方菜品不会扣减原料库存」。匹配口径对齐 pos.js::recipeBomLines：
 * sku_id（或 dish.id）优先、name 兜底；main/aux/seasoning 至少一列有料才算有配方。
 * ext.recipes 缺失/为空时不标记（默认视为有配方），避免全店误报。
 */
function markRecipeStatus(dishes, ext) {
  const list = Array.isArray(dishes) ? dishes : [];
  const recipes = ext && Array.isArray(ext.recipes) ? ext.recipes : null;
  if (!recipes || !recipes.length) return list;
  const bySku = new Map();
  const byName = new Map();
  for (const r of recipes) {
    if (!r || typeof r !== 'object') continue;
    if (r.sku_id != null && String(r.sku_id) !== '') bySku.set(String(r.sku_id), r);
    if (r.name != null && String(r.name) !== '') byName.set(String(r.name), r);
  }
  return list.map((d) => {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return d;
    const sku = String(d.sku_id || d.id || '');
    const nm = String(d.name || '');
    const row = bySku.get(sku) || byName.get(nm) || null;
    let has = true;
    if (!row) {
      has = false;
    } else {
      has = recipeColTruthy(row.main) || recipeColTruthy(row.aux) || recipeColTruthy(row.seasoning);
    }
    return Object.assign({}, d, { has_recipe: has });
  });
}

async function handle(req, res, ctx, pathname) {
  if (req.method === 'POST' && pathname === '/api/snapshot/push') {
    const cl = parseInt(req.headers['content-length'] || '0', 10);
    if (cl > MAX_BODY) {
      ctx.sendJSON(res, 413, { ok: false, error: 'payload too large (>' + MAX_BODY + ' bytes)' });
      return true;
    }
    const { tooLarge, buf } = await ctx.readBody(req, MAX_BODY);
    if (tooLarge) {
      ctx.sendJSON(res, 413, { ok: false, error: 'payload too large (>' + MAX_BODY + ' bytes)' });
      return true;
    }
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    if (!body || typeof body.rev !== 'number' || !body.data || typeof body.data !== 'object') {
      ctx.sendJSON(res, 400, { ok: false, error: 'missing rev(number) or data(object)' });
      return true;
    }
    if (body.ext !== undefined &&
        (typeof body.ext !== 'object' || body.ext === null || Array.isArray(body.ext))) {
      ctx.sendJSON(res, 400, { ok: false, error: 'ext must be an object' });
      return true;
    }
    const snap = {
      rev: body.rev,
      generated_at: new Date().toISOString(),
      size: buf.length,
      machine: body.machine || null,
      data: body.data,
      ext: body.ext === undefined ? null : body.ext
    };
    store.writeJSON('snapshot.json', snap);
    ctx.sendJSON(res, 200, { ok: true, rev: snap.rev, size: snap.size, generated_at: snap.generated_at });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/snapshot/latest') {
    const snap = loadSnapshot();
    if (!snap) {
      ctx.sendJSON(res, 404, { ok: false, error: 'no snapshot' });
      return true;
    }
    const mod = (ctx.query.get('module') || '').trim();
    let data = snap.data;
    let ext = snap.ext === undefined ? null : snap.ext;

    // 堂食 dishes ∪ 保本价盘（类型/售价/成本），收银与后厨同源
    try {
      const { mergeDishesWithBaoben } = require('../lib/menu_baoben');
      if (data && typeof data === 'object') {
        const merged = mergeDishesWithBaoben(Array.isArray(data.dishes) ? data.dishes : []);
        data = Object.assign({}, data, { dishes: markRecipeStatus(merged.dishes, ext) });
      }
    } catch (e) { /* optional */ }

    if (mod) {
      if (mod.indexOf('ext.') === 0) {
        // ext.* 过滤：只回 ext 的指定子集
        const k = mod.slice(4);
        data = null;
        const sub = {};
        if (ext && Object.prototype.hasOwnProperty.call(ext, k)) sub[k] = ext[k];
        ext = sub;
      } else {
        const full = data;
        data = {};
        if (full && Object.prototype.hasOwnProperty.call(full, mod)) data[mod] = full[mod];
        ext = null;
      }
    }
    ctx.sendJSON(res, 200, {
      ok: true,
      rev: snap.rev,
      generated_at: snap.generated_at,
      size: snap.size,
      data,
      ext
    });
    return true;
  }

  return false;
}

module.exports = { handle, loadSnapshot, markRecipeStatus };
