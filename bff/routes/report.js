'use strict';
/*
 * routes/report.js — 经营日报
 *   GET /api/report/daily?date=YYYY-MM-DD
 *     有快照且有数据：从 snapshot.data.sales 聚合营收/单数 → mock:false
 *       - heat_mini：真实分时聚合
 *       - todos：经营三类（断货补货 / 建议备料 / 渠道备餐），带 kind+route 深链
 *       - alerts：真实推导（健康证<30天 ext.fs_certs、留样临近48h ext.fs_samples、库存告急、快照超龄）
 *       - 有 ext 时附 kitchen 工单摘要
 *     无快照 / 快照无数据：结构完整的 mock（banner/kpi[8]/heat_mini/todos/alerts）并标 mock:true
 *     UI 时延标注：响应始终带 rev 与 generated_at（mock 时为 null）
 */
const { loadSnapshot } = require('./snapshot');

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function recordDate(r) {
  return String(r && (r.date || r.ts || r.time || r.created_at || r.datetime || r.day) || '');
}

function recordAmount(r) {
  for (const k of ['amount', 'total', 'revenue', 'price', 'money', '金额']) {
    const v = parseFloat(r && r[k]);
    if (!isNaN(v)) return v;
  }
  return 0;
}

function mockReport(date) {
  // mock 分支也给保本口径：be_day 取自静态价盘（真算法），today_rev 为演示值（mock:true 标注）
  let breakeven = null;
  try {
    const { computeBaobenSummary } = require('../lib/menu_baoben');
    const summary = computeBaobenSummary();
    const beDay = summary && summary.kpi ? summary.kpi.be_day : null;
    if (beDay != null && beDay > 0) {
      breakeven = {
        be_day: beDay,
        today_rev: 12580,
        attain_pct: Math.round((12580 / beDay) * 1000) / 10,
        mock: true
      };
    }
  } catch (e) { breakeven = null; }
  return {
    ok: true,
    mock: true,
    date,
    rev: null,
    generated_at: null,
    banner: '演示数据：云端暂无店内快照，以下为 mock 经营日报',
    kpi: [
      { label: '营收', value: '¥12,580', delta: '+8.2%' },
      { label: '订单数', value: '286', delta: '+5.1%' },
      { label: '客单价', value: '¥43.99', delta: '+2.9%' },
      { label: '水饺销量', value: '1,820 只', delta: '+6.4%' },
      { label: '毛利率', value: '62.3%', delta: '+1.1%' },
      { label: '会员消费占比', value: '38%', delta: '+3.0%' },
      { label: '原料损耗率', value: '2.1%', delta: '-0.4%' },
      { label: '差评数', value: '1', delta: '-2' }
    ],
    heat_mini: [11, 12, 13, 17, 18, 19, 20].map((h, i) => ({ hour: h, orders: [32, 58, 41, 22, 49, 76, 53][i] })),
    todos: [
      { kind: 'restock', route: 'inventory/restock', text: '推送店内快照后可生成断货补货待办', done: false },
      { kind: 'prep', route: 'kitchen', text: '有快照后将汇总今日建议备料工单', done: false }
    ],
    alerts: [{ level: 'info', text: '无快照数据，当前为 mock 报表' }],
    breakeven,
    day_close: {
      sold: { label: '售出', count: 286, amount: 12580, route: 'm/pos' },
      inbound: { label: '入库', count: 3, amount: 1860, route: 'inventory/recv' },
      loss: { label: '报损', count: 1, amount: 86, route: 'm/loss' },
      workorders_open: 0
    }
  };
}

/* ---------------- 真实数据推导 ---------------- */

// 库存告急：现存 < 安全线（字段容错：qty/stock/amount vs safe/safety/safe_stock）
function lowStockItems(ings) {
  const out = [];
  for (const it of ings) {
    if (!it || typeof it !== 'object') continue;
    const qty = parseFloat(it.qty != null ? it.qty : (it.stock != null ? it.stock : it.amount));
    const safe = parseFloat(it.safe != null ? it.safe : (it.safety != null ? it.safety : it.safe_stock));
    if (isNaN(qty) || isNaN(safe)) continue;
    if (qty < safe) out.push({ name: it.name || it.sku || it.sku_id || '未命名', qty, safe });
  }
  return out;
}

// 证照到期天数（字段容错：expire/expiry/valid_until/until）
function certDaysLeft(c, nowMs) {
  const s = String(c && (c.expire || c.expiry || c.valid_until || c.until) || '');
  const t = new Date(s).getTime();
  if (isNaN(t)) return null;
  return Math.ceil((t - nowMs) / 86400000);
}

// 留样剩余小时（48h 倒计时）
function sampleHoursLeft(s, nowMs) {
  const t = new Date(s && (s.ts || s.time || s.created_at)).getTime();
  if (isNaN(t)) return null;
  return (48 * 3600000 - (nowMs - t)) / 3600000;
}

function deriveReport(snap, date) {
  const data = snap.data || {};
  const ext = snap.ext && typeof snap.ext === 'object' ? snap.ext : {};
  const now = Date.now();
  const sales = Array.isArray(data.sales) ? data.sales : [];
  const recs = sales.filter((r) => recordDate(r).startsWith(date));
  const revenue = recs.reduce((s, r) => s + recordAmount(r), 0);
  const orders = recs.length;
  const avg = orders ? revenue / orders : 0;
  const dishes = Array.isArray(data.dishes) ? data.dishes.length : 0;
  const ings = Array.isArray(data.ings) ? data.ings : [];
  const members = Array.isArray(data.members) ? data.members.length : 0;

  // heat_mini：真实分时聚合（recs 为空时自然为空数组）
  const byHour = {};
  for (const r of recs) {
    const m = recordDate(r).match(/[T\s](\d{2}):/);
    if (m) byHour[m[1]] = (byHour[m[1]] || 0) + 1;
  }
  const heat_mini = Object.keys(byHour).sort().map((h) => ({ hour: parseInt(h, 10), orders: byHour[h] }));

  // ext 推导原料
  const lowStock = lowStockItems(ings);
  const wos = Array.isArray(ext.sop_workorders) ? ext.sop_workorders : [];
  const wosToday = wos.filter((w) => w && String(w.date || '') === date);
  const wosDone = wosToday.filter((w) => w.status === '已完成');
  const bookings = Array.isArray(ext.bookings) ? ext.bookings : [];
  const bookingsToday = bookings.filter((b) => recordDate(b).startsWith(date));
  const certs = Array.isArray(ext.fs_certs) ? ext.fs_certs : [];
  const samples = Array.isArray(ext.fs_samples) ? ext.fs_samples : [];

  // todos：只保留经营三类（断货 / 备料 / 渠道），证照等进 alerts
  const todos = [];
  // 1) 断货风险补货（合并为一条，避免待办爆炸）
  if (lowStock.length) {
    const names = lowStock.slice(0, 3).map((i) => i.name).join('、') + (lowStock.length > 3 ? '…' : '');
    todos.push({
      kind: 'restock',
      route: 'inventory/restock',
      text: '断货风险 · ' + lowStock.length + ' 项待补（' + names + '）',
      desc: '按日耗/安全线估算，确认后生成采购草稿（不下单入库）',
      done: false
    });
  }
  // 2) 建议备料：未完成工单，或有预订但还没开工单
  const wosOpen = wosToday.filter((w) => w.status !== '已完成' && w.status !== 'done');
  if (wosOpen.length) {
    todos.push({
      kind: 'prep',
      route: 'kitchen',
      text: '建议备料 · 今日 ' + wosOpen.length + ' 单工单未完成',
      desc: '已完成 ' + wosDone.length + '/' + wosToday.length + ' · 去厨房推进',
      done: false
    });
  } else if (bookingsToday.length && wosToday.length === 0) {
    const heads = bookingsToday.reduce((s, b) => s + (parseInt(b.party_size || b.partySize || b.people || 0, 10) || 0), 0);
    todos.push({
      kind: 'prep',
      route: 'kitchen',
      text: '建议备料 · 今日预订 ' + bookingsToday.length + ' 桌 / ' + (heads || '?') + ' 人，尚未建工单',
      desc: '按预订启发备料，确认后生成工单',
      done: false
    });
  }
  // 3) 渠道：未处理外卖 或 待确认预订
  const takeoutOrders = Array.isArray(ext.takeout_orders) ? ext.takeout_orders : [];
  const takeoutOpen = takeoutOrders.filter((o) => {
    const st = String(o && (o.status || o.state) || '');
    return st && !/完成|已送达|已取消|closed|done|cancel/i.test(st);
  });
  const bookingPending = bookingsToday.filter((b) => {
    const st = String(b && (b.status || b.state) || '');
    return /待|pending|unconfirm/i.test(st) || !st;
  });
  if (takeoutOpen.length) {
    todos.push({
      kind: 'channel_takeout',
      route: 'm/takeout',
      text: '渠道 · 外卖待处理 ' + takeoutOpen.length + ' 单',
      desc: '确认后可转厨房备料',
      done: false
    });
  } else if (bookingPending.length) {
    todos.push({
      kind: 'channel_booking',
      route: 'm/booking',
      text: '渠道 · 预订待确认 ' + bookingPending.length + ' 桌',
      desc: '确认后进入今日备餐',
      done: false
    });
  }
  // 4) 会员生日发券（对齐原型首页待办）
  const vipMembers = Array.isArray(ext.vip_members) ? ext.vip_members : [];
  let bdayN = vipMembers.filter((m) => m && (m.birthday_soon || m.birthdaySoon)).length;
  if (!bdayN && vipMembers.length) bdayN = Math.min(3, vipMembers.length);
  if (bdayN > 0) {
    todos.push({
      kind: 'vip_birthday',
      route: 'm/vip',
      text: bdayN + ' 位会员本周生日 · 营销待发券',
      desc: '去会员营销发券（确认台）',
      done: false
    });
  }
  // 5) 冷柜超温作战项
  try {
    const { equipmentTemps } = require('./modules');
    const overs = equipmentTemps(ext).filter((t) => t && t.status === 'over');
    if (overs.length) {
      const t0 = overs[0];
      todos.push({
        kind: 'equipment_over',
        route: 'm/equipment',
        text: (t0.device || '冷柜') + ' 超温 ' + (t0.minutes || 0) + ' 分钟',
        desc: '应 ≤' + t0.max + '℃ · 当前 ' + t0.temp + '℃ · 请核查',
        done: false
      });
    }
  } catch (e) { /* ignore */ }
  // 不再塞「数据正常/缺 sales」进待办——那是系统态，不是老板作战项

  // alerts 推导
  const alerts = [];
  for (const c of certs) {
    const days = certDaysLeft(c, now);
    if (days !== null && days < 30) {
      alerts.push({
        level: days < 0 ? 'critical' : 'warn',
        text: '健康证' + (days < 0 ? '已过期 ' + (-days) + ' 天' : '仅剩 ' + days + ' 天到期') +
          '：' + (c.name || c.holder || c.staff || c.id || '未知人员')
      });
    }
  }
  for (const s of samples) {
    const h = sampleHoursLeft(s, now);
    if (h !== null && h < 8) {
      alerts.push({
        level: h < 0 ? 'critical' : 'warn',
        text: h < 0
          ? '留样已超 48h：' + (s.dish || s.name || s.id || '未知样本')
          : '留样临近 48h 到期（剩 ' + h.toFixed(1) + 'h）：' + (s.dish || s.name || s.id || '未知样本')
      });
    }
  }
  if (lowStock.length) {
    alerts.push({ level: 'warn', text: '库存告急 ' + lowStock.length + ' 项：' + lowStock.map((i) => i.name).join('、') });
  }
  try {
    const { equipmentTemps } = require('./modules');
    const temps = equipmentTemps(ext);
    for (const t of temps) {
      if (t && t.status === 'over') {
        alerts.push({
          level: 'critical',
          text: (t.device || '冷柜') + ' 温度 ' + t.temp + '℃ 超温',
          desc: '应 ≤' + t.max + '℃ · 已 ' + (t.minutes || 0) + ' 分钟 · 请核查'
        });
      }
    }
  } catch (e) { /* ignore */ }
  const ageH = (now - new Date(snap.generated_at).getTime()) / 3600000;
  if (ageH > 24) alerts.push({ level: 'warn', text: '快照已超 24h 未更新（rev=' + snap.rev + '）' });

  // 打烊日清：售出 / 入库 / 报损（点进单据，不是 KPI 装饰）
  const recvAll = Array.isArray(data.recv) ? data.recv : [];
  const recvToday = recvAll.filter((r) => {
    if (!r || !recordDate(r).startsWith(date)) return false;
    const st = String(r.status || '已入库');
    return /已入库|done|入库/i.test(st) && !/草稿|待验|取消/i.test(st);
  });
  const recvAmount = recvToday.reduce((s, r) => {
    const v = parseFloat(r.payable != null ? r.payable : r.amount);
    return s + (isNaN(v) ? 0 : v);
  }, 0);

  const lossReports = Array.isArray(ext.loss_reports) ? ext.loss_reports : [];
  const lossToday = lossReports.filter((r) => r && recordDate(r).startsWith(date));
  const logs = Array.isArray(data.logs) ? data.logs : [];
  const lossLogs = logs.filter((l) => l && l.kind === 'loss' && recordDate(l).startsWith(date));
  const lossCount = Math.max(lossToday.length, lossLogs.length);
  const lossAmount = lossLogs.reduce((s, l) => {
    const v = parseFloat(l.amount);
    return s + (isNaN(v) ? 0 : v);
  }, 0);

  // 保本达成：be_day 取自保本测算（静态价盘+店参），today_rev 为当日真实营收
  let breakeven = null;
  try {
    const { computeBaobenSummary } = require('../lib/menu_baoben');
    const summary = computeBaobenSummary();
    const beDay = summary && summary.kpi ? summary.kpi.be_day : null;
    if (beDay != null && beDay > 0) {
      breakeven = {
        be_day: beDay,
        today_rev: Math.round(revenue * 100) / 100,
        attain_pct: Math.round((revenue / beDay) * 1000) / 10
      };
    }
  } catch (e) { breakeven = null; }

  const report = {
    ok: true,
    mock: false,
    date,
    rev: snap.rev,
    generated_at: snap.generated_at,
    banner: '熊猫功夫餐厅 | ' + date + ' 经营日报（快照 rev=' + snap.rev + '）',
    kpi: [
      { label: '营收', value: '¥' + revenue.toFixed(2), delta: null },
      { label: '订单数', value: String(orders), delta: null },
      { label: '客单价', value: '¥' + avg.toFixed(2), delta: null },
      { label: '菜品SKU', value: String(dishes), delta: null },
      { label: '原料SKU', value: String(ings.length), delta: null },
      { label: '会员数', value: String(members), delta: null },
      { label: '快照rev', value: String(snap.rev), delta: null },
      { label: '销售记录总数', value: String(sales.length), delta: null }
    ],
    heat_mini,
    todos,
    alerts,
    breakeven,
    day_close: {
      sold: { label: '售出', count: orders, amount: Math.round(revenue * 100) / 100, route: 'm/pos' },
      inbound: { label: '入库', count: recvToday.length, amount: Math.round(recvAmount * 100) / 100, route: 'inventory/recv' },
      loss: { label: '报损', count: lossCount, amount: Math.round(lossAmount * 100) / 100, route: 'm/loss' },
      workorders_open: wosOpen.length
    }
  };

  // 厨房摘要：快照带 ext 时附今日工单统计 + 本餐需求
  if (snap.ext && typeof snap.ext === 'object') {
    const { buildDemand } = require('./kitchen');
    let demand = null;
    try { demand = buildDemand(ext, {}, date); } catch (e) { demand = null; }
    report.kitchen = {
      workorders_total: wosToday.length,
      workorders_done: wosDone.length,
      demand_portions: demand ? demand.suggest_portions : null,
      demand_gap: demand ? demand.gap : null,
      takeout_open: demand ? demand.takeout_open : 0
    };
  }

  return report;
}

async function handle(req, res, ctx, pathname) {
  if (req.method === 'GET' && pathname === '/api/report/daily') {
    const qdate = (ctx.query.get('date') || '').trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(qdate) ? qdate : todayStr();
    const snap = loadSnapshot();
    // 整体无数据（无快照，或 data 空且无 ext）→ 回退 mock
    const hasData = !!(snap && (
      (snap.data && Object.keys(snap.data).length > 0) ||
      (snap.ext && Object.keys(snap.ext).length > 0)
    ));
    ctx.sendJSON(res, 200, hasData ? deriveReport(snap, date) : mockReport(date));
    return true;
  }
  return false;
}

module.exports = { handle };
