import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Role } from '../api/types'

interface AuthState {
  token: string | null
  role: Role | null
  account: string | null
  expiresAt: string | null
  login: (p: { token: string; role: Role; account: string; expiresAt: string }) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      role: null,
      account: null,
      expiresAt: null,
      login: ({ token, role, account, expiresAt }) =>
        set({ token, role, account, expiresAt }),
      logout: () =>
        set({ token: null, role: null, account: null, expiresAt: null }),
    }),
    { name: 'panda_admin_auth' },
  ),
)
