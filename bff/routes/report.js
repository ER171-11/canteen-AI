'use strict';
/*
 * routes/report.js — 经营日报
 *   GET /api/report/daily?date=YYYY-MM-DD
 *     有快照：从 snapshot.data.sales 聚合营收/单数等 → mock:false
 *     无快照：返回结构完整的 mock（banner/kpi[8]/heat_mini/todos/alerts）并标 mock:true
 */
const { loadSnapshot } = require('./snapshot');

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function recordDate(r) {
  return String(r && (r.date || r.ts || r.time || r.created_at || r.datetime || r.day) || '');
}

function recordAmount(r) {
  for (const k of ['amount', 'total', 'revenue', 'price', 'money', '金额']) {
    const v = parseFloat(r && r[k]);
    if (!isNaN(v)) return v;
  }
  return 0;
}

function mockReport(date) {
  return {
    ok: true,
    mock: true,
    date,
    banner: '演示数据：云端暂无店内快照，以下为 mock 经营日报',
    kpi: [
      { label: '营收', value: '¥12,580', delta: '+8.2%' },
      { label: '订单数', value: '286', delta: '+5.1%' },
      { label: '客单价', value: '¥43.99', delta: '+2.9%' },
      { label: '水饺销量', value: '1,820 只', delta: '+6.4%' },
      { label: '毛利率', value: '62.3%', delta: '+1.1%' },
      { label: '会员消费占比', value: '38%', delta: '+3.0%' },
      { label: '原料损耗率', value: '2.1%', delta: '-0.4%' },
      { label: '差评数', value: '1', delta: '-2' }
    ],
    heat_mini: [11, 12, 13, 17, 18, 19, 20].map((h, i) => ({ hour: h, orders: [32, 58, 41, 22, 49, 76, 53][i] })),
    todos: [
      { text: '推送店内快照后可查看真实日报', done: false },
      { text: '复核昨日库存盘点 warn 项', done: false },
      { text: '确认本周供应商比价结果', done: false }
    ],
    alerts: [{ level: 'info', text: '无快照数据，当前为 mock 报表' }]
  };
}

function deriveReport(snap, date) {
  const data = snap.data || {};
  const sales = Array.isArray(data.sales) ? data.sales : [];
  const recs = sales.filter((r) => recordDate(r).startsWith(date));
  const revenue = recs.reduce((s, r) => s + recordAmount(r), 0);
  const orders = recs.length;
  const avg = orders ? revenue / orders : 0;
  const dishes = Array.isArray(data.dishes) ? data.dishes.length : 0;
  const ings = Array.isArray(data.ings) ? data.ings.length : 0;
  const members = Array.isArray(data.members) ? data.members.length : 0;

  const byHour = {};
  for (const r of recs) {
    const m = recordDate(r).match(/[T\s](\d{2}):/);
    if (m) byHour[m[1]] = (byHour[m[1]] || 0) + 1;
  }
  const heat_mini = Object.keys(byHour).sort().map((h) => ({ hour: parseInt(h, 10), orders: byHour[h] }));

  const todos = [];
  if (orders === 0) todos.push({ text: '当日无销售记录，请确认 POS/店内同步是否正常', done: false });
  if (!Array.isArray(data.sales)) todos.push({ text: '快照缺少 sales 模块，请检查推送器字段', done: false });
  if (todos.length === 0) todos.push({ text: '数据正常，暂无待办', done: true });

  const alerts = [];
  const ageH = (Date.now() - new Date(snap.generated_at).getTime()) / 3600000;
  if (ageH > 24) alerts.push({ level: 'warn', text: '快照已超 24h 未更新（rev=' + snap.rev + '）' });

  const report = {
    ok: true,
    mock: false,
    date,
    rev: snap.rev,
    generated_at: snap.generated_at,
    banner: '熊猫五福餐厅 · ' + date + ' 经营日报（快照 rev=' + snap.rev + '）',
    kpi: [
      { label: '营收', value: '¥' + revenue.toFixed(2), delta: null },
      { label: '订单数', value: String(orders), delta: null },
      { label: '客单价', value: '¥' + avg.toFixed(2), delta: null },
      { label: '菜品SKU', value: String(dishes), delta: null },
      { label: '原料SKU', value: String(ings), delta: null },
      { label: '会员数', value: String(members), delta: null },
      { label: '快照rev', value: String(snap.rev), delta: null },
      { label: '销售记录总数', value: String(sales.length), delta: null }
    ],
    heat_mini,
    todos,
    alerts
  };

  // 厨房摘要：快照带 ext 时附今日工单统计，无 ext 跳过
  if (snap.ext && typeof snap.ext === 'object') {
    const wos = Array.isArray(snap.ext.sop_workorders) ? snap.ext.sop_workorders : [];
    const todays = wos.filter((w) => w && String(w.date || '') === date);
    report.kitchen = {
      workorders_total: todays.length,
      workorders_done: todays.filter((w) => w.status === '已完成').length
    };
  }

  return report;
}

async function handle(req, res, ctx, pathname) {
  if (req.method === 'GET' && pathname === '/api/report/daily') {
    const qdate = (ctx.query.get('date') || '').trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(qdate) ? qdate : todayStr();
    const snap = loadSnapshot();
    ctx.sendJSON(res, 200, snap ? deriveReport(snap, date) : mockReport(date));
    return true;
  }
  return false;
}

module.exports = { handle };
