import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { Dayjs } from 'dayjs'
import {
  fetchFinanceInvoices,
  fetchFinanceTax,
  fetchFinanceCashflow,
  fetchFinanceSplit,
  fetchFinanceOverview,
  fetchFinanceConfig,
  saveFinanceConfig,
  logFinanceInvoice,
  logFinanceTax,
  logFinanceCash,
  freezeFinanceSplit,
  approveFinanceSplit,
} from '../../api'
import type {
  CashRow,
  FinanceCashflowResp,
  FinanceConfigResp,
  FinanceInvoicesResp,
  FinanceOverviewResp,
  FinanceSplitResp,
  FinanceTaxResp,
  InvoiceRow,
  SplitRow,
  TaxRow,
} from '../../api/types'
import { useAuthStore } from '../../store/auth'
import { COLORS } from '../../theme'

type FinanceTab = 'invoice' | 'tax' | 'cashflow' | 'split'

const DEFAULT_CFG: FinanceConfigResp['finance'] = {
  invoice_quota_monthly: 50000,
  split_frozen_days: 30,
  tax_deadline_day: 15,
}

export default function FinancePage({ defaultTab = 'invoice' }: { defaultTab?: FinanceTab }) {
  const canWrite = useAuthStore((s) => s.canWrite)
  const [invoices, setInvoices] = useState<FinanceInvoicesResp | null>(null)
  const [tax, setTax] = useState<FinanceTaxResp | null>(null)
  const [cashflow, setCashflow] = useState<FinanceCashflowResp | null>(null)
  const [split, setSplit] = useState<FinanceSplitResp | null>(null)
  const [overview, setOverview] = useState<FinanceOverviewResp | null>(null)
  const [cfg, setCfg] = useState<FinanceConfigResp['finance']>(DEFAULT_CFG)
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<FinanceTab>(defaultTab)

  const [invOpen, setInvOpen] = useState(false)
  const [invForm] = Form.useForm()
  const [taxOpen, setTaxOpen] = useState(false)
  const [taxForm] = Form.useForm()
  const [cashOpen, setCashOpen] = useState(false)
  const [cashForm] = Form.useForm()
  const [spOpen, setSpOpen] = useState(false)
  const [spForm] = Form.useForm()
  const [cfgOpen, setCfgOpen] = useState(false)
  const [cfgForm] = Form.useForm()

  useEffect(() => setTab(defaultTab), [defaultTab])

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      fetchFinanceInvoices(),
      fetchFinanceTax(),
      fetchFinanceCashflow(),
      fetchFinanceSplit(),
      fetchFinanceOverview(),
      fetchFinanceConfig().catch(() => null),
    ])
      .then(([i, t, c, s, o, cf]) => {
        setInvoices(i)
        setTax(t)
        setCashflow(c)
        setSplit(s)
        setOverview(o)
        if (cf?.finance) setCfg(cf.finance)
        setIsMock(false)
      })
      .catch(() => {
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const invCols: ColumnsType<InvoiceRow> = useMemo(
    () => [
      { title: '发票号', dataIndex: 'invoice_no', width: 150, render: (v) => v ?? '-' },
      { title: '种类', dataIndex: 'kind', width: 90, render: (v) => <Tag color={COLORS.blue}>{v}</Tag> },
      { title: '方向', dataIndex: 'direction', width: 80, render: (v) => <Tag color={/销/.test(String(v)) ? COLORS.orange : COLORS.green}>{v}</Tag> },
      { title: '金额', dataIndex: 'amount', width: 120, align: 'right', render: (v) => `¥${v}` },
      { title: '税额', dataIndex: 'tax', width: 100, align: 'right', render: (v) => (v == null ? '-' : `¥${v}`) },
      { title: '状态', dataIndex: 'status', width: 100, render: (v) => <Tag>{v}</Tag> },
      { title: '时间', dataIndex: 'ts', width: 120, render: (v) => v ?? '-' },
    ],
    [],
  )

  const taxCols: ColumnsType<TaxRow> = useMemo(
    () => [
      { title: '属期', dataIndex: 'period', width: 100 },
      { title: '税种', dataIndex: 'kind', width: 110, render: (v) => <Tag color={COLORS.purple}>{v}</Tag> },
      { title: '金额', dataIndex: 'amount', width: 120, align: 'right', render: (v) => `¥${v}` },
      {
        title: '状态',
        key: 'status',
        width: 120,
        render: (_, r) => (r.overdue ? <Tag color={COLORS.red}>逾期未申报</Tag> : <Tag color={r.filed ? COLORS.green : COLORS.yellow}>{r.status}</Tag>),
      },
      { title: '申报日', dataIndex: 'filed_at', width: 140, render: (v) => (v ? dayjs(v).format('YYYY-MM-DD') : '-') },
      {
        title: '距截止',
        dataIndex: 'days_left',
        width: 100,
        render: (v, r) => (r.filed ? '-' : v == null ? '-' : v < 0 ? <Tag color={COLORS.red}>逾期 {-v} 天</Tag> : `${v} 天`),
      },
    ],
    [],
  )

  const cashCols: ColumnsType<CashRow> = useMemo(
    () => [
      { title: '时间', dataIndex: 'ts', width: 160, render: (v) => v ?? '-' },
      { title: '类型', dataIndex: 'kind', width: 100, render: (v) => <Tag color={/收入|收|入账|存款/.test(String(v)) ? COLORS.green : COLORS.red}>{v}</Tag> },
      { title: '金额', dataIndex: 'amount', width: 120, align: 'right', render: (v, r) => <span style={{ color: /收入|收|入账|存款/.test(r.kind) ? COLORS.green : COLORS.red }}>{/收入|收|入账|存款/.test(r.kind) ? '+' : '-'}¥{v}</span> },
      { title: '账户', dataIndex: 'account', width: 120 },
      { title: '备注', dataIndex: 'note', render: (v) => v ?? '-' },
    ],
    [],
  )

  const splitCols: ColumnsType<SplitRow> = useMemo(
    () => [
      { title: '账期', dataIndex: 'period', width: 90, render: (v) => v ?? '-' },
      { title: '分账方', dataIndex: 'party', width: 130, render: (v) => <strong>{v}</strong> },
      { title: '金额', dataIndex: 'amount', width: 120, align: 'right', render: (v) => `¥${v}` },
      { title: '比例', dataIndex: 'ratio', width: 80, render: (v) => (v == null ? '-' : `${Math.round(Number(v) * 100)}%`) },
      { title: '冻结至', dataIndex: 'frozen_until', width: 120, render: (v) => v ?? '-' },
      {
        title: '状态',
        key: 'status',
        width: 130,
        render: (_, r) => {
          if (r.can_release) return <Tag color={COLORS.orange}>已到期 · 可解冻</Tag>
          if (r.frozen) return <Tag color={COLORS.blue}>冻结中{r.days_left != null ? `（剩 ${r.days_left} 天）` : ''}</Tag>
          return <Tag color={COLORS.green}>{r.status}</Tag>
        },
      },
      {
        title: '操作',
        key: 'op',
        width: 100,
        render: (_, r) =>
          r.frozen ? (
            canWrite ? (
              <Tooltip title={r.can_release ? undefined : '冻结期内不可划出（防纠纷红线）'}>
                <Button size="small" disabled={!r.can_release} onClick={() => doApprove(r)}>
                  解冻结算
                </Button>
              </Tooltip>
            ) : (
              <span style={{ color: COLORS.gray }}>只读</span>
            )
          ) : (
            <span style={{ color: COLORS.gray }}>-</span>
          ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canWrite],
  )

  const run = async (fn: () => Promise<{ ok?: boolean; action_id?: string; note?: string; error?: string }>, close: () => void, okMsg: string) => {
    setBusy(true)
    try {
      const res = await fn()
      if (res.ok) {
        message.success(res.note || okMsg)
        close()
        load()
      } else message.error(res.error || '操作失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const submitInvoice = async () => {
    const v = await invForm.validateFields()
    await run(() => logFinanceInvoice({
      invoice_no: v.invoice_no || undefined,
      kind: v.kind,
      direction: v.direction,
      amount: Number(v.amount),
      tax: v.tax == null ? undefined : Number(v.tax),
      ts: v.ts ? (v.ts as Dayjs).format('YYYY-MM-DD') : undefined,
    }), () => setInvOpen(false), '开票登记已入队')
  }
  const submitTax = async () => {
    const v = await taxForm.validateFields()
    await run(() => logFinanceTax({
      period: v.period ? (v.period as Dayjs).format('YYYY-MM') : undefined,
      kind: v.kind,
      amount: Number(v.amount),
      status: v.status,
    }), () => setTaxOpen(false), '税务登记已入队')
  }
  const submitCash = async () => {
    const v = await cashForm.validateFields()
    await run(() => logFinanceCash({
      ts: v.ts ? (v.ts as Dayjs).format('YYYY-MM-DD HH:mm') : undefined,
      kind: v.kind,
      amount: Number(v.amount),
      account: v.account,
      note: v.note,
    }), () => setCashOpen(false), '现金流水已入队')
  }
  const submitSplit = async () => {
    const v = await spForm.validateFields()
    await run(() => freezeFinanceSplit({
      period: v.period ? (v.period as Dayjs).format('YYYY-MM') : undefined,
      party: v.party,
      amount: Number(v.amount),
      ratio: v.ratio == null ? undefined : Number(v.ratio),
      frozen_until: v.frozen_until ? (v.frozen_until as Dayjs).format('YYYY-MM-DD') : undefined,
    }), () => setSpOpen(false), '分账冻结已入队')
  }
  const doApprove = (r: SplitRow) => {
    const id = r.id
    if (id == null) return
    run(() => approveFinanceSplit({ id, party: r.party, amount: r.amount, status: '已结算' }), () => undefined, '分账结算已入队')
  }
  const submitCfg = async () => {
    const v = await cfgForm.validateFields()
    setBusy(true)
    try {
      const res = await saveFinanceConfig({
        invoice_quota_monthly: Number(v.invoice_quota_monthly),
        split_frozen_days: Number(v.split_frozen_days),
        tax_deadline_day: Number(v.tax_deadline_day),
      })
      if (res.ok) {
        setCfg(res.finance)
        message.success('财务配置已保存')
        setCfgOpen(false)
        load()
      } else message.error('保存失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const openCfg = () => {
    cfgForm.setFieldsValue({ ...cfg })
    setCfgOpen(true)
  }
  const readOnlyTip = canWrite ? undefined : '当前角色无写权限，仅可查看'

  return (
    <div>
      {isMock && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="后端 /api/finance 未连通，当前为本地样例数据" />
      )}
      {(overview?.alerts ?? []).slice(0, 4).map((a, i) => (
        <Alert key={i} type={a.level === 'red' ? 'error' : a.level === 'orange' ? 'warning' : 'info'} showIcon style={{ marginBottom: 12 }} message={a.text} />
      ))}

      <Card
        title="财务 · 发票 / 税务 / 现金 / 分账"
        extra={
          <Space wrap>
            <Tooltip title={readOnlyTip}><Button disabled={!canWrite} onClick={openCfg}>配置</Button></Tooltip>
            <Tooltip title={readOnlyTip}><Button disabled={!canWrite} onClick={() => { invForm.resetFields(); invForm.setFieldsValue({ kind: '普票', direction: '销项' }); setInvOpen(true) }}>开票登记</Button></Tooltip>
            <Tooltip title={readOnlyTip}><Button disabled={!canWrite} onClick={() => { taxForm.resetFields(); taxForm.setFieldsValue({ kind: '增值税', status: '待申报' }); setTaxOpen(true) }}>税务登记</Button></Tooltip>
            <Tooltip title={readOnlyTip}><Button disabled={!canWrite} onClick={() => { cashForm.resetFields(); cashForm.setFieldsValue({ kind: '支出', account: '门店现金' }); setCashOpen(true) }}>现金流水</Button></Tooltip>
            <Tooltip title={readOnlyTip}><Button type="primary" disabled={!canWrite} onClick={() => { spForm.resetFields(); spForm.setFieldsValue({ party: '合伙人A', ratio: 0.3, frozen_until: dayjs().add(cfg.split_frozen_days, 'day') }); setSpOpen(true) }}>分账冻结</Button></Tooltip>
            <Button size="small" onClick={load}>刷新</Button>
          </Space>
        }
      >
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="本月开票额度" value={overview?.invoices.issued_this_month ?? 0} suffix={`/ ${overview?.invoices.quota ?? 0}`} prefix="¥" valueStyle={{ color: (overview?.invoices.remaining ?? 0) < 0 ? COLORS.red : COLORS.black }} />
              {overview?.invoices.usage_pct != null && <Progress percent={Math.min(100, Math.round(overview.invoices.usage_pct))} size="small" status={(overview.invoices.remaining ?? 0) < 0 ? 'exception' : 'active'} />}
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="待申报税额" value={overview?.tax.payable ?? 0} prefix="¥" valueStyle={{ color: (overview?.tax.overdue ?? 0) ? COLORS.red : COLORS.black }} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{overview?.tax.pending_count ?? 0} 项待申报{(overview?.tax.overdue ?? 0) ? ` · ${overview?.tax.overdue} 项逾期` : ''}</Typography.Text>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="现金流净额" value={overview?.cashflow.net ?? 0} prefix="¥" valueStyle={{ color: (overview?.cashflow.net ?? 0) < 0 ? COLORS.red : COLORS.green }} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>收 ¥{overview?.cashflow.income ?? 0} · 支 ¥{overview?.cashflow.expense ?? 0}</Typography.Text>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="冻结分账" value={overview?.split.frozen_amount ?? 0} prefix="¥" valueStyle={{ color: (overview?.split.releasable ?? 0) ? COLORS.orange : COLORS.black }} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{overview?.split.frozen_count ?? 0} 笔{(overview?.split.releasable ?? 0) ? ` · ${overview?.split.releasable} 笔可解冻` : ''}</Typography.Text>
            </Card>
          </Col>
        </Row>

        <Tabs
          activeKey={tab}
          onChange={(k) => setTab(k as FinanceTab)}
          items={[
            {
              key: 'invoice',
              label: `发票（${invoices?.count ?? 0}）`,
              children: (
                <>
                  {invoices && (
                    <Descriptions size="small" column={4} style={{ marginBottom: 12 }}>
                      <Descriptions.Item label="本月销项">¥{invoices.issued_this_month}</Descriptions.Item>
                      <Descriptions.Item label="月度额度">¥{invoices.quota}</Descriptions.Item>
                      <Descriptions.Item label="剩余">¥{invoices.remaining}</Descriptions.Item>
                      <Descriptions.Item label="使用率">{invoices.usage_pct == null ? '-' : `${invoices.usage_pct}%`}</Descriptions.Item>
                    </Descriptions>
                  )}
                  {invoices?.rows.length ? (
                    <Table<InvoiceRow> rowKey={(r) => String(r.id ?? r.invoice_no)} columns={invCols} dataSource={invoices.rows} loading={loading} pagination={{ pageSize: 12 }} size="small" />
                  ) : (
                    <Empty description="暂无发票记录" />
                  )}
                </>
              ),
            },
            {
              key: 'tax',
              label: `税务（${tax?.pending_count ?? 0} 待申）`,
              children: tax?.rows.length ? (
                <Table<TaxRow> rowKey={(r) => String(r.id ?? `${r.period}-${r.kind}`)} columns={taxCols} dataSource={tax.rows} loading={loading} pagination={false} size="small" />
              ) : (
                <Empty description="暂无税务记录" />
              ),
            },
            {
              key: 'cashflow',
              label: '现金流水',
              children: (
                <>
                  {cashflow && (
                    <Descriptions size="small" column={3} style={{ marginBottom: 12 }}>
                      <Descriptions.Item label="收入">¥{cashflow.income}</Descriptions.Item>
                      <Descriptions.Item label="支出">¥{cashflow.expense}</Descriptions.Item>
                      <Descriptions.Item label="净额"><span style={{ color: cashflow.net < 0 ? COLORS.red : COLORS.green }}>¥{cashflow.net}</span></Descriptions.Item>
                    </Descriptions>
                  )}
                  {cashflow?.rows.length ? (
                    <Table<CashRow> rowKey={(r) => String(r.id ?? `${r.ts}-${r.kind}`)} columns={cashCols} dataSource={cashflow.rows} loading={loading} pagination={{ pageSize: 12 }} size="small" />
                  ) : (
                    <Empty description="暂无现金流水" />
                  )}
                </>
              ),
            },
            {
              key: 'split',
              label: `分账（${split?.frozen_count ?? 0} 冻结）`,
              children: split?.rows.length ? (
                <Table<SplitRow> rowKey={(r) => String(r.id ?? `${r.party}-${r.period}`)} columns={splitCols} dataSource={split.rows} loading={loading} pagination={false} size="small" />
              ) : (
                <Empty description="暂无分账，可冻结一笔" />
              ),
            },
          ]}
        />

        {(overview?.advice ?? []).length > 0 && (
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            {overview?.advice.join('；')}
          </Typography.Paragraph>
        )}
      </Card>

      <Modal title="开票登记" open={invOpen} onCancel={() => setInvOpen(false)} confirmLoading={busy} destroyOnHidden onOk={submitInvoice}>
        <Form form={invForm} layout="vertical" preserve={false}>
          <Form.Item name="invoice_no" label="发票号"><Input placeholder="选填" /></Form.Item>
          <Form.Item name="kind" label="种类" rules={[{ required: true }]}>
            <Select options={['普票', '专票', '电子票'].map((s) => ({ value: s, label: s }))} />
          </Form.Item>
          <Form.Item name="direction" label="方向" rules={[{ required: true }]}>
            <Select options={['销项', '进项'].map((s) => ({ value: s, label: s }))} />
          </Form.Item>
          <Form.Item name="amount" label="金额（元）" rules={[{ required: true, message: '请填写金额' }]}>
            <InputNumber style={{ width: '100%' }} min={0.01} />
          </Form.Item>
          <Form.Item name="tax" label="税额（元）"><InputNumber style={{ width: '100%' }} min={0} /></Form.Item>
          <Form.Item name="ts" label="开票日"><DatePicker style={{ width: '100%' }} /></Form.Item>
          <Alert type="info" showIcon message="开票登记入队 finance.invoice，经审批中心确认才写回。" />
        </Form>
      </Modal>

      <Modal title="税务申报登记" open={taxOpen} onCancel={() => setTaxOpen(false)} confirmLoading={busy} destroyOnHidden onOk={submitTax}>
        <Form form={taxForm} layout="vertical" preserve={false}>
          <Form.Item name="period" label="所属期"><DatePicker picker="month" style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="kind" label="税种" rules={[{ required: true }]}>
            <Select options={['增值税', '所得税', '附加税'].map((s) => ({ value: s, label: s }))} />
          </Form.Item>
          <Form.Item name="amount" label="金额（元）" rules={[{ required: true, message: '请填写金额' }]}>
            <InputNumber style={{ width: '100%' }} min={0} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select options={['待申报', '已申报', '已缴'].map((s) => ({ value: s, label: s }))} />
          </Form.Item>
          <Alert type="info" showIcon message="属期次月 15 日（可配）为申报截止，逾期未申报告警。" />
        </Form>
      </Modal>

      <Modal title="现金流水登记" open={cashOpen} onCancel={() => setCashOpen(false)} confirmLoading={busy} destroyOnHidden onOk={submitCash}>
        <Form form={cashForm} layout="vertical" preserve={false}>
          <Form.Item name="ts" label="时间"><DatePicker showTime style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="kind" label="类型" rules={[{ required: true }]}>
            <Select options={['收入', '支出', '存款', '备用金'].map((s) => ({ value: s, label: s }))} />
          </Form.Item>
          <Form.Item name="amount" label="金额（元）" rules={[{ required: true, message: '请填写金额' }]}>
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="account" label="账户"><Input placeholder="如：门店现金" /></Form.Item>
          <Form.Item name="note" label="备注"><Input /></Form.Item>
        </Form>
      </Modal>

      <Modal title="分账冻结登记" open={spOpen} onCancel={() => setSpOpen(false)} confirmLoading={busy} destroyOnHidden onOk={submitSplit}>
        <Form form={spForm} layout="vertical" preserve={false}>
          <Form.Item name="party" label="分账方" rules={[{ required: true, message: '请填写分账方' }]}>
            <Input placeholder="如：合伙人A / 房东" />
          </Form.Item>
          <Form.Item name="amount" label="金额（元）" rules={[{ required: true, message: '请填写金额' }]}>
            <InputNumber style={{ width: '100%' }} min={0.01} />
          </Form.Item>
          <Form.Item name="ratio" label="比例（0-1）"><InputNumber style={{ width: '100%' }} min={0} max={1} step={0.05} /></Form.Item>
          <Form.Item name="frozen_until" label="冻结至" rules={[{ required: true, message: '请选择冻结截止日' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Alert type="warning" showIcon message="冻结期内该分账金额不可划出（防纠纷红线），到期后方可解冻结算。" />
        </Form>
      </Modal>

      <Modal title="财务配置" open={cfgOpen} onCancel={() => setCfgOpen(false)} confirmLoading={busy} destroyOnHidden onOk={submitCfg}>
        <Form form={cfgForm} layout="vertical" preserve={false}>
          <Form.Item name="invoice_quota_monthly" label="月度销项开票额度（元）" rules={[{ required: true }]}>
            <InputNumber style={{ width: '100%' }} min={0} />
          </Form.Item>
          <Form.Item name="split_frozen_days" label="分账默认冻结天数" rules={[{ required: true }]}>
            <InputNumber style={{ width: '100%' }} min={0} />
          </Form.Item>
          <Form.Item name="tax_deadline_day" label="申报截止日（次月）" rules={[{ required: true }]}>
            <InputNumber style={{ width: '100%' }} min={1} max={28} />
          </Form.Item>
          <Alert type="info" showIcon message="需满足：申报截止日 ≤ 28；保存即对全店财务台账生效。" />
        </Form>
      </Modal>
    </div>
  )
}
