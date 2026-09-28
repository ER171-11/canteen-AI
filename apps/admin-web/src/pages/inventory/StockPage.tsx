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
  Space,
  Statistic,
  Table,
  Tag,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchSnapshot, submitConfirmedAction } from '../../api'
import type { IngItem } from '../../api/types'
import MockAlert from '../kitchen/components/MockAlert'
import { MOCK_INGS } from './mock'
import { safetyLine, stockStatus } from './utils'
import { COLORS } from '../../theme'

type IngRow = IngItem & {
  qty?: number
  buy?: string
  pack?: string
  moq?: string | number
  sup?: string
  spec?: string
  conv?: number
}

export default function StockPage() {
  const [items, setItems] = useState<IngRow[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [current, setCurrent] = useState<IngRow | null>(null)
  const [form] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    fetchSnapshot()
      .then((snap) => {
        const list = (snap.data?.ings ?? []) as IngRow[]
        setItems(list)
        setIsMock(false)
      })
      .catch(() => {
        setItems(MOCK_INGS as IngRow[])
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const stats = useMemo(() => {
    let critical = 0
    let low = 0
    for (const ing of items) {
      const s = stockStatus(ing).text
      if (s === '告急') critical += 1
      else if (s === '偏低') low += 1
    }
    return { total: items.length, critical, low }
  }, [items])

  const openEdit = (r?: IngRow) => {
    setCurrent(r || null)
    form.setFieldsValue(
      r
        ? {
            id: r.id,
            name: r.name,
            cat: r.cat,
            unit: r.unit,
            buy: r.buy || r.pack || r.unit,
            pack: r.pack || r.buy || r.unit,
            spec: r.spec,
            moq: r.moq,
            sup: r.sup,
            safe: safetyLine(r) || r.safe,
            est: r.est,
            conv: r.conv || 1,
          }
        : { unit: '斤', buy: '斤', pack: '斤', conv: 1, safe: 0 },
    )
    setEditOpen(true)
  }

  const columns: ColumnsType<IngRow> = [
    { title: '名称', dataIndex: 'name', ellipsis: true },
    { title: '分类', dataIndex: 'cat', width: 90, render: (v) => v ?? '-' },
    { title: '单位', dataIndex: 'unit', width: 60, render: (v) => v ?? '-' },
    {
      title: '包规',
      key: 'pack',
      width: 90,
      ellipsis: true,
      render: (_, r) => r.pack || r.buy || r.spec || '-',
    },
    {
      title: '供应商',
      dataIndex: 'sup',
      width: 110,
      ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: 'MOQ',
      dataIndex: 'moq',
      width: 70,
      render: (v) => v || '-',
    },
    {
      title: '当前量',
      key: 'stock',
      width: 90,
      align: 'right',
      sorter: (a, b) => (a.stock ?? a.qty ?? 0) - (b.stock ?? b.qty ?? 0),
      render: (_, r) => r.stock ?? r.qty ?? 0,
    },
    {
      title: '安全线',
      key: 'safe',
      width: 80,
      align: 'right',
      render: (_, r) => safetyLine(r) || '-',
    },
    {
      title: '状态',
      key: 'status',
      width: 80,
      filters: [
        { text: '告急', value: '告急' },
        { text: '偏低', value: '偏低' },
        { text: '充足', value: '充足' },
      ],
      onFilter: (v, r) => stockStatus(r).text === v,
      render: (_, r) => {
        const s = stockStatus(r)
        return <Tag color={s.color}>{s.text}</Tag>
      },
    },
    {
      title: '操作',
      key: 'act',
      width: 80,
      render: (_, r) => (
        <Button size="small" onClick={() => openEdit(r)}>
          编辑
        </Button>
      ),
    },
  ]

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/snapshot/latest · data.ings" />}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Card>
            <Statistic title="原料数" value={stats.total} />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="告急" value={stats.critical} valueStyle={{ color: COLORS.red }} />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="偏低" value={stats.low} valueStyle={{ color: COLORS.yellow }} />
          </Card>
        </Col>
      </Row>
      <Card
        title="库存 / 产品库"
        extra={
          <Space>
            <Button type="primary" onClick={() => openEdit()}>
              新增原料
            </Button>
            <span style={{ color: '#888', fontSize: 12 }}>包规·供应商·安全线经确认台写入</span>
          </Space>
        }
      >
        <Table<IngRow>
          rowKey="id"
          columns={columns}
          dataSource={items}
          loading={loading}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 项` }}
          size="small"
        />
      </Card>

      <Modal
        title={current ? `编辑 · ${current.name}` : '新增原料'}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        confirmLoading={busy}
        width={560}
        onOk={async () => {
          const v = await form.validateFields()
          setBusy(true)
          try {
            const r = await submitConfirmedAction({
              type: 'ing.upsert',
              payload: v,
              operator: 'admin',
            })
            message.success(r.confirmed ? '已确认，待消费器' : '已入队')
            setEditOpen(false)
            setTimeout(load, 2500)
          } catch (e: unknown) {
            const err = e as { response?: { data?: { error?: string } } }
            message.error(err.response?.data?.error || '失败')
          } finally {
            setBusy(false)
          }
        }}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="id" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="name" label="原料名" rules={[{ required: true }]}>
            <Input placeholder="火龙果汁 / 黑猪前肩肉" />
          </Form.Item>
          <Space style={{ width: '100%' }} size={12}>
            <Form.Item name="cat" label="分类" style={{ flex: 1 }}>
              <Input placeholder="色源/肉类/干调" />
            </Form.Item>
            <Form.Item name="unit" label="库存单位" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Input placeholder="斤/kg/瓶" />
            </Form.Item>
          </Space>
          <Space style={{ width: '100%' }} size={12}>
            <Form.Item name="buy" label="采购单位" style={{ flex: 1 }}>
              <Input placeholder="袋/箱/瓶" />
            </Form.Item>
            <Form.Item name="pack" label="包规" style={{ flex: 1 }}>
              <Input placeholder="25kg/袋 · 30枚/板" />
            </Form.Item>
            <Form.Item name="conv" label="换算" style={{ width: 100 }}>
              <InputNumber min={0.001} step={0.1} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="spec" label="规格备注">
            <Input placeholder="品牌/产地/净含量" />
          </Form.Item>
          <Space style={{ width: '100%' }} size={12}>
            <Form.Item name="sup" label="默认供应商" style={{ flex: 1 }}>
              <Input placeholder="张记 / 菜篮子" />
            </Form.Item>
            <Form.Item name="moq" label="起订量 MOQ" style={{ flex: 1 }}>
              <Input placeholder="1袋 / 10斤" />
            </Form.Item>
          </Space>
          <Space style={{ width: '100%' }} size={12}>
            <Form.Item name="safe" label="安全线" style={{ flex: 1 }}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="est" label="日耗" style={{ flex: 1 }}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  )
}
