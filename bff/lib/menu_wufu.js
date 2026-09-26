'use strict';
/*
 * 金丰御字牌五福饺子菜单真源（与 boss-app/public/menu-wufu.json 同源）
 * 供厨房菜谱列表合并：补全白饺/煎饺/蒸饺 + face_detail 面主料文案
 */
const fs = require('fs');
const path = require('path');

const MENU_PATHS = [
  path.join(__dirname, '../data/menu-wufu.json'),
  path.join(__dirname, '../../apps/boss-app/public/menu-wufu.json')
];

let _cache = null;
let _mtime = 0;

function loadMenuWufu() {
  for (const p of MENU_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const st = fs.statSync(p);
      if (_cache && st.mtimeMs === _mtime && _cache.__path === p) return _cache;
      const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
      _cache = doc;
      _cache.__path = p;
      _mtime = st.mtimeMs;
      return _cache;
    } catch (e) {
      /* try next */
    }
  }
  return null;
}

/** 快照 sku → 菜单 id 对齐 */
const SKU_TO_MENU = {
  'SKU-WF-HONG': 'WF-01',
  'SKU-WF-HUANG': 'WF-02',
  'SKU-WF-HEI': 'WF-03',
  'SKU-WF-LV': 'WF-04',
  'SKU-WF-ZI': 'WF-05',
  'SKU-WF-BAI-SUANCAI': 'WF-06',
  'SKU-WF-BAI-NIUROU': 'WF-07',
  'SKU-WF-BAI-XIHULU': 'WF-08',
  'SKU-WF-BAI-SHANYAO': 'WF-09'
};

const MENU_TO_SKU = Object.fromEntries(Object.entries(SKU_TO_MENU).map(([k, v]) => [v, k]));

function menuById(menu) {
  const m = {};
  for (const it of (menu && menu.items) || []) {
    if (it && it.id) m[it.id] = it;
  }
  return m;
}

function faceLines(faceDetail) {
  if (!faceDetail) return [];
  return String(faceDetail)
    .split(/[、,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 合并 ext.recipes + menu-wufu：
 * - 已有配方：补 menu_cat / subtitle / face_detail / blessing / params.面主料
 * - 菜单有、配方无：合成轻量配方（可算料面主料，馅待补）
 */
function mergeRecipesWithMenu(recipes) {
  const menu = loadMenuWufu();
  if (!menu || !Array.isArray(menu.items) || !menu.items.length) {
    let items = Array.isArray(recipes) ? recipes.slice() : [];
    let baobenMeta = null;
    try {
      const { absorbBaoben } = require('./menu_baoben');
      const abs = absorbBaoben(items);
      items = abs.items;
      baobenMeta = abs.baoben;
    } catch (e) { /* optional */ }
    return {
      items,
      menu: null,
      baoben: baobenMeta,
      source: baobenMeta ? 'snapshot+baoben' : 'snapshot'
    };
  }
  const byMenu = menuById(menu);
  const usedMenu = new Set();
  const out = [];

  for (const r of recipes || []) {
    if (!r) continue;
    const mid = SKU_TO_MENU[String(r.sku_id)] || null;
    const mi = mid ? byMenu[mid] : null;
    if (mi) usedMenu.add(mi.id);
    const faceDetail = (mi && mi.face_detail) || null;
    const lines = faceLines(faceDetail);
    const params = Object.assign({}, (r.params && typeof r.params === 'object') ? r.params : {});
    if (lines.length && !params['面主料']) params['面主料'] = lines;
    if (mi && mi.face && !params['色源']) params['色源'] = mi.face;
    if (faceDetail) params['起草基准'] = params['起草基准'] || '面粉500g=1倍标准量（menu-wufu）';
    out.push(Object.assign({}, r, {
      name: r.name || (mi && mi.name) || r.sku_id,
      color: r.color || (mi && mi.color) || null,
      filling: r.filling || (mi && mi.filling) || null,
      face_main: r.face_main || (mi && mi.face) || null,
      blessing: r.blessing || (mi && mi.blessing) || null,
      diet_tags: (Array.isArray(r.diet_tags) && r.diet_tags.length)
        ? r.diet_tags
        : ((mi && mi.tags) || []),
      menu_cat: (mi && mi.cat) || guessMenuCat(r),
      menu_id: (mi && mi.id) || null,
      subtitle: (mi && mi.subtitle) || null,
      face_detail: faceDetail,
      brief: (mi && mi.brief) || null,
      params,
      source: mi ? 'snapshot+menu' : 'snapshot'
    }));
  }

  for (const mi of menu.items) {
    if (!mi || usedMenu.has(mi.id)) continue;
    const sku = MENU_TO_SKU[mi.id] || ('MENU-' + mi.id);
    const lines = faceLines(mi.face_detail);
    out.push({
      sku_id: sku,
      name: mi.name,
      color: mi.color || null,
      filling: mi.filling || null,
      face_main: mi.face || null,
      main: [],
      aux: [],
      seasoning: [],
      steps: [],
      params: {
        面主料: lines,
        色源: mi.face || '',
        起草基准: '面粉500g=1倍标准量（menu-wufu）',
        标准: '金丰菜单'
      },
      blessing: mi.blessing || null,
      diet_tags: mi.tags || [],
      menu_cat: mi.cat || 'jiao_white',
      menu_id: mi.id,
      subtitle: mi.subtitle || null,
      face_detail: mi.face_detail || null,
      brief: mi.brief || null,
      version: 'menu-wufu',
      source: 'menu'
    });
  }

  // 并入保本测算：成本/售价/毛利 + 全菜单品项
  let baobenMeta = null;
  try {
    const { absorbBaoben } = require('./menu_baoben');
    const abs = absorbBaoben(out);
    out.length = 0;
    for (const it of abs.items) out.push(it);
    baobenMeta = abs.baoben;
  } catch (e) { /* optional */ }

  return {
    items: out,
    menu: { brand: menu.brand, chef: menu.chef, count: menu.items.length, five_blessings: menu.five_blessings },
    baoben: baobenMeta,
    source: baobenMeta ? 'snapshot+menu-wufu+baoben' : 'snapshot+menu-wufu'
  };
}

function guessMenuCat(r) {
  const c = String((r && r.color) || '');
  if (['红', '黄', '绿', '紫', '黑'].indexOf(c) >= 0) return 'jiao5';
  if (c === '白') return 'jiao_white';
  if (c === '煎') return 'jian';
  if (c === '蒸') return 'zheng';
  return 'other';
}

function findMergedRecipe(recipes, skuId) {
  const merged = mergeRecipesWithMenu(recipes);
  const id = String(skuId);
  const hit = merged.items.find((r) => String(r.sku_id) === id || String(r.menu_id) === id);
  return { item: hit || null, meta: merged };
}

module.exports = {
  loadMenuWufu,
  mergeRecipesWithMenu,
  findMergedRecipe,
  SKU_TO_MENU,
  MENU_TO_SKU
};
