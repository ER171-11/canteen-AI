'use strict';
/*
 * lib/algorithms/execute.js — 算法执行器（BFF 侧）
 *
 * 职责：把已迁移到 BFF 的业务算法，作用于「云端快照副本」，产出新快照。
 *   - 输入：action {type, payload}、当前 snapshot {rev, data, ext}
 *   - 运行：registry.run(type, ctx, data, payload)
 *   - 输出：{ok, handled, type, result, data, nextRev}
 *
 * ctx.store：算法层对「写新表」的抽象。BFF 把新表行暂存进快照 ext（如 ext.<table>），
 *   与店内 pusher 的 ext 契约一致；后续由店内 consumer 落 SQLite，或 BFF 持久化。
 *
 * 未登记的 type 返回 {handled:false}，由调用方回 need-manual，绝不静默丢动作。
 */

const crypto = require('crypto');
const registry = require('./index');
require('./registry'); // 触发全部算法登记

/** 基于 snapshot.ext 的轻量 store：insert/upsert 到 ext.<table> 数组 */
function makeExtStore(ext, opts) {
  const e = (ext && typeof ext === 'object') ? ext : {};
  const stamp = (opts && opts.now) || new Date().toISOString();
  const audit = [];

  function tableRows(t) {
    if (!Array.isArray(e[t])) e[t] = [];
    return e[t];
  }

  return {
    ext: e,
    audit,
    insert(table, row) {
      const rows = tableRows(table);
      const r = Object.assign({ _inserted_at: stamp }, row || {});
      rows.push(r);
      audit.push({ op: 'insert', table, row: r });
      return { ok: true, table, rowid: rows.length };
    },
    upsert(table, row, keys) {
      const rows = tableRows(table);
      const ks = Array.isArray(keys) && keys.length ? keys : ['id'];
      const pick = (o) => ks.map((k) => String(o && o[k] != null ? o[k] : '')).join('\u0000');
      const key = pick(row);
      const idx = rows.findIndex((x) => pick(x) === key && key.replace(/\u0000/g, '') !== '');
      if (idx >= 0) {
        rows[idx] = Object.assign({}, rows[idx], row, { _updated_at: stamp });
        audit.push({ op: 'update', table, row: rows[idx] });
        return { ok: true, table, rowid: idx + 1, matched: true };
      }
      const r = Object.assign({ _inserted_at: stamp }, row || {});
      rows.push(r);
      audit.push({ op: 'insert', table, row: r });
      return { ok: true, table, rowid: rows.length, matched: false };
    },
    update(table, patch, where) {
      const rows = tableRows(table);
      let n = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const hit = !where || Object.keys(where).every((k) => String(row[k]) === String(where[k]));
        if (hit) { rows[i] = Object.assign({}, row, patch || {}); n += 1; }
      }
      audit.push({ op: 'update', table, where, count: n });
      return { ok: true, table, count: n };
    },
    query(table) {
      return Array.isArray(e[table]) ? e[table].slice() : [];
    }
  };
}

/**
 * 执行一个动作到内存快照副本。
 * @param {object} snapshot 当前快照 {rev, data, ext, ...}（不会被修改，内部深拷贝必要字段）
 * @param {object} action   {type, payload, operator, trace_id}
 * @param {object} [opts]   {now, store?}  store 可注入（测试）
 * @returns {{ok:boolean, handled:boolean, type:string, result?:any, error?:string, snapshot?:object}}
 */
function executeAction(snapshot, action, opts) {
  const type = String((action && action.type) || '');
  if (!registry.has(type)) {
    return { ok: false, handled: false, type, error: 'need-manual: 算法未登记 ' + type };
  }

  const base = snapshot && typeof snapshot === 'object' ? snapshot : {};
  // 深拷贝快照，避免执行失败污染原数据
  const snap = JSON.parse(JSON.stringify({
    rev: base.rev, generated_at: base.generated_at, size: base.size,
    machine: base.machine, data: base.data || {}, ext: base.ext === undefined ? null : base.ext
  }));

  const ctx = {
    rev: snap.rev,
    traceId: (action && action.trace_id) || null,
    now: (opts && opts.now) || new Date().toISOString(),
    store: (opts && opts.store) || makeExtStore(snap.ext)
  };
  // 让 store 的 ext 变更（若有）回写到快照
  if (!snap.ext && ctx.store && ctx.store.ext) snap.ext = ctx.store.ext;

  try {
    const res = registry.run(type, ctx, snap.data, (action && action.payload) || {});
    if (ctx.store && ctx.store.ext) snap.ext = ctx.store.ext;
    return { ok: true, handled: true, type, result: res.result, snapshot: snap };
  } catch (e) {
    return { ok: false, handled: true, type, error: (e && e.message) || String(e) };
  }
}

/** 生成下一个 rev（快照 rev 自增） */
function nextRev(snapshot) {
  const cur = snapshot && typeof snapshot.rev === 'number' ? snapshot.rev : 0;
  return cur + 1;
}

module.exports = { executeAction, makeExtStore, nextRev, listTypes: registry.listTypes };
