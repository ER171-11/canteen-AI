'use strict';
/*
 * 结构测算「模拟态」只读推演 —— POST /api/modules/analysis/sim
 *
 * 设计依据：docs/decisions/ADR-007-结构测算模拟层只读推演.md
 *
 * 红线①：本文件**零写库路径** —— 只 `loadSnapshot()` 只读 + `lib/menu_baoben` 纯计算；
 *   不 `saveDB`、不写 `data/*.json`、不 `postAction`、不入 `actions_queue.json`；
 *   行覆盖一律生成新对象（`applyRowOverrides`），绝不 mutate 快照数组或其元素。
 * 独立成文件的原因（ADR-007 §2.1）：`routes/modules.js` 自带「只读端点（无任何写库路径）·
 *   非 GET 一律交外层 404」契约，把 POST 塞进去会破坏这条契约的自证性。
 * 同型先例：`POST /api/inventory/recv/import/preview`（收货导入预览，纯计算零写）。
 */

const { loadSnapshot } = require('./snapshot');
const mb = require('../lib/menu_baoben');

const SIM_PATH = '/api/modules/analysis/sim';
/** 请求体上限：95 行 × 4 字段的覆盖 JSON 远小于此，仅作防御性限流 */
const MAX_BODY = 512 * 1024;

/**
 * query 键名 → DEFAULT_PARAMS 键（与 GET /api/modules/analysis 的店参透传同一张表）
 * 入参既接受 query 键名（前端参数卡表单/`baoben_summary.params` 原样回传），
 * 也接受内部键名（幂等，便于脚本直接调用）
 */
function toInternalParams(obj) {
  const src = (obj && typeof obj === 'object') ? obj : {};
  const map = mb.PARAM_QUERY_MAP || {};
  const out = {};
  for (const q of Object.keys(map)) {
    const v = src[q];
    if (v != null && v !== '' && isFinite(Number(v))) out[map[q]] = Number(v);
  }
  for (const k of Object.keys(src)) {
    if (map[k]) continue; // 已按 query 键处理
    if (Object.prototype.hasOwnProperty.call(mb.DEFAULT_PARAMS, k)
      && src[k] != null && isFinite(Number(src[k]))) out[k] = Number(src[k]);
  }
  return out;
}

/** 行覆盖白名单过滤（只认 c/p/q/on，其余丢弃；防脏数据穿透） */
function normalizeRows(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let n = 0;
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const row = {};
    if (v.c != null && isFinite(Number(v.c))) row.c = Number(v.c);
    if (v.p != null && isFinite(Number(v.p))) row.p = Number(v.p);
    if (v.q != null && isFinite(Number(v.q))) row.q = Number(v.q);
    if (typeof v.on === 'boolean') row.on = v.on;
    if (!Object.keys(row).length) continue;
    out[String(k)] = row;
    n += 1;
    if (n > 500) break; // 防御：行数与菜品数同量级
  }
  return out;
}

async function handle(req, res, ctx, pathname) {
  if (pathname !== SIM_PATH) return false;
  // 与 modules.js 同习：本端点只认 POST，其余交外层 404（不制造「能用 GET 推演」的第二种契约）
  if (req.method !== 'POST') return false;

  let body = {};
  try {
    const r = await ctx.readBody(req, MAX_BODY);
    if (r && r.tooLarge) {
      ctx.sendJSON(res, 413, { ok: false, error: 'body too large' });
      return true;
    }
    const text = r && r.buf ? r.buf.toString('utf8') : '';
    if (text) body = JSON.parse(text);
  } catch (e) {
    ctx.sendJSON(res, 400, { ok: false, error: 'bad json body' });
    return true;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};

  const snap = loadSnapshot();
  if (!snap) {
    ctx.sendJSON(res, 200, { ok: true, sim: true, rev: null, baoben_summary: null, calc_dishes: [], qstat: null });
    return true;
  }
  const data = snap.data || {};

  // 只读推演：入参 → 行集/覆盖 → 单一公式 computeModel()（ADR-007 §2.3）
  const out = mb.simulateBaoben({
    rev: snap.rev,
    dishes: Array.isArray(data.dishes) ? data.dishes : [],
    sales: Array.isArray(data.sales) ? data.sales : [],
    alias: (data.dishAlias && typeof data.dishAlias === 'object') ? data.dishAlias : {},
    params: toInternalParams(body.params),
    rows: normalizeRows(body.rows),
    qmode: body.qmode,
    qfallback: body.qfallback
  });

  ctx.sendJSON(res, 200, {
    ok: true,
    sim: true,
    rev: out.rev,
    basis: out.basis,
    qmode: out.qmode,
    qmode_label: (mb.QMODE_LABELS || {})[out.qmode] || '',
    qfallback: out.qfallback,
    qdays: out.qdays,
    // 与 GET /api/modules/analysis 的 baoben_summary 同形：前端可整块替换渲染，无需分支
    baoben_summary: {
      brand: '熊猫五福餐厅',
      source: '保本测算·模拟态',
      count: out.calc_dishes.filter((r) => r.on !== false).length,
      basis: out.basis,
      params: out.params,
      kpi: out.kpi,
      types: out.types,
      scenes: out.scenes,
      advice: out.advice
    },
    calc_dishes: out.calc_dishes,
    qstat: out.qstat
  });
  return true;
}

module.exports = { handle, SIM_PATH };
