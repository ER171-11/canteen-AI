import type { Role } from '../api/types'
import { MENU } from '../config/menu'

/*
 * RBAC：角色 → 菜单/路由可见性（与 BFF 岗位名对齐）。
 *
 * 双轨提醒（见 docs/分端机制与开发接入指南.md §6.E）：Android 读 token 的 permissions，
 * admin-web 读本文件；改权限必须双写。新增食安页面时务必确认非老板角色的谓词覆盖：
 *   /safety/progress（拍照核验）由 老板/店长/只读 的通用规则 + 厨房 的 `/safety` 前缀规则覆盖，
 *   财务/收银不可见——漏加谓词会导致「只有老板能看」。
 */
const RULES: Record<Role, (path: string) => boolean> = {
  老板: () => true,
  店长: (path) => path !== '/finance/split' && path !== '/platform/system',
  财务: (path) =>
    path.startsWith('/finance') ||
    path === '/platform/actions' ||
    path === '/platform/org' ||
    path === '/dashboard' ||
    path === '/ops/analysis' ||
    path === '/ops/weekly' ||
    path === '/inventory/loss',
  厨房: (path) =>
    path.startsWith('/kitchen') ||
    path.startsWith('/safety') ||
    path === '/inventory/loss' ||
    path === '/dashboard',
  收银: (path) =>
    path.startsWith('/dinein') ||
    path.startsWith('/member') ||
    path === '/platform/actions' ||
    path === '/dashboard' ||
    path === '/ops/analysis' ||
    path === '/ops/weekly',
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
