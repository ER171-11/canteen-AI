'use strict';
/*
 * lib/policy.js — 分级授权政策引擎
 *
 * 政策决定「SI 发起的动作」是否可越过人工点击、直接进入待执行（消费者随后落库）。
 * 红线：不改变写路径本身——仍是 actions 队列 → 店内 consumer → /api/sync（rev 乐观锁）；
 *   政策只把 queued 提前置为「待执行」，并强制留审计与回滚引用。
 *
 * 级别：
 *   L0 只读 / L1 草稿（默认，永不自动）/ L2 政策内自动（可审计+可回滚）/ L3 必人工确认
 *
 * 数据文件：bff/data/si_policies.json
 */
const store = require('./store');

const FILE = 'si_policies.json';

/** 永不允许自动执行的类型（高风险/对外/改标准/结论性判定） */
const NEVER_AUTO = new Set([
  'dish.price', 'dish.upsert', 'dish.set_active', 'recipe.upsert', 'recipe.substitute',
  'config.update', 'staff.shift_upsert', 'vip.campaign', 'finance.approve', 'finance.freeze',
  'pos.pay', 'pos.void', 'pos.merge', 'pos.split',
  /* 食安人工复核：AI 初判不得替代人工结论，必须由老板/店长点击确认 */
  'safety.review'
]);

const DEFAULTS = {
  auto_enabled: false,
  caps: { daily_auto_max: 20 },
  policies: []
};

function load() {
  const c = store.readJSON(FILE, null);
  if (!c || typeof c !== 'object') return JSON.parse(JSON.stringify(DEFAULTS));
  return {
    auto_enabled: c.auto_enabled === true,
    caps: Object.assign({}, DEFAULTS.caps, c.caps || {}),
    policies: Array.isArray(c.policies) ? c.policies : []
  };
}

function save(cfg) {
  store.writeJSON(FILE, cfg);
  return cfg;
}

function list() {
  return load();
}

function upsert(policy) {
  const cfg = load();
  const now = new Date().toISOString();
  const id = String((policy && policy.id) || '').trim() || ('pol_' + Date.now().toString(36));
  const rec = {
    id,
    name: String((policy && policy.name) || '未命名政策').slice(0, 60),
    enabled: !!(policy && policy.enabled),
    match: {
      origin: 'si',
      types: Array.isArray(policy && policy.match && policy.match.types)
        ? policy.match.types.map(String)
        : [],
      max_amount: Number(policy && policy.match && policy.match.max_amount) || 0
    },
    tier: 2,
    created_by: (policy && policy.created_by) || null,
    created_at: now,
    updated_at: now
  };
  const idx = cfg.policies.findIndex((p) => p.id === id);
  if (idx >= 0) {
    rec.created_at = cfg.policies[idx].created_at || now;
    cfg.policies[idx] = rec;
  } else {
    cfg.policies.push(rec);
  }
  save(cfg);
  return rec;
}

function remove(id) {
  const cfg = load();
  const before = cfg.policies.length;
  cfg.policies = cfg.policies.filter((p) => p.id !== id);
  save(cfg);
  return cfg.policies.length < before;
}

function setAutoEnabled(on) {
  const cfg = load();
  cfg.auto_enabled = !!on;
  save(cfg);
  return cfg;
}

/** 估算动作涉及金额（用于上限判断）；未知返回 0（视为不限金额） */
function amountOf(payload) {
  if (!payload || typeof payload !== 'object') return 0;
  for (const k of ['amount', 'total', 'price', 'payable']) {
    const v = parseFloat(payload[k]);
    if (!isNaN(v)) return v;
  }
  if (Array.isArray(payload.items)) {
    let sum = 0;
    for (const it of payload.items) {
      const q = parseFloat(it && it.qty);
      const p = parseFloat(it && it.price);
      if (!isNaN(q) && !isNaN(p)) sum += q * p;
    }
    return sum;
  }
  return 0;
}

/** 今日已自动执行数（用于每日上限） */
function todayAutoCount() {
  const q = store.readJSON('actions_queue.json', []);
  const today = new Date().toISOString().slice(0, 10);
  return (Array.isArray(q) ? q : []).filter((a) =>
    a && a.auto_executed === true && String(a.confirmed_at || '').slice(0, 10) === today
  ).length;
}

/**
 * 求值：SI 动作是否可自动执行。
 * @returns {{auto:boolean, policy_id?:string, tier:number, reason:string, amount:number}}
 */
function evaluate(action, cfgArg) {
  const cfg = cfgArg || load();
  const tierOf = (action && action.tier != null) ? action.tier : 1;
  const amount = amountOf(action && action.payload);
  const base = { auto: false, tier: tierOf, reason: '', amount };

  if (!cfg.auto_enabled) return Object.assign(base, { reason: '自动执行总开关关闭' });
  if (!action || action.origin !== 'si') return Object.assign(base, { reason: '非 SI 发起' });
  if (NEVER_AUTO.has(String(action.type))) return Object.assign(base, { reason: '该类型禁止自动执行' });

  const cap = Number(cfg.caps && cfg.caps.daily_auto_max) || 0;
  if (cap > 0 && todayAutoCount() >= cap) {
    return Object.assign(base, { reason: '已达每日自动执行上限 ' + cap });
  }

  for (const p of cfg.policies) {
    if (!p || !p.enabled) continue;
    const types = (p.match && Array.isArray(p.match.types)) ? p.match.types : [];
    if (types.length && types.indexOf(action.type) < 0) continue;
    const max = Number(p.match && p.match.max_amount) || 0;
    if (max > 0 && amount > max) continue;
    return { auto: true, policy_id: p.id, tier: 2, reason: '命中政策「' + p.name + '」', amount };
  }
  return Object.assign(base, { reason: '无匹配政策' });
}

module.exports = {
  load, save, list, upsert, remove, setAutoEnabled,
  evaluate, amountOf, todayAutoCount, NEVER_AUTO, FILE
};
