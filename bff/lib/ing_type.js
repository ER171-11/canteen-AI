'use strict';
/*
 * lib/ing_type.js — 原料类型语义分层（W4 耗材治理）
 *
 * 唯一口径源：`ings[].type = 'food' | 'consumable'`。
 * 判定标准 = 「不进菜品成分 + 一次性使用」，见
 *   docs/待治理-原料主数据与低值易耗品同库问题.md 决策 #1；
 *   docs/发版计划-下一版本_2026-10-19.md W4 决策纪要。
 *
 * 约定：
 *   - 存量数据默认 `food`（决策 #7，加 type 不阻塞建料/导入）；
 *   - `resolveIngType(name)` 按名称关键词自动识别耗材（决策 #6「导入自动识别 + 人工确认」）；
 *   - `isFood(ing)` / `isConsumable(ing)` 供成本/损耗/比价/补货/经营分析五处口径过滤复用，
 *     缺失 type 的历史行一律按食材处理（向后兼容，宁可漏标不可误伤食材口径）。
 *
 * 零第三方依赖；纯函数；不写库。
 */

const CONSUMABLE_KEYWORDS = [
  // 决策纪要里点名的 5 项真实配送单耗材
  '一次性手套', '手套', '口罩', '保鲜袋', '硅胶布', '蒸冠', '蒸笼布',
  // 决策 #1 边界：清洁用品 / 包材 / 餐具损耗 / 劳保
  '洗洁精', '消毒液', '消毒水', '清洁剂', '去污', '抹布', '百洁布',
  '打包盒', '打包袋', '打包膜', '塑料袋', '垃圾袋', '保鲜膜',
  '牙签', '吸管', '餐巾纸', '纸巾', '一次性餐盒', '劳保用品', '劳保',
];

/** 按名称判定原料类型：命中耗材关键词 → 'consumable'，否则 'food'。 */
function resolveIngType(name) {
  const s = String(name == null ? '' : name);
  for (const kw of CONSUMABLE_KEYWORDS) {
    if (s.indexOf(kw) >= 0) return 'consumable';
  }
  return 'food';
}

/** 归一外部传入的 type 值：仅认 'consumable'，其余（含中文『耗材』别名）一律回落到 'food'。 */
function normalizeType(v) {
  return v === 'consumable' || v === '耗材' ? 'consumable' : 'food';
}

/** 是否食材：type 缺失（历史行）按食材处理。 */
function isFood(ing) {
  return !ing || ing.type !== 'consumable';
}

/** 是否耗材：显式 type === 'consumable'。 */
function isConsumable(ing) {
  return !!ing && ing.type === 'consumable';
}

module.exports = { CONSUMABLE_KEYWORDS, resolveIngType, normalizeType, isFood, isConsumable };
