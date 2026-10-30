'use strict';
/*
 * routes/snapshot.js — 店内整库快照的推送与读取（云端只存快照，不写店内 DB）
 *   POST /api/snapshot/push  {rev, data, ext?, machine}（机体 >5MB 拒收 413）
 *                            → 存 data/snapshot.json {rev, generated_at, size, data, ext}
 *   GET  /api/snapshot/latest?module= → {rev, generated_at, size, data, ext}
 *        module 按顶层 key 过滤 data 子集（?module=dishes）；
 *        module=ext.* 过滤 ext 子集（?module=ext.recipes 只回 ext.recipes）；
 *        无快照 404 {ok:false,error:"no snapshot"}
 *
 * 服务端快照备份（FP-SET-07 手动打快照，形态见 ADR-009 §2.1）：
 *   POST /api/snapshot/backup      打完当前快照 → data/snapshots/<id>.json + index.json（仅老板/店长）
 *   GET  /api/snapshot/backups     备份列表（只读元信息，倒序）
 *   GET  /api/snapshot/backup?id=  读某份备份的**全文**（只读；供下载/后续回滚取数）
 *   红线：只写 data/snapshots/ 下的备份文件，**不写业务库、不入队**；回滚（FP-SET-10）不当场执行，
 *        须走 POST /api/actions 审批队列（ADR-009 §2.2）。
 */
const { getAdapter } = require('../lib/store-adapter');
const snapshotStore = require('../lib/snapshot_store');
const snapshotAlgo = require('../lib/algorithms/snapshot');
const importStore = require('../lib/import_store');
const baselineStore = require('../lib/baseline_store');
const schema = require('../lib/schema');
const { enqueue } = require('./actions');

const MAX_BODY = 5 * 1024 * 1024; // 5MB
/* W4-01 导入备份：上传文件略大于快照本体（快照 330KB 级，留足余量），超限显式 413 */
const MAX_IMPORT = 8 * 1024 * 1024;

/** 高危门禁（ADR-013 D4-1）：仅老板/店长（与 /api/snapshot/backup、HIGH_RISK_TYPES 同口径） */
function isBossRole(ctx) {
  const role = ctx && ctx.auth ? ctx.auth.role : null;
  return role === '老板' || role === '店长';
}

function operatorOf(ctx) {
  return (ctx && ctx.auth && (ctx.auth.account || ctx.auth.role)) || null;
}

/* Phase 0 接缝（ADR-010）：快照读写统一走 StoreAdapter；默认 json 与旧实现等价。 */
function loadSnapshot() { return getAdapter().readSnapshot(); }

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
    getAdapter().writeSnapshot(null, snap);
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

  /* ---- FP-SET-07 手动打快照备份（只写 data/snapshots/，不写业务库、不入队）---- */
  if (req.method === 'POST' && pathname === '/api/snapshot/backup') {
    /* 与其他设置页写类同口径：**仅老板/店长**（比 mayWriteActions 更严，排除收银/厨房/财务） */
    const role = ctx.auth ? ctx.auth.role : null;
    if (!ctx.auth || (role !== '老板' && role !== '店长')) {
      ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: 仅老板/店长可打快照备份（当前角色 ' + (role || '未登录') + '）' });
      return true;
    }
    const snap = loadSnapshot();
    if (!snap) {
      ctx.sendJSON(res, 404, { ok: false, error: 'no snapshot' });
      return true;
    }
    let body = null;
    try {
      const r = await ctx.readBody(req, 64 * 1024);
      if (!r.tooLarge && r.buf && r.buf.length) body = JSON.parse(r.buf.toString('utf8'));
    } catch (e) { body = null; }
    const operator = ctx.auth.account || ctx.auth.role || null;
    let out;
    try {
      out = snapshotStore.save(snap, { operator, note: (body && body.note) || '' });
    } catch (e) {
      ctx.sendJSON(res, 400, { ok: false, error: e.message });
      return true;
    }
    ctx.sendJSON(res, 200, { ok: true, item: out.item, keep: out.keep, dropped: out.dropped });
    return true;
  }

  /* ---- FP-SET-10（列表查看半）备份列表：只读元信息 ---- */
  if (req.method === 'GET' && pathname === '/api/snapshot/backups') {
    ctx.sendJSON(res, 200, { ok: true, items: snapshotStore.list(), keep: snapshotStore.KEEP });
    return true;
  }

  /* ---- FP-SET-10 备份全文读取（只读；供下载 / 后续回滚取数）---- */
  if (req.method === 'GET' && pathname === '/api/snapshot/backup') {
    const id = (ctx.query.get('id') || '').trim();
    const snap = snapshotStore.read(id);
    if (!snap) {
      ctx.sendJSON(res, 404, { ok: false, error: 'no such backup: ' + id });
      return true;
    }
    ctx.sendJSON(res, 200, {
      ok: true,
      id,
      rev: snap.rev,
      generated_at: snap.generated_at,
      size: snap.size,
      data: snap.data,
      ext: snap.ext === undefined ? null : snap.ext
    });
    return true;
  }

  /* ---- W2-01 回滚预览（只读，纯计算，零写）：当前 rev → 目标 rev、备份时间、将丢弃条数 ---- */
  if (req.method === 'GET' && pathname === '/api/snapshot/backup/preview') {
    const id = (ctx.query.get('id') || '').trim();
    const target = snapshotStore.read(id);
    if (!target) {
      ctx.sendJSON(res, 404, { ok: false, error: 'no such backup: ' + id });
      return true;
    }
    const cur = loadSnapshot();
    ctx.sendJSON(res, 200, {
      ok: true,
      backup_id: id,
      backup_rev: target.rev == null ? null : target.rev,
      backup_generated_at: target.generated_at || null,
      current_rev: cur ? cur.rev : null,
      /* 将覆盖到快照：备份里的数据规模 */
      will_restore: snapshotAlgo.countSummary(target),
      /* 将被丢弃：当前快照会被整包覆盖的记录数（含 ings/recv/sales/quotes/logs/dishes/ext 表） */
      will_discard: cur ? snapshotAlgo.countSummary(cur) : null
    });
    return true;
  }

  /* ================================================================== */
  /* W4 高危三件套（ADR-013 D4）：预览全部只读零写，写只走 /api/actions   */
  /* ================================================================== */

  /* ---- W4-02 基线制品列表（只读：列 data/baselines 与随包 bff/baselines）---- */
  if (req.method === 'GET' && pathname === '/api/snapshot/baselines') {
    const items = baselineStore.list().map((x) => ({
      version: x.version,
      generated_at: x.generated_at,
      source: x.source,
      note: x.note,
      size: x.size,
      counts: x.counts,
      checksum_ok: x.checksum_ok
    }));
    ctx.sendJSON(res, 200, { ok: true, count: items.length, items });
    return true;
  }

  /* ---- W4-02 重置基线预览（只读纯计算）：基线规模 + 将丢弃当前多少条 ---- */
  if (req.method === 'GET' && pathname === '/api/snapshot/baseline/preview') {
    const ver = (ctx.query.get('version') || '').trim();
    let base;
    try {
      base = baselineStore.read(ver || undefined, { verify: true });
    } catch (e) {
      ctx.sendJSON(res, 400, { ok: false, error: (e && e.message) || String(e) });
      return true;
    }
    const cur = loadSnapshot() || { data: {}, ext: {} };
    const diff = snapshotAlgo.diffOf(cur, { data: base.data, ext: base.ext });
    ctx.sendJSON(res, 200, {
      ok: true,
      baseline_version: base.version,
      baseline_generated_at: base.item.generated_at,
      baseline_source: base.item.source,
      baseline_note: base.item.note,
      checksum_ok: base.checksum_ok,
      current_rev: cur.rev == null ? null : cur.rev,
      will_discard: diff.will_discard,
      will_restore: diff.will_restore,
      changed: diff.changed
    });
    return true;
  }

  /* ---- W4-01 导入预览（只读 POST，零写）：解析 + schema 校验/迁移 + 差异统计 ---- */
  if (req.method === 'POST' && pathname === '/api/snapshot/import/preview') {
    const input = await readImportInput(req, ctx, res);
    if (!input.ok) return true;
    let normalized;
    let steps = 0;
    try {
      normalized = snapshotAlgo.normalizeIncomingSnapshot(input.raw);
      steps = schema.migrateData(normalized.data).steps.length;
    } catch (e) {
      ctx.sendJSON(res, 400, { ok: false, error: (e && e.message) || String(e) });
      return true;
    }
    const cur = loadSnapshot() || { data: {}, ext: {} };
    const diff = snapshotAlgo.diffOf(cur, { data: normalized.data, ext: normalized.ext });
    ctx.sendJSON(res, 200, {
      ok: true,
      incoming_rev: normalized.rev,
      schema_steps: steps,
      current_rev: cur.rev == null ? null : cur.rev,
      will_discard: diff.will_discard,
      will_restore: diff.will_restore,
      changed: diff.changed,
      reason: input.reason
    });
    return true;
  }

  /* ---- W4-01 导入提交：暂存导入文件 + 入队（唯一写通道仍是 /api/actions）----
   * 这里只写 data/imports/ 下的**暂存副本**（与 /api/snapshot/backup 只写备份文件同性质），
   * 真正的整包覆盖由执行器 snapshot.import 在队列确认后完成。 */
  if (req.method === 'POST' && pathname === '/api/snapshot/import') {
    if (!isBossRole(ctx)) {
      ctx.sendJSON(res, 403, {
        ok: false,
        error: 'forbidden: 导入备份恢复为高危动作，仅老板/店长可发起（当前角色 '
          + ((ctx.auth && ctx.auth.role) || '未登录') + '）'
      });
      return true;
    }
    const input = await readImportInput(req, ctx, res);
    if (!input.ok) return true;
    let normalized;
    try {
      normalized = snapshotAlgo.normalizeIncomingSnapshot(input.raw);
      schema.migrateData(normalized.data); // 校验/迁移可行性，失败即不暂存
    } catch (e) {
      ctx.sendJSON(res, 400, { ok: false, error: (e && e.message) || String(e) });
      return true;
    }
    let staged;
    try {
      staged = importStore.save(JSON.stringify(input.raw), {
        operator: operatorOf(ctx),
        note: input.reason,
        rev: normalized.rev
      });
    } catch (e) {
      ctx.sendJSON(res, 400, { ok: false, error: (e && e.message) || String(e) });
      return true;
    }
    const r = enqueue('snapshot.import', {
      import_id: staged.item.id,
      reason: input.reason || '',
    }, operatorOf(ctx), ctx.traceId, {});
    ctx.sendJSON(res, 200, {
      ok: true,
      id: r.action.id,
      status: r.action.status,
      rev: r.action.rev,
      import_id: staged.item.id,
      import_rev: staged.item.rev,
      reused: staged.reused === true,
      dedup: r.dedup === true,
      dedup_of: r.dedup_of || null
    });
    return true;
  }

  /* ---- W4-03 清空预览（只读纯计算）：将丢弃 N 条 / 清后剩余 / 保留项 ---- */
  if (req.method === 'GET' && pathname === '/api/snapshot/clear/preview') {
    const scope = (ctx.query.get('scope') || 'business').trim();
    if (snapshotAlgo.CLEAR_SCOPES.indexOf(scope) < 0) {
      ctx.sendJSON(res, 400, { ok: false, error: 'scope 只能是 business / all（收到：' + scope + '）' });
      return true;
    }
    const cur = loadSnapshot() || { data: {}, ext: {} };
    const plan = snapshotAlgo.plannedClear(cur, scope);
    ctx.sendJSON(res, 200, {
      ok: true,
      scope,
      current_rev: cur.rev == null ? null : cur.rev,
      will_discard: snapshotAlgo.countSummary(cur),
      remaining: snapshotAlgo.countSummary({ data: plan.data, ext: plan.ext }),
      kept_data: plan.kept_data,
      kept_ext: plan.kept_ext,
      removed_files: scope === 'all' ? snapshotAlgo.CLEAR_ALL_FILES : []
    });
    return true;
  }

  return false;
}

/**
 * 读导入文件（W4-01）：接受两种 body——
 *   ① 快照/备份全文本身（`{rev, data, ext}`，即「导出全部数据(JSON)」的产物）；
 *   ② 包一层 `{snapshot: {...}, reason: '...'}`（前端带原因时用）。
 * @returns {{ok:boolean, raw?:object, reason:string}}
 */
async function readImportInput(req, ctx, res) {
  const cl = parseInt(req.headers && req.headers['content-length'] || '0', 10);
  if (cl > MAX_IMPORT) {
    ctx.sendJSON(res, 413, { ok: false, error: 'payload too large (>' + MAX_IMPORT + ' bytes)' });
    return { ok: false };
  }
  const { tooLarge, buf } = await ctx.readBody(req, MAX_IMPORT);
  if (tooLarge) {
    ctx.sendJSON(res, 413, { ok: false, error: 'payload too large (>' + MAX_IMPORT + ' bytes)' });
    return { ok: false };
  }
  let body = null;
  try { body = JSON.parse(buf.toString('utf8')); } catch (e) { body = null; }
  if (!body || typeof body !== 'object') {
    ctx.sendJSON(res, 400, { ok: false, error: '导入内容不是合法 JSON 对象' });
    return { ok: false };
  }
  const wrapped = body.snapshot && typeof body.snapshot === 'object';
  return {
    ok: true,
    raw: wrapped ? body.snapshot : body,
    reason: wrapped && typeof body.reason === 'string' ? body.reason : ''
  };
}

module.exports = { handle, loadSnapshot, markRecipeStatus, snapshotStore };
