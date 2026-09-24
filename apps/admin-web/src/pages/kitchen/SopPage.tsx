import { useCallback, useEffect, useState } from 'react'
import { Card, Select, Space, Spin, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchKitchenRecipe, fetchKitchenRecipes } from '../../api'
import type { RecipeItem, SopStep } from '../../api/types'
import ColorBadge from './components/ColorBadge'
import MockAlert from './components/MockAlert'
import { STAGE_ORDER } from './colorMeta'
import { MOCK_RECIPES, MOCK_SOP_STEPS } from './mock'
import { COLORS } from '../../theme'

export default function SopPage() {
  const [recipes, setRecipes] = useState<RecipeItem[]>([])
  const [skuId, setSkuId] = useState<string | null>(null)
  const [steps, setSteps] = useState<SopStep[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(false)

  const loadSteps = useCallback((sku: string) => {
    setLoading(true)
    fetchKitchenRecipe(sku)
      .then((resp) => setSteps(resp.steps ?? []))
      .catch(() => {
        setSteps(MOCK_SOP_STEPS)
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    fetchKitchenRecipes()
      .then((resp) => {
        const list = resp.items ?? []
        setRecipes(list)
        if (list.length > 0) {
          setSkuId(list[0].sku_id)
          loadSteps(list[0].sku_id)
        }
      })
      .catch(() => {
        setRecipes(MOCK_RECIPES)
        setIsMock(true)
        if (MOCK_RECIPES.length > 0) {
          setSkuId(MOCK_RECIPES[0].sku_id)
          setSteps(MOCK_SOP_STEPS)
        }
      })
  }, [loadSteps])

  const current = recipes.find((r) => r.sku_id === skuId)

  /* 按 STAGE_ORDER 排序（未知阶段排最后），stage 列可筛选 */
  const sorted = [...steps].sort((a, b) => {
    const ia = STAGE_ORDER.indexOf(a.stage)
    const ib = STAGE_ORDER.indexOf(b.stage)
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    return a.step_no - b.step_no
  })

  const stages = [...new Set(steps.map((s) => s.stage))]

  const columns: ColumnsType<SopStep> = [
    {
      title: '阶段',
      dataIndex: 'stage',
      width: 90,
      filters: stages.map((s) => ({ text: s, value: s })),
      onFilter: (v, r) => r.stage === v,
      render: (v: string) => <Tag color={COLORS.purple}>{v}</Tag>,
    },
    { title: '序号', dataIndex: 'step_no', width: 64, align: 'center' },
    {
      title: '时长',
      dataIndex: 'duration_min',
      width: 90,
      align: 'right',
      render: (v) => (v == null ? '-' : `${v} min`),
    },
    {
      title: '工具',
      dataIndex: 'tools',
      width: 130,
      render: (v: string | string[] | undefined) =>
        Array.isArray(v) ? v.join('、') : v ?? '-',
    },
    { title: '投料', dataIndex: 'inputs', width: 200, render: (v) => v ?? '-' },
    { title: '关键点', dataIndex: 'key_points', render: (v) => v ?? '-' },
    {
      title: '质检点',
      dataIndex: 'qc_point',
      width: 180,
      render: (v) =>
        v ? <Typography.Text type="warning">{v}</Typography.Text> : '-',
    },
    {
      title: '风险',
      dataIndex: 'risk',
      width: 180,
      render: (v) =>
        v ? <Typography.Text type="danger">{v}</Typography.Text> : '-',
    },
  ]

  return (
    <Card
      title={
        <Space>
          SOP 步骤
          {current && <ColorBadge color={current.color} />}
          {current && <span>{current.name}</span>}
        </Space>
      }
      extra={
        <Select
          style={{ width: 220 }}
          placeholder="选择配方"
          value={skuId ?? undefined}
          onChange={(v) => {
            setSkuId(v)
            loadSteps(v)
          }}
          options={recipes.map((r) => ({
            value: r.sku_id,
            label: `${r.name}（${r.sku_id}）`,
          }))}
        />
      }
    >
      {isMock && <MockAlert endpoint="/api/kitchen/recipes/{sku_id}" />}
      <Spin spinning={loading}>
        <Table<SopStep>
          rowKey={(r) => `${r.stage}-${r.step_no}`}
          columns={columns}
          dataSource={sorted}
          pagination={false}
        />
      </Spin>
    </Card>
  )
}
