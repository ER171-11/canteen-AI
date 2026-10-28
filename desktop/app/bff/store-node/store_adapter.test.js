'use strict';
/*
 * store-node/store_adapter.test.js — sqlite ctx.store 适配器回归
 *
 * 守的两件事（W3 供应商编辑被驳回的根因之一）：
 *   ① get(table,id) 主键探测：sup_vendors 表没有 id 列（主键 vendor_id），
 *      写死 `WHERE id=?` 会查询异常 → null → 算法层误判「档案不存在」；
 *   ② upsert(table,row,['vendor_id']) 命中即 UPDATE：主键列必须显式传 keys，
 *      缺省 ['id'] 会走 INSERT 撞主键，整行更新丢失。
 *
 * 运行：node store-node/store_adapter.test.js
 */
const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');
const { makeSqliteStore } = require('./consumer');

let failed = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '  ' + (e && e.message ? e.message : e)); }
}

/** 内存库 + sup_vendors 表（与 store-inventory/migrations 的列一致） */
function mkDb() {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canteen-store-'));
  const dbPath = path.join(dir, 'probe.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE sup_vendors (vendor_id TEXT PRIMARY KEY, name TEXT, contact TEXT, phone TEXT,'
    + ' category TEXT, level TEXT, status TEXT DEFAULT \'合作中\', rev INTEGER, period TEXT, note TEXT,'
    + ' updated_at TEXT, certs TEXT)');
  db.exec('CREATE TABLE loss_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT)');
  db.close();
  return { dbPath, dir };
}

const { dbPath, dir } = mkDb();
const store = makeSqliteStore(dbPath);

ok('get(table,id)：sup_vendors 无 id 列 → 按 vendor_id 命中', () => {
  store.upsert('sup_vendors', { vendor_id: 'V673E3D26', name: '金丰冷链配送', phone: '13800001111' }, ['vendor_id']);
  const row = store.get('sup_vendors', 'V673E3D26');
  assert.ok(row, 'get 必须按 vendor_id 找到行');
  assert.strictEqual(row.name, '金丰冷链配送');
});

ok('get(table,id)：有 id 列的表仍按 id 查（不回退）', () => {
  store.insert('loss_reports', { status: '待审核' });
  const row = store.get('loss_reports', 1);
  assert.ok(row, 'loss_reports 应按 id=1 命中');
  assert.strictEqual(row.status, '待审核');
});

ok('upsert(sup_vendors, row, ["vendor_id"]) 命中即 UPDATE，不插重复行', () => {
  const r = store.upsert('sup_vendors', { vendor_id: 'V673E3D26', phone: '13900009999' }, ['vendor_id']);
  assert.strictEqual(r.matched, true, '应命中既有行');
  const rows = store.query('SELECT * FROM sup_vendors');
  assert.strictEqual(rows.length, 1, '不得插入重复行');
  assert.strictEqual(rows[0].phone, '13900009999');
});

ok('upsert 缺省 keys（["id"]）对无 id 表 = 主键冲突 → 行不变（说明必须显式传 keys）', () => {
  const r = store.upsert('sup_vendors', { vendor_id: 'V673E3D26', phone: '13711112222' });
  assert.strictEqual(r.matched, false);
  const rows = store.query('SELECT * FROM sup_vendors');
  assert.strictEqual(rows.length, 1, '不得出现第二条档案');
  assert.strictEqual(rows[0].phone, '13900009999', '缺省 keys 时更新丢失（回归前提，非期望行为）');
});

store.close();
try { require('fs').rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

if (failed) { console.error('\n✗ ' + failed + ' 项失败'); process.exit(1); }
console.log('\nPASS store_adapter.test.js 全部通过');
