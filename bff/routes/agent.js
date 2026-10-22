'use strict';
/*
 * routes/agent.js — agent 对话（红线①：只读，绝不调用任何写路径）
 *   POST /api/agent/chat {question, ctx}
 *     → 基于快照只读回答 + 可选 cards（提案 CTA，须 App 确认台，AI 不直写）
 */
const { loadSnapshot } = require('./snapshot');
const planner = require('../lib/agent/planner');
const memory = require('../lib/agent/memory');

/** 本地日期 YYYY-MM-DD（与店内/日报口径一致） */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function lowStock(ings) {
  const out = [];
  for (const it of ings || []) {
    if (!it || typeof it !== 'object') continue;
    const qty = parseFloat(it.qty != null ? it.qty : it.stock);
    const safe = parseFloat(it.safe != null ? it.safe : it.safety);
    if (isNaN(qty) || isNaN(safe) || safe <= 0) continue;
    if (qty < safe) {
      out.push({
        name: it.name || it.sku || '原料',
        qty,
        safe,
        need: +(safe - qty).toFixed(3),
        ing_id: it.id != null ? String(it.id) : (it.sku != null ? String(it.sku) : null),
        unit: it.unit || it.buy || '斤',
        price: parseFloat(it.price != null ? it.price : it.cost) || 0
      });
    }
  }
  out.sort((a, b) => a.qty / a.safe - b.qty / b.safe);
  return out;
}

function restockCard(low) {
  if (!low.length) return null;
  const items = low.slice(0, 8).map((x) => ({
    ing_id: x.ing_id || x.name,
    name: x.name,
    qty: x.need > 0 ? x.need : Math.max(x.safe - x.qty, 1),
    unit: x.unit || '斤',
    price: x.price || 0
  }));
  const names = items.slice(0, 3).map((i) => i.name).join('、') + (items.length > 3 ? '…' : '');
  return {
    title: '按缺货开采购单',
    summary: `优先补 ${items.length} 项（${names}）。系统算好了 · 须老板点确认台才落库。`,
    type: 'restock.create',
    cta_label: '去确认台开单',
    payload: {
      supplier: 'AI建议补货',
      note: '问店AI建议·须老板确认',
      items
    }
  };
}

function workorderCard(snap) {
  const ext = (snap && snap.ext) || {};
  const recipes = Array.isArray(ext.recipes) ? ext.recipes : [];
  const red = recipes.find((r) => r && (r.color === '红' || /红/.test(String(r.name || ''))));
  const sku = (red && (red.sku_id || red.id)) || 'SKU-WF-HONG';
  const name = (red && red.name) || '红色饺子';
  const qty = 68;
  return {
    title: '建本餐挂桌工单',
    summary: `${name} · 计划 ${qty} 个（示范量）。建单后推进制作中会备料扣 BOM。`,
    type: 'workorder.create',
    cta_label: '去确认台建单',
    payload: {
      sku_id: String(sku),
      qty,
      status: '待开始',
      note: '问店AI建议·须老板确认'
    }
  };
}

function dayCloseCard(sales) {
  const amount = (sales || []).reduce((s, r) => {
    const v = parseFloat(r && (r.amount != null ? r.amount : r.total != null ? r.total : r.revenue));
    return s + (isNaN(v) ? 0 : v);
  }, 0);
  return {
    title: '确认打烊日清',
    summary: `今日流水约 ¥${amount.toFixed(0)} · ${sales.length} 笔。打烊登记财务日清，须老板确认。`,
    type: 'day.close',
    cta_label: '去确认台打烊',
    payload: {
      sold_count: sales.length,
      sold_amount: +amount.toFixed(2),
      note: '问店AI建议打烊·须老板确认'
    }
  };
}

function answerFromSnapshot(question, snap) {
  const q = String(question || '');
  const data = (snap && snap.data) || {};
  const ings = Array.isArray(data.ings) ? data.ings : [];
  const dishes = Array.isArray(data.dishes) ? data.dishes : [];
  const quotes = Array.isArray(data.quotes) ? data.quotes : [];
  const sales = Array.isArray(data.sales) ? data.sales : [];
  const low = lowStock(ings);
  const rev = snap && snap.rev;
  const cards = [];

  // 备货/预测：用经营分析的预测引擎（营收趋势 + 建议备货），而非简单的低库存清单
  if (/备货|备多少|预测|下周|这周|明天|明日/.test(q)) {
    let fc = null;
    try {
      const byDay = {};
      for (const r of sales) {
        const d = String((r && (r.date || r.ts || r.time || r.created_at)) || '').slice(0, 10);
        if (!d) continue;
        const v = parseFloat(r && (r.amount != null ? r.amount : r.total != null ? r.total : r.revenue));
        byDay[d] = (byDay[d] || 0) + (isNaN(v) ? 0 : v);
      }
      const trend = Object.keys(byDay).sort().map((d) => ({ date: d, revenue: byDay[d] }));
      const avg = trend.length ? trend.reduce((s, t) => s + t.revenue, 0) / trend.length : null;
      fc = require('./modules').buildForecast(snap, trend, avg != null ? { daily_avg_revenue: avg } : null);
    } catch (e) { fc = null; }
    if (fc && Array.isArray(fc.days) && fc.days.length) {
      const total = fc.days.reduce((s, d) => s + (d.pred || 0), 0);
      const top = (fc.restock || []).slice(0, 6)
        .map((x) => `${x.name} 约${x.pred}${x.unit || ''}`).join('；');
      const card = restockCard(low);
      if (card) cards.push(card);
      return {
        answer: `快照 rev=${rev}：未来 7 日营收预测合计约 ¥${total.toFixed(0)}（含周末上浮）。`
          + (top ? `建议备货：${top}。` : '建议备货见「进销·缺货」。')
          + '预测≠下单，转采购须确认台。',
        cards
      };
    }
    // 预测不可用时回落到低库存清单
  }

  if (/补货|断料|告急|库存|原料|备货|下周/.test(q)) {
    const card = restockCard(low);
    if (card) cards.push(card);
    if (!low.length) {
      return {
        answer: `快照 rev=${rev}：当前 ${ings.length} 种原料均不低于安全线。`,
        cards
      };
    }
    const top = low.slice(0, 5).map((x) => `${x.name} 现${x.qty}/安全${x.safe}（建议补${x.need}）`).join('；');
    return {
      answer: `快照 rev=${rev}：共 ${low.length} 项低于安全线。优先：${top}。点下方提案进确认台开采购单（AI 不直接下单）。`,
      cards
    };
  }

  if (/营收|销售|订单|生意/.test(q)) {
    const dayOf = (r) => String((r && (r.date || r.ts || r.time || r.created_at)) || '').slice(0, 10);
    const amountOf = (r) => {
      const v = parseFloat(r && (r.amount != null ? r.amount : r.total != null ? r.total : r.revenue));
      return isNaN(v) ? 0 : v;
    };
    const byDay = {};
    for (const r of sales) {
      const d = dayOf(r);
      if (!d) continue;
      byDay[d] = (byDay[d] || 0) + amountOf(r);
    }
    const days = Object.keys(byDay).sort();
    const latestDay = days[days.length - 1] || null;
    const today = todayStr();
    const asksToday = /今天|今日|当天|现在/.test(q);
    const todayRows = sales.filter((r) => dayOf(r) === today);
    const todayRev = todayRows.reduce((s, r) => s + amountOf(r), 0);
    if (asksToday) {
      if (todayRows.length) {
        const avg = todayRev / todayRows.length;
        return {
          answer: `快照 rev=${rev}：今日（${today}）营收约 ¥${todayRev.toFixed(0)} · ${todayRows.length} 单 · 客单价约 ¥${avg.toFixed(1)}。`
            + (latestDay && latestDay !== today ? `最近营业日 ${latestDay} 为 ¥${byDay[latestDay].toFixed(0)}。` : ''),
          cards
        };
      }
      if (latestDay) {
        return {
          answer: `快照 rev=${rev}：今日（${today}）暂无销售记录（营业后自动更新）。最近营业日 ${latestDay} 营收 ¥${byDay[latestDay].toFixed(0)}。`,
          cards
        };
      }
      return { answer: `快照 rev=${rev}：暂无销售流水（店内未推送）。`, cards };
    }
    const total = sales.reduce((s, r) => s + amountOf(r), 0);
    if (/打烊|日清|收工/.test(q)) cards.push(dayCloseCard(sales));
    return {
      answer: `快照 rev=${rev}：快照内销售流水共 ${sales.length} 笔、累计约 ¥${total.toFixed(0)}`
        + (latestDay ? `；最近营业日 ${latestDay} 约 ¥${byDay[latestDay].toFixed(0)}。` : '。')
        + '（如需「今天」，可问“今天营收怎么样”。）',
      cards
    };
  }

  if (/打烊|日清|收工/.test(q)) {
    cards.push(dayCloseCard(sales));
    return {
      answer: `快照 rev=${rev}：可登记打烊日清。流水 ${sales.length} 笔。点下方提案进确认台（AI 不自动打烊）。`,
      cards
    };
  }

  // 毛利：用真实成本卡（recipe_cost）按菜/色算毛利率，直接回答「哪个最低/最高」
  if (/毛利|成本|利润|赚/.test(q) && !/工单|做|份|备料|菜单|怎么做/.test(q)) {
    const rows = [];
    try {
      const costLib = require('../lib/recipe_cost');
      const recipes = Array.isArray(snap.ext && snap.ext.recipes) ? snap.ext.recipes : [];
      for (const r of recipes) {
        try {
          const card = costLib.buildCostCard(r, data, recipes);
          if (card && card.gross_margin != null) {
            rows.push({
              name: r.name || r.sku_id, color: r.color || '',
              margin: card.gross_margin, price: card.price, cost: card.portion_cost
            });
          }
        } catch (e) { /* 单菜成本卡失败跳过 */ }
      }
    } catch (e) { /* 无成本卡库 */ }
    if (rows.length) {
      rows.sort((a, b) => a.margin - b.margin);
      const low3 = rows.slice(0, 3)
        .map((x) => `${x.name}（毛利${x.margin}%·成本¥${x.cost}/售¥${x.price}）`).join('；');
      const best = rows[rows.length - 1];
      return {
        answer: `快照 rev=${rev}：按真实成本卡测算 ${rows.length} 道。毛利率最低：${low3}。`
          + `最高：${best.name} ${best.margin}%。提价/换料可去「菜品厨房」调价（须确认台）。`,
        cards
      };
    }
    try {
      const { computeBaobenSummary } = require('../lib/menu_baoben');
      const s = computeBaobenSummary();
      if (s && Array.isArray(s.types) && s.types.length) {
        const t = s.types.slice().sort((a, b) => b.cost_rate - a.cost_rate)[0];
        return {
          answer: `快照 rev=${rev}：按保本价盘，成本率最高（毛利最低）的是「${t.name}」——`
            + `成本率 ${t.cost_rate}%、毛利率约 ${(100 - t.cost_rate).toFixed(1)}%（${t.n} 道）。`,
          cards
        };
      }
    } catch (e) { /* ignore */ }
    return {
      answer: `快照 rev=${rev}：暂无可用成本卡（配方或原料采购价未齐），无法估算毛利。补齐菜谱与采购价后可再问。`,
      cards
    };
  }

  if (/菜|菜单|饺子|毛利|工单|做.*份|备料/.test(q)) {
    const names = dishes.slice(0, 8).map((d) => d.name || d.id).filter(Boolean);
    if (/工单|做|备料|份/.test(q)) cards.push(workorderCard(snap));
    return {
      answer: `快照 rev=${rev}：在册菜品 ${dishes.length} 道` +
        (names.length ? `，例如：${names.join('、')}` : '') +
        '。毛利请以店内进销存计价（移动加权）为准，AI 不做成本估算。' +
        (cards.length ? ' 可点下方提案建工单。' : ''),
      cards
    };
  }

  if (/比价|供应商|报价/.test(q)) {
    return {
      answer: `快照 rev=${rev}：外接报价 ${quotes.length} 条。可在管理后台「供应商比价」或 App「供应链」查看；下单须经确认台。`,
      cards
    };
  }

  if (/品控|质检|合格/.test(q)) {
    const qc = snap.ext && Array.isArray(snap.ext.qc_records) ? snap.ext.qc_records : [];
    return {
      answer: `快照 rev=${rev}：品控记录 ${qc.length} 条。可用厨房 Tab「品控」拍照走 Kimi 视觉复核。`,
      cards
    };
  }

  return null;
}

const SUGGESTIONS = ['哪些原料需要补货？', '今天营收怎么样？', '哪个色毛利最低？', '今天有哪些待办和预警？'];

function fallbackAnswer(question, snap) {
  const packed = (snap && snap.data) ? answerFromSnapshot(question, snap) : null;
  const answer = packed && packed.answer
    ? packed.answer
    : (snap
      ? `已读到店内快照 rev=${snap.rev}。可问：补货、营收、毛利、菜品、工单、打烊、比价、品控。`
      : '云端暂无店内快照。请先启动进销存并推送 snapshot，或先用进销 Tab 查看。');
  return { answer, cards: (packed && Array.isArray(packed.cards)) ? packed.cards : [], steps: [] };
}

/** SI 优先（LLM+工具），失败/未配置降级到规则快照问答 */
async function resolveAnswer(question, snap, storeId, onStep) {
  if (snap) {
    try {
      const si = await planner.runAgent({ question, snap, onStep });
      if (si && si.answer) {
        memory.append(storeId, { q: question, a: si.answer });
        return { answer: si.answer, cards: si.cards, steps: si.steps, engine: 'si' };
      }
    } catch (e) {
      console.error('[BFF][agent] SI planner failed:', e && e.message);
    }
  }
  const fb = fallbackAnswer(question, snap);
  return { answer: fb.answer, cards: fb.cards, steps: [], engine: 'rules' };
}

async function readQuestion(req, ctx) {
  const { buf } = await ctx.readBody(req);
  let body = null;
  try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
  body = body || {};
  return typeof body.question === 'string' ? body.question.trim() : '';
}

async function handle(req, res, ctx, pathname) {
  if (req.method === 'POST' && pathname === '/api/agent/chat') {
    const question = await readQuestion(req, ctx);
    const snap = loadSnapshot();
    const packed = await resolveAnswer(question, snap, ctx.storeId, null);
    ctx.sendJSON(res, 200, {
      ok: true,
      engine: packed.engine,
      answer: packed.answer,
      cards: packed.cards,
      steps: packed.steps,
      suggestions: SUGGESTIONS,
      rev: snap ? snap.rev : null,
      trace_id: ctx.traceId,
      echo: question ? question.slice(0, 200) : null,
      note: snap
        ? (packed.engine === 'si' ? 'SI 已用只读工具取数 · 提案进确认台 · AI 不写库' : '规则快照答案 · AI 不写库')
        : '无快照 · 请先推送 snapshot'
    });
    return true;
  }

  // POST /api/agent/stream —— SSE：stage(工具进度) / delta(答案) / done(卡片) / error
  if (req.method === 'POST' && pathname === '/api/agent/stream') {
    const question = await readQuestion(req, ctx);
    const snap = loadSnapshot();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Trace-Id',
      'X-Trace-Id': ctx.traceId,
      'X-Accel-Buffering': 'no'
    });
    const writeEvent = (name, data) => {
      if (res.writableEnded) return;
      try { res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {}
    };
    writeEvent('stage', { stage: 'thinking' });

    let packed;
    try {
      packed = await resolveAnswer(question, snap, ctx.storeId, (step) => {
        writeEvent('stage', { stage: 'tool', tool: step.tool, ok: step.ok });
      });
    } catch (e) {
      writeEvent('error', { ok: false, error: String(e && e.message || e) });
      try { res.end(); } catch (e2) {}
      return true;
    }

    // 逐段吐字，给老板“在说”的观感（答案本身已由后端取全）
    const answer = String(packed.answer || '');
    const CHUNK = 8;
    for (let i = 0; i < answer.length; i += CHUNK) {
      writeEvent('delta', { delta: answer.slice(i, i + CHUNK) });
      await new Promise((r) => setTimeout(r, 18));
      if (res.writableEnded) break;
    }
    writeEvent('done', {
      ok: true,
      engine: packed.engine,
      answer,
      cards: packed.cards,
      suggestions: SUGGESTIONS,
      rev: snap ? snap.rev : null,
      traceId: ctx.traceId
    });
    try { res.end(); } catch (e) {}
    return true;
  }
  return false;
}

module.exports = { handle };
