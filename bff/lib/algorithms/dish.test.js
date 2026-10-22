'use strict';
/*
 * 菜品/配方算法平价测试：Node dish.js 输出 vs Python queue_consumer.py 输出。
 * 同一 fixture 分别跑两端，归一化易变字段（_u/ts/uuid）后深比较。
 * 纯算法（score/match/norm/bom）逐值对比；写库类（auto_link/upsert_recipe/substitute）
 * 通过 node:sqlite 提供与 Python 同结构的 SQLite，比较消息 + 处理后的 data + 落库行。
 * 用法：node bff/lib/algorithms/dish.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dish = require('./dish');
const { runPython: execPy } = require('./_python');

const PY = path.join(__dirname, '../../../old/store-inventory-legacy/python-runtime/queue_consumer.py');

/* ---------- Python 侧：一次性 import ---------- */
function qcPrelude() {
  return `
import json, sys, sqlite3, os, tempfile
import importlib.util
spec = importlib.util.spec_from_file_location("qc", ${JSON.stringify(PY)})
qc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qc)
`;
}

/** 跑纯函数：返回 Python 结果（函数自带 json 序列化） */
function runPython(pyBody, input) {
  const py = qcPrelude() + '\n' + pyBody;
  const out = execPy(py, JSON.stringify(input));
  return JSON.parse(out);
}

/* ---------- 归一化：去掉时间戳与随机 id ---------- */
function normalize(d) {
  const clone = JSON.parse(JSON.stringify(d));
  const stripSku = (v) => (typeof v === 'string' && /^SKU-APP-[0-9a-fA-F]{8}$/.test(v)) ? '<SKU>' : v;
  const stripTs = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) ? '<TS>' : v;
  const clean = (v) => stripTs(stripSku(v));
  const walk = (o) => {
    if (Array.isArray(o)) {
      for (let i = 0; i < o.length; i++) {
        if (typeof o[i] === 'string') o[i] = clean(o[i]);
        else walk(o[i]);
      }
      return;
    }
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      if (k === '_u' || k === 'ts' || k === 'updated_at') { o[k] = '<TS>'; continue; }
      // W4 · ings[].type 为 Node 超集字段（食材/耗材语义分层），Python 参考实现尚未产出，平价比较前剥除（仅原料对象）
      if (k === 'type' && typeof o.id === 'string' && /^I\d+$/.test(o.id)) { delete o[k]; continue; }
      if (k === 'id' || k === 'sku_id') { o[k] = stripSku(o[k]); continue; }
      if (typeof o[k] === 'string' && /^SKU-APP-[0-9a-fA-F]{8}$/.test(o[k])) { o[k] = '<SKU>'; continue; }
      walk(o[k]);
    }
  };
  walk(clone);
  return clone;
}

function normMsg(s) {
  return String(s).replace(/SKU-APP-[0-9A-Fa-f]{8}/g, '<SKU>');
}

/** 把 score 元组 [sc,reason] 浮点对齐（Node 1 vs Python 1.0） */
function tupleEqual(a, b) {
  assert.strictEqual(a.length, b.length, 'tuple len: ' + JSON.stringify(a) + ' != ' + JSON.stringify(b));
  assert.ok(Math.abs(a[0] - b[0]) < 1e-9, 'score ' + a[0] + ' != ' + b[0]);
  assert.strictEqual(a[1], b[1], 'reason');
}

/* ---------- 纯算法 fixture ---------- */
const RECIPES = [
  { sku_id: 'SKU-WF-HONG', name: '五福红饺', color: '红', filling: '猪肉白菜' },
  { sku_id: 'SKU-WF-LV', name: '翡翠白玉饺', color: '绿', filling: '菠菜鸡蛋' },
  { sku_id: 'SKU-WF-BAI-SUANCAI', name: '酸菜饺', color: '白', filling: '酸菜猪肉' },
  { sku_id: 'SKU-APP-D9679BA1', name: '香菇猪肉饺', color: '白', filling: '香菇猪肉' }
];

/* 覆盖：精确名/规范化/别名/分类色别/昵称色别/色别短名/括号色/馅料/包含/模糊/无匹配 */
const SCORE_CASES = [
  { dn: '五福红饺', r: RECIPES[0], cat: null },
  { dn: '御字牌 五福·红（饺）', r: RECIPES[0], cat: null },
  { dn: '红饺', r: RECIPES[0], cat: null },
  { dn: '红', r: RECIPES[0], cat: null },
  { dn: '红·饺子', r: RECIPES[0], cat: null },
  { dn: '翡翠滑虾饺', r: RECIPES[1], cat: null },
  { dn: '长寿饺', r: RECIPES[0], cat: null },
  { dn: '牛肉饺', r: RECIPES[2], cat: null },
  { dn: '五福饺子', r: RECIPES[0], cat: null },
  { dn: '全家福水饺', r: RECIPES[0], cat: null },
  { dn: '水饺', r: RECIPES[0], cat: null },
  { dn: '猪肉白菜饺', r: RECIPES[0], cat: null },
  { dn: '香菇猪肉饺', r: RECIPES[3], cat: null },
  { dn: '测试·香菇猪肉饺', r: RECIPES[3], cat: null },
  { dn: '墨云水饺', r: RECIPES[0], cat: null },
  { dn: '黑金流沙包', r: RECIPES[0], cat: null },
  { dn: '翡翠白玉饺', r: RECIPES[1], cat: null },
  { dn: '完全无关菜名', r: RECIPES[0], cat: null },
  { dn: '', r: RECIPES[0], cat: null },
  { dn: '任意', r: { name: '', sku_id: 'X', color: '', filling: '' }, cat: null },
  { dn: '测试分类', r: RECIPES[0], cat: '红' }
];

const MATCH_CASES = [
  { dn: '五福红饺', list: RECIPES, cat: null },
  { dn: '红饺', list: RECIPES, cat: null },
  { dn: '翡翠滑虾饺', list: RECIPES, cat: null },
  { dn: '五福饺子', list: RECIPES, cat: null },
  { dn: '未知菜', list: RECIPES, cat: null },
  { dn: '酸菜饺', list: RECIPES, cat: null },
  { dn: '饺', list: RECIPES, cat: null },
  { dn: '红', list: RECIPES, cat: null }
];

const NORM_CASES = ['御字牌 五福·红（饺）', '熊猫五福|测试／名', '五福餐厅 水 饺', '普通名', ''];

const BOM_CASES = [
  { main: [{ name: '面粉', qty: 1.9, unit: 'L' }, { name: '盐' }, '清水'] },
  { main: [{ name: '肉', qty: '500g' }, { ing: '菜', qty: 0 }] },
  { main: [] },
  { main: null },
  { main: 'notalist' }
];

/* ---------- apply 纯函数 fixture ---------- */
const APPLY_FIXTURES = {
  upsertNew: {
    fn: 'apply_dish_upsert',
    data: { dishes: [{ id: 'D5', name: 'x' }] },
    payload: { name: '新菜', price: '12.5', cat: '热菜', sku: 'SKU-1' }
  },
  upsertBySkuNull: {
    fn: 'apply_dish_upsert',
    data: { dishes: [{ id: 'D1', name: '旧', sku_id: 'S1', recipe_link: 'r' }] },
    payload: { id: 'D1', price: 9, on: 0, sku_id: '' }
  },
  upsertSameName: {
    fn: 'apply_dish_upsert',
    data: { dishes: [{ id: 'D2', name: '同名菜' }] },
    payload: { name: '同名菜', price: 3 }
  },
  upsertFull: {
    fn: 'apply_dish_upsert',
    data: { dishes: [] },
    payload: { name: '全字段', cat: '凉菜', price: 5, est: 2, cost: 3, on: '上架',
      sku_id: 'SKU-9', recipe_link: 'auto', baoben_id: 'B1', q: 3 }
  },
  priceUpdate: {
    fn: 'apply_dish_price',
    data: { dishes: [{ id: 'D1', name: '菜', price: 10 }] },
    payload: { id: 'D1', price: 8, reason: '促销' }
  },
  priceByName: {
    fn: 'apply_dish_price',
    data: { dishes: [{ id: 'D1', name: '菜', price: 10 }] },
    payload: { name: '菜', price: 12.5 }
  },
  activeOn: {
    fn: 'apply_dish_set_active',
    data: { dishes: [{ id: 'D1', name: '菜', on: false }] },
    payload: { id: 'D1', on: '上架' }
  },
  activeOff: {
    fn: 'apply_dish_set_active',
    data: { dishes: [{ id: 'D1', name: '菜', on: true }] },
    payload: { dish_id: 'D1', on: 0 }
  }
};

/* ---------- DB 类 fixture（Node 提供 sqlite 桥） ----------
 * recipes 行按全量 14 列：[sku_id,name,color,filling,face_main,main,aux,seasoning,
 *   steps,params,blessing,diet_tags,version,updated_at]
 * main/aux/seasoning 传 JSON 字符串（与 SQLite 存储一致）。 */
function recipeRow(sku, name, color, filling, main) {
  return [sku, name, color, filling, null, main || '[]', '[]', '[]', '[]', '{}', null, '[]', 1, 'seed'];
}

const DB_FIXTURES = {
  autoLinkBasic: {
    recipes: [
      recipeRow('SKU-WF-HONG', '五福红饺', '红', '猪肉白菜', '[1]'),
      recipeRow('SKU-WF-LV', '翡翠白玉饺', '绿', '菠菜鸡蛋', '[1]'),
      recipeRow('SKU-WF-BAI-SUANCAI', '酸菜饺', '白', '酸菜猪肉', '[1]'),
      recipeRow('SKU-EMPTY', '空配方', '', '', '[]')
    ],
    data: {
      dishes: [
        { id: 'D1', name: '红饺' },
        { id: 'D2', name: '翡翠白玉饺' },
        { id: 'D3', name: '未知' },
        { id: 'D4', name: '五福饺子' },
        { id: 'D5', name: '酸菜饺', sku_id: 'X' }
      ]
    },
    payload: {}
  },
  autoLinkCreate: {
    recipes: [
      recipeRow('SKU-WF-HONG', '五福红饺', '红', '猪肉白菜', '[1]'),
      recipeRow('SKU-WF-LV', '翡翠白玉饺', '绿', '菠菜鸡蛋', '[1]')
    ],
    data: { dishes: [] },
    payload: { create_missing: true }
  },
  autoLinkForce: {
    recipes: [
      recipeRow('SKU-WF-HONG', '五福红饺', '红', '猪肉白菜', '[1]')
    ],
    data: { dishes: [{ id: 'D1', name: '红饺', sku_id: 'OLD' }] },
    payload: { force: true, create_missing: false }
  },
  recipeUpsertNew: {
    recipes: [],
    data: { dishes: [], ings: [] },
    payload: {
      name: '新配方', color: '红',
      main: [{ name: '面粉', qty: 1.9, unit: 'L' }, { name: '盐' }],
      diet_tags: 'a, b', ensure_ings: true, sync_dish: true, cost: 5
    }
  },
  recipeUpsertUpdate: {
    recipes: [
      ['SKU-R1', '旧名', '黄', null, null, '["旧"]', '[]', '[]', '[]', '{}', null, '[]', 3, 'old']
    ],
    data: { dishes: [], ings: [] },
    payload: {
      sku_id: 'SKU-R1', name: '改名',
      main: [{ name: '面粉', qty: 500, unit: 'g' }],
      aux: [{ name: '水', qty: 200 }], params: { x: 1 }, sync_dish: false
    }
  },
  recipeSubstitute: {
    recipes: [],
    data: { ext: { audits: [] } },
    payload: { from_ing: '猪肉', to_ing: '鸡肉', dish: '饺子' }
  }
};

/* ---------- Node sqlite 桥 ---------- */
function makeStore(getDb) {
  return {
    query(table, where) {
      const db = getDb();
      if (where && where.sku_id !== undefined) {
        return db.prepare('SELECT * FROM ' + table + ' WHERE sku_id=?').all(String(where.sku_id));
      }
      if (where && where.name !== undefined) {
        return db.prepare('SELECT * FROM ' + table + ' WHERE name=?').all(String(where.name));
      }
      return db.prepare('SELECT * FROM ' + table).all();
    },
    upsert(table, row) {
      const db = getDb();
      const keys = Object.keys(row);
      const ph = keys.map(() => '?').join(',');
      db.prepare('INSERT OR REPLACE INTO ' + table + ' (' + keys.join(',') + ') VALUES (' + ph + ')')
        .run(...keys.map((k) => (row[k] === undefined ? null : row[k])));
      return { matched: true };
    },
    insert(table, row) {
      const db = getDb();
      const keys = Object.keys(row);
      const ph = keys.map(() => '?').join(',');
      db.prepare('INSERT INTO ' + table + ' (' + keys.join(',') + ') VALUES (' + ph + ')')
        .run(...keys.map((k) => (row[k] === undefined ? null : row[k])));
      return true;
    }
  };
}

const RECIPE_COLS = 'sku_id TEXT PRIMARY KEY,name TEXT,color TEXT,filling TEXT,face_main TEXT,'
  + 'main TEXT,aux TEXT,seasoning TEXT,steps TEXT,params TEXT,blessing TEXT,diet_tags TEXT,'
  + 'version INTEGER,updated_at TEXT';

function seedRecipeDb(db, rows) {
  db.exec('CREATE TABLE recipes (' + RECIPE_COLS + ')');
  db.exec('CREATE TABLE IF NOT EXISTS app_audit (id INTEGER PRIMARY KEY AUTOINCREMENT,'
    + 'kind TEXT, title TEXT, body TEXT, ts TEXT)');
  const st = db.prepare('INSERT INTO recipes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const r of rows) {
    const full = r.slice();
    while (full.length < 14) full.push(null);
    st.run(...full);
  }
}

/** 把 7 列（目录）或 14 列（全字段）行补足到 14 列 */
function pad14(rows) {
  return (rows || []).map((r) => {
    const full = r.slice();
    while (full.length < 14) full.push(null);
    return full;
  });
}

/* ---------- 主流程 ---------- */
function runDishApply(call, data, payload) {
  switch (call) {
    case 'apply_dish_upsert': return dish.applyDishUpsert(data, payload);
    case 'apply_dish_price': return dish.applyDishPrice(data, payload);
    case 'apply_dish_set_active': return dish.applyDishSetActive(data, payload);
    default: throw new Error('unknown ' + call);
  }
}

function main() {
  let pass = 0;

  /* 1) score_dish_recipe 逐值对比 */
  const scoreNode = SCORE_CASES.map((c) => dish.scoreDishRecipe(c.dn, c.r, null, c.cat));
  const scorePy = runPython(`
data = json.loads(sys.stdin.read())
cases = data["cases"]
out = [list(qc.score_dish_recipe(c["dn"], c["r"], None, dish_cat=c["cat"])) for c in cases]
print(json.dumps(out, ensure_ascii=False))
`, { cases: SCORE_CASES });
  SCORE_CASES.forEach((c, i) => {
    tupleEqual(scoreNode[i], scorePy[i]);
    pass++;
  });
  console.log('  PASS score_dish_recipe x' + SCORE_CASES.length);

  /* 2) match_dish_to_recipe 逐值对比 */
  const matchNode = MATCH_CASES.map((c) => dish.matchDishToRecipe(c.dn, c.list, null, 0.72, c.cat));
  const matchPy = runPython(`
data = json.loads(sys.stdin.read())
out = []
for c in data["cases"]:
    r = qc.match_dish_to_recipe(c["dn"], c["list"], None, min_score=0.72, dish_cat=c["cat"])
    out.append(list(r) if r else None)
print(json.dumps(out, ensure_ascii=False))
`, { cases: MATCH_CASES });
  MATCH_CASES.forEach((c, i) => {
    const n = matchNode[i];
    const p = matchPy[i];
    if (n === null || p === null) {
      assert.strictEqual(n, p, '[' + c.dn + '] null mismatch');
    } else {
      assert.strictEqual(n[0], p[0], '[' + c.dn + '] sku');
      assert.ok(Math.abs(n[1] - p[1]) < 1e-9, '[' + c.dn + '] score');
      assert.strictEqual(n[2], p[2], '[' + c.dn + '] reason');
    }
    pass++;
  });
  console.log('  PASS match_dish_to_recipe x' + MATCH_CASES.length);

  /* 3) _norm_menu_name 对比 */
  const normPy = runPython(`
data = json.loads(sys.stdin.read())
print(json.dumps([qc._norm_menu_name(s) for s in data["cases"]], ensure_ascii=False))
`, { cases: NORM_CASES });
  NORM_CASES.forEach((s, i) => {
    assert.strictEqual(dish.normMenuNameDish(s), normPy[i], 'norm: ' + s);
    pass++;
  });
  console.log('  PASS _norm_menu_name x' + NORM_CASES.length);

  /* 4) _bom_lines 对比 */
  const bomPy = runPython(`
data = json.loads(sys.stdin.read())
out = []
for c in data["cases"]:
    out.append(qc._bom_lines(c, "main"))
print(json.dumps(out, ensure_ascii=False))
`, { cases: BOM_CASES });
  BOM_CASES.forEach((c, i) => {
    assert.deepStrictEqual(dish.bomLines(c, 'main'), bomPy[i], 'bom: ' + JSON.stringify(c));
    pass++;
  });
  console.log('  PASS _bom_lines x' + BOM_CASES.length);

  /* 5) dish.upsert / price / set_active 平价 */
  for (const [name, fx] of Object.entries(APPLY_FIXTURES)) {
    const nd = JSON.parse(JSON.stringify(fx.data));
    const nodeMsg = runDishApply(fx.fn, nd, fx.payload);
    const py = runPython(`
d = json.loads(sys.stdin.read())
payload = d.pop("__payload__")
msg = qc.${fx.fn}(d, payload)
print(json.dumps({"data": d, "msg": msg}, ensure_ascii=False))
`, Object.assign({ __payload__: fx.payload }, fx.data));
    assert.strictEqual(normMsg(nodeMsg), normMsg(py.msg), '[' + name + '] msg');
    assert.deepStrictEqual(normalize(nd), normalize(py.data), '[' + name + '] data');
    pass++;
    console.log('  PASS ' + name);
  }

  /* 6) DB 类：auto_link / upsert_recipe / substitute */
  const { DatabaseSync } = require('node:sqlite');
  for (const [name, fx] of Object.entries(DB_FIXTURES)) {
    // Node 侧：内存 sqlite
    const db = new DatabaseSync(':memory:');
    seedRecipeDb(db, fx.recipes || []);
    const ctx = { store: makeStore(() => db), data: null };
    const nd = JSON.parse(JSON.stringify(fx.data));
    ctx.data = nd;
    let nodeMsg;
    if (name.indexOf('autoLink') === 0) {
      nodeMsg = dish.applyDishAutoLink(ctx, nd, fx.payload);
    } else if (name.indexOf('recipeUpsert') === 0) {
      nodeMsg = dish.upsertRecipe(ctx, nd, fx.payload);
    } else {
      nodeMsg = dish.insertRecipeSubstitute(ctx, nd, fx.payload);
    }
    const nodeRows = db.prepare('SELECT * FROM recipes ORDER BY sku_id').all();

    // Python 侧：临时 sqlite 文件
    const tdb = path.join(os.tmpdir(), 'dish_test_' + Math.random().toString(16).slice(2) + '.db');
    fs.writeFileSync(tdb, '');
    const py = qcPrelude() + `
db_path = ${JSON.stringify(tdb)}
c = sqlite3.connect(db_path)
c.execute("CREATE TABLE recipes (${RECIPE_COLS})")
c.execute("CREATE TABLE IF NOT EXISTS app_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, title TEXT, body TEXT, ts TEXT)")
for r in json.loads(${JSON.stringify(JSON.stringify(pad14(fx.recipes)))}):
    c.execute("INSERT INTO recipes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", r)
c.commit(); c.close()
d = json.loads(sys.stdin.read())
payload = d.pop("__payload__")
name = ${JSON.stringify(name)}
if name.startswith("autoLink"):
    msg = qc.apply_dish_auto_link(db_path, d, payload)
elif name.startswith("recipeUpsert"):
    msg = qc.upsert_recipe(db_path, d, payload)
else:
    msg = qc.insert_recipe_substitute(db_path, payload)
c = sqlite3.connect(db_path)
rows = c.execute("SELECT * FROM recipes ORDER BY sku_id").fetchall()
c.close()
os.remove(db_path)
print(json.dumps({"data": d, "msg": msg, "rows": rows}, ensure_ascii=False))
`;
    const pyOut = JSON.parse(execPy(py, JSON.stringify(Object.assign({ __payload__: fx.payload }, fx.data))));

    assert.strictEqual(normMsg(nodeMsg), normMsg(pyOut.msg), '[' + name + '] msg: '
      + normMsg(nodeMsg) + ' != ' + normMsg(pyOut.msg));
    assert.deepStrictEqual(normalize(nd), normalize(pyOut.data), '[' + name + '] data');
    // 落库行对比：把 Node 行转普通数组（顺序与 SELECT * 列一致）
    const nodeRowArr = nodeRows.map((r) => Object.values(JSON.parse(JSON.stringify(r))));
    assert.deepStrictEqual(normalize(nodeRowArr), normalize(pyOut.rows), '[' + name + '] rows');
    db.close();
    pass++;
    console.log('  PASS ' + name);
  }

  /* 7) 错误语义平价 */
  const errorCases = [
    { fn: 'apply_dish_upsert', data: { dishes: [] }, payload: {}, kw: '缺少菜品名' },
    { fn: 'apply_dish_price', data: { dishes: [] }, payload: { id: 'D1' }, kw: '缺少 price' },
    { fn: 'apply_dish_price', data: { dishes: [{ id: 'D1', price: 1 }] }, payload: { id: 'D1', price: -1 }, kw: '售价不能为负' },
    { fn: 'apply_dish_price', data: { dishes: [] }, payload: { id: 'DX', price: 1 }, kw: '找不到菜品' },
    { fn: 'apply_dish_set_active', data: { dishes: [] }, payload: {}, kw: '缺少 id' },
    { fn: 'apply_dish_set_active', data: { dishes: [{ id: 'D1' }] }, payload: { id: 'D1' }, kw: '缺少 on' }
  ];
  for (const ec of errorCases) {
    const nd = JSON.parse(JSON.stringify(ec.data));
    let nerr = null;
    try { runDishApply(ec.fn, nd, ec.payload); } catch (e) { nerr = e.message; }
    const pyErr = runPython(`
d = json.loads(sys.stdin.read())
payload = d.pop("__payload__")
try:
    qc.${ec.fn}(d, payload)
    print(json.dumps({"err": None}))
except Exception as e:
    print(json.dumps({"err": str(e)}, ensure_ascii=False))
`, Object.assign({ __payload__: ec.payload }, ec.data)).err;
    assert.ok(nerr !== null, '[' + ec.fn + '] Node 未抛错');
    assert.ok(pyErr !== null, '[' + ec.fn + '] Python 未抛错');
    assert.ok(nerr.indexOf(ec.kw) >= 0, 'Node 错误: ' + nerr);
    assert.ok(pyErr.indexOf(ec.kw) >= 0, 'Python 错误: ' + pyErr);
    pass++;
    console.log('  PASS error ' + ec.kw);
  }

  console.log('[dish.test] PASS ' + pass + ' cases');
}

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('[dish.test] FAIL:', e.message);
    if (e.actual !== undefined) {
      console.error('actual  :', JSON.stringify(e.actual));
      console.error('expected:', JSON.stringify(e.expected));
    }
    process.exit(1);
  }
}
