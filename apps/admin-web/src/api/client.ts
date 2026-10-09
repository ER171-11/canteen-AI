import axios from 'axios'
import { useAuthStore } from '../store/auth'
import { demoEnabled } from '../store/demo'
import { suppressDemoData } from '../utils/demoGate'

/*
 * 统一 axios 实例：baseURL=/api（vite dev proxy 转发至 127.0.0.1:8787）。
 * 请求拦截器注入 Bearer token；401 自动登出并跳登录页。
 * 演示开关关闭时，响应拦截器会中和 BFF 侧 mock:true 合成数据并剔除 demo_proto 演示行。
 */
export const client = axios.create({
  baseURL: '/api',
  timeout: 10000,
})

client.interceptors.request.use((config) => {
  const state = useAuthStore.getState()
  /* token 本地已过期：直接登出跳登录，不再发请求 */
  if (state.token && state.checkExpired()) {
    if (window.location.pathname !== '/login') {
      window.location.href = '/login'
    }
    return Promise.reject(new Error('token expired'))
  }
  const { token, storeId } = state
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
  (resp) => {
    /* 演示开关关闭：去除响应中的演示数据，使界面呈现真实空态 */
    if (!demoEnabled() && resp && resp.data !== undefined) {
      resp.data = suppressDemoData(resp.data)
    }
    return resp
  },
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
