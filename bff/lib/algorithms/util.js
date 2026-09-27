'use strict';
/*
 * lib/algorithms/util.js — 算法层公共工具
 *
 * 迁移自 store-inventory/queue_consumer.py 的通用辅助（now_iso/today/_r3/num 等），
 * 统一 BFF 算法层的数值与时间口径，避免各算法各写一套。
 */

function nowIso() {
  return new Date().toISOString();
}

/** 本地日期 YYYY-MM-DD（与店内 Python today() 对齐，按本机时区） */
function today(d) {
  const dt = d ? new Date(d) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
}

/** 数值：解析失败回落默认值（对齐 Python num(v,d)） */
function num(v, d) {
  if (v === '' || v === null || v === undefined) return d;
  const n = parseFloat(v);
  return isNaN(n) ? d : n;
}

/** 保留 3 位小数（对齐 Python _r3） */
function r3(x) {
  const n = num(x, 0);
  return Math.round(n * 1000) / 1000;
}

/** 保留 2 位小数 */
function r2(x) {
  const n = num(x, 0);
  return Math.round(n * 100) / 100;
}

/** 数组兜底 */
function arr(v) {
  return Array.isArray(v) ? v : [];
}

/** 深合并：src 覆盖 dst（不改 dst 原对象，对齐 Python _deep_merge） */
function deepMerge(dst, src) {
  const out = Object.assign({}, dst);
  for (const k of Object.keys(src || {})) {
    const sv = src[k];
    if (sv && typeof sv === 'object' && !Array.isArray(sv)
      && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], sv);
    } else {
      out[k] = sv;
    }
  }
  return out;
}

/** 规范化菜单/配菜名（对齐 Python _norm_menu_name：去空白与括号后缀） */
function normMenuName(s) {
  return String(s == null ? '' : s)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/御字牌|五福饺子/g, '')
    .replace(/\s+/g, '')
    .trim();
}

module.exports = { nowIso, today, num, r3, r2, arr, deepMerge, normMenuName };
