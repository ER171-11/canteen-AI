import { useEffect, useState } from 'react'
import { Alert, Card, Progress, Space, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchStaffPerf } from '../../api'
import type { StaffPerfRow } from '../../api/types'
import { COLORS } from '../../theme'

const MEDAL: Record<number, { color: string; label: string }> = {
  1: { color: COLORS.gold, label: '🥇' },
  2: { color: COLORS.gray, label: '🥈' },
  3: { color: COLORS.orange, label: '🥉' },
}

export default function PerformancePage() {
  const [rows, setRows] = useState<StaffPerfRow[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchStaffPerf()
      .then((r) => {
        setRows(r.perf ?? [])
        setIsMock(false)
      })
      .catch(() => {
        setRows([])
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  const max = Math.max(1, ...rows.map((r) => r.score))
  const avg = rows.length ? rows.reduce((n, r) => n + r.score, 0) / rows.length : 0

  const columns: ColumnsType<StaffPerfRow> = [
    {
      title: '排名',
      dataIndex: 'rank',
      width: 80,
      render: (v: number) =>
        MEDAL[v] ? (
          <Tag color={MEDAL[v].color}>
            {MEDAL[v].label} {v}
          </Tag>
        ) : (
          <span style={{ color: COLORS.gray }}>{v}</span>
        ),
    },
    {
      title: '员工',
      key: 'staff',
      width: 140,
      render: (_, r) => (
        <Space>
          <b>{r.staff_name}</b>
          <span style={{ color: COLORS.gray, fontSize: 12 }}>{r.staff_id ?? ''}</span>
        </Space>
      ),
    },
    {
      title: '绩效得分',
      dataIndex: 'score',
      width: 220,
      sorter: (a, b) => a.score - b.score,
      render: (v: number) => (
        <Space>
          <Tag color={COLORS.purple}>{v}</Tag>
          <Progress
            percent={Math.round((v / max) * 100)}
            size="small"
            showInfo={false}
            strokeColor={COLORS.purple}
            style={{ width: 90, margin: 0 }}
          />
        </Space>
      ),
    },
    { title: '工时', dataIndex: 'hours', width: 90, align: 'right', render: (v) => `${v} h` },
    { title: '备注 / 产出', dataIndex: 'remark', render: (v) => v ?? '-' },
  ]

  return (
    <div>
      {isMock && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="后端 /api/staff/perf 未连通，当前为本地样例数据"
        />
      )}
      <Card
        title="绩效排行榜"
        extra={
          <Space size={16}>
            <span style={{ color: COLORS.gray }}>
              人均 <b style={{ color: COLORS.primary }}>{avg.toFixed(1)}</b> 分
            </span>
            <span style={{ color: COLORS.gray }}>共 {rows.length} 人</span>
          </Space>
        }
      >
        <Table<StaffPerfRow>
          rowKey={(r) => r.staff_id ?? r.staff_name ?? String(r.rank)}
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={false}
          size="small"
        />
      </Card>
    </div>
  )
}
