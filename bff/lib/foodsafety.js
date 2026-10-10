'use strict';
/*
 * lib/foodsafety.js — 食安证照 / 留样 / 消毒 / 溯源 纯逻辑（M4-T2/T4/T5）
 *
 * 纯函数，无 IO：便于单测与路由复用。数据源为快照 ext.fs_*（表行对象数组）。
 *
 * 监管口径：
 *   证照临期（M4-T5）：逾期 expired（禁营） / <red 红 / <orange 橙 / <yellow 黄 / 其余绿
 *     健康证 逾期或红 → 联动禁岗（与 M2 staff 同源 fs_certs）
 *     店铺证照 逾期 → 「停业风险」推老板
 *   留样（M4-T4）：t0 留样 → 48h 倒计时 → 到期前 2h 黄 → 到期红 → 销毁登记
 *     克重：饺子 ≥125g / 热菜 ≥200g，不足即拦截
 *   消毒（M4-T4）：待执行 → 已完成 / 超时标红；7 日达标率
 */

const sp = require('./safety_points');

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const SAMPLE_HOLD_H = 48;   // 留样 48h 监管要求
const SAMPLE_WARN_H = 2;    // 到期前 2h 转黄
const WEIGHT_JIAOZI = 125;  // 饺子留样克重下限
const WEIGHT_HOTDISH = 200; // 热菜留样克重下限
const DEFAULT_SPAN = 7;     // 消毒达标率默认窗口（7 日）
const TEMP_MIN = 0;         // 留样存放温度下限 ℃（附录 C）
const TEMP_MAX = 8;         // 留样存放温度上限 ℃（附录 C）

const DEFAULT_THRESHOLDS = { block: 0, red: 7, orange: 14, yellow: 30 };

function arr(v) { return Array.isArray(v) ? v : []; }
function str(v) { return v == null ? '' : String(v).trim(); }
function num(v, d) { const x = parseFloat(v); return Number.isNaN(x) ? (d === undefined ? 0 : d) : x; }
function uniq(list) { const out = []; for (const x of list) if (out.indexOf(x) < 0) out.push(x); return out; }
function dayOf(dateStr) {
  const s = str(dateStr);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date().toISOString().slice(0, 10);
}
function shiftDay(day, delta) {
  return new Date(new Date(day + 'T00:00:00Z').getTime() + delta * DAY_MS).toISOString().slice(0, 10);
}
/** 含今天在内、长度为 n 的升序日期窗 */
function lastNDays(endDay, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) out.push(shiftDay(endDay, -i));
  return out;
}
/** 取记录的归属日：优先 date，其次 ts 前 10 位 */
function recordDay(row) {
  const d = str(row && row.date);
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const ts = str(row && (row.ts || row.kept_at || row.keptAt));
  return /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : '';
}
function r1(v) { return v == null ? v : Math.round(v * 10) / 10; }

/* ---------------- 阈值（可配） ---------------- */

/** 生效阈值：cfg.foodsafety.cert > cfg.cert > 默认 */
function thresholdsOf(cfg) {
  const c = (cfg && cfg.foodsafety && cfg.foodsafety.cert) || (cfg && cfg.cert) || {};
  return {
    block: c.block == null ? DEFAULT_THRESHOLDS.block : num(c.block, DEFAULT_THRESHOLDS.block),
    red: c.red == null ? DEFAULT_THRESHOLDS.red : num(c.red, DEFAULT_THRESHOLDS.red),
    orange: c.orange == null ? DEFAULT_THRESHOLDS.orange : num(c.orange, DEFAULT_THRESHOLDS.orange),
    yellow: c.yellow == null ? DEFAULT_THRESHOLDS.yellow : num(c.yellow, DEFAULT_THRESHOLDS.yellow)
  };
}

/* ---------------- 证照临期 ---------------- */

function daysLeft(expireAt, now) {
  const t = new Date(str(expireAt)).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - now) / DAY_MS);
}

/** 临期分级：逾期 expired / red / orange / yellow / green；无到期日 unknown */
function certLevel(days, th) {
  if (days == null) return 'unknown';
  const t = th || DEFAULT_THRESHOLDS;
  if (days < (t.block == null ? 0 : t.block)) return 'expired';
  if (days < t.red) return 'red';
  if (days < t.orange) return 'orange';
  if (days < t.yellow) return 'yellow';
  return 'green';
}

function isHealthCert(type) { return /健康证|health/i.test(str(type)); }
function isStoreCert(type) { return !isHealthCert(type); }

/** 证照台账：分级 + 禁岗 + 停业风险 */
function certReport(ext, now, cfg) {
  const th = thresholdsOf(cfg);
  const at = now == null ? Date.now() : now;
  const rows = arr(ext && ext.fs_certs).map((c) => {
    const type = str(c && (c.cert_type || c.type)) || '证照';
    const holder = str(c && (c.holder || c.name)) || '-';
    const expireAt = str(c && (c.expire_at || c.expire || c.valid_until)) || null;
    const days = daysLeft(expireAt, at);
    const level = certLevel(days, th);
    const health = isHealthCert(type);
    return {
      id: c && c.id != null ? c.id : null,
      type,
      holder,
      cert_no: str(c && (c.cert_no || c.no)) || null,
      issued_at: str(c && c.issued_at) || null,
      expire_at: expireAt,
      status: str(c && c.status) || null,
      days,
      level,
      kind: health ? 'health' : 'store',
      blocked: health && (level === 'expired' || level === 'red'),
      store_risk: !health && level === 'expired'
    };
  });
  rows.sort((a, b) => {
    const da = a.days == null ? 1e9 : a.days;
    const db = b.days == null ? 1e9 : b.days;
    return da - db || a.type.localeCompare(b.type);
  });

  const healthBlocked = rows.filter((x) => x.blocked).map((x) => x.holder);
  const storeRisks = rows.filter((x) => x.store_risk);
  const counts = { expired: 0, red: 0, orange: 0, yellow: 0, green: 0, unknown: 0 };
  rows.forEach((x) => { counts[x.level] = (counts[x.level] || 0) + 1; });

  const advice = [];
  if (storeRisks.length) advice.push(`停业风险：${storeRisks.map((x) => x.type + '(' + x.holder + ')').join('、')} 已过期`);
  if (healthBlocked.length) advice.push(`健康证禁岗：${healthBlocked.join('、')}`);
  if (counts.red) advice.push(`健康证/证照 7 天内到期 ${counts.red} 张`);
  if (!advice.length) advice.push('证照台账正常');

  return {
    rows,
    counts,
    thresholds: th,
    health_blocked: uniq(healthBlocked),
    store_risks: storeRisks,
    store_stop_risk: storeRisks.length > 0,
    advice
  };
}

/* ---------------- 留样 48h ---------------- */

/** 留样起始时刻：优先 kept_at，退化用 date + 餐次推定 */
function keptAtMs(sample) {
  const k = str(sample && (sample.kept_at || sample.keptAt));
  if (k) {
    const t = new Date(k).getTime();
    if (!Number.isNaN(t)) return t;
  }
  const d = str(sample && sample.date);
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const meal = str(sample && sample.meal);
    const hh = /早/.test(meal) ? '08:00' : /晚/.test(meal) ? '18:00' : '12:00';
    const t = new Date(d + 'T' + hh + ':00').getTime();
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

/** 留样克重下限：饺子 125g / 其余（热菜）200g */
function needWeight(dish) { return /饺/.test(str(dish)) ? WEIGHT_JIAOZI : WEIGHT_HOTDISH; }

/** 克重校验：pass ≥need+5 / warn need~need+5 / fail <need */
function weightCheck(dish, weight) {
  const need = needWeight(dish);
  const w = num(weight, 0);
  if (w <= 0) return { ok: false, need, weight: w, level: 'unknown', short: need, error: '留样克重缺失' };
  if (w < need) {
    return { ok: false, need, weight: w, level: 'fail', short: r1(need - w), error: `留样克重不足：${w}g < ${need}g（${/饺/.test(str(dish)) ? '饺子' : '热菜'}下限）` };
  }
  if (w <= need + 5) return { ok: true, need, weight: w, level: 'warn', short: 0 };
  return { ok: true, need, weight: w, level: 'pass', short: 0 };
}

/**
 * 留样状态机：待销毁 → 2h 内到期（黄） → 已超期（红） → 已销毁
 * hours_left>0 为剩余；<=0 表示已过 48h。
 */
function sampleState(sample, now) {
  const at = now == null ? Date.now() : now;
  const kept = keptAtMs(sample);
  const clearedAt = str(sample && (sample.cleared_at || sample.clearedAt)) || null;
  if (kept == null) {
    return { kept_at: null, due_at: null, hours_left: null, elapsed_h: null, status: clearedAt ? '已销毁' : 'unknown', level: clearedAt ? 'done' : 'unknown', cleared_at: clearedAt };
  }
  const due = kept + SAMPLE_HOLD_H * HOUR_MS;
  const hoursLeft = r1((due - at) / HOUR_MS);
  let status = '待销毁';
  let level = 'green';
  if (clearedAt) { status = '已销毁'; level = 'done'; }
  else if (hoursLeft <= 0) { status = '已超期'; level = 'red'; }
  else if (hoursLeft <= SAMPLE_WARN_H) { status = '2h 内到期'; level = 'yellow'; }
  return {
    kept_at: new Date(kept).toISOString(),
    due_at: new Date(due).toISOString(),
    hours_left: hoursLeft,
    elapsed_h: r1((at - kept) / HOUR_MS),
    status,
    level,
    cleared_at: clearedAt
  };
}

/** 存放温度：缺失/非法 → null；否则 number */
function tempNum(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

/** 存放温度分级：ok 0–8℃ / out 越界 / unknown 缺失或非法 */
function tempLevel(v) {
  const n = tempNum(v);
  if (n == null) return 'unknown';
  return n >= TEMP_MIN && n <= TEMP_MAX ? 'ok' : 'out';
}

/** 留样汇总 + 到期提醒（M4-T4） */
function sampleReport(ext, now) {
  const at = now == null ? Date.now() : now;
  const rows = arr(ext && ext.fs_samples).map((s) => {
    const st = sampleState(s, at);
    const dish = str(s && s.dish) || '-';
    const wc = weightCheck(dish, s && (s.weight_g != null ? s.weight_g : s.weight));
    return Object.assign({}, st, {
      id: s && s.id != null ? s.id : null,
      date: str(s && s.date) || null,
      meal: str(s && s.meal) || null,
      dish,
      keeper: str(s && (s.keeper || s.operator)) || null,
      weight_g: wc.weight,
      need_g: wc.need,
      weight_ok: wc.ok,
      weight_level: wc.level,
      short_g: wc.short,
      hold_temp: tempNum(s && s.hold_temp),
      sealed_by: str(s && s.sealed_by) || null,
      temp_level: tempLevel(s && s.hold_temp)
    });
  });
  rows.sort((a, b) => (a.hours_left == null ? 1e9 : a.hours_left) - (b.hours_left == null ? 1e9 : b.hours_left));

  const active = rows.filter((x) => x.level !== 'done');
  const summary = {
    total: rows.length,
    pending: active.length,
    due_soon: active.filter((x) => x.level === 'yellow').length,
    expired: active.filter((x) => x.level === 'red').length,
    cleared: rows.filter((x) => x.level === 'done').length,
    under_weight: rows.filter((x) => x.weight_level === 'fail').length,
    temp_out: rows.filter((x) => x.temp_level === 'out').length
  };
  const reminders = [];
  active.forEach((x) => {
    if (x.level === 'red') reminders.push({ id: x.id, dish: x.dish, level: 'red', text: `${x.dish} 留样已超 48h（${Math.abs(x.hours_left)}h），需销毁登记` });
    else if (x.level === 'yellow') reminders.push({ id: x.id, dish: x.dish, level: 'yellow', text: `${x.dish} 留样 ${x.hours_left}h 内到期` });
  });
  rows.filter((x) => x.weight_level === 'fail').forEach((x) => {
    reminders.push({ id: x.id, dish: x.dish, level: 'fail', text: `${x.dish} 留样克重 ${x.weight_g}g < ${x.need_g}g` });
  });
  rows.filter((x) => x.temp_level === 'out').forEach((x) => {
    reminders.push({ id: x.id, dish: x.dish, level: 'out', text: `${x.dish} 存放温度 ${x.hold_temp}℃ 超出 ${TEMP_MIN}–${TEMP_MAX}℃` });
  });
  return { rows, summary, reminders };
}

/* ---------------- 消毒达标率 ---------------- */

function isDoneRow(row) {
  const v = str(row && (row.result || row.status));
  if (!v) return true; // 原型未记结果的行视为已完成
  return !/待执行|未完成|pending|未做|漏/.test(v);
}

/**
 * 7 日消毒达标率：当日已完成区域数 / 应做区域数
 * 应做区域来源：已配置消毒点位时取点位 name（唯一事实来源）；未配置时回退历史
 * fs_disinfect.area 去重，保持历史环境与空态兼容。
 */
function disinfectReport(ext, date, now, span) {
  const all = arr(ext && ext.fs_disinfect);
  const end = dayOf(date);
  const days = lastNDays(end, Math.max(1, num(span, DEFAULT_SPAN)));
  // 优先可配置消毒点位；无配置点位时回退历史记录区域去重
  const configured = sp.usingDefaultPoints(ext, 'disinfect')
    ? []
    : sp.resolvePoints(ext, 'disinfect').map((p) => str(p.name) || '未分区');
  const areas = configured.length
    ? uniq(configured)
    : uniq(all.map((r) => str(r && r.area) || '未分区'));
  const per = days.map((d) => {
    const dayRows = all.filter((r) => recordDay(r) === d);
    const doneAreas = uniq(dayRows.filter(isDoneRow).map((r) => str(r && r.area) || '未分区'));
    const missed = areas.filter((a) => doneAreas.indexOf(a) < 0);
    return {
      date: d,
      records: dayRows.length,
      done_areas: doneAreas,
      missed,
      rate: areas.length ? r1((doneAreas.length / areas.length) * 100) : null
    };
  });
  const rated = per.filter((p) => p.rate != null);
  const avg = rated.length ? r1(rated.reduce((n, p) => n + p.rate, 0) / rated.length) : null;
  const todayRow = per[per.length - 1];
  const missed = todayRow ? todayRow.missed : [];
  // 状态机口径：无记录 = 待执行；有记录但 result 非完成 = 超时标红
  const pendingAreas = missed.filter((a) => !all.some((r) => recordDay(r) === end && (str(r && r.area) || '未分区') === a));
  const overdueAreas = missed.filter((a) => all.some((r) => recordDay(r) === end && (str(r && r.area) || '未分区') === a));
  return {
    areas,
    span: days,
    days: per,
    avg_rate: avg,
    today_done: todayRow ? todayRow.done_areas.length : 0,
    today_missed: missed,
    pending: pendingAreas.map((a) => ({ area: a, state: '待执行', overdue: false })),
    overdue: overdueAreas.map((a) => ({ area: a, state: '超时', overdue: true }))
  };
}

/* ---------------- 溯源下钻 ---------------- */

/** 在 data.recv / data.sales 中按批号或原料名做 best-effort 关联（找不到就留空，不臆造） */
function pickRelated(list, batch, ingName) {
  const b = str(batch).toLowerCase();
  const n = str(ingName).toLowerCase();
  if (!b && !n) return [];
  return arr(list).filter((row) => {
    if (!row || typeof row !== 'object') return false;
    for (const k of Object.keys(row)) {
      const v = str(row[k]).toLowerCase();
      if (!v) continue;
      if (b && v.indexOf(b) >= 0) return true;
      if (n && v.indexOf(n) >= 0) return true;
    }
    return false;
  });
}

function traceRow(t) {
  const batch = str(t && (t.batch_no || t.batch || t.lot)) || '-';
  const ing = str(t && (t.ing_name || t.ing || t.name)) || '-';
  const certNo = str(t && t.cert_no) || null;
  const check = str(t && (t.check_result || t.result)) || null;
  return {
    id: t && t.id != null ? t.id : null,
    batch_no: batch,
    ing_name: ing,
    supplier: str(t && (t.supplier || t.vendor)) || '-',
    recv_date: str(t && (t.recv_date || t.recv)) || null,
    origin: str(t && t.origin) || null,
    cert_no: certNo,
    check_result: check,
    missing_cert: !certNo && !check
  };
}

function traceReport(ext, data, query) {
  const rows = arr(ext && ext.fs_trace).map(traceRow);
  const batches = rows.length;
  const missing = rows.filter((r) => r.missing_cert).length;
  const out = { ok: true, rows, batches, missing_cert: missing, advice: [] };
  if (missing) out.advice.push(`溯源批次待补检验报告 ${missing} 个`);

  const want = str(query && (query.batch || query.q));
  if (!want) return out;

  const hit = rows.filter((r) => r.batch_no === want || r.ing_name === want || r.batch_no.indexOf(want) >= 0 || r.ing_name.indexOf(want) >= 0);
  const head = hit[0] || null;
  const recv = head ? pickRelated(data && data.recv, head.batch_no, head.ing_name) : [];
  const sales = head ? pickRelated(data && data.sales, head.batch_no, head.ing_name) : [];
  out.query = want;
  out.batch = head;
  out.matches = hit.length;
  out.drill = {
    recv,
    sales,
    // 无检验报告 → 前端标黄「待补」（符合 M7-T2）
    need_cert: !!(head && head.missing_cert),
    note: head ? (sales.length ? '' : '未关联到销售记录（按批号/原料名 best-effort 匹配）') : '未匹配到批次'
  };
  return out;
}

module.exports = {
  DAY_MS,
  HOUR_MS,
  SAMPLE_HOLD_H,
  SAMPLE_WARN_H,
  WEIGHT_JIAOZI,
  WEIGHT_HOTDISH,
  TEMP_MIN,
  TEMP_MAX,
  DEFAULT_THRESHOLDS,
  thresholdsOf,
  daysLeft,
  certLevel,
  isHealthCert,
  certReport,
  keptAtMs,
  needWeight,
  weightCheck,
  sampleState,
  sampleReport,
  recordDay,
  lastNDays,
  disinfectReport,
  traceReport
};
