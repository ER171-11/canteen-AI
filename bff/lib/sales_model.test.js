'use strict';
/*
 * lib/sales_model.test.js — 销售应收模型（ADR-008）口径自证。
 *
 * 覆盖两层：
 *   1) lib/sales_model.js 的防御性取值与派生（无 MOCK、不落库）
 *   2) routes/report.js 的店级聚合（FP-DASH-02/03/04/08）——
 *      即《关键路径-销售应收模型-推行指令》§6 的「昨日开单、今日收款」断言：
 *      今日应收不计入、今日实收计入。
 *
 * 用法：node bff/lib/sales_model.test.js
 */
const assert = require('assert');
const model = require('./sales_model');
const { deriveReport } = require('../routes/report');

let pass = 0;
function ok(name, fn) {
  fn();
  pass++;
  console.log('  PASS ' + name);
}

/** 从 kpis 里取某张卡的数值（'¥123.00' → 123） */
function kpiOf(report, label) {
  const hit = (report.kpi || []).find((k) => k.label === label);
  assert.ok(hit, '缺少 KPI 卡: ' + label);
  return parseFloat(String(hit.value).replace(/[^0-9.-]/g, ''));
}
function kpiCard(report, label) {
  const hit = (report.kpi || []).find((k) => k.label === label);
  assert.ok(hit, '缺少 KPI 卡: ' + label);
  return hit;
}

/* ---------------- 1) 防御性取值（真实快照缺字段） ---------------- */

ok('真实快照行（仅 amount）：应收=amount、折扣=0、全额即收、欠款=0', () => {
  const s = { id: 'S1', date: '2026-10-12', dish: '五福饺子', qty: 2, amount: 60, channel: '堂食' };
  assert.strictEqual(model.receivableOf(s), 60);
  assert.strictEqual(model.discountOf(s), 0);
  assert.strictEqual(model.paidOf(s), 60);
  assert.strictEqual(model.debtOf(s), 0);
  assert.strictEqual(model.statusOf(s), '已结清');
});

ok('应收显式小于售价合计（折扣/抹零）时以 receivable 为准', () => {
  const s = { id: 'S1', date: '2026-10-12', amount: 100, discount: 12, receivable: 88, payments: [] };
  assert.strictEqual(model.subOf(s), 100);
  assert.strictEqual(model.discountOf(s), 12);
  assert.strictEqual(model.receivableOf(s), 88);
  assert.strictEqual(model.debtOf(s), 88);
  assert.strictEqual(model.statusOf(s), '有欠款');
});

ok('payments 为空数组 = 未收（不回退全额即收）', () => {
  const s = { id: 'S1', date: '2026-10-12', amount: 100, receivable: 100, payments: [] };
  assert.strictEqual(model.paidOf(s), 0);
  assert.strictEqual(model.debtOf(s), 100);
});

ok('实收按收款日期过滤：区间外收款不计入', () => {
  const s = {
    id: 'S1', date: '2026-10-12', amount: 100, receivable: 100,
    payments: [{ date: '2026-09-01', amount: 30 }, { date: '2026-10-13', amount: 70 }],
  };
  assert.strictEqual(model.receivedInRange(s, '2026-10-07', '2026-10-13'), 70);
  assert.strictEqual(model.receivedInRange(s, null, '2026-10-13'), 100, 'from=null 表示无下界（range=all）');
  assert.strictEqual(model.receivedInRange(s, '2026-10-14', '2026-10-20'), 0);
});

ok('浮点：多笔收款累加不留尾差', () => {
  const s = {
    id: 'S1', date: '2026-10-12', amount: 0.3, receivable: 0.3,
    payments: [{ date: '2026-10-12', amount: 0.1 }, { date: '2026-10-13', amount: 0.2 }],
  };
  assert.strictEqual(model.paidOf(s), 0.3);
  assert.strictEqual(model.debtOf(s), 0);
});

/* ---------------- 2) 店级聚合（routes/report.js） ---------------- */

const snap = {
  data: {
    sales: [
      { id: 'S1', date: '2026-10-12', amount: 100, receivable: 100, payments: [{ date: '2026-10-13', amount: 100 }] },
    ],
  },
};

ok('§6 口径自证：昨日开单、今日收款 —— 近7天应收 ¥100、实收 ¥100、欠款 ¥0、折扣 ¥0', () => {
  const r = deriveReport(snap, '2026-10-13', '7');
  assert.strictEqual(kpiOf(r, '应收合计'), 100);
  assert.strictEqual(kpiOf(r, '实收合计'), 100);
  assert.strictEqual(kpiOf(r, '未收欠款'), 0);
  assert.strictEqual(kpiOf(r, '折扣/抹零'), 0);
  assert.strictEqual(kpiCard(r, '应收合计').sub, '按单日期（本期）');
  assert.strictEqual(kpiCard(r, '实收合计').sub, '按收款日期（本期）');
  assert.strictEqual(kpiCard(r, '未收欠款').sub, '已全部收讫');
});

ok('当日口径（不传 range）：今日应收不计入、今日实收计入', () => {
  const r = deriveReport(snap, '2026-10-13');
  assert.strictEqual(kpiOf(r, '应收合计'), 0, '10-12 开的单不计入 10-13 当日应收');
  assert.strictEqual(kpiOf(r, '实收合计'), 100, '10-13 收的款计入当日实收');
  assert.strictEqual(kpiOf(r, '未收欠款'), 0);
});

ok('折扣卡按单日期落在区间内才计入（FP-DASH-08）', () => {
  const r = deriveReport({
    data: {
      sales: [
        { id: 'S1', date: '2026-10-12', amount: 100, discount: 8, receivable: 92, payments: [] },
        { id: 'S2', date: '2026-09-01', amount: 50, discount: 5, receivable: 45, payments: [] },
      ],
    },
  }, '2026-10-13', '7');
  assert.strictEqual(kpiOf(r, '折扣/抹零'), 8, '9-01 的折扣不在近7天区间内');
  assert.strictEqual(kpiOf(r, '应收合计'), 92);
  /* 欠款是累计口径（不设区间上界）：92 + 45 = 137 */
  assert.strictEqual(kpiOf(r, '未收欠款'), 137);
  assert.strictEqual(kpiCard(r, '未收欠款').sub, '累计未收');
});

ok('真实快照形态（无 receivable/discount/payments）也能出数且欠款为 0', () => {
  const r = deriveReport({
    data: {
      sales: [
        { id: 'S1', date: '2026-10-12', dish: '五福饺子', qty: 2, amount: 60, channel: '堂食' },
        { id: 'S2', date: '2026-10-13', dish: '御膳汤', qty: 1, amount: 40, channel: '堂食' },
      ],
    },
  }, '2026-10-13', '7');
  assert.strictEqual(kpiOf(r, '应收合计'), 100);
  assert.strictEqual(kpiOf(r, '实收合计'), 100, '全额即收口径：实收=应收');
  assert.strictEqual(kpiOf(r, '未收欠款'), 0);
});

ok('作废单不计入应收/实收/欠款/折扣', () => {
  const r = deriveReport({
    data: {
      sales: [
        { id: 'S1', date: '2026-10-12', amount: 100, receivable: 100, payments: [] },
        { id: 'S2', date: '2026-10-12', amount: 500, discount: 50, receivable: 450, payments: [], status: '已作废' },
      ],
    },
  }, '2026-10-13', '7');
  assert.strictEqual(kpiOf(r, '应收合计'), 100);
  assert.strictEqual(kpiOf(r, '折扣/抹零'), 0);
  assert.strictEqual(kpiOf(r, '未收欠款'), 100);
});

/* ---------------- 3) FP-DASH-10 逐日序列 / FP-DASH-13 挂账清单 ---------------- */

ok('dailySeries：逐日应收按单日期、实收按收款日期，new_debt = 当日应收 − 当日实收', () => {
  const series = model.dailySeries([
    { id: 'S1', date: '2026-10-12', amount: 100, receivable: 100, payments: [{ date: '2026-10-13', amount: 60 }] },
    { id: 'S2', date: '2026-10-13', amount: 40, receivable: 40, payments: [] },
  ], '2026-10-13', 3);
  assert.deepStrictEqual(series.map((d) => d.date), ['2026-10-11', '2026-10-12', '2026-10-13']);
  assert.deepStrictEqual(series[1], { date: '2026-10-12', receivable: 100, received: 0, new_debt: 100 });
  assert.deepStrictEqual(series[2], { date: '2026-10-13', receivable: 40, received: 60, new_debt: -20 });
});

ok('dailySeries：14 天窗口含首尾，窗外日期不入列；作废单不计入', () => {
  const series = model.dailySeries([
    { id: 'S1', date: '2026-09-30', amount: 10, receivable: 10, payments: [] },
    { id: 'S2', date: '2026-10-13', amount: 10, receivable: 10, payments: [], status: '已作废' },
  ], '2026-10-13', 14);
  assert.strictEqual(series.length, 14);
  /* 窗口 = [10-13 − 13 天, 10-13] = [09-30, 10-13]（旧版 daysAgo(13) 起点，HTML:1259） */
  assert.strictEqual(series[0].date, '2026-09-30');
  assert.strictEqual(series[0].receivable, 10, '09-30 落在窗口首日');
  assert.strictEqual(series[13].date, '2026-10-13');
  assert.strictEqual(series[13].receivable, 0, '作废单不计入逐日序列');
});

ok('dailySeries：非法日期返回空序列（不编造数据）', () => {
  assert.deepStrictEqual(model.dailySeries([], 'not-a-date', 14), []);
});

ok('unpaidSales：只列欠款 > 0.01 的单，按单日期倒序，作废单排除', () => {
  const rows = model.unpaidSales([
    { id: 'S1', no: 'XS001', date: '2026-10-11', amount: 100, receivable: 100, payments: [] },
    { id: 'S2', no: 'XS002', date: '2026-10-13', amount: 50, receivable: 50, payments: [{ date: '2026-10-13', amount: 50 }] },
    { id: 'S3', no: 'XS003', date: '2026-10-12', amount: 30, receivable: 30, payments: [{ date: '2026-10-12', amount: 10 }] },
    { id: 'S4', no: 'XS004', date: '2026-10-14', amount: 80, receivable: 80, payments: [], status: '已作废' },
    { id: 'S5', no: 'XS005', date: '2026-10-10', amount: 20, receivable: 20.005, payments: [{ date: '2026-10-10', amount: 20 }] },
  ]);
  assert.deepStrictEqual(rows.map((r) => r.no), ['XS003', 'XS001'], '已结清/作废/尾差 ≤0.01 不出列，按日期倒序');
  assert.strictEqual(rows[0].debt, 20);
  assert.strictEqual(rows[0].received, 10);
  assert.strictEqual(rows[0].status, '有欠款');
});

/* ---------------- 4) 店级下发（routes/report.js） ---------------- */

ok('report.daily 下发 daily_series(14) 与 debt_sales，且与四张卡同源', () => {
  const r = deriveReport({
    data: {
      sales: [
        { id: 'S1', date: '2026-10-12', amount: 100, receivable: 100, payments: [{ date: '2026-10-13', amount: 60 }] },
      ],
    },
  }, '2026-10-13', '7');
  assert.strictEqual(r.daily_series.length, 14);
  assert.strictEqual(r.daily_series[13].date, '2026-10-13');
  assert.strictEqual(r.daily_series[12].receivable, 100, '10-12 应收');
  assert.strictEqual(r.daily_series[13].received, 60, '10-13 实收');
  assert.strictEqual(r.debt_sales.length, 1);
  assert.strictEqual(r.debt_sales[0].debt, 40);
  assert.strictEqual(kpiOf(r, '未收欠款'), 40, '挂账清单与「未收欠款」卡同源');
});

console.log('[sales_model.test] PASS ' + pass + ' cases');
