'use strict';
/*
 * lib/sales_model.js — 销售应收模型（ADR-008）唯一口径源
 *
 * 职责边界：**只做「防御性取值 + 派生」，不做路由、不写库、不落派生值**。
 *
 * 1) 防御性取值（不造 MOCK）：真实快照 `sales[]` 目前仅
 *    {id,date,hour,dish,qty,amount,channel,method}（426 条真实记录无 discount/receivable/payments），
 *    缺字段时回退「应收 = amount、折扣 = 0、全额即收（收款日 = 单日期）」。
 *    —— 这是「按数据算出来为 0」，不是「写死 ¥0 假卡」（ADR-008 §7）。
 * 2) 派生不落库（红线②）：欠款 = receivable − Σ payments.amount 一律实时算，
 *    快照 `sales[]` **不存**欠款字段（存下来必漂移）。
 * 3) 口径唯一出口：应收/实收/欠款三数只在 BFF 聚合（`routes/report.js` 店级、
 *    `routes/export.js` 行级），前端只渲染不复算（ADR-007 / ADR-008 §4）。
 *
 * 消费方：
 *   bff/routes/report.js        —— 店级聚合（FP-DASH-02/03/04/08）
 *   bff/routes/export.js        —— 行级导出与销售单列表（FP-SALE-07 / FP-SET-14）
 *   bff/lib/algorithms/sale.js  —— 写侧执行器（sale.create/void/pay）共用同一取值口径
 */

function num(v, d) {
  const n = parseFloat(v);
  return isNaN(n) ? (d == null ? 0 : d) : n;
}
function arr(x) { return Array.isArray(x) ? x : []; }
function r2(x) { return Math.round((Number(x) + Number.EPSILON) * 100) / 100; }

/** 单日期（YYYY-MM-DD）：容错 date/ts/time/created_at/datetime/day */
function saleDateOf(s) {
  return String((s && (s.date || s.ts || s.time || s.created_at || s.datetime || s.day)) || '').slice(0, 10);
}

/** 售价合计：amount 为「本单原始成交额（售价合计）」（ADR-008 §2.5）；sub 显式给出时优先 */
function subOf(s) {
  if (s && s.sub != null) return num(s.sub);
  return num(s && s.amount);
}

/** 应收：receivable 显式给出时优先，否则 = 售价合计（无折扣时的等价口径） */
function receivableOf(s) {
  return s && s.receivable != null ? num(s.receivable) : subOf(s);
}

/** 折扣/抹零：默认 0（旧版字段名 discount） */
function discountOf(s) {
  return s && s.discount != null ? num(s.discount) : 0;
}

/**
 * 收款记录（旧版字段名 payments）。
 *
 * 语义边界（重要）：
 *   · **字段存在**（含空数组 `[]`）→ 以字段为准：`[]` 就是「分文未收」，
 *     不得把空数组回退成「全额即收」，否则新建待收款的单会被读成全收讫。
 *   · **字段缺失**（真实快照 `sales[]` 只有 amount，无 payments）→ 回退「全额即收」：
 *     以单日期为收款日的一条等额收款，使「实收合计（按收款日期）」在真实数据上仍能出数，
 *     且未来真实 payments 进来后同一逻辑自动生效（同一聚合无需改动）。
 */
function paymentsOf(s) {
  if (Array.isArray(s && s.payments)) return s.payments;
  const amt = num(s && s.amount);
  if (!(amt > 0)) return [];
  return [{ date: saleDateOf(s), amount: amt }];
}

/** 累计实收（不限日期） */
function paidOf(s) {
  return r2(arr(paymentsOf(s)).reduce((a, p) => a + num(p && p.amount), 0));
}

/** 单级欠款 = 应收 − 累计实收（派生值，不落库） */
function debtOf(s) {
  return Math.max(0, r2(receivableOf(s) - paidOf(s)));
}

/** 是否已作废（sale.void 留痕后 status='已作废'，不物理删除） */
function isVoided(s) {
  const st = String((s && s.status) || '');
  return st.indexOf('作废') >= 0 || /void/i.test(st);
}

/** 单据状态：已作废 / 已结清 / 有欠款 */
function statusOf(s) {
  if (isVoided(s)) return '已作废';
  return debtOf(s) > 0.005 ? '有欠款' : '已结清';
}

/**
 * 区间内收款实收（FP-DASH-03「按收款日期」）。
 * @param {object} s 销售单
 * @param {string|null} from 区间下界（YYYY-MM-DD；null = 无下界，range='all' 语义）
 * @param {string} to 区间上界（含）
 */
function receivedInRange(s, from, to) {
  const sum = arr(paymentsOf(s)).reduce((a, p) => {
    const d = String((p && p.date) || '').slice(0, 10);
    if (!d) return a;
    if (from && d < from) return a;
    if (to && d > to) return a;
    return a + num(p && p.amount);
  }, 0);
  return r2(sum);
}

/**
 * 店级汇总（只读；不落库）。
 * @param {Array} sales 快照 data.sales
 * @param {{from?:string|null,to?:string|null,excludeVoided?:boolean}} opt
 *   from/to 为「按单日期」的区间；excludeVoided 默认 true（作废单不计入应收/实收/欠款）
 */
function summarize(sales, opt) {
  const o = opt || {};
  const from = o.from || null;
  const to = o.to || null;
  const excludeVoided = o.excludeVoided !== false;
  let receivable = 0;
  let received = 0;
  let discount = 0;
  let debt = 0;
  for (const s of arr(sales)) {
    if (!s || typeof s !== 'object') continue;
    if (excludeVoided && isVoided(s)) continue;
    const d = saleDateOf(s);
    const inRange = (!from || d >= from) && (!to || d <= to);
    if (inRange) {
      receivable += receivableOf(s);
      discount += discountOf(s);
    }
    received += receivedInRange(s, from, to);
    debt += debtOf(s);
  }
  return {
    receivable: r2(receivable),
    received: r2(received),
    discount: r2(discount),
    debt: r2(debt),
  };
}

module.exports = {
  num,
  r2,
  saleDateOf,
  subOf,
  receivableOf,
  discountOf,
  paymentsOf,
  paidOf,
  debtOf,
  isVoided,
  statusOf,
  receivedInRange,
  summarize,
};
