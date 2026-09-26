'use strict';
/*
 * lib/wechat.js — 微信开放平台：code 换 openid（零依赖 https）
 *
 * 环境变量（bff/.env）：
 *   WECHAT_APP_ID / WECHAT_APP_SECRET  — 开放平台移动应用
 *   WECHAT_ALLOW_DEMO=1               — 无 AppId 或 code 以 demo: 开头时走开发模拟
 */
const https = require('https');
const crypto = require('crypto');

function configured() {
  return !!(process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET);
}

function allowDemo() {
  return String(process.env.WECHAT_ALLOW_DEMO || '1') !== '0';
}

function publicConfig() {
  const appId = process.env.WECHAT_APP_ID || '';
  return {
    ok: true,
    enabled: configured() || allowDemo(),
    app_id: configured() ? appId : '',
    demo: !configured() && allowDemo(),
    note: configured()
      ? '正式微信登录已配置'
      : (allowDemo() ? '未配置 WECHAT_APP_ID，App 将走开发模拟微信登录' : '微信登录未启用')
  };
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error('wechat response not json: ' + text.slice(0, 120)));
        }
      });
    }).on('error', reject);
  });
}

/** 开发模拟：code=demo:xxx → 稳定 openid */
function demoIdentity(code) {
  const raw = String(code || 'demo');
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 28);
  return {
    openid: 'demo_openid_' + digest,
    unionid: 'demo_union_' + digest.slice(0, 16),
    nickname: '演示微信用户',
    avatar: null,
    demo: true
  };
}

/**
 * 用授权 code 换微信身份。
 * @returns {{ok, openid, unionid?, nickname?, avatar?, demo?, error?, status?}}
 */
async function exchangeCode(code) {
  code = String(code || '').trim();
  if (!code) return { ok: false, error: 'missing code', status: 400 };

  if (code.indexOf('demo:') === 0 || code === 'demo') {
    if (!allowDemo()) return { ok: false, error: 'demo wechat disabled', status: 403 };
    return Object.assign({ ok: true }, demoIdentity(code));
  }

  if (!configured()) {
    if (allowDemo()) return Object.assign({ ok: true }, demoIdentity('demo:' + code));
    return { ok: false, error: 'wechat not configured', status: 503 };
  }

  const appId = process.env.WECHAT_APP_ID;
  const secret = process.env.WECHAT_APP_SECRET;
  const url =
    'https://api.weixin.qq.com/sns/oauth2/access_token'
    + '?appid=' + encodeURIComponent(appId)
    + '&secret=' + encodeURIComponent(secret)
    + '&code=' + encodeURIComponent(code)
    + '&grant_type=authorization_code';

  let tokenResp;
  try {
    tokenResp = await httpsGetJson(url);
  } catch (e) {
    return { ok: false, error: 'wechat network error', status: 502 };
  }
  if (tokenResp.errcode) {
    return {
      ok: false,
      error: tokenResp.errmsg || ('wechat err ' + tokenResp.errcode),
      status: 401
    };
  }
  const openid = tokenResp.openid;
  const accessToken = tokenResp.access_token;
  if (!openid) return { ok: false, error: 'wechat missing openid', status: 502 };

  let nickname = null;
  let avatar = null;
  if (accessToken) {
    try {
      const infoUrl =
        'https://api.weixin.qq.com/sns/userinfo'
        + '?access_token=' + encodeURIComponent(accessToken)
        + '&openid=' + encodeURIComponent(openid);
      const info = await httpsGetJson(infoUrl);
      if (!info.errcode) {
        nickname = info.nickname || null;
        avatar = info.headimgurl || null;
      }
    } catch (e) {
      /* userinfo 可选 */
    }
  }

  return {
    ok: true,
    openid,
    unionid: tokenResp.unionid || null,
    nickname,
    avatar,
    demo: false
  };
}

module.exports = {
  configured,
  allowDemo,
  publicConfig,
  exchangeCode,
  demoIdentity
};
