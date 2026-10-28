/*
 * 清理模式（测试期隐藏维护工具）
 *
 * 用途：测试阶段人工删除混入的假数据（如演示留样）。开启后受影响页面的行内
 *       出现「删」按钮，删除动作走审批队列（maint.row_delete），审批中心可见、可驳回。
 *
 * 激活方式（非常规手段，无任何菜单入口）：
 *   - 开启：地址栏访问 ?maint=1（写入 localStorage 后即持久生效）
 *   - 关闭：?maint=0，或页面左下角「退出清理模式」按钮
 *
 * 多 tab 共用：状态存 localStorage，同源所有标签页共享；已打开的旧 tab 刷新一次即生效。
 * 正式版用户不知晓激活口令即等于功能不存在；后端另有表白名单兜底。
 */

const LS_KEY = 'canteenai.maint'

/** URL 是否携带 maint 参数；有则返回其布尔值 */
function readUrlFlag(): boolean | null {
  try {
    const raw = new URLSearchParams(window.location.search).get('maint')
    if (raw == null) return null
    return !/^(0|off|false|no)$/i.test(raw.trim())
  } catch {
    return null
  }
}

let cached: boolean | null = null

/** 清理模式是否开启；模块级缓存，切换后经 reload 生效 */
export function maintEnabled(): boolean {
  if (cached === null) {
    const url = readUrlFlag()
    if (url !== null) {
      try {
        window.localStorage.setItem(LS_KEY, url ? '1' : '0')
      } catch {
        /* 隐私模式等场景忽略 */
      }
      cached = url
    } else {
      try {
        cached = window.localStorage.getItem(LS_KEY) === '1'
      } catch {
        cached = false
      }
    }
  }
  return cached
}

/** 退出清理模式并刷新 */
export function exitMaint(): void {
  try {
    window.localStorage.removeItem(LS_KEY)
  } catch {
    /* 忽略 */
  }
  window.location.reload()
}
