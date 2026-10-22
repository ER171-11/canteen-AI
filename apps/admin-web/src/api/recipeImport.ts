/*
 * api/recipeImport.ts — 食谱卡批量导入（FP-DISH-16/17/18）的 BFF 契约与请求入口。
 *
 * 为什么单独成文件（而不是写进 api/index.ts）：
 *   api/index.ts 是全站共用入口，当前还挂着「现场管理 / 销售」的在途未提交改动；
 *   为按单一主题提交、不把别人的改动混进本阶段，本阶段接口与类型放这里。
 */
import { client } from './client'

/** 预览里的一行配方明细（净料用量，按每批/每份口径，由导入文件决定） */
export interface RecipeImportLine {
  /** 原料档案 id（预览阶段已匹配）；未匹配行为空串，导入时由执行器自动建档 */
  ingId: string
  name: string
  qty: number
  unit: string
  cat?: string
  /** true = 原料档案里没有，导入时自动建档（旧版 createIngFromImport 语义） */
  isNew?: boolean
}

/** 预览里的一道菜（同一菜名多行已归并） */
export interface RecipeImportGroup {
  dish: string
  cat: string
  /** 菜品档案 id；未匹配为空串 */
  dishId: string
  skuId: string
  /** true = 菜品档案里没有，导入时自动建档（类型默认「常规」） */
  isNewDish: boolean
  /** 该菜已有配方行数（取 ext.recipes；0 表示未配置） */
  existing: number
  lines: RecipeImportLine[]
}

/** 本批将自动建档的新原料 */
export interface RecipeImportNewIng {
  name: string
  unit: string
  cat: string
}

/** 手动指定列：把「菜品名称/原料名称/净料用量…」直接对到具体列 */
export interface RecipeImportOverride {
  /** 表头所在行（0 基） */
  rowIndex: number
  /** 字段 → 列号（0 基） */
  map: Record<string, number>
}

/** 预览面板所需的原始网格（前 25 行 × 前 30 列），供「手动指定列」 */
export interface RecipeImportHead {
  format: string
  sheet: string
  sheetCount: number
  rows: string[][]
  headerRowIndex: number
  colMap: Record<string, number> | null
  /** 字段 → 中文列名 */
  labels: Record<string, string>
  /** 字段顺序 */
  fields: string[]
  /** 字段 → 支持的列名别名 */
  aliases: Record<string, string[]>
}

/**
 * POST /api/kitchen/recipes/import/preview 的**成功**响应。
 * 失败时 BFF 返回 4xx + {ok:false,error,head?}，调用方从 error.response.data 取文案与 head 展示。
 */
export interface RecipeImportPreview {
  ok: true
  format: string
  sheet?: string
  sheetCount?: number
  /** 原料名为空 / 净料用量非数字或 ≤0 被剔除的行数 */
  bad: number
  /** 缺菜品名（且无法向下补齐）被跳过的行数 */
  skipped: number
  /** 本批将**自动建档**的原料名 */
  unmatched: string[]
  newIngs?: RecipeImportNewIng[]
  /** 本批将**自动建档**的菜品名（类型默认「常规」） */
  newDishes: string[]
  groups: RecipeImportGroup[]
  single: boolean
  totalLines: number
  head: RecipeImportHead
}

/**
 * 食谱卡批量导入**预览**（只读）。
 *
 * 红线：本端点在 BFF 侧不写文件、不改快照、不入队；真正的写要等用户点「确认导入」后
 * 由页面投**一个** `recipe.import` 动作走 /api/actions（批内原子）。
 * 传 override 即为「手动指定列」重解析（同一文件、同一端点，服务端无状态）。
 */
export async function previewRecipeImport(body: {
  fileName: string
  contentBase64: string
  override?: RecipeImportOverride
}): Promise<RecipeImportPreview> {
  const { data } = await client.post<RecipeImportPreview>('/kitchen/recipes/import/preview', body)
  return data
}
