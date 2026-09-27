'use strict';
/*
 * seed/util.js — 迁移期共用的数值 / 时间小工具（纯 Node 内置，零第三方依赖）
 *
 * 关键点：pyRound 必须复刻 Python round() 的「就近取整、半值取偶」语义，
 * 因为店内 HTML 与 Python 脚本用 round(x, n) 生成库存/成本数字，
 * 直接 Math.round 在半值（如 0.125→0.12）上会与 Python 不一致。
 * 实现方式：把 double 精确拆成 mant * 2^exp，对 x*10^n 做精确有理数
 * 四舍五入（ties-to-even），再除以 10^n 取最近 double。
 */

/** Python round(x, n)：就近取整、半值取偶（n>=0）。 */
function pyRound(x, n) {
  n = n | 0;
  const v = Number(x);
  if (!Number.isFinite(v)) return v;
  if (v === 0) return v;
  const neg = v < 0;
  const ax = Math.abs(v);

  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, ax);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (exp === 0) {
    e = -1074;
  } else {
    mant |= (1n << 52n);
    e = exp - 1075;
  }
  let num = mant * (10n ** BigInt(n));
  let den = 1n;
  if (e >= 0) num <<= BigInt(e);
  else den = 1n << BigInt(-e);

  let q = num / den;
  const r = num % den;
  const twice = r * 2n;
  if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
  const res = Number(q) / Math.pow(10, n);
  return neg ? -res : res;
}

/** Python float(v) 的宽松等价：不可解析则回退默认值。 */
function toNum(v, dflt = 0) {
  if (v === null || v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Python int(v) 的宽松等价（截断），不可解析回退默认值。 */
function toInt(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地日期 YYYY-MM-DD（对齐 datetime.now().strftime("%Y-%m-%d")）。 */
function todayLocal() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 本地 ISO 秒级带时区偏移（对齐 datetime.now().astimezone().isoformat(timespec="seconds")）。 */
function localIsoSeconds() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
    sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60)
  );
}

/** UTC 微秒 ISO（对齐 datetime.now(timezone.utc).isoformat().replace("+00:00","Z")）。 */
function utcNowIsoMicros() {
  const iso = new Date().toISOString();
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3})Z$/.exec(iso);
  if (!m) return iso;
  return m[1] + '.' + m[2] + '000Z';
}

/** 本地时间戳 tag YYYYMMDD_HHMMSS（对齐 datetime.now().strftime("%Y%m%d_%H%M%S")）。 */
function nowTag() {
  const d = new Date();
  return (
    d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
    '_' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())
  );
}

/** 深拷贝（对齐 Python json.loads(json.dumps(...)) 语义，供纯 JSON 数据使用）。 */
function deepCopy(v) {
  return JSON.parse(JSON.stringify(v));
}

module.exports = { pyRound, toNum, toInt, todayLocal, localIsoSeconds, utcNowIsoMicros, nowTag, deepCopy };
