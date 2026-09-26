import { useEffect, useState } from 'react'
import { Card, Col, Progress, Row, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchModulesStaff } from '../../api'
import type { PerfItem, TrainItem } from '../../api/types'
import MockAlert from '../kitchen/components/MockAlert'
import { MOCK_STAFF } from '../../mock/modules'
import { COLORS } from '../../theme'

function nameOf(r: { staff_name?: string; name?: string; staff?: string; staff_id?: string }) {
  return String(r.staff_name ?? r.name ?? r.staff ?? r.staff_id ?? '-')
}

export default function PerformancePage() {
  const [perf, setPerf] = useState<PerfItem[]>([])
  const [train, setTrain] = useState<TrainItem[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchModulesStaff()
      .then((r) => {
        setPerf(r.perf ?? [])
        setTrain(r.train ?? [])
        setIsMock(false)
      })
      .catch(() => {
        setPerf(MOCK_STAFF.perf)
        setTrain(MOCK_STAFF.train)
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  const pCols: ColumnsType<PerfItem> = [
    { title: '员工', key: 'name', render: (_, r) => nameOf(r) },
    {
      title: '得分',
      dataIndex: 'score',
      width: 90,
      sorter: (a, b) => (a.score ?? 0) - (b.score ?? 0),
      render: (v) => (v == null ? '-' : <Tag color={COLORS.purple}>{v}</Tag>),
    },
    { title: '工时', dataIndex: 'hours', width: 80, render: (v) => v ?? '-' },
    {
      title: '备注/产出',
      key: 'remark',
      render: (_, r) => String(r.remark ?? r.output ?? r.value ?? '-'),
    },
  ]

  const tCols: ColumnsType<TrainItem> = [
    { title: '员工', key: 'name', render: (_, r) => nameOf(r) },
    { title: '课程', key: 'course', render: (_, r) => String(r.course ?? r.stage ?? '-') },
    {
      title: '进度',
      key: 'progress',
      width: 160,
      render: (_, r) => {
        if (typeof r.progress === 'number') {
          return <Progress percent={r.progress} size="small" />
        }
        const passed = r.passed === 1 || r.passed === true
        return <Tag color={passed ? COLORS.green : COLORS.yellow}>{passed ? '已通过' : '进行中'}</Tag>
      },
    },
    { title: '备注', dataIndex: 'remark', render: (v) => v ?? '-' },
  ]

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/modules/staff" />}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card title="绩效 TOP">
            <Table<PerfItem>
              rowKey={(r, i) => String(`${nameOf(r)}-${i}`)}
              columns={pCols}
              dataSource={perf}
              loading={loading}
              pagination={false}
              size="small"
            />
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card title="培训进度">
            <Table<TrainItem>
              rowKey={(r, i) => String(`${nameOf(r)}-${r.course}-${i}`)}
              columns={tCols}
              dataSource={train}
              loading={loading}
              pagination={false}
              size="small"
            />
          </Card>
        </Col>
      </Row>
    </div>
  )
}
