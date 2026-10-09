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
  fetchLossRecords,
  fetchLossReports,
  fetchLossInventory,
  fetchLossOverview,
  fetchLossConfig,
  saveLossConfig,
  logLossReport,
  approveLossReport,
  rejectLossReport,
} from '../../api'
import type {
  LossConfigResp,
  LossInventoryResp,
  LossInventoryRow,
  LossOverviewResp,
  LossRecordRow,
  LossRecordsResp,
  LossReportRow,
  LossReportsResp,
} from '../../api/types'
import { useAuthStore } from '../../store/auth'
import { COLORS } from '../../theme'

type LossTab = 'records' | 'reports' | 'inventory'

const DEFAULT_CFG: LossConfigResp['loss'] = {
  loss_rate_warn: 1.0,
  loss_rate_redline: 1.5,
  big_amount: 500,
  top_share_warn: 30,
}

const STATUS_COLOR: Record<string, string> = {
  待审核: COLORS.yellow,
  已审批: COLORS.green,
  已驳回: COLORS.red,
}

function isPending(st: string) { return !/已审|已通过|已批|驳回|作废/.test(String(st)) }

export default function LossPage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const [records, setRecords] = useState<LossRecordsResp | null>(null)
  const [reports, setReports] = useState<LossReportsResp | null>(null)
  const [inventory, setInventory] = useState<LossInventoryResp | null>(null)
  const [overview, setOverview] = useState<LossOverviewResp | null>(null)
  const [cfg, setCfg] = useState<LossConfigResp['loss']>(DEFAULT_CFG)
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<LossTab>('records')
  const [rOpen, setROpen] = useState(false)
  const [rForm] = Form.useForm()
  const [cfgOpen, setCfgOpen] = useState(false)
  const [cfgForm] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      fetchLossRecords(),
      fetchLossReports(),
      fetchLossInventory(),
      fetchLossOverview(),
      fetchLossConfig().catch(() => null),
    ])
      .then(([r, rp, inv, o, cf]) => {
        setRecords(r); setReports(rp); setInventory(inv); setOverview(o)
        if (cf?.loss) setCfg(cf.loss)
        setIsMock(false)
      })
      .catch(() => {
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const recCols: ColumnsType<LossRecordRow> = useMemo(
    () => [
      { title: '日期', dataIndex: 'date', width: 120, render: (v) => v ?? '-' },
      { title: '原料', dataIndex: 'name', width: 150, render: (v) => <strong>{v}</strong> },
      { title: '数量', dataIndex: 'qty', width: 100, align: 'right' },
      { title: '金额', dataIndex: 'amount', width: 110, align: 'right', render: (v) => `¥${v}` },
      { title: '原因', dataIndex: 'reason', width: 120, render: (v) => <Tag color={COLORS.orange}>{v}</Tag> },
    ],
    [],
  )

  const repCols: ColumnsType<LossReportRow> = useMemo(
    () => [
      { title: '日期', dataIndex: 'date', width: 120, render: (v) => v ?? '-' },
      { title: '原料', dataIndex: 'ing_name', width: 140, render: (v) => <strong>{v}</strong> },
      { title: '数量', dataIndex: 'qty', width: 90, align: 'right' },
      { title: '金额', dataIndex: 'amount', width: 110, align: 'right', render: (v) => (v == null ? '-' : <span style={{ color: Number(v) >= cfg.big_amount ? COLORS.red : undefined }}>¥{v}</span>) },
      { title: '原因', dataIndex: 'reason', width: 120, render: (v) => <Tag color={COLORS.orange}>{v}</Tag> },
      { title: '上报人', dataIndex: 'reporter', width: 100, render: (v) => v ?? '-' },
      { title: '状态', dataIndex: 'status', width: 100, render: (v) => <Tag color={STATUS_COLOR[String(v)] ?? COLORS.gray}>{v}</Tag> },
      {
        title: '操作',
        key: 'op',
        width: 150,
        render: (_, r) =>
          isPending(r.status) ? (
            canWrite ? (
              <Space size={4}>
                <Button size="small" type="primary" onClick={() => doApprove(r)}>审批</Button>
                <Button size="small" danger onClick={() => doReject(r)}>驳回</Button>
              </Space>
            ) : <span style={{ color: COLORS.gray }}>只读</span>
          ) : <span style={{ color: COLORS.gray }}>-</span>,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canWrite, cfg.big_amount],
  )

  const invCols: ColumnsType<LossInventoryRow> = useMemo(
    () => [
      { title: '日期', dataIndex: 'date', width: 120, render: (v) => v ?? '-' },
      { title: '原料', dataIndex: 'ing_name', width: 150, render: (v) => <strong>{v}</strong> },
      { title: '账面量', dataIndex: 'book_qty', width: 100, align: 'right', render: (v) => (v == null ? '-' : v) },
      { title: '实盘量', dataIndex: 'actual_qty', width: 100, align: 'right', render: (v) => (v == null ? '-' : v) },
      {
        title: '差异',
        dataIndex: 'diff',
        width: 110,
        align: 'right',
        render: (v) => (Number(v) < 0 ? <Tag color={COLORS.red}>盘亏 {Math.abs(Number(v))}</Tag> : Number(v) > 0 ? <Tag color={COLORS.green}>盘盈 {v}</Tag> : <Tag>平</Tag>),
      },
      { title: '备注', dataIndex: 'note', render: (v) => v ?? '-' },
    ],
    [],
  )

  const run = async (fn: () => Promise<{ ok?: boolean; note?: string; error?: string }>, close: (() => void) | null, okMsg: string) => {
    setBusy(true)
    try {
      const res = await fn()
      if (res.ok) { message.success(res.note || okMsg); if (close) close(); load() }
      else message.error(res.error || '操作失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const submitReport = async () => {
    const v = await rForm.validateFields()
    await run(() => logLossReport({
      date: v.date ? (v.date as Dayjs).format('YYYY-MM-DD') : undefined,
      ing_name: v.ing_name, qty: Number(v.qty), reason: v.reason,
      reporter: v.reporter, amount: v.amount == null ? undefined : Number(v.amount),
    }), () => setROpen(false), '报损登记已入队（待审核）')
  }
  const doApprove = (r: LossReportRow) => {
    const id = r.id
    if (id == null) return
    run(() => approveLossReport({ id }), null, '报损审批已入队（扣库存）')
  }
  const doReject = (r: LossReportRow) => {
    const id = r.id
    if (id == null) return
    run(() => rejectLossReport({ id }), null, '报损驳回已入队')
  }
  const submitCfg = async () => {
    const v = await cfgForm.validateFields()
    setBusy(true)
    try {
      const res = await saveLossConfig({
        loss_rate_warn: Number(v.loss_rate_warn),
        loss_rate_redline: Number(v.loss_rate_redline),
        big_amount: Number(v.big_amount),
        top_share_warn: Number(v.top_share_warn),
      })
      if (res.ok) { setCfg(res.loss); message.success('损耗配置已保存'); setCfgOpen(false); load() }
      else message.error('保存失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '保存失败')
    } finally {
      setBusy(false)
    }
  }
  const openCfg = () => { cfgForm.setFieldsValue({ ...cfg }); setCfgOpen(true) }
  const tip = canWrite ? undefined : '当前角色无写权限，仅可查看'

  const lossRate = overview?.loss.loss_rate_pct
  const ratePct = lossRate == null ? 0 : Math.min(100, Math.round((lossRate / cfg.loss_rate_redline) * 100))

  return (
    <div>
      {isMock && <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="后端 /api/loss 未连通，当前为本地样例数据" />}
      {(overview?.alerts ?? []).slice(0, 4).map((a, i) => (
        <Alert key={i} type={a.level === 'red' ? 'error' : a.level === 'orange' ? 'warning' : 'info'} showIcon style={{ marginBottom: 12 }} message={a.text} />
      ))}

      <Card
        title="损耗 · 归因 / 报损审批 / 盘点差异"
        extra={
          <Space wrap>
            <Tooltip title={tip}><Button disabled={!canWrite} onClick={openCfg}>配置</Button></Tooltip>
            <Tooltip title={tip}><Button type="primary" disabled={!canWrite} onClick={() => { rForm.resetFields(); rForm.setFieldsValue({ date: dayjs(), reason: '过期' }); setROpen(true) }}>报损登记</Button></Tooltip>
            <Button size="small" onClick={load}>刷新</Button>
          </Space>
        }
      >
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={12} md={6}>
            <Card size="small"><Statistic title="损耗金额" value={overview?.loss.total_amount ?? 0} prefix="¥" /></Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="损耗率" value={lossRate ?? 0} suffix="%" valueStyle={{ color: lossRate == null ? COLORS.gray : lossRate > cfg.loss_rate_redline ? COLORS.red : lossRate > cfg.loss_rate_warn ? COLORS.orange : COLORS.green }} />
              <Progress percent={ratePct} showInfo={false} strokeColor={lossRate != null && lossRate > cfg.loss_rate_redline ? COLORS.red : COLORS.green} size="small" />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>红线 {cfg.loss_rate_redline}%</Typography.Text>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small"><Statistic title="待审批报损单" value={overview?.reports.pending ?? 0} valueStyle={{ color: (overview?.reports.big_pending ?? 0) ? COLORS.red : undefined }} /><Typography.Text type="secondary" style={{ fontSize: 12 }}>大额 {overview?.reports.big_pending ?? 0} 张</Typography.Text></Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small"><Statistic title="盘点差异" value={overview?.inventory.diff_count ?? 0} suffix="项" /><Typography.Text type="secondary" style={{ fontSize: 12 }}>盘亏 {overview?.inventory.loss_qty ?? 0} / 盘盈 {overview?.inventory.over_qty ?? 0}</Typography.Text></Card>
          </Col>
        </Row>

        <Tabs
          activeKey={tab}
          onChange={(k) => setTab(k as LossTab)}
          items={[
            {
              key: 'records',
              label: `损耗归因（${records?.rows.length ?? 0}）`,
              children: (
                <>
                  {records && (
                    <Descriptions size="small" column={3} style={{ marginBottom: 12 }}>
                      <Descriptions.Item label="损耗金额">¥{records.total_amount}</Descriptions.Item>
                      <Descriptions.Item label="营收">¥{records.revenue}</Descriptions.Item>
                      <Descriptions.Item label="集中度">{records.top_share_pct == null ? '-' : `${records.top_ingredients[0]?.name ?? ''} ${records.top_share_pct}%`}</Descriptions.Item>
                    </Descriptions>
                  )}
                  {records?.rows.length ? (
                    <Table<LossRecordRow> rowKey={(r) => String(r.id ?? `${r.name}-${r.date}`)} columns={recCols} dataSource={records.rows} loading={loading} pagination={{ pageSize: 12 }} size="small" />
                  ) : <Empty description="暂无损耗流水（data.logs kind=loss）" />}
                </>
              ),
            },
            {
              key: 'reports',
              label: `报损单（${reports?.counts.pending ?? 0} 待审）`,
              children: reports?.rows.length ? (
                <Table<LossReportRow> rowKey={(r) => String(r.id ?? `${r.ing_name}-${r.date}`)} columns={repCols} dataSource={reports.rows} loading={loading} pagination={{ pageSize: 12 }} size="small" />
              ) : <Empty description="暂无报损单" />,
            },
            {
              key: 'inventory',
              label: `盘点差异（${inventory?.diff_count ?? 0}）`,
              children: inventory?.rows.length ? (
                <Table<LossInventoryRow> rowKey={(r) => String(r.id ?? `${r.ing_name}-${r.date}`)} columns={invCols} dataSource={inventory.rows} loading={loading} pagination={false} size="small" />
              ) : <Empty description="暂无盘点差异（仅登记，不改库存）" />,
            },
          ]}
        />

        {(overview?.advice ?? []).length > 0 && (
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>{overview?.advice.join('；')}</Typography.Paragraph>
        )}
      </Card>

      <Modal title="报损登记" open={rOpen} onCancel={() => setROpen(false)} confirmLoading={busy} destroyOnHidden onOk={submitReport}>
        <Form form={rForm} layout="vertical" preserve={false}>
          <Form.Item name="date" label="日期"><DatePicker style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="ing_name" label="原料" rules={[{ required: true, message: '请填写原料' }]}><Input placeholder="如：猪肉 / 白菜" /></Form.Item>
          <Form.Item name="qty" label="数量" rules={[{ required: true, message: '请填写数量' }]}><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="amount" label="金额（元）"><InputNumber style={{ width: '100%' }} min={0} /></Form.Item>
          <Form.Item name="reason" label="原因" rules={[{ required: true }]}>
            <Select options={['过期', '破损', '操作失误', '被盗', '解冻变质', '其他'].map((s) => ({ value: s, label: s }))} />
          </Form.Item>
          <Form.Item name="reporter" label="上报人"><Input placeholder="选填" /></Form.Item>
          <Alert type="info" showIcon message="报损登记入队 loss.report（待审核），审批通过才扣库存。" />
        </Form>
      </Modal>

      <Modal title="损耗配置" open={cfgOpen} onCancel={() => setCfgOpen(false)} confirmLoading={busy} destroyOnHidden onOk={submitCfg}>
        <Form form={cfgForm} layout="vertical" preserve={false}>
          <Form.Item name="loss_rate_warn" label="损耗率预警（%）" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={0} step={0.1} /></Form.Item>
          <Form.Item name="loss_rate_redline" label="损耗率红线（%）" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={0} step={0.1} /></Form.Item>
          <Form.Item name="big_amount" label="大额报损阈值（元）" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={0} /></Form.Item>
          <Form.Item name="top_share_warn" label="集中度告警（%）" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={0} /></Form.Item>
          <Alert type="info" showIcon message="需满足：预警 ≤ 红线；保存即对全店损耗台账生效。" />
        </Form>
      </Modal>
    </div>
  )
}
