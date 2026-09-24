import type { Role } from '../api/types'
import { MENU } from '../config/menu'

/*
 * RBAC：角色 → 菜单/路由可见性。
 *   老板：全部
 *   店长：除「财务-分账审批」「平台-系统管理」
 *   财务：仅「财务」+「审批中心」
 *   厨房：仅「菜品厨房」+「食安设备」
 *   只读：全部（写入口由页面层统一置灰）
 */
const RULES: Record<Role, (path: string) => boolean> = {
  老板: () => true,
  店长: (path) => path !== '/finance/split' && path !== '/platform/system',
  财务: (path) => path.startsWith('/finance') || path === '/platform/actions',
  厨房: (path) => path.startsWith('/kitchen') || path.startsWith('/safety'),
  只读: () => true,
}

export function canAccess(role: Role | null, path: string): boolean {
  if (!role) return false
  const rule = RULES[role]
  return rule ? rule(path) : false
}

/** 登录后默认落地页：当前角色可见的第一个菜单项 */
export function firstAccessiblePath(role: Role | null): string {
  if (!role) return '/login'
  for (const group of MENU) {
    for (const leaf of group.children) {
      if (canAccess(role, leaf.path)) return leaf.path
    }
  }
  return '/login'
}
