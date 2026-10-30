'use strict';
/*
 * scripts/gen-shared-cjs.js —— 由 ESM 源生成 CommonJS 孪生文件（目前用于 shared/recipe-cost）。
 *
 * 为什么需要：桌面包内 BFF 是 CommonJS，用 require() 加载；而 Electron 31 内置 Node 20.18
 * 还不支持 require(ESM)（Node ≥ 22.12 / 20.19 才默认开启），若 index.cjs 里写
 * `module.exports = require('./index.mjs')`，桌面端启动即 ERR_REQUIRE_ESM。
 * 因此 index.cjs 必须是真正的 CommonJS 实现，而不是 require ESM 的薄壳。
 *
 * 做法：index.mjs 仍是唯一事实来源；本脚本把顶层 `export const|function|class|let` 去掉
 * 关键字、末尾追加 module.exports，写成 index.cjs（带「自动生成」抬头）。
 * 内容无变化时不写盘（避免 mtime 抖动导致 sync-assets 反复复制）。
 *
 * 用法：node scripts/gen-shared-cjs.js [--check]
 *   --check  只校验 index.cjs 是否与 index.mjs 同步，不同步则退出码 1（发版前/CI 用）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAIRS = [
  { src: path.join(ROOT, 'shared', 'recipe-cost', 'index.mjs'), dst: path.join(ROOT, 'shared', 'recipe-cost', 'index.cjs') }
];

const CHECK = process.argv.slice(2).includes('--check');

function buildOne(srcPath, dstPath) {
  const src = fs.readFileSync(srcPath, 'utf8');
  const names = [];
  let out = src.replace(/^export\s+(const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm, (m, kw, name) => {
    names.push(name);
    return kw + ' ' + name;
  });
  if (/^export\s+default/m.test(out)) {
    throw new Error(dstPath + '：生成器不支持 export default，请手工处理');
  }
  if (/^export\s+[{*]/m.test(out)) {
    throw new Error(dstPath + '：生成器不支持 export { } / export * from，请手工处理');
  }
  if (!names.length) {
    throw new Error(dstPath + '：源文件里没有抓到任何 export，生成器规则可能已失效');
  }

  /* 行尾跟随源文件（源多为 CRLF），保证生成物行尾统一、二次运行幂等 */
  const eol = src.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const normalize = (s) => s.replace(/\r\n/g, '\n').replace(/\n/g, eol);

  const body = out.replace(/^'use strict';\s*/, '');
  const rel = path.relative(ROOT, dstPath).split(path.sep).join('/');
  const srcRel = path.relative(ROOT, srcPath).split(path.sep).join('/');
  const header = normalize("'use strict';\n"
    + '/*\n'
    + ' * ' + rel + ' —— 【自动生成，请勿手改】\n'
    + ' * 由 scripts/gen-shared-cjs.js 从 ' + srcRel + ' 生成。\n'
    + ' * 存在理由：桌面端 Electron 内置 Node 20.18 不支持 require(ESM)，\n'
    + ' * BFF 侧必须能同步 require 本文件；改逻辑请改 ' + srcRel + ' 后重新生成。\n'
    + ' */\n');
  const tail = normalize('\nmodule.exports = {\n  ' + names.join(',\n  ') + '\n};\n');
  return normalize(header + body.replace(/\s*$/, '\n') + tail);
}

let failed = false;
for (const p of PAIRS) {
  const next = buildOne(p.src, p.dst);
  const prev = fs.existsSync(p.dst) ? fs.readFileSync(p.dst, 'utf8') : null;
  /* 行尾归一后再比较：Windows 上 git autocrlf 会把生成物换成 CRLF，不能因此判为「不同步」 */
  const toLf = (s) => (s == null ? null : s.replace(/\r\n/g, '\n'));
  const rel = path.relative(ROOT, p.dst).split(path.sep).join('/');
  if (toLf(prev) === toLf(next)) {
    console.log('[gen-shared-cjs] ' + rel + ' 已是最新');
    continue;
  }
  if (CHECK) {
    console.error('[gen-shared-cjs] ✗ ' + rel + ' 与 ESM 源不同步，请执行：node scripts/gen-shared-cjs.js');
    failed = true;
    continue;
  }
  fs.writeFileSync(p.dst, next, 'utf8');
  console.log('[gen-shared-cjs] 已生成 ' + rel + '（' + next.length + ' 字节）');
}

if (failed) process.exit(1);
