'use strict';
/*
 * routes/safety.js — 食安拍照上报：只读进度端点
 *
 *   GET /api/safety/progress?date=YYYY-MM-DD
 *       → {ok, date, total_points, completed_points, pass_count, fail_count,
 *          review_count, error_count, using_defaults, points[], rev}
 *
 * 红线（本文件自查）：
 *   - **只读**：只调用 loadSnapshot()，不写库、不入队、不改快照，无任何 writeFile/enqueue 调用；
 *   - 图片只透传 photo_url 引用，绝不携带图片本体/base64；
 *   - 任何写操作（safety.check / safety.ai_judge / safety.review）一律走 POST /api/actions。
 *
 * 口径见 docs/safety-schema.md §3；点位空态回退内置种子点位（bff/lib/safety_plan.js）。
 */
const { loadSnapshot } = require('./snapshot');
const plan = require('../lib/safety_plan');

function q1(url, key) {
  const v = url && url.get ? url.get(key) : null;
  return v == null ? null : String(v);
}

function handle(req, res, ctx, pathname) {
  if (pathname !== '/api/safety/progress') return false;
  /* 只读端点：非 GET/HEAD 一律不接管（不吞掉同前缀的写路由） */
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  const snap = loadSnapshot();
  const data = (snap && snap.data) || {};
  const rep = plan.progressReport(data, q1(ctx.query, 'date'));

  ctx.sendJSON(res, 200, Object.assign({
    ok: true,
    rev: snap ? snap.rev : null,
    generated_at: (snap && snap.generated_at) || null,
    hint: snap ? null : 'no_snapshot',
    updated_at: new Date().toISOString()
  }, rep));
  return true;
}

module.exports = { handle };
