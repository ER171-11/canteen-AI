import type { BaobenDishRow, CalcQMode, CalcSimRowOverride } from '../../api/types'

/**
 * 结构测算「模拟态」共享契约（供 `WeeklyReportPage` 编排、`CalcDishTable` 渲染共用）。
 *
 * 独立成文件的两个原因：
 * 1) 行覆盖键 / 口径枚举 / 控制句柄都被两个页面同时使用，放组件文件会触发
 *    `react-refresh/only-export-components`（组件文件只许导出组件）；
 * 2) 「模拟态」的口径标识（`basis`）必须只有一个定义处，避免两处漂移。
 */

/** 基准行集标识：`shop_dishes` = 本店在售菜品（旧版 `calcModel()` 的 `SD` 口径，见 ADR-007） */
export const SIM_BASIS = 'shop_dishes'

/** 模拟态徽标文案（页面、图表卡、逐菜表三处统一引用，避免各写一份） */
export const SIM_BASIS_LABEL = '模拟态 · 本店在售菜品口径'

/** 行覆盖键：优先菜品 id（后端按菜名优先、id 次之匹配，见 `applyRowOverrides`） */
export const rowOvKey = (r: BaobenDishRow) => String(r.id ?? r.name ?? '')

/** 批量动作，逐字照抄旧版 `data-bulk`（HTML:401-409） */
export type BulkAction = 'p-10' | 'p-5' | 'p5' | 'p10' | 'q-20' | 'q20' | 'on' | 'reset'

/** 旧版 `SC_QMODES`（HTML:3852），顺序与文案逐字一致 */
export const QMODE_OPTIONS: Array<{ value: CalcQMode; label: string }> = [
  { value: 'est', label: '估算 q（菜品主数据）' },
  { value: 'real30', label: '近30天真实（日均）' },
  { value: 'real7', label: '近7天真实（日均）' },
]

/** 模拟态控制句柄（由页面持有状态，逐菜表只上抛动作） */
export interface CalcSimCtl {
  /** 是否已进入模拟态（未进入时行内控件禁用） */
  active: boolean
  /** 当前行覆盖：`{ 菜品id|菜名: {c?,p?,q?,on?} }` */
  overrides: Record<string, CalcSimRowOverride>
  qmode: CalcQMode
  qfallback: boolean
  /** 后端回传口径标签（缺失时用本地表兜底） */
  qmodeLabel?: string
  qdays?: number
  /** 口径计数：总行/在售/取真实销量/无销量回落（旧版 `calcStatText` HTML:3879） */
  qstat?: { n_total?: number; n_active?: number; n_real?: number; n_fallback?: number } | null
  /** 推演请求在途（禁用控件避免连点） */
  busy?: boolean
  /** 进入模拟态（后端推演一次，行集切到本店在售菜品口径） */
  onStart: () => void
  /** 退出模拟态（丢弃覆盖，回到基线保本价盘口径） */
  onStop: () => void
  /** 行覆盖：patch 为 null 表示该行恢复默认 */
  onOverride: (key: string, patch: CalcSimRowOverride | null) => void
  /** 批量调价/调量/上架/恢复默认，scope='__all' 或类型名（旧版 `#bulkScope` HTML:396-399） */
  onBulk: (scope: string, action: BulkAction) => void
  onQmode: (m: CalcQMode) => void
  onQfallback: (v: boolean) => void
}
