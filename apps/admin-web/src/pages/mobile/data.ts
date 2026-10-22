/*
 * 手机版预览 · 信息架构（对齐 Android BossIa.kt 单一事实源）。
 *
 * 该文件是 Android Compose 手机 UI 的 Web 复刻数据源：
 * 底栏五席 今日|前厅|SI|后厨|我的；「我的」按 进销/前厅/钱事/人与合规/店与报表 分组。
 * 每个模块的 pills / leaves / 一句话都是手机端「点进去看什么」的导航文案，
 * desktopPath 用于「打开桌面版完整页」深链（有真数可看的页面）。
 */
import type { ReactNode } from 'react'

export interface MobileModule {
  key: string
  label: string
  group: string
  /** 「我的」宫格短副标题 */
  gridSub: string
  /** 模块一句话（列表页副标题） */
  oneLiner: string
  /** 页内 pill / 分组 */
  pills: string[]
  /** 每个 pill 下手机端会看到的信息/动作（平铺要点） */
  leaves: string[]
  /** 宫格图标底色 */
  iconBg: string
  /** 深链到桌面版完整页（有真数据） */
  desktopPath?: string
  /** 前厅接口预留：相关模块暂缓、仅预留切换接口 */
  reserved?: boolean
}

export const TAB_ORDER = ['今日', '前厅', 'SI', '后厨', '我的'] as const
export type TabKey = (typeof TAB_ORDER)[number]

export const TAB_SUB: Record<TabKey, string> = {
  今日: '营收一眼 · 待批 · 待办',
  前厅: '迎客 → 开台 → 服务 → 结账/外卖',
  SI: '问店决策 · 改数走确认台',
  后厨: '工单 → 出品 → 品控',
  我的: '进销 · 钱事 · 人合规 · 店设置',
}

export const GROUP_ORDER = ['进销', '前厅', '钱事', '人与合规', '店与报表'] as const

export const GROUP_HINT: Record<string, string> = {
  进销: '原底栏货品 · 缺货→下单→入库 · 主数据',
  前厅: '主入口在底栏「前厅」· 此处搜收藏不丢功能',
  钱事: '对账、报损与确认台',
  人与合规: '排班、食安、设备',
  店与报表: '经营分析 · 餐厅设置 · 岗位',
}

/** 前厅管道（迎客 → 开台销售 → 服务中 → 收钱履约） */
export const FRONT_PIPE: Array<{ title: string; items: string[] }> = [
  { title: '迎客', items: ['预订确认', '排队取号/叫号', '候餐发茶/小食'] },
  { title: '开台销售', items: ['巡台改态', '点菜挂单', '加菜/催菜/退菜'] },
  { title: '服务中', items: ['桌态盯梢', '打包外带', '客诉当场'] },
  { title: '收钱履约', items: ['结账扣料', '外卖接单/出餐协同', '会员储值核券'] },
]

/** 后厨管道（工单 → 出品 → 品控） */
export const KITCHEN_PIPE: Array<{ title: string; items: string[] }> = [
  { title: '工单', items: ['本餐工单列表', '按 SOP 推进', '开始/完成（扣 BOM）'] },
  { title: '出品', items: ['堂食出品进度', '外卖待做', '跳回工单补产'] },
  { title: '品控', items: ['对照菜谱质检点', '成品/留样记录', '异常跟进'] },
]

export const MODULES: MobileModule[] = [
  /* ---------------- 前厅 ---------------- */
  {
    key: 'm/pos',
    label: '堂食收银',
    group: '前厅',
    gridSub: '巡台·点菜·结账',
    oneLiner: '巡台改态 → 点菜挂单 → 结账扣料',
    pills: ['巡台', '点菜', '结账'],
    leaves: [
      '桌态 free/busy/clean/rsv · 并台/拆台/转台',
      '菜类筛选 · 购物车 · 挂单回巡台 · 就餐桌加菜',
      '账单明细 · 打包外带登记 · 收款确认 · 结账扣料经确认台',
    ],
    iconBg: '#FCEDD0',
    desktopPath: '/dinein/sales',
  },
  {
    key: 'm/booking',
    label: '预订排队',
    group: '前厅',
    gridSub: '叫号·翻台',
    oneLiner: '迎客 · 叫号 · 翻台 · 候餐',
    pills: ['今日预订', '排队叫号', '候餐服务', '翻台预估'],
    leaves: ['预订桌/人数/时段 · 确认/改期', '等位队列 · 取号 · 叫号/过号', '估时看板 · 发茶登记 · 等位安抚', '预计空台时间 · 高峰提示'],
    iconBg: '#EDE3F4',
    desktopPath: '/dinein/booking',
    reserved: true,
  },
  {
    key: 'm/takeout',
    label: '外卖',
    group: '前厅',
    gridSub: '美团/饿了么',
    oneLiner: '渠道接单 · 出餐协同 · 对账',
    pills: ['概览', '对账', '差评'],
    leaves: ['平台单量/金额 · 待接/制作中 · 转后厨工单', '渠道结算核对 · 差异跟进', '差评列表 · 回访动作'],
    iconBg: '#E2F0E2',
    desktopPath: '/dinein/orders',
    reserved: true,
  },
  {
    key: 'm/vip',
    label: '会员',
    group: '前厅',
    gridSub: '储值/券/生日',
    oneLiner: '熟客经营 · 储值/券/生日',
    pills: ['会员', '储值', '券', '生日'],
    leaves: ['会员数/活跃 · 等级分布', '储值余额 · 充值活动', '在发券种 · 核销概况', '近七日寿星 · 关怀/发券'],
    iconBg: '#FCE4E1',
    desktopPath: '/member/list',
    reserved: true,
  },
  {
    key: 'm/review',
    label: '口碑',
    group: '前厅',
    gridSub: '差评·好评·客诉',
    oneLiner: '客评与客诉跟进（服务收口）',
    pills: ['评分', '差评', '好评'],
    leaves: ['综合评分 · 渠道分布', '待回访 · 处理状态 · 当场客诉登记', '好评摘要 · 可运营素材'],
    iconBg: '#FCE4E1',
    desktopPath: '/dinein/reviews',
    reserved: true,
  },

  /* ---------------- 进销（原货品底栏） ---------------- */
  {
    key: 'inventory',
    label: '库存',
    group: '进销',
    gridSub: '账面·安全线',
    oneLiner: '账面 · 告急/偏低/够用分层',
    pills: ['账面', '安全线', '盘点'],
    leaves: ['告急/偏低/够用分层', '安全线提示', '拍照盘点/账面核对'],
    iconBg: '#FCE4E1',
    desktopPath: '/inventory/stock',
  },
  {
    key: 'inventory/restock',
    label: '缺货',
    group: '进销',
    gridSub: '办货第1步',
    oneLiner: '补货建议 · 勾选生成采购意向',
    pills: ['补货建议'],
    leaves: ['补货建议清单', '勾选 → 确认台开意向', '可改数量后提交'],
    iconBg: '#FFF0F4',
    desktopPath: '/inventory/restock',
  },
  {
    key: 'inventory/purchase',
    label: '下单',
    group: '进销',
    gridSub: '办货第2步',
    oneLiner: '采购草稿/在途单 · 确认下单给供应商',
    pills: ['采购单'],
    leaves: ['采购草稿/在途单', '确认下单 / 标记状态', '跳转入库'],
    iconBg: '#FCEDD0',
    desktopPath: '/inventory/purchase',
  },
  {
    key: 'inventory/recv',
    label: '入库',
    group: '进销',
    gridSub: '办货第3步',
    oneLiner: '货到齐后入库改账面',
    pills: ['待收货', '已入库'],
    leaves: ['待收货/已入库', '齐货入库改账面', '回看采购单'],
    iconBg: '#E2F0E2',
    desktopPath: '/inventory/inbound',
  },
  {
    key: 'inventory/catalog',
    label: '产品库',
    group: '进销',
    gridSub: '包规·安全线',
    oneLiner: 'SKU · 包规 · 安全库存',
    pills: ['SKU', '包规'],
    leaves: ['SKU·包规·安全库存', '改数经确认台'],
    iconBg: '#EDE3F4',
    desktopPath: '/inventory/stock',
  },
  {
    key: 'inventory/vendors',
    label: '供应商',
    group: '进销',
    gridSub: '档案·账期',
    oneLiner: '供应商档案 · 报价比价在供应链',
    pills: ['档案'],
    leaves: ['档案·联系人·账期入口', '报价比价去「供应链」'],
    iconBg: '#E3EDF7',
    desktopPath: '/inventory/vendors',
  },

  /* ---------------- 钱事 ---------------- */
  {
    key: 'm/finance',
    label: '财务',
    group: '钱事',
    gridSub: '对账·结算',
    oneLiner: '对账 · 结算',
    pills: ['对账', '发票', '税务', '现金流', '分账'],
    leaves: ['日结核对 · 堂食/外卖 vs 采购', '开票记录 · 待开清单', '税务节点提醒', '进/出/结余 · 冻结/解冻', '平台/门店分账 · 审批'],
    iconBg: '#E2F0E2',
    desktopPath: '/finance/split',
  },
  {
    key: 'm/loss',
    label: '损耗',
    group: '钱事',
    gridSub: '报损·盘点差',
    oneLiner: '报损 · 盘点差',
    pills: ['分析', '报损', '盘点差'],
    leaves: ['损耗结构 · 高损品项', '报损单 · 确认台落库', '账面 vs 实盘 · 差异原因'],
    iconBg: '#FCEDD0',
    desktopPath: '/inventory/loss',
  },
  {
    key: 'm/actions',
    label: '确认台',
    group: '钱事',
    gridSub: '待批草稿·店内执行',
    oneLiner: '待批草稿 · 店内执行',
    pills: ['草稿', '待执行', '已执行', '已驳回'],
    leaves: ['跨模块动作流', '确认 / 驳回 · 看摘要与影响', '店内执行进度', '驳回原因'],
    iconBg: '#EDE3F4',
    desktopPath: '/platform/actions',
  },

  /* ---------------- 人与合规 ---------------- */
  {
    key: 'm/staff',
    label: '排班',
    group: '人与合规',
    gridSub: '班表·打卡·人效',
    oneLiner: '班表 · 打卡 · 人效',
    pills: ['排班', '打卡', '人效', '培训'],
    leaves: ['今日班表 · 缺口提示 · 改班', '出勤/迟到 · 异常', '人效指标 · 对比', '培训记录 · 待训名单'],
    iconBg: '#E3EDF7',
    desktopPath: '/hr/schedule',
  },
  {
    key: 'm/foodsafe',
    label: '食安',
    group: '人与合规',
    gridSub: '留样·消毒·证照',
    oneLiner: '留样 · 消毒 · 证照',
    pills: ['留样', '消毒', '证照', '溯源'],
    leaves: ['今日留样 · 拍照记录', '消毒打卡 · 漏做提醒', '证照到期 · 补证提醒', '原料批次 · 扫码追踪'],
    iconBg: '#E2F0E2',
    desktopPath: '/safety/licenses',
  },
  {
    key: 'm/safety-check',
    label: '拍照核验',
    group: '人与合规',
    gridSub: '点位·拍照·初判',
    oneLiner: '点位拍照上报 · AI 初判 · 人工复核',
    pills: ['待检', '已上报', '待复核'],
    leaves: ['今日应检点位 · 核验要点 · 拍照上报', '已上报待确认 · AI 初判结果', '不合格项 · AI 初判失败项'],
    iconBg: '#E2F0E2',
    desktopPath: '/safety/progress',
  },
  {
    key: 'm/equipment',
    label: '设备',
    group: '人与合规',
    gridSub: '温度·能耗·维保',
    oneLiner: '温度 · 能耗 · 维保',
    pills: ['温度', '能耗', '维保'],
    leaves: ['冷柜温度 · 超温告警', '用电/用水趋势', '维保计划 · 故障单'],
    iconBg: '#FCEDD0',
    desktopPath: '/safety/devices',
  },
  {
    key: 'm/inspection',
    label: '闭店巡检',
    group: '人与合规',
    gridSub: '50 节点·拍照留证',
    oneLiner: '门窗/煤气/冰箱/电源/卫生间等 50 节点拍照巡检',
    pills: ['后厨', '前厅', '仓库'],
    leaves: ['灶台/冰箱柜门/地沟 · 每点拍照留证', '门窗/电源/水龙头 · 漏项清单', '门锁/消防 · 30 分钟卫生间签到'],
    iconBg: '#E3EDF7',
    desktopPath: '/safety/points',
  },

  /* ---------------- 店与报表 ---------------- */
  {
    key: 'm/analysis',
    label: '经营分析',
    group: '店与报表',
    gridSub: 'KPI·热力·预测',
    oneLiner: 'KPI · 热力 · 预测',
    pills: ['营收', '时段', '菜品', '保本', '效率', '预测'],
    leaves: ['KPI 卡 · 趋势 · 导出周报', '热力/时段对比', '爆品/滞销 · 推置顶收银', '理论日保本 · 类型结构', '翻台/坪效/人效', '销量预测 · 转采购建议'],
    iconBg: '#EDE3F4',
    desktopPath: '/ops/analysis',
  },
  {
    key: 'm/restaurant',
    label: '我的餐厅',
    group: '店与报表',
    gridSub: '资料·桌台·菜单',
    oneLiner: '资料 · 桌台 · 营业偏好 · 菜单挂菜谱',
    pills: ['资料', '桌台', '经营', '菜单'],
    leaves: ['店名/地址/电话', '桌号/容量/分区', '营业时段 · 默认菜类', '菜品上下架/调价 · 挂靠菜谱'],
    iconBg: '#FCEDD0',
    desktopPath: '/dinein/tables',
    reserved: true,
  },
  {
    key: 'm/org',
    label: '门店岗位',
    group: '店与报表',
    gridSub: '组织·权限·开账号',
    oneLiner: '组织 · 权限 · 开账号',
    pills: ['概览'],
    leaves: ['门店列表', '岗位账号', '筹备新店 · 开账号 · 改岗权'],
    iconBg: '#E3EDF7',
    desktopPath: '/platform/org',
  },
  {
    key: 'm/supply',
    label: '供应链',
    group: '店与报表',
    gridSub: '报价比价（档案在货品）',
    oneLiner: '报价比价（档案在货品）',
    pills: ['供应商', '报价', '账期'],
    leaves: ['列表跳货品档案 · 账期入口', '多供应商比价 · 选价 · 开采购意向', '账期约定 · 到期提醒'],
    iconBg: '#E3EDF7',
    desktopPath: '/inventory/vendors',
  },

  /* ---------------- 后厨（底栏后厨，不并入「我的」分组） ---------------- */
  {
    key: 'kitchen',
    label: '工单',
    group: '后厨',
    gridSub: '本餐排产',
    oneLiner: '按菜谱标准推进工单（完成扣 BOM）',
    pills: ['本餐工单'],
    leaves: ['本餐工单列表', '按 SOP 推进', '开始/完成（扣 BOM）', '缺料提示'],
    iconBg: '#FCEDD0',
    desktopPath: '/kitchen/workorders',
  },
  {
    key: 'kitchen/board',
    label: '出品',
    group: '后厨',
    gridSub: '进度·外卖待做',
    oneLiner: '看出品进度与外卖待做',
    pills: ['出品'],
    leaves: ['堂食出品进度', '外卖待做', '跳回工单补产'],
    iconBg: '#E2F0E2',
    desktopPath: '/kitchen/workorders',
  },
  {
    key: 'kitchen/qc',
    label: '品控',
    group: '后厨',
    gridSub: '抽检·留样',
    oneLiner: '对照菜谱标准抽检成品/留样',
    pills: ['品控'],
    leaves: ['对照菜谱质检点', '成品/留样记录', '抽检结果 · 异常跟进'],
    iconBg: '#EDE3F4',
    desktopPath: '/kitchen/qc',
  },
  {
    key: 'kitchen/recipes',
    label: '菜谱',
    group: '后厨',
    gridSub: '出品标准',
    oneLiner: '出品标准 · 厨师须遵照执行',
    pills: ['菜谱'],
    leaves: ['出品标准 SOP', '标准 BOM 分量', '份量换算 · 替代料（须确认）', '转工单 / 转采购'],
    iconBg: '#FCE4E1',
    desktopPath: '/kitchen/recipes',
  },
]

export const moduleByKey = (key: string) => MODULES.find((m) => m.key === key)
export const modulesIn = (group: string) => MODULES.filter((m) => m.group === group)
export const FRONT_MODULE_KEYS = ['m/pos', 'm/booking', 'm/takeout', 'm/vip', 'm/review']
export const KITCHEN_MODULE_KEYS = ['kitchen', 'kitchen/board', 'kitchen/qc', 'kitchen/recipes']

/** SI 快捷问句（链接到真实经营分析/看板） */
export const SI_PROMPTS: Array<{ label: string; hint: string; desktopPath?: string }> = [
  { label: '下周备货建议', hint: '缺料与报价', desktopPath: '/inventory/restock' },
  { label: '缺料与报价', hint: '原料比价', desktopPath: '/inventory/vendors' },
  { label: '菜谱用量换算', hint: '配方 BOM', desktopPath: '/kitchen/recipes' },
  { label: '今日营收概况', hint: '经营看板', desktopPath: '/dashboard' },
  { label: '毛利结构分析', hint: '经营分析', desktopPath: '/ops/analysis' },
  { label: '待办与预警', hint: '今日看板', desktopPath: '/dashboard' },
]

export interface MobileModuleIcon { key: string; node: ReactNode }
