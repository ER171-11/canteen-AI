/*
 * antd Table 行键工具。
 * antd 5 已弃用 rowKey 回调的 index 参数（不保证稳定），这里改为按记录自身字段生成稳定 key：
 * 先尝试常见唯一字段，找不到时退回整行内容；避免使用行号。
 */
const ID_FIELDS = [
  'id',
  'key',
  'uid',
  'code',
  'no',
  'seq',
  'queue_no',
  'batch_no',
  'batch',
  'trace_id',
  'member_id',
  'sku_id',
  'workorder_id',
  'ing_name',
  'name',
  'ts',
  'date',
] as const

/** 稳定行键：对象优先取唯一字段，原始值/兜底转字符串 */
export function rk(record: unknown): string {
  if (record == null) return ''
  if (typeof record !== 'object') return String(record)
  const r = record as Record<string, unknown>
  for (const f of ID_FIELDS) {
    const v = r[f]
    if (v != null && v !== '') return String(v)
  }
  try {
    return JSON.stringify(r)
  } catch {
    return Object.values(r).map((v) => String(v)).join('|')
  }
}
