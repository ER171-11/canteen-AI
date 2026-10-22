import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Card, Input, Progress, Spin, Tag, message } from 'antd'
import { CameraOutlined, CheckCircleOutlined, LeftOutlined } from '@ant-design/icons'
import { fetchSafetyPoints, postAction, applyAction } from '../../api'
import type { SafetyPoint } from '../../api/types'
import dayjs from 'dayjs'
import { useAuthStore } from '../../store/auth'
import { COLORS } from '../../theme'

interface ShotState {
  photoUrl: string | null
  note: string
  status: 'idle' | 'reporting' | 'done' | 'error'
}

const lsKey = (storeId?: string | null) =>
  `inspection_reported_${storeId || 'none'}_${new Date().toISOString().slice(0, 10)}`

/**
 * 闭店巡检（手机版执行界面）。
 * 对齐后端 algorithms/inspection.js 红线：照片只留本机，服务器只记「是否拍照 + 元数据」。
 * 上报走 postAction('inspection.record')，落沙盒库，不污染真实数据。
 */
export default function InspectionFlow({ onBack }: { onBack: () => void }) {
  const { account, storeId, storeName } = useAuthStore()
  const [points, setPoints] = useState<SafetyPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [shots, setShots] = useState<Record<string, ShotState>>({})
  const fileRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef<string | null>(null)

  useEffect(() => {
    let alive = true
    let reported: Record<string, { note?: string }> = {}
    try {
      reported = JSON.parse(localStorage.getItem(lsKey(storeId)) || '{}')
    } catch {
      reported = {}
    }
    fetchSafetyPoints('inspection')
      .then((r) => {
        if (!alive) return
        const pts = (r.points || []).filter((p) => p.enabled !== 0)
        setPoints(pts)
        setShots((prev) => {
          const next = { ...prev }
          for (const id of Object.keys(reported)) {
            if (pts.find((p) => p.id === id)) {
              next[id] = { photoUrl: null, note: reported[id].note || '', status: 'done' }
            }
          }
          return next
        })
      })
      .catch(() => message.error('巡检点位加载失败'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [storeId])

  const groups = useMemo(() => {
    const g: Record<string, SafetyPoint[]> = {}
    for (const p of points) {
      const z = p.zone || '未分区'
      ;(g[z] = g[z] || []).push(p)
    }
    Object.values(g).forEach((arr) => arr.sort((a, b) => a.sort - b.sort))
    return g
  }, [points])

  const total = points.length
  const doneCount = useMemo(
    () => Object.values(shots).filter((s) => s.status === 'done').length,
    [shots],
  )

  const pickPhoto = (nodeId: string) => {
    activeRef.current = nodeId
    fileRef.current?.click()
  }

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f || !activeRef.current) return
    const url = URL.createObjectURL(f)
    const id = activeRef.current
    setShots((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || { note: '' }), photoUrl: url, status: 'idle' },
    }))
  }

  const report = async (node: SafetyPoint) => {
    const s = shots[node.id] || { note: '' }
    if (!s.photoUrl) {
      message.warning('请先拍照（照片只留本机，服务器只记「已拍」）')
      return
    }
    setShots((prev) => ({ ...prev, [node.id]: { ...prev[node.id], status: 'reporting' } }))
    try {
      const enq = await postAction({
        type: 'inspection.record',
        operator: account ?? undefined,
        payload: {
          node_id: node.id,
          operator: account ?? undefined,
          store_id: storeId,
          photo_taken: true,
          done: true,
          note: s.note || undefined,
          ts: new Date().toISOString(),
          source: 'web',
          date: dayjs().format('YYYY-MM-DD'),
        },
      })
      if (!enq.ok) throw new Error(enq.error || '入队失败')
      // 现场拍照登记即生效：入队后直接执行（写入云端快照副本，电脑看板立即可见）
      const ap = await applyAction(enq.id, { operator: account ?? undefined })
      if (!ap.ok) throw new Error(ap.error || '执行失败')
      setShots((prev) => ({ ...prev, [node.id]: { ...prev[node.id], status: 'done' } }))
      const reported = JSON.parse(localStorage.getItem(lsKey(storeId)) || '{}')
      reported[node.id] = { note: s.note || '' }
      localStorage.setItem(lsKey(storeId), JSON.stringify(reported))
      message.success(`已上报：${node.name}`)
    } catch (e: unknown) {
      const err = e as { message?: string }
      setShots((prev) => ({ ...prev, [node.id]: { ...prev[node.id], status: 'error' } }))
      message.error('上报失败：' + (err.message || e))
    }
  }

  const clearPhoto = (nodeId: string) => {
    setShots((prev) => ({
      ...prev,
      [nodeId]: { ...(prev[nodeId] || { note: '' }), photoUrl: null, status: 'idle' },
    }))
  }

  if (loading) return <Spin style={{ display: 'block', margin: '40px auto' }} />

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Button type="text" size="small" icon={<LeftOutlined />} onClick={onBack} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>闭店巡检</div>
          <div style={{ fontSize: 11, color: COLORS.gray }}>
            {storeName || '本店'} · {total} 节点拍照留证
          </div>
        </div>
      </div>

      <Card>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
          }}
        >
          <span style={{ fontSize: 13, color: COLORS.gray }}>完成进度</span>
          <span style={{ fontSize: 15, fontWeight: 700 }}>
            {doneCount} / {total}
          </span>
        </div>
        <Progress
          percent={total ? Math.round((doneCount / total) * 100) : 0}
          showInfo={false}
          strokeColor={COLORS.green}
        />
        <div style={{ fontSize: 10, color: COLORS.gray, marginTop: 6 }}>
          照片只留本机，服务器仅记录「已拍 / 责任人 / 时间」
        </div>
      </Card>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={onFile}
      />

      {total === 0 && <div style={{ textAlign: 'center', color: COLORS.gray, padding: 24 }}>暂无可巡检点位</div>}

      {Object.entries(groups).map(([zone, list]) => (
        <div key={zone}>
          <div style={{ fontSize: 13, fontWeight: 700, margin: '4px 2px 8px', color: COLORS.purple }}>
            {zone}（{list.length}）
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {list.map((node) => {
              const s = shots[node.id] || { note: '', status: 'idle' as const }
              const isDone = s.status === 'done'
              const isReporting = s.status === 'reporting'
              return (
                <Card key={node.id}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>
                        {node.name}
                        {isDone && <CheckCircleOutlined style={{ color: COLORS.green, marginLeft: 6 }} />}
                      </div>
                      {node.every30 === 1 && (
                        <Tag color="gold" style={{ marginTop: 4, fontSize: 10 }}>
                          卫生间类·每 30 分钟
                        </Tag>
                      )}
                    </div>
                    <Button
                      size="small"
                      icon={<CameraOutlined />}
                      type={s.photoUrl ? 'default' : 'primary'}
                      onClick={() => pickPhoto(node.id)}
                    >
                      {s.photoUrl ? '重拍' : '拍照'}
                    </Button>
                  </div>

                  {s.photoUrl && (
                    <div style={{ marginTop: 10, position: 'relative' }}>
                      <img
                        src={s.photoUrl}
                        alt="巡检照片"
                        style={{ width: '100%', borderRadius: 10, maxHeight: 200, objectFit: 'cover' }}
                      />
                      <Button
                        size="small"
                        danger
                        style={{ position: 'absolute', top: 8, right: 8 }}
                        onClick={() => clearPhoto(node.id)}
                      >
                        清除
                      </Button>
                    </div>
                  )}

                  <Input.TextArea
                    rows={2}
                    placeholder="备注（选填）"
                    style={{ marginTop: 10 }}
                    value={s.note}
                    onChange={(e) =>
                      setShots((prev) => ({
                        ...prev,
                        [node.id]: { ...(prev[node.id] || { photoUrl: null, status: 'idle' }), note: e.target.value },
                      }))
                    }
                  />

                  <Button
                    block
                    type="primary"
                    style={{ marginTop: 10 }}
                    disabled={!s.photoUrl || isDone}
                    loading={isReporting}
                    onClick={() => report(node)}
                  >
                    {isDone ? '已上报' : '上报'}
                  </Button>
                </Card>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
