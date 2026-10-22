/** BOM 行解析结果（与后端 buildCostCard 的 bom_lines 行口径一致） */
export interface BomLineEntry {
  name: string
  qty_g: number
  raw: string
}

/** 原料（只用 name/unit/avg/yld 四个字段，其余可缺省） */
export interface IngLike {
  name?: string
  unit?: string
  avg?: number
  yld?: number
}

export const PORTION_PIECES: number

export const UNIT_TO_G: Record<string, number>

export const ASSUMED_SPEC_G: Record<string, number>

export const SKIP_NAMES: Record<string, number>

export const ING_ALIAS_FALLBACK: Record<string, string>

export function parseBomLine(line: unknown): BomLineEntry[]

export function gramsPerUnit(ing: IngLike | null | undefined): number | null

export function stripSpec(name: unknown): string

export function resolveIngName<T = unknown>(
  name: unknown,
  aliasMap: Record<string, string> | null | undefined,
  byName: Record<string, T> | null | undefined,
): T | null

export function calcLineCost(
  qty: unknown,
  ing: IngLike | null | undefined,
): { gross: number; lineCost: number | null } | null
