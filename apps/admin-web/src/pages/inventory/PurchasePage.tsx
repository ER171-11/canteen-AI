import { useCallback, useEffect, useMemo, useState } from 'react'
import { rk } from '../../utils/rowKey'
import { allValueOf, fromAll, withAll } from '../../utils/filterAll'
import {
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { Link } from 'react-router-dom'
import dayjs from 'dayjs'
import { fetchSnapshot, postAction } from '../../api'
import type { IngItem, InventoryDoc } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import MockAlert from '../kitchen/components/MockAlert'
import OrderFormModal from './OrderFormModal'
import {
  docDebt,
  docPaid,
  lineAmount,
  orderLineSt,
  orderRecvProg,
  orderSt,
  orderStMeta,
} from './utils'
import { COLORS } from '../../theme'

/** 付款方式枚举（照抄旧版 openGet() 的 select 选项，HTML:2069） */
const PAY_METHODS = ['现金/扫码', '微信', '支付宝', '银行转账', '平台结算', '挂账转销']

/**
 * 把取数失败翻译成「用户能照做」的一句话。
 * 采购单没有独立接口，整页数据都来自 `/api/snapshot/latest` 的 `data.orders`：
 * 连不上 BFF / 服务端还没有快照 / HTTP 报错，三者的处置方式完全不同，不能都说成「暂无数据」。
 */
function describeLoadError(e: unknown): string {
  const err = e as {
    response?: { status?: number; data?: { error?: string } }
    code?: string
  }
  const status = err?.response?.status
  if (status === 404) {
    return '服务端还没有快照（/api/snapshot/latest 返回 404）：店内节点尚未推送数据，请确认 store-node 与 pusher 已启动。'
  }
  if (status === 401) return '登录态已失效（401），请重新登录。'
  if (status) return `接口返回 HTTP ${status}：${err.response?.data?.error || '未知错误'}。`
  if (err?.code === 'ECONNABORTED') return '请求超时：BFF 无响应。'
  return '无法连接 BFF（连接被拒绝）：请在 bff 目录执行 node server.js，或双击 启动测试.cmd 重新拉起后端。'
}

export default function PurchasePage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const [docs, setDocs] = useState<InventoryDoc[]>([])
  const [ings, setIngs] = useState<IngItem[]>([])
  const [supplier, setSupplier] = useState<string>()
  const [statusFilter, setStatusFilter] = useState<string>()
  const [isMock, setIsMock] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)
  const [fromSnapshot, setFromSnapshot] = useState(true)
  /* FP-PO-03/04/05/06/07：采购单行操作（付款 / 结案 / 作废 / 恢复 / 删除） */
  const [busy, setBusy] = useState(false)
  const [payDoc, setPayDoc] = useState<InventoryDoc | null>(null)
  const [payAmt, setPayAmt] = useState(0)
  const [payDate, setPayDate] = useState(dayjs().format('YYYY-MM-DD'))
  const [payMethod, setPayMethod] = useState(PAY_METHODS[0])
  /* FP-PO-01/02：新建/编辑采购单，走 po.create / po.edit 审批队列，不直写库 */
  const [orderOpen, setOrderOpen] = useState(false)
  const [editDoc, setEditDoc] = useState<InventoryDoc | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const loadDocs = useCallback(() => {
    setLoading(true)
    fetchSnapshot()
      .then((snap) => {
        setIngs(snap.data?.ings ?? [])
        setLoadError('')
        const orders = snap.data?.orders
        if (Array.isArray(orders)) {
          setDocs(orders)
          setFromSnapshot(true)
          setIsMock(false)
        } else {
          setDocs([])
          setFromSnapshot(true)
        }
      })
      .catch((e: unknown) => {
        setDocs([])
        setFromSnapshot(false)
        setIsMock(true)
        setLoadError(describeLoadError(e))
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadDocs()
  }, [loadDocs])

  /**
   * 提交一个采购单行操作 → `/api/actions` 审批队列（本地不直改，等审批执行后刷新快照）。
   * type: order.pay / order.close / order.void / order.restore / order.delete
   */
  const submitOrderAction = async (
    type: string,
    doc: InventoryDoc,
    payload: Record<string, unknown>,
    okMsg: string,
  ) => {
    setBusy(true)
    try {
      await postAction({ type, payload: { order_id: doc.id ?? doc.no, ...payload }, operator: 'admin' })
      message.success(`${okMsg} → 请到审批中心确认执行`)
      setPayDoc(null)
      loadDocs()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '提交失败')
    } finally {
      setBusy(false)
    }
  }

  const openPay = (doc: InventoryDoc) => {
    setPayDoc(doc)
    setPayAmt(docDebt(doc))
    setPayDate(dayjs().format('YYYY-MM-DD'))
    setPayMethod(PAY_METHODS[0])
  }

  const submitPay = () => {
    if (!payDoc) return Promise.resolve()
    return submitOrderAction(
      'order.pay',
      payDoc,
      { amount: payAmt, date: payDate, method: payMethod },
      '付款登记已提交',
    )
  }

  const ingName = useMemo(() => {
    const m = new Map(ings.map((g) => [g.id, g.name]))
    return (id: string) => m.get(id) ?? id ?? '?'
  }, [ings])

  const suppliers = useMemo(
    () => [...new Set(docs.map((d) => d.supplier).filter(Boolean))] as string[],
    [docs],
  )

  const filtered = useMemo(
    () =>
      docs
        .filter((d) => !supplier || d.supplier === supplier)
        /* FP-PO-14 状态筛选（对齐旧版 renderOrders() :1790-1793）：open=进行中（收货中+草稿） */
        .filter((d) => {
          if (!statusFilter) return true
          const st = orderSt(d)
          return statusFilter === 'open' ? st === 'normal' || st === 'draft' : st === statusFilter
        })
        .sort((a, b) => String(b.date).localeCompare(String(a.date))),
    [docs, supplier, statusFilter],
  )

  /**
   * FP-PO-15 顶部汇总卡。口径对齐旧版 renderOrderKpi()（旧 HTML:1777-1786）：
   *   累计下单 = Σ payable；已预付 = Σ recvPaid；待付供应商 = 累计下单 − 已预付
   *   「本月下单金额」= 近 30 天（date ≥ today−29，含今日，非自然月）
   * 注意：用全部 docs，不随供应商/状态筛选变化（与旧版一致）。
   */
  const kpi = useMemo(() => {
    const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
    const pay = r2(docs.reduce((a, d) => a + (Number(d.payable) || 0), 0))
    const got = r2(docs.reduce((a, d) => a + docPaid(d), 0))
    const cutoff = dayjs().subtract(29, 'day').format('YYYY-MM-DD')
    const mPay = r2(
      docs
        .filter((d) => String(d.date ?? '') >= cutoff)
        .reduce((a, d) => a + (Number(d.payable) || 0), 0),
    )
    return { monthPayable: mPay, totalPayable: pay, totalPaid: got, debt: r2(pay - got) }
  }, [docs])

  const columns: ColumnsType<InventoryDoc> = [
    { title: '单号', dataIndex: 'no', width: 150, render: (v) => v ?? '-' },
    { title: '日期', dataIndex: 'date', width: 110 },
    { title: '供应商', dataIndex: 'supplier', width: 140, ellipsis: true },
    {
      /* FP-PO-10 明细行级：已收 x / 未收 / 行作废（对齐旧版 renderOrders() :1799-1804） */
      title: '明细',
      key: 'lines',
      render: (_, r) => {
        const lines = r.lines ?? []
        if (!lines.length) return '-'
        return (
          <div>
            {lines.map((l, i) => {
              const name = ingName(String(l.ing ?? ''))
              const amt = lineAmount(l)
              const got = Number(l.recvQty) || 0
              const ls = orderLineSt(l)
              return (
                <div key={i} style={{ margin: '2px 0' }}>
                  {name} {l.qty ?? 0} × ¥{l.price ?? 0} = ¥{amt}元{' '}
                  {got > 0.001 ? (
                    <b style={{ color: COLORS.green }}>已收 {got}</b>
                  ) : (
                    <span style={{ color: COLORS.gray }}>未收</span>
                  )}
                  {ls === 'canceled' && (
                    <Tag color={COLORS.gray} style={{ marginLeft: 4 }}>
                      行作废
                    </Tag>
                  )}
                </div>
              )
            })}
          </div>
        )
      },
    },
    {
      title: '应付',
      dataIndex: 'payable',
      width: 100,
      align: 'right',
      render: (v) => (v == null ? '-' : `¥${v}`),
    },
    {
      title: '已付',
      key: 'paid',
      width: 100,
      align: 'right',
      render: (_, r) => `¥${docPaid(r)}`,
    },
    {
      title: '欠款',
      key: 'debt',
      width: 90,
      align: 'right',
      render: (_, r) => {
        const d = docDebt(r)
        return d > 0.01 ? <span style={{ color: COLORS.red }}>¥{d}</span> : '—'
      },
    },
    {
      /* FP-PO-11 收货进度（对齐旧版 orderRecvProg()，g 上限封顶 qty） */
      title: '收货进度',
      key: 'recv',
      width: 120,
      render: (_, r) => {
        if (!(r.lines ?? []).length) return '-'
        const pg = orderRecvProg(r)
        return (
          <span>
            {pg.g}/{pg.q} · {pg.pct}%
          </span>
        )
      },
    },
    {
      /* FP-PO-12 状态标签（对齐旧版 orderStTag()） */
      title: '状态',
      key: 'status',
      width: 90,
      render: (_, r) => {
        const meta = orderStMeta(orderSt(r))
        return <Tag color={meta.color}>{meta.text}</Tag>
      },
    },
    {
      title: '结算',
      key: 'settle',
      width: 90,
      render: (_, r) =>
        docDebt(r) > 0.01 ? (
          <Tag color={COLORS.yellow}>有欠款</Tag>
        ) : (
          <Tag color={COLORS.green}>已结清</Tag>
        ),
    },
    {
      /* FP-PO-02/03/04/05/06/07 行操作（对齐旧版 renderOrders() 行内按钮，HTML:1812-1817）：
         编辑 / 付款（有欠款时）/ 恢复或结案 / 作废（非作废时）/ 删除 */
      title: '操作',
      key: 'ops',
      width: 290,
      fixed: 'right',
      render: (_, r) => {
        const st = orderSt(r)
        const debt = docDebt(r)
        const no = r.no ?? r.id ?? ''
        return (
          <Space size={2} wrap>
            {/* FP-PO-02 编辑：走 po.edit 审批队列，不直写库 */}
            <Button
              size="small"
              type="link"
              disabled={busy || !canWrite || isMock}
              onClick={() => {
                setEditDoc(r)
                setEditOpen(true)
              }}
            >
              编辑
            </Button>
            {debt > 0.01 && (
              <Button size="small" type="link" disabled={busy} onClick={() => openPay(r)}>
                付款
              </Button>
            )}
            {st === 'void' || st === 'closed' ? (
              <Popconfirm
                title={`恢复采购单 ${no} 为「收货中」？`}
                onConfirm={() => submitOrderAction('order.restore', r, {}, '采购单已恢复')}
              >
                <Button size="small" type="link" loading={busy}>
                  恢复
                </Button>
              </Popconfirm>
            ) : (
              <Popconfirm
                title={`结案采购单 ${no}？`}
                description="结案后该单不再计入「未结案采购量」（库存与均价不受影响）。"
                onConfirm={() => submitOrderAction('order.close', r, {}, '采购单已结案')}
              >
                <Button size="small" type="link" loading={busy}>
                  结案
                </Button>
              </Popconfirm>
            )}
            {st !== 'void' && (
              <Popconfirm
                title={`作废采购单 ${no}？`}
                description="作废后不计入未结案采购量，已登记的进货单与库存不受影响。"
                onConfirm={() => submitOrderAction('order.void', r, {}, '采购单已作废')}
              >
                <Button size="small" type="link" danger loading={busy}>
                  作废
                </Button>
              </Popconfirm>
            )}
            <Popconfirm
              title={`删除采购单 ${no}？`}
              description="该单据不参与库存计算，删除不影响库存与均价。"
              onConfirm={() => submitOrderAction('order.delete', r, {}, '采购单已删除')}
            >
              <Button size="small" type="link" danger loading={busy}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        )
      },
    },
  ]

  /* 取数失败（≠ 店里没有采购单）：与「真空态」分开渲染，避免把后端不可用误读成没单据 */
  const failed = isMock && !loading
  const empty =
    fromSnapshot && !isMock && docs.length === 0 && !loading

  return (
    <div>
      {isMock && (
        <MockAlert
          endpoint="/api/snapshot/latest · data.orders"
          detail={loadError}
          onRetry={loadDocs}
        />
      )}
      {/* FP-PO-15 顶部汇总卡（口径同旧版 renderOrderKpi()，「本月」= 近 30 天） */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card>
            <Statistic
              title="本月下单金额"
              prefix="¥"
              value={kpi.monthPayable}
              suffix={<span style={{ fontSize: 12 }}>（近30天）</span>}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="累计下单" prefix="¥" value={kpi.totalPayable} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="已预付" prefix="¥" value={kpi.totalPaid} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="待付供应商"
              prefix="¥"
              value={kpi.debt}
              valueStyle={{ color: kpi.debt > 0.01 ? COLORS.red : COLORS.green }}
            />
          </Card>
        </Col>
      </Row>
      <Card
        title="采购单（CG）"
        extra={
          <Space>
            {/* 有筛选时给出「筛选后 / 全部」两个数：避免把筛选态误读成「列表少了几条」 */}
            <span>
              共 {filtered.length}
              {supplier || statusFilter ? ` / ${docs.length}` : ''} 张
            </span>
            {/* 首项固定「全部…」：不筛选=看全部单据，且随时一键退回全部（避免选过之后找不到回全量的入口） */}
            <Select
              allowClear
              placeholder="供应商"
              style={{ width: 160 }}
              options={withAll(
                suppliers.map((s) => ({ value: s, label: s })),
                '全部供应商',
              )}
              value={allValueOf(supplier)}
              onChange={(v) => setSupplier(fromAll<string>(v))}
            />
            {/* FP-PO-14 状态筛选（进行中/已结案/已作废） */}
            <Select
              allowClear
              placeholder="状态"
              style={{ width: 120 }}
              options={withAll(
                [
                  { value: 'open', label: '进行中' },
                  { value: 'closed', label: '已结案' },
                  { value: 'void', label: '已作废' },
                ],
                '全部状态',
              )}
              value={allValueOf(statusFilter)}
              onChange={(v) => setStatusFilter(fromAll<string>(v))}
            />
            {/* FP-PO-01 新建采购单：只投 po.create 建议动作，确认前不改账面 */}
            <Tooltip title={canWrite ? undefined : '当前角色无写权限，仅可查看'}>
              <Button
                type="primary"
                disabled={!canWrite || isMock}
                onClick={() => setOrderOpen(true)}
              >
                新建采购单
              </Button>
            </Tooltip>
          </Space>
        }
      >
        {failed ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span>
                未能读取采购单（接口不可用，原因见页顶提示）；此空表不代表店里没有单据，
                后端恢复后点页顶「重试」重新取数。
              </span>
            }
          />
        ) : empty ? (
          <Empty
            description={
              <span>
                暂无采购单。点右上角「新建采购单」向供应商下单，或先到{' '}
                <Link to="/inventory/restock">补货建议</Link> 勾选后转采购单。
              </span>
            }
          />
        ) : (
          <Table<InventoryDoc>
            rowKey={rk}
            columns={columns}
            dataSource={filtered}
            loading={loading}
            pagination={{ pageSize: 15 }}
            scroll={{ x: 1400 }}
            rowClassName={(r) => (docDebt(r) > 0.01 ? 'ant-table-row-warning' : '')}
            onRow={(r) => (orderSt(r) === 'void' ? { style: { opacity: 0.6 } } : {})}
          />
        )}
      </Card>

      {/* FP-PO-03 付款/补付登记（对齐旧版 openGet('O')，HTML:2055-2080） */}
      <Modal
        title={`登记付款 · ${payDoc?.no ?? ''}`}
        open={!!payDoc}
        onCancel={() => setPayDoc(null)}
        onOk={submitPay}
        confirmLoading={busy}
        okText="确认"
      >
        {payDoc && (
          <div style={{ lineHeight: 2.1 }}>
            应付 ¥{payDoc.payable ?? 0} · 已付 ¥{docPaid(payDoc)} · 欠{' '}
            <span style={{ color: COLORS.red }}>¥{docDebt(payDoc)}</span>
            <div style={{ marginTop: 8 }}>本次付款金额</div>
            <InputNumber
              min={0}
              max={docDebt(payDoc) + 0.01}
              step={0.01}
              style={{ width: '100%' }}
              value={payAmt}
              onChange={(v) => setPayAmt(Number(v) || 0)}
            />
            <div style={{ marginTop: 8 }}>日期</div>
            <DatePicker
              style={{ width: '100%' }}
              value={dayjs(payDate)}
              onChange={(d) => setPayDate(d ? d.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'))}
            />
            <div style={{ marginTop: 8 }}>方式</div>
            <Select
              style={{ width: '100%' }}
              value={payMethod}
              onChange={setPayMethod}
              options={PAY_METHODS.map((m) => ({ value: m, label: m }))}
            />
          </div>
        )}
      </Modal>

      {/* FP-PO-01 新建采购单（对齐旧版 openOrder，HTML:1670-1674）：入队后刷新列表 */}
      <OrderFormModal
        open={orderOpen}
        ings={ings}
        suppliers={suppliers}
        onClose={() => setOrderOpen(false)}
        onQueued={loadDocs}
      />

      {/* FP-PO-02 编辑采购单：走 po.edit 审批队列，入队后刷新列表 */}
      <OrderFormModal
        open={editOpen}
        editDoc={editDoc}
        ings={ings}
        suppliers={suppliers}
        onClose={() => {
          setEditOpen(false)
          setEditDoc(null)
        }}
        onQueued={loadDocs}
      />
    </div>
  )
}
