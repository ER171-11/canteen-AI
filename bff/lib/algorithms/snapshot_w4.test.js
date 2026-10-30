'use strict';
/*
 * W4 高危三件套回归（ADR-013 D4；W4-01/02/03，FP-SET-15/16/17）。
 * 全部在临时 BFF_DATA_DIR 下跑（不污染真实快照），逐项验证：
 *
 *   W4-01 导入备份恢复
 *     ① 暂存区幂等（同一份文件 → 同一 import_id，重复上传复用不新增）；
 *     ② 执行器整包恢复 data+ext、强制前置备份、rev 递增不回退、回执含 incoming_rev/schema_steps；
 *     ③ import_id 缺失 / 不存在 / 内容非法 / schema 迁移失败 → 显式报错（红线⑦）；
 *
 *   W4-02 重置为真实数据基线
 *     ④ 基线制品列表 + 校验和自证；
 *     ⑤ 重置后销售归零、原料/菜品/单据回基线、ext 清空；
 *     ⑥ 校验和被改动 / 版本不存在 → 拒绝执行；
 *
 *   W4-03 清空业务数据
 *     ⑦ business：ings/recv/logs 同组清（D4-6），config/rest/桌台/验收标准保留；
 *     ⑧ business：清完 rebuildStock 不会把库存算回来；
 *     ⑨ all：只剩 data.v，ext 清空，org.json/settle_template.json/tokens.json 一并清（回到首次安装）；
 *     ⑩ scope 非法 → 显式报错；
 *
 *   + 注册表收口（三个动作都已登记）、executeAction 端到端（ext 回写快照）。
 *
 * 运行：node bff/lib/algorithms/snapshot_w4.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adr013-w4-'));
process.env.BFF_DATA_DIR = TMP;

const store = require('../store');
const snapshotStore = require('../snapshot_store');
const importStore = require('../import_store');
const baselineStore = require('../baseline_store');
const { getAdapter } = require('../store-adapter');
const { SCHEMA_VERSION } = require('../schema');
const algo = require('./index');
require('./registry');
const S = require('./snapshot');
const { executeAction } = require('./execute');
const { rebuildStock } = require('./stock');

let failed = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '  ' + (e && e.message ? e.message : e)); }
}

function makeSnapshot(rev, data, ext) {
  return {
    rev,
    generated_at: new Date().toISOString(),
    size: 0,
    data: Object.assign({ v: SCHEMA_VERSION }, data || {}),
    ext: ext === undefined ? null : ext,
  };
}

/* 当前现场：有销售/流水/配方等业务数据 */
store.writeJSON('snapshot.json', makeSnapshot(300, {
  ings: [{ id: 'I1', name: '五花肉', stock: 10, avg: 30 }],
  dishes: [{ id: 'D1', name: '回锅肉' }],
  recv: [{ id: 'R1', lines: [{ ing: 'I1', qty: 1 }] }],
  orders: [{ id: 'O1' }],
  sales: [{ id: 'S1' }, { id: 'S2' }],
  quotes: [{ id: 'Q1' }],
  logs: [{ id: 'L1', type: '期初', ing: 'I1', qty: 10 }],
  config: { safety_stock: { 面粉: 10 } },
  rest: '熊猫五福餐厅',
  pos: [{ table_id: 'T1' }],
}, {
  recipes: [{ id: 1, name: '回锅肉' }],
  pos_tables: [{ table_id: 'T1' }],
  accept_standards: [{ ing_name: '五花肉' }],
  fin_cash: [{ id: 1, amount: 100 }],
}));

/* ---------------- W4-01 导入备份恢复 ---------------- */

ok('① 暂存区：同一份文件 → 同一 import_id（幂等），内容可回读', () => {
  const text = JSON.stringify(makeSnapshot(120, { ings: [{ id: 'X1' }], sales: [] }, { recipes: [] }));
  const a = importStore.save(text, { operator: 'tester', note: '导入一' });
  const b = importStore.save(text, { operator: 'tester', note: '导入一' });
  assert.strictEqual(a.reused, false);
  assert.strictEqual(b.reused, true, '同内容应复用，不新增暂存文件');
  assert.strictEqual(a.item.id, b.item.id);
  assert.ok(/^imp-[0-9a-f]{16}$/.test(a.item.id), 'id 形态应为 imp-<sha256 前16位>');
  const back = importStore.read(a.item.id);
  assert.ok(back && back.data, '应能回读暂存文件');
  assert.strictEqual(back.rev, 120);
});

ok('② applySnapshotImport：整包恢复 data+ext + 强制前置备份 + rev 递增', () => {
  const back = importStore.list()[0];
  const data = JSON.parse(JSON.stringify(getAdapter().readSnapshot().data));
  const ctx = { rev: 300, store: { ext: { recipes: [{ id: 9 }], fin_cash: [{}] } } };
  const res = S.applySnapshotImport(data, { import_id: back.id, reason: '导入测试' }, ctx);
  assert.strictEqual(res.from_rev, 300);
  assert.strictEqual(res.to_rev, 301, 'rev 应 = curRev+1，绝不回退');
  assert.strictEqual(res.incoming_rev, 120);
  assert.ok(res.safeguard_id, '应生成导入前自动备份');
  assert.deepStrictEqual(data.ings, [{ id: 'X1' }], 'data 应被整包替换');
  assert.strictEqual(data.sales.length, 0);
  assert.deepStrictEqual(ctx.store.ext, { recipes: [] }, 'ext 应随导入文件整包替换');
  assert.ok(snapshotStore.list().some((x) => x.note && x.note.indexOf('导入恢复前自动备份') >= 0));
});

ok('② normalizeIncomingSnapshot：三种形态 + 非法输入显式报错', () => {
  assert.deepStrictEqual(S.normalizeIncomingSnapshot({ rev: 3, data: { a: 1 } }).rev, 3);
  assert.deepStrictEqual(S.normalizeIncomingSnapshot({ data: { a: 1 } }).ext, {});
  assert.deepStrictEqual(S.normalizeIncomingSnapshot({ snapshot: { data: { b: 2 } } }).data, { b: 2 });
  assert.throws(() => S.normalizeIncomingSnapshot(null), /不是 JSON 对象/);
  assert.throws(() => S.normalizeIncomingSnapshot({ rev: 1 }), /缺少 data/);
  assert.throws(() => S.normalizeIncomingSnapshot({ data: { a: 1 }, ext: [] }), /ext 必须是对象/);
});

ok('③ import_id 缺失 / 不存在 → 显式报错', () => {
  const data = { ings: [] };
  assert.throws(() => S.applySnapshotImport(data, {}, { rev: 1, store: {} }), /需要 import_id/);
  assert.throws(() => S.applySnapshotImport(data, { import_id: 'imp-deadbeefdeadbeef' }, { rev: 1, store: {} }),
    /导入文件不存在/);
});

ok('③ 导入内容 schema 迁移不可行 → 拒绝执行（不静默跳版本）', () => {
  const bad = importStore.save(JSON.stringify({ rev: 5, data: { v: 0, ings: [] }, ext: {} }), {});
  assert.throws(
    () => S.applySnapshotImport({ ings: [] }, { import_id: bad.item.id }, { rev: 9, store: {} }),
    /schema 迁移失败|缺少 v0/
  );
});

/* ---------------- W4-02 重置为真实数据基线 ---------------- */

function writeBaseline(version, data, ext) {
  const dir = path.join(TMP, 'baselines');
  fs.mkdirSync(dir, { recursive: true });
  const obj = {
    baseline_version: version,
    generated_at: new Date().toISOString(),
    source: 'test-fixture',
    schema_version: SCHEMA_VERSION,
    note: '测试基线',
    checksum: baselineStore.checksumOf(data, ext),
    counts: baselineStore.countsOf({ data, ext }),
    data,
    ext,
  };
  const p = path.join(dir, 'baseline-' + version + '.json');
  fs.writeFileSync(p, JSON.stringify(obj, null, 1));
  return p;
}

const BASE_DATA = {
  v: SCHEMA_VERSION,
  ings: [{ id: 'B1', name: '菜心' }, { id: 'B2', name: '生菜' }],
  dishes: [{ id: 'BD1', name: '蒜蓉菜心' }],
  recv: [{ id: 'BR1', lines: [{ ing: 'B1', qty: 2 }] }],
  orders: [{ id: 'BO1' }],
  config: { safety_stock: { 菜心: 3 } },
  rest: '熊猫五福餐厅',
};
writeBaseline('v1', BASE_DATA, {});

ok('④ 基线制品列表 + 校验和自证', () => {
  const items = baselineStore.list();
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].version, 'v1');
  assert.strictEqual(items[0].checksum_ok, true);
  assert.strictEqual(items[0].counts.ings, 2);
});

ok('⑤ applySnapshotResetBaseline：销售归零、原料/单据回基线、ext 清空、前置备份', () => {
  const data = JSON.parse(JSON.stringify(getAdapter().readSnapshot().data));
  const ctx = { rev: 310, store: { ext: { recipes: [{ id: 1 }] } } };
  const res = S.applySnapshotResetBaseline(data, { baseline_version: 'v1', reason: '测试重置' }, ctx);
  assert.strictEqual(res.baseline_version, 'v1');
  assert.strictEqual(res.checksum_ok, true);
  assert.strictEqual(res.to_rev, 311);
  assert.ok(res.safeguard_id);
  assert.strictEqual(data.ings.length, 2, '原料应回到基线');
  assert.strictEqual(data.ings[0].id, 'B1');
  assert.deepStrictEqual(data.sales, undefined, '销售应归零（基线无 sales 键）');
  assert.deepStrictEqual(ctx.store.ext, {}, 'ext 应为基线内容（空）');
  assert.ok(snapshotStore.list().some((x) => x.note && x.note.indexOf('重置基线前自动备份') >= 0));
});

ok('⑥ 基线被改动（校验和不符）→ 拒绝执行', () => {
  const p = writeBaseline('v9', { v: SCHEMA_VERSION, ings: [] }, {});
  const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
  obj.data.ings.push({ id: 'HACK' });
  fs.writeFileSync(p, JSON.stringify(obj, null, 1));
  assert.throws(
    () => S.applySnapshotResetBaseline({ ings: [] }, { baseline_version: 'v9' }, { rev: 1, store: {} }),
    /校验和不匹配/
  );
  fs.unlinkSync(p);
});

ok('⑥ 基线版本不存在 → 拒绝执行', () => {
  assert.throws(
    () => S.applySnapshotResetBaseline({ ings: [] }, { baseline_version: 'v404' }, { rev: 1, store: {} }),
    /基线不存在/
  );
});

/* ---------------- W4-03 清空业务数据 ---------------- */

ok('⑦ scope=business：ings/recv/logs 同组清，config/rest/桌台/验收标准保留', () => {
  // 复位现场（前面的用例已把它改成基线内容）
  store.writeJSON('snapshot.json', makeSnapshot(320, {
    ings: [{ id: 'I1' }],
    recv: [{ id: 'R1' }],
    logs: [{ id: 'L1' }],
    sales: [{ id: 'S1' }],
    config: { note: 'keep' },
    rest: '熊猫五福餐厅',
    pos: [{ table_id: 'T1' }],
  }, { recipes: [{ id: 1 }], pos_tables: [{ table_id: 'T1' }], accept_standards: [{ ing_name: 'x' }], fin_cash: [{}] }));
  const snap = getAdapter().readSnapshot();
  const out = executeAction(snap, { type: 'snapshot.clear', payload: { scope: 'business' } });
  assert.strictEqual(out.ok, true, out.error || '应执行成功');
  const d = out.snapshot.data;
  for (const k of ['ings', 'recv', 'logs', 'sales']) {
    assert.deepStrictEqual(d[k], undefined, k + ' 应被清空');
  }
  assert.deepStrictEqual(d.config, { note: 'keep' }, '配置应保留');
  assert.strictEqual(d.rest, '熊猫五福餐厅');
  assert.ok(Array.isArray(d.pos) && d.pos.length === 1, '桌台主数据应保留');
  assert.deepStrictEqual(out.snapshot.ext.recipes, undefined, '配方应清空');
  assert.ok(out.snapshot.ext.pos_tables && out.snapshot.ext.accept_standards, '主数据表应保留');
  assert.strictEqual(out.snapshot.ext.fin_cash, undefined, '财务流水应清空');
  assert.strictEqual(d.v, SCHEMA_VERSION, 'schema 版本应保留');
});

ok('⑧ 清完 rebuildStock 不会把库存算回来（recv/logs 已同组清）', () => {
  const snap = getAdapter().readSnapshot();
  const out = executeAction(snap, { type: 'snapshot.clear', payload: { scope: 'business' } });
  const d = out.snapshot.data;
  const msg = rebuildStock(d);
  assert.ok(/跳过/.test(msg), '无 ings 时应跳过，实际：' + msg);
  assert.deepStrictEqual(d.ings, undefined);
});

ok('⑨ scope=all：只剩 data.v、ext 清空，org/结算模板/登录态一并清', () => {
  store.writeJSON('snapshot.json', makeSnapshot(330, {
    ings: [{ id: 'I1' }], config: { note: 'x' }, rest: '店名',
  }, { recipes: [{ id: 1 }], pos_tables: [] }));
  fs.writeFileSync(path.join(TMP, 'org.json'), '{"stores":[]}');
  fs.writeFileSync(path.join(TMP, 'settle_template.json'), '{"title":"x"}');
  fs.writeFileSync(path.join(TMP, 'tokens.json'), '{"tokens":{}}');

  const out = executeAction(getAdapter().readSnapshot(), { type: 'snapshot.clear', payload: { scope: 'all' } });
  assert.strictEqual(out.ok, true, out.error || '应执行成功');
  assert.deepStrictEqual(Object.keys(out.snapshot.data), ['v'], '只剩 schema 版本');
  assert.deepStrictEqual(out.snapshot.ext, {}, 'ext 应清空');
  for (const f of ['org.json', 'settle_template.json', 'tokens.json']) {
    assert.strictEqual(fs.existsSync(path.join(TMP, f)), false, f + ' 应被删除');
  }
  assert.ok(snapshotStore.list().length > 0, '清空前应已自动备份');
});

ok('⑩ scope 非法 → 显式报错（不猜默认档位）', () => {
  assert.throws(() => S.applySnapshotClear({ ings: [] }, { scope: 'everything' }, { rev: 1, store: {} }),
    /scope 只能是 business \/ all/);
});

ok('plannedClear 与 countSummary/diffOf 口径一致（预览=执行）', () => {
  const cur = { data: { ings: [1], sales: [1, 2], config: {} }, ext: { recipes: [1], staff: [1] } };
  const plan = S.plannedClear(cur, 'business');
  assert.deepStrictEqual(Object.keys(plan.data).sort(), ['config', 'v'], 'business 档应保留 config + v');
  assert.deepStrictEqual(Object.keys(plan.ext), ['staff'], 'ext 只保留主数据表');
  const diff = S.diffOf(cur, { data: plan.data, ext: plan.ext });
  assert.ok(diff.changed.some((r) => r.key === 'sales' && r.current === 2 && r.next === 0));
});

ok('注册表收口：W4 三个动作均已登记', () => {
  for (const t of ['snapshot.import', 'snapshot.reset_baseline', 'snapshot.clear']) {
    assert.strictEqual(algo.has(t), true, t + ' 未登记');
  }
  const r = algo.run('snapshot.clear', { rev: 1, store: { ext: {} } }, { v: SCHEMA_VERSION, ings: [] }, { scope: 'business' });
  assert.strictEqual(r.handled, true);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
console.log(failed
  ? '\n== snapshot W4 测试失败 ' + failed + ' 项 =='
  : '\nPASS snapshot W4 全部通过（W4-01/02/03，ADR-013 D4）');
process.exit(failed ? 1 : 0);
