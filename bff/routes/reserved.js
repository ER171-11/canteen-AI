'use strict';
/*
 * routes/reserved.js — 前厅模块接口预留层（美团承接期）。
 *
 *   GET /api/vip | /api/pos | /api/takeout | /api/booking | /api/review
 *     - meituan 模式（默认）：返回固定预留契约
 *         {code:200, data:{provider:'meituan', status:'reserved', switchable:true, module, note}, rev}
 *     - self 模式：委托 modules.js 走真实只读层（现有 real*Insight）
 *
 * 严守红线：只读/空操作，绝不写库。provider 切换只改变「读哪层」。
 */
const provider = require('../lib/provider');
const modules = require('./modules');
const { loadSnapshot } = require('./snapshot');

const RESERVED_NOTE =
  '前厅运营由美团承接，接口已预留；置 FRONT_OF_HOUSE_PROVIDER=self 后启用自营只读层';

function handle(req, res, ctx, pathname) {
  if (req.method !== 'GET') return false;
  const m = pathname.match(/^\/api\/([a-z]+)(\/.*)?$/);
  if (!m) return false;
  const prefix = m[1];
  if (!provider.isFrontHouseModule(prefix)) return false;

  // self 模式：委托真实只读层（/api/modules/<prefix>），前厅数据照常可读
  if (provider.isSelf()) {
    return modules.handle(req, res, ctx, '/api/modules/' + prefix);
  }

  // meituan 模式：预留契约
  const snap = loadSnapshot();
  ctx.sendJSON(res, 200, {
    code: 200,
    data: {
      provider: 'meituan',
      status: 'reserved',
      switchable: true,
      module: prefix,
      note: RESERVED_NOTE
    },
    rev: snap ? snap.rev : null,
    msg: 'reserved'
  });
  return true;
}

module.exports = { handle };
