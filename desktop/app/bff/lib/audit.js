'use strict';
/*
 * lib/audit.js — 审计与 Kimi 调用日志（JSONL 追加，不落 Key、不落图片）
 *   - audit.jsonl：所有 /api/ 请求 {ts, trace_id, method, path, role, status, dt_ms}
 *   - kimi_log.jsonl：Kimi 调用 {ts, trace_id, type, model, http, dt_ms, degraded, stream}
 */
const store = require('./store');

function write(entry) {
  store.appendJSONL('audit.jsonl', entry);
}

function kimiLog(entry) {
  // 防御：即使上层误传也绝不落 Key / 图片字段
  if (entry && typeof entry === 'object') {
    delete entry.key;
    delete entry.api_key;
    delete entry.image;
    delete entry.imageBase64;
  }
  store.appendJSONL('kimi_log.jsonl', entry);
}

function tail(name, limit) {
  return store.tailJSONL(name, limit);
}

module.exports = { write, kimiLog, tail };
