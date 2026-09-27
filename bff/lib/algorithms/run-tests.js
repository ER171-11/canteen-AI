'use strict';
/*
 * lib/algorithms/run-tests.js — 算法层平价测试总入口
 * 逐个运行各域 *.test.js（Node 新实现 vs Python 原实现 差分），全绿才退出 0。
 * 用法：node lib/algorithms/run-tests.js
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
    const out = execFileSync('node', [full], { encoding: 'utf8' });
    process.stdout.write(out);
    if (!/PASS/.test(out)) { failed++; console.error('  (no PASS marker) ' + t); }
  } catch (e) {
    failed++;
    console.error('FAIL ' + t + '\n' + ((e.stdout || '') + (e.stderr || '')));
  }
}

console.log('\n== 算法层测试: ' + (tests.length - failed) + '/' + tests.length + ' 通过 ==');
process.exit(failed ? 1 : 0);
