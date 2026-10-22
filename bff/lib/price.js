'use strict';
/*
 * lib/price.js — 原料比价只读聚合（旧 #tab-price「外接比价」，HTML:4924-5109）
 *
 * 目标：把「本店均价 vs 外部最低报价」的差价 / 节省% 从旧版搬回来（FP-PRICE-01/02/03/13/14）。
 * 纯函数、零 IO：入参快照 snap（{data:{ings,quotes}, ...}），缺字段一律安全回退。
 *
 * 口径（与旧版逐行对齐）：
 *   · 在售原料：ings 过滤 g.on 为真
 *   · 本店均价：g.avg（元/库存单位）
 *   · 外部报价：quotes 按 `quoteMatches`（`q.ing === g.id` 优先，回退按原料名）归集；
 *     per='buy' 为采购单位价、'stock' 为库存单位价
 *   · 折算 quotePerStock：per==='buy' ? price/conv : price（折成「元/库存单位」）
 *   · 最低报价 bestQuote：按折后单位价取最小
 *   · 差价 diff：最低折价 − 本店均价；节省% savePct：|diff|/avg
 */

const { isFood } = require('./ing_type'); // W4：耗材不参与比价（决策 #4）

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v, d) => { const n = Number(v); return isFinite(n) ? n : (d == null ? 0 : d); };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/** 折算为库存单位价（元/库存单位）。per='buy' 时按采购单位价 / conv。 */
function quotePerStock(q, g) {
  return String(q && q.per) === 'buy' ? num(q.price) / Math.max(0.0001, num(g && g.conv, 1)) : num(q.price);
}

/**
 * 报价归属判定：优先按原料 id 命中（`q.ing === g.id`），
 * 回退按原料名命中（兼容历史「按名录入」的存量报价，`q.ing === g.name`）。
 * 唯一口径出口：lib/price.js 与 lib/supply.js 共用本函数，避免两处归集规则漂移。
 */
function quoteMatches(g, q) {
  const ing = String((q && q.ing) == null ? '' : q.ing).trim();
  if (!g || !ing) return false;
  if (ing === String(g.id)) return true;
  return ing === String(g.name || '');
}

/** 该原料的全部报价（按日期倒序，逐条折算库存单位价 + 对比本店差价）。FP-PRICE-06/08 明细数据源。 */
function quotesOf(g, quotes) {
  const avg = num(g && g.avg, 0);
  return arr(quotes)
    .filter((q) => quoteMatches(g, q))
    .map((q) => {
      const perStock = r2(quotePerStock(q, g));
      return {
        id: String((q.id == null ? '' : q.id)),
        src: String(q.src || q.supplier || ''),
        price: r2(num(q.price)),
        per: String(q.per || ''),
        unit: String(q.unit || ''),
        date: String(q.date || ''),
        note: String(q.note || ''),
        perStock,
        diff: r2(perStock - avg),
      };
    })
    .sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1));
}

/** 该原料的外部最低报价（按折后单位价取最小），无报价返回 null。 */
function bestQuote(g, quotes) {
  const qs = arr(quotes).filter((q) => quoteMatches(g, q));
  if (!qs.length) return null;
  return qs.map((q) => ({ q, unit: r3(quotePerStock(q, g)) })).sort((a, b) => a.unit - b.unit)[0];
}

/** FP-PRICE-13 关键词净化：去规格/容量/品牌后缀，提高外部平台命中率（旧版 quoteKeyword :5062）。 */
function quoteKeyword(g) {
  return String(g && g.name || '')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/\d+(\.\d+)?\s*(ml|ML|L|l|kg|KG|g|G|克|千克|升|毫升|斤)/g, ' ')
    .replace(/\s+/g, ' ').trim() || (g && g.name) || '';
}

/** FP-PRICE-03/14 比价主表 + 顶部统计（旧版 renderPrice :4935 / quoteTaskText :5082）。 */
function priceReport(snap) {
  const data = (snap && snap.data) || {};
  const ings = arr(data.ings).filter((g) => g && g.on && isFood(g)); // W4：耗材不参与比价
  const quotes = arr(data.quotes);
  const rows = ings.map((g) => {
    const b = bestQuote(g, quotes);
    const avg = num(g.avg, 0);
    const diff = b ? r2(b.unit - avg) : null;
    const savePct = b && avg > 0 ? r2(Math.abs(diff) / avg * 100) : null;
    const qs = quotesOf(g, quotes); /* 日期倒序：qs[0] 为最近一条 */
    return {
      ingId: String(g.id),
      name: String(g.name || ''),
      cat: String(g.cat || ''),
      buy: String(g.buy || ''),
      conv: num(g.conv, 1),
      unit: String(g.unit || ''),
      avg: r2(avg),
      best: b ? {
        src: String(b.q.src || ''),
        price: r2(num(b.q.price)),
        per: String(b.q.per || ''),
        date: String(b.q.date || ''),
        unit: r2(b.unit),
        note: String(b.q.note || ''),
      } : null,
      diff,
      savePct,
      /* FP-PRICE-06/08：该原料的全部报价明细（前端行展开「报价记录」与「全部报价记录」共用） */
      quotes: qs,
      recent: qs.slice(0, 2).map((q) => ({ src: q.src, date: q.date })),
    };
  });
  const noQuote = rows.filter((r) => !r.best).length;
  return { rows, tip: { onSale: rows.length, noQuote, hasQuote: rows.length - noQuote } };
}

/** FP-PRICE-13 待比价清单（旧版 openQuotePlan :5091）。 */
function pricePlan(snap) {
  const data = (snap && snap.data) || {};
  const ings = arr(data.ings).filter((g) => g && g.on && isFood(g)); // W4：耗材不参与比价
  const quotes = arr(data.quotes);
  const items = ings.map((g) => ({
    ingId: String(g.id),
    name: String(g.name || ''),
    cat: String(g.cat || ''),
    keyword: quoteKeyword(g),
    buy: String(g.buy || ''),
    conv: num(g.conv, 1),
    unit: String(g.unit || ''),
    avg: r2(num(g.avg, 0)),
    status: bestQuote(g, quotes) ? '已比价' : '待比价',
  }));
  return { items, onSale: items.length };
}

module.exports = { quotePerStock, quoteMatches, quotesOf, bestQuote, quoteKeyword, priceReport, pricePlan };
