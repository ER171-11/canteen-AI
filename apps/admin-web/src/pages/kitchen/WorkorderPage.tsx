import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Row,
  Space,
  Spin,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import { fetchWorkorders } from '../../api'
import type { WorkOrder } from '../../api/types'
import ColorBadge from './components/ColorBadge'
import MockAlert from './components/MockAlert'
import { colorMeta } from './colorMeta'
import { MOCK_WORKORDERS } from './mock'
import { COLORS } from '../../theme'

const STATUS_TAG: Record<string, { color: string; text: string }> = {
  待开始: { color: 'default', text: '待开始' },
  进行中: { color: COLORS.yellow, text: '进行中' },
  已完成: { color: COLORS.green, text: '已完成' },
}

function WorkorderCard({ wo }: { wo: WorkOrder }) {
  const meta = colorMeta(wo.color)
  const tag = STATUS_TAG[wo.status] ?? { color: 'default', text: wo.status }

  /*
   * 当前 stage 高亮：已完成→全部绿；待开始→全部灰；
   * 进行中→高亮首个步骤为当前（契约未下发 current_stage，后续接入后替换）。
   */
  const currentIdx = wo.status === '进行中' ? 0 : -1

  return (
    <Card
      size="small"
      style={{ borderTop: `3px solid ${meta.hex}`, height: '100%' }}
      title={
        <Space>
          <ColorBadge color={wo.color} />
          <span>{wo.name}</span>
        </Space>
      }
      extra={<Tag color={tag.color}>{tag.text}</Tag>}
    >
      <Space split="·" wrap style={{ marginBottom: 12 }}>
        <Typography.Text>数量 {wo.qty} 份</Typography.Text>
        <Typography.Text type="secondary">
          计划开始 {wo.planned_start ?? '-'}
        </Typography.Text>
        <Typography.Text type="secondary">{wo.id}</Typography.Text>
      </Space>
      {wo.steps && wo.steps.length > 0 && (
        <Timeline
          items={wo.steps.map((s, i) => ({
            color:
              wo.status === '已完成'
                ? COLORS.green
                : i === currentIdx
                  ? COLORS.yellow
                  : 'gray',
            children: (
              <span
                style={
                  i === currentIdx ? { fontWeight: 700, color: COLORS.primary } : undefined
                }
              >
                {s.stage}
                {s.duration_min != null && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {' '}
                    {s.duration_min}min
                  </Typography.Text>
                )}
                {i === currentIdx && (
                  <Tag color={COLORS.yellow} style={{ marginLeft: 6 }}>
                    当前
                  </Tag>
                )}
              </span>
            ),
          }))}
        />
      )}
    </Card>
  )
}

export default function WorkorderPage() {
  const [date, setDate] = useState<Dayjs>(dayjs())
  const [items, setItems] = useState<WorkOrder[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback((d: Dayjs) => {
    setLoading(true)
    fetchWorkorders(d.format('YYYY-MM-DD'))
      .then((resp) => {
        setItems(resp.workorders ?? [])
        setIsMock(false)
      })
      .catch(() => {
        setItems(MOCK_WORKORDERS)
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load(date)
  }, [date, load])

  return (
    <div>
      <Card
        title="工单排产"
        extra={
          <Space>
            <DatePicker
              value={date}
              allowClear={false}
              onChange={(d) => d && setDate(d)}
            />
            {/* 红线：写操作走 actions 队列，审批中心上线前置灰 */}
            <Tooltip title="待审批中心上线">
              <Button type="primary" disabled>
                新建工单
              </Button>
            </Tooltip>
          </Space>
        }
      >
        {isMock && <MockAlert endpoint="/api/sop/workorder" />}
        <Spin spinning={loading}>
          {items.length === 0 && !loading ? (
            <Empty description="当日暂无工单" />
          ) : (
            <Row gutter={[16, 16]}>
              {items.map((wo) => (
                <Col xs={24} md={12} xl={8} key={wo.id}>
                  <WorkorderCard wo={wo} />
                </Col>
              ))}
            </Row>
          )}
        </Spin>
      </Card>
    </div>
  )
}
