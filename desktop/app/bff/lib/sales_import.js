'use strict';
/*
 * lib/sales_import.js — 平台销售数据导入「解析层」（纯函数 · 零写）
 * 移植自旧系统 HTML:4484-4934。只 require Node 内置 + ./recv_import，不写库不发网络。
 * 金额口径唯一出口 resolveSaleAmt()，预览/提交/事后重算三处复用，口径永远一致。
 */
const ri = require('./recv_import');

const SALE_SRC = [
  { key: 'mt', name: '美团外卖', ch: '美团外卖' },
  { key: 'other', name: '其他平台', ch: '外卖' },
];
const SALE_AMT_MODES = {
  A: '用户实付 + 商家实收（双全）', B: '仅用户实付', C: '仅商家实收',
  D: '原价 + 优惠/扣费', E: '仅单价×数量（兜底）',
};
const IMP_SALE_DEFS = {
  dish: { alts: ['菜品名称', '菜品', '菜名', '商品名称', '商品', '品名', '产品名称', '产品', '项目名称', '名称', '项目', 'dish', 'item'], req: 1 },
  qty: { alts: ['数量', '份数', '销售数量', '商品数量', '菜品数量', '购买数量', '下单数量', '售出数量', '销量', 'qty'], req: 1 },
  date: { alts: ['日期', '下单日期', '交易日期', '成交日期', '营业日期', '统计日期', '结算日期', '下单时间', '交易时间', '完成时间'] },
  orderNo: { alts: ['订单号', '订单编号', '订单id', '交易号', '交易单号', '流水号', '平台单号', '平台订单号', '单号', 'orderid', '订单'] },
  price: { alts: ['单价', '售价', '商品单价', '菜品单价', '原价单价', '单品价格'] },
  amtList: { alts: ['原价', '商品金额', '菜品金额', '原价金额', '订单原价', '商品原价', '原价合计', '商品总额', '订单金额', '销售额', '金额'] },
  amtPaid: { alts: ['用户实付', '顾客实付', '实付', '买家实付', '用户支付金额', '用户支付', '实际支付', '支付金额', '买家支付', '顾客支付'] },
  amtNet: { alts: ['商家实收', '商家收入', '商家到账', '结算金额', '商家实得', '入账金额', '商家应收', '预计收入', '商家结算金额'] },
  amtFee: { alts: ['平台服务费', '服务费', '佣金', '技术服务费', '平台扣费', '扣费', '手续费', '配送费', '平台佣金'] },
  amtPromo: { alts: ['优惠', '优惠金额', '商家优惠', '活动优惠', '减免', '折扣金额', '优惠券', '商家承担优惠', '优惠减免'] },
  note: { alts: ['备注', '说明', 'note'] },
};

function num(v, d) { const n = parseFloat(v); return isFinite(n) ? n : (d == null ? 0 : d); }
function r3(n) { return Math.round(num(n) * 1000) / 1000; }
function pickFirst(o, keys) { for (let i = 0; i < keys.length; i++) { const v = o[keys[i]]; if (v != null && String(v).trim() !== '') return String(v).trim(); } return ''; }
function srcDefOf(k) { return SALE_SRC.find(x => x.key === k) || { key: k || 'other', name: '外部平台', ch: '外卖' }; }
function saleSrcName(k) { return srcDefOf(k).name; }

/* ---------- 菜品匹配（三级：别名 → 精确 → 归一化） ---------- */
function normDishName(s) {
  return String(s == null ? '' : s).replace(/[\s\u3000]/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[·•、,，.。\-_—~～*＊#"'“”]/g, '')
    .replace(/^[0-9]+[.、]?/, '').toLowerCase();
}
function dishById(dishes, id) { return (dishes || []).find(x => x && String(x.id) === String(id)) || null; }
/* 精确匹配：cleanName 后的平台名与本店菜名原样相等，且要求在售（on）。
 * 注：旧版 findDishByName 不查 on（疏漏，会匹配到已下架菜品），此处显式修正为与「归一化」分支一致。 */
function findDishByName(dishes, name) {
  const n = String(name == null ? '' : name).trim();
  return n ? (dishes || []).find(x => x && x.on && x.name === n) || null : null;
}
function matchSaleDish(name, dishes, dishAlias) {
  const raw = ri.cleanName(name);
  if (!raw) return null;
  const al = (dishAlias && typeof dishAlias === 'object' && !Array.isArray(dishAlias)) ? dishAlias : {};
  const a = al[raw];
  if (a && a.dish && dishById(dishes, a.dish)) return { d: dishById(dishes, a.dish), mul: Number(a.mul) || 1, level: '别名', name: raw };
  const ex = findDishByName(dishes, raw);
  if (ex) return { d: ex, mul: 1, level: '精确', name: raw };
  const n = normDishName(raw);
  if (!n) return null;
  const hit = (dishes || []).filter(x => x && x.on && normDishName(x.name) === n);
  if (hit.length) return { d: hit[0], mul: 1, level: '归一化', name: raw };
  return null;
}

/* ---------- 金额口径（唯一出口） ---------- */
function resolveSaleAmt(v, force, opt) {
  opt = opt || {}; v = v || {};
  const n = (x) => { const t = parseFloat(x); return isFinite(t) ? t : NaN; };
  let list = n(v.list), paid = n(v.paid), net = n(v.net), fee = n(v.fee), promo = n(v.promo);
  const q = n(v.qty), p = n(v.price);
  if (!isFinite(list) && isFinite(q) && isFinite(p)) list = ri.r2(q * p);
  if (opt.rate != null && isFinite(+opt.rate)) {
    const base = isFinite(paid) ? paid : (isFinite(list) ? list : 0);
    fee = ri.r2(base * (+opt.rate) / 100);
  }
  const hasL = isFinite(list), hasP = isFinite(paid), hasN = isFinite(net), hasD = isFinite(fee) || isFinite(promo);
  const mode = force || ((hasP && hasN) ? 'A' : (hasL && hasD) ? 'D' : hasP ? 'B' : hasN ? 'C' : hasL ? 'E' : '');
  let sub = NaN, recvAmt = NaN;
  if (mode === 'A') { sub = hasL ? list : paid; recvAmt = net; }
  else if (mode === 'D') { sub = hasL ? list : (hasP ? paid : NaN); recvAmt = hasL ? ri.r2(list - ((isFinite(fee) ? fee : 0) + (isFinite(promo) ? promo : 0))) : NaN; }
  else if (mode === 'C') { sub = hasL ? list : net; recvAmt = net; }
  else if (mode === 'B') { sub = hasL ? list : ri.r2(paid + (isFinite(promo) ? promo : 0)); recvAmt = ri.r2(paid - (isFinite(fee) ? fee : 0)); }
  else if (mode === 'E') { sub = list; recvAmt = list; }
  const srcAmt = { list: hasL ? list : null, paid: hasP ? paid : null, net: hasN ? net : null, fee: isFinite(fee) ? fee : null, promo: isFinite(promo) ? promo : null };
  if (!isFinite(sub) || !isFinite(recvAmt)) return { mode, sub: NaN, discount: 0, receivable: NaN, srcAmt };
  let disc = ri.r2(sub - recvAmt);
  if (disc < 0) { disc = 0; recvAmt = sub; }
  return { mode, sub: ri.r2(sub), discount: disc, receivable: ri.r2(recvAmt), srcAmt };
}

/* ---------- 解析：行 / 表格 / JSON ---------- */
function saleRowFrom(o) {
  const name = ri.cleanName(o.dish);
  if (!name || ri.NOISE_RE.test(name)) return null;
  const q = ri.numOr(o.qty);
  if (!isFinite(q) || q <= 0) return null;
  return {
    dish: name, qty: q, date: ri.normDate(o.date), orderNo: String(o.orderNo || '').trim(),
    price: ri.numOr(o.price), list: ri.numOr(o.amtList), paid: ri.numOr(o.amtPaid),
    net: ri.numOr(o.amtNet), fee: ri.numOr(o.amtFee), promo: ri.numOr(o.amtPromo),
    note: String(o.note || '').trim(),
  };
}
function parseSaleTable(src, ov) {
  const f = ov ? { rows: ov.rows || ((src && src.rows) || []), hit: { rowIndex: ov.rowIndex == null ? -1 : ov.rowIndex, map: ov.map || {} }, sheet: ov.sheet }
    : ri.pickTable(src, IMP_SALE_DEFS, [['dish'], ['qty']]);
  if (!f) return { rows: [], err: '未识别到销售表头。需含「菜品名称/名称」+「数量」两列（支持列名别名，见界面说明）' };
  const rows = [];
  ri.rowsToObjs(f.rows, IMP_SALE_DEFS, f.hit).forEach(o => { const r = saleRowFrom(o); if (r) rows.push(r); });
  if (!rows.length) return { rows: [], err: '表内未解析到有效销售行（菜品名称与数量需齐全）' };
  return { rows, mode: rows.some(r => r.orderNo) ? 'detail' : 'sum', sheet: f.sheet || '' };
}
function parseSaleJson(text) {
  let o; try { o = JSON.parse(text); } catch (e) { return { rows: [], err: 'JSON 解析失败：' + e.message }; }
  let arr = null;
  if (Array.isArray(o)) arr = o;
  else if (o && Array.isArray(o.sales)) arr = o.sales;
  else if (o && Array.isArray(o.items)) arr = o.items;
  else if (o && Array.isArray(o.orders)) arr = o.orders;
  else if (o && Array.isArray(o.lines)) arr = o.lines;
  if (!arr) return { rows: [], err: 'JSON 缺少 sales / items / orders 明细列表' };
  const rows = [];
  const one = (xo, base) => {
    const inner = Array.isArray(xo.lines) ? xo.lines : (Array.isArray(xo.items) ? xo.items : null);
    const mk = (l) => saleRowFrom({
      dish: pickFirst(l, ['dish', 'name', '菜品名称', '菜名', '商品名称', '品名']),
      qty: pickFirst(l, ['qty', '数量', '份数', '销量', '销售数量']),
      date: pickFirst(base, ['date']) || pickFirst(l, ['date', '日期']),
      orderNo: pickFirst(base, ['orderNo']) || pickFirst(l, ['orderNo', '订单号', '订单编号', '单号']),
      price: pickFirst(l, ['price', '单价', '售价']),
      amtList: pickFirst(l, ['amtList', 'list', '原价', '商品金额', '金额']),
      amtPaid: pickFirst(l, ['amtPaid', 'paid', '用户实付', '实付']),
      amtNet: pickFirst(l, ['amtNet', 'net', '商家实收', '结算金额']),
      amtFee: pickFirst(l, ['amtFee', 'fee', '平台服务费', '服务费', '佣金']),
      amtPromo: pickFirst(l, ['amtPromo', 'promo', '优惠', '优惠金额']),
      note: pickFirst(l, ['note', '备注']),
    });
    if (inner) inner.forEach(l => { const r = mk(l); if (r) rows.push(r); });
    else { const r = mk(xo); if (r) rows.push(r); }
  };
  arr.forEach(x => {
    const xo = x || {};
    one(xo, { date: pickFirst(xo, ['date', '日期', '下单日期', '营业日期']), orderNo: pickFirst(xo, ['orderNo', '订单号', '订单编号', '单号', '平台单号']) });
  });
  const rs = rows.filter(x => x);
  return { rows: rs, mode: rs.some(r => r.orderNo) ? 'detail' : 'sum' };
}

/* ---------- 聚合（口径唯一出口） ---------- */
function buildSaleDocs(rows, mode, sel, opt) {
  opt = opt || {}; sel = sel || {};
  const dishes = Array.isArray(opt.dishes) ? opt.dishes : [];
  const dishAlias = opt.dishAlias || {};
  const map = new Map();
  let skipped = 0, matched = 0, unmapped = 0;
  (rows || []).forEach(w => {
    const raw = ri.cleanName(w.dish);
    const hit = matchSaleDish(raw, dishes, dishAlias);
    let did = null, mul = 1;
    if (hit) { did = hit.d.id; mul = hit.mul; }
    else if (sel[raw]) did = sel[raw];
    if (!did || !dishById(dishes, did)) { unmapped++; skipped++; return; }
    matched++;
    const q = r3((Number(w.qty) || 0) * mul);
    if (!(q > 0)) { skipped++; return; }
    const key = mode === 'detail' ? (w.date + '|' + (w.orderNo || '')) : ('@' + w.date);
    let d = map.get(key);
    /* 注：旧版以 0 初始化金额累加器，导致「无原价列」时 list 被误判为 0（口径 A 的 sub 取到 0）；
       此处显式修正为 NaN 初始化 + 首次赋值累加，使「缺失」与「真实为 0」可区分。 */
    if (!d) { d = { date: w.date, srcNo: mode === 'detail' ? (w.orderNo || '') : '', lines: [], _list: NaN, _paid: NaN, _net: NaN, _fee: NaN, _promo: NaN, _first: null }; map.set(key, d); }
    const dd = dishById(dishes, did);
    d.lines.push({ dish: did, dishName: dd ? dd.name : String(did), qty: q, price: isFinite(w.price) ? ri.r2(w.price) : 0, amount: isFinite(w.list) ? ri.r2(w.list) : 0 });
    ['list', 'paid', 'net', 'fee', 'promo'].forEach(k => { if (isFinite(w[k])) d['_' + k] = isFinite(d['_' + k]) ? d['_' + k] + w[k] : w[k]; });
    if (!d._first) d._first = { list: w.list, paid: w.paid, net: w.net, fee: w.fee, promo: w.promo };
  });
  const docs = [];
  map.forEach(d => {
    const orderLevel = !!(mode === 'detail' && !opt.sumAmt && d._first);
    const v = orderLevel ? d._first : { list: d._list, paid: d._paid, net: d._net, fee: d._fee, promo: d._promo };
    const rr = resolveSaleAmt(v, null);
    let sub = orderLevel && isFinite(rr.sub) ? rr.sub : 0;
    if (!(sub > 0)) sub = ri.r2(d.lines.reduce((a, l) => a + l.qty * l.price, 0));
    if (!(sub > 0)) sub = ri.r2(d.lines.reduce((a, l) => a + (l.amount || 0), 0));
    if (!(sub > 0) && isFinite(rr.sub)) sub = rr.sub;
    const recv = isFinite(rr.receivable) ? rr.receivable : sub;
    const totalQty = d.lines.reduce((a, l) => a + l.qty, 0);
    if (sub > 0 && totalQty > 0) d.lines.forEach(l => { if (!(l.price > 0)) l.price = r3(sub / totalQty); });
    sub = ri.r2(d.lines.reduce((a, l) => a + l.qty * l.price, 0));
    let disc = ri.r2(sub - recv); if (disc < 0) disc = 0;
    docs.push({ date: d.date, srcNo: d.srcNo, lines: d.lines, sub, discount: disc, receivable: ri.r2(sub - disc), amtMode: rr.mode || '', srcAmt: rr.srcAmt });
  });
  docs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { docs, skipped, matched, unmapped };
}

/* ---------- 幂等键（作废单不占键，撤回后可重导） ---------- */
function saleDupKeyOf(srcKey, d) { return srcKey + '|' + (d && d.srcNo ? d.srcNo : ('@' + (d && d.date || ''))); }
function saleDupKeys(sales, srcKey) {
  const m = new Set();
  (sales || []).forEach(s => {
    if (!s || !s.src) return;
    if (s.status && String(s.status).indexOf('作废') >= 0) return;
    m.add(saleDupKeyOf(s.src, s));
  });
  return m;
}

/* ---------- 解析文件 → 原始行（预览与提交共用，纯函数零写） ---------- */
function loadSaleRows(input) {
  const inp = input || {};
  let bytes = null;
  if (inp.bytes) bytes = Buffer.from(inp.bytes);
  else if (typeof inp.contentBase64 === 'string' && inp.contentBase64) bytes = Buffer.from(inp.contentBase64, 'base64');
  if (!bytes || !bytes.length) return { ok: false, error: '缺少文件内容（contentBase64）' };
  if (bytes.length > 8 * 1024 * 1024) return { ok: false, error: '文件过大（上限 8MB）' };
  const fileName = String(inp.fileName || 'import.csv');
  let src = null;
  try { src = ri.loadRowSource(bytes, fileName); } catch (e) { return { ok: false, error: '文件解析失败：' + ((e && e.message) || e) }; }
  if (src.err) return { ok: false, error: src.err, format: src.format };
  const r = src.json ? parseSaleJson(src.text) : parseSaleTable(src);
  if (r.err) return { ok: false, error: r.err, format: src.format };
  return { ok: true, rows: r.rows || [], mode: r.mode || 'sum', format: src.format, sheet: r.sheet || '' };
}

/* ---------- 预览入口（只读） ---------- */
function previewSaleImport(input, dishes, dishAlias) {
  const lr = loadSaleRows(input);
  if (!lr.ok) return { ok: false, error: lr.error, format: lr.format };
  const rows = lr.rows, mode = lr.mode;
  const unmatched = []; const seen = new Set();
  rows.forEach(w => { const k = ri.cleanName(w.dish); if (!matchSaleDish(k, dishes, dishAlias) && !seen.has(k)) { seen.add(k); unmatched.push(k); } });
  const built = buildSaleDocs(rows, mode, {}, { dishes, dishAlias });
  const docs = built.docs;
  return {
    ok: true, format: lr.format, sheet: lr.sheet, mode,
    totalRows: rows.length, matched: built.matched, unmapped: built.unmapped, skipped: built.skipped,
    unmatched, docs, totalDocs: docs.length, totalReceivable: ri.r2(docs.reduce((a, b) => a + (b.receivable || 0), 0)),
  };
}

module.exports = {
  SALE_SRC, SALE_AMT_MODES, IMP_SALE_DEFS,
  normDishName, dishById, findDishByName, matchSaleDish,
  resolveSaleAmt, saleRowFrom, parseSaleTable, parseSaleJson,
  buildSaleDocs, saleDupKeyOf, saleDupKeys, previewSaleImport, loadSaleRows,
  srcDefOf, saleSrcName, cleanName: ri.cleanName,
};
