'use strict';
/*
 * merge.js — 三向合并（base / mine / theirs）的 Node 移植，逐行对照
 * store-inventory/server/merge.py。
 *
 * 合并粒度（记录级，不是整库覆盖）
 * - ings/dishes/pos/sales/quotes 按 id
 * - logs 按 seq
 * - rec(配方) 按菜品 id，比较 _recU[菜品id]
 * - suppliers 取并集；platforms 按 name
 * - seq/v/rest 等标量：seq 取大，rest 取本机
 *
 * 规则
 * - 只有一端改 → 用改过的那端
 * - 两端都改 → 比 _u 时间戳，新的胜出；时间戳相同取服务端，并记入 conflicts
 * - 一端删除、另一端未改 → 认删；一端删除、另一端改过 → 保留改过的那端
 *
 * 关键保真点：Python 的 rec_hash 用
 *   json.dumps(clean, sort_keys=True, ensure_ascii=False, default=str)
 * 本文件用 pyDumps() 复刻同样的字符串口径，再取 sha1(utf-8)，
 * 从而保证 Node 与 Python 对同一条记录给出完全相同的指纹。
 */
const crypto = require('crypto');

// 集合名 -> 记录唯一键（与 merge.py 的 COLL_KEY 一致）
const COLL_KEY = {
  ings: 'id',
  dishes: 'id',
  pos: 'id',
  sales: 'id',
  quotes: 'id',
  logs: 'seq',
  // 云端队列写入的采购/进货必须参与合并，否则入库单与库存重算会在冲突路径丢失
  orders: 'id',
  recv: 'id',
  // 受控词表存 JSON 快照（data.ing_terms），按词条 id 合并，
  // 否则三向合并冲突路径会整体取 theirs，消费者刚写入的新词条/审核状态会被丢弃。
  ing_terms: 'id',
  // Phase 2 供应商类目受控词表（data.vendor_terms），同样按词条 id 合并，防冲突路径丢词条
  vendor_terms: 'id',
};

// ---------- Python json.dumps 兼容实现 ----------

// 按 Unicode 码点比较字符串（Python str 的比较口径）
function codePointCompare(a, b) {
  const ca = Array.from(a);
  const cb = Array.from(b);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const d = ca[i].codePointAt(0) - cb[i].codePointAt(0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (ca.length === cb.length) return 0;
  return ca.length < cb.length ? -1 : 1;
}

// Python json 对字符串的转义（ensure_ascii=False：中文原样输出）
function pyString(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x09) out += '\\t';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0d) out += '\\r';
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

// Python json 对数字的书写（整数不带小数点；浮点用最短往返表示）
function pyNumber(n) {
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

// 复刻 json.dumps(obj, sort_keys=True, ensure_ascii=False, default=str)
function pyDumps(obj) {
  const out = [];
  write(obj, out);
  return out.join('');

  function write(v, acc) {
    if (v === null || v === undefined) { acc.push('null'); return; }
    const t = typeof v;
    if (t === 'boolean') { acc.push(v ? 'true' : 'false'); return; }
    if (t === 'number') { acc.push(pyNumber(v)); return; }
    if (t === 'string') { acc.push(pyString(v)); return; }
    if (Array.isArray(v)) {
      acc.push('[');
      for (let i = 0; i < v.length; i++) {
        if (i) acc.push(', ');
        write(v[i], acc);
      }
      acc.push(']');
      return;
    }
    if (t === 'object') {
      const keys = Object.keys(v).sort(codePointCompare);
      acc.push('{');
      for (let i = 0; i < keys.length; i++) {
        if (i) acc.push(', ');
        acc.push(pyString(keys[i]));
        acc.push(': ');
        write(v[keys[i]], acc);
      }
      acc.push('}');
      return;
    }
    // default=str：其余类型交给字符串化
    acc.push(pyString(String(v)));
  }
}

// 记录指纹：忽略 _u(更新时间) / _d(墓碑)，只比业务内容
function recHash(obj) {
  let clean;
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    clean = {};
    for (const k of Object.keys(obj)) {
      if (k !== '_u' && k !== '_d') clean[k] = obj[k];
    }
  } else {
    clean = obj;
  }
  const raw = pyDumps(clean);
  return crypto.createHash('sha1').update(raw, 'utf8').digest('hex');
}

// ---------- 内部工具 ----------

function isDict(r) {
  return r !== null && typeof r === 'object' && !Array.isArray(r);
}

function index(rows, key) {
  const out = {};
  for (const r of rows || []) {
    if (!isDict(r)) continue;
    let k = r[key];
    if (k === null || k === undefined) k = recHash(r);
    out[String(k)] = r;
  }
  return out;
}

function ts(rec) {
  const v = (rec || {})['_u'];
  return v ? String(v) : '';
}

// 保持服务端原有顺序，新增记录追加在末尾
function order(rows, refRows, key) {
  const pos = {};
  (refRows || []).forEach((r, i) => {
    if (isDict(r)) {
      const k = r[key];
      if (k !== null && k !== undefined) pos[String(k)] = i;
    }
  });
  const keyOf = (r) => {
    const v = isDict(r) ? r[key] : undefined;
    return v ? String(v) : '';
  };
  const posOf = (r) => {
    const k = keyOf(r);
    return Object.prototype.hasOwnProperty.call(pos, k) ? pos[k] : 1e9;
  };
  return (rows || []).slice().sort((a, b) => {
    const pa = posOf(a);
    const pb = posOf(b);
    if (pa !== pb) return pa - pb;
    return codePointCompare(keyOf(a), keyOf(b));
  });
}

// ---------- 合并主体 ----------

function mergeList(rowsB, rowsM, rowsT, key, tag, conflicts) {
  const bm = index(rowsB, key);
  const mm = index(rowsM, key);
  const tm = index(rowsT, key);
  const out = [];
  // 用 object key 去重，等价于 Python 的 set(bm)|set(mm)|set(tm)
  const keys = new Set([...Object.keys(bm), ...Object.keys(mm), ...Object.keys(tm)]);
  for (const k of keys) {
    const rb = bm[k];
    const rm = mm[k];
    const rt = tm[k];
    const hb = rb !== undefined ? recHash(rb) : null;
    const hm = rm !== undefined ? recHash(rm) : null;
    const ht = rt !== undefined ? recHash(rt) : null;
    let chosen = null;

    if (rm !== undefined && rt !== undefined) {
      if (hm === ht) {
        chosen = rm;
      } else if (hm === hb) {
        chosen = rt; // 只有对端改
      } else if (ht === hb) {
        chosen = rm; // 只有本机改
      } else {
        const um = ts(rm);
        const ut = ts(rt);
        if (um > ut) {
          chosen = rm;
        } else if (ut > um) {
          chosen = rt;
        } else {
          chosen = rt;
          conflicts.push({ coll: tag, id: k, reason: 'both-changed-same-time' });
        }
      }
    } else if (rm !== undefined) { // 对端没有这条
      if (rb === undefined) { // 本机新增
        chosen = rm;
      } else if (hm === hb) { // 本机没改过 -> 认对端删除
        chosen = null;
      } else { // 本机改过、对端删了 -> 保留本机改动
        chosen = rm;
        conflicts.push({ coll: tag, id: k, reason: 'deleted-on-remote' });
      }
    } else if (rt !== undefined) { // 本机没有这条
      if (rb === undefined) { // 对端新增
        chosen = rt;
      } else if (ht === hb) { // 对端没改过 -> 认本机删除
        chosen = null;
      } else { // 对端改过、本机删了 -> 保留对端改动
        chosen = rt;
        conflicts.push({ coll: tag, id: k, reason: 'deleted-on-local' });
      }
    } else {
      chosen = null;
    }

    if (chosen !== null) out.push(chosen);
  }
  return order(out, rowsT, key);
}

function mergeRec(base, mine, theirs, conflicts) {
  const b = (base || {}).rec || {};
  const m = (mine || {}).rec || {};
  const t = (theirs || {}).rec || {};
  const ub = (base || {})._recU || {};
  const um_ = (mine || {})._recU || {};
  const ut_ = (theirs || {})._recU || {};

  const merged = {};
  const recU = {};
  const dids = new Set([...Object.keys(b), ...Object.keys(m), ...Object.keys(t)]);
  for (const did of dids) {
    const rb = b[did];
    const rm = m[did];
    const rt = t[did];
    const hb = rb != null ? recHash(rb) : null;
    const hm = rm != null ? recHash(rm) : null;
    const ht = rt != null ? recHash(rt) : null;
    let chosen;
    let tsVal;

    if (rm != null && rt != null) {
      if (hm === ht) {
        chosen = rm;
        tsVal = codePointCompare(um_[did] || '', ut_[did] || '') > 0 ? um_[did] : ut_[did];
      } else if (hm === hb) {
        chosen = rt;
        tsVal = ut_[did];
      } else if (ht === hb) {
        chosen = rm;
        tsVal = um_[did];
      } else {
        if (codePointCompare(um_[did] || '', ut_[did] || '') >= 0) {
          chosen = rm;
          tsVal = um_[did];
        } else {
          chosen = rt;
          tsVal = ut_[did];
        }
        if ((um_[did] || '') === (ut_[did] || '')) {
          conflicts.push({ coll: 'rec', id: did, reason: 'both-changed-same-time' });
        }
      }
    } else if (rm != null) {
      if (hm === hb) { chosen = null; tsVal = ''; }
      else { chosen = rm; tsVal = um_[did]; }
    } else if (rt != null) {
      if (ht === hb) { chosen = null; tsVal = ''; }
      else { chosen = rt; tsVal = ut_[did]; }
    } else {
      chosen = null;
      tsVal = '';
    }

    if (chosen != null) {
      merged[did] = chosen;
      if (tsVal) recU[did] = tsVal;
    }
  }
  return { merged, recU };
}

// suppliers(字符串并集) / platforms(按 name) 之类的小集合
function mergeSimple(base, mine, theirs, key, conflicts) {
  const b = base || [];
  const m = mine || [];
  const t = theirs || [];
  if (key === 'name') {
    const out = {};
    for (const r of [...b, ...m, ...t]) {
      if (isDict(r)) out[r.name || recHash(r)] = r;
    }
    return Object.values(out);
  }
  const seen = new Set();
  const out = [];
  for (const r of [...t, ...m, ...b]) {
    if (r === null || r === undefined) continue;
    const k = typeof r === 'string' ? r : recHash(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// 返回 [mergedDb, conflicts]
function merge(base, mine, theirs) {
  base = base || {};
  mine = mine || {};
  theirs = theirs || {};
  const conflicts = [];

  const out = {};
  Object.assign(out, theirs);

  for (const coll of Object.keys(COLL_KEY)) {
    out[coll] = mergeList(
      base[coll], mine[coll], theirs[coll], COLL_KEY[coll], coll, conflicts
    );
  }

  const rm = mergeRec(base, mine, theirs, conflicts);
  out.rec = rm.merged;
  if (Object.keys(rm.recU).length) out._recU = rm.recU;

  out.suppliers = mergeSimple(base.suppliers, mine.suppliers, theirs.suppliers, null, conflicts);
  out.platforms = mergeSimple(base.platforms, mine.platforms, theirs.platforms, 'name', conflicts);

  out.seq = Math.max(
    toInt(base.seq), toInt(mine.seq), toInt(theirs.seq)
  ) + 1;
  out.v = Math.max(toInt(base.v), toInt(mine.v), toInt(theirs.v));
  const rest = mine.rest || theirs.rest || base.rest;
  out.rest = rest === undefined ? null : rest;

  // 同步元信息：不参与业务（_recU 已单独处理）
  if ('_meta' in mine || '_meta' in theirs) {
    out._meta = Object.assign({}, theirs._meta || {});
    Object.assign(out._meta, mine._meta || {});
  }

  return [out, conflicts];
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

module.exports = {
  COLL_KEY,
  recHash,
  mergeList,
  mergeRec,
  mergeSimple,
  merge,
  // 供测试/去重使用的 Python json 兼容实现
  pyDumps,
};
