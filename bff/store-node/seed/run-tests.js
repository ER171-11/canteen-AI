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

// 种子平价测试以「店内真实库」为基座；该库不入 VCS（store-inventory/.gitignore 的 *.db），
// CI 全新检出时必然缺失。此时 testutil.copyBaseDb() 会回退为「按 migrations 全量重建」，
// 差分测试仍然真实执行（Node 实现 vs Python 原实现，同一基座对拍）。
//
// 历史缺陷（2026-09-28 修复）：这里原本在基座库缺失时直接 process.exit(0)，
// 导致 CI 上整个 seed 套件「静默跳过却判成功」= 假绿。跳过 ≠ 通过，任何情况下都不得据此判成功。
const BASE_DB = process.env.SEED_BASE_DB || path.resolve(DIR, '..', '..', '..', 'store-inventory', 'data', '餐厅系统.db');
if (!fs.existsSync(BASE_DB)) {
  console.log('[warn] 未找到店内真实基座库，将按 migrations 全量重建（等价于 CI 条件）：' + BASE_DB);
  console.log('[warn] 差分结论仍有效，但基座数据为空，不等价于「与真实店内数据一致」。');
}
if (tests.length === 0) {
  console.error('FAIL: seed/ 下未找到任何 *.test.js —— 套件为空不得判成功');
  process.exit(1);
}

// 汇总口径（2026-09-29 首次 CI 后明确）：passed = 真实执行且全绿；
// skipped = 测试自己**显式声明**的 SKIP（输出含「] SKIP」，均为夹具不在 VCS 的结构性依赖，
// 见 migrate_from_zip.test / seed_recipe_links.test 头注释），单列展示、**不计入「通过」**；
// failed = 崩溃 / 断言失败 / 无 PASS 标记。退出码只由 failed 决定。
let failed = 0;
let skipped = 0;
for (const t of tests) {
  const full = path.join(DIR, t);
  try {
    const out = execFileSync('node', [full], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    process.stdout.write(out);
    if (/\] SKIP/.test(out)) {
      skipped++;
      console.log('SKIP(显式声明) ' + t);
    } else if (!/PASS/.test(out)) {
      failed++;
      console.error('  (no PASS marker) ' + t);
    }
  } catch (e) {
    failed++;
    console.error('FAIL ' + t + '\n' + ((e.stdout || '') + (e.stderr || '')));
  }
}

console.log(
  '\n== seed 测试: ' + (tests.length - failed - skipped) + '/' + tests.length + ' 通过' +
  (skipped ? '（另 ' + skipped + ' 个显式 SKIP：夹具不在 VCS，见上方输出，不计入通过）' : '') +
  ' =='
);
process.exit(failed ? 1 : 0);
