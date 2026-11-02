import { useEffect, useState } from 'react'

/** 手机断点：< 768px 视为手机（与 antd Grid 的 md 断点一致） */
export const MOBILE_MAX_WIDTH = 768

/**
 * 是否手机视口。用 matchMedia 而不是 resize 监听，避免高频重渲染；
 * 只能在浏览器环境使用（SSR 时首帧返回 false）。
 */
export function useIsMobile(maxWidth: number = MOBILE_MAX_WIDTH): boolean {
  const query = `(max-width: ${maxWidth}px)`
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    setIsMobile(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return isMobile
}

export default useIsMobile
