'use strict';
/*
 * lib/recipe_import.js — 食谱卡批量导入「解析层」（纯函数 · 零写 · 零第三方依赖）
 *
 * 来源：旧系统《熊猫五福餐厅进销存系统_真实数据版.html》批量导入区块，逐步骤移植：
 *   IMP_REC_DEFS :3374    parseRecTable :3422    previewRecImport :3709
 *   readImportFile :3329（= 本文件复用 lib/recv_import.js 的 loadRowSource）
 *
 * 与进货单导入（lib/recv_import.js）的差别只有「列定义 + 分组维度」：
 *   进货单 → 按「供应商+日期」拆单；食谱卡 → 按「菜品名称」拆菜（菜名合并单元格向下补齐）。
 * 格式层（xlsx / 伪 .xls(网页表格) / csv / tsv / json、表头自动定位、手动指定列）**整层复用**，
 * 不再重复实现（红线：零第三方依赖，xlsx 走 recv_import 自研 zip+deflate）。
 *
 * 红线核对：
 *   ① 只 require Node 内置模块（经 recv_import 间接用 zlib），不得引入第三方包。
 *   ② 本文件绝不写库 / 不发网络请求 —— 只做「bytes → docs / preview」纯计算；
 *      真正的写仍走 /api/actions 队列（执行器 recipe.import，见 algorithms/dish.js）。
 *   ③ 解析失败一律显式报错（err），绝不静默丢弃；不支持的格式在界面写清。
 *
 * 运行自检：node lib/recipe_import.test.js
 */
const R = require('./recv_import');

/* ------------------------------------------------------------------ */
/* 列定义：别名表逐字照抄旧版 IMP_REC_DEFS（HTML:3374-3381）             */
/* ------------------------------------------------------------------ */

const IMP_REC_DEFS = {
  dish: {
    alts: ['菜品名称', '菜品', '菜名', '品项名称', '出品名称', 'dish'],
    req: 1
  },
  dishCat: { alts: ['菜品分类', '菜品类型', '类别', '类型', '分类', '系列'] },
  ingName: {
    alts: ['原料名称', '原料', '食材', '食材名称', '物料名称', '物料', '配料', '主料', '配料名称', '成分'],
    req: 1
  },
  qty: { alts: ['净料用量', '净用量', '用量', '数量', '单份用量', '每份用量', '配料用量', '主料用量'], req: 1 },
  unit: { alts: ['库存单位', '单位', '计量单位', 'unit'] },
  cat: { alts: ['原料分类', '分类', '类别'] }
};

/** 人工可读列名（预览面板 / 手动指定列用，对齐旧版 IMP_LABELS.rec :3385） */
const IMP_REC_LABELS = {
  dish: '菜品名称',
  dishCat: '菜品分类',
  ingName: '原料名称',
  qty: '净料用量',
  unit: '库存单位',
  cat: '原料分类'
};

/** 手动指定列面板的候选字段顺序 */
const REC_FIELDS = ['dish', 'dishCat', 'ingName', 'qty', 'unit', 'cat'];

/** 供界面展示「支持的列名别名」 */
function aliasPreview() {
  const out = {};
  REC_FIELDS.forEach((k) => { out[k] = IMP_REC_DEFS[k].alts.slice(); });
  return out;
}

/* ------------------------------------------------------------------ */
/* 解析：JSON / 表格                                                    */
/* ------------------------------------------------------------------ */

/** 取第一个非空值（复用 recv_import 的同名语义） */
function pickFirst(o, keys) {
  for (let i = 0; i < keys.length; i++) {
    const v = o[keys[i]];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

const DISH_KEYS = ['dish', 'dishName', 'name', '菜品名称', '菜品', '菜名'];
const DISH_CAT_KEYS = ['dishCat', 'dish_cat', '菜品分类', '菜品类型', '系列', 'cat2'];
const ING_KEYS = ['ingName', 'ing_name', 'ing', 'name', '原料名称', '原料', '配料', '食材'];
const QTY_KEYS = ['qty', 'netQty', 'net_qty', '净料用量', '净用量', '用量', '数量'];
const UNIT_KEYS = ['unit', '库存单位', '单位'];
const ING_CAT_KEYS = ['ingCat', 'ing_cat', 'cat', '原料分类', '分类'];

/**
 * JSON 分支。两种形态都收（与 docs/迁移基线/FP-菜品配方.md §7 记录一致）：
 *   a) 已分组：{recipes:[{dish,cat,lines:[{ingName,qty,unit}]}]}
 *   b) 扁平：  {items:[{dish,ingName,qty,unit}]} / 裸数组
 */
function parseRecJson(text) {
  let o = null;
  try {
    o = JSON.parse(text);
  } catch (e) {
    return { docs: [], err: 'JSON 解析失败：' + e.message };
  }
  let arr = null;
  if (Array.isArray(o)) arr = o;
  else if (o && Array.isArray(o.recipes)) arr = o.recipes;
  else if (o && Array.isArray(o.items)) arr = o.items;
  else if (o && Array.isArray(o.lines)) arr = [o];
  if (!arr) return { docs: [], err: 'JSON 缺少 recipes / items / lines 明细列表' };

  const map = new Map();
  const order = [];
  let bad = 0;
  const push = (dishName, dishCat, line) => {
    const dish = String(dishName || '').trim();
    const ingName = R.cleanName(line.ingName);
    const qty = Number(line.qty);
    if (!dish) { bad++; return; }
    if (!ingName || !isFinite(qty) || qty <= 0) { bad++; return; }
    if (!map.has(dish)) {
      map.set(dish, { dish: dish, cat: String(dishCat || '').trim(), lines: [] });
      order.push(dish);
    }
    const g = map.get(dish);
    if (!g.cat && dishCat) g.cat = String(dishCat).trim();
    g.lines.push({ ingName: ingName, qty: qty, unit: String(line.unit || '').trim(), cat: String(line.cat || '').trim() });
  };

  for (const x of arr) {
    const xo = x || {};
    const dishName = R.cleanName(pickFirst(xo, DISH_KEYS));
    const dishCat = pickFirst(xo, DISH_CAT_KEYS);
    const lines = Array.isArray(xo.lines) ? xo.lines : (Array.isArray(xo.rows) ? xo.rows : null);
    if (lines) {
      for (const l of lines) {
        const lo = l || {};
        push(dishName, dishCat, {
          ingName: pickFirst(lo, ING_KEYS),
          qty: R.numOr(pickFirst(lo, QTY_KEYS)),
          unit: pickFirst(lo, UNIT_KEYS),
          cat: pickFirst(lo, ING_CAT_KEYS)
        });
      }
    } else {
      /* 扁平：一行一个原料 */
      push(dishName, dishCat, {
        ingName: pickFirst(xo, ING_KEYS.filter((k) => k !== 'name').concat(['name'])),
        qty: R.numOr(pickFirst(xo, QTY_KEYS)),
        unit: pickFirst(xo, UNIT_KEYS),
        cat: pickFirst(xo, ING_CAT_KEYS)
      });
    }
  }
  const docs = order.map((k) => map.get(k)).filter((d) => d.lines.length);
  if (!docs.length) return { docs: [], bad: bad, err: 'JSON 里没有有效明细（菜品名称非空、净料用量 >0）' };
  return { docs: docs, bad: bad };
}

/**
 * 表格分支（xlsx / 网页表格 / csv 通用）。
 * @param src  loadRowSource 结果
 * @param ov   手动指定列覆盖：{rows, rowIndex, map, sheet}（旧版 parseRecTable(src,ov) 同款）
 */
function parseRecTable(src, ov) {
  let f = null;
  if (ov && ov.map && Object.keys(ov.map).length) {
    const rows = ov.rows || (src && src.rows) || [];
    f = {
      rows: rows,
      hit: { rowIndex: (ov.rowIndex == null ? -1 : ov.rowIndex), map: ov.map },
      sheet: ov.sheet
    };
  } else {
    f = R.pickTable(src, IMP_REC_DEFS, [['ingName'], ['dish'], ['qty']]);
  }
  if (!f) {
    return {
      docs: [],
      err: '未识别到食谱卡表头。需含「菜品名称」+「原料名称」+「净料用量」三列'
        + '（支持列名别名，见界面「支持的表头」）；也可点「手动指定列」自行对应'
    };
  }
  const objs = R.rowsToObjs(f.rows, IMP_REC_DEFS, f.hit);
  const map = new Map();
  const order = [];
  let bad = 0;
  let skipped = 0;
  let lastDish = '';
  let lastCat = '';
  for (const o of objs) {
    const first = o.__cells.filter((x) => x)[0] || '';
    if (R.NOISE_RE.test(first)) continue;
    /* 菜品名合并单元格：Excel 里只在首行写菜名，其余空 → 向下补齐（旧版 :3431） */
    let dish = R.cleanName(o.dish);
    if (!dish) dish = lastDish;
    else lastDish = dish;
    let cat = R.cleanName(o.dishCat);
    if (cat) lastCat = cat;
    const ingName = R.cleanName(o.ingName);
    if (R.NOISE_RE.test(ingName)) continue;
    if (!dish) { skipped++; continue; }
    if (!ingName) { bad++; continue; }
    const qty = R.numOr(o.qty);
    if (!isFinite(qty) || qty <= 0) { bad++; continue; }
    if (!map.has(dish)) {
      map.set(dish, { dish: dish, cat: cat || lastCat, lines: [] });
      order.push(dish);
    }
    const g = map.get(dish);
    if (!g.cat && (cat || lastCat)) g.cat = cat || lastCat;
    g.lines.push({
      ingName: ingName,
      qty: qty,
      unit: String(o.unit || '').trim(),
      cat: String(o.cat || '').trim()
    });
  }
  const docs = order.map((k) => map.get(k)).filter((d) => d.lines.length);
  if (!docs.length) {
    return {
      docs: [],
      bad: bad,
      skipped: skipped,
      sheet: f.sheet,
      err: '已识别到表头，但没有解析出有效明细行（原料名称需非空、净料用量需 >0）'
    };
  }
  return {
    docs: docs,
    bad: bad,
    skipped: skipped,
    sheet: f.sheet,
    headerRowIndex: f.hit.rowIndex,
    colMap: f.hit.map
  };
}

/* ------------------------------------------------------------------ */
/* 解析入口                                                             */
/* ------------------------------------------------------------------ */

/**
 * bytes → docs（纯计算，零写）
 * @param {Buffer|Uint8Array} bytes
 * @param {string} fileName
 * @param {object} [override] 手动指定列：{rows,rowIndex,map,sheet}
 */
function parseRecFile(bytes, fileName, override) {
  const src = R.loadRowSource(bytes, fileName);
  if (src.err) return { docs: [], format: src.format, err: src.err };
  const out = src.json ? parseRecJson(src.text) : parseRecTable(src, override);
  const sheets = src.sheets || [];
  let grid = src.rows || [];
  if (override && Array.isArray(override.rows) && override.rows.length) grid = override.rows;
  else if (sheets.length) grid = sheets[0].rows || [];
  return {
    docs: out.docs || [],
    bad: out.bad || 0,
    skipped: out.skipped || 0,
    format: src.format,
    sheet: out.sheet || (sheets[0] && sheets[0].name) || '',
    sheetCount: sheets.length || 1,
    /* 手动指定列用：前 25 行 × 前 30 列 */
    headRows: grid.slice(0, 25).map((r) => (r || []).slice(0, 30)),
    headerRowIndex: out.headerRowIndex != null ? out.headerRowIndex : -1,
    colMap: out.colMap || null,
    err: out.err
  };
}

/* ------------------------------------------------------------------ */
/* 预览（只读）                                                         */
/* ------------------------------------------------------------------ */

/** 该菜已有配方行数：优先金丰配方主数据（ext.recipes），回落 data.rec（菜品↔配方绑定） */
function existingLinesOf(snap, dishName, dish) {
  const recipes = (snap && snap.ext && Array.isArray(snap.ext.recipes)) ? snap.ext.recipes : [];
  const r = recipes.find((x) => x && String(x.name || '').trim() === dishName);
  if (r) {
    return ['main', 'aux', 'seasoning', 'face_main'].reduce((n, k) => {
      const v = r[k];
      return n + (Array.isArray(v) ? v.length : (v ? 1 : 0));
    }, 0);
  }
  const rec = (snap && snap.data && snap.data.rec) || null;
  if (rec && dish) {
    const byId = dish.id != null ? rec[dish.id] : null;
    const bySku = dish.sku_id ? rec[dish.sku_id] : null;
    const cur = byId || bySku;
    if (Array.isArray(cur)) return cur.length;
  }
  return 0;
}

/**
 * docs → 预览模型（对齐旧版 previewRecImport :3709 的校验与聚合规则）
 *
 * 未匹配的原料 / 菜品**自动建档**（旧版 createIngFromImport / createDishFromImport 同款）：
 * 预览层只登记清单（零写），真正的建档在执行器 recipe.import（走 upsertRecipe 的
 * ensure_ings / sync_dish 分支——与手工「新增菜谱」完全同一条写入口）。
 *
 * @param {Array} docs [{dish,cat,lines:[{ingName,qty,unit,cat}]}]
 * @param {object} snap 快照 {data:{ings,dishes,rec}, ext:{recipes}}
 */
function buildRecPreview(docs, snap) {
  const data = (snap && snap.data) || {};
  const ingByName = new Map();
  for (const g of (data.ings || [])) {
    const n = String((g && g.name) || '').trim();
    if (n && !ingByName.has(n)) ingByName.set(n, g);
  }
  const dishByName = new Map();
  for (const x of (data.dishes || [])) {
    const n = String((x && x.name) || '').trim();
    if (n && !dishByName.has(n)) dishByName.set(n, x);
  }

  const groups = [];
  const newNames = [];
  const newIngs = [];
  const newDishes = [];
  let bad = 0;
  let totalLines = 0;
  for (const doc of docs || []) {
    const d = doc || {};
    const dishName = String(d.dish || '').trim();
    if (!dishName) continue;
    const rows = [];
    for (const l of (d.lines || [])) {
      const nm = String((l && l.ingName) || '').trim();
      const qty = Number(l && l.qty);
      if (!nm || !isFinite(qty) || qty <= 0) { bad++; continue; }
      const g = ingByName.get(nm);
      const unit = String((l && l.unit) || '').trim()
        || String((g && g.unit) || '').trim() || '斤';
      const cat = String((l && l.cat) || '').trim() || '其他';
      if (!g && newNames.indexOf(nm) < 0) {
        newNames.push(nm);
        newIngs.push({ name: nm, unit: unit, cat: cat });
      }
      rows.push({
        ingId: g ? String(g.id) : '',
        name: g ? String(g.name) : nm,
        isNew: !g,
        qty: qty,
        unit: unit,
        cat: cat
      });
      totalLines++;
    }
    if (!rows.length) continue;
    const dish = dishByName.get(dishName) || null;
    if (!dish && newDishes.indexOf(dishName) < 0) newDishes.push(dishName);
    groups.push({
      dish: dishName,
      cat: String(d.cat || '').trim() || '常规',
      dishId: dish ? String(dish.id) : '',
      skuId: (dish && dish.sku_id) ? String(dish.sku_id) : '',
      isNewDish: !dish,
      existing: existingLinesOf(snap, dishName, dish),
      lines: rows
    });
  }
  return {
    groups: groups,
    bad: bad,
    totalLines: totalLines,
    unmatched: newNames,
    newIngs: newIngs,
    newDishes: newDishes,
    single: groups.length === 1
  };
}

const MAX_UPLOAD = 8 * 1024 * 1024;

/**
 * 预览总入口（供 routes/kitchen.js 调用）：base64 → 预览模型。
 * **红线：本函数只读，不写任何文件/数据库。**
 *
 * @param {{contentBase64?:string, bytes?:Buffer, fileName?:string, override?:object}} input
 * @param {object} snap 快照（读 data.ings / data.dishes / data.rec / ext.recipes）
 */
function previewRecImport(input, snap) {
  const inp = input || {};
  let bytes = null;
  if (inp.bytes) bytes = Buffer.from(inp.bytes);
  else if (typeof inp.contentBase64 === 'string' && inp.contentBase64) {
    bytes = Buffer.from(inp.contentBase64, 'base64');
  }
  if (!bytes || !bytes.length) return { ok: false, error: '缺少文件内容（contentBase64）' };
  if (bytes.length > MAX_UPLOAD) {
    return { ok: false, error: '文件过大（上限 8MB，实到 ' + Math.round(bytes.length / 1048576) + 'MB）' };
  }
  const fileName = String(inp.fileName || 'import.csv');
  const override = (inp.override && typeof inp.override === 'object' && !Array.isArray(inp.override))
    ? inp.override : null;

  let parsed = null;
  try {
    parsed = parseRecFile(bytes, fileName, override);
  } catch (e) {
    return { ok: false, error: '文件解析失败：' + ((e && e.message) || e) };
  }
  const head = {
    format: parsed.format,
    sheet: parsed.sheet,
    sheetCount: parsed.sheetCount,
    rows: parsed.headRows || [],
    headerRowIndex: parsed.headerRowIndex,
    colMap: parsed.colMap,
    labels: IMP_REC_LABELS,
    fields: REC_FIELDS.slice(),
    aliases: aliasPreview()
  };
  if (parsed.err) return { ok: false, error: parsed.err, format: parsed.format, head: head };

  const pv = buildRecPreview(parsed.docs, snap);
  if (!pv.groups.length) {
    return {
      ok: false,
      error: '未解析出可导入的明细行（原料名称需非空、净料用量需 >0）',
      format: parsed.format,
      head: head,
      newIngs: pv.newIngs
    };
  }
  return {
    ok: true,
    format: parsed.format,
    sheet: parsed.sheet,
    sheetCount: parsed.sheetCount,
    skipped: parsed.skipped || 0,
    bad: (parsed.bad || 0) + pv.bad,
    unmatched: pv.unmatched,
    newIngs: pv.newIngs,
    newDishes: pv.newDishes,
    single: pv.single,
    totalLines: pv.totalLines,
    groups: pv.groups,
    head: head
  };
}

module.exports = {
  previewRecImport,
  parseRecFile,
  parseRecJson,
  parseRecTable,
  buildRecPreview,
  existingLinesOf,
  aliasPreview,
  IMP_REC_DEFS,
  IMP_REC_LABELS,
  REC_FIELDS,
  MAX_UPLOAD
};
