import { useCallback, useEffect, useRef, useState } from 'react'
import { rk } from '../../utils/rowKey'
import {
  Alert,
  Card,
  Col,
  DatePicker,
  Empty,
  Image,
  Progress,
  Row,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { Dayjs } from 'dayjs'
import { fetchKitchenBoard, fetchKitchenQc, fetchQcMediaStatus } from '../../api'
import type {
  KitchenBoardItem,
  QcMediaStatus,
  QcRecord,
  YieldAlert,
} from '../../api/types'
import MockAlert from './components/MockAlert'
import { colorMeta, colorOrderKey, FIVE_COLOR_ORDER } from './colorMeta'
import { MOCK_BOARD, MOCK_QC_RECORDS } from './mock'
import { COLORS } from '../../theme'

function defectText(v: unknown): string {
  if (v == null) return '-'
  if (Array.isArray(v)) return v.join('、')
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v)
      if (Array.isArray(p)) return p.join('、')
    } catch {
      /* 已是纯文本 */
    }
    return v
  }
  return String(v)
}

export default function QcPage() {
  const [date, setDate] = useState<Dayjs>(dayjs())
  const [board, setBoard] = useState<KitchenBoardItem[]>([])
  const [yieldAlerts, setYieldAlerts] = useState<YieldAlert[]>([])
  const [records, setRecords] = useState<QcRecord[]>([])
  const [boardMock, setBoardMock] = useState(false)
  const [qcMock, setQcMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [media, setMedia] = useState<QcMediaStatus | null>(null)
  const esRef = useRef<EventSource | null>(null)

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
    fetchQcMediaStatus().then(setMedia).catch(() => setMedia(null))
  }, [date, load])

  // SSE：不合格待办实时推送 → 刷新品控台账与看板（断线静默，下次轮询恢复）
  useEffect(() => {
    const es = new EventSource('/api/inbox/stream')
    es.onmessage = () => load(date)
    esRef.current = es
    return () => es.close()
  }, [date, load])

  const sortedBoard = [...board].sort((a, b) => {
    const ia = FIVE_COLOR_ORDER.indexOf(colorOrderKey(a.color))
    const ib = FIVE_COLOR_ORDER.indexOf(colorOrderKey(b.color))
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })

  const failedWithImage = records.filter((r) => r.pass === false && !!r.photo_url)

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
      width: 110,
      render: (v: boolean, r) => (
        <Space size={4}>
          {v ? (
            <Tag color={COLORS.green}>合格</Tag>
          ) : (
            <Tag color={COLORS.red}>不合格</Tag>
          )}
          {r.manual_review && <Tag color="gold">人工复核</Tag>}
          {!v && r.photo_url && <Tag color="volcano">含大图</Tag>}
        </Space>
      ),
    },
    {
      title: '缺陷项',
      dataIndex: 'defect_items',
      width: 160,
      ellipsis: true,
      render: (v) => defectText(v),
    },
    {
      title: '环节',
      dataIndex: 'stage',
      width: 90,
      render: (v) => v ?? '-',
    },
    {
      title: '责任人',
      dataIndex: 'operator',
      width: 100,
      render: (v) => v ?? '-',
    },
    {
      title: '时间',
      dataIndex: 'ts',
      width: 170,
      render: (v) => (v ? new Date(v).toLocaleString('zh-CN') : '-'),
    },
    { title: '来源', dataIndex: 'source', render: (v) => v ?? '-' },
    {
      title: '照片',
      dataIndex: 'photo_url',
      width: 90,
      render: (v: string | undefined) =>
        v ? (
          <Image src={v} width={48} height={48} style={{ objectFit: 'cover', borderRadius: 4 }} />
        ) : (
          <Typography.Text type="secondary">不可用</Typography.Text>
        ),
    },
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
              rowKey={rk}
              columns={yieldColumns}
              dataSource={yieldAlerts}
              loading={loading}
              pagination={false}
              size="small"
            />
          </>
        )}
      </Card>

      {media && !media.configured && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="品控图片暂不可用"
          description={
            '服务器未配置对象存储，结论已记录但后台无法查看原图。缺失环境变量：' +
            (media.missing && media.missing.length ? media.missing.join('、') : '未知')
          }
        />
      )}

      {failedWithImage.length > 0 && (
        <Card title="不合格大图（实时待办）" size="small" style={{ marginBottom: 16 }}>
          <Row gutter={[12, 12]}>
            {failedWithImage.map((r) => (
              <Col key={r.id} xs={12} sm={8} md={6}>
                <Card
                  size="small"
                  cover={
                    <Image
                      src={r.photo_url}
                      height={140}
                      style={{ objectFit: 'cover' }}
                    />
                  }
                >
                  <Space direction="vertical" size={0}>
                    <span style={{ fontWeight: 600 }}>{r.name || r.sku_id}</span>
                    <Typography.Text type="danger">
                      不合格 · {r.operator ?? '-'}
                    </Typography.Text>
                    {r.defect_items != null && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        缺陷：{defectText(r.defect_items)}
                      </Typography.Text>
                    )}
                  </Space>
                </Card>
              </Col>
            ))}
          </Row>
        </Card>
      )}

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
