'use strict';
/*
 * routes/inbox.js — SI 收件箱（老板唯一的“谁在等我”入口）
 *
 *   GET  /api/inbox?since=      → 聚合：需拍板 / SI 正在办 / 异常 / SI 通知
 *   GET  /api/inbox/stream      → SSE：首帧 + 变化增量（前台实时，P0 无 FCM 时用）
 *   POST /api/inbox/ack         → {id} 或 {all:true} 标记 SI 通知已读
 *   POST /api/push/register     → {token, platform} 登记设备（后台轮询/未来 FCM）
 *
 * 红线：只读聚合 + 标记通知已读；绝不改快照/不入写队列。
 */
const store = require('../lib/store');
const push = require('../lib/push');
const { loadSnapshot } = require('./snapshot');
const { deriveReport } = require('./report');

const OPEN_DECIDE = 'queued';
const OPEN_DOING = '待执行';

function arr(v) { return Array.isArray(v) ? v : []; }

/* action.type → 深链（与 BossIa/HomeScreen 路由对齐） */
function routeForType(type) {
  const t = String(type || '');
  if (/^(restock|order|recv|ing|vendor|supply|quote|stock)\./.test(t)) return 'inventory';
  if (/^(pos)\./.test(t)) return 'm/pos';
  if (/^(booking|queue)\./.test(t)) return 'm/booking';
  if (/^(takeout|review)\./.test(t)) return 'm/takeout';
  if (/^(vip)\./.test(t)) return 'm/vip';
  if (/^(staff)\./.test(t)) return 'm/staff';
  if (/^(fs|sample|uniform)\./.test(t)) return 'm/foodsafe';
  if (/^(equipment)\./.test(t)) return 'm/equipment';
  if (/^(finance|day|loss)\./.test(t)) return 'm/finance';
  if (/^(dish|recipe|config|analysis)\./.test(t)) return 'm/restaurant';
  if (/^(workorder|qc|plate)\./.test(t)) return 'kitchen';
  return 'm/actions';
}

function actionItem(a, group) {
  return {
    id: a.id,
    group,
    level: group === 'decide' ? 'warn' : 'info',
    title: (a.payload && (a.payload.title || a.payload.note)) || humanType(a.type),
    summary: a.payload ? summarizePayload(a.payload) : '',
    type: a.type,
    status: a.status,
    route: routeForType(a.type),
    rev: a.rev,
    created_at: a.created_at
  };
}

function humanType(type) {
  const map = {
    'restock.create': '补货意向待确认',
    'day.close': '打烊日清待确认',
    'workorder.create': '建本餐工单待确认',
    'recipe.upsert': '菜谱变更待确认',
    'dish.price': '调价待确认',
    'dish.upsert': '菜品变更待确认',
    'config.update': '门店配置变更待确认',
    'recv.inbound': '入库待确认',
    'order.mark': '采购单状态待确认',
    'loss.report': '报损单待确认'
  };
  return map[type] || ('动作待确认 · ' + type);
}

function summarizePayload(p) {
  if (!p || typeof p !== 'object') return '';
  if (typeof p.note === 'string' && p.note) return p.note;
  if (Array.isArray(p.items)) return p.items.length + ' 项：' + p.items.slice(0, 3).map((i) => i.name).join('、');
  if (p.sku_id) return p.sku_id + (p.qty ? ' × ' + p.qty : '');
  const keys = Object.keys(p).slice(0, 3);
  return keys.map((k) => k + '=' + String(p[k])).join(' · ').slice(0, 120);
}

function buildInbox(snap) {
  const q = arr(store.readJSON('actions_queue.json', []));
  const decide = q.filter((a) => a.status === OPEN_DECIDE).map((a) => actionItem(a, 'decide'));
  const doing = q.filter((a) => a.status === OPEN_DOING).map((a) => actionItem(a, 'doing'));

  let alerts = [];
  if (snap && snap.data) {
    try {
      const rep = deriveReport(snap, (require('./report').todayStr()));
      alerts = arr(rep.alerts).map((a, i) => ({
        id: 'alert_' + i + '_' + String(a.text || '').slice(0, 12),
        group: 'alerts',
        level: a.level || 'warn',
        title: a.text || '预警',
        summary: a.desc || '',
        route: 'm/analysis',
        created_at: null
      }));
    } catch (e) { alerts = []; }
  }

  const feed = push.feed().filter((x) => !x.read).map((x) => ({
    id: x.id,
    group: 'feed',
    level: x.level || 'info',
    title: x.title,
    summary: x.body,
    route: x.route || 'm/inbox',
    kind: x.kind,
    created_at: x.ts
  }));

  return {
    ok: true,
    rev: snap ? snap.rev : null,
    generated_at: snap ? snap.generated_at : null,
    updated_at: new Date().toISOString(),
    counts: {
      decide: decide.length,
      doing: doing.length,
      alerts: alerts.length,
      feed: feed.length,
      total: decide.length + doing.length + alerts.length + feed.length
    },
    decide,
    doing,
    alerts,
    feed
  };
}

function fingerPrint(view) {
  return JSON.stringify([view.counts, view.decide.map((x) => x.id + x.status), view.doing.map((x) => x.id + x.status), view.alerts.map((x) => x.id)]);
}

async function handle(req, res, ctx, pathname) {
  const snap = loadSnapshot();

  if (req.method === 'GET' && pathname === '/api/inbox') {
    ctx.sendJSON(res, 200, buildInbox(snap));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/inbox/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Trace-Id',
      'X-Trace-Id': ctx.traceId,
      'X-Accel-Buffering': 'no'
    });
    const write = (name, data) => {
      if (res.writableEnded) return;
      try { res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {}
    };
    let last = '';
    const emit = () => {
      const view = buildInbox(loadSnapshot());
      const fp = fingerPrint(view);
      if (fp !== last) { last = fp; write('inbox', view); }
      else write('heartbeat', { ts: Date.now() });
    };
    emit();
    const timer = setInterval(emit, 15000);
    res.on('close', () => clearInterval(timer));
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/inbox/ack') {
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    body = body || {};
    if (body.all) push.ack(null); else if (body.id) push.ack(body.id);
    ctx.sendJSON(res, 200, { ok: true, unread: push.unreadCount() });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/push/register') {
    const { buf } = await ctx.readBody(req);
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
    body = body || {};
    const rec = push.registerToken(body.token, body.platform, body.account || (ctx.auth && ctx.auth.account));
    ctx.sendJSON(res, 200, { ok: !!rec, token: rec ? rec.token : null, cloud: push.cloudConfigured() });
    return true;
  }

  return false;
}

module.exports = { handle, buildInbox, routeForType };
