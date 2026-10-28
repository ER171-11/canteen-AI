'use strict';
/*
 * routes/inventory.js — 进销存只读建议 + 食材按标准验收 + 进货单批量导入预览
 *   GET /api/inventory/restock-suggest
 *     优先用原料 est（日耗）估算「还能撑几天」，按断货紧迫排序；
 *     有 data.plans 最新建议行时并入；无 est 时回退安全线补差。
 *     自动生成 ≠ 自动下单：本接口只读，写仍走 restock.create → 确认台。
 *     附带 spec_req（验收标准规格，采购员照着买）。
 *   GET /api/inventory/accept-standards  验收标准库
 *   GET /api/inventory/recv-accept?date= 逐项验收记录
 *   POST /api/inventory/recv/import/preview  进货单批量导入预览（FP-RECV-02）
 *     入参 {fileName, contentBase64}（兼容 {bytes}），支持 .xlsx / 伪 .xls(html 表格) / .csv / .json。
 *     **红线：本端点只读**——解析在 lib/recv_import.js（纯计算），此处不写文件、不写快照、不入队；
 *     写只在用户点「确认导入」时由前端投**一个** recv.import 动作走去 /api/actions。
 */
const { loadSnapshot } = require('./snapshot');
const { listStandards, specReqFor } = require('../lib/accept_standards');
const { previewImport } = require('../lib/recv_import');
const { isFood } = require('../lib/ing_type'); // W4：耗材不参与补货预测（决策 #5）
// W2：受控词表 + 词条 ID 精确命中（只读；写侧走 term.upsert / ing.attr_set 审批队列）
const { TERM_CATEGORIES, termsOf, resolveTermIds, matchIngTags, flattenTags, isTermId } = require('../lib/ing_terms');

function num(v, d) {
  const n = parseFloat(v);
  return isNaN(n) ? d : n;
}

function qtyOf(ing) {
  return num(ing.qty != null ? ing.qty : ing.stock, 0);
}

function safetyOf(ing) {
  if (ing.safe != null && num(ing.safe, 0) > 0) return num(ing.safe, 0);
  if (ing.safety != null && num(ing.safety, 0) > 0) return num(ing.safety, 0);
  if (ing.est != null && num(ing.est, 0) > 0) return num(ing.est, 0) * 2;
  return 0;
}

function dailyOf(ing, safety) {
  if (ing.est != null && num(ing.est, 0) > 0) return num(ing.est, 0);
  // 无日耗时：安全线按「约两日垫」反推
  if (safety > 0) return safety / 2;
  return 0;
}

/** 从最新一张未忽略的 plans 取 lines（店内补货真算法产出） */
function latestPlanLines(plans) {
  if (!Array.isArray(plans) || !plans.length) return [];
  const usable = plans
    .filter((p) => p && p.status !== '忽略' && p.status !== 'ignored')
    .slice()
    .sort((a, b) => String(b.date || b.genAt || '').localeCompare(String(a.date || a.genAt || '')));
  const top = usable[0];
  return Array.isArray(top && top.lines) ? top.lines.map((l) => ({ ...l, _planNo: top.no || top.id })) : [];
}

function buildSuggestions(snap) {
  const data = (snap && snap.data) || {};
  const ings = Array.isArray(data.ings) ? data.ings : [];
  const planLines = latestPlanLines(data.plans);
  const byIng = new Map();
  // 原料档案按 id 索引：补货建议附均价，便于 App 采购单预填单价（无报价时兜底）
  const ingById = new Map();
  for (const g of ings) if (g && g.id != null) ingById.set(String(g.id), g);

  for (const line of planLines) {
    const id = String(line.ing || line.ing_id || line.id || '');
    if (!id) continue;
    const sug = num(line.sug != null ? line.sug : line.qty != null ? line.qty : line.need, 0);
    if (sug <= 0) continue;
    const cur = num(line.cur, 0);
    const planName = line.name || line.ing_name || id;
    const planIng = ingById.get(id);
    if (planIng && !isFood(planIng)) continue; // W4：耗材不参与补货预测
    const planAnomaly = cur < 0;
    byIng.set(id, {
      ingredientId: id,
      name: planName,
      unit: line.unit || '',
      qty: cur,
      safe: num(line.safe != null ? line.safe : line.safety, 0) || null,
      suggestQty: Math.round(sug * 100) / 100,
      daily: num(line.daily, 0),
      daysLeft: line.daily > 0 ? Math.round((cur / line.daily) * 10) / 10 : null,
      avg: planIng ? num(planIng.avg, 0) || null : null,
      last: planIng ? num(planIng.last, 0) || null : null,
      anomaly: planAnomaly,
      reason: (planAnomaly ? '⚠ 账面负库存(' + cur + (line.unit || '') + ')，先盘点核实 · ' : '')
        + '店内补货计划 ' + (line._planNo || '') +
        (line.daily ? (' · 日均 ' + line.daily + ' · 建议补 ' + sug) : (' · 建议补 ' + sug)),
      source: 'plans',
      urgency: planAnomaly ? 'critical'
        : num(line.daily, 0) > 0 && cur / line.daily < 1 ? 'critical'
          : num(line.daily, 0) > 0 && cur / line.daily < 2 ? 'low' : 'watch',
      spec_req: specReqFor(planName, snap)
    });
  }

  for (const ing of ings) {
    if (!ing || !ing.id) continue;
    if (!isFood(ing)) continue; // W4：耗材不参与补货预测（走安全库存阈值提醒 + 人工下单）
    if (byIng.has(ing.id)) continue;
    const qty = qtyOf(ing);
    const safety = safetyOf(ing);
    const daily = dailyOf(ing, safety);
    const daysLeft = daily > 0 ? qty / daily : (qty < safety ? 0 : 99);
    // 经营口径：撑不过约 2 天，或已低于安全线 → 进入待办/建议
    const urgent = (daily > 0 && daysLeft < 2) || (safety > 0 && qty < safety);
    if (!urgent) continue;
    // 建议补到「两日用量」与安全线的较大者
    const target = Math.max(safety, daily > 0 ? daily * 2 : 0);
    const suggestQty = Math.max(0, Math.round((target - qty) * 100) / 100);
    if (suggestQty <= 0) continue;
    // 紧迫度：日耗撑天 + 安全线占比（对齐库存三档：<30% 告急 / <75% 偏低）
    let urgency = 'watch';
    if (daily > 0 && daysLeft < 1) urgency = 'critical';
    else if (daily > 0 && daysLeft < 2) urgency = 'low';
    if (safety > 0) {
      const ratio = qty / safety;
      if (ratio < 0.3) urgency = 'critical';
      else if (ratio < 0.75 && urgency === 'watch') urgency = 'low';
    }
    const daysTxt = daily > 0 ? ('约可撑 ' + (Math.round(daysLeft * 10) / 10) + ' 天') : '低于安全线';
    const ingName = ing.name || ing.id;
    // 负库存=账面异常（多为漏记入库/多记出库），优先提示盘点核实，而非直接按公式补货
    const anomaly = qty < 0;
    byIng.set(ing.id, {
      ingredientId: ing.id,
      name: ingName,
      unit: ing.unit || '',
      qty: Math.round(qty * 100) / 100,
      safe: safety > 0 ? Math.round(safety * 100) / 100 : null,
      suggestQty,
      daily: Math.round(daily * 100) / 100,
      daysLeft: daily > 0 ? Math.round(daysLeft * 10) / 10 : null,
      avg: num(ing.avg, 0) || null,
      last: num(ing.last, 0) || null,
      anomaly,
      reason: (anomaly ? '⚠ 账面负库存(' + Math.round(qty * 100) / 100 + (ing.unit || '') + ')，先盘点核实 · ' : '')
        + daysTxt + ' · 现 ' + qty + (ing.unit || '') +
        (safety ? (' / 安全线 ' + safety) : '') +
        (daily ? (' · 日均 ' + (Math.round(daily * 100) / 100)) : ''),
      source: daily && ing.est ? 'est' : 'safety',
      urgency: anomaly ? 'critical' : urgency,
      spec_req: specReqFor(ingName, snap)
    });
  }

  const items = Array.from(byIng.values()).sort((a, b) => {
    const ua = a.urgency === 'critical' ? 0 : a.urgency === 'low' ? 1 : 2;
    const ub = b.urgency === 'critical' ? 0 : b.urgency === 'low' ? 1 : 2;
    if (ua !== ub) return ua - ub;
    const da = a.daysLeft == null ? 99 : a.daysLeft;
    const db = b.daysLeft == null ? 99 : b.daysLeft;
    return da - db;
  });

  // 老板可用：只推告急/偏低，默认最多 15 条（全量仍回 total）
  const actionable = items.filter((it) => it.urgency === 'critical' || it.urgency === 'low');
  const LIMIT = 15;
  const clipped = actionable.slice(0, LIMIT);

  return {
    ok: true,
    mock: false,
    source: planLines.length ? 'plans+ings' : 'ings',
    count: clipped.length,
    total: actionable.length,
    truncated: actionable.length > clipped.length,
    items: clipped
  };
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function pickDate(ctx) {
  const q = (ctx.query.get('date') || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : todayStr();
}

function buildRecvAccept(snap, date) {
  const ext = (snap && snap.ext && typeof snap.ext === 'object') ? snap.ext : {};
  const fromExt = Array.isArray(ext.recv_accept) ? ext.recv_accept : [];
  const items = fromExt.filter((r) => {
    if (!r) return false;
    if (!date) return true;
    const ts = String(r.ts || r.date || '');
    return !ts || ts.indexOf(date) === 0;
  });
  // 无专用表时：从 data.recv 行上的 kimi/验收字段合成只读视图
  if (!items.length && snap && snap.data && Array.isArray(snap.data.recv)) {
    for (const doc of snap.data.recv) {
      if (!doc) continue;
      const d = String(doc.date || doc.ts || '');
      if (date && d && d.indexOf(date) !== 0) continue;
      const lines = Array.isArray(doc.lines) ? doc.lines : [];
      for (const ln of lines) {
        if (!ln) continue;
        const verdict = ln.verdict || ln.accept || ln.qc || doc.verdict;
        if (!verdict && ln.qty_rejected == null && !ln.kimi) continue;
        items.push({
          recv_id: doc.id || doc.no,
          ing_name: ln.name || ln.ing_name || ln.ing,
          qty_ordered: ln.qty != null ? ln.qty : ln.ordered,
          qty_received: ln.recvQty != null ? ln.recvQty : ln.received,
          qty_rejected: ln.qty_rejected != null ? ln.qty_rejected : 0,
          verdict: verdict || 'pass',
          detail: ln.kimi || ln.detail || null,
          batch_no: ln.batch_no || ln.batch,
          cert_no: ln.cert_no || ln.cert,
          ts: doc.ts || doc.date,
          source: ln.source || doc.source || 'recv'
        });
      }
    }
  }
  return items;
}

/* ---------- W2 受控词表（只读） ---------- */

/** GET /api/inventory/ing-terms → 受控词表列表（data.ing_terms 优先，缺失回退 seed） */
function buildIngTerms(snap) {
  const data = (snap && snap.data) || {};
  const terms = termsOf(data);
  return {
    ok: true,
    categories: TERM_CATEGORIES,
    count: terms.length,
    terms: terms.map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category,
      aliases: Array.isArray(t.aliases) ? t.aliases : [],
      status: t.status || 'active',
    })),
    source: (data && Array.isArray(data.ing_terms) && data.ing_terms.length) ? 'data' : 'seed',
  };
}

/** GET /api/inventory/ing-terms/match?q= → 词条 ID 精确命中原料（只读，别名归一） */
function buildTermMatch(snap, q) {
  const data = (snap && snap.data) || {};
  const ings = Array.isArray(data.ings) ? data.ings : [];
  const terms = termsOf(data);
  const kw = String(q || '').trim();
  if (!kw) return { ok: true, q: kw, count: 0, terms: [], items: [] };
  const wanted = resolveTermIds(kw, terms).filter(isTermId);
  const hitTerms = terms.filter((t) => t && wanted.indexOf(String(t.id)) >= 0);
  const items = [];
  for (const ing of ings) {
    if (!ing) continue;
    const hit = matchIngTags(kw, ing, terms);
    if (hit.length) {
      items.push({
        id: ing.id,
        name: ing.name,
        cat: ing.cat,
        tags: flattenTags(ing.tags, terms),
        hitTermIds: hit,
      });
    }
  }
  return { ok: true, q: kw, count: items.length, terms: hitTerms, items };
}

/** 上传体上限：8MB（与 lib/recv_import.js previewImport 内的上限同口径） */
const MAX_UPLOAD = 8 * 1024 * 1024;

/**
 * FP-RECV-02 进货单批量导入 · 预览（纯计算、零写）
 * 支持 {contentBase64,fileName} 自动识别，或 {override:{rowIndex,map}} 手动指定列。
 * 失败一律走 400 + 明确 error 文案（由前端展示），不静默吞掉任何一行。
 */
async function handleRecvImportPreview(req, res, ctx) {
  if (req.method !== 'POST') {
    ctx.sendJSON(res, 405, { ok: false, error: 'method not allowed' });
    return true;
  }
  const { buf, tooLarge } = await ctx.readBody(req, MAX_UPLOAD);
  if (tooLarge) {
    ctx.sendJSON(res, 413, {
      ok: false,
      error: '文件过大：上限 8MB，请拆分后再导入'
    });
    return true;
  }
  let body = null;
  try {
    body = JSON.parse(String(buf || '').toString('utf8'));
  } catch (e) {
    body = null;
  }
  if (!body || typeof body !== 'object' || (!body.contentBase64 && !body.text)) {
    ctx.sendJSON(res, 400, { ok: false, error: '缺少 contentBase64（文件内容）' });
    return true;
  }
  const snap = loadSnapshot();
  const ings = (snap && snap.data && Array.isArray(snap.data.ings)) ? snap.data.ings : [];
  const input = {
    fileName: String(body.fileName || 'import.csv'),
    contentBase64: body.contentBase64,
    bytes: body.text ? Buffer.from(String(body.text), 'utf8') : null,
    override: body.override || null
  };
  const out = previewImport(input, ings);
  ctx.sendJSON(res, out.ok ? 200 : 400, out);
  return true;
}

async function handle(req, res, ctx, pathname) {
  if (pathname === '/api/inventory/recv/import/preview') {
    return handleRecvImportPreview(req, res, ctx);
  }
  if (req.method !== 'GET') return false;

  if (pathname === '/api/inventory/restock-suggest') {
    const snap = loadSnapshot();
    const hasData = !!(snap && snap.data && Array.isArray(snap.data.ings) && snap.data.ings.length);
    if (!hasData) {
      ctx.sendJSON(res, 200, {
        ok: true,
        mock: true,
        source: 'none',
        count: 0,
        items: [],
        banner: '无原料快照，无法生成补货建议'
      });
      return true;
    }
    ctx.sendJSON(res, 200, buildSuggestions(snap));
    return true;
  }

  if (pathname === '/api/inventory/accept-standards') {
    const snap = loadSnapshot();
    const standards = listStandards(snap);
    ctx.sendJSON(res, 200, {
      ok: true,
      count: standards.length,
      standards,
      source: (snap && snap.ext && Array.isArray(snap.ext.accept_standards) &&
        snap.ext.accept_standards.length) ? 'ext' : 'seed'
    });
    return true;
  }

  if (pathname === '/api/inventory/recv-accept') {
    const snap = loadSnapshot();
    const date = pickDate(ctx);
    const items = buildRecvAccept(snap, date);
    ctx.sendJSON(res, 200, {
      ok: true,
      date,
      count: items.length,
      items,
      records: items
    });
    return true;
  }

  if (pathname === '/api/inventory/ing-terms') {
    const snap = loadSnapshot();
    ctx.sendJSON(res, 200, buildIngTerms(snap));
    return true;
  }

  if (pathname === '/api/inventory/ing-terms/match') {
    const snap = loadSnapshot();
    const q = (ctx.query.get('q') || '').trim();
    ctx.sendJSON(res, 200, buildTermMatch(snap, q));
    return true;
  }

  return false;
}

module.exports = { handle, buildSuggestions, buildRecvAccept, buildIngTerms, buildTermMatch };
