'use strict';
/*
 * lib/si_team.js — SI 专家团（统筹大型系统与团队）
 *
 * 把门店拆成 6 个专业域，每个"专家"用只读快照做确定性巡检，给出状态/发现/建议。
 * SI 作为总协调者汇总，形成"一个超级智能 + 一支专家团队"的统筹视图。
 * 红线：全部只读；建议如需落地，转确认台或战役（mission）。
 */
function arr(v) { return Array.isArray(v) ? v : []; }
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

function lowStock(data) {
  const out = [];
  for (const it of arr(data.ings)) {
    const qty = num(it && (it.qty != null ? it.qty : it.stock));
    const safe = num(it && (it.safe != null ? it.safe : it.safety));
    if (safe > 0 && qty < safe) out.push({ name: it.name || it.sku, qty, safe });
  }
  return out;
}

function daysUntil(s, now) {
  const t = new Date(String(s || '')).getTime();
  if (isNaN(t)) return null;
  return Math.ceil((t - now) / 86400000);
}

/** 各专家巡检：返回 findings + recommends */
function specialists(snap) {
  const data = (snap && snap.data) || {};
  const ext = (snap && snap.ext && typeof snap.ext === 'object') ? snap.ext : {};
  const now = Date.now();

  // 采购官
  const low = lowStock(data);
  const procure = {
    id: 'procurement', name: '采购官', icon: '采', domain: '进销',
    findings: low.slice(0, 4).map((x) => `${x.name} 现${x.qty}/安全${x.safe}`),
    recommends: low.length
      ? [{ text: `按缺货开采购（${low.length} 项）`, route: 'inventory/restock', action: 'restock.create' }]
      : [{ text: '库存充足，维持', route: 'inventory' }]
  };

  // 食安官
  const certs = arr(ext.fs_certs);
  const samples = arr(ext.fs_samples);
  const soonCerts = certs
    .map((c) => ({ name: c.name || c.holder || c.id, d: daysUntil(c.expire || c.expiry || c.valid_until, now) }))
    .filter((x) => x.d !== null && x.d < 30);
  const sampleDue = samples.filter((s) => {
    const t = new Date(s.ts || s.time || s.created_at).getTime();
    if (isNaN(t)) return false;
    const h = (48 * 3600000 - (now - t)) / 3600000;
    return h < 8;
  });
  const foodsafe = {
    id: 'foodsafe', name: '食安官', icon: '食', domain: '人与合规',
    findings: [
      ...soonCerts.slice(0, 2).map((x) => `${x.name} 证照${x.d < 0 ? '已过期' : '剩 ' + x.d + ' 天'}`),
      ...sampleDue.slice(0, 2).map((s) => `留样临期：${s.dish || s.name || '样本'}`)
    ],
    recommends: (soonCerts.length || sampleDue.length)
      ? [{ text: '处理证照/留样临期', route: 'm/foodsafe' }]
      : [{ text: '食安台账正常', route: 'm/foodsafe' }]
  };

  // 财务官
  let beDay = null, todayRev = 0;
  try {
    const { computeBaobenSummary } = require('./menu_baoben');
    const s = computeBaobenSummary();
    if (s && s.kpi && s.kpi.be_day) beDay = s.kpi.be_day;
  } catch (e) { /* ignore */ }
  const dayOf = (r) => String(r && (r.date || r.ts || r.time || r.created_at) || '').slice(0, 10);
  const todayStr = (() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  })();
  for (const r of arr(data.sales)) if (dayOf(r) === todayStr) todayRev += num(r.amount != null ? r.amount : r.total);
  const loss = arr(ext.loss_reports).reduce((s, r) => s + num(r.amount != null ? r.amount : r.total), 0);
  const totalRev = arr(data.sales).reduce((s, r) => s + num(r.amount != null ? r.amount : r.total), 0);
  const lossRate = totalRev > 0 ? (loss / totalRev) * 100 : 0;
  const finance = {
    id: 'finance', name: '财务官', icon: '财', domain: '钱事',
    findings: [
      beDay ? `今日营收 ¥${todayRev.toFixed(0)} / 保本 ¥${beDay.toFixed(0)}` : `今日营收 ¥${todayRev.toFixed(0)}`,
      `损耗率 ${lossRate.toFixed(2)}%`
    ],
    recommends: (beDay && todayRev < beDay)
      ? [{ text: '未达保本：推套餐/爆品提量', route: 'm/analysis' }]
      : (lossRate > 1 ? [{ text: '损耗超 1%：收紧报损', route: 'm/loss' }] : [{ text: '账面健康', route: 'm/finance' }])
  };

  // 营销官
  const vip = arr(ext.vip_members);
  const bday = vip.filter((m) => m.birthday_soon || m.birthdaySoon).length || Math.min(3, vip.length);
  const marketing = {
    id: 'marketing', name: '营销官', icon: '营', domain: '前厅',
    findings: [
      `会员 ${vip.length} 人`,
      bday ? `${bday} 位近生日` : '近期无生日'
    ],
    recommends: bday
      ? [{ text: `${bday} 位生日券待发`, route: 'm/vip', action: 'vip.campaign' }]
      : [{ text: '可做低谷时段活动', route: 'm/vip' }]
  };

  // 客流官
  const bookings = arr(ext.bookings);
  const takeout = arr(ext.takeout_orders);
  const takeoutOpen = takeout.filter((o) => {
    const st = String(o && (o.status || o.state) || '');
    return st && !/完成|已送达|已取消|closed|done|cancel/i.test(st);
  });
  const bookingPending = bookings.filter((b) => {
    const st = String(b && (b.status || b.state) || '');
    return /待|pending|unconfirm/i.test(st) || !st;
  });
  const traffic = {
    id: 'traffic', name: '客流官', icon: '客', domain: '前厅',
    findings: [
      `预订 ${bookings.length} 桌 · 待确认 ${bookingPending.length}`,
      `外卖待处理 ${takeoutOpen.length} 单`
    ],
    recommends: (bookingPending.length || takeoutOpen.length)
      ? [{ text: '处理预订/外卖待办', route: 'm/booking' }]
      : [{ text: '客流平稳', route: 'm/booking' }]
  };

  // 设备官
  let overs = [];
  try {
    const { equipmentTemps } = require('../routes/modules');
    overs = equipmentTemps(ext).filter((t) => t && t.status === 'over');
  } catch (e) { /* ignore */ }
  const equipment = {
    id: 'equipment', name: '设备官', icon: '设', domain: '人与合规',
    findings: overs.length
      ? overs.slice(0, 3).map((t) => `${t.device || '冷柜'} ${t.temp}℃ 超温`)
      : ['冷柜温度正常'],
    recommends: overs.length
      ? [{ text: '超温告警：核查冷柜', route: 'm/equipment' }]
      : [{ text: '设备正常', route: 'm/equipment' }]
  };

  // 出品官（菜谱 / SOP / 成本健康）
  let recipes = 0, withCost = 0, sopSteps = 0;
  const lowMargin = [];
  try {
    const { buildCostCard } = require('./recipe_cost');
    const rs = arr(ext.recipes);
    recipes = rs.length;
    for (const r of rs) {
      const card = buildCostCard(r, data);
      if (card && card.gross_margin != null) {
        withCost += 1;
        if (card.gross_margin < 40) lowMargin.push({ name: r.name || r.sku_id, margin: card.gross_margin });
      }
    }
    sopSteps = arr(ext.sop_steps).length;
  } catch (e) { /* ignore */ }
  const coverage = recipes > 0 ? Math.round((withCost / recipes) * 100) : null;
  const kitchen = {
    id: 'kitchen', name: '出品官', icon: '厨', domain: '后厨',
    findings: [
      `配方 ${recipes} 道 · 成本卡 ${withCost} 道` + (coverage != null ? `（覆盖 ${coverage}%）` : ''),
      `SOP 工序 ${sopSteps} 步`,
      lowMargin.length
        ? `低毛利菜：${lowMargin.sort((a, b) => a.margin - b.margin).slice(0, 3).map((x) => `${x.name} ${x.margin}%`).join('、')}`
        : '毛利结构健康'
    ],
    recommends: (coverage != null && coverage < 80)
      ? [{ text: '补齐成本卡：未挂菜谱的菜无法算成本/扣料', route: 'kitchen' }]
      : (lowMargin.length
        ? [{ text: '低毛利菜：可调价或换辅料（须确认台）', route: 'm/analysis' }]
        : [{ text: '菜谱与 SOP 标准齐备', route: 'kitchen' }])
  };

  const list = [procure, kitchen, foodsafe, finance, marketing, traffic, equipment];
  for (const s of list) {
    const crit = s.findings.some((f) => /过期|超温|告急|未达/.test(f));
    const warn = s.findings.some((f) => /临期|待处理|待确认|超 1%|低毛利/.test(f));
    s.status = crit ? 'off_track' : (warn ? 'at_risk' : 'on_track');
  }
  return list;
}

function review(snap) {
  const list = specialists(snap);
  const off = list.filter((s) => s.status === 'off_track');
  const risk = list.filter((s) => s.status === 'at_risk');
  const summary = off.length
    ? `${off.length} 位专家告警：${off.map((s) => s.name).join('、')}`
    : (risk.length ? `${risk.length} 位专家提醒：${risk.map((s) => s.name).join('、')}` : '六域巡检正常');
  return {
    ok: true,
    rev: snap ? snap.rev : null,
    updated_at: new Date().toISOString(),
    summary,
    specialists: list,
    counts: { off: off.length, risk: risk.length, on: list.length - off.length - risk.length }
  };
}

module.exports = { review, specialists };
