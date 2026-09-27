'use strict';
/*
 * import_orders_excel.js — 配送单 Excel 导入（import_orders_excel.py 的 Node 移植）
 *
 * 把 订单/ 目录下的配送单 Excel（.xlsx / 伪 .xls=HTML）导入为 DB.recv，
 * 再按店内同口径 rebuildStock，写回 SQLite，供原生 App 快照消费。
 *
 * 对齐 HTML commitRecvImport + migrateV4 + rebuildStock：
 *   - 品名去 *；实收数量/单价写进货行；新原料 stock/avg=0 后由重放生成
 *   - 单号 JH + yyyymmdd + 序号；供应商默认海南菜篮子实业有限公司
 *   - 指纹去重（品名+数量+单价集合），已入库跳过；顺带去掉 recv 重复行
 *   - 跳过：采购单整理（已是 84 行基线）、施工备用金汇总（非配送）
 *
 * 用法:
 *   node import_orders_excel.js [--dir 订单] [--db data/餐厅系统.db] [--dry-run]
 *   node import_orders_excel.js --push   # 导入后推 BFF（需 BFF_TOKEN 或自动 login boss）
 *
 * 零第三方依赖：仅用 node:fs / node:path / node:child_process / node:zlib（经 zipread）。
 * xlsx 解析用 zipread + 自实现 XML 标签扫描（对齐 Python xml.etree.ElementTree 行为）。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { openZip } = require('./zipread');
const { Store } = require('../db');
const { httpJson } = require('../common');

const BASE = __dirname;
const DEFAULT_DIR = path.resolve(BASE, '..', '..', '..', 'store-inventory', '订单');
const DEFAULT_DB = path.join(BASE, '..', 'data', '餐厅系统.db');

const SKIP_FILES = new Set([
  '采购单整理_熊猫五福.xlsx',      // seed 基线（89 行含未收，库内已是实收 84）
  '采购物品与施工备用金汇总表0924.xlsx', // 非配送进货
]);
const DEFAULT_SUPPLIER = '海南菜篮子实业有限公司';

const HEADER_ALIASES = {
  name: new Set(['品名', '商品名称', '商品名', '原料', '原料名称', '名称', '物料']),
  qty: new Set(['数量', '实收数', '实收', '收货数', '下单数', '订购数']),
  price: new Set(['单价', '单价(元)', '单价（元）', '价格']),
  unit: new Set(['单位', '采购单位']),
};

// ---------------------------------------------------------------------------
// 通用小工具（对齐 Python 语义）
// ---------------------------------------------------------------------------

function nowTag() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
    + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function toNum(x) {
  return Number(x || 0);
}

/** 对齐 Python round(float(x or 0) + 1e-12, 2) */
function r2(x) {
  const v = toNum(x) + 1e-12;
  return Math.round(v * 100) / 100;
}

/** 对齐 Python round(float(x or 0) + 1e-12, 3) */
function r3(x) {
  const v = toNum(x) + 1e-12;
  return Math.round(v * 1000) / 1000;
}

function cleanName(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/^[\s\u3000*＊·・]+/, '').trim();
}

/** Python %.2f 的近似：用于摘要字符串 */
function fixed2(x) {
  return (Number(x) || 0).toFixed(2);
}

/** 对齐 Python float() 的严格解析；失败返回 null */
function pyFloat(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  if (/^[+-]?(inf(inity)?|nan)$/i.test(s)) {
    const sign = s[0] === '-' ? -1 : 1;
    if (/nan/i.test(s)) return NaN;
    return sign * Infinity;
  }
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  return Number(s);
}

/** 字符串按码点比较（BMP 下等价 Python 字符串比较） */
function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 自实现 XML 标签扫描（对齐 xml.etree.ElementTree 的常用行为）
// ---------------------------------------------------------------------------

const XML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

function decodeXml(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code)) return m;
      try { return String.fromCodePoint(code); } catch (e) { return m; }
    }
    return Object.prototype.hasOwnProperty.call(XML_ENTITIES, body) ? XML_ENTITIES[body] : m;
  });
}

/**
 * 极简 XML DOM 解析：构建 {tag, attrs, children, text, tail}。
 * text=开始标签后、首个子节点前的文本；tail=结束标签后的文本（对齐 ET）。
 */
function parseXml(xml) {
  const root = { tag: '#root', attrs: {}, children: [], text: null, tail: null };
  const stack = [root];
  const n = xml.length;
  let i = 0;

  const appendText = (s) => {
    if (!s) return;
    const node = stack[stack.length - 1];
    if (node.children.length === 0) {
      node.text = (node.text || '') + s;
    } else {
      const last = node.children[node.children.length - 1];
      last.tail = (last.tail || '') + s;
    }
  };

  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { appendText(decodeXml(xml.slice(i))); break; }
    if (lt > i) appendText(decodeXml(xml.slice(i, lt)));

    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      appendText(xml.slice(lt + 9, e < 0 ? n : e));
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml[lt + 1] === '!') {
      const e = xml.indexOf('>', lt);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (xml[lt + 1] === '?') {
      const e = xml.indexOf('?>', lt);
      i = e < 0 ? n : e + 2;
      continue;
    }

    const gt = xml.indexOf('>', lt);
    if (gt < 0) { appendText(decodeXml(xml.slice(lt))); break; }
    const raw = xml.slice(lt + 1, gt);

    if (raw[0] === '/') {
      const name = raw.slice(1).trim();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) { stack.length = k; break; }
      }
    } else {
      const selfClose = /\/\s*$/.test(raw);
      const body = selfClose ? raw.replace(/\/\s*$/, '') : raw;
      const sp = body.search(/[\s/]/);
      const name = (sp < 0 ? body : body.slice(0, sp)).trim();
      const attrs = {};
      const attrRe = /([^\s=\/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let am;
      while ((am = attrRe.exec(body)) !== null) {
        attrs[am[1]] = decodeXml(am[3] !== undefined ? am[3] : (am[4] || ''));
      }
      const node = { tag: name, attrs, children: [], text: null, tail: null };
      stack[stack.length - 1].children.push(node);
      if (!selfClose) stack.push(node);
    }
    i = gt + 1;
  }
  return root;
}

/** 去掉命名空间前缀后的本地名 */
function localName(node) {
  const t = node.tag;
  const i = t.indexOf(':');
  return i < 0 ? t : t.slice(i + 1);
}

function childrenByLocal(node, name) {
  return node.children.filter((c) => localName(c) === name);
}

/** 深度优先前序遍历全部后代（对齐 ET.iter） */
function descendantsByLocal(node, name) {
  const out = [];
  const walk = (x) => {
    for (const c of x.children) {
      if (localName(c) === name) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

// ---------------------------------------------------------------------------
// xlsx / html-xls
// ---------------------------------------------------------------------------

/** Excel 列引用 → [col0, row0]（对齐 Python _col_row） */
function colRow(ref) {
  const m = /^([A-Z]+)(\d+)/.exec(ref || '');
  if (!m) return [0, 0];
  let col = 0;
  for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64;
  return [col - 1, parseInt(m[2], 10) - 1];
}

function readXlsxRows(p) {
  const zip = openZip(p);
  const names = zip.namelist();
  const ss = [];
  if (names.includes('xl/sharedStrings.xml')) {
    const doc = parseXml(zip.read('xl/sharedStrings.xml').toString('utf8'));
    const root = doc.children[0];
    for (const si of childrenByLocal(root, 'si')) {
      const texts = descendantsByLocal(si, 't').map((t) => t.text || '');
      ss.push(texts.join(''));
    }
  }
  const sheets = names
    .filter((nm) => /^xl\/worksheets\/sheet\d+\.xml$/.test(nm))
    .sort();
  const sheet = sheets[0];
  const doc = parseXml(zip.read(sheet).toString('utf8'));
  const root = doc.children[0]; // 文档根元素（<worksheet>）

  const grid = new Map();
  let maxr = 0;
  let maxc = 0;
  const sheetData = childrenByLocal(root, 'sheetData')[0];
  if (sheetData) {
    for (const row of childrenByLocal(sheetData, 'row')) {
      for (const c of childrenByLocal(row, 'c')) {
        const ref = c.attrs.r;
        if (!ref) continue;
        const [ci, ri] = colRow(ref);
        const t = c.attrs.t;
        let val;
        if (t === 'inlineStr') {
          val = descendantsByLocal(c, 't').map((nd) => nd.text || '').join('');
        } else {
          const v = childrenByLocal(c, 'v')[0];
          if (!v || v.text === null || v.text === undefined) {
            val = '';
          } else if (t === 's') {
            val = ss[parseInt(v.text, 10)];
          } else {
            val = v.text;
          }
        }
        grid.set(ri + ',' + ci, val);
        maxr = Math.max(maxr, ri);
        maxc = Math.max(maxc, ci);
      }
    }
  }
  const rows = [];
  for (let r = 0; r <= maxr; r++) {
    const row = [];
    for (let cc = 0; cc <= maxc; cc++) {
      const key = r + ',' + cc;
      row.push(grid.has(key) ? grid.get(key) : '');
    }
    rows.push(row);
  }
  return rows;
}

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026',
  mdash: '\u2014', ndash: '\u2013', middot: '\u00b7', times: '\u00d7',
  divide: '\u00f7', deg: '\u00b0', yen: '\u00a5', euro: '\u20ac',
  pound: '\u00a3', sect: '\u00a7', para: '\u00b6', laquo: '\u00ab',
  raquo: '\u00bb', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c',
  rdquo: '\u201d', bull: '\u2022',
};

function decodeHtml(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code)) return m;
      try { return String.fromCodePoint(code); } catch (e) { return m; }
    }
    return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, body) ? HTML_ENTITIES[body] : m;
  });
}

/** 对齐 Python _TableParser（html.parser.HTMLParser, convert_charrefs=True） */
class TableParser {
  constructor() {
    this.rows = [];
    this._row = null;
    this._in_td = false;
    this._buf = [];
    this.texts = [];
  }

  _start(tag) {
    if (tag === 'tr') this._row = [];
    else if (tag === 'td' || tag === 'th') { this._in_td = true; this._buf = []; }
    else if (tag === 'p') this._buf = [];
  }

  _end(tag) {
    if ((tag === 'td' || tag === 'th') && this._row !== null) {
      this._row.push(this._buf.join('').trim());
      this._in_td = false;
    } else if (tag === 'tr' && this._row !== null) {
      this.rows.push(this._row);
      this._row = null;
    } else if (tag === 'p') {
      const t = this._buf.join('').trim();
      if (t) this.texts.push(t);
    }
  }

  _data(d) { this._buf.push(d); }

  feed(html) {
    const n = html.length;
    let i = 0;
    while (i < n) {
      const lt = html.indexOf('<', i);
      if (lt < 0) { this._data(decodeHtml(html.slice(i))); break; }
      if (lt > i) this._data(decodeHtml(html.slice(i, lt)));

      if (html.startsWith('<!--', lt)) {
        const e = html.indexOf('-->', lt + 4);
        i = e < 0 ? n : e + 3;
        continue;
      }
      if (html.startsWith('<![CDATA[', lt)) {
        const e = html.indexOf(']]>', lt + 9);
        this._data(html.slice(lt + 9, e < 0 ? n : e));
        i = e < 0 ? n : e + 3;
        continue;
      }
      if (html[lt + 1] === '!' || html[lt + 1] === '?') {
        const e = html.indexOf('>', lt);
        i = e < 0 ? n : e + 1;
        continue;
      }

      // 找到匹配的 '>'（跳过引号内的 '>'）
      let j = lt + 1;
      let quote = null;
      while (j < n) {
        const ch = html[j];
        if (quote) { if (ch === quote) quote = null; }
        else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') break;
        j++;
      }
      const tag = html.slice(lt, j + 1);
      const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(tag);
      if (m) {
        const name = m[2].toLowerCase();
        if (m[1] === '/') {
          this._end(name);
        } else {
          this._start(name);
          if (/\/\s*>$/.test(tag)) this._end(name);
        }
      }
      i = j + 1;
    }
  }
}

function readHtmlXlsRows(p) {
  const parser = new TableParser();
  parser.feed(fs.readFileSync(p, 'utf8'));
  const rows = parser.texts.map((t) => [t]);
  rows.push(...parser.rows);
  return rows;
}

// ---------------------------------------------------------------------------
// 表头 / 元信息 / 文档解析
// ---------------------------------------------------------------------------

function findHeader(row) {
  const cells = row.map((c) => String(c).trim());
  const joined = cells.join('|');
  if (!joined.includes('品名')) return null;
  if (!joined.includes('单价') && !joined.includes('数量')) return null;
  const mapping = {};
  for (let ci = 0; ci < cells.length; ci++) {
    const c = cells[ci];
    for (const k of Object.keys(HEADER_ALIASES)) {
      if (HEADER_ALIASES[k].has(c) && !(k in mapping)) mapping[k] = ci;
    }
  }
  if ('name' in mapping && 'qty' in mapping && 'price' in mapping) return mapping;
  return null;
}

function extractMeta(rows) {
  const blob = rows.map((r) => r.map((c) => String(c)).join(' ')).join('\n');
  let date = null;
  let m = /配送时间[：:]\s*(\d{4}-\d{2}-\d{2})/.exec(blob);
  if (m) date = m[1];
  if (!date) {
    m = /(20\d{2}-\d{2}-\d{2})/.exec(blob);
    if (m) date = m[1];
  }
  let order = null;
  m = /(?:订单号|单据编号|配送单号)[：:]\s*([A-Za-z0-9\-_]{6,40})/.exec(blob);
  if (m) order = m[1];
  let merchant = null;
  m = /(?:收货商户|收货客户)[：:]\s*([^\s\u3000\xa0]+)/.exec(blob);
  if (m) merchant = m[1];
  return [date, order, merchant];
}

const STOP_RE = /人民币大写|收货人签章|第一张单合计|第二张单合计|配送单[二三四五]/;

function parseDocsFromRows(rows, fname) {
  const docs = [];
  let i = 0;
  while (i < rows.length) {
    let hi = null;
    let mapping = null;
    for (let j = i; j < rows.length; j++) {
      const m = findHeader(rows[j]);
      if (m) { hi = j; mapping = m; break; }
    }
    if (hi === null) break;
    const metaRows = rows.slice(Math.max(0, hi - 5), hi + 1);
    const [date0, order, merchant] = extractMeta(metaRows);
    let date = date0;
    const lines = [];
    let j = hi + 1;
    while (j < rows.length) {
      if (findHeader(rows[j]) && j > hi) break;
      const r = rows[j];
      const joined = r.map((c) => String(c)).join('');
      if (STOP_RE.test(joined)) {
        if (lines.length) { j += 1; break; }
        j += 1;
        continue;
      }
      if (/^合计/.test(joined.trim())) { j += 1; break; }
      const nameIdx = mapping.name;
      const name = cleanName(nameIdx < r.length ? r[nameIdx] : '');
      if (!name || name === '品名') { j += 1; continue; }
      let qty = mapping.qty < r.length ? pyFloat(r[mapping.qty]) : null;
      let price = mapping.price < r.length ? pyFloat(r[mapping.price]) : null;
      let unit = (('unit' in mapping) && mapping.unit < r.length)
        ? String(r[mapping.unit]).trim() : '斤';
      if (!unit) unit = '斤';
      if (qty === null || price === null || qty <= 0) { j += 1; continue; }
      lines.push({ name: name, qty: qty, price: price, unit: unit });
      j += 1;
    }
    if (lines.length) {
      if (!date) {
        const fm = /0?9(\d{2})/.exec(fname);
        if (fm) date = '2026-09-' + fm[1];
      }
      docs.push({
        date: date || todayStr(),
        order: order,
        merchant: merchant,
        lines: lines,
        file: fname,
      });
    }
    i = j > hi ? j : hi + 1;
  }
  return docs;
}

function loadAllDocs(orderDir) {
  const docs = [];
  const files = fs.readdirSync(orderDir).sort();
  for (const name of files) {
    if (SKIP_FILES.has(name) || name.startsWith('.')) continue;
    const full = path.join(orderDir, name);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile()) continue;
    const suf = path.extname(name).toLowerCase();
    let rows;
    try {
      if (suf === '.xlsx') {
        rows = readXlsxRows(full);
      } else if (suf === '.xls') {
        // 伪 HTML 或真二进制；本目录均为 HTML
        const head = fs.readFileSync(full).slice(0, 8);
        if (head.length >= 4 && head[0] === 0xd0 && head[1] === 0xcf
          && head[2] === 0x11 && head[3] === 0xe0) {
          console.log('[skip] 真二进制 .xls 暂不支持: ' + name);
          continue;
        }
        rows = readHtmlXlsRows(full);
      } else {
        continue;
      }
    } catch (exc) {
      console.log('[err ] 解析失败 ' + name + ': ' + (exc && exc.message));
      continue;
    }
    const parsed = parseDocsFromRows(rows, name);
    console.log('[file] ' + name + ': ' + parsed.length + ' 张配送明细');
    docs.push(...parsed);
  }
  return docs;
}

// ---------------------------------------------------------------------------
// fingerprint / rebuild
// ---------------------------------------------------------------------------

function fpKey(fp) {
  return JSON.stringify(fp);
}

function softKey(date, payable, count) {
  return JSON.stringify([date, payable, count]);
}

/** linesNamed: [[name, qty, price], ...] */
function lineFp(linesNamed) {
  const items = linesNamed.map(([n, q, p]) => [cleanName(n), r3(q), r2(p)]);
  items.sort((a, b) => cmpStr(a[0], b[0]) || (a[1] - b[1]) || (a[2] - b[2]));
  let sum = 0;
  for (const it of items) sum += it[1] * it[2];
  return [items.length, r2(sum), items];
}

/** small 的每一行是否都能在 big 里找到同品名+数量+单价（多重集合）。 */
function itemsSubset(smallItems, bigItems) {
  const c = new Map();
  for (const it of bigItems) {
    const k = JSON.stringify(it);
    c.set(k, (c.get(k) || 0) + 1);
  }
  for (const it of smallItems) {
    const k = JSON.stringify(it);
    const cnt = c.get(k) || 0;
    if (cnt <= 0) return false;
    c.set(k, cnt - 1);
  }
  return true;
}

function recvFp(recv, ingById) {
  const named = [];
  for (const l of recv.lines || []) {
    const g = ingById.get(l.ing);
    named.push([g ? g.name : l.ing, l.qty, l.price]);
  }
  return lineFp(named);
}

function recvSoftKey(r) {
  return softKey(r.date, r2(r.payable), (r.lines || []).length);
}

/** 精确指纹去重；再按 (date, payable, 行数) 去掉 zip 带入的脏重复。 */
function dedupeRecv(recvList, ingById) {
  const seenFp = new Map();
  const seenSoft = new Set();
  const out = [];
  let removed = 0;
  for (const r of recvList) {
    const fp = recvFp(r, ingById);
    const soft = recvSoftKey(r);
    const key = fpKey(fp);
    if (seenFp.has(key) || seenSoft.has(soft)) {
      removed += 1;
      continue;
    }
    seenFp.set(key, fp);
    seenSoft.add(soft);
    out.push(r);
  }
  return { out: out, removed: removed, seenFp: seenFp };
}

function alreadyImported(fp, fpsSeen, existingItemsList, softKeys, soft) {
  if (softKeys.has(soft)) return true;
  if (fpsSeen.has(fpKey(fp))) return true;
  // 拆分明细：子集命中已有进货单也视为已导入
  for (const big of existingItemsList) {
    if (itemsSubset(fp[2], big)) return true;
  }
  return false;
}

function findIng(db, name) {
  name = cleanName(name);
  for (const g of db.ings) {
    if (g.name === name) return g;
  }
  // 宽松：去括号前缀【GY】等后再比
  const bare = name.replace(/^【[^】]+】/, '').trim();
  if (bare !== name) {
    for (const g of db.ings) {
      if (g.name === bare || g.name.replace(/^【[^】]+】/, '').trim() === bare) return g;
    }
  }
  return null;
}

function createIng(db, name, unit) {
  const seq = parseInt(db.seq || 0, 10) + 1;
  db.seq = seq;
  const u = unit || '斤';
  const g = {
    id: 'I' + seq,
    name: cleanName(name),
    cat: '其他',
    unit: u,
    buy: u,
    conv: 1,
    spec: '',
    stock: 0,
    avg: 0,
    initStock: 0,
    initAvg: 0,
    initDate: todayStr(),
    last: null,
    safe: 0,
    yld: 1,
    on: true,
    _u: Date.now(),
  };
  db.ings.push(g);
  return g;
}

function mkPoLine(g, qty, price) {
  const conv = Number(g.conv || 1) || 1;
  return {
    ing: g.id,
    qty: qty,
    price: price,
    conv: conv,
    amount: r2(qty * price),
    unitCost: r3(price / conv),
  };
}

function mkNo(prefix, date, i) {
  return prefix + date.replace(/-/g, '') + '-' + String(i).padStart(2, '0');
}

function nextUid(db, prefix) {
  const seq = parseInt(db.seq || 0, 10) + 1;
  db.seq = seq;
  return prefix + seq;
}

/** Node 端口：对齐 HTML rebuildStock（移动加权 + 生成 logs）。 */
function rebuildStock(db) {
  const ingMap = new Map(db.ings.map((g) => [g.id, g]));
  const moves = [];
  for (const g of db.ings) {
    g.stock = 0;
    g.avg = 0;
    if (toNum(g.initStock) > 0) {
      moves.push({
        o: 0, type: '期初', gid: g.id, date: g.initDate || todayStr(),
        qty: Number(g.initStock), cost: Number(g.initAvg || 0), ref: '期初',
      });
    }
  }
  for (const po of db.recv || []) {
    for (const l of po.lines || []) {
      moves.push({
        o: 2, type: '采购入库', gid: l.ing, date: po.date,
        qty: Number(l.qty) * Number(l.conv || 1),
        cost: Number(l.unitCost || 0), ref: po.no,
      });
    }
  }
  for (const l of db.logs || []) {
    if (l.type === '盘点调整') {
      moves.push({
        o: 3, type: '盘点调整', gid: l.ing, date: l.date,
        qty: Number(l.qty), cost: 0, ref: l.ref, adj: l,
      });
    } else if (l.type === '手工调整') {
      moves.push({
        o: 1, type: '手工调整', gid: l.ing, date: l.date,
        qty: Number(l.qty), cost: Number(l.inCost || 0), ref: l.ref, adj: l,
      });
    }
  }
  // sales 销售出库依赖配方；无配方则跳过（与空 sales 一致）

  moves.sort((a, b) => cmpStr(a.date, b.date) || (a.o - b.o));
  const gen = [];
  let genSeq = 1;
  for (const mv of moves) {
    const g = ingMap.get(mv.gid);
    if (!g) continue;
    if (mv.type === '手工调整') {
      g.stock = r3(mv.qty);
      g.avg = Number(mv.cost || 0);
    } else if (mv.qty > 0) {
      const val = g.stock * g.avg + mv.qty * mv.cost;
      g.stock = r3(g.stock + mv.qty);
      g.avg = g.stock ? r3(val / g.stock) : Number(mv.cost || 0);
    } else {
      g.stock = r3(g.stock + mv.qty);
    }
    if (mv.adj !== undefined) {
      mv.adj.bal = r3(g.stock);
      mv.adj.cost = g.avg;
      gen.push(mv.adj);
    } else {
      gen.push({
        seq: genSeq,
        t: mv.date + ' 12:00',
        date: mv.date,
        type: mv.type,
        ing: mv.gid,
        qty: r3(mv.qty),
        inCost: mv.cost,
        cost: g.avg,
        bal: r3(g.stock),
        ref: mv.ref,
      });
      genSeq += 1;
    }
  }
  gen.sort((a, b) => cmpStr(a.date, b.date) || ((a.seq || 0) - (b.seq || 0)));
  db.logs = gen;
  for (const g of db.ings) g.last = null;
  const sortedRecv = (db.recv || []).slice()
    .sort((a, b) => cmpStr(a.date, b.date) || cmpStr(a.no, b.no));
  sortedRecv.reverse();
  for (const po of sortedRecv) {
    for (const l of po.lines || []) {
      const g = ingMap.get(l.ing);
      if (g && g.last === null) g.last = l.price;
    }
  }
}

function importDocs(db, docs, fpsSeen, existingItemsList, softKeys) {
  let newRecv = 0;
  let newIng = 0;
  let skipped = 0;
  for (const doc of docs) {
    const named = doc.lines.map((r) => [r.name, r.qty, r.price]);
    const fp = lineFp(named);
    const soft = softKey(doc.date, fp[1], fp[0]);
    if (alreadyImported(fp, fpsSeen, existingItemsList, softKeys, soft)) {
      skipped += 1;
      console.log('  skip ' + doc.file + ' ' + doc.date + ' order=' + doc.order
        + ' lines=' + fp[0] + ' ¥' + fp[1] + ' (已入库)');
      continue;
    }
    const date = doc.date;
    const lines = [];
    for (const row of doc.lines) {
      let g = findIng(db, row.name);
      if (!g) {
        g = createIng(db, row.name, row.unit);
        newIng += 1;
      }
      lines.push(mkPoLine(g, row.qty, row.price));
    }
    if (!lines.length) continue;
    let sum = 0;
    for (const l of lines) sum += l.amount;
    const payable = r2(sum);
    const sameDay = (db.recv || []).filter((r) => r.date === date).length;
    const noteParts = [];
    if (doc.order) noteParts.push('配送单号 ' + doc.order);
    if (doc.merchant) noteParts.push('收货商户 ' + doc.merchant);
    noteParts.push('来源 ' + doc.file);
    const n = {
      id: nextUid(db, 'R'),
      no: mkNo('JH', date, sameDay + 1),
      date: date,
      supplier: DEFAULT_SUPPLIER,
      lines: lines,
      payable: payable,
      payments: [],
      note: noteParts.join(' · '),
      method: '现金/转账',
      _u: Date.now(),
    };
    db.recv.push(n);
    if (!db.suppliers.includes(DEFAULT_SUPPLIER)) db.suppliers.push(DEFAULT_SUPPLIER);
    fpsSeen.set(fpKey(fp), fp);
    existingItemsList.push(fp[2]);
    softKeys.add(soft);
    newRecv += 1;
    console.log('  + ' + n.no + ' ' + date + ' lines=' + lines.length
      + ' ¥' + payable + ' ← ' + doc.file + ' (' + (doc.merchant || '-') + ')');
  }
  return { newRecv: newRecv, newIng: newIng, skipped: skipped };
}

function summarize(db) {
  const ings = db.ings || [];
  const recv = db.recv || [];
  const stockN = ings.filter((i) => toNum(i.stock) > 0).length;
  let stockAmt = 0;
  for (const i of ings) stockAmt += toNum(i.stock) * toNum(i.avg);
  let payable = 0;
  for (const r of recv) payable += toNum(r.payable);
  return 'ings=' + ings.length + ' stock>0=' + stockN + ' stock¥=' + fixed2(stockAmt)
    + ' recv=' + recv.length + ' payable¥=' + fixed2(payable)
    + ' logs=' + ((db.logs || []).length);
}

// ---------------------------------------------------------------------------
// 推送 BFF（对齐原脚本 subprocess 调 snapshot_pusher.py，此处改用 store-node/pusher.js）
// ---------------------------------------------------------------------------
async function pushSnapshot(token) {
  let tok = token;
  if (!tok) {
    const resp = await httpJson('POST', 'http://127.0.0.1:8787/api/auth/login',
      { account: 'boss', device_fp: 'excel-import' }, null, 15);
    tok = resp.body && resp.body.token;
  }
  const pusher = path.join(BASE, '..', 'pusher.js');
  const args = [pusher, '--once'];
  if (tok) args.push('--token', tok);
  const r = spawnSync('node', args, { stdio: 'inherit' });
  return r.status === null ? 1 : r.status;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { dir: DEFAULT_DIR, db: DEFAULT_DB, dryRun: false, push: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--push') out.push = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('未知参数: ' + a);
  }
  return out;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error('参数解析失败: ' + e.message);
    return 2;
  }
  if (args.help) {
    console.log('用法: node import_orders_excel.js [--dir 订单] [--db 路径] [--dry-run] [--push]');
    return 0;
  }
  if (!fs.existsSync(args.dir) || !fs.statSync(args.dir).isDirectory()) {
    throw new Error('找不到订单目录: ' + args.dir);
  }
  if (!fs.existsSync(args.db) || !fs.statSync(args.db).isFile()) {
    throw new Error('找不到库: ' + args.db);
  }

  const docs = loadAllDocs(args.dir);
  const store = new Store(args.db, path.join(path.dirname(args.db), 'backups'));
  const meta = store.get();
  if (meta.empty) throw new Error('目标库为空');
  const db = JSON.parse(JSON.stringify(meta.data));

  console.log('[before] ' + summarize(db));
  const ingById = new Map((db.ings || []).map((g) => [g.id, g]));
  const deduped = dedupeRecv(db.recv || [], ingById);
  db.recv = deduped.out;
  if (deduped.removed) console.log('[dedupe] 去掉重复进货单 ' + deduped.removed + ' 张');
  const existingItems = Array.from(deduped.seenFp.values()).map((fp) => fp[2]);
  const softKeysList = new Set((db.recv || []).map(recvSoftKey));

  const stat = importDocs(db, docs, deduped.seenFp, existingItems, softKeysList);
  rebuildStock(db);
  console.log('[after ] ' + summarize(db));
  console.log('[stat ] new_recv=' + stat.newRecv + ' new_ing=' + stat.newIng
    + ' skipped=' + stat.skipped);

  if (args.dryRun) {
    console.log('dry-run：未写库');
    return 0;
  }

  const bak = path.join(path.dirname(args.db), 'backups',
    '餐厅系统_' + nowTag() + '_pre_excel_import.db');
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  fs.copyFileSync(args.db, bak);
  console.log('[bak  ] ' + bak);

  const info = store.put(meta.rev, db, 'EXCEL-IMPORT',
    'import_orders_excel: +' + stat.newRecv + ' recv, +' + stat.newIng + ' ings');
  console.log('[ok   ] wrote rev=' + info.rev);

  if (args.push) {
    const rc = await pushSnapshot(process.env.BFF_TOKEN);
    console.log('[push ] rc=' + rc);
    return rc;
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((rc) => process.exit(rc)).catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  });
}

module.exports = {
  SKIP_FILES, DEFAULT_SUPPLIER, HEADER_ALIASES,
  nowTag, todayStr, r2, r3, cleanName, pyFloat, cmpStr,
  parseXml, localName, childrenByLocal, descendantsByLocal, colRow, readXlsxRows,
  TableParser, readHtmlXlsRows, findHeader, extractMeta, parseDocsFromRows, loadAllDocs,
  fpKey, softKey, lineFp, itemsSubset, recvFp, recvSoftKey, dedupeRecv, alreadyImported,
  findIng, createIng, mkPoLine, mkNo, nextUid, rebuildStock, importDocs, summarize, main,
};
