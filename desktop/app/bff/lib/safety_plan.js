'use strict';
/*
 * lib/safety_plan.js — 食安拍照上报：点位清单 + 核验记录聚合（纯函数，无 IO）
 *
 * 数据落点（见 docs/safety-schema.md）：
 *   data.safety.points[]   点位主数据（应检清单）
 *   data.safety.checks[]   核验记录（员工上报 → AI 初判 → 人工复核）
 *
 * 为什么是纯函数：
 *   与 lib/safety_points.js（ext.fs_points，巡检/消毒点位）同一约定——「内置种子 + 空态兜底」
 *   由纯函数给出，默认点位**不预置写库**，避免迁移脚本与审批初始化的复杂度；
 *   只读端点只调 loadSnapshot() 后走本模块计算，天然满足「不写库、不入队、不改快照」。
 *
 * 种子点位（任务 11）：8 个，覆盖冷藏 / 清洗 / 备餐 / 垃圾区（占位样图 URL，不含真实照片）。
 *   新环境初始化后（data.safety.points 为空）进度页仍能看到点位列表。
 *
 * 红线：
 *   - 图片只存 photo_url 引用，本模块不接触图片字节/base64；
 *   - AI 初判不得覆盖人工复核：effective_result 一律「人工 final_result 优先」。
 */

/** 内置种子点位（8 个；enabled=0 为逻辑删除，保留历史 checks 引用） */
const DEFAULT_POINTS = [
  {
    id: 'SC-01',
    name: '冷藏柜 A 内部',
    zone: '冷藏',
    target: '柜内食材分区离地存放、生熟分开、无裸露无残渣，柜显温度 0-4℃，无异味',
    demo_image_url: 'https://example.com/safety/demo/SC-01.jpg',
    enabled: 1,
    sort: 10,
    note: '0-4℃ 冷藏区'
  },
  {
    id: 'SC-02',
    name: '冷冻柜 B 内部',
    zone: '冷藏',
    target: '冷冻食材密封分装、无反复解冻迹象、无结霜过厚，柜显温度 ≤ -18℃',
    demo_image_url: 'https://example.com/safety/demo/SC-02.jpg',
    enabled: 1,
    sort: 20,
    note: '≤ -18℃ 冷冻区'
  },
  {
    id: 'SC-03',
    name: '洗消池（三步池）',
    zone: '清洗',
    target: '一刮二洗三消毒三池齐备、池水洁净无残渣、消毒液配比标签在有效期内',
    demo_image_url: 'https://example.com/safety/demo/SC-03.jpg',
    enabled: 1,
    sort: 30,
    note: null
  },
  {
    id: 'SC-04',
    name: '洗碗机出料口',
    zone: '清洗',
    target: '餐具无水渍无油膜、出料口洁净、已完成消毒并分区存放于保洁柜',
    demo_image_url: 'https://example.com/safety/demo/SC-04.jpg',
    enabled: 1,
    sort: 40,
    note: null
  },
  {
    id: 'SC-05',
    name: '备餐台（拌馅/凉菜区）',
    zone: '备餐',
    target: '台面洁净无积水、砧板刀具按红蓝绿分色使用、半成品加盖覆膜离地存放',
    demo_image_url: 'https://example.com/safety/demo/SC-05.jpg',
    enabled: 1,
    sort: 50,
    note: '凉菜/拌馅专间'
  },
  {
    id: 'SC-06',
    name: '熟制出餐台',
    zone: '备餐',
    target: '出餐台面洁净、成品覆膜保温、留样盒齐备并标注时间、无生熟交叉',
    demo_image_url: 'https://example.com/safety/demo/SC-06.jpg',
    enabled: 1,
    sort: 60,
    note: null
  },
  {
    id: 'SC-07',
    name: '后厨垃圾桶位',
    zone: '垃圾区',
    target: '垃圾桶带盖且随手密闭、袋口不外溢、地面无渗滤液、周边无虫鼠痕迹',
    demo_image_url: 'https://example.com/safety/demo/SC-07.jpg',
    enabled: 1,
    sort: 70,
    note: null
  },
  {
    id: 'SC-08',
    name: '前厅收残台',
    zone: '前厅',
    target: '收残台洁净、餐具按类别归位、台面无残渣积水、垃圾及时清运',
    demo_image_url: 'https://example.com/safety/demo/SC-08.jpg',
    enabled: 1,
    sort: 80,
    note: null
  }
];

const AI_RESULTS = ['pending', 'pass', 'fail', 'error'];
const CHECK_STATUS = ['pending', 'ai_done', 'reviewed', 'error'];

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

function numSort(v) {
  const n = parseInt(v, 10);
  return isFinite(n) ? n : 0;
}

function isEnabled(row) {
  return String(row && row.enabled) !== '0';
}

function normDay(v) {
  const s = str(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return new Date().toISOString().slice(0, 10);
}

/** 把任意来源的行归一为点位结构（缺字段补默认） */
function toPoint(src) {
  const s = src || {};
  return {
    id: str(s.id),
    name: str(s.name),
    zone: str(s.zone),
    target: str(s.target),
    demo_image_url: s.demo_image_url === undefined || s.demo_image_url === null ? null : String(s.demo_image_url),
    enabled: isEnabled(s) ? 1 : 0,
    sort: numSort(s.sort),
    note: s.note === undefined || s.note === null ? null : String(s.note)
  };
}

function safetyOf(data) {
  const s = data && typeof data === 'object' ? data.safety : null;
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

/**
 * 解析点位清单：
 *   优先 data.safety.points 中 enabled≠0 的行（按 sort 升序）；
 *   该清单为空 → 回退内置种子 DEFAULT_POINTS（新环境/空态可用）。
 */
function pointsOf(data) {
  const rows = arr(safetyOf(data).points).filter((p) => p && isEnabled(p)).map(toPoint);
  if (!rows.length) return DEFAULT_POINTS.map(toPoint);
  return rows.sort((a, b) => a.sort - b.sort);
}

/** 是否仍在用内置种子点位（前端提示「当前为内置默认点位」） */
function usingDefaultPoints(data) {
  return arr(safetyOf(data).points).filter((p) => p && isEnabled(p)).length === 0;
}

/** 按 id 找点位（含内置种子兜底）；不存在返回 null */
function findPoint(data, id) {
  const s = str(id);
  if (!s) return null;
  const hit = pointsOf(data).find((p) => p.id === s);
  if (hit) return hit;
  return DEFAULT_POINTS.map(toPoint).find((p) => p.id === s) || null;
}

/** 核验记录中 `created_at` 落在某天的记录（UTC 日期口径，与 foodsafe.todayStr 一致） */
function checksOf(data, date) {
  const day = normDay(date);
  return arr(safetyOf(data).checks).filter((c) => {
    const d = str(c && c.created_at).slice(0, 10);
    // created_at 缺失/非法时归入「非当日」，避免把脏数据算进今日进度
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && d === day;
  });
}

/** 派生：该记录最终算过没过（人工优先；AI 初判不得覆盖人工） */
function effectiveResult(check) {
  if (!check || typeof check !== 'object') return null;
  const f = str(check.final_result);
  if (f === 'pass' || f === 'fail') return f;
  const a = str(check.ai_result);
  if (a === 'pass' || a === 'fail') return a;
  return null;
}

function isReviewed(check) {
  const f = str(check && check.final_result);
  return f === 'pass' || f === 'fail';
}

/** 单点展示态：none | pending | pass | fail | review | error */
function pointStatus(check) {
  if (!check) return 'none';
  if (isReviewed(check)) return effectiveResult(check) || 'none';
  const a = str(check.ai_result);
  if (a === 'error') return 'error';
  if (a === 'fail') return 'review'; // AI 判不过 → 必须人工复核
  if (a === 'pass') return 'pass';
  return 'pending';
}

/** 取某点位当日最新一条记录（created_at 最大；同刻取数组末位 = 最新写入） */
function latestCheckOf(checks, pointId) {
  let hit = null;
  for (const c of arr(checks)) {
    if (!c || str(c.point_id) !== str(pointId)) continue;
    if (!hit || String(c.created_at || '') >= String(hit.created_at || '')) hit = c;
  }
  return hit;
}

/**
 * 今日食安进度（只读聚合，供 GET /api/safety/progress）。
 * 口径见 docs/safety-schema.md §3：
 *   pass/fail 以 effective_result 计；review_count = 未复核且 AI 判 fail；
 *   error_count = 未复核且 AI 判 error。
 */
function progressReport(data, date) {
  const day = normDay(date);
  const points = pointsOf(data);
  const checks = checksOf(data, day);

  let pass = 0;
  let fail = 0;
  let review = 0;
  let error = 0;
  for (const c of checks) {
    const eff = effectiveResult(c);
    if (eff === 'pass') pass += 1;
    else if (eff === 'fail') fail += 1;
    if (isReviewed(c)) continue;
    if (str(c.ai_result) === 'fail') review += 1;
    else if (str(c.ai_result) === 'error') error += 1;
  }

  const seen = new Set();
  const rows = points.map((p) => {
    const c = latestCheckOf(checks, p.id);
    if (c) seen.add(p.id);
    return {
      point_id: p.id,
      name: p.name,
      zone: p.zone,
      target: p.target,
      demo_image_url: p.demo_image_url,
      status: pointStatus(c),
      check_id: c ? str(c.id) : null,
      operator: c ? str(c.operator) || null : null,
      photo_url: c && c.photo_url !== undefined ? c.photo_url : null,
      ai_result: c ? str(c.ai_result) || 'pending' : null,
      ai_reason: c && c.ai_reason !== undefined ? c.ai_reason : null,
      ai_confidence: c && c.ai_confidence !== undefined ? c.ai_confidence : null,
      final_result: c && c.final_result !== undefined ? c.final_result : null,
      review_reason: c && c.review_reason !== undefined ? c.review_reason : null,
      reviewed_by: c && c.reviewed_by !== undefined ? c.reviewed_by : null,
      created_at: c && c.created_at !== undefined ? c.created_at : null,
      effective_result: c ? effectiveResult(c) : null
    };
  });

  return {
    date: day,
    total_points: points.length,
    completed_points: seen.size,
    pass_count: pass,
    fail_count: fail,
    review_count: review,
    error_count: error,
    using_defaults: usingDefaultPoints(data),
    points: rows
  };
}

module.exports = {
  DEFAULT_POINTS,
  AI_RESULTS,
  CHECK_STATUS,
  normDay,
  toPoint,
  pointsOf,
  usingDefaultPoints,
  findPoint,
  checksOf,
  effectiveResult,
  isReviewed,
  pointStatus,
  latestCheckOf,
  progressReport
};
