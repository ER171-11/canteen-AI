'use strict';
/*
 * routes/inventory.js — 进销存只读建议
 *   GET /api/inventory/restock-suggest
 *     优先用原料 est（日耗）估算「还能撑几天」，按断货紧迫排序；
 *     有 data.plans 最新建议行时并入；无 est 时回退安全线补差。
 *     自动生成 ≠ 自动下单：本接口只读，写仍走 restock.create → 确认台。
 */
const { loadSnapshot } = require('./snapshot');

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

  for (const line of planLines) {
    const id = String(line.ing || line.ing_id || line.id || '');
    if (!id) continue;
    const sug = num(line.sug != null ? line.sug : line.qty != null ? line.qty : line.need, 0);
    if (sug <= 0) continue;
    const cur = num(line.cur, 0);
    byIng.set(id, {
      ingredientId: id,
      name: line.name || line.ing_name || id,
      unit: line.unit || '',
      qty: cur,
      safe: num(line.safe != null ? line.safe : line.safety, 0) || null,
      suggestQty: Math.round(sug * 100) / 100,
      daily: num(line.daily, 0),
      daysLeft: line.daily > 0 ? Math.round((cur / line.daily) * 10) / 10 : null,
      reason: '店内补货计划 ' + (line._planNo || '') +
        (line.daily ? (' · 日均 ' + line.daily + ' · 建议补 ' + sug) : (' · 建议补 ' + sug)),
      source: 'plans',
      urgency: num(line.daily, 0) > 0 && cur / line.daily < 1 ? 'critical'
        : num(line.daily, 0) > 0 && cur / line.daily < 2 ? 'low' : 'watch'
    });
  }

  for (const ing of ings) {
    if (!ing || !ing.id) continue;
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
    byIng.set(ing.id, {
      ingredientId: ing.id,
      name: ing.name || ing.id,
      unit: ing.unit || '',
      qty: Math.round(qty * 100) / 100,
      safe: safety > 0 ? Math.round(safety * 100) / 100 : null,
      suggestQty,
      daily: Math.round(daily * 100) / 100,
      daysLeft: daily > 0 ? Math.round(daysLeft * 10) / 10 : null,
      reason: daysTxt + ' · 现 ' + qty + (ing.unit || '') +
        (safety ? (' / 安全线 ' + safety) : '') +
        (daily ? (' · 日均 ' + (Math.round(daily * 100) / 100)) : ''),
      source: daily && ing.est ? 'est' : 'safety',
      urgency
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

async function handle(req, res, ctx, pathname) {
  if (req.method === 'GET' && pathname === '/api/inventory/restock-suggest') {
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
  return false;
}

module.exports = { handle, buildSuggestions };
