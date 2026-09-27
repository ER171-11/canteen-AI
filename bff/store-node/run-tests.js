'use strict';
/*
 * run-tests.js — store-node 测试总入口
 * 逐个运行本周目录下的 *.test.js（Node 新实现 vs Python 原实现 差分 + HTTP 冒烟），
 * 全绿才退出 0。
 * 用法：node bff/store-node/run-tests.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const tests = fs.readdirSync(DIR)
  .filter((f) => /\.test\.js$/.test(f) && f !== 'run-tests.js')
  .sort();

let failed = 0;
for (const t of tests) {
  const full = path.join(DIR, t);
  try {
    const out = execFileSync('node', [full], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.write(out);
    if (!/PASS/.test(out)) { failed++; console.error('  (no PASS marker) ' + t); }
  } catch (e) {
    failed++;
    console.error('FAIL ' + t + '\n' + ((e.stdout || '') + (e.stderr || '')));
  }
}

console.log('\n== store-node 测试: ' + (tests.length - failed) + '/' + tests.length + ' 通过 ==');
process.exit(failed ? 1 : 0);
