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
const salesImport = require('../sales_import');

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

/* ---------- sale.update ---------- */

/**
 * sale.update：编辑销售单（审批队列执行，FP-SALE-12）。
 *
 * 与 recv.update 同构：定位单据（id 或单号）、已作废不可编辑、标量字段有传才改。
 * 金额口径与 sale.create 一致（ADR-008）：
 *   · 明细（lines/items）有传才重算售价合计 amount
 *   · discount 有传才改（0 ≤ discount ≤ amount）
 *   · receivable 默认 = amount − discount；显式传时仍受「不得超过 amount−discount」约束
 * 销售域特有约束：**应收不得小于累计实收**（否则欠款为负、账目矛盾）；
 *   本函数不改 payments（已收款只增不改），欠款 = 应收 − Σpayments 实时派生。
 * 保留 id/no（单号不变）、payments、作废留痕；记编辑人/时间（update_operator/update_at）。
 */
function applySaleUpdate(data, payload, ctx) {
  const c = ctx || {};
  if (!Array.isArray(data.sales)) throw new Error('data.sales 不是数组');
  const sid = payload.id != null ? String(payload.id)
    : (payload.sale_id != null ? String(payload.sale_id) : '');
  if (!sid) throw new Error('sale.update 缺 id / sale_id');
  const doc = findSale(data, sid);
  if (!doc) throw new Error('sale.update 未找到销售单: ' + sid);
  if (model.isVoided(doc)) throw new Error('已作废销售单不可编辑: ' + sid);

  // 先算后写：所有校验通过前不改 doc，避免校验失败留下半改快照
  let lines = doc.lines;
  let sub = model.subOf(doc);
  if (arr(payload.lines).length || arr(payload.items).length) {
    lines = normalizeLines(payload);
    if (!lines.length) throw new Error('sale.update 明细无有效行（数量与金额至少一项 > 0）');
    sub = r2(lines.reduce((a, l) => a + l.amount, 0));
  }
  if (!(sub > 0)) throw new Error('sale.update 售价合计必须大于 0');

  // 折扣：有传才改
  let discount = model.discountOf(doc);
  if (payload.discount != null) {
    discount = r2(num(payload.discount, 0));
    if (discount < 0) throw new Error('sale.update 折扣不能为负数');
    if (discount > sub + 0.01) throw new Error('sale.update 折扣超过售价合计：' + discount + ' > ' + sub);
  }

  // 应收：默认 = 售价合计 − 折扣；显式传仍受上界约束
  let receivable;
  if (payload.receivable != null) {
    receivable = r2(num(payload.receivable, 0));
    if (receivable < 0) throw new Error('sale.update 应收不能为负数');
    if (receivable > r2(sub - discount) + 0.01) {
      throw new Error('sale.update 应收不得超过「售价合计 − 折扣」：' + receivable + ' > ' + r2(sub - discount));
    }
  } else {
    receivable = r2(sub - discount);
  }

  // 销售域特有约束：应收不得小于累计实收（欠款不能为负）
  const paid = model.paidOf(doc);
  if (receivable < paid - 0.01) {
    throw new Error('sale.update 应收 ' + receivable + ' 小于已收款 ' + paid + '，请先作废该单或调整明细/折扣');
  }

  // 标量字段预校验（date 非法在写回前拦截，避免半改）
  let newDate;
  if (payload.date != null) {
    newDate = String(payload.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) throw new Error('sale.update 单日期非法: ' + payload.date);
  }

  // ---- 全部校验通过，统一写回 ----
  if (lines !== doc.lines) {
    doc.lines = lines;
    doc.qty = lines.reduce((a, l) => a + num(l.qty, 0), 0);
    doc.dish = lines.map((l) => l.name + 'x' + l.qty).join('；');
  }
  doc.amount = sub;
  doc.discount = discount;
  doc.receivable = receivable;
  if (newDate !== undefined) doc.date = newDate;
  if (payload.channel != null) doc.channel = String(payload.channel);
  if (payload.method != null) doc.method = String(payload.method);
  if (payload.note !== undefined) doc.note = String(payload.note || '');

  // 编辑痕迹（对齐 sale.void 的 rev/trace 留痕）
  const operator = payload.operator || 'QUEUE';
  doc.update_operator = operator;
  doc.update_at = payload.ts || c.now || nowIso();
  if (c.rev !== undefined && c.rev !== null) doc.update_rev = c.rev;
  if (c.traceId) doc.update_trace = c.traceId;

  const left = Math.max(0, r2(receivable - paid));
  return 'sale.update ' + (doc.no || sid) + ' 售价合计 ' + sub
    + ' · 折扣 ' + discount + ' · 应收 ' + receivable + ' · 已收款 ' + paid
    + ' · 欠款 ' + left + '（派生，未落库）';
}

/* ---------- 平台销售导入（FP-SALE-03/04/06） ---------- */

/**
 * sale.import：整批导入平台销售数据（审批队列执行，FP-SALE-03/04/06）。
 *
 * 与 recv.import 同型：预览只读（lib/sales_import.js），这里只接「提交」——整批一个动作。
 * 但 sales 导入与 recv 不同：recv 前端直接传 docs；sales 的金额口径红线要求
 *   「口径唯一出口 resolveSaleAmt，预览/提交/重算三处永远一致」，
 *   因此提交仍带原始 rows+sel，由本函数**重新调 buildSaleDocs 聚合**，避免前端本地重复算口径。
 *
 * payload：
 *   rows    原始解析行（parseSaleTable/parseSaleJson 的产物）
 *   mode    'detail'（按订单号拆单）| 'sum'（按日期汇总）
 *   sel     人工映射 { 平台菜名: 本店菜品id }（预览里指定的「未匹配 → 本店菜品」）
 *   src     平台来源 key（mt/other，见 SALE_SRC）
 *   settled 是否自动结算（true 则 payments 记一条「平台结算」全款）
 *   sumAmt  明细模式是否按订单汇总金额（false=按订单原价，true=整单合计）
 *
 * 写入快照：
 *   data.sales  追加销售单（channel=平台渠道、src/srcNo/batch/amtMode/srcAmt/settled 附加字段）
 *   data.dishAlias  写人工映射（与菜名映射配置页同源，映射一次后续导入自动命中）
 */
function applySaleImport(data, payload, ctx) {
  const c = ctx || {};
  if (data.sales === undefined || data.sales === null) data.sales = [];
  if (!Array.isArray(data.sales)) throw new Error('data.sales 不是数组');
  if (data.dishes === undefined || data.dishes === null) data.dishes = [];
  if (!Array.isArray(data.dishes)) throw new Error('data.dishes 不是数组');
  if (!data.dishAlias || typeof data.dishAlias !== 'object' || Array.isArray(data.dishAlias)) data.dishAlias = {};

  let rows = Array.isArray(payload && payload.rows) ? payload.rows : [];
  let mode = payload && payload.mode === 'detail' ? 'detail' : 'sum';
  const sel = (payload && payload.sel && typeof payload.sel === 'object') ? payload.sel : {};
  const srcKey = String((payload && payload.src) || 'mt');
  const settled = !!(payload && payload.settled);
  const sumAmt = !!(payload && payload.sumAmt);
  const source = String((payload && payload.source) || 'admin-web/dinein/sales/import');

  // 优先复用「原始文件」重新解析（口径唯一，且避免 rows 经 JSON 序列化后 NaN→null 的精度损失）；
  // 亦兼容直接传 rows（供后端测试/脚本调用）。
  if (!rows.length && payload && (payload.contentBase64 || payload.bytes)) {
    const lr = salesImport.loadSaleRows({ fileName: payload.fileName, contentBase64: payload.contentBase64, bytes: payload.bytes });
    if (!lr.ok) throw new Error('sale.import 文件解析失败：' + lr.error);
    rows = lr.rows;
    mode = lr.mode;
  }

  if (!rows.length) throw new Error('sale.import 缺 rows/contentBase64（空批次已拒绝，未改动账面）');

  // ① 写人工菜名映射（未匹配菜名 → 本店菜品），与菜名映射配置页同源
  let aliasWrites = 0;
  for (const k of Object.keys(sel)) {
    const key = salesImport.cleanName(k);
    const dishId = String(sel[k] || '');
    if (!key || !dishId) continue;
    if (!salesImport.dishById(data.dishes, dishId)) throw new Error('sale.import 映射目标菜品不存在: ' + dishId);
    data.dishAlias[key] = { dish: dishId, mul: 1 };
    aliasWrites++;
  }

  // ② 统一口径：提交与预览复用同一 buildSaleDocs + resolveSaleAmt
  const built = salesImport.buildSaleDocs(rows, mode, sel, { dishes: data.dishes, dishAlias: data.dishAlias, sumAmt });
  const docs = built.docs;
  if (!docs.length) {
    throw new Error('sale.import 无可导入销售单'
      + (built.unmapped > 0 ? '（' + built.unmapped + ' 行菜品未匹配，请先在预览里指定映射）' : '（数量/金额无效）'));
  }

  // ③ 幂等：同一 src 下 srcNo（明细）或 日期（汇总）已存在且未作废 → 跳过
  const dups = salesImport.saleDupKeys(data.sales, srcKey);
  const def = salesImport.srcDefOf(srcKey);
  const batch = 'SB' + Date.now().toString(36).toUpperCase() + hex(4);

  let n = 0; let dup = 0;
  for (const d of docs) {
    const key = salesImport.saleDupKeyOf(srcKey, d);
    if (dups.has(key)) { dup++; continue; }
    const date = String(d.date || today()).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('sale.import 单日期非法: ' + d.date);
    const lines = arr(d.lines).map((l) => ({
      dish: String(l.dish || ''),
      name: String(l.dishName || l.dish || ''),
      qty: l.qty,
      price: l.price,
      amount: r2(num(l.qty, 0) * num(l.price, 0)),
    }));
    const row = {
      id: 'S' + Date.now().toString(36).toUpperCase() + hex(4),
      no: nextSaleNo(data.sales, date),
      date: date,
      dish: lines.map((l) => l.name + 'x' + l.qty).join('；') || '销售单',
      qty: lines.reduce((a, l) => a + num(l.qty, 0), 0),
      amount: d.sub,
      receivable: d.receivable,
      discount: d.discount,
      payments: settled && d.receivable > 0
        ? [{ amount: d.receivable, date: date, method: '平台结算', source: source, ts: c.now || nowIso() }]
        : [],
      lines: lines,
      channel: def.ch,
      method: '平台结算',
      note: String((payload && payload.note) || (def.name + '导入' + (d.srcNo ? ' ' + d.srcNo : ''))),
      operator: String((payload && payload.operator) || 'QUEUE'),
      ts: c.now || nowIso(),
      source: source,
      /* 导入附加字段（供批次撤回 / 事后重算 / 来源追溯） */
      src: srcKey,
      srcNo: d.srcNo || '',
      batch: batch,
      amtMode: d.amtMode || '',
      srcAmt: d.srcAmt || {},
      settled: settled ? 1 : 0,
    };
    data.sales.push(row);
    dups.add(key);
    n++;
  }

  if (!n) {
    throw new Error('sale.import 全部 ' + dup + ' 张已被幂等拦截（该' + def.name
      + '批次此前已导入过；如需重导，请先整批撤回后再导入）');
  }

  let msg = 'sale.import 已导入 ' + n + ' 张' + def.name + '销售单（批次 ' + batch + '）'
    + ' · 应收合计 ' + r2(docs.reduce((a, x) => a + num(x.receivable, 0), 0));
  if (settled) msg += ' · 已自动结算';
  if (dup) msg += ' · 幂等跳过 ' + dup + ' 张';
  if (aliasWrites) msg += ' · 新增菜名映射 ' + aliasWrites + ' 条';
  return msg;
}

/**
 * sale.batch_void：整批撤回外部销售数据（审批队列执行，FP-SALE-04）。
 *
 * 与 sale.void 同红线：只置 status='已作废' 并留痕，**绝不物理删除**。
 * FP-SALE-13 决策：作废不回补库存——本域销售单本身不扣 BOM 料，作废只留痕；
 *   且撤回后该批次销售单不再占用幂等键（saleDupKeys 跳过作废单），可重新导入同一批数据。
 */
function applySaleBatchVoid(data, payload, ctx) {
  const c = ctx || {};
  if (!Array.isArray(data.sales)) throw new Error('data.sales 不是数组');
  const batch = String((payload && payload.batch) || '');
  if (!batch) throw new Error('sale.batch_void 缺 batch');
  const list = arr(data.sales).filter((s) => s && s.batch === batch);
  if (!list.length) throw new Error('sale.batch_void 未找到该批次（可能已撤回或批次号有误）: ' + batch);
  const operator = String((payload && payload.operator) || 'QUEUE');
  const reason = String((payload && payload.reason) || ('整批撤回 ' + batch));
  let n = 0;
  for (const s of list) {
    if (model.isVoided(s)) continue;
    s.status = '已作废';
    s.void_operator = operator;
    s.void_at = (payload && payload.ts) || c.now || nowIso();
    if (c.rev !== undefined && c.rev !== null) s.void_rev = c.rev;
    if (c.traceId) s.void_trace = c.traceId;
    s.void_reason = reason;
    s.note = (s.note || '') + ' 【整批撤回·' + operator + '】';
    n++;
  }
  return 'sale.batch_void 批次 ' + batch + ' 已整批撤回 ' + n + ' 张（作废留痕，不回补库存；可重新导入该批次数据）';
}

/**
 * sale.amt_recalc：对某批次按新口径事后重算金额（审批队列执行，FP-SALE-05）。
 *
 * 复用 resolveSaleAmt（口径唯一出口），依据落库的 srcAmt（原始金额）重新计算 amount/discount/receivable，
 * 修正「导入时用错口径 / 平台事后补扣费」导致的金额偏差；只改金额，不动明细行与单号。
 */
function applySaleAmtRecalc(data, payload) {
  if (!Array.isArray(data.sales)) throw new Error('data.sales 不是数组');
  const batch = String((payload && payload.batch) || '');
  if (!batch) throw new Error('sale.amt_recalc 缺 batch');
  const mode = (payload && payload.mode) || null;
  if (mode && !salesImport.SALE_AMT_MODES[mode]) throw new Error('sale.amt_recalc 未知口径: ' + mode);
  const rate = (payload && payload.rate != null && payload.rate !== '') ? payload.rate : null;
  let n = 0;
  for (const s of arr(data.sales)) {
    if (!s || s.batch !== batch) continue;
    if (model.isVoided(s)) continue;
    const rr = salesImport.resolveSaleAmt(Object.assign({}, s.srcAmt || {}), mode, { rate });
    if (!isFinite(rr.receivable)) continue;
    const sub = r2(arr(s.lines).reduce((a, l) => a + num(l.qty, 0) * num(l.price, 0), 0));
    let disc = r2(sub - rr.receivable); if (disc < 0) disc = 0;
    s.amount = sub;
    s.discount = disc;
    s.receivable = r2(sub - disc);
    if (mode) s.amtMode = mode;
    s.srcAmt = rr.srcAmt;
    if (s.settled && s.receivable > 0) {
      s.payments = [{ amount: s.receivable, date: String(s.date || today()).slice(0, 10), method: '平台结算' }];
    }
    n++;
  }
  if (!n) throw new Error('sale.amt_recalc 该批次没有可按此口径重算的单据: ' + batch);
  return 'sale.amt_recalc 已按口径 ' + (mode || '自动') + ' 重算 ' + n + ' 张（批次 ' + batch + '）';
}

/**
 * sale.alias_set：写入「平台菜名 → 本店菜品」映射（审批队列执行，FP-SALE-06）。
 * 与导入时的人工映射同源；配置后，后续导入同一平台菜名会被三级匹配第一级「别名」命中。
 */
function applyDishAliasSet(data, payload) {
  if (!data.dishAlias || typeof data.dishAlias !== 'object' || Array.isArray(data.dishAlias)) data.dishAlias = {};
  const name = salesImport.cleanName(String((payload && payload.name) || ''));
  const dishId = String((payload && payload.dish) != null ? payload.dish : ((payload && payload.dish_id) || ''));
  const mul = num((payload && payload.mul), 1) || 1;
  if (!name) throw new Error('sale.alias_set 缺平台菜名');
  if (!dishId) throw new Error('sale.alias_set 缺本店菜品');
  const dish = salesImport.dishById(data.dishes, dishId);
  if (!dish) throw new Error('sale.alias_set 菜品不存在: ' + dishId);
  data.dishAlias[name] = { dish: dishId, mul: mul };
  return 'sale.alias_set 菜名映射已保存: ' + name + ' → ' + dish.name + '（×' + mul + '）';
}

/** sale.alias_delete：删除菜名映射（审批队列执行，FP-SALE-06）。 */
function applyDishAliasDelete(data, payload) {
  if (!data.dishAlias || typeof data.dishAlias !== 'object' || Array.isArray(data.dishAlias)) return 'sale.alias_delete 无映射可删';
  const name = salesImport.cleanName(String((payload && payload.name) || ''));
  if (!name) throw new Error('sale.alias_delete 缺平台菜名');
  if (!(name in data.dishAlias)) throw new Error('sale.alias_delete 映射不存在: ' + name);
  delete data.dishAlias[name];
  return 'sale.alias_delete 映射已删除: ' + name;
}

module.exports = {
  applySaleCreate,
  applySalePay,
  applySaleVoid,
  applySaleUpdate,
  applySaleImport,
  applySaleBatchVoid,
  applySaleAmtRecalc,
  applyDishAliasSet,
  applyDishAliasDelete,
  nextSaleNo,
};
