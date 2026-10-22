'use strict';
/*
 * lib/si_mission.js — SI 超长期战役（持续执行 + 统筹）
 *
 * 一个"战役"是跨天/跨周的经营目标，带里程碑与步骤；SI 值守循环每 15 分钟推进：
 *   - 用只读快照重算 KPI；
 *   - 把下一步推进为「进行中」，低风险步骤生成确认台提案（origin=si，命中政策可自动执行）；
 *   - KPI 达标 → 战役完成；异常 → 记日志并推送收件箱。
 * 数据文件：bff/data/si_missions.json；全部写操作最终仍走 actions 队列 → consumer → /api/sync。
 */
const store = require('./store');
const push = require('./push');
const siGoals = require('./si_goals');
const siTeam = require('./si_team');

const FILE = 'si_missions.json';

function readAll() {
  const m = store.readJSON(FILE, []);
  return Array.isArray(m) ? m : [];
}
function writeAll(list) { store.writeJSON(FILE, list); }
function id(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 6); }
function nowIso() { return new Date().toISOString(); }

/** 战役模板：领域 → 目标 + KPI + 里程碑 + 步骤 */
const TEMPLATES = {
  gross_margin: {
    title: '守住综合毛利率',
    objective: '把综合毛利率拉回目标线并稳定 2 周',
    kpi: { metric: 'gross_margin_pct', target: 31, unit: '%', dir: 'gte' },
    milestones: ['诊断低毛利菜', '落地调价/换料', '追踪 7 日', '复盘沉淀'],
    steps: [
      { label: '诊断毛利最低的 3 道菜', owner: '采购官', route: 'm/analysis' },
      { label: '生成调价/换料提案（经确认台）', owner: '采购官', route: 'm/restaurant', action_type: null },
      { label: '追踪 7 日毛利率变化', owner: '财务官', route: 'm/si-goals' },
      { label: '复盘并沉淀为知识', owner: 'SI', route: 'm/si-knowledge' }
    ]
  },
  loss: {
    title: '压降损耗',
    objective: '把月损耗率压到 1% 以内',
    kpi: { metric: 'loss_rate_pct', target: 1.0, unit: '%', dir: 'lte' },
    milestones: ['报损归因', '收紧审批', '盘点核对', '稳定'],
    steps: [
      { label: '报损归因（过期/制作/运输占比）', owner: '财务官', route: 'm/loss' },
      { label: '收紧报损审批并登记', owner: '食安官', route: 'm/loss', action_type: null },
      { label: '盘点核对账面差异', owner: '采购官', route: 'inventory' }
    ]
  },
  revenue: {
    title: '冲刺保本',
    objective: '日营收稳定超过保本线',
    kpi: { metric: 'breakeven_attain_pct', target: 100, unit: '%', dir: 'gte' },
    milestones: ['找低谷时段', '上套餐/爆品', '追踪达成', '复盘'],
    steps: [
      { label: '看时段热力找低谷', owner: '客流官', route: 'm/analysis' },
      { label: '低谷上套餐/爆品提案', owner: '营销官', route: 'm/vip', action_type: null },
      { label: '追踪保本达成', owner: '财务官', route: 'm/si-goals' }
    ]
  },
  stock: {
    title: '保障不断料',
    objective: '把安全线以下原料清零并维持',
    kpi: { metric: null, target: 0, unit: '项', dir: 'lte' },
    milestones: ['补齐缺货', '锁定供应商', '监控复购'],
    steps: [
      { label: '按缺货开采购单（低风险可自动）', owner: '采购官', route: 'inventory/restock', action_type: 'restock.create', action_from: 'low_stock' },
      { label: '缺料比价与账期核对', owner: '采购官', route: 'm/supply' },
      { label: '监控安全线恢复', owner: 'SI', route: 'inventory' }
    ]
  },
  foodsafe: {
    title: '食安零失分',
    objective: '证照/留样/消毒全绿',
    kpi: { metric: null, target: 0, unit: '项', dir: 'lte' },
    milestones: ['巡检异常', '整改', '复查'],
    steps: [
      { label: '巡检证照与留样临期', owner: '食安官', route: 'm/foodsafe' },
      { label: '整改临期项', owner: '食安官', route: 'm/foodsafe', action_type: null },
      { label: '复查台账', owner: 'SI', route: 'm/foodsafe' }
    ]
  }
};

function withSteps(steps, ownerDefault) {
  return (steps || []).map((s) => ({
    id: id('st'),
    label: s.label,
    owner: s.owner || ownerDefault || 'SI',
    route: s.route || null,
    action_type: s.action_type || null,
    action_from: s.action_from || null,
    status: 'todo',
    created_at: nowIso(),
    done_at: null
  }));
}

function create(input) {
  const m = input || {};
  const tpl = TEMPLATES[m.template || m.domain] || {};
  const mission = {
    id: id('ms'),
    title: m.title || tpl.title || '未命名战役',
    objective: m.objective || tpl.objective || '',
    domain: m.domain || m.template || 'custom',
    // advise=只建议(进确认台)；auto=低风险步骤可被政策自动执行
    autonomy: m.autonomy === 'auto' ? 'auto' : 'advise',
    status: 'active',
    horizon_days: m.horizon_days || 14,
    kpi: m.kpi || tpl.kpi || null,
    milestones: (m.milestones || tpl.milestones || []).map((label, i) => ({
      id: 'ml' + i, label, status: 'todo', done_at: null
    })),
    steps: withSteps(m.steps || tpl.steps, m.owner),
    log: [{ ts: nowIso(), text: '战役创建' }],
    created_at: nowIso(),
    updated_at: nowIso(),
    checkpoints: 0
  };
  const all = readAll();
  all.push(mission);
  writeAll(all);
  return mission;
}

function list() { return readAll(); }
function get(mid) { return readAll().find((m) => m.id === mid) || null; }

function update(mid, patch) {
  const all = readAll();
  const idx = all.findIndex((m) => m.id === mid);
  if (idx < 0) return null;
  all[idx] = Object.assign({}, all[idx], patch, { updated_at: nowIso() });
  writeAll(all);
  return all[idx];
}

function remove(mid) {
  const all = readAll();
  const before = all.length;
  writeAll(all.filter((m) => m.id !== mid));
  return all.length < before;
}

function log(mission, text) {
  mission.log = (mission.log || []).slice(-49);
  mission.log.push({ ts: nowIso(), text });
  mission.updated_at = nowIso();
}

/** 从缺货快照构造 restock.create payload */
function lowStockPayload(snap) {
  const ings = (snap && snap.data && Array.isArray(snap.data.ings)) ? snap.data.ings : [];
  const items = [];
  for (const it of ings) {
    const qty = parseFloat(it && (it.qty != null ? it.qty : it.stock));
    const safe = parseFloat(it && (it.safe != null ? it.safe : it.safety));
    if (isNaN(safe) || safe <= 0) continue;
    if (isNaN(qty) || qty >= safe) continue;
    items.push({
      ing_id: it.id != null ? String(it.id) : (it.name || ''),
      name: it.name || '原料',
      qty: Math.round((safe - qty) * 1000) / 1000,
      unit: it.unit || it.buy || '斤',
      price: parseFloat(it.price != null ? it.price : it.cost) || 0
    });
  }
  if (!items.length) return null;
  return { supplier: 'SI战役自动补货', note: 'SI 战役·保障不断料', items: items.slice(0, 12) };
}

function kpiStatus(mission, snap) {
  if (!mission.kpi || !mission.kpi.metric) return null;
  const m = siGoals.computeMetrics(snap);
  const v = m[mission.kpi.metric];
  if (v == null) return null;
  const ok = mission.kpi.dir === 'lte' ? v <= mission.kpi.target : v >= mission.kpi.target;
  return { value: v, target: mission.kpi.target, dir: mission.kpi.dir, met: ok };
}

/**
 * 值守推进：每次 tick 至多推进一步/一战役，避免噪音。
 * @param {object} snap
 * @param {function} propose (type,payload,title,summary,meta) => {auto,id}
 */
function tick(snap, propose) {
  const all = readAll();
  const digest = [];
  let dirty = false;

  for (const mission of all) {
    if (mission.status !== 'active') continue;
    mission.checkpoints = (mission.checkpoints || 0) + 1;

    // KPI 达标 → 完成
    const ks = kpiStatus(mission, snap);
    if (ks && ks.met) {
      mission.status = 'done';
      log(mission, `KPI 达标（${ks.value}${mission.kpi.unit}）→ 战役完成`);
      digest.push({ mission: mission.title, text: '已完成：' + mission.objective });
      dirty = true;
      continue;
    }

    const next = (mission.steps || []).find((s) => s.status === 'todo');
    if (!next) {
      // 无待办步骤：如 KPI 未配，则按专家巡检判定完成
      const team = siTeam.review(snap);
      if (mission.domain === 'foodsafe' && team.counts.off === 0) {
        mission.status = 'done';
        log(mission, '食安巡检全绿 → 战役完成');
        digest.push({ mission: mission.title, text: '已完成：食安零失分' });
        dirty = true;
      }
      continue;
    }

    // 推进下一步
    next.status = 'doing';
    next.started_at = nowIso();
    let proposed = null;
    if (next.action_type && typeof propose === 'function') {
      let payload = null;
      if (next.action_from === 'low_stock') payload = lowStockPayload(snap);
      if (payload) {
        try {
          proposed = propose(next.action_type, payload, {
            title: next.label,
            summary: 'SI 战役·' + mission.title,
            operator: 'SI',
            origin: 'si',
            tier: 1
          });
        } catch (e) { proposed = null; }
      }
    }
    log(mission, proposed
      ? `推进「${next.label}」→ 已生成确认台提案${proposed.auto ? '（政策内自动执行）' : ''}`
      : `推进「${next.label}」（${next.owner}）`);
    mission.last_step = next.id;
    if (proposed) mission.last_action_id = proposed.id || null;
    digest.push({
      mission: mission.title,
      text: `推进：${next.label}` + (proposed ? '（待确认）' : `（${next.owner} 跟进` + '）')
    });
    dirty = true;
    break; // 一次 tick 只推进一个战役一步，降噪
  }

  if (dirty) writeAll(all);

  if (digest.length) {
    push.dispatch({
      kind: 'mission',
      level: 'info',
      title: 'SI 战役进展',
      body: digest.map((d) => `· ${d.mission}：${d.text}`).join('\n'),
      route: 'm/si-missions'
    });
  }
  return { ok: true, advanced: digest.length, digest };
}

/** 手动推进指定步骤（老板/店长） */
function completeStep(mid, stepId) {
  const all = readAll();
  const mission = all.find((m) => m.id === mid);
  if (!mission) return null;
  const step = (mission.steps || []).find((s) => s.id === stepId);
  if (!step) return null;
  step.status = 'done';
  step.done_at = nowIso();
  log(mission, `完成「${step.label}」`);
  // 里程碑：按步骤顺序推进
  const doneCount = (mission.steps || []).filter((s) => s.status === 'done').length;
  const total = (mission.steps || []).length || 1;
  const mlIndex = Math.min((mission.milestones || []).length - 1, Math.floor((doneCount - 1) / Math.max(1, Math.ceil(total / (mission.milestones || []).length || 1))));
  const ml = (mission.milestones || [])[mlIndex];
  if (ml && ml.status === 'todo') { ml.status = 'done'; ml.done_at = nowIso(); }
  const allDone = (mission.steps || []).every((s) => s.status === 'done');
  if (allDone) mission.status = 'done';
  writeAll(all);
  return mission;
}

module.exports = { list, get, create, update, remove, tick, completeStep, TEMPLATES, FILE };
