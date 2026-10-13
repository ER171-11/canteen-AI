/*
 * 列表页「筛选下拉」的「全部」项（供应商 / 分类 / 板块 / 状态 / 原料 / 类型…）。
 *
 * 问题现象：这些下拉此前只有具体取值 + allowClear 的悬浮 ✕。「不筛选」这个状态既没有名字、
 *   也不好点——一旦选过某个值，页面上就找不到回到「全部」的入口，看着像「列表少了几条」
 *   （如入库单页选了「未指定供应商」后，其它供应商的单据就不见了）。
 *
 * 统一约定：下拉首项固定为「全部」（与既有 `{ value: 'all', label: '全部' }` 口径一致），
 *   空值在框里也显示为「全部」，当前筛选态一眼可见、一键可退：
 *
 *   <Select
 *     allowClear
 *     options={withAll(suppliers.map((s) => ({ value: s, label: s })), '全部供应商')}
 *     value={allValueOf(supplier)}
 *     onChange={(v) => setSupplier(fromAll<string>(v))}
 *   />
 *
 * 红线：纯前端展示层，不改变筛选口径——undefined = 不筛选（显示全部），与筛选前完全一致。
 */
import type { ReactNode } from 'react'

/** 「全部」项的哨兵值：不会与业务取值（供应商名/分类名/状态码）冲突 */
export const ALL_VALUE = '__all__'

export interface FilterOption<T> {
  value: T
  label: ReactNode
}

/** 在选项前插入「全部」项 */
export function withAll<T extends string | number>(
  options: FilterOption<T>[],
  label: ReactNode = '全部',
): FilterOption<T | string>[] {
  return [{ value: ALL_VALUE, label }, ...options]
}

/** 把下拉回传值还原成筛选值：「全部」/清空/空串 → undefined（= 不筛选，显示全部） */
export function fromAll<T extends string | number>(v: unknown): T | undefined {
  return v === ALL_VALUE || v === undefined || v === null || v === '' ? undefined : (v as T)
}

/** 下拉当前值：空值（undefined / null / ''）显示为「全部」，避免空框看不出当前筛选态 */
export function allValueOf<T extends string | number>(v: T | null | undefined): T | string {
  return v === undefined || v === null || v === '' ? ALL_VALUE : v
}
