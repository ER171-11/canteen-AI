'use strict';
/*
 * 进货单「凭证层 / 账务层」两段式回归（ADR-004 §2.5，零依赖，node 直跑）
 *
 * 守的七件事：
 *   ① 登记即见：recv.inbound / recv.import 带 draft:true → status='待审核'，单据立刻在 data.recv 里；
 *   ② 账面零变化：待审核单**不进库存、不进均价**（rebuildStock 口径唯一出口 lib/recv_status.js）；
 *   ③ 记账生效：recv.post → status='已入库' + 库存/均价才变化，并留 posted_by/at/rev 痕迹；
 *   ④ 幂等：重复 recv.post 跳过；已作废显式拒绝；非待审核状态显式报错（红线 #7 不静默降级）；
 *   ⑤ 版本比对（D-C）：确认后应付被改过 → 没有确认词就拒绝，带确认词才放行并留 posted_diff；
 *   ⑥ 付款前置：待审核单不能补付（未计入应付）；
 *   ⑦ 注册表收口：recv.post 已登记，且 recv_status 口径与 stock/report 同源。
 *
 * 运行：node bff/lib/algorithms/recv_pending.test.js
 */
const assert = require('assert');
const inv = require('./inventory');
const algo = require('./index');
const recvStatus = require('../recv_status');
require('./registry');

let failed = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '  ' + (e && e.message ? e.message : e)); }
}

function mkData() {
  return {
    ings: [{ id: 'I1', name: '五花肉', stock: 0, avg: 0, on: true }],
    recv: [],
    orders: [],
    logs: [],
    suppliers: [],
  };
}

/** 登记一张待审核单（不含已生效单），返回 data */
function withDraft() {
  const d = mkData();
  inv.applyRecvInbound(d, {
    date: '2026-10-30', supplier: '甲供应商', paid: 0, method: '现金/转账',
    draft: true, operator: 'warehouse',
    items: [{ ing_id: 'I1', name: '五花肉', qty: 10, price: 30 }],
  });
  return d;
}

/* ① 登记即见 */
ok('recv.inbound(draft:true) → 单据立刻在列表里，status=待审核', () => {
  const d = withDraft();
  assert.strictEqual(d.recv.length, 1, '单据必须当场落库（老板才看得到）');
  assert.strictEqual(d.recv[0].status, '待审核');
  assert.strictEqual(d.recv[0].payable, 300);
  assert.ok(d.recv[0].review_snapshot && d.recv[0].review_snapshot.payable === 300,
    '登记时要留审核基线（金额/行数）');
});

/* ② 账面零变化 */
ok('待审核单不进库存、不进均价', () => {
  const d = withDraft();
  const g = d.ings[0];
  assert.ok(!(Number(g.stock) > 0), '库存必须还是 0，实际 ' + g.stock);
  assert.ok(!(Number(g.avg) > 0), '均价必须还是 0，实际 ' + g.avg);
});

ok('待审核单不影响其它已入库单的重算结果', () => {
  const d = mkData();
  /* 先入一张 5 斤的正式单（已入库） */
  inv.applyRecvInbound(d, {
    date: '2026-10-30', supplier: '甲', items: [{ ing_id: 'I1', qty: 5, price: 20 }],
  });
  assert.strictEqual(d.ings[0].stock, 5);
  /* 再登记一张 10 斤待审核单：重算时仍只认 5 斤 */
  inv.applyRecvInbound(d, {
    date: '2026-10-30', supplier: '甲', draft: true,
    items: [{ ing_id: 'I1', qty: 10, price: 30 }],
  });
  d.recv.push({ id: 'X', status: '已入库', lines: [] }); // 触发口径无需重算，仅占位
  const { rebuildStock } = require('./stock');
  rebuildStock(d);
  assert.strictEqual(d.ings[0].stock, 5, '待审核单不得被算进库存');
});

/* ③ 记账生效 */
ok('recv.post → 已入库，库存/均价才变化', () => {
  const d = withDraft();
  const id = d.recv[0].id;
  const msg = inv.applyRecvPost(d, { recv_id: id, operator: 'boss', expect_payable: 300 },
    { rev: 88, traceId: 'TR-post', now: '2026-10-30T02:00:00Z' });
  assert.strictEqual(d.recv[0].status, '已入库');
  assert.strictEqual(d.ings[0].stock, 10);
  assert.strictEqual(d.ings[0].avg, 30);
  assert.strictEqual(d.recv[0].posted_by, 'boss');
  assert.strictEqual(d.recv[0].posted_rev, 88);
  assert.strictEqual(d.recv[0].posted_trace, 'TR-post');
  assert.ok(/已入库/.test(msg), msg);
});

/* ④ 幂等 / 显式报错 */
ok('recv.post 重复执行 → 跳过（幂等）', () => {
  const d = withDraft();
  const id = d.recv[0].id;
  inv.applyRecvPost(d, { recv_id: id }, {});
  const msg = inv.applyRecvPost(d, { recv_id: id }, {});
  assert.ok(/跳过/.test(msg), msg);
  assert.strictEqual(d.ings[0].stock, 10, '不得重复入库');
});

ok('recv.post 对已作废单 → 显式拒绝', () => {
  const d = withDraft();
  d.recv[0].status = '已作废';
  assert.throws(() => inv.applyRecvPost(d, { recv_id: d.recv[0].id }, {}), /已作废/);
});

ok('recv.post 对草稿（未登记待审核）→ 显式报错', () => {
  const d = mkData();
  d.recv.push({ id: 'R9', no: 'JH9', status: '草稿', lines: [], payable: 10 });
  assert.throws(() => inv.applyRecvPost(d, { recv_id: 'R9' }, {}), /待审核/);
});

/* ⑤ 版本比对（D-C） */
ok('确认后应付被改过：无确认词 → 拒绝并提示确认词', () => {
  const d = withDraft();
  d.recv[0].payable = 380; // 审批人看到 300，之后被改成 380
  assert.throws(
    () => inv.applyRecvPost(d, { recv_id: d.recv[0].id, expect_payable: 300 }, {}),
    /确认入库/
  );
  assert.strictEqual(d.recv[0].status, '待审核', '被拒时不得改状态');
  assert.strictEqual(d.ings[0].stock, 0, '被拒时不得动库存');
});

ok('差异 + 输入确认词 → 按新金额记账并留 posted_diff', () => {
  const d = withDraft();
  d.recv[0].payable = 380;
  inv.applyRecvPost(d, {
    recv_id: d.recv[0].id, expect_payable: 300, confirm_word: '确认入库', operator: 'boss',
  }, {});
  assert.strictEqual(d.recv[0].status, '已入库');
  assert.deepStrictEqual(d.recv[0].posted_diff, {
    at: d.recv[0].posted_at, expect: 300, actual: 380,
  });
});

ok('未传 expect_payable 时回落到登记基线（同样能拦住改动）', () => {
  const d = withDraft();
  d.recv[0].payable = 999;
  assert.throws(() => inv.applyRecvPost(d, { recv_id: d.recv[0].id }, {}), /确认入库/);
});

/* ⑥ 付款前置 */
ok('待审核单不能补付（未计入应付）', () => {
  const d = withDraft();
  assert.throws(
    () => inv.applyRecvPay(d, { recv_id: d.recv[0].id, amount: 100 }),
    /待审核/
  );
  assert.strictEqual((d.recv[0].payments || []).length, 0);
});

/* ⑦ 编辑待审核单只改单据、不重算台账 */
ok('recv.update 待审核单：改明细但不进库存、状态不变', () => {
  const d = withDraft();
  const msg = inv.applyRecvUpdate(d, {
    id: d.recv[0].id, items: [{ ing_id: 'I1', name: '五花肉', qty: 12, price: 30 }],
  });
  assert.strictEqual(d.recv[0].payable, 360);
  assert.strictEqual(d.recv[0].status, '待审核', '编辑不得顺手把状态改成已入库');
  assert.strictEqual(d.ings[0].stock, 0);
  assert.ok(/未记账/.test(msg), msg);
});

/* ⑦ 批量导入：整批待审核、账面零变化 */
ok('recv.import(draft:true) → 整批待审核，库存不变', () => {
  const d = mkData();
  const msg = inv.applyRecvImport(d, {
    draft: true, operator: 'warehouse', markPaid: false,
    docs: [
      { supplier: '甲', date: '2026-10-30', lines: [{ ingId: 'I1', name: '五花肉', qty: 2, price: 10 }] },
      { supplier: '乙', date: '2026-10-30', lines: [{ ingId: 'I1', name: '五花肉', qty: 3, price: 10 }] },
    ],
  });
  assert.strictEqual(d.recv.length, 2);
  assert.ok(d.recv.every((r) => r.status === '待审核'), '两张都必须是待审核');
  assert.ok(d.recv.every((r) => r.review_snapshot), '每张都要留审核基线');
  assert.strictEqual(d.ings[0].stock, 0);
  assert.ok(/未计入库存与应付/.test(msg), msg);
});

/* 口径同源 + 注册表 */
ok('recv_status 口径：待审核/草稿/作废 不生效，空状态视为已入库', () => {
  assert.strictEqual(recvStatus.isEffective({ status: '待审核' }), false);
  assert.strictEqual(recvStatus.isEffective({ status: '草稿' }), false);
  assert.strictEqual(recvStatus.isEffective({ status: '已作废' }), false);
  assert.strictEqual(recvStatus.isEffective({ status: '已入库' }), true);
  assert.strictEqual(recvStatus.isEffective({}), true);
  assert.strictEqual(recvStatus.isPendingReview({ status: '待审核' }), true);
  assert.strictEqual(recvStatus.isPendingAccept({ status: '待审核' }), false,
    '已收货待记账的单不该再出现在「待验收」工作台');
});

ok('recv.post 已登记进算法注册表（否则消费器判 need-manual 驳回）', () => {
  assert.strictEqual(algo.has('recv.post'), true);
  const d = withDraft();
  const r = algo.run('recv.post', { rev: 3 }, d, { recv_id: d.recv[0].id, expect_payable: 300 });
  assert.strictEqual(r.handled, true);
  assert.strictEqual(d.recv[0].status, '已入库');
});

console.log(failed
  ? '== recv_pending 测试失败 ' + failed + ' 项 =='
  : 'PASS recv_pending 两段式（登记待审核 / 记账生效）全部通过');
process.exit(failed ? 1 : 0);
