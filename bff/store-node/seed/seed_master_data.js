'use strict';
/*
 * seed_master_data.js — 店内 Python seed_master_data.py 的 Node 移植。
 *
 * 灌齐主数据：销售流水 / 会员 / 外卖 / 桌台 / 口碑 → sqlite + 店内 JSON data.sales/pos
 *
 * 逐行对照 store-inventory/seed_master_data.py：
 *   - seedSqlite()     写 pos_tables / vip_members / vip_balance / takeout_orders /
 *                      takeout_reconcile / rv_reviews；
 *   - seedStoreJson()  GET /api/db → 组装 pos / sales / platforms → POST /api/sync。
 *
 * 零第三方依赖：仅 Node 内置 node:sqlite / fs / path 与 common.httpJson。
 * 保持 Python 原样的「非完全幂等」语义：takeout_orders 先 DELETE 再种；
 *   rv_reviews / takeout_reconcile 为追加式（重复执行会继续追加），与原脚本一致。
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { httpJson, nowIso } = require('../common');

const BASE = __dirname;
const STORE_DIR = path.resolve(BASE, '..', '..', '..', 'store-inventory');
const DEFAULT_DB = path.join(STORE_DIR, 'data', '餐厅系统.db');
const STORE_URL = process.env.STORE_URL || 'http://127.0.0.1:8765';

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 对应 Python today(offset)：本地日期 %Y-%m-%d
function today(offset) {
  const d = new Date();
  d.setDate(d.getDate() + (offset || 0));
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 对应 Python round()：正数四舍六入五成双（banker's rounding）
function pyRound(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

// ---------- sqlite 路径 ----------
function seedSqlite(dbPath) {
  const conn = new DatabaseSync(dbPath);
  try {
    conn.exec('BEGIN');

    // 桌台：午峰约 5/8 占用（对齐原型首页）
    const tables = [
      ['T1', '1号桌', 4, '就餐'],
      ['T2', '2号桌', 4, '就餐'],
      ['T3', '3号桌', 6, '就餐'],
      ['T4', '4号桌', 4, '待清'],
      ['T5', '5号桌', 8, '预订'],
      ['T6', '6号桌', 4, '就餐'],
      ['T7', '包厢A', 10, '空闲'],
      ['T8', '包厢B', 12, '空闲'],
    ];
    const insTable = conn.prepare(
      'INSERT OR REPLACE INTO pos_tables (table_id, name, capacity, status) VALUES (?,?,?,?)'
    );
    for (const [tid, name, cap, st] of tables) insTable.run(tid, name, cap, st);

    // 会员
    const members = [
      ['M1001', '王女士', '13800001111', '金卡', today(-120)],
      ['M1002', '李先生', '13800002222', '银卡', today(-60)],
      ['M1003', '赵小姐', '13800003333', '普通', today(-10)],
    ];
    const insMember = conn.prepare(
      'INSERT OR REPLACE INTO vip_members (member_id, name, phone, level, joined_at, status) VALUES (?,?,?,?,?,?)'
    );
    const insBalance = conn.prepare(
      'INSERT OR REPLACE INTO vip_balance (member_id, balance, updated_at) VALUES (?,?,?)'
    );
    for (const [mid, name, phone, level, joined] of members) {
      insMember.run(mid, name, phone, level, joined, '正常');
      insBalance.run(mid, level === '金卡' ? 200 : 80, nowIso());
    }

    // 外卖：清掉旧演示单后重种（今日午晚高峰若干单）
    conn.exec('DELETE FROM takeout_orders');
    const takeout = [
      ['美团', '美1001', 88, 10, 78, '配送中'],
      ['美团', '美1002', 64, 8, 56, '已完成'],
      ['饿了么', '饿2001', 72, 9, 63, '已完成'],
      ['美团', '美1003', 96, 12, 84, '制作中'],
      ['饿了么', '饿2002', 58, 7, 51, '已完成'],
      ['美团', '美1004', 120, 14, 106, '待接单'],
    ];
    const insTakeout = conn.prepare(
      'INSERT INTO takeout_orders (platform, platform_no, ts, amount, commission, settle, status)'
      + ' VALUES (?,?,?,?,?,?,?)'
    );
    for (const [plat, no, amt, comm, settle, st] of takeout) {
      insTakeout.run(plat, no, nowIso(), amt, comm, settle, st);
    }
    conn.prepare(
      'INSERT INTO takeout_reconcile (platform, period, expect_amt, actual_amt, diff, status) VALUES (?,?,?,?,?,?)'
    ).run('美团', today().slice(0, 7), 1200, 1180, -20, '待核对');

    // 口碑
    const reviews = [
      ['堂食', 5.0, '饺子很好吃，五福饺子推荐', 0],
      ['美团', 2.0, '等太久了，汤洒了', 0],
      ['大众点评', 4.5, '环境干净，服务不错', 1],
    ];
    const insReview = conn.prepare(
      'INSERT INTO rv_reviews (source, rating, content, ts, handled) VALUES (?,?,?,?,?)'
    );
    for (const [src, rating, content, handled] of reviews) {
      insReview.run(src, rating, content, nowIso(), handled);
    }

    conn.exec('COMMIT');
    console.log('sqlite seeded: pos_tables/vip/takeout/reviews');
  } catch (e) {
    try { conn.exec('ROLLBACK'); } catch (ignored) { /* ignore */ }
    throw e;
  } finally {
    conn.close();
  }
}

// ---------- 店内 JSON 路径（HTTP /api/sync） ----------
async function seedStoreJson(storeUrl) {
  const root = storeUrl.replace(/\/+$/, '');
  const got = await httpJson('GET', root + '/api/db');
  const doc = got.body;
  if (got.status !== 200 || !doc || !doc.ok) {
    throw new Error('store /api/db failed: ' + got.status + ' ' + JSON.stringify(doc));
  }
  const baseRev = doc.rev;
  const rawData = doc.data;
  const data = (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) ? rawData : {};

  data.pos = [
    { id: 'T1', no: '1', state: 'busy', seats: 4, name: '1号桌', zone: '大厅' },
    { id: 'T2', no: '2', state: 'busy', seats: 4, name: '2号桌', zone: '大厅' },
    { id: 'T3', no: '3', state: 'busy', seats: 6, name: '3号桌', zone: '大厅' },
    { id: 'T4', no: '4', state: 'clean', seats: 4, name: '4号桌', zone: '大厅' },
    { id: 'T5', no: '5', state: 'rsv', seats: 8, name: '5号桌', zone: '大厅' },
    { id: 'T6', no: '6', state: 'busy', seats: 4, name: '6号桌', zone: '大厅' },
    { id: 'T7', no: 'A', state: 'free', seats: 10, name: '包厢A', zone: '包间' },
    { id: 'T8', no: 'B', state: 'free', seats: 12, name: '包厢B', zone: '包间' },
  ];

  // 近 14 天销售：五色饺品名对齐原型日销量级（长寿≈78 / 三鲜≈62 / 富贵≈45 / 玉米≈51 / 好德≈41）
  // 单价取堂食常见价；外卖约占 18–22%
  const dishes = [
    ['长寿饺', 32],
    ['三鲜饺', 36],
    ['富贵饺', 30],
    ['玉米饺', 30],
    ['好德饺', 30],
  ];
  // 今日目标份数（再按小时拆）
  const dayTargets = {
    '长寿饺': 78,
    '三鲜饺': 62,
    '富贵饺': 45,
    '玉米饺': 51,
    '好德饺': 41,
  };
  const hourShare = { 11: 0.18, 12: 0.28, 13: 0.14, 17: 0.12, 18: 0.18, 19: 0.10 };
  const colorMap = { '长寿饺': '红', '三鲜饺': '黑', '富贵饺': '黄', '玉米饺': '绿', '好德饺': '紫' };
  const sales = [];
  for (let d = 13; d >= 0; d--) {
    const day = today(-d);
    // 周末略高、工作日略低（Python weekday：周一=0 … 周日=6）
    const [yy, mm, dd] = day.split('-').map(Number);
    const wd = (new Date(yy, mm - 1, dd).getDay() + 6) % 7;
    const factor = wd >= 5 ? 1.12 : ((wd === 0 || wd === 1) ? 0.92 : 1.0);
    for (const [name, price] of dishes) {
      const base = dayTargets[name];
      // 历史日在目标附近抖动
      const jitter = 1 + (((d * 3 + name.length) % 9) - 4) * 0.03;
      const dayQty = Math.max(8, pyRound(base * factor * jitter));
      let remain = dayQty;
      const hours = Object.keys(hourShare).map(Number);
      for (let idx = 0; idx < hours.length; idx++) {
        const h = hours[idx];
        let qty;
        if (idx === hours.length - 1) {
          qty = remain;
        } else {
          qty = Math.max(1, pyRound(dayQty * hourShare[h]));
          remain -= qty;
        }
        if (qty <= 0) continue;
        // 午晚高峰一部分记外卖
        let channel = '堂食';
        if ((h === 12 || h === 18) && (d + h + name.length) % 5 === 0) {
          channel = h === 12 ? '美团' : '饿了么';
        }
        sales.push({
          id: 'S' + day.split('-').join('') + h + name.slice(0, 1),
          date: day,
          hour: h,
          dish: name,
          qty: qty,
          amount: qty * price,
          channel: channel,
          color: colorMap[name],
        });
      }
    }
  }
  data.sales = sales;

  // platforms 摘要（约等于近两周外卖合计量级）
  data.platforms = [
    { name: '美团', orders: 48, amount: 3120, rating: 4.6 },
    { name: '饿了么', orders: 31, amount: 2050, rating: 4.4 },
  ];

  const synced = await httpJson('POST', root + '/api/sync', { baseRev: baseRev, data: data, machine: 'SEED' });
  const resp = synced.body;
  const ok = synced.status === 200 && resp && resp.ok && resp.action !== 'need-manual';
  if (!ok) {
    const clean = {};
    for (const k of Object.keys(resp || {})) if (k !== 'data') clean[k] = resp[k];
    throw new Error('sync failed: ' + synced.status + ' ' + JSON.stringify(clean));
  }
  console.log('store json seeded: pos=' + data.pos.length + ' sales=' + sales.length + ' rev=' + resp.rev);
  return resp.rev;
}

// ---------- CLI ----------
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

async function main(argv) {
  const args = parseArgs(argv || process.argv.slice(2));
  const db = args.db || DEFAULT_DB;
  const storeUrl = args['store-url'] || STORE_URL;
  seedSqlite(db);
  if (!args['skip-store']) await seedStoreJson(storeUrl);
}

module.exports = { today, pyRound, seedSqlite, seedStoreJson, DEFAULT_DB, STORE_URL, main };

/* 演示种子注入已停用（ADR-001 真实数据基线）；确需演示请显式设置 CANTEEN_SEED_DEMO=1 */
if (require.main === module && process.env.CANTEEN_SEED_DEMO !== '1') {
  console.error('[停用] 演示种子注入已停用（ADR-001 真实数据基线）。如确需演示，请设置 CANTEEN_SEED_DEMO=1 后重试。');
  process.exit(1);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
