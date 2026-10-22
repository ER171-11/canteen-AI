'use strict';
/*
 * lib/algorithms/vendor.test.js — 供应商档案编辑 / 删除的执行器回归（零依赖，node 直跑）
 *
 * 守的四件事：
 *   ① vendor.upsert 新建：状态可落「考察中 / 合作中 / 暂停」，不同状态互不干扰；
 *   ② vendor.upsert 编辑（edit:true）：显式空值也写回（清空电话/评级），改名后旧名从
 *      data.suppliers 摘除；非编辑口径仍保持旧行为（null 不覆盖字段）；
 *   ③ vendor.delete：档案从 data.vendors 移除、解绑原料默认供应商（ing.sup）；
 *   ④ vendor.delete 红线：有往来账（sup_accounts 命中）直接抛错拒绝，台账不悬空；
 *   ⑤ vendor.upsert 资质证照（W3）：编辑显式清空（空数组写 null）/ 缺省保留 / 非空写入。
 *
 * 运行：node lib/algorithms/vendor.test.js
 */
const assert = require('assert');
const inv = require('./inventory');

let failed = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '  ' + (e && e.message ? e.message : e)); }
}

/** 最小 store 桩：accounts 命中数 / remove 命中行数可控，remove 记调用 */
function mkStore(accRows, removedRows) {
  const log = { removed: [] };
  return {
    log,
    query() { return accRows || [{ c: 0 }]; },
    upsert() { return { rowid: 1, matched: false }; },
    insert() { return 1; },
    update() { return { rowcount: 1 }; },
    remove(table, where) {
      log.removed.push({ table, where });
      return { rowcount: removedRows === undefined ? 1 : removedRows };
    }
  };
}

function mkData() {
  return {
    vendors: [
      { id: 'V1', vendor_id: 'V1', name: '甲供应商', category: '冷链', status: '合作中', period: '月结15天', level: 4, contact: '王经理', phone: '13800001111', note: '老合作' },
      { id: 'V2', vendor_id: 'V2', name: '乙供应商', category: '蔬菜', status: '考察中', period: '现结', level: 2, contact: '李', phone: '13900002222', note: '' }
    ],
    suppliers: ['甲供应商', '乙供应商'],
    ings: [{ id: 'I1', name: '冻虾', sup: '甲供应商' }, { id: 'I2', name: '青菜', sup: '乙供应商' }],
    orders: [],
    recv: []
  };
}

/* ① 不同状态新建：状态原样落库，互不覆盖 */
ok('新建供应商按传入状态落库（考察中 / 暂停）', () => {
  const data = mkData();
  const store = mkStore();
  inv.upsertVendor(data, { name: '丙供应商', category: '粮油', status: '考察中' }, { store });
  inv.upsertVendor(data, { name: '丁供应商', category: '调料', status: '暂停' }, { store });
  const byName = (n) => data.vendors.filter((v) => v.name === n)[0];
  assert.strictEqual(byName('丙供应商').status, '考察中');
  assert.strictEqual(byName('丁供应商').status, '暂停');
  assert.strictEqual(data.vendors.length, 4);
  assert.strictEqual(data.suppliers.length, 4);
});

/* ② 编辑模式：改状态 + 清空电话/评级，其余字段保留 */
ok('编辑（edit:true）改状态并清空电话/评级', () => {
  const data = mkData();
  const store = mkStore();
  inv.upsertVendor(data, {
    edit: true, name: '甲供应商', vendor_id: 'V1', category: '冷链', status: '暂停',
    period: '月结15天', level: null, contact: '王经理', phone: '', note: ''
  }, { store });
  const v = data.vendors.filter((x) => x.id === 'V1')[0];
  assert.strictEqual(v.status, '暂停');
  assert.strictEqual(v.phone, '');
  assert.strictEqual(v.level, null);
  assert.strictEqual(v.contact, '王经理');
  assert.strictEqual(data.vendors.length, 2, '编辑不得新增档案');
});

/* ②b 非编辑口径：null 不覆盖（与 Python 平价），状态缺省仍为「合作中」 */
ok('非编辑口径 null 不覆盖既有字段', () => {
  const data = mkData();
  const store = mkStore();
  inv.upsertVendor(data, { name: '甲供应商', vendor_id: 'V1', contact: null, level: null }, { store });
  const v = data.vendors.filter((x) => x.id === 'V1')[0];
  assert.strictEqual(v.contact, '王经理', 'null 不应覆盖联系人');
  assert.strictEqual(v.level, 4, 'null 不应覆盖评级');
});

/* ②c 编辑改名：旧名从 data.suppliers 摘除，新名并入 */
ok('编辑改名后旧名从 suppliers 摘除', () => {
  const data = mkData();
  const store = mkStore();
  inv.upsertVendor(data, { edit: true, vendor_id: 'V2', name: '乙供应商（新）', category: '蔬菜', status: '合作中' }, { store });
  assert.ok(data.suppliers.indexOf('乙供应商（新）') >= 0, '新名应在 suppliers');
  assert.ok(data.suppliers.indexOf('乙供应商') < 0, '旧名应被摘除');
});

/* ②d 无编号老档案改名：靠 old_name 定位，不新增、名称与状态都更新 */
ok('无编号档案改名靠 old_name 定位（不新增）', () => {
  const data = { vendors: [{ name: '老供应商', category: '冻品', status: '合作中' }], suppliers: ['老供应商'] };
  const store = mkStore();
  inv.upsertVendor(data, { edit: true, old_name: '老供应商', name: '新供应商', category: '冻品', status: '暂停' }, { store });
  assert.strictEqual(data.vendors.length, 1, '改名不得新增档案');
  assert.strictEqual(data.vendors[0].name, '新供应商');
  assert.strictEqual(data.vendors[0].status, '暂停');
  assert.ok(data.suppliers.indexOf('新供应商') >= 0 && data.suppliers.indexOf('老供应商') < 0, String(data.suppliers));
});

/* ②e W3 资质证照：编辑显式清空（空数组）/ 缺省保留 / 非空写入 */
ok('资质证照：编辑显式清空（空数组）、缺省保留、非空写入', () => {
  const data = {
    vendors: [{
      id: 'V1', vendor_id: 'V1', name: '甲供应商', category: '冷链', status: '合作中', period: '月结15天', level: 4,
      contact: '王经理', phone: '13800001111', note: '',
      certs: [{ type: '营业执照', cert_no: 'X1', expire_at: '2027-01-01', url: '' }]
    }],
    suppliers: ['甲供应商'], ings: [], orders: [], recv: []
  };
  const store = mkStore();
  const base = { edit: true, vendor_id: 'V1', name: '甲供应商', category: '冷链', status: '合作中' };

  // 1) 缺省（未传 certs）：仅改电话，证照应保留
  inv.upsertVendor(data, Object.assign({}, base, { phone: '13911112222' }), { store });
  let v = data.vendors[0];
  assert.ok(Array.isArray(v.certs) && v.certs.length === 1, '未传 certs 不得清空证照');
  assert.strictEqual(v.phone, '13911112222');

  // 2) 显式空数组：清空证照
  inv.upsertVendor(data, Object.assign({}, base, { certs: [] }), { store });
  v = data.vendors[0];
  assert.strictEqual(v.certs, null, '显式空数组应清空证照');

  // 3) 非空数组：写入新证照
  inv.upsertVendor(data, Object.assign({}, base, { certs: [{ type: '食品经营许可', cert_no: 'JY2', expire_at: '2026-06-01', url: '' }] }), { store });
  v = data.vendors[0];
  assert.strictEqual(v.certs.length, 1, '非空数组应写回证照');
  assert.strictEqual(v.certs[0].type, '食品经营许可');
});

/* ②e 编辑定位不到档案 → 抛错，绝不静默新建（防止「编辑」变成「新增」造成重复档案） */
ok('编辑不存在的供应商 → 抛错且不新增', () => {
  const data = mkData();
  const store = mkStore();
  assert.throws(
    () => inv.upsertVendor(data, { edit: true, vendor_id: 'V404', name: '幽灵供应商', category: '其他' }, { store }),
    /找不到要编辑的供应商/
  );
  assert.strictEqual(data.vendors.length, 2, '编辑失败不得新增档案');
});

/* ③ 删除：档案消失 + 原料默认供应商解绑 + suppliers 摘名 + 删 sup_vendors 行 */
ok('删除供应商：移除档案、解绑 ing.sup、摘 suppliers、删新表行', () => {
  const data = mkData();
  const store = mkStore();
  const msg = inv.applyVendorDelete(data, { vendor_id: 'V1' }, { store });
  assert.strictEqual(data.vendors.length, 1);
  assert.strictEqual(data.vendors[0].id, 'V2');
  assert.strictEqual(data.ings[0].sup, '', 'ing.sup 应解绑');
  assert.ok(data.suppliers.indexOf('甲供应商') < 0, 'suppliers 应摘除');
  assert.deepStrictEqual(store.log.removed[0], { table: 'sup_vendors', where: { vendor_id: 'V1' } });
  assert.ok(/已删除/.test(msg), msg);
});

/* ③b 历史单据仍引用该名 → suppliers 保留（采购/进货筛选依赖名单） */
ok('删除时历史单据仍引用则保留 suppliers 名称', () => {
  const data = mkData();
  data.recv = [{ id: 'JH1', supplier: '甲供应商' }];
  const store = mkStore();
  inv.applyVendorDelete(data, { name: '甲供应商' }, { store });
  assert.ok(data.suppliers.indexOf('甲供应商') >= 0, '历史单据引用时不能摘名');
});

/* ④ 红线：有往来账禁删 */
ok('有往来账 → 抛错拒绝删除（改为暂停）', () => {
  const data = mkData();
  const store = mkStore([{ c: 2 }]);
  assert.throws(() => inv.applyVendorDelete(data, { vendor_id: 'V1' }, { store }), /往来账.*暂停/);
  assert.strictEqual(data.vendors.length, 2, '拒绝时不得改动档案');
  assert.strictEqual(store.log.removed.length, 0, '拒绝时不得删库行');
});

/* ④b 找不到档案（data 与新表都没有） → 抛错 */
ok('找不到供应商 → 抛错', () => {
  assert.throws(
    () => inv.applyVendorDelete(mkData(), { vendor_id: 'V404' }, { store: mkStore(null, 0) }),
    /找不到供应商/
  );
});

if (failed) { console.error('\n✗ ' + failed + ' 项失败'); process.exit(1); }
console.log('\nPASS vendor.test.js 全部通过');
