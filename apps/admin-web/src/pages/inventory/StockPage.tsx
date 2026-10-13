import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchSnapshot, submitAndConfirmAction } from '../../api'
import type { IngItem } from '../../api/types'
import MockAlert from '../kitchen/components/MockAlert'
import { fmtNum, safetyLine, stockStatus, stockValue } from './utils'
import { COLORS } from '../../theme'

type IngRow = IngItem & {
  qty?: number
  buy?: string
  pack?: string
  moq?: string | number
  sup?: string
  spec?: string
}

export default function StockPage() {
  const [items, setItems] = useState<IngRow[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [current, setCurrent] = useState<IngRow | null>(null)
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')
  const [onlyPending, setOnlyPending] = useState(false)
  const [showMore, setShowMore] = useState(false)
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
        setItems([])
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
    let pending = 0
    for (const ing of items) {
      if (ing.pending) pending += 1
      // 停用原料不参与告急/偏低统计（对齐旧版 lowStocks() 的 g.on 过滤）
      if (ing.on === false) continue
      const s = stockStatus(ing).text
      if (s === '告急') critical += 1
      else if (s === '偏低') low += 1
    }
    return { total: items.length, critical, low, pending, value: stockValue(items) }
  }, [items])

  const cats = useMemo(
    () => Array.from(new Set(items.map((g) => g.cat).filter(Boolean))) as string[],
    [items],
  )

  const filtered = useMemo(() => {
    const kw = q.trim()
    return items.filter(
      (g) =>
        (!onlyPending || g.pending) &&
        (!cat || g.cat === cat) &&
        (!kw || (g.name ?? '').includes(kw)),
    )
  }, [items, cat, q, onlyPending])

  const openEdit = (r?: IngRow) => {
    setCurrent(r || null)
    /* 新建：默认只露「原料名」，其余可后补；编辑/完善：直接展开全部字段 */
    setShowMore(!!r)
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
            yld: Math.round((r.yld ?? 1) * 100),
            on: r.on !== false,
          }
        : { unit: '斤', buy: '斤', pack: '斤', conv: 1, safe: 0, yld: 100, on: true },
    )
    setEditOpen(true)
  }

  const columns: ColumnsType<IngRow> = [
    {
      title: '名称',
      dataIndex: 'name',
      ellipsis: true,
      render: (v: string, r) => (
        <Space size={4}>
          <span>{v}</span>
          {r.pending ? <Tag color="orange">待完善</Tag> : null}
        </Space>
      ),
    },
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
      title: '换算率',
      key: 'conv',
      width: 120,
      render: (_, r) =>
        r.conv == null || r.conv === 1
          ? '—'
          : `1 ${r.buy || r.pack || ''} = ${r.conv} ${r.unit || ''}`,
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
      title: '库存均价',
      key: 'avg',
      width: 110,
      align: 'right',
      render: (_, r) => `${fmtNum(r.avg)} 元/${r.unit || '单位'}`,
    },
    {
      title: '最近采购价',
      key: 'last',
      width: 120,
      align: 'right',
      render: (_, r) => (r.last ? `${fmtNum(r.last)} 元/${r.buy || '单位'}` : '—'),
    },
    {
      title: '库存总值',
      key: 'val',
      width: 110,
      align: 'right',
      render: (_, r) => `${fmtNum((Number(r.stock) || 0) * (Number(r.avg) || 0))} 元`,
    },
    {
      title: '出成率',
      key: 'yld',
      width: 80,
      align: 'right',
      render: (_, r) => `${Math.round((r.yld ?? 1) * 100)}%`,
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
      title: '启用',
      key: 'on',
      width: 80,
      render: (_, r) => (r.on === false ? <Tag>停用</Tag> : <Tag color={COLORS.green}>启用</Tag>),
    },
    {
      title: '操作',
      key: 'act',
      width: 80,
      render: (_, r) => (
        <Button size="small" type={r.pending ? 'primary' : 'default'} onClick={() => openEdit(r)}>
          {r.pending ? '完善' : '编辑'}
        </Button>
      ),
    },
  ]

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/snapshot/latest · data.ings" />}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card>
            <Statistic title="原料数" value={stats.total} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="告急" value={stats.critical} valueStyle={{ color: COLORS.red }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="偏低" value={stats.low} valueStyle={{ color: COLORS.yellow }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="库存总值"
              value={stats.value}
              precision={2}
              suffix="元"
              valueStyle={{ color: COLORS.primary }}
            />
          </Card>
        </Col>
      </Row>
      {stats.pending > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`有 ${stats.pending} 种原料待完善（多为进货批量导入自动建档）`}
          description="补全「分类 / 库存单位 / 采购单位 / 包规」等信息后点「确认转正」，即视为已核对主数据。"
          action={
            <Button size="small" onClick={() => setOnlyPending((v) => !v)}>
              {onlyPending ? '显示全部' : '只看待完善'}
            </Button>
          }
        />
      ) : null}
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
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap size={8}>
            <Input
              allowClear
              placeholder="搜索原料名称…"
              style={{ width: 200 }}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <Space wrap size={4}>
              <Tag.CheckableTag checked={cat === ''} onChange={() => setCat('')}>
                全部分类
              </Tag.CheckableTag>
              {cats.map((c) => (
                <Tag.CheckableTag key={c} checked={cat === c} onChange={() => setCat(c)}>
                  {c}
                </Tag.CheckableTag>
              ))}
            </Space>
          </Space>
          <Table<IngRow>
            rowKey="id"
            columns={columns}
            dataSource={filtered}
            loading={loading}
            scroll={{ x: 'max-content' }}
            rowClassName={(r) => (r.on === false ? 'ing-off-row' : '')}
            pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 项` }}
            size="small"
          />
        </Space>
      </Card>

      <Modal
        title={
          current
            ? current.pending
              ? `完善原料 · ${current.name}`
              : `编辑 · ${current.name}`
            : '新增原料'
        }
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        confirmLoading={busy}
        width={560}
        okText={current?.pending ? '确认转正' : '确定'}
        onOk={async () => {
          const v = await form.validateFields()
          const cat = String(v.cat ?? '').trim()
          const unit = String(v.unit ?? '').trim()
          const wasPending = !!current?.pending
          /* 待完善原料：信息补齐才允许转正，否则继续留在「待完善」队列 */
          if (wasPending && (!cat || !unit)) {
            message.warning('请先补全「分类」与「库存单位」再确认转正')
            return
          }
          /* 分类 + 库存单位齐全 → 视为已完善（pending:false，后端清掉草稿标记） */
          const pending = !(cat && unit)
          const payload = {
            ...v,
            pending,
            // 出成率：表单存百分比（5~100），提交时折算为分数（0.05~1）
            yld: v.yld == null ? undefined : Math.min(1, Math.max(0.05, Number(v.yld) / 100)),
          }
          setBusy(true)
          try {
            const r = await submitAndConfirmAction({
              type: 'ing.upsert',
              payload,
              operator: 'admin',
            })
            if (!r.confirmed) message.success('已入队，待审批中心确认')
            else if (wasPending) message.success('已确认转正')
            else if (pending) message.success('已保存（仍为待完善）')
            else message.success('已保存')
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
          {current?.pending ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="该原料由进货批量导入自动建档，档案信息待完善"
              description="补全「分类」与「库存单位」后点「确认转正」。未转正前它照常参与库存与成本，只是主数据未被核对。"
            />
          ) : null}
          <Form.Item name="name" label="原料名" rules={[{ required: true }]}>
            <Input placeholder="火龙果汁 / 黑猪前肩肉" />
          </Form.Item>
          {current || showMore ? (
            <>
              <Space style={{ width: '100%' }} size={12}>
                <Form.Item name="cat" label="分类" style={{ flex: 1 }}>
                  <Input placeholder="色源/肉类/干调" />
                </Form.Item>
                <Form.Item name="unit" label="库存单位" style={{ flex: 1 }}>
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
                <Form.Item name="yld" label="出成率 %" style={{ width: 120 }}>
                  <InputNumber min={5} max={100} step={1} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item name="on" label="是否启用" style={{ width: 150 }}>
                  <Radio.Group
                    options={[
                      { label: '启用', value: true },
                      { label: '停用', value: false },
                    ]}
                  />
                </Form.Item>
              </Space>
            </>
          ) : (
            <>
              <div style={{ color: '#888', fontSize: 12, marginBottom: 4 }}>
                新建只需填「原料名」；分类 / 单位 / 包规等可稍后在「编辑」里补。
                未补全的会被标记为「待完善」（不影响库存与成本）。
              </div>
              <Button type="link" style={{ padding: 0 }} onClick={() => setShowMore(true)}>
                + 现在补充分类 / 单位 / 供应商等信息
              </Button>
            </>
          )}
        </Form>
      </Modal>
    </div>
  )
}
