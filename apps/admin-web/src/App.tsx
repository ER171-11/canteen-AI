import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { useAuthStore } from './store/auth'
import { firstAccessiblePath } from './rbac/roles'
import DemoSwitch from './components/DemoSwitch'
import MainLayout from './layouts/MainLayout'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import ActionsPage from './pages/ActionsPage'
import OrgPage from './pages/OrgPage'
import ModuleBrowsePage from './pages/ModuleBrowsePage'
import WeeklyReportPage from './pages/ops/WeeklyReportPage'
import AnalysisTrendPage from './pages/ops/AnalysisTrendPage'
import AnalysisHeatPage from './pages/ops/AnalysisHeatPage'
import AnalysisMatrixPage from './pages/ops/AnalysisMatrixPage'
import AnalysisEffPage from './pages/ops/AnalysisEffPage'
import ReservedModulePage from './pages/ops/ReservedModulePage'
import PlaceholderPage from './pages/PlaceholderPage'
import SystemConfigPage from './pages/SystemConfigPage'
import AppReleasePage from './pages/AppReleasePage'
import DishesPage from './pages/kitchen/DishesPage'
import RecipesPage from './pages/kitchen/RecipesPage'
import SopPage from './pages/kitchen/SopPage'
import WorkorderPage from './pages/kitchen/WorkorderPage'
import QcPage from './pages/kitchen/QcPage'
import StockPage from './pages/inventory/StockPage'
import PurchasePage from './pages/inventory/PurchasePage'
import InboundPage from './pages/inventory/InboundPage'
import VendorsPage from './pages/inventory/VendorsPage'
import LossPage from './pages/inventory/LossPage'
import LedgerPage from './pages/inventory/LedgerPage'
import RestockPage from './pages/inventory/RestockPage'
import TablesPage from './pages/dinein/TablesPage'
import SalesPage from './pages/dinein/SalesPage'
import BookingPage from './pages/dinein/BookingPage'
import SchedulePage from './pages/hr/SchedulePage'
import AttendancePage from './pages/hr/AttendancePage'
import PerformancePage from './pages/hr/PerformancePage'
import TrainPage from './pages/hr/TrainPage'
import LicensesPage from './pages/safety/LicensesPage'
import TracePage from './pages/safety/TracePage'
import SamplePage from './pages/safety/SamplePage'
import SafetyPointsPage from './pages/safety/SafetyPointsPage'
import SafetyProgressPage from './pages/safety/SafetyProgressPage'
import DeviceEnergyPage from './pages/safety/DeviceEnergyPage'
import FinancePage from './pages/finance/FinancePage'

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
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
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
          <Route path="ops/analysis" element={<ModuleBrowsePage routeKey="ops/analysis" />} />
          <Route path="ops/weekly" element={<WeeklyReportPage />} />
          <Route path="ops/an-trend" element={<AnalysisTrendPage />} />
          <Route path="ops/an-heat" element={<AnalysisHeatPage />} />
          <Route path="ops/an-mx" element={<AnalysisMatrixPage />} />
          <Route path="ops/an-eff" element={<AnalysisEffPage />} />
          <Route path="ops/reserved" element={<ReservedModulePage />} />
          <Route path="platform/actions" element={<ActionsPage />} />
          <Route path="platform/org" element={<OrgPage />} />
          <Route path="platform/system" element={<SystemConfigPage />} />
          <Route path="platform/app-release" element={<AppReleasePage />} />

          {/* 菜品厨房 */}
          <Route path="kitchen/dishes" element={<DishesPage />} />
          <Route path="kitchen/recipes" element={<RecipesPage />} />
          <Route path="kitchen/sop" element={<SopPage />} />
          <Route path="kitchen/workorders" element={<WorkorderPage />} />
          <Route path="kitchen/qc" element={<QcPage />} />

          {/* 进销存 */}
          <Route path="inventory/stock" element={<StockPage />} />
          <Route path="inventory/purchase" element={<PurchasePage />} />
          <Route path="inventory/inbound" element={<InboundPage />} />
          <Route path="inventory/ledger" element={<LedgerPage />} />
          <Route path="inventory/restock" element={<RestockPage />} />
          <Route path="inventory/vendors" element={<VendorsPage />} />
          <Route path="inventory/loss" element={<LossPage />} />

          {/* 堂食外卖 */}
          <Route path="dinein/sales" element={<SalesPage />} />
          <Route path="dinein/tables" element={<TablesPage />} />
          <Route path="dinein/booking" element={<BookingPage />} />
          <Route path="dinein/orders" element={<ModuleBrowsePage routeKey="dinein/orders" />} />
          <Route path="dinein/delivery" element={<ModuleBrowsePage routeKey="dinein/delivery" />} />
          <Route path="dinein/reviews" element={<ModuleBrowsePage routeKey="dinein/reviews" />} />

          {/* 会员营销 */}
          <Route path="member/list" element={<ModuleBrowsePage routeKey="member/list" />} />
          <Route path="member/stored" element={<ModuleBrowsePage routeKey="member/stored" />} />
          <Route path="member/coupons" element={<ModuleBrowsePage routeKey="member/coupons" />} />
          <Route path="member/birthday" element={<ModuleBrowsePage routeKey="member/birthday" />} />

          {/* 人员 */}
          <Route path="hr/staff" element={<ModuleBrowsePage routeKey="hr/staff" />} />
          <Route path="hr/schedule" element={<SchedulePage />} />
          <Route path="hr/attendance" element={<AttendancePage />} />
          <Route path="hr/performance" element={<PerformancePage />} />
          <Route path="hr/train" element={<TrainPage />} />
          <Route path="hr/health-cert" element={<ModuleBrowsePage routeKey="hr/health-cert" />} />

          {/* 食安设备 */}
          <Route path="safety/licenses" element={<LicensesPage />} />
          <Route path="safety/trace" element={<TracePage />} />
          <Route path="safety/sample" element={<SamplePage />} />
          <Route path="safety/points" element={<SafetyPointsPage />} />
          <Route path="safety/progress" element={<SafetyProgressPage />} />
          <Route path="safety/devices" element={<DeviceEnergyPage />} />

          {/* 财务 */}
          <Route path="finance/invoice" element={<FinancePage defaultTab="invoice" />} />
          <Route path="finance/tax" element={<FinancePage defaultTab="tax" />} />
          <Route path="finance/cashflow" element={<FinancePage defaultTab="cashflow" />} />
          <Route path="finance/split" element={<FinancePage defaultTab="split" />} />

          {/* 平台 */}
          <Route path="platform/ai-audit" element={<ModuleBrowsePage routeKey="platform/ai-audit" />} />
          <Route path="platform/audit-log" element={<ModuleBrowsePage routeKey="platform/audit-log" />} />

          {/* 未知路由回看板，不再展示建设中 */}
          <Route path="*" element={<PlaceholderPage title="" />} />
        </Route>
      </Routes>
      {/* 过渡期临时工具：运行时演示数据开关（淘汰完成后移除） */}
      <DemoSwitch />
    </BrowserRouter>
  )
}
