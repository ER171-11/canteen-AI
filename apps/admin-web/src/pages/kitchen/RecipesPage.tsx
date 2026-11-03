import { useCallback, useEffect, useMemo, useState } from 'react'
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
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd'
import { fetchAdminDishes, fetchKitchenRecipe, fetchKitchenRecipes, fetchSnapshot, submitAndConfirmAction } from '../../api'
import type { CostCard, Dish, RecipeItem } from '../../api/types'
import { calcLineCost, resolveIngName } from '../../lib/recipeCostCore'
import ColorBadge from './components/ColorBadge'
import BomTable from './components/BomTable'
import StandardRecipeCard from './components/StandardRecipeCard'
import RecipeImportModal from './components/RecipeImportModal'
import MockAlert from './components/MockAlert'
import { downloadRecipeTemplate } from './recipeTemplate'
import { colorMeta, colorOrderKey, FIVE_COLOR_ORDER } from './colorMeta'
import { COLORS } from '../../theme'

type BomFormLine = { name?: string; qty?: number; unit?: string }
type IngOpt = { id: string; name: string; unit?: string; avg?: number; yld?: number }

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
  const [ingAlias, setIngAlias] = useState<Record<string, string>>({})
  const [isMock, setIsMock] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<RecipeItem | null>(null)
  const [costCard, setCostCard] = useState<CostCard | null>(null)
  const [costCardMiss, setCostCardMiss] = useState(false)
  const [dishes, setDishes] = useState<Dish[]>([])
  const [form] = Form.useForm()

  /* 编辑弹窗实时成本：Form.useWatch([]) 监听整表，任一改动触发重渲染 */
  const watched = Form.useWatch([], form) as Record<string, unknown> | undefined
  const linesOf = useCallback(
    (key: 'main' | 'aux' | 'seasoning') => (watched?.[key] as BomFormLine[] | undefined) || [],
    [watched],
  )
  /* 原料名 → IngOpt 索引（供 resolveIngName 精确命中） */
  const byName = useMemo(() => {
    const m: Record<string, IngOpt> = {}
    for (const g of ings) if (g.name) m[g.name] = g
    return m
  }, [ings])
  const bomSummary = useMemo(() => {
    let total = 0
    for (const k of ['main', 'aux', 'seasoning'] as const) {
      for (const line of linesOf(k)) {
        const ing = line?.name ? resolveIngName(line.name, ingAlias, byName) : undefined
        const c = calcLineCost(line?.qty, ing)
        if (c?.lineCost != null) total += c.lineCost
      }
    }
    const price = Number(watched?.price)
    return { total, gm: price > 0 ? (price - total) / price : null, price }
  }, [watched, linesOf, ingAlias, byName])

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
        const alias = (snap.data?.config as { ing_alias?: unknown } | undefined)?.ing_alias
        setIngAlias(
          alias && typeof alias === 'object' && !Array.isArray(alias)
            ? (alias as Record<string, string>)
            : {},
        )
      })
      .catch(() => {
        setIngs([])
        setIngAlias({})
      })
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
      <RecipeImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onQueued={load}
      />
      <Row gutter={16}>
        <Col xs={24} md={7} lg={6}>
          <Card
            title="配方列表"
            size="small"
            extra={
              <Space size={0}>
                {/* FP-DISH-16/17：批量导入食谱卡 + 下载模板（旧版 #tab-dish 工具条同款入口） */}
                <Button type="link" size="small" onClick={() => setImportOpen(true)}>
                  批量导入
                </Button>
                <Button type="link" size="small" onClick={downloadRecipeTemplate}>
                  下载模板
                </Button>
                <Button type="link" size="small" onClick={() => openEdit(null)}>
                  新增
                </Button>
              </Space>
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
                  <Tag color={COLORS.purple}>主料说明：{colorMeta(selected.color).source}</Tag>
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
                        <Descriptions.Item label="每只成本">
                          {costCard.unit_cost != null ? `¥${Number(costCard.unit_cost).toFixed(2)}` : '-'}
                        </Descriptions.Item>
                        <Descriptions.Item label="售价">
                          {costCard.price != null ? `¥${Number(costCard.price).toFixed(2)}` : '-'}
                        </Descriptions.Item>
                        <Descriptions.Item label="毛利率">
                          {/* BFF 下发百分比（88.9）；兼容历史小数形态（≤1 视为比例） */}
                          {costCard.gross_margin != null
                            ? `${(Number(costCard.gross_margin) <= 1
                                ? Number(costCard.gross_margin) * 100
                                : Number(costCard.gross_margin)
                              ).toFixed(1)}%`
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
              {costCard && (costCard.bom_lines?.length ?? 0) > 0 ? (
                <StandardRecipeCard recipe={selected} card={costCard} />
              ) : (
                <>
                  <Typography.Title level={5}>主料说明 face_main</Typography.Title>
                  <BomTable data={selected.face_main} />
                  <Typography.Title level={5} style={{ marginTop: 16 }}>
                    主料 main
                  </Typography.Title>
                  <BomTable data={selected.main} />
                  <Typography.Title level={5} style={{ marginTop: 16 }}>
                    辅料 aux
                  </Typography.Title>
                  <BomTable data={selected.aux} />
                  <Typography.Title level={5} style={{ marginTop: 16 }}>
                    调料 seasoning
                  </Typography.Title>
                  <BomTable data={selected.seasoning} />
                </>
              )}

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

              {(!costCard || !(costCard.bom_lines && costCard.bom_lines.length)) && (
                <>
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
                </>
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
            // 缺料拦截（单向原则）：引用未在产品库建档的原料，列出并阻断保存
            const knownNames = new Set((ings || []).map((g) => String(g.name)))
            const missing: string[] = []
            for (const key of ['main', 'aux', 'seasoning']) {
              for (const l of (v[key] || []) as BomFormLine[]) {
                const nm = l?.name ? String(l.name).trim() : ''
                if (!nm || nm === '清水' || nm === '水' || nm === '料水') continue
                if (!knownNames.has(nm) && missing.indexOf(nm) < 0) missing.push(nm)
              }
            }
            if (missing.length) {
              message.error('缺料未建档：' + missing.join('、') + '（请先在原料仓建档）')
              setBusy(false)
              return
            }
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
          配料须先从进销存产品库建档后选择；用量与单位按菜谱口径填写，系统自动按原料换算成本。
        </Typography.Paragraph>
        <Form form={form} layout="vertical">
          <Form.Item name="sku_id" hidden>
            <Input />
          </Form.Item>
          <Space style={{ width: '100%' }} size={12}>
            <Form.Item name="name" label="菜谱名" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input placeholder="如：招牌红烧肉" />
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
            <Form.Item name="filling" label="副标题" style={{ flex: 1 }}>
              <Input />
            </Form.Item>
            <Form.Item name="face_main" label="主料说明" style={{ flex: 1 }}>
              <Input placeholder="如：五花肉500g" />
            </Form.Item>
          </Space>
          <Space style={{ width: '100%' }} size={12}>
            <Form.Item name="price" label="售价" style={{ width: 140 }}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="cost" label="成本" style={{ width: 140 }}>
              <InputNumber min={0} style={{ width: '100%' }} />
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
                      {key === 'main' ? '主料' : key === 'aux' ? '辅料' : '调料'}
                    </Typography.Text>
                    <Button type="link" size="small" onClick={() => add({ unit: 'g' })}>
                      + 行
                    </Button>
                  </div>
                  {fields.map((field) => {
                    const line = linesOf(key)[field.name] as BomFormLine | undefined
                    const ing = line?.name ? resolveIngName(line.name, ingAlias, byName) : undefined
                    const c = calcLineCost(line?.qty, ing, line?.unit)
                    return (
                      <Space
                        key={field.key}
                        align="start"
                        style={{
                          display: 'flex',
                          marginBottom: 8,
                          ...(c?.dimMismatch
                            ? { outline: '1px solid #D93025', borderRadius: 6, padding: 2, background: '#FFF6F6' }
                            : {}),
                        }}
                      >
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
                              /* 单向原则：原料仓只改「原料列」，严禁回写用量/单位（由菜谱侧自权威） */
                              next[field.name] = { ...(next[field.name] || {}), name }
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
                          <div
                            style={{
                              lineHeight: '30px',
                              textAlign: 'right',
                              color: c?.dimMismatch ? '#D93025' : undefined,
                              fontWeight: c?.dimMismatch ? 600 : undefined,
                            }}
                          >
                            {c?.dimMismatch ? '单位不兼容' : c?.lineCost != null ? c.lineCost.toFixed(2) : '—'}
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
                行成本 = 用量(按单位折算基础量) ÷ 出成率 × 均价
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
