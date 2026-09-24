'use strict';
/*
 * lib/store.js — bff/data/ 下 JSON / JSONL 文件持久化（零依赖）
 *   - readJSON / writeJSON（tmp + rename 原子写）
 *   - appendJSONL / tailJSONL（审计与 kimi 调用日志）
 * 数据文件：tokens.json / actions_queue.json / snapshot.json / kimi_log.jsonl / audit.jsonl
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

function file(name) { return path.join(DATA_DIR, name); }

function readJSON(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJSON(name, obj) {
  const tmp = file(name) + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file(name));
  } catch (e) {
    console.error('[BFF][store] write ' + name + ' failed:', e && e.message);
  }
}

function appendJSONL(name, obj) {
  try {
    fs.appendFileSync(file(name), JSON.stringify(obj) + '\n');
  } catch (e) {
    console.error('[BFF][store] append ' + name + ' failed:', e && e.message);
  }
}

function tailJSONL(name, limit) {
  limit = Math.max(1, Math.min(1000, parseInt(limit, 10) || 100));
  try {
    const raw = fs.readFileSync(file(name), 'utf8').trim();
    if (!raw) return [];
    const lines = raw.split('\n');
    const out = [];
    for (let i = Math.max(0, lines.length - limit); i < lines.length; i++) {
      try { out.push(JSON.parse(lines[i])); } catch (e) {}
    }
    return out;
  } catch (e) {
    return [];
  }
}

module.exports = { DATA_DIR, readJSON, writeJSON, appendJSONL, tailJSONL };
