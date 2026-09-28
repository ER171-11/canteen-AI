import { useCallback, useEffect, useMemo, useState } from 'react'
import { rk } from '../../utils/rowKey'
import {
  Button,
  Card,
  DatePicker,
  Drawer,
  Empty,
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
import dayjs, { Dayjs } from 'dayjs'
import {
  fetchAcceptStandards,
  fetchRecvAccept,
  fetchSnapshot,
  postAction,
} from '../../api'
import type {
  AcceptStandard,
  IngItem,
  InventoryDoc,
  RecvAcceptRecord,
} from '../../api/types'
import { useAuthStore } from '../../store/auth'
import MockAlert from '../kitchen/components/MockAlert'
import { MOCK_RECV } from './mock'
import { docDebt, docPaid, formatLinesSummary } from './utils'
import { COLORS } from '../../theme'

function asDoc(r: unknown): InventoryDoc | null {
  if (!r || typeof r !== 'object') return null
  const d = r as InventoryDoc
  if (d.no || d.supplier || d.lines) return d
  return null
}

function docKey(d: InventoryDoc): string {
  return String(d.id ?? d.no ?? '')
}

/** pass/warn/fail 及中文 → Tag 色 */
function verdictMeta(v?: string): { color: string; text: string } | null {
  if (!v) return null
  const s = String(v).trim().toLowerCase()
  if (s === 'pass' || s === '合格' || s === 'ok' || s === '通过') {
    return { color: COLORS.green, text: v === 'pass' ? '合格' : String(v) }
  }
  if (s === 'warn' || s === '让步' || s === 'warning' || s === '有瑕疵') {
    return { color: COLORS.yellow, text: v === 'warn' ? '让步' : String(v) }
  }
  if (s === 'fail' || s === '拒收' || s === '不合格' || s === 'reject') {
    return { color: COLORS.red, text: v === 'fail' ? '拒收' : String(v) }
  }
  return { color: 'default', text: String(v) }
}

/** 按单据聚合验收结论：优先最差（fail > warn > pass） */
function worstVerdict(records: RecvAcceptRecord[]): string | undefined {
  if (!records.length) return undefined
  const rank = (v?: string) => {
    const s = String(v || '').toLowerCase()
    if (s === 'fail' || s.includes('拒') || s.includes('不合格')) return 3
    if (s === 'warn' || s.includes('让步') || s.includes('瑕')) return 2
    if (s === 'pass' || s.includes('合格') || s === 'ok') return 1
    return 0
  }
  return [...records].sort((a, b) => rank(b.verdict) - rank(a.verdict))[0]?.verdict
}

export default function InboundPage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const account = useAuthStore((s) => s.account)
  const role = useAuthStore((s) => s.role)

  const [docs, setDocs] = useState<InventoryDoc[]>([])
  const [ings, setIngs] = useState<IngItem[]>([])
  const [accepts, setAccepts] = useState<RecvAcceptRecord[]>([])
  const [standards, setStandards] = useState<AcceptStandard[]>([])
  const [supplier, setSupplier] = useState<string>()
  const [acceptDate, setAcceptDate] = useState<Dayjs>(dayjs())
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [drawerDoc, setDrawerDoc] = useState<InventoryDoc | null>(null)
  const [acceptOpen, setAcceptOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm()

  const load = useCallback((d: Dayjs) => {
    setLoading(true)
    const ds = d.format('YYYY-MM-DD')
    Promise.all([
      fetchSnapshot()
        .then((snap) => {
          setIngs(snap.data?.ings ?? [])
          const raw = snap.data?.recv ?? []
          const list = raw.map(asDoc).filter(Boolean) as InventoryDoc[]
          setDocs(list)
          setIsMock(false)
        })
        .catch(() => {
          setDocs(MOCK_RECV)
          setIsMock(true)
        }),
      fetchRecvAccept(ds)
        .then((items) => setAccepts(items ?? []))
        .catch(() => setAccepts([])),
      fetchAcceptStandards()
        .then((r) => setStandards(r.standards ?? []))
        .catch(() => setStandards([])),
    ]).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load(acceptDate)
  }, [acceptDate, load])

  const ingName = useMemo(() => {
    const m = new Map(ings.map((g) => [g.id, g.name]))
    return (id: string) => m.get(id) ?? id ?? '?'
  }, [ings])

  const acceptsByRecv = useMemo(() => {
    const m = new Map<string, RecvAcceptRecord[]>()
    for (const a of accepts) {
      const key = String(a.recv_id ?? '')
      if (!key) continue
      const list = m.get(key) ?? []
      list.push(a)
      m.set(key, list)
    }
    return m
  }, [accepts])

  const standardByName = useMemo(() => {
    const m = new Map<string, AcceptStandard>()
    for (const s of standards) {
      if (s.ing_name) m.set(s.ing_name.replace(/\s+/g, ''), s)
    }
    return m
  }, [standards])

  const suppliers = useMemo(
    () => [...new Set(docs.map((d) => d.supplier).filter(Boolean))] as string[],
    [docs],
  )

  const filtered = useMemo(
    () =>
      docs
        .filter((d) => !supplier || d.supplier === supplier)
        .sort((a, b) => String(b.date).localeCompare(String(a.date))),
    [docs, supplier],
  )

  const drawerAccepts = useMemo(() => {
    if (!drawerDoc) return []
    const key = docKey(drawerDoc)
    const byId = acceptsByRecv.get(key) ?? []
    if (byId.length) return byId
    // 按原料名兜底关联（无 recv_id 时）
    const names = new Set(
      (drawerDoc.lines ?? []).map((l) => String(ingName(String(l.ing ?? l.name ?? '')))),
    )
    return accepts.filter((a) => a.ing_name && names.has(String(a.ing_name)))
  }, [drawerDoc, acceptsByRecv, accepts, ingName])

  const openAcceptModal = (doc?: InventoryDoc) => {
    form.resetFields()
    const firstLine = doc?.lines?.[0]
    const name = firstLine
      ? ingName(String(firstLine.ing ?? firstLine.name ?? ''))
      : undefined
    form.setFieldsValue({
      recv_id: doc ? docKey(doc) : undefined,
      ing_name: name && name !== '?' ? name : undefined,
      qty_received: firstLine?.recvQty ?? firstLine?.qty,
      qty_ordered: firstLine?.qty,
      verdict: 'pass',
    })
    setAcceptOpen(true)
  }

  const columns: ColumnsType<InventoryDoc> = [
    { title: '单号', dataIndex: 'no', width: 150, render: (v) => v ?? '-' },
    { title: '日期', dataIndex: 'date', width: 110 },
    { title: '供应商', dataIndex: 'supplier', width: 140, ellipsis: true },
    {
      title: '明细',
      key: 'lines',
      ellipsis: true,
      render: (_, r) => formatLinesSummary(r.lines, ingName),
    },
    {
      title: '验收结论',
      key: 'accept',
      width: 120,
      render: (_, r) => {
        const recs = acceptsByRecv.get(docKey(r)) ?? []
        const v = worstVerdict(recs)
        const meta = verdictMeta(v)
        if (!meta) {
          return (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              未验收
            </Typography.Text>
          )
        }
        return (
          <Space size={4}>
            <Tag color={meta.color}>{meta.text}</Tag>
            {recs.length > 1 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {recs.length}项
              </Typography.Text>
            )}
          </Space>
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
      title: '实付',
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
      title: '操作',
      key: 'ops',
      width: 140,
      fixed: 'right',
      render: (_, r) => (
        <Space size={0}>
          <Button type="link" size="small" onClick={() => setDrawerDoc(r)}>
            验收明细
          </Button>
          {canWrite && !isMock && (
            <Button type="link" size="small" onClick={() => openAcceptModal(r)}>
              补录
            </Button>
          )}
        </Space>
      ),
    },
  ]

  const acceptCols: ColumnsType<RecvAcceptRecord> = [
    { title: '原料', dataIndex: 'ing_name', render: (v) => v ?? '-' },
    {
      title: '标准规格',
      key: 'spec',
      width: 140,
      ellipsis: true,
      render: (_, r) => {
        const k = String(r.ing_name ?? '').replace(/\s+/g, '')
        return standardByName.get(k)?.spec_req || '-'
      },
    },
    {
      title: '订/收/拒',
      key: 'qty',
      width: 120,
      render: (_, r) =>
        `${r.qty_ordered ?? '-'} / ${r.qty_received ?? '-'} / ${r.qty_rejected ?? 0}`,
    },
    {
      title: '结论',
      dataIndex: 'verdict',
      width: 90,
      render: (v) => {
        const m = verdictMeta(v)
        return m ? <Tag color={m.color}>{m.text}</Tag> : '-'
      },
    },
    {
      title: '批次/证号',
      key: 'batch',
      width: 140,
      ellipsis: true,
      render: (_, r) => [r.batch_no, r.cert_no].filter(Boolean).join(' · ') || '-',
    },
    {
      title: '时间',
      dataIndex: 'ts',
      width: 160,
      render: (v) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-'),
    },
  ]

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/snapshot/latest · data.recv" />}
      <Card
        title="进货入库（JH 进货单）"
        extra={
          <Space wrap>
            <span>共 {filtered.length} 张</span>
            <DatePicker
              value={acceptDate}
              allowClear={false}
              onChange={(d) => d && setAcceptDate(d)}
              title="验收记录日期"
            />
            <Select
              allowClear
              placeholder="供应商"
              style={{ width: 160 }}
              options={suppliers.map((s) => ({ value: s, label: s }))}
              value={supplier}
              onChange={setSupplier}
            />
            <Tooltip title={canWrite ? undefined : '当前角色无写权限，仅可查看'}>
              <Button
                type="primary"
                disabled={!canWrite || isMock}
                onClick={() => openAcceptModal()}
              >
                补录验收
              </Button>
            </Tooltip>
          </Space>
        }
      >
        {filtered.length === 0 && !loading ? (
          <Empty description="暂无进货单，货到了请在店内系统或后续审批流新建 JH 进货单" />
        ) : (
          <Table<InventoryDoc>
            rowKey={rk}
            columns={columns}
            dataSource={filtered}
            loading={loading}
            pagination={{ pageSize: 15 }}
            scroll={{ x: 1100 }}
            rowClassName={(r) => (docDebt(r) > 0.01 ? 'ant-table-row-warning' : '')}
          />
        )}
      </Card>

      <Drawer
        title={
          drawerDoc
            ? `验收明细 · ${drawerDoc.no ?? drawerDoc.id ?? ''}`
            : '验收明细'
        }
        open={!!drawerDoc}
        onClose={() => setDrawerDoc(null)}
        width={720}
      >
        {drawerAccepts.length === 0 ? (
          <Empty description="该单暂无逐项验收记录" />
        ) : (
          <Table<RecvAcceptRecord>
            rowKey={rk}
            size="small"
            columns={acceptCols}
            dataSource={drawerAccepts}
            pagination={false}
          />
        )}
        {standards.length > 0 && drawerDoc?.lines?.length ? (
          <div style={{ marginTop: 16 }}>
            <Typography.Text type="secondary">对照验收标准（有匹配才显示）</Typography.Text>
            <Table
              size="small"
              style={{ marginTop: 8 }}
              pagination={false}
              rowKey="ing_name"
              dataSource={(drawerDoc.lines ?? [])
                .map((l) => {
                  const name = ingName(String(l.ing ?? l.name ?? ''))
                  const std = standardByName.get(name.replace(/\s+/g, ''))
                  return std ? { ...std, _lineName: name } : null
                })
                .filter(Boolean) as Array<AcceptStandard & { _lineName: string }>}
              columns={[
                { title: '原料', dataIndex: '_lineName' },
                { title: '规格', dataIndex: 'spec_req', render: (v) => v ?? '-' },
                { title: '感官', dataIndex: 'sensory', ellipsis: true, render: (v) => v ?? '-' },
                {
                  title: '容差',
                  dataIndex: 'weight_tol_pct',
                  width: 80,
                  render: (v) => (v == null ? '-' : `±${v}%`),
                },
              ]}
              locale={{ emptyText: '本单原料暂无标准库匹配' }}
            />
          </div>
        ) : null}
      </Drawer>

      <Modal
        title="补录验收（recv.accept）"
        open={acceptOpen}
        onCancel={() => setAcceptOpen(false)}
        confirmLoading={busy}
        destroyOnHidden
        onOk={async () => {
          const v = await form.validateFields()
          setBusy(true)
          try {
            await postAction({
              type: 'recv.accept',
              operator: role ?? account ?? 'admin',
              payload: {
                recv_id: v.recv_id,
                source: 'admin-web/inventory/inbound',
                items: [
                  {
                    ing_name: v.ing_name,
                    qty_ordered: v.qty_ordered,
                    qty_received: v.qty_received,
                    qty_rejected: v.qty_rejected ?? 0,
                    verdict: v.verdict,
                    batch_no: v.batch_no,
                    cert_no: v.cert_no,
                    detail: v.detail,
                  },
                ],
              },
            })
            message.success('验收已入队 → 请到审批中心确认')
            setAcceptOpen(false)
            load(acceptDate)
          } catch (e: unknown) {
            const err = e as { response?: { data?: { error?: string } } }
            message.error(err.response?.data?.error || '提交失败')
          } finally {
            setBusy(false)
          }
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="recv_id" label="进货单号 / recv_id">
            <Input placeholder="对应 JH 单号或 id" />
          </Form.Item>
          <Form.Item
            name="ing_name"
            label="原料名称"
            rules={[{ required: true, message: '请填写原料' }]}
          >
            <Input placeholder="与验收标准 / 进货明细一致" />
          </Form.Item>
          <Space style={{ display: 'flex' }} size="middle">
            <Form.Item name="qty_ordered" label="订购量">
              <InputNumber style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="qty_received" label="实收量">
              <InputNumber style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="qty_rejected" label="拒收量">
              <InputNumber style={{ width: 120 }} min={0} />
            </Form.Item>
          </Space>
          <Form.Item
            name="verdict"
            label="结论"
            rules={[{ required: true, message: '请选择结论' }]}
          >
            <Select
              options={[
                { value: 'pass', label: '合格' },
                { value: 'warn', label: '让步' },
                { value: 'fail', label: '拒收' },
              ]}
            />
          </Form.Item>
          <Form.Item name="batch_no" label="批次号">
            <Input />
          </Form.Item>
          <Form.Item name="cert_no" label="索证号">
            <Input />
          </Form.Item>
          <Form.Item name="detail" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
