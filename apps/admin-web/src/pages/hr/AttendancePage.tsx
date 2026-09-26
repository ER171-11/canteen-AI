import { useEffect, useState } from 'react'
import { Button, Card, Space, Table, Tag, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchModulesStaff, postAction } from '../../api'
import type { ClockItem } from '../../api/types'
import MockAlert from '../kitchen/components/MockAlert'
import { MOCK_STAFF } from '../../mock/modules'
import { COLORS } from '../../theme'

function staffName(r: ClockItem) {
  return String(r.staff_name ?? r.name ?? r.staff ?? r.staff_id ?? '-')
}

export default function AttendancePage() {
  const [rows, setRows] = useState<ClockItem[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = () => {
    setLoading(true)
    fetchModulesStaff()
      .then((r) => {
        setRows(r.clock ?? [])
        setIsMock(false)
      })
      .catch(() => {
        setRows(MOCK_STAFF.clock)
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  const columns: ColumnsType<ClockItem> = [
    { title: '员工', key: 'name', render: (_, r) => staffName(r) },
    { title: '时间', key: 'ts', render: (_, r) => String(r.ts ?? r.time ?? '-') },
    { title: '类型', dataIndex: 'kind', width: 90, render: (v) => v ?? '上班' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v) => {
        const s = String(v ?? '')
        const color = /迟到/.test(s) ? COLORS.red : /准点/.test(s) ? COLORS.green : COLORS.yellow
        return <Tag color={color}>{s || '-'}</Tag>
      },
    },
  ]

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/modules/staff" />}
      <Card
        title="打卡补录"
        extra={
          <Space>
            <Button
              type="primary"
              loading={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await postAction({
                    type: 'staff.clock',
                    payload: { staff_id: 'admin', kind: '上班', status: '补录' },
                    operator: 'admin',
                  })
                  message.success('补打卡已入队 → 审批中心确认')
                  load()
                } catch (e: unknown) {
                  const err = e as { response?: { data?: { error?: string } } }
                  message.error(err.response?.data?.error || '提交失败')
                } finally {
                  setBusy(false)
                }
              }}
            >
              补打卡（上班）
            </Button>
            <Button size="small" onClick={load}>
              刷新
            </Button>
          </Space>
        }
      >
        <Table<ClockItem>
          rowKey={(r, i) => String(`${staffName(r)}-${r.ts ?? r.time}-${i}`)}
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={{ pageSize: 20 }}
        />
      </Card>
    </div>
  )
}
