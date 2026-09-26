'use strict';
/*
 * routes/agent.js — agent 对话（红线①：只读，绝不调用任何写路径）
 *   POST /api/agent/chat {question, ctx}
 *     → 基于快照只读回答 + 可选 cards（提案 CTA，须 App 确认台，AI 不直写）
 */
const { loadSnapshot } = require('./snapshot');

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
    const revenue = sales.reduce((s, r) => {
      const v = parseFloat(r && (r.amount != null ? r.amount : r.total != null ? r.total : r.revenue));
      return s + (isNaN(v) ? 0 : v);
    }, 0);
    if (/打烊|日清|收工/.test(q)) cards.push(dayCloseCard(sales));
    return {
      answer: `快照 rev=${rev}：销售流水 ${sales.length} 笔，累计金额约 ¥${revenue.toFixed(0)}` +
        (sales.length === 0 ? '（店内暂无销售流水推送，日报可能为 mock/空）。' : '。详细分时可看简报热力。'),
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

async function handle(req, res, ctx, pathname) {
  if (req.method === 'POST' && pathname === '/api/agent/chat') {
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    body = body || {};
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    const snap = loadSnapshot();
    let packed = null;
    if (snap && snap.data) packed = answerFromSnapshot(question, snap);

    const suggestions = ['哪些原料需要补货？', '今天营收怎么样？', '建本餐工单', '确认打烊'];
    const answer = packed && packed.answer
      ? packed.answer
      : (snap
        ? `已读到店内快照 rev=${snap.rev}。可问：补货、营收、菜品、工单、打烊、比价、品控。`
        : '云端暂无店内快照。请先启动进销存并推送 snapshot，或先用进销 Tab 查看。');
    const cards = (packed && Array.isArray(packed.cards)) ? packed.cards : [];

    ctx.sendJSON(res, 200, {
      ok: true,
      answer,
      cards,
      suggestions,
      rev: snap ? snap.rev : null,
      trace_id: ctx.traceId,
      echo: question ? question.slice(0, 200) : null,
      note: snap
        ? (cards.length
          ? '只读快照 + 提案 CTA · 点卡片进确认台 · AI 不写库'
          : '只读快照答案 · AI 不写库')
        : 'agent 决策层待完善 · 无快照'
    });
    return true;
  }
  return false;
}

module.exports = { handle };
