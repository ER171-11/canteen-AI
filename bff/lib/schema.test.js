'use strict';
/*
 * lib/schema.test.js — 数据 schema 版本化 + 启动自动迁移（零依赖，node 直跑）
 *
 * 覆盖 lib/schema.js：
 *   · versionOf：缺 v 视为 0、正常读数字
 *   · migrateData：当前版本幂等无步骤；缺迁移函数时抛错（绝不静默跳版本）；注入迁移函数可逐级迁移
 *   · migrateOnBoot：无快照 / 已最新 / v3 快照启动迁移落盘 + 迁移前冷备份
 *
 * 运行：node lib/schema.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

/* 隔离数据目录：必须在 require('./schema') 之前设置，否则 lib/store.js 落到默认 bff/data */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canteen_schema_'));
process.env.BFF_DATA_DIR = TMP;

const schema = require('./schema');

let failed = 0;
function ok(name, cond, got) {
  if (cond) { console.log('  ✓ ' + name); return; }
  failed++;
  console.error('  ✗ ' + name + '  got=' + JSON.stringify(got));
}

/* ---- versionOf ---- */
ok('versionOf 缺失返回 0', schema.versionOf({}) === 0 && schema.versionOf(null) === 0, [schema.versionOf({}), schema.versionOf(null)]);
ok('versionOf 读取数字/字符串', schema.versionOf({ v: 4 }) === 4 && schema.versionOf({ v: '3' }) === 3);

/* ---- migrateData：当前版本幂等无步骤 ---- */
const cur = { v: 4, ings: [{ id: 'I1', name: '东北酸菜' }] };
const r0 = schema.migrateData(cur);
ok('v=SCHEMA_VERSION 无迁移步骤', r0.steps.length === 0 && r0.data.v === 4, r0.steps);
ok('未迁移时数据不丢字段', r0.data.ings.length === 1 && r0.data.ings[0].name === '东北酸菜', r0.data.ings);

/* ---- migrateData：缺迁移函数时抛错（绝不静默跳版本）---- */
let threw = false;
try { schema.migrateData({ v: 2 }); } catch (e) { threw = /缺少 v2/.test(e.message); }
ok('v2→v3 缺迁移函数时抛错', threw);

/* ---- migrateData：注入迁移函数验证逐级迁移 ---- */
try {
  schema.MIGRATIONS[3] = (d) => { const x = schema.deepCopy(d); x.recv = []; delete x.pos; return x; };
  schema.MIGRATIONS[4] = (d) => {
    const x = schema.deepCopy(d);
    for (const ing of (x.ings || [])) if (ing.type == null) ing.type = 'food';
    return x;
  };
  const v3 = { v: 3, pos: [{ no: 'CG1' }], ings: [{ id: 'I1' }] };
  const r = schema.migrateData(v3, 5);
  ok('v3→v5 两步迁移、v 递增', r.steps.length === 2 && r.data.v === 5, r.steps);
  ok('迁移后 recv 就位、pos 清除', Array.isArray(r.data.recv) && r.data.pos === undefined, r.data);
  ok('迁移后 ings[].type 补齐', r.data.ings[0].type === 'food', r.data.ings);
} finally {
  delete schema.MIGRATIONS[3];
  delete schema.MIGRATIONS[4];
}

/* ---- migrateOnBoot：无快照 / 已最新 / v3 落盘迁移 + 备份 ---- */
const rns = schema.migrateOnBoot();
ok('无 snapshot.json 返回 no-snapshot', rns.migrated === false && rns.reason === 'no-snapshot', rns);

fs.writeFileSync(path.join(TMP, 'snapshot.json'), JSON.stringify({ rev: 3, data: { v: 4, ings: [] }, ext: {} }));
const rup = schema.migrateOnBoot();
ok('v=SCHEMA_VERSION 返回 up-to-date（不动文件）', rup.migrated === false && rup.reason === 'up-to-date', rup);

try {
  schema.MIGRATIONS[3] = (d) => { const x = schema.deepCopy(d); x.recv = []; delete x.pos; return x; };
  fs.writeFileSync(path.join(TMP, 'snapshot.json'), JSON.stringify({ rev: 3, data: { v: 3, pos: [{ no: 'CG1' }] }, ext: { recipes: [] } }));
  const rm = schema.migrateOnBoot();
  ok('v3 快照启动迁移成功', rm.migrated === true && rm.from === 3 && rm.to === 4, rm);
  const after = JSON.parse(fs.readFileSync(path.join(TMP, 'snapshot.json'), 'utf8'));
  ok('落盘后 data.v=4、recv 就位、rev 不变', after.data.v === 4 && Array.isArray(after.data.recv) && after.rev === 3, after);
  ok('迁移前冷备份存在', !!rm.backup && fs.existsSync(rm.backup), rm.backup);
  const backups = fs.readdirSync(path.join(TMP, 'backups'));
  ok('backups 目录含 pre_migrate_v3 备份', backups.some((f) => f.includes('pre_migrate_v3')), backups);
} finally {
  delete schema.MIGRATIONS[3];
}

/* 清理临时目录 */
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }

if (failed) { console.error('\n✗ ' + failed + ' 项失败'); process.exit(1); }
console.log('\n✓ schema.test.js 全部通过');
