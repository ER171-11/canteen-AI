'use strict';
/*
 * lib/algorithms/sale.js — 销售收银写侧执行器（FP-SALE-07/08/11）
 *
 * 口径前置：ADR-008（销售应收模型按单日期）、ADR-009（销售端录销售单，统一业务处理队列）。
 * 与进货单 `recv.update / recv.void / recv.pay`（inventory.js）**完全同构**：
 *   · 唯一写入口：只在 `POST /api/actions` → 审批 → 消费器 → 快照回写这条路上被调用，
 *     前端不得直写 `sales[]`（红线①）；未注册即判 need-manual（registry.js 注册）。
 *   · 派生值不落库：欠款 = receivable − Σ payments.amount 实时算，**不存欠款字段**（红线②）。
 *   · 作废不物理删除：保留原单行，记作废人/时间/rev/trace（红线④，对齐 recv.void）。
 *   · rev 乐观锁由 actions.js `confirm`（409）与 consumer.js 的 baseRev 承担，执行器只做业务校验。
 *
 * 覆盖动作：
 *   sale.create → applySaleCreate（新增销售单，含 receivable/discount/payments 初值）
 *   sale.void   → applySaleVoid（作废留痕）
 *   sale.pay    → applySalePay（分次收款：**只**追加 payments，不动 receivable）
 */

const crypto = require('crypto');
const { today, nowIso, num, r2, arr } = require('./util');
const model = require('../sales_model');

/* ---------- 通用辅助 ---------- */

/** uuid.uuid4().hex[:n]（与 pos.js appendSale 同法） */
function hex(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

/** 单号：XS + 日期紧凑 + 3 位流水（同日既有单号最大流水 + 1） */
function nextSaleNo(sales, date) {
  const prefix = 'XS' + String(date).replace(/-/g, '');
  let max = 0;
  for (const s of arr(sales)) {
    const no = String((s && (s.no || s.id)) || '');
    if (no.indexOf(prefix) !== 0) continue;
    const n = parseInt(no.slice(prefix.length), 10);
    if (isFinite(n) && n > max) max = n;
  }
  return prefix + String(max + 1).padStart(3, '0');
}

/** 定位销售单：id 或 单号 命中 */
function findSale(data, id) {
  return arr(data.sales).find((s) => s && (String(s.id) === id || String(s.no) === id)) || null;
}

/** 明细行归一：{dish|sku|name, qty, price, amount}（与 export.saleLines 的读取口径一致） */
function normalizeLines(payload) {
  const raw = arr(payload.lines).length ? arr(payload.lines) : arr(payload.items);
  const lines = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const ref = it.dish != null ? it.dish : (it.sku != null ? it.sku : it.name);
    const qty = num(it.qty, 0);
    const price = num(it.price != null ? it.price : it.unit_price, 0);
    const amount = it.amount != null ? r2(num(it.amount, 0)) : r2(qty * price);
    if (qty === 0 && amount === 0) continue;
    const line = {
      dish: ref != null ? String(ref) : null,
      name: String(it.name || it.dish_name || ref || ''),
      qty: qty,
      price: price,
      amount: amount,
    };
    if (it.unit != null) line.unit = String(it.unit);
    lines.push(line);
  }
  return lines;
}

/* ---------- sale.create ---------- */

/**
 * sale.create：新增销售单（审批队列执行）。
 *
 * 计算口径（ADR-008 §2.5，旧版字段名不换）：
 *   amount（售价合计）= Σ 明细金额（无明细时取 payload.amount）
 *   discount         = payload.discount（默认 0）
 *   receivable       = 售价合计 − discount（显式传 receivable 时以显式值为准，并做越界校验）
 *   payments         = 首付款 > 0 时的一条 { date, amount, method, source, ts }
 * 欠款不在此处写入——它是 receivable − Σpayments 的派生值。
 *
 * 失败一律 throw（消费器置 failed），绝不静默截断（红线⑥）。
 */
function applySaleCreate(data, payload) {
  if (data.sales === undefined || data.sales === null) data.sales = [];
  if (!Array.isArray(data.sales)) throw new Error('data.sales 不是数组');

  const date = String(payload.date || today()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('sale.create 单日期非法: ' + payload.date);

  const lines = normalizeLines(payload);
  const sub = lines.length
    ? r2(lines.reduce((a, l) => a + l.amount, 0))
    : r2(num(payload.amount, 0));
  if (!(sub > 0)) throw new Error('sale.create 售价合计必须大于 0（请填明细或 amount）');

  const discount = r2(num(payload.discount, 0));
  if (discount < 0) throw new Error('sale.create 折扣不能为负数');
  if (discount > sub + 0.01) throw new Error('sale.create 折扣超过售价合计：' + discount + ' > ' + sub);

  const receivable = payload.receivable != null ? r2(num(payload.receivable, 0)) : r2(sub - discount);
  if (receivable < 0) throw new Error('sale.create 应收不能为负数');
  if (receivable > r2(sub - discount) + 0.01) {
    throw new Error('sale.create 应收不得超过「售价合计 − 折扣」：' + receivable + ' > ' + r2(sub - discount));
  }

  const paid = r2(num(payload.paid, 0));
  if (paid < 0) throw new Error('sale.create 首付不能为负数');
  if (paid > receivable + 0.01) {
    throw new Error('sale.create 首付超过应收：' + paid + ' > ' + receivable);
  }

  const method = String(payload.method || payload.pay_method || '现金/扫码');
  const payments = paid > 0
    ? [{
      amount: paid,
      date: String(payload.pay_date || date).slice(0, 10),
      method: method,
      source: payload.source || 'admin-web/dinein/sales',
      ts: payload.ts || nowIso(),
    }]
    : [];

  const now = new Date();
  const qty = lines.length ? lines.reduce((a, l) => a + num(l.qty, 0), 0) : num(payload.qty, 1);
  const row = {
    id: 'S' + String(now.getFullYear())
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0')
      + String(now.getHours()).padStart(2, '0')
      + String(now.getMinutes()).padStart(2, '0')
      + hex(4),
    no: nextSaleNo(data.sales, date),
    date: date,
    hour: num(payload.hour, now.getHours()),
    dish: String(payload.dish || payload.bill_summary
      || (lines.length ? lines.map((l) => l.name + 'x' + l.qty).join('；') : '销售单')),
    qty: qty,
    amount: sub,
    receivable: receivable,
    discount: discount,
    payments: payments,
    channel: String(payload.channel || '堂食'),
    method: method,
    /* 不写 status：结清/有欠款是 应收 vs Σpayments 的派生结论（lib/sales_model.statusOf）；
     * 只有 sale.void 会写 status='已作废'——那是「作废」这一事实本身，不是派生态。 */
    note: String(payload.note || ''),
    operator: String(payload.operator || 'QUEUE'),
    ts: payload.ts || nowIso(),
    source: payload.source || 'admin-web/dinein/sales',
  };
  if (lines.length) row.lines = lines;
  if (payload.table_id != null) row.table_id = String(payload.table_id);
  if (payload.platform != null) row.platform = String(payload.platform);

  data.sales.push(row);

  const debt = Math.max(0, r2(receivable - paid));
  return 'sale.create ' + row.no + ' ' + date + ' 售价合计 ' + sub
    + ' · 折扣 ' + discount + ' · 应收 ' + receivable + ' · 首付 ' + paid
    + ' · 欠款 ' + debt + '（派生，未落库）';
}

/* ---------- sale.pay ---------- */

/**
 * sale.pay：分次收款 / 欠款清收（FP-SALE-11，审批队列执行）。
 *
 * **只**往该单 `payments` 追加一条记录：不改 receivable、不碰 amount/discount/库存
 * （与 recv.pay 同构；欠款 = 应收 − Σpayments 由 report/export 侧实时派生）。
 * 校验一律在服务端强制，失败 throw → 消费器置 failed：
 *   · 必须能定位销售单（id 或 单号）
 *   · 已作废单不可收款
 *   · amount 必须 > 0，且不得超过当前欠款 + 0.01（幂等：重复提交会被「超过欠款」拒绝）
 */
function applySalePay(data, payload) {
  if (!Array.isArray(data.sales)) throw new Error('data.sales 不是数组');
  const sid = payload.sale_id != null ? String(payload.sale_id)
    : (payload.id != null ? String(payload.id) : '');
  if (!sid) throw new Error('sale.pay 缺 sale_id');
  const doc = findSale(data, sid);
  if (!doc) throw new Error('sale.pay 未找到销售单: ' + sid);
  if (model.isVoided(doc)) throw new Error('已作废销售单不可收款: ' + sid);

  const amount = r2(num(payload.amount, 0));
  if (!(amount > 0)) throw new Error('sale.pay 金额必须大于 0：' + payload.amount);

  const receivable = model.receivableOf(doc);
  const paid = model.paidOf(doc);
  const debt = r2(receivable - paid);
  if (amount > debt + 0.01) {
    throw new Error('sale.pay 金额超过欠款：本次 ' + amount + ' > 欠款 ' + Math.max(0, debt));
  }

  if (!Array.isArray(doc.payments)) doc.payments = [];
  doc.payments.push({
    amount: amount,
    date: String(payload.date || today()).slice(0, 10),
    method: String(payload.method || doc.method || '现金/扫码'),
    source: payload.source || 'admin-web/dinein/sales',
    ts: payload.ts || nowIso(),
  });

  const left = r2(receivable - (paid + amount));
  return 'sale.pay ' + (doc.no || sid) + ' 收款 ' + amount + ' 元（'
    + (payload.method || doc.method || '现金/扫码') + '）· 剩余欠款 ' + Math.max(0, left) + ' 元';
}

/* ---------- sale.void ---------- */

/**
 * sale.void：作废销售单（审批队列执行）。
 *
 * 红线④：只置 status='已作废' 并记作废人/时间/rev/trace/reason，**绝不 DELETE**（删除即丢审计）。
 * 幂等：已作废直接跳过。
 *
 * @param {object} ctx 队列上下文 { rev, traceId, now }（consumer.js 传入），用于留痕
 */
function applySaleVoid(data, payload, ctx) {
  const c = ctx || {};
  if (!Array.isArray(data.sales)) throw new Error('data.sales 不是数组');
  const sid = payload.id != null ? String(payload.id)
    : (payload.sale_id != null ? String(payload.sale_id) : '');
  if (!sid) throw new Error('sale.void 缺 id / sale_id');
  const doc = findSale(data, sid);
  if (!doc) throw new Error('sale.void 未找到销售单: ' + sid);
  if (model.isVoided(doc)) {
    return 'sale.void ' + (doc.no || sid) + ' 已作废（跳过）';
  }

  const operator = payload.operator || 'QUEUE';
  doc.status = '已作废';
  doc.void_operator = operator;
  /* 作废时刻优先取队列 ctx.now（与审计时间线一致），否则回落本机时间 */
  doc.void_at = payload.ts || c.now || nowIso();
  /* 记 rev：作废旧单的台账版本，便于审计定位「在哪个版本被作废」 */
  if (c.rev !== undefined && c.rev !== null) doc.void_rev = c.rev;
  if (c.traceId) doc.void_trace = c.traceId;
  if (payload.reason != null) doc.void_reason = String(payload.reason);
  doc.note = (doc.note || '') + ' 【已作废·' + operator + '】';

  /* 不物理删除：应收/实收/欠款聚合按 status 跳过该单（lib/sales_model.js isVoided） */
  const revTag = doc.void_rev !== undefined ? 'rev=' + doc.void_rev + ' ' : '';
  const left = Math.max(0, r2(model.receivableOf(doc) - model.paidOf(doc)));
  return 'sale.void ' + (doc.no || sid) + ' → 已作废（' + revTag
    + '原单保留可查，未收欠款 ' + left + ' 元不再计入应收）；欠款为派生值，无需回写';
}

module.exports = {
  applySaleCreate,
  applySalePay,
  applySaleVoid,
  nextSaleNo,
};
