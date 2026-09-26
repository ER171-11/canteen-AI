import axios from 'axios'
import { useAuthStore } from '../store/auth'

/*
 * 统一 axios 实例：baseURL=/api（vite dev proxy 转发至 127.0.0.1:8787）。
 * 请求拦截器注入 Bearer token；401 自动登出并跳登录页。
 */
export const client = axios.create({
  baseURL: '/api',
  timeout: 10000,
})

client.interceptors.request.use((config) => {
  const { token, storeId } = useAuthStore.getState()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  /* SaaS 门店上下文：业务读同源，平台侧按店过滤展示 */
  if (storeId) {
    config.headers['X-Store-Id'] = storeId
  }
  return config
})

client.interceptors.response.use(
  (resp) => resp,
  (error) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().logout()
      if (window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  },
)
