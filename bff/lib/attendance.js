'use strict';
/*
 * lib/attendance.js — 打卡状态机（M2-T4 单一事实来源）
 *
 * 口径（对应开发任务清单_P0P1P2.md M2-T4 验收）：
 *   应到（排班 start_time）→ 实到（打卡 ts）：
 *     diff ≤ late_min              → 准点
 *     late_min < diff ≤ absent_min → 迟到 N 分
 *     diff > absent_min            → 缺勤
 *   阈值可配：config.attendance = { late_min: 10, absent_min: 30 }（absent 不小于 late）。
 *   无排班 / 时间无法判定 → 返回 null（调用方保留原 status，如「补录」）。
 *
 * 纯函数模块（无 IO / 无写库），供 routes/staff.js 与验收脚本共用。
 * 红线：本模块只读排班与打卡记录，不产生任何写操作。
 */
const DEFAULT_LATE_MIN = 10;
const DEFAULT_ABSENT_MIN = 30;
const REST_RE = /休息|请假|休班|^休$/;

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

function trim(v) { return String(v == null ? '' : v).trim(); }

/** 取生效阈值（config.attendance 覆盖默认；absent 不小于 late） */
function thresholdsOf(config) {
  const a = (config && config.attendance) || {};
  const late = num(a.late_min, DEFAULT_LATE_MIN);
  const absent = num(a.absent_min, DEFAULT_ABSENT_MIN);
  return { late_min: late, absent_min: Math.max(absent, late) };
}

/** 'HH:mm' → 当日分钟数；非法返回 null */
function hhmm(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(trim(s));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 从打卡时间取 HH:mm；支持 'YYYY-MM-DD HH:mm' 与 ISO（'YYYY-MM-DDTHH:mm'） */
function clockMinutes(ts) {
  const s = String(ts || '');
  const hhmmAt = (str) => {
    const m = /(?:^|[T\s])(\d{1,2}):(\d{2})/.exec(str);
    return m ? hhmm(m[1] + ':' + m[2]) : null;
  };
  return hhmmAt(s);
}

/** 取某员工某日排班的开始时间；找不到返回 null */
function shiftStartOf(shifts, staffId, date) {
  const list = Array.isArray(shifts) ? shifts : [];
  const sid = trim(staffId);
  const day = trim(date);
  if (!sid) return null;
  const hit = list.find(
    (x) => trim(x && x.staff_id) === sid && trim(x && x.date) === day
  );
  if (!hit) return null;
  return hit.start_time || hit.start || null;
}

/** 判定打卡状态：{status, late_min} | null（无法判定） */
function classify(p) {
  const o = p || {};
  const startMin = hhmm(o.shiftStart);
  const clockMin = clockMinutes(o.ts);
  if (startMin == null || clockMin == null) return null;
  const th = thresholdsOf(o.config);
  let diff = clockMin - startMin;
  if (diff < -12 * 60) diff += 24 * 60; // 跨零点排班
  if (diff <= th.late_min) return { status: '准点', late_min: Math.max(diff, 0) };
  if (diff <= th.absent_min) return { status: '迟到 ' + diff + ' 分', late_min: diff };
  return { status: '缺勤', late_min: diff };
}

/** 归一化打卡时间：兼容 ts/time 与 'YYYY-MM-DD HH:mm'；无值返回 null */
function normalizeTs(payload) {
  const s = trim(payload && (payload.ts || payload.time));
  if (!s) return null;
  const iso = s.indexOf('T') >= 0 ? s : s.replace(' ', 'T');
  return iso.length === 16 ? iso + ':00' : iso;
}

function isRest(s) {
  return REST_RE.test(trim(s && (s.shift || s.role)));
}

function nameOf(shift) {
  return trim(shift && (shift.staff_name || shift.name)) || trim(shift && shift.staff_id) || '-';
}

/**
 * 应到 / 实到 / 迟到 / 缺勤 汇总（当日）。
 * @param shifts 排班记录（ext.staff_shifts 或 staff_shifts 表行）
 * @param clocks 打卡记录（ext.staff_clock 或 staff_clock 表行）
 * @param date   'YYYY-MM-DD'
 * @param config 快照 data.config（可含 attendance 阈值）
 * @returns {expected, clocked, on_time, late, absent, makeup, rows:[...]}
 */
function summarize(shifts, clocks, date, config) {
  const list = (Array.isArray(shifts) ? shifts : []).filter(
    (s) => trim(s && s.date) === trim(date) && !isRest(s)
  );
  const dayClocks = (Array.isArray(clocks) ? clocks : []).filter((c) => {
    const k = trim(c && c.kind);
    const ts = String((c && (c.ts || c.time)) || '');
    return ts.slice(0, 10) === trim(date) && (!k || /上班|到岗/.test(k));
  });

  const rows = [];
  let clocked = 0, onTime = 0, late = 0, absent = 0, makeup = 0;
  for (const s of list) {
    const sid = trim(s && s.staff_id);
    const nm = nameOf(s);
    const clock = sid
      ? dayClocks.find((c) => trim(c && c.staff_id) === sid)
      : dayClocks.find((c) => trim(c && c.staff_name) === nm);
    const isMakeup = !!(clock && /补录/.test(trim(clock && clock.status)));
    const cls = clock ? classify({ shiftStart: s.start_time || s.start, ts: clock.ts || clock.time, config }) : null;

    let status;
    if (!clock) status = '缺勤';
    else if (cls) status = cls.status;
    else status = trim(clock.status) || '已打卡';

    if (clock) clocked += 1;
    if (isMakeup) makeup += 1;
    if (/^准点/.test(status)) onTime += 1;
    else if (/^迟到/.test(status)) late += 1;
    else if (/^缺勤/.test(status)) absent += 1;

    rows.push({
      staff_id: sid || null,
      staff_name: nm,
      role: trim(s && s.role) || null,
      shift: trim(s && s.shift) || null,
      start_time: s.start_time || null,
      end_time: s.end_time || null,
      clock_ts: clock ? (clock.ts || clock.time) || null : null,
      clock_kind: clock ? trim(clock.kind) || null : null,
      makeup: isMakeup,
      late_min: cls && cls.late_min != null ? cls.late_min : null,
      status
    });
  }

  return {
    date: trim(date),
    expected: list.length,
    clocked,
    on_time: onTime,
    late,
    absent,
    makeup,
    thresholds: thresholdsOf(config),
    rows
  };
}

module.exports = {
  DEFAULT_LATE_MIN,
  DEFAULT_ABSENT_MIN,
  thresholdsOf,
  hhmm,
  clockMinutes,
  shiftStartOf,
  classify,
  normalizeTs,
  isRest,
  summarize
};
