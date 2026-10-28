'use strict';
/*
 * lib/agent/tools.js — SI 只读工具集
 *
 * 每个工具 run(args, snap) → JSON 可序列化结果，供 LLM 取数。
 * 红线：全部只读；数字来自确定性函数/快照聚合，LLM 不得自行算账。
 * snap 形状：{ rev, generated_at, data:{...}, ext:{...} }
 */
const store = require('../store');
const modules = require('../../routes/modules');
const { buildCostCard } = require('../recipe_cost');

function arr(v) { return Array.isArray(v) ? v : []; }
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function dayOf(r) {
  return String((r && (r.date || r.ts || r.time || r.created_at)) || '').slice(0, 10);
}
function amountOf(r) {
  return num(r && (r.amount != null ? r.amount : (r.total != null ? r.total : r.revenue)));
}
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function clamp(arr2, n) { return arr2.slice(0, n); }

/* ------------------------------------------------------------------ */
/* 工具定义                                                            */
/* ------------------------------------------------------------------ */
const TOOLS = {
  store_overview: {
    desc: '看某日营收/订单/客单价与保本达成。不做趋势时优先用这个。',
    args: { date: '可选，YYYY-MM-DD，默认今天' },
    run: (args, snap) => {
      const date = String((args && args.date) || todayStr()).slice(0, 10);
      const sales = arr((snap.data || {}).sales);
      const recs = sales.filter((r) => dayOf(r) === date);
      const revenue = recs.reduce((s, r) => s + amountOf(r), 0);
      const orders = recs.length;
      const avg = orders ? revenue / orders : 0;
      const out = {
        date,
        revenue: Math.round(revenue * 100) / 100,
        orders,
        avg_ticket: Math.round(avg * 100) / 100
      };
      try {
        const { computeBaobenSummary } = require('../menu_baoben');
        const s = computeBaobenSummary();
        const be = s && s.kpi && s.kpi.be_day;
        if (be > 0) {
          out.breakeven_day = be;
          out.attain_pct = Math.round((revenue / be) * 1000) / 10;
          out.gap = Math.round((revenue - be) * 100) / 100;
        }
      } catch (e) { /* 价盘缺失 */ }
      return out;
    }
  },

  low_stock: {
    desc: '列出低于安全库存的原料及建议补货量。',
    args: {},
    run: (args, snap) => {
      const ings = arr((snap.data || {}).ings);
      const out = [];
      for (const it of ings) {
        if (!it || typeof it !== 'object') continue;
        const qty = num(it.qty != null ? it.qty : (it.stock != null ? it.stock : it.amount));
        const safe = num(it.safe != null ? it.safe : (it.safety != null ? it.safety : it.safe_stock));
        if (safe <= 0 || qty >= safe) continue;
        out.push({
          name: it.name || it.sku || it.sku_id || '未命名',
          qty,
          safe,
          need: Math.round((safe - qty) * 1000) / 1000,
          unit: it.unit || it.buy || '斤',
          price: num(it.price != null ? it.price : it.cost)
        });
      }
      out.sort((a, b) => a.qty / a.safe - b.qty / b.safe);
      return { count: out.length, items: clamp(out, 12) };
    }
  },

  forecast_restock: {
    desc: '未来若干日营收预测与建议备货（走经营分析预测引擎）。问“下周备多少”用这个。',
    args: { days: '可选，默认 7' },
    run: (args, snap) => {
      const sales = arr((snap.data || {}).sales);
      const byDay = {};
      for (const r of sales) {
        const d = dayOf(r);
        if (!d) continue;
        byDay[d] = (byDay[d] || 0) + amountOf(r);
      }
      const trend = Object.keys(byDay).sort().map((d) => ({ date: d, revenue: byDay[d] }));
      const avg = trend.length ? trend.reduce((s, t) => s + t.revenue, 0) / trend.length : null;
      let fc = null;
      try {
        fc = modules.buildForecast(snap, trend, avg != null ? { daily_avg_revenue: avg } : null);
      } catch (e) { fc = null; }
      if (!fc) return { available: false, note: '样本不足，无法预测' };
      const days = clamp(arr(fc.days), parseInt(args && args.days, 10) || 7);
      const total = days.reduce((s, d) => s + num(d.pred), 0);
      return {
        available: true,
        total_pred: Math.round(total),
        days: days.map((d) => ({ date: d.date, pred: Math.round(num(d.pred)) })),
        restock: clamp(arr(fc.restock), 8).map((x) => ({
          name: x.name, pred: x.pred, unit: x.unit || ''
        }))
      };
    }
  },

  dish_margin: {
    desc: '按真实成本卡列出各菜毛利率，可问答“哪个菜毛利最低/最高”。',
    args: {},
    run: (args, snap) => {
      const recipes = arr((snap.ext || {}).recipes);
      const rows = [];
      for (const r of recipes) {
        try {
          const card = buildCostCard(r, snap.data || {}, recipes);
          if (card && card.gross_margin != null) {
            rows.push({
              name: r.name || r.sku_id, color: r.color || '',
              margin: card.gross_margin, price: card.price, cost: card.portion_cost
            });
          }
        } catch (e) { /* 单菜失败跳过 */ }
      }
      if (!rows.length) return { available: false, note: '暂无可算成本卡（配方或采购价未齐）' };
      rows.sort((a, b) => a.margin - b.margin);
      return { available: true, lowest: clamp(rows, 3), highest: rows[rows.length - 1], count: rows.length };
    }
  },

  sales_trend: {
    desc: '近 N 个营业日营收走势（默认 7 天）。',
    args: { days: '可选，默认 7' },
    run: (args, snap) => {
      const sales = arr((snap.data || {}).sales);
      const byDay = {};
      for (const r of sales) {
        const d = dayOf(r);
        if (!d) continue;
        byDay[d] = (byDay[d] || 0) + amountOf(r);
      }
      const keys = Object.keys(byDay).sort();
      const n = parseInt(args && args.days, 10) || 7;
      const days = keys.slice(-n).map((d) => ({ date: d, revenue: Math.round(byDay[d]) }));
      return { days, latest: days.length ? days[days.length - 1] : null };
    }
  },

  pending_actions: {
    desc: '当前确认台里待处理的动作（待老板拍板 + 待店内执行）。',
    args: {},
    run: () => {
      const q = store.readJSON('actions_queue.json', []);
      const open = arr(q).filter((a) => ['queued', '待执行'].indexOf(a.status) >= 0);
      return {
        count: open.length,
        items: clamp(open, 12).map((a) => ({
          id: a.id, type: a.type, status: a.status,
          title: (a.payload && (a.payload.title || a.payload.note)) || a.type,
          created_at: a.created_at
        }))
      };
    }
  },

  list_alerts: {
    desc: '今日待办与预警（库存/证照/留样/超温/渠道）。',
    args: {},
    run: (args, snap) => {
      try {
        const { deriveReport } = require('../../routes/report');
        const rpt = deriveReport(snap, todayStr());
        return {
          summary: rpt.summary,
          todos: arr(rpt.todos).map((t) => ({ kind: t.kind, text: t.text, route: t.route })),
          alerts: arr(rpt.alerts).map((a) => ({ level: a.level, text: a.text }))
        };
      } catch (e) {
        return { summary: null, todos: [], alerts: [], note: String(e && e.message) };
      }
    }
  }
};

/** 供系统提示使用的工具目录（name + desc + args） */
function catalog() {
  return Object.keys(TOOLS).map((name) => ({
    name,
    desc: TOOLS[name].desc,
    args: TOOLS[name].args || {}
  }));
}

/** 执行工具：未知工具/异常一律返回 {error}，不抛出 */
function runTool(name, args, snap) {
  const t = TOOLS[name];
  if (!t) return { error: 'unknown tool: ' + name };
  try {
    return t.run(args || {}, snap || {});
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}

module.exports = { TOOLS, catalog, runTool, todayStr };
