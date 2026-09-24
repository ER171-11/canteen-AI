'use strict';
/*
 * routes/agent.js — agent 对话桩（红线①：只读，绝不调用任何写路径）
 *   POST /api/agent/chat {question, ctx}
 *     → {ok, cards:[], suggestions:[], trace_id, note:"agent 决策层待 Sprint4"}
 */
async function handle(req, res, ctx, pathname) {
  if (req.method === 'POST' && pathname === '/api/agent/chat') {
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    body = body || {};
    ctx.sendJSON(res, 200, {
      ok: true,
      cards: [],
      suggestions: ['今日营收怎么样？', '哪些原料需要补货？', '昨日品控合格率？'],
      trace_id: ctx.traceId,
      echo: typeof body.question === 'string' ? body.question.slice(0, 200) : null,
      note: 'agent 决策层待 Sprint4'
    });
    return true;
  }
  return false;
}

module.exports = { handle };
