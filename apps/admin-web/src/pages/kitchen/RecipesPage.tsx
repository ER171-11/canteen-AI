import { useCallback, useEffect, useMemo, useState } from 'react'
import { rk } from '../../utils/rowKey'
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd'
import { fetchAdminDishes, fetchKitchenRecipe, fetchKitchenRecipes, fetchSnapshot, submitAndConfirmAction } from '../../api'
import type { CostCard, Dish, RecipeItem } from '../../api/types'
import ColorBadge from './components/ColorBadge'
import BomTable from './components/BomTable'
import MockAlert from './components/MockAlert'
import { colorMeta, colorOrderKey, FIVE_COLOR_ORDER } from './colorMeta'
import { COLORS } from '../../theme'

type BomFormLine = { name?: string; qty?: number; unit?: string }
type IngOpt = { id: string; name: string; unit?: string; avg?: number; yld?: number }

/** 单行成本预览：毛料消耗 = 净料用量 / 出成率；行成本 = 毛料 × 均价（元/库存单位） */
function calcLine(line: BomFormLine | undefined, ing: IngOpt | undefined) {
  const qty = Number(line?.qty)
  if (!ing || !(qty > 0)) return null
  const yld = ing.yld && ing.yld > 0 ? ing.yld : 1
  const gross = qty / yld
  const avg = typeof ing.avg === 'number' && isFinite(ing.avg) && ing.avg > 0 ? ing.avg : null
  return { gross, lc: avg != null ? gross * avg : null }
}

function linesFromBom(arr: RecipeItem['main']): BomFormLine[] {
  if (!arr?.length) return [{ name: '', qty: undefined, unit: 'g' }]
  return arr.map((e) => {
    if (typeof e === 'string') {
      const m = e.trim().match(/^(.+?)(\d+(?:\.\d+)?)([a-zA-Z\u4e00-\u9fff]+)?\s*$/)
      if (m) return { name: m[1].trim(), qty: Number(m[2]), unit: m[3] || 'g' }
      return { name: e, unit: 'g' }
    }
    const o = e as Record<string, string | number | undefined>
    return {
      name: String(o.name || o.ing || ''),
      qty: o.qty != null ? Number(o.qty) : undefined,
      unit: String(o.unit || 'g'),
    }
  })
}

export default function RecipesPage() {
  const [items, setItems] = useState<RecipeItem[]>([])
  const [ings, setIngs] = useState<IngOpt[]>([])
  const [isMock, setIsMock] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<RecipeItem | null>(null)
  const [costCard, setCostCard] = useState<CostCard | null>(null)
  const [costCardMiss, setCostCardMiss] = useState(false)
  const [dishes, setDishes] = useState<Dish[]>([])
  const [form] = Form.useForm()

  /* 编辑弹窗实时成本：Form.useWatch([]) 监听整表，任一改动触发重渲染 */
  const watched = Form.useWatch([], form) as Record<string, unknown> | undefined
  const linesOf = (key: 'main' | 'aux' | 'seasoning') =>
    (watched?.[key] as BomFormLine[] | undefined) || []
  const bomSummary = useMemo(() => {
    let total = 0
    for (const k of ['main', 'aux', 'seasoning'] as const) {
      for (const line of linesOf(k)) {
        const ing = line?.name ? ings.find((g) => g.name === line.name) : undefined
        const c = calcLine(line, ing)
        if (c?.lc != null) total += c.lc
      }
    }
    const price = Number(watched?.price)
    return { total, gm: price > 0 ? (price - total) / price : null, price }
  }, [watched, ings])

  const load = useCallback(() => {
    fetchKitchenRecipes()
      .then((resp) => {
        const list = resp.items ?? []
        setItems(list)
        setIsMock(false)
        if (list.length > 0 && !selectedId) setSelectedId(list[0].sku_id)
      })
      .catch(() => {
        setItems([])
        setIsMock(true)
      })
    fetchSnapshot()
      .then((snap) => {
        const raw =
          (snap.data?.ings as Array<{
            id?: string
            name?: string
            unit?: string
            avg?: number
            yld?: number
          }>) || []
        setIngs(
          raw
            .filter((g) => g.name)
            .map((g) => ({
              id: String(g.id || g.name),
              name: String(g.name),
              unit: g.unit,
              avg: g.avg,
              yld: g.yld,
            })),
        )
      })
      .catch(() => setIngs([]))
    fetchAdminDishes()
      .then((resp) => setDishes(resp.items ?? []))
      .catch(() => setDishes([]))
  }, [selectedId])

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* 选中配方后拉取成本卡（cost_card 未上线时回落静态价盘） */
  useEffect(() => {
    if (!selectedId || isMock) {
      setCostCard(null)
      setCostCardMiss(false)
      return
    }
    setCostCardMiss(false)
    fetchKitchenRecipe(selectedId)
      .then((resp) => {
        setCostCard(resp.cost_card ?? null)
        setCostCardMiss(!resp.cost_card)
      })
      .catch(() => {
        setCostCard(null)
        setCostCardMiss(true)
      })
  }, [selectedId, isMock])

  const selected = items.find((r) => r.sku_id === selectedId) ?? null

  const grouped = useMemo(() => {
    const map = new Map<string, RecipeItem[]>()
    for (const r of items) {
      const key = colorOrderKey(r.color)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(r)
    }
    const keys = [...map.keys()].sort((a, b) => {
      const ia = FIVE_COLOR_ORDER.indexOf(a)
      const ib = FIVE_COLOR_ORDER.indexOf(b)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
    return keys.map((k) => ({ color: k, list: map.get(k)! }))
  }, [items])

  /** 静态价盘：按 sku_id/名称匹配菜品库 */
  const staticDish = useMemo(() => {
    if (!selected) return null
    const bySku = dishes.find(
      (d) => String((d as Dish & { sku_id?: string }).sku_id || '') === selected.sku_id,
    )
    if (bySku) return bySku
    return (
      dishes.find((d) => d.name === selected.name) ??
      dishes.find((d) => d.name && selected.name.includes(d.name)) ??
      null
    )
  }, [dishes, selected])

  const openEdit = (r: RecipeItem | null) => {
    setEditing(r)
    form.setFieldsValue({
      sku_id: r?.sku_id,
      name: r?.name || '',
      color: r?.color || '红',
      filling: r?.filling || '',
      face_main:
        typeof r?.face_main === 'string'
          ? r.face_main
          : Array.isArray(r?.face_main)
            ? r.face_main
                .map((e) =>
                  typeof e === 'string' ? e : String((e as Record<string, unknown>).name ?? e),
                )
                .join('、')
            : '',
      price: undefined,
      cost: undefined,
      ensure_ings: true,
      sync_dish: true,
      main: linesFromBom(r?.main),
      aux: linesFromBom(r?.aux).filter((l) => l.name),
      seasoning: linesFromBom(r?.seasoning).filter((l) => l.name),
    })
    setEditOpen(true)
  }

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/kitchen/recipes" />}
      <Row gutter={16}>
        <Col xs={24} md={7} lg={6}>
          <Card
            title="配方列表"
            size="small"
            extra={
              <Button type="link" size="small" onClick={() => openEdit(null)}>
                新增
              </Button>
            }
            styles={{ body: { maxHeight: '72vh', overflow: 'auto' } }}
          >
            {grouped.length === 0 && (
              <Empty description="暂无配方 · 点右上角新增" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
            {grouped.map(({ color, list }) => {
              const meta = colorMeta(list[0]?.color)
              return (
                <div key={color} style={{ marginBottom: 16 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontWeight: 600,
                      marginBottom: 8,
                    }}
                  >
                    <ColorBadge color={list[0]?.color} />
                    <span>
                      {meta.label}（{list.length}）
                    </span>
                  </div>
                  {list.map((r) => (
                    <div
                      key={r.sku_id}
                      onClick={() => setSelectedId(r.sku_id)}
                      style={{
                        padding: '8px 10px',
                        marginBottom: 6,
                        borderRadius: 8,
                        cursor: 'pointer',
                        borderLeft: `4px solid ${meta.hex}`,
                        background: r.sku_id === selectedId ? '#f0e9f7' : '#fafafa',
                      }}
                    >
                      <div style={{ fontWeight: 500 }}>{r.name}</div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {r.filling ?? r.sku_id}
                      </Typography.Text>
                    </div>
                  ))}
                </div>
              )
            })}
          </Card>
        </Col>

        <Col xs={24} md={17} lg={18}>
          {!selected ? (
            <Card>
              <Empty description="请选择左侧配方，或新增一道菜谱" />
            </Card>
          ) : (
            <Card
              title={
                <Space>
                  <ColorBadge color={selected.color} />
                  <span>{selected.name}</span>
                  {selected.version && <Tag>{selected.version}</Tag>}
                </Space>
              }
              extra={
                <Space>
                  <Button type="primary" onClick={() => openEdit(selected)}>
                    编辑配料
                  </Button>
                  <Tag color={COLORS.purple}>色源：{colorMeta(selected.color).source}</Tag>
                </Space>
              }
            >
              {selected.blessing && (
                <div className="ai-gradient-text" style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>
                  寓意 · {selected.blessing}
                </div>
              )}

              <Typography.Title level={5}>
                成本卡
                {costCard ? (
                  <Tag color={COLORS.green} style={{ marginLeft: 8 }}>
                    动态均价
                  </Tag>
                ) : (
                  <Tag color={COLORS.yellow} style={{ marginLeft: 8 }}>
                    静态价盘
                  </Tag>
                )}
              </Typography.Title>
              {costCardMiss && !costCard && (
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="成本卡接口未下发 cost_card（BFF 待上线），以下展示菜品库静态价盘"
                />
              )}
              {costCard || staticDish ? (
                <Row gutter={16} style={{ marginBottom: 8 }}>
                  {costCard && (
                    <Col xs={24} md={12}>
                      <Descriptions
                        bordered
                        size="small"
                        column={2}
                        title={<span style={{ fontSize: 13 }}>动态成本（进销存均价）</span>}
                      >
                        <Descriptions.Item label="批成本">
                          {costCard.batch_cost != null ? `¥${Number(costCard.batch_cost).toFixed(2)}` : '-'}
                        </Descriptions.Item>
                        <Descriptions.Item label="份成本">
                          {costCard.unit_cost != null ? `¥${Number(costCard.unit_cost).toFixed(2)}` : '-'}
                        </Descriptions.Item>
                        <Descriptions.Item label="售价">
                          {costCard.price != null ? `¥${Number(costCard.price).toFixed(2)}` : '-'}
                        </Descriptions.Item>
                        <Descriptions.Item label="毛利率">
                          {costCard.gross_margin != null
                            ? `${(Number(costCard.gross_margin) * 100).toFixed(1)}%`
                            : '-'}
                        </Descriptions.Item>
                      </Descriptions>
                    </Col>
                  )}
                  {staticDish && (
                    <Col xs={24} md={costCard ? 12 : 24}>
                      <Descriptions
                        bordered
                        size="small"
                        column={2}
                        title={<span style={{ fontSize: 13 }}>静态价盘（菜品库）</span>}
                      >
                        <Descriptions.Item label="成本估">
                          {staticDish.est != null ? `¥${Number(staticDish.est).toFixed(2)}` : '-'}
                        </Descriptions.Item>
                        <Descriptions.Item label="售价">
                          {staticDish.price != null ? `¥${Number(staticDish.price).toFixed(2)}` : '-'}
                        </Descriptions.Item>
                        <Descriptions.Item label="毛利率">
                          {staticDish.price
                            ? `${(((Number(staticDish.price) - Number(staticDish.est ?? 0)) / Number(staticDish.price)) * 100).toFixed(1)}%`
                            : '-'}
                        </Descriptions.Item>
                        <Descriptions.Item label="状态">
                          {staticDish.on ? '上架中' : '已下架'}
                        </Descriptions.Item>
                      </Descriptions>
                    </Col>
                  )}
                </Row>
              ) : (
                <Typography.Text type="secondary">暂无成本数据</Typography.Text>
              )}
              {costCard && (costCard.missing_ings?.length ?? 0) > 0 && (
                <Alert
                  type="error"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message={`${costCard.missing_ings!.length} 项原料未建档/无均价：${costCard.missing_ings!.join('、')}`}
                />
              )}
              {costCard && (costCard.bom_lines?.length ?? 0) > 0 && (
                <Table
                  size="small"
                  rowKey={rk}
                  dataSource={costCard.bom_lines}
                  pagination={false}
                  style={{ marginBottom: 16 }}
                  columns={[
                    { title: '原料', dataIndex: 'name' },
                    { title: '用量', dataIndex: 'qty_text', width: 140, render: (v) => v ?? '-' },
                    {
                      title: '行成本',
                      dataIndex: 'line_cost',
                      width: 100,
                      align: 'right',
                      render: (v) => (v != null ? `¥${Number(v).toFixed(2)}` : '-'),
                    },
                    {
                      title: '均价',
                      dataIndex: 'matched',
                      width: 110,
                      render: (v: boolean | undefined) =>
                        v ? (
                          <Tag color={COLORS.green}>已匹配</Tag>
                        ) : (
                          <Tag color={COLORS.red}>未建档/无均价</Tag>
                        ),
                    },
                  ]}
                />
              )}

              <Typography.Title level={5}>面皮（色源）face_main</Typography.Title>
              <BomTable data={selected.face_main} />
              <Typography.Title level={5} style={{ marginTop: 16 }}>
                主馅 main
              </Typography.Title>
              <BomTable data={selected.main} />
              <Typography.Title level={5} style={{ marginTop: 16 }}>
                辅料 aux
              </Typography.Title>
              <BomTable data={selected.aux} />
              <Typography.Title level={5} style={{ marginTop: 16 }}>
                调味 seasoning
              </Typography.Title>
              <BomTable data={selected.seasoning} />

              <Typography.Title level={5} style={{ marginTop: 24 }}>
                工艺参数
              </Typography.Title>
              {selected.params && Object.keys(selected.params).length > 0 ? (
                <Descriptions bordered size="small" column={2}>
                  {Object.entries(selected.params).map(([k, v]) => (
                    <Descriptions.Item key={k} label={k}>
                      {String(v)}
                    </Descriptions.Item>
                  ))}
                </Descriptions>
              ) : (
                <span style={{ color: '#999' }}>未配置</span>
              )}

              <Typography.Title level={5} style={{ marginTop: 24 }}>
                制作步骤
              </Typography.Title>
              {selected.steps && selected.steps.length > 0 ? (
                <Timeline
                  items={selected.steps.map((s, i) => ({
                    color: colorMeta(selected.color).hex,
                    children: `${i + 1}. ${s}`,
                  }))}
                />
              ) : (
                <span style={{ color: '#999' }}>未配置</span>
              )}
            </Card>
          )}
        </Col>
      </Row>

      <Modal
        title={editing ? `编辑配料 · ${editing.name}` : '新增菜谱'}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        confirmLoading={busy}
        width={720}
        destroyOnHidden
        onOk={async () => {
          const v = await form.validateFields()
          setBusy(true)
          try {
            const r = await submitAndConfirmAction({
              type: 'recipe.upsert',
              payload: {
                sku_id: v.sku_id,
                name: v.name,
                color: v.color,
                filling: v.filling,
                face_main: v.face_main,
                main: (v.main || []).filter((l: BomFormLine) => l?.name),
                aux: (v.aux || []).filter((l: BomFormLine) => l?.name),
                seasoning: (v.seasoning || []).filter((l: BomFormLine) => l?.name),
                price: v.price,
                cost: v.cost,
                ensure_ings: v.ensure_ings,
                sync_dish: v.sync_dish,
              },
              operator: 'admin',
            })
            message.success(r.confirmed ? '已保存' : '已入队，待审批中心确认')
            setEditOpen(false)
            setTimeout(load, 2800)
          } catch (e: unknown) {
            const err = e as { response?: { data?: { error?: string } }; message?: string }
            message.error(err.response?.data?.error || err.message || '失败')
          } finally {
            setBusy(false)
          }
        }}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          配料优先从进销存产品库选择；勾选「缺料自动建档」会把未入库原料写入产品库。
        </Typography.Paragraph>
        <Form form={form} layout="vertical">
          <Form.Item name="sku_id" hidden>
            <Input />
          </Form.Item>
          <Space style={{ width: '100%' }} size={12}>
            <Form.Item name="name" label="菜谱名" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input placeholder="红色·冬菇荸荠饺" />
            </Form.Item>
            <Form.Item name="color" label="色别" style={{ width: 120 }}>
              <Select
                options={['红', '黑', '黄', '绿', '紫', '白', '热', '凉', '汤', '甜'].map((c) => ({
                  value: c,
                  label: c,
                }))}
              />
            </Form.Item>
          </Space>
          <Space style={{ width: '100%' }} size={12}>
            <Form.Item name="filling" label="馅心/副标题" style={{ flex: 1 }}>
              <Input />
            </Form.Item>
            <Form.Item name="face_main" label="面皮色源" style={{ flex: 1 }}>
              <Input placeholder="火龙果汁" />
            </Form.Item>
          </Space>
          <Space style={{ width: '100%' }} size={12}>
            <Form.Item name="price" label="售价" style={{ width: 140 }}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="cost" label="成本" style={{ width: 140 }}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="ensure_ings" label="缺料建档" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="sync_dish" label="同步菜品" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>

          {(['main', 'aux', 'seasoning'] as const).map((key) => (
            <Form.List key={key} name={key}>
              {(fields, { add, remove }) => (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <Typography.Text strong>
                      {key === 'main' ? '主馅' : key === 'aux' ? '辅料' : '调味'}
                    </Typography.Text>
                    <Button type="link" size="small" onClick={() => add({ unit: 'g' })}>
                      + 行
                    </Button>
                  </div>
                  {fields.map((field) => {
                    const line = linesOf(key)[field.name] as BomFormLine | undefined
                    const ing = line?.name ? ings.find((g) => g.name === line.name) : undefined
                    const c = calcLine(line, ing)
                    return (
                      <Space key={field.key} style={{ display: 'flex', marginBottom: 8 }} align="start">
                        <Form.Item
                          {...field}
                          name={[field.name, 'name']}
                          rules={[{ required: true, message: '原料名' }]}
                          style={{ width: 200, marginBottom: 0 }}
                        >
                          <Select
                            showSearch
                            allowClear
                            mode="tags"
                            placeholder={ings.length ? '从产品库选或输入' : '输入原料名'}
                            options={ings.map((g) => ({
                              value: g.name,
                              label: `${g.name}${g.unit ? ` · ${g.unit}` : ''}`,
                            }))}
                            optionFilterProp="label"
                            onChange={(val) => {
                              /* tags 模式允许自由输入新原料名：取最后一项并收敛为单值 */
                              const name = Array.isArray(val) ? val[val.length - 1] : val
                              const cur = form.getFieldValue(key) || []
                              const next = [...cur]
                              next[field.name] = { ...(next[field.name] || {}), name }
                              const hit = ings.find((g) => g.name === name)
                              if (hit?.unit) next[field.name].unit = hit.unit
                              form.setFieldValue(key, next)
                            }}
                          />
                        </Form.Item>
                        <Form.Item {...field} name={[field.name, 'qty']} style={{ width: 90, marginBottom: 0 }}>
                          <InputNumber min={0} placeholder="用量" style={{ width: '100%' }} />
                        </Form.Item>
                        <Form.Item {...field} name={[field.name, 'unit']} style={{ width: 70, marginBottom: 0 }}>
                          <Input placeholder="单位" />
                        </Form.Item>
                        <div style={{ width: 84 }}>
                          <div style={{ color: '#999', fontSize: 11, lineHeight: '20px' }}>毛料消耗</div>
                          <div style={{ lineHeight: '30px', textAlign: 'right' }}>
                            {c ? c.gross.toFixed(3) : '—'}
                          </div>
                        </div>
                        <div style={{ width: 84 }}>
                          <div style={{ color: '#999', fontSize: 11, lineHeight: '20px' }}>行成本</div>
                          <div style={{ lineHeight: '30px', textAlign: 'right' }}>
                            {c?.lc != null ? c.lc.toFixed(2) : '—'}
                          </div>
                        </div>
                        <Button type="link" danger onClick={() => remove(field.name)}>
                          删
                        </Button>
                      </Space>
                    )
                  })}
                </div>
              )}
            </Form.List>
          ))}

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '10px 12px',
              background: '#fafafa',
              borderRadius: 8,
              marginTop: 2,
            }}
          >
            <div>
              <Typography.Text strong>配方成本（实时）：</Typography.Text>
              <span style={{ color: '#D93025', fontWeight: 600 }}>{bomSummary.total.toFixed(2)}</span>
              <Typography.Text type="secondary"> 元/份</Typography.Text>
              <span style={{ marginLeft: 10, color: '#999', fontSize: 12 }}>
                行成本 = 净料用量 ÷ 出成率 × 均价
              </span>
            </div>
            <div>
              <Typography.Text strong>毛利率：</Typography.Text>
              <span
                style={{
                  color:
                    bomSummary.gm != null
                      ? bomSummary.gm >= 0.6
                        ? '#1E8E5A'
                        : bomSummary.gm >= 0.45
                          ? '#666'
                          : '#D93025'
                      : '#999',
                  fontWeight: 600,
                }}
              >
                {bomSummary.gm != null ? `${Math.round(bomSummary.gm * 100)}%` : '—'}
              </span>
              {bomSummary.price <= 0 && (
                <span style={{ marginLeft: 6, color: '#bbb', fontSize: 11 }}>填售价后显示</span>
              )}
            </div>
          </div>
        </Form>
      </Modal>
    </div>
  )
}
