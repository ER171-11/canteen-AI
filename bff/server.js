'use strict';
/*
 * 熊猫五福餐厅 · 云端 BFF —— 本地零依赖 Node 服务（入口）
 *
 * 红线：
 *   ① Kimi/agent 路由绝不允许有任何写库路径（kimi/agent 仅只读转发/桩）
 *   ② 所有写操作统一进 actions 队列（routes/actions.js），BFF 不直接写店内 DB
 *   ③ Kimi Key 仅从 process.env.KIMI_API_KEY 读取（bff/.env），不入代码/日志
 *   ④ 图片 base64 只用内存，响应后销毁
 *   ⑤ 零第三方依赖：仅 Node 内置 http/https/fs/path/crypto
 *   ⑥ /api/kimi/* 行为与原型契约保持一致
 *
 * 分层：
 *   server.js        入口：env、CORS、trace_id、限流、鉴权、审计、路由分发
 *   lib/             store(JSON持久化) / auth(token+RBAC) / ratelimit(令牌桶) / audit(日志)
 *   routes/          kimi(视觉代理) / auth / snapshot / report / actions / agent / admin
 *
 * 启动：node server.js（监听 127.0.0.1:8787）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------------ */
/* .env 加载（简易零依赖：仅读 KIMI_API_KEY，不依赖 dotenv）          */
/* ------------------------------------------------------------------ */
function loadEnv() {
  if (process.env.KIMI_API_KEY) return;
  const envPath = path.join(__dirname, '.env');
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const m = content.match(/^KIMI_API_KEY\s*=\s*(.+)$/m);
    if (m) process.env.KIMI_API_KEY = m[1].trim();
  } catch (e) {
    // .env 不存在或读失败，由健康检查 key_loaded 暴露
  }
}
loadEnv();

const kimi = require('./routes/kimi');
const authLib = require('./lib/auth');
const ratelimit = require('./lib/ratelimit');
const audit = require('./lib/audit');
const { loadSnapshot } = require('./routes/snapshot');

const ROUTES = [
  require('./routes/auth'),
  require('./routes/snapshot'),
  require('./routes/report'),
  require('./routes/actions'),
  require('./routes/agent'),
  require('./routes/admin'),
  require('./routes/kitchen')
];

const HOST = process.env.BFF_HOST || '127.0.0.1';
const PORT = parseInt(process.env.BFF_PORT || '8787', 10);

/* ------------------------------------------------------------------ */
/* 公共工具                                                            */
/* ------------------------------------------------------------------ */
function genTraceId() {
  return crypto.randomBytes(8).toString('hex') + Date.now().toString(36);
}

function sendJSON(res, status, obj, traceId) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Trace-Id',
    'Access-Control-Max-Age': '86400',
    'X-Trace-Id': traceId || ''
  });
  res.end(body);
}

// 读请求体；limit 超限立即 resolve({tooLarge:true}) 并销毁流
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (limit && size > limit) {
        settled = true;
        resolve({ tooLarge: true, buf: null });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ tooLarge: false, buf: Buffer.concat(chunks) });
    });
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

// 公开端点：无需 Bearer token
function isPublic(method, pathname) {
  if (method === 'GET' && (pathname === '/' || pathname === '/health' || pathname === '/api/health')) return true;
  if (method === 'POST' && (pathname === '/api/auth/login' || pathname === '/api/admin/login')) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;

  // CORS 预检（放行 admin-web:5173 与 file:// 原型，保持 * 策略）
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Trace-Id',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  // 全链路 trace_id：透传 X-Trace-Id 或生成
  const traceId = String(req.headers['x-trace-id'] || '').trim() || genTraceId();
  const isApi = pathname.startsWith('/api/');

  // Bearer 解析（无效/过期视为未登录）
  const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '');
  const authRec = m ? authLib.verify(m[1]) : null;

  // 限流：/api/kimi/* 与 /api/agent/* 按 token 10 req/min，其余 60 req/min
  const rlCls = /^\/api\/(kimi|agent)\//.test(pathname) ? 'ai' : 'std';
  const rlKey = m
    ? crypto.createHash('sha256').update(m[1]).digest('hex').slice(0, 16)
    : (req.socket.remoteAddress || 'anon');
  const rl = ratelimit.check(rlCls, rlKey);

  // 审计：所有 /api/ 请求（含被拒）在响应结束时落 audit.jsonl
  if (isApi) {
    res.on('finish', () => {
      audit.write({
        ts: new Date().toISOString(),
        trace_id: traceId,
        method: req.method,
        path: pathname,
        role: authRec ? authRec.role : null,
        status: res.statusCode,
        dt_ms: Date.now() - started
      });
    });
  }

  if (!rl.allowed) {
    return sendJSON(res, 429, { ok: false, error: 'rate limited', retry_after: rl.retryAfter }, traceId);
  }

  // 鉴权：除公开端点外的 /api/* 均需有效 Bearer token
  if (isApi && !isPublic(req.method, pathname) && !authRec) {
    return sendJSON(res, 401, { ok: false, error: 'unauthorized: bearer token required' }, traceId);
  }

  const ctx = {
    traceId,
    auth: authRec,
    query: u.searchParams,
    readBody,
    sendJSON: (r, s, o) => sendJSON(r, s, o, traceId),
    kimiLog: (entry) => audit.kimiLog(entry)
  };

  try {
    // 健康检查（旧版，保持原型兼容）
    if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
      return sendJSON(res, 200, {
        ok: true,
        service: 'canteenAI-kimi-bff',
        models: kimi.MODEL_CANDIDATES,
        keyLoaded: !!process.env.KIMI_API_KEY,
        time: new Date().toISOString()
      }, traceId);
    }

    // 健康检查（新版契约）
    if (req.method === 'GET' && pathname === '/api/health') {
      const snap = loadSnapshot();
      return sendJSON(res, 200, {
        ok: true,
        service: 'canteenAI-bff',
        models: kimi.MODEL_CANDIDATES,
        key_loaded: !!process.env.KIMI_API_KEY,
        rev: snap ? snap.rev : null
      }, traceId);
    }

    // Kimi 视觉代理（只读转发，行为不变）
    if (req.method === 'POST' && pathname === '/api/kimi/vision') {
      return await kimi.handleVision(req, res, ctx);
    }
    if (req.method === 'POST' && pathname === '/api/kimi/vision/stream') {
      return await kimi.handleVisionStream(req, res, ctx);
    }

    // 业务路由
    for (const r of ROUTES) {
      if (await r.handle(req, res, ctx, pathname)) return;
    }

    sendJSON(res, 404, { ok: false, error: 'not found' }, traceId);
  } catch (e) {
    console.error(`[BFF][${traceId}] handler crashed:`, e && e.stack || e);
    if (!res.headersSent) {
      sendJSON(res, 500, { ok: false, error: 'internal error' }, traceId);
    } else {
      try { res.end(); } catch (e2) {}
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[BFF] listening http://${HOST}:${PORT}`);
  console.log(`[BFF] models: ${kimi.MODEL_CANDIDATES.join(' -> ')}`);
  console.log('[BFF] endpoints: GET / /health /api/health | POST /api/kimi/vision(/stream)'
    + ' | /api/auth/login /api/admin/login | /api/snapshot/push /api/snapshot/latest'
    + ' | /api/report/daily | /api/agent/chat | /api/actions* | /api/admin/*');
});

// 未捕获异常兜底，避免进程崩溃
process.on('uncaughtException', (err) => {
  console.error('[BFF] uncaughtException:', err && err.message);
});
