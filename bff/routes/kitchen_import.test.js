'use strict';
/*
 * routes/kitchen_import.test.js — 食谱卡批量导入**预览端点**的路由层回归（零依赖，node 直跑）
 *
 * 覆盖 POST /api/kitchen/recipes/import/preview（FP-DISH-16 预览阶段，0 写入）：
 *   · GET → 405（预览只接受 POST）
 *   · CSV base64 → 200 + groups / newIngs / newDishes；按「菜品名称」分组、菜名合并补齐
 *   · 列名古怪 → 400 且文案给出「手动指定列」出路（绝不静默吞）
 *   · override 手动指定列 → 200
 *   · 旧版二进制 .xls → 400 + 「另存为 .xlsx 或 CSV」提示（不支持的格式必须可见，红线⑥）
 *   · 缺 body / 文件超限 → 400 / 413
 *   · 回归：同路由 GET /api/kitchen/recipes 仍 200（未破坏只读路由）
 *   · **红线：预览零写** —— data 目录文件数与 snapshot.json 字节内容在预览前后完全一致
 *
 * 运行：node bff/routes/kitchen_import.test.js（已挂 npm test）
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bff-kitchen-import-'));
process.env.BFF_DATA_DIR = dir;

const store = require('../lib/store');
const kitchen = require('./kitchen');

const SNAP = {
  rev: 11,
  generated_at: '2026-10-13T00:00:00.000Z',
  data: {
    ings: [
      { id: 'i1', name: '文昌鸡', unit: '斤', stock: 0, avg: 0 },
      { id: 'i2', name: '蕨根粉', unit: '斤', stock: 0, avg: 0 }
    ],
    dishes: [
      { id: 'D1', name: '白切文昌鸡', cat: '爆品', price: 98, on: true },
      { id: 'D2', name: '酸辣蕨根粉', cat: '引流', price: 18, on: true }
    ],
    rec: {}
  },
  ext: { recipes: [] }
};
store.writeJSON('snapshot.json', SNAP);
const snapBefore = fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8');

function mkctx() {
  return {
    auth: { role: '店长', account: 'u1' },
    traceId: 't-kitchen-import',
    query: new Map(),
    sendJSON: (res, code, obj) => {
      res.code = code;
      res.body = obj;
    },
    readBody: async (req) => ({
      tooLarge: false,
      buf: Buffer.from(String(req.__body == null ? '' : req.__body), 'utf8')
    })
  };
}
function mkctxTooLarge() {
  const c = mkctx();
  c.readBody = async () => ({ tooLarge: true, buf: null });
  return c;
}

const P = '/api/kitchen/recipes/import/preview';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const GOOD_CSV = [
  '菜品名称,菜品分类,原料名称,净料用量,库存单位,原料分类',
  '白切文昌鸡,爆品,文昌鸡,0.6,斤,鲜肉类',
  ',,生姜,0.02,斤,蔬菜类',
  '酸辣蕨根粉,引流,蕨根粉,0.2,斤,干货类'
].join('\n');

async function main() {
  let fail = 0;
  const ok = (name, cond, extra) => {
    if (!cond) {
      fail++;
      console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
    } else {
      console.log('ok   ' + name);
    }
  };

  /* 0) 回归：只读 GET 路由未受影响 */
  let res = {};
  await kitchen.handle({ method: 'GET' }, res, mkctx(), '/api/kitchen/recipes');
  ok('GET /api/kitchen/recipes 仍 200', res.code === 200, res.body && res.body.error);

  /* 1) 预览只接受 POST */
  res = {};
  await kitchen.handle({ method: 'GET' }, res, mkctx(), P);
  ok('预览端点 GET → 405', res.code === 405, res.body);

  /* 2) 正常 CSV → 200 + 分组 + 自动建档清单 */
  res = {};
  await kitchen.handle(
    { method: 'POST', __body: JSON.stringify({ fileName: 'recipes.csv', contentBase64: b64(GOOD_CSV) }) },
    res, mkctx(), P
  );
  ok('CSV 预览 → 200', res.code === 200, res.body);
  ok('按菜品分组 = 2 道', res.body && res.body.groups && res.body.groups.length === 2, res.body && res.body.groups);
  ok('菜名合并补齐（白切文昌鸡 2 行）', res.body && res.body.groups[0].lines.length === 2, res.body && res.body.groups[0]);
  ok('已有菜品不标记新增', res.body && res.body.groups[0].isNewDish === false, res.body && res.body.newDishes);
  ok('未匹配原料进 newIngs（生姜）', res.body && res.body.newIngs.length === 1
    && res.body.newIngs[0].name === '生姜', res.body && res.body.newIngs);
  ok('已有原料回填 unit=斤', res.body && res.body.groups[0].lines[0].unit === '斤', res.body && res.body.groups[0].lines[0]);
  ok('明细 3 行', res.body && res.body.totalLines === 3, res.body);
  ok('响应带 head（供手动指定列）', res.body && res.body.head && res.body.head.headerRowIndex === 0, res.body && res.body.head);

  /* 3) 列名古怪 → 400 且给出「手动指定列」出路 */
  res = {};
  await kitchen.handle(
    { method: 'POST', __body: JSON.stringify({ fileName: 'weird.csv', contentBase64: b64('菜,料,量\n老虎菜,青椒,200') }) },
    res, mkctx(), P
  );
  ok('列名古怪 → 400', res.code === 400, res.body);
  ok('文案给出「手动指定列」出路', /手动指定列/.test((res.body && res.body.error) || ''), res.body);

  /* 4) override 手动指定列 → 200 */
  res = {};
  await kitchen.handle({
    method: 'POST',
    __body: JSON.stringify({
      fileName: 'weird.csv',
      contentBase64: b64('菜,料,量\n老虎菜,青椒,200'),
      override: { rowIndex: 0, map: { dish: 0, ingName: 1, qty: 2 } }
    })
  }, res, mkctx(), P);
  ok('手动指定列 → 200', res.code === 200, res.body);
  ok('手动指定列解析出新菜（老虎菜）', res.body && res.body.newDishes[0] === '老虎菜', res.body && res.body.newDishes);

  /* 5) 旧版二进制 .xls → 400 且明确提示另存为 */
  res = {};
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(600)]).toString('base64');
  await kitchen.handle({ method: 'POST', __body: JSON.stringify({ fileName: 'old.xls', contentBase64: ole }) }, res, mkctx(), P);
  ok('二进制 .xls → 400', res.code === 400, res.body);
  ok('提示另存为 xlsx/CSV', /另存为 \.xlsx 或 CSV/.test((res.body && res.body.error) || ''), res.body);

  /* 6) 缺内容 / 坏 JSON → 400；超限 → 413 */
  res = {};
  await kitchen.handle({ method: 'POST', __body: '' }, res, mkctx(), P);
  ok('空 body → 400', res.code === 400, res.body);
  res = {};
  await kitchen.handle({ method: 'POST', __body: '{oops' }, res, mkctx(), P);
  ok('非法 JSON → 400', res.code === 400, res.body);
  res = {};
  await kitchen.handle({ method: 'POST', __body: '{}' }, res, mkctxTooLarge(), P);
  ok('上传体超限 → 413', res.code === 413, res.body);

  /* 7) 红线：预览零写 */
  const filesAfter = fs.readdirSync(dir).sort();
  const snapAfter = fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8');
  ok('预览零写：数据目录仍只有 snapshot.json', filesAfter.length === 1 && filesAfter[0] === 'snapshot.json', filesAfter);
  ok('预览零写：snapshot.json 字节内容未被改动', snapAfter === snapBefore);

  console.log('\n== kitchen/recipes/import preview 路由测试' + (fail ? ' 存在失败项：' + fail : '全部通过') + ' ==');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
