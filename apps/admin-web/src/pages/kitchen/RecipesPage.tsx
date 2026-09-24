import { useEffect, useMemo, useState } from 'react'
import {
  Card,
  Col,
  Descriptions,
  Empty,
  Row,
  Space,
  Tag,
  Timeline,
  Typography,
} from 'antd'
import { fetchKitchenRecipes } from '../../api'
import type { RecipeItem } from '../../api/types'
import ColorBadge from './components/ColorBadge'
import BomTable from './components/BomTable'
import MockAlert from './components/MockAlert'
import { colorMeta, colorOrderKey, FIVE_COLOR_ORDER } from './colorMeta'
import { MOCK_RECIPES } from './mock'
import { COLORS } from '../../theme'

export default function RecipesPage() {
  const [items, setItems] = useState<RecipeItem[]>([])
  const [isMock, setIsMock] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    fetchKitchenRecipes()
      .then((resp) => {
        const list = resp.items ?? []
        setItems(list)
        if (list.length > 0) setSelectedId(list[0].sku_id)
      })
      .catch(() => {
        setItems(MOCK_RECIPES)
        setIsMock(true)
        if (MOCK_RECIPES.length > 0) setSelectedId(MOCK_RECIPES[0].sku_id)
      })
  }, [])

  /* 按五色分组（红/黄/绿/紫/黑顺序），其余颜色排最后 */
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

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/kitchen/recipes" />}
      <Row gutter={16}>
        {/* 左侧：五色分组配方列表 */}
        <Col xs={24} md={7} lg={6}>
          <Card title="配方列表" size="small" styles={{ body: { maxHeight: '72vh', overflow: 'auto' } }}>
            {grouped.length === 0 && (
              <Empty description="暂无配方数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
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
                    <span
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 3,
                        background: meta.hex,
                        border: '1px solid rgba(0,0,0,0.15)',
                      }}
                    />
                    {meta.label}色系（{list.length}）
                  </div>
                  {list.map((r) => (
                    <div
                      key={r.sku_id}
                      onClick={() => setSelectedId(r.sku_id)}
                      style={{
                        padding: '8px 12px',
                        marginBottom: 6,
                        borderRadius: 8,
                        cursor: 'pointer',
                        borderLeft: `4px solid ${meta.hex}`,
                        background:
                          r.sku_id === selectedId ? '#f0e9f7' : '#fafafa',
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

        {/* 右侧：配方详情 */}
        <Col xs={24} md={17} lg={18}>
          {!selected ? (
            <Card>
              <Empty description="请选择左侧配方查看详情" />
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
                <Tag color={COLORS.purple}>
                  色源锁定：{colorMeta(selected.color).source}
                </Tag>
              }
            >
              {selected.blessing && (
                <div
                  className="ai-gradient-text"
                  style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}
                >
                  寓意 · {selected.blessing}
                </div>
              )}

              <Space style={{ marginBottom: 16 }} wrap>
                {(selected.diet_tags ?? []).map((t) => (
                  <Tag key={t} color={COLORS.yellow}>
                    忌口 · {t}
                  </Tag>
                ))}
                {selected.updated_at && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    更新于 {new Date(selected.updated_at).toLocaleString('zh-CN')}
                  </Typography.Text>
                )}
              </Space>

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
    </div>
  )
}
