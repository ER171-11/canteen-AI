import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { client } from '../api/client'
import { postAction, fetchSnapshot } from '../api'

type Row = Record<string, unknown>

type PageCfg = {
  title: string
  path: string
  listKey: string
  columns: ColumnsType<Row>
  /** 页面级写操作 */
  actions?: Array<{
    label: string
    type: string
    build: (rows: Row[]) => Record<string, unknown>
    summary: (rows: Row[]) => string
  }>
  /** 行级写操作 */
  rowAction?: {
    label: string
    type: string
    build: (row: Row) => Record<string, unknown>
    summary: (row: Row) => string
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
        summary: () => '确认今日外卖对账',
        build: () => ({ platform: '美团', status: '已对账', note: 'admin 对账' }),
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
        build: (rows) => ({
          platform: String(rows[0]?.platform || '美团'),
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
        build: (rows) => ({
          campaign_type: '生日礼',
          value: 30,
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
        summary: () => '登记今日早班',
        build: () => ({
          staff_id: 'admin',
          staff_name: '管理员',
          shift: '早班',
          role: '店长',
        }),
      },
      {
        label: '补打卡',
        type: 'staff.clock',
        summary: () => '补录上班打卡',
        build: () => ({ staff_id: 'admin', kind: '上班', status: '补录' }),
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
        summary: (rows) => {
          const fc = rows as Row[]
          return fc.length
            ? `按预测备货 ${fc.length} 项转采购草稿`
            : '按分析生成补货草稿'
        },
        build: (rows) => {
          const items =
            rows.length > 0 && rows[0]?.name
              ? rows.map((r) => ({
                  name: r.name,
                  qty: r.qty ?? r.opt ?? 10,
                  price: r.amount ?? 28,
                }))
              : [{ name: '猪肉馅', qty: 10, price: 28 }]
          return {
            supplier: '分析建议',
            note: '管理端经营分析一键转补货（同源 App forecast）',
            items,
          }
        },
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
        summary: () => '报损面粉 1kg',
        build: () => ({
          name: '面粉',
          ing_name: '面粉',
          qty: 1,
          reason: '受潮',
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
        summary: () => '午餐留样 125g',
        build: () => ({
          meal: '午餐',
          dish: '五福饺',
          weight_g: 125,
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
        summary: () => '冷藏柜巡检',
        build: () => ({
          device: '冷藏柜-1',
          kind: '巡检',
          operator: 'admin',
          note: '后台登记',
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
        summary: () => '冻结合伙人分账',
        build: () => ({
          party: '合伙人',
          amount: 5000,
          ratio: 0.3,
          frozen_until: '2099-12-31',
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
  const [rows, setRows] = useState<Row[]>([])
  const [secondaryRows, setSecondaryRows] = useState<Row[]>([])
  const [tertiaryRows, setTertiaryRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [rev, setRev] = useState<string | number | undefined>()
  const [busy, setBusy] = useState(false)

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

  const columns = useMemo(() => {
    if (!cfg) return []
    const cols = [...cfg.columns]
    if (cfg.rowAction) {
      cols.push({
        title: '操作',
        key: '_op',
        width: 110,
        render: (_: unknown, row: Row) => (
          <Button
            size="small"
            type="link"
            loading={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await postAction({
                  type: cfg.rowAction!.type,
                  payload: cfg.rowAction!.build(row),
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
            {cfg.rowAction!.label}
          </Button>
        ),
      })
    }
    return cols
  }, [cfg, busy, load])

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
          {cfg.actions.map((a) => (
            <Button
              key={a.type + a.label}
              type="primary"
              loading={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await postAction({
                    type: a.type,
                    payload: a.build(actionRows),
                    operator: 'admin',
                  })
                  message.success(`${a.label}已入队 → 请到审批中心确认`)
                  load()
                } catch (e: unknown) {
                  const err = e as { response?: { data?: { error?: string } } }
                  message.error(err.response?.data?.error || '提交失败')
                } finally {
                  setBusy(false)
                }
              }}
            >
              {a.label}
            </Button>
          ))}
          <Typography.Text type="secondary">写操作经确认台，不会直连店内库</Typography.Text>
        </Space>
      )}
      <Table
        rowKey={(r, i) => String(r.id ?? r.member_id ?? r.code ?? r.trace_id ?? r.device ?? i)}
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
            rowKey={(r, i) => String(r.id ?? r.name ?? i)}
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
            rowKey={(r, i) => String(r.id ?? r.name ?? i)}
            loading={loading}
            dataSource={tertiaryRows}
            columns={cfg.tertiary.columns}
            pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
          />
        </div>
      )}
    </Card>
  )
}
