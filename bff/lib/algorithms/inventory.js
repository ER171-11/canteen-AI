'use strict';
/*
 * lib/algorithms/inventory.js — 进销存算法（迁移自 store-inventory/queue_consumer.py）
 *
 * 覆盖动作：
 *   restock.create / analysis.restock → applyRestock
 *   order.fromRestock                 → applyRestockToOrders（勾选建议行按供应商拆单生成正式 CG 单）
 *   config.update                     → applyConfig
 *   rest.update                       → applyRest（写顶层 data.rest 餐厅名）
 *   ing.upsert                        → applyIngUpsert
 *   quote.upsert                      → applyQuoteUpsert
 *   loss.report                       → applyLossReport
 *   recv.inbound                      → applyRecvInbound（含 Node 超集：paid / method / po / line.recvQty）
 *   recv.accept                       → insertRecvAccept
 *   recv.pay                          → applyRecvPay（补付 / 欠款清收）
 *   recv.import                       → applyRecvImport（批量导入，批末统一 rebuildStock 一次）
 *   stock.count                       → applyStockCount + insertStockCount
 *   order.mark                        → applyOrderMark
 *   vendor.upsert                     → upsertVendor
 *   supply.po                         → insertSupplyPo（同时 applyRestock）
 *
 * 约定：纯函数优先，直接原地修改 data（与 Python 版一致）；写库统一走 ctx.store。
 * ctx.store 不存在时跳过写库，仅改 data，并在返回值里注明「未写库」。
 */

const crypto = require('crypto');
const { today, nowIso, num, r2, r3, arr } = require('./util');
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

/** 出成率钳制：0.05 ~ 1.00（对齐旧版 fYld 输入 min 0.05 max 1，存储为分数） */
function clampYld(n) {
  return Math.min(1, Math.max(0.05, n));
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

/** 下一个原料 id：现有最大 I 数字 + 1，无则从 800 起（与 applyIngUpsert 同口径） */
function nextIngId(ings) {
  const nums = [];
  for (const ing of arr(ings)) {
    const m = String((ing && ing.id) || '');
    if (m[0] === 'I' && /^\d+$/.test(m.slice(1))) nums.push(parseInt(m.slice(1), 10));
  }
  return 'I' + (nums.length ? Math.max(...nums) + 1 : 800);
}

/**
 * 进货批量导入：未匹配原料自动建档（忠实回归旧版 createIngFromImport :2806）。
 *
 * 旧版建料口径：cat 兜底「其他」、unit 兜底「斤」、buy=unit、conv=1、stock/avg=0
 * （入库后由 rebuildStock 依采购价生成均价）。
 *
 * 【Node 超集】`pending:true` —— 标为「待完善草稿」：门店记账不被阻断，但主数据信息
 * （分类/库存单位/采购单位/包规…）算「未确认」，需人工到「原料档案 → 待完善」补全并「确认转正」。
 * 2026-10-12 撤销「未匹配原料不代建」偏离后新增（旧版无此字段，recv.import 无 Python 对拍）。
 */
function createIngFromImport(ings, name, unit, cat) {
  const u = String(unit || '').trim() || '斤';
  const c = String(cat || '').trim() || '其他';
  const row = {
    id: nextIngId(ings),
    name: String(name || '').trim(),
    cat: c,
    unit: u,
    buy: u,
    pack: u,
    conv: 1,
    spec: '',
    moq: '',
    sup: '',
    qty: 0,
    stock: 0,
    safe: 0,
    safety: 0,
    est: 0,
    yld: 1,
    avg: 0,
    on: true,
    pending: true,
    _u: nowIso()
  };
  ings.push(row);
  return row;
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

/* ---------- order.fromRestock（FP-PO-18） ---------- */

/**
 * order.fromRestock：勾选补货建议行 → 按供应商拆单生成正式采购单（CG 单，status='normal'）。
 * 对齐旧版 restockToOrders()（HTML:1995-2022）：**只 push data.orders，绝不调 rebuildStock**（采购单不进库存）；
 * 新供应商并入 data.suppliers。单价/供应商/换算率优先取 payload 逐行，缺失时回落原料主数据（sup/avg/last/conv）。
 */
function applyRestockToOrders(data, payload) {
  const orders = _ordersArr(data);
  const ings = arr(data.ings);
  const ingById = new Map();
  for (const g of ings) if (g && g.id != null) ingById.set(String(g.id), g);

  const items = arr(payload.items);
  const date = payload.date || today();

  const rows = [];
  for (const it of items) {
    const id = String(it.ing_id || it.ing || it.name || '').trim();
    if (!id) continue;
    const g = ingById.get(id) || {};
    const qty = parseLineQty(it.qty)[0];
    if (!(qty > 0)) continue;
    const supplier = String(it.supplier || g.sup || '').trim() || '未指定供应商';
    let price = 0;
    if (it.price != null && it.price !== '' && num(it.price, 0) > 0) price = num(it.price, 0);
    else if (num(g.avg, 0) > 0) price = num(g.avg, 0);
    else if (num(g.last, 0) > 0) price = num(g.last, 0);
    const conv = num(g.conv, 0) > 0 ? num(g.conv, 0) : 1;
    rows.push({
      id: id,
      name: String(it.name || g.name || id).trim(),
      qty: qty,
      unit: pt(it.unit || g.unit || ''),
      price: r2(price),
      conv: conv,
      supplier: supplier
    });
  }
  if (!rows.length) throw new Error('order.fromRestock 无有效明细行（请勾选数量 > 0 的原料）');

  const bySup = new Map();
  for (const r of rows) {
    if (!bySup.has(r.supplier)) bySup.set(r.supplier, []);
    bySup.get(r.supplier).push(r);
  }

  const sameDay = orders.filter((o) => o && o.date === date).length;
  let i = 0;
  const created = [];
  for (const [supplier, rs] of bySup) {
    const lines = rs.map((r) => ({
      ing: r.id,
      name: r.name,
      qty: r.qty,
      unit: r.unit,
      price: r.price,
      conv: r.conv,
      amount: r2(r.qty * r.price),
      unitCost: r3(r.price / r.conv)
    }));
    const payable = r2(lines.reduce((s, l) => s + l.amount, 0));
    i += 1;
    const o = {
      id: uid('O', 10),
      no: 'CG' + String(date).replace(/-/g, '') + '-' + String(sameDay + i).padStart(2, '0'),
      date: date,
      supplier: supplier,
      lines: lines,
      payable: payable,
      payments: [],
      note: '由补货建议生成（采购单不入库，收货请到「进货入库」登记）',
      method: '',
      status: 'normal'
    };
    orders.push(o);
    created.push(o.no);
  }

  if (!Array.isArray(data.suppliers)) data.suppliers = [];
  for (const s of bySup.keys()) if (data.suppliers.indexOf(s) < 0) data.suppliers.push(s);

  return 'orders 按供应商拆单生成 ' + created.length + ' 张采购单（' + rows.length + ' 个品项）：' + created.join(', ');
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

/* ---------- rest.update ---------- */

/**
 * rest.update：写顶层 data.rest（餐厅名，字符串）。
 * 旧版 DB.rest 是顶层字符串字段（抬头/结算单回落名），config.update 只改 data.config，故单列动作。
 */
function applyRest(data, payload) {
  const raw = payload && payload.name != null ? payload.name : (payload && payload.rest);
  const name = String(raw == null ? '' : raw).trim();
  if (!name) throw new Error('rest.update 的 payload 必须提供非空 name');
  data.rest = name;
  return '餐厅名 → ' + name;
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
    if (payload.yld != null) ing.yld = clampYld(toFloat(payload.yld));
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
    /* 【Node 超集】待完善草稿标记：confirm:true / pending:false → 转正；pending:true → 标为待完善 */
    if (payload.confirm === true || payload.pending === false) {
      delete ing.pending;
    } else if (payload.pending === true) {
      ing.pending = true;
    }
    if (!ing.pack && ing.buy) ing.pack = ing.buy;
    ing._u = now;
  };

  for (const ing of ings) {
    if ((iid && String(ing.id) === iid) || (!iid && name && String(ing.name) === name)) {
      patch(ing);
      return 'ing 更新 ' + ing.id + ' ' + ing.name;
    }
  }
  const newId = iid || nextIngId(ings);
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
    yld: payload.yld != null ? clampYld(toFloat(payload.yld)) : 1,
    avg: toFloat(payload.avg || 0),
    on: true,
    _u: now
  };
  /* 【Node 超集】仅当调用方显式要求时才标「待完善」（缺省不写该键，保证与 Python 平价测试逐字段一致） */
  if (payload.pending === true) row.pending = true;
  ings.push(row);
  return 'ing 新建 ' + newId + ' ' + row.name + (row.pending ? '（待完善）' : '');
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
      const line = {
        ing: it.ing_id || it.ing,
        name: pt(it.name),
        qty: qty,
        price: price,
        conv: 1,
        amount: Math.round(qty * price * 100) / 100,
        unitCost: price
      };
      /* 【Node 超集】实收量：旧版 openRecv 明细只有「数量」一列（HTML:1636），
         批量导入时把「实收数」解析进 qty（HTML:2792），行上没有独立的实收量字段。
         这里只做**登记**：写入 line.recvQty 供列表展示与对账，
         **不参与 rebuildStock 计价**（仍按 qty 计入库存与应付）。不传该字段时行为与 Python 完全一致。 */
      if (it.recvQty !== undefined && it.recvQty !== null && it.recvQty !== '') {
        line.recvQty = toFloat(it.recvQty);
      }
      lines.push(line);
    }
    if (!lines.length) throw new Error('recv.inbound items 无有效数量行');
    const payable = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    const method = pt(payload.method) || '现金/转账';
    /* 【Node 超集】实付：旧版 openRecv 保存时写 payments=[{amount,date,method}]（HTML:1638-1646），
       且把超付金额**静默截断**（paid=Math.min(paid,payable)）——本实现改为「超付即拒绝」，
       避免静默吞掉多付金额（红线⑥ 不静默降级）；拒绝会以失败状态在审批中心可见。
       不传 paid 时 payments=[]，行为与 Python 完全一致。 */
    let paid = 0;
    if (payload.paid !== undefined && payload.paid !== null && payload.paid !== '') {
      paid = Math.round(toFloat(payload.paid) * 100) / 100;
      if (paid < 0) throw new Error('recv.inbound paid 不能为负数');
      if (paid > payable + 0.01) {
        throw new Error('recv.inbound paid 超过应付 ' + payable + '（超付请核对后重填）');
      }
    }
    const payments = paid > 0 ? [{ amount: paid, date: date, method: method }] : [];
    const sameDay = recv.filter((p) => p && p.date === date).length;
    const inbound = {
      id: uid('R', 10),
      no: 'JH' + String(date).replace(/-/g, '') + '-' + String(sameDay + 1).padStart(2, '0'),
      date: date,
      supplier: payload.supplier || '未指定供应商',
      lines: lines,
      payable: payable,
      payments: payments,
      note: '【云端入库】' + (payload.note || ''),
      method: method,
      status: '已入库'
    };
    /* 【Node 超集】关联采购单：旧版只把选中的采购单号写到 recv.po（HTML:1650-1654），
       采购单侧的收货进度回写由旧版 syncAllOrderRecv() 负责——Node 侧**尚未实现**（属采购管理页欠账），
       故此处只登记单向关联，不改 data.orders：界面已明示，不做静默假装。 */
    if (payload.po) inbound.po = String(payload.po);
    recv.push(inbound);
    msg = 'recv 追加入库 ' + inbound.no + '（' + lines.length + ' 行）'
      + (paid > 0 ? '，实付 ' + pf(paid) : '');
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

/* ---------- recv.pay ---------- */

/**
 * recv.pay：进货单补付 / 欠款清收。
 *
 * 只往 data.recv[i].payments 追加一条记录：
 *   不改 payable、不碰库存与均价、不写 logs —— 与旧版 openGet(:2076) 语义一致。
 *
 * 校验一律在**服务端**强制（不能只靠前端），失败 throw → 消费器置 failed，绝不静默：
 *   · 必须能定位进货单（recv_id 命中 id 或 no）
 *   · amount 必须 > 0
 *   · amount 不得超过 欠款 + 0.01（旧版 :2075 同口径）
 * 幂等：同一笔款被重复执行时，第二次会因「超过欠款」被拒，不会重复记账。
 */
function applyRecvPay(data, payload) {
  if (!Array.isArray(data.recv)) throw new Error('data.recv 不是数组');
  const rid = payload.recv_id != null ? String(payload.recv_id) : '';
  if (!rid) throw new Error('recv.pay 缺 recv_id');
  const doc = data.recv.find((p) => p && (String(p.id) === rid || String(p.no) === rid));
  if (!doc) throw new Error('recv.pay 未找到进货单: ' + rid);

  const amount = Math.round((num(payload.amount, 0) + 1e-12) * 100) / 100;
  if (!(amount > 0)) throw new Error('recv.pay 金额必须大于 0：' + payload.amount);

  const paid = Array.isArray(doc.payments)
    ? doc.payments.reduce((a, p) => a + num(p && p.amount, 0), 0)
    : 0;
  const debt = Math.round((num(doc.payable, 0) - paid + 1e-12) * 100) / 100;
  if (amount > debt + 0.01) {
    throw new Error(
      'recv.pay 金额超过欠款：本次 ' + amount + ' > 欠款 ' + Math.max(0, debt),
    );
  }

  if (!Array.isArray(doc.payments)) doc.payments = [];
  doc.payments.push({
    amount: amount,
    date: payload.date || today(),
    method: payload.method || '现金/扫码',
    source: payload.source || 'admin-web/inventory/inbound',
    ts: payload.ts || nowIso(),
  });

  const left = Math.round((num(doc.payable, 0) - (paid + amount) + 1e-12) * 100) / 100;
  return (
    'recv.pay ' + (doc.no || rid) + ' 收款 ' + amount + ' 元（' + (payload.method || '现金/扫码') + '）' +
    ' · 剩余欠款 ' + Math.max(0, left) + ' 元'
  );
}

/* ---------- recv.update ---------- */

/**
 * recv.update：编辑已有进货单（审批队列执行）。
 *
 * 对齐旧版 openRecv 编辑态（HTML:1642-1654）：就地替换 明细/日期/供应商/备注/付款方式/应付，
 * 并 rebuildStock 重算库存（旧版编辑保存后也 rebuildStock）。
 *
 * Node 超集安全项（不静默降级，与 recv.inbound 同理）：
 *   · 保留「补付」（recv.pay）追加的 payments（带 source/ts 的那些），
 *     仅用编辑表单的「实付」覆盖**初始**付款，避免编辑时吞掉历史补付记录
 *     （旧版无补付概念，编辑会把 payments 整体重写为单条，本实现在此处做了保护）。
 *   · 实付超付直接拒绝（同 recv.inbound 口径），不静默截断。
 *   · 已作废单不可再编辑。
 */
function applyRecvUpdate(data, payload) {
  if (!Array.isArray(data.recv)) throw new Error('data.recv 不是数组');
  const rid = payload.id != null ? String(payload.id)
    : (payload.recv_id != null ? String(payload.recv_id) : '');
  if (!rid) throw new Error('recv.update 缺 id / recv_id');
  const doc = data.recv.find((p) => p && (String(p.id) === rid || String(p.no) === rid));
  if (!doc) throw new Error('recv.update 未找到进货单: ' + rid);
  const st0 = String(doc.status || '');
  if (st0.indexOf('作废') >= 0 || st0.indexOf('void') >= 0) {
    throw new Error('已作废进货单不可编辑: ' + rid);
  }

  // 标量字段：有传才改，保持未传字段不变（编辑可只改某一项）
  if (payload.date != null) doc.date = String(payload.date);
  if (payload.supplier != null) doc.supplier = String(payload.supplier).trim();
  if (payload.note !== undefined) doc.note = String(payload.note || '');
  if (payload.method != null) doc.method = String(payload.method);
  if (payload.po !== undefined) {
    if (payload.po) doc.po = String(payload.po);
    else delete doc.po;
  }

  if (Array.isArray(payload.items) && payload.items.length) {
    const lines = [];
    for (const it of payload.items) {
      const qty = toFloat(it.qty || 0);
      const hasRecv = it.recvQty !== undefined && it.recvQty !== null && it.recvQty !== ''
        && toFloat(it.recvQty) > 0;
      if (qty === 0 && !hasRecv) continue;
      const price = toFloat(it.price || 0);
      const line = {
        ing: it.ing_id || it.ing,
        name: pt(it.name),
        qty: qty,
        price: price,
        conv: 1,
        amount: Math.round(qty * price * 100) / 100,
        unitCost: price
      };
      /* 实收量只登记、不定价，与 recv.inbound 同口径 */
      if (it.recvQty !== undefined && it.recvQty !== null && it.recvQty !== '') {
        line.recvQty = toFloat(it.recvQty);
      }
      lines.push(line);
    }
    if (!lines.length) throw new Error('recv.update 明细无有效数量行');
    doc.lines = lines;
    doc.payable = Math.round(lines.reduce((a, l) => a + l.amount, 0) * 100) / 100;
  }

  /* 付款：保留带 source/ts 的 补付 记录，用编辑表单「实付」覆盖**初始**付款 */
  const prior = Array.isArray(doc.payments)
    ? doc.payments.filter((p) => p && (p.source || p.ts))
    : [];
  if (payload.paid !== undefined && payload.paid !== null && payload.paid !== '') {
    const paid = Math.round(toFloat(payload.paid) * 100) / 100;
    if (paid < 0) throw new Error('recv.update paid 不能为负数');
    if (paid > num(doc.payable, 0) + 0.01) {
      throw new Error('recv.update 实付超过应付 ' + num(doc.payable, 0) + '（超付请核对后重填）');
    }
    const method = pt(payload.method) || doc.method || '现金/转账';
    const initial = paid > 0 ? [{ amount: paid, date: doc.date || today(), method: method }] : [];
    doc.payments = initial.concat(prior);
    doc.method = method;
  }
  /* 未传 paid：保留原 payments（初始 + 补付）不变 */

  const rb = rebuildStock(data);
  return 'recv.update ' + (doc.no || rid) + ' 已更新；' + rb;
}

/* ---------- recv.void ---------- */

/**
 * recv.void：作废进货单（审批队列执行）。
 *
 * 红线：只改 status='已作废' 并记操作人/时间/rev，**绝不 DELETE**
 *   （旧版 delRecv HTML:1676 物理删除不得照搬——删除即丢审计，且无法回滚）。
 * 库存不在此处直接重建：标记作废后，rebuildStock 会按 stock.js 的过滤规则跳过
 *   status 含「作废」/void 的单，故原本计入的库存与均价自动回退，
 *   效果等价于旧版「删除后重建台账」且**不丢审计、可回查**。
 * 幂等：已作废直接跳过。
 *
 * @param {object} ctx 队列上下文 { rev, traceId, now }（consumer.js:294），用于留痕 rev/链路
 */
function applyRecvVoid(data, payload, ctx) {
  const c = ctx || {};
  if (!Array.isArray(data.recv)) throw new Error('data.recv 不是数组');
  const rid = payload.id != null ? String(payload.id)
    : (payload.recv_id != null ? String(payload.recv_id) : '');
  if (!rid) throw new Error('recv.void 缺 id / recv_id');
  const doc = data.recv.find((p) => p && (String(p.id) === rid || String(p.no) === rid));
  if (!doc) throw new Error('recv.void 未找到进货单: ' + rid);
  const st0 = String(doc.status || '');
  if (st0.indexOf('作废') >= 0 || st0.indexOf('void') >= 0) {
    return 'recv.void ' + (doc.no || rid) + ' 已作废（跳过）';
  }
  const operator = payload.operator || 'QUEUE';
  doc.status = '已作废';
  doc.void_operator = operator;
  /* 作废时刻优先取队列 ctx.now（与审计时间线一致），否则回落到本机时间 */
  doc.void_at = payload.ts || c.now || nowIso();
  /* 记 rev：作废旧单的台账版本，便于审计定位「在哪个版本被作废」 */
  if (c.rev !== undefined && c.rev !== null) doc.void_rev = c.rev;
  if (c.traceId) doc.void_trace = c.traceId;
  if (payload.reason != null) doc.void_reason = String(payload.reason);
  doc.note = (doc.note || '') + ' 【已作废·' + operator + '】';
  /* 重建台账：作废单被 stock.js 跳过，库存/均价按剩余单据重算，原单保留可查 */
  const rb = rebuildStock(data);
  const revTag = doc.void_rev !== undefined ? 'rev=' + doc.void_rev + ' ' : '';
  return 'recv.void ' + (doc.no || rid) + ' → 已作废（' + revTag
    + '库存按台账自动回退，原单保留可查）；' + rb;
}

/* ---------- recv.import（批量导入） ---------- */

/**
 * recv.import：批量导入进货单（审批队列执行）。
 *
 * 移植旧版 commitRecvImport（HTML:3650-3671）：
 *   逐张单据按 applyRecvInbound 的同一口径生成 JH 单（id / no / lines / payable / payments /
 *   method / status），push 进 data.recv，供应商名字并入 data.suppliers，
 *   **批末统一 rebuildStock 一次**（ADR-004 §2.4：避免 N 次全量重算）。
 *
 * 红线：
 *   · 本函数是**唯一的执行器**，前置的解析/预览全在 lib/recv_import.js（纯计算、零写）；
 *     云端只在预览通过后才投这一个动作 → 批内原子（整批成功或整批失败）。
 *   · 明细非法（数量 ≤0 / 单价非数字 / 单价 <0 / 无原料名）**直接 throw 拒绝**，
 *     不静默跳过（红线⑥）——预览层已经过滤过，执行期再出错说明数据被改过，必须留失败痕迹。
 *   · **未匹配原料自动建档**（忠实回归旧版 createIngFromImport :2806；2026-10-12 撤销原「不代建」偏离）：
 *     依次按「档案 id 精确 → 名称/别名」匹配，仍匹配不上才新建，且建出来的是 `pending:true` 的**待完善草稿**
 *     —— 不阻断进货单 / 结算生成，门店随后到「原料档案 → 待完善」补全信息并「确认转正」。
 *   · 无用依赖：不做 N 次 rebuildStock，也不会绕过 /api/actions 直写。
 *
 * @param {object} data 业务数据快照
 * @param {object} payload { docs:[{supplier,date,note,lines:[{ingId,name,qty,price,unit}]}], markPaid }
 */
function applyRecvImport(data, payload) {
  if (data.recv === undefined || data.recv === null) data.recv = [];
  if (!Array.isArray(data.recv)) throw new Error('data.recv 不是数组');
  if (data.ings === undefined || data.ings === null) data.ings = [];
  if (!Array.isArray(data.ings)) throw new Error('data.ings 不是数组');
  const ings = data.ings;
  const recv = data.recv;
  const docs = Array.isArray(payload && payload.docs) ? payload.docs : [];
  if (!docs.length) throw new Error('recv.import 缺 docs（空批次已拒绝，未改动账面）');
  const markPaid = !!(payload && payload.markPaid);
  let newDoc = 0;
  let newLine = 0;
  let newIng = 0;
  let total = 0;

  for (const d of docs) {
    const doc = d || {};
    const date = String(doc.date || today());
    const supplier = String(doc.supplier || '').trim() || '未指定供应商';
    const src = Array.isArray(doc.lines) ? doc.lines : [];
    const lines = [];
    for (const it of src) {
      if (!it) continue;
      const name = String(it.name || '').trim();
      if (!name) throw new Error('recv.import 明细缺原料名（该批次整体拒绝）');
      const qty = toFloat(it.qty || 0);
      const price = toFloat(it.price || 0);
      if (!(qty > 0)) throw new Error('recv.import 明细数量需 > 0：' + name);
      if (!isFinite(price) || price < 0) throw new Error('recv.import 单价非法（需 ≥ 0 的数字）：' + name);
      /* 原料匹配：① 档案 id 精确 → ② 名称精确（旧版 findIngByName 同口径）
         → ③ 自动建档（待完善草稿）。同批次里同名新料在 ② 命中刚建的 pending 料，不会重复建。 */
      const rawId = String(it.ingId || it.ing_id || it.ing || '').trim();
      let gid = '';
      if (rawId) {
        for (const g of ings) {
          if (String((g && g.id) || '') === rawId) { gid = rawId; break; }
        }
      }
      if (!gid) {
        for (const g of ings) {
          if (String((g && g.name) || '').trim() === name) { gid = String(g.id); break; }
        }
      }
      if (!gid) {
        gid = createIngFromImport(ings, name, it.unit, it.cat).id;
        newIng += 1;
      }
      const line = {
        ing: gid,
        name: name,
        qty: qty,
        price: price,
        conv: 1,
        amount: Math.round(qty * price * 100) / 100,
        unitCost: price
      };
      /* 实收量：与 recv.inbound 同口径——只登记、不参与计价 */
      if (it.recvQty !== undefined && it.recvQty !== null && it.recvQty !== '') {
        line.recvQty = toFloat(it.recvQty);
      }
      lines.push(line);
    }
    if (!lines.length) throw new Error('recv.import 单据无有效明细行（供应商：' + supplier + '）');
    const payable = Math.round(lines.reduce((a, l) => a + l.amount, 0) * 100) / 100;
    const sameDay = recv.filter((p) => p && p.date === date).length;
    const inbound = {
      id: uid('R', 10),
      no: 'JH' + String(date).replace(/-/g, '') + '-' + String(sameDay + 1).padStart(2, '0'),
      date: date,
      supplier: supplier,
      lines: lines,
      payable: payable,
      /* 旧版「按应付全额登记付款」勾选项（HTML:3633 #recvPaidFlag → :3663）， ledger 语义不变 */
      payments: (markPaid && payable > 0) ? [{ amount: payable, date: date, method: '现金/转账' }] : [],
      note: String(doc.note || '').trim() || '【批量导入】',
      method: '现金/转账',
      status: '已入库'
    };
    recv.push(inbound);
    total = Math.round((total + payable) * 100) / 100;
    newDoc += 1;
    newLine += lines.length;
    /* 供应商名单补齐（旧版 :3666 DB.suppliers 去重追加，列表筛选下拉依赖它） */
    const names = arr(data.suppliers).map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
    if (names.indexOf(supplier) < 0) names.push(supplier);
    data.suppliers = names;
  }

  /* 批末统一重算一次台账（O(单据数 + 库存行数)，而非 O(N × 库存行数)） */
  const rb = rebuildStock(data);
  return 'recv.import 导入 ' + newDoc + ' 张进货单（' + newLine + ' 行，应付合计 ' + pf(total) + '）'
    + (newIng ? '，自动新建原料 ' + newIng + ' 种（待完善草稿，请到「原料档案」补全）' : '')
    + (markPaid ? '，已按应付全额登记付款' : '，默认挂账（可后续补付）') + '；' + rb;
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

/* ---------- order.pay / close / void / restore / delete ----------
 * 采购单付款与状态流转（对齐旧版 openGet('O')/closeOrder/voidOrder/restoreOrder/delOrder，HTML:1751-1827）。
 * 硬规则：只改 data.orders（status/lines/ payments），**绝不触碰库存与均价**（采购单不进库存）。
 */

function _ordersArr(data) {
  if (data.orders === undefined || data.orders === null) data.orders = [];
  if (!Array.isArray(data.orders)) throw new Error('data.orders 不是数组');
  return data.orders;
}

/** 定位采购单（id / no 任一匹配） */
function _findOrder(orders, oid) {
  const key = String(oid || '').trim();
  if (!key) throw new Error('缺 order_id');
  for (const o of orders) {
    if (String(o.id || '') === key || String(o.no || '') === key) return o;
  }
  throw new Error('找不到采购单 ' + key);
}

/** 已付 = Σ payments[].amount（对齐旧版 recvPaid，HTML:1139） */
function _orderPaid(o) {
  return r2((o.payments || []).reduce((a, p) => a + (Number(p && p.amount) || 0), 0));
}

/** 设置所有行状态（st='closed'/'canceled'；null 清除。对齐旧版 setOrderLinesSt，HTML:1715） */
function _setLinesSt(o, st) {
  for (const l of o.lines || []) {
    if (st) l.st = st; else delete l.st;
  }
}

/**
 * order.pay：采购单付款/补付登记（旧版 openGet('O')，HTML:2055-2080）。
 * 校验 0 < amount ≤ 欠款 + 0.01（payable − 已付）；金额与日期可选，方式照抄旧版枚举。
 */
function applyOrderPay(data, payload) {
  const orders = _ordersArr(data);
  const o = _findOrder(orders, payload.order_id || payload.id || payload.no);
  const payable = Number(o.payable) || 0;
  const debt = r2(payable - _orderPaid(o));
  const amount = r2(payload.amount);
  if (!(amount > 0) || amount > debt + 0.01) {
    throw new Error('付款金额需在 0 ~ 欠款（' + debt + '）之间');
  }
  if (!Array.isArray(o.payments)) o.payments = [];
  o.payments.push({
    amount,
    date: payload.date || today(),
    method: String(payload.method || '现金/扫码')
  });
  o._u = nowIso();
  return 'orders ' + (o.no || o.id || '') + ' 付款 ' + amount + '（余欠 ' + r2(debt - amount) + '）';
}

/** order.close：结案（旧版 closeOrder，HTML:1751-1757）。只改状态，不碰库存与均价 */
function applyOrderClose(data, payload) {
  const orders = _ordersArr(data);
  const o = _findOrder(orders, payload.order_id || payload.id || payload.no);
  o.status = 'closed';
  o.closeBy = 'manual';
  o.closedAt = today();
  _setLinesSt(o, 'closed');
  o._u = nowIso();
  return 'orders ' + (o.no || o.id || '') + ' 已结案（手工）';
}

/** order.void：作废（旧版 voidOrder，HTML:1758-1763） */
function applyOrderVoid(data, payload) {
  const orders = _ordersArr(data);
  const o = _findOrder(orders, payload.order_id || payload.id || payload.no);
  o.status = 'void';
  o.closeBy = 'manual';
  o.closedAt = today();
  _setLinesSt(o, 'canceled');
  o._u = nowIso();
  return 'orders ' + (o.no || o.id || '') + ' 已作废';
}

/** order.restore：已结案/已作废 → 收货中（旧版 restoreOrder，HTML:1765-1769） */
function applyOrderRestore(data, payload) {
  const orders = _ordersArr(data);
  const o = _findOrder(orders, payload.order_id || payload.id || payload.no);
  o.status = 'normal';
  o.closeBy = 'auto';
  delete o.closedAt;
  _setLinesSt(o, null);
  o._u = nowIso();
  return 'orders ' + (o.no || o.id || '') + ' 已恢复为收货中';
}

/** order.delete：物理删除采购单（旧版 delOrder，HTML:1822-1827）。该单不参与库存计算 */
function applyOrderDelete(data, payload) {
  const orders = _ordersArr(data);
  const o = _findOrder(orders, payload.order_id || payload.id || payload.no);
  const no = o.no || o.id || '';
  data.orders = orders.filter((x) => x !== o);
  return 'orders ' + no + ' 已删除';
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
  applyRest,
  applyIngUpsert,
  applyQuoteUpsert,
  applyLossReport,
  approveLossReport,
  rejectLossReport,
  applyRecvInbound,
  insertRecvAccept,
  applyRecvPay,
  applyRecvUpdate,
  applyRecvVoid,
  applyRecvImport,
  applyRestockToOrders,
  applyStockCount,
  insertStockCount,
  applyOrderMark,
  applyOrderPay,
  applyOrderClose,
  applyOrderVoid,
  applyOrderRestore,
  applyOrderDelete,
  upsertVendor,
  insertSupplyPo
};
