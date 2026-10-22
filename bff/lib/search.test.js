'use strict';
/*
 * lib/search.test.js — W5 检索域隔离 + 搜索索引字段白名单（零依赖，node 直跑）
 *
 * 覆盖 lib/search.js：
 *   · 敏感字段（税号/内部编码/成本价/金额/薪资）永不进搜索索引
 *   · 名称/规格等白名单字段可正常检索
 *   · 域隔离：单域检索不串味；全局检索分域返回
 *
 * 运行：node lib/search.test.js
 */
const assert = require('assert');
const search = require('./search');

let failed = 0;
function ok(name, cond, got) {
  if (cond) { console.log('  ✓ ' + name); return; }
  failed++;
  console.error('  ✗ ' + name + '  got=' + JSON.stringify(got));
}

const ext = {
  recipes: [{ sku_id: 'SKU1', name: '五福饺子' }],
  sup_accounts: [
    { id: 'A1', vendor_id: '甲乙供应商', kind: '应付', amount: 12345, tax_no: 'TX-888' }
  ],
  fin_invoices: [
    { id: 'F1', invoice_no: 'INV-001', type: '专票', tax_no: 'TX-777', amount: 9999 }
  ]
};
const data = {
  ings: [
    { id: 'I1', name: '东北酸菜', cat: '蔬菜', spec: '切丝', sup: '甲乙供应商', avg: 12.5, buy: '箱' },
    { id: 'I2', name: '食用墨鱼汁', cat: '调料', avg: 80 }
  ],
  vendors: [
    { id: 'V1', name: '甲乙供应商', category: '干调', tax_no: 'TX-999', internal_code: 'INNER-123' }
  ],
  recv: [
    { id: 'R1', order_id: 'PO-001', supplier: '甲乙供应商', amount: 5000, status: '已入库' }
  ],
  staff: [
    { id: 'S1', name: '张三', role: '厨师', salary: 8000, id_card: '110101199001011234' }
  ],
  sales: [
    { id: 'SA1', order_no: 'SO-1', dish: '全家福水饺', amount: 88, status: '已完成' }
  ]
};

/* 域枚举 */
ok('6 个业务域 + 中文标签',
  search.DOMAINS.length === 6 && search.DOMAIN_LABEL.procurement === '商品采购' && search.DOMAIN_LABEL.sale === '销售',
  search.DOMAINS);
ok('validDomain 校验', search.validDomain('procurement') === 'procurement' && search.validDomain('hack') === null);

/* 敏感字段永不进索引 */
ok('税号 TX-999 不入索引（供应商）', search.searchAll('TX-999', ext, data).total === 0);
ok('税号 TX-777 不入索引（发票）', search.searchAll('TX-777', ext, data).total === 0);
ok('内部编码 INNER-123 不入索引', search.searchAll('INNER-123', ext, data).total === 0);
ok('成本价 12.5 不入索引（原料 avg）', search.searchAll('12.5', ext, data).total === 0);
ok('金额 5000 不入索引（进货单 amount）', search.searchAll('5000', ext, data).total === 0);
ok('薪资 8000 不入索引（员工 salary）', search.searchAll('8000', ext, data).total === 0);
ok('身份证号不入索引', search.searchAll('110101', ext, data).total === 0);

/* 白名单字段可检索 */
ok('原料名「东北酸菜」可检索', search.searchAll('东北酸菜', ext, data).domains.procurement.count >= 1, search.searchAll('东北酸菜', ext, data).domains.procurement.count);
ok('供应商名「甲乙供应商」可检索', search.searchAll('甲乙供应商', ext, data).total >= 1, search.searchAll('甲乙供应商', ext, data).total);
ok('菜谱名「五福饺子」可检索', search.searchAll('五福饺子', ext, data).domains.procurement.count >= 1);
ok('销售单号 SO-1 可检索', search.searchDomain('sale', 'SO-1', ext, data).count === 1);

/* 域隔离：单域检索不串味 */
const proc = search.searchDomain('procurement', '甲乙供应商', ext, data);
ok('procurement 域命中 2 条（原料 sup + 供应商 name）',
  proc.count === 2 && proc.hits.every((h) => h.kind === '原料' || h.kind === '供应商'),
  proc.hits.map((h) => h.kind));
const fin = search.searchDomain('finance', '甲乙供应商', ext, data);
ok('finance 域命中 2 条（进货单 supplier + 往来账 vendor_id）',
  fin.count === 2 && fin.hits.every((h) => h.kind === '进货单' || h.kind === '往来账'),
  fin.hits.map((h) => h.kind));
ok('procurement 域不含财务记录', proc.hits.every((h) => h.kind !== '进货单' && h.kind !== '往来账'));

/* 全局分域：不跨域混排，命中集中在其所属域 */
const all = search.searchAll('甲乙供应商', ext, data);
ok('全局检索分域返回（procurement=2, finance=2, 其余=0）',
  all.domains.procurement.count === 2 && all.domains.finance.count === 2 &&
  all.domains.foodsafety.count === 0 && all.domains.staff.count === 0 && all.domains.equipment.count === 0 && all.domains.sale.count === 0,
  Object.keys(all.domains).map((k) => k + '=' + all.domains[k].count));

if (failed) { console.error('\n✗ ' + failed + ' 项失败'); process.exit(1); }
console.log('\n✓ search.test.js 全部通过');
