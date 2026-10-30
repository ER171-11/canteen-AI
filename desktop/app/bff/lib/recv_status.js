'use strict';
/*
 * lib/recv_status.js — 进货单状态口径的**唯一出口**（凭证层 / 账务层两段式）
 *
 * 为什么要单独一个文件：这条判定原来在四处各写一份，口径已经出现细微分叉
 *   · lib/algorithms/stock.js:46-50        库存重算跳过「草稿 / 待收 / 作废」
 *   · routes/report.js:159-164             isInboundEffective（打烊入库、采购应付）
 *   · routes/modules.js:1676-1677          今日采购统计
 *   · lib/workbench.js:182                 到货验收工作台
 * 新增一个状态（如「待审核」）只改一处必然漂移：库存不动、应付却虚增，属假绿。
 *
 * 两段式（ADR-004 §2.5）：
 *   ① 凭证层：`recv.inbound` / `recv.import` 带 draft:true → 单据落库 status='待审核'，
 *      **立即出现在列表、可打结算单**，但不进库存 / 不进应付（老板在系统外审单）。
 *   ② 账务层：`recv.post` 审批确认 → status='已入库' + rebuildStock，库存与应付才变化。
 *
 * 状态取值：
 *   待审核  —— 已登记、未记账（isPendingReview）
 *   已入库  —— 已记账（isEffective）
 *   草稿 / 待收 / 待验 —— 未到货或未确认的旧状态（isEffective=false）
 *   已作废 / void —— 留痕作废，永不生效（isVoided）
 *   空       —— 兼容早期数据：视为已入库（与 report.js 历史口径一致）
 */

/** 已登记待记账（凭证层） */
const PENDING_REVIEW = '待审核';
/** 已记账（账务层） */
const EFFECTIVE = '已入库';

function statusOf(doc) {
  return String((doc && doc.status) || '').trim();
}

/** 作废：只留痕不物理删，永不进任何口径 */
function isVoided(doc) {
  return /作废|void/i.test(statusOf(doc));
}

/** 草稿（尚未提交的旧状态） */
function isDraft(doc) {
  return /草稿|draft/i.test(statusOf(doc));
}

/** 已登记、待审批记账（本期新增的凭证层状态） */
function isPendingReview(doc) {
  const st = statusOf(doc);
  if (!st || isVoided(doc)) return false;
  return st.indexOf(PENDING_REVIEW) >= 0;
}

/**
 * 是否已记账生效：库存 / 均价 / 应付 / 采购统计的唯一判据。
 * 未写 status 的历史数据按「已入库」处理（保持既有数据不突变）。
 */
function isEffective(doc) {
  const st = statusOf(doc);
  if (!st) return true;
  if (isVoided(doc) || isDraft(doc) || isPendingReview(doc)) return false;
  if (/待|pending|取消|cancel/i.test(st)) return false;
  return /已入库|done|入库/i.test(st);
}

/** 待验收（工作台用）：既没记账、也没作废、也不是待审核 —— 即真正还没收货的单 */
function isPendingAccept(doc) {
  return !isEffective(doc) && !isVoided(doc) && !isPendingReview(doc);
}

module.exports = {
  PENDING_REVIEW,
  EFFECTIVE,
  statusOf,
  isVoided,
  isDraft,
  isPendingReview,
  isEffective,
  isPendingAccept
};
