import { demoEnabled } from '../store/demo'

/*
 * 演示数据门控工具（过渡期临时工具 A 的配套）
 *
 * 1) mockOrEmpty / mockArrayOrEmpty / mockOrBlank —— 所有 mock 回退点统一入口：
 *    开关开启时返回真实 mock 值；关闭时返回「空态」，从而「关开关 = 无假数据」。
 * 2) mockHits / subscribeMockHits —— 关闭状态下仍发生回退的次数，
 *    供 DemoSwitch 展示「本页演示数据回退次数」，演示时自证无假数据。
 * 3) suppressDemoData —— 供 api/client.ts 响应拦截器使用：
 *    中和 BFF 侧带 mock:true 的合成响应，并剔除响应中 source='demo_proto' 的演示行。
 *
 * 淘汰完成后本文件应随 DemoSwitch 一并移除。
 */

/* ---------------------------------------------------------------- 回退计数 */

let hits = 0
const listeners = new Set<() => void>()

/** 本页（自上次路由切换起）演示数据回退次数 */
export function mockHits(): number {
  return hits
}

export function subscribeMockHits(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 路由切换时由 DemoSwitch 调用，重置本页计数 */
export function resetMockHits(): void {
  if (hits === 0) return
  hits = 0
  listeners.forEach((fn) => fn())
}

function noteHit(): void {
  hits += 1
  listeners.forEach((fn) => fn())
}

/* ---------------------------------------------------------------- 门控 */

/** 开启演示时返回真实 mock 值，关闭时返回空态 */
export function mockOrEmpty<T>(mock: T, empty: T): T {
  if (demoEnabled()) return mock
  noteHit()
  return empty
}

/** 数组型 mock 的便捷门控 */
export function mockArrayOrEmpty<T>(mock: T[]): T[] {
  if (demoEnabled()) return mock
  noteHit()
  return []
}

/**
 * 通用门控：开启时返回 mock 原值；关闭时返回其「骨架化空态」
 * （数组清空、数值归零、文案清空，保留 ok/mock/source 等元键）。
 * 适用于无法事先构造空态对象的复杂响应（如各页 fallback()）。
 */
export function mockOrBlank<T>(mock: T): T {
  if (demoEnabled()) return mock
  noteHit()
  return scrub(mock) as T
}

/* ---------------------------------------------------------------- 响应清洗 */

/** 骨架化时保留的元数据键（不置空，供 UI 判定空态/口径） */
const META_KEYS = new Set([
  'ok', 'mock', 'source', 'src', 'rev', 'msg', 'code', 'date', 'basis',
  'notice', 'banner', 'error', 'reason', 'kind', 'updated_at',
])

function isDemoRow(it: unknown): boolean {
  if (!it || typeof it !== 'object') return false
  const r = it as Record<string, unknown>
  const src = String(r.source ?? r.src ?? '')
  return src === 'demo_proto'
}

/** 把带 mock:true 的合成响应骨架化：数组清空、数值归零、文案清空，仅保留元标记 */
function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = META_KEYS.has(k) ? val : scrub(val)
    }
    return out
  }
  if (typeof v === 'number') return 0
  if (typeof v === 'string') return ''
  return v
}

/** 剔除数组/嵌套对象中 source='demo_proto' 的演示行，其余真实数据原样保留 */
function filterDemoRows(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((it) => !isDemoRow(it)).map(filterDemoRows)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = filterDemoRows(val)
    }
    return out
  }
  return v
}

/**
 * 关闭演示开关时对响应体做「去假数据」处理：
 * - 顶层 mock === true（BFF 明确标注的合成响应）→ 整体骨架化
 * - 其余响应 → 仅剔除 demo_proto 演示行（真实数据不受影响）
 */
export function suppressDemoData<T>(payload: T): T {
  const top = payload as unknown
  if (top && typeof top === 'object' && !Array.isArray(top) && (top as { mock?: unknown }).mock === true) {
    return scrub(top) as T
  }
  return filterDemoRows(top) as T
}
