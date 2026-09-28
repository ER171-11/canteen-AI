import { useEffect, useMemo, useState } from 'react'
import { rk } from '../../utils/rowKey'
import { Card, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchFoodsafe } from '../../api'
import type { CertItem } from '../../api/types'
import MockAlert from '../kitchen/components/MockAlert'
import { MOCK_FOODSAFE } from '../../mock/modules'
import { COLORS } from '../../theme'

function daysLeft(c: CertItem): number | null {
  if (typeof c.expire_days === 'number') return c.expire_days
  const s = String(c.expire_at ?? c.expire ?? c.expiry ?? '')
  const t = new Date(s).getTime()
  if (Number.isNaN(t)) return null
  return Math.ceil((t - Date.now()) / 86400000)
}

function certType(c: CertItem) {
  return String(c.cert_type ?? c.type ?? '-')
}
function certName(c: CertItem) {
  return String(c.holder ?? c.name ?? c.staff ?? '-')
}

export default function LicensesPage() {
  const [rows, setRows] = useState<CertItem[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchFoodsafe()
      .then((r) => {
        setRows(r.certs ?? [])
        setIsMock(false)
      })
      .catch(() => {
        setRows(MOCK_FOODSAFE.certs)
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  const columns: ColumnsType<CertItem> = useMemo(
    () => [
      { title: '类型', key: 'type', width: 140, render: (_, r) => certType(r) },
      { title: '持有人/主体', key: 'name', render: (_, r) => certName(r) },
      {
        title: '剩余天数',
        key: 'days',
        width: 110,
        sorter: (a, b) => (daysLeft(a) ?? 9999) - (daysLeft(b) ?? 9999),
        render: (_, r) => {
          const d = daysLeft(r)
          if (d == null) return '-'
          const color = d < 7 ? COLORS.red : d < 30 ? COLORS.yellow : COLORS.green
          return <Tag color={color}>{d < 0 ? `已过期 ${-d} 天` : `${d} 天`}</Tag>
        },
      },
      { title: '状态', dataIndex: 'status', width: 90, render: (v) => v ?? '-' },
    ],
    [],
  )

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/modules/foodsafe" />}
      <Card title="证照台账（健康证 &lt;7 天标红）">
        <Table<CertItem>
          rowKey={rk}
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={{ pageSize: 20 }}
        />
      </Card>
    </div>
  )
}
