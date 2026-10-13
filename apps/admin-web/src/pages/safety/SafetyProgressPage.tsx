import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Form,
  Image,
  Input,
  Modal,
  Radio,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  CameraOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons'
import { fetchSafetyProgress, submitAndConfirmAction } from '../../api'
import type { SafetyPointStatus, SafetyProgress, SafetyProgressPoint } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import { COLORS } from '../../theme'

/*
 * 食安拍照上报 · 老板进度页（GET /api/safety/progress 只读聚合）
 *
 * 口径见 docs/safety-schema.md §3：pass/fail 以「人工优先」的 effective_result 计；
 * review_count = 未复核且 AI 判 fail（必须人工确认）；error_count = 未复核且 AI 初判失败。
 *
 * 红线：
 *   - 读走只读端点；**复核写操作一律 postAction('safety.review') → 审批中心确认**，本页不直写库；
 *   - `safety.review` 在 BFF policy 的 NEVER_AUTO 中：不可自动执行、不会覆盖 AI 初判（ai_result 保留）；
 *   - 复核按钮只对有权限角色（老板/店长）显示。
 */

const STATUS_META: Record<SafetyPointStatus, { text: string; color: string }> = {
  none: { text: '未上报', color: 'default' },
  pending: { text: '待 AI 初判', color: 'gold' },
  pass: { text: '合格', color: 'green' },
  fail: { text: '不合格', color: 'red' },
  review: { text: '待复核', color: 'orange' },
  error: { text: 'AI 初判失败', color: 'volcano' },
}

const AI_META: Record<string, { text: string; color: string }> = {
  pending: { text: '待初判', color: 'gold' },
  pass: { text: 'AI 合格', color: 'green' },
  fail: { text: 'AI 不合格', color: 'red' },
  error: { text: '初判失败', color: 'volcano' },
}

function fmtTime(v: string | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleString('zh-CN', { hour12: false })
}

export default function SafetyProgressPage() {
  const role = useAuthStore((s) => s.role)
  const [data, setData] = useState<SafetyProgress | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState<SafetyProgressPoint | null>(null)
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm<{ final_result: 'pass' | 'fail'; reason?: string }>()

  /** 复核权限：与 BFF policy 的「人工确认」语义一致（老板/店长） */
  const canReview = role === '老板' || role === '店长'

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchSafetyProgress()
      .then((r) => setData(r))
      .catch((e: unknown) => setError(String((e as Error)?.message || e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const points = useMemo(() => data?.points ?? [], [data])

  const openReview = (row: SafetyProgressPoint) => {
    setTarget(row)
    form.setFieldsValue({
      final_result: row.final_result ?? (row.ai_result === 'pass' ? 'pass' : 'fail'),
      reason: row.review_reason ?? '',
    })
  }

  const doReview = async () => {
    if (!target || !target.check_id) {
      message.warning('该点位尚无上报记录，无法复核')
      return
    }
    let values: { final_result: 'pass' | 'fail'; reason?: string }
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    setBusy(true)
    try {
      const res = await submitAndConfirmAction({
        type: 'safety.review',
        operator: role ?? undefined,
        payload: {
          check_id: target.check_id,
          final_result: values.final_result,
          reason: values.reason?.trim() || undefined,
          reviewer: role ?? undefined,
        },
      })
      if (res.ok) {
        message.success(
          res.confirmed
            ? '复核已提交并确认，待店内消费器落库后生效'
            : '复核已入队，请在审批中心确认',
        )
        setTarget(null)
        load()
      } else {
        message.error('复核提交失败，请重试')
      }
    } catch (e: unknown) {
      message.error(String((e as Error)?.message || '复核提交失败'))
    } finally {
      setBusy(false)
    }
  }

  const columns: ColumnsType<SafetyProgressPoint> = [
    {
      title: '点位',
      dataIndex: 'name',
      width: 200,
      render: (_: unknown, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{r.name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.zone || '—'} · {r.point_id}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      filters: Object.keys(STATUS_META).map((k) => ({
        text: STATUS_META[k as SafetyPointStatus].text,
        value: k,
      })),
      onFilter: (v, r) => r.status === v,
      render: (v: SafetyPointStatus) => {
        const m = STATUS_META[v] ?? STATUS_META.none
        return <Tag color={m.color}>{m.text}</Tag>
      },
    },
    {
      title: '现场照片',
      dataIndex: 'photo_url',
      width: 96,
      render: (v: string | null, r) =>
        v ? (
          <Image
            src={v}
            width={64}
            height={48}
            style={{ objectFit: 'cover', borderRadius: 6 }}
            preview={{ src: v }}
            alt={r.name}
          />
        ) : (
          <Typography.Text type="secondary">未上传</Typography.Text>
        ),
    },
    {
      title: 'AI 初判',
      dataIndex: 'ai_result',
      width: 240,
      render: (_: unknown, r) => {
        if (!r.ai_result) return <Typography.Text type="secondary">—</Typography.Text>
        const m = AI_META[r.ai_result] ?? AI_META.pending
        return (
          <Space direction="vertical" size={2} style={{ maxWidth: 230 }}>
            <Space size={6}>
              <Tag color={m.color}>{m.text}</Tag>
              {r.ai_confidence != null ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  置信度 {r.ai_confidence}%
                </Typography.Text>
              ) : null}
            </Space>
            {r.ai_reason ? (
              <Tooltip title={r.ai_reason}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                  {r.ai_reason}
                </Typography.Text>
              </Tooltip>
            ) : null}
          </Space>
        )
      },
    },
    {
      title: '人工结论',
      dataIndex: 'final_result',
      width: 190,
      render: (_: unknown, r) => {
        if (!r.final_result) {
          return <Typography.Text type="secondary">未复核</Typography.Text>
        }
        return (
          <Space direction="vertical" size={2} style={{ maxWidth: 180 }}>
            <Tag color={r.final_result === 'pass' ? 'green' : 'red'}>
              {r.final_result === 'pass' ? '复核合格' : '复核不合格'}
            </Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.reviewed_by || '—'} · {fmtTime(r.created_at)}
            </Typography.Text>
          </Space>
        )
      },
    },
    {
      title: '上报',
      dataIndex: 'operator',
      width: 150,
      render: (_: unknown, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{r.operator || '—'}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {fmtTime(r.created_at)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'op',
      width: 110,
      fixed: 'right',
      render: (_: unknown, r) =>
        canReview && r.check_id ? (
          <Button
            size="small"
            type={r.status === 'review' ? 'primary' : 'default'}
            danger={r.status === 'review'}
            onClick={() => openReview(r)}
          >
            {r.final_result ? '重新复核' : '复核'}
          </Button>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `${COLORS.green}1a`,
            color: COLORS.green,
            fontSize: 18,
          }}
        >
          <SafetyCertificateOutlined />
        </span>
        <div style={{ flex: 1 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            食安拍照核验
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            员工拍照上报 → AI 初判 → 老板/店长人工复核。AI 初判不替代人工结论。
          </Typography.Text>
        </div>
        <Space>
          {data?.date ? (
            <Typography.Text type="secondary">{data.date}</Typography.Text>
          ) : null}
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            刷新
          </Button>
        </Space>
      </div>

      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="进度加载失败"
          description={error}
        />
      ) : null}
      {data?.using_defaults ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="当前展示内置默认点位"
          description="门店尚未落 data.safety.points（可用种子脚本预置 SC-01…SC-08），上报与复核记录仍按点位 id 归档。"
        />
      ) : null}
      {data?.hint === 'no_snapshot' ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="尚未收到店内快照"
          description="进度按内置点位空开；店内 pusher 推送快照后即自动出现上报记录。"
        />
      ) : null}

      <Card size="small" style={{ marginBottom: 12 }}>
        <Space size={40} wrap>
          <Statistic title="应检点位" value={data?.total_points ?? 0} />
          <Statistic title="已上报" value={data?.completed_points ?? 0} />
          <Statistic
            title="合格"
            value={data?.pass_count ?? 0}
            valueStyle={{ color: COLORS.green }}
          />
          <Statistic
            title="不合格"
            value={data?.fail_count ?? 0}
            valueStyle={{ color: COLORS.red }}
          />
          <Statistic
            title="待人工复核"
            value={data?.review_count ?? 0}
            valueStyle={{ color: COLORS.orange }}
          />
          <Statistic
            title="AI 初判失败"
            value={data?.error_count ?? 0}
            valueStyle={{ color: COLORS.purple }}
          />
        </Space>
      </Card>

      <Card
        size="small"
        title={
          <Space size={8}>
            <CameraOutlined />
            <span>点位核验清单</span>
          </Space>
        }
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            rev {data?.rev ?? '—'} · 更新于 {fmtTime(data?.updated_at)}
          </Typography.Text>
        }
      >
        <Table<SafetyProgressPoint>
          rowKey="point_id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={points}
          scroll={{ x: 1100 }}
          pagination={points.length > 12 ? { pageSize: 12 } : false}
        />
      </Card>

      <Modal
        open={!!target}
        title={target ? `复核 · ${target.name}` : '复核'}
        okText="提交复核"
        cancelText="取消"
        confirmLoading={busy}
        onOk={doReview}
        onCancel={() => setTarget(null)}
        destroyOnClose
      >
        {target ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message="人工结论优先于 AI 初判"
              description={
                <span style={{ fontSize: 12 }}>
                  AI 初判 {AI_META[target.ai_result ?? 'pending']?.text ?? '—'}
                  {target.ai_confidence != null ? `（置信度 ${target.ai_confidence}%）` : ''}
                  ，复核后将保留 AI 初判原文供审计；本操作走审批队列，不会自动执行。
                </span>
              }
            />
            {target.ai_reason ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                AI 依据：{target.ai_reason}
              </Typography.Text>
            ) : null}
            <Form form={form} layout="vertical" initialValues={{ final_result: 'pass' }}>
              <Form.Item
                name="final_result"
                label="复核结论"
                rules={[{ required: true, message: '请选择复核结论' }]}
              >
                <Radio.Group>
                  <Radio.Button value="pass">合格</Radio.Button>
                  <Radio.Button value="fail">不合格</Radio.Button>
                </Radio.Group>
              </Form.Item>
              <Form.Item name="reason" label="复核理由">
                <Input.TextArea rows={3} maxLength={200} showCount placeholder="改判必须写明依据（现场复查事实）" />
              </Form.Item>
            </Form>
          </Space>
        ) : null}
      </Modal>
    </div>
  )
}
