'use strict';
/*
 * routes/sync.js —— docx 写回契约适配层（红线②：所有写操作统一进 actions 队列，不直接写库）
 *
 * docx 通用写回协议：
 *   POST /api/sync  { action, payload, rev }
 *   后端校验 rev → 三向合并 → 写库 → 返回新 rev
 *
 * 现有栈实现：校验 rev 在「确认」环节（/api/actions/{id}/confirm）做，真正的三向合并+写库
 * 由确认台触发（BFF /apply 或店内消费者 /execute）。因此本层只做「统一入口 + rev 预校验 +
 * 入队」，不在此处直接写库，确保满足 docx「所有写回必须经确认台人工确认，禁止自动执行」的红线。
 *
 * 请求体（docx 字段 → 现有字段）：
 *   action  → type        （shift_swap / clock_patch / train_pass / vip_recharge / coupon_use /
 *                            birthday_coupon_send / table_status_change / order_split / order_merge /
 *                            payment / hanging 等）
 *   payload → payload
 *   rev     → 客户端乐观锁版本（与当前快照 rev 不符直接 409；权威校验仍以 confirm 为准）
 *
 * 响应体（对齐 docx 通用响应格式）：
 *   { code: 200, data: { id, status, rev }, rev, msg }
 */
const { enqueue } = require('./actions');
const { mayWriteActions } = require('../lib/auth');
const { loadSnapshot } = require('./snapshot');

function handle(req, res, ctx, pathname) {
  if (req.method !== 'POST' || pathname !== '/api/sync') return false;

  if (!ctx.auth) {
    ctx.sendJSON(res, 401, { ok: false, error: 'unauthorized: bearer token required' });
    return true;
  }
  if (!mayWriteActions(ctx.auth)) {
    ctx.sendJSON(res, 403, {
      ok: false,
      error: 'forbidden: actions.write required（当前账号只读，请用老板/店长登录）'
    });
    return true;
  }

  return (async () => {
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    if (!body || !String(body.action || '').trim()) {
      ctx.sendJSON(res, 400, { ok: false, error: 'missing action' });
      return true;
    }

    // 乐观锁预校验：客户端 rev 与当前快照 rev 不符 → 直接拒绝（权威校验在 confirm 环节）
    const snap = loadSnapshot();
    const curRev = snap ? snap.rev : null;
    if (body.rev != null && String(body.rev) !== String(curRev)) {
      ctx.sendJSON(res, 409, {
        ok: false, error: 'rev mismatch', expected_rev: curRev, got_rev: body.rev
      });
      return true;
    }

    const operator = body.operator || ctx.auth.account || ctx.auth.role || null;
    const { action, dedup, dedup_of: dupOf } = enqueue(
      body.action, body.payload == null ? {} : body.payload, operator, ctx.traceId, {}
    );

    ctx.sendJSON(res, 200, {
      code: 200,
      data: { id: action.id, status: action.status, rev: action.rev },
      rev: action.rev,
      msg: dedup ? ('dedup: ' + (dupOf || 'open')) : 'queued',
      ok: true,
      dedup
    });
    return true;
  })();
}

module.exports = { handle };
