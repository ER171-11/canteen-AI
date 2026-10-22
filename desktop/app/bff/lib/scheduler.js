'use strict';
/*
 * lib/scheduler.js — SI 主动触发调度（定时简报 / 事件）
 *
 *   早报：默认 08:00，晚结：默认 21:30（可配）。进程内 60s tick，跨天去重。
 *   触发内容写入 push feed（客户端 /api/inbox 拉取或 /api/inbox/stream 实时收）。
 *   环境变量 SI_SCHEDULER=0 可关闭（测试用）。
 */
const store = require('./store');
const push = require('./push');
const { loadSnapshot } = require('../routes/snapshot');
const { buildBriefing } = require('../routes/report');

const CONFIG_FILE = 'si_config.json';
const STATE_FILE = 'si_schedule_state.json';

const DEFAULT_CONFIG = {
  briefing: { enabled: true, at: '08:00', evening_at: '21:30' }
};

function loadConfig() {
  const c = store.readJSON(CONFIG_FILE, null);
  const merged = Object.assign({}, DEFAULT_CONFIG, c || {});
  merged.briefing = Object.assign({}, DEFAULT_CONFIG.briefing, (c && c.briefing) || {});
  // 老板偏好（SI 偏好 UI）优先：早报/晚结时间
  try {
    const p = require('../routes/si').loadPref();
    if (p && p.briefing_at) merged.briefing.at = p.briefing_at;
    if (p && p.evening_at) merged.briefing.evening_at = p.evening_at;
    merged.preferences = p || null;
  } catch (e) { /* 偏好缺失时用默认 */ }
  return merged;
}

function loadState() { return store.readJSON(STATE_FILE, {}) || {}; }
function saveState(s) { store.writeJSON(STATE_FILE, s); }

function nowHM() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return { date: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()), hm: p(d.getHours()) + ':' + p(d.getMinutes()) };
}
function toMin(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function emitBriefing(slot) {
  const snap = loadSnapshot();
  if (!snap) return null;
  const b = buildBriefing(snap);
  const item = push.dispatch({
    kind: slot === 'evening' ? 'evening' : 'briefing',
    level: (b.alerts || []).some((a) => a.level === 'critical') ? 'warn' : 'info',
    title: slot === 'evening' ? 'SI 晚间小结' : 'SI 早报',
    body: b.headline,
    route: 'm/inbox',
    meta: { rev: b.rev, bullets: b.bullets }
  });
  return item;
}

let timer = null;

function tick() {
  const cfg = loadConfig();
  if (!cfg.briefing.enabled) return;
  const { date, hm } = nowHM();
  const nowMin = toMin(hm);
  const state = loadState();
  let dirty = false;

  const slots = [
    { key: 'last_briefing_date', at: cfg.briefing.at, slot: 'morning' },
    { key: 'last_evening_date', at: cfg.briefing.evening_at, slot: 'evening' }
  ];
  for (const s of slots) {
    const atMin = toMin(s.at);
    if (atMin == null || nowMin == null) continue;
    // 到点后 2 小时内补触发（进程晚启动也能补早报）
    if (nowMin >= atMin && nowMin <= atMin + 120 && state[s.key] !== date) {
      const item = emitBriefing(s.slot);
      state[s.key] = date;
      dirty = true;
      if (item) console.log('[BFF][scheduler] emitted', s.slot, item.id);
    }
  }

  // 战役值守：每 15 分钟推进一次 active 战役（超长期持续执行）
  const mt = state.last_mission_tick ? new Date(state.last_mission_tick).getTime() : 0;
  if (Date.now() - mt >= 15 * 60 * 1000) {
    try {
      const snap = loadSnapshot();
      if (snap) {
        const { tick } = require('./si_mission');
        const { propose } = require('../routes/actions');
        const out = tick(snap, propose);
        state.last_mission_tick = new Date().toISOString();
        dirty = true;
        if (out && out.advanced) console.log('[BFF][scheduler] mission advanced', out.advanced);
      }
    } catch (e) {
      console.warn('[BFF][scheduler] mission tick failed:', e && e.message);
    }
  }
  // 写队列健康：卡死（待执行长时间不清）→ 投递 SI 收件箱告警（30 分钟去重）
  try {
    const { queueHealth } = require('./si_cockpit');
    const qh = queueHealth();
    if (qh.stalled) {
      const last = state.last_queue_alert || 0;
      if (Date.now() - last > 30 * 60 * 1000) {
        require('./push').dispatch({
          kind: 'alert',
          level: 'critical',
          title: '写队列可能卡死',
          body: `${qh.pending_execute} 条已确认超 ${qh.oldest_execute_min} 分钟未落库 · 检查店内执行器/token`,
          route: 'm/inbox'
        });
        state.last_queue_alert = Date.now();
        dirty = true;
        console.warn('[BFF][scheduler] queue stalled alert dispatched');
      }
    } else if (state.last_queue_alert) {
      state.last_queue_alert = 0;
      dirty = true;
    }
  } catch (e) {
    /* ignore */
  }

  if (dirty) saveState(state);
}

function start() {
  if (String(process.env.SI_SCHEDULER || '1') === '0') {
    console.log('[BFF][scheduler] disabled via SI_SCHEDULER=0');
    return;
  }
  if (timer) return;
  // 启动先补一次，再每分钟检查
  setTimeout(tick, 3000).unref();
  timer = setInterval(tick, 60000);
  timer.unref();
  console.log('[BFF][scheduler] started');
}

module.exports = { start, tick, emitBriefing, loadConfig };
