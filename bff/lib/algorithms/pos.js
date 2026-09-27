'use strict';
/*
 * lib/algorithms/pos.js — POS/桌台/收银 + BOM 扣料算法
 * 忠实迁移自 store-inventory/queue_consumer.py：
 *   _wire_table_state          (:482)
 *   apply_pos_table_state      (:489)
 *   apply_pos_table_upsert     (:589)
 *   apply_pos_table_remove     (:635)
 *   append_sale                (:1376)
 *   _find_pos_table            (:1415)
 *   _bill_summary_of           (:1422)
 *   apply_pos_service_note     (:1431)
 *   apply_pos_void             (:1520)
 *   apply_pos_pay              (:1698)
 *   apply_pos_merge_split      (:1758)
 *   _prep_deducted_skus        (:2101)
 *   _parse_bom_qty_line        (:2122)
 *   _recipe_bom_lines          (:2148)
 *   _append_bom_deduct_logs    (:2180)
 *   _deduct_bom_for_workorder  (:2210)
 *   _deduct_bom_for_sale_items (:2226)
 *
 * 约定：纯函数优先，直接原地修改 data；SQLite 耦合统一走 ctx.store：
 *   ctx.store.query(sql, params) → 行数组（对象数组）
 *   ctx.store.insert(table, row) / ctx.store.upsert(table, row)
 *   ctx.store.update(table, sets, where)（前厅传菜回写工单）
 * ctx.store 缺失时优雅降级（不写库、从 data 兜底），绝不崩溃。
 */

const crypto = require('crypto');
const { today, nowIso, num, r3, arr } = require('./util');
const { resolveIngId } = require('./inventory');
const { rebuildStock } = require('./stock');

/* ---------- 公共辅助 ---------- */

/** Python _r3：round(float(x or 0) + 1e-12, 3) */
function r3e(x) {
  return Math.round((num(x, 0) + 1e-12) * 1000) / 1000;
}

/** uuid.uuid4().hex[:n] */
function hex(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

/** Python 浮点转字符串（整数 float 保留 .0）：str(5.0)='5.0' */
function pf(x) {
  if (typeof x !== 'number' || !isFinite(x)) return String(x);
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

/** Python str(v)：int 无小数，float 保 .0（JS 无法区分 2 与 2.0，按整数判定） */
function pstr(x) {
  if (typeof x === 'number') {
    if (!isFinite(x)) return String(x);
    return Number.isInteger(x) ? String(x) : String(x);
  }
  if (x === null) return 'None';
  if (x === undefined) return 'None';
  return String(x);
}

/** Python %d：向零截断 */
function pint(x) {
  return Math.trunc(num(x, 0));
}

/** Python round(x, n) 半偶舍入过于复杂；BOM/金额均为简单工况，用 Math.round */
function round2(x) {
  return Math.round(num(x, 0) * 100) / 100;
}

/** dict.get 缺键 → None：undefined → null */
function pt(v) {
  return v === undefined ? null : v;
}

/** Python 真值判断：None/False/0/''/[]/{} 为假 */
function truthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** Python `x or default`：x 为假值时取 default */
function orDefault(x, d) {
  return truthy(x) ? x : d;
}

/** Python float(x)：失败抛错 */
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

/** 安全 int：失败回落 d（对齐 Python try/except int） */
function intOr(v, d) {
  try {
    return Math.trunc(toFloat(v));
  } catch (e) {
    return d;
  }
}

/** 判断 payload 中的布尔真值（对齐 Python `in (True,1,"1","true","True")`） */
function isTrueVal(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'True';
}

/* ---------- 桌态 ---------- */

/** _wire_table_state：中文/英文桌态归一，非法抛错（对齐 Python 文案） */
function wireTableState(state) {
  let s = String(state === undefined || state === null ? 'free' : state).trim();
  if (!s) s = 'free';
  if (['free', 'busy', 'clean', 'rsv', '空闲', '就餐', '待清', '预订'].indexOf(s) < 0) {
    throw new Error('非法桌态: ' + s);
  }
  const map = { '空闲': 'free', '就餐': 'busy', '待清': 'clean', '预订': 'rsv' };
  return map[s] !== undefined ? map[s] : s;
}

/** _find_pos_table：按 id/no 查桌 */
function findPosTable(data, tid) {
  for (const t of arr(data && data.pos)) {
    if (String((t && (t.id || t.no)) || '') === String(tid)) return t;
  }
  return null;
}

/** _bill_summary_of：前 6 行「名×数」拼接 */
function billSummaryOf(bill) {
  if (!Array.isArray(bill) || !bill.length) return null;
  return bill.slice(0, 6).map((it) => (
    String((it && (it.name || it.sku)) || '?') + '×' + pstr(orDefault(it && it.qty, 1))
  )).join('、');
}

/**
 * apply_pos_table_state：更新/创建桌台 state ∈ free|busy|clean|rsv；可附挂单 bill。
 * spawn_kitchen=true 且 busy+items 时，按挂单明细建挂桌工单（传菜对桌）。
 * db 写库走 ctx.store.insert('sop_workorders', ...)。
 */
function applyPosTableState(data, payload, ctx) {
  if (data.pos === undefined || data.pos === null) data.pos = [];
  if (!Array.isArray(data.pos)) throw new Error('data.pos 不是数组');
  const pos = data.pos;
  const tid = String(orDefault(payload.table_id, payload.id) || '').trim();
  if (!tid) throw new Error('缺少 table_id');
  const wire = wireTableState(orDefault(payload.state, 'free'));
  const bill = Array.isArray(payload.items) ? payload.items : null;
  const amount = payload.amount;
  const summary = payload.bill_summary || payload.dish || payload.summary;

  const applyBill = (t) => {
    if (wire === 'free') {
      delete t.bill;
      delete t.amount;
      delete t.bill_summary;
      return;
    }
    if (bill !== null) {
      t.bill = bill;
      if (amount !== undefined && amount !== null) {
        try {
          t.amount = toFloat(amount);
        } catch (e) {
          t.amount = amount;
        }
      }
      if (truthy(summary)) {
        t.bill_summary = summary;
      } else if (truthy(bill)) {
        t.bill_summary = bill.slice(0, 6).map((it) => (
          String((it && (it.name || it.sku)) || '?') + '×' + pstr(orDefault(it && it.qty, 1))
        )).join('、');
      }
    } else if (amount !== undefined && amount !== null) {
      try {
        t.amount = toFloat(amount);
      } catch (e) {
        t.amount = amount;
      }
      if (truthy(summary)) t.bill_summary = summary;
    }
  };

  let desc = null;
  for (const t of pos) {
    if (String((t && (t.id || t.no)) || '') === tid) {
      t.state = wire;
      applyBill(t);
      desc = 'pos ' + tid + ' → ' + wire + (bill !== null ? ' ·挂单' : '');
      break;
    }
  }
  if (desc === null) {
    const row = {
      id: tid,
      no: orDefault(payload.no, tid),
      name: orDefault(payload.name, tid),
      state: wire,
      seats: intOr(orDefault(payload.seats, 4), 4),
      zone: orDefault(payload.zone, '大厅')
    };
    pos.push(row);
    applyBill(row);
    desc = 'pos 新建 ' + tid + ' → ' + wire;
  }

  // 挂单 → 后厨：一键建挂桌工单（备料路径）
  const spawn = payload.spawn_kitchen;
  const hasDb = Boolean(ctx && ctx.store && typeof ctx.store.insert === 'function');
  if (isTrueVal(spawn) && wire === 'busy' && truthy(bill) && hasDb) {
    const spawned = [];
    const tno = String(orDefault(payload.no, tid));
    const day = orDefault(payload.date, today());
    for (const it of bill) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
      const sku = it.sku_id || it.sku || it.name;
      if (!sku) continue;
      let qty = intOr(orDefault(it.qty, 1), 1);
      if (qty <= 0) continue;
      let wid = null;
      try {
        wid = insertWorkorder(ctx, {
          sku_id: sku,
          qty: qty,
          date: day,
          status: '待开始',
          table_id: tid,
          table_no: tno,
          name: it.name || sku,
          planned_start: day + 'T10:00'
        });
        spawned.push(String(sku) + '#' + (wid === null || wid === undefined ? '' : wid) + '×' + qty);
      } catch (e) {
        // Python 版吞掉异常仅告警；此处静默跳过
      }
    }
    if (spawned.length) desc += ' ·厨单' + spawned.slice(0, 6).join(',');
  }
  return desc;
}

/** insert_workorder：写 sop_workorders；无 ctx.store 返回 null（未写库） */
function insertWorkorder(ctx, payload) {
  if (!(ctx && ctx.store && typeof ctx.store.insert === 'function')) return null;
  return ctx.store.insert('sop_workorders', {
    date: payload.date || today(),
    sku_id: payload.sku_id || payload.sku || 'SKU001',
    qty: payload.qty || 20,
    planned_start: payload.planned_start || ((payload.date || today()) + 'T10:00'),
    status: payload.status || '待开始',
    qc_records: '[]',
    table_id: payload.table_id != null ? String(payload.table_id) : null,
    table_no: payload.table_no != null ? String(payload.table_no) : null
  });
}

/** apply_pos_table_upsert：桌台主数据（大厅/包间、座位数、名称） */
function applyPosTableUpsert(data, payload) {
  if (data.pos === undefined || data.pos === null) data.pos = [];
  if (!Array.isArray(data.pos)) throw new Error('data.pos 不是数组');
  const pos = data.pos;
  let tid = String(orDefault(payload.table_id, payload.id) || '').trim();
  if (!tid) {
    const used = new Set(pos.map((t) => String((t && t.id) || '')));
    let n = 1;
    while (used.has('T' + n)) n += 1;
    tid = 'T' + n;
  }
  let zone = String(orDefault(payload.zone, orDefault(payload.area, '大厅')) || '').trim();
  if (!zone) zone = '大厅';
  if (zone !== '大厅' && zone !== '包间') {
    zone = ['vip', 'private', 'room', '包厢'].indexOf(zone.toLowerCase()) >= 0 ? '包间' : '大厅';
  }
  const seats = intOr(orDefault(payload.seats, 4), 4);
  if (seats < 1 || seats > 40) throw new Error('座位数需在 1–40');
  const name = String(payload.name || '').trim()
    || (truthy(payload.no) ? (String(payload.no) + '号桌') : tid);
  const no = String(payload.no || '').trim() || tid.replace(/^T+/, '');
  const state = payload.state;
  for (const t of pos) {
    if (String((t && (t.id || t.no)) || '') === tid) {
      t.id = tid;
      t.name = name;
      t.no = no;
      t.seats = seats;
      t.zone = zone;
      if (state !== undefined && state !== null) t.state = wireTableState(state);
      return 'pos 主数据更新 ' + tid + ' ' + zone + '/' + seats + '座';
    }
  }
  pos.push({
    id: tid,
    no: no,
    name: name,
    seats: seats,
    zone: zone,
    state: wireTableState(orDefault(state, 'free'))
  });
  return 'pos 新建主数据 ' + tid + ' ' + zone + '/' + seats + '座';
}

/** apply_pos_table_remove：仅空闲桌可删（防误删在用桌） */
function applyPosTableRemove(data, payload) {
  if (data.pos === undefined || data.pos === null) data.pos = [];
  if (!Array.isArray(data.pos)) throw new Error('data.pos 不是数组');
  const pos = data.pos;
  const tid = String(orDefault(payload.table_id, payload.id) || '').trim();
  if (!tid) throw new Error('缺少 table_id');
  const force = Boolean(payload.force);
  for (let i = 0; i < pos.length; i++) {
    const t = pos[i];
    if (String((t && (t.id || t.no)) || '') === tid) {
      const st = String((t && t.state) || 'free');
      if (st !== 'free' && st !== '空闲' && !force) {
        throw new Error('桌台 ' + tid + ' 当前 ' + st + '，仅空闲可删（或 force）');
      }
      pos.splice(i, 1);
      return 'pos 删除 ' + tid;
    }
  }
  throw new Error('找不到桌台 ' + tid);
}

/* ---------- 销售追加 ---------- */

/**
 * append_sale：追加一条 data.sales（date/hour/dish/qty/amount/channel）。
 * channel 必填；dish 可选覆盖。
 */
function appendSale(data, payload, channel, dish) {
  if (data.sales === undefined || data.sales === null) data.sales = [];
  if (!Array.isArray(data.sales)) throw new Error('data.sales 不是数组');
  const sales = data.sales;
  const now = new Date();
  const items = Array.isArray(payload.items) ? payload.items : null;
  let qty = payload.qty;
  if (qty === undefined || qty === null) {
    if (items) {
      try {
        qty = items.reduce((s, it) => s + toFloat(orDefault(it && it.qty, 1)), 0);
      } catch (e) {
        qty = items.length;
      }
    }
  }
  if (qty === undefined || qty === null) qty = 1;
  let name = dish || payload.dish || payload.name;
  if (!name && items) {
    name = (items[0] && (items[0].sku || items[0].name));
  }
  if (!name) {
    name = channel === '堂食' ? '结账' : (payload.platform || '外卖');
  }
  const stamp = String(now.getFullYear())
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0')
    + String(now.getHours()).padStart(2, '0')
    + String(now.getMinutes()).padStart(2, '0');
  const line = {
    id: 'S' + stamp + hex(4),
    date: orDefault(payload.date, today()),
    hour: intOr(orDefault(payload.hour, now.getHours()), now.getHours()),
    dish: name,
    qty: qty,
    amount: toFloat(orDefault(payload.amount, 0)),
    channel: channel,
    method: pt(orDefault(payload.method, payload.pay_method)),
    table_id: pt(orDefault(payload.table_id, payload.id)),
    ts: orDefault(payload.ts, nowIso()),
    source: 'queue'
  };
  if (items) line.items = items;
  sales.push(line);
  return line;
}

/* ---------- 前厅传菜状态机 ---------- */

/**
 * apply_pos_service_note：pos.rush / pack / ready / pass。
 * rush=催（提优 planned_start）；ready=齐（挂桌工单→待传）；pass=传（→已完成）。
 */
function applyPosServiceNote(data, payload, kind, ctx) {
  const tid = String(orDefault(payload.table_id, payload.id) || '').trim();
  if (!tid) throw new Error('缺少 table_id');
  const t = findPosTable(data, tid);
  const note = orDefault(payload.note, orDefault(payload.action, kind));
  if (t !== null) {
    let flags = t.service_flags;
    if (!flags || typeof flags !== 'object' || Array.isArray(flags)) {
      flags = {};
      t.service_flags = flags;
    }
    flags[kind] = {
      ts: orDefault(payload.ts, nowIso()),
      note: note,
      operator: pt(payload.operator)
    };
    if (kind === 'rush') {
      t.rushed = true;
      delete t.passed;
    }
    if (kind === 'pack') {
      t.pack = true;
    }
    if (kind === 'ready') {
      t.pass_ready = true;
      delete t.passed;
    }
    if (kind === 'pass') {
      t.passed = true;
      t.rushed = false;
      t.pass_ready = false;
      delete flags.rush;
      delete flags.ready;
    }
  }
  if (data.logs === undefined || data.logs === null) data.logs = [];
  if (Array.isArray(data.logs)) {
    data.logs.push({
      id: 'S' + hex(8),
      kind: 'pos_' + kind,
      table_id: tid,
      no: pt(payload.no),
      note: note,
      ts: orDefault(payload.ts, nowIso()),
      source: 'queue'
    });
  }
  let desc = 'pos.' + kind + ' ' + tid + ' · ' + note;
  if (!(ctx && ctx.store && typeof ctx.store.update === 'function')) return desc;
  try {
    if (kind === 'rush') {
      const n = ctx.store.update('sop_workorders',
        { planned_start: nowIso() },
        { date: today(), table_id: tid, status_not_in: ['已完成', '完成', '作废', '待传'] });
      if (n) desc += ' ·优先工单' + n;
    } else if (kind === 'ready') {
      const n = ctx.store.update('sop_workorders',
        { status: '待传' },
        { date: today(), table_id: tid, status_not_in: ['已完成', '完成', '作废', '待传'] });
      if (n) desc += ' ·齐菜工单' + n + '→待传';
    } else if (kind === 'pass') {
      const n = ctx.store.update('sop_workorders',
        { status: '已完成' },
        { date: today(), table_id: tid, status_not_in: ['已完成', '完成', '作废'] });
      if (n) desc += ' ·已传工单' + n + '→完成';
    }
  } catch (e) {
    // Python 版吞异常仅告警
  }
  return desc;
}

/* ---------- 退菜 ---------- */

/** apply_pos_void：就餐桌退菜。按 sku/name 从 bill 减 qty；无 bill 时只记 logs + 调整摘要。 */
function applyPosVoid(data, payload) {
  const tid = String(orDefault(payload.table_id, payload.id) || '').trim();
  if (!tid) throw new Error('缺少 table_id');
  const t = findPosTable(data, tid);
  if (t === null) throw new Error('桌台不存在: ' + tid);
  const dish = String(orDefault(payload.dish, payload.name) || '').trim();
  const sku = String(orDefault(payload.sku_id, payload.sku) || '').trim();
  if (!dish && !sku) throw new Error('退菜需要 dish 或 sku');
  let qtyVoid = intOr(orDefault(payload.qty, 1), 1);
  if (qtyVoid <= 0) throw new Error('退菜数量须 > 0');
  const reason = orDefault(payload.reason, orDefault(payload.note, '退菜'));
  const bill = Array.isArray(t.bill) ? t.bill : [];
  const newBill = [];
  let removed = 0;
  let refundAmt = 0.0;
  let matched = false;
  for (const it of bill) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      newBill.push(it);
      continue;
    }
    const name = String(it.name || '');
    const isku = String(it.sku_id || it.sku || '');
    const hit = (sku && isku && sku === isku)
      || (dish && (dish === name || dish.indexOf(name) >= 0 || name.indexOf(dish) >= 0));
    if (!hit || matched) {
      newBill.push(it);
      continue;
    }
    matched = true;
    let curQty = intOr(orDefault(it.qty, 1), 1);
    const take = Math.min(curQty, qtyVoid);
    removed = take;
    let unit = 0.0;
    try {
      unit = toFloat(orDefault(it.price, orDefault(it.amount, 0)));
      if (it.amount !== undefined && it.amount !== null && curQty > 0 && !truthy(it.price)) {
        unit = toFloat(it.amount) / curQty;
      }
    } catch (e) {
      unit = 0.0;
    }
    refundAmt = unit * take;
    const left = curQty - take;
    if (left > 0) {
      const row = Object.assign({}, it);
      row.qty = left;
      if (row.amount !== undefined && row.amount !== null) {
        try {
          row.amount = toFloat(row.amount) - refundAmt;
        } catch (e) { /* pass */ }
      }
      newBill.push(row);
    }
  }
  if (bill.length && !matched) throw new Error('挂单中未找到菜品: ' + (dish || sku));
  if (bill.length) {
    t.bill = newBill;
    const summary = billSummaryOf(newBill);
    if (summary) {
      t.bill_summary = summary;
    } else {
      delete t.bill_summary;
    }
    if (t.amount !== undefined && t.amount !== null && refundAmt) {
      try {
        t.amount = Math.max(0.0, toFloat(orDefault(t.amount, 0)) - refundAmt);
      } catch (e) { /* pass */ }
    } else if (summary === null) {
      delete t.amount;
    }
  } else {
    const prev = t.bill_summary || '';
    const tag = '退:' + (dish || sku) + '×' + qtyVoid;
    t.bill_summary = (tag + (prev ? ' · ' + prev : '')).slice(0, 120);
    removed = qtyVoid;
  }
  if (data.logs === undefined || data.logs === null) data.logs = [];
  if (Array.isArray(data.logs)) {
    data.logs.push({
      id: 'V' + hex(8),
      kind: 'pos_void',
      table_id: tid,
      dish: dish || sku,
      sku: sku || null,
      qty: removed || qtyVoid,
      reason: reason,
      refund: refundAmt,
      ts: orDefault(payload.ts, nowIso()),
      source: 'queue'
    });
  }
  return 'pos.void ' + tid + ' · ' + (dish || sku) + '×' + (removed || qtyVoid) + ' · ' + reason;
}

/* ---------- 结账 ---------- */

/** apply_pos_pay：桌台结账 → free；清挂单；写 sales；默认按菜品 BOM 扣料。 */
function applyPosPay(data, payload, ctx) {
  const tid = String(orDefault(payload.table_id, payload.id) || '').trim();
  if (!tid) throw new Error('缺少 table_id');
  // 对齐 Python：payload 在循环内被复制并补 items/amount，改动影响后续 sale/log/BOM
  let pl = Object.assign({}, payload);
  let items = Array.isArray(pl.items) ? pl.items : null;
  let amount = pl.amount;
  let dish = pl.dish;
  for (const t of arr(data.pos)) {
    if (String((t && (t.id || t.no)) || '') === tid) {
      if (items === null && Array.isArray(t.bill)) {
        items = t.bill;
        pl = Object.assign({}, pl);
        pl.items = items;
      }
      if ((amount === undefined || amount === null || amount === '' || amount === 0 || amount === '0')
        && t.amount !== undefined && t.amount !== null && t.amount !== '') {
        amount = t.amount;
        pl = Object.assign({}, pl);
        pl.amount = amount;
      }
      if (!dish && t.bill_summary) dish = t.bill_summary;
      break;
    }
  }
  applyPosTableState(data, {
    table_id: tid,
    no: pl.no,
    state: 'free',
    seats: pl.seats
  }, ctx);
  if (data.logs === undefined || data.logs === null) data.logs = [];
  if (Array.isArray(data.logs)) {
    data.logs.push({
      id: 'P' + hex(8),
      kind: 'pos_pay',
      table_id: tid,
      amount: amount !== undefined && amount !== null ? amount : pl.amount,
      method: pl.method || '现金',
      items: items,
      ts: orDefault(pl.ts, nowIso()),
      source: 'queue'
    });
  }
  const sale = appendSale(
    data,
    pl,
    pl.channel || '堂食',
    dish || pl.dish || ('桌' + (pl.no || tid) + '结账')
  );
  let desc = 'pos.pay ' + tid
    + ' amount=' + pstr(amount !== undefined && amount !== null ? amount : pl.amount)
    + ' sales=' + pstr(sale.id)
    + ' lines=' + (items ? items.length : 0);
  // 默认扣 BOM；若本桌已有「备料已扣」工单则跳过对应 sku
  if (pl.deduct !== false && items && ctx && ctx.store) {
    try {
      const bom = deductBomForSaleItems(ctx, data, items, '结账#' + tid, tid);
      if (bom) desc += '；' + bom;
    } catch (e) {
      desc += '；BOM扣料跳过(' + e.message + ')';
    }
  }
  return desc;
}

/* ---------- 并桌 / 拆桌 ---------- */

/** apply_pos_merge_split：pos.merge / pos.split */
function applyPosMergeSplit(data, payload, kind, ctx) {
  const src = String(orDefault(payload.from, payload.src) || '').trim();
  const dst = String(orDefault(payload.to, payload.dst) || '').trim();
  if (!src || !dst) throw new Error('pos.' + kind + ' 需要 from/to');
  if (kind === 'merge') {
    applyPosTableState(data, { table_id: src, state: 'free' }, ctx);
    applyPosTableState(data, {
      table_id: dst, state: 'busy',
      no: orDefault(payload.to_no, dst), seats: payload.seats
    }, ctx);
  } else {
    applyPosTableState(data, {
      table_id: src, state: 'busy', no: orDefault(payload.from_no, src)
    }, ctx);
    applyPosTableState(data, {
      table_id: dst, state: 'busy',
      no: orDefault(payload.to_no, dst), seats: payload.seats
    }, ctx);
  }
  if (data.logs === undefined || data.logs === null) data.logs = [];
  if (Array.isArray(data.logs)) {
    data.logs.push({
      id: (kind === 'merge' ? 'M' : 'S') + hex(8),
      kind: 'pos_' + kind,
      from: src,
      to: dst,
      ts: nowIso(),
      source: 'queue'
    });
  }
  return 'pos.' + kind + ' ' + src + ' → ' + dst;
}

/* ---------- BOM 扣料 ---------- */

/**
 * _prep_deducted_skus：本桌今日已备料扣的 sku 集合（工单 bom_deducted=1）。
 * 走 ctx.store.query；无 store / 异常 → 空集合。
 */
function prepDeductedSkus(ctx, tableId) {
  if (!(ctx && ctx.store && typeof ctx.store.query === 'function') || !tableId) return new Set();
  try {
    const rows = ctx.store.query(
      'SELECT sku_id FROM sop_workorders WHERE date=? AND table_id=? AND COALESCE(bom_deducted,0)=1',
      [today(), String(tableId)]
    );
    const out = new Set();
    for (const r of arr(rows)) {
      const v = r && r.sku_id;
      if (v !== undefined && v !== null && v !== '') out.add(String(v));
    }
    return out;
  } catch (e) {
    return new Set();
  }
}

/**
 * _parse_bom_qty_line：解析 '面粉500g' / '猪肉 2斤' / dict → [name, qty, unit]。
 * 无匹配返回 null。
 */
function parseBomQtyLine(line) {
  if (line && typeof line === 'object' && !Array.isArray(line)) {
    const name = String(line.name || line.ing || line.ing_name || '').trim();
    if (!name) return null;
    let qty = 0.0;
    try {
      qty = toFloat(orDefault(line.qty, 0));
    } catch (e) {
      qty = 0.0;
    }
    const unit = String(orDefault(line.unit, 'g') || '').trim() || 'g';
    return [name, qty, unit];
  }
  const s = String(line === undefined || line === null ? '' : line).trim();
  if (!s) return null;
  const m = s.match(/^(.+?)\s*([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z\u4e00-\u9fff%]*)$/);
  if (m) {
    const name = m[1].trim();
    const qtyS = m[2];
    const unit = (m[3] || 'g').trim() || 'g';
    try {
      return [name, toFloat(qtyS), unit];
    } catch (e) {
      return [name, 0.0, unit];
    }
  }
  return [s, 0.0, 'g'];
}

/**
 * _recipe_bom_lines：按 sku_id / name 取菜谱主辅料行。
 * 优先 ctx.store.query；无 store 时回落 data.recipes / ctx.recipes。
 * 返回行数组（可能为空）；无菜谱返回 null。
 */
function recipeBomLines(ctx, data, sku) {
  if (!sku) return null;
  const key = String(sku);
  let row = null;
  if (ctx && ctx.store && typeof ctx.store.query === 'function') {
    try {
      let rows = ctx.store.query('SELECT main, aux, seasoning FROM recipes WHERE sku_id=?', [key]);
      if (arr(rows).length) row = rows[0];
      if (!row) {
        rows = ctx.store.query('SELECT main, aux, seasoning FROM recipes WHERE name=?', [key]);
        if (arr(rows).length) row = rows[0];
      }
    } catch (e) {
      row = null;
    }
  }
  if (!row) {
    const src = (ctx && Array.isArray(ctx.recipes)) ? ctx.recipes : (data && data.recipes);
    if (Array.isArray(src)) {
      row = src.find((r) => r && String(r.sku_id) === key)
        || src.find((r) => r && String(r.name) === key)
        || null;
    }
  }
  if (!row) return null;
  const lines = [];
  for (const col of [row.main, row.aux, row.seasoning]) {
    if (!truthy(col)) continue;
    let parsed = col;
    if (typeof col === 'string') {
      try {
        parsed = JSON.parse(col);
      } catch (e) {
        parsed = [col];
      }
    }
    if (Array.isArray(parsed)) lines.push(...parsed);
    else lines.push(parsed);
  }
  return lines;
}

/** _append_bom_deduct_logs：把菜谱行按 scale 写入盘点调整（负数）；返回匹配原料条数。 */
function appendBomDeductLogs(data, lines, scale, ref, noteSku) {
  if (data.logs === undefined || data.logs === null) data.logs = [];
  if (!Array.isArray(data.logs)) return 0;
  const logs = data.logs;
  let n = 0;
  for (const line of lines || []) {
    const parsed = parseBomQtyLine(line);
    if (!parsed) continue;
    const name = parsed[0];
    const qty = parsed[1];
    const unit = parsed[2];
    if (qty <= 0) continue;
    const need = r3e(qty * scale);
    const gid = resolveIngId(data, { name: name, ing_name: name });
    if (gid === null) continue;
    logs.push({
      type: '盘点调整',
      ing: gid,
      date: today(),
      qty: -Math.abs(need),
      ref: ref,
      note: 'BOM扣料 ' + name + ' ' + pf(need) + unit + ' ×' + num(scale, 0).toFixed(2) + '批 · ' + (noteSku || ''),
      source: 'queue'
    });
    n += 1;
  }
  return n;
}

/** _deduct_bom_for_workorder：工单备料扣料（菜谱默认 20 份/批） */
function deductBomForWorkorder(ctx, data, sku, woQty, wid) {
  if (!sku || !data || typeof data !== 'object') return '';
  const lines = recipeBomLines(ctx, data, sku);
  if (!truthy(lines)) return '无菜谱' + sku + '跳过扣料';
  const base = 20.0;
  const scale = woQty > 0 ? (woQty / base) : 1.0;
  const n = appendBomDeductLogs(data, lines, scale, '工单#' + wid + '·' + sku, sku);
  if (n <= 0) return 'BOM无匹配原料';
  const rb = rebuildStock(data);
  return 'BOM扣' + n + '料 scale=' + num(scale, 0).toFixed(2) + '；' + rb;
}

/**
 * _deduct_bom_for_sale_items：结账明细按份扣 BOM（菜谱基准 20 份/批）。
 * 若 table_id 对应工单已备料扣（bom_deducted=1），同 sku 跳过售卖扣，防双重扣料。
 */
function deductBomForSaleItems(ctx, data, items, ref, tableId) {
  if (!data || typeof data !== 'object' || !items) return '';
  const prepSkus = prepDeductedSkus(ctx, tableId);
  const dishById = {};
  const dishByName = {};
  for (const d of arr(data.dishes)) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
    if (d.id !== undefined && d.id !== null) dishById[String(d.id)] = d;
    if (d.name) dishByName[String(d.name)] = d;
  }
  let total = 0;
  const miss = [];
  const skipped = [];
  for (const it of items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    let sku = it.sku_id || it.sku;
    // 从菜单挂靠补 sku
    if (!sku || sku === it.name) {
      let d = null;
      if (it.id !== undefined && it.id !== null) d = dishById[String(it.id)];
      if (!d && it.name) d = dishByName[String(it.name)];
      if (d && d.sku_id) sku = d.sku_id;
    }
    if (!sku) sku = it.name || it.id;
    if (!sku) continue;
    const skuS = String(sku);
    if (prepSkus.has(skuS)) {
      skipped.push(skuS);
      continue;
    }
    let qty = 1.0;
    try {
      qty = toFloat(orDefault(it.qty, 1));
    } catch (e) {
      qty = 1.0;
    }
    let lines = recipeBomLines(ctx, data, sku);
    if (!truthy(lines)) {
      lines = recipeBomLines(ctx, data, it.name || '');
    }
    if (!truthy(lines)) {
      miss.push(skuS);
      continue;
    }
    const scale = qty > 0 ? (qty / 20.0) : 0.0;
    total += appendBomDeductLogs(data, lines, scale, ref, sku + '×' + pf(qty));
  }
  const tips = [];
  if (skipped.length) tips.push('备料已扣跳过:' + skipped.slice(0, 4).join('/'));
  if (total <= 0) {
    if (miss.length) tips.push('无菜谱:' + miss.slice(0, 4).join('/'));
    else if (!skipped.length) tips.push('BOM无匹配原料');
    return tips.length ? tips.join('；') : '';
  }
  const rb = rebuildStock(data);
  tips.push('售卖扣' + total + '料；' + rb);
  return tips.join('；');
}

module.exports = {
  wireTableState,
  findPosTable,
  billSummaryOf,
  applyPosTableState,
  applyPosTableUpsert,
  applyPosTableRemove,
  appendSale,
  applyPosServiceNote,
  applyPosVoid,
  applyPosPay,
  applyPosMergeSplit,
  prepDeductedSkus,
  parseBomQtyLine,
  recipeBomLines,
  appendBomDeductLogs,
  deductBomForWorkorder,
  deductBomForSaleItems
};
