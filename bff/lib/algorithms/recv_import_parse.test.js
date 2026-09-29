'use strict';
/*
 * lib/recv_import.js（进货单批量导入解析层）行为契约测试。
 *
 * 这些用例锁的是 **lib 层的解析口径**（对齐旧版 HTML:2741-3800 的同类函数），与执行器
 * recv.import（见 recv_import.test.js）分属两层：
 *   · 解析层——纯计算、**零写**；会把多行 Sheeet 归一成 [{supplier,date,note,lines}]
 *   · 执行层——走审批队列后才改账面
 *
 * 重点覆盖：
 *   ① CSV / TSV：引号、BOM、CRLF（parseCsvText ← 旧版 parseCsv :2752）
 *   ② 表头自动识别 + 别名；缺必填列（品名/单价）必须显式报错，绝不猜（红线⑥）
 *   ③ 表内自带 供应商/日期 → 按「供应商+日期」拆单（:3405-3418）
 *   ④ recvQty：× / 未收 → 整行不进单；「原4包改3包」→ 3（:2792）
 *   ⑤ JSON / 网页表格（伪 .xls）/ .xlsx（ZIP+XML）三条输入通道
 *   ⑥ 旧版二进制 .xls 明确报错（Node 侧未移植 BIFF8），不得静默当成空文件
 *   ⑦ 未匹配原料：剔除并列清单，不代建（previewImport 的差异说明）
 *
 * 用法：node bff/lib/algorithms/recv_import_parse.test.js
 */
const assert = require('assert');
const zlib = require('zlib');
const ri = require('../recv_import');

/* ---------------- 极简 ZIP 打包（只为把 .xlsx 喂给被测解析器） ---------------- */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function buildZip(entries) {
  const body = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data, 'utf8');
    const nameBuf = Buffer.from(e.name, 'utf8');
    const stored = e.method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(e.method, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(stored.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    body.push(lfh, nameBuf, stored);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(e.method, 10);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(stored.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + stored.length;
  }
  const cfh = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cfh.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, cfh, eocd]);
}

const INGS = [
  { id: 'i1', name: '五花肉', unit: '斤' },
  { id: 'i2', name: '青菜', unit: '斤' },
  { id: 'i3', name: '生姜', unit: '斤' }
];

let pass = 0;
function ok(name, fn) {
  fn();
  pass++;
  console.log('  PASS ' + name);
}

/* ① CSV：BOM、CRLF、带引号的量词/逗号 */
ok('CSV 解析：BOM/CRLF/引号内的逗号都能正确切分', () => {
  const rows = ri.parseCsvText('\ufeff原料名称,数量,单价\r\n"五花肉, 冷鲜",10,30\r\n'.replace(/\\r/g, '\r'));
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0][0], '原料名称');
  assert.strictEqual(rows[1][0], '五花肉, 冷鲜');
  assert.strictEqual(rows[1][2], '30');
  /* TSV 自动识别 */
  const tsv = ri.parseCsvText('原料名称\t数量\t单价\n青菜\t2\t3.5\n');
  assert.strictEqual(tsv[1][0], '青菜');
  assert.strictEqual(tsv[1][2], '3.5');
});

/* ② 缺必填列（单价）：显式报错，不猜 */
ok('缺「单价」必填列：返回 err 且 docs 为空（不静默解析）', () => {
  const csv = '原料名称,数量\n五花肉,10\n';
  const r = ri.parseImportFile(Buffer.from(csv, 'utf8'), 'a.csv');
  assert.ok(r.err, '应有 err');
  assert.ok(/未识别到进货单表头/.test(r.err), r.err);
  assert.strictEqual(r.docs.length, 0);
});

/* ③ 表内自带供应商/日期 → 拆成多张单据 */
ok('按「供应商+日期」拆单：两供应商两日期 → 2 张', () => {
  const csv = [
    '供应商,日期,原料名称,数量,单价',
    '海南菜篮子,2026-09-29,五花肉,10,30',
    '海南菜篮子,2026-09-29,青菜,5,4',
    '海口水产,2026-09-30,生姜,2,8'
  ].join('\n');
  const r = ri.parseImportFile(Buffer.from(csv, 'utf8'), 'a.csv');
  assert.ok(!r.err, 'err=' + r.err);
  assert.strictEqual(r.docs.length, 2);
  assert.strictEqual(r.docs[0].supplier, '海南菜篮子');
  assert.strictEqual(r.docs[0].date, '2026-09-29');
  assert.strictEqual(r.docs[0].lines.length, 2);
  assert.strictEqual(r.docs[1].supplier, '海口水产');
  const pv = ri.buildPreview(r.docs, INGS);
  assert.strictEqual(pv.groups.length, 2);
  assert.strictEqual(pv.totalLines, 3);
  assert.strictEqual(pv.totalAmount, 320 + 16);
  assert.strictEqual(pv.groups[0].lines[0].ingId, 'i1');
  assert.strictEqual(pv.bad, 0);
  assert.strictEqual(pv.unmatched.length, 0);
});

/* ④ recvQty 语义：× → 不进单；改X → 取改后数；空白 → 回落到下单数 */
ok('recvQty：×/未收剔除整行，「原4包改3包」取 3，空白回落到数量', () => {
  const csv = [
    '原料名称,实收数,下单数,数量,单价',
    '五花肉,×,4,4,30',
    '青菜,原4包改3包,4,4,4',
    '生姜,,2,2,8'
  ].join('\n');
  const r = ri.parseImportFile(Buffer.from(csv, 'utf8'), 'a.csv');
  assert.ok(!r.err, 'err=' + r.err);
  assert.strictEqual(r.skipped, 1, '× 行应被跳过');
  const lines = r.docs[0].lines;
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].qty, 3);
  assert.strictEqual(lines[1].qty, 2);
  /* 噪声行（合计/签收）不得进入明细 */
  const noisy = ri.parseImportFile(
    Buffer.from('原料名称,数量,单价\n合计,999,999\n五花肉,1,10\n', 'utf8'),
    'a.csv'
  );
  assert.strictEqual(noisy.docs[0].lines.length, 1);
  assert.strictEqual(noisy.docs[0].lines[0].ingName, '五花肉');
  /* 「数量不是数字」= 数据错误，必须计 bad（redo 旧版一股脑算 skipped 的口径：新版要显式区分） */
  const garbage = ri.parseImportFile(
    Buffer.from('原料名称,数量,单价\n五花肉,abc,30\n青菜,2,4\n', 'utf8'),
    'a.csv'
  );
  assert.strictEqual(garbage.bad, 1, '非数字数量应计 bad');
  assert.strictEqual(garbage.skipped, 0);
  const pv = ri.previewImport(
    { contentBase64: Buffer.from('原料名称,数量,单价\n五花肉,abc,30\n青菜,2,4\n', 'utf8').toString('base64') },
    INGS
  );
  assert.strictEqual(pv.ok, true);
  assert.strictEqual(pv.bad, 1);
  assert.strictEqual(pv.totalLines, 1, '坏行不得进入明细');
  assert.strictEqual(pv.groups[0].lines[0].name, '青菜');
});

/* ⑤ JSON 通道：{pos:[{supplier,date,lines:[…]}]} */
ok('JSON 通道：{pos:[…]} 结构可解析（含中文键别名）', () => {
  const text = JSON.stringify({
    pos: [{
      供应商: '海南菜篮子',
      日期: '2026-09-29',
      lines: [{ 原料名称: '五花肉', 数量: 2, 单价: 30 }]
    }]
  });
  const r = ri.parseImportFile(Buffer.from(text, 'utf8'), 'a.json');
  assert.strictEqual(r.format, 'json');
  assert.ok(!r.err, 'err=' + r.err);
  assert.strictEqual(r.docs[0].supplier, '海南菜篮子');
  assert.strictEqual(r.docs[0].date, '2026-09-29');
  const pv = ri.buildPreview(r.docs, INGS);
  assert.strictEqual(pv.groups[0].lines[0].amount, 60);
});

/* ⑥ 网页表格（供应商导出的「伪 .xls」） */
ok('网页表格通道：colspan 补位；表头可识别时正常预览', () => {
  const html = '<html><body><table>'
    + '<tr><td>原料名称</td><td colspan="2">数量与单价</td></tr>'
    + '<tr><td>青菜</td><td>3</td><td>4.5</td></tr>'
    + '</table></body></html>';
  const parsed = ri.parseHtmlTables(html);
  /* colspan=2 → 该行补成 3 个单元格 */
  assert.strictEqual(parsed.sheets[0].rows[0].length, 3);
  assert.strictEqual(parsed.sheets[0].rows[0][2], '');
  /* 合并表头导致「单价」列无法定位 → 必须显式报错（不猜列） */
  const r = ri.parseImportFile(Buffer.from(html, 'utf8'), 'order.xls');
  assert.strictEqual(r.format, 'html');
  assert.ok(r.err, '合并表头缺「单价」列时应报错');
  const html2 = '<html><body><table>'
    + '<tr><td>原料名称</td><td>数量</td><td>单价</td></tr>'
    + '<tr><td>青菜</td><td>3</td><td>4.5</td></tr>'
    + '</table></body></html>';
  const r2 = ri.parseImportFile(Buffer.from(html2, 'utf8'), 'order.xls');
  assert.ok(!r2.err, 'err=' + r2.err);
  const pv = ri.buildPreview(r2.docs, INGS);
  assert.strictEqual(pv.groups.length, 1);
  assert.strictEqual(pv.groups[0].lines[0].name, '青菜');
  assert.strictEqual(pv.groups[0].payable, 13.5);
});

/* ⑦ .xlsx（ZIP + XML，含 sharedStrings 与稀疏列） */
ok('.xlsx 通道：sharedStrings + 稀疏列 + deflate 解压均可读', () => {
  const shared = '<?xml version="1.0"?><sst><si><t>原料名称</t></si><si><t>数量</t></si>'
    + '<si><t>单价</t></si><si><t>备注</t></si><si><t>五花肉</t></si></sst>';
  const sheet = '<?xml version="1.0"?><worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>'
    /* E2 跳过了 D 列：验证稀疏单元格按列字母定位并补空，不影响必填列取值 */
    + '<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2"><v>2</v></c><c r="C2"><v>15</v></c><c r="E2"><v>是 authored</v></c></row>'
    + '</sheetData></worksheet>';
  const zip = buildZip([
    { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="明细"/></sheets></workbook>', method: 0 },
    { name: 'xl/sharedStrings.xml', data: shared, method: 0 },
    { name: 'xl/worksheets/sheet1.xml', data: sheet, method: 8 }
  ]);
  const src = ri.loadRowSource(zip, 'order.xlsx');
  assert.strictEqual(src.format, 'xlsx');
  assert.strictEqual(src.sheets[0].name, '明细');
  assert.strictEqual(src.sheets[0].rows[0][0], '原料名称');
  /* E2 跳过了 D 列 → 稀疏单元格按列字母补位 */
  assert.strictEqual(src.sheets[0].rows[1][3], '');
  assert.strictEqual(src.sheets[0].rows[1][4], '是 authored');
  const r = ri.parseImportFile(zip, 'order.xlsx');
  assert.ok(!r.err, 'err=' + r.err);
  const pv = ri.buildPreview(r.docs, INGS);
  assert.strictEqual(pv.groups.length, 1);
  assert.strictEqual(pv.groups[0].lines[0].qty, 2);
  assert.strictEqual(pv.groups[0].lines[0].price, 15);
});

/* ⑧ 旧版二进制 .xls：明确报错（不得静默当空文件） */
ok('二进制 .xls（OLE2）：返回明确错误，提示另存为 xlsx/CSV', () => {
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(600)]);
  const r = ri.parseImportFile(ole, 'old.xls');
  assert.ok(r.err, '必须有明确 err');
  assert.ok(/另存为 \.xlsx 或 CSV/.test(r.err), r.err);
  const pv = ri.previewImport({ contentBase64: ole.toString('base64'), fileName: 'old.xls' }, INGS);
  assert.strictEqual(pv.ok, false);
  assert.ok(/另存为/.test(pv.error), pv.error);
});

/* ⑨ 未匹配原料：剔除并给出清单，不代建 */
ok('未匹配原料：剔除、列清单、bad 计数；全部未匹配则返回可读错误', () => {
  const csv = '原料名称,数量,单价\n五花肉,1,10\n挪威三文鱼,1,99\n南极冰菜,0,5\n';
  const r = ri.parseImportFile(Buffer.from(csv, 'utf8'), 'a.csv');
  const pv = ri.buildPreview(r.docs, INGS);
  assert.strictEqual(pv.unmatched.length, 1);
  assert.strictEqual(pv.unmatched[0], '挪威三文鱼');
  assert.strictEqual(pv.bad, 1, '数量 0 的行应计 bad');
  assert.strictEqual(pv.groups[0].lines.length, 1);
  const none = ri.previewImport(
    { contentBase64: Buffer.from('原料名称,数量,单价\n挪威三文鱼,1,99\n', 'utf8').toString('base64') },
    INGS
  );
  assert.strictEqual(none.ok, false);
  assert.ok(/请先到原料档案建档|不存在/.test(none.error), none.error);
});

/* ⑩ previewImport 是纯函数：同一输入两次结果完全一致（不含随机 id / 时间戳） */
ok('previewImport 纯函数性：两次预览结果逐字段相同（预览不生成单号）', () => {
  const csv = '原料名称,数量,单价\n五花肉,2,15\n';
  const b64 = Buffer.from(csv, 'utf8').toString('base64');
  const a = ri.previewImport({ contentBase64: b64, fileName: 'a.csv' }, INGS);
  const b = ri.previewImport({ contentBase64: b64, fileName: 'a.csv' }, INGS);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.totalAmount, 30);
  const c = JSON.parse(JSON.stringify(a));
  assert.ok(!('id' in c.groups[0]), '预览不分配局面 id');
});

console.log('\n== recv_import 解析层用例: ' + pass + '/' + pass + ' 通过 ==');
