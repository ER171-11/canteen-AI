'use strict';
/*
 * routes/export.js — 设置页只读导出（FP-SET-11/12/13/14）
 *
 * 五类导出（旧版设置页 #btnExport/#btnCsvIng/#btnCsvDish/#btnCsvSale + 留样台账，HTML:5292-5316）：
 *   GET /api/export/backup.json  全量数据备份 JSON（快照 data+ext 原样，可直接回灌 /api/snapshot/push）
 *   GET /api/export/ings.csv     原料库存 CSV
 *   GET /api/export/dishes.csv   菜品成本毛利 CSV
 *   GET /api/export/sales.csv    销售应收实收 CSV
 *   GET /api/export/samples.csv  留样台账 CSV（含存放温度/封存人，支撑留存 ≥2 年可追溯）
 *
 * 红线①：**只读**——不写快照、不写文件、不入队、不碰任何业务库；纯计算 + 响应下发。
 * 响应：text/csv; charset=utf-8（带 UTF-8 BOM，Excel 友好）/ application/json；
 *      Content-Disposition 同时给 ASCII filename 与 RFC5987 filename*（含中文）。
 * 文件名由前端生成（与旧版一致），此处仅作兜底。
 *
 * 口径说明（销售应收实收）：
 *   旧版 sales 行含 sub/discount/receivable/payments[]；新版快照 sales 行目前只有
 *   {id,date,hour,dish,qty,amount,channel,method,...}（一次性全额收款，见 FP-SALE-01）。
 *   本导出**优先读显式字段**（forward-compatible），缺失时按「全额收款」口径兜底：
 *   折扣=空 / 应收=实收=售价合计=amount / 欠款=0。待 FP-SALE-07/11 建应收模型后，
 *   只要行上带 sub/discount/receivable/payments 即自动按真实口径导出，无需改此端点。
 */
const { loadSnapshot } = require('./snapshot');
const foodsafety = require('../lib/foodsafety');

const BOM = '\ufeff';
const JSON_TYPE = 'application/json; charset=utf-8';
const CSV_TYPE = 'text/csv; charset=utf-8';

function arr(v) { return Array.isArray(v) ? v : []; }
function num(v, d) { const n = parseFloat(v); return isNaN(n) ? (d != null ? d : 0) : n; }
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function cell(v) { return v == null ? '' : String(v); }

/** CSV：UTF-8 BOM + CRLF + 双引号转义（逐字对齐旧版 csv()，HTML:5293-5295） */
function csv(rows) {
  const body = rows.map((r) => r.map((v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
  return BOM + body;
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 近 N 天区间下界（含当天，旧版 daysAgo(N-1)） */
function daysAgoStr(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function extOf(snap) {
  return snap && snap.ext && typeof snap.ext === 'object' ? snap.ext : {};
}

/* ------------------------------------------------------------------ */
/* 配方索引 / 菜品成本                                                  */
/* ------------------------------------------------------------------ */

/** ext.recipes → 按 sku_id / name 双索引 */
function recipeIndex(ext) {
  const bySku = {}, byName = {};
  for (const r of arr(ext.recipes)) {
    if (!r) continue;
    if (r.sku_id != null) bySku[String(r.sku_id)] = r;
    if (r.name) byName[String(r.name)] = r;
  }
  return { bySku, byName };
}

/** 菜品 → 配方（sku_id → 菜名精确），无则 null */
function findRecipeForDish(d, idx) {
  if (!d) return null;
  if (d.sku_id != null && idx.bySku[String(d.sku_id)]) return idx.bySku[String(d.sku_id)];
  if (d.id != null && idx.bySku[String(d.id)]) return idx.bySku[String(d.id)];
  if (d.name && idx.byName[String(d.name)]) return idx.byName[String(d.name)];
  return null;
}

/**
 * 菜品成本卡：有配方 → lib/recipe_cost 的「每份」成本（旧版 dishRecipeCost/dishCost）；
 * 无配方 → 回落估算成本 est（旧版 dishCostType='估算'）。
 * 返回 { byId, byName }，供菜品 CSV 与销售 CSV 共用（同口径，不重复实现）。
 */
function dishCostMap(snap) {
  const data = (snap && snap.data) || {};
  const idx = recipeIndex(extOf(snap));
  let costLib = null;
  try { costLib = require('../lib/recipe_cost'); } catch (e) { costLib = null; }

  const byId = {}, byName = {};
  const detail = {}; // 供菜品 CSV 取成本来源 / 原料数 / 售价
  for (const d of arr(data.dishes)) {
    if (!d) continue;
    const recipe = findRecipeForDish(d, idx);
    let cost = num(d.est, 0);
    let costType = '估算';
    let nLines = 0;
    let price = d.price != null ? num(d.price) : null;
    if (recipe && costLib) {
      try {
        const card = costLib.buildCostCard(recipe, data);
        if (card && card.portion_cost != null) {
          cost = num(card.portion_cost, cost);
          costType = '配方';
          nLines = arr(card.bom_lines).length;
          if (card.price != null) price = num(card.price);
        }
      } catch (e) { /* 配方异常 → 回落估算，不中断导出 */ }
    }
    const rec = { cost, costType, nLines, price };
    if (d.id != null) byId[String(d.id)] = rec;
    if (d.name) byName[String(d.name)] = rec;
    detail[String(d.id != null ? d.id : d.name)] = rec;
  }
  return { byId, byName, detail };
}

/** 菜品成本（元/份）：按菜品 id → 菜名顺序回落；未命中返回 null */
function costOfDish(map, ref) {
  if (ref == null) return null;
  const key = String(ref);
  if (map.byId[key]) return map.byId[key].cost;
  if (map.byName[key]) return map.byName[key].cost;
  return null;
}

/* ------------------------------------------------------------------ */
/* 近 30 天销量/营收聚合（旧版 dishSalesAgg，HTML:2613-2619）           */
/* ------------------------------------------------------------------ */

/** 一条销售行的明细：{ref, name, qty, amount}；无 lines/items 时回落行级 dish/qty/amount */
function saleLines(s) {
  const lines = Array.isArray(s.lines) ? s.lines : (Array.isArray(s.items) ? s.items : null);
  if (lines && lines.length) {
    return lines.map((l) => ({
      ref: l && (l.dish != null ? l.dish : (l.sku != null ? l.sku : l.name)),
      name: l && (l.name || l.dish_name),
      qty: num(l && l.qty, 1),
      amount: l && l.amount != null ? num(l.amount) : null,
    }));
  }
  return [{ ref: s.dish, name: s.dish, qty: num(s.qty, 1), amount: s.amount == null ? null : num(s.amount) }];
}

/** 菜名 → 菜品 id（dishAlias → 菜名精确），与 modules.js 口径一致 */
function dishResolver(data) {
  const byName = {};
  for (const d of arr(data.dishes)) {
    if (d && d.name) byName[String(d.name)] = d;
  }
  const alias = (data.dishAlias && typeof data.dishAlias === 'object') ? data.dishAlias : {};
  const clean = (s) => String(s == null ? '' : s)
    .replace(/^[　 *＊·・]+/, '').replace(/[　 *＊]+$/, '').trim();
  return (ref) => {
    if (ref == null) return null;
    const key = String(ref);
    if (byName[key]) return key;
    const a = alias[clean(key)];
    if (a && a.dish != null) return String(a.dish);
    return key;
  };
}

/** 近 30 天聚合：dishId → {qty, rev}（销售行 date >= today-29）
 *  金额口径：行级 amount 优先；真实数据金额在记录级（lines 无 amount）时回落记录级 amount，
 *  否则 rev 会恒为 0（见真实 snapshot.json：426 条销售记录行内均无 amount，amount 在记录级）。 */
function near30Agg(data) {
  const from = daysAgoStr(29);
  const map = {};
  const resolve = dishResolver(data);
  for (const s of arr(data.sales)) {
    const day = String((s && (s.date || s.ts || s.time)) || '').slice(0, 10);
    if (!day || day < from) continue;
    const hasLines = Array.isArray(s.lines) && s.lines.length;
    const recAmt = num(s.amount, 0);
    for (const l of saleLines(s)) {
      const id = resolve(l.ref);
      if (id == null) continue;
      if (!map[id]) map[id] = { qty: 0, rev: 0 };
      map[id].qty += num(l.qty, 0);
      const la = l.amount != null ? num(l.amount) : (hasLines ? recAmt : 0);
      map[id].rev += la;
    }
  }
  return map;
}

/** FP-DISH-11/12 近 30 天销量与毛利额：dishId/name → {q30, gp30}（旧版 dishSalesAgg(d,30)，HTML:2613-2618） */
function dishSalesAgg(snap) {
  const data = (snap && snap.data) || {};
  const map = dishCostMap(snap);
  const agg = near30Agg(data);
  const byId = {};
  const byName = {};
  for (const d of arr(data.dishes)) {
    if (!d) continue;
    const rec = (d.id != null ? map.byId[String(d.id)] : null) || (d.name ? map.byName[String(d.name)] : null)
      || { cost: num(d.est, 0) };
    const a = (d.id != null ? agg[String(d.id)] : null) || (d.name ? agg[String(d.name)] : null) || { qty: 0, rev: 0 };
    const o = { q30: num(a.qty, 0), gp30: r2(num(a.rev, 0) - num(rec.cost, 0) * num(a.qty, 0)) };
    if (d.id != null) byId[String(d.id)] = o;
    if (d.name != null) byName[String(d.name)] = o;
  }
  return { byId, byName };
}

/* ------------------------------------------------------------------ */
/* 四类导出行                                                           */
/* ------------------------------------------------------------------ */

/** FP-SET-12 原料库存 CSV（旧版 #btnCsvIng，HTML:5296-5300） */
function ingsRows(snap) {
  const data = (snap && snap.data) || {};
  const rows = [['原料', '分类', '采购单位', '规格', '换算率', '库存单位', '当前库存', '安全库存', '均价', '最近采购价', '出成率']];
  for (const g of arr(data.ings)) {
    if (!g) continue;
    rows.push([
      g.name, g.cat, g.buy, g.spec, g.conv, g.unit,
      g.stock, g.safe, g.avg, cell(g.last), g.yld,
    ]);
  }
  return rows;
}

/** FP-SET-13 菜品成本毛利 CSV（旧版 #btnCsvDish，HTML:5301-5307） */
function dishesRows(snap) {
  const data = (snap && snap.data) || {};
  const map = dishCostMap(snap);
  const agg = near30Agg(data);
  const rows = [['菜品', '类型', '成本来源', '食材成本', '售价', '毛利率', '配方原料数', '近30天销量', '近30天营收']];
  for (const d of arr(data.dishes)) {
    if (!d) continue;
    const rec = (d.id != null ? map.byId[String(d.id)] : null) || (d.name ? map.byName[String(d.name)] : null) || { cost: num(d.est, 0), costType: '估算', nLines: 0, price: d.price != null ? num(d.price) : null };
    const price = rec.price != null ? num(rec.price) : null;
    const gm = (price != null && price > 0) ? ((price - rec.cost) / price).toFixed(4) : '';
    const a = (d.id != null ? agg[String(d.id)] : null) || (d.name ? agg[String(d.name)] : null) || { qty: 0, rev: 0 };
    rows.push([
      d.name, d.cat, rec.costType, num(rec.cost).toFixed(2),
      price == null ? '' : price, gm, rec.nLines,
      a.qty, num(a.rev).toFixed(2),
    ]);
  }
  return rows;
}

/** 销售明细文字：菜名x份（旧版 HTML:5311） */
function saleDetail(s, data) {
  const byId = {};
  for (const d of arr(data.dishes)) if (d && d.id != null) byId[String(d.id)] = d;
  const parts = [];
  for (const l of saleLines(s)) {
    const nm = (l.ref != null && byId[String(l.ref)] && byId[String(l.ref)].name) || l.name || (l.ref != null ? String(l.ref) : '?');
    parts.push(nm + 'x' + l.qty);
  }
  return parts.join('；');
}

/** FP-SET-14 销售应收实收 CSV（旧版 #btnCsvSale，HTML:5308-5316） */
function salesRows(snap) {
  const data = (snap && snap.data) || {};
  const map = dishCostMap(snap);
  const rows = [['单号', '日期', '渠道', '菜品明细', '售价合计', '折扣', '应收', '实收', '欠款', '食材成本', '毛利率', '备注']];
  const list = arr(data.sales).slice().sort((a, b) => String((a && a.date) || '').localeCompare(String((b && b.date) || '')));
  for (const s of list) {
    if (!s) continue;
    const sub = s.sub != null ? num(s.sub) : num(s.amount);
    const discount = s.discount != null ? num(s.discount) : '';
    const receivable = s.receivable != null ? num(s.receivable) : sub;
    const received = Array.isArray(s.payments)
      ? r2(s.payments.reduce((acc, p) => acc + num(p && p.amount), 0))
      : receivable;
    const debt = r2(receivable - received);
    let cost = 0;
    const lines = Array.isArray(s.lines) ? s.lines : (Array.isArray(s.items) ? s.items : null);
    if (lines && lines.length) {
      for (const l of lines) {
        const c = costOfDish(map, l && (l.dish != null ? l.dish : (l.sku != null ? l.sku : l.name)));
        if (c != null) cost += c * num(l && l.qty, 1);
      }
    } else {
      const c = costOfDish(map, s.dish);
      if (c != null) cost += c * num(s.qty, 1);
    }
    cost = r2(cost);
    const gm = receivable ? ((receivable - cost) / receivable).toFixed(4) : '';
    rows.push([
      s.no || s.id, s.date, s.ch || s.channel, saleDetail(s, data),
      sub, discount, receivable, received, debt, cost, gm, cell(s.note),
    ]);
  }
  return rows;
}

/** FP-SET-11 全量数据备份 JSON：快照原样（可回灌 /api/snapshot/push） */
function backupJSON(snap) {
  return JSON.stringify(snap, null, 1);
}

/** 时间格式化：本地 YYYY-MM-DD HH:mm:ss（无逗号，保证 CSV 列对齐） */
function fmtTime(iso) {
  if (iso == null) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 留样台账 CSV（M4-T4）：复用 sampleReport 口径，状态/到期时间与页面一致 */
function samplesRows(snap) {
  const rep = foodsafety.sampleReport(extOf(snap), Date.now());
  const rows = [['日期', '餐次', '菜品', '克重(g)', '存放温度(℃)', '封存人', '保管人', '留样时间', '到期时间', '状态']];
  for (const r of rep.rows) {
    rows.push([
      r.date, r.meal, r.dish, r.weight_g,
      r.hold_temp == null ? '' : r.hold_temp,
      r.sealed_by, r.keeper,
      fmtTime(r.kept_at),
      fmtTime(r.due_at),
      r.status,
    ]);
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* 响应                                                                 */
/* ------------------------------------------------------------------ */

function encodeFilename(name) {
  return encodeURIComponent(name).replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function sendFile(res, contentType, filename, body) {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': String(buf.length),
    'Content-Disposition': 'attachment; filename="' + filename.replace(/[^\x20-\x7e]/g, '_')
      + '"; filename*=UTF-8\'\'' + encodeFilename(filename),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Disposition',
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

const PATHS = {
  '/api/export/backup.json': (snap) => ({
    type: JSON_TYPE, filename: '熊猫五福进销存备份_' + todayStr() + '.json', body: backupJSON(snap),
  }),
  '/api/export/ings.csv': (snap) => ({
    type: CSV_TYPE, filename: '原料库存_' + todayStr() + '.csv', body: csv(ingsRows(snap)),
  }),
  '/api/export/dishes.csv': (snap) => ({
    type: CSV_TYPE, filename: '菜品成本毛利_' + todayStr() + '.csv', body: csv(dishesRows(snap)),
  }),
  '/api/export/sales.csv': (snap) => ({
    type: CSV_TYPE, filename: '销售应收实收_' + todayStr() + '.csv', body: csv(salesRows(snap)),
  }),
  '/api/export/samples.csv': (snap) => ({
    type: CSV_TYPE, filename: '留样台账_' + todayStr() + '.csv', body: csv(samplesRows(snap)),
  }),
};

async function handle(req, res, ctx, pathname) {
  // 只读路由：非 GET 不接管（不暴露任何写路径）
  if (req.method !== 'GET') return false;
  const build = PATHS[pathname];
  if (!build) return false;
  const snap = loadSnapshot();
  // 无快照：仍下发合法空文件（表头/空对象），不 500
  const payload = build(snap || { rev: null, generated_at: null, data: {}, ext: null });
  sendFile(res, payload.type, payload.filename, payload.body);
  return true;
}

module.exports = {
  handle,
  csv,
  ingsRows,
  dishesRows,
  salesRows,
  samplesRows,
  backupJSON,
  dishCostMap,
  near30Agg,
  dishSalesAgg,
  saleLines,
  dishResolver,
  costOfDish,
};
