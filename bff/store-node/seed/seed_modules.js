'use strict';
/*
 * seed_modules.js — 店内 Python seed_modules.py 的 Node 移植。
 *
 * 熊猫五福餐厅 · 模块种子脚本（员工/食安/预订排队）（增量组件，核心零改动）
 *
 * 数据来源：../熊猫五福App原型.html 静态演示数据（人工核对提取）。
 * 所有种子行 source='demo_proto'，真实业务录入后按 source 标记整体替换。
 *
 * 幂等策略：每次执行先 DELETE WHERE source='demo_proto' 再 INSERT，
 * 重复执行结果一致（只清自己种的演示行，不动任何真实数据）。
 *
 * 写入表（001_new_tables.sql + 002_seed_align.sql 增补列，仅增不改）：
 *   staff_shifts / staff_clock / staff_perf / staff_train
 *   fs_certs / fs_trace / fs_samples / fs_disinfect
 *   bookings / queue
 *
 * 零第三方依赖：仅 Node 内置 node:sqlite / fs / path / 正则。
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const BASE_DIR = __dirname;
const STORE_DIR = path.resolve(BASE_DIR, '..', '..', '..', 'store-inventory');
const DEFAULT_DB = path.join(STORE_DIR, 'data', '餐厅系统.db');
const MIGRATION_001 = path.join(STORE_DIR, 'migrations', '001_new_tables.sql');
const MIGRATION_002 = path.join(STORE_DIR, 'migrations', '002_seed_align.sql');

const SRC = 'demo_proto';

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

const TODAY = fmtDate(new Date());

// 员工工号映射（原型只有姓名，工号为本脚本约定，真实录入后替换）
const STAFF = [
  ['ST01', '宋师傅', '厨师'],
  ['ST02', '李厨师长', '厨师长'],
  ['ST03', '王师傅', '厨师'],
  ['ST04', '张师傅', '厨师'],
  ['ST05', '赵店长', '店长'],
  ['ST06', '钱收银', '收银'],
];
const STAFF_ID = {};
const STAFF_ROLE = {};
for (const [id, name, role] of STAFF) { STAFF_ID[name] = id; STAFF_ROLE[name] = role; }
// 对应 Python dict.get()：查不到或入参 None 均返回 null
function staffId(name) {
  if (name === null || name === undefined) return null;
  return STAFF_ID[name] !== undefined ? STAFF_ID[name] : null;
}
function staffRole(name) {
  if (name === null || name === undefined) return null;
  return STAFF_ROLE[name] !== undefined ? STAFF_ROLE[name] : null;
}

// 班次代码 → 时间（任务书给定：A早9-17 / B中11-21 / C晚14-23）
const SHIFT_TIME = { A: ['09:00', '17:00'], B: ['11:00', '21:00'], C: ['14:00', '23:00'] };
const SHIFT_NAME = { A: '早班', B: '中班', C: '晚班', '休': '休息', '假': '请假' };

// 排班周：以本周一为起点（相对 TODAY），避免钉死 9.22
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Python weekday: 周一=0
  return x;
}
const WEEK_START = fmtDate(mondayOf(new Date()));
// 原型 1161-1166 行：周一至周日班次（模式保留，日期跟当前周）
const WEEK_SHIFTS = {
  '宋师傅': ['A', 'A', 'A', 'A', 'A', 'A', '休'],
  '李厨师长': ['A', 'A', 'B', 'A', 'A', 'A', '休'],
  '王师傅': ['B', 'B', 'A', 'B', 'B', '休', 'A'],
  '张师傅': ['C', 'C', 'C', 'C', '休', 'C', 'C'],
  '赵店长': ['A', 'A', 'A', 'A', 'A', 'A', '休'],
  '钱收银': ['B', 'B', 'B', 'B', '休', 'B', 'B'],
};

// 原型 1191-1195 行「打卡明细」（今日）：张师傅「待打卡」无打卡时间，不生成记录（不编造）
const CLOCK_ROWS = [
  // (姓名, 打卡时间, kind, status)
  ['宋师傅', '08:58', '上班', '准点'],
  ['李厨师长', '09:02', '上班', '准点'],
  ['王师傅', '11:12', '上班', '迟到'], // 应 11:00，原型 1193 行
  ['赵店长', '09:05', '上班', '准点'],
];

// 原型 1203-1207 行「绩效 TOP5」；工时取自 1172-1177 行工时条（h）
const PERF_ROWS = [
  // (姓名, score, 产出份数[无则 None], hours, remark[原型原文])
  ['李厨师长', 98.5, 412, 45, '出品 412 份 · 废品 1.2%'],
  ['宋师傅', 96.8, 386, 48, '出品 386 份 · 配方 100%'],
  ['赵店长', 95.2, null, 48, '服务 0 差评 · 翻台 3.4'],
  ['张师傅', 91.0, 298, 44, '出品 298 份 · 废品 2.1%'],
  ['钱收银', 90.5, null, 42, '实收 0 差错 · 储值 +¥3.8k'],
];

// 原型 1220-1223 行「培训进度」+ 948/950 行；进度写入 remark
const TRAIN_ROWS = [
  // (姓名, course, passed, remark)
  ['李厨师长', '红饺 SOP', 1, '已通过 5/5'],
  ['王师傅', '黑饺 SOP', 0, '进行中 3/5'],
  [null, '新人入职培训', 0, '2 人待考'], // 原型未署名
  [null, '食安知识考核', 1, '6/6 通过'],
];
// 健康证到期（原型 1227-1229 行）→ 同时记入 fs_certs 与 staff_train（course=健康证）
const HEALTH_CERTS = [
  ['王师傅', '2026-10-22'],
  ['张师傅', '2026-10-19'],
  ['钱收银', '2026-10-15'],
];

// 店铺证照（原型 1493-1496 行）；证号/发证日原型未给 → 留空
const SHOP_CERTS = [
  ['营业执照', '2027-12-31', '有效'],
  ['食品经营许可证', '2027-06-30', '有效'],
  ['消防安全证', '2028-03-15', '有效'],
  ['环保备案', '2026-11-30', '待续'],
];

// 溯源批次（原型 1507-1509 行）；收货日相对 TODAY，避免钉死旧日期
function dOffset(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return fmtDate(d);
}
const TRACE_ROWS = [
  ['B' + dOffset(-1).split('-').join('').slice(4), '黑猪前肩肉', '张记', dOffset(-1), '合格'],
  ['M' + dOffset(-3).split('-').join('').slice(4), '食用墨鱼汁', '海南食品', dOffset(-3), '合格'],
  ['H' + dOffset(-2).split('-').join('').slice(4), '火龙果汁', '菜篮子', dOffset(-2), '合格'],
];

// 留样：今日午餐出品（48h 到期由 kept_at +48h 推导）
const SAMPLE_ROWS = [
  ['红色·长寿饺', 125, TODAY + ' 11:30', '午餐'],
  ['黑色·三鲜饺', 130, TODAY + ' 11:35', '午餐'],
  ['御膳狮子头', 200, TODAY + ' 12:00', '午餐'],
];

// 消毒：今日晨检 + 昨晚紫外
const DISINFECT_ROWS = [
  ['餐具消毒柜', null, TODAY + ' 09:30', '已完成'],
  ['砧板刀具', null, TODAY + ' 10:00', '已完成'],
  ['操作台紫外线', '紫外', dOffset(-1) + ' 22:00', '已完成'],
  ['餐厅地面', null, TODAY + ' 14:00', '待执行'],
];

// 今日预订：对齐原型「12 桌 / 38 人」，桌号与 pos_tables T1–T8 对齐
const BOOKING_ROWS = [
  ['11:00', '刘姐', 2, '136****2201', 'T1', '已确认'],
  ['11:30', '王总', 4, '138****1234', 'T5', '已确认'],
  ['11:45', '周女士', 3, '135****8812', 'T3', '已确认'],
  ['12:00', '李姐', 3, '139****5678', 'T2', '已确认'],
  ['12:15', '孙先生', 4, '137****4410', 'T6', '已确认'],
  ['12:30', '吴女士', 2, '136****9022', 'T4', '已确认'],
  ['17:30', '郑总', 8, '138****3300', 'T7', '已确认'],
  ['18:00', '何女士', 4, '139****1108', 'T5', '已确认'],
  ['18:30', '张先生', 6, '137****9012', 'T8', '已确认'],
  ['19:00', '陈女士', 2, '136****3456', 'T1', '待确认'],
  ['19:15', '马先生', 3, '135****7788', 'T3', '已确认'],
  ['19:30', '赵先生', 3, '135****7890', 'T6', '已确认'],
];

// 当前排队（原型 1448-1452：叫号 A08）
const QUEUE_ROWS = [
  ['A05', 2, '已入座'],
  ['A06', 4, '已入座'],
  ['A07', 3, '就座中'],
  ['A08', 2, '叫号中'],
  ['A09', 4, '等位'],
];

function weekDates() {
  const [y, m, d] = WEEK_START.split('-').map(Number);
  const base = new Date(y, m - 1, d);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const cur = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    cur.setDate(cur.getDate() + i);
    out.push(fmtDate(cur));
  }
  return out;
}

// 对应 Python datetime.strptime(ts, "%Y-%m-%d %H:%M") + timedelta(hours=48)
function plus48h(ts) {
  const [datePart, timePart] = ts.split(' ');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  const dt = new Date(y, mo - 1, d, h, mi, 0);
  dt.setHours(dt.getHours() + 48);
  return fmtDate(dt) + ' ' + pad2(dt.getHours()) + ':' + pad2(dt.getMinutes());
}

/** 组装全部种子行，返回 {表名: {cols, rows}}。 */
function buildRows() {
  const dates = weekDates();
  const tables = {};

  let rows = [];
  for (const name of Object.keys(WEEK_SHIFTS)) {
    const shifts = WEEK_SHIFTS[name];
    for (let i = 0; i < dates.length; i++) {
      const code = shifts[i];
      const d = dates[i];
      const t = SHIFT_TIME[code] || [null, null];
      rows.push([STAFF_ID[name], name, d,
        (SHIFT_NAME[code] !== undefined ? SHIFT_NAME[code] : code),
        t[0], t[1], staffRole(name), SRC]);
    }
  }
  tables.staff_shifts = {
    cols: ['staff_id', 'staff_name', 'date', 'shift', 'start_time', 'end_time', 'role', 'source'],
    rows: rows,
  };

  rows = CLOCK_ROWS.map(([n, t, k, st]) => [staffId(n), TODAY + ' ' + t, k, null, st, SRC]);
  tables.staff_clock = { cols: ['staff_id', 'ts', 'kind', 'device', 'status', 'source'], rows: rows };

  rows = PERF_ROWS.map(([n, score, val, hours, remark]) =>
    [staffId(n), '', '综合绩效', val, score, remark, hours, SRC]);
  tables.staff_perf = {
    cols: ['staff_id', 'period', 'metric', 'value', 'score', 'remark', 'hours', 'source'],
    rows: rows,
  };

  rows = TRAIN_ROWS.map(([n, c, p, r]) => [staffId(n), c, p, TODAY, r, SRC]);
  rows = rows.concat(HEALTH_CERTS.map(([n, exp]) =>
    [staffId(n), '健康证', 0, TODAY, '健康证 ' + exp + ' 到期', SRC]));
  tables.staff_train = { cols: ['staff_id', 'course', 'passed', 'ts', 'remark', 'source'], rows: rows };

  rows = HEALTH_CERTS.map(([n, exp]) => ['健康证', n, null, null, exp, '预警', SRC]);
  rows = rows.concat(SHOP_CERTS.map(([t, exp, st]) => [t, '熊猫五福餐厅', null, null, exp, st, SRC]));
  tables.fs_certs = {
    cols: ['cert_type', 'holder', 'cert_no', 'issued_at', 'expire_at', 'status', 'source'],
    rows: rows,
  };

  rows = TRACE_ROWS.map(([b, ing, sup, rd, cr]) => [b, ing, sup, rd, null, null, cr, SRC]);
  tables.fs_trace = {
    cols: ['batch_no', 'ing_name', 'supplier', 'recv_date', 'origin', 'cert_no', 'check_result', 'source'],
    rows: rows,
  };

  rows = SAMPLE_ROWS.map(([dish, w, kept, meal]) =>
    [TODAY, meal, dish, w, null, kept, plus48h(kept), SRC]);
  tables.fs_samples = {
    cols: ['date', 'meal', 'dish', 'weight_g', 'keeper', 'kept_at', 'cleared_at', 'source'],
    rows: rows,
  };

  rows = DISINFECT_ROWS.map(([area, m, ts, res]) => [TODAY, area, m, null, ts, res, SRC]);
  tables.fs_disinfect = {
    cols: ['date', 'area', 'method', 'operator', 'ts', 'result', 'source'],
    rows: rows,
  };

  rows = BOOKING_ROWS.map(([t, n, ps, p, tbl, st]) => [n, p, TODAY, t, ps, tbl, st, null, SRC]);
  tables.bookings = {
    cols: ['guest_name', 'phone', 'date', 'time', 'party_size', 'table_id', 'status', 'note', 'source'],
    rows: rows,
  };

  rows = QUEUE_ROWS.map(([no, ps, st]) => [no, TODAY, ps, st, null, SRC]);
  tables.queue = { cols: ['queue_no', 'date', 'party_size', 'status', 'ts', 'source'], rows: rows };

  return tables;
}

/** 001 全量 IF NOT EXISTS；002 的 ADD COLUMN 逐条做 PRAGMA 检查后执行（幂等）。 */
function ensureSchema(dbPath) {
  const conn = new DatabaseSync(dbPath);
  try {
    conn.exec(fs.readFileSync(MIGRATION_001, 'utf8'));
    const sql = fs.readFileSync(MIGRATION_002, 'utf8');
    const re = /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)([^;]*);/gi;
    let m;
    while ((m = re.exec(sql)) !== null) {
      const table = m[1];
      const col = m[2];
      const decl = m[3];
      const cols = conn.prepare('PRAGMA table_info(' + table + ')').all().map((r) => r.name);
      if (!cols.includes(col)) {
        conn.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col + decl);
        log.info('补列: ' + table + '.' + col);
      }
    }
  } finally {
    conn.close();
  }
}

function timestamp() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
const log = {
  info: (msg) => console.error(timestamp() + ' [INFO] seed_modules: ' + msg),
  warning: (msg) => console.error(timestamp() + ' [WARNING] seed_modules: ' + msg),
};

function seed(dbPath, tables, dryRun) {
  console.log('== 模块种子摘要（source=' + SRC + '）==');
  for (const t of Object.keys(tables)) {
    console.log('  ' + t.padEnd(14, ' ') + ' ' + tables[t].rows.length + ' 行');
  }
  if (dryRun) {
    console.log('--dry-run：不落库');
    return;
  }
  ensureSchema(dbPath);
  const conn = new DatabaseSync(dbPath);
  try {
    conn.exec('BEGIN');
    for (const t of Object.keys(tables)) {
      const { cols, rows } = tables[t];
      conn.prepare('DELETE FROM ' + t + ' WHERE source=?').run(SRC);
      const ph = cols.map(() => '?').join(',');
      const st = conn.prepare('INSERT INTO ' + t + ' (' + cols.join(',') + ') VALUES (' + ph + ')');
      for (const r of rows) st.run(...r);
    }
    conn.exec('COMMIT');
    for (const t of Object.keys(tables)) {
      const n = conn.prepare('SELECT COUNT(*) AS c FROM ' + t + ' WHERE source=?').get(SRC).c;
      log.info(t + ': demo_proto ' + n + ' 行');
    }
    console.log('落库完成（db=' + dbPath + '）');
  } catch (e) {
    try { conn.exec('ROLLBACK'); } catch (ignored) { /* ignore */ }
    throw e;
  } finally {
    conn.close();
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq >= 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[k] = next; i++; }
      else out[k] = true;
    }
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv || process.argv.slice(2));
  const dbPath = args.db || DEFAULT_DB;
  const dryRun = !!args['dry-run'];

  const tables = buildRows();
  seed(dbPath, tables, dryRun);
  if (!dryRun) {
    try {
      const sfe = require('./seed_finance_extra');
      sfe.main();
    } catch (exc) {
      log.warning('seed_finance_extra 跳过: ' + (exc && exc.message));
    }
  }
  return 0;
}

module.exports = {
  SRC, TODAY, WEEK_START, STAFF, STAFF_ID, STAFF_ROLE, SHIFT_TIME, SHIFT_NAME,
  WEEK_SHIFTS, CLOCK_ROWS, PERF_ROWS, TRAIN_ROWS, HEALTH_CERTS, SHOP_CERTS,
  TRACE_ROWS, SAMPLE_ROWS, DISINFECT_ROWS, BOOKING_ROWS, QUEUE_ROWS,
  weekDates, plus48h, buildRows, ensureSchema, seed, main, DEFAULT_DB, MIGRATION_001, MIGRATION_002,
};

/* 演示种子注入已停用（ADR-001 真实数据基线）；确需演示请显式设置 CANTEEN_SEED_DEMO=1 */
if (require.main === module && process.env.CANTEEN_SEED_DEMO !== '1') {
  console.error('[停用] 演示种子注入已停用（ADR-001 真实数据基线）。如确需演示，请设置 CANTEEN_SEED_DEMO=1 后重试。');
  process.exit(1);
}

if (require.main === module) {
  process.exit(main());
}
