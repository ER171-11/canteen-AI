import { fetchSettleTemplate, saveSettleTemplate } from '../../../api'
import type { SettleTemplate } from '../../../api/types'

/**
 * 结算单模板（只读输出层的配置）。
 * 字段与旧版 DEF_SETTLE_TPL（旧 HTML:2088-2095）逐一对齐，不得增删语义。
 *
 * 存储位置变更记录：
 *   旧版存独立 localStorage key（ADR 见 store-inventory/docs/modules/结算单.md §4）；
 *   新版改存 BFF 独立文件 bff/data/settle_template.json（ADR-003），
 *   理由是多端共享 + 换机器不丢。**不进业务库、不走审批队列。**
 */

export const DEFAULT_SETTLE_TPL: SettleTemplate = {
  title: '进货付款审批单',
  restName: '',
  addr: '',
  tel: '',
  taxNo: '',
  usePurpose: '采购货款',
  payeeName: '',
  payeeBank: '',
  payeeAccount: '',
  subjects: ['经办人', '审核人', '审批人'],
  footer: '本单一式两联：一联财务留存，一联随付款凭证归档。',
}

/** 抬头单位名留空时的回落值（旧版 DB.rest 默认值） */
export const DEFAULT_REST_NAME = '熊猫五福餐厅'

/** 补默认值 + 清洗 subjects（允许 '经办人/审核人/审批人' 这类字符串传入） */
export function normalizeSettleTpl(t?: Partial<SettleTemplate> | null): SettleTemplate {
  const out: SettleTemplate = { ...DEFAULT_SETTLE_TPL, ...(t || {}) }
  const keys = Object.keys(DEFAULT_SETTLE_TPL) as Array<keyof SettleTemplate>
  for (const k of keys) {
    if (k === 'subjects') continue
    const v = out[k] as unknown
    ;(out as unknown as Record<string, unknown>)[k] =
      typeof v === 'string' ? v : String(v == null ? '' : v)
  }
  const raw = Array.isArray(out.subjects) ? out.subjects : []
  const clean = raw.map((s) => String(s ?? '').trim()).filter(Boolean)
  out.subjects = clean.length ? clean : [...DEFAULT_SETTLE_TPL.subjects]
  return out
}

/** 读取模板；后端不可达时回落默认值（结算单是只读输出层，不该因模板取不到而打不开） */
export async function loadSettleTpl(): Promise<SettleTemplate> {
  try {
    const r = await fetchSettleTemplate()
    return normalizeSettleTpl(r.template)
  } catch {
    return normalizeSettleTpl(null)
  }
}

export async function persistSettleTpl(t: SettleTemplate): Promise<SettleTemplate> {
  const r = await saveSettleTemplate(normalizeSettleTpl(t))
  return normalizeSettleTpl(r.template)
}
