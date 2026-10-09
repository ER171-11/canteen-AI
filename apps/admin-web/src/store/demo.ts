import { create } from 'zustand'

/*
 * 演示数据运行时开关（过渡期临时工具 A）
 *
 * 背景：前端此前不存在任何演示开关，演示态完全由「请求失败/空数据 → catch 回退硬编码数组」
 *       隐式触发。本开关不改业务流，只作为「是否允许回退到内置演示数据」的全局闸门。
 *
 * 优先级：URL 参数 ?demo > localStorage > 缺省开启。
 *   - ?demo=0 / off / false / no  → 关闭
 *   - ?demo=1 / on / true / 其他  → 开启
 * 生效方式：模块顶层只求值一次，切换后由调用方 location.reload() 生效。
 *
 * 淘汰完成后本文件应随 DemoSwitch 一并移除。
 */

const LS_KEY = 'canteenai.demo'

/** URL 参数优先；无该参数返回 null */
function readUrlFlag(): boolean | null {
  try {
    const raw = new URLSearchParams(window.location.search).get('demo')
    if (raw == null) return null
    return !/^(0|off|false|no)$/i.test(raw.trim())
  } catch {
    return null
  }
}

function readStored(): boolean {
  try {
    const v = window.localStorage.getItem(LS_KEY)
    return v == null ? true : v === '1'
  } catch {
    return true
  }
}

let cached: boolean | null = null

/** 同步读取「演示数据是否开启」，缺省 true（合并前后端行为不变） */
export function demoEnabled(): boolean {
  if (cached === null) cached = readUrlFlag() ?? readStored()
  return cached
}

/** URL 是否锁定开关（此时面板只读） */
export function isDemoUrlLocked(): boolean {
  return readUrlFlag() !== null
}

interface DemoState {
  enabled: boolean
}

export const useDemoStore = create<DemoState>(() => ({ enabled: demoEnabled() }))

/** 写入开关并同步缓存/订阅者；是否刷新页面由调用方决定 */
export function setDemo(on: boolean): void {
  if (isDemoUrlLocked()) {
    cached = readUrlFlag()
    useDemoStore.setState({ enabled: cached === true })
    return
  }
  cached = on
  try {
    window.localStorage.setItem(LS_KEY, on ? '1' : '0')
  } catch {
    /* 隐私模式等场景忽略 */
  }
  useDemoStore.setState({ enabled: on })
}

/** 组件内响应式读取开关 */
export function useDemo(): { enabled: boolean; setDemo: (on: boolean) => void; urlLocked: boolean } {
  const enabled = useDemoStore((s) => s.enabled)
  return { enabled, setDemo, urlLocked: isDemoUrlLocked() }
}
