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
const inspection = require('./inspection');
const safetyPoint = require('./safety_point');
const safetyCheck = require('./safety_check');
const sale = require('./sale');
const terms = require('./terms');
const maint = require('./maint');

/* 库存算法：入库/盘点后重算 stock/qty/avg */
registerAll({
  'stock.rebuild': (ctx, data) => ({ message: stock.rebuildStock(data) })
});

/* 进销存域：迁移自 queue_consumer.py 的 apply_* / insert_* */
registerAll({
  'restock.create': (ctx, data, payload) => inv.applyRestock(data, payload),
  'analysis.restock': (ctx, data, payload) => inv.applyRestock(data, payload),
  'order.fromRestock': (ctx, data, payload) => inv.applyRestockToOrders(data, payload),
  'config.update': (ctx, data, payload) => inv.applyConfig(data, payload),
  'rest.update': (ctx, data, payload) => inv.applyRest(data, payload),
  'ing.upsert': (ctx, data, payload) => inv.applyIngUpsert(data, payload),
  'quote.upsert': (ctx, data, payload) => inv.applyQuoteUpsert(data, payload),
  'loss.report': (ctx, data, payload) => inv.applyLossReport(data, payload, ctx),
  'loss.approve': (ctx, data, payload) => inv.approveLossReport(ctx, data, payload),
  'loss.reject': (ctx, data, payload) => inv.rejectLossReport(ctx, data, payload),
  'recv.inbound': (ctx, data, payload) => inv.applyRecvInbound(data, payload),
  'recv.accept': (ctx, data, payload) => inv.insertRecvAccept(ctx, payload),
  /* 编辑/作废：做成建议动作走审批队列，不直写库；作废只留痕、不物理删除 */
  'recv.update': (ctx, data, payload) => inv.applyRecvUpdate(data, payload),
  'recv.void': (ctx, data, payload) => inv.applyRecvVoid(data, payload, ctx),
  /* 批量导入：预览在 lib/recv_import.js（纯计算、零写），这里只接「提交」——整批一个动作（ADR-004 §2.4） */
  'recv.import': (ctx, data, payload) => inv.applyRecvImport(data, payload),
  /* 补付 / 欠款清收：不登记 type 会被消费器判 need-manual 驳回（consumer.js:9） */
  'recv.pay': (ctx, data, payload) => inv.applyRecvPay(data, payload),
  'stock.count': (ctx, data, payload) => inv.applyStockCount(data, payload, ctx),
  'order.mark': (ctx, data, payload) => inv.applyOrderMark(data, payload),
  'order.pay': (ctx, data, payload) => inv.applyOrderPay(data, payload),
  'order.close': (ctx, data, payload) => inv.applyOrderClose(data, payload),
  'order.void': (ctx, data, payload) => inv.applyOrderVoid(data, payload),
  'order.restore': (ctx, data, payload) => inv.applyOrderRestore(data, payload),
  'order.delete': (ctx, data, payload) => inv.applyOrderDelete(data, payload),
  /* FP-PO-01/02 新建/编辑采购单：与 order.* 同型建议动作，只改 data.orders（不入库） */
  'po.create': (ctx, data, payload) => inv.applyOrderCreate(data, payload),
  'po.edit': (ctx, data, payload) => inv.applyOrderEdit(data, payload),
  /* FP-PO-17/19/20 补货参数 / 忽略建议行 / 行内调整记回主数据（只改 data.restock 与 data.plans） */
  'restock.config': (ctx, data, payload) => inv.applyRestockConfig(data, payload),
  'restock.ignore': (ctx, data, payload) => inv.applyRestockIgnore(data, payload),
  'restock.adjust': (ctx, data, payload) => inv.applyRestockAdjust(data, payload),
  'vendor.upsert': (ctx, data, payload) => inv.upsertVendor(data, payload, ctx),
  /* 供应商档案删除（错建/重复档案清理）：有往来账禁删，报价与单据历史不删 */
  'vendor.delete': (ctx, data, payload) => inv.applyVendorDelete(data, payload, ctx),
  'supply.po': (ctx, data, payload) => (
    inv.applyRestock(data, payload) + ' + ' + inv.insertSupplyPo(ctx, payload)
  )
});

/* 菜品/配方域：迁移自 queue_consumer.py 的 dish/recipe 算法 */
registerAll({
  'dish.upsert': (ctx, data, payload) => dish.applyDishUpsert(data, payload),
  'dish.price': (ctx, data, payload) => dish.applyDishPrice(data, payload),
  'dish.set_active': (ctx, data, payload) => dish.applyDishSetActive(data, payload),
  /* FP-DISH-06 删除菜品：有销售记录禁删（旧版 delDish 同口径） */
  'dish.delete': (ctx, data, payload) => dish.applyDishDelete(data, payload),
  'dish.auto_link': (ctx, data, payload) => dish.applyDishAutoLink(ctx, data, payload),
  'recipe.upsert': (ctx, data, payload) => dish.upsertRecipe(ctx, data, payload),
  /* FP-DISH-16/18 食谱卡批量导入：预览在 lib/recipe_import.js（纯计算零写），这里只接「提交」 */
  'recipe.import': (ctx, data, payload) => dish.applyRecipeImport(ctx, data, payload),
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

/* 销售收银域（FP-SALE-07/08/11）：ADR-008 销售应收模型 + ADR-009 统一动作队列。
 * 与 recv.update/void/pay 同型（唯一写入口、动作注册、状态机、作废留痕、rev 乐观锁）； */
registerAll({
  'sale.create': (ctx, data, payload) => sale.applySaleCreate(data, payload, ctx),
  'sale.pay': (ctx, data, payload) => sale.applySalePay(data, payload, ctx),
  'sale.void': (ctx, data, payload) => sale.applySaleVoid(data, payload, ctx),
  'sale.update': (ctx, data, payload) => sale.applySaleUpdate(data, payload, ctx),
  /* 平台销售导入链路（FP-SALE-03/04/05/06）：预览只读在 lib/sales_import.js，这里只接「提交」 */
  'sale.import': (ctx, data, payload) => sale.applySaleImport(data, payload, ctx),
  'sale.batch_void': (ctx, data, payload) => sale.applySaleBatchVoid(data, payload, ctx),
  'sale.amt_recalc': (ctx, data, payload) => sale.applySaleAmtRecalc(data, payload),
  'sale.alias_set': (ctx, data, payload) => sale.applyDishAliasSet(data, payload),
  'sale.alias_delete': (ctx, data, payload) => sale.applyDishAliasDelete(data, payload)
});

/* 餐饮运营/人员/食安/会员/财务/设备：迁移自 queue_consumer.py 的 insert_* / apply_* / upsert_* */
registerAll({
  'qc.record': (ctx, data, payload) => ops.insertQcRecord(ctx, data, payload),
  'qc.pass': (ctx, data, payload) => ops.insertQcRecord(ctx, data, payload),
  'plate.pass': (ctx, data, payload) => ops.insertQcRecord(ctx, data, payload),
  'qc.force_pass': (ctx, data, payload) => ops.insertQcForcePass(ctx, data, payload),
  'queue.serve': (ctx, data, payload) => ops.applyQueueServe(ctx, data, payload),
  'sample.log': (ctx, data, payload) => ops.insertSample(ctx, data, payload),
  'fs.sample_clear': (ctx, data, payload) => ops.clearSample(ctx, data, payload),
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
  'staff.upsert': (ctx, data, payload) => ops.upsertStaff(ctx, data, payload),
  'uniform.log': (ctx, data, payload) => ops.insertUniformLog(ctx, data, payload),
  'fs.disinfect': (ctx, data, payload) => ops.insertDisinfect(ctx, data, payload),
  'fs.trace_scan': (ctx, data, payload) => ops.insertFsTrace(ctx, data, payload),
  'equipment.maintain': (ctx, data, payload) => ops.insertEqMaintain(ctx, data, payload),
  'equipment.temp_log': (ctx, data, payload) => ops.insertEqTemp(ctx, data, payload),
  'equipment.energy_log': (ctx, data, payload) => ops.insertEqEnergy(ctx, data, payload),
  'vip.campaign': (ctx, data, payload) => ops.insertVipCampaign(ctx, data, payload),
  'vip.coupon_redeem': (ctx, data, payload) => ops.redeemVipCoupon(ctx, data, payload),
  'vip.balance_deduct': (ctx, data, payload) => ops.deductVipBalance(ctx, data, payload),
  'analysis.export_week': (ctx, data, payload) => ops.insertWeekExport(ctx, data, payload),
  'takeout.ack': (ctx, data, payload) => ops.insertTakeoutAck(ctx, data, payload),
  'review.followup': (ctx, data, payload) => ops.insertReviewFollowup(ctx, data, payload),
  'vip.checkin': (ctx, data, payload) => ops.insertVipCheckin(ctx, data, payload),
  'finance.freeze': (ctx, data, payload) => ops.insertFinSplit(ctx, data, payload, false),
  'finance.approve': (ctx, data, payload) => ops.insertFinSplit(ctx, data, payload, true),
  'finance.invoice': (ctx, data, payload) => ops.insertFinInvoice(ctx, data, payload),
  'finance.tax': (ctx, data, payload) => ops.insertFinTax(ctx, data, payload),
  'finance.cash': (ctx, data, payload) => ops.insertFinCash(ctx, data, payload)
});

/* 闭店巡检域（C/D 块）：巡检照片只存手机本地，本域不接收任何图片字段 */
registerAll({
  'inspection.record': (ctx, data, payload) => inspection.recordInspection(ctx, data, payload),
  'inspection.assign': (ctx, data, payload) => inspection.assignInspection(ctx, data, payload)
});

/* 食安点位主数据域：巡检点 / 消毒点的增删改，写快照 ext.fs_points（走审批队列） */
registerAll({
  'safety_point.upsert': (ctx, data, payload) => safetyPoint.upsertSafetyPoint(ctx, data, payload),
  'safety_point.seed': (ctx, data, payload) => safetyPoint.seedSafetyPoints(ctx, data, payload),
  'safety_point.remove': (ctx, data, payload) => safetyPoint.removeSafetyPoint(ctx, data, payload)
});

/* 食安拍照上报域：员工拍照 → AI 初判 → 人工复核，写快照 data.safety.checks（走审批队列）
 * 红线：AI 初判（ai_result）与人工结论（final_result）分列存储，人工优先；
 *       safety.review 已在 lib/policy.js 的 NEVER_AUTO 中，永不允许自动执行。 */
registerAll({
  'safety.check': (ctx, data, payload) => safetyCheck.submitSafetyCheck(ctx, data, payload),
  'safety.ai_judge': (ctx, data, payload) => safetyCheck.aiJudgeSafetyCheck(ctx, data, payload),
  'safety.review': (ctx, data, payload) => safetyCheck.reviewSafetyCheck(ctx, data, payload)
});

/* loss.report 的 data 侧与 SQLite 旁路均已由 inv.applyLossReport 处理（内含 loss_reports 写入） */

/* W2 商品库受控词表 + 结构化属性 Tag（Node 超集，无 Python 对拍）：
 *   term.upsert   词条申请/审核/上架（受控词表 term{id,name,category,aliases,status}）
 *   ing.attr_set  给原料关联受控词条 ID + 自定义营销 Tag（只改 ings[].tags，不进成本口径） */
registerAll({
  'term.upsert': (ctx, data, payload) => terms.applyTermUpsert(data, payload),
  'ing.attr_set': (ctx, data, payload) => terms.applyIngAttrSet(data, payload)
});

/* Phase 2 供应商类目受控词表（最小侵入：data.vendor_terms 独立数组，不升 schema）：
 *   supplier_term.upsert   供应商类目词条申请/审核/上架（S 前缀 + 「供应商类目」维度）
 *   vendor.attr_set        给供应商设置受控类目（单选标量 vendor.category，禁自定义标签）
 *   vendor_term.backfill   存量 vendor.category 自由文本 → 词条 ID 归一（幂等） */
registerAll({
  'supplier_term.upsert': (ctx, data, payload) => terms.applyVendorTermUpsert(data, payload),
  'vendor.attr_set': (ctx, data, payload) => terms.applyVendorAttrSet(data, payload, ctx),
  'vendor_term.backfill': (ctx, data, payload) => terms.applyVendorTermBackfill(data, ctx)
});

/* 测试期维护清理（隐藏能力，正式版无前端入口）：
 *   maint.row_delete  按白名单表 + 非空 where 物理删行（ext/店内表 + data.ext 兜底），
 *                     入口走审批队列，审批中心可见、可驳回、全程留痕 */
registerAll({
  'maint.row_delete': (ctx, data, payload) => maint.applyRowDelete(ctx, data, payload)
});

module.exports = { stock, inv, dish, pos, ops, inspection, safetyPoint, safetyCheck, terms, maint };
