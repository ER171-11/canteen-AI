'use strict';
/*
 * seed_finance_extra.js — 店内 Python seed_finance_extra.py 的 Node 移植。
 *
 * 补齐财务/能耗等空表，避免管理端空白。
 * 幂等策略：与 Python 原实现一致，逐表 COUNT(*)==0 才插入（表非空则跳过）。
 *
 * 零第三方依赖：仅 Node 内置 node:sqlite / path。
 * 说明：Python 原脚本把 DB 路径写死为模块级常量、无 CLI 参数；为便于测试，
 *   这里额外接受可选 --db / main(dbPath)，默认值与原脚本一致。
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { nowIso } = require('../common');

const BASE = __dirname;
const STORE_DIR = path.resolve(BASE, '..', '..', '..', 'store-inventory');
const DB = path.join(STORE_DIR, 'data', '餐厅系统.db');

function pad2(n) { return String(n).padStart(2, '0'); }

// 对应 Python now()：本地 ISO 秒级
function now() { return nowIso(); }

// 对应 Python today(off)
function today(off) {
  const d = new Date();
  d.setDate(d.getDate() + (off || 0));
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 任意 Date → 本地 ISO 秒级（对齐 datetime.isoformat(timespec="seconds")）
function isoSeconds(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function main(dbPath) {
  const target = dbPath || DB;
  const conn = new DatabaseSync(target);
  const count = (t) => conn.prepare('SELECT COUNT(*) AS c FROM ' + t).get().c;
  try {
    conn.exec('BEGIN');

    // 发票
    if (count('fin_invoices') === 0) {
      const st = conn.prepare(
        'INSERT INTO fin_invoices (invoice_no, kind, direction, amount, tax, ts, status) VALUES (?,?,?,?,?,?,?)'
      );
      const rows = [
        ['FP202609001', '电子普票', '销项', 1280, 72.45, now(), '已开具'],
        ['FP202609002', '专票', '进项', 860, 111.4, now(), '已认证'],
        ['FP202609003', '电子普票', '销项', 560, 31.7, now(), '已开具'],
      ];
      for (const r of rows) st.run(...r);
      console.log('fin_invoices seeded');
    }

    // 税务
    if (count('fin_tax') === 0) {
      const period = today().slice(0, 7);
      const st = conn.prepare(
        'INSERT INTO fin_tax (period, kind, amount, filed_at, status) VALUES (?,?,?,?,?)'
      );
      const rows = [
        [period, '增值税', 3200, null, '待申报'],
        [period, '所得税', 1500, null, '待申报'],
        [period, '附加税', 280, today(-5), '已申报'],
      ];
      for (const r of rows) st.run(...r);
      console.log('fin_tax seeded');
    }

    // 现金
    if (count('fin_cash') === 0) {
      const st = conn.prepare(
        'INSERT INTO fin_cash (ts, kind, amount, account, note) VALUES (?,?,?,?,?)'
      );
      const rows = [
        [now(), '收入', 2300, '收银备用金', '午市'],
        [now(), '支出', 500, '收银备用金', '找零补充'],
        [now(), '存款', 1800, '对公账户', '日结存入'],
      ];
      for (const r of rows) st.run(...r);
      console.log('fin_cash seeded');
    }

    // 能耗
    if (count('eq_energy') === 0) {
      const st = conn.prepare(
        'INSERT INTO eq_energy (date, device, kind, reading, usage) VALUES (?,?,?,?,?)'
      );
      const rows = [
        [today(), '冷藏柜-1', '电', 12080, 42],
        [today(), '煮饺炉', '气', 880, 12],
        [today(-1), '冷藏柜-1', '电', 12038, 40],
      ];
      for (const r of rows) st.run(...r);
      console.log('eq_energy seeded');
    }

    // 冷柜温度时序（真 IoT 推送路径；超温点便于预警验收）
    try {
      if (count('eq_temp') === 0) {
        const base = new Date();
        const st = conn.prepare('INSERT INTO eq_temp (ts, device, temp) VALUES (?,?,?)');
        for (let i = 0; i < 9; i++) {
          const ts = isoSeconds(new Date(base.getTime() - (8 - i) * 3 * 60000));
          st.run(ts, '冷柜 A', 4.0 + i * 0.03);
          st.run(ts, '冷柜 B', 4.5 + i * 0.35); // 末段超温
          st.run(ts, '冷柜 C', 3.6 + (i % 3) * 0.1);
        }
        console.log('eq_temp seeded');
      }
    } catch (e) {
      console.log('eq_temp skip: ' + (e && e.message));
    }

    // 证照若缺健康证相关已有；确保 loss 有样例
    if (count('loss_reports') === 0) {
      conn.prepare(
        'INSERT INTO loss_reports (date, ing_name, qty, reason, reporter, status) VALUES (?,?,?,?,?,?)'
      ).run(today(), '面粉', 2, '受潮', 'admin', '待审核');
      console.log('loss_reports seeded');
    }

    conn.exec('COMMIT');
    console.log('done ' + target);
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

module.exports = { now, today, isoSeconds, main, DB };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  main(args.db);
}
