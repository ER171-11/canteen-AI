'use strict';
/*
 * lib/algorithms/safety_check.js — 食安拍照上报三步算法（快照 data.safety.checks）
 *
 * 算法约定（全项目统一）：handler(ctx, data, payload) → result；抛错 = 动作被驳回。
 * 落点见 docs/safety-schema.md：data.safety.points（点位于 lib/safety_plan.js 兜底）/ data.safety.checks。
 *
 * 动作：
 *   safety.check     员工拍照上报：新增一条 checks（ai_result='pending'）；**不调用外部 AI**（员工端不等待）
 *   safety.ai_judge  异步 AI 初判：更新 ai_result/ai_reason/ai_confidence/model；失败写 error，不删记录、不动 final_result
 *   safety.review    人工复核（老板/店长）：写 final_result + review_reason；**保留 ai_result**，可多次复核以最新为准
 *
 * 红线：
 *   - 只写快照 data，不写店内 DB、不直连外部系统（AI 只在 ai_judge 里、且可注入）。
 *   - AI 初判（ai_result）与人工结论（final_result）分列存储，人工优先；
 *     safety.review 已在 lib/policy.js 的 NEVER_AUTO 中，不可自动执行。
 *   - 图片只存 photo_url 引用，本模块不接收、不写入任何图片字节/base64。
 */
const crypto = require('crypto');
const plan = require('../safety_plan');

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

function nowIso(ctx) {
  return (ctx && ctx.now) || new Date().toISOString();
}

/** 生成核验记录 id：chk_ + base36 时间戳 + 6 位随机 */
function newCheckId() {
  return 'chk_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

/** 取（必要时创建）data.safety 子树 */
function safetyOf(data) {
  if (!data || typeof data !== 'object') throw new Error('safety.check 需要可写 data 快照');
  if (!data.safety || typeof data.safety !== 'object' || Array.isArray(data.safety)) data.safety = {};
  return data.safety;
}

function checksOf(data) {
  const s = safetyOf(data);
  if (!Array.isArray(s.checks)) s.checks = [];
  return s.checks;
}

function findCheck(data, checkId) {
  const id = str(checkId);
  if (!id) return null;
  return checksOf(data).find((c) => c && str(c.id) === id) || null;
}

/**
 * safety.check — 员工拍照上报（入队 → 确认 → 执行）。
 * payload: { point_id, photo_url?, taken_at?, operator?, check_id? }
 * 返回 { ok:true, check_id, data:{safety}, ext }（data 只回传 safety 子树，避免把整库塞进动作结果）
 */
function submitSafetyCheck(ctx, data, payload) {
  const p = payload || {};
  const pointId = str(p.point_id);
  if (!pointId) throw new Error('safety.check point_id 必填');

  const point = plan.findPoint(data, pointId);
  if (!point) throw new Error('未知食安点位: ' + pointId);

  const givenId = str(p.check_id);
  if (givenId && findCheck(data, givenId)) throw new Error('check_id 已存在: ' + givenId);

  const photoUrl = p.photo_url === undefined || p.photo_url === null ? null : String(p.photo_url).trim() || null;
  const operator = str(p.operator) || str(p.submitted_by) || str(ctx && ctx.operator) || null;
  // 现场拍摄时刻优先；缺省用执行时刻（员工端不等待 AI，created_at 即上报时刻）
  const createdAt = str(p.taken_at) || nowIso(ctx);

  const row = {
    id: givenId || newCheckId(),
    point_id: pointId,
    operator: operator,
    photo_url: photoUrl,
    /* AI 初判：上报时不等待，置 pending，由 safety.ai_judge 异步回填 */
    ai_result: 'pending',
    ai_reason: null,
    ai_confidence: null,
    /* 人工复核：只有 safety.review 能写 */
    final_result: null,
    review_reason: null,
    status: 'pending',
    created_at: createdAt,
    reviewed_at: null,
    reviewed_by: null,
    model: null
  };
  checksOf(data).push(row);

  return {
    ok: true,
    check_id: row.id,
    status: row.status,
    point_id: row.point_id,
    data: { safety: safetyOf(data) },
    ext: (ctx && ctx.store && ctx.store.ext) || null
  };
}

/** AI 初判入口：可注入（测试/店内消费器），缺省用 lib/safety_vision */
function visionOf(ctx) {
  if (ctx && typeof ctx.vision === 'function') return ctx.vision;
  if (ctx && ctx.vision && typeof ctx.vision.judge === 'function') return (input) => ctx.vision.judge(input);
  return (input) => require('../safety_vision').judge(input);
}

/**
 * safety.ai_judge — 异步 AI 初判（员工端不等待，两个动作解耦）。
 * payload: { check_id }
 * 失败（未配置/取图失败/解析失败）→ 该条记 ai_result='error' + ai_reason，**保留记录、不动 final_result**。
 */
async function aiJudgeSafetyCheck(ctx, data, payload) {
  const p = payload || {};
  const checkId = str(p.check_id);
  if (!checkId) throw new Error('safety.ai_judge check_id 必填');
  const check = findCheck(data, checkId);
  if (!check) throw new Error('未找到核验记录: ' + checkId);

  const point = plan.findPoint(data, check.point_id);
  let judged = null;
  let failure = null;
  try {
    judged = await visionOf(ctx)({
      photo_url: check.photo_url,
      point: point || { id: check.point_id, name: '', zone: '', target: '' }
    });
  } catch (e) {
    failure = (e && e.message) || String(e);
  }

  if (!judged || !judged.ai_result) {
    check.ai_result = 'error';
    check.ai_reason = failure
      ? ('AI 初判失败: ' + failure)
      : 'AI 初判失败: 视觉模型未配置或不可用（检查 KIMI_API_KEY / photo_url 可访问性）';
    check.ai_confidence = null;
    check.status = 'error';
    check.model = null;
    return { ok: true, check_id: check.id, ai_result: 'error', ai_reason: check.ai_reason, data: { safety: safetyOf(data) } };
  }

  check.ai_result = judged.ai_result;
  check.ai_reason = judged.ai_reason == null ? null : String(judged.ai_reason);
  check.ai_confidence = judged.ai_confidence == null ? null : judged.ai_confidence;
  check.model = judged.model == null ? null : String(judged.model);
  check.status = 'ai_done';
  /* 红线：AI 初判绝不写 final_result（人工结论只能由 safety.review 写） */
  return {
    ok: true,
    check_id: check.id,
    ai_result: check.ai_result,
    ai_reason: check.ai_reason,
    ai_confidence: check.ai_confidence,
    low_conf: judged.low_conf === true,
    need_review: judged.ai_result === 'fail' || judged.low_conf === true,
    data: { safety: safetyOf(data) }
  };
}

/**
 * safety.review — 老板/店长人工改判（分级授权 NEVER_AUTO：必须人工确认）。
 * payload: { check_id, final_result('pass'|'fail'), reason? }
 * 同一 check 可多次复核，以最新为准；ai_result 原样保留（不允许清空）。
 */
function reviewSafetyCheck(ctx, data, payload) {
  const p = payload || {};
  const checkId = str(p.check_id);
  if (!checkId) throw new Error('safety.review check_id 必填');
  const check = findCheck(data, checkId);
  if (!check) throw new Error('未找到核验记录: ' + checkId);

  const finalResult = str(p.final_result || p.result).toLowerCase();
  if (finalResult !== 'pass' && finalResult !== 'fail') {
    throw new Error('safety.review final_result 必填(pass|fail)');
  }
  /*
   * AI 未回（pending）或初判失败（error）时**仍允许**人工下结论——
   * 人工结论优先于 AI 初判；若此处拦死，AI 不可用时现场就无法闭环。
   */

  check.final_result = finalResult;
  check.review_reason = str(p.reason || p.review_reason) || null;
  check.status = 'reviewed';
  check.reviewed_at = nowIso(ctx);
  check.reviewed_by = str(p.reviewer) || str(p.operator) || (ctx && ctx.operator) || null;
  /* 红线：ai_result 不被清空/覆盖，保留 AI 原始初判供审计与回溯 */

  return {
    ok: true,
    check_id: check.id,
    final_result: check.final_result,
    ai_result: check.ai_result,
    review_reason: check.review_reason,
    reviewed_by: check.reviewed_by,
    data: { safety: safetyOf(data) }
  };
}

module.exports = {
  newCheckId,
  submitSafetyCheck,
  aiJudgeSafetyCheck,
  reviewSafetyCheck
};
