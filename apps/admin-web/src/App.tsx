import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { useAuthStore } from './store/auth'
import { firstAccessiblePath } from './rbac/roles'
import MainLayout from './layouts/MainLayout'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import ActionsPage from './pages/ActionsPage'
import PlaceholderPage from './pages/PlaceholderPage'

/** 路由守卫：未登录跳 /login */
function RequireAuth({ children }: { children: JSX.Element }) {
  const token = useAuthStore((s) => s.token)
  if (!token) return <Navigate to="/login" replace />
  return children
}

/** 登录后首页：跳到当前角色可见的第一个菜单 */
function HomeRedirect() {
  const role = useAuthStore((s) => s.role)
  return <Navigate to={firstAccessiblePath(role)} replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <MainLayout />
            </RequireAuth>
          }
        >
          <Route index element={<HomeRedirect />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="platform/actions" element={<ActionsPage />} />

          {/* 菜品厨房 */}
          <Route path="kitchen/dishes" element={<PlaceholderPage title="菜品菜单" />} />
          <Route path="kitchen/recipes" element={<PlaceholderPage title="配方BOM" />} />
          <Route path="kitchen/sop" element={<PlaceholderPage title="SOP步骤" />} />
          <Route path="kitchen/workorders" element={<PlaceholderPage title="工单排产" />} />
          <Route path="kitchen/qc" element={<PlaceholderPage title="品控记录" />} />

          {/* 进销存 */}
          <Route path="inventory/stock" element={<PlaceholderPage title="原料库存" />} />
          <Route path="inventory/purchase" element={<PlaceholderPage title="采购单" />} />
          <Route path="inventory/inbound" element={<PlaceholderPage title="入库单" />} />
          <Route path="inventory/vendors" element={<PlaceholderPage title="供应商比价" />} />

          {/* 堂食外卖 */}
          <Route path="dinein/tables" element={<PlaceholderPage title="桌台管理" />} />
          <Route path="dinein/orders" element={<PlaceholderPage title="订单查询" />} />
          <Route path="dinein/delivery" element={<PlaceholderPage title="外卖对账" />} />
          <Route path="dinein/reviews" element={<PlaceholderPage title="差评管理" />} />

          {/* 会员营销 */}
          <Route path="member/list" element={<PlaceholderPage title="会员列表" />} />
          <Route path="member/stored" element={<PlaceholderPage title="储值" />} />
          <Route path="member/coupons" element={<PlaceholderPage title="优惠券" />} />
          <Route path="member/birthday" element={<PlaceholderPage title="生日营销" />} />

          {/* 人员 */}
          <Route path="hr/staff" element={<PlaceholderPage title="员工档案" />} />
          <Route path="hr/schedule" element={<PlaceholderPage title="排班" />} />
          <Route path="hr/attendance" element={<PlaceholderPage title="打卡" />} />
          <Route path="hr/performance" element={<PlaceholderPage title="绩效" />} />
          <Route path="hr/health-cert" element={<PlaceholderPage title="健康证" />} />

          {/* 食安设备 */}
          <Route path="safety/licenses" element={<PlaceholderPage title="证照" />} />
          <Route path="safety/trace" element={<PlaceholderPage title="溯源批次" />} />
          <Route path="safety/sample" element={<PlaceholderPage title="留样消毒" />} />
          <Route path="safety/devices" element={<PlaceholderPage title="设备温度能耗" />} />

          {/* 财务 */}
          <Route path="finance/invoice" element={<PlaceholderPage title="发票" />} />
          <Route path="finance/tax" element={<PlaceholderPage title="税务" />} />
          <Route path="finance/cashflow" element={<PlaceholderPage title="现金流" />} />
          <Route path="finance/split" element={<PlaceholderPage title="分账审批" />} />

          {/* 平台 */}
          <Route path="platform/ai-audit" element={<PlaceholderPage title="AI审计" />} />
          <Route path="platform/system" element={<PlaceholderPage title="系统管理" />} />
          <Route path="platform/audit-log" element={<PlaceholderPage title="审计日志" />} />

          {/* 兜底：不留 404 空白 */}
          <Route path="*" element={<PlaceholderPage title="页面建设中" />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
