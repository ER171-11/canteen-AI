import { useCallback, useEffect, useMemo, useState } from 'react'
import {
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
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd'
import { fetchKitchenRecipes, fetchSnapshot, submitConfirmedAction } from '../../api'
import type { RecipeItem } from '../../api/types'
import ColorBadge from './components/ColorBadge'
import BomTable from './components/BomTable'
import MockAlert from './components/MockAlert'
import { colorMeta, colorOrderKey, FIVE_COLOR_ORDER } from './colorMeta'
import { MOCK_RECIPES } from './mock'
import { COLORS } from '../../theme'

type BomFormLine = { name?: string; qty?: number; unit?: string }
type IngOpt = { id: string; name: string; unit?: string }

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
  const [form] = Form.useForm()

  const load = useCallback(() => {
    fetchKitchenRecipes()
      .then((resp) => {
        const list = resp.items ?? []
        setItems(list)
        setIsMock(false)
        if (list.length > 0 && !selectedId) setSelectedId(list[0].sku_id)
      })
      .catch(() => {
        setItems(MOCK_RECIPES)
        setIsMock(true)
        if (MOCK_RECIPES.length > 0) setSelectedId(MOCK_RECIPES[0].sku_id)
      })
    fetchSnapshot()
      .then((snap) => {
        const raw = (snap.data?.ings as Array<{ id?: string; name?: string; unit?: string }>) || []
        setIngs(
          raw
            .filter((g) => g.name)
            .map((g) => ({ id: String(g.id || g.name), name: String(g.name), unit: g.unit })),
        )
      })
      .catch(() => setIngs([]))
  }, [selectedId])

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  const selected = items.find((r) => r.sku_id === selectedId) ?? null

  const openEdit = (r: RecipeItem | null) => {
    setEditing(r)
    form.setFieldsValue({
      sku_id: r?.sku_id,
      name: r?.name || '',
      color: r?.color || '红',
      filling: r?.filling || '',
      face_main: typeof r?.face_main === 'string' ? r.face_main : '',
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
        destroyOnClose
        onOk={async () => {
          const v = await form.validateFields()
          setBusy(true)
          try {
            const r = await submitConfirmedAction({
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
            message.success(r.confirmed ? '已确认，待消费器落库' : '已入队')
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
                  {fields.map((field) => (
                    <Space key={field.key} style={{ display: 'flex', marginBottom: 8 }} align="start">
                      <Form.Item
                        {...field}
                        name={[field.name, 'name']}
                        rules={[{ required: true, message: '原料名' }]}
                        style={{ width: 280, marginBottom: 0 }}
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
                      <Form.Item {...field} name={[field.name, 'qty']} style={{ width: 100, marginBottom: 0 }}>
                        <InputNumber min={0} placeholder="用量" style={{ width: '100%' }} />
                      </Form.Item>
                      <Form.Item {...field} name={[field.name, 'unit']} style={{ width: 80, marginBottom: 0 }}>
                        <Input placeholder="单位" />
                      </Form.Item>
                      <Button type="link" danger onClick={() => remove(field.name)}>
                        删
                      </Button>
                    </Space>
                  ))}
                </div>
              )}
            </Form.List>
          ))}
        </Form>
      </Modal>
    </div>
  )
}
