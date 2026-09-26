import { Navigate } from 'react-router-dom'

/** 未知路由不再展示「建设中」，回到看板 */
export default function PlaceholderPage({ title: _title }: { title: string }) {
  return <Navigate to="/dashboard" replace />
}
