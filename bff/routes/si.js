'use strict';
/*
 * routes/si.js — SI 目标 / What-if 模拟 / 偏好
 *
 *   GET  /api/si/goals        → 目标达成评估（只读）
 *   POST /api/si/goals        → 设/改目标（需 actions.write）
 *   POST /api/si/simulate     → What-if 模拟（只读）
 *   GET  /api/si/preferences  → 老板偏好
 *   POST /api/si/preferences  → 保存偏好（需 actions.write）
 *
 * 红线：goals/simulate 全部只读快照；不改任何业务数据。
 */
const store = require('../lib/store');
const siGoals = require('../lib/si_goals');
const siSim = require('../lib/si_sim');
const siAudit = require('../lib/si_audit');
const siMission = require('../lib/si_mission');
const siTeam = require('../lib/si_team');
const siKnowledge = require('../lib/si_knowledge');
const actionsLib = require('./actions');
const { loadSnapshot } = require('./snapshot');
const { mayWriteActions } = require('../lib/auth');

const PREF_FILE = 'si_preferences.json';
const DEFAULT_PREF = {
  briefing_at: '08:00',
  evening_at: '21:30',
  watch_metrics: ['营收', '毛利率', '损耗'],
  muted_alerts: []
};

function loadPref() {
  const p = store.readJSON(PREF_FILE, null);
  return Object.assign({}, DEFAULT_PREF, (p && typeof p === 'object') ? p : {});
}

async function handle(req, res, ctx, pathname) {
  const snap = loadSnapshot();

  if (req.method === 'GET' && pathname === '/api/si/goals') {
    ctx.sendJSON(res, 200, siGoals.evaluate(snap));
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/si/goals') {
    if (!ctx.auth || !mayWriteActions(ctx.auth)) {
      ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' });
      return true;
    }
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    if (!body || !body.id) {
      ctx.sendJSON(res, 400, { ok: false, error: 'missing id' });
      return true;
    }
    const saved = siGoals.upsertGoal({
      id: String(body.id),
      label: body.label,
      metric: body.metric,
      target: body.target != null ? Number(body.target) : undefined,
      unit: body.unit,
      dir: body.dir,
      route: body.route
    });
    siAudit.log({
      trace_id: ctx.traceId, decision: 'goal_upsert', origin: 'human',
      policy_id: null, reason: body.id + '=' + body.target,
      operator: ctx.auth.account || ctx.auth.role
    });
    ctx.sendJSON(res, 200, Object.assign(siGoals.evaluate(snap), { goals: saved }));
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/si/simulate') {
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    const out = siSim.simulate(body || {}, snap);
    ctx.sendJSON(res, out.ok ? 200 : 422, out);
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/si/preferences') {
    ctx.sendJSON(res, 200, { ok: true, preferences: loadPref() });
    return true;
  }

  /* ---------------- 专家团 / 战役 / 知识 ---------------- */

  if (req.method === 'GET' && pathname === '/api/si/team') {
    ctx.sendJSON(res, 200, siTeam.review(snap));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/si/pipeline') {
    ctx.sendJSON(res, 200, require('../lib/si_flow').pipeline(snap));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/si/cockpit') {
    ctx.sendJSON(res, 200, require('../lib/si_cockpit').cockpit(snap));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/queue/health') {
    ctx.sendJSON(res, 200, Object.assign({ ok: true, rev: snap ? snap.rev : null }, require('../lib/si_cockpit').queueHealth()));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/si/knowledge') {
    ctx.sendJSON(res, 200, siKnowledge.all(snap));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/si/missions') {
    ctx.sendJSON(res, 200, { ok: true, missions: siMission.list(), templates: Object.keys(siMission.TEMPLATES) });
    return true;
  }

  const mm = pathname.match(/^\/api\/si\/missions\/([^/]+)(?:\/(advance|pause|resume))?$/);
  const canWrite = ctx.auth && mayWriteActions(ctx.auth);

  if (req.method === 'POST' && pathname === '/api/si/missions') {
    if (!canWrite) { ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' }); return true; }
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    const m = siMission.create(body || {});
    siAudit.log({ trace_id: ctx.traceId, decision: 'mission_create', origin: 'human', reason: m.title, policy_id: null, operator: ctx.auth.account || ctx.auth.role });
    ctx.sendJSON(res, 200, { ok: true, mission: m });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/si/missions/from-goal') {
    if (!canWrite) { ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' }); return true; }
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    const gid = String((body && body.goal_id) || '');
    const map = { gross_margin: 'gross_margin', loss_rate: 'loss', breakeven: 'revenue', avg_ticket: 'revenue', daily_revenue: 'revenue' };
    const tpl = map[gid] || 'gross_margin';
    const m = siMission.create({ template: tpl, autonomy: body && body.autonomy === 'auto' ? 'auto' : 'advise' });
    siAudit.log({ trace_id: ctx.traceId, decision: 'mission_from_goal', origin: 'human', reason: gid + '→' + tpl, policy_id: null, operator: ctx.auth.account || ctx.auth.role });
    ctx.sendJSON(res, 200, { ok: true, mission: m });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/si/missions/tick') {
    const out = siMission.tick(snap, actionsLib.propose);
    ctx.sendJSON(res, 200, out);
    return true;
  }

  if (mm && req.method === 'POST' && mm[2]) {
    if (!canWrite) { ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' }); return true; }
    const mid = mm[1];
    if (mm[2] === 'advance') {
      const { buf } = await ctx.readBody(req);
      let body = null;
      try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
      const stepId = body && body.step_id;
      let mission;
      if (stepId) mission = siMission.completeStep(mid, stepId);
      else {
        const cur = siMission.get(mid);
        const firstTodo = cur && (cur.steps || []).find((s) => s.status !== 'done');
        mission = firstTodo ? siMission.completeStep(mid, firstTodo.id) : cur;
      }
      ctx.sendJSON(res, mission ? 200 : 404, { ok: !!mission, mission: mission || null });
      return true;
    }
    if (mm[2] === 'pause') { const m = siMission.update(mid, { status: 'paused' }); ctx.sendJSON(res, m ? 200 : 404, { ok: !!m, mission: m }); return true; }
    if (mm[2] === 'resume') { const m = siMission.update(mid, { status: 'active' }); ctx.sendJSON(res, m ? 200 : 404, { ok: !!m, mission: m }); return true; }
  }

  if (mm && req.method === 'DELETE' && !mm[2]) {
    if (!canWrite) { ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' }); return true; }
    ctx.sendJSON(res, 200, { ok: true, removed: siMission.remove(mm[1]) });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/si/knowledge') {
    if (!canWrite) { ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' }); return true; }
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    ctx.sendJSON(res, 200, { ok: true, playbook: siKnowledge.addPlaybook(body || {}) });
    return true;
  }

  const km = pathname.match(/^\/api\/si\/knowledge\/([^/]+)$/);
  if (km && req.method === 'DELETE') {
    if (!canWrite) { ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' }); return true; }
    ctx.sendJSON(res, 200, { ok: true, removed: siKnowledge.removePlaybook(km[1]) });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/si/preferences') {
    if (!ctx.auth || !mayWriteActions(ctx.auth)) {
      ctx.sendJSON(res, 403, { ok: false, error: 'forbidden: actions.write required' });
      return true;
    }
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    const next = Object.assign(loadPref(), (body && typeof body === 'object') ? body : {});
    store.writeJSON(PREF_FILE, next);
    siAudit.log({
      trace_id: ctx.traceId, decision: 'preferences_update', origin: 'human',
      reason: JSON.stringify(next).slice(0, 200),
      operator: ctx.auth.account || ctx.auth.role
    });
    ctx.sendJSON(res, 200, { ok: true, preferences: next });
    return true;
  }

  return false;
}

module.exports = { handle, loadPref, DEFAULT_PREF };
