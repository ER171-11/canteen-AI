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
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
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
    }),
    { name: 'panda_admin_auth' },
  ),
)
