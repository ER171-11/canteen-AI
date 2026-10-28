'use strict';
/*
 * scripts/sync-assets.js —— 把仓库源码同步进 desktop/app（Electron 打包根）。
 *
 * 为什么需要：electron-builder 只收 desktop/app/ 下的文件，而运行期代码有三处跨目录依赖：
 *   1. shared/        ← bff/lib/recipe_cost.js 用 require('../../shared/recipe-cost/index.cjs')
 *                        （BFF 在 app/bff，故相对路径落到 app/shared）
 *   2. apps/admin-web/dist → app/dist（前端构建产物）
 *   3. bff/           → app/bff（后端源码）
 * 少同步任何一处，打包后要么 BFF 启动即 Cannot find module，要么前端是旧版。
 *
 * 用法：
 *   node scripts/sync-assets.js                # 全量同步（shared + bff + dist）
 *   node scripts/sync-assets.js --dry-run      # 只列差异，不写盘
 *   node scripts/sync-assets.js --only=bff     # 只同步某几块（逗号分隔）
 *   node scripts/sync-assets.js --verbose      # 打印每个文件动作
 *
 * 保护项（永不复制、也永不删除目标侧）：
 *   bff/data/（本机运行数据）、bff/data.seed/（桌面首启空快照基线）、bff/.env、*.test.js、test/、node_modules/
 *
 * 由 desktop/package.json 的 pack/dist 脚本前置调用。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');          // 仓库根
const APP = path.join(__dirname, '..', 'app');          // desktop/app（打包根）

/* bff 目录的保护规则：命中即「不复制、不删除」 */
const BFF_PROTECT = [
  /^data($|\/)/,
  /* store-node 的推送水位是店内节点的本机运行状态，不进安装包 */
  /^store-node\/data($|\/)/,
  /^data\.seed($|\/)/,
  /^node_modules($|\/)/,
  /(^|\/)node_modules($|\/)/,
  /^\.env$/,
  /\.test\.js$/,
  /(^|\/)test($|\/)/,
  /\.bak($|\.)/
];

const TASKS = [
  {
    name: 'shared',
    src: path.join(ROOT, 'shared'),
    dst: path.join(APP, 'shared'),
    protect: [/^node_modules($|\/)/]
  },
  {
    name: 'bff',
    src: path.join(ROOT, 'bff'),
    dst: path.join(APP, 'bff'),
    protect: BFF_PROTECT
  },
  {
    name: 'dist',
    src: path.join(ROOT, 'apps', 'admin-web', 'dist'),
    dst: path.join(APP, 'dist'),
    protect: [/^node_modules($|\/)/]
  }
];

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');
const ONLY = (() => {
  const a = argv.find((x) => x.indexOf('--only=') === 0);
  if (!a) return null;
  return a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
})();

function relOf(base, abs) {
  return path.relative(base, abs).split(path.sep).join('/');
}
function protectedRel(task, rel) {
  return task.protect.some((re) => re.test(rel));
}

/** 递归列文件（相对路径），跳过受保护项 */
function listFiles(root, task, out) {
  const acc = out || [];
  if (!fs.existsSync(root)) return acc;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = relOf(root, abs);
      if (protectedRel(task, rel)) continue;
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) acc.push(rel);
    }
  };
  walk(root);
  return acc;
}

function statOrNull(p) {
  try { return fs.statSync(p); } catch (e) { return null; }
}

/** 单块镜像同步：复制新增/变更 + 删除目标侧多余文件（受保护项不删） */
function syncOne(task, opts) {
  const stats = { added: 0, updated: 0, removed: 0, same: 0, error: 0 };
  const srcStat = statOrNull(task.src);
  if (!srcStat || !srcStat.isDirectory()) {
    console.warn('[sync-assets] 跳过 ' + task.name + '：源目录不存在 ' + task.src);
    stats.error += 1;
    return stats;
  }

  const srcFiles = listFiles(task.src, task);
  const srcSet = new Set(srcFiles);
  const dstFiles = listFiles(task.dst, task);

  for (const rel of srcFiles) {
    const s = path.join(task.src, rel);
    const d = path.join(task.dst, rel);
    const ss = statOrNull(s);
    const ds = statOrNull(d);
    if (!ss) continue;
    const changed = !ds || ds.size !== ss.size || Math.abs(ds.mtimeMs - ss.mtimeMs) > 1000;
    if (!changed) { stats.same += 1; continue; }
    if (!opts.dryRun) {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      /* 保留源 mtime，避免下次同步因时间戳差异反复复制 */
      try { fs.utimesSync(d, ss.atime, ss.mtime); } catch (e) {}
    }
    if (ds) stats.updated += 1; else stats.added += 1;
    if (opts.verbose) console.log('  ' + (ds ? '~ ' : '+ ') + rel);
  }

  /* 镜像删除：目标有、源没有（受保护项天然不在 dstFiles 里，安全） */
  for (const rel of dstFiles) {
    if (srcSet.has(rel)) continue;
    if (!opts.dryRun) {
      try { fs.unlinkSync(path.join(task.dst, rel)); } catch (e) { continue; }
    }
    stats.removed += 1;
    if (opts.verbose) console.log('  - ' + rel);
  }

  return stats;
}

/** 构建产物新鲜度：dist 比源码旧就提醒（不同步就等于发旧前端） */
function warnIfDistStale() {
  const distDir = path.join(ROOT, 'apps', 'admin-web', 'dist');
  const srcDir = path.join(ROOT, 'apps', 'admin-web', 'src');
  const newest = (dir) => {
    let max = 0;
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, ent.name);
        if (ent.isDirectory()) walk(abs);
        else {
          const st = statOrNull(abs);
          if (st && st.mtimeMs > max) max = st.mtimeMs;
        }
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return max;
  };
  if (!fs.existsSync(distDir)) {
    console.warn('[sync-assets] ⚠ apps/admin-web/dist 不存在，先执行：cd apps/admin-web && npm run build');
    return;
  }
  const dt = newest(distDir);
  const st = newest(srcDir);
  if (dt && st && dt < st) {
    const fmt = (t) => new Date(t).toLocaleString('zh-CN');
    console.warn('[sync-assets] ⚠ dist 落后于源码：dist=' + fmt(dt) + '，src=' + fmt(st) + '；建议先 cd apps/admin-web && npm run build');
  }
}

function main() {
  const picked = TASKS.filter((t) => !ONLY || ONLY.indexOf(t.name) >= 0);
  if (!picked.length) {
    console.error('[sync-assets] --only 未命中任何块，可用：' + TASKS.map((t) => t.name).join(','));
    process.exit(1);
  }
  console.log('[sync-assets] ' + (DRY ? '预演（不写盘）' : '开始同步') + '：' + picked.map((t) => t.name).join(' + '));
  if (!DRY && (!ONLY || ONLY.indexOf('dist') >= 0)) warnIfDistStale();

  let failed = false;
  for (const task of picked) {
    const st = syncOne(task, { dryRun: DRY, verbose: VERBOSE });
    console.log('[sync-assets] ' + task.name.padEnd(6)
      + ' +' + st.added + ' ~' + st.updated + ' -' + st.removed
      + ' （未变 ' + st.same + '）→ ' + task.dst);
    if (st.error) failed = true;
  }
  if (failed) process.exit(1);
  console.log('[sync-assets] 完成' + (DRY ? '（预演，未改动任何文件）' : ''));
}

main();
