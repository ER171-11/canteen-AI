'use strict';
/*
 * routes/staff.js — M2 排班员工模块 API（数据源：店内快照 ext.staff_* ，只读聚合）
 *
 *   GET  /api/staff/schedule?week=YYYY-MM-DD   周排班 A/B/C 班矩阵 + 工时汇总
 *   GET  /api/staff/clock?date=YYYY-MM-DD      应到/实到/迟到/缺勤（阈值可配）
 *   GET  /api/staff/perf                       绩效排行
 *   GET  /api/staff/train                      SOP 进度 n/5 + 健康证到期预警 + 禁岗
 *   GET  /api/staff/config / POST              迟到/缺勤阈值（BFF 本地配置，可配）
 *   GET  /api/staff/swaps?status=              换班单
 *   POST /api/staff/swaps/request              发起换班（A → B）
 *   POST /api/staff/swaps/:id/accept           接手人同意（rev）
 *   POST /api/staff/swaps/:id/reject           驳回
 *   POST /api/staff/swaps/:id/approve          店长审批 → 写回入队（rev）
 *   GET  /api/staff/quiz                       关键工艺抽查题库
 *   POST /api/staff/uniform                    着装合规入档（uniform.log 入队）
 *   POST /api/staff/quiz/pass                  培训/抽查通过（staff.train_pass 入队）
 *
 * 红线①：GET 全为只读；红线②：所有写操作一律 enqueue 进 actions 队列，不直写店内库。
 */
const store = require('../lib/store');
const { enqueue } = require('./actions');
const { mayWriteActions } = require('../lib/auth');
const { loadSnapshot } = require('./snapshot');
const attendance = require('../lib/attendance');
const skillMatrix = require('../lib/skill_matrix');
const swap = require('../lib/shift_swap');

const CONFIG_FILE = 'staff_config.json';
const SHIFT_CODE = { '早班': 'A', '中班': 'B', '晚班': 'C', A: 'A', B: 'B', C: 'C' };
const REST_RE = /休息|请假|休班|^休$/;
const CERT_RED_DAYS = 7;    // < 7 天：红（禁岗）
const CERT_WARN_DAYS = 30;  // < 30 天：黄（预警）

/** 关键工艺抽查题库（M2-T6：料水分三次 / 点水三次 / 醒发 30 分钟） */
const QUIZ = [
  { id: 'q1', topic: '料水', q: '和面加水应分几次？', answer: '分三次', keywords: ['三次', '3次', '3 次'] },
  { id: 'q2', topic: '点水', q: '点水应点几次？', answer: '三次', keywords: ['三次', '3次', '3 次'] },
  { id: 'q3', topic: '醒发', q: '醒发时长要求？', answer: '30 分钟', keywords: ['30', '三十分钟'] },
  { id: 'q4', topic: '着装', q: '进入操作区着装要求？', answer: '工服工帽口罩齐全', keywords: ['工服', '工帽', '口罩'] }
];

function arr(v) { return Array.isArray(v) ? v : []; }
function trim(v) { return String(v == null ? '' : v).trim(); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function dayOf(dateStr) {
  const s = trim(dateStr);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : todayStr();
}
/** 以 date 所在周的周一为起点，返回 7 天 */
function weekOf(dateStr) {
  const s = dayOf(dateStr);
  const d = new Date(s + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // 周一=0
  d.setUTCDate(d.getUTCDate() - dow);
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    days.push(new Date(d.getTime() + i * 86400000).toISOString().slice(0, 10));
  }
  return days;
}
function shiftCode(s) {
  const v = trim(s);
  if (!v) return '-';
  if (REST_RE.test(v)) return '休';
  return SHIFT_CODE[v] || v;
}
function hoursOf(a, b) {
  const s = attendance.hhmm(a);
  const e = attendance.hhmm(b);
  if (s == null || e == null) return 0;
  const diff = e >= s ? e - s : e + 1440 - s;
  return Math.round((diff / 60) * 10) / 10;
}

function loadExt() {
  const snap = loadSnapshot();
  const ext = (snap && snap.ext) || {};
  return { snap, ext };
}
/** 生效阈值：BFF 本地配置 > 快照 config.attendance > 默认 */
function effectiveConfig() {
  const local = store.readJSON(CONFIG_FILE, null);
  const snap = loadSnapshot();
  const snapCfg = (snap && snap.data && snap.data.config) || {};
  const merged = Object.assign({}, snapCfg, local && local.attendance ? { attendance: local.attendance } : {});
  return merged;
}
function thresholds() { return attendance.thresholdsOf(effectiveConfig()); }

/* ---------------- 只读聚合 ---------------- */

function schedulePayload(weekStart) {
  const { ext } = loadExt();
  const days = weekOf(weekStart);
  const shifts = arr(ext.staff_shifts);
  const weekShifts = shifts.filter((s) => days.indexOf(trim(s && s.date)) >= 0);

  const staff = [];
  const idx = {};
  for (const s of weekShifts) {
    const id = trim(s && s.staff_id) || trim(s && s.staff_name);
    if (!id) continue;
    if (!idx[id]) {
      idx[id] = { staff_id: trim(s.staff_id) || null, staff_name: trim(s.staff_name) || id, role: trim(s.role) || null, cells: {}, hours: 0, days: 0 };
      staff.push(idx[id]);
    }
    const row = idx[id];
    if (!row.role && trim(s.role)) row.role = trim(s.role);
    const code = shiftCode(s.shift);
    row.cells[trim(s.date)] = code;
    if (code !== '休' && code !== '-') {
      row.hours += hoursOf(s.start_time, s.end_time);
      row.days += 1;
    }
  }
  staff.forEach((r) => { r.hours = Math.round(r.hours * 10) / 10; });
  staff.sort((a, b) => b.hours - a.hours || String(a.staff_name).localeCompare(String(b.staff_name)));

  return {
    ok: true,
    week_start: days[0],
    days,
    staff,
    totals: {
      people: staff.length,
      hours: Math.round(staff.reduce((n, r) => n + r.hours, 0) * 10) / 10,
      shifts: staff.reduce((n, r) => n + r.days, 0)
    },
    rev: null
  };
}

function clockPayload(date) {
  const { ext, snap } = loadExt();
  const d = dayOf(date);
  const s = attendance.summarize(arr(ext.staff_shifts), arr(ext.staff_clock), d, effectiveConfig());
  return Object.assign({ ok: true, rev: snap ? snap.rev : null }, s);
}

function perfPayload() {
  const { ext, snap } = loadExt();
  const rows = arr(ext.staff_perf).slice().sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  return {
    ok: true,
    rev: snap ? snap.rev : null,
    perf: rows.map((r, i) => ({
      rank: i + 1,
      staff_id: trim(r.staff_id) || null,
      staff_name: trim(r.staff_name) || trim(r.staff_id) || '-',
      score: Number(r.score || 0),
      hours: Number(r.hours || 0),
      remark: trim(r.remark) || null
    }))
  };
}

function certAlerts(ext, date) {
  const today = dayOf(date);
  const base = new Date(today + 'T00:00:00Z').getTime();
  return arr(ext.fs_certs)
    .filter((c) => /健康证/.test(trim(c && (c.type || c.cert_type))))
    .map((c) => {
      const name = trim(c.name || c.holder) || '-';
      const exp = trim(c.expire_at || c.expire);
      let days = c.expire_days != null ? Number(c.expire_days) : null;
      if (days == null && /^\d{4}-\d{2}-\d{2}$/.test(exp)) {
        days = Math.floor((new Date(exp + 'T00:00:00Z').getTime() - base) / 86400000);
      }
      const level = days == null ? 'unknown' : (days < CERT_RED_DAYS ? 'red' : (days < CERT_WARN_DAYS ? 'warn' : 'ok'));
      return { staff_name: name, expire_at: exp || null, days_left: days, level, blocked: level === 'red' };
    })
    .sort((a, b) => (a.days_left == null ? 9999 : a.days_left) - (b.days_left == null ? 9999 : b.days_left));
}

function trainPayload() {
  const { ext, snap } = loadExt();
  const cfg = effectiveConfig();
  const rows = arr(ext.staff_train);
  const progress = skillMatrix.trainProgress(rows, cfg);
  const certs = certAlerts(ext, todayStr());
  const blockedNames = {};
  certs.filter((c) => c.blocked).forEach((c) => { blockedNames[c.staff_name] = true; });
  progress.forEach((p) => { p.blocked = !!blockedNames[trim(p.staff_name)]; });
  const certRed = certs.filter((c) => c.blocked);
  return {
    ok: true,
    rev: snap ? snap.rev : null,
    sop_total: skillMatrix.SOP_TOTAL,
    train: arr(ext.staff_train),
    progress,
    certs,
    summary: {
      staff: progress.length,
      cert_red: certRed.length,
      cert_warn: certs.filter((c) => c.level === 'warn').length,
      blocked_staff: progress.filter((p) => p.blocked).length,
      gated_skus: Object.keys(skillMatrix.matrixOf(cfg)).length
    },
    skill_matrix: skillMatrix.matrixOf(cfg),
    uniform: arr(ext.staff_train).filter((r) => /着装|uniform/i.test(trim(r.course || r.name)))
  };
}

/* ---------------- 路由 ---------------- */

function needWrite(ctx, res) {
  if (!ctx.auth) { ctx.sendJSON(res, 401, { ok: false, error: 'unauthorized: bearer token required' }); return false; }
  if (!mayWriteActions(ctx.auth)) {
    ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required（当前账号只读，请用老板/店长登录）' });
    return false;
  }
  return true;
}
async function readJson(ctx, req) {
  try {
    const { buf } = await ctx.readBody(req);
    const b = JSON.parse(buf.toString('utf8'));
    return b && typeof b === 'object' ? b : {};
  } catch (e) { return {}; }
}
function operatorOf(ctx, body) {
  return (body && body.operator) || (ctx.auth && (ctx.auth.account || ctx.auth.role)) || null;
}
function doEnqueue(type, payload, operator, traceId) {
  const { action } = enqueue(type, payload, operator, traceId, {});
  return action && action.id;
}

function handle(req, res, ctx, pathname) {
  if (pathname.indexOf('/api/staff') !== 0) return false;
  const m = req.method;

  // ---- 只读 ----
  if (m === 'GET' || m === 'HEAD') {
    if (pathname === '/api/staff/schedule') {
      ctx.sendJSON(res, 200, schedulePayload(ctx.query.get('week'))); return true;
    }
    if (pathname === '/api/staff/clock') {
      ctx.sendJSON(res, 200, clockPayload(ctx.query.get('date'))); return true;
    }
    if (pathname === '/api/staff/perf') { ctx.sendJSON(res, 200, perfPayload()); return true; }
    if (pathname === '/api/staff/train') { ctx.sendJSON(res, 200, trainPayload()); return true; }
    if (pathname === '/api/staff/quiz') {
      ctx.sendJSON(res, 200, { ok: true, quiz: QUIZ.map((q) => ({ id: q.id, topic: q.topic, q: q.q })) }); return true;
    }
    if (pathname === '/api/staff/config') {
      ctx.sendJSON(res, 200, { ok: true, attendance: thresholds(), source: 'bff:staff_config.json ∪ snapshot.data.config' });
      return true;
    }
    if (pathname === '/api/staff/swaps') {
      const st = trim(ctx.query.get('status'));
      const items = swap.list(st || null);
      ctx.sendJSON(res, 200, { ok: true, count: items.length, items });
      return true;
    }
    return false;
  }

  if (m !== 'POST') return false;

  // ---- 写（全部入队）----
  if (pathname === '/api/staff/config') {
    if (!needWrite(ctx, res)) return true;
    return (async () => {
      const body = await readJson(ctx, req);
      const th = attendance.thresholdsOf({ attendance: body.attendance || body });
      store.writeJSON(CONFIG_FILE, { attendance: th, updated_at: new Date().toISOString(), by: operatorOf(ctx, body) });
      ctx.sendJSON(res, 200, { ok: true, attendance: th, msg: '阈值已更新（BFF 本地生效）' });
      return true;
    })();
  }

  if (pathname === '/api/staff/uniform') {
    if (!needWrite(ctx, res)) return true;
    return (async () => {
      const body = await readJson(ctx, req);
      const op = operatorOf(ctx, body);
      const pass = body.pass == null ? '合格' : body.pass;
      const id = doEnqueue('uniform.log', {
        staff_id: trim(body.staff_id) || 'E0',
        staff_name: trim(body.staff_name) || null,
        pass, ts: body.ts || new Date().toISOString(),
        note: trim(body.note) || null,
        source: 'staff.uniform'
      }, op, ctx.traceId);
      const score = Number(body.score);
      const needReview = Number.isFinite(score) && score < 90;
      ctx.sendJSON(res, 200, {
        code: 200, ok: true, msg: 'queued',
        data: { id, status: needReview ? '待复核' : '入档', score: Number.isFinite(score) ? score : null },
        note: needReview ? 'Kimi 合规度 <90%，转待复核' : 'Kimi 合规度 ≥90%，已入档'
      });
      return true;
    })();
  }

  if (pathname === '/api/staff/quiz/pass') {
    if (!needWrite(ctx, res)) return true;
    return (async () => {
      const body = await readJson(ctx, req);
      const op = operatorOf(ctx, body);
      const wrong = arr(body.answers).filter((a) => {
        const q = QUIZ.find((x) => x.id === (a && a.id));
        if (!q) return false;
        return !q.keywords.some((k) => String((a && a.answer) || '').indexOf(k) >= 0);
      }).map((a) => a && a.id);
      const passed = wrong.length === 0;
      const id = doEnqueue('staff.train_pass', {
        staff_id: trim(body.staff_id) || 'E0',
        staff_name: trim(body.staff_name) || null,
        course: trim(body.course) || '关键工艺抽查',
        passed: passed ? 1 : 0,
        remark: passed ? '抽查通过 ' + QUIZ.length + '/' + QUIZ.length : '未通过：' + wrong.join(','),
        ts: new Date().toISOString()
      }, op, ctx.traceId);
      ctx.sendJSON(res, 200, { ok: true, code: 200, passed, wrong, data: { id }, msg: passed ? '抽查通过，已入队' : '抽查未通过' });
      return true;
    })();
  }

  if (pathname === '/api/staff/swaps/request') {
    if (!needWrite(ctx, res)) return true;
    return (async () => {
      const body = await readJson(ctx, req);
      const r = swap.request(body, ctx.auth);
      ctx.sendJSON(res, r.ok ? 200 : r.status, r.ok ? { ok: true, swap: r.swap } : { ok: false, error: r.error, id: r.id });
      return true;
    })();
  }

  const m2 = /^\/api\/staff\/swaps\/([^/]+)\/(accept|reject|approve)$/.exec(pathname);
  if (m2) {
    if (!needWrite(ctx, res)) return true;
    return (async () => {
      const id = decodeURIComponent(m2[1]);
      const act = m2[2];
      const body = await readJson(ctx, req);
      const snap = loadSnapshot();
      const snapRev = snap ? snap.rev : null;
      const rev = body.rev == null ? snapRev : body.rev; // 客户端未带 rev → 以当前快照 rev 为基准
      let r;
      if (act === 'accept') r = swap.accept(id, ctx.auth, snapRev, rev);
      else if (act === 'reject') r = swap.reject(id, ctx.auth, body.reason);
      else {
        r = swap.approve(id, ctx.auth, snapRev, rev, (type, payload, actor) => doEnqueue(type, payload, operatorOf(ctx, body), ctx.traceId));
      }
      ctx.sendJSON(res, r.ok ? 200 : r.status, r.ok
        ? { ok: true, swap: r.swap, write_actions: r.write_actions || [] }
        : { ok: false, error: r.error, expected_rev: r.expected_rev });
      return true;
    })();
  }

  return false;
}

module.exports = { handle, QUIZ };
