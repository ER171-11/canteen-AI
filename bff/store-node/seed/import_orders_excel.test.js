'use strict';
/*
 * import_orders_excel.test.js — import_orders_excel.js 与 .py 的平价（差分）测试。
 *
 * 1) 解析层：同一批 xlsx / HTML-xls（含自造 sharedStrings 样本），
 *    分别用 Node / Python 原实现解析出表格行、配送单 docs，深比较必须一致。
 * 2) 写库层：同一 fixture 整库 + 同一订单目录，分别跑 Python / Node 的
 *    dedupe → import_docs → rebuild_stock → Store.put，
 *    比较落库后的整库 JSON（忽略毫秒时间戳 _u）。
 *
 * 用法：node bff/store-node/seed/import_orders_excel.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPython: execPy } = require('../../lib/_python');
const io = require('./import_orders_excel');
const { Store } = require('../db');

const REPO = path.resolve(__dirname, '..', '..', '..');
const PY_IMPORT = path.join(REPO, 'old', 'store-inventory-legacy', 'python-seed', 'import_orders_excel.py');
const PY_RUNTIME = path.join(REPO, 'old', 'store-inventory-legacy', 'python-runtime');
const ORDERS_DIR = path.join(REPO, 'store-inventory', '订单');

function runPython(code, args) {
  return execPy(code, { args: args || [] });
}

function pyBootstrap() {
  return [
    'import sys',
    'sys.path.insert(0, ' + JSON.stringify(PY_RUNTIME) + ')',
    'import importlib.util',
    'spec = importlib.util.spec_from_file_location("ioe", ' + JSON.stringify(PY_IMPORT) + ')',
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 自造样本：sharedStrings / inlineStr / 多 sheet / stored 压缩
// ---------------------------------------------------------------------------
function makeSyntheticXlsx(dir) {
  const py = [
    'import zipfile, sys',
    'ss = "<sst xmlns=\\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\\">"',
    'ss += "<si><t>品名</t></si><si><r><t>富</t></r><r><t>贵</t></r></si>"',
    'ss += "<si><t xml:space=\\"preserve\\">空格 </t></si></sst>"',
    'sheet = "<worksheet xmlns=\\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\\">"',
    'sheet += "<sheetData>"',
    'sheet += "<row r=\\"1\\"><c r=\\"A1\\" t=\\"s\\"><v>0</v></c><c r=\\"B1\\" t=\\"s\\"><v>1</v></c><c r=\\"C1\\" t=\\"s\\"><v>2</v></c></row>"',
    'sheet += "<row r=\\"2\\"><c r=\\"A2\\" t=\\"inlineStr\\"><is><t>内联</t></is></c><c r=\\"B2\\" t=\\"n\\"><v>3.14</v></c><c r=\\"C2\\"/></row>"',
    'sheet += "<row r=\\"3\\"><c r=\\"A3\\" t=\\"s\\"><v>2</v></c></row>"',
    'sheet += "</sheetData></worksheet>"',
    'sheet2 = "<worksheet><sheetData><row r=\\"1\\"><c r=\\"A1\\" t=\\"inlineStr\\"><is><t>X</t></is></c></row></sheetData></worksheet>"',
    'for comp, name in [(zipfile.ZIP_DEFLATED, "synth_deflate.xlsx"), (zipfile.ZIP_STORED, "synth_stored.xlsx")]:',
    '    z = zipfile.ZipFile(sys.argv[1] + "/" + name, "w", comp)',
    '    z.writestr("xl/sharedStrings.xml", ss)',
    '    z.writestr("xl/worksheets/sheet1.xml", sheet)',
    '    z.writestr("xl/worksheets/sheet2.xml", sheet2)',
    '    z.close()',
  ].join('\n');
  runPython(py, [dir]);
  return [path.join(dir, 'synth_deflate.xlsx'), path.join(dir, 'synth_stored.xlsx')];
}

// ---------------------------------------------------------------------------
// 1) 解析层平价
// ---------------------------------------------------------------------------
function testParseParity(synthFiles) {
  const py = [
    pyBootstrap(),
    'import json, os',
    'from pathlib import Path',
    'out = {}',
    'd = Path(sys.argv[1])',
    'for p in sorted(d.iterdir()):',
    '    if p.name in m.SKIP_FILES or p.name.startswith("."): continue',
    '    suf = p.suffix.lower()',
    '    try:',
    '        if suf == ".xlsx": rows = m.read_xlsx_rows(p)',
    '        elif suf == ".xls":',
    '            head = p.read_bytes()[:8]',
    '            if head[:4] == b"\\xd0\\xcf\\x11\\xe0": continue',
    '            rows = m.read_html_xls_rows(p)',
    '        else: continue',
    '    except Exception as exc:',
    '        out[p.name] = {"error": str(exc)}; continue',
    '    out[p.name] = {"rows": rows, "docs": m.parse_docs_from_rows(rows, p.name)}',
    'for f in json.loads(sys.argv[2]):',
    '    rows = m.read_xlsx_rows(Path(f))',
    '    out[os.path.basename(f)] = {"rows": rows, "docs": m.parse_docs_from_rows(rows, os.path.basename(f))}',
    'sys.stdout.write(json.dumps(out, ensure_ascii=False))',
  ].join('\n');
  const pyOut = JSON.parse(runPython(py, [ORDERS_DIR, JSON.stringify(synthFiles)]));

  const nodeOut = {};
  for (const name of fs.readdirSync(ORDERS_DIR).sort()) {
    if (io.SKIP_FILES.has(name) || name.startsWith('.')) continue;
    const full = path.join(ORDERS_DIR, name);
    if (!fs.statSync(full).isFile()) continue;
    const suf = path.extname(name).toLowerCase();
    let rows;
    try {
      if (suf === '.xlsx') rows = io.readXlsxRows(full);
      else if (suf === '.xls') {
        const head = fs.readFileSync(full).slice(0, 8);
        if (head.length >= 4 && head[0] === 0xd0 && head[1] === 0xcf
          && head[2] === 0x11 && head[3] === 0xe0) continue;
        rows = io.readHtmlXlsRows(full);
      } else continue;
    } catch (exc) {
      nodeOut[name] = { error: exc.message };
      continue;
    }
    nodeOut[name] = { rows: rows, docs: io.parseDocsFromRows(rows, name) };
  }
  for (const f of synthFiles) {
    const name = path.basename(f);
    const rows = io.readXlsxRows(f);
    nodeOut[name] = { rows: rows, docs: io.parseDocsFromRows(rows, name) };
  }

  assert.deepStrictEqual(nodeOut, pyOut, '解析结果不一致');
  const n = Object.keys(pyOut).length;
  let docs = 0;
  for (const k of Object.keys(pyOut)) docs += (pyOut[k].docs || []).length;
  console.log('[import_orders_excel.test] 解析层 PASS  files=' + n + ' docs=' + docs);
}

// ---------------------------------------------------------------------------
// 2) 写库层平价
// ---------------------------------------------------------------------------
const FIXTURE = {
  seq: 5,
  v: 4,
  ings: [
    { id: 'I1', name: '黑猪五花肉', cat: '其他', unit: '斤', buy: '斤', conv: 1, spec: '', stock: 0, avg: 0, initStock: 0, initAvg: 0, initDate: '2026-09-01', last: null, safe: 0, yld: 1, on: true, _u: 1 },
    { id: 'I2', name: '小葱', cat: '其他', unit: '斤', buy: '斤', conv: 1, spec: '', stock: 0, avg: 0, initStock: 10, initAvg: 4.0, initDate: '2026-09-01', last: null, safe: 0, yld: 1, on: true, _u: 1 },
    { id: 'I3', name: '【GY】红洋葱', cat: '其他', unit: '斤', buy: '斤', conv: 1, spec: '', stock: 0, avg: 0, initStock: 0, initAvg: 0, initDate: '2026-09-01', last: null, safe: 0, yld: 1, on: true, _u: 1 },
  ],
  recv: [
    { id: 'R1', no: 'JH20260901-01', date: '2026-09-01', supplier: '海南菜篮子实业有限公司', lines: [{ ing: 'I1', qty: 2, price: 18.0, conv: 1, amount: 36.0, unitCost: 18.0 }], payable: 36.0, payments: [], note: '旧单', method: '现金/转账', _u: 1 },
  ],
  logs: [
    { type: '盘点调整', ing: 'I2', date: '2026-09-02', qty: -1, ref: '盘点-1', bal: 9, cost: 4.0 },
    { type: '手工调整', ing: 'I1', date: '2026-09-03', qty: 5, inCost: 18.5, ref: '手工-1', bal: 5, cost: 18.5 },
  ],
  suppliers: ['海南菜篮子实业有限公司'],
  orders: [], sales: [], platforms: [],
};

function stripVolatile(v) {
  if (Array.isArray(v)) return v.map(stripVolatile);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      if (k === '_u') continue;
      // W4 · ings[].type 为 Node 超集字段（食材/耗材语义分层），Python 参考实现尚未产出，平价比较前剥除（仅原料对象）
      if (k === 'type' && typeof v.id === 'string' && /^I\d+$/.test(v.id)) continue;
      out[k] = stripVolatile(v[k]);
    }
    return out;
  }
  return v;
}

function testWriteParity(dir) {
  const fixturePath = path.join(dir, 'fixture.json');
  fs.writeFileSync(fixturePath, JSON.stringify(FIXTURE), 'utf8');
  const pyDb = path.join(dir, 'py.db');
  const nodeDb = path.join(dir, 'node.db');

  const py = [
    pyBootstrap(),
    'import json, os, contextlib',
    'from pathlib import Path',
    'from db import Store',
    'dbpath, orderdir, fixture = sys.argv[1], sys.argv[2], sys.argv[3]',
    'store = Store(dbpath, backup_dir=os.path.join(os.path.dirname(dbpath), "backups"))',
    'meta = store.get()',
    'if meta["empty"]:',
    '    store.put(0, json.load(open(fixture, encoding="utf-8")), "TEST")',
    '    meta = store.get()',
    'db = json.loads(json.dumps(meta["data"], ensure_ascii=False))',
    'with contextlib.redirect_stdout(sys.stderr):',
    '    docs = m.load_all_docs(Path(orderdir))',
    '    ing_by_id = {g["id"]: g for g in db["ings"]}',
    '    db["recv"], removed, fps = m.dedupe_recv(db.get("recv") or [], ing_by_id)',
    '    existing = [fp[2] for fp in fps]',
    '    soft = {(r.get("date"), m.r2(r.get("payable")), len(r.get("lines") or [])) for r in db["recv"]}',
    '    nr, ni, sk = m.import_docs(db, docs, fps, existing, soft)',
    '    m.rebuild_stock(db)',
    '    store.put(meta["rev"], db, "EXCEL-IMPORT", "test")',
    'out = store.get()["data"]',
    'sys.stdout.write(json.dumps({"new_recv": nr, "new_ing": ni, "skipped": sk, "data": out}, ensure_ascii=False))',
  ].join('\n');
  const pyOut = JSON.parse(runPython(py, [pyDb, ORDERS_DIR, fixturePath]));

  const store = new Store(nodeDb, path.join(dir, 'backups'));
  let meta = store.get();
  if (meta.empty) {
    store.put(0, JSON.parse(JSON.stringify(FIXTURE)), 'TEST');
    meta = store.get();
  }
  const db = JSON.parse(JSON.stringify(meta.data));
  const docs = io.loadAllDocs(ORDERS_DIR);
  const ingById = new Map((db.ings || []).map((g) => [g.id, g]));
  const ded = io.dedupeRecv(db.recv || [], ingById);
  db.recv = ded.out;
  const existing = Array.from(ded.seenFp.values()).map((fp) => fp[2]);
  const soft = new Set((db.recv || []).map(io.recvSoftKey));
  const stat = io.importDocs(db, docs, ded.seenFp, existing, soft);
  io.rebuildStock(db);
  store.put(meta.rev, db, 'EXCEL-IMPORT', 'test');
  const nodeOut = {
    new_recv: stat.newRecv, new_ing: stat.newIng, skipped: stat.skipped,
    data: store.get().data,
  };

  assert.strictEqual(nodeOut.new_recv, pyOut.new_recv, 'new_recv 不一致');
  assert.strictEqual(nodeOut.new_ing, pyOut.new_ing, 'new_ing 不一致');
  assert.strictEqual(nodeOut.skipped, pyOut.skipped, 'skipped 不一致');
  assert.deepStrictEqual(stripVolatile(nodeOut.data), stripVolatile(pyOut.data), '整库 JSON 不一致');
  console.log('[import_orders_excel.test] 写库层 PASS  new_recv=' + nodeOut.new_recv
    + ' new_ing=' + nodeOut.new_ing + ' skipped=' + nodeOut.skipped);
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-orders-'));
  try {
    const synth = makeSyntheticXlsx(dir);
    testParseParity(synth);
    testWriteParity(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('[import_orders_excel.test] PASS');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('[import_orders_excel.test] FAIL:', e.message);
    process.exit(1);
  }
}
