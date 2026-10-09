import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  InputNumber,
  Modal,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchStaffTrain, postStaffUniform } from '../../api'
import type { CertAlert, StaffTrainProgress, TrainCourse } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import { COLORS } from '../../theme'

const LEVEL_META: Record<string, { color: string; text: string }> = {
  red: { color: COLORS.red, text: '≤7 天 · 禁岗' },
  warn: { color: COLORS.yellow, text: '≤30 天 · 预警' },
  ok: { color: COLORS.green, text: '正常' },
  unknown: { color: COLORS.gray, text: '无到期日' },
}

export default function TrainPage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const [progress, setProgress] = useState<StaffTrainProgress[]>([])
  const [certs, setCerts] = useState<CertAlert[]>([])
  const [summary, setSummary] = useState({
    staff: 0,
    cert_red: 0,
    cert_warn: 0,
    blocked_staff: 0,
    gated_skus: 0,
  })
  const [sopTotal, setSopTotal] = useState(5)
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    fetchStaffTrain()
      .then((r) => {
        setProgress(r.progress ?? [])
        setCerts(r.certs ?? [])
        setSummary(r.summary)
        setSopTotal(r.sop_total ?? 5)
        setIsMock(false)
      })
      .catch(() => {
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const certCols: ColumnsType<CertAlert> = [
    { title: '员工', dataIndex: 'staff_name', width: 130 },
    {
      title: '到期日',
      dataIndex: 'expire_at',
      width: 130,
      render: (v) => v ?? '-',
    },
    {
      title: '剩余天数',
      dataIndex: 'days_left',
      width: 110,
      align: 'right',
      sorter: (a, b) =>
        (a.days_left ?? 9999) - (b.days_left ?? 9999),
      render: (v: number | null) =>
        v == null ? (
          <span style={{ color: COLORS.gray }}>-</span>
        ) : (
          <b style={{ color: v < 7 ? COLORS.red : v < 30 ? COLORS.yellow : COLORS.green }}>
            {v} 天
          </b>
        ),
    },
    {
      title: '预警级别',
      dataIndex: 'level',
      width: 150,
      render: (v: string) => {
        const m = LEVEL_META[v] ?? LEVEL_META.unknown
        return <Tag color={m.color}>{m.text}</Tag>
      },
    },
    {
      title: '排班',
      dataIndex: 'blocked',
      width: 90,
      render: (v: boolean) =>
        v ? <Tag color={COLORS.red}>禁岗</Tag> : <Tag color={COLORS.green}>可排</Tag>,
    },
  ]

  const progCols: ColumnsType<StaffTrainProgress> = [
    {
      title: '员工',
      key: 'staff',
      width: 150,
      render: (_, r) => (
        <Space size={4}>
          <span>{r.staff_name ?? r.staff_id}</span>
          {r.blocked && (
            <Tooltip title="健康证临期，已禁岗">
              <Tag color={COLORS.red} style={{ margin: 0 }}>
                禁岗
              </Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: `SOP 进度（n/${sopTotal}）`,
      key: 'courses',
      render: (_, r) =>
        r.courses.length === 0 ? (
          <span style={{ color: COLORS.gray }}>暂无培训记录</span>
        ) : (
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            {r.courses.map((c: TrainCourse) => (
              <Space key={c.course} size={8} style={{ width: '100%' }}>
                <span style={{ width: 110, display: 'inline-block' }}>{c.course}</span>
                <Progress
                  percent={c.pct}
                  size="small"
                  steps={c.total}
                  strokeColor={c.passed ? COLORS.green : COLORS.yellow}
                  style={{ width: 160, margin: 0 }}
                />
                <b>
                  {c.done}/{c.total}
                </b>
                <Tag color={c.passed ? COLORS.green : COLORS.yellow}>
                  {c.passed ? '已通过' : '进行中'}
                </Tag>
              </Space>
            ))}
          </Space>
        ),
    },
    {
      title: '禁接单 SKU',
      dataIndex: 'blocked_skus',
      width: 200,
      render: (v: string[]) =>
        v && v.length ? (
          <Space size={4} wrap>
            {v.map((s) => (
              <Tag color={COLORS.red} key={s}>
                {s}
              </Tag>
            ))}
          </Space>
        ) : (
          <Tag color={COLORS.green}>无</Tag>
        ),
    },
  ]

  return (
    <div>
      {isMock && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="后端 /api/staff/train 未连通，当前为本地样例数据"
        />
      )}
      <Card title="培训与健康证总览" style={{ marginBottom: 16 }}>
        <Space size={32} wrap>
          <Statistic title="受训人数" value={summary.staff} />
          <Statistic
            title="健康证 ≤7 天"
            value={summary.cert_red}
            valueStyle={{ color: COLORS.red }}
          />
          <Statistic
            title="健康证 ≤30 天"
            value={summary.cert_warn}
            valueStyle={{ color: COLORS.yellow }}
          />
          <Statistic
            title="禁岗人数"
            value={summary.blocked_staff}
            valueStyle={{ color: COLORS.red }}
          />
          <Statistic title="受控 SKU" value={summary.gated_skus} />
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="健康证到期预警（<7 天红 = 禁岗）">
            {certs.length === 0 && !loading ? (
              <Empty description="暂无健康证数据" />
            ) : (
              <Table<CertAlert>
                rowKey={(r) => r.staff_name + (r.expire_at ?? '')}
                columns={certCols}
                dataSource={certs}
                loading={loading}
                pagination={false}
                size="small"
              />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            title="着装合规（Kimi uniform）"
            extra={
              <Tooltip title={canWrite ? undefined : '当前角色无写权限，仅可查看'}>
                <Button
                  size="small"
                  type="primary"
                  disabled={!canWrite}
                  onClick={() => {
                    form.resetFields()
                    form.setFieldsValue({ pass: '合格', score: 95 })
                    setOpen(true)
                  }}
                >
                  录入合规
                </Button>
              </Tooltip>
            }
          >
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="Kimi 着装合规：≥90% 自动入档；<90% 转待复核"
              description="仅存合规结论与分数，不存人脸、不存原图。"
            />
            <Table<{ staff_id?: string; staff_name?: string; course?: string; remark?: string; passed?: number | boolean }>
              rowKey={(r, i) => String(r.staff_id ?? r.staff_name ?? i)}
              columns={[
                { title: '员工', key: 'n', render: (_, r) => r.staff_name ?? r.staff_id ?? '-' },
                { title: '结论', key: 'c', render: (_, r) => r.course ?? '-' },
                { title: '备注', dataIndex: 'remark', render: (v) => v ?? '-' },
              ]}
              dataSource={[]}
              size="small"
              pagination={false}
              locale={{ emptyText: '本批次暂无着装记录（录入后进入审批中心）' }}
            />
          </Card>
        </Col>
      </Row>

      <Card title={`SOP 培训进度（n/${sopTotal}）`} style={{ marginTop: 16 }}>
        <Table<StaffTrainProgress>
          rowKey={(r) => r.staff_id}
          columns={progCols}
          dataSource={progress}
          loading={loading}
          pagination={false}
          size="small"
        />
      </Card>

      <Modal
        title="着装合规录入（Kimi）"
        open={open}
        onCancel={() => setOpen(false)}
        confirmLoading={busy}
        destroyOnHidden
        onOk={async () => {
          const v = await form.validateFields()
          setBusy(true)
          try {
            const res = await postStaffUniform({
              staff_id: String(v.staff_id),
              staff_name: String(v.staff_id),
              pass: v.pass,
              score: v.score,
            })
            message.success(res.note ?? '已入队 → 审批中心确认')
            setOpen(false)
            load()
          } catch (e: unknown) {
            const err = e as { response?: { data?: { error?: string } } }
            message.error(err.response?.data?.error || '提交失败')
          } finally {
            setBusy(false)
          }
        }}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="staff_id" label="员工" rules={[{ required: true, message: '请选择员工' }]}>
            <Select
              showSearch
              placeholder="选择员工"
              options={progress.map((p) => ({
                value: p.staff_id,
                label: p.staff_name ?? p.staff_id,
              }))}
            />
          </Form.Item>
          <Form.Item name="score" label="Kimi 合规度（%）" rules={[{ required: true, message: '请输入合规度' }]}>
            <InputNumber min={0} max={100} style={{ width: '100%' }} addonAfter="%" />
          </Form.Item>
          <Form.Item name="pass" label="结论" rules={[{ required: true, message: '请选择结论' }]}>
            <Select
              options={[
                { value: '合格', label: '合格' },
                { value: '待复核', label: '待复核' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
