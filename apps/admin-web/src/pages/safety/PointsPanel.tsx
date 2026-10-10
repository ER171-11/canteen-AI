import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Image,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { UploadProps } from 'antd'
import { ImportOutlined, PlusOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import axios from 'axios'
import {
  fetchSafetyPoints,
  presignSafetyPointDemo,
  removeSafetyPoint,
  seedSafetyPoints,
  signSafetyPointImages,
  upsertSafetyPoint,
} from '../../api'
import type { SafetyPoint, SafetyPointKind } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import PointEditModal from './PointEditModal'

interface Props {
  kind: SafetyPointKind
  title: string
}

export default function PointsPanel({ kind, title }: Props) {
  const canWrite = useAuthStore((s) => s.canWrite)
  const [points, setPoints] = useState<SafetyPoint[]>([])
  const [usingDefaults, setUsingDefaults] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [signMap, setSignMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<SafetyPoint | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchSafetyPoints(kind)
      .then(async (r) => {
        setPoints(r.points ?? [])
        setUsingDefaults(!!r.using_defaults)
        setConfigured(!!r.configured)
        const keys = (r.points ?? [])
          .filter((p) => !p.demo_image_url && p.demo_image_key)
          .map((p) => p.demo_image_key as string)
        if (r.configured && keys.length) {
          const signed = await signSafetyPointImages(keys)
          const map: Record<string, string> = {}
          signed.items.forEach((it) => {
            if (it.url) map[it.key] = it.url
          })
          setSignMap(map)
        } else setSignMap({})
      })
      .catch((e) => setError(String(e?.message || e)))
      .finally(() => setLoading(false))
  }, [kind])

  useEffect(() => {
    load()
  }, [load])

  const demoUrlOf = useCallback(
    (p: SafetyPoint) => p.demo_image_url || (p.demo_image_key ? signMap[p.demo_image_key] ?? null : null),
    [signMap],
  )

  const uploadDemoFor = useCallback(
    (row: SafetyPoint): UploadProps['customRequest'] => async ({ file, onSuccess, onError }) => {
      try {
        const f = file as File
        const pre = await presignSafetyPointDemo({
          kind,
          id: row.id,
          ext: (f.name.split('.').pop() || 'jpg').toLowerCase(),
          content_type: f.type || 'image/jpeg',
        })
        if (!pre.configured || !pre.upload_url) {
          message.warning(pre.note || '对象存储未配置，演示图暂不可用')
          onError?.(new Error('objstore not configured'))
          return
        }
        await axios.put(pre.upload_url, f, { headers: pre.headers })
        const res = await upsertSafetyPoint({
          id: row.id,
          name: row.name,
          zone: row.zone,
          kind,
          every30: row.every30,
          sort: row.sort,
          note: row.note,
          demo_image_key: pre.key,
          demo_image_url: pre.photo_url,
        })
        if (res.ok) message.success('演示图已入队，待审批中心确认后生效')
        else message.error(res.error || '演示图保存失败')
        onSuccess?.({}, f as unknown as XMLHttpRequest)
      } catch (e) {
        message.error('演示图上传失败，请重试')
        onError?.(e as Error)
      }
    },
    [kind],
  )

  const doSeed = async () => {
    const res = await seedSafetyPoints(kind)
    if (res.ok) message.success(res.note || '默认点位导入已入队')
    else message.error(res.error || '导入失败')
  }

  const doRemove = async (row: SafetyPoint) => {
    const res = await removeSafetyPoint({ id: row.id, kind })
    if (res.ok) message.success(res.note || '删除已入队，待审批中心确认')
    else message.error(res.error || '删除失败')
  }

  const cols: ColumnsType<SafetyPoint> = useMemo(
    () => [
      {
        title: '点位名称',
        dataIndex: 'name',
        render: (v: string, r) => (
          <Space size={4}>
            <span style={{ fontWeight: 600 }}>{v}</span>
            {kind === 'inspection' && r.every30 === 1 && <Tag color="gold">30min</Tag>}
          </Space>
        ),
      },
      { title: kind === 'inspection' ? '所属板块' : '所属区域', dataIndex: 'zone', width: 120 },
      {
        title: '规范演示图',
        dataIndex: 'demo_image_key',
        width: 140,
        render: (_: unknown, r) => {
          const url = demoUrlOf(r)
          if (url) {
            return <Image src={url} width={84} height={56} style={{ objectFit: 'cover', borderRadius: 6 }} />
          }
          if (!r.demo_image_key) return <Typography.Text type="secondary">未上传</Typography.Text>
          return <Tag color={configured ? 'default' : 'red'}>{configured ? '待换签' : '图片不可用'}</Tag>
        },
      },
      { title: '排序', dataIndex: 'sort', width: 70 },
      {
        title: '操作',
        key: 'op',
        width: 190,
        render: (_, r) => (
          <Space size={4}>
            <Button
              size="small"
              disabled={!canWrite}
              onClick={() => {
                setEditing(r)
                setEditOpen(true)
              }}
            >
              编辑
            </Button>
            <Upload accept="image/*" showUploadList={false} customRequest={uploadDemoFor(r)}>
              <Button size="small" icon={<UploadOutlined />} disabled={!canWrite || !configured}>
                演示图
              </Button>
            </Upload>
            <Popconfirm
              title="删除该点位？"
              description="逻辑删除，历史台账保留"
              onConfirm={() => doRemove(r)}
              disabled={!canWrite}
            >
              <Button size="small" danger disabled={!canWrite}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [kind, canWrite, configured, demoUrlOf, uploadDemoFor],
  )

  return (
    <Card
      size="small"
      title={`${title}（${points.length}）`}
      style={{ marginBottom: 16 }}
      extra={
        <Space>
          {usingDefaults && (
            <Tooltip title="把内置默认点位落库为可编辑点位（一次审批，幂等）">
              <Button size="small" icon={<ImportOutlined />} disabled={!canWrite} onClick={doSeed}>
                导入默认点位
              </Button>
            </Tooltip>
          )}
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            disabled={!canWrite}
            onClick={() => {
              setEditing(null)
              setEditOpen(true)
            }}
          >
            新增点位
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
        </Space>
      }
    >
      {error && (
        <Alert type="error" showIcon style={{ marginBottom: 12 }} message="点位加载失败" description={error} />
      )}
      {usingDefaults && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="当前展示内置默认点位"
          description="尚无自定义点位，巡检/消毒统计暂用内置默认；新增或「导入默认点位」后将以此为唯一清单。"
        />
      )}
      {!configured && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="对象存储未配置"
          description="演示图暂不可用（点位管理其余功能不受影响）。配置 OSS_* 环境变量后即可上传。"
        />
      )}
      <Table<SafetyPoint>
        rowKey="id"
        size="small"
        loading={loading}
        columns={cols}
        dataSource={points}
        pagination={points.length > 12 ? { pageSize: 12, size: 'small' } : false}
      />
      <PointEditModal
        open={editOpen}
        kind={kind}
        point={editing}
        configured={configured}
        demoUrl={editing ? demoUrlOf(editing) : null}
        onCancel={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false)
          load()
        }}
      />
    </Card>
  )
}
