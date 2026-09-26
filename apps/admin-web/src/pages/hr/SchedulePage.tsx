import { useEffect, useMemo, useState } from 'react'
import { Button, Card, Space, Table, Tag, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchModulesStaff, postAction } from '../../api'
import type { ShiftItem } from '../../api/types'
import MockAlert from '../kitchen/components/MockAlert'
import { MOCK_STAFF } from '../../mock/modules'

function staffName(r: ShiftItem) {
  return String(r.staff_name ?? r.name ?? r.staff ?? r.staff_id ?? '-')
}

export default function SchedulePage() {
  const [rows, setRows] = useState<ShiftItem[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [rev, setRev] = useState<string | number | undefined>()

  const load = () => {
    setLoading(true)
    fetchModulesStaff()
      .then((r) => {
        setRows(r.shifts ?? [])
        setRev(r.rev)
        setIsMock(false)
      })
      .catch(() => {
        setRows(MOCK_STAFF.shifts)
        setRev('mock')
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  const columns: ColumnsType<ShiftItem> = useMemo(
    () => [
      { title: '员工', key: 'name', render: (_, r) => staffName(r) },
      { title: '角色', dataIndex: 'role', width: 100, render: (v) => v ?? '-' },
      { title: '日期', dataIndex: 'date', width: 120, render: (v) => v ?? '-' },
      { title: '班次', dataIndex: 'shift', width: 90, render: (v) => <Tag>{String(v ?? '-')}</Tag> },
      {
        title: '时段',
        key: 'span',
        width: 140,
        render: (_, r) =>
          r.start_time || r.end_time ? `${r.start_time ?? ''}–${r.end_time ?? ''}` : '-',
      },
    ],
    [],
  )

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/modules/staff" />}
      <Card
        title={`排班登记 · rev=${rev ?? '-'}`}
        extra={
          <Space>
            <Button
              type="primary"
              loading={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await postAction({
                    type: 'staff.shift_upsert',
                    payload: {
                      staff_id: 'admin',
                      staff_name: '管理员',
                      shift: '早班',
                      role: '店长',
                    },
                    operator: 'admin',
                  })
                  message.success('换班已入队 → 审批中心确认')
                  load()
                } catch (e: unknown) {
                  const err = e as { response?: { data?: { error?: string } } }
                  message.error(err.response?.data?.error || '提交失败')
                } finally {
                  setBusy(false)
                }
              }}
            >
              登记换班
            </Button>
            <Button size="small" onClick={load}>
              刷新
            </Button>
          </Space>
        }
      >
        <Table<ShiftItem>
          rowKey={(r, i) => String(r.id ?? `${staffName(r)}-${r.date}-${i}`)}
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={{ pageSize: 20 }}
        />
      </Card>
    </div>
  )
}
