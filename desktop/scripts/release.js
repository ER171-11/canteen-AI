'use strict';
/*
 * scripts/release.js —— 一键发版：bump 版本 → 同步资源 → electron-builder --publish always 上传 GitHub Releases
 *
 * 用法：
 *   node scripts/release.js --patch            # 0.1.0 → 0.1.1
 *   node scripts/release.js --minor            # 0.1.0 → 0.2.0
 *   node scripts/release.js --major            # 0.1.0 → 1.0.0
 *   node scripts/release.js --version=0.2.0    # 指定精确版本
 *   node scripts/release.js --patch --dry-run  # 只打印流程，不写盘 / 不构建 / 不上传
 *
 * 前置：
 *   1) 环境变量 GH_TOKEN（GitHub Personal Access Token，需 repo 权限）
 *      PowerShell 临时设置：  $env:GH_TOKEN="ghp_xxx"
 *      PowerShell 永久设置：  [Environment]::SetEnvironmentVariable("GH_TOKEN","ghp_xxx","User")
 *   2) 已完成 npm install（electron / electron-builder / electron-updater）
 *   3) build.publish.owner/repo 已填真实仓库（当前为 ER171-11/canteen-AI）
 *
 * 会做什么：
 *   1) 把 desktop/package.json 的 version 写到目标版本
 *   2) node scripts/sync-assets.js（bff/shared/dist → desktop/app）
 *   3) electron-builder --publish always（构建 NSIS 安装包 + 上传 GitHub Releases + 生成 latest.yml）
 *   客户端下次启动即可检测到新版本并提示更新。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const DESKTOP = path.join(__dirname, '..');
const PKG_PATH = path.join(DESKTOP, 'package.json');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const BUMP = argv.find((a) => a === '--patch' || a === '--minor' || a === '--major');
const VERSION_ARG = argv.find((a) => a.indexOf('--version=') === 0);

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

function nextVersion(cur, kind) {
  const p = cur.split('.').map(Number);
  if (kind === '--major') return `${p[0] + 1}.0.0`;
  if (kind === '--minor') return `${p[0]}.${p[1] + 1}.0`;
  if (kind === '--patch') return `${p[0]}.${p[1]}.${p[2] + 1}`;
  return null;
}

const target = VERSION_ARG ? VERSION_ARG.slice('--version='.length) : nextVersion(pkg.version, BUMP);

if (!/^\d+\.\d+\.\d+$/.test(target || '')) {
  console.error('[release] 用法：node scripts/release.js [--patch|--minor|--major|--version=x.y.z] [--dry-run]');
  process.exit(1);
}
if (target === pkg.version) {
  console.error('[release] 目标版本与当前版本相同（' + target + '），无需发版');
  process.exit(1);
}

/* GH_TOKEN 读取顺序：环境变量 → ~/.canteen/gh_token → desktop/.gh_token
 * 目的：token 不进对话、不落仓库；写到主目录本地文件里，发版时自动读，
 *       避免「已运行的 IDE 进程读不到你新设的环境变量」这个坑。 */
function readToken() {
  const fromEnv = String(process.env.GH_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const files = [
    path.join(os.homedir(), '.canteen', 'gh_token'),
    path.join(DESKTOP, '.gh_token'),
  ];
  for (const f of files) {
    try {
      if (fs.existsSync(f)) {
        const t = fs.readFileSync(f, 'utf8').trim();
        if (t) return t;
      }
    } catch (e) { /* ignore */ }
  }
  return '';
}
const token = readToken();

console.log('[release] 发版 ' + pkg.version + ' → ' + target + (DRY ? '（dry-run）' : ''));
if (token) console.log('[release] GH_TOKEN 已就绪（' + token.slice(0, 4) + '…）');
else if (!DRY) console.warn('[release] ⚠ 未检测到 GH_TOKEN（上传 Releases 前会拦截）');

/* 1) bump version */
if (!DRY) {
  pkg.version = target;
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
}
console.log('[release] 1/3 version 已写入 package.json：' + target);

/* 2) 同步资源（bff/shared/dist → desktop/app） */
console.log('[release] 2/3 同步资源（bff/shared/dist → desktop/app）...');
if (!DRY) {
  const r = spawnSync(process.execPath, [path.join(DESKTOP, 'scripts', 'sync-assets.js')], { stdio: 'inherit', cwd: DESKTOP });
  if (r.status !== 0) { console.error('[release] sync-assets 失败'); process.exit(1); }
}

/* 3) 构建 + 上传 GitHub Releases */
console.log('[release] 3/3 构建 NSIS 并上传 GitHub Releases（tag=v' + target + '）...');
if (!DRY) {
  if (!token) {
    console.error('[release] 缺少 GH_TOKEN，无法上传 Releases。请先设置：$env:GH_TOKEN="ghp_xxx"');
    process.exit(1);
  }
  /* Windows 上 Node spawnSync 直接调 .cmd shim 会静默失败（status=null、无任何日志），
     改为直接用当前 node 执行 electron-builder 的 JS 入口，跨平台且可靠 */
  const ebEntry = path.join(DESKTOP, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
  const env = Object.assign({}, process.env, {
    GH_TOKEN: token,
    /* 本地无代码签名证书，禁自动发现，交由 noop-sign.js 空签名（不因找不到证书中断构建） */
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    /* 本机访问 GitHub 有 HTTPS 证书拦截（企业代理/自签名），让 Node 用系统证书存储，
       否则 electron-builder 上传 Releases 会报 unable to verify certificate */
    NODE_OPTIONS: (process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : '') + '--use-system-ca',
  });
  const r = spawnSync(process.execPath, [ebEntry, '--publish', 'always'], { stdio: 'inherit', cwd: DESKTOP, env });
  if (r.status !== 0) { console.error('[release] electron-builder 失败（status=' + r.status + '）'); process.exit(1); }
}

console.log('[release] 完成' + (DRY ? '（dry-run，未实际发版）' : '：v' + target + ' 已发布，客户端下次启动即可检测更新'));
