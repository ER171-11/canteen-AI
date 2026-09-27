import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Card,
  Col,
  DatePicker,
  Empty,
  Progress,
  Row,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { Dayjs } from 'dayjs'
import { fetchKitchenBoard, fetchKitchenQc } from '../../api'
import type { KitchenBoardItem, QcRecord, YieldAlert } from '../../api/types'
import MockAlert from './components/MockAlert'
import { colorMeta, colorOrderKey, FIVE_COLOR_ORDER } from './colorMeta'
import { MOCK_BOARD, MOCK_QC_RECORDS } from './mock'
import { COLORS } from '../../theme'

export default function QcPage() {
  const [date, setDate] = useState<Dayjs>(dayjs())
  const [board, setBoard] = useState<KitchenBoardItem[]>([])
  const [yieldAlerts, setYieldAlerts] = useState<YieldAlert[]>([])
  const [records, setRecords] = useState<QcRecord[]>([])
  const [boardMock, setBoardMock] = useState(false)
  const [qcMock, setQcMock] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback((d: Dayjs) => {
    setLoading(true)
    const ds = d.format('YYYY-MM-DD')
    Promise.all([
      fetchKitchenBoard(ds)
        .then((r) => {
          setBoard(r.items ?? [])
          setYieldAlerts(Array.isArray(r.yield_alerts) ? r.yield_alerts : [])
          setBoardMock(false)
        })
        .catch(() => {
          setBoard(MOCK_BOARD)
          setYieldAlerts([])
          setBoardMock(true)
        }),
      fetchKitchenQc(ds)
        .then((r) => {
          setRecords(r.items ?? [])
          setQcMock(false)
        })
        .catch(() => {
          setRecords(MOCK_QC_RECORDS)
          setQcMock(true)
        }),
    ]).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load(date)
  }, [date, load])

  const sortedBoard = [...board].sort((a, b) => {
    const ia = FIVE_COLOR_ORDER.indexOf(colorOrderKey(a.color))
    const ib = FIVE_COLOR_ORDER.indexOf(colorOrderKey(b.color))
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })

  const columns: ColumnsType<QcRecord> = [
    { title: 'ID', dataIndex: 'id', width: 110 },
    { title: '工单', dataIndex: 'workorder_id', width: 160, render: (v) => v ?? '-' },
    { title: 'SKU', dataIndex: 'sku_id', width: 120 },
    {
      title: '样本重量',
      dataIndex: 'sample_weight',
      width: 100,
      align: 'right',
      render: (v) => (v == null ? '-' : `${v}g`),
    },
    {
      title: '判定',
      dataIndex: 'pass',
      width: 90,
      render: (v: boolean) =>
        v ? <Tag color={COLORS.green}>合格</Tag> : <Tag color={COLORS.red}>不合格</Tag>,
    },
    {
      title: '时间',
      dataIndex: 'ts',
      width: 170,
      render: (v) => (v ? new Date(v).toLocaleString('zh-CN') : '-'),
    },
    { title: '来源', dataIndex: 'source', render: (v) => v ?? '-' },
  ]

  const yieldColumns: ColumnsType<YieldAlert> = [
    {
      title: '菜品',
      dataIndex: 'name',
      render: (v, r) => v ?? r.sku_id ?? r.workorder_id ?? '-',
    },
    {
      title: '理论出成',
      dataIndex: 'expected_yield',
      width: 100,
      align: 'right',
      render: (v) => (v == null ? '-' : v),
    },
    {
      title: '实际出成',
      dataIndex: 'actual_yield',
      width: 100,
      align: 'right',
      render: (v) => (v == null ? '-' : v),
    },
    {
      title: '偏差',
      dataIndex: 'deviation_pct',
      width: 100,
      align: 'right',
      render: (v: number | undefined) => {
        if (v == null) return '-'
        const color = Math.abs(v) >= 8 ? COLORS.red : COLORS.yellow
        return <span style={{ color }}>{v > 0 ? `+${v}%` : `${v}%`}</span>
      },
    },
    {
      title: '说明',
      dataIndex: 'note',
      ellipsis: true,
      render: (v) => v ?? '-',
    },
  ]

  return (
    <div>
      <Card
        title="出品看板"
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          <DatePicker
            value={date}
            allowClear={false}
            onChange={(d) => d && setDate(d)}
          />
        }
      >
        {boardMock && <MockAlert endpoint="/api/kitchen/board" />}
        <Spin spinning={loading}>
          <Row gutter={[16, 16]}>
            {sortedBoard.map((b) => {
              const meta = colorMeta(b.color)
              const pct = b.planned > 0 ? Math.round((b.done / b.planned) * 100) : 0
              return (
                <Col xs={12} md={8} xl={4} key={b.color} flex="1 0 180px">
                  <Card size="small" style={{ borderTop: `3px solid ${meta.hex}` }}>
                    <Space direction="vertical" style={{ width: '100%' }}>
                      <Statistic
                        title={`${meta.label}色出品`}
                        value={b.done}
                        suffix={`/ ${b.planned}`}
                      />
                      <Progress
                        percent={pct}
                        strokeColor={meta.hex}
                        size="small"
                      />
                      <Statistic
                        title="QC 合格率"
                        value={b.qc_pass_rate ?? 0}
                        suffix="%"
                        valueStyle={{
                          fontSize: 16,
                          color:
                            (b.qc_pass_rate ?? 0) >= 90 ? COLORS.green : COLORS.red,
                        }}
                      />
                    </Space>
                  </Card>
                </Col>
              )
            })}
          </Row>
        </Spin>
      </Card>

      <Card title="出成偏差告警" size="small" style={{ marginBottom: 16 }}>
        {yieldAlerts.length === 0 && !loading ? (
          <Empty description="当日无出成偏差告警" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <>
            {yieldAlerts.length > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message={`共 ${yieldAlerts.length} 条出成偏差（|偏差|≥8%）`}
              />
            )}
            <Table<YieldAlert>
              rowKey={(r, i) => String(r.workorder_id ?? r.id ?? r.sku_id ?? i)}
              columns={yieldColumns}
              dataSource={yieldAlerts}
              loading={loading}
              pagination={false}
              size="small"
            />
          </>
        )}
      </Card>

      <Card title="品控记录" size="small">
        {qcMock && <MockAlert endpoint="/api/kitchen/qc" />}
        <Table<QcRecord>
          rowKey="id"
          columns={columns}
          dataSource={records}
          loading={loading}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
        />
      </Card>
    </div>
  )
}
