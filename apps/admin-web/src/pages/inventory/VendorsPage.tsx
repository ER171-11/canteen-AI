import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  Card,
  Empty,
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
import { fetchSnapshot, submitConfirmedAction } from '../../api'
import type { IngItem, QuoteItem, Vendor } from '../../api/types'
import MockAlert from '../kitchen/components/MockAlert'
import { MOCK_QUOTES } from './mock'
import { COLORS } from '../../theme'

interface QuoteRow {
  key: string
  ingId: string
  ingName: string
  src: string
  price: number
  date?: string
  note?: string
  isBest?: boolean
}

export default function VendorsPage() {
  const [quotes, setQuotes] = useState<QuoteItem[]>([])
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [ings, setIngs] = useState<IngItem[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    fetchSnapshot()
      .then((snap) => {
        setIngs(snap.data?.ings ?? [])
        const q = snap.data?.quotes
        const v = snap.data?.vendors
        if (Array.isArray(q) && q.length > 0) {
          setQuotes(q)
          setIsMock(false)
        } else if (Array.isArray(v) && v.length > 0) {
          setVendors(v)
          setQuotes([])
          setIsMock(false)
        } else {
          setQuotes([])
        }
      })
      .catch(() => {
        setQuotes(MOCK_QUOTES)
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const ingName = useMemo(() => {
    const m = new Map(ings.map((g) => [g.id, g.name]))
    return (id: string) => m.get(id) ?? id ?? '?'
  }, [ings])

  const rows: QuoteRow[] = useMemo(() => {
    if (quotes.length) {
      const byIng = new Map<string, QuoteItem[]>()
      for (const q of quotes) {
        const id = String(q.ing ?? '')
        if (!byIng.has(id)) byIng.set(id, [])
        byIng.get(id)!.push(q)
      }
      const out: QuoteRow[] = []
      for (const [ingId, list] of byIng) {
        const prices = list.map((x) => Number(x.price) || Infinity)
        const min = Math.min(...prices)
        list.forEach((q, i) => {
          const p = Number(q.price) || 0
          out.push({
            key: String(q.id ?? `${ingId}-${i}`),
            ingId,
            ingName: ingName(ingId),
            src: String(q.src ?? '-'),
            price: p,
            date: q.date,
            note: q.note,
            isBest: p === min && min < Infinity,
          })
        })
      }
      return out.sort((a, b) => a.ingName.localeCompare(b.ingName, 'zh-CN'))
    }
    return vendors.map((v) => ({
      key: v.id,
      ingId: '',
      ingName: v.category ?? '供应商',
      src: v.name,
      price: v.rating ?? 0,
      note: v.contact,
    }))
  }, [quotes, vendors, ingName])

  const columns: ColumnsType<QuoteRow> = [
    { title: '原料', dataIndex: 'ingName', width: 160 },
    { title: '来源/供应商', dataIndex: 'src', ellipsis: true },
    {
      title: '报价',
      dataIndex: 'price',
      width: 120,
      align: 'right',
      render: (v, r) =>
        quotes.length ? (
          <span>
            ¥{v}
            {r.isBest ? (
              <Tag color={COLORS.green} style={{ marginLeft: 6 }}>
                最低
              </Tag>
            ) : null}
          </span>
        ) : (
          v || '-'
        ),
    },
    { title: '日期', dataIndex: 'date', width: 110, render: (v) => v ?? '-' },
    { title: '备注', dataIndex: 'note', ellipsis: true, render: (v) => v ?? '-' },
  ]

  const empty = !loading && rows.length === 0 && !isMock

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/snapshot/latest · data.quotes" />}
      <Card
        title="供应商报价 / 比价"
        extra={
          <Button type="primary" onClick={() => { form.resetFields(); form.setFieldsValue({ set_default_sup: true }); setOpen(true) }}>
            录入报价
          </Button>
        }
      >
        {empty ? (
          <Empty description="暂无报价。点右上角「录入报价」经确认台写入。" />
        ) : (
          <Table<QuoteRow>
            rowKey="key"
            columns={columns}
            dataSource={rows}
            loading={loading}
            pagination={{ pageSize: 20 }}
          />
        )}
      </Card>

      <Modal
        title="录入供应商报价"
        open={open}
        onCancel={() => setOpen(false)}
        confirmLoading={busy}
        onOk={async () => {
          const v = await form.validateFields()
          setBusy(true)
          try {
            const r = await submitConfirmedAction({
              type: 'quote.upsert',
              payload: {
                ing: v.ing,
                src: v.src,
                price: v.price,
                note: v.note,
                set_default_sup: v.set_default_sup,
              },
              operator: 'admin',
            })
            message.success(r.confirmed ? '报价已确认，待消费器' : '已入队')
            setOpen(false)
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
          <Form.Item name="ing" label="原料" rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={ings.map((i) => ({ value: i.id, label: `${i.name}（${i.id}）` }))}
              placeholder="选择原料"
            />
          </Form.Item>
          <Form.Item name="src" label="供应商" rules={[{ required: true }]}>
            <Input placeholder="张记肉联 / 菜篮子 / 京东" />
          </Form.Item>
          <Form.Item name="price" label="报价（元）" rules={[{ required: true }]}>
            <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input placeholder="含运 / 到店价 / 箱规" />
          </Form.Item>
          <Form.Item name="set_default_sup" label="设为该原料默认供应商" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
        <Space>
          <span style={{ color: '#888', fontSize: 12 }}>同原料多供应商会自动标出最低价</span>
        </Space>
      </Modal>
    </div>
  )
}
