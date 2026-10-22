'use strict';
/*
 * lib/org.js — 餐厅组织：门店 / 岗位权限 / 用户账号（JSON 持久化）
 *
 * 数据文件：bff/data/org.json
 * 权限码：{module}.{read|write}，modules 见 MODULES
 * 首次加载自动种子：1 店 + 6 岗 + 5 账号（密码默认 wufu123）
 */
const crypto = require('crypto');
const store = require('./store');

const FILE = 'org.json';
const DEFAULT_PASSWORD = process.env.BFF_DEFAULT_PASSWORD || 'wufu123';
const INVITE_CODE = process.env.BFF_INVITE_CODE || 'WUFU2026';

const MODULES = [
  'inventory', 'kitchen', 'pos', 'booking', 'foodsafe', 'staff',
  'finance', 'vip', 'takeout', 'analysis', 'supply', 'loss',
  'equipment', 'review', 'actions', 'org'
];

function allPerms(mode) {
  if (mode === 'r') return MODULES.map((m) => m + '.read');
  const mods = Array.isArray(mode) ? mode : MODULES;
  const out = [];
  for (const m of mods) {
    out.push(m + '.read');
    out.push(m + '.write');
  }
  return out;
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(String(password), salt, 32);
  const expect = Buffer.from(hash, 'hex');
  if (got.length !== expect.length) return false;
  return crypto.timingSafeEqual(got, expect);
}

function defaultOrg() {
  const now = new Date().toISOString();
  const pw = hashPassword(DEFAULT_PASSWORD);
  const positions = [
    {
      id: 'pos_boss',
      name: '老板',
      permissions: allPerms('rw'),
      write: true
    },
    {
      id: 'pos_manager',
      name: '店长',
      permissions: allPerms('rw').filter((p) => p !== 'org.write'),
      write: true
    },
    {
      id: 'pos_cashier',
      name: '收银',
      permissions: [
        'pos.read', 'pos.write', 'booking.read', 'booking.write',
        'vip.read', 'vip.write', 'takeout.read', 'takeout.write',
        'actions.read', 'actions.write',
        'inventory.read', 'kitchen.read', 'analysis.read'
      ],
      write: true
    },
    {
      id: 'pos_kitchen',
      name: '厨房',
      permissions: [
        'kitchen.read', 'kitchen.write', 'foodsafe.read', 'foodsafe.write',
        'inventory.read', 'actions.read', 'actions.write', 'analysis.read'
      ],
      write: true
    },
    {
      id: 'pos_finance',
      name: '财务',
      permissions: [
        'finance.read', 'finance.write', 'analysis.read', 'analysis.write',
        'supply.read', 'actions.read', 'actions.write',
        'inventory.read', 'vip.read', 'takeout.read'
      ],
      write: true
    },
    {
      id: 'pos_readonly',
      name: '只读',
      permissions: allPerms('r'),
      write: false
    }
  ];

  function user(account, displayName, positionId, storeId) {
    return {
      id: 'u_' + account,
      account,
      display_name: displayName,
      position_id: positionId,
      store_id: storeId,
      status: 'active',
      password_salt: pw.salt,
      password_hash: pw.hash,
      created_at: now
    };
  }

  const storeId = 'store_jinfeng';
  return {
    version: 1,
    invite_code: INVITE_CODE,
    stores: [
      {
        id: storeId,
        name: '熊猫功夫餐厅海口世贸雅苑店',
        brand: '熊猫五福',
        city: '海口',
        address: '海口世贸雅苑',
        status: '营业中',
        created_at: now
      }
    ],
    positions,
    users: [
      user('boss', 'David Sun', 'pos_boss', storeId),
      user('manager', '店长', 'pos_manager', storeId),
      user('cashier', '收银员', 'pos_cashier', storeId),
      user('kitchen', '后厨主管', 'pos_kitchen', storeId),
      user('finance', '财务', 'pos_finance', storeId)
    ]
  };
}

/** 把种子门店/老板身份对齐产品设定（可重复执行） */
function migratePersona(org) {
  if (!org || typeof org !== 'object') return org;
  const store = (org.stores || [])[0];
  if (store) {
    if (!store.brand) store.brand = '熊猫五福';
    const n = String(store.name || '');
    if (!n || n.indexOf('熊猫五福餐厅') >= 0 || n === '熊猫五福') {
      store.name = '熊猫功夫餐厅海口世贸雅苑店';
    }
  }
  const boss = findUser(org, 'boss');
  if (boss) {
    const dn = String(boss.display_name || '');
    if (!dn || dn === '老板' || dn.indexOf('演示微信老板') >= 0 || dn.indexOf('演示') === 0) {
      boss.display_name = 'David Sun';
    }
  }
  return org;
}

function load() {
  let org = store.readJSON(FILE, null);
  if (!org || typeof org !== 'object' || !Array.isArray(org.users)) {
    org = defaultOrg();
    store.writeJSON(FILE, org);
  }
  if (!org.invite_code) org.invite_code = INVITE_CODE;
  const before = JSON.stringify(org);
  org = migratePersona(org);
  if (JSON.stringify(org) !== before) store.writeJSON(FILE, org);
  return org;
}

function save(org) {
  store.writeJSON(FILE, org);
}

function findUser(org, account) {
  account = String(account || '').trim().toLowerCase();
  return (org.users || []).find((u) => String(u.account).toLowerCase() === account) || null;
}

function findByWechatOpenId(org, openid) {
  openid = String(openid || '').trim();
  if (!openid) return null;
  return (org.users || []).find((u) => u.wechat_openid === openid) || null;
}

/**
 * 微信登录：已绑定则签发；未绑定可挂到已有账号（account+password）；
 * 否则自动建只读账号 wx_xxxx。
 */
function loginOrCreateWechat({ openid, unionid, nickname, avatar, account, password, invite_code }) {
  const org = load();
  openid = String(openid || '').trim();
  if (!openid) return { ok: false, error: 'missing openid', status: 400 };

  let user = findByWechatOpenId(org, openid);

  if (!user && account) {
    const existing = findUser(org, account);
    if (!existing) return { ok: false, error: 'account not found for bind', status: 404 };
    if (existing.status && existing.status !== 'active') {
      return { ok: false, error: 'account disabled', status: 403 };
    }
    if (!password || !verifyPassword(password, existing.password_salt, existing.password_hash)) {
      return { ok: false, error: 'invalid credentials for bind', status: 401 };
    }
    if (existing.wechat_openid && existing.wechat_openid !== openid) {
      return { ok: false, error: 'account already bound to another wechat', status: 409 };
    }
    existing.wechat_openid = openid;
    if (unionid) existing.wechat_unionid = unionid;
    if (nickname && !existing.display_name) existing.display_name = nickname;
    if (avatar) existing.wechat_avatar = avatar;
    user = existing;
    save(org);
  }

  if (!user) {
    const suffix = openid.replace(/[^a-zA-Z0-9]/g, '').slice(-8).toLowerCase() || crypto.randomBytes(4).toString('hex');
    let acc = 'wx_' + suffix;
    let n = 0;
    while (findUser(org, acc)) {
      n += 1;
      acc = 'wx_' + suffix + n;
    }
    // 有邀请码则按只读入店；无邀请码也允许建只读（首登），便于微信一键进店
    if (invite_code && String(invite_code) !== String(org.invite_code)) {
      return { ok: false, error: 'invalid invite_code', status: 403 };
    }
    const st = org.stores[0];
    // 开发模拟微信：默认老板岗，便于真机打通拍板；正式微信仍只读，由店长改岗
    const demoBoss = String(openid).indexOf('demo_openid_') === 0;
    const pos = findPosition(org, demoBoss ? 'pos_boss' : 'pos_readonly');
    const pw = hashPassword(crypto.randomBytes(12).toString('hex'));
    user = {
      id: 'u_' + crypto.randomBytes(6).toString('hex'),
      account: acc,
      display_name: nickname || (demoBoss ? 'David Sun' : ('微信用户' + suffix.slice(-4))),
      position_id: pos.id,
      store_id: st.id,
      status: 'active',
      password_salt: pw.salt,
      password_hash: pw.hash,
      wechat_openid: openid,
      wechat_unionid: unionid || null,
      wechat_avatar: avatar || null,
      created_at: new Date().toISOString()
    };
    org.users.push(user);
    save(org);
  } else {
    let dirty = false;
    if (unionid && user.wechat_unionid !== unionid) {
      user.wechat_unionid = unionid;
      dirty = true;
    }
    if (nickname && user.display_name && String(user.display_name).startsWith('微信用户')) {
      user.display_name = nickname;
      dirty = true;
    }
    if (avatar && user.wechat_avatar !== avatar) {
      user.wechat_avatar = avatar;
      dirty = true;
    }
    // 开发模拟 openid：若仍卡在只读岗，自动升老板岗（真机联调可写）
    if (String(openid).indexOf('demo_openid_') === 0 && user.position_id === 'pos_readonly') {
      const boss = findPosition(org, 'pos_boss');
      if (boss) {
        user.position_id = boss.id;
        if (!user.display_name || String(user.display_name).indexOf('演示') >= 0 ||
            String(user.display_name).startsWith('微信用户')) {
          user.display_name = 'David Sun';
        }
        dirty = true;
      }
    }
    if (dirty) save(org);
  }

  return { ok: true, user: publicUser(org, user) };
}

function findPosition(org, positionId) {
  return (org.positions || []).find((p) => p.id === positionId) || null;
}

function findStore(org, storeId) {
  return (org.stores || []).find((s) => s.id === storeId) || null;
}

function permissionsOf(org, user) {
  if (!user) return [];
  const pos = findPosition(org, user.position_id);
  return (pos && pos.permissions) || [];
}

function can(org, user, perm) {
  const list = permissionsOf(org, user);
  return list.indexOf(perm) >= 0;
}

function canWriteActions(org, user) {
  return can(org, user, 'actions.write');
}

function publicUser(org, user) {
  if (!user) return null;
  const pos = findPosition(org, user.position_id);
  const st = findStore(org, user.store_id);
  return {
    id: user.id,
    account: user.account,
    display_name: user.display_name,
    role: (pos && pos.name) || '只读',
    position_id: user.position_id,
    position_name: (pos && pos.name) || null,
    store_id: user.store_id,
    store_name: (st && st.name) || null,
    permissions: permissionsOf(org, user),
    can_write: !!(pos && pos.write),
    status: user.status
  };
}

function register({ account, password, display_name, invite_code, position_id, store_id }) {
  const org = load();
  account = String(account || '').trim().toLowerCase();
  if (!account || !password) return { ok: false, error: 'missing account/password', status: 400 };
  if (String(invite_code || '') !== String(org.invite_code)) {
    return { ok: false, error: 'invalid invite_code', status: 403 };
  }
  if (findUser(org, account)) return { ok: false, error: 'account exists', status: 409 };
  const st = findStore(org, store_id) || org.stores[0];
  const pos = findPosition(org, position_id) || findPosition(org, 'pos_readonly');
  const pw = hashPassword(password);
  const user = {
    id: 'u_' + crypto.randomBytes(6).toString('hex'),
    account,
    display_name: display_name || account,
    position_id: pos.id,
    store_id: st.id,
    status: 'active',
    password_salt: pw.salt,
    password_hash: pw.hash,
    created_at: new Date().toISOString()
  };
  org.users.push(user);
  save(org);
  return { ok: true, user: publicUser(org, user) };
}

function createUser(actor, body) {
  const org = load();
  if (!actor || !can(org, findUser(org, actor.account), 'org.write')) {
    return { ok: false, error: 'forbidden: org.write required', status: 403 };
  }
  const account = String(body.account || '').trim().toLowerCase();
  const password = body.password || DEFAULT_PASSWORD;
  if (!account) return { ok: false, error: 'missing account', status: 400 };
  if (findUser(org, account)) return { ok: false, error: 'account exists', status: 409 };
  const st = findStore(org, body.store_id) || org.stores[0];
  const pos = findPosition(org, body.position_id) || findPosition(org, 'pos_readonly');
  const pw = hashPassword(password);
  const user = {
    id: 'u_' + crypto.randomBytes(6).toString('hex'),
    account,
    display_name: body.display_name || account,
    position_id: pos.id,
    store_id: st.id,
    status: body.status || 'active',
    password_salt: pw.salt,
    password_hash: pw.hash,
    created_at: new Date().toISOString()
  };
  org.users.push(user);
  save(org);
  return { ok: true, user: publicUser(org, user) };
}

/** 改岗 / 改姓名 / 停用启用 */
function updateUser(actor, body) {
  const org = load();
  if (!actor || !can(org, findUser(org, actor.account), 'org.write')) {
    return { ok: false, error: 'forbidden: org.write required', status: 403 };
  }
  const account = String(body.account || body.id || '').trim().toLowerCase();
  const user = findUser(org, account) || (org.users || []).find((u) => u.id === body.id);
  if (!user) return { ok: false, error: 'user not found', status: 404 };
  if (body.display_name != null) user.display_name = String(body.display_name).trim() || user.display_name;
  if (body.position_id) {
    const pos = findPosition(org, body.position_id);
    if (!pos) return { ok: false, error: 'position not found', status: 400 };
    user.position_id = pos.id;
  }
  if (body.store_id) {
    const st = findStore(org, body.store_id);
    if (!st) return { ok: false, error: 'store not found', status: 400 };
    user.store_id = st.id;
  }
  if (body.status) {
    const st = String(body.status);
    if (['active', 'disabled', '正常', '停用'].indexOf(st) < 0) {
      return { ok: false, error: 'invalid status', status: 400 };
    }
    user.status = (st === '停用' || st === 'disabled') ? 'disabled' : 'active';
  }
  user.updated_at = new Date().toISOString();
  save(org);
  return { ok: true, user: publicUser(org, user) };
}

function resetPassword(actor, body) {
  const org = load();
  if (!actor || !can(org, findUser(org, actor.account), 'org.write')) {
    return { ok: false, error: 'forbidden: org.write required', status: 403 };
  }
  const account = String(body.account || '').trim().toLowerCase();
  const user = findUser(org, account);
  if (!user) return { ok: false, error: 'user not found', status: 404 };
  const password = body.password || DEFAULT_PASSWORD;
  if (String(password).length < 4) return { ok: false, error: 'password too short', status: 400 };
  const pw = hashPassword(password);
  user.password_salt = pw.salt;
  user.password_hash = pw.hash;
  user.updated_at = new Date().toISOString();
  save(org);
  return { ok: true, account: user.account, reset: true };
}

/** 岗位权限编辑（老板 org.write） */
function updatePosition(actor, body) {
  const org = load();
  if (!actor || !can(org, findUser(org, actor.account), 'org.write')) {
    return { ok: false, error: 'forbidden: org.write required', status: 403 };
  }
  const pos = findPosition(org, body.id || body.position_id);
  if (!pos) return { ok: false, error: 'position not found', status: 404 };
  if (body.name != null) pos.name = String(body.name).trim() || pos.name;
  if (Array.isArray(body.permissions)) {
    const allowed = new Set(allPerms('rw'));
    pos.permissions = body.permissions.filter((p) => allowed.has(String(p)));
  }
  if (body.write != null) pos.write = !!body.write;
  // 至少保留本岗 read 防锁死
  if (!pos.permissions || !pos.permissions.length) {
    pos.permissions = ['org.read'];
    pos.write = false;
  }
  save(org);
  return {
    ok: true,
    position: { id: pos.id, name: pos.name, write: !!pos.write, permissions: pos.permissions || [] }
  };
}

function updateStore(actor, body) {
  const org = load();
  const me = actor && findUser(org, actor.account);
  const allowed = (me && can(org, me, 'org.write')) ||
    (actor && (actor.role === '老板' || actor.role === '店长'));
  if (!allowed) {
    return { ok: false, error: 'forbidden: org.write required', status: 403 };
  }
  const id = String(body.id || body.store_id || '').trim();
  if (!id) return { ok: false, error: 'missing store id', status: 400 };
  const row = findStore(org, id);
  if (!row) return { ok: false, error: 'store not found', status: 404 };
  if (body.name != null) row.name = String(body.name).trim() || row.name;
  if (body.brand != null) row.brand = String(body.brand).trim();
  if (body.city != null) row.city = String(body.city).trim();
  if (body.address != null) row.address = String(body.address).trim();
  if (body.status != null) row.status = String(body.status).trim() || row.status;
  row.updated_at = new Date().toISOString();
  save(org);
  return {
    ok: true,
    store: {
      id: row.id, name: row.name, brand: row.brand, city: row.city,
      address: row.address, status: row.status
    }
  };
}

function listPublic(org) {
  return {
    stores: (org.stores || []).map((s) => ({
      id: s.id, name: s.name, brand: s.brand, city: s.city,
      address: s.address, status: s.status
    })),
    positions: (org.positions || []).map((p) => ({
      id: p.id, name: p.name, write: !!p.write,
      permissions: p.permissions || []
    })),
    users: (org.users || []).map((u) => publicUser(org, u)),
    modules: MODULES,
    invite_hint: '需邀请码注册（找店长索取）'
  };
}

module.exports = {
  MODULES,
  DEFAULT_PASSWORD,
  load,
  save,
  findUser,
  findByWechatOpenId,
  findPosition,
  findStore,
  permissionsOf,
  can,
  canWriteActions,
  publicUser,
  hashPassword,
  verifyPassword,
  register,
  loginOrCreateWechat,
  createUser,
  updateUser,
  updateStore,
  resetPassword,
  updatePosition,
  listPublic,
  defaultOrg
};
