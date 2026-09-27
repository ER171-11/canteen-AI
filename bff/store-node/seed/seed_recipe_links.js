'use strict';
/*
 * seed_recipe_links.js — 菜谱全链条「数据缝合」（批0，幂等，可重复执行）
 *
 * 逐行移植 store-inventory/seed_recipe_links.py。干四件事（+ 一件可选）：
 *   a. 原料别名：解析 recipes 表 BOM 行原料名 ↔ docs.data ings 实名，
 *      生成 alias map 写入 docs.data 的 config.ing_alias（键=BOM 名，值=ings 实名）。
 *   b. 填充 DB.rec：按 dishes.sku_id 把 recipes 的 BOM 写进 DB.rec。
 *   c. dishAlias：sales 里的菜品短名写入 docs.data.dishAlias，
 *      并给无 lines 的平铺 sales 记录补 lines:[{dish, qty}]。
 *   d. 占位价修复：9 个 SKU-WF-* 占位菜品 price=0 → 用保本价盘回填 price/est/cost。
 *   e. （默认开，--no-plan 关）按店内 restockLines 同口径重算日均耗量并生成一张
 *      pending 补货建议单进 DB.plans（已有 pending 单则跳过），同时把日均耗量回填 ings.est。
 *
 * 写库方式：走店内 HTTP API（GET /api/db → 改 → PUT /api/db，rev 乐观锁，409 自动重试）。
 *
 * 用法：
 *   node bff/store-node/seed/seed_recipe_links.js --dry-run
 *   node bff/store-node/seed/seed_recipe_links.js [--store-url URL] [--db PATH] [--days N] [--no-plan]
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { httpJson } = require('../common');
const { pyRound, toNum, toInt, todayLocal, localIsoSeconds, deepCopy } = require('./util');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_DB = path.join(REPO_ROOT, 'store-inventory', 'data', '餐厅系统.db');
const DEFAULT_STORE = 'http://127.0.0.1:8765';
const BAOBEN_PATHS = [
  path.join(REPO_ROOT, 'bff', 'data', 'menu-baoben.json'),
  path.join(REPO_ROOT, 'apps', 'boss-app', 'public', 'menu-baoben.json'),
];

// ---------------- 人工别名表（自动匹配判不定时的裁定，宁可不映射不可错映射） ----------------
const MANUAL_ALIAS = {
  猪前肩肉: '前腿半肥肉',
  冬菇: '香菇',
  食盐: '雪天精制盐',
  白绵糖: '白糖',
  葱花: '大葱',
  姜末: '生姜',
  海天蚝油: '海天上等蚝油1kg',
  海天生抽: '海天金标生抽1.9L',
  海天老抽: '海天草菇老抽1.9L',
  味精: '莲花细味精908g',
  料油: '5L金龙鱼非转大豆油',
  香油: '金永丰香麻油860ml',
  南瓜泥: '南瓜',
  菠菜汁: '菠菜',
  木耳: '云耳(好)',
  香芹: '芹菜',
  花椒: '花椒粒',
  大料: '八角',
  王守义十三香: '十三香45g',
};

// 无对应 ings、确认不映射的 BOM 名（清水按 0 成本跳过；其余进 missing 报告）
const SKIP_NAMES = new Set(['清水', '料水']);

// 规格不明、无法从名称解析克重的 ings，按市售常见规格假定
const ASSUMED_SPEC_G = {
  雪天精制盐: 500.0,
  食用墨鱼汁: 90.0,
  紫薯粉: 100.0,
  '东北酸菜(切丝)': 500.0,
};

// BOM 数量单位 → 克
const UNIT_TO_G = {
  g: 1.0,
  克: 1.0,
  kg: 1000.0,
  斤: 500.0,
  两: 50.0,
  ml: 1.0,
  l: 1000.0,
  L: 1000.0,
  升: 1000.0,
  '': 1.0,
};

// 一份 = 15 只饺子
const PORTION_PIECES = 15;

const QTY_RE = /^(.+?)\s*([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z\u4e00-\u9fff%]*)$/;
const PAREN_RE_G = /[（(][^）)]*[）)]/g;
const SPEC_RE = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l|L|升)/;
const SPEC_RE_G = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l|L|升)/g;
const INNER_RE = /[（(]([^）)]*[0-9][^）)]*)[）)]/;

/** Python str(v)：None → "None"。 */
function pyStr(v) {
  return v === null || v === undefined ? 'None' : String(v);
}

function stripParens(s) {
  return String(s === null || s === undefined ? '' : s).replace(PAREN_RE_G, '').trim();
}

/** 对齐店内 HTML cleanName()：去首尾空白/星号/间隔号。 */
function cleanName(s) {
  let str = String(s === null || s === undefined ? '' : s);
  str = str.replace(/^[\s\u3000*＊·・]+/, '');
  str = str.replace(/[\s\u3000*＊]+$/, '');
  return str.trim();
}

/** '猪前肩肉500g' → ['猪前肩肉', 500.0, 'g']；失败返回 [原文, 0, 'g']。 */
function parseQtyText(s) {
  const raw = String(s === null || s === undefined ? '' : s).trim();
  const m = QTY_RE.exec(raw);
  if (!m) return [raw, 0.0, 'g'];
  const name = m[1].trim();
  let qty;
  try {
    qty = parseFloat(m[2]);
  } catch (e) {
    qty = 0.0;
  }
  if (!Number.isFinite(qty)) qty = 0.0;
  const unit = (m[3] || 'g').trim() || 'g';
  return [name, qty, unit];
}

/** 一条 BOM 字符串 → [[name, qty_g, 原文], ...]（可能展开多条）。 */
function parseBomLine(line) {
  const out = [];
  const s = String(line === null || line === undefined ? '' : line).trim();
  if (!s) return out;
  // 复合行：括号内含带数量的顿号子项 → 展开子项（主料水本身是水，跳过）
  const inner = INNER_RE.exec(s);
  const head = s.replace(PAREN_RE_G, '').trim();
  if (inner && inner[1].includes('、')) {
    for (const seg of inner[1].split('、')) {
      const [n, q, u] = parseQtyText(seg);
      if (n && q > 0) out.push([n, q * (UNIT_TO_G[u] !== undefined ? UNIT_TO_G[u] : 1.0), s]);
    }
    return out;
  }
  // 顿号并列且每段都带数量 → 拆分
  if (head.includes('、')) {
    const segs = head.split('、').map(parseQtyText);
    if (segs.every((x) => x[1] > 0)) {
      for (const [n, q, u] of segs) {
        out.push([n, q * (UNIT_TO_G[u] !== undefined ? UNIT_TO_G[u] : 1.0), s]);
      }
      return out;
    }
  }
  const [n, q, u] = parseQtyText(head);
  if (n && q > 0) out.push([n, q * (UNIT_TO_G[u] !== undefined ? UNIT_TO_G[u] : 1.0), s]);
  return out;
}

/** 1 个 ing.unit 等于多少克（avg 是 per-unit 价，成本=qty_g/本值*avg）。 */
function gramsPerUnit(g) {
  const unit = String((g && g.unit) || '').trim();
  const name = String((g && g.name) || '');
  if (unit === '斤') return 500.0;
  if (unit === 'kg' || unit === '公斤') return 1000.0;
  if (unit === 'g' || unit === '克') return 1.0;
  const m = SPEC_RE.exec(name);
  if (m) {
    const v = parseFloat(m[1]);
    const u = m[2];
    return v * (u === 'kg' || u === 'L' || u === 'l' || u === '升' ? 1000.0 : 1.0);
  }
  if (Object.prototype.hasOwnProperty.call(ASSUMED_SPEC_G, name)) return ASSUMED_SPEC_G[name];
  return null;
}

/** 去名称尾部规格（1.9L/900g/45g/500ml 等）用于匹配。 */
function stripSpec(name) {
  let s = String(name === null || name === undefined ? '' : name).replace(SPEC_RE_G, '');
  const chars = ' *xX/件瓶包桶罐盒支袋';
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start])) start++;
  while (end > start && chars.includes(s[end - 1])) end--;
  return s.slice(start, end);
}

/** 读取 recipes 表（main/aux/seasoning/params JSON 解析）。 */
function loadRecipes(dbPath) {
  const conn = new DatabaseSync(dbPath);
  try {
    const rows = conn
      .prepare(
        'SELECT sku_id, name, color, face_main, main, aux, seasoning, params FROM recipes ORDER BY sku_id'
      )
      .all();
    return rows.map((r) => {
      const d = Object.assign({}, r);
      for (const col of ['main', 'aux', 'seasoning', 'params']) {
        const def = col !== 'params' ? [] : {};
        try {
          d[col] = d[col] ? JSON.parse(d[col]) : def;
        } catch (e) {
          d[col] = def;
        }
      }
      return d;
    });
  } finally {
    conn.close();
  }
}

/** 一个 recipe → [[bom_name, qty_g, 原文, 部位], ...]。 */
function recipeBomEntries(rec) {
  const entries = [];
  for (const [col, part] of [
    ['face_main', '面皮'],
    ['main', '主料'],
    ['aux', '辅料'],
    ['seasoning', '调味'],
  ]) {
    const v = rec[col];
    const lines = Array.isArray(v) ? v : v ? [v] : [];
    for (const line of lines) {
      for (const [name, qtyG, raw] of parseBomLine(line)) {
        entries.push([name, qtyG, raw, part]);
      }
    }
  }
  return entries;
}

/** BOM 名 → ing 行。精确 → 人工表 → 去规格精确 → 唯一双向包含。判不定返回 [null, null]。 */
function resolveIng(bomName, ings, report) {
  const name = String(bomName).trim();
  const byName = {};
  for (const g of ings) byName[String(g.name || '').trim()] = g;
  if (Object.prototype.hasOwnProperty.call(byName, name)) return [byName[name], '精确'];
  if (Object.prototype.hasOwnProperty.call(MANUAL_ALIAS, name)) {
    const tgt = MANUAL_ALIAS[name];
    if (Object.prototype.hasOwnProperty.call(byName, tgt)) return [byName[tgt], '人工表'];
    report.push('人工表目标不存在：' + name + ' → ' + tgt);
    return [null, null];
  }
  const sn = stripSpec(name);
  for (const g of ings) {
    if (stripSpec(g.name) === sn && sn) return [g, '去规格'];
  }
  const hits = ings.filter((g) => {
    const gn = String(g.name || '');
    return (
      (name && gn.includes(name)) ||
      (sn && sn.length >= 2 && gn.includes(sn)) ||
      (gn && name.includes(gn))
    );
  });
  if (hits.length === 1) return [hits[0], '包含'];
  return [null, null];
}

function loadBaoben() {
  for (const p of BAOBEN_PATHS) {
    if (fs.existsSync(p)) {
      return { doc: JSON.parse(fs.readFileSync(p, 'utf8')), path: p };
    }
  }
  return { doc: null, path: null };
}

async function getDb(baseUrl) {
  const res = await httpJson('GET', baseUrl.replace(/\/+$/, '') + '/api/db');
  if (res.status >= 400) throw new Error('HTTP ' + res.status);
  return res.body;
}

function parseArgs(argv) {
  const out = { storeUrl: DEFAULT_STORE, db: DEFAULT_DB, days: 30, dryRun: false, noPlan: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--store-url') out.storeUrl = argv[++i];
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--days') out.days = parseInt(argv[++i], 10);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-plan') out.noPlan = true;
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv || process.argv.slice(2));

  const recipes = loadRecipes(args.db);
  console.log('[i] recipes 表 ' + recipes.length + ' 行：' + recipes.map((r) => r.sku_id).join('、'));

  const cur = await getDb(args.storeUrl);
  const rev = cur.rev;
  const data = cur.data;
  console.log(
    '[i] 店内库 rev=' + rev +
      ' ings=' + ((data.ings || []).length) +
      ' dishes=' + ((data.dishes || []).length) +
      ' sales=' + ((data.sales || []).length) +
      ' rec=' + Object.keys(data.rec || {}).length +
      ' dishAlias=' + Object.keys(data.dishAlias || {}).length +
      ' plans=' + ((data.plans || []).length)
  );

  const ings = data.ings || [];
  const dishes = data.dishes || [];
  const sales = data.sales || [];
  const warn = [];

  // ---------- a. 原料别名 ----------
  const alias = {};
  const unmapped = {};
  const ingUsed = {};
  const bomEntriesBySku = {};
  for (const rec of recipes) {
    const entries = recipeBomEntries(rec);
    bomEntriesBySku[rec.sku_id] = entries;
    for (const [name, qtyG, raw, part] of entries) {
      if (SKIP_NAMES.has(name)) continue;
      const [g, how] = resolveIng(name, ings, warn);
      if (g === null) {
        if (!unmapped[name]) unmapped[name] = new Set();
        unmapped[name].add(rec.sku_id);
        continue;
      }
      const real = pyStr(g.name);
      alias[name] = real;
      ingUsed[real] = g;
    }
  }
  // 同时给「原始带括号名」也立键
  for (const rec of recipes) {
    for (const col of ['face_main', 'main', 'aux', 'seasoning']) {
      const v = rec[col];
      const lines = Array.isArray(v) ? v : v ? [v] : [];
      for (const line of lines) {
        const m = QTY_RE.exec(String(line || '').trim());
        const rawName = m ? m[1].trim() : '';
        const head = stripParens(rawName);
        if (rawName && Object.prototype.hasOwnProperty.call(alias, head) && !Object.prototype.hasOwnProperty.call(alias, rawName)) {
          alias[rawName] = alias[head];
        }
      }
    }
  }

  console.log('\n== a. 原料别名（config.ing_alias：BOM 名 → ings 实名）==');
  for (const k of Object.keys(alias).sort()) {
    const g = ingUsed[alias[k]];
    const gpu = g ? gramsPerUnit(g) : null;
    let specNote = '';
    if (g && Object.prototype.hasOwnProperty.call(ASSUMED_SPEC_G, alias[k])) {
      specNote = '（规格假定 ' + ASSUMED_SPEC_G[alias[k]] + ' g/' + g.unit + '）';
    }
    console.log(
      '  ' + k + ' → ' + alias[k] + ' [ing=' + (g ? g.id : '?') + ' unit=' + (g ? g.unit : '?') +
        ' avg=' + (g ? g.avg : '?') + ' gpu=' + gpu + ']' + specNote
    );
  }
  if (Object.keys(unmapped).length) {
    console.log('  -- 未映射（无对应 ings，进成本卡 missing，不猜）--');
    for (const k of Object.keys(unmapped).sort()) {
      console.log('  !! ' + k + '  (SKU: ' + Array.from(unmapped[k]).sort().join('、') + ')');
    }
  }
  for (const w of warn) console.log('  [warn] ' + w);

  // ---------- b. DB.rec ----------
  const dishesBySku = {};
  for (const d of dishes) {
    const sku = d.sku_id;
    if (sku) {
      const k = String(sku);
      if (!dishesBySku[k]) dishesBySku[k] = [];
      dishesBySku[k].push(d);
    }
  }
  const recNew = deepCopy(data.rec || {});
  const recReport = [];
  for (const rec of recipes) {
    const sku = rec.sku_id;
    const targets = dishesBySku[sku] || [];
    if (!targets.length) {
      recReport.push('  !! ' + sku + ' 无挂 sku_id 的菜品，跳过');
      continue;
    }
    let lines = [];
    const params = rec.params || {};
    let batchPieces = toInt(params['一批出成_个'], 67);
    if (batchPieces <= 0) batchPieces = 67;
    const ratio = PORTION_PIECES / batchPieces;
    for (const [name, qtyG, raw, part] of bomEntriesBySku[sku]) {
      if (SKIP_NAMES.has(name)) continue;
      const real = alias[name];
      const g = ingUsed[real];
      if (!g) continue;
      const gpu = gramsPerUnit(g);
      if (!gpu) {
        recReport.push('  !! ' + sku + ' 规格不明无法换算，跳过 rec 行：' + name + '（' + real + '）');
        continue;
      }
      const qty = pyRound((qtyG * ratio) / gpu, 4);
      lines.push({ ing: String(g.id), qty: qty });
    }
    const merged = {};
    for (const l of lines) merged[l.ing] = pyRound(toNum(merged[l.ing], 0) + l.qty, 4);
    lines = Object.keys(merged).map((k) => ({ ing: k, qty: merged[k] }));
    for (const d of targets) recNew[pyStr(d.id)] = lines;
    recReport.push('  ' + sku + ' → 菜品 ' + targets.map((d) => pyStr(d.id)).join('、') + '，' + lines.length + ' 行');
  }
  console.log('\n== b. DB.rec 填充（{ing, qty} qty=每份用量，按 ing.unit 换算；批→份按 ' + PORTION_PIECES + ' 只/份）==');
  console.log(recReport.join('\n'));
  console.log('  rec 菜品数：' + Object.keys(data.rec || {}).length + ' → ' + Object.keys(recNew).length);

  // ---------- c. dishAlias + sales 补 lines ----------
  const colorSku = {};
  for (const rec of recipes) {
    const c = String(rec.color || '');
    if (c && !Object.prototype.hasOwnProperty.call(colorSku, c)) colorSku[c] = rec.sku_id;
  }
  const dishById = {};
  const dishByName = {};
  for (const d of dishes) {
    dishById[pyStr(d.id)] = d;
    dishByName[String(d.name || '')] = d;
  }

  const aliasBase = data.dishAlias && typeof data.dishAlias === 'object' && !Array.isArray(data.dishAlias)
    ? Object.assign({}, data.dishAlias)
    : {};
  const aliasDelta = {};
  const shortNames = Array.from(new Set(sales.filter((s) => s.dish).map((s) => String(s.dish || '')))).sort();
  console.log('\n== c. dishAlias 与 sales.lines ==');
  for (const nm of shortNames) {
    const key = cleanName(nm);
    if (Object.prototype.hasOwnProperty.call(aliasBase, key) || Object.prototype.hasOwnProperty.call(aliasDelta, key)) continue;
    const colors = new Set(sales.filter((s) => s.dish === nm).map((s) => String(s.color || '')));
    let target = null;
    if (Object.prototype.hasOwnProperty.call(dishByName, nm)) {
      target = dishByName[nm];
    } else if (colors.size === 1) {
      const c = Array.from(colors)[0];
      if (Object.prototype.hasOwnProperty.call(colorSku, c)) target = dishById[String(colorSku[c])];
    }
    if (target !== null && target !== undefined) {
      aliasDelta[key] = { dish: pyStr(target.id), mul: 1 };
      console.log('  别名 ' + key + ' → ' + target.id + '（' + target.name + '）');
    } else {
      console.log('  !! 短名 ' + nm + ' 无法定位菜品（colors=' + Array.from(colors).sort().join('、') + '），不映射');
    }
  }
  const aliasAll = Object.assign({}, aliasBase, aliasDelta);

  function saleDishId(s, amap) {
    const nm = String(s.dish || '');
    const a = amap[cleanName(nm)];
    if (a && Object.prototype.hasOwnProperty.call(dishById, String(a.dish))) return String(a.dish);
    if (Object.prototype.hasOwnProperty.call(dishByName, nm)) return pyStr(dishByName[nm].id);
    const c = String(s.color || '');
    if (Object.prototype.hasOwnProperty.call(colorSku, c) && Object.prototype.hasOwnProperty.call(dishById, colorSku[c])) {
      return colorSku[c];
    }
    return null;
  }

  function applySalesLines(salesList, amap) {
    let added = 0;
    for (const s of salesList) {
      if (Array.isArray(s.lines) && s.lines.length) continue;
      const did = saleDishId(s, amap);
      if (!did) continue;
      const qty = toNum(s.qty, NaN);
      if (Number.isNaN(qty)) continue;
      s.lines = [{ dish: did, qty: qty }];
      added += 1;
    }
    return added;
  }

  const salesProbe = deepCopy(sales);
  const linesAdded = applySalesLines(salesProbe, aliasAll);
  console.log('  sales 补 lines：' + linesAdded + ' / ' + sales.length + ' 条');

  // ---------- d. 占位价修复 ----------
  const bb = loadBaoben();
  const bbByName = {};
  for (const it of (bb.doc && bb.doc.items) || []) {
    if (it.name) bbByName[it.name] = it;
  }

  function applyPriceFix(dishesList) {
    const fixed = [];
    for (const d of dishesList) {
      const sku = String(d.sku_id || '');
      if (!sku.startsWith('SKU-WF-')) continue;
      const p = Number(d.price);
      if (Number.isFinite(p) && p > 0) continue;
      const recRow = recipes.find((r) => r.sku_id === sku);
      const color = String((recRow && recRow.color) || d.cat || '');
      const item = color === '白' ? bbByName['全家福水饺'] : bbByName['五福饺子'];
      if (!item) continue;
      d.price = Number(item.price);
      if (!(Number(d.est) > 0)) d.est = Number(item.cost);
      if (!(Number(d.cost) > 0)) d.cost = Number(item.cost);
      d._u = localIsoSeconds();
      fixed.push('  ' + sku + ' price 0 → ' + item.price + '，est/cost → ' + item.cost + '（' + item.name + '）');
    }
    return fixed;
  }

  const dishesProbe = deepCopy(dishes);
  const priceFixed = applyPriceFix(dishesProbe);
  console.log('\n== d. SKU-WF-* 占位价回填（来源 ' + (bb.path || '无') + '）==');
  console.log(priceFixed.length ? priceFixed.join('\n') : '  无需修复');

  // ---------- e. 日均耗量 + 补货建议单 ----------
  const estReport = [];
  let planNew = null;
  if (!args.noPlan) {
    const cfg = data.restock || {};
    const days = toInt(cfg.days || args.days, args.days);
    const lead = toNum(cfg.lead || 0);
    const gap = toNum(cfg.gap || 0);
    const today = todayLocal();
    const back = new Date();
    back.setDate(back.getDate() - (days - 1));
    const pad = (n) => String(n).padStart(2, '0');
    const fromDay = back.getFullYear() + '-' + pad(back.getMonth() + 1) + '-' + pad(back.getDate());
    const use = {};
    const ingById = {};
    for (const g of ings) {
      use[pyStr(g.id)] = 0.0;
      ingById[pyStr(g.id)] = g;
    }
    for (const s of salesProbe) {
      const day = String(s.date || s.ts || '').slice(0, 10);
      if (!day || day < fromDay || day > today) continue;
      for (const sl of s.lines || []) {
        const dd = dishById[pyStr(sl.dish)];
        if (!dd) continue;
        for (const rl of recNew[pyStr(dd.id)] || []) {
          const g = ingById[pyStr(rl.ing)];
          if (!g) continue;
          const yld = toNum(g.yld, 1) || 1;
          use[pyStr(g.id)] += (toNum(sl.qty, 0) * toNum(rl.qty, 0)) / yld;
        }
      }
    }
    const lines = [];
    for (const g of ings) {
      if (g.on === false) continue;
      const gid = pyStr(g.id);
      const daily = pyRound((use[gid] || 0.0) / days, 4);
      const safe = toNum(g.safe, 0);
      const curStock = toNum(g.stock, 0);
      const conv = Math.max(0.0001, toNum(g.conv, 1));
      const need = pyRound(Math.max(0.0, daily * (lead + gap) + safe - curStock), 3);
      if (daily > 0 && !(toNum(g.est, 0) > 0)) estReport.push([g.name, daily, g.unit]);
      if (need <= 0) continue;
      let b = need / conv;
      const moq = toNum(g.moq, 0);
      if (moq > 0) b = Math.max(b, moq);
      const pack = toNum(g.pack, 0);
      if (pack > 0) b = Math.ceil(b / pack - 1e-9) * pack;
      const sug = pyRound(b, 2);
      if (sug <= 0) continue;
      let price = g.last;
      if (!price) price = pyRound(toNum(g.avg, 0) * conv, 2);
      lines.push({
        ing: gid,
        cur: pyRound(curStock, 3),
        safe: safe,
        daily: daily,
        onway: 0,
        need: need,
        sug: sug,
        unit: g.unit === undefined ? null : g.unit,
        buy: g.buy === undefined ? null : g.buy,
        conv: g.conv === undefined ? null : g.conv,
        qty: sug,
        price: price,
        supplier: g.sup || '',
        st: 'pending',
        name: g.name === undefined ? null : g.name,
      });
    }
    lines.sort((a, b) => b.need - a.need);
    const plans = data.plans || [];
    const pending = plans.filter((p) => p.status === 'pending');
    if (pending.length) {
      console.log('\n== e. 已有 pending 补货建议单（' + pending[0].no + '），跳过生成 ==');
    } else if (lines.length) {
      const seq = plans.filter((p) => p.date === today).length + 1;
      const d = new Date();
      const HHMMSS = pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
      planNew = {
        id: 'BYseed' + HHMMSS,
        no: 'BY' + today.replace(/-/g, '') + '-' + String(seq).padStart(3, '0'),
        date: today,
        genAt: localIsoSeconds(),
        by: 'seed_recipe_links',
        status: 'pending',
        lines: lines,
      };
      console.log('\n== e. 生成补货建议单 ' + planNew.no + '：' + lines.length + ' 品项（日均耗量近 ' + days + ' 天 × (lead ' + lead + ' + gap ' + gap + ') + 安全 − 现存）==');
      for (const l of lines.slice(0, 10)) {
        console.log('  ' + l.name + ' 日均 ' + l.daily + l.unit + ' 现 ' + l.cur + ' → 建议补 ' + l.sug);
      }
    } else {
      console.log('\n== e. 无需补货（库存覆盖或耗量为 0）==');
    }
    if (estReport.length) {
      console.log('  回填 ings.est（日耗）：' + estReport.slice(0, 15).map(([n, d, u]) => n + '=' + d + u).join('、'));
    }
  }

  // ---------- 汇总改动 ----------
  const changes = {
    ing_alias: Object.keys(alias).length,
    unmapped: Object.keys(unmapped).length,
    rec_dishes: Object.keys(recNew).length,
    dishAlias: Object.keys(aliasAll).length,
    sales_lines_added: linesAdded,
    price_fixed: priceFixed.length,
    plan_lines: planNew ? planNew.lines.length : 0,
  };
  console.log('\n== 改动汇总 ==', JSON.stringify(changes));

  if (args.dryRun) {
    console.log('\n[dry-run] 不写库。');
    return 0;
  }

  // ---------- 应用 + PUT（rev 乐观锁，409 重试） ----------
  const base = args.storeUrl.replace(/\/+$/, '');
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur2 = await getDb(args.storeUrl);
    const d2 = cur2.data;
    let cfg2 = d2.config;
    if (!(cfg2 && typeof cfg2 === 'object' && !Array.isArray(cfg2))) {
      cfg2 = {};
      d2.config = cfg2;
    }
    cfg2.ing_alias = alias;
    d2.rec = recNew;
    const bAlias = d2.dishAlias;
    const mergedAlias = Object.assign({}, bAlias && typeof bAlias === 'object' && !Array.isArray(bAlias) ? bAlias : {});
    Object.assign(mergedAlias, aliasDelta);
    d2.dishAlias = mergedAlias;
    applySalesLines(d2.sales || [], mergedAlias);
    applyPriceFix(d2.dishes || []);
    let recU = d2._recU;
    if (!(recU && typeof recU === 'object' && !Array.isArray(recU))) {
      recU = {};
      d2._recU = recU;
    }
    const nowIso = localIsoSeconds();
    for (const did of Object.keys(recNew)) {
      if (!Object.prototype.hasOwnProperty.call(recU, did)) recU[did] = nowIso;
    }
    if (planNew) {
      let plans2 = d2.plans;
      if (!Array.isArray(plans2)) {
        plans2 = [];
        d2.plans = plans2;
      }
      if (!plans2.some((p) => p.status === 'pending')) plans2.push(planNew);
    }
    if (estReport.length) {
      const dailyByName = {};
      for (const [n, dd, uu] of estReport) dailyByName[n] = dd;
      for (const g of d2.ings || []) {
        const nm = g.name;
        if (Object.prototype.hasOwnProperty.call(dailyByName, nm) && !(toNum(g.est, 0) > 0)) {
          g.est = pyRound(dailyByName[nm], 4);
        }
      }
    }
    const res = await httpJson('PUT', base + '/api/db', { rev: cur2.rev, data: d2, machine: 'SEED' });
    if (res.status === 409 && attempt < 2) {
      console.log('[warn] rev 冲突，重试 ' + (attempt + 1));
      continue;
    }
    if (res.status >= 400) throw new Error('HTTP ' + res.status);
    console.log('\n[ok] 已写库 rev ' + cur2.rev + ' → ' + ((res.body || {}).rev));
    break;
  }

  // ---------- 断言 ----------
  const fin = await getDb(args.storeUrl);
  const fd = fin.data;
  const nRec = Object.keys(fd.rec || {}).length;
  const nAlias = Object.keys((fd.config || {}).ing_alias || {}).length;
  const nDalias = Object.keys(fd.dishAlias || {}).length;
  const nSkuPriced = (fd.dishes || []).filter(
    (d) => String(d.id || '').startsWith('SKU-WF-') && Number(d.price) > 0
  ).length;
  const nLines = (fd.sales || []).filter((s) => s.lines).length;
  const nPlans = (fd.plans || []).filter((p) => p.status === 'pending').length;
  console.log('\n== 断言 ==');
  console.log('  DB.rec 菜品数 = ' + nRec + '（应 >0）' + (nRec > 0 ? 'OK' : 'FAIL'));
  console.log(
    '  config.ing_alias 条数 = ' + nAlias + '（BOM 名 ' + (nAlias + Object.keys(unmapped).length) +
      ' 个，未映射 ' + Object.keys(unmapped).length + ' 个：' + (Object.keys(unmapped).sort().join('、') || '无') + '）' +
      (nAlias > 0 ? 'OK' : 'FAIL')
  );
  console.log('  dishAlias 条数 = ' + nDalias + '（应 ≥5）' + (nDalias >= 5 ? 'OK' : 'FAIL'));
  console.log('  SKU-WF-* price>0 个数 = ' + nSkuPriced + ' / 9 ' + (nSkuPriced === 9 ? 'OK' : 'FAIL'));
  console.log('  sales 带 lines = ' + nLines + ' / ' + (fd.sales || []).length);
  console.log('  pending plans = ' + nPlans);
  const ok = nRec > 0 && nAlias > 0 && nDalias >= 5 && nSkuPriced === 9;
  console.log('\n' + (ok ? '全部断言通过' : '存在未过断言，请检查上面 FAIL 项'));
  return ok ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code || 0),
    (e) => {
      console.error(e && e.stack ? e.stack : e);
      process.exit(1);
    }
  );
}

module.exports = {
  DEFAULT_DB,
  DEFAULT_STORE,
  MANUAL_ALIAS,
  SKIP_NAMES,
  ASSUMED_SPEC_G,
  UNIT_TO_G,
  PORTION_PIECES,
  stripParens,
  cleanName,
  parseQtyText,
  parseBomLine,
  gramsPerUnit,
  stripSpec,
  loadRecipes,
  recipeBomEntries,
  resolveIng,
  loadBaoben,
  parseArgs,
  main,
};
