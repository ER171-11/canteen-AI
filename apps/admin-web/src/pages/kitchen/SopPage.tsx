import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Card,
  Input,
  List,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchKitchenRecipe, fetchKitchenRecipes, fetchSopVideos, postSopVideo } from '../../api'
import type { RecipeItem, SopStep, SopVideo } from '../../api/types'
import ColorBadge from './components/ColorBadge'
import MockAlert from './components/MockAlert'
import { STAGE_ORDER } from './colorMeta'
import { COLORS } from '../../theme'

export default function SopPage() {
  const [recipes, setRecipes] = useState<RecipeItem[]>([])
  const [skuId, setSkuId] = useState<string | null>(null)
  const [steps, setSteps] = useState<SopStep[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(false)
  const [videos, setVideos] = useState<SopVideo[]>([])
  const [videoTitle, setVideoTitle] = useState('')
  const [videoUrl, setVideoUrl] = useState('')
  const [binding, setBinding] = useState(false)

  const loadSteps = useCallback((sku: string) => {
    setLoading(true)
    fetchKitchenRecipe(sku)
      .then((resp) => setSteps(resp.steps ?? []))
      .catch(() => {
        setSteps([])
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
        setRecipes([])
        setIsMock(true)
      })
  }, [loadSteps])

  useEffect(() => {
    if (!skuId) {
      setVideos([])
      return
    }
    fetchSopVideos(skuId).then(setVideos).catch(() => setVideos([]))
  }, [skuId])

  const bindVideo = () => {
    if (!skuId) {
      message.warning('请先选择配方')
      return
    }
    if (!videoUrl.trim()) {
      message.warning('请填写视频托管 URL')
      return
    }
    setBinding(true)
    postSopVideo({
      sku_id: skuId,
      title: videoTitle.trim() || current?.name || skuId,
      video_url: videoUrl.trim(),
    })
      .then((r) => {
        if (r.ok) {
          message.success('已绑定视频教材')
          setVideoUrl('')
          setVideoTitle('')
          return fetchSopVideos(skuId)
        }
        throw new Error(r.error || 'bind failed')
      })
      .then(setVideos)
      .catch((e) => message.error(String(e?.message || e)))
      .finally(() => setBinding(false))
  }

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
    <>
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

      <Card title="视频教材" size="small" style={{ marginTop: 16 }}>
        <Typography.Paragraph type="secondary">
          视频本身不进本服务，仅绑定已托管好的视频 URL（对象存储 / 点播）。填写 URL 后绑定到当前菜品。
        </Typography.Paragraph>
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          <Space wrap>
            <Input
              placeholder="标题（缺省用菜品名）"
              style={{ width: 220 }}
              value={videoTitle}
              onChange={(e) => setVideoTitle(e.target.value)}
            />
            <Input
              placeholder="视频托管 URL（https://...）"
              style={{ width: 360 }}
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
            />
            <Button type="primary" loading={binding} onClick={bindVideo}>
              绑定到当前菜品
            </Button>
          </Space>
          {videos.length === 0 ? (
            <Typography.Text type="secondary">暂无视频教材，绑定后此处展示。</Typography.Text>
          ) : (
            <List
              size="small"
              dataSource={videos}
              renderItem={(v) => (
                <List.Item
                  actions={[
                    <a key="play" href={v.video_url} target="_blank" rel="noreferrer">
                      播放
                    </a>,
                  ]}
                >
                  <List.Item.Meta title={v.title || v.sku_id} description={v.video_url} />
                </List.Item>
              )}
            />
          )}
        </Space>
      </Card>
    </>
  )
}
