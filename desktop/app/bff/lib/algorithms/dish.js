'use strict';
/*
 * lib/algorithms/dish.js — 菜品/配方域算法（迁移自 store-inventory/queue_consumer.py）
 *
 * 覆盖动作：
 *   dish.upsert          → applyDishUpsert
 *   dish.price           → applyDishPrice
 *   dish.set_active      → applyDishSetActive
 *   dish.auto_link       → applyDishAutoLink
 *   recipe.upsert        → upsertRecipe
 *   recipe.substitute    → insertRecipeSubstitute
 *
 * 约定：纯函数优先，直接原地修改 data（与 Python 版一致）；
 * 与 SQLite 强耦合的 _recipe_catalog / insert_recipe_substitute / upsert_recipe
 * 统一改走 ctx.store（query/insert/upsert），无 ctx.store 时优雅降级：
 *   - 菜谱目录回落 data.ext.recipes
 *   - 配方写入回落 data.ext.recipes / data.dishes，并标注「未写库」
 * 绝不因缺 store 抛崩溃，也不静默丢动作。
 */

const crypto = require('crypto');
const { nowIso, num, arr, normMenuName } = require('./util');
const { applyIngUpsert } = require('./inventory');

/* ---------- 通用辅助 ---------- */

/** 生成唯一 id：对齐 Python uuid.uuid4().hex[:n] */
function uidHex(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

/** Python 浮点转字符串（对齐 "%s" % float：整数浮点保留 .0） */
function pf(x) {
  if (typeof x !== 'number' || !isFinite(x)) return String(x);
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

/** Python float() 语义：失败抛错 */
function toFloat(v) {
  if (typeof v === 'number') {
    if (isFinite(v)) return v;
    throw new Error('invalid float');
  }
  const s = String(v).trim();
  if (s === '') throw new Error('invalid float');
  const n = Number(s);
  if (Number.isNaN(n)) throw new Error('invalid float');
  return n;
}

/** 对齐 Python dict.get 缺键：undefined → null */
function pt(v) {
  return v === undefined ? null : v;
}

/** Python bool(x in (True,1,"1","true",...)) 真值判定 */
function truthyOn(v, extra) {
  if (v === true || v === 1 || v === '1' || v === 'true' || v === '上架') return true;
  if (extra) for (const e of extra) if (v === e) return true;
  return false;
}

/** 取出 data.ext（快照扩展，承载 recipes 等） */
function extOf(data) {
  return (data && data.ext && typeof data.ext === 'object' && !Array.isArray(data.ext))
    ? data.ext : {};
}

/* ---------- 五福映射常量（与 Python 逐字一致） ---------- */

/* 五福色别短名 → 有 BOM 的 sku（智能关联优先） */
const WF_COLOR_SKU = {
  红: 'SKU-WF-HONG',
  黄: 'SKU-WF-HUANG',
  绿: 'SKU-WF-LV',
  紫: 'SKU-WF-ZI',
  黑: 'SKU-WF-HEI'
};
const WF_ALIAS_SKU = {
  红饺: 'SKU-WF-HONG',
  黄饺: 'SKU-WF-HUANG',
  绿饺: 'SKU-WF-LV',
  紫饺: 'SKU-WF-ZI',
  黑饺: 'SKU-WF-HEI',
  酸菜饺: 'SKU-WF-BAI-SUANCAI',
  牛肉饺: 'SKU-WF-BAI-NIUROU',
  西葫芦饺: 'SKU-WF-BAI-XIHULU',
  山药饺: 'SKU-WF-BAI-SHANYAO',
  香菇猪肉饺: 'SKU-APP-D9679BA1',
  '测试·香菇猪肉饺': 'SKU-APP-D9679BA1',
  墨云水饺: 'SKU-WF-HEI',
  墨云饺: 'SKU-WF-HEI',
  黑金饺: 'SKU-WF-HEI',
  长寿饺: 'SKU-WF-HONG',
  富贵饺: 'SKU-WF-HUANG',
  康宁饺: 'SKU-WF-LV',
  好德饺: 'SKU-WF-ZI'
};
/* 名字里出现的色/馅暗示 → 色别（再映射到唯一色 SKU；白馅另走关键词） */
const WF_NICK_COLOR = {
  墨云: '黑', 墨鱼: '黑', 三鲜: '黑', 黑金: '黑',
  翡翠: '绿', 菠菜: '绿', 玉米: '绿', 康宁: '绿',
  长寿: '红', 冬菇: '红', 荸荠: '红',
  富贵: '黄', 茴香: '黄',
  好德: '紫', 香芹: '紫'
};

/* ---------- dish.upsert ---------- */

/**
 * dish.upsert：菜品新增/修改（名/分类/售价/成本/上下架/sku_id）。
 * 与 Python 版逐行对齐，注意 float() 对 string 亦可用。
 */
function applyDishUpsert(data, payload) {
  if (data.dishes === undefined || data.dishes === null) data.dishes = [];
  const dishes = data.dishes;
  if (!Array.isArray(dishes)) throw new Error('data.dishes 不是数组');
  let name = String(payload.name || '').trim();
  if (!name && !(payload.id || payload.dish_id)) throw new Error('缺少菜品名');
  let did = String(payload.id || payload.dish_id || '').trim();
  const now = nowIso();

  const applyFields = (d) => {
    if (name) d.name = name;
    if (payload.cat !== undefined && payload.cat !== null) d.cat = payload.cat;
    if (payload.price !== undefined && payload.price !== null) d.price = toFloat(payload.price);
    if (payload.est !== undefined && payload.est !== null) d.est = toFloat(payload.est);
    if (payload.cost !== undefined && payload.cost !== null) d.cost = toFloat(payload.cost);
    if (payload.on !== undefined && payload.on !== null) d.on = truthyOn(payload.on);
    if (Object.prototype.hasOwnProperty.call(payload, 'sku_id')
      || Object.prototype.hasOwnProperty.call(payload, 'sku')) {
      const sku = Object.prototype.hasOwnProperty.call(payload, 'sku_id') ? payload.sku_id : payload.sku;
      if (sku === null || sku === undefined || sku === '') {
        delete d.sku_id;
        delete d.recipe_link;
      } else {
        d.sku_id = String(sku).trim();
        if (payload.recipe_link) d.recipe_link = payload.recipe_link;
        else if (payload.link_reason) d.recipe_link = payload.link_reason;
      }
    }
    if (payload.baoben_id !== undefined && payload.baoben_id !== null) d.baoben_id = payload.baoben_id;
    d._u = now;
  };

  for (const d of dishes) {
    if (did && String(d.id) === did) {
      if (!name) name = String(d.name || '');
      applyFields(d);
      return 'dish 更新 ' + d.id + ' ' + d.name + ' sku=' + (d.sku_id || '-');
    }
    if (!did && name && String(d.name) === name) {
      did = String(d.id);
      applyFields(d);
      return 'dish 同名更新 ' + did + ' sku=' + (d.sku_id || '-');
    }
  }

  if (!name) throw new Error('缺少菜品名');
  const nums = [];
  for (const d of dishes) {
    const m = String(d.id || '');
    if (m[0] === 'D' && /^\d+$/.test(m.slice(1))) nums.push(parseInt(m.slice(1), 10));
  }
  const newId = did || ('D' + (nums.length ? Math.max(...nums) + 1 : 900));
  const price = toFloat(payload.price || 0);
  const est = toFloat(payload.est !== undefined && payload.est !== null
    ? payload.est : (payload.cost || 0));
  const onVal = payload.on === undefined || payload.on === null ? true : truthyOn(payload.on);
  const row = {
    id: newId,
    name: name,
    cat: payload.cat || '常规',
    price: price,
    est: est,
    cost: toFloat(payload.cost !== undefined && payload.cost !== null ? payload.cost : est),
    q: parseInt(payload.q || 0, 10) || 0,
    on: onVal,
    _u: now
  };
  if (payload.sku_id || payload.sku) row.sku_id = String(payload.sku_id || payload.sku).trim();
  if (payload.baoben_id) row.baoben_id = payload.baoben_id;
  if (payload.recipe_link || payload.link_reason) {
    row.recipe_link = payload.recipe_link || payload.link_reason;
  }
  dishes.push(row);
  return 'dish 新建 ' + newId + ' ' + name + ' ¥' + pf(price) + ' sku=' + (row.sku_id || '-');
}

/* ---------- dish.price ---------- */

/** dish.price：调价（只改售价，可附 reason）。 */
function applyDishPrice(data, payload) {
  if (data.dishes === undefined || data.dishes === null) data.dishes = [];
  const dishes = data.dishes;
  if (!Array.isArray(dishes)) throw new Error('data.dishes 不是数组');
  const did = String(payload.id || payload.dish_id || '').trim();
  const name = String(payload.name || '').trim();
  if (payload.price === undefined || payload.price === null) throw new Error('缺少 price');
  const newPrice = toFloat(payload.price);
  if (newPrice < 0) throw new Error('售价不能为负');
  for (const d of dishes) {
    if ((did && String(d.id) === did) || (name && String(d.name) === name)) {
      const old = d.price;
      d.price = newPrice;
      d._u = nowIso();
      if (payload.reason) d.price_note = String(payload.reason);
      return 'dish 调价 ' + d.id + ' ' + d.name + ' → ¥' + pf(newPrice)
        + '（原 ¥' + String(old) + '）';
    }
  }
  throw new Error('找不到菜品 ' + (did || name));
}

/* ---------- dish.set_active ---------- */

/** dish.set_active：上下架。 */
function applyDishSetActive(data, payload) {
  if (data.dishes === undefined || data.dishes === null) data.dishes = [];
  const dishes = data.dishes;
  if (!Array.isArray(dishes)) throw new Error('data.dishes 不是数组');
  const did = String(payload.id || payload.dish_id || '').trim();
  if (!did) throw new Error('缺少 id');
  const on = payload.on;
  if (on === undefined || on === null) throw new Error('缺少 on');
  const active = truthyOn(on);
  for (const d of dishes) {
    if (String(d.id) === did) {
      d.on = active;
      d._u = nowIso();
      return 'dish ' + did + ' ' + (active ? '上架' : '下架');
    }
  }
  throw new Error('找不到菜品 ' + did);
}

/* ---------- 规范化 + 菜谱目录 ---------- */

/**
 * 去品牌前缀/空格，保留括号内色别与馅料，避免多色饺子撞成同名。
 * 注意：与 util.normMenuName 语义不同（util 版会去括号后缀），此处保真 Python。
 */
function normMenuNameDish(s) {
  let t = String(s == null ? '' : s).trim();
  t = t.replace(/\|/g, '').replace(/·/g, '').replace(/／/g, '/');
  t = t.replace(/（/g, '(').replace(/）/g, ')');
  for (const p of ['御字牌', '熊猫五福', '五福餐厅']) t = t.replace(new RegExp(p, 'g'), '');
  t = t.replace(/\s+/g, '');
  return t;
}

/** 某列 main/aux/seasoning 是否非空（对齐 Python：字符串则 json.loads，失败按原值） */
function bomColNonEmpty(col) {
  if (!col) return false;
  let parsed = col;
  if (typeof col === 'string') {
    try {
      parsed = JSON.parse(col);
    } catch (e) {
      parsed = col;
    }
  }
  return pyTruthy(parsed);
}

/** Python 真值：None/False/0/''/[]/{}/() 为假 */
function pyTruthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/**
 * 有 BOM 的菜谱列表 [{sku_id,name,color,filling}]。
 * 优先 ctx.store.query('recipes')；无 store 时回落 data.ext.recipes，再次回落空。
 */
function recipeCatalog(ctx, data) {
  let rows = [];
  if (ctx && ctx.store && typeof ctx.store.query === 'function') {
    const q = ctx.store.query('recipes');
    if (Array.isArray(q)) rows = q;
    else if (q && Array.isArray(q.rows)) rows = q.rows;
  } else {
    rows = arr(extOf(data).recipes);
  }
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const sku = r.sku_id !== undefined ? r.sku_id : r.sku;
    if (sku === undefined || sku === null) continue;
    const hasBom = bomColNonEmpty(r.main) || bomColNonEmpty(r.aux) || bomColNonEmpty(r.seasoning);
    if (!hasBom) continue;
    out.push({
      sku_id: sku,
      name: r.name || '',
      color: r.color || '',
      filling: r.filling || ''
    });
  }
  return out;
}

/* ---------- score_dish_recipe（核心纯算法，逐字保真） ---------- */

/** Python difflib.SequenceMatcher(None,a,b).ratio() 等价实现 */
function seqRatio(a, b) {
  const s1 = String(a == null ? '' : a);
  const s2 = String(b == null ? '' : b);
  const n = s1.length;
  const m = s2.length;
  if (n === 0 && m === 0) return 1;
  if (n === 0 || m === 0) return 0;
  const dp = new Array(m + 1).fill(0);
  let prev;
  for (let i = 1; i <= n; i++) {
    prev = 0;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      dp[j] = s1[i - 1] === s2[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const matches = dp[m];
  return (2 * matches) / (n + m);
}

/** 从字符串中取连续 2+ 个中日韩汉字（对齐 Python re.findall r"[\u4e00-\u9fff]{2,}"） */
function hanTokens(s) {
  const out = [];
  const re = /[\u4e00-\u9fff]{2,}/g;
  let m;
  while ((m = re.exec(String(s == null ? '' : s))) !== null) out.push(m[0]);
  return out;
}

/**
 * 0~1 匹配分 + 原因。权重/阈值与 Python 逐字一致。
 * @returns {[number,string]} [score, reason]
 */
function scoreDishRecipe(dishName, recipe, dishBaoben, dishCat) {
  const dn = String(dishName == null ? '' : dishName).trim();
  const rn = String((recipe && recipe.name) || '').trim();
  const sku = String((recipe && recipe.sku_id) || '');
  const color = String((recipe && recipe.color) || '');
  if (!dn || !rn) return [0.0, ''];
  if (dn === rn) return [1.0, '全名一致'];
  const nd = normMenuNameDish(dn);
  const nr = normMenuNameDish(rn);
  if (nd && nd === nr) return [0.98, '规范化同名'];
  // 别名表
  const alias = WF_ALIAS_SKU[dn] || WF_ALIAS_SKU[nd];
  if (alias && alias === sku) return [0.96, '别名'];
  // 菜品分类字段直接是色别（红/黄/绿/紫/黑）
  const cat = String(dishCat == null ? '' : dishCat).trim();
  if (WF_COLOR_SKU[cat] && WF_COLOR_SKU[cat] === sku) return [0.94, '分类色别'];
  // 营销昵称 → 色别（仅饺子类）
  const isJiao = (dn.indexOf('饺') >= 0) || !!WF_COLOR_SKU[cat] || (cat === '白');
  for (const nick of Object.keys(WF_NICK_COLOR)) {
    if (!isJiao) break;
    const nickColor = WF_NICK_COLOR[nick];
    if (dn.indexOf(nick) >= 0 && nickColor === color
      && WF_COLOR_SKU[color] && WF_COLOR_SKU[color] === sku) {
      return [0.92, '昵称色别'];
    }
  }
  // 色别短名：红饺 / 五福红 / 红·饺子
  if (color && WF_COLOR_SKU[color] && WF_COLOR_SKU[color] === sku) {
    const esc = color.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(esc + '\\s*饺|饺[\\s\\S]*?' + esc + '|五福[\\s\\S]*?' + esc
      + '|' + esc + '[\\s\\S]*?五福').test(dn)) {
      return [0.93, '色别短名'];
    }
    if (nd === color + '饺' || nd === '五福' + color || nd === color + '五福') {
      return [0.93, '色别短名'];
    }
    if (new RegExp('[（(]\\s*' + esc + '\\s*[）)]').test(dn)) return [0.95, '括号色别'];
  }
  // 馅料关键词（饺子类）
  const filling = String((recipe && recipe.filling) || '');
  let fillHit = 0;
  for (const tok of hanTokens(filling)) {
    if (dn.indexOf(tok) >= 0) fillHit += 1;
  }
  if (isJiao && fillHit >= 2 && (dn.indexOf('饺') >= 0 || rn.indexOf('饺') >= 0)) {
    return [Math.min(0.9, 0.7 + 0.08 * fillHit), '馅料关键词×' + fillHit];
  }
  if (isJiao && fillHit >= 1 && color && dn.indexOf(color) >= 0 && dn.indexOf('饺') >= 0) {
    return [0.88, '色+馅'];
  }
  // 白饺：仅馅料命中时挂对应白 SKU
  if (isJiao && color === '白' && fillHit >= 1 && dn.indexOf('饺') >= 0) {
    return [Math.min(0.91, 0.82 + 0.04 * fillHit), '白饺馅料'];
  }
  // 互相包含
  if (nd && nr && (nd.indexOf(nr) >= 0 || nr.indexOf(nd) >= 0)) {
    if (nd.length <= 4 && fillHit === 0 && !(color && dn.indexOf(color) >= 0)) {
      return [0.55, '短名包含'];
    }
    if ((dn === '五福饺子' || dn === '全家福水饺' || dn === '水饺' || dn === '饺子') && color) {
      return [0.35, '泛名歧义'];
    }
    return [0.85, '名称包含'];
  }
  const ratio = (nd && nr) ? seqRatio(nd, nr) : 0.0;
  if (ratio >= 0.72) return [ratio, '模糊' + Math.trunc(Math.round(ratio * 100)) + '%'];
  return [ratio * 0.5, ''];
}

/* ---------- match_dish_to_recipe（核心纯算法） ---------- */

/**
 * 返回 [sku_id, score, reason] 或 null；要求第一名明显领先。
 */
function matchDishToRecipe(dishName, recipes, dishBaoben, minScore, dishCat) {
  if (minScore === undefined || minScore === null) minScore = 0.72;
  const scored = [];
  for (const r of arr(recipes)) {
    const [sc, reason] = scoreDishRecipe(dishName, r, dishBaoben, dishCat);
    if (sc > 0) scored.push([sc, reason, r]);
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b[0] - a[0]);
  const best = scored[0];
  const bestSc = best[0];
  const bestReason = best[1];
  const bestR = best[2];
  if (bestSc < minScore) return null;
  if (bestSc < 0.99 && scored.length > 1
    && scored[1][0] >= bestSc - 0.05 && scored[1][0] >= minScore) {
    return null;
  }
  return [bestR.sku_id, bestSc, bestReason || '智能匹配'];
}

/* ---------- dish.auto_link ---------- */

/** dish.auto_link：按菜名智能挂 sku_id；可选为无菜单的菜谱建壳。 */
function applyDishAutoLink(ctx, data, payload) {
  if (data.dishes === undefined || data.dishes === null) data.dishes = [];
  const dishes = data.dishes;
  if (!Array.isArray(dishes)) throw new Error('data.dishes 不是数组');
  const recipes = recipeCatalog(ctx, data);
  if (!recipes.length) return 'dish.auto_link 无可用菜谱(BOM)';
  let minScore = 0.72;
  try {
    minScore = toFloat(payload.min_score !== undefined && payload.min_score !== null
      ? payload.min_score : 0.72);
  } catch (e) {
    minScore = 0.72;
  }
  const force = truthyOn(payload.force);
  let createMissing = payload.create_missing;
  if (createMissing === undefined || createMissing === null) createMissing = true;
  createMissing = truthyOn(createMissing, ['yes']);

  let linked = 0;
  let skipped = 0;
  let ambiguous = 0;
  let unmatched = 0;
  const details = [];
  const unmatchedNames = [];
  const ambiguousNames = [];
  const usedSkus = new Set();
  for (const d of dishes) if (d && d.sku_id) usedSkus.add(String(d.sku_id));

  for (const d of dishes) {
    if (!(d && typeof d === 'object' && !Array.isArray(d))) continue;
    if (d.sku_id && !force) {
      skipped += 1;
      continue;
    }
    const hit = matchDishToRecipe(d.name, recipes, d.baoben_id, minScore, d.cat);
    if (!hit) {
      const loose = matchDishToRecipe(d.name, recipes, d.baoben_id, 0.55, d.cat);
      if (loose === null) {
        const scored = [];
        for (const r of recipes) {
          const [sc] = scoreDishRecipe(d.name, r, d.baoben_id, d.cat);
          if (sc >= 0.55) scored.push(sc);
        }
        const nm = String(d.name == null ? '' : d.name).trim();
        if (scored.filter((s) => s >= 0.55).length >= 2) {
          ambiguous += 1;
          if (nm) ambiguousNames.push(nm);
        } else {
          unmatched += 1;
          if (nm && (nm.indexOf('饺') >= 0 || WF_COLOR_SKU[d.cat])) unmatchedNames.push(nm);
        }
      } else {
        unmatched += 1;
        const nm = String(d.name == null ? '' : d.name).trim();
        if (nm && (nm.indexOf('饺') >= 0 || WF_COLOR_SKU[d.cat])) unmatchedNames.push(nm);
      }
      continue;
    }
    const sku = hit[0];
    const sc = hit[1];
    const reason = hit[2];
    d.sku_id = sku;
    d.recipe_link = 'auto:' + sc.toFixed(2) + ':' + reason;
    d._u = nowIso();
    usedSkus.add(sku);
    linked += 1;
    const rec = recipes.find((r) => String(r.sku_id) === String(sku));
    const rname = rec ? rec.name : sku;
    const color = rec ? rec.color : '';
    const short = color ? (color + '饺') : String(rname || '').slice(0, 12) || sku;
    details.push(d.name + '→' + short);
  }

  let created = 0;
  if (createMissing) {
    const byName = {};
    const bySku = {};
    for (const x of dishes) {
      if (!(x && typeof x === 'object' && !Array.isArray(x))) continue;
      byName[String(x.name || '')] = x;
      if (x.sku_id) bySku[String(x.sku_id || '')] = x;
    }
    for (const r of recipes) {
      const sku = r.sku_id;
      if (bySku[String(sku)] || usedSkus.has(String(sku))) continue;
      const existing = byName[String(r.name || '')];
      if (existing !== undefined && existing !== null) {
        if (!existing.sku_id || force) {
          existing.sku_id = sku;
          existing.recipe_link = 'auto:ensure';
          existing._u = nowIso();
          usedSkus.add(String(sku));
          linked += 1;
          details.push(existing.name + '→' + sku);
        }
        continue;
      }
      applyDishUpsert(data, {
        id: sku,
        name: r.name,
        cat: r.color || '常规',
        sku_id: sku,
        on: true,
        price: 0,
        recipe_link: 'auto:from_recipe'
      });
      created += 1;
      usedSkus.add(String(sku));
      details.push('+' + sku);
    }
  }

  const tipParts = [];
  if (linked) tipParts.push('新挂' + linked + '道');
  else tipParts.push('无新挂');
  if (created) tipParts.push('菜单补建' + created + '道');
  if (skipped) tipParts.push('已挂不动' + skipped);
  if (ambiguous) tipParts.push('歧义需手选' + ambiguous);
  const jiaoMiss = unmatchedNames.length;
  const otherMiss = Math.max(0, unmatched - jiaoMiss);
  if (jiaoMiss) tipParts.push('饺类未挂' + jiaoMiss + '道');
  if (otherMiss) tipParts.push('非扣料菜跳过' + otherMiss);
  tipParts.push('厨房可扣料' + recipes.length + '道');
  let tip = tipParts.join('；');
  if (details.length) {
    tip += '。挂靠：' + details.slice(0, 8).join('、');
    if (details.length > 8) tip += '…';
  }
  if (unmatchedNames.length || ambiguousNames.length) {
    const hand = ambiguousNames.slice(0, 4).concat(unmatchedNames.slice(0, 4));
    tip += '。请手选：' + hand.slice(0, 6).join('、');
    if (ambiguousNames.length + unmatchedNames.length > 6) tip += '…';
  }
  return 'dish.auto_link ' + tip;
}

/* ---------- recipe.substitute ---------- */

/**
 * recipe.substitute：缺料替换记 app_audit 审计。
 * 有 ctx.store 走 insert；无则写 data.ext.audits（对齐 app_audit 语义），标注未写库。
 */
function insertRecipeSubstitute(ctx, data, payload) {
  if (payload === undefined || payload === null) {
    payload = data || {};
    data = null;
  }
  const frm = payload.from_ing || payload.from || '?';
  const to = payload.to_ing || payload.to || '?';
  const dish = payload.dish || '';
  const body = frm + ' → ' + to + ' · ' + dish;
  if (ctx && ctx.store && typeof ctx.store.insert === 'function') {
    ctx.store.insert('app_audit', {
      kind: 'recipe_substitute',
      title: '缺料替换',
      body: body,
      ts: payload.ts || nowIso()
    });
    return 'recipe.substitute ' + frm + '→' + to + ' (记审计)';
  }
  // 降级：写 data.ext.audits（对齐 app_audit 语义），标注未写库
  const d = (data && typeof data === 'object') ? data : {};
  const ext = extOf(d);
  const audits = Array.isArray(ext.audits) ? ext.audits : (ext.audits = []);
  audits.push({ kind: 'recipe_substitute', title: '缺料替换', body: body, ts: nowIso() });
  return 'recipe.substitute ' + frm + '→' + to + ' (记审计·未写库)';
}

/* ---------- dish.delete（FP-DISH-06） ---------- */

/**
 * 销售单是否引用了该菜：id / 菜名 / sku_id 三选一命中即视为「已有销售记录」。
 * 旧版只比对 l.dish === d.id（HTML:2676）；新版销售线路里可能存的是 sku_id（如 SKU-WF-HONG），
 * 故一并比对 sku_id 与菜名，避免把有销售的菜误删。
 */
function dishReferencedBySales(data, dish) {
  const ids = {};
  if (dish.id != null) ids[String(dish.id)] = 1;
  if (dish.name) ids[String(dish.name)] = 1;
  if (dish.sku_id) ids[String(dish.sku_id)] = 1;
  const sales = Array.isArray(data.sales) ? data.sales : [];
  for (const s of sales) {
    if (!s) continue;
    const lines = Array.isArray(s.lines) ? s.lines : [];
    for (const l of lines) {
      if (l && l.dish != null && ids[String(l.dish)]) return true;
    }
    if (s.dish != null && ids[String(s.dish)]) return true;
  }
  return false;
}

/**
 * dish.delete：删除菜品（含其配方绑定）。旧版 delDish（HTML:2675-2680）逐条移植。
 *
 * 红线：有销售记录的菜**禁删**，只允许停售（旧版同口径）。物理删除是本域既定口径
 * （同 order.delete / pos.table_remove），本函数**不触碰库存**。
 *
 * 新版把「菜品主数据」与「配方主数据」分开了，故删除范围与旧版略有不同：
 *   - 菜品体：从 data.dishes 移除；
 *   - 配方绑定：删 data.rec[dish.id] / data.rec[sku_id]（结账扣料的依据）；
 *   - 金丰配方主数据（recipes 表 / ext.recipes）**不删**——它是全店配方目录，不是本菜的附属物。
 */
function applyDishDelete(data, payload) {
  if (!Array.isArray(data.dishes)) throw new Error('data.dishes 不是数组');
  const key = String((payload && (payload.id || payload.dish_id || payload.name || payload.dish)) || '').trim();
  if (!key) throw new Error('dish.delete 缺 id/name');
  const idx = data.dishes.findIndex((d) => d && (String(d.id) === key || String(d.name) === key
    || (d.sku_id && String(d.sku_id) === key)));
  if (idx < 0) throw new Error('找不到菜品 ' + key);
  const d = data.dishes[idx];
  if (dishReferencedBySales(data, d)) {
    throw new Error('该菜已有销售记录，不能删除（可停售）：' + (d.name || d.id));
  }
  const rec = (data.rec && typeof data.rec === 'object' && !Array.isArray(data.rec)) ? data.rec : null;
  let unbind = 0;
  if (rec) {
    for (const k of [d.id, d.sku_id]) {
      if (k != null && rec[String(k)] !== undefined) {
        delete rec[String(k)];
        unbind += 1;
      }
    }
  }
  data.dishes.splice(idx, 1);
  return 'dish 删除 ' + (d.id || '') + ' ' + (d.name || '')
    + (unbind ? ' · 解除配方绑定' + unbind + ' 处' : '');
}

/* ---------- recipe.import（FP-DISH-16/18：食谱卡批量导入的唯一写入口） ---------- */

/** BOM 行字符串 → 原料名（去尾部「用量+单位」，去括号规格） */
function bomNameOf(line) {
  let s = String(line == null ? '' : line).trim();
  s = s.replace(/[\d./]+\s*[a-zA-Z\u4e00-\u9fff]*\s*$/, '').trim();
  return s.replace(/[（(].*?[）)]/g, '').trim() || String(line == null ? '' : line).trim();
}

/** 导入行 → {name,qty,unit,cat}；非法行返回 null */
function importRowOf(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const name = String(r.name || r.ing || r.ingName || r.ing_name || '').trim();
  const qty = Number(r.qty);
  if (!name || !isFinite(qty) || qty <= 0) return null;
  return {
    name: name,
    qty: qty,
    unit: String(r.unit || 'g').trim() || 'g',
    cat: String(r.cat || '').trim()
  };
}

/** 读当前配方主料行（字符串数组），供 merge 模式按原料合并 */
function currentMainOf(ctx, data, name) {
  const store = (ctx && ctx.store) ? ctx.store : null;
  let row = null;
  if (store && typeof store.query === 'function') {
    row = queryOne(store, 'recipes', { name: name });
  } else {
    const recipes = extOf(data).recipes;
    if (Array.isArray(recipes)) row = recipes.find((r) => r && String(r.name) === name) || null;
  }
  if (!row) return null;
  return rowToCur(row).main || [];
}

/** merge：旧行按原料名命中 → 覆盖该行用量；未命中的新原料追加 */
function mergeMainRows(cur, rows) {
  const out = cur.map((s) => String(s));
  const idx = {};
  out.forEach((s, i) => {
    const n = bomNameOf(s);
    if (n && !(n in idx)) idx[n] = i;
  });
  for (const r of rows) {
    const line = r.name + formatG(Number(r.qty)) + r.unit;
    const i = idx[r.name];
    if (i != null) out[i] = line;
    else {
      idx[r.name] = out.length;
      out.push(line);
    }
  }
  return out;
}

/**
 * recipe.import：食谱卡批量导入「提交」（整批一个动作，走审批队列；与 recv.import 同型）。
 *
 * 逐道菜复用**唯一写入口** upsertRecipe（ensure_ings 缺料建档 + sync_dish 同步菜品壳），
 * 因此「未匹配原料/菜品自动建档」的口径与手工「新增菜谱」完全一致，不另起一套写路径。
 *
 * mode='replace'（默认）：视为该菜配方的完整定义 —— 覆盖主料，并清空辅料/调味旧行（旧版覆盖语义）；
 * mode='merge'：按原料名合并用量，未出现的旧行保留。
 * 明细统一记入「主料」；模板无分组列（与旧版一致），导入后可在「编辑配料」里调整分组。
 */
function applyRecipeImport(ctx, data, payload) {
  const groups = (payload && Array.isArray(payload.groups)) ? payload.groups : [];
  if (!groups.length) throw new Error('recipe.import 缺 groups（请先预览再提交）');
  const mode = String((payload && payload.mode) || 'replace') === 'merge' ? 'merge' : 'replace';
  const ensure = (payload && payload.ensure_ings !== undefined)
    ? truthyOn(payload.ensure_ings, ['yes']) : true;
  const syncDish = (payload && payload.sync_dish !== undefined)
    ? truthyOn(payload.sync_dish, ['yes']) : true;

  /* 未匹配原料建档：对齐旧版 createIngFromImport（HTML:2806）——带文件里的「库存单位/原料分类」，
     建完再进 upsertRecipe（其 ensure_ings 会发现已存在而跳过），避免分类一律落成「菜谱挂钩」。 */
  let createdIngs = 0;
  if (ensure) {
    const have = new Set();
    for (const g0 of (Array.isArray(data.ings) ? data.ings : [])) {
      if (g0 && g0.name) have.add(String(g0.name));
    }
    for (const g of groups) {
      for (const r of (Array.isArray(g && g.rows) ? g.rows : []).map(importRowOf).filter(Boolean)) {
        if (have.has(r.name) || r.name === '清水' || r.name === '水') continue;
        applyIngUpsert(data, {
          name: r.name,
          unit: r.unit || '斤',
          cat: r.cat || '菜谱挂钩',
          qty: 0,
          safe: 0,
          on: true
        });
        have.add(r.name);
        createdIngs += 1;
      }
    }
  }

  let saved = 0;
  let lines = 0;
  for (const g of groups) {
    const name = String((g && g.dish) || '').trim();
    if (!name) continue;
    let rows = (Array.isArray(g.rows) ? g.rows : []).map(importRowOf).filter(Boolean);
    if (!rows.length) continue;
    if (mode === 'merge') {
      const cur = currentMainOf(ctx, data, name);
      if (cur && cur.length) rows = mergeMainRows(cur, rows);
    }
    upsertRecipe(ctx, data, {
      name: name,
      dish_cat: String((g.cat || '常规')).trim() || '常规',
      main: rows,
      aux: mode === 'replace' ? [] : undefined,
      seasoning: mode === 'replace' ? [] : undefined,
      ensure_ings: ensure,
      sync_dish: syncDish,
      on: true
    });
    saved += 1;
    lines += rows.length;
  }
  if (!saved) throw new Error('recipe.import 没有可导入的菜（菜品名称需非空、净料用量需 >0）');
  return 'recipe.import ' + saved + ' 道菜 / ' + lines + ' 行'
    + (createdIngs ? ' · 建原料' + createdIngs : '')
    + ' · ' + (mode === 'merge' ? '按原料合并' : '覆盖');
}

/* ---------- _bom_lines ---------- */

/** 把 main/aux/seasoning 收成字符串行：原料名+用量+单位。 */
function bomLines(payload, key) {
  const raw = payload[key];
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (item === undefined || item === null) continue;
    if (typeof item === 'string') {
      const s = item.trim();
      if (s) out.push(s);
      continue;
    }
    if (!(typeof item === 'object' && !Array.isArray(item))) continue;
    const name = String(item.name || item.ing || item.ing_name || '').trim();
    if (!name) continue;
    const qty = item.qty;
    let unit = String(item.unit || 'g').trim() || 'g';
    if (qty === undefined || qty === null || qty === '') {
      out.push(name);
    } else {
      let qf;
      let qtxt;
      try {
        qf = toFloat(qty);
        qtxt = formatG(qf);
      } catch (e) {
        qtxt = String(qty);
      }
      out.push(name + qtxt + unit);
    }
  }
  return out;
}

/** 对齐 Python "%g" % float（去掉尾零，最多 6 位有效数字） */
function formatG(x) {
  if (!isFinite(x)) return String(x);
  if (x === 0) return '0';
  const s = x.toPrecision(6);
  let out = String(parseFloat(s));
  return out;
}

/* ---------- recipe.upsert ---------- */

/**
 * recipe.upsert：写 recipes（走 ctx.store）；可选同步菜品壳、缺料原料建档。
 * 无 ctx.store 时写 data.ext.recipes（stub），并在返回里标注「未写库」。
 */
function upsertRecipe(ctx, data, payload) {
  const name = String(payload.name || '').trim();
  let sku = String(payload.sku_id || payload.sku || payload.id || '').trim();
  if (!name && !sku) throw new Error('recipe.upsert 缺 name/sku_id');

  const store = ctx && ctx.store ? ctx.store : null;
  let cur = null;
  let wrote = false;

  if (store && typeof store.query === 'function') {
    let row = null;
    if (sku) row = queryOne(store, 'recipes', { sku_id: sku });
    if (!row && name) {
      row = queryOne(store, 'recipes', { name: name });
      if (row) sku = row.sku_id !== undefined ? row.sku_id : row[0];
    }
    if (!sku) sku = 'SKU-APP-' + uidHex(8).toUpperCase();
    cur = row ? rowToCur(row) : blankCur(sku, name);
  } else {
    // 从 data.ext.recipes 降级读写
    const ext = extOf(data);
    const recipes = Array.isArray(ext.recipes) ? ext.recipes : (ext.recipes = []);
    let row = null;
    if (sku) row = recipes.find((r) => String(r.sku_id || r.sku) === String(sku));
    if (!row && name) row = recipes.find((r) => String(r.name) === String(name));
    if (row) sku = row.sku_id !== undefined ? row.sku_id : row.sku;
    if (!sku) sku = 'SKU-APP-' + uidHex(8).toUpperCase();
    cur = row ? rowToCur(row) : blankCur(sku, name);
  }

  if (name) cur.name = name;
  for (const k of ['color', 'filling', 'face_main', 'blessing']) {
    if (payload[k] !== undefined && payload[k] !== null) cur[k] = payload[k];
  }
  for (const k of ['main', 'aux', 'seasoning', 'steps']) {
    const lines = bomLines(payload, k);
    if (lines !== null) cur[k] = lines;
  }
  if (payload.params !== undefined && payload.params !== null
    && typeof payload.params === 'object' && !Array.isArray(payload.params)) {
    cur.params = payload.params;
  }
  if (payload.diet_tags !== undefined && payload.diet_tags !== null) {
    let tags = payload.diet_tags;
    if (typeof tags === 'string') {
      tags = tags.split(',').map((t) => t.trim()).filter(Boolean);
    }
    cur.diet_tags = Array.isArray(tags) ? tags : [];
  }
  cur.version = (parseInt(cur.version || 0, 10) || 0) + 1;
  const now = nowIso();
  cur.updated_at = now;

  if (store) {
    if (typeof store.upsert === 'function') {
      store.upsert('recipes', serializeRecipe(cur));
      wrote = true;
    } else if (typeof store.insert === 'function') {
      store.insert('recipes', serializeRecipe(cur));
      wrote = true;
    }
  } else {
    const ext = extOf(data);
    const recipes = Array.isArray(ext.recipes) ? ext.recipes : (ext.recipes = []);
    let hit = -1;
    for (let i = 0; i < recipes.length; i++) {
      if (String(recipes[i] && (recipes[i].sku_id || recipes[i].sku)) === String(cur.sku_id)) {
        hit = i;
        break;
      }
    }
    if (hit >= 0) recipes[hit] = Object.assign({}, recipes[hit], serializeRecipe(cur));
    else recipes.push(serializeRecipe(cur));
  }

  const parts = ['recipe ' + cur.sku_id + ' v' + cur.version];

  // 缺料原料建档（产品库）
  const ensure = truthyOn(payload.ensure_ings, ['yes']);
  if (ensure) {
    const names = [];
    for (const key of ['main', 'aux', 'seasoning']) {
      for (const line of (cur[key] || [])) {
        let n = String(line).replace(/[\d./]+\s*[a-zA-Z\u4e00-\u9fff]*\s*$/, '').trim();
        n = n.replace(/[（(].*?[）)]/g, '').trim() || String(line).trim();
        if (n && names.indexOf(n) < 0) names.push(n);
      }
    }
    if (data.ings === undefined || data.ings === null) data.ings = [];
    const ings = data.ings;
    const existing = new Set();
    for (const g of ings) if (g && typeof g === 'object') existing.add(String(g.name || ''));
    let createdN = 0;
    for (const n of names) {
      if (existing.has(n) || n === '清水' || n === '水') continue;
      let unit = 'g';
      for (const line of (cur.main || []).concat(cur.aux || [], cur.seasoning || [])) {
        if (String(line).indexOf(n) === 0 || String(line).indexOf(n) >= 0) {
          const m = String(line).match(/(\d+(?:\.\d+)?)(g|kg|斤|ml|L|个|只|把|袋)$/);
          if (m) unit = m[2];
          break;
        }
      }
      applyIngUpsert(data, {
        name: n,
        unit: unit,
        cat: '菜谱挂钩',
        qty: 0,
        safe: 0,
        on: true
      });
      existing.add(n);
      createdN += 1;
    }
    if (createdN) parts.push('建原料' + createdN);
  }

  // 同步堂食菜品壳（可卖）
  let syncDish = payload.sync_dish;
  if (syncDish === undefined || syncDish === null) syncDish = true;
  if (truthyOn(syncDish, ['yes'])) {
    const dishPayload = {
      id: payload.dish_id || cur.sku_id,
      name: cur.name,
      cat: payload.dish_cat || payload.cat || cur.color || '常规',
      price: payload.price,
      cost: payload.cost,
      on: payload.on === undefined ? true : payload.on,
      sku_id: cur.sku_id,
      recipe_link: 'from_recipe'
    };
    if (dishPayload.price === undefined || dishPayload.price === null) delete dishPayload.price;
    if (dishPayload.cost === undefined || dishPayload.cost === null) delete dishPayload.cost;
    try {
      parts.push(applyDishUpsert(data, dishPayload));
    } catch (dex) {
      parts.push('dish跳过:' + dex.message);
    }
  }

  let msg = parts.join(' · ');
  if (!store) msg += '（未写库）';
  return msg;
}

/** 查询一行：store.query 返回数组/对象均可，取首个 */
function queryOne(store, table, where) {
  const q = store.query(table, where);
  let row = null;
  if (Array.isArray(q)) row = q.length ? q[0] : null;
  else if (q && Array.isArray(q.rows)) row = q.rows.length ? q.rows[0] : null;
  else if (q && typeof q === 'object') row = q;
  if (!row) return null;
  // 归一：支持 [col,...] 数组行或 {col:...} 对象行
  if (Array.isArray(row)) {
    const cols = ['sku_id', 'name', 'color', 'filling', 'face_main', 'main', 'aux',
      'seasoning', 'steps', 'params', 'blessing', 'diet_tags', 'version'];
    const o = {};
    cols.forEach((c, i) => { o[c] = row[i]; });
    return o;
  }
  return row;
}

/** 数据库行 → 配方当前态（main/aux/seasoning/steps/params/diet_tags 反序列化） */
function rowToCur(row) {
  const jload = (s, dflt) => {
    if (!s) return dflt;
    if (typeof s !== 'string') return s;
    try {
      return JSON.parse(s);
    } catch (e) {
      return dflt;
    }
  };
  return {
    sku_id: row.sku_id !== undefined ? row.sku_id : row[0],
    name: row.name !== undefined ? row.name : row[1],
    color: row.color !== undefined ? row.color : row[2],
    filling: row.filling !== undefined ? row.filling : row[3],
    face_main: row.face_main !== undefined ? row.face_main : row[4],
    main: jload(row.main, []),
    aux: jload(row.aux, []),
    seasoning: jload(row.seasoning, []),
    steps: jload(row.steps, []),
    params: jload(row.params, {}),
    blessing: row.blessing !== undefined ? row.blessing : row[10],
    diet_tags: jload(row.diet_tags, []),
    version: parseInt(row.version || 1, 10) || 1
  };
}

function blankCur(sku, name) {
  return {
    sku_id: sku,
    name: name || sku,
    color: null,
    filling: null,
    face_main: null,
    main: [],
    aux: [],
    seasoning: [],
    steps: [],
    params: {},
    blessing: null,
    diet_tags: [],
    version: 0
  };
}

/** 对齐 Python json.dumps(obj, ensure_ascii=False)：分隔符 ', ' 与 ': ' */
function pyJsonDumps(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(pyJsonDumps).join(', ') + ']';
  const keys = Object.keys(v);
  return '{' + keys.map((k) => JSON.stringify(k) + ': ' + pyJsonDumps(v[k])).join(', ') + '}';
}

/** 配方当前态 → 写库/写 ext 行（BOM 序列化为 JSON 字符串，对齐 SQLite 列） */
function serializeRecipe(cur) {
  return {
    sku_id: cur.sku_id,
    name: cur.name,
    color: cur.color,
    filling: cur.filling,
    face_main: cur.face_main,
    main: pyJsonDumps(cur.main),
    aux: pyJsonDumps(cur.aux),
    seasoning: pyJsonDumps(cur.seasoning),
    steps: pyJsonDumps(cur.steps),
    params: pyJsonDumps(cur.params || {}),
    blessing: cur.blessing,
    diet_tags: pyJsonDumps(cur.diet_tags || []),
    version: cur.version,
    updated_at: cur.updated_at
  };
}

module.exports = {
  normMenuNameDish,
  recipeCatalog,
  scoreDishRecipe,
  matchDishToRecipe,
  applyDishUpsert,
  applyDishPrice,
  applyDishSetActive,
  applyDishDelete,
  dishReferencedBySales,
  applyDishAutoLink,
  insertRecipeSubstitute,
  applyRecipeImport,
  bomLines,
  upsertRecipe,
  seqRatio,
  uidHex,
  pt
};
