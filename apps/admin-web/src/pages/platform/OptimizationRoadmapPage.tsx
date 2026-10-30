import { useMemo, useState } from 'react'
import {
  Card,
  Col,
  Collapse,
  Empty,
  Input,
  Progress,
  Row,
  Segmented,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  CheckCircleFilled,
  ClockCircleFilled,
  MinusCircleFilled,
  StopFilled,
} from '@ant-design/icons'
import {
  ROADMAP_META,
  ROADMAP_PHASES,
  ROADMAP_SECTIONS,
  RISK_COLOR,
  STATUS_META,
  aggregate,
  type Status,
} from '../../data/optimizationRoadmap'

const { Title, Paragraph, Text } = Typography

const STATUS_ICON: Record<Status, JSX.Element> = {
  done: <CheckCircleFilled style={{ color: STATUS_META.done.color }} />,
  in_progress: <ClockCircleFilled style={{ color: STATUS_META.in_progress.color }} />,
  pending: <MinusCircleFilled style={{ color: STATUS_META.pending.color }} />,
  blocked: <StopFilled style={{ color: STATUS_META.blocked.color }} />,
}

type FilterKey = 'all' | Status

/** 阶段进度条（P0–P4 总览） */
function PhaseOverview() {
  return (
    <Row gutter={[16, 16]}>
      {ROADMAP_PHASES.map((p) => {
        const sm = STATUS_META[p.status]
        return (
          <Col xs={24} sm={12} lg={Math.floor(24 / ROADMAP_PHASES.length)} key={p.id}>
            <Card size="small" style={{ borderTop: `3px solid ${sm.color}` }}>
              <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                <Text strong>{p.id}</Text>
                <Tag color={sm.color} style={{ marginRight: 0 }}>
                  {sm.text}
                </Tag>
              </Space>
              <Paragraph
                type="secondary"
                style={{ fontSize: 12, margin: '6px 0', minHeight: 36 }}
              >
                {p.content}
              </Paragraph>
              <Progress
                percent={p.progress}
                size="small"
                strokeColor={sm.color}
                status={p.status === 'pending' ? 'normal' : undefined}
              />
              <div style={{ fontSize: 12, color: '#8C8C8C', marginTop: 4 }}>
                依赖：{p.depends} · 风险
                <Text style={{ color: RISK_COLOR[p.risk] }}> {p.risk}</Text>
              </div>
            </Card>
          </Col>
        )
      })}
    </Row>
  )
}

/** 单个章节项的进度行 */
function ItemRow({ item }: { item: (typeof ROADMAP_SECTIONS)[number]['items'][number] }) {
  const sm = STATUS_META[item.status]
  return (
    <Card
      size="small"
      style={{ marginBottom: 12 }}
      title={
        <Space>
          {STATUS_ICON[item.status]}
          <Text strong>{item.title}</Text>
        </Space>
      }
      extra={
        <Tag color={sm.color} style={{ marginRight: 0 }}>
          {sm.text}
        </Tag>
      }
    >
      {item.note && (
        <Paragraph style={{ fontSize: 13, marginBottom: 10 }}>{item.note}</Paragraph>
      )}
      <Progress
        percent={item.progress}
        size="small"
        strokeColor={sm.color}
        status={item.status === 'pending' ? 'normal' : undefined}
      />
      <Space wrap style={{ marginTop: 10, fontSize: 12 }}>
        {item.owner && (
          <Tag>负责人：{item.owner}</Tag>
        )}
        {item.risk && (
          <Tag color={RISK_COLOR[item.risk]}>风险 {item.risk}</Tag>
        )}
        {item.depends && (
          <Tooltip title="前置依赖">
            <Tag>依赖：{item.depends}</Tag>
          </Tooltip>
        )}
      </Space>
    </Card>
  )
}

export default function OptimizationRoadmapPage() {
  const [filter, setFilter] = useState<FilterKey>('all')
  const [keyword, setKeyword] = useState('')

  const agg = useMemo(() => aggregate(), [])

  const sections = useMemo(() => {
    const kw = keyword.trim()
    return ROADMAP_SECTIONS.map((sec) => {
      const items = sec.items.filter((it) => {
        const matchStatus = filter === 'all' || it.status === filter
        const matchKw =
          !kw || it.title.includes(kw) || (it.note ?? '').includes(kw)
        return matchStatus && matchKw
      })
      return { ...sec, items }
    }).filter((sec) => sec.items.length > 0)
  }, [filter, keyword])

  return (
    <div style={{ maxWidth: 1200 }}>
      <Space
        align="center"
        style={{ justifyContent: 'space-between', width: '100%', flexWrap: 'wrap', gap: 12 }}
      >
        <Title level={4} style={{ margin: 0 }}>
          系统优化路线图 · 进度看板
        </Title>
        <Space size={12} wrap>
          <Text type="secondary" style={{ fontSize: 12 }}>
            来源：{ROADMAP_META.source}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            生成 {ROADMAP_META.generatedAt} · {ROADMAP_META.status}
          </Text>
        </Space>
      </Space>

      <Paragraph type="secondary" style={{ marginTop: 8 }}>
        当前基线：{ROADMAP_META.baseline}
      </Paragraph>

      {/* 总进度 + 状态计数 */}
      <Card style={{ marginTop: 8 }}>
        <Row gutter={[16, 16]} align="middle">
          <Col xs={24} md={8}>
            <Statistic
              title="总进度（章节项平均完成度）"
              value={agg.overall}
              suffix="%"
              valueStyle={{ color: '#9B6BBF' }}
            />
            <Progress
              percent={agg.overall}
              strokeColor="#9B6BBF"
              showInfo={false}
              style={{ marginTop: 8 }}
            />
          </Col>
          <Col xs={24} md={16}>
            <Row gutter={[12, 12]}>
              <Col xs={12} sm={6}>
                <Statistic
                  title="已完成"
                  value={agg.counts.done}
                  suffix={`/ ${agg.total}`}
                  valueStyle={{ color: STATUS_META.done.color }}
                />
              </Col>
              <Col xs={12} sm={6}>
                <Statistic
                  title="进行中"
                  value={agg.counts.in_progress}
                  suffix={`/ ${agg.total}`}
                  valueStyle={{ color: STATUS_META.in_progress.color }}
                />
              </Col>
              <Col xs={12} sm={6}>
                <Statistic
                  title="待启动"
                  value={agg.counts.pending}
                  suffix={`/ ${agg.total}`}
                  valueStyle={{ color: STATUS_META.pending.color }}
                />
              </Col>
              <Col xs={12} sm={6}>
                <Statistic
                  title="受阻"
                  value={agg.counts.blocked}
                  suffix={`/ ${agg.total}`}
                  valueStyle={{ color: STATUS_META.blocked.color }}
                />
              </Col>
            </Row>
          </Col>
        </Row>
      </Card>

      {/* 阶段总览 */}
      <Title level={5} style={{ marginTop: 20 }}>
        推进阶段（按杠杆从高到低）
      </Title>
      <PhaseOverview />

      {/* 章节明细 + 筛选 */}
      <div
        style={{
          marginTop: 20,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <Title level={5} style={{ margin: 0 }}>
          优化项明细（一～六）
        </Title>
        <Space wrap>
          <Segmented<FilterKey>
            value={filter}
            onChange={setFilter}
            options={[
              { label: '全部', value: 'all' },
              { label: '已完成', value: 'done' },
              { label: '进行中', value: 'in_progress' },
              { label: '待启动', value: 'pending' },
              { label: '受阻', value: 'blocked' },
            ]}
          />
          <Input.Search
            placeholder="搜索标题 / 摘要"
            allowClear
            style={{ width: 220 }}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </Space>
      </div>

      {sections.length === 0 ? (
        <Empty description="无匹配优化项" style={{ marginTop: 40 }} />
      ) : (
        <Collapse
          defaultActiveKey={ROADMAP_SECTIONS.map((s) => s.id)}
          style={{ marginTop: 12 }}
          items={sections.map((sec) => ({
            key: sec.id,
            label: (
              <Space>
                <Text strong>{sec.title}</Text>
                <Tag>{sec.items.length} 项</Tag>
              </Space>
            ),
            children: (
              <div>
                <Paragraph type="secondary" style={{ fontSize: 12 }}>
                  {sec.summary}
                </Paragraph>
                {sec.items.map((it) => (
                  <ItemRow key={it.id} item={it} />
                ))}
              </div>
            ),
          }))}
        />
      )}

      <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 24 }}>
        说明：本看板进度由文档手动同步至前端数据源（src/data/optimizationRoadmap.ts），
        非运行时拉取；文档更新后请同步该文件。
      </Paragraph>
    </div>
  )
}
