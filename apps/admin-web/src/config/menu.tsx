import type { ReactNode } from 'react'
import {
  DashboardOutlined,
  ShopOutlined,
  InboxOutlined,
  ShoppingOutlined,
  GiftOutlined,
  TeamOutlined,
  SafetyCertificateOutlined,
  AccountBookOutlined,
  CloudServerOutlined,
} from '@ant-design/icons'

export interface MenuLeaf {
  path: string
  title: string
}

export interface MenuGroup {
  key: string
  label: string
  icon: ReactNode
  children: MenuLeaf[]
}

/*
 * 菜单与 12 业务模块一一对应；未实现页统一渲染 PlaceholderPage。
 * RBAC 可见性见 src/rbac/roles.ts，按 path 判定。
 */
export const MENU: MenuGroup[] = [
  {
    key: 'overview',
    label: '总览',
    icon: <DashboardOutlined />,
    children: [{ path: '/dashboard', title: '经营看板' }],
  },
  {
    key: 'kitchen',
    label: '菜品厨房',
    icon: <ShopOutlined />,
    children: [
      { path: '/kitchen/dishes', title: '菜品菜单' },
      { path: '/kitchen/recipes', title: '配方BOM' },
      { path: '/kitchen/sop', title: 'SOP步骤' },
      { path: '/kitchen/workorders', title: '工单排产' },
      { path: '/kitchen/qc', title: '品控记录' },
    ],
  },
  {
    key: 'inventory',
    label: '进销存',
    icon: <InboxOutlined />,
    children: [
      { path: '/inventory/stock', title: '原料库存' },
      { path: '/inventory/purchase', title: '采购单' },
      { path: '/inventory/inbound', title: '入库单' },
      { path: '/inventory/vendors', title: '供应商比价' },
    ],
  },
  {
    key: 'dinein',
    label: '堂食外卖',
    icon: <ShoppingOutlined />,
    children: [
      { path: '/dinein/tables', title: '桌台管理' },
      { path: '/dinein/orders', title: '订单查询' },
      { path: '/dinein/delivery', title: '外卖对账' },
      { path: '/dinein/reviews', title: '差评管理' },
    ],
  },
  {
    key: 'member',
    label: '会员营销',
    icon: <GiftOutlined />,
    children: [
      { path: '/member/list', title: '会员列表' },
      { path: '/member/stored', title: '储值' },
      { path: '/member/coupons', title: '优惠券' },
      { path: '/member/birthday', title: '生日营销' },
    ],
  },
  {
    key: 'hr',
    label: '人员',
    icon: <TeamOutlined />,
    children: [
      { path: '/hr/staff', title: '员工档案' },
      { path: '/hr/schedule', title: '排班' },
      { path: '/hr/attendance', title: '打卡' },
      { path: '/hr/performance', title: '绩效' },
      { path: '/hr/health-cert', title: '健康证' },
    ],
  },
  {
    key: 'safety',
    label: '食安设备',
    icon: <SafetyCertificateOutlined />,
    children: [
      { path: '/safety/licenses', title: '证照' },
      { path: '/safety/trace', title: '溯源批次' },
      { path: '/safety/sample', title: '留样消毒' },
      { path: '/safety/devices', title: '设备温度能耗' },
    ],
  },
  {
    key: 'finance',
    label: '财务',
    icon: <AccountBookOutlined />,
    children: [
      { path: '/finance/invoice', title: '发票' },
      { path: '/finance/tax', title: '税务' },
      { path: '/finance/cashflow', title: '现金流' },
      { path: '/finance/split', title: '分账审批' },
    ],
  },
  {
    key: 'platform',
    label: '平台',
    icon: <CloudServerOutlined />,
    children: [
      { path: '/platform/actions', title: '审批中心' },
      { path: '/platform/ai-audit', title: 'AI审计' },
      { path: '/platform/system', title: '系统管理' },
      { path: '/platform/audit-log', title: '审计日志' },
    ],
  },
]

export function findLeaf(path: string): { group: MenuGroup; leaf: MenuLeaf } | null {
  for (const group of MENU) {
    const leaf = group.children.find((c) => c.path === path)
    if (leaf) return { group, leaf }
  }
  return null
}
