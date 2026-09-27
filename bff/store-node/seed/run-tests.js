'use strict';
/*
 * seed/run-tests.js — seed 迁移脚本测试总入口
 * 逐个运行 seed/ 目录下的 *.test.js（Node 新实现 vs Python 原实现 差分），
 * 全绿才退出 0。
 * 用法：node bff/store-node/seed/run-tests.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const tests = fs
  .readdirSync(DIR)
  .filter((f) => /\.test\.js$/.test(f))
  .sort();

// 种子平价测试以「店内真实库」为基座；该库不入 VCS（.gitignore *.db），
// CI 全新检出时缺失 → 整体 SKIP（不判失败）。
const BASE_DB = path.resolve(DIR, '..', '..', '..', 'store-inventory', 'data', '餐厅系统.db');
if (!fs.existsSync(BASE_DB)) {
  console.log('SKIP seed 测试（基座库不存在：' + BASE_DB + '）');
  console.log('\n== seed 测试: SKIP（无基座库）==');
  process.exit(0);
}

let failed = 0;
for (const t of tests) {
  const full = path.join(DIR, t);
  try {
    const out = execFileSync('node', [full], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    process.stdout.write(out);
    if (!/PASS/.test(out)) {
      failed++;
      console.error('  (no PASS marker) ' + t);
    }
  } catch (e) {
    failed++;
    console.error('FAIL ' + t + '\n' + ((e.stdout || '') + (e.stderr || '')));
  }
}

console.log('\n== seed 测试: ' + (tests.length - failed) + '/' + tests.length + ' 通过 ==');
process.exit(failed ? 1 : 0);
