'use strict';
/*
 * lib/algorithms/inventory.js — 进销存算法（迁移自 store-inventory/queue_consumer.py）
 *
 * 覆盖动作：
 *   restock.create / analysis.restock → applyRestock
 *   config.update                     → applyConfig
 *   ing.upsert                        → applyIngUpsert
 *   quote.upsert                      → applyQuoteUpsert
 *   loss.report                       → applyLossReport
 *   recv.inbound                      → applyRecvInbound
 *   recv.accept                       → insertRecvAccept
 *   stock.count                       → applyStockCount + insertStockCount
 *   order.mark                        → applyOrderMark
 *   vendor.upsert                     → upsertVendor
 *   supply.po                         → insertSupplyPo（同时 applyRestock）
 *
 * 约定：纯函数优先，直接原地修改 data（与 Python 版一致）；写库统一走 ctx.store。
 * ctx.store 不存在时跳过写库，仅改 data，并在返回值里注明「未写库」。
 */

const crypto = require('crypto');
const { today, nowIso, num, r3, arr } = require('./util');
const { rebuildStock } = require('./stock');

/* ---------- 通用辅助 ---------- */

/** Python 版 _r3：round(float(x or 0) + 1e-12, 3)，与 util.r3 略有差异，需保真 */
function r3e(x) {
  return Math.round((num(x, 0) + 1e-12) * 1000) / 1000;
}

/** 生成唯一 id：前缀 + hex[:n]（对齐 Python uuid.uuid4().hex[:n]） */
function uid(prefix, n) {
  return prefix + crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

/** Python 浮点转字符串（对齐 "%s" % float：整数浮点保留 .0） */
function pf(x) {
  if (typeof x !== 'number' || !isFinite(x)) return String(x);
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

/** 对齐 Python dict.get 缺键取 None：undefined → null（避免 JSON 丢键） */
function pt(v) {
  return v === undefined ? null : v;
}

/** 解析菜谱常传的 '500g'/'1.9L'，返回 [数值, 单位] */
function parseLineQty(raw) {
  if (typeof raw === 'number' && isFinite(raw)) return [Number(raw), ''];
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return [0.0, ''];
  let m = s.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z\u4e00-\u9fff%]*)$/);
  if (m) return [parseFloat(m[1]), (m[2] || '').trim()];
  const m2 = s.match(/(\d+(?:\.\d+)?)/);
  if (m2) return [parseFloat(m2[1]), ''];
  return [0.0, ''];
}

/** float(x) 语义：成功返回 number，失败抛错（对齐 Python float()） */
function toFloat(v) {
  if (typeof v === 'number') {
    if (isFinite(v)) return v;
    throw new Error('invalid float');
  }
  const s = String(v).trim();
  if (s === '') throw new Error('invalid float');
  const n = Number(s);
  if (Number.isNaN(n)) throw new Error('invalid float');
  return n;
}

/**
 * 从 payload 解析原料 id（对齐 Python resolve_ing_id：精确 → 别名 → 双向包含）。
 * 注意：与 stock.js 的 resolveIng 不同，此处包含 ing/gid 与 config.ing_alias。
 */
function resolveIngId(data, payload) {
  const raw = (payload && (payload.ing_id != null ? payload.ing_id
    : (payload.ing != null ? payload.ing : payload.gid)));
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    return String(raw).trim();
  }
  const name = String((payload && (payload.name || payload.ing_name)) || '').trim();
  if (!name) return null;
  const ings = arr(data && data.ings);
  for (const g of ings) {
    if (String((g && g.name) || '').trim() === name) return String(g.id);
  }
  const alias = ((data && data.config) || {}).ing_alias || {};
  const stripped = name.replace(/[（(][^）)]*[）)]/g, '').trim();
  for (const key of [name, stripped]) {
    const tgt = alias[key];
    if (!tgt) continue;
    for (const g of ings) {
      if (String((g && g.name) || '').trim() === String(tgt).trim()) return String(g.id);
    }
  }
  for (const g of ings) {
    const n = String((g && g.name) || '');
    if (n.indexOf(name) >= 0 || name.indexOf(n) >= 0) return String(g.id);
  }
  return null;
}

/** 写库统一入口：无 ctx.store 则跳过（返回 false） */
function storeInsert(ctx, table, row) {
  if (ctx && ctx.store && typeof ctx.store.insert === 'function') {
    ctx.store.insert(table, row);
    return true;
  }
  return false;
}

function storeUpsert(ctx, table, row) {
  if (ctx && ctx.store && typeof ctx.store.upsert === 'function') {
    ctx.store.upsert(table, row);
    return true;
  }
  return false;
}

/* ---------- restock.create / analysis.restock ---------- */

/**
 * 向 data.orders 追加草稿采购单（PO）。不入库、不改 stock。
 * 对齐店内红线：plans/建议 → orders(采购) → recv(进货入库)。
 */
function applyRestock(data, payload) {
  if (!Array.isArray(data.orders)) {
    if (data.orders === undefined || data.orders === null) data.orders = [];
    else throw new Error('data.orders 不是数组，拒绝写入');
  }
  const orders = data.orders;
  const date = payload.date || today();
  const items = payload.items || [];
  const lines = [];
  for (const it of items) {
    const [qty, unitFromQty] = parseLineQty(it.qty);
    const unit = String(it.unit || unitFromQty || '').trim();
    let price = 0.0;
    try {
      price = it.price ? toFloat(it.price) : 0.0;
    } catch (e) {
      price = 0.0;
    }
    lines.push({
      ing: it.ing_id || it.ing || it.name,
      name: pt(it.name || it.ing_id),
      qty: qty,
      unit: unit,
      price: price,
      conv: 1,
      amount: Math.round(qty * price * 100) / 100,
      unitCost: price
    });
  }
  if (!lines.length) throw new Error('restock.create 无有效明细行');
  const payable = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const sameDay = orders.filter((p) => p && p.date === date).length;
  const draft = {
    id: uid('O', 10),
    no: 'CG' + String(date).replace(/-/g, '') + '-' + String(sameDay + 1).padStart(2, '0'),
    date: date,
    supplier: payload.supplier || '未指定供应商',
    lines: lines,
    payable: payable,
    payments: [],
    note: '【草稿·云端补货·待下单】' + (payload.note || '自动生成≠自动下单，确认后仍为采购草稿'),
    method: '现金/转账',
    status: '草稿',
    sku_id: pt(payload.sku_id),
    from_recipe_qty: pt(payload.qty)
  };
  orders.push(draft);
  return 'orders 追加采购草稿 ' + draft.no + '（' + lines.length + ' 行，应付 ' + payable.toFixed(2) + '）';
}

/* ---------- config.update ---------- */

/**
 * config.update：深合并写入 data.config（嵌套 dict 不整键覆盖）。
 */
function applyConfig(data, payload) {
  if (data.config === undefined || data.config === null) data.config = {};
  if (!(data.config && typeof data.config === 'object' && !Array.isArray(data.config))) {
    throw new Error('data.config 已存在且不是对象，拒绝覆盖');
  }
  const cfg = data.config;
  const updates = payload.config || payload.values || payload;
  if (!(updates && typeof updates === 'object' && !Array.isArray(updates)) || !Object.keys(updates).length) {
    throw new Error('config.update 的 payload 必须是非空对象（可嵌于 config/values 键）');
  }
  const skip = ['config', 'values', 'type', 'base_rev', 'operator'];
  const clean = {};
  for (const k of Object.keys(updates)) if (skip.indexOf(k) < 0) clean[k] = updates[k];
  if (!Object.keys(clean).length) throw new Error('config.update 无有效配置键');
  data.config = deepMergeLocal(cfg, clean);
  return 'config 深合并 ' + Object.keys(clean).length + ' 项: ' + Object.keys(clean).join(',');
}

/** 一层嵌套合并（对齐 Python _deep_merge）：src dict 与 dst 同键 dict 合并，其它覆盖 */
function deepMergeLocal(dst, src) {
  if (!(dst && typeof dst === 'object' && !Array.isArray(dst))
    || !(src && typeof src === 'object' && !Array.isArray(src))) {
    return src;
  }
  const out = Object.assign({}, dst);
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v)
      && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMergeLocal(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/* ---------- ing.upsert ---------- */

/**
 * ing.upsert：原料产品库（包规/采购单位/供应商/安全线）。
 */
function applyIngUpsert(data, payload) {
  if (data.ings === undefined || data.ings === null) data.ings = [];
  if (!Array.isArray(data.ings)) throw new Error('data.ings 不是数组');
  const ings = data.ings;
  const name = String(payload.name || '').trim();
  const iid = String(payload.id || payload.ing_id || '').trim();
  if (!iid && !name) throw new Error('缺少 id 或 name');
  const now = nowIso();

  const patch = (ing) => {
    if (payload.name != null) ing.name = String(payload.name).trim();
    const pairs = [
      ['cat', 'cat'], ['unit', 'unit'], ['buy', 'buy'], ['spec', 'spec'],
      ['pack', 'pack'], ['moq', 'moq'], ['sup', 'sup'], ['supplier', 'sup']
    ];
    for (const [ks, kd] of pairs) if (payload[ks] != null) ing[kd] = payload[ks];
    if (payload.conv != null) ing.conv = toFloat(payload.conv || 1);
    if (payload.safe != null) {
      ing.safe = toFloat(payload.safe);
      ing.safety = toFloat(payload.safe);
    }
    if (payload.est != null) ing.est = toFloat(payload.est);
    if (payload.qty != null) {
      const q = toFloat(payload.qty);
      ing.qty = q;
      ing.stock = q;
    }
    if (payload.stock != null && payload.qty == null) {
      const q = toFloat(payload.stock);
      ing.stock = q;
      ing.qty = q;
    }
    if (payload.avg != null) ing.avg = toFloat(payload.avg);
    if (payload.on != null) ing.on = (payload.on === true || payload.on === 1 || payload.on === '1' || payload.on === 'true');
    if (!ing.pack && ing.buy) ing.pack = ing.buy;
    ing._u = now;
  };

  for (const ing of ings) {
    if ((iid && String(ing.id) === iid) || (!iid && name && String(ing.name) === name)) {
      patch(ing);
      return 'ing 更新 ' + ing.id + ' ' + ing.name;
    }
  }
  const nums = [];
  for (const ing of ings) {
    const m = String(ing.id || '');
    if (m[0] === 'I' && /^\d+$/.test(m.slice(1))) nums.push(parseInt(m.slice(1), 10));
  }
  const newId = iid || ('I' + (nums.length ? Math.max(...nums) + 1 : 800));
  const row = {
    id: newId,
    name: name || newId,
    cat: payload.cat || '原料',
    unit: payload.unit || '斤',
    buy: payload.buy || payload.pack || payload.unit || '斤',
    pack: payload.pack || payload.buy || payload.unit || '斤',
    conv: toFloat(payload.conv || 1),
    spec: payload.spec || '',
    moq: payload.moq || '',
    sup: payload.sup || payload.supplier || '',
    qty: toFloat(payload.qty != null ? payload.qty : (payload.stock || 0)),
    stock: toFloat(payload.stock != null ? payload.stock : (payload.qty || 0)),
    safe: toFloat(payload.safe || 0),
    safety: toFloat(payload.safe || 0),
    est: toFloat(payload.est || 0),
    avg: toFloat(payload.avg || 0),
    on: true,
    _u: now
  };
  ings.push(row);
  return 'ing 新建 ' + newId + ' ' + row.name;
}

/* ---------- quote.upsert ---------- */

/**
 * quote.upsert：供应商报价（按 ing+src 幂等覆盖）。
 */
function applyQuoteUpsert(data, payload) {
  if (data.quotes === undefined || data.quotes === null) data.quotes = [];
  if (!Array.isArray(data.quotes)) throw new Error('data.quotes 不是数组');
  const quotes = data.quotes;
  const ing = String(payload.ing || payload.ing_id || '').trim();
  const src = String(payload.src || payload.supplier || '').trim();
  if (!ing || !src) throw new Error('缺少 ing / src');
  if (payload.price == null) throw new Error('缺少 price');
  const price = toFloat(payload.price);
  const now = nowIso();
  for (const q of quotes) {
    if (String(q.ing) === ing && String(q.src) === src) {
      q.price = price;
      q.per = payload.per || q.per || 'buy';
      q.date = payload.date || today();
      if (payload.note != null) q.note = payload.note;
      q._u = now;
      return 'quote 更新 ' + ing + '@' + src + ' → ¥' + pf(price);
    }
  }
  const nums = [];
  for (const q of quotes) {
    const m = String(q.id || '');
    if (m[0] === 'Q' && /^\d+$/.test(m.slice(1))) nums.push(parseInt(m.slice(1), 10));
  }
  const qid = payload.id || ('Q' + (nums.length ? Math.max(...nums) + 1 : 200));
  quotes.push({
    id: qid,
    ing: ing,
    name: payload.name || ing,
    src: src,
    supplier: src,
    price: price,
    per: payload.per || 'buy',
    unit: payload.unit || '',
    date: payload.date || today(),
    note: payload.note || '',
    _u: now
  });
  if (payload.set_default_sup) {
    for (const i of arr(data.ings)) {
      if (String(i.id) === ing) {
        i.sup = src;
        break;
      }
    }
  }
  return 'quote 新建 ' + qid + ' ' + ing + '@' + src + ' ¥' + pf(price);
}

/* ---------- loss.report ---------- */

/**
 * loss.report：写可重放「盘点调整」负向流水 + 旁路 logs，再 rebuild 扣库存。
 */
function applyLossReport(data, payload, ctx) {
  if (data.logs === undefined || data.logs === null) data.logs = [];
  if (!Array.isArray(data.logs)) throw new Error('data.logs 不是数组');
  const logs = data.logs;
  let qty = 0.0;
  try {
    // 对齐 Python float(payload.get("qty") or 0)：0/''/None 都当 0
    qty = toFloat(payload.qty || 0);
  } catch (e) {
    qty = 0.0;
  }
  if (qty === 0) throw new Error('loss.report 数量不能为 0');
  const gid = resolveIngId(data, payload);
  const name = payload.name || payload.ing_name || '未命名损耗';

  // 待审批模式：仅登记报损单，不动账面；由 loss.approve 审批后再扣库存
  if (payload.pending === true) {
    let dbNote0 = '';
    if (storeInsert(ctx, 'loss_reports', {
      date: payload.date || today(),
      ing_name: payload.ing_name || payload.name || '',
      qty: payload.qty,
      reason: payload.reason || '',
      reporter: payload.reporter || 'QUEUE',
      status: '待审核',
      source: 'queue'
    })) dbNote0 = ' + loss_reports写入';
    return '报损登记待审批 ' + name + ' × ' + pf(qty) + dbNote0;
  }

  logs.push({
    id: uid('L', 8),
    kind: 'loss',
    name: name,
    qty: qty,
    amount: pt(payload.amount),
    reason: payload.reason || '',
    ts: payload.ts || nowIso(),
    source: 'queue',
    ing: gid
  });

  // loss_reports 旁路写库（有 ctx.store 才写）
  let dbNote = '';
  if (storeInsert(ctx, 'loss_reports', {
    date: payload.date || today(),
    ing_name: payload.ing_name || payload.name || '',
    qty: payload.qty,
    reason: payload.reason || '',
    reporter: payload.reporter || 'QUEUE',
    status: payload.status || '待审核',
    source: 'queue'
  })) dbNote = ' + loss_reports写入';

  if (gid) {
    logs.push({
      type: '盘点调整',
      ing: gid,
      date: payload.date || today(),
      qty: -Math.abs(qty),
      ref: '报损·' + (payload.reason || name),
      source: 'queue'
    });
    const rb = rebuildStock(data);
    return '报损扣库存 ' + name + ' × ' + pf(qty) + '（' + rb + '）' + dbNote;
  }
  return 'logs 追加损耗 ' + name + '（未匹配原料 id，库存未扣）' + dbNote;
}

/* ---------- recv.inbound ---------- */

/**
 * recv.inbound：确认入库，并 rebuild_stock 让 ings.stock/qty 立刻变化。
 */
function applyRecvInbound(data, payload) {
  if (data.recv === undefined || data.recv === null) data.recv = [];
  if (!Array.isArray(data.recv)) throw new Error('data.recv 不是数组');
  const recv = data.recv;
  const rid = payload.id || payload.recv_id;
  const oid = payload.order_id || payload.po_id;
  const items = payload.items || [];
  if (!rid && !oid && (!items || !items.length)) {
    // Kimi 拍照验货：无进货单/明细时仅审计登记，绝不空改账面
    if (payload.kimi_draft || String(payload.source || '').indexOf('kimi') === 0) {
      if (data.logs === undefined || data.logs === null) data.logs = [];
      const logs = data.logs;
      const note = String(payload.note || '').slice(0, 200);
      if (Array.isArray(logs)) {
        logs.push({
          id: uid('KR', 8),
          kind: 'kimi_recv_audit',
          supplier: payload.supplier || 'Kimi验货',
          status: payload.status || '待核对',
          note: note,
          date: payload.date || today(),
          ts: payload.ts || nowIso(),
          source: 'kimi'
        });
      }
      return 'recv.inbound kimi 审计登记（未改账面）· ' + (note || '验货结论');
    }
    throw new Error('recv.inbound 需提供 id / order_id / items 之一（空入库已拒绝）');
  }

  let msg = null;
  if (rid) {
    let found = false;
    for (const r of recv) {
      if (String(r.id || r.no) === String(rid)) {
        r.status = payload.status || '已入库';
        r.note = (r.note || '') + ' 【云端确认入库】';
        found = true;
        msg = 'recv ' + rid + ' → 已入库';
        break;
      }
    }
    if (!found) throw new Error('找不到进货单 ' + rid);
  } else if (oid) {
    if (data.orders === undefined || data.orders === null) data.orders = [];
    if (!Array.isArray(data.orders)) throw new Error('data.orders 不是数组');
    const orders = data.orders;
    let src = null;
    for (const o of orders) {
      if (String(o.id || o.no) === String(oid)) {
        src = o;
        break;
      }
    }
    if (!src) throw new Error('找不到采购单 ' + oid);
    const lines = (src.lines || []).slice();
    if (!lines.length) throw new Error('采购单 ' + oid + ' 无明细行，拒绝空入库');
    const date = payload.date || src.date || today();
    const sameDay = recv.filter((p) => p && p.date === date).length;
    const inbound = {
      id: uid('R', 10),
      no: 'JH' + String(date).replace(/-/g, '') + '-' + String(sameDay + 1).padStart(2, '0'),
      date: date,
      supplier: src.supplier || payload.supplier || '未指定供应商',
      lines: lines,
      payable: src.payable || 0,
      payments: (src.payments || []).slice(),
      note: '【云端入库·自采购 ' + (src.no || oid) + '】',
      method: src.method || '现金/转账',
      status: '已入库',
      from_order: src.id || oid
    };
    recv.push(inbound);
    src.status = '已转进货';
    src.note = (src.note || '') + ' → ' + inbound.no;
    msg = 'orders ' + oid + ' → recv ' + inbound.no + ' 已入库';
  } else {
    const date = payload.date || today();
    const lines = [];
    for (const it of items) {
      const qty = toFloat(it.qty || 0);
      const price = toFloat(it.price || 0);
      if (qty === 0) continue;
      lines.push({
        ing: it.ing_id || it.ing,
        name: pt(it.name),
        qty: qty,
        price: price,
        conv: 1,
        amount: Math.round(qty * price * 100) / 100,
        unitCost: price
      });
    }
    if (!lines.length) throw new Error('recv.inbound items 无有效数量行');
    const payable = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    const sameDay = recv.filter((p) => p && p.date === date).length;
    const inbound = {
      id: uid('R', 10),
      no: 'JH' + String(date).replace(/-/g, '') + '-' + String(sameDay + 1).padStart(2, '0'),
      date: date,
      supplier: payload.supplier || '未指定供应商',
      lines: lines,
      payable: payable,
      payments: [],
      note: '【云端入库】' + (payload.note || ''),
      method: '现金/转账',
      status: '已入库'
    };
    recv.push(inbound);
    msg = 'recv 追加入库 ' + inbound.no + '（' + lines.length + ' 行）';
  }

  const rb = rebuildStock(data);
  return msg + '；' + rb;
}

/* ---------- recv.accept ---------- */

/**
 * recv.accept：逐项验收结论写入 recv_accept 表。
 * 迁移为纯算法 + ctx.store.insert；无 ctx.store 时仅汇总行数。
 */
function insertRecvAccept(ctx, payload) {
  let items = payload.items || payload.lines;
  if (!Array.isArray(items) || !items.length) {
    if (payload.ing_name || payload.name) items = [payload];
    else throw new Error('recv.accept 需提供 items[] 或 ing_name');
  }
  const recvId = payload.recv_id || payload.order_id || payload.id;
  const source = payload.source || 'manual';
  const ts = payload.ts || nowIso();
  let n = 0;
  for (const it of items) {
    if (!it) continue;
    const name = it.ing_name || it.name || it.ing;
    if (!name) continue;
    let detail = it.detail;
    if (detail !== undefined && detail !== null && typeof detail !== 'string') detail = JSON.stringify(detail);
    storeInsert(ctx, 'recv_accept', {
      recv_id: recvId != null ? String(recvId) : null,
      ing_name: String(name),
      qty_ordered: it.qty_ordered,
      qty_received: it.qty_received != null ? it.qty_received : it.qty,
      qty_rejected: it.qty_rejected != null ? it.qty_rejected : 0,
      verdict: it.verdict || it.result || 'pass',
      detail: detail,
      batch_no: it.batch_no || it.batch,
      cert_no: it.cert_no || it.cert,
      ts: it.ts || ts,
      source: it.source || source
    });
    n += 1;
  }
  if (n === 0) throw new Error('recv.accept 无有效验收行');
  return 'recv_accept 写入 ' + n + ' 行 · recv_id=' + (recvId || '-');
}

/* ---------- stock.count ---------- */

/**
 * stock.count：记差异 + 写盘点调整流水并 rebuild_stock（真改账面）。
 * 与 Python 版不同：写库走 ctx.store，无则跳过。
 */
function applyStockCount(data, payload, ctx) {
  const name = payload.name || payload.ing_name || '原料';
  const gid = resolveIngId(data, payload);
  let book = payload.book_qty;
  if (book === undefined || book === null) book = payload.book;
  let real = payload.real_qty;
  if (real === undefined || real === null) real = payload.real;
  let bookF = null;
  try {
    bookF = book !== undefined && book !== null ? toFloat(book) : null;
  } catch (e) {
    bookF = null;
  }
  let realF = null;
  try {
    realF = real !== undefined && real !== null ? toFloat(real) : null;
  } catch (e) {
    realF = null;
  }

  // 旁路差异表（审计）
  insertStockCount(ctx, payload);

  if (gid === null) {
    return 'stock.count ' + name + '（未匹配原料，仅记差异表）';
  }
  if (realF === null) {
    const note = String(payload.note || '').slice(0, 120);
    return 'stock.count ' + name + '（仅审计登记，未改账面）· ' + (note || '缺实盘数');
  }

  // 账面：优先用传入 book，否则读当前 stock
  if (bookF === null) {
    for (const g of arr(data.ings)) {
      if (String(g.id) === String(gid)) {
        bookF = toFloat(g.qty != null ? g.qty : (g.stock || 0));
        break;
      }
    }
    if (bookF === null) bookF = 0.0;
  }
  const delta = r3e(realF - bookF);
  if (data.logs === undefined || data.logs === null) data.logs = [];
  if (!Array.isArray(data.logs)) throw new Error('data.logs 不是数组');
  const logs = data.logs;
  // 用「手工调整」按实盘绝对值落账：rebuild 从零重放时，盘点差异 Δ 会在无期初/入库基线时变成错误账面
  logs.push({
    type: '手工调整',
    ing: gid,
    date: payload.date || today(),
    qty: realF,
    ref: '盘点·' + name,
    note: payload.note || ('账面 ' + bookF + ' → 实盘 ' + realF + '（Δ' + delta + '）'),
    source: 'queue',
    inCost: 0
  });
  // 同步改 ings 即时字段，避免等 rebuild 前快照仍显示旧数
  for (const g of arr(data.ings)) {
    if (String(g.id) === String(gid)) {
      g.qty = realF;
      g.stock = realF;
      break;
    }
  }
  const rb = rebuildStock(data);
  return 'stock.count ' + name + ' 账面' + pf(bookF) + '→实盘' + pf(realF) + ' Δ' + pf(delta) + '；' + rb;
}

/**
 * 盘点差异写库（对齐 Python insert_stock_count）。
 * Python 里先写 loss_inventory_diff，表不存在则回落 loss_reports；
 * 此处抽象为 ctx.store.insert('loss_inventory_diff', ...)（表回落交由 store 层处理）。
 */
function insertStockCount(ctx, payload) {
  const name = payload.name || payload.ing_name || '原料';
  const wrote = storeInsert(ctx, 'loss_inventory_diff', {
    name: name,
    book_qty: payload.book_qty || payload.book,
    real_qty: payload.real_qty || payload.real,
    note: payload.note || 'App 盘点'
  });
  if (!wrote) {
    storeInsert(ctx, 'loss_reports', {
      date: today(),
      ing_name: name,
      qty: payload.qty || 0,
      reason: '盘点差异',
      status: '已登记'
    });
  }
  return 'stock.count ' + name;
}

/* ---------- order.mark ---------- */

/**
 * order.mark：采购单状态迁移（草稿→已发/已下单，不入库）。
 */
function applyOrderMark(data, payload) {
  if (data.orders === undefined || data.orders === null) data.orders = [];
  if (!Array.isArray(data.orders)) throw new Error('data.orders 不是数组');
  const orders = data.orders;
  const oid = String(payload.order_id || payload.id || payload.no || '').trim();
  if (!oid) throw new Error('order.mark 缺 order_id');
  let status = String(payload.status || '已发').trim() || '已发';
  if (['已下单', '已订', 'shipped', 'ordered'].indexOf(status) >= 0) status = '已发';
  for (const o of orders) {
    if (String(o.id || '') === oid || String(o.no || '') === oid) {
      const old = o.status;
      if (['已转进货', '已入库', 'done'].indexOf(old) >= 0) {
        throw new Error('采购单 ' + oid + ' 已入库，不能再改状态');
      }
      o.status = status;
      const note = payload.note;
      if (note) o.note = (o.note || '') + ' 【' + note + '】';
      else o.note = (o.note || '') + ' 【确认下单·待到货】';
      if (payload.supplier) o.supplier = payload.supplier;
      o._u = nowIso();
      return 'orders ' + (o.no || oid) + ' ' + old + ' → ' + status;
    }
  }
  throw new Error('找不到采购单 ' + oid);
}

/* ---------- vendor.upsert ---------- */

/**
 * vendor.upsert：供应商档案 → SQLite sup_vendors（走 ctx.store）+ data.vendors/suppliers。
 */
function upsertVendor(data, payload, ctx) {
  let name = String(payload.name || '').trim();
  let vid = String(payload.vendor_id || payload.id || '').trim();
  if (!name && !vid) throw new Error('vendor.upsert 缺 name/vendor_id');
  if (!name) name = vid;
  if (!vid) vid = uid('V', 8).toUpperCase();

  const contact = payload.contact;
  const phone = payload.phone;
  const category = payload.category || payload.cat;
  const level = payload.level || payload.rating;
  const status = payload.status || '合作中';
  const period = payload.period || payload.settle || '月结30天';
  const note = payload.note || '';
  const now = nowIso();

  let action = '新建';
  if (ctx && ctx.store && typeof ctx.store.upsert === 'function') {
    // 由 store 层按 vendor_id/name 幂等 upsert；返回值可携带命中信息
    const r = ctx.store.upsert('sup_vendors', {
      vendor_id: vid, name: name, contact: contact, phone: phone,
      category: category, level: level != null ? String(level) : null,
      status: status, period: period, note: note, updated_at: now
    });
    if (r && r.matched) {
      vid = r.vendor_id || vid;
      action = '更新';
    }
  }

  const row = {
    id: vid,
    vendor_id: vid,
    name: name,
    contact: contact,
    phone: phone,
    category: category,
    level: level,
    status: status,
    period: period,
    note: note,
    _u: now
  };
  try {
    if (level != null && /^\d+(\.\d+)?$/.test(String(level).replace('.', ''))) {
      row.rating = toFloat(level);
    }
  } catch (e) { /* ignore */ }

  let vendors = data.vendors;
  if (!Array.isArray(vendors)) {
    vendors = [];
    data.vendors = vendors;
  }
  let hit = false;
  for (let i = 0; i < vendors.length; i++) {
    const v = vendors[i];
    if (!(v && typeof v === 'object' && !Array.isArray(v))) continue;
    if (String(v.id || v.vendor_id || '') === vid || String(v.name || '') === name) {
      const merged = Object.assign({}, v);
      for (const [k, val] of Object.entries(row)) if (val !== null) merged[k] = val;
      vendors[i] = merged;
      hit = true;
      break;
    }
  }
  if (!hit) vendors.push(row);

  const names = [];
  for (const v of vendors) {
    if (v && typeof v === 'object' && !Array.isArray(v) && v.name) names.push(String(v.name));
    else if (typeof v === 'string' && v.trim()) names.push(v.trim());
  }
  for (const s of arr(data.suppliers)) {
    if (typeof s === 'string' && s.trim() && names.indexOf(s.trim()) < 0) names.push(s.trim());
  }
  if (names.indexOf(name) < 0) names.push(name);
  data.suppliers = names;

  return 'vendor ' + action + ' ' + vid + ' ' + name;
}

/* ---------- supply.po ---------- */

/**
 * supply.po：同时追加草稿采购（applyRestock）+ 供应商往来账登记一笔应付。
 */
function insertSupplyPo(ctx, payload) {
  const wrote = storeInsert(ctx, 'sup_accounts', {
    vendor_id: payload.vendor_id || payload.supplier || '',
    kind: '应付',
    amount: payload.amount || payload.payable,
    ts: payload.ts || nowIso(),
    ref_no: payload.ref_no || payload.po_no || uid('PO', 8)
  });
  return wrote ? 'sup_accounts写入' : 'sup_accounts未写库';
}

/** 报损单定位：兼容 sqlite(get/query) 与 ext.loss_reports */
function findLossReport(ctx, id) {
  if (ctx && ctx.store) {
    if (typeof ctx.store.get === 'function') {
      try { const r = ctx.store.get('loss_reports', id); if (r) return r; } catch (e) { /* ignore */ }
    }
    if (ctx.store.ext && Array.isArray(ctx.store.ext.loss_reports)) {
      const r = ctx.store.ext.loss_reports.find((x) => String((x && x.id)) === String(id));
      if (r) return r;
    }
    if (typeof ctx.store.query === 'function') {
      try {
        const rows = ctx.store.query(
          'SELECT id, ing_name, qty, amount, reason, status, date FROM loss_reports WHERE id = ?', [id]
        );
        if (Array.isArray(rows) && rows.length) return rows[0];
      } catch (e) { /* ignore */ }
    }
  }
  return null;
}

/**
 * loss.approve —— 报损审批：状态 待审核→已审批，并扣库存（盘点调整 + rebuildStock）。
 * 幂等：已审批直接跳过；已驳回拒绝审批。
 */
function approveLossReport(ctx, data, payload) {
  const id = payload.id;
  if (id === null || id === undefined || String(id).trim() === '') throw new Error('loss.approve 缺 id');
  const row = findLossReport(ctx, id);
  if (!row) throw new Error('报损单不存在: ' + id);
  const st = String(row.status || '待审核');
  if (/已审批|已通过/.test(st)) return 'loss_reports#' + id + ' 已审批（跳过）';
  if (/驳回|作废/.test(st)) throw new Error('报损单已驳回，不能审批: ' + id);

  let qty = 0;
  try { qty = Math.abs(toFloat(row.qty || 0)); } catch (e) { qty = 0; }
  if (qty === 0) throw new Error('报损数量为 0，不能审批');

  if (data.logs === undefined || data.logs === null) data.logs = [];
  const gid = resolveIngId(data, { name: row.ing_name, ing: row.ing });
  data.logs.push({
    id: uid('L', 8), kind: 'loss', name: row.ing_name || '报损', qty: qty,
    amount: pt(row.amount), reason: row.reason || '', ts: nowIso(), source: 'approve', ing: gid
  });
  let rbNote = '';
  if (gid) {
    data.logs.push({
      type: '盘点调整', ing: gid, date: row.date || today(), qty: -qty,
      ref: '报损审批·' + (row.reason || row.ing_name || ''), source: 'approve'
    });
    rbNote = rebuildStock(data);
  }
  if (ctx && ctx.store && typeof ctx.store.update === 'function') {
    ctx.store.update('loss_reports', { status: '已审批' }, { id: id });
  }
  return '报损审批扣库存 ' + (row.ing_name || '') + ' × ' + qty
    + (gid ? ('（' + rbNote + '）') : '（未匹配原料，库存未扣）');
}

/** loss.reject —— 报损驳回：状态 → 已驳回，不扣库存 */
function rejectLossReport(ctx, data, payload) {
  const id = payload.id;
  if (id === null || id === undefined || String(id).trim() === '') throw new Error('loss.reject 缺 id');
  const row = findLossReport(ctx, id);
  if (row && /已审批|已通过/.test(String(row.status || ''))) throw new Error('已审批单据不能驳回: ' + id);
  if (ctx && ctx.store && typeof ctx.store.update === 'function') {
    ctx.store.update('loss_reports', { status: '已驳回', reason: payload.reason || (row && row.reason) || '' }, { id: id });
  }
  return 'loss_reports#' + id + ' → 已驳回';
}

module.exports = {
  parseLineQty,
  resolveIngId,
  applyRestock,
  applyConfig,
  applyIngUpsert,
  applyQuoteUpsert,
  applyLossReport,
  approveLossReport,
  rejectLossReport,
  applyRecvInbound,
  insertRecvAccept,
  applyStockCount,
  insertStockCount,
  applyOrderMark,
  upsertVendor,
  insertSupplyPo
};
