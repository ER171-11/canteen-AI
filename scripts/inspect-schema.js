#!/usr/bin/env node
'use strict';
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('store-inventory/data/餐厅系统_演练.db', { readOnly: true });

const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('=== 所有表 ===');
for (const t of tables) console.log(t.name);

console.log('\n=== 含 certs / qc / vendor / ing 相关列的表 ===');
for (const t of tables) {
  const cols = db.prepare('PRAGMA table_info("' + t.name + '")').all();
  const hit = cols.filter((c) => /certs|qc_|vendor|ing|snapshot|data|payload|json/.test(c.name));
  if (hit.length) {
    console.log('\n[' + t.name + '] 列:', cols.map((c) => c.name).join(', '));
  }
}
db.close();
