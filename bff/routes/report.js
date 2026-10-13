'use strict';
/*
 * routes/report.js — 经营日报
 *   GET /api/report/daily?date=YYYY-MM-DD&range=7|30|all
 *     range（FP-DASH-01，旧版 #dashRange HTML:194-198）：默认 30；区间 = [date-(r-1), date]，
 *     营收/订单数/客单价/采购应付按区间聚合；热度、晨报、打烊、保本达成始终按当日。
 *     有快照且有数据：从 snapshot.data.sales 聚合营收/单数 → mock:false
 *       - heat_mini：真实分时聚合
 *       - todos：经营三类（断货补货 / 建议备料 / 渠道备餐），带 kind+route 深链
 *       - alerts：真实推导（健康证<30天 ext.fs_certs、留样临近48h ext.fs_samples、库存告急、快照超龄）
 *       - 有 ext 时附 kitchen 工单摘要
 *     无快照 / 快照无数据：结构完整的 mock（banner/kpi[8]/heat_mini/todos/alerts）并标 mock:true
 *     UI 时延标注：响应始终带 rev 与 generated_at（mock 时为 null）
 */
const { loadSnapshot } = require('./snapshot');
// FP-DASH-05/15：复用导出层既有成本解析（dishCostMap/dishResolver/costOfDish/near30Agg），
// 单一公式源，不另写第二份成本口径
const { dishCostMap, dishResolver, costOfDish, near30Agg } = require('./export');

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

function num(v, d) { const n = parseFloat(v); return isNaN(n) ? (d == null ? 0 : d) : n; }
function arr(x) { return Array.isArray(x) ? x : []; }
function r2(x) { return Math.round((Number(x) + Number.EPSILON) * 100) / 100; }

function mockReport(date, rangeRaw) {
  // 无快照时的真实空态：不编造 KPI / 热度 / 日结；仅保留保本口径（be_day 取自静态价盘，真算法）
  const range = parseRange(rangeRaw);
  const rangeFrom = rangeStart(range, date);
  let breakeven = null;
  try {
    const { computeBaobenSummary } = require('../lib/menu_baoben');
    const summary = computeBaobenSummary();
    const beDay = summary && summary.kpi ? summary.kpi.be_day : null;
    if (beDay != null && beDay > 0) {
      breakeven = { be_day: beDay, today_rev: null, attain_pct: null, mock: true };
    }
  } catch (e) { breakeven = null; }
  return {
    ok: true,
    mock: true,
    date,
    rev: null,
    generated_at: null,
    // FP-DASH-01：空态也回传周期字段，前端 chips 与区间文字照常可用
    range,
    range_label: rangeLabelOf(range, rangeFrom, date),
    range_from: rangeFrom,
    range_to: date,
    banner: '暂无店内数据：云端未收到门店快照',
    kpi: [],
    heat_mini: [],
    low_stock: { total: 0, items: [] },
    todos: [
      { kind: 'restock', route: 'inventory/restock', text: '推送店内快照后可生成断货补货待办', done: false },
      { kind: 'prep', route: 'kitchen', text: '有快照后将汇总今日建议备料工单', done: false }
    ],
    alerts: [{ level: 'info', text: '云端未收到门店快照' }],
    breakeven,
    day_close: null
  };
}

/* ---------------- 真实数据推导 ---------------- */

// 库存告急：现存 < 安全线（字段容错：qty/stock/amount vs safe/safety/safe_stock）
// FP-DASH-11：补 id/cat/unit 供概览页明细列表（旧版 #lowStockBox，HTML:1280-1285）
function lowStockItems(ings) {
  const out = [];
  for (const it of ings) {
    if (!it || typeof it !== 'object') continue;
    if (it.on === false) continue; // 旧版 lowStocks() 只算在售原料（HTML:1279 `g.on&&`）
    const qty = parseFloat(it.qty != null ? it.qty : (it.stock != null ? it.stock : it.amount));
    const safe = parseFloat(it.safe != null ? it.safe : (it.safety != null ? it.safety : it.safe_stock));
    if (isNaN(qty) || isNaN(safe)) continue;
    if (qty < safe) {
      out.push({
        id: it.id || it.sku_id || null,
        name: it.name || it.sku || it.sku_id || '未命名',
        cat: it.cat || '',
        unit: it.unit || '',
        qty,
        safe,
      });
    }
  }
  return out;
}

/* ---------------- FP-DASH-01 统计周期（旧版 DASH_R/inRange/rangeLabel，HTML:1221-1223） ---------------- */
const DASH_RANGES = ['7', '30', 'all'];
/** 默认周期 = 旧版 DASH_R 初值 30（HTML:1221；#dashRange 里「近30天」chip 默认 on，HTML:196） */
const DEFAULT_DASH_RANGE = '30';

/** 查询参数 → 周期；非法值回落默认。仅 HTTP 层调用 */
function parseRange(q) {
  const v = String(q == null ? '' : q).trim();
  return DASH_RANGES.indexOf(v) >= 0 ? v : DEFAULT_DASH_RANGE;
}

/** 区间下界：近 r 天 = [date-(r-1), date]（旧版下界 daysAgo(r-1)，HTML:1222）；all = 无下界 */
function rangeStart(range, date) {
  if (range !== '7' && range !== '30') return null;
  const d = new Date(date + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() - (parseInt(range, 10) - 1));
  return dateStr(d);
}

/** 区间文字（旧版 rangeLabel，HTML:1223）：全部时间 / 近N天（起 至 止） */
function rangeLabelOf(range, from, to) {
  return range === 'all'
    ? '全部时间（截至 ' + to + '）'
    : '近' + range + '天（' + (from || '—') + ' 至 ' + to + '）';
}

/**
 * 周期判定：不传 range（agent/inbox 等程序化调用）时保持既有「当日」口径；
 * 传 7/30/all 时按 [下界, 截止日] 过滤（旧版无上界，新版加截止日上界，避免未来日期混入）
 */
function makeInDashRange(range, rangeFrom, rangeTo) {
  return function inDashRange(r) {
    const d = recordDate(r).slice(0, 10);
    if (!d) return false;
    if (rangeFrom && d < rangeFrom) return false;
    return d <= rangeTo;
  };
}

/** 进货单是否为有效入库单（排除草稿/待验/取消/作废；口径与打烊「入库」统计同源） */
function isInboundEffective(r) {
  const st = String((r && r.status) || '已入库');
  if (/草稿|待验|取消|作废/i.test(st)) return false;
  return /已入库|done|入库/i.test(st);
}

/** FP-DASH-07 库存总值：对齐旧版 stockValue()（HTML:1244/1251）= Σ 库存 × 均价（时点值，不随周期变） */
function stockValueOf(ings) {
  const sum = ings.reduce((a, it) => {
    if (!it || typeof it !== 'object') return a;
    const q = parseFloat(it.stock != null ? it.stock : (it.qty != null ? it.qty : it.amount));
    const p = parseFloat(it.avg);
    return a + ((isNaN(q) ? 0 : q) * (isNaN(p) ? 0 : p));
  }, 0);
  return Math.round((sum + Number.EPSILON) * 100) / 100;
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

function deriveReport(snap, date, rangeRaw) {
  const data = snap.data || {};
  const ext = snap.ext && typeof snap.ext === 'object' ? snap.ext : {};
  const now = Date.now();
  // FP-DASH-01 统计周期：不传（agent/inbox 等程序化调用）→ 当日口径，行为不变
  const range = DASH_RANGES.indexOf(String(rangeRaw)) >= 0 ? String(rangeRaw) : null;
  const rangeFrom = range ? rangeStart(range, date) : null;
  const rangeTo = date;
  const inDashRange = range ? makeInDashRange(range, rangeFrom, rangeTo) : null;
  const sales = Array.isArray(data.sales) ? data.sales : [];
  const recs = sales.filter((r) => recordDate(r).startsWith(date));
  // 当日口径：热度 / 晨报 / 打烊 / 保本达成（既有行为，不随周期切换而变）
  const dayRevenue = recs.reduce((s, r) => s + recordAmount(r), 0);
  const dayOrders = recs.length;
  // 周期口径：KPI 卡（营收 / 订单数 / 客单价 / 采购应付 / 折扣抹零）
  const rangeRecs = inDashRange ? sales.filter(inDashRange) : recs;
  const revenue = rangeRecs.reduce((s, r) => s + recordAmount(r), 0);
  const orders = rangeRecs.length;
  const avg = orders ? revenue / orders : 0;
  const dishes = Array.isArray(data.dishes) ? data.dishes.length : 0;
  const ings = Array.isArray(data.ings) ? data.ings : [];
  const members = Array.isArray(data.members) ? data.members.length : 0;

  // FP-DASH-05 销售毛利率（含成本副标）：区间营收 − 区间食材成本，与「营收」同区间口径。
  // 复用导出层 dishCostMap + dishResolver + costOfDish，销售菜名经 dishAlias 解析到菜品成本（单一公式源）。
  const costMap = dishCostMap(snap);
  const resolveDish = dishResolver(data);
  function costOfSales(list) {
    let c = 0;
    for (const s of list) {
      const lines = Array.isArray(s.lines) && s.lines.length ? s.lines : null;
      if (lines) {
        for (const l of lines) {
          const ref = l && (l.dish != null ? l.dish : (l.sku != null ? l.sku : l.name));
          const cc = costOfDish(costMap, resolveDish(ref));
          if (cc != null) c += cc * num(l.qty, 1);
        }
      } else {
        const cc = costOfDish(costMap, resolveDish(s.dish));
        if (cc != null) c += cc * num(s.qty, 1);
      }
    }
    return c;
  }
  const costInRange = costOfSales(rangeRecs);
  const grossMargin = revenue > 0 ? (revenue - costInRange) / revenue : null;

  // FP-DASH-15 菜品毛利排行（近30天 Top12：份数/营收/毛利/毛利率），复用 near30Agg + dishCostMap
  const agg30 = near30Agg(data);
  const topDishesRaw = [];
  for (const d of arr(data.dishes)) {
    if (!d) continue;
    const id = d.id != null ? String(d.id) : null;
    const a = (id && agg30[id]) || (d.name && agg30[d.name]) || { qty: 0, rev: 0 };
    if (!a.qty && !a.rev) continue;
    const rec = (id && costMap.byId[id]) || (d.name && costMap.byName[d.name]) || { cost: num(d.est, 0) };
    const qty = num(a.qty, 0);
    const rev = num(a.rev, 0);
    const cost = num(rec.cost, 0) * qty;
    const gp = rev - cost;
    const gm = rev > 0 ? gp / rev : null;
    topDishesRaw.push({
      id,
      name: d.name,
      cat: d.cat || '',
      qty,
      rev: r2(rev),
      cost: r2(cost),
      gp: r2(gp),
      gm: gm != null ? r2(gm) : null,
    });
  }
  topDishesRaw.sort((x, y) => y.gp - x.gp);
  const top_dishes = topDishesRaw.slice(0, 12).map((o, i) => ({ rank: i + 1, ...o }));

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
      text: '库存告急：' + names + ' · ' + lowStock.length + ' 项待补',
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
      text: '建议备料 · 今日工单 ' + wosToday.length + ' 单（未完成 ' + wosOpen.length + ' 单）',
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
      text: '渠道 · 今日预订 ' + bookingPending.length + ' 桌待确认',
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
  const recvToday = recvAll.filter((r) => r && recordDate(r).startsWith(date) && isInboundEffective(r));
  const recvAmount = recvToday.reduce((s, r) => {
    const v = parseFloat(r.payable != null ? r.payable : r.amount);
    return s + (isNaN(v) ? 0 : v);
  }, 0);
  // FP-DASH-06 采购应付（本期）：旧版 Σ DB.recv.payable（HTML:1243/1250），按当前周期过滤
  const payableIn = recvAll.reduce((s, r) => {
    if (!r || !isInboundEffective(r)) return s;
    // 无周期（程序化调用）时按当日，与 KPI「营收」的既有口径保持一致
    if (inDashRange ? !inDashRange(r) : !recordDate(r).startsWith(date)) return s;
    const v = parseFloat(r.payable != null ? r.payable : r.amount);
    return s + (isNaN(v) ? 0 : v);
  }, 0);
  // FP-DASH-07 库存总值：时点值，不随周期变化（旧版 stockValue()，HTML:1244/1251）
  const stockVal = stockValueOf(ings);

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
        today_rev: Math.round(dayRevenue * 100) / 100,
        attain_pct: Math.round((dayRevenue / beDay) * 1000) / 10
      };
    }
  } catch (e) { breakeven = null; }

  // 一句话晨报：今日营收/保本达成 + 最大风险 + 待办数（老板开屏即读）
  const bannerParts = [];
  if (dayRevenue <= 0 && dayOrders === 0) bannerParts.push('今日暂无销售');
  else bannerParts.push('今日营收 ¥' + dayRevenue.toFixed(0) + '·' + dayOrders + '单');
  if (breakeven && breakeven.be_day) {
    const gap = dayRevenue - breakeven.be_day;
    bannerParts.push(gap >= 0
      ? '已超保本 ¥' + gap.toFixed(0)
      : '距保本差 ¥' + (-gap).toFixed(0));
  }
  const criticalAlerts = alerts.filter((a) => a && a.level === 'critical');
  if (criticalAlerts.length) bannerParts.push('风险：' + String(criticalAlerts[0].text || '').slice(0, 24));
  else if (alerts.length) bannerParts.push(alerts.length + ' 条预警');
  if (todos.length) bannerParts.push(todos.length + ' 件待办');
  const smartSummary = bannerParts.join(' · ');
  const smartBanner = '熊猫功夫餐厅 · ' + smartSummary + '（快照 rev=' + snap.rev + '）';

  const report = {
    ok: true,
    mock: false,
    date,
    rev: snap.rev,
    generated_at: snap.generated_at,
    // FP-DASH-01：周期与区间文字（range=null 表示沿用既有「当日」口径，供程序化调用）
    range: range || '1',
    range_label: range ? rangeLabelOf(range, rangeFrom, rangeTo) : '当日（' + rangeTo + '）',
    range_from: rangeFrom,
    range_to: rangeTo,
    banner: smartBanner,
    summary: smartSummary,
    kpi: [
      { label: '营收', value: '¥' + revenue.toFixed(2), delta: null },
      { label: '订单数', value: String(orders), delta: null },
      { label: '客单价', value: '¥' + avg.toFixed(2), delta: null },
      // FP-DASH-05 销售毛利率（真实值，清掉前端 MOCK；含成本副标）
      {
        label: '销售毛利率',
        value: grossMargin != null ? (grossMargin * 100).toFixed(1) + '%' : '-',
        sub: grossMargin != null ? '食材成本 ¥' + costInRange.toFixed(0) + '（区间）' : '区间无销售',
        delta: null,
      },
      { label: '菜品SKU', value: String(dishes), delta: null },
      { label: '原料SKU', value: String(ings.length), delta: null },
      { label: '会员数', value: String(members), delta: null },
      { label: '快照rev', value: String(snap.rev), delta: null },
      { label: '销售记录总数', value: String(sales.length), delta: null },
      // FP-DASH-06 采购应付（本期）：区间内有效进货单应付合计（旧版 HTML:1243/1250）
      { label: '采购应付（本期）', value: '¥' + payableIn.toFixed(2), delta: null },
      // FP-DASH-07 库存总值：Σ 库存 × 均价（时点值，不随周期变；旧版 HTML:1244/1251）
      { label: '库存总值', value: '¥' + stockVal.toFixed(2), delta: null }
    ],
    heat_mini,
    todos,
    alerts,
    // FP-DASH-11 低库存预警明细（旧版 #lowStockBox，HTML:1280-1285；前端按 12 条截断）
    low_stock: { total: lowStock.length, items: lowStock },
    // FP-DASH-15 菜品毛利排行（近30天 Top12：份数/营收/毛利/毛利率）
    top_dishes,
    breakeven,
    day_close: {
      sold: { label: '售出', count: dayOrders, amount: Math.round(dayRevenue * 100) / 100, route: 'm/pos' },
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

function dateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** SI 简报：以“昨天经营 + 今天风险/待办”给老板开屏一条人话结论（确定性，不调 LLM） */
function buildBriefing(snap) {
  const today = todayStr();
  const yd = new Date();
  yd.setDate(yd.getDate() - 1);
  const y = dateStr(yd);
  const data = snap.data || {};
  const sales = Array.isArray(data.sales) ? data.sales : [];
  const recs = sales.filter((r) => recordDate(r).startsWith(y));
  const rev = recs.reduce((s, r) => s + recordAmount(r), 0);
  const orders = recs.length;
  const rep = deriveReport(snap, today);

  const bullets = [];
  bullets.push(orders
    ? '昨天营收 ¥' + rev.toFixed(0) + ' · ' + orders + ' 单 · 客单 ¥' + (rev / orders).toFixed(1)
    : '昨天暂无销售记录（可能未营业或快照未更新）');
  if (rep.breakeven && rep.breakeven.be_day) {
    const gap = rep.breakeven.today_rev - rep.breakeven.be_day;
    bullets.push('今日保本线 ¥' + Number(rep.breakeven.be_day).toFixed(0)
      + '，当前' + (gap >= 0 ? '已超 ¥' + gap.toFixed(0) : '距保本差 ¥' + (-gap).toFixed(0)));
  }
  const crit = (rep.alerts || []).filter((a) => a && a.level === 'critical');
  crit.slice(0, 2).forEach((a) => bullets.push('风险：' + a.text));
  (rep.todos || []).slice(0, 3).forEach((t) => bullets.push('待办：' + t.text));

  const headline = 'SI 早报 · ' + bullets[0] + (crit[0] ? ' · 需警惕：' + crit[0].text : '');
  return {
    ok: true,
    mock: false,
    date: today,
    rev: snap.rev,
    generated_at: snap.generated_at,
    headline,
    bullets,
    summary: rep.summary,
    todos: rep.todos,
    alerts: rep.alerts
  };
}

async function handle(req, res, ctx, pathname) {
  if (req.method === 'GET' && pathname === '/api/report/briefing') {
    const snap = loadSnapshot();
    const hasData = !!(snap && (
      (snap.data && Object.keys(snap.data).length > 0) ||
      (snap.ext && Object.keys(snap.ext).length > 0)
    ));
    if (!hasData) {
      ctx.sendJSON(res, 200, {
        ok: true, mock: true, date: todayStr(),
        headline: '暂无店内快照，请先推送 snapshot',
        bullets: [], todos: [], alerts: [], rev: null, generated_at: null
      });
      return true;
    }
    ctx.sendJSON(res, 200, buildBriefing(snap));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/report/daily') {
    const qdate = (ctx.query.get('date') || '').trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(qdate) ? qdate : todayStr();
    // FP-DASH-01：?range=7|30|all（默认 30，旧版 #dashRange 默认「近30天」on，HTML:196）
    const range = parseRange(ctx.query.get('range'));
    const snap = loadSnapshot();
    // 整体无数据（无快照，或 data 空且无 ext）→ 回退 mock
    const hasData = !!(snap && (
      (snap.data && Object.keys(snap.data).length > 0) ||
      (snap.ext && Object.keys(snap.ext).length > 0)
    ));
    ctx.sendJSON(res, 200, hasData ? deriveReport(snap, date, range) : mockReport(date, range));
    return true;
  }
  return false;
}

module.exports = { handle, deriveReport, buildBriefing, todayStr };
