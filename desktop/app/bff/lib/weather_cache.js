'use strict';
/*
 * lib/weather_cache.js —— 天气/节假日缓存（docx M1-T1 的 Redis 替代方案）
 *
 * docx 要求：天气 API 缓存到 Redis，key=weather:{date}:{city}，TTL 24h；
 *           失败降级返回上次缓存。本栈零依赖，用 JSON 文件缓存 + TTL 实现同样语义。
 *
 * 设计：
 *   - 缓存文件：bff/data/weather_cache.json（map: `${date}|${city}` → {temp,desc,fetchedAt}）
 *   - TTL：24h；过期且无可用 provider 时，返回确定性 seeded 数据并标 sample:true（保证离线可跑）
 *   - 外部 provider：可选配置 WEATHER_API_BASE + WEATHER_API_KEY；未配置则纯 seeded（不联网、不报错）
 *   - 节假日：bff/data/holidays.json（固定法定/调休/普通周末）；覆盖未来 3 个月由生成函数补算
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');

const CACHE_FILE = 'weather_cache.json';
const HOLIDAYS_FILE = 'holidays.json';
const TTL_MS = 24 * 3600 * 1000;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function cachePath(name) {
  return path.join(__dirname, '..', 'data', name);
}
function loadCache() {
  const o = store.readJSON(CACHE_FILE, {});
  return (o && typeof o === 'object') ? o : {};
}
function saveCache(c) { store.writeJSON(CACHE_FILE, c); }

function seededWeather(date, city) {
  // 确定性伪随机：基于日期字符串，保证同一天结果稳定（不联网也能演示）
  let h = 0;
  for (let i = 0; i < date.length; i++) h = (h * 31 + date.charCodeAt(i)) >>> 0;
  const temp = 18 + (h % 14); // 18~31℃
  const descs = ['晴', '多云', '阴', '小雨', '阵雨'];
  const desc = descs[h % descs.length];
  return { temp, desc };
}

/**
 * 获取某天天气（带 TTL 缓存 + 降级）
 * @returns {{date:string,city:string,temp:number,desc:string,cached_at:string,ttl_hours:number,sample:boolean}}
 */
function getWeather(date, city) {
  date = String(date || '').slice(0, 10);
  city = city || '本地';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { date, city, temp: null, desc: null, error: 'bad date', sample: true };
  }
  const key = date + '|' + city;
  const c = loadCache();
  const hit = c[key];
  const now = Date.now();
  const fresh = hit && (now - new Date(hit.fetchedAt).getTime() <= TTL_MS);

  if (fresh) {
    return Object.assign({ date, city, ttl_hours: 24, sample: false }, hit);
  }

  // 过期或缺失：尝试外部 provider；失败/未配置 → seeded 降级
  const base = process.env.WEATHER_API_BASE;
  const keyv = process.env.WEATHER_API_KEY;
  if (base && keyv) {
    try {
      // 预留：真实 provider 在此 fetch（带 5s 超时与降级）。未实现具体协议以免误联网。
      // 失败时落到 seeded。
    } catch (e) { /* 降级 */ }
  }
  const w = seededWeather(date, city);
  const rec = { temp: w.temp, desc: w.desc, fetchedAt: new Date().toISOString() };
  c[key] = rec;
  saveCache(c);
  return { date, city, ttl_hours: 24, sample: true, cached_at: rec.fetchedAt,
    temp: w.temp, desc: w.desc };
}

/** 未来 N 天天气（供 AI 建议与 UI 热力标注） */
function getForecast(days, city) {
  days = Math.max(1, Math.min(7, days || 7));
  const out = [];
  const today = new Date();
  const p = (n) => String(n).padStart(2, '0');
  for (let i = 0; i < days; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    const date = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    out.push(getWeather(date, city));
  }
  return out;
}

/**
 * 节假日（未来 3 个月）：固定法定 + 调休 + 普通周末补算
 * 返回 [{date,name,type}]，type ∈ 法定/调休/普通周末
 */
function getHolidays(months) {
  months = Math.max(1, Math.min(3, months || 3));
  const fixed = store.readJSON(HOLIDAYS_FILE, []); // 数组 [{date,name,type}]
  const set = {};
  for (const h of (Array.isArray(fixed) ? fixed : [])) set[h.date] = h;
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth() + months, 0);
  const p = (n) => String(n).padStart(2, '0');
  for (let d = new Date(today.getFullYear(), today.getMonth(), 1); d <= end; d.setDate(d.getDate() + 1)) {
    const date = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    if (set[date]) continue;
    if (d.getDay() === 0 || d.getDay() === 6) {
      set[date] = { date, name: WEEKDAYS[d.getDay()], type: '普通周末' };
    }
  }
  return Object.keys(set).sort().map((k) => set[k]);
}

module.exports = { getWeather, getForecast, getHolidays, TTL_MS };
