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
  SearchOutlined,
} from '@ant-design/icons'

export interface MenuLeaf {
  path: string
  title: string
  /** 前厅接口预留：与美团深度合作，相关模块暂缓开发、仅预留切换接口 */
  reserved?: boolean
}

export interface MenuGroup {
  key: string
  label: string
  icon: ReactNode
  children: MenuLeaf[]
}

/*
 * 信息架构：与 App 12 业务模块 + 平台治理对齐。
 * 每个叶子菜单均有可用页面（专用页或 ModuleBrowsePage），无「建设中」。
 */
export const MENU: MenuGroup[] = [
  {
    key: 'overview',
    label: '总览',
    icon: <DashboardOutlined />,
    children: [
      { path: '/dashboard', title: '经营看板' },
      { path: '/ops/analysis', title: '经营分析' },
      { path: '/ops/an-trend', title: '趋势分析' },
      { path: '/ops/an-heat', title: '时段热力' },
      { path: '/ops/an-mx', title: '波士顿矩阵' },
      { path: '/ops/an-eff', title: '效率仪表盘' },
      { path: '/ops/weekly', title: '经营周报' },
      { path: '/ops/reserved', title: '接口预留总览', reserved: true },
    ],
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
      { path: '/inventory/ledger', title: '库存流水' },
      { path: '/inventory/restock', title: '补货建议' },
      { path: '/inventory/vendors', title: '供应商比价' },
      { path: '/inventory/loss', title: '损耗报损' },
    ],
  },
  {
    key: 'dinein',
    label: '堂食外卖',
    icon: <ShoppingOutlined />,
    children: [
      { path: '/dinein/sales', title: '销售收银' },
      { path: '/dinein/tables', title: '桌台管理', reserved: true },
      { path: '/dinein/booking', title: '预订排队', reserved: true },
      { path: '/dinein/orders', title: '外卖订单', reserved: true },
      { path: '/dinein/delivery', title: '外卖对账', reserved: true },
      { path: '/dinein/reviews', title: '差评管理', reserved: true },
    ],
  },
  {
    key: 'member',
    label: '会员营销',
    icon: <GiftOutlined />,
    children: [
      { path: '/member/list', title: '会员列表', reserved: true },
      { path: '/member/stored', title: '储值余额', reserved: true },
      { path: '/member/coupons', title: '优惠券', reserved: true },
      { path: '/member/birthday', title: '生日营销', reserved: true },
    ],
  },
  {
    key: 'hr',
    label: '人员',
    icon: <TeamOutlined />,
    children: [
      { path: '/hr/roster', title: '员工花名册' },
      { path: '/hr/staff', title: '排班总览' },
      { path: '/hr/schedule', title: '排班登记' },
      { path: '/hr/attendance', title: '打卡补录' },
      { path: '/hr/performance', title: '绩效人效' },
      { path: '/hr/train', title: '培训考核' },
      { path: '/hr/health-cert', title: '健康证' },
    ],
  },
  {
    key: 'safety',
    label: '食安设备',
    icon: <SafetyCertificateOutlined />,
    children: [
      { path: '/safety/licenses', title: '证照合规' },
      { path: '/safety/trace', title: '溯源批次' },
      { path: '/safety/sample', title: '留样登记' },
      { path: '/safety/points', title: '食安点位统筹' },
      { path: '/safety/progress', title: '拍照核验' },
      { path: '/safety/devices', title: '设备维保能耗' },
    ],
  },
  {
    key: 'finance',
    label: '财务',
    icon: <AccountBookOutlined />,
    children: [
      { path: '/finance/invoice', title: '发票' },
      { path: '/finance/tax', title: '税务' },
      { path: '/finance/cashflow', title: '现金流水' },
      { path: '/finance/split', title: '分账审批' },
    ],
  },
  {
    key: 'platform',
    label: '平台',
    icon: <CloudServerOutlined />,
    children: [
      { path: '/platform/actions', title: '审批中心' },
      { path: '/platform/org', title: '门店岗位账号' },
      { path: '/platform/system', title: '系统配置' },
      { path: '/platform/app-release', title: 'App 下载' },
      { path: '/platform/optimization', title: '优化路线图' },
      { path: '/platform/ai-audit', title: 'AI审计' },
      { path: '/platform/audit-log', title: '审计日志' },
    ],
  },
  {
    key: 'search',
    label: '检索',
    icon: <SearchOutlined />,
    children: [
      { path: '/search', title: '全局搜索' },
    ],
  },
]

/** App/BFF route → SaaS 路径（同源待办深链） */
const ROUTE_MAP: Record<string, string> = {
  'inventory/restock': '/inventory/restock',
  'inventory/recv': '/inventory/inbound',
  'inventory/purchase': '/inventory/purchase',
  kitchen: '/kitchen/workorders',
  'm/takeout': '/dinein/orders',
  'm/booking': '/dinein/booking',
  'm/vip': '/member/birthday',
  'm/equipment': '/safety/devices',
  'm/inspection': '/safety/points',
  'm/pos': '/dinein/tables',
  'm/loss': '/inventory/loss',
  'm/review': '/dinein/reviews',
  'm/finance': '/finance/split',
  'm/actions': '/platform/actions',
}

const KIND_MAP: Record<string, string> = {
  restock: '/inventory/restock',
  prep: '/kitchen/workorders',
  channel_takeout: '/dinein/orders',
  channel_booking: '/dinein/booking',
  vip_birthday: '/member/birthday',
  equipment_over: '/safety/devices',
}

/** 看板待办/预警 → 业务页：优先 BFF route/kind，再按文案兜底 */
export function resolveDeepLink(
  text: string,
  opts?: { route?: string | null; kind?: string | null },
): string | null {
  const r = (opts?.route || '').replace(/^\//, '')
  if (r && ROUTE_MAP[r]) return ROUTE_MAP[r]
  if (opts?.kind && KIND_MAP[opts.kind]) return KIND_MAP[opts.kind]
  const t = text || ''
  if (/补货|库存|安全线|原料|断货/.test(t)) return '/inventory/restock'
  if (/采购|进货/.test(t)) return '/inventory/purchase'
  if (/工单|排产|厨房|备料/.test(t)) return '/kitchen/workorders'
  if (/预订|排队/.test(t)) return '/dinein/booking'
  if (/差评|口碑|评价/.test(t)) return '/dinein/reviews'
  if (/外卖|对账/.test(t)) return '/dinein/delivery'
  if (/健康证/.test(t)) return '/hr/health-cert'
  if (/消毒|巡检/.test(t)) return '/safety/points'
  if (/拍照核验|食安拍照|食安核验/.test(t)) return '/safety/progress'
  if (/留样/.test(t)) return '/safety/sample'
  if (/证照/.test(t)) return '/safety/licenses'
  if (/分账|财务/.test(t)) return '/finance/split'
  if (/生日|发券/.test(t)) return '/member/birthday'
  if (/超温|冷柜|设备/.test(t)) return '/safety/devices'
  if (/会员|储值|券/.test(t)) return '/member/list'
  if (/报损|损耗/.test(t)) return '/inventory/loss'
  if (/审批|待执行/.test(t)) return '/platform/actions'
  if (/预测|备货|分析/.test(t)) return '/ops/analysis'
  return null
}

export function findLeaf(path: string): { group: MenuGroup; leaf: MenuLeaf } | null {
  for (const group of MENU) {
    const leaf = group.children.find((c) => c.path === path)
    if (leaf) return { group, leaf }
  }
  return null
}
