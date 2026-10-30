'use strict';
/*
 * routes/export.test.js — 设置页只读导出端点的路由层回归测试（零依赖，node 直跑）
 *
 * 覆盖 routes/export.js（FP-SET-11/12/13/14 + M4-T4 留样台账）：
 *   · backup.json → 全量备份（快照原样，可直接回灌 /api/snapshot/push）
 *   · ings.csv    → 表头 + 行数（旧版 #btnCsvIng HTML:5296-5300）
 *   · dishes.csv  → 有配方=「配方」成本 / 无配方=「估算」；近 30 天销量聚合
 *   · sales.csv   → 全额收款口径（应收=实收=售价合计、欠款 0）/ 显式 payments 口径（欠款=应收−实收）
 *   · samples.csv → 留样台账（存放温度/封存人透出，越界温度原样导出）
 *   · 红线①：**只读** —— 五类导出前后 snapshot.json 字节完全一致（不写库、不入队）
 *   · 非 GET 不接管；未知路径不接管
 *
 * 运行：node routes/export.test.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bff-export-'));
process.env.BFF_DATA_DIR = dir;

const store = require('../lib/store');
const exp = require('./export');

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
const TODAY = todayStr();

const SNAP = {
  rev: 12,
  generated_at: '2026-10-10T00:00:00.000Z',
  data: {
    rest: '测试餐厅',
    ings: [
      { id: 'i1', name: '五花肉', cat: '鲜肉', buy: '斤', spec: '', conv: 1, unit: '斤', stock: 8, safe: 5, avg: 18.5, last: 19, yld: 100, on: true },
      { id: 'i2', name: '黄瓜', cat: '蔬菜', buy: '斤', spec: '', conv: 1, unit: '斤', stock: 0.7, safe: 1, avg: 3, last: 3.2, yld: 100, on: true }
    ],
    dishes: [
      { id: 'd1', name: '长寿饺', cat: '五福饺', price: 32, est: 9, on: true },
      { id: 'd2', name: '拍黄瓜', cat: '凉菜', price: 12, est: 3.5, on: true }
    ],
    sales: [
      { id: 's1', date: TODAY, hour: 12, dish: '长寿饺', qty: 2, amount: 64, channel: '堂食' },
      { id: 's2', date: TODAY, hour: 18, dish: '拍黄瓜', qty: 1, amount: 12, channel: '堂食',
        sub: 12, discount: 2, receivable: 12, payments: [{ amount: 10 }] }
    ],
    logs: [],
    recv: [],
    orders: [],
    quotes: []
  },
  ext: {
    recipes: [
      { sku_id: 'd1', name: '长寿饺', main: ['五花肉200g'], params: { '一批出成_个': 67 } }
    ],
    fs_samples: [
      { id: 1, date: '2026-10-10', meal: '午餐', dish: '长寿饺', weight_g: 125, keeper: '张三', kept_at: '2026-10-10T04:00:00.000Z', source: 'queue', hold_temp: 4.5, sealed_by: '张三/李四' },
      { id: 2, date: '2026-10-10', meal: '晚餐', dish: '拍黄瓜', weight_g: 220, keeper: '李四', kept_at: '2026-10-10T04:00:00.000Z', source: 'queue', hold_temp: 9.5, sealed_by: '王五' }
    ]
  }
};
store.writeJSON('snapshot.json', SNAP);
const bytesBefore = fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8');

function mkres() {
  return {
    code: 0,
    headers: {},
    body: null,
    writeHead(code, headers) { this.code = code; this.headers = headers || {}; },
    end(buf) { this.body = buf; },
  };
}
function mkctx() {
  return { auth: { role: '老板', account: 'u1' }, traceId: 't-export', query: new URLSearchParams('') };
}
async function call(pathname, method) {
  const res = mkres();
  const took = await exp.handle({ method: method || 'GET' }, res, mkctx(), pathname);
  return { res, took };
}
const text = (res) => String(res.body == null ? '' : res.body).replace(/^\uFEFF/, '');
const lines = (res) => text(res).split('\r\n').filter((l) => l !== '');

async function main() {
  let fail = 0;
  const ok = (name, cond, extra) => {
    if (!cond) { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
    else console.log('ok   ' + name);
  };

  /* ---- FP-SET-11 全量备份 JSON ---- */
  let { res, took } = await call('/api/export/backup.json');
  ok('backup.json 被接管且 200', took === true && res.code === 200, res.code);
  ok('backup.json Content-Type=json', /application\/json/.test(res.headers['Content-Type'] || ''), res.headers['Content-Type']);
  ok('backup.json 带附件文件名（含中文 filename*）',
    /attachment/.test(res.headers['Content-Disposition'] || '')
    && /filename\*=UTF-8''/.test(res.headers['Content-Disposition'] || ''), res.headers['Content-Disposition']);
  let backup = null;
  try { backup = JSON.parse(text(res)); } catch (e) { backup = null; }
  ok('backup.json 可解析且保留 data+ext（可回灌 push）',
    backup && backup.data && Array.isArray(backup.data.ings) && backup.ext && Array.isArray(backup.ext.recipes), backup && Object.keys(backup));
  ok('backup.json rev 透传', backup && backup.rev === 12, backup && backup.rev);

  /* ---- FP-SET-12 原料库存 CSV ---- */
  res = (await call('/api/export/ings.csv')).res;
  ok('ings.csv Content-Type=csv', /text\/csv/.test(res.headers['Content-Type'] || ''), res.headers['Content-Type']);
  ok('ings.csv 带 UTF-8 BOM', String(res.body).charCodeAt(0) === 0xfeff);
  let rows = lines(res);
  ok('ings.csv 表头 11 列（照抄旧版 HTML:5297）',
    rows[0] === '原料,分类,采购单位,规格,换算率,库存单位,当前库存,安全库存,均价,最近采购价,出成率', rows[0]);
  ok('ings.csv 数据行 = 原料数', rows.length === 3, rows.length);
  ok('ings.csv 行内容对齐（五花肉 / 8 / 18.5）',
    rows[1].split(',')[0] === '五花肉' && rows[1].split(',')[6] === '8' && rows[1].split(',')[8] === '18.5', rows[1]);

  /* ---- FP-SET-13 菜品成本毛利 CSV ---- */
  res = (await call('/api/export/dishes.csv')).res;
  rows = lines(res);
  ok('dishes.csv 表头 9 列（照抄旧版 HTML:5302）',
    rows[0] === '菜品,类型,成本来源,食材成本,售价,毛利率,配方原料数,近30天销量,近30天营收', rows[0]);
  const c1 = rows.find((l) => l.indexOf('长寿饺') === 0).split(',');
  const c2 = rows.find((l) => l.indexOf('拍黄瓜') === 0).split(',');
  ok('dishes.csv 有配方 → 成本来源=配方 且原料数>0', c1[2] === '配方' && Number(c1[6]) > 0, c1);
  ok('dishes.csv 配方成本 < 估算成本（1.66 < 9）', Number(c1[3]) < 9 && Number(c1[3]) > 0, c1[3]);
  ok('dishes.csv 无配方 → 成本来源=估算 且用 est', c2[2] === '估算' && Number(c2[3]) === 3.5, c2);
  ok('dishes.csv 售价取菜品售价', c1[4] === '32' && c2[4] === '12', [c1[4], c2[4]]);
  ok('dishes.csv 近30天销量聚合（长寿饺 2 / 拍黄瓜 1）', c1[7] === '2' && c2[7] === '1', [c1[7], c2[7]]);
  ok('dishes.csv 近30天营收聚合（64 / 12）', Number(c1[8]) === 64 && Number(c2[8]) === 12, [c1[8], c2[8]]);

  /* ---- FP-DISH-11/12 近30天销量/毛利额聚合（dishSalesAgg） ---- */
  const agg = exp.dishSalesAgg(SNAP);
  ok('dishSalesAgg 按 id 命中两菜', agg.byId && agg.byId.d1 && agg.byId.d2, agg.byId && Object.keys(agg.byId));
  ok('dishSalesAgg 按菜名命中两菜', agg.byName && agg.byName['长寿饺'] && agg.byName['拍黄瓜'], agg.byName && Object.keys(agg.byName));
  ok('dishSalesAgg 近30天销量（长寿饺 2 / 拍黄瓜 1）',
    agg.byId.d1.q30 === 2 && agg.byId.d2.q30 === 1, [agg.byId.d1.q30, agg.byId.d2.q30]);
  const d1cost = exp.dishCostMap(SNAP).byId.d1.cost;
  const d2cost = exp.dishCostMap(SNAP).byId.d2.cost;
  const rr2 = (n) => Math.round(n * 100) / 100;
  ok('dishSalesAgg 有配方毛利额 = 营收−配方成本×2（正、小于营收）',
    agg.byId.d1.gp30 === rr2(64 - d1cost * 2) && agg.byId.d1.gp30 > 0 && agg.byId.d1.gp30 < 64, agg.byId.d1.gp30);
  ok('dishSalesAgg 无配方毛利额 = 营收−est×销量（12−3.5=8.5）',
    agg.byId.d2.gp30 === rr2(12 - d2cost) && agg.byId.d2.gp30 === 8.5, agg.byId.d2.gp30);

  /* ---- FP-SET-14 销售应收实收 CSV ---- */
  res = (await call('/api/export/sales.csv')).res;
  rows = lines(res);
  ok('sales.csv 表头 12 列（照抄旧版 HTML:5309）',
    rows[0] === '单号,日期,渠道,菜品明细,售价合计,折扣,应收,实收,欠款,食材成本,毛利率,备注', rows[0]);
  ok('sales.csv 行数 = 销售行数', rows.length === 3, rows.length);
  const s1 = rows.find((l) => l.indexOf('s1') === 0).split(',');
  const s2 = rows.find((l) => l.indexOf('s2') === 0).split(',');
  ok('sales.csv 全额收款口径：应收=实收=售价合计、欠款 0、折扣空',
    Number(s1[4]) === 64 && Number(s1[6]) === 64 && Number(s1[7]) === 64 && Number(s1[8]) === 0 && s1[5] === '', s1);
  ok('sales.csv 显式 payments 口径：应收 12 / 实收 10 / 欠款 2',
    Number(s2[6]) === 12 && Number(s2[7]) === 10 && Number(s2[8]) === 2, s2);
  ok('sales.csv 折扣取显式 discount', s2[5] === '2', s2[5]);
  ok('sales.csv 菜品明细带菜名与份数', s1[3] === '长寿饺x2' && s2[3] === '拍黄瓜x1', [s1[3], s2[3]]);
  ok('sales.csv 食材成本按配方成本计', Number(s2[9]) > 0, s2[9]);
  ok('sales.csv 毛利率 4 位小数', /^\d\.\d{4}$/.test(s1[10]), s1[10]);

  /* ---- M4-T4 留样台账 CSV ---- */
  res = (await call('/api/export/samples.csv')).res;
  ok('samples.csv Content-Type=csv', /text\/csv/.test(res.headers['Content-Type'] || ''), res.headers['Content-Type']);
  rows = lines(res);
  ok('samples.csv 表头 10 列',
    rows[0] === '日期,餐次,菜品,克重(g),存放温度(℃),封存人,保管人,留样时间,到期时间,状态', rows[0]);
  ok('samples.csv 数据行 = 留样行数', rows.length === 3, rows.length);
  const sm1 = rows.find((l) => l.indexOf('长寿饺') >= 0).split(',');
  ok('samples.csv 存放温度/封存人透出（4.5 / 张三/李四）',
    sm1[4] === '4.5' && sm1[5] === '张三/李四', sm1);
  const sm2 = rows.find((l) => l.indexOf('拍黄瓜') >= 0).split(',');
  ok('samples.csv 越界温度原样透出（9.5）', sm2[4] === '9.5', sm2[4]);

  /* ---- W2-03 / FP-PRICE-11 待比价任务 JSON（panda-quote-task v1） ---- */
  res = (await call('/api/export/quote-task.json')).res;
  ok('quote-task.json 被接管且 200', res.code === 200, res.code);
  ok('quote-task.json Content-Type=json', /application\/json/.test(res.headers['Content-Type'] || ''), res.headers['Content-Type']);
  ok('quote-task.json 附件文件名含中文 filename*',
    /attachment/.test(res.headers['Content-Disposition'] || '')
    && /filename\*=UTF-8''/.test(res.headers['Content-Disposition'] || ''), res.headers['Content-Disposition']);
  let task = null;
  try { task = JSON.parse(text(res)); } catch (e) { task = null; }
  ok('quote-task 契约头：type=panda-quote-task / version=1',
    task && task.type === 'panda-quote-task' && task.version === 1, task && [task.type, task.version]);
  ok('quote-task rest 取 data.rest', task && task.rest === '测试餐厅', task && task.rest);
  ok('quote-task guide 指向 fetch_quotes.py（外部脚本可读）',
    !!task && /fetch_quotes\.py/.test(String(task.guide)) && /采购单位/.test(String(task.guide)));
  ok('quote-task items 覆盖在售原料 2 种', task && Array.isArray(task.items) && task.items.length === 2,
    task && task.items && task.items.length);
  const ITEM_KEYS = ['ingId', 'ingName', 'cat', 'unit', 'buy', 'conv', 'avg', 'keyword', 'taskDate'];
  ok('quote-task 单条字段与旧版契约一致（9 键）',
    !!task && task.items.every((it) => Object.keys(it).sort().join(',') === ITEM_KEYS.slice().sort().join(',')),
    task && task.items && Object.keys(task.items[0] || {}));
  ok('quote-task 关键词净化（五花肉 去规格/容量）',
    !!task && task.items.find((it) => it.ingId === 'i1').keyword === '五花肉', task && task.items[0].keyword);
  ok('quote-task taskDate = 今天', !!task && task.items.every((it) => it.taskDate === TODAY));
  /* 耗材不参与比价（W4 决策 #4）+ 停用原料不参与（旧版 DB.ings.filter(g=>g.on)） */
  const taskPartial = exp.quoteTaskPayload({
    data: {
      ings: [
        { id: 'i1', name: '五花肉', on: true, unit: '斤', buy: '斤', conv: 1, avg: 18.5 },
        { id: 'i9', name: '一次性手套', type: 'consumable', on: true, unit: '盒', buy: '盒', conv: 1, avg: 20 },
        { id: 'i3', name: '停用菜', on: false, unit: '斤', buy: '斤', conv: 1, avg: 2 }
      ],
      quotes: [],
    },
  });
  ok('quote-task 排除耗材与停用原料（只剩 1 种）',
    taskPartial.items.length === 1 && taskPartial.items[0].ingId === 'i1',
    taskPartial.items.map((x) => x.ingId));
  ok('quote-task 无 data.rest 时回落默认店名',
    exp.quoteTaskPayload({ data: { ings: [] } }).rest === '熊猫五福餐厅');

  /* ---- 红线①：五类导出全程只读 ---- */
  const bytesAfter = fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8');
  ok('红线：五类导出前后 snapshot.json 字节一致（不写库）', bytesBefore === bytesAfter);
  ok('红线：export 路由不导出写动作文件',
    !fs.existsSync(path.join(dir, 'actions_queue.json')));

  /* ---- 路由边界 ---- */
  const post = await call('/api/export/ings.csv', 'POST');
  ok('非 GET 不接管（只读）', post.took === false);
  const other = await call('/api/other');
  ok('未知路径不接管', other.took === false);

  /* ---- 辅助函数单测 ---- */
  ok('csv() 双引号/逗号/换行转义',
    exp.csv([['a,b', 'c"d', 'e\nf']]) === '\ufeff"a,b","c""d","e\nf"');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fail ? '== export 测试失败 ' + fail + ' 项 ==' : '== export 测试全部通过 ==');
  process.exit(fail ? 1 : 0);
}

main();
