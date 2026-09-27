'use strict';
/*
 * store-node/common.js — 店内组件（pusher/consumer）共用的最小 HTTP + 重试工具
 *
 * 只依赖 Node 内置模块：
 *   - httpJson：极简 JSON 客户端，返回 {status, body}；HTTP 状态码不 reject，
 *     仅网络/超时 reject（对齐 Python urllib 的「响应体也可解析」语义）。
 *   - withRetry：指数退避重试（默认 2s/4s/8s），可注入 sleep/retries 便于测试。
 *
 * 说明：pusher/consumer 只读写 SQLite 与 HTTP，不依赖 store-node/db.js|merge.js|server.js。
 */

const http = require('http');
const https = require('https');

/** 本地 ISO 时间（秒级，对齐 Python datetime.now().isoformat(timespec="seconds")） */
function nowIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** Promise 睡眠 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 极简 JSON HTTP 客户端。
 * @returns {Promise<{status:number, body:any}>}
 *   - 正常响应（含 4xx/5xx）→ resolve，body 尽力 JSON.parse，失败给 {raw}
 *   - 网络错误/超时 → reject
 */
function httpJson(method, url, payload, token, timeoutSec) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    let body = null;
    const headers = { Accept: 'application/json' };
    if (payload !== undefined && payload !== null) {
      body = Buffer.from(JSON.stringify(payload), 'utf8');
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(body.length);
    }
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = lib.request({
      method: method,
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + (u.search || ''),
      headers: headers,
      timeout: (timeoutSec || 30) * 1000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        if (raw) {
          try { parsed = JSON.parse(raw); }
          catch (e) { parsed = { raw: raw.slice(0, 500) }; }
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 指数退避重试：默认 2s/4s/8s。全部失败抛最后一次异常。
 * @param {() => Promise<any>} fn
 * @param {string} desc 日志描述
 * @param {object} [opts] {retries=3, baseDelayMs=2000, sleep, log}
 */
async function withRetry(fn, desc, opts) {
  const o = opts || {};
  const retries = o.retries || 3;
  const baseDelayMs = o.baseDelayMs || 2000;
  const sleepFn = o.sleep || sleep;
  const log = o.log || console;
  let last = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (log && typeof log.warning === 'function') {
        log.warning(desc + ' 第 ' + attempt + '/' + retries + ' 次失败: ' + (e && e.message));
      } else if (log && typeof log.warn === 'function') {
        log.warn(desc + ' 第 ' + attempt + '/' + retries + ' 次失败: ' + (e && e.message));
      }
      if (attempt < retries) await sleepFn(baseDelayMs * Math.pow(2, attempt - 1));
    }
  }
  throw last;
}

module.exports = { nowIso, sleep, httpJson, withRetry };
