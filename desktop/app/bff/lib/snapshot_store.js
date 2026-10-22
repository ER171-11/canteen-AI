'use strict';
/*
 * lib/snapshot_store.js — 服务端「快照备份」历史存储（零依赖）
 *
 * 形态依据 `docs/decisions/ADR-009-服务端快照形态与录入职责边界.md` §2.1：
 *   服务端 `data/snapshot.json` 是**唯一数据源**；本模块在其之下提供**用户手动打的历史快照**：
 *     data/snapshots/index.json    备份索引（按时间倒序，只存元信息）
 *     data/snapshots/<id>.json     该次备份的**快照全文**（与 `snapshot.json` 同结构，可直接回灌 `/api/snapshot/push`）
 *
 * 红线（与 ADR-009 §4 一致）：
 *   · 只写 `data/snapshots/` 下的**备份文件**；**不写业务库**（ings/dishes/sales/…）、不入 `actions_queue.json`；
 *   · 业务数据的唯一写入口仍是 `POST /api/actions` 审批队列（本模块不提供任何业务写路径）；
 *   · 回滚（FP-SET-10 的另一半）**不在本模块**——它属高危写，须走审批队列并由消费器执行（ADR-009 §2.2）。
 *
 * 保留策略：只保最近 KEEP 份，超出自动淘汰最旧的（避免手动打快照无限增长撑爆磁盘）。
 * 原子写：tmp + rename（与 lib/store.js 同手法），避免半截文件被读到。
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');

/** 保留份数（超出淘汰最旧；调大可改此常量，不影响既有备份） */
const KEEP = 20;
const INDEX = 'index.json';
/** id 白名单：仅数字/字母/连字符，防路径穿越 */
const ID_RX = /^[0-9A-Za-z-]{1,64}$/;

function dirPath() { return path.join(store.DATA_DIR, 'snapshots'); }
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

const pad = (n, w) => String(n).padStart(w, '0');

/** 读取备份索引（坏文件/缺失一律回落空数组，不让备份列表把页面打挂） */
function list() {
  try {
    const arr = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    return Array.isArray(arr) ? arr.filter((x) => x && x.id) : [];
  } catch (e) { return []; }
}

function writeIndex(items) {
  ensureDir();
  try { writeAtomic(indexPath(), JSON.stringify(items, null, 1)); }
  catch (e) { console.error('[BFF][snapshot_store] write index failed:', e && e.message); }
}

/** 备份 id：本地时间戳 + 快照 rev，如 20261012-153012-r284（同一秒重复点击自动加 -2/-3 后缀） */
function newId(rev, now) {
  const d = now instanceof Date ? now : new Date();
  return d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2)
    + '-' + pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + pad(d.getSeconds(), 2)
    + '-r' + (rev == null ? 'na' : String(rev));
}

/**
 * 打一份备份。
 * @param {object} snap 当前快照（{rev, generated_at, data, ext, ...}）
 * @param {object} [meta] {operator, note}
 * @returns {{item:object, dropped:number, keep:number}}
 */
function save(snap, meta) {
  if (!snap || typeof snap !== 'object' || snap.data === undefined) {
    throw new Error('无快照可备份（服务端暂无 snapshot.json）');
  }
  ensureDir();
  const m = meta || {};
  const now = new Date();
  const items = list();
  let id = newId(snap.rev, now);
  if (items.some((x) => x.id === id) || fs.existsSync(fileOf(id))) {
    let n = 2;
    while (items.some((x) => x.id === id + '-' + n) || fs.existsSync(fileOf(id + '-' + n))) n++;
    id = id + '-' + n;
  }
  const body = JSON.stringify(snap);
  writeAtomic(fileOf(id), body);
  const item = {
    id,
    rev: snap.rev == null ? null : snap.rev,
    size: Buffer.byteLength(body),
    generated_at: snap.generated_at || null,
    created_at: now.toISOString(),
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
  return { item, dropped: dropped.length, keep: KEEP };
}

/** 读某份备份的**全文快照**（不存在/坏文件返回 null） */
function read(id) {
  if (!ID_RX.test(String(id || ''))) return null;
  try {
    const snap = JSON.parse(fs.readFileSync(fileOf(String(id)), 'utf8'));
    return (snap && typeof snap === 'object' && snap.data !== undefined) ? snap : null;
  } catch (e) { return null; }
}

/** 读某份备份的元信息（不存在返回 null） */
function metaOf(id) {
  return list().find((x) => x.id === id) || null;
}

module.exports = { KEEP, dirPath, ensureDir, save, list, read, metaOf, newId };
