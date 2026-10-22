'use strict';
/*
 * routes/recv_import.test.js — 进货单批量导入**预览端点**的路由层回归测试（零依赖，node 直跑）
 *
 * 覆盖 POST /api/inventory/recv/import/preview（FP-RECV-02 预览阶段，0 写入）：
 *   · GET → 405（预览只接受 POST）
 *   · CSV base64 → 200 + groups/totalAmount；能按「供应商+日期」拆单
 *   · 未匹配原料 → 200 + 计入明细并标 isNew（自动建档为待完善草稿，不阻断；2026-10-12 撤销不代建偏离）
 *   · 手动指定列（旧版 openColMap 回归）：列名非标准 → 400 回传 head；override 重解析 → 200
 *   · 旧版二进制 .xls → 400 + 「另存为 .xlsx 或 CSV」提示（明确不支持的格式必须可见，红线⑥）
 *   · 缺 body / 文件超限 → 400 / 413
 *   · **红线：预览零写** —— data 目录文件数与 snapshot.json 字节内容在预览前后完全一致
 *
 * 为什么独立成文件：routes/run-tests.js 当前被「现场管理」在途改动占用，
 * 为避免混提交（单的主题原则），本测试独立跑：node bff/routes/recv_import.test.js
 * （已挂到 npm test:routes，见 bff/package.json）
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bff-recv-import-'));
process.env.BFF_DATA_DIR = dir;

const store = require('../lib/store');
const inventory = require('./inventory');

const SNAP = {
  rev: 7,
  generated_at: '2026-09-29T00:00:00.000Z',
  data: {
    ings: [
      { id: 'i1', name: '五花肉', unit: '斤', buy: '斤', stock: 0, avg: 0 },
      { id: 'i2', name: '青菜', unit: '斤', buy: '斤', stock: 0, avg: 0 }
    ],
    recv: [],
    orders: []
  }
};
store.writeJSON('snapshot.json', SNAP);
const snapBefore = fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8');

function mkctx() {
  return {
    auth: { role: '店长', account: 'u1' },
    traceId: 't-recv-import',
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

/** 超限桩：模拟 8MB 以上的上传体 */
function mkctxTooLarge() {
  const c = mkctx();
  c.readBody = async () => ({ tooLarge: true, buf: null });
  return c;
}

const GOOD_CSV = [
  '供应商,日期,原料名称,数量,单价',
  '海南菜篮子,2026-09-29,五花肉,10,30',
  '海南菜篮子,2026-09-29,青菜,5,4',
  '海口水产,2026-09-30,五花肉,1,30'
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
  const P = '/api/inventory/recv/import/preview';

  /* 1) 只接受 POST */
  let res = {};
  await inventory.handle({ method: 'GET' }, res, mkctx(), P);
  ok('预览端点 GET → 405', res.code === 405, res.body);

  /* 2) 正常 CSV → 200 + 分组 */
  res = {};
  await inventory.handle(
    { method: 'POST', __body: JSON.stringify({ fileName: 'a.csv', contentBase64: Buffer.from(GOOD_CSV, 'utf8').toString('base64') }) },
    res, mkctx(), P,
  );
  ok('CSV 预览 → 200', res.code === 200, res.body);
  ok('预览识别出 2 张单据（按 供应商+日期 拆单）',
    res.body && res.body.groups && res.body.groups.length === 2, res.body && res.body.groups);
  ok('预览合计 = 320 + 30 = 350',
    res.body && res.body.totalAmount === 350, res.body && res.body.totalAmount);
  ok('预览行数是 3 行', res.body && res.body.totalLines === 3, res.body);
  ok('原料已匹配到档案 id', res.body && res.body.groups[0].lines[0].ingId === 'i1', res.body);
  ok('预览不生成单号/id（留给执行器）',
    res.body && res.body.groups[0].no === undefined && res.body.groups[0].id === undefined, res.body);

  /* 3) 未匹配原料 → 200 + 计入 groups（自动建档，不阻断；回归旧版 createIngFromImport 语义） */
  res = {};
  await inventory.handle(
    {
      method: 'POST',
      __body: JSON.stringify({
        fileName: 'a.csv',
        contentBase64: Buffer.from('原料名称,数量,单价\n挪威三文鱼,1,99\n', 'utf8').toString('base64')
      })
    },
    res, mkctx(), P,
  );
  ok('全部原料未匹配 → 仍 200（自动建档，不阻断）', res.code === 200, res.body);
  ok('未匹配行计入 groups 且标 isNew',
    res.body && res.body.groups[0].lines[0].isNew === true, res.body && res.body.groups);
  ok('响应登记 newIngs（挪威三文鱼）',
    res.body && res.body.newIngs && res.body.newIngs[0] && res.body.newIngs[0].name === '挪威三文鱼', res.body && res.body.newIngs);

  /* 4) 旧版二进制 .xls → 明确「不支持」，提示另存为 */
  res = {};
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(600)]).toString('base64');
  await inventory.handle(
    { method: 'POST', __body: JSON.stringify({ fileName: 'old.xls', contentBase64: ole }) },
    res, mkctx(), P,
  );
  ok('二进制 .xls → 400', res.code === 400, res.body);
  ok('二进制 .xls 明确提示另存为 xlsx/CSV', /另存为 \.xlsx 或 CSV/.test(res.body && res.body.error || ''), res.body);

  /* 5) 缺内容 / 坏 JSON → 400 */
  res = {};
  await inventory.handle({ method: 'POST', __body: '' }, res, mkctx(), P);
  ok('空 body → 400', res.code === 400, res.body);
  res = {};
  await inventory.handle({ method: 'POST', __body: '{oops' }, res, mkctx(), P);
  ok('非法 JSON → 400', res.code === 400, res.body);

  /* 6) 超限 → 413 */
  res = {};
  await inventory.handle({ method: 'POST', __body: '{}' }, res, mkctxTooLarge(), P);
  ok('上传体超限 → 413', res.code === 413, res.body);

  /* 6.5) 手动指定列（旧版 openColMap 回归）：列名非标准 → 自动识别失败回传 head；override 重解析成功 */
  const WEIRD_CSV = 'a,b,c\n娃娃菜,5,3\n猪里脊,2,30\n';
  res = {};
  await inventory.handle(
    {
      method: 'POST',
      __body: JSON.stringify({ fileName: 'w.csv', contentBase64: Buffer.from(WEIRD_CSV, 'utf8').toString('base64') })
    },
    res, mkctx(), P,
  );
  ok('非标准列名自动识别 → 400', res.code === 400, res.body);
  ok('失败时回传 head（供手动指定列面板）',
    res.body && res.body.head && Array.isArray(res.body.head.rows) && res.body.head.rows.length >= 2, res.body);
  ok('head 带 fields/labels/aliases',
    res.body && res.body.head && Array.isArray(res.body.head.fields)
      && res.body.head.fields.indexOf('ingName') >= 0
      && res.body.head.labels && res.body.head.labels.ingName
      && res.body.head.aliases && Array.isArray(res.body.head.aliases.ingName), res.body && res.body.head);

  res = {};
  await inventory.handle(
    {
      method: 'POST',
      __body: JSON.stringify({
        fileName: 'w.csv',
        contentBase64: Buffer.from(WEIRD_CSV, 'utf8').toString('base64'),
        override: { rowIndex: 0, map: { ingName: 0, qty: 1, price: 2 } }
      })
    },
    res, mkctx(), P,
  );
  ok('手动指定列（a=品名 b=数量 c=单价）→ 200', res.code === 200, res.body);
  ok('手动指定列解析出 2 行', res.body && res.body.totalLines === 2, res.body);
  ok('手动指定列正确取数（娃娃菜 5×3）',
    res.body && res.body.groups[0].lines[0].name === '娃娃菜'
      && res.body.groups[0].lines[0].qty === 5
      && res.body.groups[0].lines[0].price === 3, res.body && res.body.groups);
  ok('手动指定列响应同样带 head', res.body && res.body.head && Array.isArray(res.body.head.rows), res.body);

  /* 7) 红线：预览零写 —— 目录文件数与 snapshot 内容都没变 */
  const filesAfter = fs.readdirSync(dir).sort();
  const snapAfter = fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8');
  ok('预览零写：数据目录仍只有 snapshot.json', filesAfter.length === 1 && filesAfter[0] === 'snapshot.json', filesAfter);
  ok('预览零写：snapshot.json 字节内容未被改动', snapAfter === snapBefore);

  console.log('\n== recv/import preview 路由测试' + (fail ? ' 存在失败项：' + fail : '全部通过') + ' ==');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
