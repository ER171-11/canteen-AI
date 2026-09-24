'use strict';
/*
 * lib/ratelimit.js — 令牌桶限流（进程内存态）
 *   - ai  档：/api/kimi/* 与 /api/agent/*，按 token 10 req/min
 *   - std 档：其余 /api/*，60 req/min
 *   - key：已鉴权请求按 token 哈希，未鉴权按远端 IP
 */
const RATES = {
  ai: { cap: 10, perMs: 60000 / 10 },
  std: { cap: 60, perMs: 60000 / 60 }
};

const buckets = new Map();

// 定期清理闲置桶，避免长驻内存膨胀
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (now - b.ts > 10 * 60 * 1000) buckets.delete(k);
  }
}).unref();

function check(cls, key) {
  const r = RATES[cls] || RATES.std;
  const k = cls + ':' + key;
  const now = Date.now();
  let b = buckets.get(k);
  if (!b) { b = { tokens: r.cap, ts: now }; buckets.set(k, b); }
  b.tokens = Math.min(r.cap, b.tokens + (now - b.ts) / r.perMs);
  b.ts = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { allowed: true, retryAfter: 0 };
  }
  return { allowed: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) * r.perMs / 1000)) };
}

module.exports = { check };
