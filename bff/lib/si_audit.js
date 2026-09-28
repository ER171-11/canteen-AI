'use strict';
/*
 * lib/si_audit.js — SI 决策审计（JSONL）
 *   si_audit.jsonl：{ts, trace_id, action_id, type, origin, decision, policy_id, tier, rev, reason}
 *   红线：只追加，不修改；不落 Key/图片。
 */
const store = require('./store');

function log(entry) {
  const e = Object.assign({ ts: new Date().toISOString() }, entry || {});
  delete e.image;
  delete e.imageBase64;
  store.appendJSONL('si_audit.jsonl', e);
}

function tail(limit) {
  return store.tailJSONL('si_audit.jsonl', limit);
}

module.exports = { log, tail };
