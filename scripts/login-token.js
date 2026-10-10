#!/usr/bin/env node
'use strict';
/*
 * scripts/login-token.js — 登录 BFF 并只把 token 打到 stdout。
 *
 * 用途：给 .cmd / .sh 启动脚本捕获 token（consumer / pusher 需要）。
 *   for /f "usebackq delims=" %%T in (`node scripts\login-token.js`) do set "TOKEN=%%T"
 *
 * 环境变量：
 *   BFF_URL      默认 http://127.0.0.1:8787
 *   BFF_ACCOUNT  默认 boss
 *   BFF_PASSWORD 默认 wufu123
 *
 * 退出码：0 成功（stdout 仅 token，无换行）；1 失败（stderr 打错误）。
 */

const BFF = (process.env.BFF_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ACCOUNT = process.env.BFF_ACCOUNT || 'boss';
const PASSWORD = process.env.BFF_PASSWORD || 'wufu123';

async function main() {
  let res;
  try {
    res = await fetch(BFF + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: ACCOUNT, password: PASSWORD, device_fp: 'launch-script' }),
    });
  } catch (e) {
    console.error('登录请求失败（BFF 是否已启动？）: ' + (e && e.message ? e.message : e));
    return 1;
  }
  let body = {};
  try { body = await res.json(); } catch (e) { body = {}; }
  if (res.status === 200 && body && body.token) {
    process.stdout.write(String(body.token));
    return 0;
  }
  console.error('登录失败: http=' + res.status + ' ' + JSON.stringify(body));
  return 1;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    console.error('[login-token] ' + (e && e.message ? e.message : e));
    process.exit(1);
  });
