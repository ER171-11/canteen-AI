'use strict';
/*
 * seed_recipes.test.js — seed_recipes.js 与 seed_recipes.py 的平价（差分）测试。
 *
 * 1) 解析层：同一 docx，分别用 Node / Python 原实现解析出
 *    段落文本、色×馅小节、recipes（去 updated_at）、sop_steps，深比较必须一致。
 * 2) 写库层：两份临时 sqlite，分别跑 Python / Node 的 ensure_tables + seed，
 *    比较 recipes / sop_steps / sop_workorders 结果行（忽略 updated_at）。
 *
 * 用法：node bff/store-node/seed/seed_recipes.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const sr = require('./seed_recipes');

const PY_SEED = path.resolve(__dirname, '..', '..', '..', 'old', 'store-inventory-legacy', 'python-seed', 'seed_recipes.py');
const DOCX = path.resolve(__dirname, '..', '..', '..', 'old', 'root-assets',
  '金丰御字牌五福饺子(2).docx');

function runPython(code, args) {
  return execFileSync('python3', ['-c', code].concat(args || []), { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// 1) 解析层平价
// ---------------------------------------------------------------------------
function testParseParity() {
  const py = [
    'import json, sys, logging, importlib.util',
    'logging.disable(logging.CRITICAL)',
    'spec = importlib.util.spec_from_file_location("sr", ' + JSON.stringify(PY_SEED) + ')',
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'lines = m.docx_paragraphs(sys.argv[1])',
    'parsed = m.parse_sections(lines)',
    'recs, sop = m.build_recipes(sys.argv[1])',
    'for r in recs:',
    '    r.pop("updated_at", None)',
    'out = {"lines": lines,',
    '       "sections": {("%s/%s" % k): v for k, v in parsed.items()},',
    '       "recipes": recs, "sop": sop}',
    'sys.stdout.write(json.dumps(out, ensure_ascii=False))',
  ].join('\n');
  const pyOut = JSON.parse(runPython(py, [DOCX]));

  const lines = sr.docxParagraphs(DOCX);
  const parsed = sr.parseSections(lines);
  const built = sr.buildRecipes(DOCX);
  const sections = {};
  for (const [k, v] of parsed.map) sections[k] = v;
  for (const r of built.recipes) delete r.updated_at;

  assert.deepStrictEqual(lines, pyOut.lines, '段落文本不一致');
  assert.deepStrictEqual(sections, pyOut.sections, '色×馅小节不一致');
  assert.deepStrictEqual(built.recipes, pyOut.recipes, 'recipes 不一致');
  assert.deepStrictEqual(built.sop, pyOut.sop, 'sop_steps 不一致');
  console.log('[seed_recipes.test] 解析层 PASS  lines=' + lines.length
    + ' sections=' + Object.keys(sections).length
    + ' recipes=' + built.recipes.length + ' sop=' + built.sop.length);
}

// ---------------------------------------------------------------------------
// 2) 写库层平价
// ---------------------------------------------------------------------------
const R_COLS = ['sku_id', 'name', 'color', 'filling', 'face_main', 'main', 'aux',
  'seasoning', 'steps', 'params', 'blessing', 'diet_tags', 'version'];
const S_COLS = ['sku_id', 'step_no', 'stage', 'duration_min', 'tools', 'inputs',
  'key_points', 'qc_point', 'risk', 'params'];
const W_COLS = ['date', 'sku_id', 'qty', 'planned_start', 'status', 'qc_records'];

function dumpSqlite(dbPath) {
  const conn = new DatabaseSync(dbPath);
  try {
    const dump = (table, cols, order) => conn.prepare(
      'SELECT ' + cols.join(',') + ' FROM ' + table + ' ORDER BY ' + order
    ).all().map((r) => Object.assign({}, r));
    return {
      recipes: dump('recipes', R_COLS, 'sku_id'),
      sop: dump('sop_steps', S_COLS, 'sku_id,step_no'),
      wo: dump('sop_workorders', W_COLS, 'id'),
    };
  } finally {
    conn.close();
  }
}

function testWriteParity(dir) {
  const nodeDb = path.join(dir, 'node.db');
  const pyDb = path.join(dir, 'py.db');
  const py = [
    'import json, sys, logging, sqlite3, contextlib, importlib.util',
    'logging.disable(logging.CRITICAL)',
    'spec = importlib.util.spec_from_file_location("sr", ' + JSON.stringify(PY_SEED) + ')',
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'db = sys.argv[1]',
    'recs, sop = m.build_recipes(sys.argv[2])',
    'with contextlib.redirect_stdout(sys.stderr):',
    '    m.seed(db, recs, sop, False)',
    'c = sqlite3.connect(db)',
    'c.row_factory = sqlite3.Row',
    'def dump(tbl, cols, order):',
    '    return [dict(r) for r in c.execute("SELECT %s FROM %s ORDER BY %s" % (",".join(cols), tbl, order))]',
    'rcols = ' + JSON.stringify(R_COLS),
    'scols = ' + JSON.stringify(S_COLS),
    'wcols = ' + JSON.stringify(W_COLS),
    'out = {"recipes": dump("recipes", rcols, "sku_id"),',
    '       "sop": dump("sop_steps", scols, "sku_id,step_no"),',
    '       "wo": dump("sop_workorders", wcols, "id")}',
    'sys.stdout.write(json.dumps(out, ensure_ascii=False))',
  ].join('\n');
  const pyOut = JSON.parse(runPython(py, [pyDb, DOCX]));

  const built = sr.buildRecipes(DOCX);
  sr.seed(nodeDb, built.recipes, built.sop, false);
  const nodeOut = dumpSqlite(nodeDb);

  assert.deepStrictEqual(nodeOut, pyOut, '写库结果不一致');
  console.log('[seed_recipes.test] 写库层 PASS  recipes=' + nodeOut.recipes.length
    + ' sop=' + nodeOut.sop.length + ' workorders=' + nodeOut.wo.length);
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-recipes-'));
  try {
    testParseParity();
    testWriteParity(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('[seed_recipes.test] PASS');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('[seed_recipes.test] FAIL:', e.message);
    process.exit(1);
  }
}
