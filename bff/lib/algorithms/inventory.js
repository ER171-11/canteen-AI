'use strict';
/*
 * lib/algorithms/inventory.js — 进销存算法（迁移自 store-inventory/queue_consumer.py）
 *
 * 覆盖动作：
 *   restock.create / analysis.restock → applyRestock
 *   order.fromRestock                 → applyRestockToOrders（勾选建议行按供应商拆单生成正式 CG 单）
 *   po.create                         → applyOrderCreate（新建采购单 CG）
 *   po.edit                           → applyOrderEdit（编辑采购单）
 *   restock.config                    → applyRestockConfig（补货参数 → data.restock）
 *   restock.ignore                    → applyRestockIgnore（忽略勾选建议行）
 *   restock.adjust                    → applyRestockAdjust（行内改量/供应商/起订/整包并记回原料主数据）
 *   config.update                     → applyConfig
 *   rest.update                       → applyRest（写顶层 data.rest 餐厅名）
 *   ing.upsert                        → applyIngUpsert（主数据维护，**不再**用于存量校准）
 *   ing.batch                         → applyIngBatch（W3-02 批量改安全线/出成率，一条动作）
 *   ing.delete                        → applyIngDelete（W3-03 引用保护：有引用即禁删，改停用）
 *   quote.upsert                      → applyQuoteUpsert
 *   quote.delete                      → applyQuoteDelete（W2-02 删除单条报价，零命中显式报错）
 *   loss.report                       → applyLossReport
 *   recv.inbound                      → applyRecvInbound（含 Node 超集：paid / method / po / line.recvQty；
 *                                        draft:true = 凭证层登记「待审核」，不动账面）
 *   recv.post                         → applyRecvPost（待审核 → 已入库，唯一记账生效口，含版本比对）
 *   recv.accept                       → insertRecvAccept
 *   recv.pay                          → applyRecvPay（补付 / 欠款清收）
 *   recv.import                       → applyRecvImport（批量导入，批末统一 rebuildStock 一次）
 *   stock.count                       → applyStockCount + insertStockCount
 *                                       （W3-01 手工校准：payload.avg 改均价、强制填原因、
 *                                         流水 inCost 取「传入均价 ?? 现有均价」，修掉盘点均价清 0）
 *   order.mark                        → applyOrderMark
 *   vendor.upsert                     → upsertVendor
 *   vendor.delete                     → applyVendorDelete（有往来账禁删）
 *   supply.po                         → insertSupplyPo（同时 applyRestock）
 *
 * 约定：纯函数优先，直接原地修改 data（与 Python 版一致）；写库统一走 ctx.store。
 * ctx.store 不存在时跳过写库，仅改 data，并在返回值里注明「未写库」。
 */

const crypto = require('crypto');
const { today, nowIso, num, r2, r3, arr } = require('./util');
const { rebuildStock } = require('./stock');
const { resolveIngType, normalizeType } = require('../ing_type');
const supTerms = require('../supplier_terms');
/* 进货单状态口径唯一出口：凭证层「待审核」/ 账务层「已入库」两段式（lib/recv_status.js） */
const recvStatus = require('../recv_status');

/** 是否按「凭证层」登记（只落单据、不动账面），仅认显式 draft/pending_review */
function isDraftRecv(payload) {
  return !!(payload && (payload.draft === true || payload.pending_review === true));
}

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
 * 【唯一出口】单据应付口径（让利不摊入成本，抹零/整单优惠需求）：
 *   gross    = Σ lines[].amount（明细合计；行级 amount/unitCost/price 一律不动 → 库存成本不变）
 *   discount = 整单优惠/抹零（≥0，默认 0）
 *   payable  = gross − discount（实际应付）
 * 红线：discount 不得超过 gross（让利不得把应付减成负数）；折扣只减应付，
 *       绝不回改行级 amount/unitCost/price，也不影响 rebuildStock 的移动加权均价与最近进价 g.last。
 */
function resolveDocPayable(lines, discount) {
  const gross = r2((lines || []).reduce(
    (s, l) => s + (l && l.amount != null ? num(l.amount, 0) : num(l.qty, 0) * num(l.price, 0)),
    0
  ));
  const disc = r2(Math.max(0, num(discount, 0)));
  if (disc > gross + 0.01) {
    throw new Error('整单优惠 ' + disc + ' 超过明细合计 ' + gross + '（让利不得高于应付，请核对）');
  }
  return { gross: gross, discount: disc, payable: r2(gross - disc) };
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

/**
 * 进货/采购明细行原料引用归一（忠实回归旧版 openDocForm 的「＋新增原料」+ createIngFromImport）。
 *
 * 匹配顺序与 recv.import 一致：① 档案 id 精确 → ② 名称精确 → ③ 自动建档（待完善草稿）。
 * 供 recv.inbound / recv.update / po.create / po.edit 共用的**唯一出口**，避免各动作口径漂移。
 *
 * 返回原料 id；未命中且无名时原样返回 rawId（保持既有宽松行为，rebuildStock 会自然跳过）。
 */
function resolveIngRef(data, rawId, name, unit, cat) {
  if (data && data.ings == null) data.ings = [];
  const ings = arr(data && data.ings);
  const r = String(rawId || '').trim();
  const n = String(name || '').trim();
  let gid = '';
  if (r) {
    for (const g of ings) {
      if (String((g && g.id) || '') === r) { gid = r; break; }
    }
  }
  if (!gid && n) {
    for (const g of ings) {
      if (String((g && g.name) || '').trim() === n) { gid = String(g.id); break; }
    }
  }
  if (!gid && n) {
    gid = createIngFromImport(ings, n, unit, cat).id;
  }
  return gid || r;
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

/* ---------- 补货参数 / 建议单行（FP-PO-17/19/20） ----------
 * 只改 data.restock 与 data.plans（+ 记回 data.ings 的 sup/moq/packQty），**绝不触碰库存与均价**。
 * 对齐旧版 restockCfg()/curRestockPlan()/syncPlanStatus()/restockIgnore()/readRestockRows()（HTML:1835-2051）。
 */

/** 补货参数默认值（照抄旧版 RESTOCK_DEF，HTML:5355） */
function restockDef() {
  return { days: 30, lead: 1, gap: 1, useOnway: 1 };
}

function _plansArr(data) {
  if (data.plans === undefined || data.plans === null) data.plans = [];
  if (!Array.isArray(data.plans)) throw new Error('data.plans 不是数组，拒绝写入');
  return data.plans;
}

/** 定位建议单：显式 id/no 优先，否则取最新一张未忽略（对齐旧版 curRestockPlan，HTML:1861） */
function _findPlan(plans, key) {
  const k = String(key || '').trim();
  if (k) {
    for (const p of plans) if (p && (String(p.id || '') === k || String(p.no || '') === k)) return p;
    throw new Error('找不到补货建议单 ' + k);
  }
  const usable = plans.filter((p) => p && p.status !== 'ignored' && p.status !== '已忽略');
  usable.sort((a, b) => String(b.date || b.genAt || '').localeCompare(String(a.date || a.genAt || '')));
  if (!usable.length) throw new Error('当前没有待处理的补货建议单（请先在店内生成建议单）');
  return usable[0];
}

/** 行状态推导（对齐旧版 orderLineSt，HTML:1688） */
function _orderLineSt(l) {
  const st = l && l.st;
  if (st === 'canceled' || st === 'closed') return st;
  const q = num(l && l.qty, 0);
  const got = num(l && l.recvQty, 0);
  return (q > 0 && got >= q - 1e-6) ? 'closed' : 'normal';
}

/** 单状态推导（对齐旧版 orderSt，HTML:1694）：void/draft/closed 显式优先，否则全部行收齐即结案 */
function _orderStatus(o) {
  if (!o) return 'normal';
  if (o.status === 'void') return 'void';
  if (o.status === 'draft' || o.status === '草稿') return 'draft';
  if (o.status === 'closed') return 'closed';
  const ls = arr(o.lines);
  if (ls.length && !ls.some((l) => _orderLineSt(l) === 'normal')) return 'closed';
  return 'normal';
}

/** 建议单状态推进（对齐旧版 syncPlanStatus，HTML:1890）：行状态随关联采购单派生 → 单状态聚合 */
function _syncPlanStatus(data, p) {
  const orders = arr(data.orders);
  for (const l of arr(p.lines)) {
    if (!l || l.st === 'ignored' || !l.po) continue;
    const o = orders.find((x) => String(x && x.id) === String(l.po));
    if (!o) { l.st = 'pending'; delete l.po; continue; }
    const st = _orderStatus(o);
    l.st = st === 'void' ? 'ignored' : (st === 'closed' ? 'closed' : 'done');
  }
  const ls = arr(p.lines);
  if (!ls.length) { p.status = 'ignored'; return; }
  if (ls.every((l) => l.st === 'closed')) p.status = 'closed';
  else if (ls.every((l) => l.st === 'ignored' || l.st === 'closed')) p.status = 'ignored';
  else if (ls.some((l) => l.st !== 'pending')) p.status = 'part';
  else p.status = 'pending';
}

/**
 * restock.config（FP-PO-17）：补货参数配置 → data.restock。
 * days ≥ 1 取整；lead/gap ≥ 0；useOnway 归一 0/1（照抄旧版 openRestockCfg 保存，HTML:2045-2048）。
 */
function applyRestockConfig(data, payload) {
  const src = (payload && payload.restock && typeof payload.restock === 'object' && !Array.isArray(payload.restock))
    ? payload.restock : (payload || {});
  const cur = (data.restock && typeof data.restock === 'object' && !Array.isArray(data.restock))
    ? data.restock : restockDef();
  const pick = (k) => (src[k] != null ? src[k] : cur[k]);
  const days = Math.max(1, Math.floor(num(pick('days'), 30)));
  const lead = Math.max(0, num(pick('lead'), 1));
  const gap = Math.max(0, num(pick('gap'), 1));
  const useOnway = pick('useOnway') ? 1 : 0;
  data.restock = { days: days, lead: lead, gap: gap, useOnway: useOnway };
  return '补货参数已保存：days=' + days + ' lead=' + lead + ' gap=' + gap + ' useOnway=' + useOnway;
}

/**
 * restock.ignore（FP-PO-19）：忽略勾选的建议行（旧版 restockIgnore，HTML:2023-2029）。
 * 只把 `st='pending'` 的行置为 `ignored` 并推进建议单状态；不删行、不生成采购单。
 */
function applyRestockIgnore(data, payload) {
  const plans = _plansArr(data);
  const p = _findPlan(plans, payload.plan_id || payload.plan_no || payload.id);
  const ids = arr(payload.ing_ids || payload.ings).map((x) => String(x && x.ing ? x.ing : x));
  if (!ids.length) throw new Error('restock.ignore 缺 ing_ids（请先勾选要忽略的建议行）');
  let n = 0;
  for (const l of arr(p.lines)) {
    if (l && l.st === 'pending' && ids.indexOf(String(l.ing)) >= 0) { l.st = 'ignored'; n += 1; }
  }
  if (!n) throw new Error('restock.ignore 未命中任何待处理建议行（勾选行可能已转单/已忽略）');
  _syncPlanStatus(data, p);
  return '建议单 ' + (p.no || p.id || '') + ' 忽略 ' + n + ' 行（单状态 ' + p.status + '）';
}

/**
 * restock.adjust（FP-PO-20）：行内改采购量/供应商/起订量/整包 → 记回原料主数据 + 建议行。
 * 对齐旧版 readRestockRows（HTML:1978-1993）：
 *   - 原料主数据：`sup`（供应商）、`moq`（起订量）；整包规格写 **Node 超集字段 `packQty`**，
 *     不写 `ing.pack`（新系统 `pack`＝包规字符串，结算单用，覆盖会破坏主数据）。
 *   - 建议行：`qty`（采购量，> 0 才写）、`supplier`（供应商）。
 * 仅记录，不重算库存/不调 rebuildStock。
 */
function applyRestockAdjust(data, payload) {
  const plans = _plansArr(data);
  const p = _findPlan(plans, payload.plan_id || payload.plan_no || payload.id);
  const rows = arr(payload.rows || payload.items);
  if (!rows.length) throw new Error('restock.adjust 缺 rows（请填写要记回的建议行）');
  const ings = arr(data.ings);
  const byId = new Map();
  for (const g of ings) if (g && g.id != null) byId.set(String(g.id), g);
  const now = nowIso();
  let nLine = 0;
  const ingTouched = [];
  for (const r of rows) {
    const id = String((r && (r.ing || r.ing_id)) || '').trim();
    if (!id) continue;
    const g = byId.get(id);
    if (g) {
      let touched = false;
      if (r.supplier != null) {
        const v = String(r.supplier).trim();
        if (v !== String(g.sup || '')) { g.sup = v; touched = true; }
      }
      if (r.moq != null) {
        const v = Math.max(0, num(r.moq, 0));
        if (v !== num(g.moq, 0)) { g.moq = v; touched = true; }
      }
      if (r.packQty != null) {
        const v = Math.max(0, num(r.packQty, 0));
        if (v !== num(g.packQty, 0)) { g.packQty = v; touched = true; }
      }
      if (touched) { g._u = now; ingTouched.push(id); }
    }
    for (const l of arr(p.lines)) {
      if (String(l.ing) !== id) continue;
      if (r.qty != null && num(r.qty, 0) > 0) l.qty = r2(r.qty);
      if (r.supplier != null) l.supplier = String(r.supplier).trim();
      else if (!l.supplier && g) l.supplier = g.sup || '';
      nLine += 1;
    }
  }
  if (!nLine) throw new Error('restock.adjust 未命中任何建议行（请确认勾选行在当前建议单内）');
  _syncPlanStatus(data, p);
  return '建议单 ' + (p.no || p.id || '') + ' 调整 ' + nLine + ' 行，记回原料主数据 '
    + ingTouched.length + ' 项（' + ingTouched.join(',') + '）';
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
    /* 【Node 超集】整包规格（采购单位，数值）：与 `pack`（包规字符串，结算单用）分列，避免覆盖主数据 */
    if (payload.packQty != null) ing.packQty = Math.max(0, toFloat(payload.packQty));
    /* 【Node 超集】W4 食材/耗材类型（人工纠偏入口）：显式传入才改，缺省不动存量 */
    if (payload.type != null) ing.type = normalizeType(payload.type);
    /* 【Node 超集】W3 产品超链接：质检报告 URL（显式传入才写，缺省不写键，平价测试与 Python 逐字段一致） */
    if (payload.qc_report_url != null) ing.qc_report_url = payload.qc_report_url;
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
    /* 【Node 超集】W4 食材/耗材类型：显式传入优先，否则按名称自动识别（缺省 food，决策 #6/#7） */
    type: payload.type != null ? normalizeType(payload.type) : resolveIngType(name),
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
  /* 【Node 超集】W3 产品超链接：质检报告 URL（同样缺省不写键） */
  if (payload.qc_report_url != null) row.qc_report_url = payload.qc_report_url;
  ings.push(row);
  return 'ing 新建 ' + newId + ' ' + row.name + (row.pending ? '（待完善）' : '');
}

/* ---------- ing.batch（W3-02 / FP-ING-06） ---------- */

/**
 * ing.batch：批量设置「安全库存线 / 出成率」——整批一个动作（一条队列 = 一次审批）。
 *
 * 只改主数据字段（safe/safety/yld），**不碰 stock/avg**（存量校准走 stock.count，
 * 否则会被 rebuildStock 冲回）。零命中显式报错（红线 #7），不做静默空跑。
 */
function applyIngBatch(data, payload) {
  if (data.ings === undefined || data.ings === null) data.ings = [];
  if (!Array.isArray(data.ings)) throw new Error('data.ings 不是数组');
  const rawIds = Array.isArray(payload.ids) ? payload.ids
    : (Array.isArray(payload.ing_ids) ? payload.ing_ids : []);
  const ids = rawIds.map((x) => String(x).trim()).filter(Boolean);
  if (!ids.length) throw new Error('ing.batch 需要 ids（至少一项）');
  const hasSafe = payload.safe !== undefined && payload.safe !== null && String(payload.safe).trim() !== '';
  const hasYld = payload.yld !== undefined && payload.yld !== null && String(payload.yld).trim() !== '';
  if (!hasSafe && !hasYld) throw new Error('ing.batch 需要 safe 或 yld（至少一项）');
  const safeV = hasSafe ? toFloat(payload.safe) : null;
  if (hasSafe && safeV < 0) throw new Error('safe 不能为负');
  const yldV = hasYld ? clampYld(toFloat(payload.yld)) : null;

  const now = nowIso();
  let hit = 0;
  const missing = [];
  for (const g of arr(data.ings)) {
    if (!g || typeof g !== 'object' || ids.indexOf(String(g.id)) < 0) continue;
    hit += 1;
    if (hasSafe) { g.safe = safeV; g.safety = safeV; }
    if (hasYld) g.yld = yldV;
    g._u = now;
  }
  if (!hit) throw new Error('ing.batch 零命中：ids 未匹配任何原料（' + ids.join(',') + '）');
  for (const id of ids) {
    if (!arr(data.ings).some((g) => g && String(g.id) === id)) missing.push(id);
  }
  const parts = [];
  if (hasSafe) parts.push('安全线 ' + pf(safeV));
  if (hasYld) parts.push('出成率 ' + Math.round(yldV * 100) + '%');
  return 'ing.batch 更新 ' + hit + ' 个原料（' + parts.join(' / ') + '）'
    + (missing.length ? ' · 未匹配 ' + missing.length + ' 项' : '');
}

/* ---------- ing.delete（W3-03 / FP-ING-11） ---------- */

/** BOM 行 → 原料名（对象行取 name/ing；字符串行去掉尾部用量与单位），不猜别名 */
function bomLineName(line) {
  if (line && typeof line === 'object' && !Array.isArray(line)) {
    return String(line.name || line.ing || line.ing_name || '').trim();
  }
  const s = String(line == null ? '' : line).trim();
  const m = s.match(/^(.+?)\s*[0-9]+(?:\.[0-9]+)?\s*[a-zA-Z\u4e00-\u9fff%]*$/);
  return (m ? m[1] : s).trim();
}

/**
 * 原料被引用情况（W3-03 引用保护）。
 * 逐类计数，错误信息里写清「被什么引用」——红线 #7：不做静默删除，也不给模糊提示。
 *
 * 覆盖：库存流水 / 进货单 / 采购单 / 报价 / 出餐销售 / 配方（data.rec 绑定 + 菜谱主数据）。
 * 引用匹配口径：原料 id 精确；报价与配方另按原料名精确匹配（历史「按名录入」行）。
 */
function ingRefsOf(data, g) {
  const id = String(g.id);
  const name = String(g.name || '').trim();
  const refs = [];
  const bump = (k, n) => { if (n > 0) refs.push(k + ' ' + n); };
  const hasLine = (lines) => arr(lines).some((l) => l && l.ing != null && String(l.ing) === id);

  bump('库存流水', arr(data.logs).filter((l) => l && l.ing != null && String(l.ing) === id).length);
  bump('进货单', arr(data.recv).filter((r) => r && hasLine(r.lines)).length);
  bump('采购单', arr(data.orders).filter((o) => o && hasLine(o.lines)).length);
  bump('出餐销售', arr(data.sales).filter((s) => s && hasLine(s.lines)).length);
  bump('报价', arr(data.quotes).filter((q) => q && (String(q.ing) === id
    || (name && String(q.ing || '').trim() === name))).length);

  /* 配方：data.rec[dishId] = BOM 行数组；菜谱主数据在 data.recipes / data.ext.recipes */
  let recipeHits = 0;
  const nameHit = (lines) => arr(lines).some((l) => {
    if (l && typeof l === 'object' && !Array.isArray(l)) {
      if (l.ing != null && String(l.ing) === id) return true;
    }
    const n = bomLineName(l);
    return !!n && !!name && n === name;
  });
  if (data.rec && typeof data.rec === 'object' && !Array.isArray(data.rec)) {
    for (const k of Object.keys(data.rec)) if (nameHit(data.rec[k])) recipeHits += 1;
  }
  const recipes = arr(data.recipes).concat(arr(data.ext && data.ext.recipes));
  for (const r of recipes) {
    if (!r || typeof r !== 'object') continue;
    if (String(r.ing_sku || '') === id) { recipeHits += 1; continue; }
    if (['main', 'aux', 'seasoning', 'face_main'].some((k) => nameHit(r[k]))) recipeHits += 1;
  }
  bump('配方', recipeHits);
  return refs;
}

/**
 * ing.delete：删除原料（错建/重复档案清理）。
 *
 * 红线（沿用 dish.js / applyVendorDelete 先例）：
 *   · 有引用（流水/单据/报价/销售/配方）**禁删**——删掉会让台账、BOM 与比价表悬空，
 *     正确做法是把原料改为「停用」（on:false），历史台账保留；
 *   · 无引用才物理摘除 data.ings 一行（本域既定口径，同 order.delete / dish.delete）；
 *   · 零命中显式报错，不静默空跑。
 */
function applyIngDelete(data, payload) {
  if (data.ings === undefined || data.ings === null) data.ings = [];
  if (!Array.isArray(data.ings)) throw new Error('data.ings 不是数组');
  const key = String((payload && (payload.id || payload.ing_id || payload.name)) || '').trim();
  if (!key) throw new Error('ing.delete 缺 id/name');
  const idx = data.ings.findIndex((g) => g
    && (String(g.id) === key || String(g.name || '').trim() === key));
  if (idx < 0) throw new Error('找不到原料 ' + key);
  const g = data.ings[idx];
  const refs = ingRefsOf(data, g);
  if (refs.length) {
    throw new Error('原料「' + (g.name || g.id) + '」已被引用（' + refs.join(' / ')
      + '），不能删除（请改为「停用」on:false，台账保留）');
  }
  data.ings.splice(idx, 1);
  return 'ing 删除 ' + (g.id || '') + ' ' + (g.name || '');
}

/* ---------- quote.upsert ---------- */

/**
 * FP-PRICE-15「设为该原料默认供应商」：默认供应商是**原料**属性，不属于某条报价，
 * 因此在「新建」与「覆盖既有报价」两条路径上都要生效（Python 参考实现只在新建分支处理，
 * 导致同一 ing+src 二次录入时勾选无效；此为本版有意超集，消息与快照字段口径不变）。
 */
function bindDefaultSup(data, ing, src, payload) {
  if (!payload || !payload.set_default_sup) return; /* 真值判定，与 Python `payload.get("set_default_sup")` 平价 */
  for (const i of arr(data.ings)) {
    if (String(i.id) === ing) {
      i.sup = src;
      break;
    }
  }
}

/**
 * 报价归属键归一：原料名 → 原料 id（历史「按名录入」的存量报价就地自愈）；无对应原料时原样返回。
 * 目的：幂等键 `ing+src` 必须落在同一口径上，否则同一供应商同一原料会被重复建条。
 */
function quoteIngKey(data, v) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return raw;
  const ings = arr(data.ings);
  for (const g of ings) if (String(g.id) === raw) return raw;
  for (const g of ings) if (String(g.name) === raw) return String(g.id);
  return raw;
}

/**
 * quote.upsert：供应商报价（按 ing+src 幂等覆盖）。
 */
/* ---------- quote.upsert / quote.import（W2-04 / FP-PRICE-12，ADR-013 D2） ---------- */

/** 取下一个报价 id（Q 前缀，纯数字递增，对齐旧版 id 形态） */
function nextQuoteId(quotes) {
  const nums = [];
  for (const q of quotes) {
    const m = String(q.id || '');
    if (m[0] === 'Q' && /^\d+$/.test(m.slice(1))) nums.push(parseInt(m.slice(1), 10));
  }
  return 'Q' + (nums.length ? Math.max(...nums) + 1 : 200);
}

/**
 * quote 单行写入（被 upsert / import 共用）：
 *   append=false（默认，手工录入）：按 ing+src 幂等**覆盖**；
 *   append=true（导入）：按 ing+src+price(+date) 去重**追加**，命中完全相同的行则跳过（不覆盖）。
 * 返回 {action:'update'|'append'|'skip', msg}。
 */
function upsertQuote(quotes, payload, data, append) {
  const ing = quoteIngKey(data, payload.ing || payload.ing_id);
  const src = String(payload.src || payload.supplier || '').trim();
  if (!ing || !src) throw new Error('缺少 ing / src');
  if (payload.price == null) throw new Error('缺少 price');
  const price = toFloat(payload.price);
  const now = nowIso();
  const per = payload.per || 'buy';
  const date = payload.date || today();
  const note = payload.note != null ? payload.note : '';

  if (append) {
    for (const q of quotes) {
      if (quoteIngKey(data, q.ing) === ing && String(q.src) === src
        && toFloat(q.price) === price && (q.date || today()) === date) {
        return { action: 'skip', msg: 'quote 跳过重复 ' + ing + '@' + src + ' ¥' + pf(price) };
      }
    }
  } else {
    for (const q of quotes) {
      /* 幂等键归一：历史按名录入的行（q.ing = 原料名）与本次按 id 提交视为同一报价，就地改写归属键 */
      if (quoteIngKey(data, q.ing) === ing && String(q.src) === src) {
        if (String(q.ing) !== ing) q.ing = ing;
        q.price = price;
        q.per = per;
        q.date = date;
        if (note) q.note = note;
        q._u = now;
        bindDefaultSup(data, ing, src, payload);
        return { action: 'update', msg: 'quote 更新 ' + ing + '@' + src + ' → ¥' + pf(price) };
      }
    }
  }
  const qid = payload.id || nextQuoteId(quotes);
  quotes.push({
    id: qid,
    ing: ing,
    name: payload.name || ing,
    src: src,
    supplier: src,
    price: price,
    per: per,
    unit: payload.unit || '',
    date: date,
    note: note,
    _u: now
  });
  bindDefaultSup(data, ing, src, payload);
  return { action: 'append', msg: 'quote 新建 ' + qid + ' ' + ing + '@' + src + ' ¥' + pf(price) };
}

/**
 * quote.upsert：供应商报价（默认按 ing+src 幂等覆盖；payload.append=true 时按 ing+src+price 去重追加，ADR-013 D2）。
 */
function applyQuoteUpsert(data, payload) {
  if (data.quotes === undefined || data.quotes === null) data.quotes = [];
  if (!Array.isArray(data.quotes)) throw new Error('data.quotes 不是数组');
  const r = upsertQuote(data.quotes, payload, data, !!payload.append);
  return r.msg;
}

/**
 * quote.import（W2-04 / FP-PRICE-12，ADR-013 D2）：批量导入比价结果（整批一个动作）。
 * 红线（沿用旧 ADR-003）：只写 data.quotes；不写 logs / ings.stock / ings.avg / recv；
 *   conv ≠ 1 的原料默认跳过，不在导入里自动推断跨单位价格（见 lib/quote_import.js）。
 * 内部复用 lib/quote_import.js 的解析/去重口径（与预览端点一致），保证「预览即所见、提交即所得」。
 */
function applyQuoteImport(data, payload) {
  const qimp = require('./../quote_import');
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  const r = qimp.runQuoteImport(data, items);
  return 'quote.import 追加 ' + r.appended + ' 条 · 跳过(重复/跨单位) ' + r.skipped
    + ' 条 · 非法 ' + r.invalid + ' 条';
}

/* ---------- quote.delete（W2-02 / FP-PRICE-07） ---------- */

/**
 * quote.delete：删除**单条**外部报价（错录 / 供应商撤回报价）。
 *
 * 定位优先级：`id`（报价主键）→ `ing + src`（原料 + 供应商，即 quote.upsert 的幂等键）。
 * 红线 #6：只摘 data.quotes 里这一行，**不动物料主数据、不动库存流水、不动进货单**；
 * 红线 #7：命中 0 行必须显式报错，不静默成功（避免「以为删了其实没删」）。
 * 留痕：动作本身走 /api/actions 队列（谁、何时、删了哪条），审批中心可见可驳回。
 */
function applyQuoteDelete(data, payload) {
  const p = payload || {};
  if (!Array.isArray(data.quotes)) throw new Error('data.quotes 不是数组');
  const quotes = data.quotes;
  const id = String(p.id || p.quote_id || '').trim();
  const ingRaw = p.ing || p.ing_id;
  const src = String(p.src || p.supplier || '').trim();
  if (!id && (!ingRaw || !src)) throw new Error('quote.delete 需要 id，或 ing + src');

  let idx = -1;
  if (id) {
    idx = quotes.findIndex((q) => String((q && q.id) == null ? '' : q.id) === id);
  } else {
    const ing = quoteIngKey(data, ingRaw);
    idx = quotes.findIndex((q) => q && quoteIngKey(data, q.ing) === ing && String(q.src) === src);
  }
  if (idx < 0) throw new Error('quote.delete 未命中：' + (id ? 'id=' + id : String(ingRaw) + '@' + src));

  const gone = quotes[idx];
  quotes.splice(idx, 1);
  return 'quote 删除 ' + String((gone && gone.id) || '?')
    + ' ' + String((gone && gone.ing) || '') + '@' + String((gone && gone.src) || '')
    + ' ¥' + pf(gone && gone.price);
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
  /* 凭证层登记（ADR-004 §2.5）：draft:true → status='待审核'，单据立即可见/可打结算单，
     但**不进库存、不进应付**；记账生效由 recv.post 审批后完成 */
  const draft = isDraftRecv(payload);
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
  let drafted = null; /* 本次登记出来的待审核单（末尾写审核基线） */
  if (rid) {
    let found = false;
    for (const r of recv) {
      if (String(r.id || r.no) === String(rid)) {
        r.status = payload.status || (draft ? recvStatus.PENDING_REVIEW : recvStatus.EFFECTIVE);
        r.note = (r.note || '') + (draft ? ' 【登记待审核】' : ' 【云端确认入库】');
        drafted = r;
        found = true;
        msg = 'recv ' + rid + ' → ' + (draft ? '待审核（未记账）' : '已入库');
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
      note: (draft ? '【待审核·自采购 ' : '【云端入库·自采购 ') + (src.no || oid) + '】',
      method: src.method || '现金/转账',
      status: draft ? recvStatus.PENDING_REVIEW : recvStatus.EFFECTIVE,
      from_order: src.id || oid
    };
    /* 超集：整单优惠/抹零 —— 仅在有让利时才写字段（0 时不落库，与 Python 逐字段一致） */
    const srcDisc = num(src.discount, 0);
    if (srcDisc > 0) {
      inbound.gross = src.gross != null ? num(src.gross, 0) : (src.payable || 0);
      inbound.discount = srcDisc;
    }
    recv.push(inbound);
    drafted = inbound;
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
        ing: resolveIngRef(data, it.ing_id || it.ing, it.name, it.unit, it.cat),
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
    const amt = resolveDocPayable(lines, payload.discount);
    const payable = amt.payable;
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
      payable: amt.payable,
      payments: payments,
      note: (draft ? '【待审核·登记】' : '【云端入库】') + (payload.note || ''),
      method: method,
      status: draft ? recvStatus.PENDING_REVIEW : recvStatus.EFFECTIVE
    };
    if (amt.discount > 0) {
      inbound.gross = amt.gross;
      inbound.discount = amt.discount;
    }
    /* 【Node 超集】关联采购单：旧版只把选中的采购单号写到 recv.po（HTML:1650-1654），
       采购单侧的收货进度回写由旧版 syncAllOrderRecv() 负责——Node 侧**尚未实现**（属采购管理页欠账），
       故此处只登记单向关联，不改 data.orders：界面已明示，不做静默假装。 */
    if (payload.po) inbound.po = String(payload.po);
    recv.push(inbound);
    drafted = inbound;
    msg = (draft ? 'recv 登记待审核 ' : 'recv 追加入库 ') + inbound.no + '（' + lines.length + ' 行）'
      + (paid > 0 ? '，实付 ' + pf(paid) : '');
  }

  if (draft) {
    /* 审核基线：审批人看到的就是这一版（金额/行数），recv.post 用它比对「确认后被改过」 */
    if (drafted) {
      drafted.review_snapshot = {
        at: nowIso(), payable: num(drafted.payable, 0), lines: arr(drafted.lines).length,
        by: payload.operator || null
      };
    }
    return msg + '；未计入库存与应付（待审核，确认入库后生效）';
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

  /* 凭证层未记账的单不计入应付，付款会挂在「未生效」的单上 → 显式拒绝，先确认入库 */
  if (recvStatus.isPendingReview(doc)) {
    throw new Error('该进货单待审核（未计入应付），不能补付：请先确认入库再登记付款');
  }

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

  /* 整单优惠/抹零：可独立修改（不依赖改明细）；先落到临时量，统一校验通过后再写，避免超优惠残留 */
  let recalc = false;
  let pendingDiscount = num(doc.discount, 0);
  if (payload.discount !== undefined && payload.discount !== null && payload.discount !== '') {
    pendingDiscount = num(payload.discount, 0);
    recalc = true;
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
        ing: resolveIngRef(data, it.ing_id || it.ing, it.name, it.unit, it.cat),
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
    recalc = true;
  }

  /* 明细或优惠任一变化 → 统一重算 gross/discount/payable（唯一出口） */
  if (recalc) {
    const amt = resolveDocPayable(doc.lines || [], pendingDiscount);
    doc.payable = amt.payable;
    if (amt.discount > 0) {
      doc.gross = amt.gross;
      doc.discount = amt.discount;
    } else {
      delete doc.gross;
      delete doc.discount;
    }
  }

  /* 付款：保留带 source/ts 的 补付 记录，用编辑表单「实付」覆盖**初始**付款 */
  const prior = Array.isArray(doc.payments)
    ? doc.payments.filter((p) => p && (p.source || p.ts))
    : [];
  const priorSum = Math.round(prior.reduce((s, p) => s + (toFloat(p.amount) || 0), 0) * 100) / 100;
  if (payload.paid !== undefined && payload.paid !== null && payload.paid !== '') {
    const paid = Math.round(toFloat(payload.paid) * 100) / 100;
    if (paid < 0) throw new Error('recv.update paid 不能为负数');
    /* 超付口径 = 本次初始实付 + 已登记补付 合计不得超过应付
       （否则像「补付已结清后再编辑又全额填实付」会把实付累积翻倍） */
    if (paid + priorSum > num(doc.payable, 0) + 0.01) {
      throw new Error(
        'recv.update 实付 ' + paid + ' + 已登记补付 ' + priorSum +
        ' 超过应付 ' + num(doc.payable, 0) + '（超付请核对后重填）',
      );
    }
    const method = pt(payload.method) || doc.method || '现金/转账';
    const initial = paid > 0 ? [{ amount: paid, date: doc.date || today(), method: method }] : [];
    doc.payments = initial.concat(prior);
    doc.method = method;
  }
  /* 未传 paid：保留原 payments（初始 + 补付）不变 */

  /* 凭证层（待审核/草稿）单未计入库存：只改单据，不重算台账 */
  if (!recvStatus.isEffective(doc)) {
    return 'recv.update ' + (doc.no || rid) + ' 已更新（待审核·未记账，库存与应付不变）';
  }
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

/* ---------- recv.post（凭证 → 记账生效） ---------- */

/** 差异二次确认词：确认后单据被人改过时必须输入，防「批了 A、付了 B」 */
const POST_CONFIRM_WORD = '确认入库';

/**
 * recv.post：把「待审核」进货单推进为「已入库」，此时才进库存/均价/应付（ADR-004 §2.5）。
 *
 * 与 recv.inbound 的分工：
 *   · recv.inbound(draft:true) = 凭证层登记：单据立即可见、可打结算单，账面零变化；
 *   · recv.post                 = 账务层生效：唯一把单据计入台账的那一步，必须经审批确认。
 *
 * 版本比对（D-C）：审批人看到的应付与执行时不一致（确认后被编辑），必须输入确认词
 *   才能按新金额记账，并把 before→after 写进单据（posted_diff）与动作回执，不静默放行。
 *
 * 幂等：已是「已入库」直接跳过；已作废显式拒绝；状态不是「待审核」显式拒绝（不静默降级）。
 */
function applyRecvPost(data, payload, ctx) {
  const c = ctx || {};
  if (!Array.isArray(data.recv)) throw new Error('data.recv 不是数组');
  const rid = payload.recv_id != null ? String(payload.recv_id)
    : (payload.id != null ? String(payload.id) : '');
  if (!rid) throw new Error('recv.post 缺 recv_id');
  const doc = data.recv.find((p) => p && (String(p.id) === rid || String(p.no) === rid));
  if (!doc) throw new Error('recv.post 未找到进货单: ' + rid);
  if (recvStatus.isVoided(doc)) throw new Error('已作废进货单不可记账: ' + rid);
  if (recvStatus.isEffective(doc)) return 'recv.post ' + (doc.no || rid) + ' 已入库（跳过）';
  if (!recvStatus.isPendingReview(doc)) {
    throw new Error('仅「待审核」进货单可记账生效（当前状态：'
      + (recvStatus.statusOf(doc) || '空') + '）');
  }

  const curPayable = Math.round(num(doc.payable, 0) * 100) / 100;
  const base = (doc.review_snapshot && typeof doc.review_snapshot === 'object')
    ? doc.review_snapshot : null;
  /* 优先用前端在确认弹窗里带上来的应付（= 审批人看到的那一版），缺失才回落到登记基线 */
  const expectRaw = payload.expect_payable != null && payload.expect_payable !== ''
    ? payload.expect_payable
    : (base ? base.payable : null);
  let diff = null;
  if (expectRaw !== null && expectRaw !== undefined && expectRaw !== '') {
    const expect = Math.round(num(expectRaw, 0) * 100) / 100;
    if (Math.abs(expect - curPayable) >= 0.01) {
      const word = String(payload.confirm_word || '').trim();
      if (word !== POST_CONFIRM_WORD) {
        throw new Error('单据在确认后被修改（应付 ' + expect + ' → ' + curPayable
          + '）。确认按新金额记账，请先在「确认词」输入「' + POST_CONFIRM_WORD + '」再提交');
      }
      diff = { expect: expect, actual: curPayable };
    }
  }

  doc.status = recvStatus.EFFECTIVE;
  doc.posted_at = payload.ts || c.now || nowIso();
  doc.posted_by = payload.operator || 'QUEUE';
  if (c.rev !== undefined && c.rev !== null) doc.posted_rev = c.rev;
  if (c.traceId) doc.posted_trace = c.traceId;
  if (diff) doc.posted_diff = Object.assign({ at: doc.posted_at }, diff);
  doc.note = (doc.note || '') + ' 【记账生效·' + doc.posted_by + '】';

  const rb = rebuildStock(data);
  return 'recv.post ' + (doc.no || rid) + ' → 已入库（应付 ' + curPayable
    + (diff ? '，确认时 ' + diff.expect + '，差异已留痕' : '') + '）；' + rb;
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
  /* 凭证层登记（ADR-004 §2.5）：整批只写单据、不动账面；记账生效走 recv.post */
  const draft = isDraftRecv(payload);
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
    const amt = resolveDocPayable(lines, doc.discount);
    const payable = amt.payable;
    const sameDay = recv.filter((p) => p && p.date === date).length;
    const inbound = {
      id: uid('R', 10),
      no: 'JH' + String(date).replace(/-/g, '') + '-' + String(sameDay + 1).padStart(2, '0'),
      date: date,
      supplier: supplier,
      lines: lines,
      payable: amt.payable,
      /* 旧版「按应付全额登记付款」勾选项（HTML:3633 #recvPaidFlag → :3663）， ledger 语义不变 */
      payments: (markPaid && payable > 0) ? [{ amount: payable, date: date, method: '现金/转账' }] : [],
      note: String(doc.note || '').trim() || '【批量导入】',
      method: '现金/转账',
      status: draft ? recvStatus.PENDING_REVIEW : recvStatus.EFFECTIVE
    };
    /* 超集：整单优惠/抹零 —— 仅在有让利时才写字段（0 时不落库，与 Python 逐字段一致） */
    if (amt.discount > 0) {
      inbound.gross = amt.gross;
      inbound.discount = amt.discount;
    }
    if (draft) {
      /* 审核基线：审批人看到的就是这一版（金额/行数），recv.post 用它比对「确认后被改过」 */
      inbound.review_snapshot = {
        at: nowIso(), payable: num(inbound.payable, 0), lines: lines.length,
        by: payload.operator || null
      };
      inbound.note = '【待审核·批量导入】' + inbound.note;
    }
    recv.push(inbound);
    total = Math.round((total + payable) * 100) / 100;
    newDoc += 1;
    newLine += lines.length;
    /* 供应商名单补齐（旧版 :3666 DB.suppliers 去重追加，列表筛选下拉依赖它） */
    const names = arr(data.suppliers).map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
    if (names.indexOf(supplier) < 0) names.push(supplier);
    data.suppliers = names;
  }

  const head = (draft ? 'recv.import 登记待审核 ' : 'recv.import 导入 ')
    + newDoc + ' 张进货单（' + newLine + ' 行，合计 ' + pf(total) + '）'
    + (newIng ? '，自动新建原料 ' + newIng + ' 种（待完善草稿，请到「原料档案」补全）' : '')
    + (markPaid ? '，已按应付全额登记付款' : '，默认挂账（可后续补付）');

  /* 凭证层：整批不进库存/应付，也就无需重算台账 */
  if (draft) return head + '；未计入库存与应付（待审核，确认入库后生效）';

  /* 批末统一重算一次台账（O(单据数 + 库存行数)，而非 O(N × 库存行数)） */
  const rb = rebuildStock(data);
  return head + '；' + rb;
}

/* ---------- stock.count ---------- */

/**
 * stock.count：记差异 + 写「手工调整」流水并 rebuild_stock（真改账面）。
 * 与 Python 版不同：写库走 ctx.store，无则跳过。
 *
 * ADR-013 D3（W3-01 手工校准）——口径变化：
 *   · `payload.avg` 显式传入 = 手工校准：**均价可单独改**（不传 real_qty 则数量不动）；
 *   · 手工校准**强制填原因**（写进流水 note，供损耗/审计追溯）；
 *   · 流水 `inCost` 不再写死 0，改为「传入均价 ?? 该原料现有均价」——
 *     修掉「盘点一次 → 均价清零 → 库存总值变 0 元」的既有缺陷（rebuildStock 用它回写 avg）；
 *   · 存量校准只走本动作；`ing.upsert` 继续负责主数据维护，不能用来改 stock/avg（会被重算冲回）。
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

  /* 均价：显式传入（含 0）即按手工校准处理（W3-01） */
  let avgF = null;
  if (payload.avg !== undefined && payload.avg !== null && String(payload.avg).trim() !== '') {
    try {
      avgF = toFloat(payload.avg);
    } catch (e) {
      throw new Error('avg 不是有效数值');
    }
    if (avgF < 0) throw new Error('avg 不能为负');
  }
  const calibrate = avgF !== null || payload.calibrate === true;
  const noteIn = String(payload.note || '').trim();
  /* 红线 #7 不静默降级：校准没有原因就无法追溯，直接拒绝 */
  if (calibrate && !noteIn) {
    throw new Error('手工校准必须填写原因（写入「手工调整」流水，供损耗/审计追溯）');
  }

  if (gid === null) {
    if (calibrate) throw new Error('手工校准失败：未匹配到原料 ' + name);
    // 旁路差异表（审计）
    insertStockCount(ctx, payload);
    return 'stock.count ' + name + '（未匹配原料，仅记差异表）';
  }
  if (realF === null && avgF === null) {
    insertStockCount(ctx, payload);
    return 'stock.count ' + name + '（仅审计登记，未改账面）· ' + (noteIn.slice(0, 120) || '缺实盘数');
  }

  let ing = null;
  for (const g of arr(data.ings)) {
    if (String(g.id) === String(gid)) { ing = g; break; }
  }
  const stockNow = ing ? toFloat(ing.qty != null ? ing.qty : (ing.stock || 0)) : 0.0;
  const avgNow = ing ? toFloat(ing.avg || 0) : 0.0;

  // 账面：优先用传入 book，否则读当前 stock
  if (bookF === null) bookF = stockNow;
  /* 只改均价（不传实盘数）→ 数量按当前库存写绝对值，等价「数量不动、只修均价」 */
  const targetQty = realF === null ? stockNow : realF;
  const inCost = avgF !== null ? avgF : avgNow;

  /* 差异表只在真的盘点数量时登记（纯均价校准不是数量差异，避免损耗页出现伪差异） */
  if (realF !== null) insertStockCount(ctx, payload);

  const delta = r3e(targetQty - bookF);
  if (data.logs === undefined || data.logs === null) data.logs = [];
  if (!Array.isArray(data.logs)) throw new Error('data.logs 不是数组');
  const logs = data.logs;
  // 用「手工调整」按绝对值落账：rebuild 从零重放时，盘点差异 Δ 会在无期初/入库基线时变成错误账面
  logs.push({
    type: '手工调整',
    ing: gid,
    date: payload.date || today(),
    qty: targetQty,
    ref: (realF === null ? '校准·' : '盘点·') + name,
    note: noteIn || ('账面 ' + bookF + ' → 实盘 ' + targetQty + '（Δ' + delta + '）'),
    source: 'queue',
    inCost: inCost
  });
  // 同步改 ings 即时字段，避免等 rebuild 前快照仍显示旧数
  if (ing) {
    ing.qty = targetQty;
    ing.stock = targetQty;
  }
  const rb = rebuildStock(data);
  let msg = 'stock.count ' + name + ' 账面' + pf(bookF) + '→实盘' + pf(targetQty) + ' Δ' + pf(delta);
  if (avgF !== null) msg += ' · 均价' + pf(avgNow) + '→' + pf(avgF);
  return msg + '；' + rb;
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

/* ---------- po.create / po.edit（FP-PO-01/02） ----------
 * 新建/编辑采购单（对齐旧版 openOrder / openDocForm，HTML:1559-1675）。
 * 硬规则：只改 data.orders（+ data.suppliers），**绝不调 rebuildStock**（采购单不入库、不影响均价）。
 */

/** 采购单明细行：按采购单位 qty/price 生成，conv 取原料主数据、amount=r2(qty·price)、unitCost=r3(price/conv) */
function _orderLinesFromItems(data, items) {
  const ingById = new Map();
  for (const g of arr(data && data.ings)) if (g && g.id != null) ingById.set(String(g.id), g);
  const lines = [];
  for (const it of arr(items)) {
    const rawId = String((it && (it.ing_id || it.ing)) || '').trim();
    const name = pt(it && it.name);
    if (!rawId && !name) continue;
    /* 原料引用：id 精确 → 名称精确 → 自动建档（旧版「＋新增原料」openNewIngForPo 同口径） */
    const gid = resolveIngRef(data, rawId, name, it && it.unit, it && it.cat);
    if (!gid) continue;
    const g = ingById.get(String(gid)) || {};
    const qty = num(it.qty, 0);
    const price = num(it.price, 0);
    const conv = num(g.conv, 0) > 0 ? num(g.conv, 0) : 1;
    lines.push({
      ing: gid,
      name: name || g.name || gid,
      qty: qty,
      unit: pt(it.unit || g.buy || g.unit || ''),
      price: price,
      conv: conv,
      amount: r2(qty * price),
      unitCost: r3(price / conv)
    });
  }
  return lines;
}

/** 明细校验（对齐旧版：数量 > 0、单价 ≥ 0；否则拒绝保存） */
function _assertOrderLines(lines, tag) {
  if (!lines.length) throw new Error(tag + ' 无有效明细行（请至少填写一行原料+数量）');
  if (lines.some((l) => !(l.qty > 0) || l.price < 0)) {
    throw new Error(tag + ' 明细数量需 > 0、单价 ≥ 0（请检查数量/单价）');
  }
}

/** 新供应商并入 data.suppliers（对齐旧版 `if(!DB.suppliers.includes(sup))DB.suppliers.push(sup)`） */
function _ensureSupplier(data, supplier) {
  if (!supplier) return;
  if (!Array.isArray(data.suppliers)) data.suppliers = [];
  if (data.suppliers.indexOf(supplier) < 0) data.suppliers.push(supplier);
}

/**
 * po.create：新建采购单 CG（旧版 openOrder→openDocForm，HTML:1670-1674）。
 * 单号 `CG+yyyymmdd-NN`（同日已有张数+1）；payments = paid>0 ? [单条] : []（超额封顶到应付）；
 * status='normal'（与 order.fromRestock 一致，正式采购单＝收货中，仍由收齐/结案/作废推导）。
 */
function applyOrderCreate(data, payload) {
  const orders = _ordersArr(data);
  const supplier = String(payload.supplier || '').trim();
  if (!supplier) throw new Error('po.create 缺供应商（旧版 openDocForm 必填）');
  const lines = _orderLinesFromItems(data, payload.items);
  _assertOrderLines(lines, 'po.create');
  const date = payload.date || today();
  const method = String(payload.method || '现金/转账');
  const amt = resolveDocPayable(lines, payload.discount);
  const payable = amt.payable;
  const paid = Math.min(Math.max(r2(payload.paid), 0), payable);
  const sameDay = orders.filter((o) => o && o.date === date).length;
  const o = {
    id: uid('O', 10),
    no: 'CG' + String(date).replace(/-/g, '') + '-' + String(sameDay + 1).padStart(2, '0'),
    date: date,
    supplier: supplier,
    lines: lines,
    payable: payable,
    payments: paid > 0 ? [{ amount: paid, date: date, method: method }] : [],
    note: payload.note != null ? String(payload.note) : '',
    method: method,
    status: 'normal'
  };
  if (amt.discount > 0) {
    o.gross = amt.gross;
    o.discount = amt.discount;
  }
  orders.push(o);
  _ensureSupplier(data, supplier);
  return 'orders 新建采购单 ' + o.no + '（' + lines.length + ' 行，应付 ' + payable.toFixed(2)
    + '，已付 ' + paid.toFixed(2) + '）';
}

/**
 * po.edit：编辑采购单（旧版 openOrder(order)，HTML:1642-1643）。
 * 覆盖 date/supplier/note/method/lines/payable；payments 对齐旧版**重置为「本次实付」单条**
 * （前端预填 paid=已付合计，故应付/已付/欠款三数不变，仅付款笔数归并）。
 */
function applyOrderEdit(data, payload) {
  const orders = _ordersArr(data);
  const o = _findOrder(orders, payload.order_id || payload.id || payload.no);
  const supplier = payload.supplier != null ? String(payload.supplier).trim() : String(o.supplier || '');
  if (!supplier) throw new Error('po.edit 缺供应商（旧版必填）');
  const lines = _orderLinesFromItems(data, payload.items);
  _assertOrderLines(lines, 'po.edit');
  const date = payload.date || o.date || today();
  const method = payload.method != null ? String(payload.method) : String(o.method || '');
  const disc = payload.discount !== undefined && payload.discount !== null && payload.discount !== ''
    ? payload.discount : num(o.discount, 0);
  const amt = resolveDocPayable(lines, disc);
  const payable = amt.payable;
  const paid = Math.min(Math.max(r2(payload.paid != null ? payload.paid : _orderPaid(o)), 0), payable);
  o.lines = lines;
  o.date = date;
  o.supplier = supplier;
  o.note = payload.note != null ? String(payload.note) : (o.note || '');
  o.method = method;
  o.payable = payable;
  if (amt.discount > 0) {
    o.gross = amt.gross;
    o.discount = amt.discount;
  } else {
    delete o.gross;
    delete o.discount;
  }
  o.payments = paid > 0 ? [{ amount: paid, date: date, method: method }] : [];
  o._u = nowIso();
  _ensureSupplier(data, supplier);
  return 'orders ' + (o.no || o.id || '') + ' 已更新（' + lines.length + ' 行，应付 ' + payable.toFixed(2) + '）';
}

/* ---------- vendor.upsert ---------- */

/**
 * 【Node 超集】W3 供应商资质归一：支持数组 / {类型: {...}} 映射两种入参，
 * 产出统一 [{type, cert_no, expire_at, url}]（空证照剔除；全空返回 null，缺省不写键）。
 * 类型约定：营业执照 / 食品经营许可 / 检验合格（沿用 foodsafety 语境，type 保持自由字符串）。
 */
function normalizeCerts(raw) {
  if (raw == null) return null;
  const out = [];
  const push = (type, c) => {
    if (!type) return;
    const o = (c && typeof c === 'object' && !Array.isArray(c)) ? c : {};
    const cert_no = o.cert_no || o.no || '';
    const expire_at = o.expire_at || o.expires || o.expire || '';
    const url = o.url || o.cert_url || '';
    if (!cert_no && !expire_at && !url) return; // 空证照跳过
    out.push({ type: String(type), cert_no: String(cert_no), expire_at: String(expire_at), url: String(url) });
  };
  if (Array.isArray(raw)) {
    for (const c of raw) push(c && c.type, c);
  } else if (raw && typeof raw === 'object') {
    for (const k of Object.keys(raw)) push(k, raw[k]);
  }
  return out.length ? out : null;
}

/* ---------- vendor 档案取数（与列表口径同源） ---------- */

/**
 * Phase 2 供应商类目归一：自由文本 / 别名 / 词条 ID → 受控词条 ID（S 前缀）。
 *   - 空值原样返回（保留旧行为：新建缺省不写类目）；
 *   - 未命中词条 → 兜底「其他」（S005），由 vendor_term.backfill 可重复收口；
 *   - 只读 data.vendor_terms（缺失回退 seed），本函数不写词表、不建表。
 */
function vendorCategoryOf(data, raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return raw;
  const r = supTerms.resolveCategory(s, supTerms.termsOf(data));
  return r.id || raw;
}

/** 新表 sup_vendors 行：优先快照 ext（BFF apply），其次 sqlite（店内 consumer）；表不存在 → 空数组 */
function vendorStoreRows(ctx) {
  if (!(ctx && ctx.store)) return [];
  const e = ctx.store.ext;
  if (e && Array.isArray(e.sup_vendors)) return e.sup_vendors;
  if (typeof ctx.store.query === 'function') {
    try {
      const rows = ctx.store.query('SELECT * FROM sup_vendors');
      if (Array.isArray(rows)) return rows;
    } catch (err) { /* 表不存在 / 查询失败 → 空 */ }
  }
  return [];
}

/**
 * 供应商档案写回源：
 *   data.vendors **是数组**（含空数组）→ 旧口径（档案随主数据快照走，与 Python 参考实现平价）；
 *   data.vendors 缺失（undefined/null）→ 新表 sup_vendors（ext / sqlite）。
 * 返回 {rows, from}；rows 是**可原地修改**的引用（ext 数组改完由执行器回写快照）。
 *
 * 注意「列表口径」是 data.vendors 非空优先、空则回落 ext.sup_vendors（lib/supply.js），
 * 所以**校验**必须把两源并起来看（vendorAllRows），否则会出现
 * 「列表看得见（ext.sup_vendors）、编辑说找不到」→ 动作被置已驳回。
 */
function vendorSource(data, ctx) {
  if (data && Array.isArray(data.vendors)) return { rows: data.vendors, from: 'data' };
  return { rows: vendorStoreRows(ctx), from: 'store' };
}

/** 定位用并集：data.vendors + 新表 sup_vendors（判重/编辑定位，不用于写回） */
function vendorAllRows(data, ctx) {
  const out = [];
  for (const v of arr(data && data.vendors)) out.push(v);
  for (const v of vendorStoreRows(ctx)) {
    if (out.indexOf(v) < 0) out.push(v);
  }
  return out;
}

/** 档案行可用于定位的键（vendor_id / id / name） */
function vendorKeysOf(v) {
  const out = [];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const k of [v.vendor_id, v.id, v.name]) {
    const s = String(k == null ? '' : k).trim();
    if (s && out.indexOf(s) < 0) out.push(s);
  }
  return out;
}

/**
 * vendor.upsert：供应商档案新建 / 覆盖（按 vendor_id 或 name 幂等）。
 *
 * 【Node 超集】payload.edit === true 为「编辑」口径：显式空值（''/null）也写回，
 * 让清空联系人/电话/评级/备注真正生效；缺省（非编辑）仍沿用旧行为——null 不覆盖字段，
 * 与 Python 参考实现逐字段平价。
 */
function upsertVendor(data, payload, ctx) {
  const edit = payload.edit === true;
  let name = String(payload.name || '').trim();
  let vid = String(payload.vendor_id || payload.id || '').trim();
  /* 编辑老档案（无编号）时先按 old_name 找回原编号，避免改名被当成新建、并在新表多出一行 */
  const origin = edit && !vid && payload.old_name
    ? arr(data.vendors).filter((v) => v && typeof v === 'object'
      && String(v.name || '').trim() === String(payload.old_name).trim())[0]
    : null;
  if (origin) vid = String(origin.vendor_id || origin.id || '').trim();
  if (!name && !vid) throw new Error('vendor.upsert 缺 name/vendor_id');
  if (!name) name = vid;
  if (!vid) vid = uid('V', 8).toUpperCase();

  const contact = payload.contact;
  const phone = payload.phone;
  /* Phase 2：类目落受控词条 ID（别名归一，未命中落「其他」），展示侧再还原标准名 */
  const category = vendorCategoryOf(data, payload.category || payload.cat);
  const level = payload.level === undefined ? payload.rating : payload.level;
  const status = payload.status || '合作中';
  const period = payload.period || payload.settle || '月结30天';
  const note = payload.note || '';
  /* W3 资质：显式传入（含空数组）时允许编辑清空；缺省（未传）保持旧值 */
  const hasCerts = payload.certs !== undefined || payload.licenses !== undefined;
  const certs = normalizeCerts(payload.certs || payload.licenses);
  const now = nowIso();

  /* 档案当前生效源：与列表同源（data.vendors 优先，否则 sup_vendors 新表） */
  const src = vendorSource(data, ctx);
  const keys = [];
  for (const k of [vid, name, payload.old_name]) {
    const s = String(k == null ? '' : k).trim();
    if (s && keys.indexOf(s) < 0) keys.push(s);
  }

  /**
   * 编辑模式必须先定位到原档案：定位不到就报错，**绝不静默新建**。
   * （否则前端回显失效时用户手填一遍，就会多出一条 id=旧名 的重复档案）
   * 定位范围＝列表同源，避免「列表看得见（ext.sup_vendors）、编辑说没有」。
   */
  if (edit) {
    const inSource = vendorAllRows(data, ctx)
      .some((v) => vendorKeysOf(v).some((k) => keys.indexOf(k) >= 0));
    if (!inSource) {
      /* 兜底：源数组未含（如快照 ext 尚未推送）时按主键列直查 sqlite */
      let inStore = null;
      if (ctx && ctx.store && typeof ctx.store.get === 'function' && vid) {
        try { inStore = ctx.store.get('sup_vendors', vid); } catch (e) { inStore = null; }
      }
      if (!inStore) {
        throw new Error('找不到要编辑的供应商 ' + (name || vid) + '（可能已被删除，请刷新列表后重试）');
      }
    }
  }

  let action = '新建';
  if (ctx && ctx.store && typeof ctx.store.upsert === 'function') {
    // 由 store 层按 vendor_id 幂等 upsert；返回值可携带命中信息
    const storeRow = {
      vendor_id: vid, name: name, contact: contact, phone: phone,
      category: category, level: level != null ? String(level) : null,
      status: status, period: period, note: note, updated_at: now
    };
    /* 【Node 超集】W3 资质证照：非空写数组；编辑显式清空写 null；缺省不写键（不清空） */
    if (certs != null || (edit && hasCerts)) storeRow.certs = certs;
    /* sup_vendors 主键是 vendor_id：必须显式传 keys，缺省 ['id'] 会插出重复行（主键冲突 → 整行未更新） */
    const r = ctx.store.upsert('sup_vendors', storeRow, ['vendor_id']);
    if (r && r.matched) {
      vid = r.vendor_id || vid;
      action = '更新';
    }
  }
  /* 编辑命中新表档案：即便 store 未回 matched（ext 源），语义也是「更新」 */
  if (edit && src.from === 'store') action = '更新';

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
  /* 【Node 超集】W3 资质证照：非空写数组；编辑显式清空写 null；缺省不写键 */
  if (certs != null || (edit && hasCerts)) row.certs = certs;
  try {
    if (level != null && /^\d+(\.\d+)?$/.test(String(level).replace('.', ''))) {
      row.rating = toFloat(level);
    } else if (edit) {
      /* 编辑清空评级：rating 是 level 的历史别名，一并清掉，否则 normVendor 会回落到旧 rating */
      row.rating = null;
    }
  } catch (e) { /* ignore */ }

  /*
   * 写回**同源**档案数组：
   *   data.vendors 口径 → 就地合并 / 追加（旧行为）；
   *   sup_vendors 口径 → 上面 store.upsert 已落库（ext 源时同一数组引用已被改），
   *                     这里只做内存合并，**绝不新建 data.vendors**（否则档案分裂成两条）。
   */
  const vendors = src.rows;
  let hit = false;
  let oldName = '';
  /* 编辑改名兜底：老档案可能没有编号，靠 old_name 仍能定位到原行（否则改名会变成新建一条） */
  const oldKey = edit ? String(payload.old_name || '').trim() : '';
  for (let i = 0; i < vendors.length; i++) {
    const v = vendors[i];
    if (!(v && typeof v === 'object' && !Array.isArray(v))) continue;
    const vname0 = String(v.name || '');
    if (String(v.vendor_id || v.id || '') === vid || vname0 === name || (oldKey && vname0 === oldKey)) {
      oldName = String(v.name || '');
      const merged = Object.assign({}, v);
      for (const [k, val] of Object.entries(row)) {
        if (val === undefined) continue;
        if (!edit && val === null) continue; // 非编辑口径：null 不覆盖（与 Python 逐字段平价）
        merged[k] = val;
      }
      vendors[i] = merged;
      hit = true;
      break;
    }
  }
  if (!hit && src.from === 'data') vendors.push(row);

  const names = [];
  for (const v of (src.from === 'data' ? vendors : [])) {
    if (v && typeof v === 'object' && !Array.isArray(v) && v.name) names.push(String(v.name));
    else if (typeof v === 'string' && v.trim()) names.push(v.trim());
  }
  /* 编辑改名：旧名若无其他档案占用，从 data.suppliers 名单一并摘掉（避免下拉残留已改名的供应商） */
  const dropName = (edit && hit && oldName && oldName !== name
    && names.indexOf(oldName) < 0) ? oldName : null;
  for (const s of arr(data.suppliers)) {
    const t = typeof s === 'string' ? s.trim() : '';
    if (!t || t === dropName) continue;
    if (names.indexOf(t) < 0) names.push(t);
  }
  if (names.indexOf(name) < 0) names.push(name);
  data.suppliers = names;

  return 'vendor ' + action + ' ' + vid + ' ' + name;
}

/* ---------- vendor.delete（供应商档案删除） ---------- */

/** 统计 sqlite 表中某列命中 keys 的行数（无 store / 表不存在 → 0） */
function countStoreRows(ctx, table, col, keys) {
  if (!(ctx && ctx.store && typeof ctx.store.query === 'function') || !keys.length) return 0;
  try {
    const rows = ctx.store.query(
      'SELECT COUNT(*) AS c FROM "' + table + '" WHERE "' + col + '" IN (' + keys.map(() => '?').join(',') + ')',
      keys
    );
    return Number((rows && rows[0] && rows[0].c) || 0);
  } catch (e) { return 0; }
}

/**
 * vendor.delete：删除供应商档案（错建 / 重复档案清理）。
 *
 * 红线：
 *   · 有往来账（sup_accounts 命中该供应商）**禁删**——删档案会让应付台账悬空，
 *     正确做法是把状态改为「暂停」；
 *   · 报价历史（sup_prices / data.quotes）与采购/进货单据是既成事实，**不随档案删除**；
 *   · data.suppliers 名单只在没有任何历史单据引用时才摘掉（采购/进货筛选依赖它）。
 *
 * 与其他 delete 动作同型：入口走审批队列（vendor.delete），本函数改 data + sqlite 表。
 */
function applyVendorDelete(data, payload, ctx) {
  const key = String((payload && (payload.vendor_id || payload.id || payload.name)) || '').trim();
  if (!key) throw new Error('vendor.delete 缺 vendor_id/name');
  /* 与列表/编辑同源：data.vendors 为空时档案在 sup_vendors 新表，不能只看 data.vendors */
  const vendors = vendorSource(data, ctx).rows;
  const idx = vendors.findIndex((v) => v && typeof v === 'object' && !Array.isArray(v)
    && (String(v.vendor_id || v.id || '') === key || String(v.name || '') === key));
  const target = idx >= 0 ? vendors[idx] : null;
  const vid = target ? String(target.vendor_id || target.id || '').trim() : key;
  const vname = target ? String(target.name || '').trim() : '';
  const keys = [];
  for (const k of [vid, vname, key]) if (k && keys.indexOf(k) < 0) keys.push(k);

  /* 红线：已有往来账 → 禁删（改为「暂停」保留台账） */
  const acc = countStoreRows(ctx, 'sup_accounts', 'vendor_id', keys);
  if (acc > 0) {
    throw new Error('供应商「' + (vname || vid) + '」已有 ' + acc + ' 笔往来账，不能删除（请把状态改为「暂停」）');
  }

  if (idx < 0) {
    /* 档案只在新表 sup_vendors（data.vendors 为空时列表走 ext.sup_vendors） */
    const r = (ctx && ctx.store && typeof ctx.store.remove === 'function')
      ? ctx.store.remove('sup_vendors', { vendor_id: key }) : null;
    if (!(r && r.rowcount)) throw new Error('找不到供应商 ' + key);
    return '供应商 ' + key + ' 已删除（sup_vendors）';
  }

  /* 解绑原料默认供应商指向（ing.sup），避免补货建议指向已删档案 */
  let unbind = 0;
  for (const g of arr(data.ings)) {
    if (!(g && typeof g === 'object')) continue;
    if (g.sup != null && keys.indexOf(String(g.sup).trim()) >= 0) { g.sup = ''; unbind += 1; }
  }

  vendors.splice(idx, 1);

  if (Array.isArray(data.suppliers) && vname) {
    const used = arr(data.orders).some((o) => o && String(o.sup || o.supplier || '').trim() === vname)
      || arr(data.recv).some((r) => r && String(r.supplier || '').trim() === vname)
      || vendors.some((v) => v && typeof v === 'object' && String(v.name || '').trim() === vname);
    if (!used) data.suppliers = data.suppliers.filter((s) => String(s == null ? '' : s).trim() !== vname);
  }

  let wrote = false;
  if (ctx && ctx.store && typeof ctx.store.remove === 'function' && vid) {
    const r = ctx.store.remove('sup_vendors', { vendor_id: vid });
    wrote = !!(r && r.rowcount);
  }
  return '供应商 ' + (vname || vid) + ' 已删除'
    + (unbind ? ' · 解除原料默认供应商 ' + unbind + ' 处' : '')
    + (wrote ? '' : '（sup_vendors 未写库）');
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
  resolveIngRef,
  applyRestock,
  applyConfig,
  applyRest,
  applyIngUpsert,
  applyIngBatch,
  applyIngDelete,
  applyQuoteUpsert,
  applyQuoteImport,
  quoteIngKey,
  applyQuoteDelete,
  applyLossReport,
  approveLossReport,
  rejectLossReport,
  applyRecvInbound,
  insertRecvAccept,
  applyRecvPay,
  applyRecvUpdate,
  applyRecvVoid,
  applyRecvPost,
  applyRecvImport,
  applyRestockToOrders,
  applyRestockConfig,
  applyRestockIgnore,
  applyRestockAdjust,
  restockDef,
  applyStockCount,
  insertStockCount,
  applyOrderMark,
  applyOrderPay,
  applyOrderClose,
  applyOrderVoid,
  applyOrderRestore,
  applyOrderDelete,
  applyOrderCreate,
  applyOrderEdit,
  upsertVendor,
  applyVendorDelete,
  insertSupplyPo
};
