import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Card,
  Col,
  DatePicker,
  Empty,
  List,
  Progress,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Tag,
  Typography,
} from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import { fetchInspectionBoard } from '../../api'
import type { InspectionBoardResp, InspectionNode } from '../../api/types'
import { COLORS } from '../../theme'
import { allValueOf, fromAll, withAll } from '../../utils/filterAll'

export default function InspectionBoardPage() {
  const [date, setDate] = useState<Dayjs>(dayjs())
  const [board, setBoard] = useState<string | undefined>(undefined)
  const [data, setData] = useState<InspectionBoardResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((d: Dayjs, b?: string) => {
    setLoading(true)
    setError(null)
    fetchInspectionBoard({ date: d.format('YYYY-MM-DD'), board: b })
      .then((r) => setData(r))
      .catch((e) => setError(String(e?.message || e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load(date, board)
  }, [date, board, load])

  const boards = data?.boards ?? []
  const nodesByBoard: Record<string, InspectionNode[]> = {}
  ;(data?.nodes ?? []).forEach((n) => {
    (nodesByBoard[n.board] = nodesByBoard[n.board] || []).push(n)
  })

  return (
    <div>
      <Card
        title="闭店巡检统筹"
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          <Space>
            {/* 首项固定「全部板块」：不筛选=看全部板块，且随时一键退回全部 */}
            <Select
              allowClear
              placeholder="全部板块"
              style={{ width: 160 }}
              value={allValueOf(board)}
              onChange={(v) => setBoard(fromAll<string>(v))}
              options={withAll(
                boards.map((b) => ({ value: b.board, label: b.board })),
                '全部板块',
              )}
            />
            <DatePicker
              value={date}
              allowClear={false}
              onChange={(d) => d && setDate(d)}
            />
          </Space>
        }
      >
        {data?.updated_at && (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            数据更新时间：{data.updated_at}
          </Typography.Paragraph>
        )}
        {error && (
          <Alert type="error" showIcon message="巡检看板加载失败" description={error} />
        )}
        <Spin spinning={loading}>
          <Row gutter={[16, 16]}>
            <Col xs={12} md={8} xl={6}>
              <Card size="small">
                <Statistic
                  title="全店完成率"
                  value={data?.summary?.rate ?? 0}
                  suffix="%"
                  valueStyle={{
                    color:
                      (data?.summary?.rate ?? 0) >= 90 ? COLORS.green : COLORS.red,
                  }}
                />
                <Progress
                  percent={data?.summary?.rate ?? 0}
                  strokeColor={COLORS.green}
                  size="small"
                />
              </Card>
            </Col>
            <Col xs={12} md={8} xl={6}>
              <Card size="small">
                <Statistic
                  title="已完成 / 总节点"
                  value={data?.summary?.done ?? 0}
                  suffix={`/ ${data?.summary?.total ?? 0}`}
                />
              </Card>
            </Col>
            <Col xs={12} md={8} xl={6}>
              <Card size="small">
                <Statistic
                  title="漏项"
                  value={(data?.boards ?? []).reduce(
                    (a, b) => a + (b.missing_count ?? b.missing?.length ?? 0),
                    0,
                  )}
                  valueStyle={{ color: COLORS.red }}
                />
              </Card>
            </Col>
            {data?.every30 && (
              <Col xs={12} md={8} xl={6}>
                <Card size="small">
                  <Statistic
                    title="卫生间每 30 分钟"
                    value={`${data.every30.rounds_recorded.length}/${data.every30.rounds_per_day}`}
                    suffix="轮"
                  />
                  {data.every30.rounds_missing.length > 0 && (
                    <Tag color="red">
                      {data.every30.rounds_missing.length} 轮未拍
                    </Tag>
                  )}
                </Card>
              </Col>
            )}
          </Row>
        </Spin>
      </Card>

      {boards.map((b) => {
        const miss = b.missing ?? []
        const missIds = new Set(miss.map((m) => m.node_id))
        const nodes = nodesByBoard[b.board] ?? []
        return (
          <Card
            key={b.board}
            title={
              <Space>
                {b.board}
                <Tag color={b.rate >= 100 ? 'green' : 'orange'}>{b.rate}%</Tag>
              </Space>
            }
            size="small"
            style={{ marginBottom: 16 }}
          >
            <Progress percent={b.rate} strokeColor={COLORS.green} />
            <Row gutter={[8, 8]} style={{ margin: '12px 0' }}>
              {nodes.map((n) => {
                const done = !missIds.has(n.id)
                return (
                  <Col key={n.id} xs={12} sm={8} md={6} lg={4}>
                    <Card size="small" style={{ borderTop: `3px solid ${done ? COLORS.green : COLORS.red}` }}>
                      <Space direction="vertical" size={0}>
                        <span style={{ fontWeight: 600 }}>
                          {n.name}
                          {n.every30 && <Tag color="gold" style={{ marginLeft: 4 }}>30min</Tag>}
                        </span>
                        <Typography.Text type={done ? 'success' : 'danger'} style={{ fontSize: 12 }}>
                          {done ? '已拍照' : '漏项'}
                        </Typography.Text>
                      </Space>
                    </Card>
                  </Col>
                )
              })}
            </Row>
            {miss.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message={`漏项 ${miss.length} 个`}
                description={
                  <span>
                    {miss
                      .map((m) => m.name || m.node_id)
                      .join('、')}
                  </span>
                }
              />
            )}
          </Card>
        )
      })}

      {!loading && (data?.boards?.length ?? 0) === 0 && (
        <Empty description="当日尚未生成巡检快照，首次拍照后将建立记录" />
      )}

      {(data?.records?.length ?? 0) > 0 && (
        <Card title="巡检记录（历史台账）" size="small">
          <List
            size="small"
            dataSource={data?.records ?? []}
            renderItem={(r) => (
              <List.Item>
                <Space>
                  <Tag color={r.done ? 'green' : 'red'}>{r.done ? '已拍' : '未拍'}</Tag>
                  <span>节点 {r.node_id}</span>
                  <span>执行人 {r.operator ?? '-'}</span>
                  {r.ts && <span>{new Date(r.ts).toLocaleString('zh-CN')}</span>}
                </Space>
              </List.Item>
            )}
          />
        </Card>
      )}
    </div>
  )
}
