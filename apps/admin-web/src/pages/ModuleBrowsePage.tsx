import { useCallback, useEffect, useMemo, useState } from 'react'
import { rk } from '../utils/rowKey'
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { type Dayjs } from 'dayjs'
import { client } from '../api/client'
import { postAction, fetchSnapshot } from '../api'
import { useAuthStore } from '../store/auth'

type Row = Record<string, unknown>
type Opt = { value: string | number; label: string }

type WriteField = {
  name: string
  label: string
  type: 'text' | 'number' | 'select' | 'date'
  required?: boolean
  min?: number
  max?: number
  initial?: unknown
  placeholder?: string
  options?: Opt[]
  /** 动态选项：快照原料 / 菜品（AutoComplete 渲染，允许自由输入） */
  optionsFrom?: 'ings' | 'dishes'
  /** 从主表 rows 按字段去重取选项 */
  optionsFromRows?: string
}

type PageAction = {
  label: string
  type: string
  build: (rows: Row[], values?: Record<string, unknown>) => Record<string, unknown>
  summary: (rows: Row[]) => string
  /** 有 fields 时先弹 Modal 真表单，确认后入队 */
  fields?: WriteField[]
  /** 返回禁用原因；null 表示可用 */
  disabledReason?: (rows: Row[]) => string | null
}

type PageCfg = {
  title: string
  path: string
  listKey: string
  columns: ColumnsType<Row>
  /** 页面级写操作 */
  actions?: PageAction[]
  /** 行级写操作 */
  rowAction?: {
    label: string
    type: string
    build: (row: Row) => Record<string, unknown>
    summary: (row: Row) => string
    /** 行不满足条件时隐藏按钮（如已处理差评） */
    visibleWhen?: (row: Row) => boolean
  }
  emptyHint?: string
  /** 额外从 snapshot 取数 */
  fromSnapshot?: (snap: Awaited<ReturnType<typeof fetchSnapshot>>) => Row[]
  /** 列表过滤（如生日即将到来） */
  filterRows?: (rows: Row[], data: Record<string, unknown>) => Row[]
  /** 同接口第二张表（如能耗） */
  secondary?: {
    title: string
    listKey: string
    /** 嵌套路径，如 forecast.restock */
    nestedKey?: string
    columns: ColumnsType<Row>
  }
  /** 同接口第三张表 */
  tertiary?: {
    title: string
    listKey: string
    nestedKey?: string
    columns: ColumnsType<Row>
  }
}

const COL = {
  text: (title: string, key: string, width?: number) => ({
    title,
    dataIndex: key,
    width,
    ellipsis: true,
    render: (v: unknown) => (v == null || v === '' ? '-' : String(v)),
  }),
  money: (title: string, key: string, width = 100) => ({
    title,
    dataIndex: key,
    width,
    render: (v: unknown) => (v == null ? '-' : `¥${v}`),
  }),
  tag: (title: string, key: string, width = 100) => ({
    title,
    dataIndex: key,
    width,
    render: (v: unknown) => <Tag>{v == null ? '-' : String(v)}</Tag>,
  }),
}

const PLATFORM_OPTS: Opt[] = ['美团', '饿了么', '京东到家'].map((p) => ({ value: p, label: p }))

const PAGES: Record<string, PageCfg> = {
  'dinein/orders': {
    title: '外卖订单',
    path: '/modules/takeout',
    listKey: 'orders',
    emptyHint: '暂无外卖订单，可先做对账确认',
    columns: [
      COL.text('平台', 'platform', 100),
      COL.text('平台单号', 'platform_no', 140),
      COL.money('金额', 'amount'),
      COL.tag('状态', 'status'),
      COL.text('时间', 'ts', 180),
    ],
    actions: [
      {
        label: '对账确认',
        type: 'takeout.ack',
        summary: () => '确认外卖对账',
        fields: [
          {
            name: 'platform',
            label: '平台',
            type: 'select',
            required: true,
            initial: '美团',
            options: PLATFORM_OPTS,
          },
        ],
        build: (_rows, v) => ({ platform: v?.platform, status: '已对账', note: 'admin 对账' }),
      },
    ],
  },
  'dinein/delivery': {
    title: '外卖对账',
    path: '/modules/takeout',
    listKey: 'reconcile',
    emptyHint: '暂无对账记录',
    columns: [
      COL.text('平台', 'platform', 100),
      COL.text('账期', 'period', 120),
      COL.money('应结', 'expect_amt'),
      COL.money('实结', 'actual_amt'),
      COL.money('差额', 'diff'),
      COL.tag('状态', 'status'),
    ],
    actions: [
      {
        label: '标记已对账',
        type: 'takeout.ack',
        summary: () => '将本期对账标为已对账',
        fields: [
          {
            name: 'platform',
            label: '平台',
            type: 'select',
            required: true,
            options: PLATFORM_OPTS,
          },
        ],
        build: (rows, v) => ({
          platform: v?.platform ?? String(rows[0]?.platform || '美团'),
          status: '已对账',
          amount: rows[0]?.actual_amt,
        }),
      },
    ],
  },
  'dinein/reviews': {
    title: '差评管理',
    path: '/modules/review',
    listKey: 'reviews',
    emptyHint: '暂无评价',
    columns: [
      COL.text('来源', 'source', 100),
      COL.text('评分', 'rating', 80),
      COL.text('内容', 'content'),
      {
        title: '处理',
        dataIndex: 'handled',
        width: 90,
        render: (v: unknown) =>
          Number(v) === 1 ? <Tag color="green">已处理</Tag> : <Tag color="orange">待跟进</Tag>,
      },
      COL.text('时间', 'ts', 160),
    ],
    rowAction: {
      label: '跟进',
      type: 'review.followup',
      summary: (r) => `跟进评价 #${r.id}`,
      /* 已处理的评价不再展示跟进入口 */
      visibleWhen: (r) => Number(r.handled) !== 1,
      build: (r) => ({
        review_id: r.id,
        action: '电话回访致歉',
        owner: 'admin',
        status: '进行中',
      }),
    },
  },
  'member/list': {
    title: '会员列表',
    path: '/modules/vip',
    listKey: 'members',
    emptyHint: '暂无会员',
    columns: [
      COL.text('会员号', 'member_id', 120),
      COL.text('姓名', 'name', 100),
      COL.text('手机', 'phone', 130),
      COL.tag('等级', 'level', 90),
      COL.money('余额', 'balance'),
      COL.tag('状态', 'status', 90),
    ],
    actions: [
      {
        label: '创建满减活动',
        type: 'vip.campaign',
        summary: () => '创建满减券活动草案',
        build: () => ({
          campaign_type: '满减',
          value: 20,
          code: `ADM${Date.now() % 100000}`,
        }),
      },
    ],
  },
  'member/stored': {
    title: '储值余额',
    path: '/modules/vip',
    listKey: 'members',
    emptyHint: '暂无储值会员',
    columns: [
      COL.text('会员', 'name', 120),
      COL.text('会员号', 'member_id', 120),
      COL.money('余额', 'balance'),
      COL.tag('等级', 'level'),
    ],
  },
  'member/coupons': {
    title: '优惠券',
    path: '/modules/vip',
    listKey: 'coupons',
    emptyHint: '暂无券，可创建活动草案',
    columns: [
      COL.text('券码', 'code', 140),
      COL.text('类型', 'type', 100),
      COL.money('面额', 'value'),
      COL.tag('状态', 'status'),
    ],
    actions: [
      {
        label: '新建活动券',
        type: 'vip.campaign',
        summary: () => '新建优惠券活动',
        build: () => ({
          campaign_type: '折扣',
          value: 10,
          code: `CPN${Date.now() % 100000}`,
        }),
      },
    ],
  },
  'member/birthday': {
    title: '生日营销',
    path: '/modules/vip',
    listKey: 'members',
    emptyHint: '暂无即将生日的会员',
    filterRows: (rows) => {
      const soon = rows.filter((r) => !!r.birthday_soon)
      return soon.length ? soon : rows.slice(0, 3)
    },
    columns: [
      COL.text('会员', 'name', 120),
      COL.text('手机', 'phone', 130),
      COL.tag('等级', 'level'),
      COL.money('余额', 'balance'),
      COL.text('生日', 'birthday', 110),
      {
        title: '本周',
        dataIndex: 'birthday_soon',
        width: 80,
        render: (v: unknown) =>
          v ? <Tag color="magenta">待发券</Tag> : <Tag>否</Tag>,
      },
    ],
    actions: [
      {
        label: '推送生日礼券',
        type: 'vip.campaign',
        summary: (rows) => `为 ${rows.length || 0} 位会员推送生日礼券`,
        fields: [
          {
            name: 'value',
            label: '礼券面额（元）',
            type: 'number',
            required: true,
            min: 1,
            initial: 30,
          },
        ],
        build: (rows, v) => ({
          campaign_type: '生日礼',
          value: v?.value ?? 30,
          code: `BDY${Date.now() % 100000}`,
          member_ids: rows.map((r) => r.member_id).filter(Boolean),
        }),
      },
    ],
  },
  'hr/staff': {
    title: '排班总览',
    path: '/modules/staff',
    listKey: 'shifts',
    emptyHint: '暂无排班，可登记换班',
    columns: [
      COL.text('日期', 'date', 120),
      COL.text('员工', 'staff_name', 120),
      COL.text('工号', 'staff_id', 100),
      COL.tag('班次', 'shift', 90),
      COL.text('岗位', 'role', 100),
      COL.text('时段', 'start_time', 80),
    ],
    actions: [
      {
        label: '登记换班',
        type: 'staff.shift_upsert',
        summary: () => '登记换班',
        fields: [
          { name: 'staff_name', label: '员工', type: 'select', required: true, optionsFromRows: 'staff_name' },
          { name: 'date', label: '日期', type: 'date', required: true, initial: dayjs() },
          {
            name: 'shift',
            label: '班次',
            type: 'select',
            required: true,
            initial: '早班',
            options: ['早班', '中班', '晚班'].map((s) => ({ value: s, label: s })),
          },
        ],
        build: (_rows, v) => ({
          staff_name: v?.staff_name,
          date: v?.date ? (v.date as Dayjs).format('YYYY-MM-DD') : undefined,
          shift: v?.shift,
        }),
      },
      {
        label: '补打卡',
        type: 'staff.clock',
        summary: () => '补录打卡',
        fields: [
          { name: 'staff_name', label: '员工', type: 'select', required: true, optionsFromRows: 'staff_name' },
          {
            name: 'kind',
            label: '类型',
            type: 'select',
            required: true,
            initial: '上班',
            options: ['上班', '下班'].map((s) => ({ value: s, label: s })),
          },
          { name: 'time', label: '打卡时间', type: 'text', required: true, placeholder: 'HH:mm，如 09:00' },
        ],
        build: (_rows, v) => ({
          staff_name: v?.staff_name,
          kind: v?.kind,
          time: v?.time,
          status: '补录',
        }),
      },
    ],
    secondary: {
      title: '近期打卡',
      listKey: 'clock',
      columns: [
        COL.text('时间', 'ts', 160),
        COL.text('员工', 'staff_id', 120),
        COL.tag('类型', 'kind', 80),
        COL.tag('状态', 'status', 90),
      ],
    },
  },
  'hr/health-cert': {
    title: '健康证',
    path: '/modules/foodsafe',
    listKey: 'certs',
    emptyHint: '暂无健康证记录',
    columns: [
      COL.text('持证人', 'holder', 120),
      COL.tag('类型', 'cert_type', 100),
      COL.text('证号', 'cert_no', 140),
      COL.text('到期日', 'expire_at', 120),
      COL.tag('状态', 'status', 90),
    ],
    actions: [
      {
        label: '工服合规登记',
        type: 'uniform.log',
        summary: () => '登记工服合规检查',
        build: () => ({ pass: true, course: '工服合规', note: 'admin' }),
      },
    ],
  },
  'ops/analysis': {
    title: '经营分析',
    path: '/modules/analysis',
    listKey: 'trend',
    emptyHint: '暂无趋势数据',
    columns: [
      COL.text('日期', 'date', 120),
      COL.money('营收', 'revenue'),
      COL.text('订单', 'orders', 90),
    ],
    actions: [
      {
        label: '分析转补货建议',
        type: 'analysis.restock',
        summary: (rows) => `按预测备货 ${rows.length} 项转采购草稿`,
        /* 无 AI 预测数据时禁用，不再硬编码兜底项 */
        disabledReason: (rows) =>
          rows.length > 0 ? null : '暂无 AI 预测备货数据，无法生成补货草稿',
        build: (rows) => ({
          supplier: '分析建议',
          note: '管理端经营分析一键转补货（同源 App forecast）',
          items: rows.map((r) => ({
            name: r.name,
            qty: r.qty ?? r.opt ?? 10,
            price: r.amount ?? 0,
          })),
        }),
      },
    ],
    secondary: {
      title: 'AI 预测备货（与 App 同源）',
      listKey: 'forecast',
      nestedKey: 'restock',
      columns: [
        COL.text('原料', 'name', 140),
        COL.text('单位', 'unit', 60),
        COL.text('建议量', 'qty', 80),
        COL.text('预测', 'pred', 80),
        COL.text('保守', 'cons', 80),
        COL.text('乐观', 'opt', 80),
        COL.tag('标记', 'badge', 90),
        COL.text('原因', 'reason'),
      ],
    },
    tertiary: {
      title: '菜品矩阵',
      listKey: 'matrix',
      columns: [
        COL.text('菜品', 'name', 140),
        COL.tag('象限', 'quadrant', 100),
        COL.text('销量', 'volume', 90),
        COL.text('毛利', 'margin', 90),
      ],
      /* 行级动作（调价/上下架/标为爆品）在组件内按 routeKey==='ops/analysis' 追加 */
    },
  },
  'inventory/loss': {
    title: '损耗报损',
    path: '/modules/loss',
    listKey: 'reports',
    emptyHint: '暂无报损，可提交报损单',
    columns: [
      COL.text('日期', 'date', 120),
      COL.text('原料', 'ing_name', 140),
      COL.text('数量', 'qty', 80),
      COL.text('原因', 'reason'),
      COL.text('报告人', 'reporter', 100),
      COL.tag('状态', 'status', 100),
    ],
    actions: [
      {
        label: '提交报损',
        type: 'loss.report',
        summary: () => '提交报损单',
        fields: [
          { name: 'ing_name', label: '原料', type: 'select', required: true, optionsFrom: 'ings', placeholder: '从产品库选或输入' },
          { name: 'qty', label: '数量', type: 'number', required: true, min: 0.01, initial: 1 },
          { name: 'reason', label: '原因', type: 'text', required: true, placeholder: '如 受潮 / 过期 / 破损' },
        ],
        build: (_rows, v) => ({
          name: v?.ing_name,
          ing_name: v?.ing_name,
          qty: v?.qty,
          reason: v?.reason,
          reporter: 'admin',
        }),
      },
    ],
  },
  'safety/sample': {
    title: '留样 · 消毒',
    path: '/modules/foodsafe',
    listKey: 'samples',
    emptyHint: '暂无留样，可立即登记',
    columns: [
      COL.text('日期', 'date', 120),
      COL.text('餐次', 'meal', 80),
      COL.text('菜品', 'dish', 140),
      COL.text('克重', 'weight_g', 80),
      COL.text('余时(h)', 'hours_left', 90),
      COL.text('保管人', 'keeper', 100),
    ],
    actions: [
      {
        label: '登记留样',
        type: 'sample.log',
        summary: () => '登记留样',
        fields: [
          { name: 'dish', label: '菜品', type: 'select', required: true, optionsFrom: 'dishes', placeholder: '从菜品库选或输入' },
          { name: 'weight_g', label: '克重（g）', type: 'number', required: true, min: 1, initial: 125 },
          {
            name: 'meal',
            label: '餐次',
            type: 'select',
            required: true,
            initial: '午餐',
            options: ['早餐', '午餐', '晚餐'].map((s) => ({ value: s, label: s })),
          },
        ],
        build: (_rows, v) => ({
          meal: v?.meal,
          dish: v?.dish,
          weight_g: v?.weight_g,
          keeper: 'admin',
        }),
      },
      {
        label: '登记消毒',
        type: 'fs.disinfect',
        summary: () => '餐具区高温消毒',
        build: () => ({ area: '餐具区', method: '高温', operator: 'admin' }),
      },
    ],
  },
  'safety/devices': {
    title: '设备温度 · 维保 · 能耗',
    path: '/modules/equipment',
    listKey: 'temps',
    emptyHint: '暂无温度传感器数据',
    columns: [
      COL.text('设备', 'device', 140),
      COL.tag('类型', 'kind', 90),
      {
        title: '温度℃',
        dataIndex: 'temp',
        width: 90,
        render: (v: unknown) => (v == null ? '-' : String(v)),
      },
      {
        title: '上限',
        dataIndex: 'max',
        width: 80,
        render: (v: unknown) => (v == null ? '-' : String(v)),
      },
      {
        title: '状态',
        dataIndex: 'status',
        width: 100,
        render: (v: unknown) => {
          const s = String(v || '')
          const color = /超|高|告警|warn|over/i.test(s) ? 'red' : 'green'
          return <Tag color={color}>{s || '-'}</Tag>
        },
      },
      COL.text('持续(分)', 'minutes', 90),
    ],
    actions: [
      {
        label: '登记维保',
        type: 'equipment.maintain',
        summary: () => '登记设备维保',
        fields: [
          { name: 'device', label: '设备', type: 'select', required: true, optionsFromRows: 'device', placeholder: '从设备列表选或输入' },
          {
            name: 'kind',
            label: '类型',
            type: 'select',
            required: true,
            initial: '巡检',
            options: ['巡检', '保养', '维修'].map((s) => ({ value: s, label: s })),
          },
          { name: 'note', label: '备注', type: 'text', placeholder: '后台登记' },
        ],
        build: (_rows, v) => ({
          device: v?.device,
          kind: v?.kind,
          operator: 'admin',
          note: v?.note || '后台登记',
        }),
      },
    ],
    secondary: {
      title: '维保记录',
      listKey: 'maintain',
      columns: [
        COL.text('设备', 'device', 140),
        COL.tag('类型', 'kind', 90),
        COL.text('操作人', 'operator', 100),
        COL.text('时间', 'ts', 160),
        COL.text('备注', 'note'),
      ],
    },
    tertiary: {
      title: '能耗抄表',
      listKey: 'energy',
      columns: [
        COL.text('日期', 'date', 120),
        COL.text('设备', 'device', 140),
        COL.tag('种类', 'kind', 80),
        COL.text('读数', 'reading', 100),
        COL.text('用量', 'usage', 100),
      ],
    },
  },
  'finance/invoice': {
    title: '发票',
    path: '/modules/finance',
    listKey: 'invoices',
    emptyHint: '暂无发票记录',
    columns: [
      COL.text('发票号', 'invoice_no', 140),
      COL.text('种类', 'kind', 100),
      COL.text('方向', 'direction', 80),
      COL.money('金额', 'amount'),
      COL.money('税额', 'tax'),
      COL.tag('状态', 'status'),
      COL.text('时间', 'ts', 160),
    ],
  },
  'finance/tax': {
    title: '税务申报',
    path: '/modules/finance',
    listKey: 'tax',
    emptyHint: '暂无税务记录',
    columns: [
      COL.text('属期', 'period', 120),
      COL.text('税种', 'kind', 120),
      COL.money('金额', 'amount'),
      COL.tag('状态', 'status'),
      COL.text('申报日', 'filed_at', 140),
    ],
  },
  'finance/cashflow': {
    title: '现金流水',
    path: '/modules/finance',
    listKey: 'cash',
    emptyHint: '暂无现金流水',
    columns: [
      COL.text('时间', 'ts', 160),
      COL.tag('类型', 'kind', 100),
      COL.money('金额', 'amount'),
      COL.text('账户', 'account', 120),
      COL.text('备注', 'note'),
    ],
  },
  'finance/split': {
    title: '分账审批',
    path: '/modules/finance',
    listKey: 'split',
    emptyHint: '暂无分账，可冻结一笔',
    columns: [
      COL.text('账期', 'period', 100),
      COL.text('分账方', 'party', 120),
      COL.money('金额', 'amount'),
      COL.text('比例', 'ratio', 80),
      COL.text('冻结至', 'frozen_until', 120),
      COL.tag('状态', 'status'),
    ],
    actions: [
      {
        label: '冻结分账',
        type: 'finance.freeze',
        summary: () => '冻结分账',
        fields: [
          { name: 'party', label: '分账方', type: 'text', required: true, initial: '合伙人' },
          { name: 'amount', label: '金额（元）', type: 'number', required: true, min: 0.01 },
          { name: 'ratio', label: '比例（0-1）', type: 'number', required: true, min: 0, max: 1, initial: 0.3 },
          { name: 'frozen_until', label: '冻结至', type: 'date', required: true, initial: dayjs().add(30, 'day') },
        ],
        build: (_rows, v) => ({
          party: v?.party,
          amount: v?.amount,
          ratio: v?.ratio,
          frozen_until: v?.frozen_until
            ? (v.frozen_until as Dayjs).format('YYYY-MM-DD')
            : undefined,
        }),
      },
    ],
    rowAction: {
      label: '批准结算',
      type: 'finance.approve',
      summary: (r) => `批准分账 #${r.id}`,
      build: (r) => ({ id: r.id, party: r.party, amount: r.amount, status: '已结算' }),
    },
  },
  'platform/ai-audit': {
    title: 'AI 审计（Kimi 调用）',
    path: '/admin/kimi-log',
    listKey: 'items',
    emptyHint: '暂无 Kimi 调用记录',
    columns: [
      COL.text('trace', 'trace_id', 160),
      COL.text('类型', 'type', 90),
      COL.text('模型', 'model', 140),
      {
        title: '结果',
        dataIndex: 'ok',
        width: 80,
        render: (v: unknown) =>
          v ? <Tag color="green">ok</Tag> : <Tag color="red">fail</Tag>,
      },
      COL.text('耗时ms', 'latency_ms', 90),
      COL.text('时间', 'ts', 180),
    ],
  },
  'platform/audit-log': {
    title: '审计日志',
    path: '/admin/audit',
    listKey: 'items',
    emptyHint: '暂无审计日志',
    columns: [
      COL.text('时间', 'ts', 180),
      COL.text('方法', 'method', 80),
      COL.text('路径', 'path', 200),
      COL.text('角色', 'role', 80),
      COL.text('状态码', 'status', 90),
      COL.text('耗时ms', 'dt_ms', 90),
      COL.text('trace', 'trace_id', 140),
    ],
  },
}

export default function ModuleBrowsePage({ routeKey }: { routeKey: string }) {
  const cfg = PAGES[routeKey]
  const canWrite = useAuthStore((s) => s.canWrite)
  const noWriteTip = '当前角色无写权限，仅可查看'
  const [rows, setRows] = useState<Row[]>([])
  const [secondaryRows, setSecondaryRows] = useState<Row[]>([])
  const [tertiaryRows, setTertiaryRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [rev, setRev] = useState<string | number | undefined>()
  const [busy, setBusy] = useState(false)
  const [formAction, setFormAction] = useState<PageAction | null>(null)
  const [ingsOpts, setIngsOpts] = useState<Opt[]>([])
  const [dishOpts, setDishOpts] = useState<Opt[]>([])
  const [dishMap, setDishMap] = useState<Map<string, { id: string; on?: boolean }>>(new Map())
  const [priceRow, setPriceRow] = useState<Row | null>(null)
  const [writeForm] = Form.useForm()
  const [priceForm] = Form.useForm()

  /** 菜品库 名称→{id,on}：矩阵行级动作（set_active 必须带 id） */
  const loadDishMap = useCallback(() => {
    if (routeKey !== 'ops/analysis') return
    client
      .get('/admin/dishes')
      .then(({ data }) => {
        const m = new Map<string, { id: string; on?: boolean }>()
        for (const d of (data?.items ?? []) as Array<{ id?: string; name?: string; on?: boolean }>) {
          if (d.name) m.set(String(d.name), { id: String(d.id), on: !!d.on })
        }
        setDishMap(m)
      })
      .catch(() => setDishMap(new Map()))
  }, [routeKey])

  useEffect(() => {
    loadDishMap()
  }, [loadDishMap])

  const pickList = (data: Record<string, unknown>, key: string, nested?: string): Row[] => {
    let cur: unknown = data?.[key]
    if (nested && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      cur = (cur as Record<string, unknown>)[nested]
    }
    return Array.isArray(cur) ? (cur as Row[]) : []
  }

  const load = useCallback(() => {
    if (!cfg) return
    setLoading(true)
    setError(null)
    setHint(null)
    client
      .get(cfg.path)
      .then(async ({ data }) => {
        const raw = data as Record<string, unknown>
        if (raw.hint === 'no_snapshot' || typeof raw.message === 'string') {
          setHint(String(raw.message || '店内快照未接通 · 本页可空开，推送后刷新'))
        }
        let list = pickList(raw, cfg.listKey)
        if ((!Array.isArray(list) || list.length === 0) && cfg.fromSnapshot) {
          try {
            const snap = await fetchSnapshot()
            list = cfg.fromSnapshot(snap)
          } catch {
            /* ignore */
          }
        }
        if (cfg.filterRows) list = cfg.filterRows(list, raw)
        setRows(Array.isArray(list) ? list : [])
        if (cfg.secondary) {
          setSecondaryRows(pickList(raw, cfg.secondary.listKey, cfg.secondary.nestedKey))
        } else {
          setSecondaryRows([])
        }
        if (cfg.tertiary) {
          setTertiaryRows(pickList(raw, cfg.tertiary.listKey, cfg.tertiary.nestedKey))
        } else {
          setTertiaryRows([])
        }
        setRev(data?.rev as string | number | undefined)
      })
      .catch((e) => {
        setRows([])
        setSecondaryRows([])
        setTertiaryRows([])
        const msg = e?.response?.data?.error || e.message || '加载失败'
        if (String(msg).toLowerCase().includes('no snapshot')) {
          setError(null)
          setHint('店内快照未接通 · 本页可空开，推送后刷新')
        } else {
          setError(msg)
        }
      })
      .finally(() => setLoading(false))
  }, [cfg])

  useEffect(() => {
    load()
  }, [load])

  const submitAction = async (a: PageAction, values?: Record<string, unknown>) => {
    setBusy(true)
    try {
      await postAction({
        type: a.type,
        payload: a.build(actionRows, values),
        operator: 'admin',
      })
      message.success(`${a.label}已入队 → 请到审批中心确认`)
      setFormAction(null)
      load()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '提交失败')
    } finally {
      setBusy(false)
    }
  }

  /** 打开真表单；按需预取动态选项（原料 / 菜品） */
  const openForm = (a: PageAction) => {
    writeForm.resetFields()
    setFormAction(a)
    if (a.fields?.some((f) => f.optionsFrom === 'ings')) {
      fetchSnapshot()
        .then((snap) => {
          const ings = (snap.data?.ings ?? []) as Array<{ name?: string; unit?: string }>
          setIngsOpts(
            ings
              .filter((g) => g.name)
              .map((g) => ({
                value: String(g.name),
                label: `${g.name}${g.unit ? ` · ${g.unit}` : ''}`,
              })),
          )
        })
        .catch(() => setIngsOpts([]))
    }
    if (a.fields?.some((f) => f.optionsFrom === 'dishes')) {
      client
        .get('/admin/dishes')
        .then(({ data }) => {
          const items = (data?.items ?? []) as Array<{ name?: string }>
          setDishOpts(
            items.filter((d) => d.name).map((d) => ({ value: String(d.name), label: String(d.name) })),
          )
        })
        .catch(() => setDishOpts([]))
    }
  }

  const fieldOptions = (f: WriteField): Opt[] => {
    if (f.options) return f.options
    if (f.optionsFrom === 'ings') return ingsOpts
    if (f.optionsFrom === 'dishes') return dishOpts
    if (f.optionsFromRows) {
      const seen = new Set<string>()
      const out: Opt[] = []
      for (const r of rows) {
        const v = r[f.optionsFromRows]
        if (v != null && v !== '' && !seen.has(String(v))) {
          seen.add(String(v))
          out.push({ value: String(v), label: String(v) })
        }
      }
      return out
    }
    return []
  }

  const renderField = (f: WriteField) => {
    const common = { placeholder: f.placeholder }
    if (f.type === 'number') {
      return <InputNumber min={f.min} max={f.max} style={{ width: '100%' }} {...common} />
    }
    if (f.type === 'date') {
      return <DatePicker style={{ width: '100%' }} allowClear={false} />
    }
    if (f.type === 'select') {
      const opts = fieldOptions(f)
      /* 动态来源（原料/菜品/设备/员工）允许自由输入 */
      if (f.optionsFrom || f.optionsFromRows) {
        return (
          <AutoComplete
            options={opts}
            filterOption={(input, opt) =>
              String(opt?.label ?? '').toLowerCase().includes(input.toLowerCase())
            }
            {...common}
          />
        )
      }
      return <Select options={opts} {...common} />
    }
    return <Input {...common} />
  }

  /** 矩阵行级动作入队（调价/上下架/标为爆品） */
  const enqueueMatrix = async (type: string, payload: Record<string, unknown>, ok: string) => {
    setBusy(true)
    try {
      await postAction({ type, payload, operator: 'admin' })
      message.success(`${ok}已入队，请到审批中心确认执行`)
      load()
      loadDishMap()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '提交失败')
    } finally {
      setBusy(false)
    }
  }

  const openMatrixPrice = (row: Row) => {
    priceForm.setFieldsValue({ price: row.price, reason: '' })
    setPriceRow(row)
  }

  const columns = useMemo(() => {
    if (!cfg) return []
    const cols = [...cfg.columns]
    if (cfg.rowAction) {
      const ra = cfg.rowAction
      cols.push({
        title: '操作',
        key: '_op',
        width: 110,
        render: (_: unknown, row: Row) => {
          if (ra.visibleWhen && !ra.visibleWhen(row)) return <span>-</span>
          return (
            <Tooltip title={canWrite ? undefined : noWriteTip}>
              <Button
                size="small"
                type="link"
                disabled={!canWrite}
                loading={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await postAction({
                      type: ra.type,
                      payload: ra.build(row),
                      operator: 'admin',
                    })
                    message.success('已入队，请到审批中心确认执行')
                    load()
                  } catch (e: unknown) {
                    const err = e as { response?: { data?: { error?: string } } }
                    message.error(err.response?.data?.error || '提交失败')
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {ra.label}
              </Button>
            </Tooltip>
          )
        },
      })
    }
    return cols
  }, [cfg, busy, load, canWrite])

  /* 矩阵（tertiary）列：ops/analysis 追加行级动作 */
  const tertiaryColumns = useMemo(() => {
    if (!cfg?.tertiary) return []
    const cols = [...cfg.tertiary.columns]
    if (routeKey === 'ops/analysis') {
      cols.push({
        title: '操作',
        key: '_mxop',
        width: 220,
        render: (_: unknown, row: Row) => {
          const dish = dishMap.get(String(row.name ?? ''))
          return (
            <Space size={4} wrap>
              <Tooltip title={canWrite ? undefined : noWriteTip}>
                <Button
                  size="small"
                  type="link"
                  disabled={!canWrite}
                  onClick={() => openMatrixPrice(row)}
                >
                  调价
                </Button>
              </Tooltip>
              <Tooltip
                title={
                  !canWrite
                    ? noWriteTip
                    : dish
                      ? undefined
                      : '菜品库未按名称匹配到该菜，无法上下架'
                }
              >
                <Button
                  size="small"
                  type="link"
                  disabled={!canWrite || !dish}
                  loading={busy}
                  onClick={() =>
                    dish &&
                    enqueueMatrix(
                      'dish.set_active',
                      { id: dish.id, on: !dish.on },
                      dish.on ? `下架 ${row.name}` : `上架 ${row.name}`,
                    )
                  }
                >
                  {dish?.on ? '下架' : '上架'}
                </Button>
              </Tooltip>
              <Tooltip title={canWrite ? 'dish.upsert 改分类为爆品' : noWriteTip}>
                <Button
                  size="small"
                  type="link"
                  disabled={!canWrite}
                  loading={busy}
                  onClick={() =>
                    enqueueMatrix(
                      'dish.upsert',
                      { id: dish?.id, name: row.name, cat: '爆品' },
                      `标为爆品 ${row.name}`,
                    )
                  }
                >
                  标为爆品
                </Button>
              </Tooltip>
            </Space>
          )
        },
      })
    }
    return cols
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, routeKey, dishMap, busy, canWrite])

  if (!cfg) {
    return (
      <Card title="页面">
        <Alert type="warning" showIcon message={`未配置：${routeKey}，请从左侧菜单进入已上线模块`} />
      </Card>
    )
  }

  const actionRows =
    routeKey === 'ops/analysis' && secondaryRows.length > 0 ? secondaryRows : rows

  return (
    <Card
      title={cfg.title}
      extra={
        <Space>
          {rev != null && <Tag color="blue">rev {rev}</Tag>}
          <Button size="small" onClick={load}>
            刷新
          </Button>
        </Space>
      }
    >
      {hint && (
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message={hint} />
      )}
      {error && (
        <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} />
      )}
      {cfg.actions && cfg.actions.length > 0 && (
        <Space wrap style={{ marginBottom: 12 }}>
          {cfg.actions.map((a) => {
            const reason = a.disabledReason?.(actionRows) ?? null
            const disabled = !canWrite || reason != null
            const tip = !canWrite ? noWriteTip : (reason ?? undefined)
            return (
              <Tooltip key={a.type + a.label} title={tip}>
                <Button
                  type="primary"
                  disabled={disabled}
                  loading={busy}
                  onClick={() => {
                    if (a.fields?.length) {
                      openForm(a)
                    } else {
                      submitAction(a)
                    }
                  }}
                >
                  {a.label}
                </Button>
              </Tooltip>
            )
          })}
          <Typography.Text type="secondary">写操作经确认台，不会直连店内库</Typography.Text>
        </Space>
      )}
      <Table
        rowKey={rk}
        loading={loading}
        dataSource={rows}
        columns={columns}
        locale={{ emptyText: cfg.emptyHint || '暂无数据' }}
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
      />
      {cfg.secondary && (
        <div style={{ marginTop: 24 }}>
          <Typography.Title level={5}>{cfg.secondary.title}</Typography.Title>
          <Table
            rowKey={rk}
            loading={loading}
            dataSource={secondaryRows}
            columns={cfg.secondary.columns}
            pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
          />
        </div>
      )}
      {cfg.tertiary && (
        <div style={{ marginTop: 24 }}>
          <Typography.Title level={5}>{cfg.tertiary.title}</Typography.Title>
          <Table
            rowKey={rk}
            loading={loading}
            dataSource={tertiaryRows}
            columns={tertiaryColumns}
            pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
          />
        </div>
      )}
      <Modal
        title={formAction?.label ?? ''}
        open={!!formAction}
        onCancel={() => setFormAction(null)}
        confirmLoading={busy}
        destroyOnHidden
        onOk={async () => {
          const values = await writeForm.validateFields()
          if (formAction) await submitAction(formAction, values)
        }}
      >
        <Form form={writeForm} layout="vertical" preserve={false}>
          {formAction?.fields?.map((f) => (
            <Form.Item
              key={f.name}
              name={f.name}
              label={f.label}
              initialValue={f.initial}
              rules={f.required ? [{ required: true, message: `请填写${f.label}` }] : undefined}
            >
              {renderField(f)}
            </Form.Item>
          ))}
        </Form>
      </Modal>
      <Modal
        title={`调价 · ${String(priceRow?.name ?? '')}`}
        open={!!priceRow}
        onCancel={() => setPriceRow(null)}
        confirmLoading={busy}
        destroyOnHidden
        onOk={async () => {
          const v = await priceForm.validateFields()
          const row = priceRow
          if (!row) return
          const dish = dishMap.get(String(row.name ?? ''))
          await enqueueMatrix(
            'dish.price',
            { id: dish?.id, name: row.name, price: v.price, reason: v.reason },
            `调价 ${row.name} → ¥${v.price}`,
          )
          setPriceRow(null)
        }}
      >
        <Form form={priceForm} layout="vertical" preserve={false}>
          <Form.Item label="当前售价">
            <Input disabled value={priceRow?.price != null ? `¥${priceRow.price}` : '-'} />
          </Form.Item>
          <Form.Item name="price" label="新售价" rules={[{ required: true, message: '请填写新售价' }]}>
            <InputNumber min={0} step={1} style={{ width: '100%' }} addonBefore="¥" />
          </Form.Item>
          <Form.Item name="reason" label="调价原因">
            <Input.TextArea rows={2} placeholder="成本上涨 / 促销 / 象限优化…" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
