'use strict';
/*
 * lib/supply.test.js — 供应链只读聚合的纯函数回归（零依赖，node 直跑）
 *
 * 覆盖 lib/supply.js：
 *   · compareReport：候选价统一折算「元/库存单位」（口径同 lib/price.js::quotePerStock）
 *     —— 不同口径（per=buy / stock）的报价必须折算后再比大小；
 *   · compareReport：单家报价 spread_pct 为 null（不构成比价，前端显示 `-`）；
 *   · compareReport：报价归属先按原料 id，回退按原料名（兼容历史「按名录入」脏数据）；
 *   · overviewReport：`compare.top` 只取真正有价差（候选 ≥ 2）的原料。
 *
 * 运行：node lib/supply.test.js
 */
const assert = require('assert');
const supply = require('./supply');

let failed = 0;
function ok(name, cond, got) {
  if (cond) { console.log('  ✓ ' + name); return; }
  failed++;
  console.error('  ✗ ' + name + '  got=' + JSON.stringify(got));
}

const ings = [
  { id: 'I1', name: '生抽', buy: '箱', conv: 10, unit: '瓶', avg: 12, on: true },
  { id: 'I2', name: '海天苹果醋450ml', buy: '瓶', conv: 1, unit: '瓶', avg: 6.48, on: true },
];
const data = {
  ings,
  /* I1 三档：1688 按箱 100（折 10/瓶）最低、京东按瓶 11、某批发按箱 120（折 12）最高；
     I2 仅一家（单家不构成比价）；Q9 为历史「按名录入」脏数据（ing = 原料名） */
  quotes: [
    { id: 'Q1', ing: 'I1', name: '生抽', src: '1688', price: 100, per: 'buy', unit: '箱', date: '2026-10-01', note: '含运' },
    { id: 'Q2', ing: 'I1', name: '生抽', src: '京东', price: 11, per: 'stock', unit: '瓶', date: '2026-10-05', note: '' },
    { id: 'Q3', ing: 'I1', name: '生抽', src: '批发商', price: 120, per: 'buy', unit: '箱', date: '2026-10-03', note: '' },
    { id: 'Q4', ing: 'I2', name: '海天苹果醋450ml', src: '测试商2', price: 6.44, per: 'buy', unit: '瓶', date: '2026-10-14', note: '' },
    { id: 'Q9', ing: '海天苹果醋450ml', src: '旧数据商', price: 6.9, per: 'buy', unit: '瓶', date: '2026-09-01', note: '' },
  ],
};
const SNAP = { ext: {}, data };

const cmp = supply.compareReport({}, data, {});
ok('compareReport 两个原料均有报价', cmp.available === 2, cmp.available);

const r1 = cmp.rows.find((r) => r.ingId === 'I1');
ok('compareReport I1 折算后最低 = 1688 ¥10/瓶', r1.best.src === '1688' && r1.best.perStock === 10, r1.best);
ok('compareReport I1 折算后最高 = 批发商 ¥12/瓶', r1.worst.src === '批发商' && r1.worst.perStock === 12, r1.worst);
ok('compareReport I1 价差 = (12−10)/10 = 20%', r1.spread_pct === 20, r1.spread_pct);
ok('compareReport I1 对比本店 = 10−12 = −2', r1.diff === -2, r1.diff);
ok('compareReport I1 候选按折价升序', r1.quotes.map((q) => q.perStock).join(',') === '10,11,12', r1.quotes.map((q) => q.perStock));
ok('compareReport I1 候选保留原报价与口径', r1.quotes[0].price === 100 && r1.quotes[0].per === 'buy' && r1.quotes[0].note === '含运', r1.quotes[0]);

const r2 = cmp.rows.find((r) => r.ingId === 'I2');
ok('compareReport I2 名称回退：按名录入的报价并入同一原料', r2.candidates === 2 && r2.name === '海天苹果醋450ml', r2);
ok('compareReport I2 显示名为原料名而非 id', r2.name !== 'I2', r2.name);
ok('compareReport I2 最低 = 6.44（测试商2）', r2.best.src === '测试商2' && r2.best.perStock === 6.44, r2.best);

/* 单家报价不构成比价：spread_pct 为 null（前端显示 `-`，不再误显 0%） */
const single = supply.compareReport({}, { ings: [ings[1]], quotes: [data.quotes[3]] }, {});
ok('compareReport 单家报价 spread_pct = null', single.rows[0].candidates === 1 && single.rows[0].spread_pct === null, single.rows[0]);

/* 无主数据的报价：回落按名称独立成组，不再丢失 */
const orphan = supply.compareReport({}, { ings: [], quotes: [{ ing: '未同步原料', price: 3, per: 'stock' }] }, {});
ok('compareReport 无主数据报价回落成组（conv=1）', orphan.available === 1 && orphan.rows[0].name === '未同步原料', orphan.rows);
ok('compareReport 无效报价（price<=0）不入比价', supply.compareReport({}, { ings: [], quotes: [{ ing: 'X', price: 0 }] }, {}).available === 0);

/* 旧口径兼容：ext.sup_prices（无 ing id、无 ings 主数据） */
const extOnly = supply.compareReport({ sup_prices: [{ ing_name: '面粉', vendor_id: 'A', price: 5 }, { ing_name: '面粉', vendor_id: 'B', price: 6 }] }, {}, {});
ok('compareReport ext.sup_prices 回落可用', extOnly.available === 1 && extOnly.rows[0].candidates === 2, extOnly.rows);

/* 汇总：最大价差只取真价差行 */
const ov = supply.overviewReport({}, data, {}, Date.parse('2026-10-14T00:00:00Z'));
ok('overviewReport compare.top 只取有价差原料（生抽）', ov.compare.top && ov.compare.top.name === '生抽' && ov.compare.top.spread_pct === 20, ov.compare.top);
const ovNoSpread = supply.overviewReport({}, { ings, quotes: [data.quotes[3]] }, {}, Date.now());
ok('overviewReport 全为单家报价时 top = null', ovNoSpread.compare.top === null, ovNoSpread.compare.top);

/* W3 产品超链接：供应商资质（certs）归一 + 临期分级（复用食安 certLevel/daysLeft） */
const NOW = Date.parse('2026-10-20T00:00:00Z');
const day = (n) => new Date(NOW + n * 86400000).toISOString().slice(0, 10);

ok('normCerts 数组归一（type/cert_no/expire_at/url）',
  JSON.stringify(supply.normCerts({ certs: [{ type: '营业执照', cert_no: 'A1', expire_at: '2026-12-31', url: 'http://x/a.jpg' }] })) ===
  JSON.stringify([{ type: '营业执照', cert_no: 'A1', expire_at: '2026-12-31', url: 'http://x/a.jpg' }]),
  supply.normCerts({ certs: [{ type: '营业执照', cert_no: 'A1', expire_at: '2026-12-31', url: 'http://x/a.jpg' }] }));

ok('normCerts 无证照返回 null', supply.normCerts({}) === null, supply.normCerts({}));

ok('certSummary 已逾期 = expired',
  supply.certSummary([{ type: '营业执照', expire_at: day(-5) }], NOW).level === 'expired',
  supply.certSummary([{ type: '营业执照', expire_at: day(-5) }], NOW));
ok('certSummary 3 天临期 = red',
  supply.certSummary([{ type: '食品经营许可', expire_at: day(3) }], NOW).level === 'red',
  supply.certSummary([{ type: '食品经营许可', expire_at: day(3) }], NOW));
ok('certSummary 10 天临期 = orange',
  supply.certSummary([{ type: '检验合格', expire_at: day(10) }], NOW).level === 'orange',
  supply.certSummary([{ type: '检验合格', expire_at: day(10) }], NOW));
ok('certSummary 60 天 = green',
  supply.certSummary([{ type: '营业执照', expire_at: day(60) }], NOW).level === 'green',
  supply.certSummary([{ type: '营业执照', expire_at: day(60) }], NOW));
ok('certSummary 无到期日 = unknown',
  supply.certSummary([{ type: '营业执照' }], NOW).level === 'unknown',
  supply.certSummary([{ type: '营业执照' }], NOW));

const vendData = {
  vendors: [
    { id: 'V1', name: '甲供应商', certs: [{ type: '营业执照', cert_no: 'A1', expire_at: day(-5) }] },
    { id: 'V2', name: '乙供应商', certs: [{ type: '食品经营许可', cert_no: 'B1', expire_at: day(3) }] },
    { id: 'V3', name: '丙供应商', certs: [{ type: '检验合格', cert_no: 'C1', expire_at: day(10) }] },
    { id: 'V4', name: '丁供应商', certs: [{ type: '营业执照', cert_no: 'D1', expire_at: day(60) }] }
  ]
};
const vr = supply.vendorsReport({}, vendData, {}, NOW);
const vr1 = vr.rows.find((v) => v.name === '甲供应商');
const vr4 = vr.rows.find((v) => v.name === '丁供应商');
ok('vendorsReport 每行挂 cert 分级', vr1.cert.level === 'expired' && vr4.cert.level === 'green', vr.rows.map((v) => v.name + ':' + v.cert.level));
ok('vendorsReport cert_expiring 只收 expired/red/orange 三档',
  vr.cert_expiring.length === 3 && vr.cert_expiring.every((c) => ['expired', 'red', 'orange'].indexOf(c.level) >= 0),
  vr.cert_expiring);
ok('vendorsReport 资质逾期 advice 提示',
  vr.advice.some((a) => /资质已逾期/.test(a)), vr.advice);

/* W3.4 看板临期告警：overview 透出 cert_expiring，告警数量与清单一致 */
const ovCert = supply.overviewReport({}, vendData, {}, NOW);
ok('overviewReport 透出 cert_expiring（只含 expired/red/orange）',
  Array.isArray(ovCert.cert_expiring) && ovCert.cert_expiring.length === 3
  && ovCert.cert_expiring.every((c) => ['expired', 'red', 'orange'].indexOf(c.level) >= 0),
  ovCert.cert_expiring);
ok('overviewReport 资质告警数量与临期清单一致（逾期优先）',
  ovCert.vendors.cert_expiring_count === ovCert.cert_expiring.length
  && ovCert.alerts.some((a) => /资质已逾期 1 家/.test(a.text)),
  ovCert.alerts);
ok('overviewReport 无临期资质时不误报资质告警',
  supply.overviewReport({}, { vendors: [{ id: 'V9', name: '戊', certs: [{ type: '营业执照', expire_at: day(90) }] }] }, {}, NOW)
    .alerts.every((a) => !/资质/.test(a.text)),
  supply.overviewReport({}, { vendors: [{ id: 'V9', name: '戊', certs: [{ type: '营业执照', expire_at: day(90) }] }] }, {}, NOW).alerts);

if (failed) { console.error('\n✗ ' + failed + ' 项失败'); process.exit(1); }
console.log('\n✓ supply.test.js 全部通过');
