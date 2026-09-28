'use strict';
/*
 * scripts/clean-demo-data.js — 清理真实门店库中的非正式/测试数据（保守规则）
 *
 * 用法：node scripts/clean-demo-data.js [--db PATH] [--dry]
 *  1) 删除明显测试行（测试菜谱、E2E 券、测试客、smoke 记录、联调审计、E2E 动作）
 *  2) 归一化来源标记：demo_proto → init；操作人 e2e → 店长/后厨
 *  3) 清理 docs 主数据 JSON 中的测试菜/测试料/联调单据，并自增 rev
 * 仅用 Node 内置 node:sqlite；默认对 store-inventory/data/餐厅系统.db 就地执行。
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

function parseArgs(argv) {
  const out = { db: path.join(__dirname, '..', 'store-inventory', 'data', '餐厅系统.db'), dry: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') out.db = argv[++i];
    else if (argv[i] === '--dry') out.dry = true;
  }
  return out;
}

const TESTISH = /demo_proto|E2E|e2e|smoke|联调|测试|批2|示例|占位/;

function main() {
  const { db: dbPath, dry } = parseArgs(process.argv.slice(2));
  const db = new DatabaseSync(dbPath);
  const counts = {};

  const del = (table, where) => {
    try {
      const r = db.prepare('DELETE FROM "' + table + '" WHERE ' + where).run();
      if (r.changes) counts['删.' + table] = (counts['删.' + table] || 0) + Number(r.changes);
    } catch (e) { counts['ERR.' + table] = e.message; }
  };
  const upd = (table, sets, where) => {
    try {
      const r = db.prepare('UPDATE "' + table + '" SET ' + sets + ' WHERE ' + where).run();
      if (r.changes) counts['改.' + table] = (counts['改.' + table] || 0) + Number(r.changes);
    } catch (e) { counts['ERR.' + table] = e.message; }
  };

  db.exec('BEGIN');
  // 1) 删除明显测试行
  del('recipes', "sku_id='SKU-APP-D9679BA1' OR name LIKE '%测试%'");
  del('actions_queue', "payload LIKE '%E2E%' OR payload LIKE '%测试%' OR payload LIKE '%smoke%' OR payload LIKE '%联调%'");
  del('vip_coupons', "code LIKE 'E2E%' OR code LIKE 'CROSS%'");
  del('bookings', "guest_name LIKE '%测试%' OR guest_name LIKE '%验收%' OR guest_name='' OR note LIKE '%e2e%'");
  del('vip_visits', "name LIKE '%测试%' OR note LIKE '%smoke%' OR note LIKE '%联调%'");
  del('recv_accept', "recv_id LIKE 'SMOKE%' OR recv_id LIKE 'E2E%' OR ing_name LIKE '%测试%'");
  del('app_audit', "body LIKE '%联调%' OR body LIKE '%e2e%' OR title LIKE '%联调%'");
  del('rv_improve', "owner='e2e'");

  // 2) 归一化来源与操作人
  for (const t of ['staff_shifts', 'staff_clock', 'staff_perf', 'staff_train',
    'fs_certs', 'fs_trace', 'fs_samples', 'fs_disinfect', 'eq_maintain', 'queue', 'bookings']) {
    upd(t, "source='init'", "source='demo_proto'");
  }
  upd('fs_disinfect', "operator='店长'", "operator='e2e'");
  upd('eq_maintain', "operator='店长'", "operator='e2e'");
  upd('fs_samples', "keeper='后厨'", "keeper='e2e'");
  upd('fin_cash', "note=REPLACE(note,'e2e 025','系统自动')", "note LIKE '%e2e 025%'");
  upd('sop_workorders', "steps_state=REPLACE(steps_state,'e2e','后厨')", "steps_state LIKE '%e2e%'");

  // 3) docs 主数据
  const row = db.prepare('SELECT rev, data FROM docs ORDER BY rev DESC LIMIT 1').get();
  if (row) {
    const data = JSON.parse(row.data);
    const before = {
      dishes: (data.dishes || []).length, ings: (data.ings || []).length,
      orders: (data.orders || []).length, recv: (data.recv || []).length,
      logs: (data.logs || []).length, quotes: (data.quotes || []).length
    };
    data.dishes = (data.dishes || []).filter((d) => d && !TESTISH.test(String(d.name || '')));
    data.ings = (data.ings || []).filter((g) => g && !TESTISH.test(String(g.name || '')));
    data.orders = (data.orders || []).filter((o) => o && !TESTISH.test(String((o.supplier || '') + (o.note || ''))));
    data.recv = (data.recv || []).filter((r) => r && !TESTISH.test(String((r.supplier || '') + (r.note || ''))));
    data.logs = (data.logs || []).filter((l) => l && !TESTISH.test(JSON.stringify(l)));
    data.quotes = (data.quotes || []).filter((q) => q && !TESTISH.test(String((q.src || '') + (q.supplier || '') + (q.note || ''))));
    // 桌台服务备注/VIP 名去测试痕迹
    if (Array.isArray(data.pos)) {
      for (const t of data.pos) {
        if (t && t.service_flags && typeof t.service_flags === 'object') {
          for (const k of Object.keys(t.service_flags)) {
            const f = t.service_flags[k];
            if (f && typeof f.note === 'string') {
              f.note = f.note.replace(/smoke|e2e|联调|测试/gi, '').trim() || '前厅操作';
            }
          }
        }
        if (t && typeof t.vip_name === 'string' && /测试/.test(t.vip_name)) t.vip_name = '王女士';
      }
    }
    const newRev = (row.rev || 1) + 1;
    counts['docs'] = { rev: row.rev + '→' + newRev, before, after: {
      dishes: data.dishes.length, ings: data.ings.length, orders: data.orders.length,
      recv: data.recv.length, logs: data.logs.length, quotes: data.quotes.length
    } };
    if (!dry) {
      db.prepare('UPDATE docs SET rev=?, data=? WHERE rev=?').run(newRev, JSON.stringify(data), row.rev);
    }
  }

  if (dry) db.exec('ROLLBACK'); else db.exec('COMMIT');
  console.log(JSON.stringify({ db: dbPath, dry, counts }, null, 1));
}

main();
