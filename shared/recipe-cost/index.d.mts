/** BOM 行解析结果（与后端 buildCostCard 的 bom_lines 行口径一致） */
export interface BomLineEntry {
  name: string
  qty_g: number
  raw: string
}

/** 原料（成本折算只用 name/unit/avg/yld/base_unit/pack_in_base，其余可缺省） */
export interface IngLike {
  name?: string
  unit?: string
  avg?: number
  yld?: number
  base_unit?: 'g' | 'ml' | '个'
  pack_in_base?: number
  last?: number | null
  id?: string
}

export type Dim = 'weight' | 'volume' | 'count'

export const PORTION_PIECES: number

export const UNIT_TO_G: Record<string, number>

export const ASSUMED_SPEC_G: Record<string, number>

export const SKIP_NAMES: Record<string, number>

export const ING_ALIAS_FALLBACK: Record<string, string>

export const DIM_OF_UNIT: Record<string, Dim>

export function parseBomLine(line: unknown): BomLineEntry[]

export function gramsPerUnit(ing: IngLike | null | undefined): number | null

/** 每 1 个库存单位含多少基础单位（数值）；无则 null */
export function packInBase(ing: IngLike | null | undefined): number | null

/** 原料换算维度（weight/volume/count）；无法确定返回 null */
export function ingDim(ing: IngLike | null | undefined): Dim | null

/** 原料基础单位信息：{ dim, amount }；无法换算返回 null */
export function ingBaseInfo(ing: IngLike | null | undefined): { dim: Dim; amount: number } | null

/** 从原料名（SPEC_RE 抠 1.9L/500g）+ unit 推导结构化换算字段（旧数据兜底/一次性补全） */
export function inferBaseUnit(ing: IngLike | null | undefined): { base_unit?: 'g' | 'ml' | '个'; pack_in_base?: number }

/** 返回「1 个该单位 = 多少基础单位」系数；未知单位返回 null */
export function unitToBase(dim: Dim, unit: string): number | null

export function stripSpec(name: unknown): string

export function resolveIngName<T = unknown>(
  name: unknown,
  aliasMap: Record<string, string> | null | undefined,
  byName: Record<string, T> | null | undefined,
): T | null

/**
 * 单行成本。
 * - 不传 unit：旧行为，qty 视为已按原料基础单位（克重口径）填写。
 * - 传 unit：维度感知路径；维度不兼容或缺失换算系数时 lineCost=null 且 dimMismatch=true。
 */
export function calcLineCost(
  qty: unknown,
  ing: IngLike | null | undefined,
  unit?: string,
): { gross: number; lineCost: number | null; dimMismatch?: boolean } | null
