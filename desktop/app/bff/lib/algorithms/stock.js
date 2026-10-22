'use strict';
/*
 * lib/algorithms/stock.js — 库存算法（迁移自 queue_consumer.py rebuild_stock / resolve_ing_id）
 *
 * rebuild_stock(data)：期初 + 已入库进货 + 盘点/手工调整 → ings.stock/qty/avg，并重建规范化流水 logs。
 *   与店内 HTML / import_orders_excel.rebuild_stock 同口径；入库确认后必须调用，
 *   否则 App 库存页数字不变。
 *
 * 纯函数：只读写传入的 data 对象，触碰不到外部状态。
 */

const { today, nowIso, num, r3, arr } = require('./util');

/* 流水排序权重（数值越小越早应用）：期初0 / 手工调整1 / 采购入库2 / 盘点调整3 */
const ORDER = { 期初: 0, 手工调整: 1, 采购入库: 2, 盘点调整: 3 };

/**
 * 重算库存。
 * @param {object} data 快照 data（含 ings/recv/logs）
 * @returns {string} 处理摘要（与 Python 版返回文案对齐）
 */
function rebuildStock(data) {
  if (!data || typeof data !== 'object') return 'rebuild_stock 跳过（无 data）';
  const ings = arr(data.ings);
  if (!ings.length) return 'rebuild_stock 跳过（无 ings）';

  const ingMap = new Map();
  for (const g of ings) {
    if (g && g.id !== undefined && g.id !== null) ingMap.set(String(g.id), g);
  }

  const moves = [];
  for (const g of ings) {
    g.stock = 0;
    g.avg = 0;
    const init = num(g.initStock, 0);
    if (init > 0) {
      moves.push({
        o: ORDER['期初'], type: '期初', gid: String(g.id),
        date: g.initDate || today(), qty: init,
        cost: num(g.initAvg, 0), ref: '期初'
      });
    }
  }

  for (const po of arr(data.recv)) {
    const st = String((po && po.status) || '');
    // 仅已入库计入库存；草稿/待收不进；已作废旧版 delRecv 物理删除→Node 改为留痕，
    // 由此处跳过（作废单不进台账，库存按剩余单据重算，效果等价于旧版「删除后重建」且不丢审计）
    if (st && (st.indexOf('草稿') >= 0 || st.indexOf('待') >= 0 || st.indexOf('作废') >= 0 || st.indexOf('void') >= 0) && st.indexOf('已入库') < 0) continue;
    for (const l of arr(po && po.lines)) {
      const gid = (l && (l.ing != null ? l.ing : l.ing_id));
      if (gid === undefined || gid === null) continue;
      moves.push({
        o: ORDER['采购入库'], type: '采购入库', gid: String(gid),
        date: (po && po.date) || today(),
        qty: num(l.qty, 0) * num(l.conv, 1),
        cost: num(l.unitCost != null ? l.unitCost : l.price, 0),
        ref: (po && (po.no || po.id)) || null
      });
    }
  }

  for (const l of arr(data.logs)) {
    if (!l || typeof l !== 'object') continue;
    // 只吃规范化流水，避免把 kind=loss 的旁路日志当重放源重复扣
    if (l.type === '盘点调整' && l.ing !== undefined && l.ing !== null) {
      moves.push({
        o: ORDER['盘点调整'], type: '盘点调整', gid: String(l.ing),
        date: l.date || today(), qty: num(l.qty, 0), cost: 0,
        ref: l.ref, adj: l
      });
    } else if (l.type === '手工调整' && l.ing !== undefined && l.ing !== null) {
      moves.push({
        o: ORDER['手工调整'], type: '手工调整', gid: String(l.ing),
        date: l.date || today(), qty: num(l.qty, 0),
        cost: num(l.inCost, 0), ref: l.ref, adj: l
      });
    }
  }

  moves.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.o - b.o));

  const gen = [];
  let genSeq = 1;
  for (const mv of moves) {
    const g = ingMap.get(mv.gid);
    if (!g) continue;
    if (mv.type === '手工调整') {
      g.stock = r3(mv.qty);
      g.avg = num(mv.cost, 0);
    } else if (mv.qty > 0) {
      const val = num(g.stock, 0) * num(g.avg, 0) + mv.qty * mv.cost;
      g.stock = r3(num(g.stock, 0) + mv.qty);
      g.avg = g.stock ? r3(val / g.stock) : num(mv.cost, 0);
    } else {
      g.stock = r3(num(g.stock, 0) + mv.qty);
    }

    if (mv.adj !== undefined && mv.adj !== null) {
      mv.adj.bal = r3(g.stock);
      mv.adj.cost = g.avg;
      gen.push(mv.adj);
    } else {
      gen.push({
        seq: genSeq,
        t: (mv.date || today()) + ' 12:00',
        date: mv.date,
        type: mv.type,
        ing: mv.gid,
        qty: r3(mv.qty),
        inCost: mv.cost,
        cost: g.avg,
        bal: r3(g.stock),
        ref: mv.ref
      });
      genSeq += 1;
    }
  }

  // 保留非重放日志（如 kind=loss 旁路），再并入重放流水
  const keep = arr(data.logs).filter((x) => x && typeof x === 'object'
    && ['期初', '采购入库', '盘点调整', '手工调整'].indexOf(x.type) < 0 && !x.seq);
  data.logs = keep.concat(gen);

  const stamp = nowIso();
  for (const g of ings) {
    // App 读 qty||stock，两边对齐
    g.qty = g.stock;
    g.last = null;
    // 打更新戳：三向合并时本机重算结果优先于对端旧 stock
    g._u = stamp;
  }

  const sortedRecv = arr(data.recv)
    .filter((p) => p && typeof p === 'object')
    .sort((a, b) => {
      const ka = (a.date || '') + '\u0000' + (a.no || '');
      const kb = (b.date || '') + '\u0000' + (b.no || '');
      return ka < kb ? 1 : ka > kb ? -1 : 0; // reverse
    });
  for (const po of sortedRecv) {
    for (const l of arr(po.lines)) {
      const g = ingMap.get(String((l && (l.ing != null ? l.ing : l.ing_id)) || ''));
      // 对齐 Python l.get("price")：缺失即 null（不可留 undefined，否则 JSON 丢键）
      if (g && g.last === null) g.last = l && l.price !== undefined ? l.price : null;
    }
  }

  return 'rebuild_stock 完成 ings=' + ings.length + ' moves=' + moves.length;
}

/** 从 payload 的 ing_id / name / ing_name 解析原料并返回（对齐 Python resolve_ing_id） */
function resolveIng(data, payload) {
  const ings = arr(data && data.ings);
  const pid = payload && (payload.ing_id != null ? payload.ing_id : payload.id);
  if (pid !== undefined && pid !== null) {
    const hit = ings.find((g) => String(g.id) === String(pid));
    if (hit) return hit;
  }
  const name = String((payload && (payload.name || payload.ing_name)) || '').trim();
  if (!name) return null;
  return ings.find((g) => String(g.name || '').trim() === name)
    || ings.find((g) => String(g.name || '').indexOf(name) >= 0)
    || null;
}

module.exports = { rebuildStock, resolveIng };
