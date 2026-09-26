import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchAdminDishes, fetchSnapshot, submitConfirmedAction } from '../../api'
import type { Dish } from '../../api/types'
import MockAlert from './components/MockAlert'
import { MOCK_DISHES } from './mock'
import { COLORS } from '../../theme'

export default function DishesPage() {
  const [items, setItems] = useState<Dish[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [cat, setCat] = useState<string | undefined>()
  const [keyword, setKeyword] = useState('')
  const [editOpen, setEditOpen] = useState(false)
  const [priceOpen, setPriceOpen] = useState(false)
  const [current, setCurrent] = useState<Dish | null>(null)
  const [form] = Form.useForm()
  const [priceForm] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    fetchAdminDishes()
      .then((resp) => {
        setItems(resp.items ?? [])
        setIsMock(false)
      })
      .catch(() =>
        fetchSnapshot()
          .then((snap) => {
            const dishes = (snap.data?.dishes as Dish[] | undefined) || []
            if (dishes.length) {
              setItems(dishes)
              setIsMock(false)
            } else {
              setItems(MOCK_DISHES)
              setIsMock(true)
            }
          })
          .catch(() => {
            setItems(MOCK_DISHES)
            setIsMock(true)
          }),
      )
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const cats = useMemo(
    () => [...new Set(items.map((d) => d.cat).filter(Boolean))] as string[],
    [items],
  )

  const filtered = useMemo(
    () =>
      items.filter(
        (d) =>
          (!cat || d.cat === cat) &&
          (!keyword || d.name.includes(keyword.trim())),
      ),
    [items, cat, keyword],
  )

  const run = async (type: string, payload: Record<string, unknown>, ok: string) => {
    setBusy(true)
    try {
      const r = await submitConfirmedAction({ type, payload, operator: 'admin' })
      message.success(r.confirmed ? `${ok}（待消费器）` : `${ok}已入队`)
      setTimeout(load, 2500)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '提交失败')
    } finally {
      setBusy(false)
    }
  }

  const openEdit = (d?: Dish) => {
    setCurrent(d || null)
    form.setFieldsValue(
      d
        ? { id: d.id, name: d.name, cat: d.cat || '常规', price: d.price, est: d.est, on: !!d.on }
        : { cat: '常规', price: 28, est: 8, on: true },
    )
    setEditOpen(true)
  }

  const openPrice = (d: Dish) => {
    setCurrent(d)
    priceForm.setFieldsValue({ price: d.price, reason: '' })
    setPriceOpen(true)
  }

  const columns: ColumnsType<Dish> = [
    { title: '菜品名', dataIndex: 'name', sorter: (a, b) => a.name.localeCompare(b.name, 'zh-CN') },
    { title: '分类', dataIndex: 'cat', width: 100, render: (v) => v ?? '-' },
    {
      title: '售价',
      dataIndex: 'price',
      width: 90,
      align: 'right',
      render: (v) => (v == null ? '-' : `¥${v}`),
      sorter: (a, b) => (a.price ?? 0) - (b.price ?? 0),
    },
    {
      title: '成本',
      dataIndex: 'est',
      width: 90,
      align: 'right',
      render: (v) => (v == null ? '-' : `¥${v}`),
    },
    {
      title: '销量',
      dataIndex: 'q',
      width: 80,
      align: 'right',
      sorter: (a, b) => (a.q ?? 0) - (b.q ?? 0),
    },
    {
      title: '上架',
      dataIndex: 'on',
      width: 90,
      render: (v: boolean | undefined) =>
        v ? <Tag color={COLORS.green}>上架中</Tag> : <Tag>已下架</Tag>,
    },
    {
      title: '操作',
      key: 'act',
      width: 220,
      render: (_, r) => (
        <Space size={4} wrap>
          <Button size="small" onClick={() => openEdit(r)}>
            编辑
          </Button>
          <Button size="small" onClick={() => openPrice(r)}>
            调价
          </Button>
          <Button
            size="small"
            loading={busy}
            onClick={() =>
              run(
                'dish.set_active',
                { id: r.id, on: !r.on },
                r.on ? `已下架 ${r.name}` : `已上架 ${r.name}`,
              )
            }
          >
            {r.on ? '下架' : '上架'}
          </Button>
        </Space>
      ),
    },
  ]

  return (
    <Card
      title="菜品菜单"
      extra={
        <Space>
          <Select
            allowClear
            placeholder="按分类筛选"
            style={{ width: 140 }}
            value={cat}
            onChange={setCat}
            options={cats.map((c) => ({ value: c, label: c }))}
          />
          <Input.Search
            allowClear
            placeholder="搜索菜品名"
            style={{ width: 180 }}
            onSearch={setKeyword}
            onChange={(e) => !e.target.value && setKeyword('')}
          />
          <Button type="primary" onClick={() => openEdit()}>
            新增菜品
          </Button>
        </Space>
      }
    >
      {isMock && <MockAlert endpoint="/api/admin/dishes" />}
      <Table<Dish>
        rowKey="id"
        columns={columns}
        dataSource={filtered}
        loading={loading}
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 道` }}
      />

      <Modal
        title={current ? '编辑菜品' : '新增菜品'}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        confirmLoading={busy}
        onOk={async () => {
          const v = await form.validateFields()
          await run(
            'dish.upsert',
            {
              id: v.id,
              name: v.name,
              cat: v.cat,
              price: v.price,
              est: v.est,
              cost: v.est,
              on: v.on,
            },
            current ? '菜品已更新' : '菜品已新增',
          )
          setEditOpen(false)
        }}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="id" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="name" label="菜品名" rules={[{ required: true }]}>
            <Input placeholder="长寿饺 / 御膳狮子头" />
          </Form.Item>
          <Form.Item name="cat" label="分类" rules={[{ required: true }]}>
            <Select
              options={[
                '引流',
                '爆品',
                '利润',
                '形象',
                '常规',
                '五福饺',
                '热菜',
                '凉菜',
                '饮品',
              ].map((c) => ({ value: c, label: c }))}
            />
          </Form.Item>
          <Form.Item name="price" label="售价" rules={[{ required: true }]}>
            <InputNumber min={0} step={1} style={{ width: '100%' }} addonBefore="¥" />
          </Form.Item>
          <Form.Item name="est" label="成本估">
            <InputNumber min={0} step={0.1} style={{ width: '100%' }} addonBefore="¥" />
          </Form.Item>
          <Form.Item name="on" label="上架" valuePropName="checked">
            <Switch checkedChildren="上架" unCheckedChildren="下架" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`调价 · ${current?.name || ''}`}
        open={priceOpen}
        onCancel={() => setPriceOpen(false)}
        confirmLoading={busy}
        onOk={async () => {
          const v = await priceForm.validateFields()
          await run(
            'dish.price',
            { id: current?.id, name: current?.name, price: v.price, reason: v.reason },
            `调价至 ¥${v.price}`,
          )
          setPriceOpen(false)
        }}
        destroyOnClose
      >
        <Form form={priceForm} layout="vertical">
          <Form.Item label="当前售价">
            <Input disabled value={current?.price != null ? `¥${current.price}` : '-'} />
          </Form.Item>
          <Form.Item name="price" label="新售价" rules={[{ required: true }]}>
            <InputNumber min={0} step={1} style={{ width: '100%' }} addonBefore="¥" />
          </Form.Item>
          <Form.Item name="reason" label="调价原因">
            <Input.TextArea rows={2} placeholder="成本上涨 / 促销 / 午市特价…" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
