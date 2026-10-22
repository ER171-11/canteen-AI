'use strict';
/*
 * lib/si_flow.js — SI 主线流程（把平铺的专家卡收成一条经营闭环）
 *
 *   看盘 → 抓异常 → 出方案 → 执行 → 追踪 → 沉淀
 * 每阶段带真实计数与状态（alert/warn/info/ok），并给出「下一步」。
 * 只读聚合，不写业务数据。
 */
function pipeline(snap) {
  const siTeam = require('./si_team');
  const siGoals = require('./si_goals');
  const siKnowledge = require('./si_knowledge');
  const siMission = require('./si_mission');
  const { buildInbox } = require('../routes/inbox');
  const { buildBriefing } = require('../routes/report');

  const team = siTeam.review(snap);
  const goals = siGoals.evaluate(snap);
  const kb = siKnowledge.all(snap);
  const missions = siMission.list();
  const inbox = buildInbox(snap);
  let headline = '';
  try { headline = buildBriefing(snap).headline; } catch (e) { headline = ''; }

  const activeMissions = missions.filter((m) => m.status === 'active').length;
  const offGoals = goals.items.filter((g) => g.status === 'off_track').length;

  // 各阶段挂真实明细，供主线卡内联处理
  const TPL_OF = {
    procurement: 'stock', foodsafe: 'foodsafe', finance: 'loss',
    kitchen: 'gross_margin', traffic: 'revenue'
  };
  const findItems = team.specialists
    .filter((s) => s.status !== 'on_track')
    .slice(0, 3)
    .map((s) => ({
      title: s.name,
      sub: (s.findings && s.findings[0]) || '',
      route: (s.recommends && s.recommends[0] && s.recommends[0].route) || 'm/si-team',
      mission_template: TPL_OF[s.id] || null
    }));
  const planItems = inbox.decide.slice(0, 3).map((x) => ({
    id: x.id, title: x.title, sub: x.summary, type: x.type, route: x.route
  }));
  const doingItems = inbox.doing.slice(0, 3).map((x) => ({
    id: x.id, title: x.title, sub: x.summary, type: x.type, route: x.route
  }));
  const trackItems = missions
    .filter((m) => m.status === 'active')
    .slice(0, 3)
    .map((m) => {
      const total = (m.steps || []).length || 1;
      const done = (m.steps || []).filter((s) => s.status === 'done').length;
      const next = (m.steps || []).find((s) => s.status === 'todo');
      return {
        id: m.id,
        mission_id: m.id,
        next_step_id: next ? next.id : null,
        next_step_label: next ? next.label : null,
        title: m.title,
        sub: `进度 ${Math.round((done / total) * 100)}%` + (next ? ` · 下一步：${next.label}` : ''),
        route: 'm/si-missions'
      };
    });
  const learnItems = kb.derived.slice(0, 3).map((p) => ({ title: p.title, sub: p.insight, route: 'm/si-team' }));

  const stages = [
    {
      key: 'watch', label: '看盘', count: 0, status: 'ok', items: [],
      text: headline || '读取门店数据', route: 'm/inbox'
    },
    {
      key: 'find', label: '抓异常', count: team.counts.off + team.counts.risk,
      status: team.counts.off > 0 ? 'alert' : (team.counts.risk > 0 ? 'warn' : 'ok'),
      items: findItems, text: team.summary, route: 'm/si-team'
    },
    {
      key: 'plan', label: '出方案', count: inbox.counts.decide,
      status: inbox.counts.decide > 0 ? 'warn' : 'ok',
      items: planItems,
      text: inbox.counts.decide ? `${inbox.counts.decide} 条提案等你拍板` : '暂无待拍板提案',
      route: 'm/inbox'
    },
    {
      key: 'execute', label: '执行', count: inbox.counts.doing,
      status: inbox.counts.doing > 0 ? 'info' : 'ok',
      items: doingItems,
      text: inbox.counts.doing ? `${inbox.counts.doing} 条店内执行中` : '无在途执行',
      route: 'm/inbox'
    },
    {
      key: 'track', label: '追踪', count: activeMissions + offGoals,
      status: offGoals > 0 ? 'warn' : 'ok',
      items: trackItems,
      text: `${activeMissions} 个战役推进 · 目标达成 ${goals.score}%`,
      route: 'm/si-missions'
    },
    {
      key: 'learn', label: '沉淀', count: kb.derived.length + kb.custom.length,
      status: 'ok',
      items: learnItems,
      text: `${kb.derived.length + kb.custom.length} 条打法可迁移`,
      route: 'm/si-team'
    }
  ];

  const order = { alert: 0, warn: 1, info: 2, ok: 3 };
  const ranked = stages
    .filter((s) => s.key !== 'watch')
    .slice()
    .sort((a, b) => (order[a.status] - order[b.status]) || ((b.count || 0) - (a.count || 0)));
  const next = (ranked[0] && ranked[0].status !== 'ok') ? ranked[0].key : 'watch';

  return {
    ok: true,
    rev: snap ? snap.rev : null,
    updated_at: new Date().toISOString(),
    headline,
    stages,
    next_key: next
  };
}

module.exports = { pipeline };
