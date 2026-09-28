'use strict';
/*
 * lib/si_cockpit.js — 老板全局 SI 驾驶舱（一次拿全店态势）
 * 聚合：早报结论 + KPI 达成 + 六域专家 + 主线下一步 + 待拍板/在办 + 战役 + 目标。
 * 只读聚合，不写业务数据。
 */
function cockpit(snap) {
  const siGoals = require('./si_goals');
  const siTeam = require('./si_team');
  const siFlow = require('./si_flow');
  const siMission = require('./si_mission');
  const store = require('./store');
  const { buildInbox } = require('../routes/inbox');
  const { buildBriefing } = require('../routes/report');

  const metrics = siGoals.computeMetrics(snap);
  const goals = siGoals.evaluate(snap);
  const team = siTeam.review(snap);
  const flow = siFlow.pipeline(snap);
  const missions = siMission.list().filter((m) => m.status === 'active');
  const inbox = buildInbox(snap);
  let headline = '';
  try { headline = buildBriefing(snap).headline; } catch (e) { headline = ''; }

  const nextStage = flow.stages.find((s) => s.key === flow.next_key) || flow.stages[0];
  const offGoals = goals.items.filter((g) => g.status === 'off_track');
  const atRiskGoals = goals.items.filter((g) => g.status === 'at_risk');

  // 写队列健康：待执行若长时间不清 → 店内执行器可能掉线（token 失效/进程停）
  const queue = queueHealth();
  const stalled = queue.stalled;

  const advice = [];
  if (stalled) advice.push(`写队列可能卡死：${queue.pending_execute} 条已确认但超 ${queue.oldest_execute_min} 分钟未落库，检查店内执行器`);

  // 近 14 日营收趋势（驾驶舱迷你图）
  const sales = Array.isArray(snap && snap.data && snap.data.sales) ? snap.data.sales : [];
  const byDay = {};
  for (const r of sales) {
    const d = String((r && (r.date || r.ts || r.time || r.created_at)) || '').slice(0, 10);
    if (!d) continue;
    const v = parseFloat(r && (r.amount != null ? r.amount : (r.total != null ? r.total : r.revenue)));
    byDay[d] = (byDay[d] || 0) + (isNaN(v) ? 0 : v);
  }
  const trend = Object.keys(byDay).sort().slice(-14).map((d) => ({ date: d, revenue: Math.round(byDay[d]) }));

  return {
    ok: true,
    rev: snap ? snap.rev : null,
    updated_at: new Date().toISOString(),
    headline,
    kpis: {
      revenue_today: metrics._today_revenue,
      breakeven_day: metrics._breakeven_day,
      attain_pct: metrics.breakeven_attain_pct,
      gross_margin_pct: metrics.gross_margin_pct,
      loss_rate_pct: metrics.loss_rate_pct,
      avg_ticket: metrics.avg_ticket,
      daily_avg_revenue: metrics.daily_avg_revenue
    },
    goal_score: goals.score,
    goals_alert: offGoals.concat(atRiskGoals).slice(0, 5).map((g) => ({
      label: g.label, status: g.status, current: g.current, target: g.target, unit: g.unit, advice: g.advice
    })),
    team: {
      counts: team.counts,
      summary: team.summary,
      specialists: team.specialists.map((s) => ({ id: s.id, name: s.name, icon: s.icon, status: s.status, finding: (s.findings && s.findings[0]) || '' }))
    },
    next: {
      key: nextStage.key, label: nextStage.label, text: nextStage.text,
      count: nextStage.count, route: nextStage.route, status: nextStage.status
    },
    stages: flow.stages.map((s) => ({ key: s.key, label: s.label, status: s.status, count: s.count, text: s.text })),
    inbox: { decide: inbox.counts.decide, doing: inbox.counts.doing, alerts: inbox.counts.alerts },
    queue,
    advice,
    trend,
    missions: missions.slice(0, 5).map((m) => {
      const total = (m.steps || []).length || 1;
      const done = (m.steps || []).filter((s) => s.status === 'done').length;
      return { id: m.id, title: m.title, progress: Math.round((done / total) * 100) };
    })
  };
}



/** 写队列健康（供 /api/queue/health 与驾驶舱复用） */
function queueHealth() {
  const store = require('./store');
  const raw = store.readJSON('actions_queue.json', []);
  const q = Array.isArray(raw) ? raw : [];
  const pendingExec = q.filter((a) => a && a.status === '待执行');
  const queued = q.filter((a) => a && a.status === 'queued');
  const oldestMs = pendingExec.reduce((m, a) => {
    const t = new Date(a.confirmed_at || a.created_at).getTime();
    return isNaN(t) ? m : Math.min(m, t);
  }, Infinity);
  const oldestMin = pendingExec.length ? Math.round((Date.now() - oldestMs) / 60000) : 0;
  return {
    pending_confirm: queued.length,
    pending_execute: pendingExec.length,
    oldest_execute_min: oldestMin,
    stalled: pendingExec.length > 0 && oldestMin >= 3
  };
}

module.exports = { cockpit, queueHealth };
