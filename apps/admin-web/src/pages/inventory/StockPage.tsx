import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Key } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  fetchSnapshot,
  fetchIngTerms,
  submitAndConfirmAction,
  submitIngAttrSet,
  submitIngDelete,
  submitIngDisable,
  submitTermUpsert,
} from '../../api'
import type { IngItem, IngTerm } from '../../api/types'
import MockAlert from '../kitchen/components/MockAlert'
import QuoteEntryModal, { type QuoteIngOption } from './QuoteEntryModal'
import StockBatchModal from './StockBatchModal'
import StockCalibrateModal, { type CalibrateTarget } from './StockCalibrateModal'
import { fmtNum, safeHref, safetyLine, stockStatus, stockValue } from './utils'
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

  /* W3-04 / FP-ING-13：原料行内「比价」入口（复用供应商比价页的报价录入弹窗） */
  const [quoteOpen, setQuoteOpen] = useState(false)
  const [quoteIngId, setQuoteIngId] = useState<string | undefined>(undefined)

  /* W3-01 / FP-ING-05 手工校准（独立弹窗，与主数据编辑分开） */
  const [calibOpen, setCalibOpen] = useState(false)
  const [calibTarget, setCalibTarget] = useState<CalibrateTarget | null>(null)

  /* W3-02 / FP-ING-06 批量设置安全线/出成率（整批一个动作） */
  const [selectedKeys, setSelectedKeys] = useState<Key[]>([])
  const [batchOpen, setBatchOpen] = useState(false)

  /* ---- W2 受控词表 + 属性 Tag ---- */
  const [terms, setTerms] = useState<IngTerm[]>([])
  const [termOpen, setTermOpen] = useState(false)
  const [termName, setTermName] = useState('')
  const [termCat, setTermCat] = useState('')
  const [termAliases, setTermAliases] = useState('')
  const [termBusy, setTermBusy] = useState(false)

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

  /* W2：加载受控词表（只读；失败不阻塞主流程，退化为无词条） */
  useEffect(() => {
    fetchIngTerms()
      .then((r) => setTerms(r.terms ?? []))
      .catch(() => setTerms([]))
  }, [])

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

  /* W2：词条索引（标准名/别名/词条ID → 词条），用于搜索命中与标签渲染 */
  const termIndex = useMemo(() => {
    const m = new Map<string, IngTerm>()
    for (const t of terms) {
      for (const k of [t.name, ...(t.aliases || [])]) {
        const nk = String(k).replace(/\s+/g, '').trim()
        if (nk) m.set(nk, t)
      }
      if (t.id) m.set(t.id, t)
    }
    return m
  }, [terms])

  const termById = useMemo(() => {
    const m = new Map<string, IngTerm>()
    for (const t of terms) m.set(t.id, t)
    return m
  }, [terms])

  /* W2：当前搜索词归一出的词条 ID（「东北」「东北产地」等别名 → 同一词条，精确命中） */
  const hitTermId = useMemo(() => {
    const nk = q.trim().replace(/\s+/g, '')
    return nk ? termIndex.get(nk)?.id ?? null : null
  }, [q, termIndex])

  const filtered = useMemo(() => {
    const kw = q.trim()
    return items.filter(
      (g) =>
        (!onlyPending || g.pending) &&
        (!cat || g.cat === cat) &&
        (!kw || (g.name ?? '').includes(kw) || (hitTermId && (g.tags ?? []).includes(hitTermId))),
    )
  }, [items, cat, q, onlyPending, hitTermId])

  /* W2：编辑 Modal 的词条多选选项（按受控维度分组） */
  const termOptions = useMemo(() => {
    const groups: Record<string, IngTerm[]> = {}
    for (const t of terms) (groups[t.category] = groups[t.category] || []).push(t)
    return Object.entries(groups).map(([c, list]) => ({
      label: c,
      options: list.map((t) => ({
        label: `${t.name}${t.status === 'pending' ? '（待审）' : t.status === 'rejected' ? '（已驳回）' : ''}`,
        value: t.id,
        disabled: t.status !== 'active',
      })),
    }))
  }, [terms])

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
            base_unit: r.base_unit,
            pack_in_base: r.pack_in_base,
            on: r.on !== false,
            tags: r.tags ?? [],
            qc_report_url: r.qc_report_url ?? '',
          }
        : { unit: '斤', buy: '斤', pack: '斤', conv: 1, safe: 0, yld: 100, on: true, tags: [], qc_report_url: '' },
    )
    setEditOpen(true)
  }

  /* 详情面板：列表仅保留核心列，其余属性点击行首 ▸ 展开查看 */
  const renderDetail = (r: IngRow) => {
    const tags = r.tags ?? []
    return (
      <Descriptions
        size="small"
        bordered
        column={{ xs: 1, sm: 2, md: 3 }}
        labelStyle={{ width: 110 }}
      >
        <Descriptions.Item label="库存单位">{r.unit ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="包规">{r.pack || r.buy || r.spec || '-'}</Descriptions.Item>
        <Descriptions.Item label="默认供应商">{r.sup || '-'}</Descriptions.Item>
        <Descriptions.Item label="起订量 MOQ">{r.moq || '-'}</Descriptions.Item>
        <Descriptions.Item label="换算率">
          {r.conv == null || r.conv === 1
            ? '—'
            : `1 ${r.buy || r.pack || ''} = ${r.conv} ${r.unit || ''}`}
        </Descriptions.Item>
        <Descriptions.Item label="安全线">{safetyLine(r) || '-'}</Descriptions.Item>
        <Descriptions.Item label="库存均价">{`${fmtNum(r.avg)} 元/${r.unit || '单位'}`}</Descriptions.Item>
        <Descriptions.Item label="最近采购价">{r.last ? `${fmtNum(r.last)} 元/${r.buy || '单位'}` : '—'}</Descriptions.Item>
        <Descriptions.Item label="库存总值">{`${fmtNum((Number(r.stock) || 0) * (Number(r.avg) || 0))} 元`}</Descriptions.Item>
        <Descriptions.Item label="出成率">{`${Math.round((r.yld ?? 1) * 100)}%`}</Descriptions.Item>
        <Descriptions.Item label="启用">{r.on === false ? '停用' : '启用'}</Descriptions.Item>
        <Descriptions.Item label="标签 / 属性" span={3}>
          {tags.length ? (
            <Space size={4} wrap>
              {tags.map((t) => {
                const term = termById.get(t)
                const isHit = hitTermId === t
                return term ? (
                  <Tag key={t} color={isHit ? 'geekblue' : 'blue'} style={{ marginInlineEnd: 0 }}>
                    {term.name}
                  </Tag>
                ) : (
                  <Tag key={t} color={isHit ? 'orange' : 'default'} style={{ marginInlineEnd: 0 }}>
                    {t}
                  </Tag>
                )
              })}
            </Space>
          ) : (
            <span style={{ color: '#999' }}>-</span>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="质检报告" span={3}>
          {safeHref(r.qc_report_url) ? (
            <a href={safeHref(r.qc_report_url)!} target="_blank" rel="noopener noreferrer">
              查看报告
            </a>
          ) : (
            <span style={{ color: '#999' }}>-</span>
          )}
        </Descriptions.Item>
      </Descriptions>
    )
  }

  /* 报价录入下拉：与「原料比价」同一口径（在售原料 + 本店均价），停用原料不参与比价 */
  const quoteIngs = useMemo<QuoteIngOption[]>(
    () => items
      .filter((g) => g.on !== false)
      .map((g) => ({
        ingId: String(g.id),
        name: g.name,
        avg: Number(g.avg) || 0,
        unit: g.unit ?? '',
        buy: g.buy || g.pack || g.unit,
        conv: Number(g.conv ?? 1) || 1,
      })),
    [items],
  )

  const openQuote = (r: IngRow) => {
    setQuoteIngId(String(r.id))
    setQuoteOpen(true)
  }

  const openCalib = (r: IngRow) => {
    setCalibTarget({
      id: String(r.id),
      name: r.name,
      unit: r.unit,
      stock: r.stock,
      qty: r.qty,
      avg: r.avg,
    })
    setCalibOpen(true)
  }

  /**
   * W3-03 / FP-ING-11 删除原料：走 ing.delete（引用保护）。
   * 有流水/单据/报价/销售/配方引用会被执行器驳回——错误信息里直接给出正解「改为停用」，
   * 并顺手弹一个「改为停用」的一步确认（红线 #6：不物理删台账）。
   */
  const removeIng = async (r: IngRow) => {
    setBusy(true)
    try {
      const res = await submitIngDelete({ id: String(r.id) })
      if (res.error) {
        Modal.confirm({
          title: '该原料不能删除',
          content: res.error,
          okText: '改为停用',
          cancelText: '取消',
          onOk: async () => {
            try {
              await submitIngDisable({ id: String(r.id), on: false })
              message.success('已停用（历史台账保留）')
              load()
            } catch (e: unknown) {
              const err = e as { response?: { data?: { error?: string } } }
              message.error(err.response?.data?.error || '停用失败')
            }
          },
        })
        return
      }
      if (res.settled) message.success('已删除')
      else if (res.confirmed) message.success('删除已入队，待审批中心确认')
      else message.success('已提交，待确认')
      load()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '删除失败')
    } finally {
      setBusy(false)
    }
  }

  const selectedRows = useMemo(
    () => items.filter((g) => selectedKeys.some((k) => String(k) === String(g.id))),
    [items, selectedKeys],
  )

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
    {
      title: '当前量',
      key: 'stock',
      width: 100,
      align: 'right',
      sorter: (a, b) => (a.stock ?? a.qty ?? 0) - (b.stock ?? b.qty ?? 0),
      render: (_, r) => r.stock ?? r.qty ?? 0,
    },
    {
      title: '状态',
      key: 'status',
      width: 90,
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
      width: 200,
      render: (_, r) => (
        <Space size={0}>
          <Button size="small" type={r.pending ? 'primary' : 'default'} onClick={() => openEdit(r)}>
            {r.pending ? '完善' : '编辑'}
          </Button>
          {/* W3-04 / FP-ING-13：行内比价（录一条外部报价 → quote.upsert 审批入队）。
              耗材不参与比价（W4 决策 #4），故耗材行不露入口（原料比价主表本就不收耗材）。 */}
          {(r as IngRow & { type?: string }).type !== 'consumable' && (
            <Button size="small" type="link" onClick={() => openQuote(r)}>
              比价
            </Button>
          )}
          {/* W3-01 / FP-ING-05 手工校准：独立弹窗改存量（库存/均价），与档案编辑分开 */}
          <Button size="small" type="link" onClick={() => openCalib(r)}>
            校准
          </Button>
          {/* W3-03 / FP-ING-11 删除原料：有引用会被执行器拒绝并提示改「停用」 */}
          <Popconfirm
            title={`删除原料「${r.name}」？`}
            description="有流水/单据/报价/销售/配方引用的原料会被拒绝删除（请改为停用）。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => removeIng(r)}
          >
            <Button size="small" type="link" danger>
              删
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  /* ---- W2 词条管理：申请 / 审核（上架·驳回） ---- */
  const reloadTerms = useCallback(() => {
    fetchIngTerms()
      .then((r) => setTerms(r.terms ?? []))
      .catch(() => setTerms([]))
  }, [])

  const submitTerm = async () => {
    if (!termName.trim()) {
      message.warning('请输入词条名')
      return
    }
    if (!termCat) {
      message.warning('请选择受控维度')
      return
    }
    setTermBusy(true)
    try {
      await submitTermUpsert({
        name: termName.trim(),
        category: termCat,
        aliases: termAliases.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      })
      message.success('已提交词条申请（待审核上架）')
      setTermName('')
      setTermCat('')
      setTermAliases('')
      reloadTerms()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '失败')
    } finally {
      setTermBusy(false)
    }
  }

  const setTermStatus = async (t: IngTerm, status: string) => {
    setTermBusy(true)
    try {
      await submitTermUpsert({ id: t.id, status })
      message.success(status === 'active' ? '已上架' : '已驳回/下架')
      reloadTerms()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '失败')
    } finally {
      setTermBusy(false)
    }
  }

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
            {/* W3-02 / FP-ING-06：勾选原料 → 批量改安全线/出成率（整批 1 条队列） */}
            <Button disabled={!selectedKeys.length} onClick={() => setBatchOpen(true)}>
              批量设置{selectedKeys.length ? `（${selectedKeys.length}）` : ''}
            </Button>
            <Button onClick={() => setTermOpen(true)}>词条管理</Button>
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
            <span style={{ color: '#999', fontSize: 12 }}>点击行首 ▸ 查看单位 / 包规 / 供应商 / 均价等详情</span>
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
            rowSelection={{
              selectedRowKeys: selectedKeys,
              onChange: (keys) => setSelectedKeys(keys),
              preserveSelectedRowKeys: true,
            }}
            expandable={{
              expandedRowRender: renderDetail,
              expandRowByClick: true,
            }}
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
          /* W2：标签/属性从主数据 payload 中剥离，独立走 ing.attr_set（不混入成本/库存口径） */
          const { tags: formTags, ...rest } = v
          /* W3 产品超链接：质检报告只在用户改动过时才带该键（清空则显式传 ''）——未改动不写键，存量不被污染 */
          const qcUrl = String(v.qc_report_url ?? '').trim()
          const prevQcUrl = String(current?.qc_report_url ?? '').trim()
          if (qcUrl === prevQcUrl) delete rest.qc_report_url
          else rest.qc_report_url = qcUrl
          const payload = {
            ...rest,
            pending,
            // 出成率：表单存百分比（5~100），提交时折算为分数（0.05~1）
            yld: v.yld == null ? undefined : Math.min(1, Math.max(0.05, Number(v.yld) / 100)),
            // 结构化换算字段：成本折算口径的唯一可靠来源（替代名称正则抠规格）
            base_unit: v.base_unit || undefined,
            pack_in_base: v.pack_in_base == null || v.pack_in_base === '' ? undefined : Number(v.pack_in_base),
          }
          setBusy(true)
          try {
            const r = await submitAndConfirmAction({
              type: 'ing.upsert',
              payload,
              operator: 'admin',
            })
            const newTags = (Array.isArray(formTags) ? formTags : [])
              .map((t: string) => String(t).trim())
              .filter(Boolean)
            const oldTags = current?.tags ?? []
            if (newTags.join('\u0001') !== oldTags.join('\u0001')) {
              const attrPayload: { tags: string[]; id?: string; name?: string } = { tags: newTags }
              if (current?.id) attrPayload.id = current.id
              else attrPayload.name = String(v.name ?? '').trim()
              await submitIngAttrSet(attrPayload)
            }
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
          <Form.Item
            name="tags"
            label="标签 / 属性（受控词条 + 自定义）"
            extra="选择标准词条（产地/部位/颜色…），也可直接输入自定义营销 Tag。仅用于检索与归类，不影响成本与库存。"
          >
            <Select
              mode="multiple"
              allowClear
              placeholder="选标准词条，或输入自定义 Tag"
              options={termOptions}
              optionFilterProp="label"
              tokenSeparators={[',', '，']}
            />
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
              <Form.Item
                name="qc_report_url"
                label="质检报告链接"
                extra={
                  <>
                    仅保存链接（报告本体独立存储，主数据不臃肿）；留空保存即清除已登记链接。
                    {current && safeHref(current.qc_report_url) ? (
                      <>
                        {' '}当前：
                        <a href={safeHref(current.qc_report_url)!} target="_blank" rel="noopener noreferrer">查看报告</a>
                      </>
                    ) : null}
                  </>
                }
              >
                <Input placeholder="https://oss.example.com/qc/ing-I1.pdf" />
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
                <Form.Item name="base_unit" label="基础单位" style={{ width: 130 }}>
                  <Select
                    allowClear
                    placeholder="成本折算口径"
                    options={[
                      { value: 'g', label: 'g（重量）' },
                      { value: 'ml', label: 'ml（体积）' },
                      { value: '个', label: '个（计数）' },
                    ]}
                  />
                </Form.Item>
                <Form.Item name="pack_in_base" label="每包基础量" style={{ width: 140 }}>
                  <InputNumber min={0} step={0.1} style={{ width: '100%' }} placeholder="如 1900" />
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

      <Modal
        title="受控词条管理（申请 → 审核 → 上架）"
        open={termOpen}
        onCancel={() => setTermOpen(false)}
        footer={null}
        width={780}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="受控词条按「产地/颜色/部位/等级/品种/规格/包装/口味」归类，多别名归一到同一词条。新词条默认「待审核」，审核上架后原料才能选用。"
          />
          <Space wrap>
            <Input
              placeholder="词条名（如：云南）"
              style={{ width: 160 }}
              value={termName}
              onChange={(e) => setTermName(e.target.value)}
            />
            <Select
              placeholder="受控维度"
              style={{ width: 120 }}
              value={termCat || undefined}
              onChange={(v) => setTermCat(v)}
              options={['产地', '颜色', '部位', '等级', '品种', '规格', '包装', '口味'].map((c) => ({
                label: c,
                value: c,
              }))}
            />
            <Input
              placeholder="别名（逗号分隔，如：云南产地,产自云南）"
              style={{ width: 280 }}
              value={termAliases}
              onChange={(e) => setTermAliases(e.target.value)}
            />
            <Button type="primary" loading={termBusy} onClick={submitTerm}>
              申请词条
            </Button>
          </Space>
          <Table<IngTerm>
            rowKey="id"
            size="small"
            dataSource={terms}
            pagination={false}
            columns={[
              { title: 'ID', dataIndex: 'id', width: 70 },
              { title: '词条名', dataIndex: 'name', width: 120 },
              { title: '维度', dataIndex: 'category', width: 80 },
              {
                title: '别名',
                dataIndex: 'aliases',
                render: (a: string[]) => (a?.length ? a.join('、') : '-'),
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 90,
                render: (s: string) =>
                  s === 'active' ? (
                    <Tag color="green">已上架</Tag>
                  ) : s === 'pending' ? (
                    <Tag color="orange">待审核</Tag>
                  ) : (
                    <Tag>已驳回</Tag>
                  ),
              },
              {
                title: '操作',
                key: 'act',
                width: 140,
                render: (_, t) =>
                  t.status === 'pending' ? (
                    <Space size={4}>
                      <Button size="small" type="primary" onClick={() => setTermStatus(t, 'active')}>
                        上架
                      </Button>
                      <Button size="small" onClick={() => setTermStatus(t, 'rejected')}>
                        驳回
                      </Button>
                    </Space>
                  ) : t.status === 'active' ? (
                    <Button size="small" onClick={() => setTermStatus(t, 'rejected')}>
                      下架
                    </Button>
                  ) : (
                    <Button size="small" type="primary" onClick={() => setTermStatus(t, 'active')}>
                      重新上架
                    </Button>
                  ),
              },
            ]}
          />
        </Space>
      </Modal>

      {/* W3-04 / FP-ING-13：原料行内「比价」→ 复用供应商比价页的报价录入弹窗（同一 quote.upsert 口径） */}
      <QuoteEntryModal
        open={quoteOpen}
        ings={quoteIngs}
        defaultIngId={quoteIngId}
        onCancel={() => setQuoteOpen(false)}
      />

      {/* W3-01 / FP-ING-05：手工校准（存量为唯一改动对象，走 stock.count） */}
      <StockCalibrateModal
        open={calibOpen}
        ing={calibTarget}
        onCancel={() => setCalibOpen(false)}
        onDone={() => {
          setCalibOpen(false)
          load()
        }}
      />

      {/* W3-02 / FP-ING-06：批量设置安全线/出成率（整批一个 ing.batch 动作） */}
      <StockBatchModal
        open={batchOpen}
        ids={selectedRows.map((g) => String(g.id))}
        names={selectedRows.map((g) => g.name)}
        onCancel={() => setBatchOpen(false)}
        onDone={() => {
          setBatchOpen(false)
          setSelectedKeys([])
          load()
        }}
      />
    </div>
  )
}
