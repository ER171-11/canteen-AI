'use strict';
/*
 * lib/provider.js — 前厅运营承接方切换（与美团深度合作）。
 *
 * 默认 meituan：前厅 5 模块（会员营销 / 堂食收银 / 外卖平台 / 预订排队 / 顾客口碑）
 *   接口仅预留、不接业务、不写库；置 FRONT_OF_HOUSE_PROVIDER=self 后可切回自营
 *   （reserved 路由改走真实只读层 + 写回动作允许消费）。
 *
 * 红线：provider 切换只影响「读哪层 + 是否允许消费动作」，任何模式下前厅 reserved
 *   路由与占位页都必须是只读/空操作，绝不引入写库副作用。
 */
const FRONT_HOUSE_MODULES = ['vip', 'pos', 'takeout', 'booking', 'review'];

// 前厅写回 action 枚举（docx 草案，切回自营后启用；meituan 模式一律不写库）
const FRONT_HOUSE_ACTIONS = [
  // 会员营销 (M3)
  'vip_recharge', 'vip_coupon', 'vip_point', 'vip_birthday_coupon',
  // 堂食收银 (M5)
  'pos_order', 'pos_payment', 'pos_refund', 'pos_table_status',
  // 外卖平台 (M6)
  'takeout_order', 'takeout_sync',
  // 预订排队 (M7)
  'booking_create', 'booking_checkin', 'booking_queue', 'table_merge', 'table_split',
  // 顾客口碑 (M11)
  'review_reply', 'review_push'
];

function frontHouseProvider() {
  const v = String(process.env.FRONT_OF_HOUSE_PROVIDER || 'meituan').trim().toLowerCase();
  return v === 'self' ? 'self' : 'meituan';
}

function isSelf() { return frontHouseProvider() === 'self'; }

function isFrontHouseModule(prefix) {
  return FRONT_HOUSE_MODULES.indexOf(String(prefix || '').toLowerCase()) >= 0;
}

function isFrontHouseAction(type) {
  const t = String(type || '').toLowerCase();
  if (FRONT_HOUSE_ACTIONS.indexOf(t) >= 0) return true;
  // 前缀匹配：vip_* / pos_* / takeout_* / booking_* / review_*
  const p = t.split('_')[0];
  return isFrontHouseModule(p);
}

module.exports = {
  FRONT_HOUSE_MODULES,
  FRONT_HOUSE_ACTIONS,
  frontHouseProvider,
  isSelf,
  isFrontHouseModule,
  isFrontHouseAction
};
