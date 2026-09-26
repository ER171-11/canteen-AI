import type { Role } from '../api/types'
import { MENU } from '../config/menu'

/*
 * RBAC：角色 → 菜单/路由可见性（与 BFF 岗位名对齐）。
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
    path === '/ops/analysis',
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
