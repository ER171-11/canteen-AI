#!/usr/bin/env node
'use strict';
/*
 * scripts/verify-w5-search.js — W5 检索域隔离 + 搜索索引字段管控 活体验证
 * 对真实运行的 BFF 打 /api/search 系列端点，打印核对结果（只读，零写库）。
 * 用法：node scripts/verify-w5-search.js [BFF_URL]  默认 http://127.0.0.1:8787
 */
const BFF = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ACCOUNT = process.env.BFF_ACCOUNT || 'boss';
const PASSWORD = process.env.BFF_PASSWORD || 'wufu123';

let failed = 0;
function ok(name, cond, detail) {
  if (cond) { console.log('  ✓ ' + name); return; }
  failed++;
  console.error('  ✗ ' + name + (detail != null ? '  got=' + JSON.stringify(detail) : ''));
}

async function api(path, token, method = 'GET') {
  const res = await fetch(BFF + path, {
    method,
    headers: token ? { Authorization: 'Bearer ' + token } : {}
  });
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  return { status: res.status, body };
}

(async () => {
  const login = await api('/api/auth/login', null, 'POST');
  // login 走 POST，需要带 body，这里单独处理
  const lres = await fetch(BFF + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: ACCOUNT, password: PASSWORD, device_fp: 'w5-verify' })
  });
  const lb = await lres.json();
  const token = lb && lb.token;
  ok('登录获取 token', !!token, lb);
  if (!token) { process.exit(1); }

  /* 1. 域枚举 */
  const doms = await api('/api/search/domains', token);
  ok('GET /api/search/domains 返回 6 域', doms.status === 200 && doms.body.domains.length === 6, doms.body);
  if (doms.body.domains) console.log('      ' + doms.body.domains.map((d) => d.key + '=' + d.label).join('  '));

  /* 2. 无 token 拦截 */
  const noauth = await api('/api/search?q=%E9%A5%BA', null);
  ok('无 token 返回 401（鉴权兜底）', noauth.status === 401, noauth.status);

  /* 3. 非法域 → 400 + 合法域清单 */
  const bad = await api('/api/search?domain=hack&q=x', token);
  ok('非法域 domain=hack 返回 400 + valid 清单', bad.status === 400 && Array.isArray(bad.body.valid), bad.body);

  /* 4. 全局分域检索 */
  const g = await api('/api/search?q=%E9%A5%BA', token);
  ok('全局检索「饺」返回分域结构', g.status === 200 && g.body.domain_order && g.body.domains, g.body);
  if (g.body.domains) {
    const line = g.body.domain_order.map((d) => d + '=' + g.body.domains[d].count).join('  ');
    console.log('      全局 total=' + g.body.total + '  ' + line);
  }

  /* 5. 单域检索不串味：sale 域只允许「销售单」类型 */
  const sale = await api('/api/search?domain=sale&q=%E9%A5%BA', token);
  if (sale.status === 200) {
    const kinds = (sale.body.result.hits || []).map((h) => h.kind);
    ok('sale 单域命中仅含「销售单」类型（不串味）',
      kinds.every((k) => k === '销售单'),
      kinds);
  }

  /* 6. 敏感字段隔离：对命中的每一条，matched_field 必须落在该域白名单内（永不等于敏感字段） */
  const SENSITIVE = new Set(['tax_no', 'tax', '税号', 'tax_id', 'internal_code', '内部编码', 'inner_code',
    'avg', 'last', 'cost', 'cost_price', '成本', '成本价', '进价', 'amount', 'amt', '金额', 'payable',
    'receivable', 'balance', '应付', '应收', '余额', 'salary', '薪资', '工资', 'pay', 'id_card', '身份证',
    'idcard', 'bank_account', '银行卡', 'bank', '账户']);
  let leak = [];
  for (const d of g.body.domain_order || []) {
    const r = await api('/api/search?domain=' + d + '&q=%E9%A5%BA', token);
    for (const h of (r.body.result && r.body.result.hits) || []) {
      if (SENSITIVE.has(h.matched_field)) leak.push(d + ':' + h.matched_field);
    }
  }
  ok('「饺」全部命中字段均非敏感字段（黑名单兜底）', leak.length === 0, leak);

  /* 7. 命中字段白名单抽查：打印前若干命中明细 */
  console.log('  命中明细抽查（procurement 域）：');
  const p = await api('/api/search?domain=procurement&q=%E9%A5%BA', token);
  (p.body.result.hits || []).slice(0, 6).forEach((h) =>
    console.log('    [' + h.kind + '] ' + h.title + (h.subtitle ? '  · ' + h.subtitle : '') + '  ← ' + h.matched_field));

  console.log('');
  if (failed) { console.error('✗ ' + failed + ' 项未通过'); process.exit(1); }
  console.log('✓ W5 活体验证全部通过（' + BFF + '）');
})();
