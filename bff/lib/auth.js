'use strict';
/*
 * lib/auth.js — 登录签发 / 校验 Bearer token（零依赖，HMAC 签名随机串）
 *   - 账号角色映射：boss→老板 manager→店长 finance→财务 kitchen→厨房 其他→只读
 *   - token = randomHex + '.' + HMAC-SHA256(randomHex, secret)；secret 首启生成并持久化
 *     于 data/tokens.json（本地签名密钥，与 KIMI_API_KEY 无关；红线③仅针对 Kimi Key）
 *   - 默认 12h 过期
 *   - WRITE_ROLES：admin 写操作仅 老板/店长
 */
const crypto = require('crypto');
const store = require('./store');

const ROLE_MAP = { boss: '老板', manager: '店长', finance: '财务', kitchen: '厨房' };
const WRITE_ROLES = ['老板', '店长'];
const TTL_MS = 12 * 3600 * 1000;

function load() {
  let s = store.readJSON('tokens.json', null);
  if (!s || typeof s !== 'object') s = { tokens: {} };
  if (!s.secret) s.secret = crypto.randomBytes(32).toString('hex');
  if (!s.tokens || typeof s.tokens !== 'object') s.tokens = {};
  return s;
}

function save(s) { store.writeJSON('tokens.json', s); }

function sign(raw, secret) {
  return crypto.createHmac('sha256', secret).update(raw).digest('hex').slice(0, 32);
}

// 登录：返回 {token, role, expires_at}；account 为空返回 null
function login(account, device_fp, source) {
  account = String(account == null ? '' : account).trim();
  if (!account) return null;
  const role = ROLE_MAP[account] || '只读';
  const s = load();
  const raw = crypto.randomBytes(24).toString('hex');
  const token = raw + '.' + sign(raw, s.secret);
  const now = Date.now();
  s.tokens[token] = {
    account,
    role,
    device_fp: device_fp || null,
    source: source || 'app',
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + TTL_MS).toISOString()
  };
  save(s);
  return { token, role, expires_at: s.tokens[token].expires_at };
}

// 校验：通过返回 token 记录（含 role/account），否则 null
function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const raw = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const s = load();
  const expect = sign(raw, s.secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const rec = s.tokens[token];
  if (!rec) return null;
  if (new Date(rec.expires_at).getTime() < Date.now()) return null;
  return Object.assign({ token }, rec);
}

module.exports = { login, verify, ROLE_MAP, WRITE_ROLES };
