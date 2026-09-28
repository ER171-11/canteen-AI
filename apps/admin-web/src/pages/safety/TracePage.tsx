import { useEffect, useState } from 'react'
import { rk } from '../../utils/rowKey'
import { Card, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchFoodsafe } from '../../api'
import type { TraceItem } from '../../api/types'
import MockAlert from '../kitchen/components/MockAlert'
import { MOCK_FOODSAFE } from '../../mock/modules'
import { COLORS } from '../../theme'

export default function TracePage() {
  const [rows, setRows] = useState<TraceItem[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchFoodsafe()
      .then((r) => {
        setRows(r.trace ?? [])
        setIsMock(false)
      })
      .catch(() => {
        setRows(MOCK_FOODSAFE.trace)
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  const columns: ColumnsType<TraceItem> = [
    {
      title: '批次',
      key: 'batch',
      width: 140,
      render: (_, r) => String(r.batch_no ?? r.batch ?? '-'),
    },
    {
      title: '原料',
      key: 'ing',
      render: (_, r) => String(r.ing_name ?? r.ing ?? '-'),
    },
    {
      title: '供应商',
      key: 'vendor',
      render: (_, r) => String(r.supplier ?? r.vendor ?? '-'),
    },
    {
      title: '检验结果',
      key: 'result',
      width: 110,
      render: (_, r) => {
        const v = String(r.check_result ?? r.result ?? '-')
        const color = /合格|pass/i.test(v)
          ? COLORS.green
          : /待|warn/i.test(v)
            ? COLORS.yellow
            : COLORS.red
        return <Tag color={color}>{v}</Tag>
      },
    },
  ]

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/modules/foodsafe" />}
      <Card title="溯源批次">
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          溯源批次由供应商入库同步，后台只读展示；纠错请走进货/留样相关写操作。
        </Typography.Paragraph>
        <Table<TraceItem>
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
