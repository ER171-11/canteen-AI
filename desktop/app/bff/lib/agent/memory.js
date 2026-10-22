'use strict';
/*
 * lib/agent/memory.js — SI 轻量记忆（按门店）
 *   - 记录最近问答，供后续上下文与偏好学习（P0 仅回放，不参与决策）
 * 数据文件：bff/data/si_memory.json
 */
const store = require('../store');

const FILE = 'si_memory.json';
const MAX_PER_STORE = 30;

function keyOf(storeId) { return String(storeId || 'default'); }

function load() {
  const m = store.readJSON(FILE, {});
  return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
}

function recent(storeId, limit) {
  const all = load();
  const list = Array.isArray(all[keyOf(storeId)]) ? all[keyOf(storeId)] : [];
  const n = Math.max(1, Math.min(MAX_PER_STORE, parseInt(limit, 10) || 5));
  return list.slice(-n);
}

function append(storeId, entry) {
  const all = load();
  const k = keyOf(storeId);
  const list = Array.isArray(all[k]) ? all[k] : [];
  list.push({
    ts: new Date().toISOString(),
    q: String((entry && entry.q) || '').slice(0, 200),
    a: String((entry && entry.a) || '').slice(0, 400)
  });
  all[k] = list.slice(-MAX_PER_STORE);
  store.writeJSON(FILE, all);
}

module.exports = { recent, append };
