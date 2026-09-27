'use strict';
/*
 * lib/algorithms/registry.js — 算法注册入口
 * 分批迁移：每批在此 require 并 registerAll，BFF 只依赖此文件拿到全部算法。
 */

const { registerAll } = require('./index');
const stock = require('./stock');
const inv = require('./inventory');
const pos = require('./pos');
const dish = require('./dish');
const ops = require('./ops');

/* 库存算法：入库/盘点后重算 stock/qty/avg */
registerAll({
  'stock.rebuild': (ctx, data) => ({ message: stock.rebuildStock(data) })
});

/* 进销存域：迁移自 queue_consumer.py 的 apply_* / insert_* */
registerAll({
  'restock.create': (ctx, data, payload) => inv.applyRestock(data, payload),
  'analysis.restock': (ctx, data, payload) => inv.applyRestock(data, payload),
  'config.update': (ctx, data, payload) => inv.applyConfig(data, payload),
  'ing.upsert': (ctx, data, payload) => inv.applyIngUpsert(data, payload),
  'quote.upsert': (ctx, data, payload) => inv.applyQuoteUpsert(data, payload),
  'loss.report': (ctx, data, payload) => inv.applyLossReport(data, payload, ctx),
  'recv.inbound': (ctx, data, payload) => inv.applyRecvInbound(data, payload),
  'recv.accept': (ctx, data, payload) => inv.insertRecvAccept(ctx, payload),
  'stock.count': (ctx, data, payload) => inv.applyStockCount(data, payload, ctx),
  'order.mark': (ctx, data, payload) => inv.applyOrderMark(data, payload),
  'vendor.upsert': (ctx, data, payload) => inv.upsertVendor(data, payload, ctx),
  'supply.po': (ctx, data, payload) => (
    inv.applyRestock(data, payload) + ' + ' + inv.insertSupplyPo(ctx, payload)
  )
});

/* 菜品/配方域：迁移自 queue_consumer.py 的 dish/recipe 算法 */
registerAll({
  'dish.upsert': (ctx, data, payload) => dish.applyDishUpsert(data, payload),
  'dish.price': (ctx, data, payload) => dish.applyDishPrice(data, payload),
  'dish.set_active': (ctx, data, payload) => dish.applyDishSetActive(data, payload),
  'dish.auto_link': (ctx, data, payload) => dish.applyDishAutoLink(ctx, data, payload),
  'recipe.upsert': (ctx, data, payload) => dish.upsertRecipe(ctx, data, payload),
  'recipe.substitute': (ctx, data, payload) => dish.insertRecipeSubstitute(ctx, data, payload)
});

/* POS/桌台/收银域：迁移自 queue_consumer.py 的 POS + BOM 扣料算法 */
registerAll({
  'pos.table_state': (ctx, data, payload) => pos.applyPosTableState(data, payload, ctx),
  'pos.table_upsert': (ctx, data, payload) => pos.applyPosTableUpsert(data, payload),
  'pos.table_remove': (ctx, data, payload) => pos.applyPosTableRemove(data, payload),
  'pos.rush': (ctx, data, payload) => pos.applyPosServiceNote(data, payload, 'rush', ctx),
  'pos.pack': (ctx, data, payload) => pos.applyPosServiceNote(data, payload, 'pack', ctx),
  'pos.ready': (ctx, data, payload) => pos.applyPosServiceNote(data, payload, 'ready', ctx),
  'pos.pass': (ctx, data, payload) => pos.applyPosServiceNote(data, payload, 'pass', ctx),
  'pos.service_note': (ctx, data, payload) => (
    pos.applyPosServiceNote(data, payload, payload.kind || 'rush', ctx)
  ),
  'pos.void': (ctx, data, payload) => pos.applyPosVoid(data, payload),
  'pos.pay': (ctx, data, payload) => pos.applyPosPay(data, payload, ctx),
  'pos.merge': (ctx, data, payload) => pos.applyPosMergeSplit(data, payload, 'merge', ctx),
  'pos.split': (ctx, data, payload) => pos.applyPosMergeSplit(data, payload, 'split', ctx)
});

/* 餐饮运营/人员/食安/会员/财务/设备：迁移自 queue_consumer.py 的 insert_* / apply_* / upsert_* */
registerAll({
  'qc.record': (ctx, data, payload) => ops.insertQcRecord(ctx, data, payload),
  'qc.pass': (ctx, data, payload) => ops.insertQcRecord(ctx, data, payload),
  'plate.pass': (ctx, data, payload) => ops.insertQcRecord(ctx, data, payload),
  'queue.serve': (ctx, data, payload) => ops.applyQueueServe(ctx, data, payload),
  'sample.log': (ctx, data, payload) => ops.insertSample(ctx, data, payload),
  'workorder.create': (ctx, data, payload) => ops.insertWorkorder(ctx, data, payload),
  'workorder.advance': (ctx, data, payload) => ops.advanceWorkorder(ctx, data, payload),
  'workorder.step_clock': (ctx, data, payload) => ops.clockWorkorderStep(ctx, data, payload),
  'fs.cert.upsert': (ctx, data, payload) => ops.insertFsCert(ctx, data, payload),
  'day.close': (ctx, data, payload) => ops.applyDayClose(ctx, data, payload),
  'finance.recon': (ctx, data, payload) => ops.applyFinanceRecon(ctx, data, payload),
  'booking.upsert': (ctx, data, payload) => ops.upsertBooking(ctx, data, payload),
  'queue.call': (ctx, data, payload) => ops.updateQueueCall(ctx, data, payload),
  'queue.join': (ctx, data, payload) => ops.insertQueueJoin(ctx, data, payload),
  'staff.clock': (ctx, data, payload) => ops.insertStaffClock(ctx, data, payload),
  'staff.shift_upsert': (ctx, data, payload) => ops.upsertStaffShift(ctx, data, payload),
  'uniform.log': (ctx, data, payload) => ops.insertUniformLog(ctx, data, payload),
  'fs.disinfect': (ctx, data, payload) => ops.insertDisinfect(ctx, data, payload),
  'fs.trace_scan': (ctx, data, payload) => ops.insertFsTrace(ctx, data, payload),
  'equipment.maintain': (ctx, data, payload) => ops.insertEqMaintain(ctx, data, payload),
  'vip.campaign': (ctx, data, payload) => ops.insertVipCampaign(ctx, data, payload),
  'vip.coupon_redeem': (ctx, data, payload) => ops.redeemVipCoupon(ctx, data, payload),
  'analysis.export_week': (ctx, data, payload) => ops.insertWeekExport(ctx, data, payload),
  'takeout.ack': (ctx, data, payload) => ops.insertTakeoutAck(ctx, data, payload),
  'review.followup': (ctx, data, payload) => ops.insertReviewFollowup(ctx, data, payload),
  'vip.checkin': (ctx, data, payload) => ops.insertVipCheckin(ctx, data, payload),
  'finance.freeze': (ctx, data, payload) => ops.insertFinSplit(ctx, data, payload, false),
  'finance.approve': (ctx, data, payload) => ops.insertFinSplit(ctx, data, payload, true)
});

/* loss.report 的 data 侧与 SQLite 旁路均已由 inv.applyLossReport 处理（内含 loss_reports 写入） */

module.exports = { stock, inv, dish, pos, ops };
