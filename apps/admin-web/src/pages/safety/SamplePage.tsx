import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { Dayjs } from 'dayjs'
import {
  clearFoodsafeSample,
  fetchExportCsvBlob,
  fetchFoodsafeSamples,
  ingestFoodsafeSample,
  logFoodsafeSample,
} from '../../api'
import type { FoodsafeSamplesResp, SampleLevel, SampleRow } from '../../api/types'
import { downloadBlob } from '../inventory/settle/download'
import { useAuthStore } from '../../store/auth'
import { COLORS } from '../../theme'

const LEVEL_META: Record<SampleLevel, { text: string; color: string }> = {
  green: { text: '待销毁', color: COLORS.green },
  yellow: { text: '2h 内到期', color: COLORS.yellow },
  red: { text: '已超期', color: COLORS.red },
  done: { text: '已销毁', color: COLORS.gray },
  unknown: { text: '未知', color: COLORS.gray },
}

const WEIGHT_META: Record<string, { text: string; color: string }> = {
  pass: { text: '达标', color: COLORS.green },
  warn: { text: '临界', color: COLORS.yellow },
  fail: { text: '不足', color: COLORS.red },
  unknown: { text: '缺失', color: COLORS.gray },
}

const TEMP_META: Record<string, { text: string; color: string }> = {
  ok: { text: '正常', color: COLORS.green },
  out: { text: '越界', color: COLORS.red },
  unknown: { text: '未填', color: COLORS.gray },
}

const REMINDER_COLOR: Record<string, string> = {
  red: COLORS.red,
  yellow: COLORS.yellow,
  fail: COLORS.red,
}

export default function SamplePage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const [data, setData] = useState<FoodsafeSamplesResp | null>(null)
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const [logOpen, setLogOpen] = useState(false)
  const [logForm] = Form.useForm()
  const [kimiOpen, setKimiOpen] = useState(false)
  const [kimiForm] = Form.useForm()
  const [kimiResult, setKimiResult] = useState<string | null>(null)
  const [clearRow, setClearRow] = useState<SampleRow | null>(null)
  const [clearForm] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    fetchFoodsafeSamples()
      .then((r) => {
        setData(r)
        setIsMock(false)
      })
      .catch(() => {
        setData(null)
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const weightRuleTip = useMemo(() => {
    const w = data?.weight_rule ?? { 饺子: 125, '热菜/其他': 200 }
    return Object.entries(w)
      .map(([k, v]) => `${k} ≥${v}g`)
      .join(' / ')
  }, [data])

  const tempRangeTip = useMemo(() => {
    const r = data?.temp_range ?? { min: 0, max: 8 }
    return `${r.min}–${r.max}℃`
  }, [data])

  const submitLog = async () => {
    const v = await logForm.validateFields()
    setBusy(true)
    try {
      const res = await logFoodsafeSample({
        date: (v.date as Dayjs).format('YYYY-MM-DD'),
        meal: v.meal,
        dish: v.dish,
        weight_g: Number(v.weight_g),
        keeper: v.keeper || undefined,
        hold_temp: v.hold_temp != null ? Number(v.hold_temp) : null,
        sealed_by: v.sealed_by || undefined,
      })
      if (res.ok) {
        message.success(
          res.weight_level === 'warn'
            ? `已登记（克重临界 ${res.need_g}g），待审批中心确认`
            : res.note || '留样已登记，待审批中心确认',
        )
        setLogOpen(false)
        load()
      } else message.error(res.error || '登记失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '登记失败')
    } finally {
      setBusy(false)
    }
  }

  const submitKimi = async () => {
    const v = await kimiForm.validateFields()
    setBusy(true)
    setKimiResult(null)
    try {
      const res = await ingestFoodsafeSample({
        date: (v.date as Dayjs).format('YYYY-MM-DD'),
        meal: v.meal,
        dish: v.dish,
        weight_g: Number(v.weight_g),
        conf: Number(v.conf),
        keeper: v.keeper || undefined,
        source: 'kimi',
        hold_temp: v.hold_temp != null ? Number(v.hold_temp) : null,
        sealed_by: v.sealed_by || undefined,
      })
      if (res.review) {
        setKimiResult(res.reason || `置信度 ${res.conf}% < ${res.threshold}%，转人工待复核`)
        message.warning(res.reason || '置信度不足，转人工待复核')
      } else if (res.ok) {
        setKimiResult(res.note || '已自动入档')
        message.success(res.note || '已自动入档，待审批中心确认')
        load()
      } else message.error(res.error || '入档失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '入档失败')
    } finally {
      setBusy(false)
    }
  }

  const submitClear = async () => {
    if (!clearRow) return
    const v = await clearForm.validateFields()
    setBusy(true)
    try {
      const res = await clearFoodsafeSample({
        id: clearRow.id ?? '',
        dish: clearRow.dish,
        note: v.note || undefined,
      })
      if (res.ok) {
        message.success(res.note || '销毁登记已入队，待审批中心确认')
        setClearRow(null)
        load()
      } else message.error(res.error || '销毁登记失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '销毁登记失败')
    } finally {
      setBusy(false)
    }
  }

  const exportSamples = async () => {
    try {
      const blob = await fetchExportCsvBlob('samples')
      downloadBlob(`留样台账_${dayjs().format('YYYY-MM-DD')}.csv`, blob)
      message.success('已导出留样台账 CSV')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } }; message?: string }
      message.error(err?.response?.data?.error || err?.message || '导出失败')
    }
  }

  const cols: ColumnsType<SampleRow> = [
    {
      title: '菜品',
      dataIndex: 'dish',
      width: 150,
      render: (v, r) => (
        <Space size={4}>
          <span>{v}</span>
          {r.weight_level === 'fail' && <Tag color={COLORS.red}>克重不足</Tag>}
        </Space>
      ),
    },
    { title: '餐次', dataIndex: 'meal', width: 80, render: (v) => v ?? '-' },
    {
      title: '留样时间',
      dataIndex: 'kept_at',
      width: 160,
      render: (v) => (v ? new Date(v).toLocaleString('zh-CN') : '-'),
    },
    {
      title: '到期时间',
      dataIndex: 'due_at',
      width: 160,
      render: (v) => (v ? new Date(v).toLocaleString('zh-CN') : '-'),
    },
    {
      title: '剩余',
      key: 'left',
      width: 110,
      sorter: (a, b) => (a.hours_left ?? 9999) - (b.hours_left ?? 9999),
      render: (_, r) => {
        if (r.hours_left == null) return '-'
        return r.hours_left <= 0 ? (
          <Tag color={COLORS.red}>超 {Math.abs(r.hours_left)}h</Tag>
        ) : (
          <Tag color={LEVEL_META[r.level]?.color}>{r.hours_left}h</Tag>
        )
      },
    },
    {
      title: '状态',
      key: 'status',
      width: 110,
      render: (_, r) => <Tag color={LEVEL_META[r.level]?.color}>{r.status}</Tag>,
    },
    {
      title: '克重',
      key: 'weight',
      width: 120,
      render: (_, r) => (
        <Tooltip title={`下限 ${r.need_g}g`}>
          <Tag color={WEIGHT_META[r.weight_level]?.color}>
            {r.weight_g}g {WEIGHT_META[r.weight_level]?.text}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: '存放温度',
      dataIndex: 'hold_temp',
      width: 110,
      render: (v: number | null, r) => {
        if (v == null) return '-'
        const meta = TEMP_META[r.temp_level ?? 'unknown']
        return (
          <Tooltip title={`正常范围 ${tempRangeTip}`}>
            <Tag color={meta?.color}>{v}℃ {meta?.text}</Tag>
          </Tooltip>
        )
      },
    },
    { title: '封存人', dataIndex: 'sealed_by', width: 100, render: (v) => v ?? '-' },
    { title: '保管人', dataIndex: 'keeper', width: 90, render: (v) => v ?? '-' },
    {
      title: '操作',
      key: 'op',
      width: 110,
      render: (_, r) => {
        if (!canWrite) return <span style={{ color: COLORS.gray }}>只读</span>
        if (r.level === 'done') return <span style={{ color: COLORS.gray }}>已销毁</span>
        return (
          <Button
            size="small"
            danger
            onClick={() => {
              clearForm.resetFields()
              setClearRow(r)
            }}
          >
            销毁登记
          </Button>
        )
      },
    },
  ]

  const s = data?.summary

  return (
    <div>
      {isMock && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="后端 /api/foodsafe/samples 未连通，当前为本地样例数据"
        />
      )}

      <Card
        title={`留样 48h 台账（${data?.hold_hours ?? 48}h 监管 · 到期前 ${data?.warn_hours ?? 2}h 转黄）`}
        extra={
          <Space wrap>
            <Tooltip title={canWrite ? undefined : '当前角色无写权限，仅可查看'}>
              <Button
                disabled={!canWrite}
                onClick={() => {
                  kimiForm.resetFields()
                  kimiForm.setFieldsValue({ date: dayjs(), conf: 95 })
                  setKimiResult(null)
                  setKimiOpen(true)
                }}
              >
                Kimi 识别入档
              </Button>
            </Tooltip>
            <Tooltip title={canWrite ? undefined : '当前角色无写权限，仅可查看'}>
              <Button
                type="primary"
                disabled={!canWrite}
                onClick={() => {
                  logForm.resetFields()
                  logForm.setFieldsValue({ date: dayjs(), meal: '午餐' })
                  setLogOpen(true)
                }}
              >
                留样登记
              </Button>
            </Tooltip>
            <Button size="small" onClick={exportSamples}>
              导出 CSV
            </Button>
            <Button size="small" onClick={load}>
              刷新
            </Button>
          </Space>
        }
      >
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={12} md={6} xl={4}>
            <Card size="small">
              <Statistic title="留样总数" value={s?.total ?? 0} />
            </Card>
          </Col>
          <Col xs={12} md={6} xl={4}>
            <Card size="small">
              <Statistic title="待销毁" value={s?.pending ?? 0} />
            </Card>
          </Col>
          <Col xs={12} md={6} xl={4}>
            <Card size="small">
              <Statistic
                title="2h 内到期"
                value={s?.due_soon ?? 0}
                valueStyle={{ color: COLORS.yellow }}
              />
            </Card>
          </Col>
          <Col xs={12} md={6} xl={4}>
            <Card size="small">
              <Statistic
                title="已超期"
                value={s?.expired ?? 0}
                valueStyle={{ color: COLORS.red }}
              />
            </Card>
          </Col>
          <Col xs={12} md={6} xl={4}>
            <Card size="small">
              <Statistic
                title="克重不足"
                value={s?.under_weight ?? 0}
                valueStyle={{ color: (s?.under_weight ?? 0) ? COLORS.red : COLORS.green }}
              />
            </Card>
          </Col>
          <Col xs={12} md={6} xl={4}>
            <Card size="small">
              <Statistic
                title="温度越界"
                value={s?.temp_out ?? 0}
                valueStyle={{ color: (s?.temp_out ?? 0) ? COLORS.red : COLORS.green }}
              />
            </Card>
          </Col>
          <Col xs={12} md={6} xl={4}>
            <Card size="small">
              <Statistic
                title="已销毁"
                value={s?.cleared ?? 0}
                valueStyle={{ color: COLORS.green }}
              />
            </Card>
          </Col>
        </Row>

        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          克重口径：{weightRuleTip}；Kimi 留样识别置信度 ≥{data?.auto_archive_conf ?? 91}% 自动入档，低于则转人工待复核。
        </Typography.Paragraph>

        {(data?.reminders ?? []).length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={`留样提醒 ${(data?.reminders ?? []).length} 条`}
            description={
              <List
                size="small"
                dataSource={data?.reminders ?? []}
                renderItem={(r) => (
                  <List.Item style={{ padding: '2px 0', border: 'none' }}>
                    <Space size={6}>
                      <Tag color={REMINDER_COLOR[r.level] ?? COLORS.yellow}>{r.level}</Tag>
                      <span>{r.text}</span>
                    </Space>
                  </List.Item>
                )}
              />
            }
          />
        )}

        <Table<SampleRow>
          rowKey={(r) => String(r.id ?? r.dish + r.kept_at)}
          columns={cols}
          dataSource={data?.rows ?? []}
          loading={loading}
          pagination={{ pageSize: 15 }}
          size="small"
        />
      </Card>

      <Modal
        title="留样登记"
        open={logOpen}
        onCancel={() => setLogOpen(false)}
        confirmLoading={busy}
        destroyOnHidden
        onOk={submitLog}
      >
        <Form form={logForm} layout="vertical" preserve={false}>
          <Form.Item name="dish" label="菜品" rules={[{ required: true, message: '请填写菜品' }]}>
            <Input placeholder="如：红色五福饺（饺子类按 125g 判定）" />
          </Form.Item>
          <Form.Item
            name="weight_g"
            label={`留样克重（g）· ${weightRuleTip}`}
            rules={[{ required: true, message: '请填写克重' }]}
          >
            <InputNumber min={0} style={{ width: '100%' }} placeholder="不足将被拦截" />
          </Form.Item>
          <Form.Item name="date" label="留样日期" rules={[{ required: true, message: '请选择日期' }]}>
            <DatePicker style={{ width: '100%' }} allowClear={false} />
          </Form.Item>
          <Form.Item name="meal" label="餐次">
            <Select
              options={['早餐', '午餐', '晚餐'].map((m) => ({ value: m, label: m }))}
            />
          </Form.Item>
          <Form.Item name="keeper" label="保管人">
            <Input placeholder="选填，默认当前账号" />
          </Form.Item>
          <Form.Item name="hold_temp" label={`存放温度（℃）· 正常 ${tempRangeTip}`}>
            <InputNumber min={-40} max={60} style={{ width: '100%' }} placeholder="如 4（0–8℃ 为正常）" />
          </Form.Item>
          <Form.Item name="sealed_by" label="封存人（双人封存）">
            <Input placeholder="如：张三 / 李四" />
          </Form.Item>
          <Alert type="info" showIcon message="登记后进入 48h 倒计时，销毁需另行登记。" />
        </Form>
      </Modal>

      <Modal
        title="Kimi 留样识别入档"
        open={kimiOpen}
        onCancel={() => setKimiOpen(false)}
        confirmLoading={busy}
        destroyOnHidden
        onOk={submitKimi}
      >
        <Form form={kimiForm} layout="vertical" preserve={false}>
          <Form.Item
            name="dish"
            label="识别菜品"
            rules={[{ required: true, message: '请填写识别结果' }]}
          >
            <Input placeholder="Kimi 视觉识别菜品名" />
          </Form.Item>
          <Form.Item
            name="weight_g"
            label="识别克重（g）"
            rules={[{ required: true, message: '请填写克重' }]}
          >
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="conf"
            label={`识别置信度（%）· 阈值 ${data?.auto_archive_conf ?? 91}%`}
            rules={[{ required: true, message: '请填写置信度' }]}
          >
            <InputNumber min={0} max={100} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="date" label="留样日期" rules={[{ required: true, message: '请选择日期' }]}>
            <DatePicker style={{ width: '100%' }} allowClear={false} />
          </Form.Item>
          <Form.Item name="meal" label="餐次">
            <Select options={['早餐', '午餐', '晚餐'].map((m) => ({ value: m, label: m }))} />
          </Form.Item>
          <Form.Item name="keeper" label="保管人">
            <Input placeholder="选填" />
          </Form.Item>
          <Form.Item name="hold_temp" label={`存放温度（℃）· 正常 ${tempRangeTip}`}>
            <InputNumber min={-40} max={60} style={{ width: '100%' }} placeholder="选填" />
          </Form.Item>
          <Form.Item name="sealed_by" label="封存人（双人封存）">
            <Input placeholder="选填" />
          </Form.Item>
          {kimiResult && <Alert type="warning" showIcon message={kimiResult} />}
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 8 }}
            message={`置信度 ≥${data?.auto_archive_conf ?? 91}% 自动入档；低于则转人工待复核（不入档、不写回）。`}
          />
        </Form>
      </Modal>

      <Modal
        title="留样销毁登记"
        open={!!clearRow}
        onCancel={() => setClearRow(null)}
        confirmLoading={busy}
        destroyOnHidden
        onOk={submitClear}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`确认销毁：${clearRow?.dish ?? '-'}（留样 ${clearRow?.kept_at ? new Date(clearRow.kept_at).toLocaleString('zh-CN') : '-'}）`}
        />
        <Form form={clearForm} layout="vertical" preserve={false}>
          <Form.Item name="note" label="销毁说明">
            <Input.TextArea rows={2} placeholder="如：48h 到期销毁 / 交接销毁" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
