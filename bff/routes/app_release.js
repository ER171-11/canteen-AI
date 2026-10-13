'use strict';
/*
 * routes/app_release.js — 局域网 App 分发包（供 PC 管理后台「App 下载」页）
 *   GET  /api/app/release   公开：安装包元信息（版本/大小/哈希/局域网地址）
 *   GET  /api/app/download  公开：流式下发 APK（支持 Range 断点续传）
 *   HEAD /api/app/download  公开：供下载器探测大小/可续传
 *
 * 只读：仅读取 Android 构建产物，不触碰任何业务数据，不进 actions 队列。
 * 构建产物路径：APP_APK_PATH（绝对或相对仓库根）覆盖，默认 debug 包。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_APK = path.join(
  REPO_ROOT, 'apps', 'android-app', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'
);

function apkPath() {
  const p = process.env.APP_APK_PATH;
  if (!p) return DEFAULT_APK;
  return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
}

function apkMetaPath() {
  return path.join(path.dirname(apkPath()), 'output-metadata.json');
}

function readMeta() {
  try {
    const raw = JSON.parse(fs.readFileSync(apkMetaPath(), 'utf8'));
    const el = (raw.elements && raw.elements[0]) || {};
    return {
      applicationId: raw.applicationId || null,
      versionName: el.versionName || null,
      versionCode: el.versionCode != null ? el.versionCode : null,
      minSdk: raw.minSdkVersionForDexing != null ? raw.minSdkVersionForDexing : null,
      variant: raw.variantName || null
    };
  } catch (e) {
    return {};
  }
}

let _hashCache = { key: '', sha256: '' };
function sha256(file) {
  const st = fs.statSync(file);
  const key = st.size + ':' + st.mtimeMs;
  if (_hashCache.key === key) return _hashCache.sha256;
  const hex = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  _hashCache = { key, sha256: hex };
  return hex;
}

function humanSize(n) {
  if (n == null) return null;
  const mb = n / 1024 / 1024;
  return mb >= 1 ? mb.toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';
}

/** 排除虚拟网卡/链路本地地址（VirtualBox、Docker/WSL、169.254 等），避免二维码指向手机不可达的 IP */
function isVirtualOrLocal(ip) {
  return (
    ip.startsWith('169.254.') || // 链路本地
    ip.startsWith('192.168.56.') || // VirtualBox Host-Only 默认网段
    ip.startsWith('198.18.') || // 基准测试保留段（部分虚拟网卡使用）
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) // Docker/WSL/Hyper-V 常用 172.16-31 段
  );
}

function lanIPv4() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  const real = out.filter((ip) => !isVirtualOrLocal(ip));
  return real.length > 0 ? real : out;
}

function port() {
  return parseInt(process.env.BFF_PORT || '8787', 10);
}

/** 安装包元信息（供下载页展示与生成二维码） */
function releaseInfo() {
  const file = apkPath();
  let st = null;
  try { st = fs.statSync(file); } catch (e) { st = null; }
  const meta = readMeta();
  const portNum = port();
  const suffix = portNum === 80 ? '' : ':' + portNum;
  const ips = lanIPv4();
  const urls = ips.map((ip) => 'http://' + ip + suffix + '/api/app/download');
  return {
    ok: !!st && st.isFile(),
    available: !!st && st.isFile(),
    applicationId: meta.applicationId,
    versionName: meta.versionName,
    versionCode: meta.versionCode,
    minSdk: meta.minSdk,
    variant: meta.variant,
    file: path.basename(file),
    size: st ? st.size : null,
    sizeText: st ? humanSize(st.size) : null,
    sha256: st ? sha256(file) : null,
    builtAt: st ? new Date(st.mtimeMs).toISOString() : null,
    downloadPath: '/api/app/download',
    lan: { port: portNum, ips, urls },
    note: st && st.isFile() ? null : '未找到构建产物，请先构建 APK 或设置 APP_APK_PATH',
    error: null
  };
}

function streamApk(req, res, file, st) {
  const common = {
    'Content-Type': 'application/vnd.android.package-archive',
    'Access-Control-Allow-Origin': '*',
    'Content-Disposition': 'attachment; filename="' + path.basename(file) + '"',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  };

  if (req.method === 'HEAD') {
    res.writeHead(200, Object.assign({}, common, { 'Content-Length': st.size }));
    res.end();
    return;
  }

  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m) {
      if (m[1] !== '') start = parseInt(m[1], 10);
      if (m[2] !== '') end = parseInt(m[2], 10);
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= st.size) end = st.size - 1;
      if (start > end) {
        res.writeHead(416, Object.assign({}, common, { 'Content-Range': 'bytes */' + st.size }));
        res.end();
        return;
      }
      status = 206;
    }
  }

  const headers = Object.assign({}, common, { 'Content-Length': end - start + 1 });
  if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
  res.writeHead(status, headers);
  fs.createReadStream(file, { start, end }).pipe(res);
}

async function handle(req, res, ctx, pathname) {
  if (pathname === '/api/app/release') {
    if (req.method !== 'GET') return false;
    ctx.sendJSON(res, 200, releaseInfo());
    return true;
  }

  if (pathname === '/api/app/download') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const file = apkPath();
    let st = null;
    try { st = fs.statSync(file); } catch (e) { st = null; }
    if (!st || !st.isFile()) {
      ctx.sendJSON(res, 404, {
        ok: false,
        error: 'apk not built',
        hint: '先构建：cd apps/android-app && ./gradlew :app:assembleDebug'
      });
      return true;
    }
    streamApk(req, res, file, st);
    return true;
  }

  return false;
}

module.exports = { handle, releaseInfo };
