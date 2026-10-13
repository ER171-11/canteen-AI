'use strict';
/*
 * lib/recv_import.js — 进货单批量导入「解析层」（纯函数 · 零写 · 零第三方依赖）
 *
 * 来源：旧系统《熊猫五福餐厅进销存系统_真实数据版.html》批量导入区块，逐步骤移植：
 *   parseCsv :2752          parseRecvJson :3570        parseRecvTable :3388
 *   loadRowSource :3329     previewRecvImport :3591    metaFromText :3023
 *   findHeaderRow :2977     rowsToObjs :2977+          pickTable :3012
 *   IMP_PO_DEFS :3362       NOISE_RE :3360             recvQty :2792
 *   cleanName :2786         normDate :2772             numOr :2771
 *   createIngFromImport :2806（未匹配原料自动建档，见下方 buildPreview 的说明）
 *
 * 红线核对：
 *   ① 本文件只允许 require Node **内置**模块（zlib 用于解压 .xlsx），不得引入第三方包。
 *   ② 本文件绝不写库 / 不发网络请求 —— 只做「bytes → docs / preview」的纯计算；
 *      真正的写仍走 /api/actions 队列（执行器 recv.import，见 algorithms/inventory.js）。
 *   ③ 解析失败一律**显式报错**（err / warnings），绝不静默丢弃；不支持的格式必须在界面写清（红线⑥）。
 *
 * 明确不支持（必须明示，已在 routes/inventory.js 与前端写明）：
 *   旧版**二进制 .xls**（OLE2 + BIFF8）——旧版 parseBiff(:3043) 未移植，遇到即返回明确错误
 *   「请另存为 .xlsx 或 CSV」；供应商导出的**伪 .xls**（网页表格）已支持。
 */
const zlib = require('zlib');

/* ------------------------------------------------------------------ */
/* 小工具（对齐旧版 helper）                                            */
/* ------------------------------------------------------------------ */

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 物料两位小数（对齐旧版 r2） */
function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** 品名清洗：去掉供应商明细里的「*」新增标记与首尾空白（:2786） */
function cleanName(s) {
  return String(s == null ? '' : s)
    .replace(/^[\s\u3000*＊·・]+/, '')
    .replace(/[\s\u3000*＊]+$/, '')
    .trim();
}

/** 数字宽松解析：非数字返回 NaN（:2771） */
function numOr(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.\-]/g, ''));
  return isFinite(n) ? n : NaN;
}

/** 日期归一：支持 2026-09-29 / 20260929 / Excel 序列号（:2772） */
function normDate(s) {
  const raw = String(s == null ? '' : s).trim();
  if (!raw) return today();
  const m = raw.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (m) {
    return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
  }
  const m2 = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m2) return m2[1] + '-' + m2[2] + '-' + m2[3];
  const n = parseFloat(raw);
  if (isFinite(n) && n > 20000 && n < 80000) {
    /* Excel 日期序列号 */
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return today();
}

/**
 * 实收数解析（:2792）：供应商配送单的「实收数」列常混批注文字
 *   「×/未收/缺货/已划掉」→ null（整行不进单）
 *   「纯数字」            → 该数字
 *   「原4包改3包」        → 取「改」后的最后一个数字
 *   其余情况回落到 下单数 → 数量
 */
function recvQty(recv, order, plain) {
  const t = String(recv == null ? '' : recv).trim();
  if (t) {
    if (/^[×x✗✘❌—\-]/.test(t) || /未收|未送|缺货|不送|已划|划掉/.test(t)) return null;
    if (/^\d+(?:\.\d+)?$/.test(t)) {
      const n = parseFloat(t);
      if (isFinite(n)) return n;
    }
    const chg = t.match(/改\s*\d+(?:\.\d+)?/g);
    if (chg && chg.length) {
      const n = parseFloat(chg[chg.length - 1].replace(/[^\d.]/g, ''));
      if (isFinite(n)) return n;
    }
  }
  const o = numOr(order);
  if (isFinite(o)) return o;
  const p = numOr(plain);
  return isFinite(p) ? p : null;
}

/** 供应商明细里的噪声行（:3360） */
const NOISE_RE = /^(合计|总计|小计|合\s*计|金额合计|备注|说明|制单|配送员|收货人|总金额|供应商盖章|签收|以上|本单|¥|￥)/;

/* ------------------------------------------------------------------ */
/* 多格式表格统一化：.xlsx / 伪 .xls(网页表格) / .csv 都归一为二维数组   */
/* ------------------------------------------------------------------ */

/** 嗅探文件真实格式（:2850） */
function sniffFormat(buf) {
  if (!buf || buf.length < 4) return 'text';
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return 'zip';
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'ole';
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return 'utf16';
  return 'text';
}

/** UTF-8 解码，乱码时回落 GBK（:2857；Node 无 gbk 时保持 UTF-8） */
function decodeText(buf) {
  if (sniffFormat(buf) === 'utf16') {
    const le = buf[0] === 0xff && buf[1] === 0xfe;
    try {
      return new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(buf);
    } catch (e) {
      /* 落到 UTF-8 尝试 */
    }
  }
  let t = '';
  try {
    t = new TextDecoder('utf-8').decode(buf);
    if (/\uFFFD/.test(t)) {
      try {
        const g = new TextDecoder('gbk').decode(buf);
        if (!/\uFFFD/.test(g)) t = g;
      } catch (e) {
        /* Node 未启用 GBK 解码器：保持 UTF-8 结果 */
      }
    }
  } catch (e) {
    t = '';
  }
  return t;
}

function looksHtml(t) {
  const s = String(t || '');
  return /<table[\s>]/i.test(s.slice(0, 8000)) || /^\s*(<!doctype\s+html|<html)/i.test(s);
}

/** XML 实体还原（:2867） */
function xmlUnesc(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** <t>xxx</t> 拼接（:2873） */
function joinTags(s) {
  let out = '';
  let m;
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  while ((m = re.exec(s))) out += xmlUnesc(m[1]);
  return out;
}

/** 列字母 → 0 基列号（:2874） */
function colIndex(s) {
  if (!s) return -1;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 65 || c > 90) return -1;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** raw deflate 解压（Node 内置 zlib 替代浏览器 DecompressionStream） */
function inflateRaw(bytes) {
  return Buffer.from(zlib.inflateRawSync(bytes));
}

/** ZIP 中央目录读取（:2881） */
function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 66000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('文件不是有效的 .xlsx（ZIP 结构损坏）');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map();
  for (let n = 0; n < count && p + 46 <= bytes.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const nm = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    out.set(nm, { method: method, raw: bytes.subarray(start, start + csize) });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

function zipText(zip, name) {
  const e = zip.get(name);
  if (!e) return '';
  const data = e.method === 0 ? e.raw : inflateRaw(e.raw);
  return new TextDecoder('utf-8').decode(data);
}

/** sheet XML → 二维数组（:2908） */
function sheetRows(xml, shared) {
  const rows = [];
  let m;
  const rowRe = /<row\b([^>]*?)\/>|<row\b([^>]*?)>([\s\S]*?)<\/row>/g;
  while ((m = rowRe.exec(xml))) {
    const inner = m[3] || '';
    const cells = [];
    let c;
    const cellRe = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
    while ((c = cellRe.exec(inner))) {
      const attrs = c[1] || c[2] || '';
      const body = c[3] || '';
      const ref = (attrs.match(/r="([A-Z]+)\d*"/) || [])[1] || '';
      const type = (attrs.match(/t="([^"]+)"/) || [])[1] || '';
      const vm = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
      let val = '';
      if (type === 's') {
        const idx = vm ? parseInt(xmlUnesc(vm[1]), 10) : NaN;
        val = (isFinite(idx) && shared[idx] != null) ? String(shared[idx]) : '';
      } else if (type === 'inlineStr') {
        val = joinTags(body);
      } else {
        val = vm ? xmlUnesc(vm[1]) : '';
      }
      const ci = colIndex(ref);
      if (ci >= 0) cells[ci] = val;
      else cells.push(val);
    }
    const arr = [];
    for (let i = 0; i < cells.length; i++) arr.push(cells[i] == null ? '' : cells[i]);
    rows.push(arr);
  }
  return rows;
}

/** .xlsx → { sheets:[{name,rows}] }（:2933） */
function parseXlsxBytes(bytes) {
  const zip = unzip(bytes);
  const shared = [];
  const ss = zipText(zip, 'xl/sharedStrings.xml');
  if (ss) {
    let m;
    const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    while ((m = re.exec(ss))) shared.push(joinTags(m[1]));
  }
  const names = [];
  zip.forEach((v, k) => {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(k)) names.push(k);
  });
  names.sort((a, b) => ((parseInt((a.match(/(\d+)\.xml$/) || [])[1], 10) || 0)
    - (parseInt((b.match(/(\d+)\.xml$/) || [])[1], 10) || 0)));
  const wb = zipText(zip, 'xl/workbook.xml');
  const titles = [];
  if (wb) {
    let m;
    const re = /<sheet\b[^>]*name="([^"]*)"/g;
    while ((m = re.exec(wb))) titles.push(xmlUnesc(m[1]));
  }
  const sheets = [];
  for (let i = 0; i < names.length; i++) {
    const rows = sheetRows(zipText(zip, names[i]), shared);
    if (rows.some((r) => r.some((x) => String(x).trim() !== ''))) {
      sheets.push({ name: titles[i] || ('工作表' + (i + 1)), rows: rows });
    }
  }
  if (!sheets.length) throw new Error('.xlsx 中没有读取到工作表数据');
  return { sheets: sheets };
}

function stripTags(s) {
  return String(s == null ? '' : s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\u00a0/g, ' ');
}

/** 网页表格（供应商导出的伪 .xls / .html）→ sheets（:2954，Node 无 DOM，改用同语义正则） */
function parseHtmlTables(html) {
  const src = String(html || '');
  const sheets = [];
  let ti = 0;
  let t;
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  while ((t = tableRe.exec(src))) {
    const rows = [];
    let r;
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    while ((r = trRe.exec(t[1]))) {
      const cells = [];
      let c;
      const tdRe = /<(t[dh])\b([^>]*)>([\s\S]*?)<\/\1>/gi;
      while ((c = tdRe.exec(r[1]))) {
        const span = Math.max(1, parseInt((/colspan\s*=\s*["']?(\d+)/i.exec(c[2] || '') || [])[1], 10) || 1);
        cells.push(xmlUnesc(stripTags(c[3])).replace(/\s+/g, ' ').trim());
        for (let k = 1; k < span; k++) cells.push('');
      }
      rows.push(cells);
    }
    if (rows.some((rw) => rw.some((x) => String(x).trim() !== ''))) {
      ti += 1;
      sheets.push({ name: '表格' + ti, rows: rows });
    }
  }
  const text = xmlUnesc(stripTags(src)).replace(/\s+/g, ' ');
  return { rows: sheets.length ? sheets[0].rows : [], sheets: sheets, text: text };
}

/** CSV / TSV（:2752，增加 TSV 自动识别；UTF-8 与 GBK 已在 decodeText 处理） */
function parseCsvText(text) {
  const src = String(text).replace(/^\ufeff/, '');
  const head = src.split(/\r?\n/).filter((s) => s.trim() !== '')[0] || '';
  const delim = (head.indexOf('\t') >= 0 && head.indexOf(',') < 0) ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === delim) {
        row.push(cell);
        cell = '';
      } else if (c === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else if (c !== '\r') cell += c;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

/**
 * 读取入口：统一嗅探文件真实格式（:3329）
 * @param {Buffer|Uint8Array} bytes
 * @param {string} fileName
 * @returns {{rows:Array, sheets:Array, text:string, json?:boolean, format:string, err?:string, warn?:string}}
 */
function loadRowSource(bytes, fileName) {
  const buf = Buffer.from(bytes);
  const kind = sniffFormat(buf);
  const fname = String(fileName || '');
  if (kind === 'zip') {
    const x = parseXlsxBytes(buf);
    const text = x.sheets.map((s) => s.rows.map((r) => r.join('\t')).join('\n')).join('\n');
    return { rows: x.sheets[0].rows, sheets: x.sheets, text: text, format: 'xlsx' };
  }
  if (kind === 'ole') {
    /* 明确不支持：旧版二进制 .xls（OLE2+BIFF8）。绝不静默降级——直接给出可执行的替代方式 */
    return {
      rows: [],
      sheets: [{ name: '数据', rows: [] }],
      text: '',
      format: 'xls-binary',
      err: '暂不支持旧版二进制 .xls（Excel 97-2003）：请在 Excel 中「另存为 .xlsx 或 CSV」后再导入'
        + '（供应商系统导出的「伪 .xls」网页表格已支持，可直接导入）'
    };
  }
  const text = decodeText(buf);
  if (looksHtml(text)) {
    const h = parseHtmlTables(text);
    if (!h.rows.length) {
      return { rows: [], sheets: [], text: text, format: 'html', err: '该文件是网页格式(伪 Excel)，但没有找到可用的表格' };
    }
    h.format = 'html';
    return h;
  }
  if (/\.json$/i.test(fname) || /^\s*[{\[]/.test(text)) {
    return { json: true, text: text, rows: [], sheets: [], format: 'json' };
  }
  const rows = parseCsvText(text);
  return { rows: rows, sheets: [{ name: '数据', rows: rows }], text: text, format: 'csv' };
}

/* ------------------------------------------------------------------ */
/* 表头自动定位 + 列映射（CSV / 网页表格 / xlsx 通用）                    */
/* ------------------------------------------------------------------ */

/** 采购单（进货入库）列定义：别名表逐字照抄旧版 IMP_PO_DEFS（:3362-3373） */
const IMP_PO_DEFS = {
  ingName: {
    alts: ['原料名称', '原料', '品名', '品名规格', '商品名称', '商品名', '商品', '货品名称', '货品',
      '产品名称', '产品', '物料名称', '物料', '食材名称', '食材', '菜名', '名称', '品项'],
    req: 1
  },
  qtyRecv: { alts: ['实收数', '实收数量', '实收', '实收量', '收货数', '收货数量', '验收数量', '到货数', '到货数量', '入库数', '入库数量'] },
  qtyOrder: { alts: ['下单数', '下单数量', '订购数', '订购数量', '订货数', '订货数量', '订购量', '订单数量', '下单量'] },
  qty: { alts: ['数量', '销售量', '销售数量', '用量', '数量合计', 'qty'] },
  price: {
    alts: ['单价', '采购单价', '进货价', '供货价', '含税单价', '未税单价', '单价元', '采购价', '价格', 'price'],
    req: 1
  },
  unit: { alts: ['单位', '库存单位', '计量单位', '规格单位', 'unit'] },
  cat: { alts: ['类别', '原料分类', '分类', '品类', '类型', '大类'] },
  note: { alts: ['备注', '说明', '备注说明', 'note'] },
  supplier: { alts: ['供应商', '供应商名称', '供货商', '供货商名称', '供货单位', '供货方', '厂家'] },
  date: { alts: ['日期', '采购日期', '配送日期', '送货日期', '入库日期', '单据日期'] }
};

/** 表头归一（:2974） */
function normHeader(s) {
  return String(s == null ? '' : s)
    .replace(/[\s\u3000]/g, '')
    .replace(/[（(][^）)]*[)）]/g, '')
    .replace(/[*＊·・]/g, '')
    .toLowerCase();
}

/** 表头自动定位（:2977） */
function findHeaderRow(rows, defs, anyGroups) {
  const keys = Object.keys(defs);
  const limit = Math.min(rows.length, 25);
  let best = null;
  for (let i = 0; i < limit; i++) {
    const cells = (rows[i] || []).map(normHeader);
    const map = {};
    let score = 0;
    keys.forEach((k) => {
      const alts = defs[k].alts.map(normHeader);
      const j = cells.findIndex((c) => c !== '' && alts.indexOf(c) >= 0);
      if (j >= 0) {
        map[k] = j;
        score++;
      }
    });
    if (!best || score > best.score) best = { rowIndex: i, map: map, score: score };
  }
  if (!best || !best.score) return null;
  for (let i = 0; i < keys.length; i++) {
    if (defs[keys[i]].req && best.map[keys[i]] == null) return null;
  }
  for (let g = 0; g < (anyGroups || []).length; g++) {
    if (!anyGroups[g].some((k) => best.map[k] != null)) return null;
  }
  return best;
}

/** 数据行 → 对象（:2997） */
function rowsToObjs(rows, defs, hit) {
  const out = [];
  for (let i = hit.rowIndex + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const o = {};
    let nonEmpty = 0;
    Object.keys(defs).forEach((k) => {
      const j = hit.map[k];
      const v = (j == null) ? '' : String(r[j] == null ? '' : r[j]).trim();
      o[k] = v;
      if (v) nonEmpty++;
    });
    const cells = [];
    for (let x = 0; x < r.length; x++) cells.push(String(r[x] == null ? '' : r[x]).trim());
    o.__cells = cells;
    if (nonEmpty) out.push(o);
  }
  return out;
}

/** 多工作表里挑第一个能识别出表头的（:3012） */
function pickTable(src, defs, anyGroups) {
  const cands = (src.sheets && src.sheets.length) ? src.sheets : [{ rows: src.rows }];
  for (let i = 0; i < cands.length; i++) {
    const hit = findHeaderRow(cands[i].rows || [], defs, anyGroups);
    if (hit) return { rows: cands[i].rows, hit: hit, sheet: cands[i].name };
  }
  return null;
}

/* --- 从标题/页眉文字里提取 供应商 / 日期 / 单据号（:3021-3038） --- */
const BUYER_LABEL = /(收货商户|收货单位|收货方|收货人|客户名称|客户|采购方|买方|需方|门店|分店|餐厅|单位)\s*[：:][^\s，,、|；;\n]{0,30}/g;
const RE_COMPANY = /([\u4e00-\u9fa5]{2,20}?(?:股份有限公司|有限责任公司|有限公司|公司|商行|配送中心|供应链|经营部))/;

function metaFromText(text) {
  const t = String(text == null ? '' : text);
  let supplier = '';
  let date = '';
  let no = '';
  const ms = t.match(/(?:供应商|供货商|供货单位|供货方)\s*[：:]\s*([^\s，,、|（(；;\n]{2,30})/);
  if (ms) supplier = ms[1];
  if (!supplier) {
    const m = t.replace(BUYER_LABEL, ' ').match(RE_COMPANY);
    if (m) supplier = m[1];
  }
  const md = t.match(/(?:配送时间|送货日期|配送日期|单据日期|下单日期|采购日期|日期)\s*[：:]\s*(\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2})/);
  if (md) date = normDate(md[1]);
  if (!date) {
    const m2 = t.match(/(\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2})/);
    if (m2) date = normDate(m2[1]);
  }
  const mn = t.match(/(?:单据编号|配送单号|订单号|单据号|单号|配送编号)\s*[：:]\s*([A-Za-z0-9\-_]{4,40})/);
  if (mn) no = mn[1];
  return { supplier: supplier, date: date, no: no };
}

/* ------------------------------------------------------------------ */
/* 采购单（进货入库）解析                                               */
/* ------------------------------------------------------------------ */

/** JSON 分支（:3570） */
function parseRecvJson(text) {
  let o = null;
  try {
    o = JSON.parse(text);
  } catch (e) {
    return { docs: [], err: 'JSON 解析失败：' + e.message };
  }
  let arr = null;
  if (Array.isArray(o)) arr = o;
  else if (o && Array.isArray(o.pos)) arr = o.pos;
  else if (o && Array.isArray(o.lines)) arr = [o];
  else if (o && Array.isArray(o.items)) arr = [Object.assign({}, o, { lines: o.items })];
  if (!arr) return { docs: [], err: 'JSON 缺少 lines / pos 明细列表' };
  const docs = arr.map((x) => {
    const xo = x || {};
    const lines = (Array.isArray(xo.lines) ? xo.lines : []).map((l) => {
      const lo = l || {};
      return {
        ingName: cleanName(pickFirst(lo, ['ingName', 'ing', 'name', '原料名称', '原料'])),
        qty: numOr(pickFirst(lo, ['qty', '数量', '实收数量', '收货数量'])),
        price: numOr(pickFirst(lo, ['price', '单价', '采购单价'])),
        unit: pickFirst(lo, ['unit', '单位']),
        cat: pickFirst(lo, ['cat', '原料分类', '分类'])
      };
    });
    return {
      supplier: pickFirst(xo, ['supplier', '供应商', '供应商名称']),
      date: normDate(pickFirst(xo, ['date', '日期', '采购日期'])),
      note: pickFirst(xo, ['note', '备注']),
      lines: lines
    };
  }).filter((d) => d.lines.length);
  return { docs: docs, meta: {} };
}

/** 取第一个非空值（:2770 pick 的语义） */
function pickFirst(o, keys) {
  for (let i = 0; i < keys.length; i++) {
    const v = o[keys[i]];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** 表格分支（:3388-3420） */
/** 表「未收货」的显式标记（× / 未收 / 缺货 / 已划掉）——这类行数一般是业务原因不收货，不计为数据错误 */
const NOT_RECEIVED_RE = /^[×x✗✘❌—\-]|未收|未送|缺货|不送|已划|划掉/;

function parseRecvTable(src) {
  const f = pickTable(src, IMP_PO_DEFS, [['qtyRecv', 'qtyOrder', 'qty']]);
  if (!f) {
    return {
      docs: [],
      err: '未识别到进货单表头。需含「品名/原料名称」+「数量(或实收数/下单数)」+「单价」三列'
        + '（支持列名别名：' + Object.keys(IMP_PO_DEFS).length + ' 个字段、见界面说明）'
    };
  }
  const objs = rowsToObjs(f.rows, IMP_PO_DEFS, f.hit);
  const meta = metaFromText(src.text || '');
  const lines = [];
  let skipped = 0;
  let bad = 0;
  objs.forEach((o) => {
    const name = cleanName(o.ingName);
    const first = o.__cells.filter((x) => x)[0] || '';
    if (!name || NOISE_RE.test(name) || NOISE_RE.test(first)) return;
    const qty = recvQty(o.qtyRecv, o.qtyOrder, o.qty);
    if (qty == null) {
      /* 数量三列的整体取值（优先实收数 → 下单数 → 数量，与 recvQty 同序） */
      const qRaw = String(o.qtyRecv || '').trim() || String(o.qtyOrder || '').trim() || String(o.qty || '').trim();
      if (!qRaw || NOT_RECEIVED_RE.test(qRaw)) {
        skipped++; /* 空行 / 明确未收货：业务原因，不是数据错误（旧版同口径，但一股脑算 skipped） */
      } else {
        bad++; /* 数量不是数字：这是数据错误，必须显式暴露给用户（红线⑥） */
      }
      return;
    }
    lines.push({
      ingName: name,
      qty: qty,
      price: numOr(o.price),
      unit: o.unit,
      cat: o.cat,
      _note: o.note,
      _sup: o.supplier,
      _date: o.date
    });
  });
  if (!lines.length) {
    return { docs: [], skipped: skipped, bad: bad, err: '已识别到表头，但没有解析出有效明细行（请检查数量、单价是否为数字）' };
  }
  const docs = [];
  if (lines.some((l) => l._sup || l._date)) {
    /* 表内自带供应商/日期：按「供应商+日期」拆成多张进货单（与旧版同规则） */
    const m = new Map();
    lines.forEach((l) => {
      const sup = l._sup || meta.supplier || '未指定供应商';
      const date = l._date ? normDate(l._date) : (meta.date || today());
      const key = sup + '|' + date;
      if (!m.has(key)) m.set(key, { supplier: sup, date: date, note: l._note || meta.no || '', lines: [] });
      m.get(key).lines.push({ ingName: l.ingName, qty: l.qty, price: l.price, unit: l.unit, cat: l.cat });
    });
    m.forEach((v) => docs.push(v));
  } else {
    docs.push({
      supplier: meta.supplier || '',
      date: meta.date || today(),
      note: meta.no || '',
      lines: lines.map((l) => ({ ingName: l.ingName, qty: l.qty, price: l.price, unit: l.unit, cat: l.cat }))
    });
  }
  return { docs: docs, meta: meta, skipped: skipped, bad: bad, sheet: f.sheet };
}

/**
 * bytes → docs（纯计算，零写）
 * @param {Buffer|Uint8Array} bytes
 * @param {string} fileName
 * @returns {{docs:Array, skipped:number, meta:object, format:string, sheet?:string, err?:string}}
 */
function parseImportFile(bytes, fileName) {
  const src = loadRowSource(bytes, fileName);
  if (src.err) return { docs: [], skipped: 0, bad: 0, meta: {}, format: src.format, err: src.err };
  const r = src.json ? parseRecvJson(src.text) : parseRecvTable(src);
  return {
    docs: r.docs || [],
    skipped: r.skipped || 0,
    bad: r.bad || 0,
    meta: r.meta || {},
    format: src.format,
    sheet: r.sheet,
    sheetCount: (src.sheets || []).length,
    err: r.err
  };
}

/**
 * docs → 预览模型（移植旧版 previewRecvImport :3591 的校验与聚合规则）
 *
 * **2026-10-12 撤销原「不代建」偏离，回归旧版行为**：旧版未匹配的原料会「自动新建」到原料档案
 * （createIngFromImport :2806，见 HTML:3656-3658），本版同样**自动建档、不再剔除、不再阻断导入**
 * ——进货单 / 结算照常生成（不阻塞门店记账）。
 *
 * 与旧版的差别只在「建出来的是什么料」：本版建的是**待完善草稿**（`ings[].pending=true`，Node 超集字段），
 * 单位/分类用旧版兜底值（单据单位或「斤」/ 单据分类或「其他」），导入后在「原料档案 → 待完善」补全
 * 并「确认转正」。这样既不像旧版那样把不确定的单位/分类静默写进主数据，也不阻断记账（红线⑥）。
 *
 * 预览层**零写**：这里只把未匹配行标 `isNew`、汇总进 `newIngs`，真正的建档在执行器 recv.import。
 *
 * @param {Array} docs [{supplier,date,note,lines:[{ingName,qty,price,unit,cat}]}]
 * @param {Array} ings 快照 data.ings
 */
function buildPreview(docs, ings) {
  const byName = new Map();
  for (const g of ings || []) {
    const n = String((g && g.name) || '').trim();
    if (n && !byName.has(n)) byName.set(n, g);
  }
  const groups = [];
  const newNames = [];
  const newIngs = [];
  let bad = 0;
  let totalLines = 0;
  let totalAmount = 0;
  for (const doc of docs || []) {
    const d = doc || {};
    const rows = [];
    for (const l of (d.lines || [])) {
      const qty = Number(l && l.qty);
      const price = Number(l && l.price);
      const nm = String((l && l.ingName) || '').trim();
      if (!isFinite(qty) || qty <= 0 || !isFinite(price) || price < 0 || !nm) {
        bad++;
        continue;
      }
      const g = byName.get(nm);
      const unit = String((l && l.unit) || '').trim() || String((g && g.unit) || '').trim() || '斤';
      const cat = String((l && l.cat) || '').trim() || '其他';
      /* 未匹配 → 自动建档（旧版同款）：预览阶段只登记清单，不写库；执行器里才真正 new 出 pending 料 */
      if (!g && newNames.indexOf(nm) < 0) {
        newNames.push(nm);
        newIngs.push({ name: nm, unit: unit, cat: cat });
      }
      const amount = r2(qty * price);
      rows.push({
        ingId: g ? String(g.id) : '',
        name: g ? String(g.name) : nm,
        isNew: !g,
        qty: qty,
        price: r2(price),
        unit: unit,
        amount: amount
      });
      totalLines++;
      totalAmount += amount;
    }
    if (!rows.length) continue;
    groups.push({
      supplier: String(d.supplier || '').trim(),
      date: normDate(d.date),
      note: String(d.note || ''),
      lines: rows,
      payable: r2(rows.reduce((a, b) => a + b.amount, 0))
    });
  }
  return {
    groups: groups,
    bad: bad,
    /* 将自动建档的新原料名（去重）；保留 unmatched 字段名以兼容既有前端/测试 */
    unmatched: newNames,
    /* 新增：自动建档原料的明细（带 unit/cat），供界面提示与执行器参考 */
    newIngs: newIngs,
    totalLines: totalLines,
    totalAmount: r2(totalAmount),
    single: groups.length === 1
  };
}

/**
 * 预览总入口（供 routes/inventory.js 调用）：base64 → 预览模型。
 * **红线：本函数只读，不写任何文件/数据库。**
 *
 * 未匹配原料不再导致失败：它们已按旧版逻辑计入 groups（`lines[].isNew=true`），
 * 只有「整批没有任何可用明细行」才算失败。
 *
 * @param {{contentBase64?:string, bytes?:Buffer, fileName?:string}} input
 * @param {Array} ings 快照 data.ings
 */
function previewImport(input, ings) {
  const inp = input || {};
  let bytes = null;
  if (inp.bytes) bytes = Buffer.from(inp.bytes);
  else if (typeof inp.contentBase64 === 'string' && inp.contentBase64) {
    bytes = Buffer.from(inp.contentBase64, 'base64');
  }
  if (!bytes || !bytes.length) return { ok: false, error: '缺少文件内容（contentBase64）' };
  const MAX = 8 * 1024 * 1024;
  if (bytes.length > MAX) {
    return { ok: false, error: '文件过大（上限 8MB，实到 ' + Math.round(bytes.length / 1048576) + 'MB）' };
  }
  const fileName = String(inp.fileName || 'import.csv');
  let parsed = null;
  try {
    parsed = parseImportFile(bytes, fileName);
  } catch (e) {
    return { ok: false, error: '文件解析失败：' + ((e && e.message) || e) };
  }
  if (parsed.err) return { ok: false, error: parsed.err, format: parsed.format };
  const pv = buildPreview(parsed.docs, ings);
  if (!pv.groups.length) {
    return {
      ok: false,
      error: '未解析出可导入的明细行（数量需 >0、单价需 ≥0）',
      format: parsed.format,
      unmatched: pv.unmatched,
      newIngs: pv.newIngs
    };
  }
  return {
    ok: true,
    format: parsed.format,
    sheet: parsed.sheet || '',
    sheetCount: parsed.sheetCount || 1,
    meta: parsed.meta || {},
    skipped: parsed.skipped || 0,
    /* bad = 解析层剔除（数量非数字等） + 预览层剔除（单价非数字/负单价/数量≤0/缺名） */
    bad: (parsed.bad || 0) + pv.bad,
    /* unmatched / newIngs：本批将自动建档（待完善草稿）的新原料，界面据此提示 */
    unmatched: pv.unmatched,
    newIngs: pv.newIngs,
    single: pv.single,
    totalLines: pv.totalLines,
    totalAmount: pv.totalAmount,
    groups: pv.groups
  };
}

module.exports = {
  /* 入口 */
  previewImport,
  parseImportFile,
  buildPreview,
  /* 格式层 */
  loadRowSource,
  parseCsvText,
  parseRecvJson,
  parseRecvTable,
  parseHtmlTables,
  parseXlsxBytes,
  unzip,
  inflateRaw,
  zipText,
  sheetRows,
  decodeText,
  sniffFormat,
  /* 识别层 */
  IMP_PO_DEFS,
  findHeaderRow,
  rowsToObjs,
  pickTable,
  normHeader,
  metaFromText,
  /* 工具 */
  today,
  r2,
  cleanName,
  numOr,
  normDate,
  recvQty,
  NOISE_RE
};
