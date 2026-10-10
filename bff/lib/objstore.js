'use strict';
/*
 * lib/objstore.js — 对象存储（S3 / 阿里云 OSS / MinIO）零依赖预签名
 *
 * 为什么需要它：
 *   A 块「AI 品控识别」要求不合格大图能推到 admin-web 后台查看，照片就必须有
 *   一个服务器侧可直接访问的位置。而项目红线规定：
 *     - bff/server.js:9  「图片 base64 只用内存，响应后销毁」
 *     - ci/redline_guard.sh 命中「图片 base64 落盘」即 CI 失败
 *     - bff/server.js:10 「仅 Node 内置 http/https/fs/path/crypto」
 *   因此照片既不落 BFF 磁盘、也不进数据库，而是由 BFF **签发预签名 URL**，
 *   App 直传对象存储；数据库只保存 photo_key / photo_url 引用。
 *
 * 实现：AWS SigV4 query-string 预签名（node:crypto HMAC-SHA256），
 *   不引入任何 SDK，兼容 AWS S3、阿里云 OSS（OSS_SERVICE=oss）、MinIO。
 *
 * 环境变量（密钥严禁硬编码：scripts/lint-zero-dep.js 会拦 sk- / KIMI_API_KEY= 模式）：
 *   OSS_ENDPOINT     必填，形如 https://oss-cn-hangzhou.aliyuncs.com 或 http://127.0.0.1:9000
 *   OSS_BUCKET       必填
 *   OSS_AK / OSS_SK  必填（AccessKey / SecretKey）
 *   OSS_REGION       选填，默认 us-east-1
 *   OSS_SERVICE      选填，默认 s3；阿里云 OSS 原生签名填 oss
 *   OSS_PATH_STYLE   选填，默认 '1'（path-style，兼容 OSS/MinIO/AWS）；
 *                    置 '0' 改用 virtual-host 风格（bucket 作为子域）
 *   OSS_PUBLIC_BASE  选填，对象公开读基址；未配置则 photo_url 留空、读图走 presignGet
 *   OSS_EXPIRE_SEC   选填，默认 900（15 分钟），上限 604800（7 天）
 *
 * 未配置时：configured() === false，presignPut/presignGet 返回 null，
 *   调用方必须降级（品控仍完成识别与状态落库，后台标注「图片不可用」），功能不中断。
 */
const crypto = require('crypto');

const DEFAULT_REGION = 'us-east-1';
const DEFAULT_SERVICE = 's3';
const DEFAULT_EXPIRE = 900;
const MAX_EXPIRE = 604800;
const REQUIRED_ENVS = ['OSS_ENDPOINT', 'OSS_BUCKET', 'OSS_AK', 'OSS_SK'];
const ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'webp', 'heic'];

function envStr(name) {
  const v = process.env[name];
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** 读取配置；必填项缺失或端点非法时返回 null（调用方降级，不抛错） */
function config() {
  const endpoint = envStr('OSS_ENDPOINT');
  const bucket = envStr('OSS_BUCKET');
  const ak = envStr('OSS_AK');
  const sk = envStr('OSS_SK');
  if (!endpoint || !bucket || !ak || !sk) return null;
  if (!/^https?:\/\//i.test(endpoint)) return null;

  let origin = endpoint.replace(/\/+$/, '');
  let host;
  try {
    host = new URL(origin).host;
  } catch (e) {
    return null;
  }

  const pathStyleRaw = envStr('OSS_PATH_STYLE');
  const pathStyle = pathStyleRaw === '' ? true : pathStyleRaw !== '0';
  if (!pathStyle) {
    origin = origin.replace('://', '://' + bucket + '.');
    host = bucket + '.' + host;
  }

  const expireSec = clampInt(envStr('OSS_EXPIRE_SEC'), DEFAULT_EXPIRE, 1, MAX_EXPIRE);
  return {
    origin,
    host,
    bucket,
    region: envStr('OSS_REGION') || DEFAULT_REGION,
    service: envStr('OSS_SERVICE') || DEFAULT_SERVICE,
    ak,
    sk,
    pathStyle,
    publicBase: envStr('OSS_PUBLIC_BASE').replace(/\/+$/, ''),
    expireSec
  };
}

function configured() {
  return config() !== null;
}

function missingEnv() {
  return REQUIRED_ENVS.filter((n) => !envStr(n));
}

/* ---------- 编码与签名原语 ---------- */

function uriEnc(s) {
  return encodeURIComponent(String(s))
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function uriEncPath(p) {
  return String(p).split('/').map(uriEnc).join('/');
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/** ISO8601 基本格式：20260929T201500Z */
function amzStamp(d) {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/* ---------- 对象键 ---------- */

function safeSeg(v) {
  const s = String(v === undefined || v === null ? '' : v).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
  return s || 'na';
}

function safeExt(v) {
  const e = String(v === undefined || v === null ? '' : v).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return ALLOWED_EXT.indexOf(e) >= 0 ? e : 'jpg';
}

/** 归一对象键：去前导斜杠、拒绝路径穿越；非法返回 null */
function normKey(key) {
  const k = String(key === undefined || key === null ? '' : key).trim().replace(/^\/+/, '');
  if (!k || k.indexOf('..') >= 0) return null;
  return k;
}

/** 生成品控照片对象键：qc/{store}/{date}/{workorder}-{stamp}-{rand}.{ext} */
function buildQcKey(opt) {
  const o = opt || {};
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(o.date || ''))
    ? String(o.date)
    : new Date().toISOString().slice(0, 10);
  const wo = safeSeg(o.workorder_id === undefined || o.workorder_id === null ? 'na' : o.workorder_id);
  const stamp = safeSeg(o.stamp === undefined || o.stamp === null ? Date.now() : o.stamp);
  const rand = crypto.randomBytes(3).toString('hex');
  return ['qc', safeSeg(o.store_id || o.storeId || 'default'), date, wo + '-' + stamp + '-' + rand + '.' + safeExt(o.ext)].join('/');
}

/** 生成点位规范演示图对象键：points/{store}/{date}/{kind}-{id}-{stamp}-{rand}.{ext} */
function buildPointDemoKey(opt) {
  const o = opt || {};
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(o.date || ''))
    ? String(o.date)
    : new Date().toISOString().slice(0, 10);
  const kind = safeSeg(o.kind === undefined || o.kind === null ? 'na' : o.kind);
  const id = safeSeg(o.id === undefined || o.id === null ? 'na' : o.id);
  const stamp = safeSeg(o.stamp === undefined || o.stamp === null ? Date.now() : o.stamp);
  const rand = crypto.randomBytes(3).toString('hex');
  return ['points', safeSeg(o.store_id || o.storeId || 'default'), date, kind + '-' + id + '-' + stamp + '-' + rand + '.' + safeExt(o.ext)].join('/');
}

/* ---------- 预签名 ---------- */

/**
 * SigV4 预签名核心。method 为 'PUT'（上传）或 'GET'（读取）。
 * 返回 { ok, key, method, url, expires_in, signed_at }；未配置或键非法返回 null。
 * 只签名 host 头，避免客户端必须精确复现 Content-Type 才能上传。
 */
function presign(method, key, opt) {
  const cfg = config();
  const k = normKey(key);
  if (!cfg || !k) return null;

  const o = opt || {};
  const expires = clampInt(o.expires, cfg.expireSec, 1, MAX_EXPIRE);
  const stamp = amzStamp(o.now ? new Date(o.now) : new Date());
  const dateStamp = stamp.slice(0, 8);
  const scope = dateStamp + '/' + cfg.region + '/' + cfg.service + '/aws4_request';
  const canonicalUri = (cfg.pathStyle ? '/' + uriEnc(cfg.bucket) : '') + '/' + uriEncPath(k);

  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': cfg.ak + '/' + scope,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host'
  };
  const canonicalQuery = Object.keys(params).sort()
    .map((n) => uriEnc(n) + '=' + uriEnc(params[n])).join('&');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    'host:' + cfg.host + '\n',
    'host',
    'UNSIGNED-PAYLOAD'
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + cfg.sk, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, cfg.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    ok: true,
    key: k,
    method,
    url: cfg.origin + canonicalUri + '?' + canonicalQuery + '&X-Amz-Signature=' + signature,
    expires_in: expires,
    signed_at: stamp
  };
}

/** 上传预签名（App 直传）。contentType 仅作提示，未纳入签名。 */
function presignPut(key, opt) {
  const r = presign('PUT', key, opt);
  if (!r) return null;
  r.headers = { 'Content-Type': (opt && opt.contentType) || 'application/octet-stream' };
  return r;
}

/** 读取预签名（admin-web 展示大图；bucket 私有时的唯一读法） */
function presignGet(key, opt) {
  const r = presign('GET', key, opt);
  if (!r) return null;
  r.headers = {};
  return r;
}

/** 公开读地址；未配置 OSS_PUBLIC_BASE（即 bucket 私有）时返回 null */
function publicUrl(key) {
  const cfg = config();
  const k = normKey(key);
  if (!cfg || !k || !cfg.publicBase) return null;
  return cfg.publicBase + '/' + uriEncPath(k);
}

/** 供前端判断降级：绝不返回密钥 */
function status() {
  const cfg = config();
  if (!cfg) return { configured: false, missing: missingEnv(), public_base: false };
  return {
    configured: true,
    host: cfg.host,
    bucket: cfg.bucket,
    region: cfg.region,
    service: cfg.service,
    path_style: cfg.pathStyle,
    public_base: !!cfg.publicBase,
    expire_sec: cfg.expireSec
  };
}

module.exports = {
  configured,
  status,
  missingEnv,
  normKey,
  buildQcKey,
  buildPointDemoKey,
  presign,
  presignPut,
  presignGet,
  publicUrl,
  amzStamp,
  DEFAULT_EXPIRE,
  MAX_EXPIRE,
  ALLOWED_EXT
};
