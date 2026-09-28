import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Tag,
  Typography,
  message,
} from 'antd'
import { fetchSnapshot, submitConfirmedAction } from '../../api'
import type { PosTable } from '../../api/types'
import MockAlert from '../kitchen/components/MockAlert'
import { MOCK_TABLES } from './mock'
import { COLORS } from '../../theme'

const STATUS_STYLE: Record<string, { bg: string; label: string; wire: string }> = {
  空闲: { bg: COLORS.green, label: '空闲', wire: 'free' },
  free: { bg: COLORS.green, label: '空闲', wire: 'free' },
  就餐: { bg: COLORS.red, label: '就餐', wire: 'busy' },
  用餐: { bg: COLORS.red, label: '就餐', wire: 'busy' },
  dining: { bg: COLORS.red, label: '就餐', wire: 'busy' },
  busy: { bg: COLORS.red, label: '就餐', wire: 'busy' },
  occupied: { bg: COLORS.red, label: '就餐', wire: 'busy' },
  待清: { bg: COLORS.yellow, label: '待清', wire: 'clean' },
  cleaning: { bg: COLORS.yellow, label: '待清', wire: 'clean' },
  clean: { bg: COLORS.yellow, label: '待清', wire: 'clean' },
  预订: { bg: COLORS.purple, label: '预订', wire: 'rsv' },
  reserved: { bg: COLORS.purple, label: '预订', wire: 'rsv' },
  rsv: { bg: COLORS.purple, label: '预订', wire: 'rsv' },
}

function normalizeStatus(s?: string): string {
  return (s ?? '空闲').trim()
}

function zoneOf(t: PosTable): string {
  const z = String((t as { zone?: string }).zone || '')
  if (z === '包间' || z === '包厢') return '包间'
  const name = String(t.name || t.no || t.id || '')
  if (/包/.test(name)) return '包间'
  return z || '大厅'
}

export default function TablesPage() {
  const [tables, setTables] = useState<PosTable[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [zoneFilter, setZoneFilter] = useState<string | undefined>()
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<PosTable | null>(null)
  const [form] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    fetchSnapshot()
      .then((snap) => {
        const raw =
          (Array.isArray(snap.data?.pos) && snap.data.pos.length > 0
            ? snap.data.pos
            : []) as PosTable[]
        if (raw.length > 0) {
          setTables(
            raw.map((t) => ({
              ...t,
              status: String(t.status ?? (t as { state?: string }).state ?? '空闲'),
              zone: zoneOf(t),
            })),
          )
          setIsMock(false)
        } else {
          setTables(MOCK_TABLES)
          setIsMock(true)
        }
      })
      .catch(() => {
        setTables(MOCK_TABLES)
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const filtered = useMemo(
    () => tables.filter((t) => !zoneFilter || zoneOf(t) === zoneFilter),
    [tables, zoneFilter],
  )

  const stats = useMemo(() => {
    const c = { 空闲: 0, 就餐: 0, 待清: 0, 预订: 0, 大厅: 0, 包间: 0 }
    for (const t of tables) {
      const label = STATUS_STYLE[normalizeStatus(t.status)]?.label ?? '空闲'
      if (label in c) c[label as keyof typeof c] += 1
      const z = zoneOf(t)
      if (z === '包间') c.包间 += 1
      else c.大厅 += 1
    }
    return c
  }, [tables])

  const run = async (type: string, payload: Record<string, unknown>, okMsg: string) => {
    setBusy(true)
    try {
      const r = await submitConfirmedAction({ type, payload, operator: 'admin' })
      message.success(
        r.confirmed ? `${okMsg}（已确认，待消费器）` : `${okMsg}已入队，请到审批中心确认`,
      )
      setTimeout(load, 2500)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '提交失败')
    } finally {
      setBusy(false)
    }
  }

  const setState = (t: PosTable, wire: string, label: string) => {
    const tid = String(t.id ?? t.no ?? t.name ?? '')
    if (!tid) return
    return run(
      'pos.table_state',
      { table_id: tid, no: t.no, state: wire, seats: t.seats },
      label,
    )
  }

  const openEdit = (t?: PosTable) => {
    setEditing(t || null)
    form.setFieldsValue(
      t
        ? {
            id: t.id,
            name: t.name,
            no: t.no,
            seats: t.seats || 4,
            zone: zoneOf(t),
          }
        : { seats: 4, zone: '大厅', name: '', no: '' },
    )
    setEditOpen(true)
  }

  const saveMaster = async () => {
    const v = await form.validateFields()
    await run(
      'pos.table_upsert',
      {
        table_id: v.id || undefined,
        name: v.name,
        no: v.no,
        seats: v.seats,
        zone: v.zone,
      },
      v.id ? '桌台已更新' : '桌台已新增',
    )
    setEditOpen(false)
  }

  const removeTable = (t: PosTable) => {
    const tid = String(t.id ?? t.no ?? '')
    const label = STATUS_STYLE[normalizeStatus(t.status)]?.label ?? '空闲'
    if (label !== '空闲') {
      message.warning(`桌台「${t.name || tid}」当前为「${label}」，仅空闲桌台可删除`)
      return
    }
    Modal.confirm({
      title: `删除桌台 ${t.name || tid}？`,
      content: '仅空闲桌可删；删后需确认台落库。',
      onOk: () => run('pos.table_remove', { table_id: tid }, '已删桌'),
    })
  }

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/snapshot/latest · data.pos" />}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        {(['空闲', '就餐', '待清', '预订'] as const).map((k) => (
          <Col xs={6} key={k}>
            <Card loading={loading}>
              <Statistic
                title={k}
                value={stats[k]}
                valueStyle={{ color: Object.values(STATUS_STYLE).find((s) => s.label === k)?.bg }}
              />
            </Card>
          </Col>
        ))}
      </Row>
      <Card
        title="桌台平面图 · 大厅 / 包间"
        extra={
          <Space>
            <Select
              allowClear
              placeholder="分区"
              style={{ width: 100 }}
              value={zoneFilter}
              onChange={setZoneFilter}
              options={[
                { value: '大厅', label: `大厅 ${stats.大厅}` },
                { value: '包间', label: `包间 ${stats.包间}` },
              ]}
            />
            <Button type="primary" onClick={() => openEdit()}>
              新增桌台
            </Button>
            <Typography.Text type="secondary">主数据与改态均经确认台</Typography.Text>
          </Space>
        }
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
            gap: 12,
          }}
        >
          {filtered.map((t, i) => {
            const st = STATUS_STYLE[normalizeStatus(t.status)] ?? STATUS_STYLE['空闲']
            const z = zoneOf(t)
            return (
              <div
                key={String(t.id ?? t.name ?? t.no ?? i)}
                style={{
                  border: `2px solid ${st.bg}`,
                  borderRadius: 8,
                  padding: 12,
                  background: `${st.bg}14`,
                  minHeight: 130,
                }}
              >
                <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                  <Typography.Text strong>
                    {String(t.name ?? t.no ?? t.id ?? `桌${i + 1}`)}
                  </Typography.Text>
                  <Tag>{z}</Tag>
                </Space>
                <div style={{ marginTop: 4 }}>
                  <Tag color={st.bg}>{st.label}</Tag>
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t.seats ?? '-'} 座 · {String(t.id || '')}
                </Typography.Text>
                <Space size={4} wrap style={{ marginTop: 8 }}>
                  <Button size="small" loading={busy} onClick={() => setState(t, 'free', '置空闲')}>
                    空闲
                  </Button>
                  <Button size="small" loading={busy} onClick={() => setState(t, 'busy', '置就餐')}>
                    就餐
                  </Button>
                  <Button size="small" loading={busy} onClick={() => setState(t, 'clean', '置待清')}>
                    待清
                  </Button>
                  <Button size="small" onClick={() => openEdit(t)}>
                    编辑
                  </Button>
                  <Button size="small" danger onClick={() => removeTable(t)}>
                    删
                  </Button>
                </Space>
              </div>
            )
          })}
        </div>
      </Card>

      <Modal
        title={editing ? '编辑桌台' : '新增桌台'}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={saveMaster}
        confirmLoading={busy}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="id" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '填桌名，如 3号桌 / 包厢A' }]}>
            <Input placeholder="3号桌 / 包厢A" />
          </Form.Item>
          <Form.Item name="no" label="桌号">
            <Input placeholder="3 / A" />
          </Form.Item>
          <Form.Item name="zone" label="分区" rules={[{ required: true }]}>
            <Select
              options={[
                { value: '大厅', label: '大厅' },
                { value: '包间', label: '包间' },
              ]}
            />
          </Form.Item>
          <Form.Item name="seats" label="座位数" rules={[{ required: true }]}>
            <InputNumber min={1} max={40} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
