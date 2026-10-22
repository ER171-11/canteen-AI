'use strict';
/*
 * lib/auth.js — 登录签发 / 校验 Bearer token
 *   - 正式账号：org.json 用户 + 密码（scrypt）
 *   - 兼容：ALLOW_DEMO_LOGIN=1 时无密码也可按旧 ROLE_MAP 登录（开发用）
 *   - token 内嵌 account/role/store_id/permissions
 */
const crypto = require('crypto');
const store = require('./store');
const org = require('./org');

const ROLE_MAP = { boss: '老板', manager: '店长', finance: '财务', kitchen: '厨房', cashier: '收银' };
const WRITE_ROLES = ['老板', '店长', '收银', '厨房', '财务']; // 粗粒度兼容；细粒度看 permissions
const TTL_MS = 12 * 3600 * 1000;
const ALLOW_DEMO = String(process.env.ALLOW_DEMO_LOGIN || '1') !== '0';

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

function issueToken(profile, device_fp, source) {
  const s = load();
  const raw = crypto.randomBytes(24).toString('hex');
  const token = raw + '.' + sign(raw, s.secret);
  const now = Date.now();
  s.tokens[token] = {
    account: profile.account,
    role: profile.role,
    display_name: profile.display_name || profile.account,
    store_id: profile.store_id || null,
    store_name: profile.store_name || null,
    position_id: profile.position_id || null,
    position_name: profile.position_name || null,
    permissions: profile.permissions || [],
    can_write: !!profile.can_write,
    device_fp: device_fp || null,
    source: source || 'app',
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + TTL_MS).toISOString()
  };
  save(s);
  return {
    token,
    account: profile.account,
    role: profile.role,
    expires_at: s.tokens[token].expires_at,
    display_name: s.tokens[token].display_name,
    store_id: s.tokens[token].store_id,
    store_name: s.tokens[token].store_name,
    position_id: s.tokens[token].position_id,
    position_name: s.tokens[token].position_name,
    permissions: s.tokens[token].permissions,
    can_write: s.tokens[token].can_write
  };
}

/**
 * 登录：
 *  1) 正式用户：校验密码（password 必填，除非 ALLOW_DEMO_LOGIN）
 *  2) 未知账号 + demo：按 ROLE_MAP 发只读或映射角色（无门店权限精细化）
 */
function login(account, device_fp, source, password) {
  account = String(account == null ? '' : account).trim();
  if (!account) return null;

  const o = org.load();
  const user = org.findUser(o, account);

  if (user) {
    if (user.status && user.status !== 'active') {
      return { error: 'account disabled', status: 403 };
    }
    const needPw = !ALLOW_DEMO || (password != null && String(password).length > 0);
    if (needPw || !ALLOW_DEMO) {
      if (!password) return { error: 'password required', status: 401 };
      if (!org.verifyPassword(password, user.password_salt, user.password_hash)) {
        return { error: 'invalid credentials', status: 401 };
      }
    }
    const profile = org.publicUser(o, user);
    return issueToken(profile, device_fp, source);
  }

  // 无正式账号：仅 demo 模式允许
  if (!ALLOW_DEMO) return { error: 'unknown account', status: 401 };
  const role = ROLE_MAP[account.toLowerCase()] || '只读';
  const canWrite = WRITE_ROLES.indexOf(role) >= 0 && role !== '只读';
  // demo 权限：老板/店长全开，其余只读
  let permissions = o.positions.find((p) => p.name === role);
  permissions = permissions ? permissions.permissions : org.listPublic(o).positions
    .find((p) => p.id === 'pos_readonly').permissions;
  const st = o.stores[0];
  return issueToken({
    account,
    role,
    display_name: account,
    store_id: st && st.id,
    store_name: st && st.name,
    position_id: null,
    position_name: role,
    permissions,
    can_write: canWrite || role === '老板' || role === '店长'
  }, device_fp, source);
}

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

/** 当前会话是否可写 actions */
function mayWriteActions(authRec) {
  if (!authRec) return false;
  if (Array.isArray(authRec.permissions) && authRec.permissions.indexOf('actions.write') >= 0) {
    return true;
  }
  // 兼容旧 token（无 permissions）
  return WRITE_ROLES.indexOf(authRec.role) >= 0;
}

function hasPerm(authRec, perm) {
  if (!authRec) return false;
  if (Array.isArray(authRec.permissions) && authRec.permissions.indexOf(perm) >= 0) return true;
  if (authRec.role === '老板' || authRec.role === '店长') return true;
  return false;
}

module.exports = {
  login,
  issueToken,
  verify,
  mayWriteActions,
  hasPerm,
  ROLE_MAP,
  WRITE_ROLES,
  ALLOW_DEMO
};
