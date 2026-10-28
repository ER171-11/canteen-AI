/*
 * lib/recipeCostCore.ts — 前端配方成本薄壳：统一从共享核心 re-export，无本地逻辑。
 * 保证前端「编辑弹窗实时成本」与后端 buildCostCard 同源同口径。
 */
import * as core from '../../../../shared/recipe-cost/index.mjs'

export const {
  parseBomLine,
  gramsPerUnit,
  stripSpec,
  resolveIngName,
  calcLineCost,
  ingBaseInfo,
  packInBase,
  ingDim,
  inferBaseUnit,
  unitToBase,
  DIM_OF_UNIT,
  ING_ALIAS_FALLBACK,
  ASSUMED_SPEC_G,
  UNIT_TO_G,
  PORTION_PIECES,
  SKIP_NAMES,
} = core
