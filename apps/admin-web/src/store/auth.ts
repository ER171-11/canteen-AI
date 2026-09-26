import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Role } from '../api/types'

interface AuthState {
  token: string | null
  role: Role | null
  account: string | null
  expiresAt: string | null
  storeId: string | null
  storeName: string | null
  permissions: string[]
  canWrite: boolean
  login: (p: {
    token: string
    role: Role
    account: string
    expiresAt: string
    storeId?: string | null
    storeName?: string | null
    permissions?: string[]
    canWrite?: boolean
  }) => void
  setStore: (p: { storeId: string; storeName: string }) => void
  logout: () => void
  /** 主动过期检查：token 已过 expiresAt 即登出并返回 true */
  checkExpired: () => boolean
}

/** expires_at 解析（ISO8601；非法值视为不过期，交由服务端 401 兜底） */
function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false
  const t = new Date(expiresAt).getTime()
  if (Number.isNaN(t)) return false
  return t <= Date.now()
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      role: null,
      account: null,
      expiresAt: null,
      storeId: null,
      storeName: null,
      permissions: [],
      canWrite: false,
      login: ({
        token,
        role,
        account,
        expiresAt,
        storeId,
        storeName,
        permissions,
        canWrite,
      }) =>
        set({
          token,
          role,
          account,
          expiresAt,
          storeId: storeId ?? null,
          storeName: storeName ?? null,
          permissions: permissions ?? [],
          canWrite: !!canWrite,
        }),
      setStore: ({ storeId, storeName }) => set({ storeId, storeName }),
      logout: () =>
        set({
          token: null,
          role: null,
          account: null,
          expiresAt: null,
          storeId: null,
          storeName: null,
          permissions: [],
          canWrite: false,
        }),
      checkExpired: () => {
        const { token, expiresAt } = get()
        if (token && isExpired(expiresAt)) {
          get().logout()
          return true
        }
        return false
      },
    }),
    { name: 'panda_admin_auth' },
  ),
)
