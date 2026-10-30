'use strict';
/*
 * lib/import_store.js — W4-01「导入备份恢复」的**暂存区**（ADR-013 D4-1/D4-3/D4-7）。
 *
 * 为什么需要暂存区：
 *   ① `/api/actions` 的 payload 会随队列列表（审批中心）一起下发，把 300KB+ 的整库快照塞进
 *      payload 会让每次 `GET /api/actions` 变成下载整库；而且导入内容不该出现在审批列表里；
 *   ② 执行器从磁盘读文件，天然绕开 HTTP body 限制（与 W2-01 回滚读 `data/snapshots/<id>.json` 同一取舍）。
 *
 * 形态：
 *   data/imports/<id>.json      导入文件的**原样副本**（仍是 {rev, generated_at, data, ext}）
 *   data/imports/index.json     索引（id / sha256 / rev / size / created_at / operator / note）
 *
 * 红线：
 *   · **只写 data/imports/ 下的暂存文件**：不写业务库、不写快照、不入审批队列（入队由调用方显式发起）；
 *   · id = `imp-` + 内容 sha256 前 16 位 → 同一份文件重复上传复用同一 id（红线③幂等：同一导入文件不重复执行）；
 *   · 暂存本身不是「恢复」：真正的整包覆盖只在 `snapshot.import` 执行器里发生（走 /api/actions 队列）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

/** 最多保留份数（超出淘汰最旧；暂存文件只是排队等待执行的中间态） */
const KEEP = 10;
const INDEX = 'index.json';
/** id 白名单：`imp-` + 十六进制，防路径穿越 */
const ID_RX = /^imp-[0-9a-f]{8,64}$/;

function dirPath() { return path.join(store.DATA_DIR, 'imports'); }
function fileOf(id) { return path.join(dirPath(), id + '.json'); }
function indexPath() { return path.join(dirPath(), INDEX); }

function ensureDir() {
  try { fs.mkdirSync(dirPath(), { recursive: true }); } catch (e) { /* ignore */ }
}

function writeAtomic(p, text) {
  const tmp = p + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** 内容 → 暂存 id（同一份文件 → 同一 id，天然幂等） */
function idOf(text) {
  return 'imp-' + sha256(text).slice(0, 16);
}

function list() {
  try {
    const arr = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    return Array.isArray(arr) ? arr.filter((x) => x && x.id) : [];
  } catch (e) { return []; }
}

function writeIndex(items) {
  ensureDir();
  try { writeAtomic(indexPath(), JSON.stringify(items, null, 1)); }
  catch (e) { console.error('[BFF][import_store] write index failed:', e && e.message); }
}

/**
 * 暂存一份导入文件。
 * @param {string} text 上传原文（必须是合法 JSON 文本；调用方负责语义校验）
 * @param {object} [meta] {operator, note, rev}
 * @returns {{item:object, reused:boolean}}
 */
function save(text, meta) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('导入内容为空');
  const m = meta || {};
  const id = idOf(text);
  const items = list();
  const exist = items.find((x) => x.id === id);
  if (exist) return { item: exist, reused: true };

  ensureDir();
  writeAtomic(fileOf(id), text);
  const item = {
    id,
    sha256: sha256(text),
    rev: (typeof m.rev === 'number') ? m.rev : null,
    size: Buffer.byteLength(text),
    created_at: new Date().toISOString(),
    operator: m.operator || null,
    note: m.note ? String(m.note).slice(0, 200) : '',
  };
  const all = [item].concat(items);
  const kept = all.slice(0, KEEP);
  const dropped = all.slice(KEEP);
  for (const d of dropped) {
    try { fs.unlinkSync(fileOf(d.id)); } catch (e) { /* ignore */ }
  }
  writeIndex(kept);
  return { item, reused: false };
}

/** 读暂存区某份导入文件（不存在/坏文件 → null） */
function read(id) {
  const key = String(id || '');
  if (!ID_RX.test(key)) return null;
  try {
    const snap = JSON.parse(fs.readFileSync(fileOf(key), 'utf8'));
    return (snap && typeof snap === 'object') ? snap : null;
  } catch (e) { return null; }
}

function metaOf(id) {
  return list().find((x) => x.id === id) || null;
}

module.exports = { KEEP, dirPath, save, list, read, metaOf, idOf, sha256 };
